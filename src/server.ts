/**
 * The x402Seek reviewer preview.
 *
 * Two read-only discovery routes over a frozen catalog, plus static files.
 * There is no POST route, no registration route, no `/verify`, no `/settle`,
 * no signer, and no funded account — and not merely because they are switched
 * off: the modules that would implement them are not part of this service's
 * dependency graph at all (see `vendor/catalog/index.ts`).
 *
 * Ranking is the real `SearchEngine` from the frozen core: same model, same
 * document representation, same dense cosine, same abstention threshold. The
 * abstention a reviewer sees is computed, not matched against a list of
 * queries.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { CatalogListing, ResourceType } from "../vendor/catalog/index.js";
import { toDiscoveryResourcesResponse, toDiscoverySearchResponse } from "../vendor/catalog/index.js";
import { DEFAULT_ABSTENTION_THRESHOLD, SearchEngine, cosine, embed } from "../vendor/search/index.js";
import * as evidence from "./evidence.js";
import { FrozenCatalogStore } from "./store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const WEB = join(ROOT, "web");

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
/** The 86 MB model is fetched once on a cold image. Fail loudly, never hang. */
const MODEL_LOAD_TIMEOUT_MS = Number(process.env.MODEL_LOAD_TIMEOUT_MS ?? 180_000);

const MAX_QUERY_LENGTH = 512;

interface Snapshot {
  schemaVersion: number;
  builtAt: string;
  coreCommit: string;
  provenance: Record<string, unknown>;
  listings: CatalogListing[];
}

const snapshot = JSON.parse(readFileSync(join(ROOT, "data", "snapshot.json"), "utf8")) as Snapshot;
const store = new FrozenCatalogStore(snapshot.listings);
const engine = new SearchEngine(store);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} exceeded ${ms} ms`)), ms).unref(),
    ),
  ]);
}

/**
 * Per-listing relevance, recomputed with the same embedder and the same vectors
 * the engine ranked on.
 *
 * `SearchResponse` carries listings but only a single `debug.topScore`, and the
 * UI has to show a score per card. Rather than approximate one, this embeds the
 * query again and takes the cosine against the stored vector — the identical
 * arithmetic `SearchEngine.search()` performed internally, so the number shown
 * is the number that produced the ordering.
 */
async function relevanceFor(query: string, listings: CatalogListing[]): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (listings.length === 0) return scores;

  const [queryVector] = await embed([query]);
  const vectors = new Map(store.allEmbeddings().map((e) => [e.canonicalKey, e.vector]));
  for (const listing of listings) {
    const vector = vectors.get(listing.canonicalKey);
    scores.set(listing.canonicalKey, vector && queryVector ? cosine(queryVector, vector) : 0);
  }
  return scores;
}

function parseType(raw: unknown): { ok: true; value?: ResourceType } | { ok: false } {
  if (raw === undefined || raw === "") return { ok: true };
  if (raw === "http" || raw === "mcp") return { ok: true, value: raw };
  return { ok: false };
}

/** Only these networks and schemes appear in the frozen catalog. */
function cleanFilter(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value.length > 0 && value.length <= 64 ? value : undefined;
}

export function buildServer() {
  const app = Fastify({ logger: false, bodyLimit: 1024 });

  /**
   * A crude fixed-window limiter, deliberately dependency-free.
   *
   * Each search embeds a query, which is CPU-bound; without a cap one client
   * can saturate a small instance. Not a security control — there is nothing
   * here to protect — purely availability for the next reviewer.
   */
  const hits = new Map<string, { count: number; resetAt: number }>();
  const WINDOW_MS = 60_000;
  const MAX_PER_WINDOW = 60;

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const key = request.ip;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return;
    }
    entry.count += 1;
    if (entry.count > MAX_PER_WINDOW) {
      return reply.code(429).send({ error: "rate limited, try again shortly" });
    }
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "x402seek-preview",
    mode: "discovery-only",
    listings: store.all().length,
    coreCommit: snapshot.coreCommit,
    settlement: "not offered",
  }));

  app.get("/api/evidence", async () => ({
    conformance: evidence.CONFORMANCE,
    settlement: evidence.SETTLEMENT,
    transactions: evidence.TRANSACTIONS,
    benchmark: evidence.BENCHMARK,
    agentDemo: evidence.AGENT_DEMO,
    status: evidence.STATUS,
    explorerBase: evidence.EXPLORER_BASE,
    snapshot: {
      builtAt: snapshot.builtAt,
      coreCommit: snapshot.coreCommit,
      provenance: snapshot.provenance,
      listings: store.all().length,
    },
    abstentionThreshold: DEFAULT_ABSTENTION_THRESHOLD,
  }));

  /**
   * `GET /api/discovery/resources` — the frozen catalog, Bazaar `items` envelope.
   */
  app.get("/api/discovery/resources", async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const type = parseType(q.type);
    if (!type.ok) return reply.code(400).send({ error: "type must be 'http' or 'mcp'" });

    return toDiscoveryResourcesResponse(
      store.list({
        ...(type.value ? { type: type.value } : {}),
        ...(cleanFilter(q.network) ? { network: cleanFilter(q.network) } : {}),
        ...(cleanFilter(q.scheme) ? { scheme: cleanFilter(q.scheme) } : {}),
        ...(cleanFilter(q.payTo) ? { payTo: cleanFilter(q.payTo) } : {}),
      }),
    );
  });

  /**
   * `GET /api/discovery/search` — natural language over the frozen catalog.
   *
   * `relevance` is an addition beyond the Bazaar envelope, for the preview UI.
   * Note there is no `asset` filter: `DiscoveryQuery` upstream has no such
   * field, so the engine cannot apply one *before* ranking. Adding a post-filter
   * would quietly break the "hard filters run before scoring" property that is
   * the point of the design, so asset is displayed and not filtered on.
   */
  app.get("/api/discovery/search", async (request, reply) => {
    const q = request.query as Record<string, unknown>;

    const query = typeof q.query === "string" ? q.query.trim() : "";
    if (!query) return reply.code(400).send({ error: "query is required" });
    if (query.length > MAX_QUERY_LENGTH) {
      return reply.code(400).send({ error: `query must be ${MAX_QUERY_LENGTH} characters or fewer` });
    }

    const type = parseType(q.type);
    if (!type.ok) return reply.code(400).send({ error: "type must be 'http' or 'mcp'" });

    const response = await engine.search({
      query,
      filters: {
        ...(type.value ? { type: type.value } : {}),
        ...(cleanFilter(q.network) ? { network: cleanFilter(q.network) } : {}),
        ...(cleanFilter(q.scheme) ? { scheme: cleanFilter(q.scheme) } : {}),
      },
      ...(typeof q.cursor === "string" ? { cursor: q.cursor } : {}),
    });

    const wire = toDiscoverySearchResponse(
      response.resources,
      response.partialResults,
      response.pagination,
      response.abstained,
    );
    const scores = await relevanceFor(query, response.resources);

    return {
      ...wire,
      relevance: Object.fromEntries(scores),
      threshold: DEFAULT_ABSTENTION_THRESHOLD,
      tookMs: Math.round(response.debug.latencyMs * 10) / 10,
    };
  });

  /**
   * Static files.
   *
   * The whitelist is explicit rather than a path join over user input, so there
   * is no traversal surface to reason about in the first place.
   */
  const PAGES: Record<string, string> = {
    "/": "index.html",
    "/index.html": "index.html",
    "/app.js": "app.js",
    "/styles.css": "styles.css",
  };

  app.get("/*", async (request, reply) => {
    const file = PAGES[request.url.split("?")[0] ?? "/"];
    if (!file) return reply.code(404).send({ error: "not found" });
    const ext = file.slice(file.lastIndexOf("."));
    return reply
      .header("content-type", MIME[ext] ?? "application/octet-stream")
      .send(readFileSync(join(WEB, file), "utf8"));
  });

  return app;
}

export async function start() {
  const app = buildServer();

  console.log("x402seek preview — discovery only, no settlement");
  console.log(`  core commit : ${snapshot.coreCommit}`);
  console.log(`  snapshot    : ${store.all().length} listings, built ${snapshot.builtAt}`);
  console.log(`  threshold   : ${DEFAULT_ABSTENTION_THRESHOLD} cosine`);
  console.log("  loading embedding model (86 MB on a cold image)…");

  const started = Date.now();
  try {
    const stats = await withTimeout(engine.sync(), MODEL_LOAD_TIMEOUT_MS, "model load and index build");
    console.log(`  index       : ${stats.total} vectors in ${Date.now() - started} ms`);
  } catch (error) {
    console.error("FATAL: could not build the search index.");
    console.error(error instanceof Error ? error.message : error);
    console.error("The model is fetched from the Hugging Face CDN on first run.");
    process.exit(1);
  }

  await app.listen({ port: PORT, host: HOST });
  console.log(`  listening   : http://${HOST}:${PORT}`);
  return app;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await start();
}

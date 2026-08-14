/**
 * The search engine behind `GET /discovery/search`.
 *
 * Pipeline, in this order and no other:
 *
 *   1. parse         — caller's job, see the route handler
 *   2. hard filters  — deterministic protocol predicates
 *   3. candidates    — eligible listings loaded from the catalog
 *   4. rank          — dense cosine over the candidates
 *   5. abstain       — top-1 below threshold means no results
 *   6. paginate      — cursor
 *   7. respond       — Bazaar-compatible shape
 *
 * Step 2 before step 4 is the load-bearing decision. A semantically perfect
 * match on the wrong network is not a lower-ranked result; it is not a result.
 * An agent that follows one wastes a round trip and then fails to pay.
 *
 * The catalog is the source of truth and this index is derived state. Every
 * vector records the document hash, model id and representation version it was
 * built from, so staleness is detectable and the whole `embeddings` table can
 * be deleted and rebuilt from `listings` at any time.
 */

import {
  SEARCH_DOCUMENT_VERSION,
  buildSearchDocument,
  type CatalogListing,
  type CatalogStore,
  type DiscoveryQuery,
} from "../catalog/index.js";
import { createHash } from "node:crypto";
import { EMBEDDING_MODEL, cosine, documentHash, embed } from "./embedder.js";
import {
  Bm25Index,
  DEFAULT_ABSTENTION_THRESHOLD,
  applyAbstention,
  decodeCursor,
  encodeCursor,
  type ScoredListing,
} from "./ranking.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export interface SearchRequest {
  query: string;
  filters?: Omit<DiscoveryQuery, "limit" | "offset">;
  limit?: number;
  cursor?: string;
}

export interface SearchResult {
  listing: CatalogListing;
  score: number;
}

export interface SearchResponse {
  resources: CatalogListing[];
  /** True when matches beyond this page were truncated. */
  partialResults: boolean;
  pagination: { limit: number; cursor: string | null } | null;
  /** Present when the engine declined to answer. Never null on abstention. */
  abstained?: { reason: string; topScore: number; threshold: number };
  /** Diagnostics; not part of the spec's response contract. */
  debug: { candidates: number; matched: number; topScore: number; latencyMs: number };
}

export interface SearchEngineOptions {
  threshold?: number;
  /** Also build the lexical index. Off by default; dense is the ranker. */
  buildLexical?: boolean;
}

/** Fingerprint of a query plus its filters, for cursor validation. */
function fingerprint(query: string, filters: SearchRequest["filters"]): string {
  const canonical = JSON.stringify({
    q: query.trim().toLowerCase(),
    f: {
      type: filters?.type ?? null,
      network: filters?.network ?? null,
      scheme: filters?.scheme ?? null,
      payTo: filters?.payTo ?? null,
      extensions: [...(filters?.extensions ?? [])].sort(),
    },
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

export class SearchEngine {
  private vectors = new Map<string, Float32Array>();
  private readonly lexical = new Bm25Index();
  private readonly threshold: number;
  private readonly buildLexical: boolean;

  constructor(
    private readonly store: CatalogStore,
    options: SearchEngineOptions = {},
  ) {
    this.threshold = options.threshold ?? DEFAULT_ABSTENTION_THRESHOLD;
    this.buildLexical = options.buildLexical ?? false;
  }

  /**
   * Bring the derived index into agreement with the catalog.
   *
   * Reuses a cached vector when the document hash, model and representation
   * version all still match, so a payment-only update — new amount, unchanged
   * description — costs no embedding work. Anything stale or missing is
   * re-embedded in one batch.
   *
   * @returns counts, so callers can report build cost.
   */
  async sync(): Promise<{ total: number; reused: number; embedded: number; pruned: number }> {
    const pruned = this.store.pruneEmbeddings();
    const listings = this.store.all();

    const cached = new Map(this.store.allEmbeddings().map((e) => [e.canonicalKey, e]));
    const next = new Map<string, Float32Array>();
    const toEmbed: Array<{ listing: CatalogListing; document: string; hash: string }> = [];

    for (const listing of listings) {
      const document = buildSearchDocument(listing);
      const hash = documentHash(document);
      const hit = cached.get(listing.canonicalKey);
      const fresh =
        hit &&
        hit.documentHash === hash &&
        hit.model === EMBEDDING_MODEL &&
        hit.docVersion === SEARCH_DOCUMENT_VERSION &&
        hit.vector.length > 0;

      if (fresh) next.set(listing.canonicalKey, hit.vector);
      else toEmbed.push({ listing, document, hash });
    }

    if (toEmbed.length > 0) {
      const built = await embed(toEmbed.map((item) => item.document));
      const builtAt = new Date().toISOString();
      for (const [i, item] of toEmbed.entries()) {
        const vector = built[i]!;
        next.set(item.listing.canonicalKey, vector);
        this.store.putEmbedding({
          canonicalKey: item.listing.canonicalKey,
          documentHash: item.hash,
          model: EMBEDDING_MODEL,
          docVersion: SEARCH_DOCUMENT_VERSION,
          vector,
          builtAt,
        });
      }
    }

    this.vectors = next;
    if (this.buildLexical) this.lexical.build(listings);

    return {
      total: listings.length,
      reused: listings.length - toEmbed.length,
      embedded: toEmbed.length,
      pruned,
    };
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const started = performance.now();
    const limit = Math.min(Math.max(request.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    // ---- 2 & 3. hard filters, then candidates ----------------------------
    // Delegated to the store so the predicate runs in SQL and the same filter
    // semantics back both discovery endpoints.
    const candidates = this.store.list({
      ...request.filters,
      limit: Number.MAX_SAFE_INTEGER,
      offset: 0,
    }).resources;

    if (candidates.length === 0) {
      return {
        resources: [],
        partialResults: false,
        pagination: null,
        abstained: { reason: "NO_ELIGIBLE_RESOURCES", topScore: 0, threshold: this.threshold },
        debug: { candidates: 0, matched: 0, topScore: 0, latencyMs: performance.now() - started },
      };
    }

    // ---- 4. rank ----------------------------------------------------------
    const [queryVector] = await embed([request.query]);
    const ranked: ScoredListing[] = [];
    for (const listing of candidates) {
      const vector = this.vectors.get(listing.canonicalKey);
      // A listing with no vector is not silently dropped: it ranks last with
      // score 0 rather than disappearing, so a stale index degrades ordering
      // instead of hiding a payable resource.
      ranked.push({ listing, score: vector ? cosine(queryVector!, vector) : 0 });
    }
    ranked.sort(
      (a, b) =>
        b.score - a.score || (a.listing.canonicalKey < b.listing.canonicalKey ? -1 : 1),
    );

    // ---- 5. abstain -------------------------------------------------------
    const decision = applyAbstention(ranked, { threshold: this.threshold });
    if (!decision.accepted) {
      return {
        resources: [],
        partialResults: false,
        pagination: null,
        abstained: {
          reason: "BELOW_RELEVANCE_THRESHOLD",
          topScore: decision.topScore,
          threshold: this.threshold,
        },
        debug: {
          candidates: candidates.length,
          matched: 0,
          topScore: decision.topScore,
          latencyMs: performance.now() - started,
        },
      };
    }

    // Only results at or above the threshold are returned. The tail of a good
    // query is still noise, and an agent paying for result #9 at cosine 0.05 is
    // the failure this whole policy exists to prevent.
    const matched = decision.results.filter((hit) => hit.score >= this.threshold);

    // ---- 6. paginate ------------------------------------------------------
    const print = fingerprint(request.query, request.filters);
    let offset = 0;
    if (request.cursor) {
      const state = decodeCursor(request.cursor);
      // A cursor from a different query or filter set is refused rather than
      // reinterpreted, so it cannot be used to page across a filter boundary.
      if (!state || state.fingerprint !== print) {
        return {
          resources: [],
          partialResults: false,
          pagination: null,
          abstained: { reason: "INVALID_CURSOR", topScore: 0, threshold: this.threshold },
          debug: {
            candidates: candidates.length,
            matched: matched.length,
            topScore: decision.topScore,
            latencyMs: performance.now() - started,
          },
        };
      }
      offset = state.offset;
    }

    const page = matched.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < matched.length;

    return {
      resources: page.map((hit) => hit.listing),
      // Real semantics, not a hard-coded false: true exactly when matches were
      // left behind.
      partialResults: hasMore,
      pagination: {
        limit,
        cursor: hasMore ? encodeCursor({ offset: nextOffset, fingerprint: print }) : null,
      },
      debug: {
        candidates: candidates.length,
        matched: matched.length,
        topScore: decision.topScore,
        latencyMs: performance.now() - started,
      },
    };
  }

  /** Lexical scores, for diagnostics and future score-aware routing. */
  lexicalScores(query: string): Map<string, number> {
    return this.lexical.score(query);
  }
}

/**
 * The canonical searchable representation of a listing.
 *
 * This is the single place that decides what text retrieval sees. The
 * benchmark and the live `/discovery/search` both call these functions, so a
 * change to the representation moves both at once and the measured numbers keep
 * describing the shipped system. Anything that reimplements this is drift.
 *
 * ## What is included, and why
 *
 * | Field | Included | Reason |
 * |---|---|---|
 * | `serviceName` | yes, weighted | The name is what a person searches for. |
 * | `description` | yes | Carries the intent an agent's query paraphrases. |
 * | `tags` | yes, weighted | Curated vocabulary; short and high-signal. |
 * | `toolName` | yes (MCP) | The tool name is the MCP equivalent of a name. |
 * | input parameter names | yes | `city`, `hsCode` disambiguate similar services. |
 * | input parameter descriptions | yes | RFP §3.2: this is what makes an endpoint legible to an agent. |
 * | output description/example keys | yes | Distinguishes services with similar inputs. |
 * | `resource` / `routeTemplate` | path only, lexical index only | `/weather/:city` carries signal; the host does not. |
 *
 * ## What is deliberately excluded
 *
 * `network`, `asset`, `payTo`, `amount`. These are **hard filter** inputs, not
 * ranking inputs. Embedding them would let a query mentioning "USDC" pull
 * services by payment metadata rather than by what they do, and every one of
 * them is already an exact, deterministic predicate applied before ranking. A
 * demonstrated retrieval reason would be needed to add them; there is none.
 *
 * Addresses are also high-entropy noise: `GDOEUTRI3CA…` tokenises into garbage
 * that dilutes every real term in the document.
 */

import type { CatalogListing } from "./types.js";

/**
 * Bump when the representation changes.
 *
 * Persisted embeddings record the version they were built with, so a change
 * here makes stale vectors identifiable and rebuildable rather than silently
 * mixed with new ones.
 */
export const SEARCH_DOCUMENT_VERSION = 1;

/** Caps applied before any text reaches an embedder or a tokenizer. */
export const SEARCH_LIMITS = {
  description: 2000,
  serviceName: 128,
  tags: 16,
  tagLength: 64,
  params: 32,
  paramDescription: 512,
  document: 8000,
} as const;

/**
 * Strip control characters and collapse whitespace.
 *
 * Hostile metadata reaches this function: it arrives in a payment payload from
 * a client. Upstream sanitisation already bounds `serviceName`, `tags` and
 * `iconUrl`, but `description` and parameter descriptions are not length-capped
 * upstream, and nothing guarantees well-formed Unicode. Lone surrogates are
 * replaced rather than thrown on, because a malformed listing must degrade to a
 * worse search result, never to a crashed index.
 */
function clean(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    // Replace unpaired surrogates, which throw in some encoders.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�")
    // C0/C1 control characters and zero-width joiners used for spoofing.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

interface ParamLike {
  name?: unknown;
  description?: unknown;
}

/**
 * Pull parameter names and descriptions out of the bazaar `info` block.
 *
 * The shape differs between HTTP (`input.query` / `input.body` with a JSON
 * Schema) and MCP (`input.inputSchema`), and it arrives client-controlled, so
 * this reads defensively and returns whatever it can recognise.
 */
function extractParams(discoveryInfo: unknown): ParamLike[] {
  const info = discoveryInfo as { input?: Record<string, unknown> } | undefined;
  const input = info?.input;
  if (!input || typeof input !== "object") return [];

  const schema = (input.inputSchema ?? input.querySchema ?? input.bodySchema) as
    | { properties?: Record<string, unknown> }
    | undefined;

  const properties = schema?.properties;
  if (!properties || typeof properties !== "object") return [];

  return Object.entries(properties)
    .slice(0, SEARCH_LIMITS.params)
    .map(([name, spec]) => ({
      name,
      description: (spec as { description?: unknown } | undefined)?.description,
    }));
}

/** Output example keys, which name the fields a caller gets back. */
function extractOutputKeys(discoveryInfo: unknown): string[] {
  const info = discoveryInfo as { output?: { example?: unknown } } | undefined;
  const example = info?.output?.example;
  if (!example || typeof example !== "object" || Array.isArray(example)) return [];
  return Object.keys(example as Record<string, unknown>).slice(0, SEARCH_LIMITS.params);
}

/** Path component of a resource URL, without host or scheme. */
function resourcePath(listing: Pick<CatalogListing, "resource" | "routeTemplate">): string {
  if (listing.routeTemplate) return listing.routeTemplate;
  try {
    const url = new URL(listing.resource);
    return url.pathname === "/" ? "" : url.pathname;
  } catch {
    return "";
  }
}

/**
 * Natural-language rendering of a listing, for an embedding model.
 *
 * Prose rather than a field dump: sentence-transformer models are trained on
 * sentences, and `"Weather Forecast. HTTP API endpoint. Returns…"` embeds
 * closer to `"will it rain tomorrow"` than a bag of labelled fields does.
 */
export function buildSearchDocument(
  listing: Pick<
    CatalogListing,
    "type" | "resource" | "routeTemplate" | "serviceName" | "description" | "tags" | "toolName" | "discoveryInfo"
  >,
): string {
  const name = clean(listing.serviceName, SEARCH_LIMITS.serviceName);
  const description = clean(listing.description, SEARCH_LIMITS.description);
  const tags = (listing.tags ?? [])
    .slice(0, SEARCH_LIMITS.tags)
    .map((tag) => clean(tag, SEARCH_LIMITS.tagLength))
    .filter(Boolean);

  const kind =
    listing.type === "mcp"
      ? `MCP tool ${clean(listing.toolName, SEARCH_LIMITS.serviceName)}`
      : "HTTP API endpoint";

  const params = extractParams(listing.discoveryInfo)
    .map((p) => {
      const paramName = clean(p.name, SEARCH_LIMITS.serviceName);
      const paramDescription = clean(p.description, SEARCH_LIMITS.paramDescription);
      if (!paramName) return "";
      return paramDescription ? `${paramName}: ${paramDescription}` : paramName;
    })
    .filter(Boolean)
    .join("; ");

  const outputs = extractOutputKeys(listing.discoveryInfo).join(", ");

  return [
    name ? `${name}.` : "",
    `${kind}.`,
    description,
    tags.length > 0 ? `Tags: ${tags.join(", ")}.` : "",
    params ? `Parameters: ${params}.` : "",
    outputs ? `Returns: ${outputs}.` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, SEARCH_LIMITS.document);
}

/**
 * Field-weighted tokens for lexical (BM25) retrieval.
 *
 * Repetition is the weighting mechanism: a term in the service name counts for
 * three occurrences, a tag for two. The multipliers are conventional round
 * numbers and were not fitted to the benchmark's queries.
 *
 * The resource path is included here but not in the embedding document — a
 * literal path segment is an exact-match signal, which is what BM25 is for, and
 * it reads as noise to a sentence encoder.
 */
export function buildSearchTokens(
  listing: Parameters<typeof buildSearchDocument>[0],
): string[] {
  const name = tokenize(clean(listing.serviceName, SEARCH_LIMITS.serviceName));
  const tags = (listing.tags ?? [])
    .slice(0, SEARCH_LIMITS.tags)
    .flatMap((tag) => tokenize(clean(tag, SEARCH_LIMITS.tagLength)));
  const params = extractParams(listing.discoveryInfo).flatMap((p) => [
    ...tokenize(clean(p.name, SEARCH_LIMITS.serviceName)),
    ...tokenize(clean(p.description, SEARCH_LIMITS.paramDescription)),
  ]);

  return [
    ...name, ...name, ...name,
    ...tags, ...tags,
    ...tokenize(clean(listing.description, SEARCH_LIMITS.description)),
    ...(listing.toolName ? tokenize(clean(listing.toolName, SEARCH_LIMITS.serviceName)) : []),
    ...params,
    ...extractOutputKeys(listing.discoveryInfo).flatMap((key) => tokenize(key)),
    ...tokenize(resourcePath(listing)),
  ];
}

/**
 * A compact English stopword list.
 *
 * Deliberately short: an aggressive list strips terms that carry real signal
 * here ("how", "much", "up"), and the queries are natural language rather than
 * keywords.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for",
  "from", "i", "if", "in", "is", "it", "its", "me", "my", "of", "on", "or",
  "that", "the", "then", "there", "these", "they", "this", "to", "was", "were",
  "will", "with", "you", "your",
]);

/**
 * Lowercase, split on non-alphanumerics, drop stopwords and single characters.
 *
 * No stemmer: it would help ("translation"/"translate") and hurt
 * ("price"/"priced"), and it adds a dependency whose licence needs auditing
 * under RFP §3.6 for a gain the benchmark can measure later rather than assume.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

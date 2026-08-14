/** Read-path re-exports of `@stellar-bazaar/search`. Unchanged surface. */
export { EMBEDDING_DIMS, EMBEDDING_MODEL, cosine, documentHash, embed } from "./embedder.js";
export { SearchEngine } from "./engine.js";
export type { SearchEngineOptions, SearchRequest, SearchResponse, SearchResult } from "./engine.js";
export {
  Bm25Index,
  DEFAULT_ABSTENTION_THRESHOLD,
  applyAbstention,
  decodeCursor,
  encodeCursor,
} from "./ranking.js";
export type { AbstentionPolicy, CursorState, ScoredListing } from "./ranking.js";

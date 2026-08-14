/**
 * Read-path re-exports of `@stellar-bazaar/catalog`.
 *
 * The upstream package's `index.ts` also exports `catalog.ts` (the settlement
 * write path) and `store.ts` (SQLite). Neither is vendored here: this preview
 * has no write path and no database, so the modules that would provide one do
 * not exist in the deployed artifact.
 */
export { httpCanonicalKey, mcpCanonicalKey, normalizeResourceUrl } from "./canonical.js";
export {
  SEARCH_DOCUMENT_VERSION,
  SEARCH_LIMITS,
  buildSearchDocument,
  buildSearchTokens,
  tokenize,
} from "./search-document.js";
export {
  DISCOVERY_X402_VERSION,
  toDiscoveryResource,
  toDiscoveryResourcesResponse,
  toDiscoverySearchResponse,
} from "./wire.js";
export type {
  BazaarStatus,
  CatalogListing,
  CatalogOutcome,
  CatalogRejectionCode,
  CatalogStore,
  EmbeddingRecord,
  DiscoveryPage,
  DiscoveryQuery,
  OwnershipBinding,
  ResourceType,
} from "./types.js";

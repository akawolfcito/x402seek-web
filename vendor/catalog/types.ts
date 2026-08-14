/**
 * Catalog contracts.
 *
 * The persisted model deliberately keeps two groups of fields apart:
 *
 * - **Settled facts** — `payTo`, `network`, `scheme`, `asset`, `amount`,
 *   `ownerPayTo`. Copied from the `PaymentRequirements` the facilitator itself
 *   validated and Soroban enforced. Not writable from discovery metadata.
 * - **Declared metadata** — `serviceName`, `description`, `tags`, `iconUrl`,
 *   `discoveryInfo`. Client-controlled, sanitised by upstream
 *   `@x402/extensions/bazaar` helpers before it reaches here.
 *
 * See docs/security/catalog-ownership-model.md for why the split exists.
 */

/** How strongly the owner binding is evidenced. */
export type OwnershipBinding =
  /** Bound to the payTo observed at first settlement. No proof of URL control. */
  | "tofu"
  /** Reserved: origin published a .well-known document authorizing this payTo. */
  | "domain-verified";

export type ResourceType = "http" | "mcp";

/** A persisted discovery listing. */
export interface CatalogListing {
  /** Dedup key. HTTP: normalized URL. MCP: normalized URL + "#tool=" + toolName. */
  canonicalKey: string;
  type: ResourceType;
  /** Canonical resource URL, including routeTemplate for parameterised routes. */
  resource: string;
  /** Present iff `type === "http"` and the route is parameterised. */
  routeTemplate?: string;
  /** HTTP verb, when the discovery info declares one. */
  method?: string;
  /** Present iff `type === "mcp"`. */
  toolName?: string;

  // ---- declared metadata (sanitised upstream) ----
  serviceName?: string;
  description?: string;
  tags?: string[];
  iconUrl?: string;
  mimeType?: string;
  /** The bazaar `info` block: input/output shape. Stored verbatim once validated. */
  discoveryInfo: unknown;
  /** The full extensions map echoed in the payload, for round-tripping. */
  extensions?: Record<string, unknown>;

  // ---- settled facts ----
  payTo: string;
  network: string;
  scheme: string;
  asset: string;
  amount: string;
  x402Version: number;

  // ---- ownership ----
  ownerPayTo: string;
  ownershipBinding: OwnershipBinding;

  // ---- provenance ----
  firstSeenAt: string;
  lastSeenAt: string;
  /** Transaction hash of the settlement that last updated this listing. */
  lastSettlementTx: string;
  /** Schema version of this row, so a migration can find rows to rewrite. */
  metadataVersion: number;
}

/**
 * Machine-readable rejection reasons.
 *
 * `specs/extensions/bazaar.md` types `bazaar.rejectedReason` only as a
 * human-readable string and defines no enum, so these are ours. They are
 * emitted as `CODE: human explanation` — the code is greppable, the sentence
 * satisfies the spec, and nothing about the wire shape is incompatible.
 */
export type CatalogRejectionCode =
  | "INVALID_SCHEMA"
  | "INVALID_ROUTE_TEMPLATE"
  | "INVALID_METADATA"
  | "OWNERSHIP_CONFLICT"
  | "CATALOG_WRITE_FAILED";

/** Spec status values for the bazaar key of `EXTENSION-RESPONSES`. */
export type BazaarStatus = "success" | "processing" | "rejected";

/**
 * The result of attempting to catalog one settlement.
 *
 * `noop` covers a replayed callback for a settlement already recorded: nothing
 * changed, but nothing was wrong either, so the wire status stays `success`.
 */
export type CatalogOutcome =
  | {
      kind: "cataloged";
      status: "success";
      listing: CatalogListing;
      created: boolean;
      /** True when a malformed `routeTemplate` was dropped, per upstream soft-drop. */
      droppedRouteTemplate?: boolean;
    }
  | { kind: "noop"; status: "success"; listing: CatalogListing }
  | { kind: "skipped"; status: null; reason: "no-bazaar-extension" }
  | { kind: "rejected"; status: "rejected"; code: CatalogRejectionCode; message: string };

/** Filters for `GET /discovery/resources`, per specs/extensions/bazaar.md. */
export interface DiscoveryQuery {
  type?: ResourceType;
  payTo?: string;
  network?: string;
  scheme?: string;
  /** Extension keys that must be present on the listing. */
  extensions?: string[];
  limit?: number;
  offset?: number;
}

export interface DiscoveryPage {
  resources: CatalogListing[];
  pagination: { limit: number; offset: number; total: number };
}

/**
 * A cached embedding for one listing.
 *
 * `documentHash`, `model` and `docVersion` together decide freshness: if any
 * differs from what the current listing and code would produce, the vector is
 * stale and gets rebuilt. This is what makes a payment-only update — new
 * amount, same description — skip re-embedding.
 */
export interface EmbeddingRecord {
  canonicalKey: string;
  /** Hash of the string `buildSearchDocument` produced. */
  documentHash: string;
  model: string;
  docVersion: number;
  vector: Float32Array;
  builtAt: string;
}

/** Persistence boundary. Implemented by the SQLite store; swappable. */
export interface CatalogStore {
  /**
   * Insert or update, enforcing the ownership rule atomically.
   *
   * Must be a single transaction: read-then-write across two statements would
   * let two concurrent settlements both observe "no owner" and race.
   */
  upsert(listing: CatalogListing): CatalogOutcome;
  get(canonicalKey: string): CatalogListing | undefined;
  list(query: DiscoveryQuery): DiscoveryPage;

  // ---- derived search index ----
  /** Every listing, for a full index rebuild. */
  all(): CatalogListing[];
  putEmbedding(record: EmbeddingRecord): void;
  allEmbeddings(): EmbeddingRecord[];
  pruneEmbeddings(): number;
  clearEmbeddings(): void;

  close(): void;
}

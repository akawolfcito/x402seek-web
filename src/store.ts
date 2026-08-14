/**
 * A frozen, read-only `CatalogStore` over the committed snapshot.
 *
 * `CatalogStore` is documented upstream as "Persistence boundary… swappable",
 * and this is the swap: the same interface the SQLite store implements, backed
 * by a JSON file that is loaded once and never written.
 *
 * ## Why the preview does not ship the SQLite store
 *
 * The real store's `upsert` is the catalog *write* path. This service has no
 * settlement to write from, so shipping a writable store would mean carrying
 * code whose only purpose is a capability the preview must not have. Instead
 * `upsert` throws: the catalog is not merely unused, it is structurally
 * immutable, and any future code path that tried to mutate it would fail loudly
 * in tests rather than quietly succeed in production.
 *
 * Embedding writes *are* permitted. Vectors are derived state — `SearchEngine`
 * rebuilds them from the listings at boot — so allowing them mutates nothing a
 * reviewer sees, and forbidding them would mean reimplementing `sync()`.
 *
 * Filter and ordering semantics mirror `SqliteCatalogStore.list()` exactly:
 * equality on `type`/`payTo`/`network`/`scheme`, presence for `extensions`,
 * `ORDER BY first_seen_at ASC, canonical_key ASC`, and the same
 * default-20 / max-100 clamp. The engine applies these before ranking, so a
 * resource on the wrong network is not a low-ranked result — it is not a result.
 */

import type {
  CatalogListing,
  CatalogOutcome,
  CatalogStore,
  DiscoveryPage,
  DiscoveryQuery,
  EmbeddingRecord,
} from "../vendor/catalog/index.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export class ReadOnlyCatalogError extends Error {
  constructor() {
    super("the x402Seek preview catalog is frozen and cannot be written to");
    this.name = "ReadOnlyCatalogError";
  }
}

export class FrozenCatalogStore implements CatalogStore {
  private readonly byKey: Map<string, CatalogListing>;
  private readonly ordered: CatalogListing[];
  private embeddings = new Map<string, EmbeddingRecord>();

  constructor(listings: CatalogListing[]) {
    this.ordered = [...listings].sort(
      (a, b) =>
        a.firstSeenAt.localeCompare(b.firstSeenAt) ||
        a.canonicalKey.localeCompare(b.canonicalKey),
    );
    this.byKey = new Map(this.ordered.map((l) => [l.canonicalKey, l]));
  }

  /** Always throws. See the note at the top of this file. */
  upsert(_listing: CatalogListing): CatalogOutcome {
    throw new ReadOnlyCatalogError();
  }

  get(canonicalKey: string): CatalogListing | undefined {
    return this.byKey.get(canonicalKey);
  }

  list(query: DiscoveryQuery): DiscoveryPage {
    const matches = this.ordered.filter((l) => {
      if (query.type && l.type !== query.type) return false;
      if (query.payTo && l.payTo !== query.payTo) return false;
      if (query.network && l.network !== query.network) return false;
      if (query.scheme && l.scheme !== query.scheme) return false;
      for (const key of query.extensions ?? []) {
        if (!l.extensions || !(key in l.extensions)) return false;
      }
      return true;
    });

    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(query.offset ?? 0, 0);

    return {
      resources: matches.slice(offset, offset + limit),
      pagination: { limit, offset, total: matches.length },
    };
  }

  all(): CatalogListing[] {
    return [...this.ordered];
  }

  putEmbedding(record: EmbeddingRecord): void {
    this.embeddings.set(record.canonicalKey, record);
  }

  allEmbeddings(): EmbeddingRecord[] {
    return [...this.embeddings.values()];
  }

  /** Drops vectors whose listing no longer exists. Always 0 on a frozen catalog. */
  pruneEmbeddings(): number {
    let pruned = 0;
    for (const key of this.embeddings.keys()) {
      if (!this.byKey.has(key)) {
        this.embeddings.delete(key);
        pruned += 1;
      }
    }
    return pruned;
  }

  clearEmbeddings(): void {
    this.embeddings.clear();
  }

  close(): void {
    /* nothing to release: no file handle, no connection */
  }
}

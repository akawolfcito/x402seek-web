/**
 * Ranking, abstention and cursors.
 *
 * Dense-first, because the benchmark said so. Held-out nDCG@10 on the synthetic
 * corpus: reference `includes()` 22.6%, BM25 83.0%, dense 95.3%, RRF hybrid
 * 93.6%. Fusing the two arms *lowered* the score, and cost 10.8 points on the
 * natural-language category specifically, because RRF reads rank rather than
 * confidence and a near-noise lexical ranking still contributes `1/(60+rank)`.
 * So the hybrid is not shipped. The lexical arm is kept because it is the only
 * retriever here that abstains cleanly (see `ABSTENTION` below) and because it
 * is the substrate for score-aware routing later.
 */

import type { CatalogListing } from "../catalog/index.js";
import { buildSearchTokens, tokenize } from "../catalog/index.js";

export interface ScoredListing {
  listing: CatalogListing;
  score: number;
}

// --------------------------------------------------------------------------
// Lexical (BM25)
// --------------------------------------------------------------------------

/**
 * Okapi BM25 with Lucene's always-positive idf.
 *
 * The classic Robertson/Sparck-Jones idf goes negative for terms in more than
 * half the corpus, which on a small catalog would penalise a listing for
 * containing a common word like "search".
 *
 * k1 and b are the conventional literature defaults and were not fitted here.
 */
export class Bm25Index {
  private docs: Array<{ key: string; length: number; frequencies: Map<string, number> }> = [];
  private documentFrequency = new Map<string, number>();
  private averageLength = 0;

  constructor(
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {}

  build(listings: CatalogListing[]): void {
    this.docs = listings.map((listing) => {
      const tokens = buildSearchTokens(listing);
      const frequencies = new Map<string, number>();
      for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      return { key: listing.canonicalKey, length: tokens.length, frequencies };
    });

    this.documentFrequency = new Map();
    for (const doc of this.docs) {
      for (const term of doc.frequencies.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
    }

    const total = this.docs.reduce((sum, d) => sum + d.length, 0);
    this.averageLength = this.docs.length === 0 ? 0 : total / this.docs.length;
  }

  /** Scores by canonical key. Absent key means the query matched nothing. */
  score(query: string): Map<string, number> {
    const terms = tokenize(query);
    const scores = new Map<string, number>();
    if (terms.length === 0 || this.docs.length === 0) return scores;

    const n = this.docs.length;
    for (const doc of this.docs) {
      let score = 0;
      for (const term of terms) {
        const f = doc.frequencies.get(term);
        if (!f) continue;
        const df = this.documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const denominator =
          f + this.k1 * (1 - this.b + (this.b * doc.length) / (this.averageLength || 1));
        score += idf * ((f * (this.k1 + 1)) / denominator);
      }
      if (score > 0) scores.set(doc.key, score);
    }
    return scores;
  }
}

// --------------------------------------------------------------------------
// Abstention
// --------------------------------------------------------------------------

/**
 * Cosine below which the catalog answers "nothing here" instead of guessing.
 *
 * Why abstention is a deliverable rather than a nicety: dense retrieval always
 * returns its nearest neighbour. On unanswerable queries the top hit still
 * scores around 0.18 cosine, and an agent acting on that pays real money for an
 * irrelevant service. BM25 abstains for free — no shared term, no score — which
 * is most of why the lexical arm stays in the codebase.
 *
 * ## How 0.22 was chosen
 *
 * `pnpm calibrate` sweeps the threshold on the **dev split only**; the 20
 * held-out queries were not read. Dev sweep (34 answerable, 2 unanswerable):
 *
 * ```
 *    T    coverage  reject  FP-rate  nDCG@10|accepted
 *  0.15    100.0%    50.0%   50.0%      92.0%
 *  0.20     97.1%   100.0%    0.0%      89.4%
 *  0.22     97.1%   100.0%    0.0%      86.9%   <- shipped
 *  0.24     97.1%   100.0%    0.0%      85.4%
 *  0.26     94.1%   100.0%    0.0%      85.9%
 *  0.30     91.2%   100.0%    0.0%      81.2%
 * ```
 *
 * 0.20–0.24 is a plateau: coverage and rejection are both flat across it. The
 * middle of a plateau is the right place to sit, because an edge is where
 * sampling noise bites. 0.22 leaves 0.037 of margin above the largest observed
 * negative score (0.1827) while costing one answerable dev query.
 *
 * ## What it gets wrong, and what the numbers do not support
 *
 * **The two distributions overlap.** The weakest answerable dev query scores
 * 0.1523, *below* the strongest unanswerable one at 0.1827. No threshold
 * separates them cleanly, so any choice trades a real query for a refused
 * irrelevant one. We bias toward refusing: a false positive makes an agent pay
 * for the wrong service, a false negative makes it find nothing and fall back.
 * Money lost beats a retry.
 *
 * **The dev split has two negative queries.** Two. "100% rejection" is two data
 * points and rejection rate can only move in 50% steps, so this threshold is a
 * defensible starting point and emphatically not a calibrated one. Treat it as
 * the conservative default it is.
 *
 * ## How it evolves
 *
 * Real `/discovery/search` logs replace the guesswork: queries that returned
 * results but were never followed by a settlement are candidate false
 * positives, and the score distribution of queries that *did* convert gives a
 * per-catalog threshold instead of one global constant. Until then this stays a
 * single documented number rather than a classifier nobody can audit.
 */
export const DEFAULT_ABSTENTION_THRESHOLD = 0.22;

export interface AbstentionPolicy {
  /** Minimum top-1 cosine for the result set to be returned at all. */
  threshold: number;
}

/**
 * Apply the policy to a ranked list.
 *
 * All-or-nothing on the top score rather than per-result filtering: a query the
 * catalog cannot serve should return an empty set, not a short tail of weak
 * matches that an agent might still try.
 */
export function applyAbstention(
  ranked: ScoredListing[],
  policy: AbstentionPolicy,
): { accepted: boolean; results: ScoredListing[]; topScore: number } {
  const topScore = ranked[0]?.score ?? 0;
  if (topScore < policy.threshold) return { accepted: false, results: [], topScore };
  return { accepted: true, results: ranked, topScore };
}

// --------------------------------------------------------------------------
// Cursor
// --------------------------------------------------------------------------

/**
 * Opaque continuation cursor.
 *
 * It is an offset plus a fingerprint of the query and filters, base64url
 * encoded — stated plainly rather than dressed up, because the spec allows an
 * advisory cursor and pretending this is a keyset cursor would be a lie.
 *
 * The fingerprint is what makes it safe. A cursor is only accepted for the same
 * query and the same filters that produced it, so a client cannot carry a
 * cursor from a permissive search into a restrictive one and page through
 * results the second search would have excluded. Nothing inside references SQL,
 * row ids or any internal state: decoding one yields an integer and a hash.
 *
 * Ranking itself is deterministic — same catalog, same query, same order — so
 * offsets are stable between pages unless the catalog changes underneath, which
 * is the documented limitation of every offset scheme.
 */
export interface CursorState {
  offset: number;
  fingerprint: string;
}

export function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify([state.offset, state.fingerprint]), "utf8").toString(
    "base64url",
  );
}

/** @returns the state, or undefined if the cursor is malformed. */
export function decodeCursor(cursor: string): CursorState | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [offset, fingerprint] = parsed;
    if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) return undefined;
    if (typeof fingerprint !== "string" || fingerprint.length > 64) return undefined;
    return { offset, fingerprint };
  } catch {
    return undefined;
  }
}

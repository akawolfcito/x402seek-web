/**
 * Recorded evidence, quoted from the frozen SCF core at `762c6e6`.
 *
 * Every value here is transcribed from a committed artifact or from
 * `docs/scf/evidence-log.md`, and each carries the E-number and artifact path it
 * came from so a reviewer can check it rather than trust it.
 *
 * This file must never contain a number that is not in that repository. There
 * are deliberately no counters, no uptime, no "services indexed" and no
 * "transactions today": this service observes no traffic and must not imply it
 * does.
 */

export interface EvidenceLink {
  label: string;
  hash: string;
}

const explorer = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;

export const EXPLORER_BASE = "https://stellar.expert/explorer/testnet/tx/";

/** Upstream x402 conformance. Source: artifacts/e2e/upstream-e2e-results.json, E-18. */
export const CONFORMANCE = {
  payments: { passed: 9, total: 9 },
  /** Source: docs/scf/evidence-log.md E-18. Not carried in the results artifact. */
  discovery: { passed: 5, total: 5 },
  upstreamCommit: "c8247c4cd15f29498474404d94636e7dbb894e86",
  servers: ["Express", "Fastify", "Hono", "Next", "MCP"],
} as const;

/**
 * On-chain balance deltas for the nine-payment USDC run.
 * Source: artifacts/e2e/balances-before-usdc2.json / balances-after-usdc2.json, E-19.
 */
export const SETTLEMENT = {
  asset: "canonical testnet USDC",
  assetContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  buyerUsdcDelta: "-0.0090000",
  buyerXlmDelta: "+0.0000000",
  facilitatorXlmDelta: "-0.0206757",
  payments: 9,
  perPayment: "0.0010000",
} as const;

/** Transactions the frozen proposal itself publishes. */
export const TRANSACTIONS: EvidenceLink[] = [
  {
    label: "Representative upstream settlement (E-19)",
    hash: "117b374785bf3bdfdd8ff7d5ac888771fd62ee5faf27372efb4f2e2fbffacc4d",
  },
  {
    label: "Agent discovery → pay → invoke (E-22…E-25)",
    hash: "f92a6aeca76861010f90f7e36d11837e6a9463df40b4a0b9024b6a2c6c16ed4b",
  },
];

/** Retrieval benchmark. Source: artifacts/retrieval-eval/latest.json, E-01…E-03. */
export const BENCHMARK = {
  corpusDocuments: 65,
  queriesTotal: 56,
  queriesTuning: 36,
  queriesHeldOut: 20,
  corpusVersion: "2026-08-11.1",
  retrievers: [
    { name: "Reference substring search", ndcgAt10: 22.6, reference: true },
    { name: "BM25", ndcgAt10: 83.0, reference: false },
    { name: "Wayfinder dense retrieval", ndcgAt10: 95.3, reference: false, shipped: true },
    { name: "Hybrid RRF", ndcgAt10: 93.5, reference: false },
  ],
  caveat: "Held-out synthetic benchmark — not production accuracy.",
} as const;

/**
 * The agent demo, from artifacts/e2e/mcp-discovery-pay-call.json (E-22…E-25).
 * `settlementMs` is 8597.76 of a total 8611.92, hence "all but 14 ms".
 */
export const AGENT_DEMO = {
  query: "I need something that can condense a long passage of text",
  tool: "Text Summarizer",
  resource: "mcp://127.0.0.1:4531/tool/summarize_text",
  totalMs: 8612,
  settlementMs: 8598,
  refusals: [
    { code: "PAYMENT_REQUIREMENTS_CHANGED", why: "discovered amount was stale" },
    { code: "PRICE_EXCEEDS_LIMIT", why: "price above the caller's ceiling" },
    { code: "INVALID_RESOURCE", why: "authority-less mcp:// URL was unreachable" },
  ],
} as const;

export const STATUS = {
  built: [
    "exact Stellar testnet settlement",
    "automatic Bazaar cataloging from settled payments",
    "persistent natural-language discovery search",
    "abstention below a calibrated relevance threshold",
    "MCP discovery → pay → invoke, end to end",
    "upstream x402 conformance suite, 9/9 and 5/5",
    "transitive licence audit with a CI gate",
  ],
  planned: [
    "publicly hosted facilitator",
    "stellar:pubnet",
    "the upto scheme and its Soroban contract",
    "contract-account (__check_auth) support",
    "third-party Audit Bank security review",
    ".well-known/x402 domain binding",
  ],
  disclosure:
    "The public Wayfinder preview exposes discovery only. The facilitator is not " +
    "currently operated as a public settlement service.",
} as const;

export { explorer };

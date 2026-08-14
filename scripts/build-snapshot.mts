/**
 * Build the frozen preview catalog from the SCF core repository's committed
 * source and committed evidence artifacts.
 *
 * ## What this does and does not do
 *
 * It does **not** invent services, rewrite resource URLs, fabricate endpoints,
 * or synthesise transaction history. Every listing corresponds to a resource
 * that was cataloged in a recorded Stellar testnet run by a real settled
 * payment, and carries that run's transaction hash.
 *
 * Discovery metadata is produced by calling the **real**
 * `declareDiscoveryExtension` from `@x402/extensions/bazaar`, not by
 * hand-writing what we think it emits. That distinction matters: the helper
 * puts a declared `inputSchema` under `schema`, and only `queryParams` under
 * `info.input`. `buildSearchDocument` reads `info`, so hand-writing the shape
 * would have silently changed what the ranker sees.
 *
 * ## Why it runs inside the core repo
 *
 * `@x402/extensions` and `catalog-seller.ts` only resolve from within
 * `apps/e2e-stellar`. Node's ESM resolver keys on the *script's* location, so
 * this file copies a shim into that workspace, runs it, and removes it. The
 * core repository is left byte-identical; nothing is written to it that
 * survives the run.
 *
 * Output is committed, so the deployed service never needs the core repo.
 *
 * Usage: pnpm build:snapshot [--core ../facilitador-stellar]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "data", "snapshot.json");

const coreArgIndex = process.argv.indexOf("--core");
const CORE = resolve(
  coreArgIndex === -1 ? join(HERE, "..", "..", "facilitador-stellar") : process.argv[coreArgIndex + 1]!,
);

/**
 * The shim. Runs inside `apps/e2e-stellar` so that `@x402/extensions` and the
 * seller definitions resolve, and prints the assembled listings as JSON.
 *
 * Every constant below is quoted from committed evidence; the comment on each
 * names the artifact it came from.
 */
const SHIM = String.raw`
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { PAID_RESOURCES } from "./src/catalog-seller.js";
import { TOOL_NAME } from "./src/mcp-tool-server.js";

// apps/e2e-stellar/src/search.ts:27 — SELLER_PORT for the recorded search run.
const SELLER_PORT = 4413;
// artifacts/e2e/mcp-discovery-pay-call.json — discoveredTool.resource authority.
const MCP_PORT = 4531;

// Seller account, recorded in artifacts/e2e/stellar-testnet-bazaar-catalog.json
// and artifacts/e2e/mcp-discovery-pay-call.json (payment.payTo).
const PAY_TO = "GDOEUTRI3CA534VATJBFTEFDOOAQR47UQBBLNRQ2IWAPLHV2OF433ULR";

// apps/e2e-stellar/src/provision.ts:43 provisions Asset.native().contractId(TESTNET);
// artifacts/e2e/stellar-testnet-exact.json and …-bazaar-catalog.json both record
// this exact contract for the runs from this harness.
const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
// artifacts/e2e/mcp-discovery-pay-call.json — payment.asset (canonical testnet USDC).
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

// apps/e2e-stellar/src/provision.ts:59 — E2E_AMOUNT, and every recorded artifact.
const AMOUNT = "10000";

// artifacts/e2e/stellar-testnet-bazaar-search.json — catalog.settlements[].
const HTTP_TX = {
  "/weather/forecast": "f2d314684a2ff1470876f4f7ae8287b7a7e0897b0172ae885de779a606488e59",
  "/weather/history": "cef5279fe5549c51c1d8f60a0d80e70714fd9d4fcc2627b3fd97b4169c3edf54",
  "/weather/alerts": "4686c7c642d56fce5f6bc3e2a9e164d386542ad4ab79a2a7663bed173062b11c",
  "/translate/text": "aad676cd8cf932cc0844431aad1806569f8f82953ecee1d4cc9bb99361c96027",
  "/translate/document": "a60acdb9d0c4409d50680b22359bf25fe4f9e9e04257f0f3352f3a90d9103741",
  "/tokens/translation-table": "325a347a047f39cd934ea3bc668603d45ffab24468ce82074402a1f11d0ff3de",
};

// artifacts/e2e/stellar-testnet-bazaar-search.json — startedAt / finishedAt.
const HTTP_RUN_AT = "2026-08-12T05:34:24.732Z";
// artifacts/e2e/mcp-discovery-pay-call.json — seedTransaction cataloged the tool,
// payment.transaction is the agent's own purchase that last touched the listing.
const MCP_SEED_TX = "530f07513fdebfdc05db9ced910157d0b5cdd48758ff9dacd7dc00127e675b8d";
const MCP_TX = "f92a6aeca76861010f90f7e36d11837e6a9463df40b4a0b9024b6a2c6c16ed4b";
const MCP_RUN_AT = "2026-08-13T17:13:39.920Z";

const listings = [];

for (const r of PAID_RESOURCES) {
  const resource = "http://127.0.0.1:" + SELLER_PORT + r.path;
  const ext = declareDiscoveryExtension(r.discovery);
  listings.push({
    canonicalKey: resource,
    type: "http",
    resource,
    method: r.discovery.method,
    serviceName: r.serviceName,
    description: r.description,
    tags: r.tags,
    mimeType: "application/json",
    discoveryInfo: ext.bazaar.info,
    extensions: { bazaar: {} },
    payTo: PAY_TO,
    network: "stellar:testnet",
    scheme: "exact",
    asset: XLM_SAC,
    amount: AMOUNT,
    x402Version: 2,
    ownerPayTo: PAY_TO,
    ownershipBinding: "tofu",
    firstSeenAt: HTTP_RUN_AT,
    lastSeenAt: HTTP_RUN_AT,
    lastSettlementTx: HTTP_TX[r.path],
    metadataVersion: 1,
  });
}

const mcpResource = "mcp://127.0.0.1:" + MCP_PORT + "/tool/" + TOOL_NAME;
const mcpExt = declareDiscoveryExtension({
  toolName: TOOL_NAME,
  description:
    "Condense a passage of text into one short summary line. Accepts plain text and " +
    "returns a single sentence with a word count.",
  transport: "sse",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to summarize, as plain UTF-8" },
    },
    required: ["text"],
  },
  output: { example: { summary: "the quick brown fox jumped over… (12 words)" } },
});

listings.push({
  canonicalKey: mcpResource + "#tool=" + TOOL_NAME,
  type: "mcp",
  resource: mcpResource,
  toolName: TOOL_NAME,
  serviceName: "Text Summarizer",
  description: "Summarize a block of text into a single short line.",
  tags: ["summarization", "text", "nlp"],
  discoveryInfo: mcpExt.bazaar.info,
  extensions: { bazaar: {} },
  payTo: PAY_TO,
  network: "stellar:testnet",
  scheme: "exact",
  asset: USDC,
  amount: AMOUNT,
  x402Version: 2,
  ownerPayTo: PAY_TO,
  ownershipBinding: "tofu",
  firstSeenAt: MCP_RUN_AT,
  lastSeenAt: MCP_RUN_AT,
  lastSettlementTx: MCP_TX,
  seedSettlementTx: MCP_SEED_TX,
  metadataVersion: 1,
});

process.stdout.write(JSON.stringify(listings));
`;

const shimPath = join(CORE, "apps", "e2e-stellar", ".x402seek-snapshot.mts");

let raw: string;
try {
  writeFileSync(shimPath, SHIM, "utf8");
  raw = execFileSync(
    "pnpm",
    ["--filter", "@stellar-bazaar/e2e-stellar", "exec", "tsx", ".x402seek-snapshot.mts"],
    { cwd: CORE, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
} finally {
  rmSync(shimPath, { force: true });
}

const listings = JSON.parse(raw.slice(raw.indexOf("[")));

const snapshot = {
  schemaVersion: 1,
  builtAt: new Date().toISOString(),
  coreCommit: "762c6e60dee76f47283e38e1f6928429e95f4f84",
  /** Read by the server purely to render provenance; never used for ranking. */
  provenance: {
    note:
      "Every listing was cataloged by a real settled payment in a recorded Stellar " +
      "testnet run. Resource URLs are the local origins those runs used and are " +
      "preserved verbatim; they are not public endpoints.",
    httpRun: {
      artifact: "artifacts/e2e/stellar-testnet-bazaar-search.json",
      evidence: "E-12, E-13",
      asset: "native XLM Stellar Asset Contract",
      resources: 6,
    },
    mcpRun: {
      artifact: "artifacts/e2e/mcp-discovery-pay-call.json",
      evidence: "E-22…E-25",
      asset: "canonical testnet USDC",
      resources: 1,
    },
  },
  listings,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

console.log(`wrote ${OUT}`);
console.log(`  listings : ${listings.length}`);
for (const l of listings) console.log(`  ${l.type.padEnd(4)} ${l.serviceName}`);

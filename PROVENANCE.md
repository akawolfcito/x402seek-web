# Provenance

Every byte this service serves traces to the frozen SCF core at
**`762c6e60dee76f47283e38e1f6928429e95f4f84`**. This file records what came from
where, so the claim is checkable rather than trusted.

Run `pnpm verify:vendor` to re-check the code half automatically.

---

## Vendored source

Copied verbatim from the core. SHA-256 is of the **original** file at the pinned
commit, before the one documented rewrite.

| Vendored path | Core path | sha256 (original) |
|---|---|---|
| `vendor/catalog/types.ts` | `packages/catalog/src/types.ts` | `dea41ee11cb0ac09a81f62dbd89a56679ebe2ecf068f4ff542f96c4f4051e41b` |
| `vendor/catalog/wire.ts` | `packages/catalog/src/wire.ts` | `0929a6e2b4d5389d45ed0418988f5ad0e12ab97c6f782c84ee13f71fb8ca3799` |
| `vendor/catalog/search-document.ts` | `packages/catalog/src/search-document.ts` | `e681cd2c60128c738fa590a876a2b9b953b3b396fb52a40539586df77cbdc590` |
| `vendor/catalog/canonical.ts` | `packages/catalog/src/canonical.ts` | `2c21061a61b074031fb0ddca0e0e72bfeb07f6cec6653829170d10bb823def38` |
| `vendor/search/embedder.ts` | `packages/search/src/embedder.ts` | `e9d6c788e901a30149490c641137032cecc068e2fb671d080ddd33fadb3a746a` |
| `vendor/search/engine.ts` | `packages/search/src/engine.ts` | `f230819bcd6cd61388c3eb438d489983ea8181523c86a2c777edc8adedcb0477` |
| `vendor/search/ranking.ts` | `packages/search/src/ranking.ts` | `7644fd0e466ce4082c23614cb530b89e81d2dc1d177dc70bf580b2726a7292f2` |

**The only modification**, applied to `engine.ts` and `ranking.ts`:

```
"@stellar-bazaar/catalog"  →  "../catalog/index.js"
```

A workspace specifier cannot resolve outside the core's pnpm workspace.
`verify:vendor` applies exactly this rewrite to the pinned original and fails on
any other difference.

`vendor/*/index.ts` are new barrel files, not copies. `vendor/catalog/index.ts`
deliberately re-exports **less** than the core's: it omits `catalog.ts` (the
settlement write path) and `store.ts` (SQLite), neither of which is vendored.

---

## Why those two files are absent

Omitting them is the reviewer-safety property this service rests on. Without
`catalog.ts` there is no code path that can write a listing from a settlement;
without `store.ts` there is no database to write to. The production dependency
graph consequently contains no `@x402/*` package and no database driver — the
absence is structural, not configured, and `pnpm audit:licenses` shows it.

---

## Snapshot listings

`data/snapshot.json`, 7 listings, built by `scripts/build-snapshot.mts`. Each
was cataloged in a recorded testnet run by a real settled payment.

### 6 HTTP resources — E-12, E-13

- **Metadata**: `apps/e2e-stellar/src/catalog-seller.ts` (`PAID_RESOURCES`).
- **Origin**: `http://127.0.0.1:4413` — `SELLER_PORT` at
  `apps/e2e-stellar/src/search.ts:27`. Preserved, not rewritten.
- **`payTo`**: `GDOEUTRI…3ULR`, recorded in
  `artifacts/e2e/stellar-testnet-bazaar-catalog.json` and
  `artifacts/e2e/mcp-discovery-pay-call.json`.
- **Asset**: `CDLZFC3S…CYSC`, the native XLM Stellar Asset Contract.
  `apps/e2e-stellar/src/provision.ts:43` provisions
  `Asset.native().contractId(TESTNET)`, and both
  `artifacts/e2e/stellar-testnet-exact.json` and
  `…-bazaar-catalog.json` record that exact contract for this harness.
- **Amount**: `10000` base units (0.0010000 at 7 decimals) —
  `provision.ts:59`, and every recorded artifact.
- **Transaction hashes**: `artifacts/e2e/stellar-testnet-bazaar-search.json`,
  `catalog.settlements[]`.

> **Note on the asset.** The search run's own artifact does not record an asset
> field. The value above comes from the provisioning code and from two artifacts
> of the same harness, one recorded the same day. It is not USDC, and this
> preview does not label it as such.

### 1 MCP tool — E-22…E-25

Fully recorded in `artifacts/e2e/mcp-discovery-pay-call.json`: resource,
tool name, service name, description, network, scheme, asset
(`CBIELTK6…DAMA`, canonical testnet USDC), amount, `payTo`, `ownershipBinding`,
input schema, and both transactions — the seed that cataloged it
(`530f0751…`) and the agent's own purchase (`f92a6aec…`).

### Discovery metadata

`discoveryInfo` is produced by calling the real `declareDiscoveryExtension` from
`@x402/extensions/bazaar`, not hand-written. This matters: the helper places a
declared `inputSchema` under `schema` and only `queryParams` under `info.input`
for HTTP resources. `buildSearchDocument` reads `info`, so a hand-written shape
would have quietly changed what the ranker sees.

---

## Displayed evidence

`src/evidence.ts`. Each constant carries its artifact path and E-number in a
comment. Sources: `upstream-e2e-results.json` (9/9), `evidence-log.md` E-18
(5/5 discovery), `balances-*-usdc2.json` (E-19 deltas),
`retrieval-eval/latest.json` (22.6% / 95.3%, 65 documents, 56 queries,
36 tuning / 20 held-out), `mcp-discovery-pay-call.json` (agent demo).

There are no counters, no uptime, no user numbers and no "transactions today".
This service observes no traffic and reports none.

---

## Fidelity check

The preview reproduces the recorded run's own output:

| Query | Recorded | Preview |
|---|---|---|
| `book me a dentist appointment` | `BELOW_RELEVANCE_THRESHOLD`, top `0.026828248…` | `0.026828` |
| `will it rain tomorrow?` | Weather Forecast, Severe Weather Alerts | identical |
| `what is the current token translation?` | Token Translation Table first | identical |

Asserted in `test/preview.test.ts`, so a regression breaks the build.

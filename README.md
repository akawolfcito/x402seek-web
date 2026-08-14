# Wayfinder — reviewer preview

**Decision-grade discovery for autonomous x402 payments on Stellar.**

A public, read-only preview of the discovery layer built for
[SCF #45 — *X402 Facilitator with Bazaar (discovery) support*](https://communityfund.stellar.org).
It exists so a reviewer can type a sentence and watch real ranking and real
abstention, in under a minute, without installing anything.

## What this is not

- **Not a hosted facilitator.** No `/verify`, no `/settle`, no signer, no funded
  account. The modules that implement settlement are not vendored into this
  service at all, so it is not a matter of routes being switched off.
- **Not a production service or a mainnet deployment.**
- **Not a payment UI.** There is no wallet connect and no pay button.
- **Not a replacement for the SCF implementation**, which is frozen at
  `762c6e60dee76f47283e38e1f6928429e95f4f84` in the core repository and is
  untouched by this repo.

## What it is

`GET /api/discovery/search` and `GET /api/discovery/resources` over a **frozen
catalog snapshot**, ranked by the **actual** `SearchEngine` from the frozen core
— same model, same document representation, same dense cosine, same abstention
threshold. There are no other routes, and none of them is a POST.

The fidelity is checkable rather than asserted. Against the recorded testnet
run, this preview reproduces:

| Query | Recorded evidence | This preview |
|---|---|---|
| `book me a dentist appointment` | `BELOW_RELEVANCE_THRESHOLD`, top **0.026828** | **0.026828** |
| `will it rain tomorrow?` | Weather Forecast, Severe Weather Alerts | identical order |

## The catalog

Seven listings, each cataloged in a recorded Stellar testnet run **by a real
settled payment**, each carrying that payment's transaction hash:

- **6 HTTP resources** — from `apps/e2e-stellar/src/catalog-seller.ts`, settled
  in the native XLM Stellar Asset Contract (E-12, E-13).
- **1 MCP tool** — Text Summarizer, settled in canonical testnet USDC
  (E-22…E-25).

Resource URLs are `127.0.0.1` because that is the origin those recorded runs
used. They are **preserved verbatim** and labelled in the UI as *testnet
evidence resources*; rewriting them to a public host would imply hosting that
does not exist.

Nothing here is invented: no fabricated services, no synthetic transaction
history, no traffic counters, no uptime, no "services indexed".

## Vendored code, and how to check it

`vendor/` holds seven files copied from the frozen core. The core repository has
no git remote, so a submodule would not resolve on a deploy host; vendoring is
the honest alternative, and `pnpm verify:vendor` makes it verifiable — it reads
each file back out of the core at the pinned commit with `git show`, applies the
one documented rewrite, and diffs.

> The rewrite: `"@stellar-bazaar/catalog"` → `"../catalog/index.js"`. A workspace
> specifier cannot resolve outside the core's pnpm workspace. Nothing else
> differs, and the script fails if anything else does.

Deliberately **not** vendored: `catalog.ts` (the settlement write path) and
`store.ts` (SQLite). Their absence is why this service's production graph
contains no `@x402/*` package and no database driver.

## Running it

```bash
nvm use                 # 22
pnpm install
pnpm test               # 19 tests
pnpm typecheck
pnpm audit:licenses     # exits non-zero on copyleft or unclassified
pnpm verify:vendor      # vendored source == frozen core at the pinned commit
pnpm start              # http://localhost:8080
```

Rebuilding the snapshot needs the core repository checked out alongside:

```bash
pnpm build:snapshot --core ../facilitador-stellar
```

The generator runs the real `declareDiscoveryExtension`, so the stored
`discoveryInfo` is what the live system would store — the helper puts a declared
`inputSchema` under `schema` and only `queryParams` under `info.input`, and
hand-writing that shape would have silently changed what the ranker sees.

## Licences

Audited independently of the core, because this is a separate public service and
the core's numbers describe a different graph:

| | |
|---|---|
| Resolved production packages | **73** |
| Forbidden (AGPL/GPL/LGPL/SSPL/…) | **0** |
| Unknown or unclassified | **0** |
| Native binaries | 1 — `onnxruntime-node` (MIT) |
| Embedding model | `Xenova/all-MiniLM-L6-v2`, Apache-2.0 |

MIT 60 · BSD-3-Clause 7 · ISC 4 · Apache-2.0 1 · `(MIT OR CC0-1.0)` 1.
The audit fails on unclassifiable licences too, not only forbidden ones — an
audit that passes because it could not read a manifest has told you nothing.

## Deployment

One persistent container. `render.yaml` is committed; Railway and Fly.io work
from the same `Dockerfile`. Serverless is the wrong shape here: `onnxruntime-node`
is a native binding and the model is 86 MB, so cold starts would defeat the
purpose of the page. The model is baked into the image at build time.

## Licence

Apache-2.0.

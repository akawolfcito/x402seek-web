# x402Seek — reviewer preview

**Decision-grade discovery for autonomous x402 payments on Stellar.**

Live: **<https://x402seek.xyz>**

A public, read-only preview of the discovery layer built for
[SCF #45 — *X402 Facilitator with Bazaar (discovery) support*](https://communityfund.stellar.org).
It exists so a reviewer can type a sentence and watch real ranking and real
abstention, in under a minute, without installing anything.

Status: **public preview on Stellar testnet.** Not mainnet, not production.

## What this is not

- **Not a hosted facilitator.** This service has no `/verify`, no `/settle`, no
  signer and no funded account. The modules that implement settlement are not
  vendored into it at all, so it is not a matter of routes being switched off.
  A separate hosted facilitator does settle on testnet — see *Live testnet mode*
  below — and this site can read it, not command it.
- **Not a mainnet deployment**, and not a production service.
- **Not a wallet UI.** There is no wallet connect, no key entry, no faucet, and
  no way for a visitor to spend their own money. There *is* one bounded demo
  payment, described below, in which the project's own testnet account pays.

## What it is

Two data sources, never blended, each labelled on every section that changes
with it.

### 1. The frozen evidence catalog

`GET /api/discovery/search` and `GET /api/discovery/resources` over a **frozen
catalog snapshot**, ranked by the **actual** `SearchEngine` from the frozen core
— same model, same document representation, same dense cosine, same abstention
threshold.

The fidelity is checkable rather than asserted. Against the recorded testnet
run, this preview reproduces:

| Query | Recorded evidence | This preview |
|---|---|---|
| `book me a dentist appointment` | `BELOW_RELEVANCE_THRESHOLD`, top **0.026828** | **0.026828** |
| `will it rain tomorrow?` | Weather Forecast, Severe Weather Alerts | identical order |

Asserted in `test/preview.test.ts`, so a regression breaks the build.

### 2. Live testnet mode

`GET /api/live/*` forwards to the hosted x402Seek facilitator at
`facilitator.testnet.x402seek.xyz`, which runs on **Stellar testnet** and does
settle payments. The forwarding exists because that facilitator sends no CORS
headers, so the browser cannot call it directly.

| Route | Does |
|---|---|
| `GET /api/live/status` | Facilitator health, network, scheme, catalog size, declared scope |
| `GET /api/live/resources` | The live Bazaar catalog |
| `GET /api/live/search` | Live semantic search against the live catalog |
| `GET /api/live/inspect` | Reads a seller's current 402 payment terms. Sends no `X-PAYMENT` header and cannot pay |
| `GET /api/live/settlement` | One recorded hosted settlement, quoted as a static fact — not a counter |
| `POST /api/live/demo-payment` | The demo payment (below). The only non-read route in the service |

A live failure reports itself as a live failure (`503 LIVE_TESTNET_UNAVAILABLE`)
rather than quietly falling back to frozen data. A live badge over recorded data
would be the worst outcome this page could produce.

### The demo payment

`POST /api/live/demo-payment` triggers a real testnet payment of 0.001 USDC by
**x402Seek's own demo buyer account**, at a fixed price, to a fixed seller, for a
fixed resource. It has an economic side effect, so calling it read-only would be
convenient and wrong.

- The visitor never pays and never signs. The request shape contains **no
  payment parameter**, so none can be supplied.
- The only fields that cross are `text` (≤ 500 chars) and an optional
  `requestId`. Any other key is refused.
- **Three per visitor per hour**, fixed window. The visitor key is a truncated
  SHA-256 of the client address (IPv6 collapsed to a /64), so no address is
  stored downstream.
- The buyer runs behind a private network address with no public domain, so it
  cannot be called directly from the internet.

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
history, no traffic counters, no uptime, no "services indexed". This service
observes no traffic and reports none.

## Architecture

```
browser  ──▶  Fastify (src/server.ts)  ──┬─▶  frozen snapshot (data/snapshot.json)
                                         │      ranked by vendor/search/engine.ts
                                         │      all-MiniLM-L6-v2 via onnxruntime-node
                                         │
                                         └─▶  src/live.ts  ──┬─▶ hosted facilitator (testnet)
                                                             ├─▶ hosted seller  (402, read only)
                                                             └─▶ demo buyer     (private network)
```

| Path | Holds |
|---|---|
| `src/server.ts` | Routes, rate limits, static file whitelist |
| `src/live.ts` | The bounded upstream proxies, with their allowed hosts as constants |
| `src/store.ts` | `FrozenCatalogStore` — the read-only store the engine ranks over |
| `src/evidence.ts` | Recorded numbers, each carrying its artifact path and E-number |
| `vendor/` | Seven files copied verbatim from the frozen core |
| `web/` | The page: `index.html`, `app.js`, `styles.css`. No build step, no framework |
| `data/snapshot.json` | The frozen catalog, generated by `scripts/build-snapshot.mts` |

Supported protocols and platforms: **x402** payment requirements over HTTP and
**MCP** tools; **Bazaar** discovery envelopes; **Stellar testnet**
(`stellar:testnet`, scheme `exact`, classic accounts only). `upto` is not
implemented. Mainnet is not supported.

## Vendored code, and how to check it

`vendor/` holds seven files copied from the frozen core, pinned at
`762c6e60dee76f47283e38e1f6928429e95f4f84`. The core repository has no git
remote, so a submodule would not resolve on a deploy host; vendoring is the
honest alternative, and `pnpm verify:vendor` makes it verifiable — it reads each
file back out of the core at the pinned commit with `git show`, applies the one
documented rewrite, and diffs. Per-file SHA-256 sums are in
[`PROVENANCE.md`](PROVENANCE.md).

> The rewrite: `"@stellar-bazaar/catalog"` → `"../catalog/index.js"`. A workspace
> specifier cannot resolve outside the core's pnpm workspace. Nothing else
> differs, and the script fails if anything else does.

Deliberately **not** vendored: `catalog.ts` (the settlement write path) and
`store.ts` (SQLite). Their absence is why this service's production graph
contains no `@x402/*` package and no database driver.

## Running it

```bash
nvm use                 # 22, from .nvmrc
pnpm install
pnpm start              # http://localhost:8080
```

First start downloads the 86 MB embedding model from the Hugging Face CDN into
`.models-cache/` (git-ignored); later starts read it from disk. The server exits
non-zero rather than hanging if the index cannot be built.

`pnpm dev` is the same thing under `tsx watch`.

### Configuration

No secrets are read. Every variable has a working default.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `MODELS_CACHE_DIR` | `.models-cache` | Where the embedding model lives. Set to `/app/.models-cache` in the image |
| `MODEL_LOAD_TIMEOUT_MS` | `180000` | Fail loudly instead of hanging on a cold model fetch |
| `DEMO_BUYER_URL` | private-network address | Demo buyer upstream. Override for local development only |

### Testing and checks

```bash
pnpm test               # 97 tests, 4 files
pnpm typecheck          # tsc --noEmit, strict + noUncheckedIndexedAccess
pnpm audit:licenses     # exits non-zero on copyleft or unclassified
pnpm verify:vendor      # vendored source == frozen core at the pinned commit
```

`pnpm verify:vendor` needs the core repository checked out alongside, so it is a
local pre-deploy check rather than a CI step. CI (`.github/workflows/ci.yml`)
runs the licence gate, the typecheck and the tests on every push to `main` and
every pull request.

Rebuilding the snapshot also needs the core checked out alongside:

```bash
pnpm build:snapshot --core ../facilitador-stellar
```

The generator runs the real `declareDiscoveryExtension`, so the stored
`discoveryInfo` is what the live system would store — the helper puts a declared
`inputSchema` under `schema` and only `queryParams` under `info.input`, and
hand-writing that shape would have silently changed what the ranker sees.

## Deployment

Deployed and public at **<https://x402seek.xyz>**. `GET /health` reports the
listing count and the pinned core commit.

One persistent container on **Railway**; `railway.toml` is committed. Any other
container host works from the same `Dockerfile`, which is host-agnostic.

Serverless is the wrong shape here: `onnxruntime-node` is a native binding and
the model is 86 MB, so cold starts would defeat the purpose of the page. The
model is baked into the image at build time, so a container start never depends
on the Hugging Face CDN.

Sized from measurement rather than a default — **1 GB / 1 vCPU**:

| | |
|---|---|
| Peak RSS | ~318 MB, and the peak is the model load, not traffic |
| After 30 sequential searches | ~296 MB, no growth |
| Ready on `/health` | 4–5 s cold, of which ~1.2 s is the ONNX session and index |
| Warm search p50 / p95 | 28 ms / 47 ms wall (13 ms / 22 ms in the engine) |
| 1 vCPU vs 2 vCPU | p50 28.1 ms vs 28.7 ms — inference on one short sequence does not parallelise |
| Image | 628 MB, of which 91 MB is the model |

## Known limitations

- **Testnet only.** No mainnet support, and none is claimed.
- **Frozen catalog.** The evidence catalog is a snapshot of 7 listings. Nothing
  registers into it at runtime; there is no write path.
- **The live catalog is small.** The hosted facilitator currently indexes a
  single resource, and this page reports whatever it says.
- **No `asset` filter.** `DiscoveryQuery` upstream has no such field, so the
  engine cannot apply one *before* ranking. A post-filter would break the "hard
  filters run before scoring" property, so asset is displayed and not filtered.
- **`upto` is not implemented**, and only classic Stellar accounts are supported.
- **Rate limits are in memory**, per instance, and reset on restart. There is one
  instance, so that is sufficient here and would not be behind a load balancer.
- **The demo payment depends on a funded testnet account.** When it runs dry the
  route refuses; live discovery and the recorded evidence keep working.
- **No persistence.** No database, no session, no user accounts, no analytics.

## Security considerations

- **No secrets.** The service reads no credential, holds no key, and signs
  nothing. Dotenv files are git-ignored so one cannot arrive by accident, and the
  container runs as `USER node`.
- **Neither proxy can be pointed anywhere.** Upstream hosts are constants in
  `src/live.ts` and paths are fixed. The 402 inspector will only fetch a URL the
  live catalog itself returned, so a caller cannot introduce a destination — the
  SSRF surface is closed by construction rather than by a blocklist.
- **No payment parameter exists** in the demo request shape, and unknown keys are
  refused at the first hop.
- **Static files are served from an explicit whitelist**, not a path join over
  user input, so there is no traversal surface.
- **`trustProxy: 2`** is measured against Railway's forwarding shape, not
  guessed: it lands on the real client address, and an entry prepended by a
  caller is never reached, so spoofing the rate-limit bucket fails by
  construction. The reasoning is in `src/server.ts`; if the edge changes, the
  number must be re-measured.
- **Rate limits:** 60 API requests per minute per client, and 3 demo payments per
  hour per client. Client identity is hashed, never stored raw.
- **Published Stellar addresses are public keys on testnet.** No secret key
  appears anywhere in this repository.

## Licences

The dependency graph is audited independently of the core, because this is a
separate public service and the core's numbers describe a different graph.
Report: `artifacts/compliance/licenses.json`.

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

## Licence

Apache-2.0. See [`LICENSE`](LICENSE).

/**
 * The LIVE TESTNET surface.
 *
 * Three properties are worth more than the rest, and they are what most of this
 * file asserts:
 *
 *   a live failure must never become recorded data wearing a live badge;
 *   nothing here can pay, sign, or be talked into fetching a URL of the
 *   caller's choosing;
 *   the evidence mode keeps serving frozen data, untouched.
 *
 * Upstream calls are stubbed. A test that reached the real hosted facilitator
 * would be measuring somebody's uptime rather than this code — the genuine
 * hosted check is a separate smoke, run against the deployment.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";
import { LIVE_FACILITATOR, LIVE_SELLER_HOST, inspectLive402 } from "../src/live.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = buildServer();

const HEALTH = {
  status: "ok",
  ready: true,
  discovery: { status: "ready", indexed: 1 },
  network: "stellar:testnet",
  catalog: 1,
};
const SUPPORTED = { kinds: [{ network: "stellar:testnet", scheme: "exact" }] };
const RESOURCE = `https://${LIVE_SELLER_HOST}/summarize`;
const CATALOG = {
  x402Version: 2,
  items: [
    {
      resource: RESOURCE,
      serviceName: "Text Summarizer",
      canonicalKey: RESOURCE,
      type: "http",
      ownershipBinding: "tofu",
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet",
          asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          amount: "10000",
          payTo: "GD45744YX7ELZEGGCV2ISXUHXA6LBDJR6THTTMP2EZ5JXMTE5K63XBRK",
        },
      ],
    },
  ],
};

/** Encode a 402 the way the seller does: base64 in a header, not in the body. */
function paymentRequiredResponse(): Response {
  const payload = {
    x402Version: 2,
    resource: { url: RESOURCE, serviceName: "Text Summarizer" },
    accepts: CATALOG.items[0]!.accepts,
  };
  return new Response("{}", {
    status: 402,
    headers: { "payment-required": Buffer.from(JSON.stringify(payload)).toString("base64") },
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input instanceof URL ? input.href : input);
    if (url.startsWith(`${LIVE_FACILITATOR}/health`)) return json(HEALTH);
    if (url.startsWith(`${LIVE_FACILITATOR}/supported`)) return json(SUPPORTED);
    if (url.startsWith(`${LIVE_FACILITATOR}/discovery/resources`)) return json(CATALOG);
    if (url.startsWith(`${LIVE_FACILITATOR}/discovery/search`)) {
      return json({ x402Version: 2, resources: CATALOG.items, partialResults: false });
    }
    if (url.startsWith(`https://${LIVE_SELLER_HOST}/summarize`)) return paymentRequiredResponse();
    throw new Error(`unexpected upstream fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("live status", () => {
  it("reports what the hosted facilitator says, and discloses the scope", async () => {
    const body = (await app.inject({ method: "GET", url: "/api/live/status" })).json();
    expect(body.ready).toBe(true);
    expect(body.network).toBe("stellar:testnet");
    expect(body.scheme).toBe("exact");
    expect(body.catalog).toBe(1);
    expect(body.discovery).toEqual({ status: "ready", indexed: 1 });
    // Stated, not left to be inferred from silence.
    expect(body.scope.accounts).toBe("classic only");
    expect(body.scope.upto).toBe("not implemented");
  });

  it("never claims production or mainnet", async () => {
    const text = (await app.inject({ method: "GET", url: "/api/live/status" })).body;
    for (const banned of ["production", "mainnet", "pubnet"]) {
      expect(text.toLowerCase()).not.toContain(banned);
    }
  });
});

describe("live discovery", () => {
  it("queries the hosted facilitator, not the frozen catalog", async () => {
    const body = (
      await app.inject({ method: "GET", url: "/api/live/search?query=condense%20text" })
    ).json();
    expect(body.resources[0].serviceName).toBe("Text Summarizer");
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith(`${LIVE_FACILITATOR}/discovery/search`))).toBe(true);
  });

  it("passes an abstention through as the hosted facilitator's own answer", async () => {
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith(`${LIVE_FACILITATOR}/discovery/search`)) {
        return json({
          x402Version: 2,
          resources: [],
          abstained: { reason: "BELOW_RELEVANCE_THRESHOLD", topScore: 0.0268, threshold: 0.22 },
        });
      }
      return json(HEALTH);
    });

    const body = (
      await app.inject({ method: "GET", url: "/api/live/search?query=book%20a%20dentist" })
    ).json();
    expect(body.abstained.reason).toBe("BELOW_RELEVANCE_THRESHOLD");
    expect(body.resources).toHaveLength(0);
  });

  it("still validates the query before forwarding it", async () => {
    expect((await app.inject({ method: "GET", url: "/api/live/search?query=" })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: `/api/live/search?query=${"a".repeat(513)}` }))
        .statusCode,
    ).toBe(400);
  });
});

describe("a live failure stays a live failure", () => {
  it("returns 503 LIVE_TESTNET_UNAVAILABLE rather than frozen data", async () => {
    fetchMock.mockRejectedValue(new Error("connection refused"));

    for (const url of ["/api/live/status", "/api/live/resources", "/api/live/search?query=x"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(503);
      expect(response.json().error, url).toBe("LIVE_TESTNET_UNAVAILABLE");
      // The frozen listings must not appear under a live route.
      expect(response.body, url).not.toContain("127.0.0.1");
      expect(response.body, url).not.toContain("Weather Forecast");
    }
  });

  it("surfaces an upstream error status without inventing a result", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 502 }));
    const response = await app.inject({ method: "GET", url: "/api/live/status" });
    expect(response.statusCode).toBe(503);
    expect(response.json().detail).toContain("502");
  });

  it("keeps the evidence routes serving frozen data throughout", async () => {
    fetchMock.mockRejectedValue(new Error("hosted is down"));
    const frozen = (await app.inject({ method: "GET", url: "/api/discovery/resources" })).json();
    expect(frozen.items).toHaveLength(7);
    expect(frozen.items[0].resource).toContain("127.0.0.1");
  });
});

describe("inspecting a live 402", () => {
  it("decodes the seller's current terms and pays nothing", async () => {
    const body = (
      await app.inject({
        method: "GET",
        url: `/api/live/inspect?resource=${encodeURIComponent(RESOURCE)}`,
      })
    ).json();

    expect(body.status).toBe(402);
    expect(body.resource).toBe(RESOURCE);
    expect(body.terms).toMatchObject({
      network: "stellar:testnet",
      scheme: "exact",
      amount: "10000",
      payTo: "GD45744YX7ELZEGGCV2ISXUHXA6LBDJR6THTTMP2EZ5JXMTE5K63XBRK",
    });

    // No payment header was ever sent, and no POST was made.
    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers((init as RequestInit | undefined)?.headers ?? {});
      expect(headers.get("x-payment")).toBeNull();
      expect(((init as RequestInit | undefined)?.method ?? "GET").toUpperCase()).toBe("GET");
    }
  });

  it("refuses a host it was not built to talk to", async () => {
    for (const hostile of [
      "https://evil.example/steal",
      "http://169.254.169.254/latest/meta-data/",
      "https://facilitator.testnet.x402seek.xyz/internal/metrics",
      "file:///etc/passwd",
    ]) {
      await expect(inspectLive402(hostile)).rejects.toThrow();
    }
  });

  it("refuses a seller URL the live catalog did not publish", async () => {
    // Right host, wrong resource: the catalog is the allowlist.
    await expect(inspectLive402(`https://${LIVE_SELLER_HOST}/not-in-the-catalog`)).rejects.toThrow(
      /not in the live catalog/,
    );
  });
});

describe("the browser surface", () => {
  const html = readFileSync(join(ROOT, "web", "index.html"), "utf8");
  const script = readFileSync(join(ROOT, "web", "app.js"), "utf8");

  it("offers both modes explicitly", () => {
    expect(html).toContain('id="mode-evidence"');
    expect(html).toContain('id="mode-live"');
    expect(html).toContain("Live testnet");
  });

  it("has no payment, wallet or key-entry affordance", () => {
    const surface = `${html}\n${script}`.toLowerCase();
    for (const banned of [
      "connect wallet",
      "pay now",
      "run payment",
      "private key",
      "secret key",
      "buyer_secret",
      "faucet",
      "sign transaction",
    ]) {
      expect(surface, banned).not.toContain(banned);
    }
    expect(script).not.toContain("x-payment");
  });

  it("ships no secret-bearing configuration to the browser", () => {
    const surface = `${html}\n${script}`;
    expect(surface).not.toMatch(/S[A-Z2-7]{55}/);
    expect(surface).not.toContain("METRICS_TOKEN");
    expect(surface).not.toContain("SIGNER");
  });

  it("keeps the recorded transactions reachable behind a disclosure", () => {
    expect(script).toContain("View recorded transactions");
    expect(script).toContain("View on Stellar Expert");
  });

  it("renders the hosted amount as the decimal the API reports, not as base units", async () => {
    // The settlement endpoint reports 0.0010000, already human. Converting it a
    // second time printed 0.0000000 USDC on a proof card, which is the one place
    // on the page a wrong number is worst.
    const settlement = (await app.inject({ method: "GET", url: "/api/live/settlement" })).json();
    expect(settlement.amount).toMatch(/^\d+\.\d+$/);
    expect(Number(settlement.amount)).toBeGreaterThan(0);
    expect(script).toContain("trimZeros(s.amount)");
    expect(script).not.toContain("displayPrice(s.amount)");
  });

  it("labels the data source in both modes", () => {
    expect(html).toContain('id="discovery-source"');
    expect(script).toContain("Live testnet");
    expect(script).toContain("Recorded evidence");
    // And says so when live is down, rather than quietly showing frozen data.
    expect(script).toContain("LIVE_TESTNET_UNAVAILABLE");
  });
});

describe("no route can be used to pay", () => {
  it("exposes only GET live routes", async () => {
    const routes = app.printRoutes({ commonPrefix: false });
    // One write route exists, and it is the demo payment. Nothing else.
    expect(routes.match(/\((POST|PUT|PATCH|DELETE)\)/g) ?? []).toEqual(["(POST)"]);
    expect(routes).toContain("demo-payment");
    for (const url of ["/api/live/pay", "/api/live/settle", "/api/live/sign"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    }
  });
});

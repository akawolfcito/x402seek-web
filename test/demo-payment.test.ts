/**
 * The bounded demo-payment proxy.
 *
 * This site used to register only GET handlers, and a test asserted it. That
 * invariant is now deliberately spent: there is exactly one non-GET route, it
 * is this one, and it causes an economic side effect. The assertion changed
 * from "none" to "exactly one, and here is which", which is a count rather than
 * a removal.
 *
 * Everything here stubs the upstream. What is under test is what the browser
 * can and cannot influence.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_BUYER_URL, MAX_DEMO_TEXT, clientKeyFor, runDemoPayment } from "../src/live.js";
import { buildServer } from "../src/server.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(join(ROOT, "web", "app.js"), "utf8");
const app = buildServer();

const SETTLED = {
  status: "settled",
  payer: "x402seek-demo-buyer",
  amount: "10000",
  amountDisplay: "0.001 USDC",
  network: "stellar:testnet",
  transaction: "cbd40ab0feedface",
  explorer: "https://stellar.expert/explorer/testnet/tx/cbd40ab0feedface",
  seller: { status: 200, result: { summary: "the quick brown fox… (9 words)" } },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(SETTLED), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

/**
 * A distinct visitor per call by default.
 *
 * The per-visitor limit is real now, so tests that are not about rate limiting
 * must not share a bucket with each other. The one test that *is* about it
 * passes an explicit address.
 */
let visitor = 0;
const post = (payload: unknown, ip?: string) =>
  app.inject({
    method: "POST",
    url: "/api/live/demo-payment",
    payload: payload as never,
    remoteAddress: ip ?? `198.51.${Math.floor(visitor / 250) % 250}.${(visitor++ % 250) + 1}`,
  });

describe("the browser controls nothing about the payment", () => {
  it.each([
    "payTo",
    "amount",
    "asset",
    "network",
    "facilitator",
    "facilitatorUrl",
    "resource",
    "seller",
    "buyer",
    "terms",
    "url",
    "upstream",
  ])("refuses a body carrying %s, and forwards nothing", async (field) => {
    const response = await post({ [field]: "https://evil.example" });
    expect(response.statusCode).toBe(400);
    expect(response.json().reason).toBe("INVALID_REQUEST");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards exactly requestId and text, to exactly one hard-coded upstream", async () => {
    await post({ requestId: "abc-123", text: "condense this" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DEMO_BUYER_URL}/demo-payment`);
    const sent = JSON.parse(String(init.body));
    expect(sent.requestId).toBe("abc-123");
    expect(sent.text).toBe("condense this");
    // clientKey is derived here, never taken from the body.
    expect(Object.keys(sent).sort()).toEqual(["clientKey", "requestId", "text"]);
  });

  it("cannot be pointed anywhere by a caller", () => {
    // The upstream is a module constant, not a request field. A test on the
    // shape of the function is the closest thing to proving the negative.
    expect(DEMO_BUYER_URL).toContain("railway.internal");
    expect(DEMO_BUYER_URL).not.toContain("x402seek.xyz");
  });

  it("derives the visitor key itself and refuses one from the body", async () => {
    // The demo buyer sits behind this proxy, so it only ever sees this service
    // as the peer. Without a key derived here its per-IP limit limits nothing,
    // which is what the production ledger showed. Accepting one from the body
    // would hand the limit back to the caller.
    expect((await post({ clientKey: "deadbeefdeadbeef" })).statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    await post({ text: "hello" });
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(sent.clientKey).toMatch(/^[a-f0-9]{16}$/);
  });

  it("gives two visitors different keys and the same visitor a stable one", () => {
    expect(clientKeyFor("203.0.113.9")).toBe(clientKeyFor("203.0.113.9"));
    expect(clientKeyFor("203.0.113.9")).not.toBe(clientKeyFor("198.51.100.4"));
    // A whole IPv6 /64 is one subscriber.
    expect(clientKeyFor("2001:db8:1:2::1")).toBe(clientKeyFor("2001:db8:1:2:ffff::9"));
    expect(clientKeyFor("2001:db8:1:3::1")).not.toBe(clientKeyFor("2001:db8:1:2::1"));
    // Nothing recognisable survives.
    expect(clientKeyFor("203.0.113.9")).not.toContain("203");
  });

  it("bounds the one field it does forward", async () => {
    expect((await post({ text: "x".repeat(MAX_DEMO_TEXT + 1) })).statusCode).toBe(400);
    expect((await post({ text: 42 })).statusCode).toBe(400);
    expect((await post({ requestId: 42 })).statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("failures stay inside the closed set", () => {
  it("turns an unreachable buyer into a refusal we wrote", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED fd12::4:4430"));
    const response = await post({});

    expect(response.statusCode).toBe(503);
    expect(response.json().reason).toBe("DEMO_UNAVAILABLE");
    expect(response.body).not.toContain("ECONNREFUSED");
    expect(response.body).not.toContain("fd12::4");
    expect(response.json().detail).toContain("still work");
  });

  it("passes the buyer's own refusal through, because it is already visitor copy", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "refused",
          reason: "DEMO_BUDGET_EXHAUSTED",
          detail: "Today's demo budget is spent. It resets at 00:00 UTC.",
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
    );
    const response = await post({});
    expect(response.statusCode).toBe(429);
    expect(response.json().reason).toBe("DEMO_BUDGET_EXHAUSTED");
  });

  it("never returns a body it could not parse", async () => {
    fetchMock.mockResolvedValue(new Response("<html>gateway error</html>", { status: 502 }));
    const response = await post({});
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain("<html>");
    expect(response.json().reason).toBe("DEMO_UNAVAILABLE");
  });

  it("does not need the demo to serve everything else", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    // Option D is the floor: the recorded evidence is unaffected by a demo outage.
    const frozen = await app.inject({ method: "GET", url: "/api/discovery/resources" });
    expect(frozen.statusCode).toBe(200);
    expect(frozen.json().items).toHaveLength(7);
  });
});

describe("the route surface", () => {
  it("has exactly one non-GET route, and it is the demo payment", () => {
    const routes = app.printRoutes({ commonPrefix: false });
    const mutating = routes.match(/\((POST|PUT|PATCH|DELETE)\)/g) ?? [];
    expect(mutating).toEqual(["(POST)"]);
    expect(routes).toContain("demo-payment");
  });

  it("still refuses every other write anyone might try", async () => {
    for (const url of ["/api/live/pay", "/api/live/settle", "/api/live/sign", "/settle", "/verify"]) {
      const response = await app.inject({ method: "POST", url });
      expect(response.statusCode, url).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("the browser surface", () => {
  it("labels the three ownership states without flattering the weakest", () => {
    expect(script).toContain("Domain verified");
    expect(script).toContain("Domain mismatch");
    expect(script).toContain("Ownership: first use");
    // The old label promoted trust-on-first-use to something it was not.
    expect(script).not.toContain('"Ownership verified"');
    // And domain control is never presented as permission to pay.
    expect(script).toContain("domain control, not wallet proof");
    expect(script).toContain("The live 402 is the payment authority");
  });

  it("says whose money it is before it says anything else", () => {
    expect(script).toContain("Run demo payment");
    expect(script).toContain("You are not paying. x402Seek's testnet demo account pays.");
    expect(script).toContain("x402Seek's testnet demo account");
    expect(script).toContain("No wallet required");
    expect(script).toContain("x402Seek demo buyer");
  });

  it("still offers no wallet, no key entry and no faucet", () => {
    const lower = script.toLowerCase();
    for (const banned of [
      "connect wallet",
      "pay now",
      "buy now",
      "private key",
      "seed phrase",
      "faucet",
      "sign transaction",
    ]) {
      expect(lower, banned).not.toContain(banned);
    }
    expect(script).not.toMatch(/S[A-Z2-7]{55}/);
  });

  it("attaches the action to the live card only, and only for the demo resource", () => {
    // The evidence card builder never gains it: a recorded listing has nothing
    // live to pay.
    const evidenceCard = script.slice(script.indexOf("function card("), script.indexOf("function primaryTerms"));
    expect(evidenceCard).not.toContain("demoPaymentPanel");

    const liveCard = script.slice(script.indexOf("function liveCard("));
    expect(liveCard).toContain("demoPaymentPanel");
    expect(liveCard).toContain("https://demo-api.testnet.x402seek.xyz/summarize");
  });

  it("sends no payment parameter from the browser", () => {
    const panel = script.slice(script.indexOf("function demoPaymentPanel"), script.indexOf("function newRequestId"));
    for (const banned of ["payTo", "amount:", "asset", "facilitator", "resource:"]) {
      expect(panel, banned).not.toContain(banned);
    }
    expect(panel).toContain("requestId");
  });
});

describe("runDemoPayment in isolation", () => {
  it("refuses a body that is not an object", async () => {
    expect((await runDemoPayment(["not", "an", "object"])).status).toBe(400);
  });

  it("sends an empty object rather than inventing fields", async () => {
    await runDemoPayment({});
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it("refuses three an hour from one visitor, before the upstream is troubled", async () => {
    const ip = "198.51.100.77";
    for (let i = 0; i < 3; i += 1) {
      const r = await app.inject({
        method: "POST", url: "/api/live/demo-payment",
        payload: { requestId: `p-${i}` } as never, remoteAddress: ip,
      });
      expect(r.statusCode, `attempt ${i}`).toBe(200);
    }
    const refused = await app.inject({
      method: "POST", url: "/api/live/demo-payment",
      payload: { requestId: "p-9" } as never, remoteAddress: ip,
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().reason).toBe("RATE_LIMITED");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

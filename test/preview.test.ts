/**
 * The preview's guarantees, as tests.
 *
 * Two groups. The first asserts what the service *cannot* do — mutate the
 * catalog, settle, verify, register, accept a POST — because "we removed it" is
 * a claim and a failing test is evidence. The second asserts that ranking and
 * abstention are the real engine's output, since a preview whose abstention was
 * a hardcoded query match would be a demo of nothing.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CatalogListing } from "../vendor/catalog/index.js";
import { FrozenCatalogStore, ReadOnlyCatalogError } from "../src/store.js";
import { buildServer } from "../src/server.js";
import { SearchEngine } from "../vendor/search/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshot = JSON.parse(readFileSync(join(ROOT, "data", "snapshot.json"), "utf8")) as {
  coreCommit: string;
  listings: CatalogListing[];
};

describe("frozen snapshot", () => {
  it("carries every listing from the recorded testnet runs", () => {
    expect(snapshot.listings).toHaveLength(7);
    expect(snapshot.coreCommit).toBe("762c6e60dee76f47283e38e1f6928429e95f4f84");
  });

  it("gives every listing a real settlement transaction", () => {
    for (const listing of snapshot.listings) {
      expect(listing.lastSettlementTx).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("preserves the local origins the recorded runs used", () => {
    // Rewriting these to a public host would imply hosting that does not exist.
    for (const listing of snapshot.listings) {
      expect(listing.resource).toMatch(/127\.0\.0\.1/);
    }
  });

  it("discloses trust-on-first-use on every listing", () => {
    for (const listing of snapshot.listings) {
      expect(listing.ownershipBinding).toBe("tofu");
      expect(listing.network).toBe("stellar:testnet");
    }
  });

  it("has one MCP tool and six HTTP resources", () => {
    const mcp = snapshot.listings.filter((l) => l.type === "mcp");
    expect(mcp).toHaveLength(1);
    expect(mcp[0]!.serviceName).toBe("Text Summarizer");
    expect(snapshot.listings.filter((l) => l.type === "http")).toHaveLength(6);
  });
});

describe("the catalog is structurally immutable", () => {
  const store = new FrozenCatalogStore(snapshot.listings);

  it("refuses writes rather than silently accepting them", () => {
    expect(() => store.upsert(snapshot.listings[0]!)).toThrow(ReadOnlyCatalogError);
  });

  it("applies hard filters before anything is scored", () => {
    expect(store.list({ type: "mcp" }).resources).toHaveLength(1);
    expect(store.list({ network: "stellar:pubnet" }).resources).toHaveLength(0);
    expect(store.list({ scheme: "exact" }).resources).toHaveLength(7);
  });

  it("orders deterministically", () => {
    const once = store.list({}).resources.map((l) => l.canonicalKey);
    const twice = store.list({}).resources.map((l) => l.canonicalKey);
    expect(once).toEqual(twice);
  });
});

describe("real ranking and abstention", () => {
  const store = new FrozenCatalogStore(snapshot.listings);
  const engine = new SearchEngine(store);

  beforeAll(async () => {
    await engine.sync();
  }, 240_000);

  it("finds the summarizer from an intent that names none of its words", async () => {
    const result = await engine.search({
      query: "I need something that can condense a long passage of text",
    });
    expect(result.abstained).toBeUndefined();
    expect(result.resources[0]!.serviceName).toBe("Text Summarizer");
  });

  it("separates the token distractor from language translation", async () => {
    const result = await engine.search({ query: "what is the current token translation?" });
    expect(result.resources[0]!.serviceName).toBe("Token Translation Table");
  });

  it("abstains on an unanswerable query, by score and not by name", async () => {
    const result = await engine.search({ query: "book me a dentist appointment" });
    expect(result.resources).toHaveLength(0);
    expect(result.abstained?.reason).toBe("BELOW_RELEVANCE_THRESHOLD");
    expect(result.abstained!.topScore).toBeLessThan(result.abstained!.threshold);
  });

  it("returns nothing for a network the catalog cannot serve", async () => {
    const result = await engine.search({
      query: "will it rain tomorrow?",
      filters: { network: "stellar:pubnet" },
    });
    expect(result.resources).toHaveLength(0);
    expect(result.abstained?.reason).toBe("NO_ELIGIBLE_RESOURCES");
  });
});

describe("the public surface", () => {
  const app = buildServer();
  afterAll(async () => {
    await app.close();
  });

  it("exposes no payment, settlement, registration or write route", async () => {
    const forbidden = [
      { method: "POST" as const, url: "/settle" },
      { method: "POST" as const, url: "/verify" },
      { method: "POST" as const, url: "/api/discovery/resources" },
      { method: "POST" as const, url: "/api/discovery/register" },
      { method: "GET" as const, url: "/supported" },
      { method: "POST" as const, url: "/api/discovery/search" },
    ];
    for (const route of forbidden) {
      const response = await app.inject(route);
      expect(response.statusCode, `${route.method} ${route.url}`).toBeGreaterThanOrEqual(400);
    }
  });

  it("registers exactly one non-GET handler, the bounded demo-payment proxy", () => {
    // This invariant was "none" until the demo payment shipped. It is now a
    // count, so a second write route has to be argued for rather than slipped in.
    const routes = app.printRoutes({ commonPrefix: false });
    expect(routes.match(/\((POST|PUT|PATCH|DELETE)\)/g) ?? []).toEqual(["(POST)"]);
    expect(routes).toContain("demo-payment");
  });

  it("serves health without claiming to settle", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ mode: "discovery-only", settlement: "not offered" });
  });

  it("rejects an over-long query instead of embedding it", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/discovery/search?query=${"a".repeat(513)}`,
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects an unknown type filter", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/discovery/search?query=weather&type=ftp",
    });
    expect(response.statusCode).toBe(400);
  });

  it("serves the Bazaar `items` envelope from the list endpoint", async () => {
    const response = await app.inject({ method: "GET", url: "/api/discovery/resources" });
    const body = response.json();
    expect(body.x402Version).toBe(2);
    expect(body.items).toHaveLength(7);
    expect(body.items[0]).toHaveProperty("ownershipBinding", "tofu");
  });

  /**
   * The disclaimer must not be script-dependent.
   *
   * It was: both elements shipped empty and were filled from /api/evidence, so
   * a blocked script or a failed fetch produced a page headed "TESTNET-PROVEN"
   * with nothing saying the facilitator is not operated. Caught by the local
   * reviewer smoke.
   */
  it("states the read-only boundary in the served HTML, without running any script", async () => {
    const html = (await app.inject({ method: "GET", url: "/" })).body;
    const sentence =
      "The browser experience is read-only. The hosted facilitator operates on Stellar testnet.";
    // Once in the hero, once in the status section.
    expect(html.split(sentence).length - 1).toBe(2);
  });

  it("no longer claims the facilitator is unoperated, because it is operated", async () => {
    // That sentence was true at 762c6e6 and is false now. It must not survive
    // anywhere in what the browser receives.
    const surface = [
      (await app.inject({ method: "GET", url: "/" })).body,
      (await app.inject({ method: "GET", url: "/app.js" })).body,
      (await app.inject({ method: "GET", url: "/api/evidence" })).body,
    ].join("\n");

    expect(surface).not.toContain("not currently operated");
    expect(surface).not.toContain("no settlement service is operated here");
    expect(surface).not.toContain("exposes discovery only");
  });

  it("lists hosted operation as built, not as planned", async () => {
    const status = (await app.inject({ method: "GET", url: "/api/evidence" })).json().status;
    expect(status.built.join(" ")).toContain("Hosted Stellar testnet facilitator");
    expect(status.planned.join(" ").toLowerCase()).not.toContain("hosted facilitator");
    // The genuinely unbuilt items stay where they are.
    expect(status.planned.join(" ")).toContain("Stellar pubnet");
    expect(status.planned.join(" ")).toContain("upto");
  });

  it("leads with the live state and keeps the proof state one tab away", async () => {
    const html = (await app.inject({ method: "GET", url: "/" })).body;
    const script = (await app.inject({ method: "GET", url: "/app.js" })).body;

    // Live is the default now that the facilitator really runs.
    expect(html).toContain('id="mode-live" role="tab" aria-selected="true"');
    expect(html).toContain('id="mode-evidence" role="tab" aria-selected="false"');
    // Live testnet is listed before Evidence.
    expect(html.indexOf('id="mode-live"')).toBeLessThan(html.indexOf('id="mode-evidence"'));
    expect(html).toContain("● LIVE TESTNET");
    // TESTNET-PROVEN did not disappear, it moved to the mode it describes.
    expect(html).not.toContain("TESTNET-PROVEN");
    expect(script).toContain("TESTNET-PROVEN");
    expect(script).toContain('await setMode("live")');
  });

  it("does not claim a connection it has not made yet", async () => {
    // Before any request is answered the band says it is still trying. Saying
    // "connected" in static markup would be a claim about a machine this file
    // has never spoken to.
    const html = (await app.inject({ method: "GET", url: "/" })).body;
    const script = (await app.inject({ method: "GET", url: "/app.js" })).body;
    expect(html).toContain("Connecting to the hosted x402Seek facilitator on Stellar testnet.");
    expect(html).not.toContain("Connected to the hosted");
    expect(script).toContain("Connected to the hosted x402Seek facilitator on Stellar testnet.");
    expect(script).toContain("The hosted facilitator did not answer.");
  });

  it("draws the whole path, refusal branch included", async () => {
    const html = (await app.inject({ method: "GET", url: "/" })).body;
    // Search, decide, re-check, settle. The catalog never gets the last word.
    for (const step of ["Search", "Decide", "Live 402", "Settle"]) {
      expect(html).toContain(`<span>${step}</span>`);
    }
    expect(html).toContain("Stellar settles");
    expect(html).toContain("The seller\u2019s current 402 decides, not the catalog.");
  });

  it("explains the product in static markup, including the refusal branch", async () => {
    // The hero has to survive a blocked script. A visitor who never runs app.js
    // should still be able to read what x402Seek does and what it does instead
    // of recommending a bad match.
    const html = (await app.inject({ method: "GET", url: "/" })).body;
    expect(html).toContain("x402Seek recommends a payable\n        service, or recommends none");
    expect(html).toContain("Text Summarizer");
    expect(html).toContain("Abstain");
    expect(html).toContain("Relevant and payable");
    // Read as a person reads it, since the figure and its unit are separate spans.
    const text = html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    expect(text).toContain("0 USDC recommended");
    expect(html).toContain("An illustration, not a live query.");
    // Three steps, named, in order.
    for (const step of ["Discover", "Decide", "Pay"]) expect(html).toContain(`<h3>${step}</h3>`);
  });

  it("names the active data source in a band, not only in a tab", async () => {
    const html = (await app.inject({ method: "GET", url: "/" })).body;
    const script = (await app.inject({ method: "GET", url: "/app.js" })).body;
    // Static default is the recorded source; the live wording is script-side.
    expect(html).toContain('id="mode-band"');
    // Static default is the live source; the recorded wording is script-side.
    expect(html).toContain("● LIVE TESTNET");
    expect(script).toContain("RECORDED EVIDENCE");
    expect(script).toContain("Reproducible results from the frozen testnet implementation.");
  });

  it("asks the question in the user's words and labels the action Seek", async () => {
    const html = (await app.inject({ method: "GET", url: "/" })).body;
    expect(html).toContain("What does your agent need?");
    expect(html).toMatch(/<button type="submit" id="go">Seek<\/button>/);
    // Filters are still reachable, just no longer competing with the result.
    expect(html).toContain('id="f-type"');
    expect(html).toContain('id="f-network"');
    expect(html).toContain('id="f-scheme"');
  });

  it("puts capabilities before the changelog, without dropping either list", async () => {
    const status = (await app.inject({ method: "GET", url: "/api/evidence" })).json().status;
    expect(status.liveNow).toContain("Discovery");
    expect(status.liveNow).toContain("Fee sponsorship");
    expect(status.next).toContain("Pubnet");
    // The summary is a summary. The full lists remain the authority.
    expect(status.liveNow.length).toBeLessThan(status.built.length);
    expect(status.built).toContain("Hosted Stellar testnet facilitator");
    expect((await app.inject({ method: "GET", url: "/" })).body).toContain("View technical status");
  });

  it("says ownership and network in words, keeping the protocol values", async () => {
    const script = (await app.inject({ method: "GET", url: "/app.js" })).body;
    // "Ownership verified" was retired: it flattered trust-on-first-use once
    // domain binding gave that phrase a stronger meaning.
    expect(script).toContain("Ownership: first use");
    expect(script).toContain("Domain verified");
    expect(script).toContain("Stellar Testnet");
    // TOFU and the raw ids are explained rather than erased.
    // TOFU is still explained in the tooltip; only its headline label changed.
    expect(script).toContain("Trust on first use");
    expect(script).toContain("stellar:testnet");
    expect(script).toContain("base units");
    expect(script).toContain("Asset contract");
  });

  it("keeps the abstention reason code available as detail", async () => {
    const script = (await app.inject({ method: "GET", url: "/app.js" })).body;
    expect(script).toContain("No service was relevant enough to recommend spending on.");
    expect(script).toContain("0 USDC");
    // The code is not the headline, but it is still on the page.
    expect(script).toContain("abstained.reason");
  });

  it("never reports live traffic in its evidence", async () => {
    const body = (await app.inject({ method: "GET", url: "/api/evidence" })).json();
    const text = JSON.stringify(body).toLowerCase();
    for (const banned of ["uptime", "users", "requests today", "transactions today", "live traffic"]) {
      expect(text).not.toContain(banned);
    }
  });
});

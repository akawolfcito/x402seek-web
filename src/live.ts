/**
 * Read-only access to the hosted testnet deployment.
 *
 * The hosted facilitator sends no CORS headers, so a browser on x402seek.xyz
 * cannot call it directly. This is the narrowest thing that fixes that: four
 * GET endpoints that forward to two hard-coded hosts and return what they say.
 *
 * ## Why a client never supplies a URL
 *
 * A proxy that forwards wherever it is told is an SSRF hole, and this one sits
 * on a public site. So the hosts are constants in this file, the paths are
 * fixed, and the one endpoint that fetches a *seller* URL — the live 402
 * inspector — will only fetch a URL the live catalog itself returned. A caller
 * cannot introduce a destination; it can only ask about one the facilitator
 * already published.
 *
 * ## What this does not do
 *
 * No payment, no signing, no POST. The hosted facilitator settles payments;
 * this file cannot ask it to, and neither can the browser.
 */

export const LIVE_FACILITATOR = "https://facilitator.testnet.x402seek.xyz";
export const LIVE_SELLER_HOST = "demo-api.testnet.x402seek.xyz";

/** Upstream calls are bounded: a slow hosted service must not hold a socket here. */
const TIMEOUT_MS = 12_000;

export class LiveUnavailableError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "LiveUnavailableError";
  }
}

async function getJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new LiveUnavailableError(`upstream returned ${response.status}`, String(response.status));
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof LiveUnavailableError) throw error;
    throw new LiveUnavailableError(
      "the hosted facilitator could not be reached",
      error instanceof Error ? error.name : undefined,
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface LiveStatus {
  ready: boolean;
  network: string;
  scheme: string;
  catalog: number;
  discovery: { status: string; indexed: number };
  settlement: "enabled";
  /** Stated plainly rather than implied by omission. */
  scope: { accounts: "classic only"; schemes: string[]; upto: "not implemented" };
}

export async function liveStatus(): Promise<LiveStatus> {
  const health = await getJson<{
    ready: boolean;
    network: string;
    catalog: number;
    discovery: { status: string; indexed: number };
  }>(`${LIVE_FACILITATOR}/health`);

  const supported = await getJson<{ kinds: Array<{ network: string; scheme: string }> }>(
    `${LIVE_FACILITATOR}/supported`,
  );
  const schemes = [...new Set(supported.kinds.map((k) => k.scheme))];

  return {
    ready: health.ready === true,
    network: health.network,
    scheme: schemes[0] ?? "exact",
    catalog: health.catalog,
    discovery: health.discovery,
    // The hosted facilitator does settle payments. This site does not offer a
    // way to ask it to, which is a different statement and both are true.
    settlement: "enabled",
    scope: { accounts: "classic only", schemes, upto: "not implemented" },
  };
}

export async function liveResources(): Promise<unknown> {
  return getJson(`${LIVE_FACILITATOR}/discovery/resources`);
}

export async function liveSearch(query: string, filters: Record<string, string>): Promise<unknown> {
  const params = new URLSearchParams({ query });
  // Only the filters the facilitator understands, and only as opaque strings.
  for (const key of ["type", "network", "scheme"]) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  return getJson(`${LIVE_FACILITATOR}/discovery/search?${params}`);
}

export interface Live402 {
  status: number;
  resource: string;
  serviceName?: string;
  terms: {
    network: string;
    scheme: string;
    asset: string;
    amount: string;
    payTo: string;
  };
}

/**
 * Read a resource's live payment terms without paying.
 *
 * The URL is checked against the live catalog before it is fetched, so this
 * cannot be pointed at an arbitrary host. It also sends no `X-PAYMENT` header
 * and ignores anything but the 402 — there is no code path here that could
 * settle even if it wanted to.
 */
export async function inspectLive402(resourceUrl: string): Promise<Live402> {
  let parsed: URL;
  try {
    parsed = new URL(resourceUrl);
  } catch {
    throw new LiveUnavailableError("not a valid resource URL");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== LIVE_SELLER_HOST) {
    throw new LiveUnavailableError(`only ${LIVE_SELLER_HOST} resources can be inspected`);
  }

  // The URL must be one the live catalog published. This is what stops the
  // endpoint from becoming a general fetcher.
  const catalog = (await liveResources()) as { items?: Array<{ resource?: string }> };
  const known = (catalog.items ?? []).some((item) => item.resource === resourceUrl);
  if (!known) {
    throw new LiveUnavailableError("that resource is not in the live catalog");
  }

  const probe = new URL(resourceUrl);
  probe.searchParams.set("text", "The quick brown fox jumps over the lazy dog");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(probe, { signal: controller.signal });
  } catch {
    throw new LiveUnavailableError("the hosted seller could not be reached");
  } finally {
    clearTimeout(timer);
  }

  if (response.status !== 402) {
    throw new LiveUnavailableError(`expected 402 from the seller, got ${response.status}`);
  }

  const header = response.headers.get("payment-required");
  if (!header) throw new LiveUnavailableError("the 402 carried no payment-required header");

  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    resource: { url: string; serviceName?: string };
    accepts: Array<{ network: string; scheme: string; asset: string; amount: string; payTo: string }>;
  };
  const terms = decoded.accepts[0];
  if (!terms) throw new LiveUnavailableError("the 402 carried no payment terms");

  return {
    status: 402,
    resource: decoded.resource.url,
    ...(decoded.resource.serviceName ? { serviceName: decoded.resource.serviceName } : {}),
    terms: {
      network: terms.network,
      scheme: terms.scheme,
      asset: terms.asset,
      amount: terms.amount,
      payTo: terms.payTo,
    },
  };
}

/**
 * The hosted settlement, quoted from HOSTED-E-02 and HOSTED-E-03.
 *
 * Static because it describes one recorded event, not a counter. It is labelled
 * in the UI as a hosted testnet settlement — never as traffic, volume or stats,
 * which this site does not observe and must not imply it does.
 */
export const HOSTED_SETTLEMENT = {
  transaction: "cbd40ab0afff1a92773f58994d43a326d44be33b0c836c12cb1760db4b4f8752",
  buyer: "GA2DVFND5DMIN3WO2UH5WXJSDVSZQMLV625CWEPVEIF3C3EEU65RKOA3",
  seller: "GD45744YX7ELZEGGCV2ISXUHXA6LBDJR6THTTMP2EZ5JXMTE5K63XBRK",
  facilitator: "GDX6H6PL2DYMYW5UUZ6GGUD7UNCCHO6HNQMQDGQM4AMVP3LDGUZ2ZEMQ",
  amount: "0.0010000",
  asset: "USDC (testnet)",
  buyerXlmDelta: "+0.0000000",
  facilitatorFeeXlm: "0.0022973",
  resource: "https://demo-api.testnet.x402seek.xyz/summarize",
  note: "Catalog and ownership binding survived a facilitator restart; search rehydrated from persistent state.",
} as const;

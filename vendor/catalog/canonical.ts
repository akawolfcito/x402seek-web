/**
 * Canonical key derivation.
 *
 * The key is what the ownership rule protects, so ambiguity here is a security
 * bug, not a tidiness issue: two spellings of one resource producing two rows
 * means the second spelling bypasses the first row's owner check.
 *
 * Normalisation is therefore conservative and total — lowercase scheme and
 * host, drop a default port, collapse a trailing slash — and nothing else. In
 * particular we never rewrite a path to "repair" it. Invalid input is rejected
 * upstream by `isValidRouteTemplate`; see
 * docs/security/catalog-ownership-model.md §4.6.
 */

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/**
 * Normalise an absolute resource URL for use in a canonical key.
 *
 * @throws {Error} if the URL cannot be parsed.
 */
export function normalizeResourceUrl(raw: string): string {
  const url = new URL(raw);
  const scheme = url.protocol.toLowerCase();

  // `mcp:` and other non-special schemes: WHATWG gives them an opaque path and
  // an "null" origin, so they are rebuilt from parts rather than via `origin`.
  // This is also why MCP keys never route through the HTTP branch —
  // x402-foundation/x402 issue #3121 is exactly this bug upstream.
  if (scheme !== "http:" && scheme !== "https:") {
    const trimmed = raw.trim();
    const withoutTrailing = trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
    return withoutTrailing.toLowerCase();
  }

  const host = url.hostname.toLowerCase();
  const port = url.port && url.port !== DEFAULT_PORTS[scheme] ? `:${url.port}` : "";
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : "";

  return `${scheme}//${host}${port}${path}`;
}

/**
 * Canonical key for an HTTP resource.
 *
 * `resourceUrl` is expected to already carry the routeTemplate as its path when
 * the route is parameterised — that is what upstream `extractDiscoveryInfo`
 * produces, and reusing it keeps our dedup identical to the reference
 * behaviour described in specs/extensions/bazaar.md §"Dynamic Routes".
 */
export function httpCanonicalKey(resourceUrl: string): string {
  return normalizeResourceUrl(resourceUrl);
}

/**
 * Canonical key for an MCP tool: the tuple of `resource.url` and
 * `input.toolName`, per specs/extensions/bazaar.md and RFP §3.2.
 *
 * Built from the raw payload URL rather than from
 * `extractDiscoveryInfo().resourceUrl`, because that field is wrong for MCP
 * upstream: `mcp:` is not a WHATWG special scheme, so `url.origin` is the
 * string `"null"` and the canonical URL comes out as `null/tool/x`
 * (x402-foundation/x402 issue #3121). MCP is not implemented yet; this function
 * exists so the key space is structurally correct when it is.
 */
export function mcpCanonicalKey(resourceUrl: string, toolName: string): string {
  return `${normalizeResourceUrl(resourceUrl)}#tool=${toolName}`;
}

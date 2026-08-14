/**
 * Wire serialization for the discovery endpoints.
 *
 * The response shapes here come from the *implementation* stock clients parse —
 * `@x402/extensions@2.22.0` `src/bazaar/facilitatorClient.ts` — not from the
 * prose in `specs/extensions/bazaar.md`, which describes the filters but not the
 * envelope. Where the two could be read differently, the code wins, because the
 * code is what a reviewer's client will run.
 *
 * Two details are easy to get wrong and both were:
 *
 * - The list endpoint returns `items`; the search endpoint returns `resources`.
 *   The asymmetry is real (`DiscoveryResourcesResponse.items` vs
 *   `SearchDiscoveryResourcesResponse.resources`).
 * - Both envelopes carry `x402Version`.
 *
 * We shipped `{resources, pagination}` from the list endpoint with no
 * `x402Version`, which settled payments perfectly and produced a catalog no
 * stock client could read. The upstream e2e suite caught it with
 * `TypeError: Cannot read properties of undefined (reading 'length')` — exactly
 * the failure mode RFP §3.6 warns about: "correct settlement plus a non
 * conformant wire format produces an unusable service".
 */

import type { CatalogListing, DiscoveryPage } from "./types.js";

/** The x402 protocol version these endpoints speak. */
export const DISCOVERY_X402_VERSION = 2;

/**
 * One resource, in the shape `DiscoveryResource` defines.
 *
 * `accepts` is reconstructed as a `PaymentRequirements[]` from the settled facts
 * we stored, because that is how a client reads payment terms — our flat
 * `payTo`/`asset`/`amount` columns are storage, not wire.
 *
 * `ownerPayTo` and `ownershipBinding` are additional properties beyond the
 * upstream interface. They are deliberate: the binding is trust-on-first-use
 * and a consuming agent is entitled to know that (see
 * docs/security/catalog-ownership-model.md §5). Extra properties do not break
 * a structurally-typed client.
 */
export function toDiscoveryResource(listing: CatalogListing): Record<string, unknown> {
  return {
    resource: listing.resource,
    type: listing.type,
    x402Version: listing.x402Version,
    accepts: [
      {
        scheme: listing.scheme,
        network: listing.network,
        asset: listing.asset,
        amount: listing.amount,
        payTo: listing.payTo,
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true },
      },
    ],
    lastUpdated: listing.lastSeenAt,
    ...(listing.description ? { description: listing.description } : {}),
    ...(listing.mimeType ? { mimeType: listing.mimeType } : {}),
    ...(listing.serviceName ? { serviceName: listing.serviceName } : {}),
    ...(listing.tags ? { tags: listing.tags } : {}),
    ...(listing.iconUrl ? { iconUrl: listing.iconUrl } : {}),
    ...(listing.extensions ? { extensions: listing.extensions } : {}),

    // --- beyond the upstream interface, on purpose ---
    canonicalKey: listing.canonicalKey,
    ...(listing.routeTemplate ? { routeTemplate: listing.routeTemplate } : {}),
    ...(listing.method ? { method: listing.method } : {}),
    ...(listing.toolName ? { toolName: listing.toolName } : {}),
    ownerPayTo: listing.ownerPayTo,
    ownershipBinding: listing.ownershipBinding,
    firstSeenAt: listing.firstSeenAt,
    lastSettlementTx: listing.lastSettlementTx,
  };
}

/** `GET /discovery/resources` envelope: `items` plus offset pagination. */
export function toDiscoveryResourcesResponse(page: DiscoveryPage): Record<string, unknown> {
  return {
    x402Version: DISCOVERY_X402_VERSION,
    items: page.resources.map(toDiscoveryResource),
    pagination: page.pagination,
  };
}

/** `GET /discovery/search` envelope: `resources` plus a cursor. */
export function toDiscoverySearchResponse(
  resources: CatalogListing[],
  partialResults: boolean,
  pagination: { limit: number; cursor: string | null } | null,
  abstained?: { reason: string; topScore: number; threshold: number },
): Record<string, unknown> {
  return {
    x402Version: DISCOVERY_X402_VERSION,
    resources: resources.map(toDiscoveryResource),
    partialResults,
    pagination,
    ...(abstained ? { abstained } : {}),
  };
}

/**
 * The Listing window's link (step 5 of docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md): `/listings?listing=<id>`
 * opens the window on one listing. `GET /api/catalog-transfer/readiness/listing/:id` answers where that listing sits on
 * the page: its product, the product's family root, and the destination (the chip's key) it belongs to. Read only; no
 * channel call.
 *
 * The destination is the live layer's join rule (`liveDestinationKey`, listing-readiness-live.service.ts: channel,
 * market with GB = UK, account, alias — exactly), spelled as the page spells its chips: the readiness index's own key
 * when the business has that destination, otherwise the listing's own key — the extra chip the page shows for a listing
 * that matches no readiness destination (`attachLive`).
 */
import prisma from '../../db.js'
import { liveDestinationKey, readinessFootprint } from './listing-readiness-live.service.js'

export interface ReadinessListingTarget {
  productId: string
  /** The family root (`parentId ?? id`). */
  rootId: string
  destinationKey: string
  /** For the window's title. */
  sku: string
  name: string | null
}

export async function readinessListingTarget(listingId: string): Promise<ReadinessListingTarget> {
  const id = String(listingId ?? '').trim()
  const listing = id ? await prisma.channelListing.findFirst({
    where: { id, product: { deletedAt: null } },
    select: { productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, product: { select: { sku: true, name: true, parentId: true } } },
  }) : null
  if (!listing) throw Object.assign(new Error('Listing not found'), { statusCode: 404 })
  const key = liveDestinationKey(listing)
  return {
    productId: listing.productId,
    rootId: listing.product.parentId ?? listing.productId,
    destinationKey: (await readinessFootprint()).get(key) ?? key,
    sku: listing.product.sku,
    name: listing.product.name ?? null,
  }
}

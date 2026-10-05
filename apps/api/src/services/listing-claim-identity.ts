/**
 * BP.S3 — the seller identity a claim is keyed on; S8 (docs/sheet-ids-sku-rows/PLAN.md) — a listing may carry its own
 * channel SKU (per channel AND market), so these rules read it through the one resolver (`listings/channel-sku.pure.ts`).
 *
 *   - `sellerSkuForClaim`: the SKU publish SENDS for this listing (`wantedChannelSku`). A claim reserves the coordinate a
 *     push is about to write into, so it must name the SKU the push will name — the old "active offer, else product
 *     SKU" rule disagreed with Publish for a listing whose SKU sits in another store, and knows nothing of an own SKU.
 *   - `sellerSkuForDelist` (outbound-enqueue.ts): the SKU the channel HOLDS (`liveChannelSku`) — a delete names what is
 *     there now. The two differ only while a listing's own SKU is not yet live (a rename waiting for Publish).
 *   - `identitySellerSku`: what the identity checks compare with the channel's own read — the confirmed live SKU, else
 *     the listing's own SKU, else `offerOrProductSku` (today's rule). The SAME order as the identity-audit SQL
 *     (identity-audit.service.ts), so the sweep's link and the audit's comparison can never disagree.
 *
 * It stays apart from the claim service only to keep that service free of the outbound module's queue imports.
 */
import { wantedChannelSku, type ChannelSkuAnswer, type ChannelSkuListing } from './listings/channel-sku.pure.js'

type ProductSku = { product?: { sku: string | null } | null }

/**
 * The rule before S8, and still the identity audit's last step: the one active offer's SKU, else the product SKU.
 * Two different active offers name no single SKU: null (never a guess).
 */
export function offerOrProductSku(listing: ProductSku & {
  offers?: ReadonlyArray<{ sku: string | null; fulfillmentMethod?: string | null; isActive: boolean }> | null
}): string | null {
  const skus = [...new Set((listing.offers ?? [])
    .filter(offer => offer.isActive)
    .map(offer => offer.sku)
    .filter((sku): sku is string => typeof sku === 'string' && !!sku.trim()))]
  if (skus.length > 1) return null
  return skus[0] ?? (listing.product?.sku?.trim() ? listing.product.sku : null)
}

/**
 * The seller SKU a claim on a shared account is keyed on: the SKU publish sends for this listing, in this market
 * (`wantedChannelSku`), with the resolver's sentence when it has no single SKU (a conflict: the claim is then refused,
 * never guessed).
 */
export function claimSkuAnswer(listing: ChannelSkuListing & ProductSku): ChannelSkuAnswer {
  return wantedChannelSku(listing, listing.product?.sku)
}

/** `claimSkuAnswer`, the SKU only: null when the listing has no single SKU. */
export function sellerSkuForClaim(listing: ChannelSkuListing & ProductSku): string | null {
  return claimSkuAnswer(listing).sku
}

/** The seller SKU the identity checks compare with the channel's: liveChannelSku, then channelSku, then `offerOrProductSku`. */
export function identitySellerSku(listing: Parameters<typeof offerOrProductSku>[0] & {
  channelSku?: string | null
  liveChannelSku?: string | null
}): string | null {
  return listing.liveChannelSku?.trim() || listing.channelSku?.trim() || offerOrProductSku(listing)
}

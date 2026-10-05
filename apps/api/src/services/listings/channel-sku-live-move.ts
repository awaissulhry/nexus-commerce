/**
 * S9 / S10 — a SKU edit on a listing the channel HOLDS (plan docs/sheet-ids-sku-rows/PLAN.md). Pure: no database here.
 *
 * The Owner's rule (2026-10-05): a SKU edit in a channel scope belongs to that listing only (that channel and that
 * market). On a listing the channel does not hold yet (a still-draft, or one Deleted back to a draft) any SKU may be
 * typed: Publish lists it under that SKU. On a listing the channel holds, a new SKU MOVES the live listing, and Publish's
 * move step (S10) carries it where it can — so the edit is allowed exactly where Publish moves it, and refused, with the
 * sentence Publish's review says, where it cannot:
 *   - Amazon: allowed (one Publish creates NEW on the same ASIN, then deletes OLD) — except a family's MAIN row, whose
 *     variations hang under the old parent SKU (`amazonMainRowMove`, the sentence `studio-publication-amazon.ts` refuses);
 *   - eBay: allowed for an item sent through the Trading API (renamed in place); refused for an item on eBay's Inventory
 *     API (`ebayInventoryMoveRefusal`, the sentence `studio-publication-ebay.ts` refuses with);
 *   - Shopify: allowed (renamed in place);
 *   - Etsy: refused (`etsySkuMoveSentence`, the review's Etsy line); any other channel: refused.
 * Keeping the SKU the channel holds is always allowed.
 */
import { channelLabel, channelPlace } from '@nexus/shared/channel-label'
import { amazonMainRowMove, EBAY_INVENTORY_SKU_MOVE, etsySkuMoveSentence } from '@nexus/shared/publish-actions'
import { liveChannelSku, wantedChannelSku, type ChannelSkuListing } from './channel-sku.pure.js'

/** "Amazon · DE", "eBay · IT (extra listing)", "Shopify": where a listing sells, in the words the sheet uses (`channelPlace`). */
export function listingPlace(listing: { channel: string; marketplace?: string | null; aliasKey?: string | null }): string {
  const where = channelPlace(listing.channel, listing.marketplace)
  return listing.aliasKey ? `${where} (extra listing)` : where
}

/** eBay Inventory API: Publish cannot move the SKU — the review's sentence, and this edit's (one source). */
export const ebayInventoryMoveRefusal = (from: string, to: string) => `eBay holds ${from}, Nexus holds ${to}. ${EBAY_INVENTORY_SKU_MOVE}`

/** What decides whether Publish can move a held listing (read by `channelSkuMoveFacts`, channel-sku.ts). */
export interface ChannelSkuMoveFacts {
  /** Amazon: the listing is a family's main row (a parent, or a product with variations). */
  mainRow?: boolean
  /** eBay: the listing's item is on eBay's Inventory API (`usesEbayInventory`), not the Trading API. */
  ebayInventory?: boolean
}

/**
 * Can Publish move a listing the channel holds from `from` to `to`? Null = yes (the edit is allowed); otherwise the
 * sentence Publish's review gives for it. The per-channel answer — see the file header.
 */
export function channelSkuMoveRefusal(channel: string, from: string, to: string, facts: ChannelSkuMoveFacts = {}): string | null {
  switch (String(channel ?? '').toUpperCase()) {
    case 'AMAZON': return facts.mainRow ? amazonMainRowMove(from, to) : null
    case 'EBAY': return facts.ebayInventory ? ebayInventoryMoveRefusal(from, to) : null
    case 'SHOPIFY': return null
    case 'ETSY': return etsySkuMoveSentence(from, to)
    default: return `Nexus cannot move a ${channelLabel(channel) || channel} listing to a new SKU yet (${from} → ${to}): Delete it, then list it again.`
  }
}

/**
 * Why `nextChannelSku` may not be stored on this listing now, or null when it may. `nextChannelSku` is the value about
 * to be stored in `channelSku` (null = follow the product SKU). Allowed:
 *   - the listing is still a Nexus draft (never on the channel, or Deleted back to a draft);
 *   - the SKU it will send afterwards is the SKU the channel holds (setting it back to the live value, or following the
 *     product SKU when that is the SKU the channel holds);
 *   - the channel's SKU cannot be told (two on record) and the new value is one of them: that names which one it is;
 *   - a move Publish carries on this channel (`channelSkuMoveRefusal`).
 * Refused otherwise, with the sentence Publish's review gives for that move.
 */
export function liveChannelSkuMoveRefusal(
  listing: ChannelSkuListing & { marketplace?: string | null },
  productSku: string | null | undefined,
  nextChannelSku: string | null,
  facts: ChannelSkuMoveFacts = {},
): string | null {
  const held = liveChannelSku(listing, productSku)
  if (held === null) return null
  const next = wantedChannelSku({ ...listing, channelSku: nextChannelSku }, productSku).sku
  if (held.sku === null) {
    if (next && held.conflict.candidates.some(candidate => candidate.sku === next)) return null
    return `${held.conflict.sentence} Choose the SKU ${listingPlace(listing)} holds (${held.conflict.candidates.map(c => c.sku).join(' or ') || 'none on record'}).`
  }
  if (next === held.sku) return null
  if (!next) return `${listingPlace(listing)} would have no SKU to send. Type the SKU it should use.`
  return channelSkuMoveRefusal(listing.channel, held.sku, next, facts)
}

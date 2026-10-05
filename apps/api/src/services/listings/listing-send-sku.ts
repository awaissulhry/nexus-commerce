/**
 * Per-listing channel SKU, the SENDING side (plan docs/sheet-ids-sku-rows/PLAN.md, step S3): the SKU a sender names on
 * the channel for ONE listing — the SKU the channel holds for it (`liveChannelSku`, channel-sku.pure.ts). The Amazon
 * senders ask this one function: the stock and price push, Delete, Pause / Resume offer, recovery, the batch and image
 * feeds, FBA restore.
 *
 *   - a listing with no SKU of its own: the product SKU, exactly as before;
 *   - a listing with its own SKU (the confirmed `liveChannelSku`, or the one value an old store holds): that SKU;
 *   - two different SKUs on record (or an Amazon extra listing with none of its own): NO SKU, and the resolver's
 *     sentence. The sender sends nothing: a guess could write another listing's offer;
 *   - a listing that is still a Nexus draft (never on the channel), or no listing at all: `fallback`, what the sender
 *     sent before. A draft's own wanted SKU is Publish's to send, never a push's.
 *
 * Pure: the caller selects the facts (`CHANNEL_SKU_LISTING_SELECT`, or the subset its channel reads).
 */
import { liveChannelSku, wantedChannelSku, type ChannelSkuListing, type ChannelSkuProblem, type ChannelSkuSource } from './channel-sku.pure.js'

/** Flat on purpose: `apps/api` is not strict, so a union would not narrow. */
export interface ListingSendSku {
  /** The SKU to name on the channel; null = send nothing (`refusal` says why). */
  sku: string | null
  /** Where the SKU came from; 'fallback' = the caller's own value (a draft, or no listing). */
  source: ChannelSkuSource | 'fallback' | null
  /** One plain sentence when there is no single SKU; null otherwise. */
  refusal: string | null
  code: ChannelSkuProblem | null
}

/** Every channel-SKU problem a sender reports, under one error code. */
export const CHANNEL_SKU_UNRESOLVED = 'CHANNEL_SKU_UNRESOLVED'

/** The SKU the channel holds for `listing` (see the file header); `fallback` for a draft or a missing listing. */
export function listingSendSku(listing: ChannelSkuListing | null | undefined, productSku: string | null | undefined, fallback: string): ListingSendSku {
  const before: ListingSendSku = { sku: fallback, source: 'fallback', refusal: null, code: null }
  if (!listing) return before
  const held = liveChannelSku(listing, productSku)
  if (held === null) return before
  if (held.sku !== null) return { sku: held.sku, source: held.source, refusal: null, code: null }
  // No SKU anywhere (no product SKU, no store): nothing new is known, so the sender keeps what it named before.
  if (held.conflict.code === 'NO_SKU') return before
  return { sku: null, source: null, refusal: `${held.conflict.sentence} Nothing was sent.`, code: held.conflict.code }
}

/**
 * The Amazon EU shared-quantity guard, per seller SKU: does this sibling listing share the ONE EU quantity of `sku`?
 * Amazon keeps one merchant quantity per seller SKU across the EU markets, so two markets selling a product under two
 * different seller SKUs hold two quantities, and the same SKU in two markets is one quantity (as before). A sibling is
 * read under the SKU Amazon holds for it; a still-draft sibling under the SKU it will be listed with. A sibling whose
 * SKU cannot be told (two on record) counts as sharing it: the guard fails closed.
 */
export function sharesAmazonSellerSku(sibling: Omit<ChannelSkuListing, 'channel'>, productSku: string | null | undefined, sku: string): boolean {
  const facts = { ...sibling, channel: 'AMAZON' }
  const held = liveChannelSku(facts, productSku) ?? wantedChannelSku(facts, productSku)
  return held.sku === null || held.sku === sku.trim()
}

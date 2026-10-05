/**
 * Per-listing channel SKU, the pure rules (plan docs/sheet-ids-sku-rows/PLAN.md, step S2). No database here.
 *
 * The Owner's rule (2026-10-05): a SKU edit in a channel scope of the product sheet belongs to that listing only (that
 * channel AND that market; each Amazon EU market on its own). The Shared scope edits `Product.sku`. Two columns on
 * `ChannelListing` hold it (S1):
 *   - `channelSku`: the SKU Nexus sends to this channel and market. NULL = follow `Product.sku`.
 *   - `liveChannelSku`: the SKU the channel holds now, written only when the channel confirms it. NULL = nothing known.
 *
 * Until every writer moves to those columns, a listing's own SKU may still sit in the OLD stores, read here in today's
 * order: Amazon's active offers, then the Amazon mirror keys of `platformAttributes`, then `flatFileSnapshot`
 * (`AMAZON_LISTING_SKU_KEYS`, the same places Publish and the import read); Shopify's native `sku`
 * (`nativeListingValue`); an extra listing's own SKU (`ProductListingAlias.sku`, on the alias's main row). Shopify's
 * wanted rule reads its override bag before its native path (S5, `shopifyEditSku` below); eBay's and Shopify's old
 * stores are wanted values only (`legacySkuIsLive`).
 *
 * For an Amazon row with no `channelSku`, `wantedChannelSku` gives exactly the answer Amazon Publish gives today
 * (`studio-publication-amazon.ts`, the seller-SKU map): the one active offer or stored identity, else the product SKU;
 * two different identities are a conflict (never a guess), and an alias row with no identity of its own is refused.
 * One difference, on purpose: values are trimmed, so " ABC" and "ABC" are one SKU here.
 */
import { channelLabel } from '@nexus/shared/channel-label'
import { isStillDraftListing } from '@nexus/shared/push-lock'
import { AMAZON_LISTING_SKU_KEYS } from '../channel-mapping/defaults.js'
import { shopifyProductSpec } from '../pim/channel-specs/store.js'
import { nativeListingValue } from '../shopify/native-listing-value.js'

/** Where a SKU came from, so a caller can say it in plain words. */
export type ChannelSkuSource = 'channel' | 'live' | 'offer' | 'attributes' | 'flatFile' | 'shopify' | 'alias' | 'product'

/** Why a listing has no single SKU: two different ones on record, more than one active Amazon offer, an alias with none. */
export type ChannelSkuProblem = 'MULTIPLE_ACTIVE_OFFERS' | 'CONFLICTING_SKUS' | 'ALIAS_NEEDS_OWN_SKU' | 'NO_SKU'

/** The facts the rules read. Select what you have; a store you leave out simply counts as empty. */
export interface ChannelSkuListing {
  channel: string
  /** Needed for the alias store: the alias SKU belongs to the alias's main row (`alias.productId === productId`). */
  productId?: string | null
  /** '' (or null) = the primary listing; otherwise an extra listing (alias). */
  aliasKey?: string | null
  channelSku?: string | null
  liveChannelSku?: string | null
  /** The draft facts (`isStillDraftListing`); a missing fact counts as "not a draft". */
  listingStatus?: string | null
  isPublished?: boolean | null
  externalListingId?: string | null
  platformAttributes?: unknown
  flatFileSnapshot?: unknown
  overrideData?: unknown
  offers?: ReadonlyArray<{ sku: string | null; isActive: boolean; fulfillmentMethod?: string | null }> | null
  alias?: { sku?: string | null; productId?: string | null } | null
}

/** One SKU found in an old store. `key` names the attribute key, or the offer's fulfilment method. */
export interface LegacyChannelSku {
  sku: string
  source: Extract<ChannelSkuSource, 'offer' | 'attributes' | 'flatFile' | 'shopify' | 'alias'>
  key?: string
}

export interface ChannelSkuConflict {
  code: ChannelSkuProblem
  /** The values on record (for MULTIPLE_ACTIVE_OFFERS: the active offers' SKUs). */
  candidates: LegacyChannelSku[]
  /** One plain sentence. For Amazon, word for word what Amazon Publish says today. */
  sentence: string
}

/** A SKU and where it came from, or no SKU and why (never a guess). */
export type ChannelSkuAnswer =
  | { sku: string; source: ChannelSkuSource; conflict?: undefined }
  | { sku: null; source: null; conflict: ChannelSkuConflict }

/**
 * Where Shopify keeps a listing's native SKU, from the Shopify spec (the store `nativeListingValue` reads): the
 * `platformAttributes` paths and the `overrideData` keys. Only for a database prefilter that finds candidate rows;
 * `legacyChannelSkus` (through `nativeListingValue`) still decides what a row holds.
 */
export const SHOPIFY_SKU_STORES: { attributePaths: string[][]; overrideKeys: string[] } = (() => {
  const field = shopifyProductSpec().fields.find(f => f.shopifyField?.id === 'sku')
  const store = field?.channelStore
  const attributePaths = store?.kind === 'platformAttributes' ? [store.path, ...(store.legacyPaths ?? [])] : []
  return { attributePaths, overrideKeys: [...new Set([field?.masterKey ?? field?.key, field?.key].filter((k): k is string => !!k))] }
})()

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const isAmazon = (listing: ChannelSkuListing) => String(listing.channel ?? '').toUpperCase() === 'AMAZON'
const isShopify = (listing: ChannelSkuListing) => String(listing.channel ?? '').toUpperCase() === 'SHOPIFY'

/**
 * S4 (eBay) — do the old stores hold a SKU the channel HOLDS, or only one Nexus WANTS? eBay's only old store is an extra
 * listing's own SKU (`ProductListingAlias.sku`), and eBay publish never sent it: every eBay publisher built its rows from
 * `Product.sku`. So on eBay that value is wanted, never live: `liveChannelSku` skips it, and the backfill copies it into
 * `channelSku` only.
 *
 * S5 (Shopify) — the same. Its native SKU (`platformAttributes.sku`) is what the Shopify sheet's SKU column saves
 * (`listing_sku`) and what the next Publish sends; nothing writes Shopify's answer there. The override bag
 * (`overrideData.listing_sku`) holds older sheet edits. Neither proves what Shopify holds, so Shopify's live SKU is the
 * confirmed `liveChannelSku`, else the product SKU. Every other channel's old stores hold what the channel was sent.
 */
const WANTED_ONLY_LEGACY = new Set(['EBAY', 'SHOPIFY'])
export function legacySkuIsLive(listing: Pick<ChannelSkuListing, 'channel'>): boolean {
  return !WANTED_ONLY_LEGACY.has(String(listing.channel ?? '').toUpperCase())
}

/**
 * The SKUs the old stores hold for this listing, in today's reading order, trimmed and de-duplicated (the first store
 * that holds a value names its source). Amazon: offers (active only unless `offers: 'all'`), then `platformAttributes`,
 * then `flatFileSnapshot`. Shopify: the native `sku`. Any channel but Amazon: the alias's own SKU, on the alias's main
 * row only (Amazon Publish has never read it, so it stays out of the Amazon rule).
 *
 * `offers: 'all'` is for matching a channel's SKU back (an order or a report may name an offer that is no longer active).
 */
export function legacyChannelSkus(listing: ChannelSkuListing, options: { offers?: 'active' | 'all' } = {}): LegacyChannelSku[] {
  const found: LegacyChannelSku[] = []
  const add = (value: unknown, source: LegacyChannelSku['source'], key?: string) => {
    const sku = text(value)
    if (sku && !found.some(f => f.sku === sku)) found.push({ sku, source, ...(key ? { key } : {}) })
  }
  if (isAmazon(listing)) {
    for (const offer of listing.offers ?? []) {
      if (options.offers === 'all' || offer.isActive === true) add(offer.sku, 'offer', offer.fulfillmentMethod ?? undefined)
    }
    const pa = record(listing.platformAttributes)
    for (const key of AMAZON_LISTING_SKU_KEYS.platformAttributes) add(pa[key], 'attributes', key)
    const ff = record(listing.flatFileSnapshot)
    for (const key of AMAZON_LISTING_SKU_KEYS.flatFileSnapshot) add(ff[key], 'flatFile', key)
    return found
  }
  if (isShopify(listing)) add(nativeListingValue(listing, 'sku'), 'shopify', 'sku')
  const alias = listing.alias
  if (listing.aliasKey && alias?.productId && listing.productId && alias.productId === listing.productId) add(alias.sku, 'alias')
  return found
}

function conflictSentence(code: ChannelSkuProblem, listing: ChannelSkuListing, productSku: string, candidates: LegacyChannelSku[]): string {
  const name = productSku || 'This product'
  if (isAmazon(listing)) {
    // Word for word what Amazon Publish says today (studio-publication-amazon.ts), so a caller can swap rules unseen.
    if (code === 'MULTIPLE_ACTIVE_OFFERS') return `${name} has multiple seller SKUs. Select its offer before publishing.`
    if (code === 'CONFLICTING_SKUS') return `${name}: conflicting Amazon seller SKUs. Reconcile this listing's identity before publishing.`
    if (code === 'ALIAS_NEEDS_OWN_SKU') return `${name}: this alias needs its own Amazon seller SKU before publishing.`
  }
  const where = channelLabel(listing.channel) || 'channel'
  if (code === 'CONFLICTING_SKUS') {
    return `${name}: this ${where} listing has more than one SKU on record (${candidates.map(c => c.sku).join(', ')}). Set this listing's own SKU before sending it.`
  }
  if (code === 'ALIAS_NEEDS_OWN_SKU') return `${name}: this extra ${where} listing needs its own SKU before sending it.`
  if (code === 'MULTIPLE_ACTIVE_OFFERS') return `${name}: this ${where} listing has more than one active SKU. Select its offer before sending it.`
  return `${name}: this ${where} listing has no SKU to send.`
}

function refused(code: ChannelSkuProblem, listing: ChannelSkuListing, productSku: string, candidates: LegacyChannelSku[]): ChannelSkuAnswer {
  return { sku: null, source: null, conflict: { code, candidates, sentence: conflictSentence(code, listing, productSku, candidates) } }
}

/**
 * The SKU the OLD stores give this listing, ignoring the two new columns: exactly one value → that value; none → the
 * product SKU (an Amazon alias row: refused); two different values → a conflict. Amazon also refuses more than one
 * active offer, before anything else, as Publish does. The backfill reads this; `wantedChannelSku` and
 * `liveChannelSku` fall back to it.
 */
export function legacyChannelSku(listing: ChannelSkuListing, productSku: string | null | undefined): ChannelSkuAnswer {
  const product = text(productSku) ?? ''
  if (isAmazon(listing)) {
    const active = legacyChannelSkus({ channel: listing.channel, offers: (listing.offers ?? []).filter(o => o.isActive === true) })
    if (active.length > 1) return refused('MULTIPLE_ACTIVE_OFFERS', listing, product, active)
  }
  const legacy = legacyChannelSkus(listing)
  if (legacy.length > 1) return refused('CONFLICTING_SKUS', listing, product, legacy)
  if (legacy.length === 1) return { sku: legacy[0].sku, source: legacy[0].source }
  if (isAmazon(listing) && listing.aliasKey) return refused('ALIAS_NEEDS_OWN_SKU', listing, product, [])
  return product ? { sku: product, source: 'product' } : refused('NO_SKU', listing, product, [])
}

/**
 * S5 — Shopify's wanted SKU reads its old stores in this order: the edit in the override bag
 * (`overrideData.listing_sku`), then the native path (`platformAttributes.sku`) and an extra listing's own SKU (two
 * different values there are a conflict), then the product SKU. All of them are wanted values (`legacySkuIsLive`).
 */
function shopifyEditSku(listing: ChannelSkuListing): string | null {
  const bag = record(listing.overrideData)
  for (const key of SHOPIFY_SKU_STORES.overrideKeys) {
    const sku = text(bag[key])
    if (sku) return sku
  }
  return null
}

/** S5 — Shopify: the SKU its other stores give (the native path, then an extra listing's own SKU). */
function shopifyStoredSku(listing: ChannelSkuListing, productSku: string | null | undefined): ChannelSkuAnswer {
  const product = text(productSku) ?? ''
  const found: LegacyChannelSku[] = []
  const add = (value: unknown, source: LegacyChannelSku['source'], key?: string) => {
    const sku = text(value)
    if (sku && !found.some(f => f.sku === sku)) found.push({ sku, source, ...(key ? { key } : {}) })
  }
  for (const path of SHOPIFY_SKU_STORES.attributePaths) add(path.reduce<unknown>((bag, key) => record(bag)[key], listing.platformAttributes), 'shopify', 'sku')
  const alias = listing.alias
  if (listing.aliasKey && alias?.productId && listing.productId && alias.productId === listing.productId) add(alias.sku, 'alias')
  if (found.length > 1) return refused('CONFLICTING_SKUS', listing, product, found)
  if (found.length === 1) return { sku: found[0].sku, source: found[0].source }
  return product ? { sku: product, source: 'product' } : refused('NO_SKU', listing, product, [])
}

/** The SKU Nexus sends for this listing: its own `channelSku` when set; else the old stores' one value; else the product SKU. */
export function wantedChannelSku(listing: ChannelSkuListing, productSku: string | null | undefined): ChannelSkuAnswer {
  const own = text(listing.channelSku)
  if (own) return { sku: own, source: 'channel' }
  if (isShopify(listing)) {
    const edit = shopifyEditSku(listing)
    return edit ? { sku: edit, source: 'shopify' } : shopifyStoredSku(listing, productSku)
  }
  return legacyChannelSku(listing, productSku)
}

/**
 * The SKU the channel holds for this listing: null while the listing is still a Nexus draft (never on the channel);
 * else the confirmed `liveChannelSku` when set; else the old stores' one value; else the product SKU. eBay and Shopify
 * (`legacySkuIsLive`): the confirmed `liveChannelSku`, else the product SKU — their old stores hold values Nexus wants,
 * not values the channel is known to hold.
 */
export function liveChannelSku(listing: ChannelSkuListing, productSku: string | null | undefined): ChannelSkuAnswer | null {
  if (isStillDraftListing(listing)) return null
  const live = text(listing.liveChannelSku)
  if (live) return { sku: live, source: 'live' }
  if (!legacySkuIsLive(listing)) {
    const product = text(productSku)
    return product ? { sku: product, source: 'product' } : refused('NO_SKU', listing, '', [])
  }
  return legacyChannelSku(listing, productSku)
}

/**
 * For the sheet's "Own SKU here" mark: true when this listing does not simply send the product SKU — its wanted SKU
 * is another value, or it has no single SKU (a conflict also needs the person's eye).
 */
export function differsFromProduct(listing: ChannelSkuListing, productSku: string | null | undefined): boolean {
  const wanted = wantedChannelSku(listing, productSku)
  return wanted.sku === null || wanted.sku !== (text(productSku) ?? '')
}

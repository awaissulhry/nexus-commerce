/**
 * Amazon sheet gaps — ONE reader of a listing's Amazon offer facts (the leaves of `offer-fields.ts`), in two lanes:
 *
 *   - `job`     (price job, stock job, cockpit, old page): the LIVE value of every leaf. Never a draft.
 *   - `publish` (studio Publish): live, with the listing's offer draft (`amazonOfferDraft`) on top.
 *
 * Precedence per leaf: the live store first — the price columns and the sale window for the price facts,
 * `platformAttributes.amazonOffer.*` / `.amazonFulfillment.*` for the rest, where an explicit `null` means cleared
 * and stops the search — then Amazon's own report (the pull's `platformAttributes.attributes.<root>`, then a top-level
 * `platformAttributes.<root>`). `overrideData` is never read: an old sheet value saved there was never sent, and it
 * does not start being sent now.
 *
 * Two deliberate exceptions to the mirror fallback: the sale comes from the price columns only (Nexus's own sale — a
 * sale Amazon reports from Seller Central is the builder's `base`, never re-sent from a stale copy), and the price
 * falls back to Amazon's report only when the listing holds no price at all.
 */
import type { Prisma } from '@prisma/client'
import { amazonFulfilmentCodes, hasFbaFulfilmentCode, normaliseAmazonFulfilmentCode } from '../../lib/amazon-fulfilment-programme.js'
import { marketplaceCodeToId } from '../../utils/marketplace-code.js'
import { readSaleWindows, type SaleWindow } from '../pim/sale-window.js'
import { listingSendPriceNow } from '../pim/follower-price.js'
import { AMAZON_OFFER_LEAVES, amazonOfferLivePath, dayOf, isAmazonDate, type AmazonOfferLeaf } from './offer-fields.js'
import { readAmazonOfferDraft, type AmazonOfferDraft } from './offer-draft.js'

export type AmazonOfferLane = 'job' | 'publish'
export type AmazonOfferSource = 'live' | 'mirror' | 'draft' | 'none'

/** The facts in the shape the builder sends them. */
export interface AmazonOfferValues {
  our_price: { mode: 'follow' | 'pin'; price: number | null }
  sale: { price: number; start: string | null; end: string | null } | null
  minimum_seller_allowed_price: number | null
  maximum_seller_allowed_price: number | null
  map_price: number | null
  offer_start_at: string | null
  offer_end_at: string | null
  automated_pricing_rule_id: string | null
  lead_time_to_ship_max_days: number | null
  restock_date: string | null
  is_inventory_available: boolean | null
}

export interface AmazonOfferFacts {
  lane: AmazonOfferLane
  marketplaceId: string | null
  values: AmazonOfferValues
  source: Record<AmazonOfferLeaf, AmazonOfferSource>
  /** Every fulfilment code the listing carries, both places (`amazon-fulfilment-programme.ts`). */
  fulfilmentCodes: string[]
  /** The FBA guard's code test on the stored copies (D9 = A: plain AMAZON_EU only in Amazon's pulled copy does not count). */
  fbaByCode: boolean
  /** The draft laid over live (publish lane only). */
  draft: AmazonOfferDraft | null
}

/** The listing columns the reader needs (a Prisma row fits; Decimals are read as numbers). */
export interface AmazonOfferFactsListing {
  marketplace: string | null
  price?: unknown
  priceOverride?: unknown
  followMasterPrice?: boolean | null
  salePrice?: unknown
  /** `readSaleWindows`' answer for this listing (the two raw window columns). */
  saleWindow?: SaleWindow | null
  platformAttributes?: unknown
}

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : typeof (v as { toNumber?: unknown }).toNumber === 'function' ? (v as { toNumber(): number }).toNumber() : Number(String(v))
  return Number.isFinite(n) ? n : null
}
const at = (bag: unknown, path: readonly string[]): unknown => {
  let cur: unknown = bag
  for (const p of path) { if (!cur || typeof cur !== 'object') return undefined; cur = (cur as Record<string, unknown>)[p] }
  return cur
}

/** One leaf's value checked to its shape; `undefined` when the stored value is not one (it is then not trusted). */
function shaped(leaf: AmazonOfferLeaf, v: unknown): unknown {
  if (v === null) return null
  switch (leaf) {
    case 'minimum_seller_allowed_price': case 'maximum_seller_allowed_price': case 'map_price': {
      const n = num(v); return n != null && n >= 0 ? n : undefined
    }
    case 'offer_start_at': case 'offer_end_at': return isAmazonDate(v) ? v : undefined
    case 'restock_date': return isAmazonDate(v) ? dayOf(v) : undefined
    case 'automated_pricing_rule_id': return typeof v === 'string' && v.trim() ? v.trim() : undefined
    case 'lead_time_to_ship_max_days': { const n = num(v); return n != null && Number.isInteger(n) && n >= 0 && n <= 120 ? n : undefined }
    case 'is_inventory_available': return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined
  }
  return undefined
}

/** `amazonMarketplaceIdOrNull`'s rule without the outbound module: a full id passes, a code maps, GB is UK. */
export function amazonMarketplaceIdOf(market: string | null | undefined): string | null {
  if (!market) return null
  if (/^A[A-Z0-9]{9,}$/.test(market)) return market
  const code = market.trim().toUpperCase()
  return marketplaceCodeToId(code === 'GB' ? 'UK' : code)
}

/** Amazon's reported `purchasable_offer` instance for this market (all buyers), from one root. */
export function reportedOfferInstance(root: unknown, marketplaceId: string | null): Record<string, unknown> | null {
  const instances = list(root).map(record).filter((x): x is Record<string, unknown> => !!x)
  const audienceAll = (x: Record<string, unknown>) => String(x.audience ?? 'ALL').toUpperCase() === 'ALL'
  const here = instances.filter((x) => audienceAll(x) && (x.marketplace_id == null || x.marketplace_id === marketplaceId))
  if (here.length) return here[0]
  return instances.length === 1 && audienceAll(instances[0]) ? instances[0] : null
}

/** Amazon's reported merchant `fulfillment_availability` entry (DEFAULT, else one with no code), from one root. */
export function reportedFulfilmentEntry(root: unknown): Record<string, unknown> | null {
  const entries = list(root).map(record).filter((x): x is Record<string, unknown> => !!x)
  return entries.find((e) => normaliseAmazonFulfilmentCode(e.fulfillment_channel_code) === 'DEFAULT')
    ?? entries.find((e) => !normaliseAmazonFulfilmentCode(e.fulfillment_channel_code)) ?? entries[0] ?? null
}

const schedule = (sub: unknown): unknown => at(list(sub)[0], ['schedule', '0', 'value_with_tax']) ?? at(list(sub)[0], ['schedule', '0', 'value'])

/** One leaf from one reported instance / entry. */
function reportedLeaf(leaf: AmazonOfferLeaf, instance: Record<string, unknown> | null, entry: Record<string, unknown> | null): unknown {
  switch (leaf) {
    case 'our_price': return instance ? schedule(instance.our_price) : undefined
    case 'minimum_seller_allowed_price': case 'maximum_seller_allowed_price': case 'map_price': return instance ? schedule(instance[leaf]) : undefined
    case 'offer_start_at': return instance ? at(instance.start_at, ['value']) : undefined
    case 'offer_end_at': return instance ? at(instance.end_at, ['value']) : undefined
    case 'automated_pricing_rule_id': return instance ? at(list(instance.automated_pricing_merchandising_rule_plan)[0], ['merchandising_rule', 'rule_id']) : undefined
    case 'lead_time_to_ship_max_days': case 'restock_date': case 'is_inventory_available': return entry ? entry[leaf] : undefined
  }
  return undefined
}

export interface ReadAmazonOfferFactsOptions {
  /** The price a following listing is sent now (`listingSendPrice`), for a draft that sets it back to Follow. */
  followPrice?: number | null
}

/** PURE — the offer facts of one listing in one lane. */
export function readAmazonOfferFacts(listing: AmazonOfferFactsListing, lane: AmazonOfferLane, options: ReadAmazonOfferFactsOptions = {}): AmazonOfferFacts {
  const pa = record(listing.platformAttributes) ?? {}
  const marketplaceId = amazonMarketplaceIdOf(listing.marketplace)
  const attrs = record(pa.attributes)
  const mirrors = [
    { instance: reportedOfferInstance(attrs?.purchasable_offer, marketplaceId), entry: reportedFulfilmentEntry(attrs?.fulfillment_availability) },
    { instance: reportedOfferInstance(pa.purchasable_offer, marketplaceId), entry: reportedFulfilmentEntry(pa.fulfillment_availability) },
  ]
  const source = {} as Record<AmazonOfferLeaf, AmazonOfferSource>
  const values = {} as Record<AmazonOfferLeaf, unknown>

  // Price: the listing's own columns (the number the push reads); Amazon's report only when the listing has none.
  const pinned = listing.followMasterPrice === false
  const own = pinned ? num(listing.priceOverride) ?? num(listing.price) : num(listing.price)
  let reportedPrice: number | null = null
  for (const m of mirrors) { reportedPrice ??= num(reportedLeaf('our_price', m.instance, m.entry)) }
  values.our_price = { mode: pinned ? 'pin' : 'follow', price: own ?? reportedPrice }
  source.our_price = own != null ? 'live' : reportedPrice != null ? 'mirror' : 'none'

  // Sale: Nexus's own sale (value + window), never a reported one.
  const salePrice = num(listing.salePrice)
  values.sale = salePrice != null ? { price: salePrice, start: listing.saleWindow?.start ?? null, end: listing.saleWindow?.end ?? null } : null
  source.sale = salePrice != null ? 'live' : 'none'

  for (const leaf of AMAZON_OFFER_LEAVES) {
    if (leaf === 'our_price' || leaf === 'sale') continue
    const path = amazonOfferLivePath(leaf)!
    const live = path ? shaped(leaf, at(pa, path)) : undefined
    if (live !== undefined) { values[leaf] = live; source[leaf] = 'live'; continue }
    let found: unknown
    for (const m of mirrors) {
      const v = shaped(leaf, reportedLeaf(leaf, m.instance, m.entry))
      if (v !== undefined && v !== null) { found = v; break }
    }
    values[leaf] = found ?? null
    source[leaf] = found !== undefined ? 'mirror' : 'none'
  }

  const draft = lane === 'publish' ? readAmazonOfferDraft(pa) : null
  for (const [leaf, entry] of Object.entries(draft?.leaves ?? {}) as Array<[AmazonOfferLeaf, { value: unknown }]>) {
    if (leaf === 'our_price') {
      const v = record(entry.value)
      if (v?.follow === true) values.our_price = { mode: 'follow', price: options.followPrice ?? num(listing.price) ?? reportedPrice }
      else if (num(v?.pin) != null) values.our_price = { mode: 'pin', price: num(v!.pin) }
      else continue
    } else if (leaf === 'sale') {
      const v = record(entry.value)
      if (entry.value !== null && num(v?.price) == null) continue
      values.sale = v ? { price: num(v.price)!, start: typeof v.start === 'string' ? v.start : null, end: typeof v.end === 'string' ? v.end : null } : null
    } else {
      const v = shaped(leaf, entry.value)
      if (v === undefined) continue
      values[leaf] = v
    }
    source[leaf] = 'draft'
  }

  return { lane, marketplaceId, values: values as unknown as AmazonOfferValues, source, fulfilmentCodes: amazonFulfilmentCodes(pa), fbaByCode: hasFbaFulfilmentCode(pa), draft }
}

/** The live value of every leaf in the DRAFT's shape — what a draft leaf is compared with and saved against. */
export function liveDraftValues(facts: AmazonOfferFacts): Record<AmazonOfferLeaf, unknown> {
  const v = facts.values
  const out = {} as Record<AmazonOfferLeaf, unknown>
  for (const leaf of AMAZON_OFFER_LEAVES) out[leaf] = (v as unknown as Record<string, unknown>)[leaf] ?? null
  out.our_price = v.our_price.mode === 'pin' && v.our_price.price != null ? { pin: v.our_price.price } : { follow: true }
  out.sale = v.sale && v.sale.start && v.sale.end ? { price: v.sale.price, start: v.sale.start, end: v.sale.end } : null
  return out
}

type Db = Pick<Prisma.TransactionClient, 'channelListing' | '$queryRawUnsafe' | '$executeRawUnsafe'>

export const OFFER_FACTS_LISTING_SELECT = {
  id: true, channel: true, marketplace: true, price: true, priceOverride: true, followMasterPrice: true, pricingRule: true,
  priceAdjustmentPercent: true, salePrice: true, platformAttributes: true, product: { select: { basePrice: true } },
} as const

/** The offer facts of many listings: one listing read and one sale-window read. */
export async function loadAmazonOfferFacts(db: Db, listingIds: readonly string[], lane: AmazonOfferLane): Promise<Map<string, AmazonOfferFacts>> {
  const out = new Map<string, AmazonOfferFacts>()
  if (listingIds.length === 0) return out
  const [rows, windows] = await Promise.all([
    db.channelListing.findMany({ where: { id: { in: [...listingIds] } }, select: OFFER_FACTS_LISTING_SELECT }),
    readSaleWindows(db as never, listingIds),
  ])
  for (const row of rows) {
    let followPrice: number | null | undefined
    // Only a Publish of a draft that sets the price back to Follow needs the rule's price now.
    if (lane === 'publish' && record(readAmazonOfferDraft(row.platformAttributes)?.leaves.our_price?.value)?.follow === true) {
      followPrice = (await listingSendPriceNow({ ...row, followMasterPrice: true, priceOverride: null } as never, row.product?.basePrice)).price
    }
    out.set(row.id, readAmazonOfferFacts({ ...row, saleWindow: windows.get(row.id) ?? null }, lane, { followPrice }))
  }
  return out
}

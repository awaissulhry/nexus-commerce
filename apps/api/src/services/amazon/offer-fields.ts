/**
 * Amazon sheet gaps (gaps 1–3, D4=B, D5=B) — THE registry of Amazon's offer and fulfilment fields: for every sheet key
 * under `purchasable_offer`, `fulfillment_availability` and `list_price`, the one fact it is, the one store that holds
 * it, the one service that writes it, and the rules it carries. Pure: no Prisma.
 *
 * Every consumer reads this table instead of re-deciding: the reader (`offer-facts.ts`), the send builder
 * (`offer-attributes.ts`), the draft model (`offer-draft.ts`), the channel spec (`channel-specs/amazon.ts`), the sheet
 * cells and writes (U5) and the Publish offer lane (U4a).
 *
 *   - `leaf` is the fact's id (the draft leaf key, design-draft-and-remote §A). The sale's three keys are one leaf.
 *   - `lane` says how an edit on a LIVE listing travels: `draft` = saved as an offer draft, sent on Publish;
 *     `matrix` = immediate, through the Matrix door (quantity, fulfilment method); `channel` = the generic channel
 *     value (RRP). A still-draft listing writes the live doors directly.
 *   - `livePath` is where the live value sits in `platformAttributes` (the price and sale facts live in the listing's
 *     price columns instead). Amazon's own report (the pull's mirror) is read second, never `overrideData`.
 */
import type { ChannelStore } from '../pim/channel-specs/types.js'
import { PARENT_PRICE_REASON, PARENT_REASON } from '../pim/matrix-cells.js'

export type AmazonOfferLeaf =
  | 'our_price' | 'sale' | 'minimum_seller_allowed_price' | 'maximum_seller_allowed_price' | 'map_price'
  | 'offer_start_at' | 'offer_end_at' | 'automated_pricing_rule_id'
  | 'lead_time_to_ship_max_days' | 'restock_date' | 'is_inventory_available'

/** The leaves inside `purchasable_offer` (per market). */
export const PURCHASABLE_OFFER_LEAVES = [
  'our_price', 'sale', 'minimum_seller_allowed_price', 'maximum_seller_allowed_price', 'map_price',
  'offer_start_at', 'offer_end_at', 'automated_pricing_rule_id',
] as const satisfies readonly AmazonOfferLeaf[]
/** The leaves inside `fulfillment_availability` (one per SKU across the EU markets). */
export const FULFILMENT_LEAVES = ['lead_time_to_ship_max_days', 'restock_date', 'is_inventory_available'] as const satisfies readonly AmazonOfferLeaf[]
export const AMAZON_OFFER_LEAVES: readonly AmazonOfferLeaf[] = [...PURCHASABLE_OFFER_LEAVES, ...FULFILMENT_LEAVES]

export type AmazonOfferRoot = 'purchasable_offer' | 'fulfillment_availability' | 'list_price'
export const rootOfLeaf = (leaf: AmazonOfferLeaf): 'purchasable_offer' | 'fulfillment_availability' =>
  (FULFILMENT_LEAVES as readonly string[]).includes(leaf) ? 'fulfillment_availability' : 'purchasable_offer'

/** The sub-attribute of Amazon's root each leaf is (`offer_start_at` is the offer's `start_at`). */
export const AMAZON_SUB_ATTRIBUTE: Readonly<Record<AmazonOfferLeaf, string>> = {
  our_price: 'our_price', sale: 'discounted_price',
  minimum_seller_allowed_price: 'minimum_seller_allowed_price', maximum_seller_allowed_price: 'maximum_seller_allowed_price',
  map_price: 'map_price', offer_start_at: 'start_at', offer_end_at: 'end_at',
  automated_pricing_rule_id: 'automated_pricing_merchandising_rule_plan',
  lead_time_to_ship_max_days: 'lead_time_to_ship_max_days', restock_date: 'restock_date', is_inventory_available: 'is_inventory_available',
}

/** The live store of each leaf. `priceColumns` / `saleColumns` = the listing's price columns (the price door's). */
export type AmazonOfferLiveStore =
  | { kind: 'priceColumns' }
  | { kind: 'saleColumns' }
  | { kind: 'platformAttributes'; path: [string, string] }

export const AMAZON_OFFER_LIVE_STORE: Readonly<Record<AmazonOfferLeaf, AmazonOfferLiveStore>> = {
  our_price: { kind: 'priceColumns' },
  sale: { kind: 'saleColumns' },
  minimum_seller_allowed_price: { kind: 'platformAttributes', path: ['amazonOffer', 'minimum_seller_allowed_price'] },
  maximum_seller_allowed_price: { kind: 'platformAttributes', path: ['amazonOffer', 'maximum_seller_allowed_price'] },
  map_price: { kind: 'platformAttributes', path: ['amazonOffer', 'map_price'] },
  offer_start_at: { kind: 'platformAttributes', path: ['amazonOffer', 'start_at'] },
  offer_end_at: { kind: 'platformAttributes', path: ['amazonOffer', 'end_at'] },
  automated_pricing_rule_id: { kind: 'platformAttributes', path: ['amazonOffer', 'automated_pricing_rule_id'] },
  lead_time_to_ship_max_days: { kind: 'platformAttributes', path: ['amazonFulfillment', 'lead_time_to_ship_max_days'] },
  restock_date: { kind: 'platformAttributes', path: ['amazonFulfillment', 'restock_date'] },
  is_inventory_available: { kind: 'platformAttributes', path: ['amazonFulfillment', 'is_inventory_available'] },
}
/** The `platformAttributes` path of a leaf's live value, or null for the price-column facts. */
export function amazonOfferLivePath(leaf: AmazonOfferLeaf): [string, string] | null {
  const store = AMAZON_OFFER_LIVE_STORE[leaf]
  return store.kind === 'platformAttributes' ? store.path : null
}
/** The draft layer's key in `platformAttributes` (design-draft-and-remote §A). */
export const AMAZON_OFFER_DRAFT_KEY = 'amazonOfferDraft'

/** The services that write each fact (named; the write paths live in their own modules). */
export type AmazonOfferWriteService = 'writeChannelPrices' | 'setAmazonFulfilmentSettings' | 'writeMatrixCells' | 'setFulfillmentMethod' | 'channelValueWrite'

export type AmazonOfferCheck =
  | 'price' | 'saleBothDates' | 'date' | 'dateTodayOrLater' | 'leadTimeDays' | 'boolean' | 'ruleId' | 'minNotAboveMax' | 'priceInsideBounds'

export interface AmazonOfferField {
  /** The sheet column key (the channel spec's field key). */
  key: string
  root: AmazonOfferRoot
  /** The fact; `null` for the two immediate Matrix facts and RRP. */
  leaf: AmazonOfferLeaf | null
  /** The sale's three keys are one leaf. */
  part?: 'value' | 'start' | 'end'
  lane: 'draft' | 'matrix' | 'channel'
  writeService: AmazonOfferWriteService
  /** The store the channel spec declares for the generic reader; absent = the spec keeps what it has. */
  specStore?: ChannelStore
  /** Applies on an FBA listing; when false, `fbaReason` says why it is held. */
  fbaApplies: boolean
  /** One value for every Amazon EU market of the SKU (Amazon keeps one fulfilment entry per SKU across the EU). */
  euShared: boolean
  /** The parent is not buyable: its sentence when the field is held on a parent row. */
  parentReason: string
  /** Held on this surface (sheet only, never a mapping rule — see `ChannelFieldSpec.editHeldReason`). */
  editHeldReason?: string
  checks: readonly AmazonOfferCheck[]
}

export const FBA_FULFILMENT_REASON =
  'Amazon stores and ships this listing (FBA): handling time, restock date and always available apply only to orders you ship (FBM). The saved value is kept.'
export const QUANTITY_HELD_REASON =
  'Set the quantity in the Qty column — the Matrix\'s own, with its buffer and the Amazon EU shared-stock check.'

/** The two mirror places Amazon's report sits in: the pull's `attributes.<root>`, and a top-level `<root>`. */
const mirror = (root: string, ...tail: string[]): string[][] => [['attributes', root, '0', ...tail], [root, '0', ...tail]]
const offerStore = (leaf: AmazonOfferLeaf, ...tail: string[]): ChannelStore =>
  ({ kind: 'platformAttributes', path: [...amazonOfferLivePath(leaf)!], legacyPaths: mirror('purchasable_offer', ...tail) })
const fulfilmentStore = (leaf: AmazonOfferLeaf): ChannelStore =>
  ({ kind: 'platformAttributes', path: [...amazonOfferLivePath(leaf)!], legacyPaths: mirror('fulfillment_availability', leaf) })

const offer = (key: string, leaf: AmazonOfferLeaf, checks: AmazonOfferCheck[], extra: Partial<AmazonOfferField> = {}): AmazonOfferField => ({
  key, root: 'purchasable_offer', leaf, lane: 'draft', writeService: 'writeChannelPrices', fbaApplies: true, euShared: false,
  parentReason: PARENT_PRICE_REASON, checks, ...extra,
})
const fulfilment = (key: string, leaf: AmazonOfferLeaf, checks: AmazonOfferCheck[]): AmazonOfferField => ({
  key, root: 'fulfillment_availability', leaf, lane: 'draft', writeService: 'setAmazonFulfilmentSettings', fbaApplies: false, euShared: true,
  parentReason: PARENT_REASON, checks, specStore: fulfilmentStore(leaf),
})

export const AMAZON_OFFER_FIELDS: readonly AmazonOfferField[] = [
  offer('purchasable_offer__our_price', 'our_price', ['price', 'priceInsideBounds'],
    { specStore: { kind: 'listingColumn', column: 'price', followFlag: 'followMasterPrice' } }),
  offer('purchasable_offer__discounted_price__value_with_tax', 'sale', ['price', 'saleBothDates'], { part: 'value' }),
  offer('purchasable_offer__discounted_price__start_at', 'sale', ['date', 'saleBothDates'], { part: 'start' }),
  offer('purchasable_offer__discounted_price__end_at', 'sale', ['date', 'saleBothDates'], { part: 'end' }),
  offer('purchasable_offer__minimum_seller_allowed_price', 'minimum_seller_allowed_price', ['price', 'minNotAboveMax'],
    { specStore: offerStore('minimum_seller_allowed_price', 'minimum_seller_allowed_price', '0', 'schedule', '0', 'value_with_tax') }),
  offer('purchasable_offer__maximum_seller_allowed_price', 'maximum_seller_allowed_price', ['price', 'minNotAboveMax'],
    { specStore: offerStore('maximum_seller_allowed_price', 'maximum_seller_allowed_price', '0', 'schedule', '0', 'value_with_tax') }),
  offer('purchasable_offer__map_price', 'map_price', ['price'],
    { specStore: offerStore('map_price', 'map_price', '0', 'schedule', '0', 'value_with_tax') }),
  offer('purchasable_offer__start_at', 'offer_start_at', ['date'], { specStore: offerStore('offer_start_at', 'start_at', 'value') }),
  offer('purchasable_offer__end_at', 'offer_end_at', ['date'], { specStore: offerStore('offer_end_at', 'end_at', 'value') }),
  offer('purchasable_offer__automated_pricing_merchandising_rule_plan', 'automated_pricing_rule_id', ['ruleId'],
    { specStore: offerStore('automated_pricing_rule_id', 'automated_pricing_merchandising_rule_plan', '0', 'merchandising_rule', 'rule_id') }),
  fulfilment('fulfillment_availability__lead_time_to_ship_max_days', 'lead_time_to_ship_max_days', ['leadTimeDays']),
  fulfilment('fulfillment_availability__restock_date', 'restock_date', ['dateTodayOrLater']),
  fulfilment('fulfillment_availability__is_inventory_available', 'is_inventory_available', ['boolean']),
  // Immediate facts: the Matrix door owns them (Mode / Qty / Buffer and the fulfilment method), never a draft.
  { key: 'fulfillment_availability__quantity', root: 'fulfillment_availability', leaf: null, lane: 'matrix', writeService: 'writeMatrixCells',
    fbaApplies: false, euShared: true, parentReason: PARENT_REASON, editHeldReason: QUANTITY_HELD_REASON, checks: [] },
  { key: 'fulfillment_availability__fulfillment_channel_code', root: 'fulfillment_availability', leaf: null, lane: 'matrix', writeService: 'setFulfillmentMethod',
    fbaApplies: true, euShared: true, parentReason: PARENT_REASON, checks: [] },
  // RRP: a saved pricing fact on its own store (channel-specs/amazon.ts `AMAZON_LISTING_STORES`), sent as its own root.
  { key: 'list_price', root: 'list_price', leaf: null, lane: 'channel', writeService: 'channelValueWrite',
    fbaApplies: true, euShared: false, parentReason: PARENT_PRICE_REASON, checks: ['price'] },
]

/**
 * Sub-attributes of these roots that are deliberately not sheet fields: selectors the builder fills itself
 * (`marketplace_id`, `currency`, `audience`) and the RRP's currency. Kept as Amazon reports them on every send.
 */
export const AMAZON_OFFER_OUT_OF_SCOPE: Readonly<Record<string, string>> = {
  purchasable_offer__marketplace_id: 'Selector — the builder names the market.',
  purchasable_offer__currency: 'Selector — the market\'s currency, filled by the builder.',
  purchasable_offer__audience: 'Selector — Nexus prices the all-buyers (ALL) offer; a business (B2B) offer is kept as Amazon reports it.',
  list_price__currency: 'Selector — the market\'s currency, filled by the writer.',
  list_price__marketplace_id: 'Selector — the writer names the market.',
}

const BY_KEY = new Map(AMAZON_OFFER_FIELDS.map((f) => [f.key, f]))
export function amazonOfferFieldFor(key: string): AmazonOfferField | null {
  return BY_KEY.get(key.replace(/^attr_/, '')) ?? null
}
/** The sheet keys of one leaf (the sale has three). */
export function amazonOfferKeysOf(leaf: AmazonOfferLeaf): string[] {
  return AMAZON_OFFER_FIELDS.filter((f) => f.leaf === leaf).map((f) => f.key)
}
export const isAmazonOfferDraftKey = (key: string): boolean => amazonOfferFieldFor(key)?.lane === 'draft'

const DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/
/** A date or date-time string Amazon's schema accepts (`format: date | date-time`). */
export const isAmazonDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(v.slice(0, 10)))
/** The calendar day of a date or date-time string. */
export const dayOf = (v: string): string => v.slice(0, 10)

/**
 * The refusal sentence for one leaf's value on its own, or null. `null` (remove on Amazon) always passes. Cross-leaf
 * rules (min ≤ max, price inside them) are `amazonSellerBoundsRefusal` in `offer-attributes.ts`.
 */
export function amazonOfferLeafRefusal(leaf: AmazonOfferLeaf, value: unknown, today: string = new Date().toISOString().slice(0, 10)): string | null {
  if (value === null) return null
  const price = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0
  switch (leaf) {
    case 'our_price': {
      const v = value as { pin?: unknown; follow?: unknown }
      if (v && v.follow === true) return null
      return v && price(v.pin) ? null : 'A price is a number of zero or more'
    }
    case 'sale': {
      const v = value as { price?: unknown; start?: unknown; end?: unknown }
      if (!v || !price(v.price)) return 'A sale price is a number of zero or more'
      if (!v.start || !v.end) return 'A sale needs a start and an end date — Amazon schedules a sale with both'
      if (!isAmazonDate(v.start) || !isAmazonDate(v.end)) return 'Sale dates are YYYY-MM-DD'
      return dayOf(v.end) < dayOf(v.start) ? 'A sale ends on or after the day it starts' : null
    }
    case 'minimum_seller_allowed_price': case 'maximum_seller_allowed_price': case 'map_price':
      return price(value) ? null : 'A price is a number of zero or more'
    case 'offer_start_at': case 'offer_end_at':
      return isAmazonDate(value) ? null : 'Dates are YYYY-MM-DD'
    case 'automated_pricing_rule_id':
      return typeof value === 'string' && value.trim() !== '' ? null : 'An Automate Pricing rule is named by its rule id'
    case 'lead_time_to_ship_max_days':
      return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 120 ? null : 'Handling time is a whole number of days, 0 to 120'
    case 'restock_date':
      if (!isAmazonDate(value)) return 'A restock date is YYYY-MM-DD'
      return dayOf(value) < today ? 'A restock date is today or later — Amazon ignores a date that has passed' : null
    case 'is_inventory_available':
      return typeof value === 'boolean' ? null : 'Always available is on or off'
  }
  return null
}

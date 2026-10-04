/**
 * Amazon sheet gaps (D4=B, D5=B, D3) — the product sheet's Amazon offer cell rule (`amazon-offer-cells.ts`): the value is
 * what Publish sends (the saved draft over live), the saved change carries the words of design-draft-and-remote §A, the
 * holds speak in the Matrix's order (parent, permission, FBA), the price shows as the Matrix's own price cell, Always
 * available and Automate Pricing carry their D5 warnings, and a Remote Fulfilment code is shown read-only (D3). Pure:
 * the loader runs against an in-memory stand-in for the database.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import { pricingRuleLabel } from '@nexus/shared/listing-price'
import { readAmazonOfferFacts, type AmazonOfferFactsListing } from '../amazon/offer-facts.js'
import { FBA_FULFILMENT_REASON } from '../amazon/offer-fields.js'
import {
  ALWAYS_AVAILABLE_WARNING, AUTOMATE_PRICING_WARNING, OFFER_DRAFT_WORDS, amazonFulfilmentMethodCell, amazonOfferCellOf, loadAmazonOfferCells,
  type AmazonOfferListingFacts, type OfferSheetCell,
} from './amazon-offer-cells.js'
import { PARENT_PRICE_REASON, PARENT_REASON, PRICE_PERMISSION_REASON, priceCellOf } from './matrix-cells.js'

const TODAY = '2026-10-02'
const SAVED = { savedAt: '2026-10-01T09:00:00.000Z', savedBy: 'sheet@test' }
const draft = (leaves: Record<string, { value: unknown; base: unknown }>) =>
  ({ amazonOfferDraft: { v: 1, leaves: Object.fromEntries(Object.entries(leaves).map(([k, e]) => [k, { ...e, ...SAVED }])) } })

/** One listing's facts for the rule, built the way the loader builds them. */
function facts(listing: AmazonOfferFactsListing & { pricingRule?: string | null; basePrice?: number | null }, over: Partial<AmazonOfferListingFacts> = {}): AmazonOfferListingFacts {
  const num = (v: unknown) => (v == null ? null : Number(v))
  return {
    facts: readAmazonOfferFacts(listing, 'publish'),
    live: readAmazonOfferFacts(listing, 'job'),
    isFba: false,
    pricingRule: listing.pricingRule ?? null,
    priceAdjustmentPercent: null,
    priceCell: priceCellOf({ price: num(listing.price), priceOverride: num(listing.priceOverride), followMasterPrice: listing.followMasterPrice ?? true,
      basePrice: listing.basePrice ?? null, currency: 'EUR', formula: null, clamped: null }),
    ...over,
  }
}
const PINNED = { marketplace: 'IT', price: 49.9, priceOverride: 49.9, followMasterPrice: false, basePrice: 40 }
const FOLLOWING = { marketplace: 'IT', price: 49.9, priceOverride: null, followMasterPrice: true, basePrice: 40 }
const cell = (key: string, listing: AmazonOfferListingFacts | null, row: { isParent?: boolean; canEditPrice?: boolean } = {}) =>
  amazonOfferCellOf({ key, listing, isParent: row.isParent ?? false, canEditPrice: row.canEditPrice ?? true, today: TODAY })

describe('the saved change and its words (§A)', () => {
  it('a price typed on a following listing: the cell shows 44.90, live 49.90, "pins at"', () => {
    const c = cell('purchasable_offer__our_price', facts({ ...FOLLOWING, platformAttributes: draft({ our_price: { value: { pin: 44.9 }, base: { follow: true } } }) }))!
    expect(c.value).toBe(44.9)
    expect(c.hold).toBeNull()
    expect(c.pendingPublish).toEqual({ value: 44.9, live: 49.9, ...SAVED, note: 'Saved — pins at 44.90 when you publish', sent: true })
    expect(c.pendingPublish!.note).toBe(OFFER_DRAFT_WORDS.pinsAt('44.90'))
  })

  it('a price typed on an already pinned listing: "Saved — sent when you publish", never "pins at"', () => {
    const c = cell('purchasable_offer__our_price', facts({ ...PINNED, platformAttributes: draft({ our_price: { value: { pin: 44.9 }, base: { pin: 49.9 } } }) }))!
    expect(c.pendingPublish).toMatchObject({ value: 44.9, live: 49.9, note: OFFER_DRAFT_WORDS.saved })
  })

  it('a reset on a pinned price: "follows {rule}" with the rule\'s own words', () => {
    const c = cell('attr_purchasable_offer__our_price', facts({ ...PINNED, platformAttributes: draft({ our_price: { value: { follow: true }, base: { pin: 49.9 } } }) }))!
    const rule = pricingRuleLabel(null, null)
    expect(c.pendingPublish!.note).toBe(`Saved — follows ${rule} when you publish`)
    expect(c.pendingPublish!.live).toBe(49.9)
  })

  it('any other leaf: "Saved — sent when you publish"; a saved removal shows none', () => {
    const l = facts({ ...PINNED, platformAttributes: { amazonOffer: { map_price: 28 }, ...draft({ map_price: { value: 30, base: 28 }, minimum_seller_allowed_price: { value: null, base: 20 } }) } })
    expect(cell('purchasable_offer__map_price', l)).toMatchObject({ value: 30, pendingPublish: { value: 30, live: 28, note: OFFER_DRAFT_WORDS.saved, sent: true } })
    expect(OFFER_DRAFT_WORDS.saved).toBe('Saved — sent when you publish')
    expect(cell('purchasable_offer__minimum_seller_allowed_price', l)).toMatchObject({ value: null, pendingPublish: { value: null, note: OFFER_DRAFT_WORDS.saved } })
  })

  it('the sale\'s three columns each show their part of the saved sale', () => {
    const sale = { price: 39.9, start: '2026-10-10', end: '2026-10-20' }
    const l = facts({ ...PINNED, platformAttributes: draft({ sale: { value: sale, base: null } }) })
    expect(cell('purchasable_offer__discounted_price__value_with_tax', l)).toMatchObject({ value: 39.9, pendingPublish: { value: 39.9, live: null, note: OFFER_DRAFT_WORDS.saved } })
    expect(cell('purchasable_offer__discounted_price__start_at', l)!.value).toBe('2026-10-10')
    expect(cell('purchasable_offer__discounted_price__end_at', l)!.value).toBe('2026-10-20')
  })

  it('D7=A — live moved after the save: the saved value still shows and goes, the sentence says so', () => {
    const c = cell('purchasable_offer__our_price', facts({ ...PINNED, price: 52, priceOverride: 52, platformAttributes: draft({ our_price: { value: { pin: 44.9 }, base: { pin: 49.9 } } }) }))!
    expect(c.value).toBe(44.9)
    expect(c.pendingPublish).toMatchObject({ value: 44.9, live: 52, liveChangedSince: { from: { pin: 49.9 }, to: { pin: 52 },
      note: 'Live changed since you saved: 49.90 → 52.00. Publish sends your saved value.' } })
    // Live unchanged since the save: no such line.
    expect(cell('purchasable_offer__our_price', facts({ ...PINNED, platformAttributes: draft({ our_price: { value: { pin: 44.9 }, base: { pin: 49.9 } } }) }))!.pendingPublish!.liveChangedSince).toBeUndefined()
  })

  it('a saved restock date that has passed is not sent; a live one that has passed is flagged', () => {
    const saved = cell('fulfillment_availability__restock_date', facts({ ...PINNED, platformAttributes: draft({ restock_date: { value: '2026-09-01', base: null } }) }))!
    expect(saved.pendingPublish).toMatchObject({ value: '2026-09-01', note: 'Restock date has passed — not sent. Change it or discard it.', sent: false })
    const live = cell('fulfillment_availability__restock_date', facts({ ...PINNED, platformAttributes: { amazonFulfillment: { restock_date: '2026-09-01' } } }))!
    expect(live).toMatchObject({ value: '2026-09-01', pendingPublish: null, offerWarning: 'Restock date has passed — not sent.' })
    expect(cell('fulfillment_availability__restock_date', facts({ ...PINNED, platformAttributes: { amazonFulfillment: { restock_date: '2026-11-01' } } }))!.offerWarning).toBeUndefined()
  })

  it('nothing saved: no pendingPublish; a key that is not an offer draft column is not this rule\'s', () => {
    expect(cell('purchasable_offer__map_price', facts(PINNED))!.pendingPublish).toBeNull()
    for (const key of ['fulfillment_availability__quantity', 'fulfillment_availability__fulfillment_channel_code', 'list_price', 'brand', 'price']) {
      expect(cell(key, facts(PINNED)), key).toBeNull()
    }
  })
})

describe('the holds, in the Matrix\'s order', () => {
  it('the parent writes nothing: the price sentence on offer leaves, the variants sentence on fulfilment leaves', () => {
    expect(cell('purchasable_offer__our_price', facts(PINNED), { isParent: true })!.hold).toBe(PARENT_PRICE_REASON)
    expect(cell('purchasable_offer__map_price', null, { isParent: true })).toEqual({ hold: PARENT_PRICE_REASON, pendingPublish: null })
    expect(cell('fulfillment_availability__lead_time_to_ship_max_days', facts(PINNED, { isFba: true }), { isParent: true })!.hold).toBe(PARENT_REASON)
  })

  it('without products.price.edit every leaf the price door writes is held; handling time is not a price', () => {
    for (const key of ['purchasable_offer__our_price', 'purchasable_offer__discounted_price__start_at', 'purchasable_offer__map_price',
      'purchasable_offer__end_at', 'purchasable_offer__automated_pricing_merchandising_rule_plan']) {
      expect(cell(key, facts(PINNED), { canEditPrice: false })!.hold, key).toBe(PRICE_PERMISSION_REASON)
    }
    expect(cell('fulfillment_availability__lead_time_to_ship_max_days', facts(PINNED), { canEditPrice: false })!.hold).toBeNull()
  })

  it('FBA holds handling time, restock date and always available (the saved value is kept); offer leaves stay editable', () => {
    const fba = facts({ ...PINNED, platformAttributes: { amazonFulfillment: { lead_time_to_ship_max_days: 2 } } }, { isFba: true })
    for (const key of ['fulfillment_availability__lead_time_to_ship_max_days', 'fulfillment_availability__restock_date', 'fulfillment_availability__is_inventory_available']) {
      expect(cell(key, fba)!.hold, key).toBe(FBA_FULFILMENT_REASON)
    }
    expect(cell('fulfillment_availability__lead_time_to_ship_max_days', fba)!.value).toBe(2)
    expect(cell('purchasable_offer__our_price', fba)!.hold).toBeNull()
    expect(cell('purchasable_offer__automated_pricing_merchandising_rule_plan', fba)!.hold).toBeNull()
  })
})

describe('the price shows as the Matrix shows it (priceCellOf)', () => {
  it('a following listing: the value and the price cell are the Matrix\'s own', () => {
    const l = facts(FOLLOWING)
    const c = cell('purchasable_offer__our_price', l)!
    expect(c.priceCell).toEqual(priceCellOf({ price: 49.9, priceOverride: null, followMasterPrice: true, basePrice: 40, currency: 'EUR', formula: null, clamped: null }))
    expect(c.priceCell).toMatchObject({ value: 49.9, source: 'master' })
    expect(c.value).toBe(c.priceCell!.value)
  })

  it('a following listing with no price of its own yet shows the Matrix\'s number, not a stale Amazon report', () => {
    const l = facts({ ...FOLLOWING, price: null, platformAttributes: { attributes: { purchasable_offer: [{ our_price: [{ schedule: [{ value_with_tax: 61 }] }] }] } } })
    const c = cell('purchasable_offer__our_price', l)!
    expect(c.value).toBe(l.priceCell!.value)
    expect(c.value).toBe(40)
  })

  it('a pinned listing: source override; a saved price shows the saved number beside the Matrix\'s live one', () => {
    const l = facts({ ...PINNED, platformAttributes: draft({ our_price: { value: { pin: 44.9 }, base: { pin: 49.9 } } }) })
    const c = cell('purchasable_offer__our_price', l)!
    expect(c.priceCell).toMatchObject({ value: 49.9, source: 'override' })
    expect(c.value).toBe(44.9)
    expect(c.pendingPublish!.live).toBe(c.priceCell!.value)
  })
})

describe('D5 warnings', () => {
  it('Always available on: Amazon ignores the quantity; off: no warning', () => {
    const on = facts({ ...PINNED, platformAttributes: { amazonFulfillment: { is_inventory_available: true } } })
    expect(cell('fulfillment_availability__is_inventory_available', on)!.offerWarning).toBe(ALWAYS_AVAILABLE_WARNING)
    expect(ALWAYS_AVAILABLE_WARNING).toBe('Always available: Amazon ignores the quantity Nexus sends and keeps the offer buyable at any stock. Use it only for made-to-order items.')
    const off = facts({ ...PINNED, platformAttributes: { amazonFulfillment: { is_inventory_available: false } } })
    expect(cell('fulfillment_availability__is_inventory_available', off)!.offerWarning).toBeUndefined()
    // A saved On waiting for Publish warns too.
    const saved = facts({ ...PINNED, platformAttributes: draft({ is_inventory_available: { value: true, base: null } }) })
    expect(cell('fulfillment_availability__is_inventory_available', saved)!.offerWarning).toBe(ALWAYS_AVAILABLE_WARNING)
  })

  it('an Automate Pricing rule: Amazon changes the price by the rule; none: no warning', () => {
    const rule = facts({ ...PINNED, platformAttributes: { amazonOffer: { automated_pricing_rule_id: 'R-123' } } })
    expect(cell('purchasable_offer__automated_pricing_merchandising_rule_plan', rule)).toMatchObject({ value: 'R-123', offerWarning: AUTOMATE_PRICING_WARNING })
    expect(AUTOMATE_PRICING_WARNING).toBe('Automate Pricing: Amazon changes this price by your Seller Central rule, inside your minimum and maximum price. Nexus still sends its own price; the rule can change it again.')
    expect(cell('purchasable_offer__automated_pricing_merchandising_rule_plan', facts(PINNED))!.offerWarning).toBeUndefined()
  })

  it('a held cell carries no warning (FBA Always available is read-only)', () => {
    const fba = facts({ ...PINNED, platformAttributes: { amazonFulfillment: { is_inventory_available: true } } }, { isFba: true })
    expect(cell('fulfillment_availability__is_inventory_available', fba)).toMatchObject({ hold: FBA_FULFILMENT_REASON })
    expect(cell('fulfillment_availability__is_inventory_available', fba)!.offerWarning).toBeUndefined()
  })
})

describe('the Fulfillment method cell (D3)', () => {
  const REMOTE = 'Remote Fulfilment (EU stock → UK) is switched on in Seller Central → Inventory → Remote Fulfilment with FBA → Marketplace Enrolment. Nexus keeps the code Amazon reports.'
  it('a Remote Fulfilment code, in either place: the real code, read-only, the programme words and the Seller Central sentence', () => {
    const reported = { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU_RAFN' }] } }
    expect(amazonFulfilmentMethodCell(reported)).toEqual({ value: 'AMAZON_EU_RAFN', label: 'Remote Fulfilment · EU stock → UK', reason: REMOTE })
    expect(amazonFulfilmentMethodCell({ fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 3 }, { fulfillment_channel_code: 'AMAZON_EU2AE_RAFN' }] }))
      .toMatchObject({ value: 'AMAZON_EU2AE_RAFN', label: 'Remote Fulfilment · EU stock → UAE' })
    expect(amazonFulfilmentMethodCell({ fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU_VCS' }] })).toMatchObject({ value: 'AMAZON_EU_VCS', label: 'FBA (VCS)',
      reason: expect.stringContaining('Nexus treats it as FBA and keeps the code Amazon reports.') })
  })

  it('FBA (AMAZON_EU) and FBM (DEFAULT) are the ordinary cell — the two choices a person has', () => {
    expect(amazonFulfilmentMethodCell({ fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] })).toBeNull()
    expect(amazonFulfilmentMethodCell({ attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT' }] } })).toBeNull()
    expect(amazonFulfilmentMethodCell({})).toBeNull()
  })
})

describe('loadAmazonOfferCells → apply (one sheet row)', () => {
  /** An in-memory stand-in for the reads the loader makes. */
  function fakeDb(rows: Array<Record<string, unknown>>, fbaStock: Array<{ productId: string; quantity: number }> = []) {
    return {
      channelListing: { findMany: async () => rows },
      stockLevel: { findMany: async () => fbaStock },
      offer: { findMany: async () => [] },
      marketplace: { findMany: async () => [{ channel: 'AMAZON', code: 'IT', currency: 'EUR' }] },
      cellFormula: { findMany: async () => [] },
      pricingSnapshot: { findMany: async () => [] },
      $queryRawUnsafe: async () => [{ n: 0 }],
      $executeRawUnsafe: async () => 0,
    } as never
  }
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id, productId: `p-${id}`, channel: 'AMAZON', marketplace: 'IT', aliasKey: '', price: 49.9, priceOverride: 49.9, followMasterPrice: false,
    pricingRule: null, priceAdjustmentPercent: null, salePrice: null, fulfillmentMethod: 'FBM', platformAttributes: {},
    product: { sku: id.toUpperCase(), basePrice: 40, isParent: false, fulfillmentMethod: null }, ...over,
  })
  const sheetCell = (value: unknown, editable = true): OfferSheetCell => ({ value, editable, writable: editable, writeBlockedReason: editable ? null : 'Not applicable to this category.' })

  it('lays the rule over the built cells: draft value, saved change, price cell; other columns untouched', async () => {
    const book = await loadAmazonOfferCells({ listingIds: ['l1'], canEditPrice: true, today: TODAY },
      fakeDb([row('l1', { platformAttributes: draft({ our_price: { value: { pin: 44.9 }, base: { pin: 49.9 } } }) })]))
    const values: Record<string, OfferSheetCell> = {
      purchasable_offer__our_price: sheetCell(49.9),
      purchasable_offer__map_price: sheetCell(null),
      brand: sheetCell('Xavia'),
      // A cell the generic rule already holds keeps its own hold when the offer rule has none.
      purchasable_offer__end_at: sheetCell(null, false),
    }
    book.apply(values, { listingId: 'l1', isParent: false })
    expect(values.purchasable_offer__our_price).toMatchObject({ value: 44.9, editable: true, pendingPublish: { value: 44.9, live: 49.9 }, priceCell: { value: 49.9, source: 'override' } })
    expect(values.purchasable_offer__map_price).toEqual(sheetCell(null))
    expect('pendingPublish' in values.purchasable_offer__map_price).toBe(false)
    expect(values.brand).toEqual(sheetCell('Xavia'))
    expect(values.purchasable_offer__end_at).toMatchObject({ editable: false, writeBlockedReason: 'Not applicable to this category.' })
  })

  it('a Remote Fulfilment listing: the Fulfillment method cell is read-only with its code; its handling time is held as FBA', async () => {
    const pa = { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU_RAFN' }] } }
    const book = await loadAmazonOfferCells({ listingIds: ['l2'], canEditPrice: true, today: TODAY }, fakeDb([row('l2', { fulfillmentMethod: null, platformAttributes: pa })]))
    const values: Record<string, OfferSheetCell> = {
      fulfillment_availability__fulfillment_channel_code: sheetCell('AMAZON_EU'),
      fulfillment_availability__lead_time_to_ship_max_days: sheetCell(null),
    }
    book.apply(values, { listingId: 'l2', isParent: false })
    expect(values.fulfillment_availability__fulfillment_channel_code).toMatchObject({ value: 'AMAZON_EU_RAFN', fulfilmentLabel: 'Remote Fulfilment · EU stock → UK',
      editable: false, writable: false, writeBlockedReason: expect.stringContaining('Seller Central → Inventory → Remote Fulfilment with FBA → Marketplace Enrolment') })
    expect(values.fulfillment_availability__lead_time_to_ship_max_days).toMatchObject({ editable: false, writable: false, writeBlockedReason: FBA_FULFILMENT_REASON })
  })

  it('FBA by stock (no code): fulfilment leaves held; an FBM listing\'s cell is the ordinary one', async () => {
    const book = await loadAmazonOfferCells({ listingIds: ['l3', 'l4'], canEditPrice: false, today: TODAY },
      fakeDb([row('l3'), row('l4', { productId: 'p-l4' })], [{ productId: 'p-l3', quantity: 5 }]))
    const fba: Record<string, OfferSheetCell> = { fulfillment_availability__restock_date: sheetCell(null), fulfillment_availability__fulfillment_channel_code: sheetCell('AMAZON_EU') }
    book.apply(fba, { listingId: 'l3', isParent: false })
    expect(fba.fulfillment_availability__restock_date.writeBlockedReason).toBe(FBA_FULFILMENT_REASON)
    expect(fba.fulfillment_availability__fulfillment_channel_code).toEqual(sheetCell('AMAZON_EU'))
    const fbm: Record<string, OfferSheetCell> = { fulfillment_availability__restock_date: sheetCell(null), purchasable_offer__our_price: sheetCell(49.9) }
    book.apply(fbm, { listingId: 'l4', isParent: false })
    expect(fbm.fulfillment_availability__restock_date).toMatchObject({ editable: true, writeBlockedReason: null })
    // canEditPrice false → the price is held with the Matrix's sentence.
    expect(fbm.purchasable_offer__our_price).toMatchObject({ editable: false, writable: false, writeBlockedReason: PRICE_PERMISSION_REASON })
  })

  it('a list column (Amazon\'s schedule) keeps its shape: the one value as a list, none as an empty list', async () => {
    const book = await loadAmazonOfferCells({ listingIds: ['l5'], canEditPrice: true, today: TODAY },
      fakeDb([row('l5', { platformAttributes: draft({ our_price: { value: { pin: 44.9 }, base: { pin: 49.9 } } }) })]))
    const values: Record<string, OfferSheetCell> = { purchasable_offer__our_price: sheetCell([49.9]), purchasable_offer__map_price: sheetCell([]) }
    book.apply(values, { listingId: 'l5', isParent: false })
    expect(values.purchasable_offer__our_price).toMatchObject({ value: [44.9], pendingPublish: { value: 44.9, live: 49.9 } })
    expect(values.purchasable_offer__map_price.value).toEqual([])
  })

  it('a sheet without an offer or Fulfillment method column reads nothing', async () => {
    const untouchable = new Proxy({}, { get: (_t, model) => { throw new Error(`read ${String(model)}`) } }) as never
    const book = await loadAmazonOfferCells({ listingIds: ['l6'], keys: ['brand', 'item_name', 'fulfillment_availability__quantity'], canEditPrice: true }, untouchable)
    expect(book.listing('l6')).toBeNull()
  })

  it('a row with no listing keeps its own value; the parent row is held', async () => {
    const book = await loadAmazonOfferCells({ listingIds: [], canEditPrice: true, today: TODAY }, fakeDb([]))
    const values: Record<string, OfferSheetCell> = { purchasable_offer__our_price: sheetCell(12) }
    book.apply(values, { listingId: null, isParent: true })
    expect(values.purchasable_offer__our_price).toMatchObject({ value: 12, editable: false, writeBlockedReason: PARENT_PRICE_REASON })
  })
})

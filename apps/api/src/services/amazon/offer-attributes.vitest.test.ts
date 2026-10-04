/**
 * Amazon sheet gaps — the ONE offer/fulfilment send builder. Every expected payload below was written before the
 * builder, from the cached IT/OUTERWEAR schema (`channel-specs/__tests__/fixtures/amazon-it-outerwear.trimmed.json`),
 * and is checked against it by `schemaShape` at the end.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  AMAZON_PRICE_OUTSIDE_SELLER_BOUNDS, amazonFulfillmentAvailability, amazonOfferMergeLeaves, amazonPurchasableOffer, amazonSellerBoundsRefusal,
} from './offer-attributes.js'
import { readAmazonOfferFacts, type AmazonOfferFacts } from './offer-facts.js'

const IT = 'APJ6JRA9NG5V4'
const here = dirname(fileURLToPath(import.meta.url))
const schema = JSON.parse(readFileSync(join(here, '../pim/channel-specs/__tests__/fixtures/amazon-it-outerwear.trimmed.json'), 'utf8'))

/** A listing with live offer facts: 49.90 pinned, sale 39.90 10–20 Oct, min 30 / max 60 / MAP 40, rule R1, lead 2. */
const liveListing = (over: Record<string, unknown> = {}) => ({
  marketplace: 'IT', price: 49.9, priceOverride: 49.9, followMasterPrice: false, salePrice: 39.9,
  saleWindow: { start: '2026-10-10', end: '2026-10-20' },
  platformAttributes: {
    amazonOffer: { minimum_seller_allowed_price: 30, maximum_seller_allowed_price: 60, map_price: 40, automated_pricing_rule_id: 'R1' },
    amazonFulfillment: { lead_time_to_ship_max_days: 2, restock_date: '2026-11-01' },
    attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 3, marketplace_id: IT }] },
  },
  ...over,
})
const facts = (over: Record<string, unknown> = {}, lane: 'job' | 'publish' = 'job'): AmazonOfferFacts => readAmazonOfferFacts(liveListing(over) as never, lane)
const TODAY = '2026-10-02'

describe('purchasable_offer — whole root from the live facts (no Amazon read)', () => {
  it('carries every live leaf: price, sale with both dates, min, max, MAP, rule', () => {
    const expected = [{
      currency: 'EUR', marketplace_id: IT,
      our_price: [{ schedule: [{ value_with_tax: 49.9 }] }],
      discounted_price: [{ schedule: [{ start_at: '2026-10-10', end_at: '2026-10-20', value_with_tax: 39.9 }] }],
      minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 30 }] }],
      maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: 60 }] }],
      map_price: [{ schedule: [{ value_with_tax: 40 }] }],
      automated_pricing_merchandising_rule_plan: [{ merchandising_rule: { rule_id: 'R1' } }],
    }]
    expect(amazonPurchasableOffer({ marketplaceId: IT, currency: 'EUR', facts: facts() })).toEqual(expected)
  })

  it('a sale without both dates is never sent', () => {
    const root = amazonPurchasableOffer({ marketplaceId: IT, currency: 'EUR', facts: facts({ saleWindow: { start: '2026-10-10', end: null } }) })!
    expect(root[0]).not.toHaveProperty('discounted_price')
  })

  it('the send price replaces the stored one (the job\'s payload price / Publish\'s send price)', () => {
    const root = amazonPurchasableOffer({ marketplaceId: IT, currency: 'EUR', facts: facts(), sendPrice: 44.9 })!
    expect(root[0].our_price).toEqual([{ schedule: [{ value_with_tax: 44.9 }] }])
  })

  it('a parent gets no offer root; an offer with no price is never built (it would clear the price)', () => {
    expect(amazonPurchasableOffer({ marketplaceId: IT, currency: 'EUR', facts: facts(), isParent: true })).toBeNull()
    expect(amazonPurchasableOffer({ marketplaceId: IT, currency: 'EUR', facts: facts({ price: null, priceOverride: null }) })).toBeNull()
  })
})

describe('purchasable_offer — whole root on top of Amazon\'s current one', () => {
  const amazonRoot = [
    { marketplace_id: IT, currency: 'EUR', audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 51 }] }],
      discounted_price: [{ schedule: [{ start_at: '2026-09-01', end_at: '2026-09-30', value_with_tax: 45 }] }],
      start_at: { value: '2023-07-10T20:20:20.225Z' }, quantity_discount_plan: [{ unmodelled: true }] },
    { marketplace_id: IT, currency: 'EUR', audience: 'B2B', our_price: [{ schedule: [{ value_with_tax: 41 }] }] },
    { marketplace_id: 'A1PA6795UKMFR9', currency: 'EUR', audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 55 }] }] },
  ]

  it('keeps the B2B instance, the other market and every unmodelled sub-attribute; Nexus-held leaves go on top', () => {
    const expected = [
      { marketplace_id: IT, currency: 'EUR', audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 49.9 }] }],
        discounted_price: [{ schedule: [{ start_at: '2026-10-10', end_at: '2026-10-20', value_with_tax: 39.9 }] }],
        start_at: { value: '2023-07-10T20:20:20.225Z' }, quantity_discount_plan: [{ unmodelled: true }],
        minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 30 }] }],
        maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: 60 }] }],
        map_price: [{ schedule: [{ value_with_tax: 40 }] }],
        automated_pricing_merchandising_rule_plan: [{ merchandising_rule: { rule_id: 'R1' } }] },
      amazonRoot[1],
      amazonRoot[2],
    ]
    expect(amazonPurchasableOffer({ marketplaceId: IT, currency: 'EUR', facts: facts(), base: amazonRoot })).toEqual(expected)
  })

  it('a leaf Nexus does not hold keeps Amazon\'s value; Nexus with no sale leaves Amazon\'s sale alone', () => {
    const root = amazonPurchasableOffer({ marketplaceId: IT, currency: 'EUR', facts: facts({ salePrice: null }), base: amazonRoot })!
    expect(root[0].discounted_price).toEqual(amazonRoot[0].discounted_price)
    expect(root[0].start_at).toEqual({ value: '2023-07-10T20:20:20.225Z' })
  })

  it('selected leaves only: everything else stays as Amazon has it; an explicit null removes the leaf', () => {
    const f = facts({ platformAttributes: { amazonOffer: { map_price: null, minimum_seller_allowed_price: 35 } } }, 'publish')
    const root = amazonPurchasableOffer({ marketplaceId: IT, currency: 'EUR', facts: f, base: [{ ...amazonRoot[0], map_price: [{ schedule: [{ value_with_tax: 40 }] }] }], leaves: ['minimum_seller_allowed_price', 'map_price'] })!
    expect(root[0]).toMatchObject({ our_price: [{ schedule: [{ value_with_tax: 51 }] }], minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 35 }] }] })
    expect(root[0]).not.toHaveProperty('map_price')
    expect(root[0].discounted_price).toEqual(amazonRoot[0].discounted_price)
  })

  it('no instance for this market yet: a new one is added beside the others', () => {
    const root = amazonPurchasableOffer({ marketplaceId: IT, currency: 'EUR', facts: facts(), base: [amazonRoot[2]] })!
    expect(root).toHaveLength(2)
    expect(root[0]).toEqual(amazonRoot[2])
    expect(root[1]).toMatchObject({ marketplace_id: IT, currency: 'EUR', our_price: [{ schedule: [{ value_with_tax: 49.9 }] }] })
  })
})

describe('publish lane — the draft goes on top of live', () => {
  it('draft price, min and a removed MAP; the job lane of the same listing sends live only', () => {
    const pa = { ...liveListing().platformAttributes as object, amazonOfferDraft: { v: 1, leaves: {
      our_price: { value: { pin: 44.9 }, base: { pin: 49.9 }, savedAt: 't', savedBy: 'u' },
      minimum_seller_allowed_price: { value: 35, base: 30, savedAt: 't', savedBy: 'u' },
      map_price: { value: null, base: 40, savedAt: 't', savedBy: 'u' },
    } } }
    const publish = amazonPurchasableOffer({ marketplaceId: IT, currency: 'EUR', facts: facts({ platformAttributes: pa }, 'publish') })!
    expect(publish[0]).toMatchObject({ our_price: [{ schedule: [{ value_with_tax: 44.9 }] }], minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 35 }] }] })
    expect(publish[0]).not.toHaveProperty('map_price')
    const job = amazonPurchasableOffer({ marketplaceId: IT, currency: 'EUR', facts: facts({ platformAttributes: pa }, 'job') })!
    expect(job[0]).toMatchObject({ our_price: [{ schedule: [{ value_with_tax: 49.9 }] }], minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 30 }] }], map_price: [{ schedule: [{ value_with_tax: 40 }] }] })
  })
})

describe('fulfillment_availability', () => {
  it('FBM: DEFAULT + the send quantity + handling time + restock date, in one entry', () => {
    const expected = [{ fulfillment_channel_code: 'DEFAULT', quantity: 7, lead_time_to_ship_max_days: 2, restock_date: '2026-11-01' }]
    expect(amazonFulfillmentAvailability({ facts: facts(), fba: false, live: true, quantity: 7, today: TODAY })).toEqual(expected)
  })

  it('on top of Amazon\'s entry: its unmodelled leaves are kept, its stray marketplace_id is not sent', () => {
    const base = [{ fulfillment_channel_code: 'DEFAULT', quantity: 3, marketplace_id: IT, is_inventory_available: false }]
    expect(amazonFulfillmentAvailability({ facts: facts(), fba: false, live: true, quantity: 7, base, today: TODAY }))
      .toEqual([{ fulfillment_channel_code: 'DEFAULT', quantity: 7, is_inventory_available: false, lead_time_to_ship_max_days: 2, restock_date: '2026-11-01' }])
  })

  it('no quantity given: Amazon\'s current quantity is kept (a whole-root replace never drops it)', () => {
    const base = [{ fulfillment_channel_code: 'DEFAULT', quantity: 3 }]
    expect(amazonFulfillmentAvailability({ facts: facts(), fba: false, live: true, base, today: TODAY })![0]).toMatchObject({ quantity: 3 })
  })

  it('a restock date that has passed is never sent', () => {
    const f = facts({ platformAttributes: { amazonFulfillment: { lead_time_to_ship_max_days: 2, restock_date: '2026-09-01' } } })
    expect(amazonFulfillmentAvailability({ facts: f, fba: false, live: true, quantity: 7, today: TODAY }))
      .toEqual([{ fulfillment_channel_code: 'DEFAULT', quantity: 7, lead_time_to_ship_max_days: 2 }])
  })

  it('always available (D5): sent when Nexus holds it', () => {
    const f = facts({ platformAttributes: { amazonFulfillment: { is_inventory_available: true } } })
    expect(amazonFulfillmentAvailability({ facts: f, fba: false, live: true, quantity: 7, today: TODAY }))
      .toEqual([{ fulfillment_channel_code: 'DEFAULT', quantity: 7, is_inventory_available: true }])
  })

  it('FBA on a LIVE listing: no fulfilment root at all; FBA on a new listing: the code alone', () => {
    expect(amazonFulfillmentAvailability({ facts: facts(), fba: true, live: true, quantity: 7, today: TODAY })).toBeNull()
    expect(amazonFulfillmentAvailability({ facts: facts(), fba: true, live: false, quantity: 7, today: TODAY })).toEqual([{ fulfillment_channel_code: 'AMAZON_EU' }])
  })

  it('an FBA code in Nexus\'s own entry, or in Amazon\'s current root, is FBA even when the caller says FBM (fail-closed)', () => {
    const f = facts({ platformAttributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } })
    expect(amazonFulfillmentAvailability({ facts: f, fba: false, live: true, quantity: 7, today: TODAY })).toBeNull()
    expect(amazonFulfillmentAvailability({ facts: f, fba: false, live: false, quantity: 7, today: TODAY })).toEqual([{ fulfillment_channel_code: 'AMAZON_EU' }])
    const plain = facts()
    expect(amazonFulfillmentAvailability({ facts: plain, fba: false, live: true, quantity: 7, today: TODAY, base: [{ fulfillment_channel_code: 'AMAZON_EU' }] })).toBeNull()
  })

  it('D9 = A: plain AMAZON_EU only in the copy Amazon\'s pull left does not make an FBM listing FBA', () => {
    const f = facts({ platformAttributes: { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } } })
    expect(f.fbaByCode).toBe(false)
    expect(amazonFulfillmentAvailability({ facts: f, fba: false, live: true, quantity: 7, today: TODAY })).toEqual([{ fulfillment_channel_code: 'DEFAULT', quantity: 7 }])
  })

  it('Remote Fulfilment / VCS: the root is never rebuilt, live or new', () => {
    for (const code of ['AMAZON_EU_RAFN', 'AMAZON_EU_VCS']) {
      const f = facts({ platformAttributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 2 }, { fulfillment_channel_code: code }] } })
      expect(amazonFulfillmentAvailability({ facts: f, fba: false, live: true, quantity: 7, today: TODAY })).toBeNull()
      expect(amazonFulfillmentAvailability({ facts: f, fba: true, live: false, quantity: 7, today: TODAY })).toBeNull()
    }
  })

  it('an unknown code: the root is omitted; an old label value counts as its code', () => {
    const unknown = facts({ platformAttributes: { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'SOMETHING_ELSE' }] } } })
    expect(amazonFulfillmentAvailability({ facts: unknown, fba: false, live: true, quantity: 7, today: TODAY })).toBeNull()
    const label = facts({ platformAttributes: { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'GESTITO DAL VENDITORE (DEFAULT)', quantity: 1 }] } } })
    expect(amazonFulfillmentAvailability({ facts: label, fba: false, live: true, quantity: 7, today: TODAY })).toEqual([{ fulfillment_channel_code: 'DEFAULT', quantity: 7 }])
  })

  it('a parent gets no fulfilment root', () => {
    expect(amazonFulfillmentAvailability({ facts: facts(), fba: false, live: true, quantity: 7, isParent: true, today: TODAY })).toBeNull()
  })
})

describe('merge instance (NEXUS_AMAZON_OFFER_MERGE)', () => {
  it('selectors + the selected leaves only; a removal is an explicit null', () => {
    const f = facts({ platformAttributes: { amazonOffer: { map_price: null, minimum_seller_allowed_price: 35 } } })
    expect(amazonOfferMergeLeaves({ marketplaceId: IT, currency: 'EUR', facts: f, leaves: ['our_price', 'minimum_seller_allowed_price', 'map_price', 'sale'] })).toEqual({
      marketplace_id: IT, currency: 'EUR', audience: 'ALL',
      our_price: [{ schedule: [{ value_with_tax: 49.9 }] }],
      minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 35 }] }],
      map_price: null,
      discounted_price: [{ schedule: [{ start_at: '2026-10-10', end_at: '2026-10-20', value_with_tax: 39.9 }] }],
    })
  })
})

describe('seller bounds — Amazon refuses a price outside its minimum and maximum', () => {
  it('inside: no refusal; below / above / a sale outside / min above max: one sentence each', () => {
    expect(amazonSellerBoundsRefusal({ price: 45, min: 30, max: 60 })).toBeNull()
    expect(amazonSellerBoundsRefusal({ price: 45, min: null, max: null })).toBeNull()
    expect(amazonSellerBoundsRefusal({ price: 18, min: 20, max: 60, sku: 'SKU-1' })).toMatch(/^SKU-1: 18\.00 is below the minimum price on Amazon \(20\.00\)/)
    expect(amazonSellerBoundsRefusal({ price: 70, min: 20, max: 60 })).toMatch(/70\.00 is above the maximum price on Amazon \(60\.00\)/)
    expect(amazonSellerBoundsRefusal({ price: 45, salePrice: 15, min: 20, max: 60 })).toMatch(/sale price 15\.00 is below the minimum price/)
    expect(amazonSellerBoundsRefusal({ price: 45, min: 70, max: 60 })).toMatch(/minimum price on Amazon \(70\.00\) is above its maximum \(60\.00\)/)
    expect(AMAZON_PRICE_OUTSIDE_SELLER_BOUNDS).toBe('AMAZON_PRICE_OUTSIDE_SELLER_BOUNDS')
  })
})

describe('every built root fits the cached schema (shape, not values)', () => {
  /** Every key the builder emits must be declared in the schema's items (additionalProperties: false). */
  const declared = (root: string) => new Set(Object.keys(schema.properties[root].items.properties))
  it('purchasable_offer and fulfillment_availability keys are all declared', () => {
    const offer = amazonPurchasableOffer({ marketplaceId: IT, currency: 'EUR', facts: facts({ platformAttributes: { amazonOffer: { start_at: '2026-10-01', end_at: '2026-12-31', minimum_seller_allowed_price: 1, maximum_seller_allowed_price: 99, map_price: 2, automated_pricing_rule_id: 'R' } } }) })!
    for (const k of Object.keys(offer[0])) expect(declared('purchasable_offer').has(k), k).toBe(true)
    const rule = schema.properties.purchasable_offer.items.properties.automated_pricing_merchandising_rule_plan.items.properties
    expect(Object.keys((offer[0].automated_pricing_merchandising_rule_plan as any)[0])).toEqual(Object.keys(rule))
    expect(Object.keys((offer[0].start_at as any))).toEqual(Object.keys(schema.properties.purchasable_offer.items.properties.start_at.properties))
    const fa = amazonFulfillmentAvailability({ facts: facts({ platformAttributes: { amazonFulfillment: { lead_time_to_ship_max_days: 3, restock_date: '2026-12-01', is_inventory_available: false } } }), fba: false, live: true, quantity: 1, today: TODAY })!
    for (const k of Object.keys(fa[0])) expect(declared('fulfillment_availability').has(k), k).toBe(true)
  })
})

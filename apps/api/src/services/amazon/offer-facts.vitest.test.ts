/**
 * Amazon sheet gaps — the ONE offer-facts reader: live store first (explicit null = cleared), then Amazon's report
 * (`attributes.<root>`, then a top-level `<root>`); the job lane never reads a draft; `overrideData` is never read.
 */
import { describe, expect, it } from 'vitest'
import { liveDraftValues, readAmazonOfferFacts } from './offer-facts.js'

const IT = 'APJ6JRA9NG5V4'
const DE = 'A1PA6795UKMFR9'
const reported = {
  purchasable_offer: [
    { marketplace_id: DE, currency: 'EUR', our_price: [{ schedule: [{ value_with_tax: 99 }] }], map_price: [{ schedule: [{ value_with_tax: 99 }] }] },
    { marketplace_id: IT, currency: 'EUR', audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 51 }] }],
      minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 25 }] }], map_price: [{ schedule: [{ value_with_tax: 45 }] }],
      start_at: { value: '2023-07-10T20:20:20.225Z' }, end_at: { value: null },
      discounted_price: [{ schedule: [{ start_at: '2024-01-13', end_at: '2024-12-30', value_with_tax: 21.99 }] }],
      automated_pricing_merchandising_rule_plan: [{ merchandising_rule: { rule_id: 'RULE-AMZ' } }] },
    { marketplace_id: IT, currency: 'EUR', audience: 'B2B', our_price: [{ schedule: [{ value_with_tax: 40 }] }], minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 1 }] }] },
  ],
  fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 4, lead_time_to_ship_max_days: 5, restock_date: '0', marketplace_id: IT }],
}
const listing = (pa: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ marketplace: 'IT', price: 49.9, priceOverride: null, followMasterPrice: true, salePrice: null, saleWindow: null, platformAttributes: pa, ...over })

describe('precedence', () => {
  it('Amazon\'s report fills what the live store does not hold — this market\'s all-buyers instance, never DE or B2B', () => {
    const f = readAmazonOfferFacts(listing({ attributes: reported }) as never, 'job')
    expect(f.marketplaceId).toBe(IT)
    expect(f.values).toMatchObject({
      our_price: { mode: 'follow', price: 49.9 }, minimum_seller_allowed_price: 25, map_price: 45, maximum_seller_allowed_price: null,
      offer_start_at: '2023-07-10T20:20:20.225Z', offer_end_at: null, automated_pricing_rule_id: 'RULE-AMZ',
      lead_time_to_ship_max_days: 5, restock_date: null, is_inventory_available: null,
    })
    expect(f.source).toMatchObject({ our_price: 'live', minimum_seller_allowed_price: 'mirror', maximum_seller_allowed_price: 'none', offer_end_at: 'none', lead_time_to_ship_max_days: 'mirror', restock_date: 'none' })
  })

  it('the live store wins over the report; an explicit null is a clear and stops the search', () => {
    const f = readAmazonOfferFacts(listing({ attributes: reported, amazonOffer: { minimum_seller_allowed_price: 30, map_price: null }, amazonFulfillment: { lead_time_to_ship_max_days: null, restock_date: '2026-11-01' } }) as never, 'job')
    expect(f.values).toMatchObject({ minimum_seller_allowed_price: 30, map_price: null, lead_time_to_ship_max_days: null, restock_date: '2026-11-01' })
    expect(f.source).toMatchObject({ minimum_seller_allowed_price: 'live', map_price: 'live', lead_time_to_ship_max_days: 'live', restock_date: 'live' })
  })

  it('a top-level copy of the root is read after the pull\'s attributes copy', () => {
    const f = readAmazonOfferFacts(listing({ fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', lead_time_to_ship_max_days: 7, is_inventory_available: true }] }) as never, 'job')
    expect(f.values).toMatchObject({ lead_time_to_ship_max_days: 7, is_inventory_available: true })
    const both = readAmazonOfferFacts(listing({ attributes: reported, fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', lead_time_to_ship_max_days: 7 }] }) as never, 'job')
    expect(both.values.lead_time_to_ship_max_days).toBe(5)
  })

  it('price: the listing\'s own number (a pin reads its override); Amazon\'s only when the listing has none', () => {
    expect(readAmazonOfferFacts(listing({}, { followMasterPrice: false, priceOverride: 44.9, price: 49.9 }) as never, 'job').values.our_price).toEqual({ mode: 'pin', price: 44.9 })
    const none = readAmazonOfferFacts(listing({ attributes: reported }, { price: null }) as never, 'job')
    expect(none.values.our_price).toEqual({ mode: 'follow', price: 51 })
    expect(none.source.our_price).toBe('mirror')
  })

  it('sale: Nexus\'s own (value + window) only — a sale Amazon reports is never read back as Nexus\'s', () => {
    expect(readAmazonOfferFacts(listing({ attributes: reported }) as never, 'job').values.sale).toBeNull()
    const own = readAmazonOfferFacts(listing({}, { salePrice: 39.9, saleWindow: { start: '2026-10-10', end: '2026-10-20' } }) as never, 'job')
    expect(own.values.sale).toEqual({ price: 39.9, start: '2026-10-10', end: '2026-10-20' })
    expect(own.source.sale).toBe('live')
  })

  it('Decimal-like price columns read as numbers', () => {
    const dec = (n: number) => ({ toNumber: () => n })
    expect(readAmazonOfferFacts(listing({}, { price: dec(12.5), salePrice: dec(10), saleWindow: { start: '2026-10-10', end: '2026-10-20' } }) as never, 'job').values)
      .toMatchObject({ our_price: { price: 12.5 }, sale: { price: 10 } })
  })

  it('codes from both places, normalised (the old label counts as DEFAULT)', () => {
    const f = readAmazonOfferFacts(listing({ fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU_RAFN' }], attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'Gestito dal venditore (default)' }] } }) as never, 'job')
    expect(f.fulfilmentCodes).toEqual(['AMAZON_EU_RAFN', 'DEFAULT'])
  })
})

describe('lanes', () => {
  const draft = { v: 1, leaves: {
    our_price: { value: { pin: 44.9 }, base: { follow: true }, savedAt: 't', savedBy: 'u' },
    minimum_seller_allowed_price: { value: 35, base: 25, savedAt: 't', savedBy: 'u' },
    map_price: { value: null, base: 45, savedAt: 't', savedBy: 'u' },
    sale: { value: { price: 39.9, start: '2026-10-10', end: '2026-10-20' }, base: null, savedAt: 't', savedBy: 'u' },
    lead_time_to_ship_max_days: { value: 3, base: 5, savedAt: 't', savedBy: 'u' },
  } }

  it('the job lane NEVER reads a draft', () => {
    const job = readAmazonOfferFacts(listing({ attributes: reported, amazonOfferDraft: draft }) as never, 'job')
    expect(job.draft).toBeNull()
    expect(job.values).toMatchObject({ our_price: { mode: 'follow', price: 49.9 }, minimum_seller_allowed_price: 25, map_price: 45, sale: null, lead_time_to_ship_max_days: 5 })
    expect(Object.values(job.source)).not.toContain('draft')
  })

  it('the publish lane lays the draft over live; a draft null removes it', () => {
    const pub = readAmazonOfferFacts(listing({ attributes: reported, amazonOfferDraft: draft }) as never, 'publish')
    expect(pub.values).toMatchObject({ our_price: { mode: 'pin', price: 44.9 }, minimum_seller_allowed_price: 35, map_price: null, sale: { price: 39.9, start: '2026-10-10', end: '2026-10-20' }, lead_time_to_ship_max_days: 3 })
    expect(pub.source).toMatchObject({ our_price: 'draft', map_price: 'draft', sale: 'draft', offer_start_at: 'mirror' })
  })

  it('a draft that sets the price back to Follow takes the rule\'s price now', () => {
    const back = { v: 1, leaves: { our_price: { value: { follow: true }, base: { pin: 44.9 }, savedAt: 't', savedBy: 'u' } } }
    const pub = readAmazonOfferFacts(listing({ amazonOfferDraft: back }, { followMasterPrice: false, priceOverride: 44.9, price: 44.9 }) as never, 'publish', { followPrice: 52 })
    expect(pub.values.our_price).toEqual({ mode: 'follow', price: 52 })
  })
})

describe('overrideData is never read', () => {
  it('values saved in the old override bag are ignored by both lanes', () => {
    const overrideData = {
      purchasable_offer__minimum_seller_allowed_price: 99, purchasable_offer__map_price: 99, purchasable_offer__our_price: 1,
      fulfillment_availability__lead_time_to_ship_max_days: 9, fulfillment_availability__restock_date: '2030-01-01',
      purchasable_offer__automated_pricing_merchandising_rule_plan: ['e2e-rule'],
    }
    for (const lane of ['job', 'publish'] as const) {
      const f = readAmazonOfferFacts({ ...listing({}), overrideData } as never, lane)
      expect(f.values).toMatchObject({ our_price: { price: 49.9 }, minimum_seller_allowed_price: null, map_price: null, lead_time_to_ship_max_days: null, restock_date: null, automated_pricing_rule_id: null })
    }
  })
})

describe('live values in the draft\'s shape', () => {
  it('a following price is {follow:true}, a pin {pin}; a sale without both dates is none', () => {
    expect(liveDraftValues(readAmazonOfferFacts(listing({}) as never, 'job')).our_price).toEqual({ follow: true })
    expect(liveDraftValues(readAmazonOfferFacts(listing({}, { followMasterPrice: false, priceOverride: 44.9 }) as never, 'job')).our_price).toEqual({ pin: 44.9 })
    expect(liveDraftValues(readAmazonOfferFacts(listing({}, { salePrice: 30, saleWindow: { start: '2026-10-10', end: null } }) as never, 'job')).sale).toBeNull()
  })
})

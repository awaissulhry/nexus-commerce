import { describe, expect, it } from 'vitest'
import { amazonBusinessElement, amazonBusinessOfferPlan, businessNormalPrice, businessSendLine, liveBusinessInstance, storedBusinessSetting } from './business-offer.js'

const IT = 'APJ6JRA9NG5V4'
const price = (v: number) => [{ schedule: [{ value_with_tax: v }] }]
const all = { marketplace_id: IT, currency: 'EUR', audience: 'ALL', our_price: price(105), discounted_price: [{ schedule: [{ value_with_tax: 94.94, start_at: '2024-06-01', end_at: '2026-06-01' }] }] }
const b2bLive = (v: number, plan?: unknown) => ({ marketplace_id: IT, currency: 'EUR', audience: 'B2B', our_price: price(v), ...(plan ? { quantity_discount_plan: plan } : {}) })
const tiers = { type: 'percent' as const, levels: [{ minQty: 2, value: 3 }, { minQty: 5, value: 5 }] }
const wanted = (v: number, t: typeof tiers | null = null) => amazonBusinessElement({ marketplaceId: IT, currency: 'EUR', price: v, tiers: t })

describe('amazonBusinessElement — the instance Nexus sends', () => {
  it('selectors, VAT-inclusive price, tiers in Amazon\'s names; no tiers = an explicit null', () => {
    expect(wanted(99.75, tiers)).toEqual({
      marketplace_id: IT, currency: 'EUR', audience: 'B2B', our_price: price(99.75),
      quantity_discount_plan: [{ schedule: [{ discount_type: 'percent', levels: [{ lower_bound: 2, value: 3 }, { lower_bound: 5, value: 5 }] }] }],
    })
    expect(wanted(99.75).quantity_discount_plan).toBeNull()
  })
})

describe('amazonBusinessOfferPlan — only the business instance of this market changes', () => {
  it('none held, one wanted → replace with THE BUILDER\'s root (Nexus\'s normal offer over Amazon\'s) plus the new one — never Amazon\'s copy as read', () => {
    const nexusNormal = { ...all, our_price: price(110) } // a price change Amazon may not show yet
    const plan = amazonBusinessOfferPlan({ wanted: wanted(99.75, tiers), live: [all], marketplaceId: IT, normalRoot: [nexusNormal] })
    expect(plan).toEqual({ kind: 'replace', value: [nexusNormal, wanted(99.75, tiers)] })
  })
  it('a first offer with no tiers leaves the plan key out of the replace', () => {
    const plan = amazonBusinessOfferPlan({ wanted: wanted(99.75), live: [all], marketplaceId: IT, normalRoot: [all] })
    expect(plan.kind).toBe('replace')
    expect((plan as { value: Record<string, unknown>[] }).value[1]).not.toHaveProperty('quantity_discount_plan')
  })
  it('a first offer: the builder made no root (no price) → refused, nothing sent', () => {
    expect(amazonBusinessOfferPlan({ wanted: wanted(99.75), live: [all], marketplaceId: IT, normalRoot: null }).kind).toBe('refused')
  })
  it('held and different → merge naming only the business instance; the normal offer is never in it', () => {
    const plan = amazonBusinessOfferPlan({ wanted: wanted(99.75, tiers), live: [all, b2bLive(32.95)], marketplaceId: IT, normalRoot: [all] })
    expect(plan).toEqual({ kind: 'merge', value: [wanted(99.75, tiers)] })
  })
  it('held with a plan, wanted without → merge with quantity_discount_plan null (Amazon\'s documented delete)', () => {
    const livePlan = [{ schedule: [{ discount_type: 'percent', levels: [{ lower_bound: 2, value: 3 }] }] }]
    const plan = amazonBusinessOfferPlan({ wanted: wanted(32.95), live: [all, b2bLive(32.95, livePlan)], marketplaceId: IT, normalRoot: [all] })
    expect(plan).toEqual({ kind: 'merge', value: [{ ...wanted(32.95), quantity_discount_plan: null }] })
  })
  it('held and equal (price and plan) → nothing to send', () => {
    const livePlan = [{ schedule: [{ discount_type: 'percent', levels: [{ lower_bound: 2, value: 3 }, { lower_bound: 5, value: 5 }] }] }]
    expect(amazonBusinessOfferPlan({ wanted: wanted(99.75, tiers), live: [all, b2bLive(99.75, livePlan)], marketplaceId: IT, normalRoot: [all] })).toEqual({ kind: 'none' })
    expect(amazonBusinessOfferPlan({ wanted: wanted(32.95), live: [all, b2bLive(32.95)], marketplaceId: IT, normalRoot: [all] })).toEqual({ kind: 'none' })
  })
  it('none wanted: a held business offer is deleted by its selectors; none held → nothing', () => {
    expect(amazonBusinessOfferPlan({ wanted: null, live: [all, b2bLive(32.95)], marketplaceId: IT, normalRoot: [all] })).toEqual({ kind: 'delete', value: [{ marketplace_id: IT, currency: 'EUR', audience: 'B2B' }] })
    expect(amazonBusinessOfferPlan({ wanted: null, live: [all], marketplaceId: IT, normalRoot: [all] })).toEqual({ kind: 'none' })
  })
  it('refuses: no normal offer in this market; a business offer held in another currency', () => {
    expect(amazonBusinessOfferPlan({ wanted: wanted(99.75), live: [], marketplaceId: IT, normalRoot: null }).kind).toBe('refused')
    expect(amazonBusinessOfferPlan({ wanted: wanted(99.75), live: [{ ...all, marketplace_id: 'A1PA6795UKMFR9' }], marketplaceId: IT, normalRoot: [{ ...all, marketplace_id: 'A1PA6795UKMFR9' }] }).kind).toBe('refused')
    expect(amazonBusinessOfferPlan({ wanted: wanted(99.75), live: [all, { ...b2bLive(32.95), currency: 'GBP' }], marketplaceId: IT, normalRoot: [all] }).kind).toBe('refused')
  })
  it('a first offer is refused when Amazon holds the normal offer in another currency (never a second normal offer)', () => {
    expect(amazonBusinessOfferPlan({ wanted: wanted(99.75), live: [{ ...all, currency: 'GBP' }], marketplaceId: IT, normalRoot: [{ ...all, currency: 'GBP' }] }).kind).toBe('refused')
  })
  it('another market\'s business offer is not this market\'s; one with no marketplace_id is (a single-market answer)', () => {
    expect(liveBusinessInstance([{ ...b2bLive(32.95), marketplace_id: 'A1PA6795UKMFR9' }], IT)).toBeNull()
    const { marketplace_id: _m, ...noMarket } = b2bLive(32.95)
    expect(liveBusinessInstance([noMarket], IT)).toEqual(noMarket)
  })
  it('a business offer Amazon holds with no currency is not removed blind', () => {
    const { currency: _c, ...noCurrency } = b2bLive(32.95)
    expect(amazonBusinessOfferPlan({ wanted: null, live: [all, noCurrency], marketplaceId: IT, normalRoot: [all] }).kind).toBe('refused')
  })
})

describe('storedBusinessSetting and the send line', () => {
  it('reads the columns (Decimal strings too); no rule → none', () => {
    expect(storedBusinessSetting({ businessPriceRule: 'PERCENT_OFF', businessPricePercent: '5.00', businessPrice: null, businessTiers: tiers }))
      .toEqual({ rule: 'PERCENT_OFF', percent: 5, price: null, tiers })
    expect(storedBusinessSetting({ businessPriceRule: 'FIXED', businessPricePercent: null, businessPrice: '32.95', businessTiers: null }))
      .toEqual({ rule: 'FIXED', percent: null, price: 32.95, tiers: null })
    expect(storedBusinessSetting({ businessPriceRule: null })).toBeNull()
  })
  it('says the price and each tier', () => {
    expect(businessSendLine(99.75, tiers, 'EUR')).toBe('EUR 99.75 · 2+ 96.76, 5+ 94.76')
    expect(businessSendLine(32.95, null, 'EUR')).toBe('EUR 32.95')
  })
})

describe('businessNormalPrice — the one normal price a business price follows (the number the push sends)', () => {
  const l = (over: Record<string, unknown>) => ({ followMasterPrice: false, priceOverride: null, price: null, pricingRule: null, priceAdjustmentPercent: null, ...over }) as never
  it('pinned: its own price; following: the master by its rule, even with an empty price column', () => {
    expect(businessNormalPrice(l({ priceOverride: 99 }), 105, { masterPrice: 120, marketCurrency: 'EUR' })).toBe(99)
    expect(businessNormalPrice(l({ followMasterPrice: true }), null, { masterPrice: 39.95, marketCurrency: 'EUR' })).toBe(39.95)
  })
  it('nothing the push could send: Amazon\'s mirrored price, else none', () => {
    expect(businessNormalPrice(l({ followMasterPrice: true }), 41, { masterPrice: null, marketCurrency: 'EUR' })).toBe(41)
    expect(businessNormalPrice(l({ followMasterPrice: true }), null, { masterPrice: null, marketCurrency: 'EUR' })).toBeNull()
  })
})

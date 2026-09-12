import { describe, expect, it } from 'vitest'

import { adsHeadline, adsQuery, money, readAds, readEfficiency } from './readAds'
import {
  joinPriceRows, readAvailable, readDaysOfInventory, readPrices, readSales, readStockoutRisk,
  readTrend, sparklinePath,
} from './readAnalytics'
import type { AnalyticsPayload, ProductAdsPayload } from './types'

const analytics = (over: Partial<AnalyticsPayload['sales']> = {}, days = 30): AnalyticsPayload => ({
  productId: 'p1', sku: 'GALE-JACKET', days,
  sales: {
    totalUnits: 0, totalRevenue: 0, totalOrders: 0, avgDailyUnits: 0, stockoutDays: 0,
    byChannel: [], ...over,
  },
  inventory: { totalAvailable: 0, daysOfInventory: null, stockoutRisk: 'UNKNOWN' },
  pricing: { currentPrices: [], latestBuyBoxPrices: [], latestRepricingDecision: null },
  quality: { latestScore: null, latestScoreAt: null, byChannel: [] },
  reviews: { avgRating: null, reviewCount: 0, recentSpikeCount: 0 },
})

describe('readSales — the parent that reads zero while the family sells', () => {
  it('refuses to report 0 units for a parent with no rows of its own', () => {
    const r = readSales(analytics({}, 90), { isParent: true, variantCount: 20 })
    expect(r.kind).toBe('parentHasNoRows')
    if (r.kind !== 'parentHasNoRows') throw new Error('unreachable')
    expect(r.note).toMatch(/20 variants hold the figures/)
    expect(r.note).toMatch(/Nothing here is a measurement of zero/)
  })

  it('says absence, not zero, for a childless product with no rows', () => {
    const r = readSales(analytics(), { isParent: false })
    expect(r.kind).toBe('noData')
    if (r.kind !== 'noData') throw new Error('unreachable')
    expect(r.note).toMatch(/absence of data, which is not the same as no sales/)
  })

  it('reports the totals when channel rows actually exist', () => {
    const r = readSales(analytics({
      totalUnits: 24, totalRevenue: 2439.2, totalOrders: 24, avgDailyUnits: 0.8,
      byChannel: [{ channel: 'AMAZON', marketplace: 'IT', units: 24, revenue: 2439.2, orders: 24 }],
    }), { isParent: false })
    expect(r).toMatchObject({ kind: 'measured', units: 24, orders: 24 })
  })

  it('🔴 keeps a measured 0 stockout days, and refuses an absent one', () => {
    const withZero = readSales(analytics({
      totalUnits: 1, stockoutDays: 0,
      byChannel: [{ channel: 'AMAZON', marketplace: 'IT', units: 1, revenue: 1, orders: 1 }],
    }), { isParent: false })
    expect(withZero).toMatchObject({ kind: 'measured', stockoutDays: 0 })

    // The server not sending it is not a clean bill of health.
    const absent = readSales(analytics({
      totalUnits: 1, stockoutDays: undefined as unknown as number,
      byChannel: [{ channel: 'AMAZON', marketplace: 'IT', units: 1, revenue: 1, orders: 1 }],
    }), { isParent: false })
    expect(absent).toMatchObject({ kind: 'measured', stockoutDays: null })
  })

  it('a parent WITH rows is measured like anything else', () => {
    const r = readSales(analytics({
      totalUnits: 5,
      byChannel: [{ channel: 'AMAZON', marketplace: 'IT', units: 5, revenue: 10, orders: 5 }],
    }), { isParent: true, variantCount: 20 })
    expect(r.kind).toBe('measured')
  })

  it('omits the count gracefully when the variant count is unknown', () => {
    const r = readSales(analytics(), { isParent: true })
    if (r.kind !== 'parentHasNoRows') throw new Error('unreachable')
    expect(r.note).toMatch(/Its variants hold the figures/)
    expect(r.note).not.toMatch(/null|undefined/)
  })
})

describe('readAvailable — a measured zero is not an absent one', () => {
  it('🔴 shows a real 0, because out of stock is the most actionable number on the page', () => {
    expect(readAvailable(0)).toEqual({ text: '0', known: true })
  })

  it('🔴 never renders an ABSENT value as 0 — that reports out-of-stock when we know least', () => {
    for (const absent of [null, undefined]) {
      expect(readAvailable(absent)).toEqual({ text: 'Not known', known: false })
    }
  })

  it('rejects a non-finite number rather than printing NaN', () => {
    expect(readAvailable(NaN).known).toBe(false)
    expect(readAvailable(Infinity).known).toBe(false)
  })

  it('passes a real count through', () => {
    expect(readAvailable(13)).toEqual({ text: '13', known: true })
  })
})

describe('readDaysOfInventory / readStockoutRisk', () => {
  it('null cover is not calculable, never zero days', () => {
    expect(readDaysOfInventory(null)).toEqual({ text: 'Not calculable', known: false })
    expect(readDaysOfInventory(0)).toEqual({ text: '0 days', known: true })
  })

  it('UNKNOWN risk never reads as LOW', () => {
    expect(readStockoutRisk('UNKNOWN')).toEqual({ label: 'Not known', tone: 'neutral' })
    expect(readStockoutRisk('LOW')).toEqual({ label: 'Low', tone: 'success' })
    expect(readStockoutRisk('')).toMatchObject({ label: 'Not known' })
    expect(readStockoutRisk('something-new')).toMatchObject({ label: 'Not known' })
  })
})

describe('readPrices', () => {
  it('keeps a zero price visible as a real reading', () => {
    const [row] = readPrices([{ channel: 'AMAZON', marketplace: 'DE', price: 0 }])
    expect(row).toMatchObject({ text: '0.00', known: true })
  })

  it('reports a null price as not set', () => {
    const [row] = readPrices([{ channel: 'AMAZON', marketplace: 'DE', buyBoxPrice: null }])
    expect(row).toMatchObject({ text: 'Not set', known: false })
  })
})

describe('readTrend / sparklinePath', () => {
  const pts = (...units: number[]) => units.map((u, i) => ({ date: `d${i}`, units: u, revenue: u * 2 }))

  it('one point is not a trend', () => {
    expect(readTrend(pts(5)).empty).toBe(true)
    expect(readTrend([]).empty).toBe(true)
    expect(readTrend(pts(1, 2)).empty).toBe(false)
  })

  it('drops non-finite readings rather than drawing through them', () => {
    const r = readTrend([...pts(1, 2), { date: 'x', units: NaN, revenue: 0 }])
    expect(r.points).toHaveLength(2)
  })

  it('draws an all-zero series along the bottom, not through the middle', () => {
    const path = sparklinePath(pts(0, 0, 0), 100, 20)
    // Every y must be the full height — a mid-height flat line would imply activity.
    expect(path).toBe('M0.00,20.00 L50.00,20.00 L100.00,20.00')
  })

  it('scales to the maximum and spans the full width', () => {
    const path = sparklinePath(pts(0, 10), 100, 20)
    expect(path).toBe('M0.00,20.00 L100.00,0.00')
  })

  it('draws nothing from fewer than two points', () => {
    expect(sparklinePath(pts(5), 100, 20)).toBe('')
  })
})

describe('readEfficiency — ACOS null is not 0%', () => {
  it('spend with no sales is named, not shown as a percentage', () => {
    const r = readEfficiency({ spendCents: 759, adSalesCents: 0, acos: null })
    expect(r).toEqual({ kind: 'spentNoSales', label: 'No sales' })
  })

  it('never renders 0% for a campaign that returned nothing', () => {
    expect(readEfficiency({ spendCents: 759, adSalesCents: 0, acos: null }).label).not.toMatch(/0/)
  })

  it('no spend is its own state', () => {
    expect(readEfficiency({ spendCents: 0, adSalesCents: 0, acos: null }).kind).toBe('noSpend')
  })

  it('a real ACOS is a percentage', () => {
    expect(readEfficiency({ spendCents: 100, adSalesCents: 400, acos: 25 }))
      .toEqual({ kind: 'acos', percent: 25, label: '25.0%' })
  })
})

describe('adsQuery — the ASIN is the one that matches', () => {
  it('carries every identifier the product has', () => {
    const q = adsQuery({ productId: 'p1', sku: 'GALE-JACKET', asin: 'B0BMSH19GY', windowDays: 7 })
    expect(q).toContain('productId=p1')
    expect(q).toContain('sku=GALE-JACKET')
    expect(q).toContain('asin=B0BMSH19GY')
  })

  it('omits the ones it does not have rather than sending empty strings', () => {
    const q = adsQuery({ productId: 'p1', sku: null, asin: null, windowDays: 30 })
    expect(q).not.toContain('sku=')
    expect(q).not.toContain('asin=')
  })
})

describe('readAds / adsHeadline', () => {
  const payload = (over: Partial<ProductAdsPayload> = {}): ProductAdsPayload => ({
    windowDays: 7, productAds: 103,
    campaigns: [
      { id: 'a', externalCampaignId: '1', name: 'Gale FR', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'FR', status: 'PAUSED', impressions: 0, clicks: 0, orders: 0, spendCents: 0, adSalesCents: 0, currencyCode: 'EUR', acos: null },
      { id: 'b', externalCampaignId: '2', name: 'Gale DE', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'DE', status: 'ENABLED', impressions: 4613, clicks: 16, orders: 0, spendCents: 759, adSalesCents: 0, currencyCode: 'EUR', acos: null },
      { id: 'c', externalCampaignId: '3', name: 'Gale IT', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', status: 'ENABLED', impressions: 900, clicks: 9, orders: 2, spendCents: 300, adSalesCents: 1200, currencyCode: 'EUR', acos: 25 },
    ],
    searchTerms: [],
    summary: { campaignCount: 74, productAdCount: 103, totalSpendCents: 15144, totalAdSalesCents: 49437, acos: 30.6, sbCreatives: 0, multiProductCreatives: 103, windowDays: 7 },
    ...over,
  })

  it('counts campaigns that spent and returned nothing', () => {
    expect(readAds(payload()).spendingNothingBack).toBe(1)
  })

  it('counts campaigns with no impressions, whatever their status says', () => {
    expect(readAds(payload()).silent).toBe(1)
  })

  it('leads with money that returned nothing, not with the campaign count', () => {
    const h = adsHeadline(readAds(payload()))
    expect(h).toMatch(/151\.44 EUR spent over 7 days/)
    expect(h).toMatch(/1 campaign returned nothing/)
    expect(h).toMatch(/1 had no impressions at all/)
  })

  it('says plainly when a childless product has no ads', () => {
    expect(adsHeadline(readAds(payload({ productAds: 0 })), { isParent: false }))
      .toBe('No ads are running against this product.')
    expect(adsHeadline(readAds(null))).toBe('No ads are running against this product.')
  })

  it('🔴 never tells a parent that nothing is advertised — its variants hold the campaigns', () => {
    // Measured: the parent returns 0 ads for every identifier it has, while every child sampled
    // returns 93–107. "No ads are running" is true of the row and false about the family.
    const h = adsHeadline(readAds(payload({ productAds: 0 })), { isParent: true })
    expect(h).toMatch(/recorded against each variant/)
    expect(h).toMatch(/not a statement that nothing is being advertised/)
    expect(h).not.toMatch(/^No ads are running/)
  })

  it('a parent that DOES have ad rows is summarised normally', () => {
    expect(adsHeadline(readAds(payload()), { isParent: true })).toMatch(/spent over 7 days/)
  })

  it('money comes from integer cents', () => {
    expect(money(15144, 'EUR')).toBe('151.44 EUR')
    expect(money(0, null)).toBe('0.00')
  })
})

describe('joinPriceRows — joined on the coordinate, never on array position', () => {
  const cur = (channel: string, marketplace: string | null, price: number | null) =>
    ({ channel, marketplace, price })
  const bb = (channel: string, marketplace: string | null, buyBoxPrice: number | null) =>
    ({ channel, marketplace, buyBoxPrice })

  it('🔴 a missing buy-box row does not shift every row below it under the wrong label', () => {
    // `currentPrices` is one entry per LISTING ROW; `latestBuyBoxPrices` one per DISTINCT
    // COORDINATE. They are parallel only by luck. Here DE has no buy-box observation.
    const rows = joinPriceRows(
      [cur('AMAZON', 'DE', 99), cur('AMAZON', 'IT', 105), cur('AMAZON', 'ES', 110)],
      [bb('AMAZON', 'IT', 101), bb('AMAZON', 'ES', 108)],
    )
    expect(rows.map((r) => [r.marketplace, r.price, r.buyBox])).toEqual([
      ['DE', '99.00', 'No observation'],   // its own absence, NOT IT's 101
      ['IT', '105.00', '101.00'],
      ['ES', '110.00', '108.00'],
    ])
  })

  it('an index join would have produced exactly the wrong answer — guarding the shape', () => {
    const rows = joinPriceRows(
      [cur('AMAZON', 'DE', 99), cur('AMAZON', 'IT', 105)],
      [bb('AMAZON', 'IT', 101)],
    )
    // Position 0 of the buy-box array is IT's. Pairing by index would put 101 on the DE row.
    expect(rows[0].buyBox).not.toBe('101.00')
    expect(rows[0].buyBox).toBe('No observation')
  })

  it('🔴 fans out one-to-many: two listings on one coordinate both get that coordinate price', () => {
    // BE.1: two aliases on one coordinate emit two `currentPrices` entries. The buy box belongs to
    // the coordinate, so both rows show it — and the row AFTER the duplicate reads its OWN price.
    const rows = joinPriceRows(
      [cur('AMAZON', 'IT', 105), cur('AMAZON', 'IT', 99), cur('AMAZON', 'ES', 110)],
      [bb('AMAZON', 'IT', 101), bb('AMAZON', 'ES', 108)],
    )
    expect(rows.map((r) => [r.marketplace, r.price, r.buyBox])).toEqual([
      ['IT', '105.00', '101.00'],
      ['IT', '99.00', '101.00'],
      ['ES', '110.00', '108.00'],   // ← its own, not shifted by the duplicate above
    ])
  })

  it('gives duplicate coordinates distinct identities, so a future getRowId cannot merge them', () => {
    const rows = joinPriceRows(
      [cur('AMAZON', 'IT', 105), cur('AMAZON', 'IT', 99)],
      [bb('AMAZON', 'IT', 101)],
    )
    expect(new Set(rows.map((r) => r.key)).size).toBe(2)
  })

  it('reports a null price as not set without borrowing a neighbour', () => {
    const rows = joinPriceRows([cur('AMAZON', 'DE', null)], [bb('AMAZON', 'IT', 101)])
    // The two absences read differently on purpose: an unset PRICE is the seller's doing, an
    // absent BUY BOX is a reading we never took.
    expect(rows[0]).toMatchObject({
      price: 'Not set', priceKnown: false, buyBox: 'No observation', buyBoxKnown: false,
    })
  })

  it('handles empty sides without inventing rows', () => {
    expect(joinPriceRows([], [bb('AMAZON', 'IT', 101)])).toEqual([])
    expect(joinPriceRows([cur('AMAZON', 'IT', 105)], [])[0].buyBox).toBe('No observation')
  })
})

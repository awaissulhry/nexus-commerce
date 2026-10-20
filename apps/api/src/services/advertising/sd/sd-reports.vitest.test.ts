/**
 * SD reports below the campaign (2026-10-20) — what Nexus asks Amazon for, and how one row of each SD report becomes a
 * stored row. The rows are shaped as Amazon's v3 SD reports send them (GZIP_JSON, one object per entity and day); every
 * id is made up.
 */
import { describe, expect, it } from 'vitest'
import { SD_ENTITY_OF, SD_REPORTS, sdDailyRowOf, sdPurchasedRowOf } from './sd-reports.js'

const metrics = {
  impressions: 12000, impressionsViews: 8400, clicks: 31, cost: 18.62,
  sales: 210.5, salesClicks: 140.25, purchases: 5, purchasesClicks: 3, unitsSold: 6, unitsSoldClicks: 4,
  detailPageViews: 90, detailPageViewsClicks: 40,
  newToBrandPurchases: 2, newToBrandPurchasesClicks: 1, newToBrandSales: 80.1, newToBrandSalesClicks: 40.05,
  newToBrandUnitsSold: 2, newToBrandUnitsSoldClicks: 1,
}

describe('the four SD reports Nexus asks for', () => {
  it('each report, its group-by and its columns (the attributed figures with their after-a-click twins)', () => {
    expect(SD_REPORTS.map((s) => [s.reportTypeId, s.groupBy])).toEqual([
      ['sdAdGroup', ['adGroup']],
      ['sdTargeting', ['targeting']],
      ['sdAdvertisedProduct', ['advertiser']],
      ['sdPurchasedProduct', ['asin']],
    ])
    for (const spec of SD_REPORTS.slice(0, 3)) {
      for (const column of ['date', 'campaignId', 'adGroupId', ...Object.keys(metrics)]) expect(spec.columns, `${spec.reportTypeId} ${column}`).toContain(column)
      // `viewableImpressions` is Sponsored Brands' name: an SD report refuses it (impressionsViews is SD's).
      expect(spec.columns).not.toContain('viewableImpressions')
    }
    expect(SD_REPORTS[1].columns).toEqual(expect.arrayContaining(['targetingId', 'targetingExpression', 'targetingText', 'adKeywordStatus']))
    expect(SD_REPORTS[2].columns).toEqual(expect.arrayContaining(['adId', 'promotedAsin', 'promotedSku']))
    expect(SD_REPORTS[3].columns).toEqual([
      'date', 'campaignId', 'adGroupId', 'promotedAsin', 'promotedSku', 'asinBrandHalo',
      'salesBrandHalo', 'salesBrandHaloClicks', 'conversionsBrandHalo', 'conversionsBrandHaloClicks', 'unitsSoldBrandHalo', 'unitsSoldBrandHaloClicks',
    ])
    // No column is asked twice (Amazon refuses a duplicate as it refuses an unknown one).
    for (const spec of SD_REPORTS) expect(new Set(spec.columns).size).toBe(spec.columns.length)
    expect(SD_ENTITY_OF).toEqual({ sdAdGroup: 'AD_GROUP', sdTargeting: 'AD_TARGET', sdAdvertisedProduct: 'PRODUCT_AD' })
  })
})

describe('one report row → one stored row', () => {
  const figures = {
    impressions: 12000, viewableImpressions: 8400, clicks: 31, costMicros: 18_620_000n,
    sales14dCents: 21050, salesClicks14dCents: 14025, orders14d: 5, ordersClicks14d: 3, units14d: 6, unitsClicks14d: 4,
    detailPageViews14d: 90, detailPageViewsClicks14d: 40,
    ntbOrders14d: 2, ntbOrdersClicks14d: 1, ntbSalesCents14d: 8010, ntbSalesClicksCents14d: 4005, ntbUnits14d: 2, ntbUnitsClicks14d: 1,
  }

  it('sdAdGroup: keyed by the ad group, named as Amazon sent it', () => {
    expect(sdDailyRowOf('sdAdGroup', { date: '2026-10-01', campaignId: 900000000000001, adGroupId: 900000000000011, adGroupName: 'Display group', ...metrics })).toEqual({
      date: new Date('2026-10-01T00:00:00.000Z'), entityType: 'AD_GROUP', entityId: '900000000000011', campaignId: '900000000000001', adGroupId: '900000000000011',
      entityName: 'Display group', targetingExpression: null, entityStatus: null, promotedAsin: null, promotedSku: null, ...figures,
    })
  })

  it('sdTargeting: keyed by the targeting id, with its text, expression and state', () => {
    const row = sdDailyRowOf('sdTargeting', {
      date: '2026-10-01', campaignId: '900000000000001', adGroupId: '900000000000011', targetingId: 900000000000021,
      targetingExpression: 'asinSameAs=B0FXTEST01', targetingText: 'asin="B0FXTEST01"', adKeywordStatus: 'ENABLED', ...metrics,
    })
    expect(row).toMatchObject({ entityType: 'AD_TARGET', entityId: '900000000000021', entityName: 'asin="B0FXTEST01"', targetingExpression: 'asinSameAs=B0FXTEST01', entityStatus: 'ENABLED', ...figures })
  })

  it('sdAdvertisedProduct: keyed by the ad id, with the advertised ASIN and SKU', () => {
    const row = sdDailyRowOf('sdAdvertisedProduct', { date: '2026-10-01', campaignId: 1, adGroupId: 11, adId: 900000000000031, promotedAsin: 'B0FXTEST01', promotedSku: 'SKU-TEST-1', ...metrics })
    expect(row).toMatchObject({ entityType: 'PRODUCT_AD', entityId: '900000000000031', promotedAsin: 'B0FXTEST01', promotedSku: 'SKU-TEST-1', entityName: null })
  })

  it('a figure Amazon did not send stays null; a zero Amazon sent stays 0', () => {
    const row = sdDailyRowOf('sdAdGroup', { date: '2026-10-02', campaignId: 1, adGroupId: 11, impressions: 0, clicks: 0, cost: 0, sales: 0, purchases: 0 })
    expect(row).toMatchObject({ impressions: 0, clicks: 0, costMicros: 0n, sales14dCents: 0, orders14d: 0, salesClicks14dCents: null, viewableImpressions: null, ntbOrders14d: null })
  })

  it('a row with no day, campaign or entity id cannot be keyed: not stored', () => {
    expect(sdDailyRowOf('sdTargeting', { date: '2026-10-01', campaignId: 1, adGroupId: 11, ...metrics })).toBeNull()
    expect(sdDailyRowOf('sdAdGroup', { campaignId: 1, adGroupId: 11 })).toBeNull()
    expect(sdDailyRowOf('sdAdGroup', { date: 'not a day', campaignId: 1, adGroupId: 11 })).toBeNull()
    expect(sdDailyRowOf('sdAdGroup', { date: '2026-10-01', adGroupId: 11 })).toBeNull()
    expect(sdDailyRowOf('spTargeting', { date: '2026-10-01', campaignId: 1, keywordId: 5 })).toBeNull()
  })

  it('sdPurchasedProduct: the advertised product, the other product bought, after a click or a view and after a click', () => {
    expect(sdPurchasedRowOf({
      date: '2026-10-01', campaignId: 900000000000001, adGroupId: 900000000000011, promotedAsin: 'B0FXTEST01', promotedSku: 'SKU-TEST-1',
      asinBrandHalo: 'B0FXTEST02', salesBrandHalo: 59.9, salesBrandHaloClicks: 29.95, conversionsBrandHalo: 2, conversionsBrandHaloClicks: 1,
      unitsSoldBrandHalo: 2, unitsSoldBrandHaloClicks: 1,
    })).toEqual({
      date: new Date('2026-10-01T00:00:00.000Z'), campaignId: '900000000000001', adGroupId: '900000000000011', promotedAsin: 'B0FXTEST01', promotedSku: 'SKU-TEST-1',
      purchasedAsin: 'B0FXTEST02', sales14dCents: 5990, salesClicks14dCents: 2995, orders14d: 2, ordersClicks14d: 1, units14d: 2, unitsClicks14d: 1,
    })
    // A cpc campaign: Amazon counts after a click only, the click-or-view totals are not sent.
    expect(sdPurchasedRowOf({ date: '2026-10-01', campaignId: 1, adGroupId: 11, promotedAsin: 'B0FXTEST01', asinBrandHalo: 'B0FXTEST02', salesBrandHaloClicks: 10, conversionsBrandHaloClicks: 1 }))
      .toMatchObject({ promotedSku: null, sales14dCents: null, orders14d: null, salesClicks14dCents: 1000, ordersClicks14d: 1 })
    expect(sdPurchasedRowOf({ date: '2026-10-01', campaignId: 1, adGroupId: 11, promotedAsin: 'B0FXTEST01' })).toBeNull()
  })
})

/**
 * Google Ads programme 2, G1 (2026-10-15) — live numbers: the window (account days, today allowed, never after it, at
 * most 1,095 days back), the query (ids checked before anything is sent, every filtered field selected, hour only where
 * Google has it, a LIMIT, product titles never with impression share), and how Google's rows read (micros → cents,
 * currency units → cents, fractions → percent, splits, ids the change tools take, names of places and products).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rows: vi.fn() }))
vi.mock('./write-client.js', () => ({ liveRows: h.rows }))

import {
  geoNamesQuery, liveNumbers, NUMBER_LEVEL_SPECS, NUMBER_LEVELS, numbersQuery, numbersRowOf, numbersTotals, numbersWindow, productTitlesQuery,
} from './live-numbers.js'

const target = { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }
const window = { from: '2026-10-01', to: '2026-10-15' }
const selectOf = (q: string) => q.slice('SELECT '.length, q.indexOf(' FROM ')).split(', ')
const whereOf = (q: string) => q.slice(q.indexOf(' WHERE ') + 7, q.indexOf(' ORDER BY '))

describe('the window', () => {
  // 2026-10-15 22:30 UTC is already 2026-10-16 in Rome (UTC+2): the account's today, not the server's.
  const now = new Date('2026-10-15T22:30:00Z')

  it('defaults to the account\'s today, in its time zone', () => {
    expect(numbersWindow('Europe/Rome', {}, now)).toEqual({ from: '2026-10-16', to: '2026-10-16', today: '2026-10-16', includesToday: true })
    expect(numbersWindow('America/Los_Angeles', { from: '2026-10-01' }, now)).toEqual({ from: '2026-10-01', to: '2026-10-15', today: '2026-10-15', includesToday: true })
    expect(numbersWindow('Europe/Rome', { from: '2026-10-01', to: '2026-10-07' }, now)).toMatchObject({ includesToday: false })
  })

  it('refuses a day after today, a window that ends before it starts, a non-day, and more than 1,095 days back', () => {
    expect(numbersWindow('Europe/Rome', { to: '2026-10-17' }, now)).toEqual({ refusal: expect.stringMatching(/after the account's today \(2026-10-16/) })
    expect(numbersWindow('Europe/Rome', { from: '2026-10-10', to: '2026-10-01' }, now)).toEqual({ refusal: expect.stringMatching(/ends before it starts/) })
    expect(numbersWindow('Europe/Rome', { from: '2026-02-30' }, now)).toEqual({ refusal: expect.stringMatching(/not a day/) })
    expect(numbersWindow('Europe/Rome', { from: '2023-10-01' }, now)).toEqual({ refusal: expect.stringMatching(/more than 1095 days back/) })
    expect(numbersWindow('Europe/Rome', { from: '2023-10-17' }, now)).toMatchObject({ from: '2023-10-17' })
  })
})

describe('the query', () => {
  it('a campaign read: the window, impressions only, one campaign, most expensive first, a LIMIT', () => {
    const q = numbersQuery({ level: 'campaign', window, campaignId: '21', segments: ['day', 'hour'], limit: 50 })
    expect(q).toMatch(/^SELECT campaign\.id, campaign\.name, campaign\.status, campaign\.advertising_channel_type, segments\.date, segments\.hour, metrics\.impressions, /)
    expect(q).toContain(' FROM campaign WHERE segments.date BETWEEN \'2026-10-01\' AND \'2026-10-15\' AND metrics.impressions > 0 AND campaign.id = 21 ')
    expect(q).toMatch(/ORDER BY metrics\.cost_micros DESC, metrics\.impressions DESC LIMIT 50$/)
    expect(q).toContain('metrics.search_budget_lost_impression_share')
  })

  it('ids are digits, dates are days, the LIMIT is 1 … 1000 — or nothing is sent', () => {
    expect(() => numbersQuery({ level: 'campaign', window, campaignId: '21 OR 1=1' })).toThrow(/Nothing was sent/)
    expect(() => numbersQuery({ level: 'keyword', window, adGroupId: 'abc' })).toThrow(/Nothing was sent/)
    expect(() => numbersQuery({ level: 'campaign', window: { from: '2026-10-01\' OR \'', to: '2026-10-02' } })).toThrow(/Nothing was sent/)
    expect(() => numbersQuery({ level: 'campaign', window, limit: 1001 })).toThrow(/LIMIT/)
    expect(() => numbersQuery({ level: 'campaign', window, limit: 0 })).toThrow(/LIMIT/)
  })

  it('hour only for campaigns and ad groups; no ad group filter where there are no ad groups', () => {
    expect(() => numbersQuery({ level: 'keyword', window, segments: ['hour'] })).toThrow(/cannot split keywords by hour/)
    expect(numbersQuery({ level: 'ad-group', window, segments: ['hour'] })).toContain('segments.hour')
    expect(() => numbersQuery({ level: 'campaign', window, adGroupId: '51' })).toThrow(/not read per ad group/)
    expect(() => numbersQuery({ level: 'asset', window, adGroupId: '51' })).toThrow(/not read per ad group/)
  })

  it('every field filtered on is selected (Google refuses a filtered segmenting field that is not), at every level', () => {
    for (const level of NUMBER_LEVELS) {
      const spec = NUMBER_LEVEL_SPECS[level]
      const q = numbersQuery({ level, window, campaignId: '21', adGroupId: spec.adGroup ? '51' : null })
      const select = selectOf(q)
      for (const field of whereOf(q).match(/\b[a-z_]+\.[a-z_.]+/g) ?? []) {
        if (field === 'segments.date') continue // a core date segment: Google lets it be filtered without being selected
        expect(select, `${level}: ${field}`).toContain(field)
      }
    }
  })

  it('an ad group filter selects the ad group where it is a segmenting resource (search terms, products, locations)', () => {
    expect(selectOf(numbersQuery({ level: 'search-term', window }))).not.toContain('ad_group.id')
    expect(selectOf(numbersQuery({ level: 'search-term', window, adGroupId: '51' }))).toContain('ad_group.id')
    expect(selectOf(numbersQuery({ level: 'product', window, adGroupId: '51' }))).toContain('ad_group.id')
  })

  it('products: impression share with item id and brand, never with the title (Google cannot combine them); titles come from a second query', () => {
    const q = numbersQuery({ level: 'product', window })
    expect(q).toContain('metrics.search_impression_share')
    expect(q).not.toContain('segments.product_title')
    const titles = productTitlesQuery(window, ['shopify_it_1_2', 'bad\'id', 'shopify_it_1_2'])
    expect(titles).toContain("segments.product_item_id IN ('shopify_it_1_2')")
    expect(titles).not.toContain('metrics.search_impression_share')
    expect(() => productTitlesQuery(window, ['bad\'id'])).toThrow(/Nothing was sent/)
    expect(geoNamesQuery(['2380', '2380', '1008463'])).toContain('geo_target_constant.id IN (2380, 1008463)')
  })
})

describe('the rows', () => {
  it('micros → cents, currency units → cents, fractions → percent; zero counts are 0', () => {
    const row = numbersRowOf('campaign', {
      campaign: { id: '21', name: 'Shop A', status: 'ENABLED', advertisingChannelType: 'SHOPPING' },
      metrics: {
        impressions: '1200', clicks: '30', costMicros: '12340000', averageCpc: 411333.33, ctr: 0.025, conversions: 2, conversionsValue: 159.9,
        searchImpressionShare: 0.0999, searchBudgetLostImpressionShare: 0.1234,
      },
    })
    expect(row).toMatchObject({
      campaignId: '21', campaignName: 'Shop A', item: { status: 'ENABLED', type: 'SHOPPING' },
      impressions: 1200, clicks: 30, spendCents: 1234, avgCpcCents: 41, ctrPct: 2.5, conversions: 2, conversionValueCents: 15990,
      impressionShare: { search: 9.99, lostToBudget: 12.34, top: null },
    })
    const empty = numbersRowOf('ad', { campaign: { id: '21' }, adGroup: { id: '51', name: 'AG' }, adGroupAd: { ad: { id: '7', type: 'RESPONSIVE_SEARCH_AD' }, status: 'ENABLED' }, metrics: { impressions: '3' } })
    expect(empty).toMatchObject({ adGroupId: '51', item: { adId: '51~7' }, impressions: 3, clicks: 0, spendCents: 0, conversionValueCents: 0, avgCpcCents: null })
    expect(empty.impressionShare).toBeUndefined()
  })

  it('splits and the ids the change tools take', () => {
    const row = numbersRowOf('keyword', {
      campaign: { id: '21' }, adGroup: { id: '51' },
      adGroupCriterion: { criterionId: '901', keyword: { text: 'giacca moto', matchType: 'EXACT' }, status: 'ENABLED' },
      segments: { date: '2026-10-15', device: 'MOBILE', dayOfWeek: 'THURSDAY', adNetworkType: 'SEARCH' },
      metrics: { impressions: '10' },
    }, ['day', 'device', 'day-of-week', 'network'])
    expect(row.item).toEqual({ keywordId: '51~901', text: 'giacca moto', matchType: 'EXACT', status: 'ENABLED' })
    expect(row.segments).toEqual({ date: '2026-10-15', device: 'MOBILE', dayOfWeek: 'THURSDAY', network: 'SEARCH' })
    const hour = numbersRowOf('campaign', { campaign: { id: '21' }, segments: {}, metrics: {} }, ['hour'])
    expect(hour.segments).toEqual({ hour: 0 })
  })

  it('totals: sums, then ratios from the sums', () => {
    const rows = [
      numbersRowOf('campaign', { campaign: { id: '1' }, metrics: { impressions: '100', clicks: '10', costMicros: '5000000', conversions: 1, conversionsValue: 20 } }),
      numbersRowOf('campaign', { campaign: { id: '2' }, metrics: { impressions: '300', clicks: '10', costMicros: '15000000', conversions: 3, conversionsValue: 100 } }),
    ]
    expect(numbersTotals(rows)).toEqual({
      rows: 2, impressions: 400, clicks: 20, ctrPct: 5, spendCents: 2000, avgCpcCents: 100, conversions: 4, conversionValueCents: 12000, costPerConversionCents: 500, roas: 6,
    })
    expect(numbersTotals([])).toMatchObject({ rows: 0, ctrPct: null, avgCpcCents: null, roas: null })
  })
})

describe('liveNumbers', () => {
  beforeEach(() => { h.rows.mockReset() })

  it('locations get Google\'s names in a second query; a refused name query leaves the numbers', async () => {
    h.rows.mockImplementation(async (_t: unknown, query: string) => {
      if (query.includes('FROM geographic_view')) {
        return [{ campaign: { id: '21' }, geographicView: { countryCriterionId: '2380', locationType: 'LOCATION_OF_PRESENCE' }, segments: { geoTargetMostSpecificLocation: 'geoTargetConstants/1008463' }, metrics: { impressions: '5' } }]
      }
      return [{ geoTargetConstant: { id: '2380', name: 'Italy', canonicalName: 'Italy' } }, { geoTargetConstant: { id: '1008463', name: 'Milan', canonicalName: 'Milan,Lombardy,Italy' } }]
    })
    const read = await liveNumbers(target, { level: 'location', window })
    expect(h.rows).toHaveBeenCalledTimes(2)
    expect(read.rows[0].item).toEqual({ locationId: '1008463', locationName: 'Milan,Lombardy,Italy', countryId: '2380', countryName: 'Italy', locationType: 'LOCATION_OF_PRESENCE' })
    expect(read.truncated).toBe(false)

    h.rows.mockReset()
    h.rows.mockResolvedValueOnce([{ campaign: { id: '21' }, geographicView: { countryCriterionId: '2380' }, metrics: { impressions: '5' } }])
    h.rows.mockRejectedValueOnce(new Error('Google refused it'))
    const partial = await liveNumbers(target, { level: 'location', window })
    expect(partial.rows).toHaveLength(1)
    expect(partial.notRead).toEqual([{ part: 'location names', why: 'Google refused it' }])
  })

  it('products get their titles from the second query; a read that fills its LIMIT says it may have more', async () => {
    h.rows.mockImplementation(async (_t: unknown, query: string) => {
      if (query.includes('segments.product_title')) return [{ segments: { productItemId: 'shopify_it_1_2', productTitle: 'Jacket A' } }]
      return [
        { campaign: { id: '21' }, segments: { productItemId: 'shopify_it_1_2', productBrand: 'Brand A' }, metrics: { impressions: '9', searchImpressionShare: 0.5 } },
        { campaign: { id: '21' }, segments: { productItemId: 'shopify_it_3_4' }, metrics: { impressions: '4' } },
      ]
    })
    const read = await liveNumbers(target, { level: 'product', window, limit: 2 })
    expect(read.rows.map((r) => r.item)).toEqual([{ itemId: 'shopify_it_1_2', title: 'Jacket A', brand: 'Brand A' }, { itemId: 'shopify_it_3_4', title: null, brand: null }])
    expect(read.rows[0].impressionShare).toMatchObject({ search: 50 })
    expect(read.truncated).toBe(true)
  })
})

/**
 * BID BRAIN BB-16 — one Marketing Stream record → one delta at ad group × placement grain (pure). Values are made up.
 */
import { describe, expect, it } from 'vitest'
import { GRAIN_DAYS_KEPT, OFF_AMAZON, ageBucketHours, normalizeStreamPlacement, parseGrainRecord, streamRecordKey } from './ams-grain.js'

const AT = new Date('2026-10-08T12:20:00Z')
const market = (raw: string) => (raw === 'APJ6JRA9NG5V4' ? 'IT' : raw)
const traffic = (over: Record<string, unknown> = {}) => ({
  dataset_id: 'sp-traffic', idempotency_id: 'idem-t-1', advertiser_id: 'ADV1', marketplace_id: 'APJ6JRA9NG5V4', currency: 'EUR',
  campaign_id: '1001', ad_group_id: '2001', ad_id: '3001', keyword_id: '4001', placement: 'Top of Search on-Amazon',
  time_window_start: '2026-10-08T10:00:00Z', impressions: 120, clicks: 4, cost: 1.6, ...over,
})
const conversion = (over: Record<string, unknown> = {}) => ({
  dataset_id: 'sp-conversion', idempotency_id: 'idem-c-1', advertiser_id: 'ADV1', marketplace_id: 'APJ6JRA9NG5V4', currency: 'EUR',
  campaign_id: '1001', ad_group_id: '2001', placement: 'Detail Page on-Amazon', time_window_start: '2026-10-08T10:00:00Z',
  attributed_conversions_1d: 1, attributed_conversions_7d: 2, attributed_units_ordered_1d: 1, attributed_units_ordered_7d: 3,
  attributed_sales_1d: 80, attributed_sales_7d: 160.5, attributed_conversions_14d: 9, ...over,
})
const parse = (rec: Record<string, unknown>, at = AT) => parseGrainRecord(rec, at, market)

describe('a traffic record', () => {
  it('becomes a delta at ad group × placement grain, in UTC, with the market and the dedupe key', () => {
    const out = parse(traffic())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.delta).toMatchObject({
      kind: 'traffic', profileId: 'ADV1', marketplace: 'IT', currencyCode: 'EUR', campaignId: '1001', adGroupId: '2001',
      placement: 'PLACEMENT_TOP', date: '2026-10-08', hour: 10, impressions: 120, clicks: 4, costMicros: 1_600_000n,
      orders1d: 0, orders7d: 0, sales7dCents: 0, negative: false, late: false, ageHours: 1,
    })
    expect(out.delta.key).toBe(streamRecordKey('sp-traffic', 'idem-t-1'))
  })

  it('reads an offset time and a numeric id as Amazon sends them', () => {
    const out = parse(traffic({ time_window_start: '2026-10-08T12:00:00+02:00', campaign_id: 1001, ad_group_id: 2001 }))
    expect(out.ok && out.delta).toMatchObject({ date: '2026-10-08', hour: 10, campaignId: '1001', adGroupId: '2001' })
  })

  it('a negative delta (invalid clicks) is a correction', () => {
    const out = parse(traffic({ impressions: 0, clicks: -1, cost: -0.4 }))
    expect(out.ok && out.delta).toMatchObject({ negative: true, clicks: -1, costMicros: -400_000n })
  })
})

describe('a conversion record', () => {
  it('keeps the real 1-day AND 7-day conversions (the 14-day ones are not this grain\'s)', () => {
    const out = parse(conversion())
    expect(out.ok && out.delta).toMatchObject({
      kind: 'conversion', placement: 'PLACEMENT_PRODUCT_PAGE', orders1d: 1, orders7d: 2, units1d: 1, units7d: 3,
      sales1dCents: 8_000, sales7dCents: 16_050, impressions: 0, clicks: 0, costMicros: 0n,
    })
  })

  it('arriving days after its hour lands in a day bucket, and would start a row late', () => {
    const out = parse(conversion(), new Date('2026-10-12T09:00:00Z'))
    expect(out.ok && out.delta).toMatchObject({ ageHours: 72, late: true })
  })
})

describe('placements', () => {
  it('maps Amazon\'s labels to the lanes Nexus uses; keeps an unknown label by name; never folds one into a lane', () => {
    expect(normalizeStreamPlacement('Top of Search on-Amazon')).toBe('PLACEMENT_TOP')
    expect(normalizeStreamPlacement('Detail Page on-Amazon')).toBe('PLACEMENT_PRODUCT_PAGE')
    expect(normalizeStreamPlacement('Other on-Amazon')).toBe('PLACEMENT_REST_OF_SEARCH')
    expect(normalizeStreamPlacement('  rest   of search ')).toBe('PLACEMENT_REST_OF_SEARCH')
    expect(normalizeStreamPlacement('Off Amazon')).toBe(OFF_AMAZON)
    expect(normalizeStreamPlacement('Amazon Business on-Amazon')).toBe('OTHER:Amazon Business on-Amazon')
    expect(normalizeStreamPlacement(undefined)).toBe('UNKNOWN')
    expect(normalizeStreamPlacement('x'.repeat(100))).toHaveLength('OTHER:'.length + 48)
  })
})

describe('the arrival age bucket', () => {
  const start = new Date('2026-10-01T10:00:00Z')
  const after = (hours: number) => new Date(start.getTime() + 3_600_000 + hours * 3_600_000)
  it('exact hours below 48 h, whole days below 14 days, whole weeks after; never negative', () => {
    expect(ageBucketHours(start, new Date('2026-10-01T10:30:00Z'))).toBe(0)
    expect(ageBucketHours(start, after(0.5))).toBe(0)
    expect(ageBucketHours(start, after(47.9))).toBe(47)
    expect(ageBucketHours(start, after(50))).toBe(48)
    expect(ageBucketHours(start, after(24 * 13 + 5))).toBe(24 * 13)
    expect(ageBucketHours(start, after(24 * 20))).toBe(336)
    expect(ageBucketHours(start, after(24 * 59))).toBe(168 * 8)
  })
})

describe('the dedupe key', () => {
  it('is stable, per dataset and id, and fits a signed 64-bit integer', () => {
    const k = streamRecordKey('sp-traffic', 'abc')
    expect(streamRecordKey('sp-traffic', 'abc')).toBe(k)
    expect(streamRecordKey('sp-conversion', 'abc')).not.toBe(k)
    expect(k >= -(2n ** 63n) && k < 2n ** 63n).toBe(true)
  })
})

describe('refused records, each with its reason', () => {
  it.each([
    ['Sponsored Brands keeps the campaign grain', { ...traffic(), dataset_id: 'sb-traffic' }, 'notGrain'],
    ['a change stream', { dataset_id: 'campaigns', campaignId: '1' }, 'notGrain'],
    ['no dataset', { ...traffic(), dataset_id: undefined }, 'notGrain'],
    ['no ad group', traffic({ ad_group_id: undefined }), 'malformed'],
    ['an id that is not an id', traffic({ campaign_id: '1001; DROP' }), 'malformed'],
    ['no hour', traffic({ time_window_start: 'yesterday' }), 'malformed'],
    ['an hour in the future', traffic({ time_window_start: '2026-10-08T18:00:00Z' }), 'malformed'],
    ['a metric that is not a number', traffic({ clicks: 'four' }), 'malformed'],
    ['an absurd metric', traffic({ impressions: 1e12 }), 'malformed'],
    ['no idempotency key', traffic({ idempotency_id: undefined }), 'noIdempotencyKey'],
    ['older than the days kept', traffic({ time_window_start: new Date(AT.getTime() - (GRAIN_DAYS_KEPT + 1) * 86_400_000).toISOString() }), 'tooOld'],
    ['a record that changes nothing', traffic({ impressions: 0, clicks: 0, cost: 0 }), 'zero'],
    ['a conversion record with only 14-day changes', conversion({ attributed_conversions_1d: 0, attributed_conversions_7d: 0, attributed_units_ordered_1d: 0, attributed_units_ordered_7d: 0, attributed_sales_1d: 0, attributed_sales_7d: 0 }), 'zero'],
  ])('%s', (_name, rec, reason) => {
    const out = parse(rec as Record<string, unknown>)
    expect(out).toMatchObject({ ok: false, reason })
  })

  it('numeric strings are numbers, absent metrics are 0', () => {
    const out = parse(traffic({ impressions: '30', clicks: undefined, cost: '0.25' }))
    expect(out.ok && out.delta).toMatchObject({ impressions: 30, clicks: 0, costMicros: 250_000n })
  })
})

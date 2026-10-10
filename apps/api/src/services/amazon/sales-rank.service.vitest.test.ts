/**
 * The Best Sellers Rank feed's pure parts: Amazon's searchCatalogItems body → ranks per ASIN (this market only, best
 * first, junk dropped), 20 ASINs per call at most, one ASIN per account × market with the product its main listing sells,
 * what is stored (changed, or a day-old heartbeat; never a read with no rank), and the tool's summary (best ASIN per
 * category, trend against a day and a week ago, best rank per day). Fake ASINs and numbers only.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import {
  bestRankOf, chunk, parseSalesRanks, planAsins, sameRanks, shouldStore, summariseSalesRank, salesRankAge, SALES_RANK_BATCH,
  SALES_RANK_STALE_HOURS,
  type AsinRanks, type StoredRead,
} from './sales-rank.service.js'

const MP = 'TESTMARKET01'
const OTHER_MP = 'TESTMARKET02'
const body = {
  numberOfResults: 3,
  items: [
    {
      asin: 'B0TEST0001',
      salesRanks: [
        {
          marketplaceId: MP,
          classificationRanks: [
            { classificationId: '900002', title: 'Test Sub B', link: 'https://example.test/b', rank: 40 },
            { classificationId: '900001', title: 'Test Sub A', link: 'https://example.test/a', rank: 4 },
            { classificationId: '900003', title: 'Broken', rank: 0 },
          ],
          displayGroupRanks: [{ websiteDisplayGroup: 'test_display_on_website', title: 'Test Department', rank: 1234 }],
        },
        { marketplaceId: OTHER_MP, classificationRanks: [{ classificationId: '900001', title: 'Other market', rank: 1 }] },
      ],
    },
    { asin: 'b0test0002', salesRanks: [] },
    { asin: '', salesRanks: [{ marketplaceId: MP, classificationRanks: [{ classificationId: 'x', title: 'x', rank: 1 }] }] },
  ],
}

const ranks = (sub: number, dept = 1000): AsinRanks => ({
  classification: [{ id: '900001', title: 'Test Sub A', rank: sub }],
  displayGroup: [{ group: 'test_display_on_website', title: 'Test Department', rank: dept }],
})

describe('parseSalesRanks — Amazon\'s body', () => {
  it('keeps this market\'s ranks, best first, drops a rank that is not a positive whole number', () => {
    const out = parseSalesRanks(body, MP)
    expect(out.get('B0TEST0001')).toEqual({
      classification: [{ id: '900001', title: 'Test Sub A', rank: 4 }, { id: '900002', title: 'Test Sub B', rank: 40 }],
      displayGroup: [{ group: 'test_display_on_website', title: 'Test Department', rank: 1234 }],
    })
  })

  it('an ASIN with no rank maps to empty lists (upper-cased); an item with no ASIN and a body with no items give nothing', () => {
    const out = parseSalesRanks(body, MP)
    expect(out.get('B0TEST0002')).toEqual({ classification: [], displayGroup: [] })
    expect([...out.keys()]).toEqual(['B0TEST0001', 'B0TEST0002'])
    expect(parseSalesRanks({}, MP).size).toBe(0)
    expect(parseSalesRanks(null, MP).size).toBe(0)
  })

  it('bestRankOf: the best sub-category rank, else the department, else null', () => {
    expect(bestRankOf(parseSalesRanks(body, MP).get('B0TEST0001')!)).toBe(4)
    expect(bestRankOf({ classification: [], displayGroup: [{ group: 'g', title: 'g', rank: 77 }] })).toBe(77)
    expect(bestRankOf({ classification: [], displayGroup: [] })).toBeNull()
  })
})

describe('chunk — 20 ASINs per call at most', () => {
  it('splits 45 into 20 + 20 + 5 and keeps the order', () => {
    const asins = Array.from({ length: 45 }, (_, i) => `B0TEST${String(i).padStart(4, '0')}`)
    const parts = chunk(asins)
    expect(SALES_RANK_BATCH).toBe(20)
    expect(parts.map((p) => p.length)).toEqual([20, 20, 5])
    expect(parts.flat()).toEqual(asins)
    expect(chunk([])).toEqual([])
  })
})

describe('planAsins — one ASIN per account × market', () => {
  it('dedupes, upper-cases, skips a row with no valid ASIN or market, and names the main listing\'s product', () => {
    const plan = planAsins([
      { productId: 'p-alias', marketplace: 'it', channelConnectionId: 'acc-1', externalListingId: 'b0test0001', aliasKey: 'alt1' },
      { productId: 'p-main', marketplace: 'IT', channelConnectionId: 'acc-1', externalListingId: 'B0TEST0001', aliasKey: '' },
      { productId: 'p-de', marketplace: 'DE', channelConnectionId: 'acc-1', externalListingId: 'B0TEST0001', aliasKey: '' },
      { productId: 'p-x', marketplace: 'IT', channelConnectionId: 'acc-1', externalListingId: 'NOT-AN-ASIN', aliasKey: '' },
      { productId: 'p-y', marketplace: 'DEFAULT', channelConnectionId: 'acc-1', externalListingId: 'B0TEST0009', aliasKey: '' },
      { productId: 'p-z', marketplace: 'IT', channelConnectionId: null, externalListingId: 'B0TEST0003', aliasKey: '' },
    ])
    expect(plan).toEqual([
      { accountId: 'acc-1', marketplace: 'IT', asin: 'B0TEST0001', productId: 'p-main' },
      { accountId: 'acc-1', marketplace: 'DE', asin: 'B0TEST0001', productId: 'p-de' },
      { accountId: null, marketplace: 'IT', asin: 'B0TEST0003', productId: 'p-z' },
    ])
  })
})

describe('shouldStore — what is kept', () => {
  const now = new Date('2026-10-09T12:00:00Z')
  const last = (r: AsinRanks, hoursAgo: number) => ({ asin: 'B0TEST0001', marketplace: 'IT', ranks: r, capturedAt: new Date(now.getTime() - hoursAgo * 3_600_000) })

  it('a first read, or a changed rank, is stored', () => {
    expect(shouldStore(ranks(5), undefined, now)).toBe('store')
    expect(shouldStore(ranks(5), last(ranks(6), 3), now)).toBe('store')
    expect(shouldStore(ranks(5, 999), last(ranks(5, 1000), 3), now)).toBe('store')
  })

  it('the same ranks are skipped until the last stored read is a day old (titles do not count)', () => {
    const renamed: AsinRanks = { classification: [{ id: '900001', title: 'Renamed', rank: 5 }], displayGroup: ranks(5).displayGroup }
    expect(sameRanks(renamed, ranks(5))).toBe(true)
    expect(shouldStore(renamed, last(ranks(5), 3), now)).toBe('unchanged')
    expect(shouldStore(ranks(5), last(ranks(5), 24), now)).toBe('store')
  })

  it('a read with no rank is never stored', () => {
    expect(shouldStore({ classification: [], displayGroup: [] }, undefined, now)).toBe('no-rank')
  })
})

describe('summariseSalesRank — the tool\'s answer', () => {
  const now = new Date('2026-10-09T12:00:00Z')
  const read = (asin: string, sub: number, hoursAgo: number, productId = 'p-1'): StoredRead => ({
    asin, marketplace: 'IT', productId, ranks: ranks(sub, sub * 100), capturedAt: new Date(now.getTime() - hoursAgo * 3_600_000),
  })

  it('per ASIN: newest ranks, change against the read nearest ~24 h and ~7 d before it (positive = climbed), best rank per day', () => {
    // Newest read 1 h ago → the comparison targets are 25 h and 169 h ago.
    const out = summariseSalesRank([read('B0TEST0001', 4, 1), read('B0TEST0001', 9, 26), read('B0TEST0001', 6, 30), read('B0TEST0001', 20, 24 * 7 + 3)], now)
    const sub = out.asins[0].categories.find((c) => c.kind === 'subcategory')!
    expect(sub).toMatchObject({
      categoryId: '900001', rank: 4,
      rank24hAgo: 9, rank24hAgoAt: '2026-10-08T10:00:00.000Z', change24h: 5,
      rank7dAgo: 20, rank7dAgoAt: '2026-10-02T09:00:00.000Z', change7d: 16,
    })
    expect(sub.history).toEqual([
      { date: '2026-10-02', best: 20 },
      { date: '2026-10-08', best: 6 },
      { date: '2026-10-09', best: 4 },
    ])
    expect(out.asins[0]).toMatchObject({ asin: 'B0TEST0001', reads: 4, capturedAt: '2026-10-09T11:00:00.000Z', ageHours: 1, stale: false })
  })

  it('B2 + review fix: a gap (the newest read before then is more than 27 h older) → null, never a change against a much older read', () => {
    // 24 h ago: the read 40 h ago still held (16 h older, inside a heartbeat); 7 days ago: the newest read before it is
    // 30 h older — a gap, so no 7-day change.
    const out = summariseSalesRank([read('B0TEST0001', 4, 1), read('B0TEST0001', 9, 40), read('B0TEST0001', 20, 24 * 8 + 6)], now)
    const sub = out.asins[0].categories.find((c) => c.kind === 'subcategory')!
    expect(sub).toMatchObject({ rank: 4, rank24hAgo: 9, change24h: 5, rank7dAgo: null, rank7dAgoAt: null, change7d: null })
    const gap = summariseSalesRank([read('B0TEST0001', 4, 2), read('B0TEST0001', 9, 60)], now).asins[0].categories[0]
    expect(gap).toMatchObject({ rank24hAgo: null, change24h: null })
  })

  it('review fix: a steady rank (stored once a day) gives change24h = 0 from a real older read, never a read after "24 h ago"', () => {
    // Heartbeats 2 h and 31 h ago, the same rank: 24 h ago the 31-hour-old read still held (7 h older) — a real 0.
    const steady = summariseSalesRank([read('B0TEST0001', 4, 2), read('B0TEST0001', 4, 31)], now).asins[0].categories[0]
    expect(steady).toMatchObject({ rank: 4, rank24hAgo: 4, rank24hAgoAt: '2026-10-08T05:00:00.000Z', change24h: 0 })
    // A read 20 h ago is AFTER "24 h ago": it is not the rank then.
    const after = summariseSalesRank([read('B0TEST0001', 4, 2), read('B0TEST0001', 9, 20)], now).asins[0].categories[0]
    expect(after).toMatchObject({ rank24hAgo: null, change24h: null })
  })

  it('B2: the newest read is never its own comparison (one read, or a second one only hours older → null, not 0)', () => {
    const one = summariseSalesRank([read('B0TEST0001', 4, 20)], now).asins[0].categories[0]
    expect(one).toMatchObject({ change24h: null, change7d: null })
    const close = summariseSalesRank([read('B0TEST0001', 4, 1), read('B0TEST0001', 4, 3)], now).asins[0].categories[0]
    expect(close).toMatchObject({ change24h: null, change7d: null })
  })

  it(`B1: a newest read older than ${SALES_RANK_STALE_HOURS} h is stale (Amazon reported no rank since, or the feed did not run)`, () => {
    const out = summariseSalesRank([read('B0TEST0001', 4, SALES_RANK_STALE_HOURS + 3), read('B0TEST0002', 7, 2, 'p-2')], now)
    expect(out.asins.find((a) => a.asin === 'B0TEST0001')).toMatchObject({ ageHours: SALES_RANK_STALE_HOURS + 3, stale: true })
    expect(out.asins.find((a) => a.asin === 'B0TEST0002')).toMatchObject({ ageHours: 2, stale: false })
    // The best per category says its own age too, so a stale #1 never reads as the rank now.
    expect(out.bestPerCategory.find((b) => b.kind === 'subcategory')).toMatchObject({ asin: 'B0TEST0001', rank: 4, stale: true })
    expect(salesRankAge(new Date(now.getTime() - SALES_RANK_STALE_HOURS * 3_600_000), now)).toEqual({ ageHours: SALES_RANK_STALE_HOURS, stale: false })
  })

  it('a family: the best ASIN per market and category now', () => {
    const out = summariseSalesRank([read('B0TEST0001', 12, 1), read('B0TEST0002', 3, 2, 'p-2'), read('B0TEST0003', 7, 1, 'p-3')], now)
    const best = out.bestPerCategory.find((b) => b.kind === 'subcategory')!
    expect(best).toMatchObject({ marketplace: 'IT', rank: 3, asin: 'B0TEST0002', productId: 'p-2', change24h: null })
    expect(out.bestPerCategory[0].kind).toBe('subcategory')
    expect(out.asins.map((a) => a.asin)).toEqual(['B0TEST0002', 'B0TEST0003', 'B0TEST0001'])
  })

  it('nothing stored: nothing to say', () => {
    expect(summariseSalesRank([], now)).toEqual({ bestPerCategory: [], asins: [] })
  })
})

/**
 * Amazon's 6-month topic trends (amazon-review-trends.ts): Amazon's own example answer of getItemReviewTrends (the
 * official model's 200 example, __fixtures__/customer-feedback-2024-06-01.examples.json) read into the stored shape, the
 * stored shape read back, and one topic's trend over a page's reads.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { monthOf, parseItemReviewTrends, readStoredTrends, topicTrend, type StoredTrends, type TrendSourceRow } from './amazon-review-trends.js'

const examples = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'customer-feedback-2024-06-01.examples.json'), 'utf8')) as {
  getItemReviewTrends: Record<string, unknown>
}

describe("Amazon's getItemReviewTrends answer (the model's example)", () => {
  it('every topic of both lists, its label trimmed, six months oldest first, the share of reviews per month', () => {
    const topics = parseItemReviewTrends(examples.getItemReviewTrends)
    expect(topics.map((t) => [t.polarity, t.topic])).toEqual([
      ['POSITIVE', 'Quality-Overall'],
      ['POSITIVE', 'Assembly/Installation'],
      ['NEGATIVE', 'Weak and fragile'],
    ])
    expect(topics[0].points).toEqual([
      { month: '2024-01', share: 27.58 }, { month: '2024-02', share: 27.58 }, { month: '2024-03', share: 27.58 },
      { month: '2024-04', share: 27.58 }, { month: '2024-05', share: 27.58 }, { month: '2024-06', share: 27.58 },
    ])
  })

  it("a family keeps its parent's numbers; a month without one keeps its place", () => {
    const answer = { reviewTrends: { positiveTopics: [{ topic: 'Fit', trendMetrics: [
      { dateRange: { startDate: '2026-10-01T00:00:00.000Z' }, asinMetrics: { occurrencePercentage: 12 }, parentAsinMetrics: { occurrencePercentage: 9.5 } },
      { dateRange: { startDate: '2026-09-01T00:00:00.000Z' }, asinMetrics: { occurrencePercentage: 3 }, parentAsinMetrics: null },
    ] }], negativeTopics: null } }
    expect(parseItemReviewTrends(answer, 'parent')).toEqual([{ topic: 'Fit', polarity: 'POSITIVE', points: [{ month: '2026-09', share: null }, { month: '2026-10', share: 9.5 }] }])
    expect(parseItemReviewTrends(answer, 'asin')[0].points).toEqual([{ month: '2026-09', share: 3 }, { month: '2026-10', share: 12 }])
  })

  it('too few reviews (null lists), an empty answer (204) or a strange one → no topics, never a throw', () => {
    expect(parseItemReviewTrends({ reviewTrends: { positiveTopics: null, negativeTopics: null } })).toEqual([])
    expect(parseItemReviewTrends(undefined)).toEqual([])
    expect(parseItemReviewTrends({ reviewTrends: { positiveTopics: [{ topic: '', trendMetrics: [] }, { topic: 'No months', trendMetrics: [{ dateRange: {} }] }] } })).toEqual([])
  })

  it('months: a date or a month in, the year and month out; nonsense → null', () => {
    expect(monthOf('2024-02-30T00:00:00.000Z')).toBe('2024-02')
    expect(monthOf('2026-10')).toBe('2026-10')
    expect(monthOf('2026-13-01')).toBeNull()
    expect(monthOf(20261001)).toBeNull()
  })
})

describe('the stored trend, read back', () => {
  it('a row written before trends were read (an array) is "never read"; a stored read comes back clean', () => {
    expect(readStoredTrends([])).toBeNull()
    expect(readStoredTrends([{ month: '2026-05', starRating: 4.2, reviewCount: 10 }])).toBeNull()
    expect(readStoredTrends({ read: 'REFUSED', at: '2026-10-26T06:00:00.000Z', topics: [] })).toEqual({ read: 'REFUSED', at: '2026-10-26T06:00:00.000Z', topics: [] })
    expect(readStoredTrends({ read: 'OK', at: 'x', topics: [{ topic: ' Fit ', polarity: 'POSITIVE', points: [{ month: '2026-10', share: 9 }, { month: 'bad', share: 1 }] }, { topic: 'No polarity', points: [] }] }))
      .toEqual({ read: 'OK', at: 'x', topics: [{ topic: 'Fit', polarity: 'POSITIVE', points: [{ month: '2026-10', share: 9 }] }] })
  })
})

describe("one topic's trend over a page's reads", () => {
  const ok = (topics: StoredTrends['topics']): StoredTrends => ({ read: 'OK', at: '2026-10-26T06:00:00.000Z', topics })
  const months = (shares: Array<number | null>) => shares.map((share, i) => ({ month: `2026-${String(5 + i).padStart(2, '0')}`, share }))
  const row = (over: Partial<TrendSourceRow> & { mentions?: number }): TrendSourceRow => ({
    asin: 'B0TEST0001', marketplace: 'IT', productId: 'p1',
    positiveTopics: [], negativeTopics: [{ topic: 'Runs small', mentionCount: over.mentions ?? 10 }],
    trend: ok([{ topic: 'Runs small', polarity: 'NEGATIVE', points: months([4, 5, 5, 6, 8, 9]) }]),
    ...over,
  })

  it('one read: its own months, matched by label whatever the case', () => {
    expect(topicTrend([row({})], 'NEGATIVE', 'runs SMALL')).toEqual({ state: 'ok', points: months([4, 5, 5, 6, 8, 9]), reads: 1, products: 1, markets: 1 })
  })

  it('several products: each month weighted by the mentions of each read', () => {
    const other = row({ asin: 'B0TEST0002', productId: 'p2', mentions: 30, trend: ok([{ topic: 'Runs small', polarity: 'NEGATIVE', points: months([8, 8, 8, 8, 8, null]) }]) })
    const t = topicTrend([row({ mentions: 10 }), other], 'NEGATIVE', 'Runs small')
    if (t.state !== 'ok') throw new Error(t.state)
    expect(t.points.map((p) => p.share)).toEqual([7, 7.25, 7.25, 7.5, 8, 9])
    expect(t).toMatchObject({ reads: 2, products: 2, markets: 1 })
  })

  it('true states without a line: none for this topic, refused, never read', () => {
    expect(topicTrend([row({ trend: ok([]) })], 'NEGATIVE', 'Runs small')).toEqual({ state: 'none' })
    expect(topicTrend([row({ trend: ok([{ topic: 'Runs small', polarity: 'NEGATIVE', points: months([null, null]) }]) })], 'NEGATIVE', 'Runs small')).toEqual({ state: 'none' })
    expect(topicTrend([row({ trend: { read: 'REFUSED', at: 'x', topics: [] } })], 'NEGATIVE', 'Runs small')).toEqual({ state: 'refused' })
    expect(topicTrend([row({ trend: [] })], 'NEGATIVE', 'Runs small')).toEqual({ state: 'not_read' })
    // The other polarity's line never counts.
    expect(topicTrend([row({})], 'POSITIVE', 'Runs small')).toEqual({ state: 'not_read' })
  })
})

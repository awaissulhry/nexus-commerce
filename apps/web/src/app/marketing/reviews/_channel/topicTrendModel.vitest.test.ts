import { describe, expect, it } from 'vitest'
import { sparkSummary } from '@/design-system/components/sparklineModel'
import { monthsSpanned, monthWord, shareWords, topicTrendView, TREND_NONE, TREND_NOT_READ, TREND_REFUSED, type TopicTrend } from './topicTrendModel'

// 2026-10-27 — Reviews › Amazon: a topic's 6-month trend (Amazon's getItemReviewTrends, read with the weekly topics).
const months = (shares: Array<number | null>, start = 5, year = 2026) => shares.map((share, i) => {
  const at = year * 12 + (start - 1) + i
  return { month: `${Math.floor(at / 12)}-${String((at % 12) + 1).padStart(2, '0')}`, share }
})
const ok = (shares: Array<number | null>, over: Partial<Extract<TopicTrend, { state: 'ok' }>> = {}): TopicTrend =>
  ({ state: 'ok', points: months(shares), reads: 1, products: 1, markets: 1, ...over })

describe('a topic’s 6-month trend', () => {
  it('rose: the line, its months, and the words', () => {
    expect(topicTrendView(ok([4, 5, 5, 6, 8, 9]))).toEqual({
      values: [4, 5, 5, 6, 8, 9], from: 'May', to: 'Oct 2026',
      words: 'Rose from 4% to 9% of reviews over 6 months',
      label: 'Rose from 4% to 9% of reviews over 6 months, May–Oct 2026',
    })
  })

  it("the chart's text alternative (the DS Sparkline's accessible name) says the trend and its months", () => {
    const view = topicTrendView(ok([4, 5, 5, 6, 8, 9]))
    expect(sparkSummary(view.label, view.values ?? [], shareWords))
      .toBe('Rose from 4% to 9% of reviews over 6 months, May–Oct 2026: 6 readings, low 4%, high 9%, now 9%')
  })

  it('fell, held, a missing month, a year boundary', () => {
    expect(topicTrendView(ok([27.58, 20, 18.01])).words).toBe('Fell from 28% to 18% of reviews over 3 months')
    expect(topicTrendView(ok([7.02, 7.04])).words).toBe('Held at 7% of reviews over 2 months')
    const gap = topicTrendView(ok([null, 3.25, null, 4.5]))
    expect(gap).toMatchObject({ values: [null, 3.25, null, 4.5], words: 'Rose from 3.3% to 4.5% of reviews over 3 months' })
    const across = topicTrendView({ state: 'ok', points: months([2, 3, 4], 11, 2025), reads: 1, products: 1, markets: 1 })
    expect(across).toMatchObject({ from: 'Nov 2025', to: 'Jan 2026', label: 'Rose from 2% to 4% of reviews over 3 months, Nov 2025–Jan 2026' })
  })

  it('one month only: said as one month', () => {
    expect(topicTrendView(ok([null, null, 9]))).toMatchObject({ values: [null, null, 9], words: '9% of reviews in Jul 2026 — Amazon sent no other month' })
  })

  it('a topic of several products or markets says it is weighted by mentions', () => {
    expect(topicTrendView(ok([4, 9], { reads: 3, products: 3, markets: 1 })).words).toBe('Rose from 4% to 9% of reviews over 2 months · 3 products, weighted by mentions')
    expect(topicTrendView(ok([4, 9], { reads: 2, products: 1, markets: 2 })).words).toBe('Rose from 4% to 9% of reviews over 2 months · 2 markets, weighted by mentions')
  })

  it('no line: true words for each reason, never "coming later"', () => {
    expect(topicTrendView({ state: 'not_read' })).toEqual({ values: null, from: null, to: null, words: TREND_NOT_READ, label: TREND_NOT_READ })
    expect(topicTrendView(null).words).toBe(TREND_NOT_READ)
    expect(topicTrendView({ state: 'refused' }).words).toBe(TREND_REFUSED)
    expect(topicTrendView({ state: 'none' }).words).toBe(TREND_NONE)
    expect(topicTrendView(ok([null, null])).words).toBe(TREND_NONE)
    for (const words of [TREND_NOT_READ, TREND_REFUSED, TREND_NONE]) expect(words).not.toMatch(/coming later|sample/i)
  })

  it('months and shares in words', () => {
    expect(monthWord('2026-05')).toBe('May')
    expect(monthWord('2026-12', true)).toBe('Dec 2026')
    expect(monthWord('2026-13')).toBe('')
    expect(monthsSpanned('2025-11', '2026-04')).toBe(6)
    expect([27.58, 10, 9.96, 4.04, 4].map(shareWords)).toEqual(['28%', '10%', '10%', '4%', '4%'])
  })
})

import { describe, expect, it } from 'vitest'
import { chartMarks, legendMarks, markOf, seriesMarks, stackTotal } from './performanceGraphSeries'

// 2026-10-26 — PerformanceGraph bars and stacked bars (Reviews channel pages, lane L12).
const reviews = { key: 'reviews', label: 'Reviews per week', color: 'grey', axis: 'left' as const, shape: 'bar' as const }
const average = { key: 'avg', label: 'Average rating', color: 'blue', axis: 'right' as const }
const byType = {
  key: 'feedback', label: 'Feedback', color: 'grey', axis: 'left' as const,
  stack: [
    { key: 'positive', label: 'Positive', color: 'green' },
    { key: 'neutral', label: 'Neutral', color: 'grey' },
    { key: 'negative', label: 'Negative', color: 'red' },
  ],
}

describe('the marks a series draws', () => {
  it('a line by default, one bar with shape bar, one stacked bar per part with stack', () => {
    expect(seriesMarks(average)).toEqual([{ kind: 'line', key: 'avg', label: 'Average rating', color: 'blue', axis: 'right', format: undefined }])
    expect(seriesMarks(reviews)).toMatchObject([{ kind: 'bar', key: 'reviews' }])
    expect(seriesMarks(reviews)[0].stackId).toBeUndefined()
    expect(seriesMarks(byType).map((m) => [m.kind, m.key, m.color, m.stackId])).toEqual([
      ['bar', 'positive', 'green', 'stack:feedback'],
      ['bar', 'neutral', 'grey', 'stack:feedback'],
      ['bar', 'negative', 'red', 'stack:feedback'],
    ])
    // An empty stack is no stack.
    expect(seriesMarks({ ...average, stack: [] })[0].kind).toBe('line')
  })

  it('bars are drawn first so a line sits on top; the legend keeps the order the series were given', () => {
    expect(chartMarks(average, reviews).map((m) => m.key)).toEqual(['reviews', 'avg'])
    expect(legendMarks(average, reviews).map((m) => m.key)).toEqual(['avg', 'reviews'])
    // Two lines: exactly as before (left, then right).
    expect(chartMarks(average, { ...average, key: 'other', axis: 'left' }).map((m) => m.key)).toEqual(['avg', 'other'])
  })

  it('a tooltip row finds its mark by data key; a stack has a total', () => {
    const marks = chartMarks(byType, average)
    expect(markOf(marks, 'negative')?.label).toBe('Negative')
    expect(markOf(marks, 'feedback')).toBeNull()
    expect(stackTotal({ positive: 9, neutral: 1, negative: null }, byType.stack)).toBe(10)
    expect(stackTotal({ when: 'Oct' }, byType.stack)).toBeNull()
  })
})

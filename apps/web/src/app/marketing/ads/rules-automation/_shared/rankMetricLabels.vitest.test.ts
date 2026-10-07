/**
 * Keyword feed (2026-10-07) — the Keyword Tracker's metric menu says what each metric is: Search Volume is a week's
 * searches (Amazon Brand Analytics), and the three ranks fill only from a hand import. Only the words change: the value
 * a rule stores, and the API adapter maps, stays the metric's name.
 */
import { describe, expect, it } from 'vitest'
import { PC_METRICS_RANK, pcMetricsFor } from './PerformanceCriteria'

describe('Keyword Tracker metric labels', () => {
  it('name the source honestly, keeping every stored value', () => {
    expect(PC_METRICS_RANK).toEqual([
      { value: 'Organic Rank', label: 'Organic Rank (import only)' },
      { value: 'Sponsored Rank', label: 'Sponsored Rank (import only)' },
      { value: 'Rank Change', label: 'Rank Change (import only)' },
      { value: 'Search Volume', label: 'Search Volume (searches per week)' },
      { value: 'ACOS', label: 'ACOS' },
      { value: 'Spend', label: 'Spend' },
    ])
    expect(pcMetricsFor('keyword-tracker')).toEqual(PC_METRICS_RANK)
  })

  it('leave every other tab\'s labels as their names', () => {
    for (const slug of ['bid', 'budget', 'sov', 'placement', 'keyword-harvesting']) {
      for (const o of pcMetricsFor(slug)) expect(o.label).toBe(o.value)
    }
  })
})

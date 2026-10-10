/**
 * Keyword feed (2026-10-07) — the Keyword Tracker's metric menu says what each metric is: Search Volume is a week's
 * searches (Amazon Brand Analytics), and the three ranks fill only from a hand import. Only the words change: the value
 * a rule stores, and the API adapter maps, stays the metric's name.
 */
import { describe, expect, it } from 'vitest'
import { PC_METRICS_RANK, blockedRankConditions, keywordFeedWeek, pcDefaultCondition, pcMetricsFor, rankMetricOptions, rankReadingNoun, ranksMeasured, unmeasuredRankMetrics, type KeywordFeedMeasured } from './PerformanceCriteria'

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

/**
 * Free visibility numbers (2026-10-10, A2–A5) — the builder reads the feed's own census (`feed.measured`): a rank the feed
 * holds no fresh reading of is listed but cannot be chosen, and a rule whose condition reads one is held at Create.
 */
describe('Keyword Tracker builder gating — never build a rule on a rank Amazon does not give', () => {
  const volumeOnly: KeywordFeedMeasured = { maxAgeDays: 14, freshRows: 300, organicRank: 0, sponsoredRank: 0, searchVolume: 300 }
  const imported: KeywordFeedMeasured = { maxAgeDays: 14, freshRows: 320, organicRank: 20, sponsoredRank: 0, searchVolume: 300 }

  it('opens on Search Volume, the one keyword metric with an Amazon source', () => {
    expect(pcDefaultCondition('keyword-tracker')).toEqual({ metric: 'Search Volume', op: 'gte', value: '' })
  })

  it('holds every rank while the feed fills Search Volume only, each with its reason', () => {
    const held = unmeasuredRankMetrics(volumeOnly)
    expect([...held.keys()].sort()).toEqual(['Organic Rank', 'Rank Change', 'Sponsored Rank'])
    expect(held.get('Organic Rank')).toContain('Amazon publishes no organic search position')
    expect(held.get('Sponsored Rank')).toContain('advertising console only')
    expect(held.get('Organic Rank')).toContain('14 days')
    const opts = rankMetricOptions(volumeOnly)
    expect(opts.filter((o) => o.heldReason).map((o) => o.value)).toEqual(['Organic Rank', 'Sponsored Rank', 'Rank Change'])
    expect(opts.find((o) => o.value === 'Search Volume')?.heldReason).toBeUndefined()
    expect(opts.map((o) => o.value)).toEqual(PC_METRICS_RANK.map((o) => o.value)) // nothing removed, stored values intact
  })

  it('frees a rank once a hand import gave it a fresh reading (Rank Change follows organic rank)', () => {
    expect([...unmeasuredRankMetrics(imported).keys()]).toEqual(['Sponsored Rank'])
  })

  it('holds nothing while the census is unknown — an unanswered fetch is not an empty feed', () => {
    expect(unmeasuredRankMetrics(null).size).toBe(0)
    expect(rankMetricOptions(undefined).some((o) => o.heldReason)).toBe(false)
    expect(blockedRankConditions([{ metric: 'Organic Rank' }], null)).toEqual([])
  })

  it('blocks Create on a condition that reads an unmeasured rank, and only then', () => {
    expect(blockedRankConditions([{ metric: 'Organic Rank' }, { metric: 'ACOS' }], volumeOnly)).toEqual(['Organic Rank'])
    expect(blockedRankConditions([{ metric: 'Rank Change' }, { metric: 'Rank Change' }], volumeOnly)).toEqual(['Rank Change'])
    expect(blockedRankConditions([{ metric: 'Search Volume' }, { metric: 'Spend' }], volumeOnly)).toEqual([])
    expect(blockedRankConditions([{ metric: 'Organic Rank' }], imported)).toEqual([])
  })

  it('names a reading by what it is, and hides rank columns only when no rank is measured', () => {
    expect(ranksMeasured(volumeOnly)).toBe(false)
    expect(ranksMeasured(imported)).toBe(true)
    expect(ranksMeasured(undefined)).toBeNull()
    expect(rankReadingNoun(volumeOnly)).toBe('search-volume reading')
    expect(rankReadingNoun(imported)).toBe('keyword reading')
    expect(rankReadingNoun(null)).toBe('keyword reading')
  })

  it('states the newest Brand Analytics week from its end date, and its age', () => {
    // the feed stores capturedAt = the week's Sunday start + 7 days
    expect(keywordFeedWeek('2026-10-11T00:00:00.000Z', new Date('2026-10-17T12:00:00Z'))).toEqual({ label: '4 Oct – 10 Oct', ageDays: 6 })
    expect(keywordFeedWeek(null)).toBeNull()
    expect(keywordFeedWeek('not a date')).toBeNull()
  })
})

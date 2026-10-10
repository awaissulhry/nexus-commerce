/**
 * B4 (2026-10-10) — GET /advertising/rank-runtime's signal words, tested where they are pure.
 *
 *   Top lane  the campaign's OWN daily shares, impression-weighted by Nexus, its own newest date for the age, and a
 *             label that names the window and the days behind it ("Top-IS 30-day wtd avg X% (n days)"). It was an
 *             unweighted mean aged by the MARKET's newest report, labelled "Top-IS X% · Nd".
 *   SQP lane  the family share from the SQP programme's reader, worded as a share computed by Nexus for a named week.
 *   Words     a non-zero share below 0.01 % reads "<0.01%", never 0.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

const { topIsReadingOf, topLaneSignal, sqpLaneSignal, sharePctWords, TOP_IS_WINDOW_DAYS } = await import('./rank-runtime.service.js')
const { weightedIS, mergeTopOfSearchReadings, tosSourceWords } = await import('./placement-grid.service.js')

const D = (s: string) => new Date(`${s}T00:00:00.000Z`)
const NOW = new Date('2026-10-10T12:00:00.000Z')

describe('topIsReadingOf', () => {
  it('impression-weighted, the days with a reading, and the campaign\'s own newest date', () => {
    const r = topIsReadingOf([
      { date: D('2026-10-01'), value: 0.6, weight: 100 },
      { date: D('2026-10-08'), value: 0.2, weight: 300 },
    ], weightedIS)!
    expect(r.share).toBeCloseTo((0.6 * 100 + 0.2 * 300) / 400, 12) // 0.30 — the unweighted mean said 0.40
    expect(r.days).toBe(2)
    expect(r.newest.toISOString().slice(0, 10)).toBe('2026-10-08')
  })

  it('no rows is no reading', () => {
    expect(topIsReadingOf([], weightedIS)).toBeNull()
  })

  it('review fix — names the source of its readings', () => {
    const r = topIsReadingOf([
      { date: D('2026-10-07'), value: 0.3, weight: 100, source: 'placement' },
      { date: D('2026-10-08'), value: 0.5, weight: 100, source: 'campaign' },
    ], weightedIS, tosSourceWords)!
    expect(r.source).toBe('Amazon\'s placement report (1 reading) and campaign report (1 reading)')
    expect(topLaneSignal('PLACEMENT_TOP', r, NOW).detail).toMatch(/ Source: Amazon's placement report \(1 reading\) and campaign report \(1 reading\)\.$/)
  })
})

describe('mergeTopOfSearchReadings — the placement table where it has the day, else the campaign report (review fix)', () => {
  it('one reading per campaign-day: the placement row first; a campaign row only for a day the placement table lacks', () => {
    const merged = mergeTopOfSearchReadings(
      [{ campaignId: 'E1', date: D('2026-10-07'), share: 0.3, impressions: 50 }],
      [
        { campaignId: 'E1', date: D('2026-10-07'), share: 0.9, impressions: 500 }, // the placement row has this day
        { campaignId: 'E1', date: D('2026-10-08'), share: 0.4, impressions: 400 },
        { campaignId: 'E2', date: D('2026-10-07'), share: 0.1, impressions: 100 },
      ],
    )
    expect(merged.map((m) => [m.campaignId, m.date.toISOString().slice(0, 10), m.share, m.source])).toEqual([
      ['E1', '2026-10-07', 0.3, 'placement'], ['E1', '2026-10-08', 0.4, 'campaign'], ['E2', '2026-10-07', 0.1, 'campaign'],
    ])
    expect(tosSourceWords(merged)).toBe('Amazon\'s placement report (1 reading) and campaign report (2 readings)')
    expect(tosSourceWords(merged.filter((m) => m.source === 'campaign'))).toBe('Amazon\'s campaign report (2 readings)')
  })
})

describe('topLaneSignal', () => {
  it('says the window, the weighting and the days, and ages by the campaign\'s own newest reading', () => {
    const s = topLaneSignal('PLACEMENT_TOP', { share: 0.3, days: 12, newest: D('2026-10-08') }, NOW)
    expect(s).toMatchObject({ kind: 'top-is', valuePct: 30, ageDays: 2, rows: 12, freshness: 'fresh', staleReason: null })
    expect(s.label).toBe(`Top-IS ${TOP_IS_WINDOW_DAYS}-day wtd avg 30.0% (12 days)`)
    expect(s.detail).toBe('The top-of-search impression share Amazon reported for this campaign (campaign level), averaged by Nexus '
      + '(impression-weighted) over the 12 days with a reading in the last 30: 30.0%. Newest reading 2026-10-08, 2 days old.')
  })

  it('stale when the campaign\'s own newest reading is more than 7 days old, and it says the date', () => {
    const s = topLaneSignal('PLACEMENT_TOP', { share: 0.3, days: 3, newest: D('2026-09-30') }, NOW)
    expect(s.freshness).toBe('stale')
    expect(s.staleReason).toMatch(/newest top-of-search share is from 2026-09-30, 10 days ago/)
  })

  it('no reading in the window: no signal, no age invented from another campaign', () => {
    const s = topLaneSignal('PLACEMENT_TOP', null, NOW)
    expect(s).toMatchObject({ kind: 'no-signal', valuePct: null, ageDays: null, label: 'no signal', freshness: 'never' })
  })

  it('a tiny real share is never shown as 0', () => {
    const s = topLaneSignal('PLACEMENT_TOP', { share: 0.00004, days: 1, newest: D('2026-10-09') }, NOW)
    expect(s.label).toContain('<0.01%')
    expect(s.valuePct).toBeGreaterThan(0)
  })
})

describe('sqpLaneSignal', () => {
  const reading = { share: 0.0123, ageDays: 12, weekStart: '2026-09-27', contributors: { withData: 3, total: 4 } }

  it('a share computed by Nexus from Amazon\'s weekly counts, for a named week — never a rank', () => {
    const s = sqpLaneSignal('PLACEMENT_REST_OF_SEARCH', 4, reading)
    expect(s).toMatchObject({ kind: 'sqp', valuePct: 1.23, ageDays: 12, rows: 3, contributors: { withData: 3, total: 4 } })
    expect(s.label).toBe('SQP 1.2% · week of 2026-09-27')
    expect(s.detail).toMatch(/computed by Nexus from Amazon's weekly Brand Analytics Search Query Performance counts/)
    expect(s.detail).toMatch(/week of 2026-09-27 \(started 12 days ago\)\. A share, not a rank\. Basis: 3 of 4 advertised ASINs\./)
  })

  it('a week with no query totals: no signal, never 0 %', () => {
    const s = sqpLaneSignal('PLACEMENT_REST_OF_SEARCH', 4, { ...reading, share: null })
    expect(s).toMatchObject({ kind: 'no-signal', valuePct: null, label: 'no signal' })
    expect(s.detail).toMatch(/the week of 2026-09-27 carries no query totals/)
  })
})

describe('sharePctWords', () => {
  it('<0.01% for a non-zero share below 0.01 %; two decimals below 1 %, one above', () => {
    expect(sharePctWords(0.00004)).toBe('<0.01%')
    expect(sharePctWords(0)).toBe('0.00%')
    expect(sharePctWords(0.0045)).toBe('0.45%')
    expect(sharePctWords(0.345)).toBe('34.5%')
  })
})

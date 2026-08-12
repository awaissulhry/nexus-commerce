/**
 * KT.4 — the series builder, which is the one place a chart can lie without anyone noticing.
 *
 * Two rules, both measured into existence:
 *   · a missing week is a GAP, not a zero. 46 of IT's 97 measured terms have a span longer than 7
 *     days somewhere in their history (DE 7 of 21, ES 5 of 7, FR 3 of 8), so this is the common case
 *     and a zero-filled series would draw 46 collapses that never happened.
 *   · share and spend share one timeline but neither is extended to the other's extent. Share stops
 *     23–30 days before spend today, and that distance is the feed's silence drawn to scale.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

const { buildSeries, weekStart } = await import('./keyword-term.service.js')

const sh = (week: string, share: number, clickShare = 0, asin: string | null = 'A1') => ({ week, share, clickShare, asin })
const sp = (week: string, cents: number, clicks = 0, orders = 0) => ({ week, cents, clicks, orders })

describe('buildSeries', () => {
  it('keeps a missing week ABSENT rather than zero-filling it', () => {
    // the real shape of `giubbotto moto estivo`: a 14-day span, then weekly
    const s = buildSeries([sh('2026-06-07', 0.01), sh('2026-06-21', 0.02), sh('2026-06-28', 0.03)], [])
    expect(s.points.map((p) => p.week)).toEqual(['2026-06-07', '2026-06-21', '2026-06-28'])
    expect(s.points.some((p) => p.share === 0)).toBe(false)
    expect(s.hasGaps).toBe(true)
  })

  it('reports no gap when every span is 7 days', () => {
    const s = buildSeries([sh('2026-07-05', 0.01), sh('2026-07-12', 0.02), sh('2026-07-19', 0.03)], [])
    expect(s.hasGaps).toBe(false)
  })

  it('counts share weeks so the caller can refuse to draw a line through fewer than 3', () => {
    expect(buildSeries([sh('2026-07-19', 0.01)], []).shareWeeks).toBe(1)
    expect(buildSeries([sh('2026-07-12', 0.01), sh('2026-07-19', 0.02)], []).shareWeeks).toBe(2)
    expect(buildSeries([sh('2026-07-05', 0.01), sh('2026-07-12', 0.02), sh('2026-07-19', 0.03)], []).shareWeeks).toBe(3)
  })

  it('takes our BEST ASIN per week, matching the row the grid renders', () => {
    const s = buildSeries([sh('2026-07-19', 0.006, 0.001, 'A1'), sh('2026-07-19', 0.070, 0.010, 'A2')], [])
    expect(s.points).toHaveLength(1)
    expect(s.points[0].share).toBeCloseTo(0.070)
    expect(s.points[0].asins).toBe(2)
  })

  it('puts spend on the same timeline WITHOUT extending the share series to meet it', () => {
    const s = buildSeries([sh('2026-07-19', 0.007)], [sp('2026-07-19', 500), sp('2026-08-10', 900)])
    expect(s.points.map((p) => p.week)).toEqual(['2026-07-19', '2026-08-10'])
    // the newer week has spend and NO share — the chart draws nothing there for share
    expect(s.points[1].share).toBeNull()
    expect(s.points[1].spendCents).toBe(900)
    expect(s.lastShareWeek).toBe('2026-07-19')
    expect(s.lastSpendWeek).toBe('2026-08-10')
    expect(s.shareTrailsSpendByDays).toBe(22)
  })

  it('sums several spend days into one week bucket', () => {
    const s = buildSeries([], [sp('2026-07-19', 100, 2, 1), sp('2026-07-19', 250, 3, 0)])
    expect(s.points[0].spendCents).toBe(350)
    expect(s.points[0].clicks).toBe(5)
    expect(s.points[0].orders).toBe(1)
  })

  it('measures gaps over the SHARE series only — spend cadence must not mask one', () => {
    // share jumps 14 days; spend is present every week, which must not hide the share gap
    const s = buildSeries(
      [sh('2026-06-07', 0.01), sh('2026-06-21', 0.02)],
      [sp('2026-06-07', 10), sp('2026-06-14', 10), sp('2026-06-21', 10)],
    )
    expect(s.hasGaps).toBe(true)
  })

  it('is empty, not broken, for a term with nothing at all', () => {
    const s = buildSeries([], [])
    expect(s).toMatchObject({ points: [], shareWeeks: 0, hasGaps: false, lastShareWeek: null, shareTrailsSpendByDays: null })
  })
})

describe('weekStart', () => {
  it('buckets any day to the Monday of its ISO week — the bucket SQP startDate uses', () => {
    // 2026-07-19 is a Sunday; 2026-07-13 is the Monday of that week
    expect(weekStart(new Date('2026-07-15T00:00:00Z')).toISOString().slice(0, 10)).toBe('2026-07-13')
    expect(weekStart(new Date('2026-07-13T00:00:00Z')).toISOString().slice(0, 10)).toBe('2026-07-13')
    expect(weekStart(new Date('2026-07-19T23:59:00Z')).toISOString().slice(0, 10)).toBe('2026-07-13')
  })
})

/**
 * 🔴 The cap, which a measurement caught before this shipped.
 *
 * ES's gate picks 2026-07-12 because 07-19 holds 193 rows against a 207-row threshold. But 07-19 has
 * rows for ES's terms, so an uncapped series ended there — putting a week the page had already judged
 * incomplete at the chart's right edge, one line beneath a header reading "as of 12 Jul".
 */
describe('buildSeries · the completeness cap', () => {
  const rows = [sh('2026-07-05', 0.01), sh('2026-07-12', 0.02), sh('2026-07-19', 0.03)]

  it('drops share weeks NEWER than the gate\'s chosen period', () => {
    const s = buildSeries(rows, [], '2026-07-12')
    expect(s.points.filter((p) => p.share != null).map((p) => p.week)).toEqual(['2026-07-05', '2026-07-12'])
    expect(s.lastShareWeek).toBe('2026-07-12')
    expect(s.shareWeeksExcluded).toBe(1)
  })

  it('keeps everything when the cap IS the newest week (IT and DE today)', () => {
    const s = buildSeries(rows, [], '2026-07-19')
    expect(s.shareWeeks).toBe(3)
    expect(s.shareWeeksExcluded).toBe(0)
  })

  it('does NOT cap spend — a different feed, and its overhang is the point', () => {
    const s = buildSeries(rows, [sp('2026-08-10', 900)], '2026-07-12')
    expect(s.lastSpendWeek).toBe('2026-08-10')
    // 07-12 → 08-10 is 29 days, which is what KT.5 measured for ES
    expect(s.shareTrailsSpendByDays).toBe(29)
  })

  it('no cap means no exclusion, so existing callers are unaffected', () => {
    expect(buildSeries(rows, []).shareWeeksExcluded).toBe(0)
    expect(buildSeries(rows, []).lastShareWeek).toBe('2026-07-19')
  })
})

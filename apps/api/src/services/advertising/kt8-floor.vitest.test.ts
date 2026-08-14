/**
 * KT.8 — the completeness floor.
 *
 * Written before the implementation and run against it to watch them fail. The four properties that
 * matter are the ones SQP.4's analysis turns on: REPLACEMENT (not OR, not AND), refusal when nothing
 * qualifies, non-vacuity as the population becomes homogeneous, and the opt-in boundary that keeps
 * Share of Voice on the old behaviour.
 */
import { describe, it, expect } from 'vitest'
import { chooseViewPeriod, KT_COVERAGE_FLOOR, SQP_COMPLETENESS_RATIO } from './keyword-tracker.service.js'

const D = (s: string) => new Date(`${s}T00:00:00.000Z`)
const NOW = D('2026-08-15').getTime()

/**
 * IT exactly as measured 2026-08-14 — all twelve stored weeks, rows and coverage.
 *
 * 🔴 The full twelve matter: the baseline is `median(sorted.slice(0, SQP_BASELINE_PERIODS))` with
 * `SQP_BASELINE_PERIODS = 12`, so a four-week fixture produces a median of 456.5 instead of the real
 * 558.5 and the ratio then *accepts* 2026-08-02 — the opposite of production. The first draft of this
 * file made that mistake and the legacy-behaviour test caught it.
 */
const IT = [
  { start: D('2026-08-02'), rows: 258, asins: 12 },
  { start: D('2026-07-26'), rows: 8, asins: 4 },
  { start: D('2026-07-19'), rows: 655, asins: 19 },
  { start: D('2026-07-12'), rows: 1066, asins: 13 },
  { start: D('2026-07-05'), rows: 989, asins: 13 },
  { start: D('2026-06-28'), rows: 857, asins: 13 },
  { start: D('2026-06-21'), rows: 1042, asins: 13 },
  { start: D('2026-06-14'), rows: 921, asins: 12 },
  { start: D('2026-06-07'), rows: 462, asins: 8 },
  { start: D('2026-05-31'), rows: 158, asins: 6 },
  { start: D('2026-05-24'), rows: 376, asins: 8 },
  { start: D('2026-05-17'), rows: 1, asins: 1 },
]
/** FR as measured: never more than 4 covered ASINs inside the lookback. */
const FR = [
  { start: D('2026-08-02'), rows: 1, asins: 1 },
  { start: D('2026-07-26'), rows: 1, asins: 1 },
  { start: D('2026-07-19'), rows: 4, asins: 3 },
  { start: D('2026-07-12'), rows: 42, asins: 4 },
]

describe('the floor REPLACES the ratio', () => {
  it('picks the freshest week that meets the floor, even though the ratio rejects it', () => {
    // 258 rows against a threshold of 279.25 — the ratio says no; 12 ASINs says yes.
    const c = chooseViewPeriod(IT, { now: NOW, floorAsins: 5 })
    expect(c.start).toEqual(D('2026-08-02'))
    expect(c.reason).toBe('complete')
    expect(c.truncated).toBe(false)
  })

  it('🔴 is not an OR — a week that clears the ratio but misses the floor is REJECTED', () => {
    // The shape an earlier model used, which reported FR as fixed when it was not: under `ratio OR
    // floor`, FR's 07-12 clears the ratio (42 rows vs 32.5) and silently keeps a 4-ASIN week.
    const c = chooseViewPeriod(FR, { now: NOW, floorAsins: 5 })
    expect(c.start).not.toEqual(D('2026-07-12'))
    expect(c.reason).not.toBe('complete')
  })

  it('🔴 is not an AND either — IT would break, since 258 rows misses the ratio', () => {
    const c = chooseViewPeriod(IT, { now: NOW, floorAsins: 5 })
    expect(c.rows).toBe(258)
    expect(c.start).toEqual(D('2026-08-02'))
  })

  it('reports the floor it used, not a row threshold', () => {
    const c = chooseViewPeriod(IT, { now: NOW, floorAsins: 5 })
    expect(c.floorAsins).toBe(5)
    expect(c.asins).toBe(12)
  })
})

describe('refusal — FR has never had a qualifying week', () => {
  it('refuses every FR week and says the view is truncated', () => {
    const c = chooseViewPeriod(FR, { now: NOW, floorAsins: KT_COVERAGE_FLOOR })
    expect(c.truncated).toBe(true)
    expect(c.reason).toBe('incomplete-week')
  })

  it('still renders the newest week rather than an empty grid', () => {
    const c = chooseViewPeriod(FR, { now: NOW, floorAsins: KT_COVERAGE_FLOOR })
    expect(c.start).toEqual(D('2026-08-02'))
    expect(c.asins).toBe(1)
  })

  it('does not list the period it chose as one it rejected', () => {
    // KT.1b's rule: `rejected` means "newer than the one we chose". On the fallback path the chosen
    // period IS the newest, so nothing may be listed.
    const c = chooseViewPeriod(FR, { now: NOW, floorAsins: KT_COVERAGE_FLOOR })
    expect(c.rejected).toEqual([])
  })
})

describe('🔴 non-vacuity — the property the ratio loses and the floor must not', () => {
  it('still refuses a one-ASIN week after the population becomes homogeneous', () => {
    // 12 consecutive thin weeks: the ratio's median collapses to the thinness it is meant to catch
    // and passes everything. A fixed floor cannot, because it is not computed from our own output.
    const thin = Array.from({ length: 12 }, (_, i) => ({
      start: new Date(D('2026-08-02').getTime() - i * 7 * 86_400_000), rows: 1, asins: 1,
    }))
    const ratio = chooseViewPeriod(thin, { now: NOW })
    const floor = chooseViewPeriod(thin, { now: NOW, floorAsins: KT_COVERAGE_FLOOR })
    expect(ratio.reason).toBe('complete')      // vacuous: 1 row passes a threshold of 0.5
    expect(floor.truncated).toBe(true)         // the floor still refuses
  })
})

describe('the opt-in boundary — Share of Voice must not move', () => {
  it('without floorAsins, behaves exactly as before', () => {
    const c = chooseViewPeriod(IT, { now: NOW })
    expect(c.baselineRows).toBe(558.5)         // the real 12-period median
    expect(c.threshold).toBe(279.25)
    expect(c.start).toEqual(D('2026-07-19'))   // the ratio's answer, unchanged — 258 < 279.25
    expect(c.threshold).toBe(SQP_COMPLETENESS_RATIO * c.baselineRows)
    expect(c.floorAsins).toBeNull()
  })

  it('treats a missing asins field as zero rather than as passing', () => {
    const noCoverage = IT.map(({ start, rows }) => ({ start, rows }))
    const c = chooseViewPeriod(noCoverage, { now: NOW, floorAsins: 5 })
    expect(c.truncated).toBe(true)             // nothing can qualify without evidence
  })
})

describe('KT_COVERAGE_FLOOR', () => {
  it('is 5 — half the nightly per-market request budget', () => {
    expect(KT_COVERAGE_FLOOR).toBe(5)
  })
})

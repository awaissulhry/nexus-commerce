/**
 * SQP catch-up — which missed weeks the nightly pass asks for again. Pure: the facts are handed in.
 *
 * The state this exists for (measured 2026-10-07): IT holds no week after 2026-08-16, DE none after
 * 08-23, ES none after 09-06, and nothing ever asked for those weeks again.
 */
import { describe, expect, it } from 'vitest'
import { catchUpLookbacks, planCatchUp, weekKey, type CatchUpMarket, type CatchUpWeek } from './sqp-catchup.js'

const wk = (iso: string): CatchUpWeek => {
  const start = new Date(`${iso}T00:00:00Z`)
  const end = new Date(start); end.setUTCDate(start.getUTCDate() + 6)
  return { start, end }
}
// 2026-10-07 (a Wednesday): lookback 2 … 6, newest first.
const WEEKS = ['2026-09-20', '2026-09-13', '2026-09-06', '2026-08-30', '2026-08-23'].map(wk)

const market = (mkt: string, proven: string[], answered: Record<string, string[]> = {}): CatchUpMarket => ({
  mkt, proven, answered: new Map(Object.entries(answered).map(([k, v]) => [k, new Set(v)])),
})

describe('planCatchUp', () => {
  it("asks for every market's newest gap before any market's older one, and stops at the nightly cap", () => {
    const out = planCatchUp({
      markets: [market('IT', ['I1', 'I2']), market('DE', ['D1']), market('ES', ['E1'])],
      weeks: WEEKS, maxUnits: 4, asinsPerWeek: 6,
    })
    expect(out.units.map((u) => `${u.mkt} ${weekKey(u.week.start)}`)).toEqual([
      'IT 2026-09-20', 'DE 2026-09-20', 'ES 2026-09-20', 'IT 2026-09-13',
    ])
    // Every gap is counted, so the summary can say how many are left for later nights.
    expect(out.gaps).toBe(15)
  })

  it('asks only for the top proven ASINs of a week, in yield order', () => {
    const out = planCatchUp({ markets: [market('IT', ['A', 'B', 'C', 'D'])], weeks: [WEEKS[0]], maxUnits: 4, asinsPerWeek: 2 })
    expect(out.units[0].asins).toEqual(['A', 'B'])
  })

  it('leaves out ASINs that already have an answer for that week, and skips a covered week without spending the cap', () => {
    const out = planCatchUp({
      markets: [market('IT', ['A', 'B'], { '2026-09-20': ['A', 'B'], '2026-09-13': ['A'] })],
      weeks: WEEKS, maxUnits: 2, asinsPerWeek: 2,
    })
    expect(out.units.map((u) => [weekKey(u.week.start), u.asins])).toEqual([
      ['2026-09-13', ['B']],
      ['2026-09-06', ['A', 'B']],
    ])
  })

  it('🔴 a covered week stays covered: it does not reach further down the ranking for new ASINs', () => {
    // The top two are answered; C and D are proven too, but asking for them every night would never end.
    const out = planCatchUp({
      markets: [market('IT', ['A', 'B', 'C', 'D'], { '2026-09-20': ['A', 'B'] })],
      weeks: [WEEKS[0]], maxUnits: 4, asinsPerWeek: 2,
    })
    expect(out).toEqual({ units: [], gaps: 0 })
  })

  it('a market with no proven ASIN has nothing to catch up (no history to fill)', () => {
    expect(planCatchUp({ markets: [market('FR', [])], weeks: WEEKS, maxUnits: 4, asinsPerWeek: 6 })).toEqual({ units: [], gaps: 0 })
  })

  it('a cap of 0 asks for nothing but still counts the gaps', () => {
    const out = planCatchUp({ markets: [market('IT', ['A'])], weeks: WEEKS, maxUnits: 0, asinsPerWeek: 6 })
    expect(out.units).toEqual([])
    expect(out.gaps).toBe(5)
  })
})

describe('catchUpLookbacks', () => {
  it('runs from the first week after the normal one to the last that still serves Share of Voice', () => {
    // SQP_LOOKBACK = 1 is the normal week; SOV_DEFAULT_WEEKS 8 - 2 = 6.
    expect(catchUpLookbacks(2, 6)).toEqual([2, 3, 4, 5, 6])
    expect(catchUpLookbacks(7, 6)).toEqual([])
  })
})

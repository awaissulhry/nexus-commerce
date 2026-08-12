/**
 * BSP.1 — the burn-down's arithmetic, pinned.
 *
 * Two of these tests exist because the property they check is invisible on screen until it is
 * wrong: `materialiseCalendar` must emit every day of the month (a partial calendar makes the
 * server's `expectedPct` read 0% instead of 17.1%), and the linear/calendar forecasts must be
 * provably identical on an even split, so that any divergence the chart discloses is genuinely the
 * calendar and not a rounding artefact of mine.
 */
import { describe, it, expect } from 'vitest'
import {
  cumulative, materialiseCalendar, boostedDays, calendarTotal, expectedCurve,
  linearForecastCents, calendarForecastCents, forecastDisclosure, statusBand, burnDownSeries,
  STATUS_BAND_PCT,
} from './planMath'

describe('cumulative', () => {
  it('runs a total and keeps the length', () => {
    expect(cumulative([100, 200, 50])).toEqual([100, 300, 350])
    expect(cumulative([])).toEqual([])
  })
  it('treats holes as zero rather than NaN', () => {
    expect(cumulative([100, undefined as unknown as number, 50])).toEqual([100, 100, 150])
  })
})

describe('materialiseCalendar — every day, or expectedPct is wrong', () => {
  it('emits one entry per day of the month', () => {
    expect(materialiseCalendar([], 31)).toHaveLength(31)
    expect(materialiseCalendar([{ day: 5, pct: 20 }], 30)).toHaveLength(30)
    expect(materialiseCalendar([], 28)).toHaveLength(28)
  })

  it('an empty boost list is an even split summing to 100', () => {
    const c = materialiseCalendar([], 31)
    expect(calendarTotal(c)).toBeCloseTo(100, 6)
    expect(c.every((d) => Math.abs(d.pct - 100 / 31) < 1e-9)).toBe(true)
  })

  it('boosted days keep their value and the rest share the remainder', () => {
    const c = materialiseCalendar([{ day: 28, pct: 20 }, { day: 29, pct: 20 }], 31)
    expect(calendarTotal(c)).toBeCloseTo(100, 6)
    expect(c.find((d) => d.day === 28)!.pct).toBe(20)
    expect(c.find((d) => d.day === 29)!.pct).toBe(20)
    // 60 left over 29 remaining days
    expect(c.find((d) => d.day === 1)!.pct).toBeCloseTo(60 / 29, 9)
  })

  it('🔴 the partial-calendar bug: a 3-day calendar reads 0%, the materialised one reads 17%', () => {
    const daysInMonth = 31, dayOfMonth = 12
    const partial = [{ day: 28, pct: 20 }, { day: 29, pct: 20 }, { day: 30, pct: 20 }]
    const serverExpectedPct = (cal: Array<{ day: number; pct: number }>) =>
      cal.filter((c) => c.day <= dayOfMonth).reduce((a, c) => a + c.pct, 0) / 100
    // 60% is booked on days 28-30, so a PARTIAL calendar claims we should have spent nothing at
    // all by day 12 — the plan would read "over" from the first euro.
    expect(serverExpectedPct(partial)).toBe(0)
    const full = materialiseCalendar(partial, daysInMonth)
    // Materialised, the 40% remainder spreads over the other 28 days: 12 x 1.43% = 17.1%. Lower
    // than an even split's 38.7%, and correctly so — this calendar IS back-loaded.
    expect(serverExpectedPct(full)).toBeCloseTo((12 * (40 / 28)) / 100, 6)
    expect(serverExpectedPct(full)).toBeGreaterThan(0.15)
  })

  it('ignores days outside the month and de-duplicates', () => {
    const c = materialiseCalendar([{ day: 0, pct: 50 }, { day: 32, pct: 50 }, { day: 3, pct: 10 }, { day: 3, pct: 15 }], 31)
    expect(c).toHaveLength(31)
    expect(c.find((d) => d.day === 3)!.pct).toBe(15)
    expect(calendarTotal(c)).toBeCloseTo(100, 6)
  })

  it('does not silently rescale an over-100 boost — the caller must warn', () => {
    const c = materialiseCalendar([{ day: 1, pct: 90 }, { day: 2, pct: 50 }], 31)
    expect(calendarTotal(c)).toBeCloseTo(140, 6)
    expect(c.find((d) => d.day === 3)!.pct).toBe(0)
  })

  it('round-trips through boostedDays', () => {
    const boosted = [{ day: 28, pct: 20 }, { day: 29, pct: 25 }]
    expect(boostedDays(materialiseCalendar(boosted, 31), 31)).toEqual(boosted)
    expect(boostedDays(materialiseCalendar([], 31), 31)).toEqual([])
  })
})

describe('expectedCurve', () => {
  it('an empty calendar is a straight even ramp to the cap', () => {
    const c = expectedCurve(310000, 31, [])
    expect(c).toHaveLength(31)
    expect(c[0]).toBe(10000)
    expect(c[30]).toBe(310000)
  })

  it('a calendar bends the curve and still lands on the cap', () => {
    const cal = materialiseCalendar([{ day: 31, pct: 50 }], 31)
    const c = expectedCurve(100000, 31, cal)
    expect(c[30]).toBe(100000)
    expect(c[29]).toBeCloseTo(50000, -2)   // half the month's budget is on the last day
  })
})

describe('the forecast, and its two models', () => {
  it('reproduces the service formula exactly', () => {
    expect(linearForecastCents(115274, 12, 31)).toBe(Math.round((115274 / 12) * 31))
    expect(linearForecastCents(0, 0, 31)).toBeNull()
  })

  it('🔴 on an even split the two models are identical, so any divergence IS the calendar', () => {
    const daysInMonth = 31, dayOfMonth = 12, spend = 115274
    const evenExpectedPct = dayOfMonth / daysInMonth
    expect(calendarForecastCents(spend, evenExpectedPct)).toBe(linearForecastCents(spend, dayOfMonth, daysInMonth))
    const d = forecastDisclosure({ spendCents: spend, dayOfMonth, daysInMonth, expectedPct: evenExpectedPct, hasCalendar: false })
    expect(d.diverges).toBe(false)
    expect(d.divergenceCents).toBe(0)
  })

  it('🔴 a tentpole calendar makes them disagree, and the disclosure says so', () => {
    const daysInMonth = 31, dayOfMonth = 12, spend = 100000
    // half the budget is planned for the last three days, so by day 12 we are only ~19% through plan
    const cal = materialiseCalendar([{ day: 29, pct: 17 }, { day: 30, pct: 17 }, { day: 31, pct: 16 }], daysInMonth)
    const expectedPct = cal.filter((c) => c.day <= dayOfMonth).reduce((a, c) => a + c.pct, 0) / 100
    const d = forecastDisclosure({ spendCents: spend, dayOfMonth, daysInMonth, expectedPct, hasCalendar: true })
    expect(d.diverges).toBe(true)
    expect(d.linearCents).not.toBe(d.calendarCents)
    // the calendar says the month lands HIGHER than the naive line, because the spend is back-loaded
    expect(d.calendarCents!).toBeGreaterThan(d.linearCents!)
  })

  it('always reports the sample size the projection rests on', () => {
    expect(forecastDisclosure({ spendCents: 100, dayOfMonth: 4, daysInMonth: 31, expectedPct: 4 / 31, hasCalendar: false }).basisDays).toBe(4)
    expect(forecastDisclosure({ spendCents: 100, dayOfMonth: 28, daysInMonth: 31, expectedPct: 28 / 31, hasCalendar: false }).basisDays).toBe(28)
  })

  it('the day-4 instability the study measured is visible in the numbers', () => {
    // €100 spent by day 4 projects the month at €775 — a 7.75x multiplier on a four-day sample
    expect(linearForecastCents(10000, 4, 31)).toBe(77500)
    expect(linearForecastCents(10000, 28, 31)).toBe(11071)
  })
})

describe('statusBand — the ±10 point dead band', () => {
  it('is 10 percentage points either side', () => {
    expect(STATUS_BAND_PCT).toBe(0.1)
    const b = statusBand(0.43, 0.387)!
    expect(b.insideBand).toBe(true)
    expect(b.deltaPct).toBeCloseTo(0.043, 6)
  })

  it('an 8-point overshoot still reads on-track, which is why the band is shown', () => {
    const b = statusBand(0.467, 0.387)!
    expect(b.insideBand).toBe(true)
    expect(b.deltaPct).toBeCloseTo(0.08, 6)
  })

  it('11 points is outside', () => {
    expect(statusBand(0.497, 0.387)!.insideBand).toBe(false)
  })

  it('is null when there is no cap to divide by', () => {
    expect(statusBand(null, 0.387)).toBeNull()
  })
})

describe('burnDownSeries', () => {
  const daily = Array.from({ length: 12 }, () => 10000) // €100/day for 12 days

  it('emits one point per day of the month, not per day of data', () => {
    const s = burnDownSeries({ daily, capCents: 400000, daysInMonth: 31, dayOfMonth: 12, calendar: [], forecastCents: 310000 })
    expect(s).toHaveLength(31)
    expect(s[0].day).toBe(1)
    expect(s[30].day).toBe(31)
  })

  it('the actual line stops at today instead of falling to zero', () => {
    const s = burnDownSeries({ daily, capCents: 400000, daysInMonth: 31, dayOfMonth: 12, calendar: [], forecastCents: 310000 })
    expect(s[11].actual).toBe(120000)
    expect(s[12].actual).toBeNull()
    expect(s[30].actual).toBeNull()
  })

  it('the forecast tail starts where the actual line ends, so it is visibly continuous', () => {
    const s = burnDownSeries({ daily, capCents: 400000, daysInMonth: 31, dayOfMonth: 12, calendar: [], forecastCents: 310000 })
    expect(s[11].forecast).toBe(120000)   // day 12: same point as actual
    expect(s[10].forecast).toBeNull()     // nothing before today
    expect(s[30].forecast).toBe(310000)   // lands exactly on the forecast
  })

  it('expected covers every day even where actual does not', () => {
    const s = burnDownSeries({ daily, capCents: 310000, daysInMonth: 31, dayOfMonth: 12, calendar: [], forecastCents: null })
    expect(s.every((p) => typeof p.expected === 'number')).toBe(true)
    expect(s[30].expected).toBe(310000)
  })

  it('survives a null forecast and a zero-day month edge', () => {
    const s = burnDownSeries({ daily: [], capCents: 0, daysInMonth: 31, dayOfMonth: 0, calendar: [], forecastCents: null })
    expect(s).toHaveLength(31)
    expect(s.every((p) => p.forecast === null)).toBe(true)
  })

  it('on the last day of the month the forecast is the target, with no divide-by-zero', () => {
    const s = burnDownSeries({ daily: Array.from({ length: 31 }, () => 10000), capCents: 310000, daysInMonth: 31, dayOfMonth: 31, calendar: [], forecastCents: 310000 })
    expect(s[30].forecast).toBe(310000)
    expect(Number.isFinite(s[30].forecast!)).toBe(true)
  })
})

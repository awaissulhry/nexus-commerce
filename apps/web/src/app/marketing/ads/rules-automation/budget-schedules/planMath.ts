/**
 * ⛔ PARKED 2026-08-18 (U8) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the pacing/plan arithmetic (pure).
 * Why it left: the Budget Schedules tab is now Helium 10's shape — the hourly-performance card over
 *   the schedules grid, and nothing else (`BudgetSchedulesTabClient.tsx`; study
 *   `docs/2026-08-16-ra-h10-reference-study.md` §3.7, §7.9).
 * Candidate home: travels with PlanEditor + PacingBand.
 *
 * ⚠ Nothing here was changed and no endpoint was retired — `/budget-manager*`, `/budget-binding`
 * and `/budget-schedules*` are all still served. The file stays at this path on purpose:
 * re-mounting it is one import. Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */
/**
 * BSP.1 — the burn-down's arithmetic, as a pure module.
 *
 * Every number the chart draws is computed here so it can be tested without a browser, and so the
 * two disclosures the chart is required to make are derived rather than asserted.
 *
 * ── The two things this module exists to make honest ───────────────────────────────────────────
 *
 * 1. **The forecast is a naive linear extrapolation.** `ads-budget-manager.service.ts:147` computes
 *    `forecastSpendCents = (spendCents / dayOfMonth) × daysInMonth`. On day 4 that multiplies a
 *    four-day sample by 7.75, and that instability is not hypothetical — it is what produced 2,387
 *    budget writes in six days (study §3), a storm that stopped on its own once the denominator
 *    grew. So the chart prints its sample size next to the number.
 *
 * 2. 🔴 **The forecast and the expected line use different models, by construction.**
 *    `expectedPct` (`:140`) is calendar-weighted; `forecastSpendCents` (`:147`) ignores the calendar
 *    entirely. On an even-split plan they agree exactly — see the test — but on a plan with a
 *    tentpole calendar they diverge, and the chart would show a forecast that does not follow its
 *    own expected curve. That is a real property of the live service, not a bug in this page, and
 *    the fix is to disclose it rather than to quietly "correct" a service that writes to production
 *    every 30 minutes.
 */

/** A calendar entry as `AdBudgetPlan.calendar` stores it. */
export interface CalendarDay { day: number; pct: number }

/** Running total of a per-day series. Index 0 = day 1. */
export function cumulative(daily: number[]): number[] {
  const out: number[] = []
  let acc = 0
  for (const v of daily) { acc += v ?? 0; out.push(acc) }
  return out
}

/**
 * 🔴 A calendar must cover EVERY day of the month, or `expectedPct` is silently wrong.
 *
 * The server computes `expectedPct` as `sum(pct where day <= dayOfMonth) / 100`. A calendar holding
 * only the days an operator boosted would therefore make the expected line the sum of those few
 * days. Measured in the test: a calendar holding only days 28-30 says we should have spent **0%**
 * by day 12, so the plan reads "over" from the first euro. Materialised, the same intent reads
 * 17.1% — lower than an even split's 38.7%, and correctly so, because that calendar IS back-loaded.
 *
 * So the editor's UI is a short list of boosted days, and this function is what it saves: the full
 * `daysInMonth` entries, with the unboosted days sharing whatever percentage is left. What the bar
 * strip renders is this output, not the input, so what you see is what is stored.
 *
 * Boosted days that exceed 100 in total are kept as given and the remainder is zero — the caller is
 * responsible for warning, because silently rescaling an operator's explicit numbers is worse than
 * showing them a total that says 140%.
 */
export function materialiseCalendar(boosted: CalendarDay[], daysInMonth: number): CalendarDay[] {
  const byDay = new Map<number, number>()
  for (const b of boosted) {
    if (!Number.isFinite(b.day) || b.day < 1 || b.day > daysInMonth) continue
    byDay.set(Math.trunc(b.day), Math.max(0, b.pct))
  }
  const boostedTotal = [...byDay.values()].reduce((a, v) => a + v, 0)
  const restDays = daysInMonth - byDay.size
  const remainder = Math.max(0, 100 - boostedTotal)
  const perRest = restDays > 0 ? remainder / restDays : 0

  const out: CalendarDay[] = []
  for (let d = 1; d <= daysInMonth; d++) {
    out.push({ day: d, pct: byDay.has(d) ? (byDay.get(d) as number) : perRest })
  }
  return out
}

/**
 * What the operator typed, recovered from a stored full calendar.
 *
 * 🔴 NOT "the days that differ from 100/daysInMonth". Once anything is boosted, the *remaining*
 * days no longer carry the even share either — boosting two days to 20% leaves the other 29 on
 * 1.90%, not 3.23% — so comparing against the even share reports all 31 days as boosted and the
 * editor reopens with 31 rows instead of 2. The rest-share is whatever value the most days agree
 * on, so the modal pct is the baseline and everything else is a boost.
 */
export function boostedDays(calendar: CalendarDay[], _daysInMonth: number): CalendarDay[] {
  if (!calendar.length) return []
  // Bucket by rounded pct so JSON float noise does not split one baseline into many.
  const buckets = new Map<string, number>()
  for (const c of calendar) {
    const k = c.pct.toFixed(6)
    buckets.set(k, (buckets.get(k) ?? 0) + 1)
  }
  let modal = 0, best = -1
  for (const [k, n] of buckets) if (n > best) { best = n; modal = Number(k) }
  // Every day sharing the modal value is the untouched remainder; a calendar where nothing repeats
  // is fully hand-authored, and then every day is legitimately a boost.
  return calendar.filter((c) => Math.abs(c.pct - modal) > 0.005).map((c) => ({ day: c.day, pct: c.pct }))
}

/** Sum of a calendar, for the "total must be 100%" readout. */
export const calendarTotal = (calendar: CalendarDay[]): number =>
  calendar.reduce((a, c) => a + (Number.isFinite(c.pct) ? c.pct : 0), 0)

/**
 * The expected cumulative spend curve, in cents, one point per day of the month.
 *
 * Calendar-weighted when a calendar exists, an even split otherwise — the same branch the server
 * takes for `expectedPct`, so the curve and the status chip cannot disagree.
 */
export function expectedCurve(capCents: number, daysInMonth: number, calendar: CalendarDay[]): number[] {
  const out: number[] = []
  if (calendar.length) {
    const byDay = new Map(calendar.map((c) => [c.day, c.pct]))
    let acc = 0
    for (let d = 1; d <= daysInMonth; d++) { acc += byDay.get(d) ?? 0; out.push(Math.round((acc / 100) * capCents)) }
    return out
  }
  for (let d = 1; d <= daysInMonth; d++) out.push(Math.round((d / daysInMonth) * capCents))
  return out
}

/**
 * The projection the SERVER makes, restated here only so the chart can draw it and compare it.
 * Deliberately identical to `:147` including its naivety — this is not a better forecast.
 */
export const linearForecastCents = (spendCents: number, dayOfMonth: number, daysInMonth: number): number | null =>
  dayOfMonth > 0 ? Math.round((spendCents / dayOfMonth) * daysInMonth) : null

/**
 * The projection the plan's OWN calendar implies: if you are `expectedPct` of the way through your
 * planned spend and have spent `spendCents`, the month lands at `spendCents / expectedPct`.
 *
 * On an even-split plan `expectedPct` is `dayOfMonth / daysInMonth`, so this reduces exactly to the
 * linear forecast. Any difference between the two is the calendar, and that is the point.
 */
export const calendarForecastCents = (spendCents: number, expectedPct: number): number | null =>
  expectedPct > 0 ? Math.round(spendCents / expectedPct) : null

export interface ForecastDisclosure {
  /** The server's number, which is what the band and the status chip use. */
  linearCents: number | null
  /** What the plan's calendar implies. Equal to `linearCents` on an even-split plan. */
  calendarCents: number | null
  /** How many days the projection is built on. 4 is a very different number from 28. */
  basisDays: number
  /** True when the two models disagree by enough to be worth a sentence. */
  diverges: boolean
  /** Signed difference, cents. Positive = the linear forecast is the higher of the two. */
  divergenceCents: number
}

/** Below this the two models are the same number for display purposes. €1. */
const DIVERGENCE_FLOOR_CENTS = 100

export function forecastDisclosure(opts: {
  spendCents: number
  dayOfMonth: number
  daysInMonth: number
  expectedPct: number
  hasCalendar: boolean
}): ForecastDisclosure {
  const linearCents = linearForecastCents(opts.spendCents, opts.dayOfMonth, opts.daysInMonth)
  const calendarCents = opts.hasCalendar ? calendarForecastCents(opts.spendCents, opts.expectedPct) : linearCents
  const divergenceCents = linearCents != null && calendarCents != null ? linearCents - calendarCents : 0
  return {
    linearCents,
    calendarCents,
    basisDays: opts.dayOfMonth,
    diverges: opts.hasCalendar && Math.abs(divergenceCents) >= DIVERGENCE_FLOOR_CENTS,
    divergenceCents,
  }
}

/**
 * The status dead band, restated so the page can show it.
 *
 * `:145-146` classifies `over` at `pct > expectedPct + 0.1` and `under` at `pct < expectedPct - 0.1`
 * — a **±10 percentage-point** tolerance on a ratio. An operator looking at "on-track" while sitting
 * 8 points over pace deserves to be told the band exists, because 8 points of €4,000 is €320.
 */
export const STATUS_BAND_PCT = 0.1

export interface StatusBand { lowPct: number; highPct: number; deltaPct: number; insideBand: boolean }

export function statusBand(pct: number | null, expectedPct: number): StatusBand | null {
  if (pct == null) return null
  return {
    lowPct: Math.max(0, expectedPct - STATUS_BAND_PCT),
    highPct: expectedPct + STATUS_BAND_PCT,
    deltaPct: pct - expectedPct,
    insideBand: Math.abs(pct - expectedPct) <= STATUS_BAND_PCT,
  }
}

export interface BurnPoint {
  day: number
  /** Cumulative actual spend, cents. null after today — the month has not happened yet. */
  actual: number | null
  /** Cumulative expected spend, cents, for every day of the month. */
  expected: number
  /** The forecast tail: null up to today, then a straight line to the month-end forecast. */
  forecast: number | null
}

/**
 * The chart's rows. One per day of the month, so the x-axis is the month rather than the data.
 *
 * The actual series stops at today rather than dropping to zero — a cumulative line that falls off
 * a cliff on day 13 reads as "spending stopped", which is the opposite of what it means.
 */
export function burnDownSeries(opts: {
  daily: number[]
  capCents: number
  daysInMonth: number
  dayOfMonth: number
  calendar: CalendarDay[]
  forecastCents: number | null
}): BurnPoint[] {
  const actualCum = cumulative(opts.daily)
  const expected = expectedCurve(opts.capCents, opts.daysInMonth, opts.calendar)
  const today = Math.min(opts.dayOfMonth, opts.daysInMonth)
  const spentSoFar = actualCum.length ? actualCum[Math.min(today, actualCum.length) - 1] ?? 0 : 0
  const target = opts.forecastCents

  const out: BurnPoint[] = []
  for (let d = 1; d <= opts.daysInMonth; d++) {
    const isPast = d <= today
    let forecast: number | null = null
    if (target != null && d >= today) {
      // A straight line from where we actually are to where the month is projected to land, so the
      // tail visibly continues the actual line instead of floating detached from it.
      const span = opts.daysInMonth - today
      forecast = span <= 0 ? target : Math.round(spentSoFar + ((target - spentSoFar) * (d - today)) / span)
    }
    out.push({
      day: d,
      actual: isPast ? actualCum[d - 1] ?? spentSoFar : null,
      expected: expected[d - 1] ?? 0,
      forecast,
    })
  }
  return out
}

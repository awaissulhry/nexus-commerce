/**
 * ONE BRAIN AB-7 — the money hierarchy, step 2: the pace of one product's envelope through the month, and its brakes
 * (design 2026-10-08-ads-one-brain/DESIGN.md §2.6, §4 step 2, §5). Pure. SHADOW: decided and logged; nothing is written.
 *
 *   clock     the money month and day are the BUDGET day's (00:00–24:00 UTC in every market, @nexus/shared/ads-budget-day:
 *             Amazon resets campaign budgets there and the daily report counts spend there, measured). The market's own
 *             clock (Europe/Rome for IT) gives the local hour the intraday ladder reads; between local midnight and the
 *             UTC reset (00:00–02:00 Rome in summer, 00:00–01:00 in winter) the budget day is still the previous one.
 *   curve     the expected cumulative spend by day and by hour: the aim (paceTargetPct of the envelope, 90 % unless the
 *             Owner set his own) spread over the days — evenly, or by the Budget Manager's calendar when the month has one
 *             — and inside today by the hour curve (the product's own hourly spend over 4 weeks, else the market's, else an
 *             even day: UTC hours, as the Marketing Stream stores them).
 *   project   month-end spend = spend so far (the daily report's complete days, then the Marketing Stream's hours after
 *             them; without the stream, the run rate stands in for them) + the run rate (the average of the last 7
 *             reported days) × what is left of the month (today's part by the hour curve).
 *   brakes    on projected month-end spend, % of the envelope: > 95 % no raises (bids, budgets, hours); > 100 % bids step
 *             down 10 % a day; > 105 % the stop recipe on the weakest campaigns until back on pace. The portfolio cap
 *             (115 %) is never meant to be reached. No envelope: no brake (said). An envelope of 0 with spend ahead: the
 *             strongest brake.
 *   allowance what the aim leaves per day for the rest of the month: the campaign budgets are sized inside it.
 */

import { money } from './budget-envelope.js'

export type BrakeLevel = 'none' | 'hold_raises' | 'cut_bids' | 'stop_weakest'

/** The brakes, weakest first: above `abovePct` of the envelope (projected month-end spend), what the brain does. */
export const MONEY_BRAKES: ReadonlyArray<{ level: Exclude<BrakeLevel, 'none'>; abovePct: number; does: string }> = [
  { level: 'hold_raises', abovePct: 95, does: 'no raises: bids, budgets and hours hold' },
  { level: 'cut_bids', abovePct: 100, does: 'bids step down 10 % a day' },
  { level: 'stop_weakest', abovePct: 105, does: 'the stop recipe on the weakest campaigns until back on pace' },
]
/** cut_bids: how far the bids step down a day. */
export const BRAKE_BID_STEP_PCT = 10
export const RUN_RATE_DAYS = 7
export const HOUR_CURVE_DAYS = 28
/** An hour curve needs this much spend over its 4 weeks to be the product's (else the market's, else an even day). */
export const HOUR_CURVE_MIN_CENTS = 2_000

const DAY_MS = 86_400_000
const pad = (n: number) => String(n).padStart(2, '0')
const round2 = (x: number) => Math.round(x * 100) / 100

export interface MoneyClock {
  /** ISO instant the plan was decided at. */
  at: string
  /** The budget day (YYYY-MM-DD, UTC), its month and day of the month, the month's length, the whole days after today. */
  day: string
  month: string
  dayOfMonth: number
  daysInMonth: number
  daysAfterToday: number
  /** The UTC hour of the budget day and the fraction of it gone. */
  hour: number
  hourFraction: number
  /** The market's clock (null zone: UTC): its date and hour. */
  timeZone: string | null
  localDay: string
  localHour: number
  /** The hour the ladder reads: the local hour, + 24 once local midnight passed while the budget day still runs. */
  ladderHour: number
}

/** The calendar day and hour of `at` in `timeZone` (UTC when the zone is missing or unknown). */
function localParts(at: Date, timeZone: string | null): { day: string; hour: number; minute: number } {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
      const [y, mo, d, h, mi] = [get('year'), get('month'), get('day'), get('hour'), get('minute')]
      if (y && mo && d && h) return { day: `${y}-${mo}-${d}`, hour: Number(h) % 24, minute: Number(mi) || 0 }
    } catch { /* an unknown zone: UTC */ }
  }
  return { day: at.toISOString().slice(0, 10), hour: at.getUTCHours(), minute: at.getUTCMinutes() }
}

/** The money clock at `now` for a market in `timeZone`. Pure. */
export function moneyClock(now: Date, timeZone: string | null): MoneyClock {
  // The budget day: 00:00 UTC on now's UTC date (@nexus/shared/ads-budget-day budgetDayStart, the one definition).
  const y = now.getUTCFullYear()
  const mo = now.getUTCMonth()
  const dom = now.getUTCDate()
  const daysInMonth = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()
  const day = `${y}-${pad(mo + 1)}-${pad(dom)}`
  const local = localParts(now, timeZone)
  const ladderHour = local.day > day ? local.hour + 24 : local.day < day ? local.hour - 24 : local.hour
  return {
    at: now.toISOString(), day, month: `${y}-${pad(mo + 1)}`, dayOfMonth: dom, daysInMonth, daysAfterToday: daysInMonth - dom,
    hour: now.getUTCHours(), hourFraction: (now.getUTCMinutes() * 60 + now.getUTCSeconds()) / 3600,
    timeZone, localDay: local.day, localHour: local.hour + local.minute / 60, ladderHour: ladderHour + local.minute / 60,
  }
}

/** The first day of the month `month` (YYYY-MM) and of the month before it, at 00:00 UTC. */
export function monthStart(month: string, delta = 0): Date {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + delta, 1))
}

/** Day weights of the month: the Budget Manager calendar (each day's %), else even. Unusable calendars are even. Pure. */
export function dayWeights(daysInMonth: number, calendar: unknown): { weights: number[]; from: 'calendar' | 'even' } {
  const even = { weights: Array.from({ length: daysInMonth }, () => 1), from: 'even' as const }
  if (!Array.isArray(calendar) || !calendar.length) return even
  const w = Array.from({ length: daysInMonth }, () => 0)
  for (const c of calendar as Array<{ day?: unknown; pct?: unknown }>) {
    const d = Number(c?.day)
    const p = Number(c?.pct)
    if (Number.isInteger(d) && d >= 1 && d <= daysInMonth && Number.isFinite(p) && p >= 0) w[d - 1] += p
  }
  return w.reduce((n, x) => n + x, 0) > 0 ? { weights: w, from: 'calendar' } : even
}

/** The share of a budget day gone at UTC `hour` + `fraction`, by the hour curve (24 weights; none usable → even). Pure. */
export function dayShareGone(hourWeights: readonly number[] | null, hour: number, fraction: number): number {
  const w = hourWeights && hourWeights.length === 24 && hourWeights.some((x) => x > 0) ? hourWeights.map((x) => Math.max(0, x)) : Array.from({ length: 24 }, () => 1)
  const sum = w.reduce((n, x) => n + x, 0)
  let gone = 0
  for (let h = 0; h < hour && h < 24; h++) gone += w[h]
  if (hour < 24) gone += w[hour] * Math.min(1, Math.max(0, fraction))
  return Math.min(1, gone / sum)
}

/** The hour curve: the product's own (enough spend), else the market's, else an even day. Pure. */
export function hourCurve(product: readonly number[] | null, market: readonly number[] | null): { weights: number[] | null; from: 'product' | 'market' | 'even' } {
  const total = (w: readonly number[] | null) => (w ? w.reduce((n, x) => n + Math.max(0, x), 0) : 0)
  if (product && product.length === 24 && total(product) >= HOUR_CURVE_MIN_CENTS) return { weights: [...product], from: 'product' }
  if (market && market.length === 24 && total(market) >= HOUR_CURVE_MIN_CENTS) return { weights: [...market], from: 'market' }
  return { weights: null, from: 'even' }
}

export interface Brake {
  level: BrakeLevel
  /** The threshold it crossed, % of the envelope (null: none crossed). */
  abovePct: number | null
  does: string
  why: string
}

/** The brake for a projected month-end spend against the envelope. Pure. */
export function brakeOf(projectedCents: number, envelopeCents: number | null, words: (c: number) => string = (c) => money(c)): Brake {
  if (envelopeCents == null) return { level: 'none', abovePct: null, does: 'nothing: no envelope to pace', why: 'no envelope: nothing to pace, so no brake' }
  if (envelopeCents <= 0) {
    if (projectedCents <= 0) return { level: 'none', abovePct: null, does: 'nothing', why: 'an envelope of 0 and no spend ahead' }
    const top = MONEY_BRAKES[MONEY_BRAKES.length - 1]
    return { level: top.level, abovePct: top.abovePct, does: top.does, why: `the envelope is 0 and ${words(projectedCents)} of spend is projected: ${top.does}` }
  }
  const pct = (projectedCents / envelopeCents) * 100
  const hit = [...MONEY_BRAKES].reverse().find((b) => pct > b.abovePct)
  if (!hit) return { level: 'none', abovePct: null, does: 'nothing', why: `projected ${round2(pct)} % of the envelope: under the first brake (${MONEY_BRAKES[0].abovePct} %)` }
  return { level: hit.level, abovePct: hit.abovePct, does: hit.does, why: `projected ${round2(pct)} % of the envelope (above ${hit.abovePct} %): ${hit.does}` }
}

/** The brake levels from the weakest; `atLeast(b, 'hold_raises')`: b holds raises (or stronger). */
const ORDER: readonly BrakeLevel[] = ['none', 'hold_raises', 'cut_bids', 'stop_weakest']
export const atLeast = (b: BrakeLevel, level: BrakeLevel): boolean => ORDER.indexOf(b) >= ORDER.indexOf(level)

export interface PaceFacts {
  envelopeCents: number | null
  /** The pacing limit (paceTargetPct): month-end spend aimed at, % of the envelope. */
  aimPct: number
  clock: MoneyClock
  dayWeights: readonly number[] | null
  hourWeights: readonly number[] | null
  /** The product's own campaigns' spend on the month's days the daily report covers, through `reportedThroughDay`. */
  spentCents: number
  reportedThroughDay: number
  /** Marketing Stream spend after the reported days: the days before today, and today so far. Null: no stream rows. */
  stream: { gapCents: number; todayCents: number } | null
  /** The average of the last RUN_RATE_DAYS reported days; null: no reported day. */
  runRateCents: number | null
}

export interface Pace {
  aimPct: number
  aimCents: number | null
  /** The expected cumulative spend at the end of each day of the month, and of each UTC hour today (null: no envelope). */
  curve: { byDayCents: number[]; todayByHourCents: number[] } | null
  expectedThroughReportedCents: number | null
  expectedNowCents: number | null
  /** Spend so far: reported days + the stream after them (or the run rate standing in for them). */
  spentNowCents: number
  projectedCents: number
  projection: 'stream and run rate' | 'run rate' | 'month to date only'
  /** Projected month-end spend, % of the envelope; actual spend against the curve on the reported days, %. */
  pacePct: number | null
  vsCurvePct: number | null
  /** What the aim leaves per day for the rest of the month (today's part included); null: no envelope. */
  allowanceCents: number | null
  /** The days ahead, today's remaining part by the hour curve included. */
  daysAhead: number
  brake: Brake
  why: string
}

/** The pace of one envelope, and its brake. Pure. */
export function paceOf(f: PaceFacts, words: (c: number) => string = (c) => money(c)): Pace {
  const c = f.clock
  const shareGone = dayShareGone(f.hourWeights, c.hour, c.hourFraction)
  const gapDays = Math.max(0, c.dayOfMonth - 1 - Math.max(0, Math.min(f.reportedThroughDay, c.dayOfMonth - 1)))
  const runRate = f.runRateCents ?? 0
  const spentNow = f.spentCents + (f.stream ? f.stream.gapCents + f.stream.todayCents : runRate * (gapDays + shareGone))
  const daysAhead = (1 - shareGone) + c.daysAfterToday
  const projected = Math.round(spentNow + runRate * daysAhead)
  const projection: Pace['projection'] = f.runRateCents == null ? 'month to date only' : f.stream ? 'stream and run rate' : 'run rate'

  let curve: Pace['curve'] = null
  let aimCents: number | null = null
  let expectedThrough: number | null = null
  let expectedNow: number | null = null
  if (f.envelopeCents != null) {
    aimCents = Math.round((f.envelopeCents * f.aimPct) / 100)
    const w = f.dayWeights && f.dayWeights.length === c.daysInMonth && f.dayWeights.some((x) => x > 0) ? f.dayWeights : Array.from({ length: c.daysInMonth }, () => 1)
    const sum = w.reduce((n, x) => n + Math.max(0, x), 0)
    let acc = 0
    const byDay = w.map((x) => { acc += Math.max(0, x); return Math.round((aimCents! * acc) / sum) })
    const prev = c.dayOfMonth > 1 ? byDay[c.dayOfMonth - 2] : 0
    const todayPart = byDay[c.dayOfMonth - 1] - prev
    const todayByHour = Array.from({ length: 24 }, (_, h) => Math.round(prev + todayPart * dayShareGone(f.hourWeights, h, 1)))
    curve = { byDayCents: byDay, todayByHourCents: todayByHour }
    expectedThrough = f.reportedThroughDay > 0 ? byDay[Math.min(f.reportedThroughDay, c.daysInMonth) - 1] : 0
    expectedNow = Math.round(prev + todayPart * shareGone)
  }
  const pacePct = f.envelopeCents != null && f.envelopeCents > 0 ? round2((projected / f.envelopeCents) * 100) : null
  const vsCurvePct = expectedThrough != null && expectedThrough > 0 ? round2((f.spentCents / expectedThrough) * 100) : null
  const allowance = aimCents != null && daysAhead > 0 ? Math.max(0, Math.round((aimCents - spentNow) / daysAhead)) : null
  const brake = brakeOf(projected, f.envelopeCents, words)
  const how = projection === 'month to date only' ? 'no reported day to take a run rate from: month to date only'
    : `${words(Math.round(spentNow))} so far + run rate ${words(runRate)} a day × ${round2(daysAhead)} days${f.stream ? '' : ' (no Marketing Stream hours: the run rate stands in for the days the report does not cover yet)'}`
  const why = f.envelopeCents == null
    ? `no envelope: projected ${words(projected)} by month end (${how}); nothing to pace`
    : `projected ${words(projected)} = ${pacePct ?? '—'} % of the envelope ${words(f.envelopeCents)} (${how}); the aim is ${f.aimPct} % (${words(aimCents!)}), ${allowance != null ? `${words(allowance)} a day from here` : 'no day left'}; ${brake.why}`
  return {
    aimPct: f.aimPct, aimCents, curve, expectedThroughReportedCents: expectedThrough, expectedNowCents: expectedNow,
    spentNowCents: Math.round(spentNow), projectedCents: projected, projection, pacePct, vsCurvePct, allowanceCents: allowance,
    daysAhead: round2(daysAhead), brake, why,
  }
}

/**
 * The average daily spend over the `days` calendar days ending on `lastDay` — the newest day the market's daily report
 * covers — a day with no row counting 0 (the report has no row for a campaign that did not serve). `firstDay`, the oldest
 * day the report covers, shortens the window for a young account. Null when no day is reported. Pure.
 */
export function averageDaily(dailyCents: ReadonlyMap<string, number>, lastDay: string | null, days = RUN_RATE_DAYS, firstDay: string | null = null): number | null {
  if (!lastDay) return null
  const end = Date.parse(`${lastDay}T00:00:00Z`)
  const first = firstDay ? Date.parse(`${firstDay}T00:00:00Z`) : -Infinity
  let sum = 0
  let n = 0
  for (let i = 0; i < days; i++) {
    const t = end - i * DAY_MS
    if (t < first) break
    sum += dailyCents.get(new Date(t).toISOString().slice(0, 10)) ?? 0
    n++
  }
  return n ? Math.round(sum / n) : null
}

/**
 * BID BRAIN BB-17 (design BRAIN-UPGRADES-DESIGN.md U1c; one-brain DESIGN.md §2.6 "intraday pacing", §5) — the intraday
 * brakes: what today's Marketing Stream hours say about one campaign the brain owns, as facts the bid brain decides with.
 * Brakes only: nothing here ever raises a bid (U1c: hourly conversions are far too sparse to raise on).
 *
 *   spend   the budget day's projected spend — today's hours so far ÷ the share of a usual day gone by its hour curve (its
 *           own 4 weeks, else the pooled curve of the brain's campaigns in the market, else an even day; only once a
 *           quarter of a usual day is behind, before that the spend so far) — against the day's planned spend (the money
 *           brain's plan of today for the campaign, else the median of its last 14 days that spent):
 *             above intradaySpendHoldPct (130 %)  no raises today (keyword bids and placement %)
 *             above intradaySpendCutPct (160 %)   the bids step down intradaySpendCutStepPct (10 %) from the bid before
 *                                                 the brake for the rest of the budget day, lane-aware: every lane's CPC
 *                                                 ceiling steps down with them and no lane % rises; released at 00:00 UTC
 *                                                 (the next budget day), when the bids go back (decide.ts `restore`)
 *           A cut once reached holds the rest of the day: the projection is also read at the end of every hour of today,
 *           so the cut's own effect never lifts it (no flapping).
 *   cpc     a placement lane whose cost per click over the last two UTC hours (this one and the one before, at least
 *           intradayCpcMinClicks clicks) runs above intradayCpcSpikePct (200 %) of its median for the same two hours over
 *           the last 14 days (at least 5 days with clicks) — a competitor surge or a shift in Amazon's auction: no raises
 *           while it lasts, and its dearest click is held to that multiple of the median: the lane's CPC ceiling where the
 *           brain sets the lane (its % comes down first), and the keyword bids wherever Amazon's stack (the lane's % the
 *           brain does not set, its dynamic bidding) would still let a click cost more. Given back when the spike ends.
 *           Keyword grain is not stored (BB-16 keeps ad group × placement): the brake is per campaign × lane.
 *   budget  a campaign whose projected spend would use its daily budget up before its best hours (the hours worth the
 *           most by its 1-day sales over 4 weeks — its own with 10 orders, else the pooled, else its usual spend) →
 *           no raises today, and in its low-value hours the bids slow to the factor that leaves the best hours their
 *           usual spend (at least intradayBudgetSlowMinPct, 50 %; quantised to 5 %), given back in the best hours. The
 *           strongest slowdown asked today holds the day. The budget is the money brain's: this brake never raises it.
 *   gaps    no brake on what the data cannot say: the hourly feed silent for these campaigns for 3 hours, a placement
 *           day the grain capped (its rows are incomplete), a late first delta in the window, too few days of history,
 *           no budget known. Said, never silent.
 *
 *   NEXUS_BID_BRAIN_INTRADAY = off · shadow (default) · on
 *     off     nothing is read; the brain decides exactly as before BB-17
 *     shadow  the brakes are read and decided; every decision stays exactly what it is without them. Where a brake would
 *             change one, the stored why says so (" · intraday (shadow): would …") and the run's line counts it. Nothing
 *             more is written, nothing is sent.
 *     on      the brakes are in the facts (applyIntraday): the raise cap, the `intraday` override, the lanes' ceilings
 * Thresholds: the brain's settings (brain/levers.ts), the Owner's product and campaign overrides over them.
 * Pure: no database, no clock (intraday-load.ts reads).
 */
import { dayShareGone, hourCurve, HOUR_CURVE_DAYS } from '../brain/budget-pace.js'
import { money } from '../brain/budget-envelope.js'
import { BRAIN_SETTINGS, type BrainSetting } from '../brain/levers.js'
import { laneHeadroom } from '../rank-controller.js'
import { placementOf } from './plan-hour.js'
import { laneWords, type Lane, type LaneName } from './recipe.js'
import type { Decision, Overrides, TargetFacts } from './decide.js'

export type IntradayMode = 'off' | 'shadow' | 'on'

/** The switch. Anything unrecognised is shadow: decisions never change by accident. */
export function intradayMode(env: string | undefined = process.env.NEXUS_BID_BRAIN_INTRADAY): IntradayMode {
  const v = (env ?? '').trim().toLowerCase()
  if (v === 'off' || v === '0' || v === 'false') return 'off'
  if (v === 'on' || v === '1' || v === 'true') return 'on'
  return 'shadow'
}

/** The projection waits until this share of a usual day's spend is behind (before it: the spend so far). */
export const PROJECT_MIN_SHARE = 0.25
/** The planned day from history: the median of the last PLANNED_DAYS days that spent, at least PLANNED_MIN_DAYS of them. */
export const PLANNED_DAYS = 14
export const PLANNED_MIN_DAYS = 5
/** A planned day below this is too little to judge (cents): no spend brake. */
export const PLANNED_MIN_CENTS = 200
/** The CPC median: the last CPC_DAYS days, at least CPC_MIN_DAYS of them with clicks in the window. */
export const CPC_DAYS = 14
export const CPC_MIN_DAYS = 5
/** The hourly feed silent for these campaigns this long (once the day is this old): no brake. */
export const STREAM_SILENT_HOURS = 3
/** A sales curve is a campaign's own (or the pool's) from this many 1-day orders in its 4 weeks. */
export const VALUE_MIN_ORDERS = 10
/** The budget brake's slowdown is quantised down to steps of this. */
export const BUDGET_SLOW_STEP = 0.05
export const CURVE_DAYS = HOUR_CURVE_DAYS

/** The settings the brakes read, in the order the Owner meets them. */
export const INTRADAY_SETTING_KEYS = ['intradaySpendHoldPct', 'intradaySpendCutPct', 'intradaySpendCutStepPct', 'intradayCpcSpikePct', 'intradayCpcMinClicks', 'intradayBudgetSlowMinPct'] as const satisfies readonly BrainSetting[]
export type IntradaySettingKey = (typeof INTRADAY_SETTING_KEYS)[number]

export interface IntradayThresholds {
  spendHoldPct: number
  spendCutPct: number
  spendCutStepPct: number
  cpcSpikePct: number
  cpcMinClicks: number
  budgetSlowMinPct: number
}

/** The thresholds from resolved setting values (a value that is not a number keeps the brain's default). */
export function thresholdsOf(values: Partial<Record<IntradaySettingKey, unknown>> = {}): IntradayThresholds {
  const num = (k: IntradaySettingKey) => (typeof values[k] === 'number' && Number.isFinite(values[k]) ? (values[k] as number) : (BRAIN_SETTINGS[k].default as number))
  return {
    spendHoldPct: num('intradaySpendHoldPct'), spendCutPct: num('intradaySpendCutPct'), spendCutStepPct: num('intradaySpendCutStepPct'),
    cpcSpikePct: num('intradayCpcSpikePct'), cpcMinClicks: num('intradayCpcMinClicks'), budgetSlowMinPct: num('intradayBudgetSlowMinPct'),
  }
}

/** The budget day (00:00–24:00 UTC: Amazon resets campaign budgets there, and the stream stores UTC hours) at `now`. */
export interface IntradayClock { day: string; hour: number; fraction: number }
export function intradayClock(now: Date): IntradayClock {
  return { day: now.toISOString().slice(0, 10), hour: now.getUTCHours(), fraction: (now.getUTCMinutes() * 60 + now.getUTCSeconds()) / 3600 }
}

/** One placement lane's window: the last two UTC hours today, and the same two hours of each of the last 14 days. */
export interface LaneWindow {
  lane: LaneName
  today: { spendCents: number; clicks: number; late: boolean }
  past: ReadonlyArray<{ day: string; spendCents: number; clicks: number }>
}

/** One campaign's hours, as the loader reads them. Money in cents (may carry a fraction: Amazon bills in micros). */
export interface CampaignHours {
  /** Spend per UTC hour of today so far (24 entries; the hours to come 0). */
  todayCents: readonly number[]
  /** Its spend and 1-day sales per UTC hour over the last 28 complete days, and its 1-day orders there. */
  curveCents: readonly number[] | null
  salesCurveCents: readonly number[] | null
  orders: number
  /** Its spend on each of the last 14 complete days that had a stream row (a missing day did not spend, or is a gap). */
  dailyCents: readonly number[]
  /** The money brain's expected spend for it today (its newest plan of today); null: none. */
  moneyPlanCents: number | null
  /** Its daily budget now; null: not known. */
  budgetCents: number | null
  lanes: readonly LaneWindow[]
}

/** The pool a thin campaign's curves fall back on: the brain's campaigns in the market. */
export interface PoolHours { curveCents: readonly number[] | null; salesCurveCents: readonly number[] | null; orders: number }

export interface SpendBrake {
  level: 'hold' | 'cut'
  projectedCents: number
  spentCents: number
  plannedCents: number
  plannedFrom: string
  /** cut: the UTC hour from which the cut holds (the end of the hour whose projection first crossed it; null: now). */
  since: number | null
  stepPct: number
  why: string
}

export interface CpcSpike {
  lane: LaneName
  readingCents: number
  clicks: number
  medianCents: number
  days: number
  /** The dearest click allowed in the lane while it lasts: the spike multiple × the median, in whole cents. */
  ceilingCents: number
  why: string
}

export interface BudgetBrake {
  /** The slowdown of its low-value hours (1: none — the budget is used up, or no low-value hour is left). */
  factor: number
  /** The hour now is one of its low-value hours (the slowdown applies now). */
  lowHour: boolean
  bestHours: number[]
  why: string
}

export interface CampaignBrakes {
  spend: SpendBrake | null
  cpc: CpcSpike[]
  budget: BudgetBrake | null
  /** Why the brakes leave this campaign alone where the data cannot say (per brake). */
  gaps: string[]
}

/** The run's intraday brakes (load.ts → RunRows.intraday), per campaign the brain owns. */
export interface IntradayRun {
  mode: 'shadow' | 'on'
  brakes: ReadonlyMap<string, CampaignBrakes>
  /** Why no brake was read for the market at all (the feed silent); empty: read. */
  gaps: readonly string[]
  /** Campaigns read. */
  campaigns: number
}

const pad = (n: number) => String(n).padStart(2, '0')
const clockWords = (c: IntradayClock) => `${pad(c.hour)}:${pad(Math.min(59, Math.floor(c.fraction * 60)))} UTC`
const pctWords = (x: number) => `${Math.round(x)} %`
const sum = (xs: readonly number[]) => xs.reduce((n, x) => n + x, 0)
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Hours as ranges: [18, 19, 20, 3] → "03:00–04:00, 18:00–21:00 UTC". */
export function hourRanges(hours: readonly number[]): string {
  const hs = [...new Set(hours)].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < hs.length; i++) {
    let j = i
    while (j + 1 < hs.length && hs[j + 1] === hs[j] + 1) j++
    out.push(`${pad(hs[i])}:00–${pad((hs[j] + 1) % 24)}:00`)
    i = j
  }
  return out.length ? `${out.join(', ')} UTC` : 'none'
}

/** A day projected from what it spent and the share of a usual day gone (the spend so far until a quarter is gone). */
export const projectDay = (spentCents: number, gone: number): number => (gone >= PROJECT_MIN_SHARE ? spentCents / gone : spentCents)

/** The day's planned spend: the money brain's plan of today, else the median of the last days that spent; null: too little. */
export function plannedDay(c: Pick<CampaignHours, 'moneyPlanCents' | 'dailyCents'>): { cents: number; from: string } | null {
  if (c.moneyPlanCents != null && c.moneyPlanCents >= PLANNED_MIN_CENTS) return { cents: c.moneyPlanCents, from: 'the money brain\'s plan of today' }
  const days = c.dailyCents.filter((x) => x > 0)
  const m = days.length >= PLANNED_MIN_DAYS ? median(days) : null
  return m != null && m >= PLANNED_MIN_CENTS ? { cents: m, from: `the median of its last ${days.length} days that spent` } : null
}

/**
 * The spend brake (pure). `weights`: the spend curve (null: an even day). The projection is read at the end of every hour
 * of today and now: a cut, once crossed, holds the day. Null: under the hold line (or nothing to judge).
 */
export function spendBrakeOf(a: { todayCents: readonly number[]; weights: readonly number[] | null; clock: IntradayClock; planned: { cents: number; from: string }; t: IntradayThresholds; currency: string }): SpendBrake | null {
  const { clock, planned, t } = a
  const w = (c: number) => money(Math.round(c), a.currency)
  const holdAbove = (planned.cents * t.spendHoldPct) / 100
  const cutAbove = (planned.cents * Math.max(t.spendCutPct, t.spendHoldPct)) / 100
  let cum = 0
  let since: number | null | undefined
  for (let j = 0; j < clock.hour; j++) {
    cum += Math.max(0, a.todayCents[j] ?? 0)
    if (since === undefined && projectDay(cum, dayShareGone(a.weights, j, 1)) > cutAbove) since = (j + 1) % 24
  }
  const spent = cum + Math.max(0, a.todayCents[clock.hour] ?? 0)
  const gone = dayShareGone(a.weights, clock.hour, clock.fraction)
  const projected = projectDay(spent, gone)
  if (since === undefined && projected > cutAbove) since = null
  const level = since !== undefined ? 'cut' : projected > holdAbove ? 'hold' : null
  if (!level) return null
  const heads = gone >= PROJECT_MIN_SHARE
    ? `today heads for ${w(projected)} (${w(spent)} spent by ${clockWords(clock)}, ${pctWords(gone * 100)} of a usual day)`
    : `today has spent ${w(spent)} by ${clockWords(clock)} (under a quarter of a usual day: not projected)`
  const of = `the day's planned ${w(planned.cents)} (${planned.from})`
  const why = level === 'cut'
    ? `intraday spend: ${heads} — above ${pctWords(Math.max(t.spendCutPct, t.spendHoldPct))} of ${of}${since != null ? ` since ${pad(since)}:00 UTC` : ''}: bids step down ${t.spendCutStepPct} % from the bid before for the rest of the budget day (back at 00:00 UTC), and no raises`
    : `intraday spend: ${heads} — above ${pctWords(t.spendHoldPct)} of ${of}: no raises today`
  return { level, projectedCents: Math.round(projected), spentCents: Math.round(spent), plannedCents: Math.round(planned.cents), plannedFrom: planned.from, since: level === 'cut' ? since ?? null : null, stepPct: t.spendCutStepPct, why }
}

/** The CPC spike of one lane (pure): the spike, a gap (the data cannot say), or null (no spike, or too few clicks today). */
export function cpcSpikeOf(l: LaneWindow, a: { t: IntradayThresholds; cappedDays: ReadonlySet<string>; today: string; currency: string }): { spike: CpcSpike } | { gap: string } | null {
  const name = laneWords(l.lane)
  if (a.cappedDays.has(a.today)) return { gap: `${name} CPC: the hourly grain capped today's rows — today's cost per click is not known` }
  if (l.today.late) return { gap: `${name} CPC: a late first delta in the last two hours — earlier deltas may be missing` }
  if (l.today.clicks < Math.max(1, a.t.cpcMinClicks) || l.today.spendCents <= 0) return null
  const past = l.past.filter((d) => !a.cappedDays.has(d.day) && d.clicks > 0 && d.spendCents >= 0).map((d) => d.spendCents / d.clicks)
  if (past.length < CPC_MIN_DAYS) return { gap: `${name} CPC: ${past.length} of the last ${CPC_DAYS} days had clicks in these hours (${CPC_MIN_DAYS} needed)` }
  const med = median(past)!
  if (!(med > 0)) return null
  const reading = l.today.spendCents / l.today.clicks
  if (reading <= (med * a.t.cpcSpikePct) / 100) return null
  const ceiling = Math.max(1, Math.floor((med * a.t.cpcSpikePct) / 100))
  const w = (c: number) => money(c, a.currency)
  const why = `intraday CPC spike: ${name} cost per click ${w(Math.round(reading))} over the last two hours (${l.today.clicks} clicks) is ${Math.round((reading / med) * 10) / 10} × its ${past.length}-day median for these hours (${w(Math.round(med))}) — a competitor surge or a shift in Amazon's auction: no raises, and its dearest click held to ${w(ceiling)} while it lasts`
  return { spike: { lane: l.lane, readingCents: Math.round(reading), clicks: l.today.clicks, medianCents: Math.round(med), days: past.length, ceilingCents: ceiling, why } }
}

/** The best hours of a value curve: smoothed over three hours (circular), those at or above the day's mean. */
export function bestHoursOf(value: readonly number[] | null): Set<number> {
  const v = value && value.length === 24 && value.some((x) => x > 0) ? value.map((x) => Math.max(0, x)) : Array.from({ length: 24 }, () => 1)
  const smooth = v.map((_, h) => (v[(h + 23) % 24] + v[h] + v[(h + 1) % 24]) / 3)
  const mean = sum(smooth) / 24
  return new Set(smooth.flatMap((x, h) => (x >= mean - 1e-9 ? [h] : [])))
}

/**
 * The budget brake at one moment (pure): the day projected from `spentCents` at `hour` + `fraction`; null when the budget
 * lasts the day (or the projection waits), else where it runs out and the slowdown of the low-value hours that leaves the
 * best hours their usual spend (`factor` null: the budget runs out only after its best hours, or no low-value hour is left).
 */
export function budgetAt(a: { spentCents: number; hour: number; fraction: number; weights: readonly number[] | null; best: ReadonlySet<number>; budgetCents: number }): { runOut: number; factor: number | null; bestLeft: number[] } | null {
  const gone = dayShareGone(a.weights, a.hour, a.fraction)
  if (gone < PROJECT_MIN_SHARE) return null
  const projected = a.spentCents / gone
  if (projected <= a.budgetCents) return null
  const w = a.weights && a.weights.length === 24 && a.weights.some((x) => x > 0) ? a.weights.map((x) => Math.max(0, x)) : Array.from({ length: 24 }, () => 1)
  const total = sum(w)
  const share = (k: number) => (w[k] / total) * (k === a.hour ? 1 - Math.min(1, Math.max(0, a.fraction)) : 1)
  let acc = a.spentCents
  let runOut = 23
  for (let k = a.hour; k < 24; k++) {
    acc += projected * share(k)
    if (acc >= a.budgetCents) { runOut = k; break }
  }
  const bestLeft = [...a.best].filter((h) => h >= runOut).sort((x, y) => x - y)
  if (!bestLeft.length) return { runOut, factor: null, bestLeft }
  let low = 0
  let high = 0
  for (let k = a.hour; k < 24; k++) (a.best.has(k) ? (high += share(k)) : (low += share(k)))
  if (low <= 0) return { runOut, factor: null, bestLeft }
  return { runOut, factor: (a.budgetCents - a.spentCents - projected * high) / (projected * low), bestLeft }
}

/**
 * The budget brake (pure): read at the end of every hour of today and now; the strongest slowdown asked holds the day.
 * `value`: the curve the best hours come from, and its words.
 */
export function budgetBrakeOf(a: { todayCents: readonly number[]; weights: readonly number[] | null; value: { curve: readonly number[] | null; from: string }; clock: IntradayClock; budgetCents: number; t: IntradayThresholds; currency: string }): BudgetBrake | null {
  const { clock } = a
  const w = (c: number) => money(Math.round(c), a.currency)
  const best = bestHoursOf(a.value.curve)
  const bestHours = [...best].sort((x, y) => x - y)
  const lowHour = !best.has(clock.hour)
  const spent = sum(a.todayCents.slice(0, clock.hour + 1).map((x) => Math.max(0, x)))
  if (spent >= a.budgetCents) {
    return { factor: 1, lowHour, bestHours, why: `intraday budget: ${w(spent)} spent by ${clockWords(clock)} — its ${w(a.budgetCents)} daily budget is used up: no raises today (the money brain owns the budget)` }
  }
  let cum = 0
  let strongest: { at: string; factor: number } | null = null
  let latest: { runOut: number; factor: number | null; bestLeft: number[] } | null = null
  const consider = (r: ReturnType<typeof budgetAt>, at: string) => {
    if (!r) return
    latest = r
    if (r.factor != null && (!strongest || r.factor < strongest.factor)) strongest = { at, factor: r.factor }
  }
  for (let j = 0; j < clock.hour; j++) {
    cum += Math.max(0, a.todayCents[j] ?? 0)
    consider(budgetAt({ spentCents: cum, hour: j, fraction: 1, weights: a.weights, best, budgetCents: a.budgetCents }), `${pad((j + 1) % 24)}:00 UTC`)
  }
  consider(budgetAt({ spentCents: spent, hour: clock.hour, fraction: clock.fraction, weights: a.weights, best, budgetCents: a.budgetCents }), 'now')
  if (!strongest && !latest) return null
  const s = strongest as { at: string; factor: number } | null
  const minFactor = Math.min(1, Math.max(0, a.t.budgetSlowMinPct / 100))
  const factor = s ? Math.max(minFactor, Math.min(1, Math.floor(s.factor / BUDGET_SLOW_STEP + 1e-9) * BUDGET_SLOW_STEP)) : 1
  const l = latest as { runOut: number; factor: number | null; bestLeft: number[] } | null
  const runs = l ? `today heads past its ${w(a.budgetCents)} daily budget (${w(spent)} spent by ${clockWords(clock)}), about ${pad(l.runOut)}:00 UTC` : `today headed past its ${w(a.budgetCents)} daily budget`
  if (!s) {
    // The budget runs out only after the best hours, or no low-value hour is left to slow: the raises wait, nothing slows.
    const where = l?.bestLeft.length ? `before its best hours (${hourRanges(bestHours)}, ${a.value.from}), with no low-value hour left to slow` : `after its best hours (${hourRanges(bestHours)}, ${a.value.from})`
    return { factor: 1, lowHour, bestHours, why: `intraday budget: ${runs}, ${where}: no raises today — the money brain owns the budget` }
  }
  const slow = factor < 1
    ? `its low-value hours slowed to ${Math.round(factor * 100)} % of the bid${s.at === 'now' ? '' : ` since ${s.at}`}${s.factor < minFactor ? ` (the most intradayBudgetSlowMinPct allows; even so the best hours may not get their usual spend)` : ''}${lowHour ? ' — now is one' : ' — now is a best hour: bids as they were'}`
    : 'intradayBudgetSlowMinPct is 100 %: no slowdown'
  return { factor, lowHour, bestHours, why: `intraday budget: ${runs}, before its best hours (${hourRanges(bestHours)}, ${a.value.from}): ${slow}; no raises today — the money brain owns the budget` }
}

/** The value curve the best hours come from: 1-day sales with enough orders (its own, else the pool's), else its spend curve. */
export function valueCurveOf(c: Pick<CampaignHours, 'salesCurveCents' | 'orders'>, pool: PoolHours | null, spend: { weights: readonly number[] | null; from: string }): { curve: readonly number[] | null; from: string } {
  if (c.salesCurveCents && c.orders >= VALUE_MIN_ORDERS) return { curve: c.salesCurveCents, from: `by its 1-day sales over ${CURVE_DAYS} days` }
  if (pool?.salesCurveCents && pool.orders >= VALUE_MIN_ORDERS) return { curve: pool.salesCurveCents, from: `by the 1-day sales of the brain's campaigns in the market over ${CURVE_DAYS} days` }
  return { curve: spend.weights, from: spend.weights ? `by ${spend.from}` : 'no curve: every hour alike' }
}

/** Every brake of one campaign (pure). `pool`: the brain's campaigns in the market summed (thin curves fall back on it). */
export function campaignBrakes(c: CampaignHours, a: { pool: PoolHours | null; t: IntradayThresholds; clock: IntradayClock; cappedDays: ReadonlySet<string>; currency: string }): CampaignBrakes {
  const gaps: string[] = []
  const curve = hourCurve(c.curveCents ? [...c.curveCents] : null, a.pool?.curveCents ? [...a.pool.curveCents] : null)
  const spendFrom = curve.from === 'product' ? `its own hourly spend over ${CURVE_DAYS} days` : curve.from === 'market' ? `the hourly spend of the brain's campaigns in the market over ${CURVE_DAYS} days` : 'an even day'
  const planned = plannedDay(c)
  let spend: SpendBrake | null = null
  if (planned) spend = spendBrakeOf({ todayCents: c.todayCents, weights: curve.weights, clock: a.clock, planned, t: a.t, currency: a.currency })
  else gaps.push(`spend: no planned day (no money plan of today, and fewer than ${PLANNED_MIN_DAYS} of the last ${PLANNED_DAYS} days spent ${money(PLANNED_MIN_CENTS, a.currency)} or more)`)
  const cpc: CpcSpike[] = []
  for (const l of c.lanes) {
    const r = cpcSpikeOf(l, { t: a.t, cappedDays: a.cappedDays, today: a.clock.day, currency: a.currency })
    if (r && 'spike' in r) cpc.push(r.spike)
    else if (r && 'gap' in r) gaps.push(r.gap)
  }
  let budget: BudgetBrake | null = null
  if (c.budgetCents != null && c.budgetCents > 0) {
    budget = budgetBrakeOf({ todayCents: c.todayCents, weights: curve.weights, value: valueCurveOf(c, a.pool, { weights: curve.weights, from: spendFrom }), clock: a.clock, budgetCents: c.budgetCents, t: a.t, currency: a.currency })
  } else gaps.push('budget: no daily budget known')
  return { spend, cpc, budget, gaps }
}

/** Whether a campaign's brakes hold anything (a raise cap at least). */
export const anyBrake = (b: CampaignBrakes | undefined): b is CampaignBrakes => !!b && (!!b.spend || b.cpc.length > 0 || !!b.budget)

/** The brakes in short words, for a note and the run's line: "spend cut −10 %", "CPC spike top-of-search", "budget slow ×0.7". */
export function brakeLabels(b: CampaignBrakes): string[] {
  const out: string[] = []
  if (b.spend) out.push(b.spend.level === 'cut' ? `spend cut −${b.spend.stepPct} %` : 'spend hold')
  for (const s of b.cpc) out.push(`CPC spike ${laneWords(s.lane)}`)
  if (b.budget) out.push(b.budget.factor < 1 ? `budget slow ×${b.budget.factor}${b.budget.lowHour ? '' : ' (a best hour now)'}` : 'budget hold')
  return out
}

/**
 * The brakes in one keyword's facts (pure): every brake holds raises (the raise cap, joined to any other); the spend cut and
 * the budget's slow hours step the bid down from the bid before (`intraday.factor`, the stronger of the two), a CPC spike
 * caps it (`intraday.capCents`) — lane-aware: the lanes the brain sets get their CPC ceilings stepped down with the bid, a
 * spiking one its spike ceiling; a lane it does not set counts at its own % in the cap. `campaign`: the placements that
 * serve (the stop's memory first, as facts.ts measures the stack) and the bidding strategy.
 */
export function applyIntraday(f: TargetFacts, b: CampaignBrakes | undefined, campaign: { placements: ReadonlyArray<{ placement: string; percentage: number }>; biddingStrategy: string | null }): TargetFacts {
  if (!anyBrake(b)) return f
  const whys = [b.spend?.why, ...b.cpc.map((s) => s.why), b.budget?.why].filter((x): x is string => !!x)
  const out: TargetFacts = { ...f, raiseCap: [f.raiseCap, ...whys].filter(Boolean).join('; ') }
  const cut = b.spend?.level === 'cut' ? 1 - b.spend.stepPct / 100 : 1
  const slow = b.budget && b.budget.lowHour && b.budget.factor < 1 ? b.budget.factor : 1
  const factor = Math.min(cut, slow)
  let lanes: Lane[] | undefined = f.lanes ? [...f.lanes] : undefined
  if (lanes && factor < 1) {
    const step = (c: number | null | undefined) => (c != null && c > 0 ? Math.max(1, Math.floor(c * factor)) : c)
    lanes = lanes.map((l) => ({ ...l, maxCpcCents: step(l.maxCpcCents), ...(l.baseCeilingCents != null ? { baseCeilingCents: step(l.baseCeilingCents) } : {}) }))
  }
  let capCents: number | null = null
  for (const s of b.cpc) {
    const dyn = laneHeadroom(campaign.biddingStrategy, placementOf(s.lane))
    const sets = !!lanes?.some((l) => l.lane === s.lane)
    if (sets) lanes = lanes!.map((l) => (l.lane === s.lane ? { ...l, maxCpcCents: Math.min(l.maxCpcCents ?? s.ceilingCents, s.ceilingCents) } : l))
    // The lane's own % where the brain does not set it: Amazon still stacks it on the bid.
    const pct = sets ? 0 : Math.max(0, campaign.placements.find((p) => p.placement === placementOf(s.lane))?.percentage ?? 0)
    const cap = Math.max(1, Math.floor(s.ceilingCents / ((1 + pct / 100) * dyn)))
    if (capCents == null || cap < capCents) capCents = cap
  }
  if (lanes) out.lanes = lanes
  if (factor < 1 || capCents != null) {
    const by = [
      b.spend?.level === 'cut' ? `the intraday spend cut (−${b.spend.stepPct} % for the rest of the budget day)` : null,
      slow < 1 ? `the intraday budget brake (a low-value hour at ${Math.round(slow * 100)} %)` : null,
      capCents != null ? `the intraday CPC spike (${b.cpc.map((s) => `${laneWords(s.lane)} click ≤ ${s.ceilingCents}¢`).join(', ')}: bid ≤ ${capCents}¢)` : null,
    ].filter(Boolean).join(' and ')
    const o: NonNullable<Overrides['intraday']> = { by, ...(factor < 1 ? { factor } : {}), ...(capCents != null ? { capCents } : {}) }
    out.overrides = { ...(f.overrides ?? {}), intraday: o }
  }
  return out
}

/**
 * The brakes in a market's facts, `campaignOf` naming each keyword's campaign (facts.ts buildFacts, switched on). Pure.
 */
export function applyIntradayAll(facts: TargetFacts[], run: Pick<IntradayRun, 'brakes'>, campaignOf: (targetId: string) => { id: string; placements: ReadonlyArray<{ placement: string; percentage: number }>; biddingStrategy: string | null } | null): TargetFacts[] {
  if (!run.brakes.size) return facts
  return facts.map((f) => {
    const c = campaignOf(f.targetId)
    return c ? applyIntraday(f, run.brakes.get(c.id), c) : f
  })
}

/** What the brakes did (on) or would do (shadow) in one market's run, for its line. */
export interface IntradaySummary {
  mode: 'shadow' | 'on'
  campaigns: number
  spendHold: number
  spendCut: number
  cpcLanes: number
  budget: number
  /** Decisions a brake changes (on) or would change (shadow), of those decided. */
  changed: number
  decided: number
  gaps: string[]
}

/** One keyword: the decision without the brakes against the one with them; the shadow's words, or null when they agree. */
export function intradayNote(plain: Decision, braked: Decision, labels: readonly string[]): string | null {
  if (plain.action === braked.action && plain.bidCents === braked.bidCents && plain.layer === braked.layer) return null
  const verb = braked.action === 'write' ? `would write ${braked.bidCents}¢` : braked.action === 'brake' ? 'would brake' : `would hold at ${braked.bidCents}¢`
  return `intraday (shadow): ${verb} (${braked.layer.replace('_', '-')}${labels.length ? `; ${labels.join(', ')}` : ''})`
}

/**
 * A run's decisions without the brakes and with them, matched by target: the notes (shadow only: on, the decisions carry
 * the brakes in their own why) and the counts. Pure.
 */
export function compareIntraday(plain: readonly Decision[], braked: readonly Decision[], run: IntradayRun, campaignOf: (targetId: string) => string): { notes: Map<string, string>; summary: IntradaySummary } {
  const byTarget = new Map(braked.map((d) => [d.targetId, d]))
  const notes = new Map<string, string>()
  const summary: IntradaySummary = { mode: run.mode, campaigns: run.campaigns, spendHold: 0, spendCut: 0, cpcLanes: 0, budget: 0, changed: 0, decided: plain.length, gaps: [...run.gaps] }
  for (const b of run.brakes.values()) {
    if (b.spend?.level === 'hold') summary.spendHold++
    if (b.spend?.level === 'cut') summary.spendCut++
    summary.cpcLanes += b.cpc.length
    if (b.budget) summary.budget++
  }
  for (const p of plain) {
    const b = byTarget.get(p.targetId)
    if (!b) continue
    const brakes = run.brakes.get(campaignOf(p.targetId))
    const note = intradayNote(p, b, brakes ? brakeLabels(brakes) : [])
    if (!note) continue
    summary.changed++
    if (run.mode === 'shadow') notes.set(p.targetId, note)
  }
  return { notes, summary }
}

/** The run line's words: "intraday shadow: 3 campaigns — spend hold 1, spend cut 0, CPC spikes 1, budget 1; 7 of 40 decisions would change". */
export function intradaySummaryWords(s: IntradaySummary | null | undefined): string {
  if (!s) return ''
  if (s.gaps.length && !s.spendHold && !s.spendCut && !s.cpcLanes && !s.budget) return `intraday ${s.mode}: no brake — ${s.gaps.join('; ')}`
  const brakes = s.spendHold + s.spendCut + s.cpcLanes + s.budget
  if (!brakes) return `intraday ${s.mode}: ${s.campaigns} campaign${s.campaigns === 1 ? '' : 's'}, no brake`
  return `intraday ${s.mode}: ${s.campaigns} campaign${s.campaigns === 1 ? '' : 's'} — spend hold ${s.spendHold}, spend cut ${s.spendCut}, CPC spikes ${s.cpcLanes}, budget ${s.budget}; ${s.changed} of ${s.decided} decisions ${s.mode === 'shadow' ? 'would change' : 'changed'}`
}

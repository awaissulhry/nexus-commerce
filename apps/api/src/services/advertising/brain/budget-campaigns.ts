/**
 * ONE BRAIN AB-7 — the money hierarchy, step 4: each campaign's daily budget, the intraday ladder and the day-move
 * "intraday" exception (design 2026-10-08-ads-one-brain/DESIGN.md §2.5, §2.6, §4 step 6, §5). Pure. Decided and logged;
 * the money writer (brain/budget-live.ts, AB-8) asks for it at PROPOSE and writes it at AUTO. Budget follows the bid,
 * never the other way: the bid is the throttle.
 *
 *   target    the campaign's expected daily spend at the goal bids ÷ budgetUsePct (70 %: Perpetua's ~70 % use, so the
 *             budget never throttles before the bid does). Expected spend = its average daily spend over the last 14
 *             reported days × the bid brain's newest goal bids against today's (Σ decided ÷ Σ today, keyword by keyword).
 *             Inside the product's pace: when the own campaigns' expected spend passes what the aim leaves a day, each is
 *             scaled down to fit. Then Amazon's limits (€1 … €1,000,000) and the Owner's own min / max budget.
 *   moves     one base move a day, inside the gate's day-move bound around the day's opening — the opening the gate
 *             itself reads from the budget log (ads-write-gate.ts loggedDayOpeningCents; the budget as it is when no
 *             writer moved it today), −30 % / +50 % or +€10 around it (budgetDayMoveBounds): the step is what today would
 *             write; the target is where it goes. The day's first plan decides the step; the later runs of the budget day
 *             keep it (one base move a day) and only the ladder moves. Within 5 % of today's budget it is kept.
 *   holds     not the brain's here (excluded, the budgets lever locked — the Owner's value or as it is) → none or his
 *             value; a paused campaign, or one with no spend to size on → left as it is; a shared campaign (D2) → may only
 *             go down; a pace brake (> 95 %) → no raise, budgets may only go down.
 *   ladder    Adbrew's hourly ladder inside the band (IND §2.4): a campaign > 75 % used, whose ACoS is inside (or under) the
 *             band, gets +25 % before 06:00, +50 % before 12:00, +75 % before 18:00, +100 % before 23:00, on the market's
 *             clock (Europe/Rome for IT), up to intradayLadderMaxPct (Amazon spends at most 2× a day). It starts only
 *             before 18:00 ("> 75 % used before 18:00"); after 18:00 only a campaign already on the ladder today climbs.
 *             Never over the band (its bids go down instead), never on a spike (spend-guard.ts, BB-10), never under a
 *             brake, never in the budget day's last hours (after 23:00 local, and between local midnight and the UTC
 *             reset), never on a shared or locked campaign. The rung is on top of today's base; ACoS is the campaign's
 *             own with ≥ 3 orders in the settled window, else the product's (pooled: §1, thin products).
 *   exception the ladder may pass the day-move ceiling: an "intraday give-back" — the brain's own ladder, at most
 *             intradayLadderMaxPct of the base, given back to the base at 00:00 UTC (the next day opens at the base). It
 *             is exempt from the day-move bound only; every other gate check stands. AB-8 teaches the gate the exception
 *             (brain/budget-ladder.ts): a rung the gate would refuse is planned with `allowed: false` and never written.
 *   AB-8      a budget that stands on the brain's ladder (`ladderNow`, read from the budget log) is measured from its
 *             base: today's rungs are on top of today's base (no base move undoes them), and a ladder of an earlier day
 *             is given back — "kept" means back at its base, and the day's base move starts there.
 */
import type { Brake } from './budget-pace.js'
import { atLeast } from './budget-pace.js'
import { money } from './budget-envelope.js'
import type { BrainLevel, SettingValue } from './levers.js'
import type { LeverSettings, Resolved } from './settings.js'

export const SPEND_WINDOW_DAYS = 14
export const BUDGET_KEEP_PCT = 5
export const LADDER_USAGE = 0.75
export const LADDER_START_BEFORE = 18
export const LADDER_LAST_HOUR = 23
export const POOLED_MIN_ORDERS = 3
/** The ladder's rungs: before this local hour, this raise (% of the base). */
export const LADDER_RUNGS: ReadonlyArray<{ before: number; pct: number }> = [
  { before: 6, pct: 25 }, { before: 12, pct: 50 }, { before: 18, pct: 75 }, { before: 23, pct: 100 },
]

export interface DayMoveBounds { floorCents: number; ceilCents: number }

export interface CampaignMoneyFacts {
  campaignId: string
  name: string
  status: string
  /** product: the product's own campaign; shared: it advertises another product too (D2: no product's brain owns it). */
  owner: 'product' | 'shared'
  todayCents: number
  /** The day's opening budget the gate measures every move against (its logged opening; else todayCents). */
  openingCents: number
  /** The base step an earlier plan of this budget day decided (one base move a day); null: none yet today. */
  stepToday: number | null
  /** The Owner's own lowest and highest daily budget (Campaign.minBudgetCents / maxBudgetCents, the gate holds them). */
  minCents: number | null
  maxCents: number | null
  /** Its average daily spend over the last SPEND_WINDOW_DAYS reported days (null: no reported day). */
  avgDailySpendCents: number | null
  /** The bid brain's newest goal bids against today's on its keywords (null: no decision). */
  bidRatio: number | null
  /** Its spend, sales and orders over the settled window (the ACoS the band reads). */
  settled: { spendCents: number; salesCents: number; orders: number }
  /** Amazon's budget usage today (live or derived): a fraction (0.8 = 80 %); null: no reading today. */
  usage: number | null
  /** The spend guard (BB-10) holds raises this hour: why; null: no spike. */
  spikeWhy: string | null
  /** The highest ladder rung the plan gave it earlier today (%), 0: none. */
  ladderedTodayPct: number
  /**
   * AB-8 — the budget now stands on the brain's ladder (brain/budget-ladder.ts ladderNowOf): today's rungs on top of
   * `baseCents`, or an earlier day's ladder whose give-back is owed (`before`). Absent or null: no ladder under it.
   */
  ladderNow?: { baseCents: number; fromDay: 'today' | 'before' } | null
  /** The brain's settings resolved on this campaign: its exclusion, the budgets lever, budgetUsePct, intradayLadderMaxPct. */
  excluded: boolean
  budgets: Pick<LeverSettings, 'effective' | 'lock' | 'why'>
  budgetUsePct: Resolved<SettingValue>
  ladderMaxPct: Resolved<SettingValue>
}

export interface BandFacts {
  /** The product's goal (bid-brain/goal.ts resolveGoal): its band as fractions, and its words; null: no goal. */
  goal: { lo: number; hi: number; words: string } | null
  /** The product's own campaigns over the settled window (the pooled ACoS). */
  product: { spendCents: number; salesCents: number; orders: number }
}

export type BandState = 'under' | 'in' | 'over'

export interface LadderStep {
  pct: number
  cents: number
  /** Above the day-move ceiling: it needs the intraday give-back exception. */
  exception: boolean
  /** AB-8 — the day-move check lets it through (inside the bound, or as the exception); false: never written. */
  allowed: boolean
  why: string
}

export type CampaignAction = 'raise' | 'lower' | 'keep' | 'hold' | 'skip'

export interface CampaignBudgetDecision {
  campaignId: string
  name: string
  status: string
  owner: 'product' | 'shared'
  action: CampaignAction
  todayCents: number
  /** Where the budget goes (null: not the brain's); the step today writes (inside the day-move bound). */
  targetCents: number | null
  stepCents: number
  expectedSpendCents: number | null
  band: BandState | null
  bandFrom: 'campaign' | 'product' | null
  acosPct: number | null
  usagePct: number | null
  ladder: LadderStep | null
  ladderWhy: string
  /** AB-8 — the highest rung in force today (this plan's, or one given earlier today), % of the base; 0: none. */
  ladderTodayPct?: number
  dayMove: { floorCents: number; ceilCents: number; bounded: boolean }
  why: string
}

const pctOf = (x: number) => Math.round(x * 1000) / 10

/** A campaign's ACoS against the product's band: its own with enough orders, else the product's (pooled). Pure. */
export function bandStateOf(c: Pick<CampaignMoneyFacts, 'settled'>, band: BandFacts): { state: BandState | null; from: 'campaign' | 'product' | null; acos: number | null; why: string } {
  if (!band.goal) return { state: null, from: null, acos: null, why: 'no ACoS goal in the ads strategy: the band is unknown' }
  const own = c.settled.orders >= POOLED_MIN_ORDERS
  const s = own ? c.settled : band.product
  const from = own ? 'campaign' : 'product'
  if (s.spendCents <= 0) return { state: null, from, acos: null, why: `no spend in the settled window (${from}): the band is unknown` }
  if (s.salesCents <= 0) return { state: 'over', from, acos: null, why: `no sales on its spend in the settled window (${from}${own ? '' : ', pooled: under 3 orders of its own'}): over the band ${band.goal.words}` }
  const acos = s.spendCents / s.salesCents
  const state: BandState = acos > band.goal.hi ? 'over' : acos < band.goal.lo ? 'under' : 'in'
  return { state, from, acos, why: `ACoS ${pctOf(acos)} % (${from}${own ? '' : ', pooled: under 3 orders of its own'}) is ${state === 'in' ? 'inside' : state} the band — ${band.goal.words}` }
}

/** The ladder's rung at the market's local hour (`ladderHour`, + 24 past local midnight inside the budget day). Pure. */
export function ladderRung(ladderHour: number): number {
  if (ladderHour < 0) return LADDER_RUNGS[0].pct
  return LADDER_RUNGS.find((r) => ladderHour < r.before)?.pct ?? 0
}

/**
 * The day-move check of one intended budget against the day's opening, with the intraday give-back exception for the
 * brain's own ladder. Pure.
 */
export function dayMoveCheck(a: { openingCents: number; intendedCents: number; bounds: DayMoveBounds; ladder?: { baseCents: number; pct: number; maxPct: number } | null }): { allowed: boolean; exception: 'intraday-give-back' | null; why: string } {
  const { floorCents, ceilCents } = a.bounds
  if (a.intendedCents >= floorCents && a.intendedCents <= ceilCents) return { allowed: true, exception: null, why: 'inside the day-move bound' }
  if (a.intendedCents > ceilCents && a.ladder) {
    const { baseCents, pct, maxPct } = a.ladder
    const baseInside = baseCents >= floorCents && baseCents <= ceilCents
    const withinLadder = pct <= maxPct && a.intendedCents <= baseCents + Math.round((baseCents * maxPct) / 100)
    if (baseInside && withinLadder) {
      return { allowed: true, exception: 'intraday-give-back', why: `above the day-move ceiling, allowed as an intraday give-back: the brain's ladder (+${pct} % of the base, at most +${maxPct} %), given back to the base at 00:00 UTC — the next day opens at the base` }
    }
    return { allowed: false, exception: null, why: baseInside ? `above the day-move ceiling and beyond the ladder's +${maxPct} %` : 'above the day-move ceiling, and the base itself is outside the day-move bound' }
  }
  return { allowed: false, exception: null, why: a.intendedCents < floorCents ? 'below the day-move floor' : 'above the day-move ceiling' }
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

export interface CampaignPlanInput {
  campaigns: readonly CampaignMoneyFacts[]
  /** What the pace's aim leaves a day (null: no envelope, nothing to fit). */
  allowanceCents: number | null
  brake: Brake
  /** The local hour the ladder reads (MoneyClock.ladderHour). */
  ladderHour: number
  band: BandFacts
  /** Amazon's daily budget limits for Sponsored Products in the market. */
  limits: { minCents: number; maxCents: number }
  /** The day-move bound around a day's opening (ads-write-gate.ts budgetDayMoveBounds). */
  bounds: (openingCents: number) => DayMoveBounds
  words?: (c: number) => string
}

/** Each campaign's budget decision, and how the own campaigns were fitted into the pace. Pure. */
export function planCampaignBudgets(input: CampaignPlanInput): { campaigns: CampaignBudgetDecision[]; scale: number | null; fitWhy: string } {
  const w = input.words ?? ((c: number) => money(c))
  const brakeHolds = atLeast(input.brake.level, 'hold_raises')
  const brain = (c: CampaignMoneyFacts) => !c.excluded && !c.budgets.lock
  const expected = (c: CampaignMoneyFacts) => (c.avgDailySpendCents != null && c.avgDailySpendCents > 0 ? Math.round(c.avgDailySpendCents * (c.bidRatio ?? 1)) : null)
  // The own, enabled, sizable campaigns share the pace's allowance.
  const sized = input.campaigns.filter((c) => brain(c) && c.owner === 'product' && c.status === 'ENABLED' && expected(c) != null)
  const want = sized.reduce((n, c) => n + expected(c)!, 0)
  const scale = input.allowanceCents != null && want > input.allowanceCents ? (want > 0 ? input.allowanceCents / want : 0) : null
  const fitWhy = input.allowanceCents == null
    ? 'no envelope: the budgets follow the expected spend alone'
    : scale != null
      ? `the own campaigns expect ${w(want)} a day, more than the pace leaves (${w(input.allowanceCents)} a day): each is scaled to ${pctOf(scale)} %`
      : `the own campaigns expect ${w(want)} a day, inside what the pace leaves (${w(input.allowanceCents)} a day)`

  const decisions = input.campaigns.map((c): CampaignBudgetDecision => {
    const bounds = input.bounds(c.openingCents)
    const band = bandStateOf(c, input.band)
    const base = {
      campaignId: c.campaignId, name: c.name, status: c.status, owner: c.owner, todayCents: c.todayCents,
      band: band.state, bandFrom: band.from, acosPct: band.acos != null ? pctOf(band.acos) : null, usagePct: c.usage != null ? pctOf(c.usage) : null,
      dayMove: { floorCents: bounds.floorCents, ceilCents: bounds.ceilCents, bounded: false },
    }
    const exp = expected(c)
    const hold = (action: CampaignAction, why: string, targetCents: number | null = action === 'skip' ? null : c.todayCents): CampaignBudgetDecision =>
      ({ ...base, action, targetCents, stepCents: c.todayCents, expectedSpendCents: exp, ladder: null, ladderWhy: 'no ladder: the budget is not the brain\'s to move here', why })
    if (c.excluded) return hold('skip', 'excluded from the brain by the Owner: today\'s engines run its budget')
    if (c.budgets.lock) {
      // The Owner holds the lever: the brain writes nothing (it only recommends, AB-1), whatever Amazon holds.
      const own = (c.budgets.lock.value as { dailyBudgetCents?: unknown } | null)?.dailyBudgetCents
      return typeof own === 'number' ? hold('hold', `${c.budgets.why}: the Owner's own budget ${w(own)}`, own) : hold('hold', `${c.budgets.why}: the budget as it is`)
    }
    if (c.status !== 'ENABLED') return hold('hold', `${c.status.toLowerCase()}: the budget is left as it is`)
    if (exp == null) return hold('hold', `no spend in the last ${SPEND_WINDOW_DAYS} reported days: nothing to size the budget on, left as it is`)

    // The base: expected spend (inside the pace) ÷ the use it is sized for, inside Amazon's and the Owner's limits.
    const usePct = Number(c.budgetUsePct.value) || 70
    const paced = c.owner === 'product' && scale != null ? exp * scale : exp
    const lo = Math.max(input.limits.minCents, c.minCents ?? 0)
    const hi = Math.min(input.limits.maxCents, c.maxCents ?? Infinity)
    // Up to the next cent (a hair under it forgiven: 280 ÷ 0.7 is 400.00000000000006 in floating point).
    const sizedCents = Math.ceil((paced * 100) / usePct - 1e-9)
    let target = clamp(sizedCents, lo, Math.max(lo, hi))
    const parts = [`expected ${w(exp)} a day${c.bidRatio != null && c.bidRatio !== 1 ? ` (its average ${w(c.avgDailySpendCents!)} × the bid brain's goal bids ${c.bidRatio > 1 ? '+' : ''}${pctOf(c.bidRatio - 1)} %)` : c.bidRatio == null ? ' (its average; no bid brain decision on its keywords)' : ''}`]
    if (c.owner === 'product' && scale != null) parts.push(`scaled to the pace ${pctOf(scale)} % → ${w(Math.round(paced))}`)
    parts.push(`÷ ${usePct} % use${c.budgetUsePct.source === 'default' ? '' : ' (the Owner\'s setting)'} = ${w(target)}`)
    if (target === lo && sizedCents < lo) parts.push(`held at the lowest budget ${w(lo)}${c.minCents != null && c.minCents >= input.limits.minCents ? ' (the Owner\'s minimum)' : ' (Amazon\'s minimum)'}`)
    if (Number.isFinite(hi) && sizedCents > hi) parts.push(`held at the highest budget ${w(hi)}${c.maxCents != null && c.maxCents <= input.limits.maxCents ? ' (the Owner\'s maximum)' : ' (Amazon\'s maximum)'}`)
    // AB-8 — the budget under the brain's ladder: its base (today's rungs on top of it, or an earlier day's to give back).
    const baseNow = c.ladderNow?.baseCents ?? c.todayCents
    if (c.ladderNow?.fromDay === 'before') parts.push(`it still stands on the brain's ladder of an earlier day (${w(c.todayCents)}): given back to its base ${w(baseNow)} first`)
    if (c.owner === 'shared' && target > baseNow) { target = baseNow; parts.push('a shared campaign (D2): the brain may lower it, never raise it') }
    if (brakeHolds && target > baseNow) { target = baseNow; parts.push(`the pace brake holds raises (${input.brake.level})`) }

    // Today's step: one base move a day, from the day's opening, inside the day-move bound; a small difference is kept.
    let step: number
    let bounded = false
    if (c.stepToday != null) {
      // The day's first plan decided today's base move: the later runs keep it (the brain moves a budget once a day).
      step = c.stepToday
      if (step !== target) parts.push(`today ${w(step)}, as the day's first plan decided it: one base move a day`)
    } else {
      // Near today's budget: kept as it is (no churn, and no undoing a move another writer made today). AB-8 — near its
      // base when it stands on the brain's ladder: kept at the base (an earlier day's ladder given back).
      const near = Math.abs(target - baseNow) <= Math.round((baseNow * BUDGET_KEEP_PCT) / 100)
      step = clamp(near ? baseNow : clamp(target, bounds.floorCents, bounds.ceilCents), lo, Math.max(lo, hi))
      bounded = !near && step !== target
      if (near && target !== baseNow) parts.push(`within ${BUDGET_KEEP_PCT} % of today's ${w(baseNow)}: kept`)
      if (bounded) parts.push(`today ${w(step)}: the day-move bound (${w(bounds.floorCents)}–${w(bounds.ceilCents)} around the day's opening ${w(c.openingCents)}) lets it move that far today`)
    }
    // AB-8 — today's rungs are not the base: the base move is measured against the base under them.
    const against = c.ladderNow?.fromDay === 'today' ? baseNow : c.todayCents
    const action: CampaignAction = step > against ? 'raise' : step < against ? 'lower' : 'keep'

    // The intraday ladder, on top of today's base.
    let ladder: LadderStep | null = null
    let ladderWhy: string
    const setMax = Number(c.ladderMaxPct.value)
    const maxPct = Math.max(0, Math.min(100, Number.isFinite(setMax) ? setMax : 100))
    const rung = ladderRung(input.ladderHour)
    if (c.owner !== 'product') ladderWhy = 'no ladder: a shared campaign is never raised'
    else if (brakeHolds) ladderWhy = `no ladder: the pace brake holds raises (${input.brake.level})`
    else if (band.state === 'over') ladderWhy = 'no ladder: over the band — its bids go down instead'
    else if (band.state == null) ladderWhy = `no ladder: ${band.why}`
    else if (c.spikeWhy) ladderWhy = `no ladder: ${c.spikeWhy}`
    else if (c.usage == null) ladderWhy = 'no ladder: no budget usage reading today'
    else if (c.usage <= LADDER_USAGE) ladderWhy = `no ladder: ${pctOf(c.usage)} % used (it climbs above ${LADDER_USAGE * 100} %)`
    else if (rung === 0) ladderWhy = `no ladder: the budget day's last hours (after ${LADDER_LAST_HOUR}:00 on the market's clock, or past its midnight before the 00:00 UTC reset)`
    else if (input.ladderHour >= LADDER_START_BEFORE && c.ladderedTodayPct <= 0) ladderWhy = `no ladder: ${pctOf(c.usage)} % used only after ${LADDER_START_BEFORE}:00 — it lasts through the evening`
    else if (maxPct <= 0) ladderWhy = `no ladder: the Owner set its largest raise to 0 % (${c.ladderMaxPct.by ?? c.ladderMaxPct.source})`
    else {
      const pct = Math.min(rung, maxPct)
      if (pct <= c.ladderedTodayPct) ladderWhy = `on the ladder at +${c.ladderedTodayPct} % already today (this hour's rung +${pct} %)`
      else {
        const cap = Math.min(input.limits.maxCents, c.maxCents ?? Infinity)
        const cents = Math.max(0, Math.min(Math.round((step * pct) / 100), cap - step))
        if (cents <= 0) ladderWhy = 'no ladder: the budget is at its highest already'
        else {
          const check = dayMoveCheck({ openingCents: c.openingCents, intendedCents: step + cents, bounds, ladder: { baseCents: step, pct, maxPct } })
          ladder = { pct, cents, exception: check.exception === 'intraday-give-back', allowed: check.allowed, why: `${pctOf(c.usage)} % used, ${band.why}: +${pct} % of today's ${w(step)} = ${w(step + cents)} (the ${rung === pct ? `rung before ${LADDER_RUNGS.find((r) => r.pct === rung)?.before}:00` : `Owner's largest raise ${maxPct} %`}); ${check.why}` }
          ladderWhy = ladder.why
        }
      }
    }
    return { ...base, action, targetCents: target, stepCents: step, expectedSpendCents: exp, ladder, ladderWhy, ladderTodayPct: Math.max(ladder?.pct ?? 0, c.ladderedTodayPct), dayMove: { ...base.dayMove, bounded }, why: parts.join('; ') }
  })
  return { campaigns: decisions, scale, fitWhy }
}

/**
 * > 105 %: the weakest own campaigns to stop until the projection is back to the envelope — no sales first (most spend
 * first), then the highest ACoS (lowest marginal profit until U2 measures it). Each one's run rate leaves the projection.
 * Enabled own campaigns that spend only: a shared campaign (D2), one the Owner excluded and one whose budget he holds
 * are never the brain's to stop. Pure.
 */
export function weakestToStop(campaigns: ReadonlyArray<Pick<CampaignMoneyFacts, 'campaignId' | 'name' | 'status' | 'owner' | 'avgDailySpendCents' | 'settled' | 'excluded' | 'budgets'>>, projectedCents: number, envelopeCents: number, daysAhead: number): Array<{ campaignId: string; name: string; savesCents: number }> {
  const candidates = campaigns
    .filter((c) => c.owner === 'product' && c.status === 'ENABLED' && !c.excluded && !c.budgets.lock && (c.avgDailySpendCents ?? 0) > 0)
    .map((c) => ({ c, acos: c.settled.salesCents > 0 ? c.settled.spendCents / c.settled.salesCents : Infinity }))
    .sort((a, b) => b.acos - a.acos || (b.c.avgDailySpendCents ?? 0) - (a.c.avgDailySpendCents ?? 0) || a.c.campaignId.localeCompare(b.c.campaignId))
  const out: Array<{ campaignId: string; name: string; savesCents: number }> = []
  let projected = projectedCents
  for (const { c } of candidates) {
    if (projected <= envelopeCents) break
    const saves = Math.round((c.avgDailySpendCents ?? 0) * daysAhead)
    out.push({ campaignId: c.campaignId, name: c.name, savesCents: saves })
    projected -= saves
  }
  return out
}

/** The level a lever resolves to, as the plan names it. */
export type LeverLevel = BrainLevel | 'LOCKED' | 'EXCLUDED' | 'NOT_ENROLLED'

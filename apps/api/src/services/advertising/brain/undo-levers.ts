/**
 * ONE BRAIN AB-15 — auto-undo per lever (design 2026-10-08-ads-one-brain/DESIGN.md §2.14, §5, §8 row AB-15): what auto-undo
 * (automation A19, ads-auto-undo.service.ts) judges of each brain lever's own writes, besides the bid brain's bids it judged
 * already (BB-10: an undone brain bid pins its keyword 7 days, UNDO_PIN, and holds its campaign — unchanged). Pure: no
 * database, no clock. brain/undo-run.ts reads the facts, judges with these functions, records and acts; brain/lever-holds.ts
 * gives each lever's run the holds that follow an undo.
 *
 * Per lever (BRAIN_UNDO_RULES has the words, the windows and the hold; the numbers are A19's own per market,
 * ads-auto-undo-thresholds.ts — minClicks, minSpendCents, acosPointsUp, spendUpPct, maxUndosPerDay):
 *
 *   lever           judged                          worse when                                  undo                      hold
 *   budgets         a base RAISE of a campaign's    spend rose > spendUpPct % and no order      the budget back (the       7 days: no
 *                   daily budget by the money       after; or ACoS after above the band's top    Undo's own path, its       budget write
 *                   writer (AB-8)                   by > acosPointsUp points and above before    5-minute window)           on it
 *   portfolioCap    a RAISE of an Amazon portfolio  the portfolio spent past the old cap since,  the old cap (set-portfolio) 7 days: no cap
 *                   cap by the money writer         and that spend brought no order or an ACoS   — always a person: past    write on it
 *                                                   past the band's top                          it every campaign stops
 *   state · pause   a pause for a stop of days      its cause ended, it is still paused, and it  resume (enable-ads) —      7 days: no
 *                   (AB-12)                         brought orders in the days before            always a person            pause of it
 *   state · resume  a resume when a stop ended      ≥ minClicks and ≥ minSpend after and no      pause it again             7 days: no
 *                                                   order, or ACoS past the band's top            (it only lowers spend)     resume of it
 *   negatives       a negative the brain added      the term brought ≥ 2 orders on the other     revive: the negative       30 days: the
 *                   (AB-10)                         products' campaigns of the market since,     retired (archived)         term not
 *                                                   at an ACoS inside the product's band top                                negated again
 *   harvest         the brain's harvest pair        AB-11's own judgement (window + 72 hours)     the pair back together:    AB-11's
 *                   (AB-11, brain/harvest-undo.ts)  says WORSE                                    keyword paused, source     cooldown (30
 *                                                                                                 negatives retired          days)
 *   biddingStrategy a switch outside a stop         ACoS up > acosPointsUp points and sales not  the strategy back         14 days: no
 *                   (AB-17; a stop's switch and its up; or to up-and-down with spend up >     (set-campaign-settings) —  switch of it
 *                   give-back are never judged)     spendUpPct % and sales not up                always a person
 *
 * Never judged (left alone, counted): a cut of a budget or a cap (the pace's brake — undoing it would raise), a ladder rung
 * (the brain gives it back the next budget day), a first cap where none was, a stop's switch of the bidding strategy and its
 * give-back, a person's own change and a request a person approved (they write as the person, never as the brain).
 *
 *   asymmetry   an undo that only lowers spend (a re-pause, a budget or cap back down, a harvest put back) may run alone at
 *               AUTO; one that adds spend or lifts an automatic pause (a resume, a strategy back, a revive) or that may stop
 *               a whole portfolio (a cap back) always asks a person (`ceiling` PROPOSE). Batch 2 review fix — a revive lets a
 *               term serve again at its sources' full bids: it adds spend. Design §2.7 revives at a low bid; the retire path
 *               has no bid to set (a retired negative serves at whatever the source bids), so auto-undo asks a person.
 *   kill        a lever the Owner's kill switch stopped is never written by auto-undo alone either: at AUTO it asks him.
 *   levels      auto-undo's own level (OBSERVE records, PROPOSE asks, AUTO acts — its switch under the env and the dial) and
 *               the same daily cap per market as the bid brain's undos (one count).
 *   words       no money in a `why`: counts and percentage points only (amounts stay under the evidence's keys).
 */
import { BRAIN_ACTOR } from '../bid-brain/live.js'
import { BRAIN_NEGATIVES_ACTOR, BRAIN_STATE_ACTOR, PRODUCT_BRAIN_ACTOR } from '../ads-write-gate.js'
import type { AutoUndoThresholds } from '../ads-auto-undo-thresholds.js'
import type { AutomationLevel } from '../../automation/automation-levels.js'
import { BASE_LAYER, LADDER_LAYER, MONEY_BUDGETS_ACTOR, MONEY_PORTFOLIO_ACTOR } from './budget-ladder.js'

export const BRAIN_UNDO_LEVERS = ['budgets', 'portfolioCap', 'state', 'negatives', 'harvest', 'biddingStrategy'] as const
export type BrainUndoLever = (typeof BRAIN_UNDO_LEVERS)[number]
export const isBrainUndoLever = (v: unknown): v is BrainUndoLever => typeof v === 'string' && (BRAIN_UNDO_LEVERS as readonly string[]).includes(v)

/** The kind of change within a lever: what the rule, the undo and the hold are about. */
export type BrainChangeKind = 'raise' | 'pause' | 'resume' | 'add' | 'harvest' | 'switch'

export interface LeverUndoRule {
  /** What is judged, in words. */
  judges: string
  /** What the verdict reads, in words. */
  metric: string
  /** The settled days after the change a verdict waits for (at least), and the most it reads. */
  minDays: number
  maxDays: number
  /** Changes older than this are not judged; a judgement still short of data then is closed for good. */
  lookbackDays: number
  worse: string
  undo: string
  /** After an undo the brain leaves the entity's lever this many days (UNDO_PIN's 7 for a bid). */
  holdDays: number
  hold: string
  /** The most auto-undo does alone (see `asymmetry` above). */
  ceiling: 'AUTO' | 'PROPOSE'
}

/** Each lever's (and each state kind's) rule. Key: lever, or `state:pause` / `state:resume`. */
export const BRAIN_UNDO_RULES: Readonly<Record<BrainUndoLever | 'state:pause' | 'state:resume', LeverUndoRule>> = Object.freeze({
  budgets: {
    judges: 'a base raise of a campaign\'s daily budget by the brain\'s money writer (AB-8); a ladder rung (given back the next budget day) and a cut (the pace\'s brake) are never judged',
    metric: 'the campaign\'s spend, orders and ACoS in the settled days after the raise against as many days before, and the product\'s ACoS band',
    minDays: 3, maxDays: 7, lookbackDays: 14,
    worse: 'only spend, not orders at the target: its spend rose by more than spendUpPct % and it brought no order after, or its ACoS after is above the band\'s top by more than acosPointsUp points and above its ACoS before',
    undo: 'the daily budget goes back to its value before the raise, through the Undo\'s own path (compare-and-set, the ads audit, the 5-minute window to cancel)',
    holdDays: 7, hold: 'the brain writes no budget of that campaign for 7 days', ceiling: 'AUTO',
  },
  portfolioCap: {
    judges: 'a raise of an Amazon portfolio cap by the brain\'s money writer (AB-8); a first cap where none was, and a lower cap, are never judged',
    metric: 'the spend of the portfolio\'s campaigns this month against the old cap, and their orders and ACoS since the raise',
    minDays: 3, maxDays: 14, lookbackDays: 31,
    worse: 'the portfolio spent past the old cap since the raise, and that spend brought no order or an ACoS above the band\'s top by more than acosPointsUp points',
    undo: 'the cap goes back to its old amount (set-portfolio) — always a person: with this month\'s spend past it, every campaign of the portfolio stops until the 1st',
    holdDays: 7, hold: 'the brain writes no cap of that portfolio for 7 days', ceiling: 'PROPOSE',
  },
  state: {
    judges: 'a pause the state brain made for a stop of several days, and its resume when the stop ended (AB-12)',
    metric: 'see state:pause and state:resume',
    minDays: 3, maxDays: 7, lookbackDays: 30,
    worse: 'see state:pause and state:resume', undo: 'see state:pause and state:resume',
    holdDays: 7, hold: 'see state:pause and state:resume', ceiling: 'PROPOSE',
  },
  'state:pause': {
    judges: 'a pause the state brain made for a stop of several days (AB-12)',
    metric: 'whether the stop\'s cause has ended (the state brain\'s newest decision on the campaign) and the campaign\'s orders in the days before the pause',
    minDays: 3, maxDays: 7, lookbackDays: 30,
    worse: 'a pause that costs sales: its cause ended, it is still paused, and it brought orders in the days before',
    undo: 'resume it (enable-ads) — always a person: a resume adds spend and lifts an automatic pause',
    holdDays: 7, hold: 'the brain pauses that campaign again only after 7 days', ceiling: 'PROPOSE',
  },
  'state:resume': {
    judges: 'a resume the state brain made when a stop ended (AB-12)',
    metric: 'the campaign\'s clicks, spend, orders and ACoS in the settled days after the resume, and the product\'s ACoS band',
    minDays: 3, maxDays: 7, lookbackDays: 14,
    worse: 'a resume into waste: at least minClicks clicks and minSpendCents of spend after and no order, or an ACoS above the band\'s top by more than acosPointsUp points',
    undo: 'pause it again (it only lowers spend)',
    holdDays: 7, hold: 'the brain resumes that campaign again only after 7 days', ceiling: 'AUTO',
  },
  negatives: {
    judges: 'a negative the brain\'s negatives run added (AB-10)',
    metric: 'the negated term\'s orders and ACoS on the other products\' campaigns of the market — a sibling, or the market — in the settled days since it landed',
    minDays: 7, maxDays: 14, lookbackDays: 30,
    worse: 'the term converts elsewhere: at least 2 orders on the other products\' campaigns of the market since it landed, at an ACoS inside the product\'s band top',
    undo: 'revive it: the negative is retired (archived at Amazon) through the retire path, so the term can serve again — always a person: it adds spend, and the retire path cannot revive it at a low bid (design §2.7)',
    holdDays: 30, hold: 'the brain does not negate that term in the product again for 30 days', ceiling: 'PROPOSE',
  },
  harvest: {
    judges: 'a harvest pair the brain made (AB-11): the exact keyword in its destination and the negative exact in its sources',
    metric: 'AB-11\'s own judgement of the keyword after the attribution window + 72 hours, against the evidence it was harvested on',
    minDays: 10, maxDays: 30, lookbackDays: 45,
    worse: 'AB-11 judged it WORSE (it stopped converting, or its ACoS is above the band\'s top and clearly worse than when harvested)',
    undo: 'the pair goes back together: the keyword paused and the source negatives retired (AB-11\'s own undo)',
    holdDays: 30, hold: 'AB-11\'s cooldown: the term is not harvested again for 30 days', ceiling: 'AUTO',
  },
  biddingStrategy: {
    judges: 'a switch of Amazon\'s bidding strategy the brain made outside a stop (AB-17); a stop\'s switch to down only and its give-back are never judged',
    metric: 'the campaign\'s ACoS, spend and sales in the settled days after the switch against as many days before',
    minDays: 7, maxDays: 14, lookbackDays: 30,
    worse: 'its ACoS rose by more than acosPointsUp points and its sales did not rise, or (a switch to up and down) its spend rose by more than spendUpPct % and its sales did not',
    undo: 'the strategy goes back (set-campaign-settings) — always a person: the gate passes only the brain, a person and the repairs on a strategy, and a switch needs approval (N4)',
    holdDays: 14, hold: 'the brain switches that campaign\'s strategy again only after 14 days', ceiling: 'PROPOSE',
  },
})

/** The rule of one change. */
export const ruleOf = (lever: BrainUndoLever, kind: BrainChangeKind): LeverUndoRule =>
  lever === 'state' ? BRAIN_UNDO_RULES[kind === 'resume' ? 'state:resume' : 'state:pause'] : BRAIN_UNDO_RULES[lever]

/** The longest lookback of every rule: the span of writes one run reads. */
export const BRAIN_UNDO_LOOKBACK_DAYS = Math.max(...Object.values(BRAIN_UNDO_RULES).map((r) => r.lookbackDays))

// ── Which brain write is which change ───────────────────────────────────────────────────────────────────────────────

export interface BrainChangeRow {
  id: string
  entityType: string
  entityId: string
  actionType: string
  userId: string | null
  payloadBefore: unknown
  payloadAfter: unknown
  evidence: unknown
  createdAt: Date
}

export type BrainChange =
  | { lever: 'budgets'; kind: 'raise'; campaignId: string; fromCents: number; toCents: number }
  | { lever: 'portfolioCap'; kind: 'raise'; portfolioRowId: string; externalPortfolioId: string | null; fromCents: number; toCents: number }
  | { lever: 'state'; kind: 'pause' | 'resume'; campaignId: string; from: string; to: string }
  | { lever: 'negatives'; kind: 'add'; negativeId: string; text: string | null }
  | { lever: 'biddingStrategy'; kind: 'switch'; campaignId: string; from: string; to: string }

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const num = (v: unknown): number | null => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** The bid brain's stop recipe records its strategy switches under these layers: a stop and its give-back, never judged. */
export const STOP_LAYERS: ReadonlySet<string> = new Set(['stop', 'stock', 'min_bid_hour', 'restore'])

/** The brain's actors whose writes auto-undo judges here (the bid brain's keyword bids stay A19's own path). */
export const isProductBrainActor = (actor: string | null | undefined): boolean => !!actor && (actor === PRODUCT_BRAIN_ACTOR || actor.startsWith(`${PRODUCT_BRAIN_ACTOR}-`))

/** The writes the brain's pass reads: the product brain's family, and the bid brain's campaign writes (its strategy). */
export const brainUndoActorWhere = () => ({ OR: [{ userId: { startsWith: `${PRODUCT_BRAIN_ACTOR}-` } }, { userId: PRODUCT_BRAIN_ACTOR }, { userId: BRAIN_ACTOR, entityType: 'CAMPAIGN' }] })

const layerOf = (evidence: unknown): string | null => str(obj(obj(evidence).brain).layer)

/** Pure — which brain lever one logged write moved, which way and from what to what; or why it is not judged here. */
export function brainChangeOf(row: BrainChangeRow): BrainChange | { skip: string } {
  const before = obj(row.payloadBefore)
  const after = obj(row.payloadAfter)
  const actor = row.userId ?? ''
  if (actor === MONEY_BUDGETS_ACTOR) {
    if (row.entityType !== 'CAMPAIGN') return { skip: 'not a campaign budget' }
    const from = num(before.dailyBudget)
    const to = num(after.dailyBudget)
    if (from == null || to == null || from === to) return { skip: 'it moved no daily budget' }
    const layer = layerOf(row.evidence)
    if (layer === LADDER_LAYER) return { skip: 'a ladder rung: the brain gives it back the next budget day' }
    if (to < from) return { skip: 'a budget cut is the pace\'s brake: never undone (undoing it would raise)' }
    if (layer && layer !== BASE_LAYER) return { skip: `a ${layer} write, not the day's base move` }
    return { lever: 'budgets', kind: 'raise', campaignId: row.entityId, fromCents: Math.round(from * 100), toCents: Math.round(to * 100) }
  }
  if (actor === MONEY_PORTFOLIO_ACTOR) {
    if (row.entityType !== 'PORTFOLIO') return { skip: 'not a portfolio cap' }
    const from = num(before.budgetAmount)
    const to = num(after.budgetAmount)
    if (to == null) return { skip: 'it set no cap amount' }
    if (from == null) return { skip: 'a first cap where none was: it only limits spend, never undone' }
    if (to <= from) return { skip: to === from ? 'it moved no cap' : 'a lower cap only limits spend: never undone' }
    return { lever: 'portfolioCap', kind: 'raise', portfolioRowId: row.entityId, externalPortfolioId: str(after.portfolioId) ?? str(before.portfolioId), fromCents: Math.round(from * 100), toCents: Math.round(to * 100) }
  }
  if (actor === BRAIN_STATE_ACTOR) {
    const from = str(before.status)
    const to = str(after.status)
    if (row.entityType !== 'CAMPAIGN' || !from || !to || from === to) return { skip: 'it changed no campaign status' }
    if (to === 'PAUSED' && from === 'ENABLED') return { lever: 'state', kind: 'pause', campaignId: row.entityId, from, to }
    if (to === 'ENABLED' && from === 'PAUSED') return { lever: 'state', kind: 'resume', campaignId: row.entityId, from, to }
    return { skip: `a status change from ${from} to ${to} is not a pause or a resume the brain makes` }
  }
  if (actor === BRAIN_NEGATIVES_ACTOR) {
    if (row.entityType !== 'AD_TARGET' || !row.actionType.startsWith('create_negative')) return { skip: 'not a negative the brain added (a retire is never undone: archive is terminal)' }
    return { lever: 'negatives', kind: 'add', negativeId: row.entityId, text: str(after.keywordText) ?? str(after.text) ?? str(after.asin) ?? str(after.expressionValue) }
  }
  if (actor === BRAIN_ACTOR || isProductBrainActor(actor)) {
    const from = str(before.biddingStrategy)
    const to = str(after.biddingStrategy)
    if (row.entityType === 'CAMPAIGN' && from && to && from !== to) {
      const layer = layerOf(row.evidence)
      if (layer && STOP_LAYERS.has(layer)) return { skip: 'a stop\'s switch of the bidding strategy, or its give-back: never auto-undone' }
      return { lever: 'biddingStrategy', kind: 'switch', campaignId: row.entityId, from, to }
    }
    return { skip: 'not a write of a brain lever auto-undo judges here' }
  }
  return { skip: 'not the brain\'s write' }
}

// ── The figures and the verdicts ────────────────────────────────────────────────────────────────────────────────────

/** Spend, sales, clicks and orders summed over some days; ACoS = spend ÷ sales (null without sales). Money in minor units. */
export interface Period { spendCents: number; salesCents: number; clicks: number; orders: number; acos: number | null; days: number }
export interface Sums { spendCents: number; salesCents: number; clicks: number; orders: number }

export const periodOf = (s: Sums, days: number): Period => ({ ...s, days, acos: s.salesCents > 0 ? s.spendCents / s.salesCents : null })

const DAY_MS = 86_400_000
export const isoDay = (at: Date | string): string => new Date(at).toISOString().slice(0, 10)
export const plusDays = (d: string, n: number): string => isoDay(new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS))

/** Pure — the sums of a daily map over [from, to] (days as YYYY-MM-DD). */
export function sumDays(days: ReadonlyMap<string, Sums> | undefined, from: string, to: string): Sums {
  const out: Sums = { spendCents: 0, salesCents: 0, clicks: 0, orders: 0 }
  for (const [d, s] of days ?? []) {
    if (d < from || d > to) continue
    out.spendCents += s.spendCents
    out.salesCents += s.salesCents
    out.clicks += s.clicks
    out.orders += s.orders
  }
  return out
}

/**
 * Pure — the equal windows around a change of day `d`: after = the settled days from d+1 (at most `maxDays`), before = as
 * many days before d. Null while fewer than `minDays` settled days are in (it waits).
 */
export function windowsAround(d: string, settledThrough: string, rule: Pick<LeverUndoRule, 'minDays' | 'maxDays'>): { days: number; before: { from: string; to: string }; after: { from: string; to: string } } | null {
  const first = plusDays(d, 1)
  if (settledThrough < first) return null
  const have = Math.round((Date.parse(`${settledThrough}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY_MS) + 1
  if (have < rule.minDays) return null
  const days = Math.min(have, rule.maxDays)
  return { days, before: { from: plusDays(d, -days), to: plusDays(d, -1) }, after: { from: first, to: plusDays(d, days) } }
}

export type BrainVerdict = 'not_enough_data' | 'not_worse' | 'worse'
export interface BrainJudged { verdict: BrainVerdict; why: string }

/** The product's ACoS band (fractions), when its strategy holds a goal. */
export interface Band { aim: number; lo: number; hi: number }

const pts = (fraction: number) => Math.round(fraction * 1000) / 10
const short = (e: Period, t: AutoUndoThresholds) => e.clicks < t.minClicks || e.spendCents < t.minSpendCents
const tooLittle = (e: Period, t: AutoUndoThresholds): BrainJudged =>
  ({ verdict: 'not_enough_data', why: `too little data to judge: ${e.clicks} clicks in the ${e.days} days after; it needs ${t.minClicks} clicks and ${t.minSpendCents} of spend (minor units)` })

/** budgets — did the raise bring orders at the target, or only spend? */
export function judgeBudgetRaise(x: { before: Period; after: Period; band: Band | null; t: AutoUndoThresholds }): BrainJudged {
  const { before: b, after: a, t } = x
  if (short(a, t)) return tooLittle(a, t)
  const spendUp = b.spendCents > 0 ? a.spendCents > b.spendCents * (1 + t.spendUpPct / 100) : a.spendCents > 0
  if (spendUp && a.orders === 0) return { verdict: 'worse', why: `only spend: in the ${a.days} days after the raise its spend rose by more than ${t.spendUpPct} % and it brought no order` }
  if (x.band && a.acos != null && a.spendCents > b.spendCents && a.acos > x.band.hi && pts(a.acos - x.band.hi) > t.acosPointsUp && (b.acos == null || a.acos > b.acos)) {
    return { verdict: 'worse', why: `orders above the target: in the ${a.days} days after the raise its ACoS is ${pts(a.acos - x.band.hi)} points above the band's top (more than ${t.acosPointsUp}) and above its ACoS before` }
  }
  if (a.spendCents <= b.spendCents) return { verdict: 'not_worse', why: `the budget did not bind: its spend did not rise in the ${a.days} days after the raise` }
  return { verdict: 'not_worse', why: x.band ? `the raise brought ${a.orders} orders in the ${a.days} days after, inside the band (or not clearly above it)` : `the raise brought ${a.orders} orders in the ${a.days} days after; the product has no ACoS band to measure them against` }
}

/** portfolioCap — did the spend the raise let past the old cap bring orders at the target? */
export function judgePortfolioRaise(x: { monthSpendCents: number; oldCapCents: number; since: Period; band: Band | null; t: AutoUndoThresholds }): BrainJudged {
  const { since: s, t } = x
  if (x.monthSpendCents <= x.oldCapCents) return { verdict: 'not_worse', why: 'the old cap never bound this month: the portfolio\'s spend stayed under it, so the raise changed nothing' }
  if (s.spendCents < t.minSpendCents) return tooLittle(s, t)
  if (s.orders === 0) return { verdict: 'worse', why: `the portfolio spent past the old cap, and in the ${s.days} days since the raise its campaigns brought no order` }
  if (x.band && s.acos != null && s.acos > x.band.hi && pts(s.acos - x.band.hi) > t.acosPointsUp) return { verdict: 'worse', why: `the portfolio spent past the old cap, and since the raise its ACoS is ${pts(s.acos - x.band.hi)} points above the band's top (more than ${t.acosPointsUp})` }
  return { verdict: 'not_worse', why: `the spend past the old cap brought ${s.orders} orders, inside the band (or not clearly above it)` }
}

/** state · pause — a pause whose cause ended but which still costs the sales it made. */
export function judgePause(x: { causeEnded: boolean | null; causeWhy: string | null; before: Period }): BrainJudged {
  if (x.causeEnded == null) return { verdict: 'not_worse', why: 'the state brain has decided nothing on it since the pause: its stop is taken as going on' }
  if (!x.causeEnded) return { verdict: 'not_worse', why: `its stop goes on${x.causeWhy ? `: ${x.causeWhy}` : ''}` }
  if (x.before.orders === 0) return { verdict: 'not_worse', why: `its cause ended, but it brought no order in the ${x.before.days} days before the pause: the pause costs nothing it made` }
  return { verdict: 'worse', why: `a pause that costs sales: its cause ended${x.causeWhy ? ` (${x.causeWhy})` : ''}, it is still paused, and it brought ${x.before.orders} orders in the ${x.before.days} days before the pause` }
}

/** state · resume — a resume into waste. */
export function judgeResume(x: { after: Period; band: Band | null; t: AutoUndoThresholds }): BrainJudged {
  const { after: a, t } = x
  if (short(a, t)) return tooLittle(a, t)
  if (a.orders === 0) return { verdict: 'worse', why: `a resume into waste: ${a.clicks} clicks in the ${a.days} days after the resume and no order` }
  if (x.band && a.acos != null && a.acos > x.band.hi && pts(a.acos - x.band.hi) > t.acosPointsUp) return { verdict: 'worse', why: `a resume into waste: in the ${a.days} days after, its ACoS is ${pts(a.acos - x.band.hi)} points above the band's top (more than ${t.acosPointsUp})` }
  return { verdict: 'not_worse', why: `it brought ${a.orders} orders in the ${a.days} days after the resume, inside the band (or not clearly above it)` }
}

/** The orders a negated term needs elsewhere in the market to show it converts. */
export const REVIVE_MIN_ORDERS = 2

/** negatives — a negated term a sibling or the market shows converting. */
export function judgeNegative(x: { elsewhere: Period; band: Band | null }): BrainJudged {
  const e = x.elsewhere
  if (e.orders < REVIVE_MIN_ORDERS) return { verdict: 'not_worse', why: e.clicks ? `the other products' campaigns of the market brought ${e.orders} orders on it in ${e.days} days (it needs ${REVIVE_MIN_ORDERS}): it does not show converting` : `no other product's campaign of the market served it in the ${e.days} days since` }
  if (x.band && e.acos != null && e.acos > x.band.hi) return { verdict: 'not_worse', why: `it converts elsewhere in the market (${e.orders} orders in ${e.days} days), but at an ACoS above the product's band top: the negative stands` }
  return { verdict: 'worse', why: `the term converts elsewhere in the market: ${e.orders} orders on the other products' campaigns in the ${e.days} days since it was negated${x.band ? ', at an ACoS inside the product\'s band top' : ''} — the negative costs the product sales` }
}

/** biddingStrategy — a switch outside a stop. */
export function judgeStrategySwitch(x: { before: Period; after: Period; to: string; t: AutoUndoThresholds }): BrainJudged {
  const { before: b, after: a, t } = x
  if (short(a, t)) return tooLittle(a, t)
  if (b.acos != null && a.acos != null && pts(a.acos - b.acos) > t.acosPointsUp && a.salesCents <= b.salesCents) {
    return { verdict: 'worse', why: `its ACoS rose ${pts(a.acos - b.acos)} points (more than ${t.acosPointsUp}) in the ${a.days} days after the switch, and its sales did not rise` }
  }
  if (x.to === 'AUTO_FOR_SALES' && a.spendCents > b.spendCents * (1 + t.spendUpPct / 100) && a.salesCents <= b.salesCents) {
    return { verdict: 'worse', why: `after the switch to up and down its spend rose by more than ${t.spendUpPct} % in ${a.days} days, and its sales did not` }
  }
  return { verdict: 'not_worse', why: `not clearly worse in the ${a.days} days after the switch` }
}

// ── What auto-undo does ─────────────────────────────────────────────────────────────────────────────────────────────

export type BrainAction = 'none' | 'would_undo' | 'proposed' | 'undone' | 'held'

/**
 * Pure — what auto-undo does with one judgement of a brain lever, at its level, inside the shared daily cap. Like the bid
 * path (ads-auto-undo.service.ts decideAction): OBSERVE would undo, PROPOSE asks, AUTO acts — but AUTO acts alone only
 * where the lever's rule lets it (`ceiling`) and the Owner's kill switch does not stop the lever; else it asks a person.
 */
export function decideBrainAction(x: { verdict: BrainVerdict; level: AutomationLevel; rule: Pick<LeverUndoRule, 'ceiling'>; kill: string | null; capLeft: number; cap: number; market: string | null }): { action: BrainAction; reason: string } {
  if (x.verdict !== 'worse') return { action: 'none', reason: x.verdict === 'not_enough_data' ? 'too little data after it to judge (never "worse")' : 'not clearly worse' }
  if (x.level === 'OFF') return { action: 'none', reason: 'auto-undo is off' }
  if (x.capLeft <= 0) return { action: 'held', reason: `past the daily cap of ${x.cap} undos in ${x.market ?? 'this market'}: tomorrow's run looks again` }
  if (x.level === 'OBSERVE') return { action: 'would_undo', reason: 'OBSERVE: it would undo this; nothing was changed' }
  if (x.level === 'PROPOSE') return { action: 'proposed', reason: 'PROPOSE: a person decides the undo in the Approvals page' }
  if (x.kill) return { action: 'proposed', reason: `AUTO, but the lever is ${x.kill}: auto-undo writes nothing on it alone — a person decides the undo in the Approvals page` }
  if (x.rule.ceiling === 'PROPOSE') return { action: 'proposed', reason: 'AUTO, but this undo always goes to a person (it adds spend, lifts an automatic pause or may stop a whole portfolio): the Approvals page' }
  return { action: 'undone', reason: 'AUTO: put back by auto-undo, inside its caps' }
}

// ── The hold after an undo ──────────────────────────────────────────────────────────────────────────────────────────

/** One brain change auto-undo put back (alone, or by a person's approved request): the rows the holds are read from. */
export interface UndoneChange {
  id: string
  lever: string
  /** The change's kind (the judgement's `direction`). */
  kind: string
  /** CAMPAIGN / AD_TARGET / PORTFOLIO id of the change (campaign, negative, portfolio row). */
  entityId: string
  /** From the judgement's evidence: the product, the campaign, the term, Amazon's portfolio id. */
  campaignId: string | null
  term: string | null
  externalPortfolioId: string | null
  actionAt: Date
}

export interface LeverUndoHolds {
  /** campaignId → the hold (and the action it blocks: a pause or a resume for the state lever; null: every write of the lever). */
  campaigns: Map<string, { why: string; blocks: 'pause' | 'resume' | null; until: string }>
  /** A normalised term → the hold (negatives). */
  terms: Map<string, { why: string; until: string }>
  /** A portfolio (Amazon's id, else Nexus's row id) → the hold. */
  portfolios: Map<string, { why: string; until: string }>
}

export const normTerm = (t: string): string => t.trim().toLowerCase().replace(/\s+/g, ' ')

/** Pure — the holds of one lever that are still in force at `now`, from the changes auto-undo put back. */
export function holdsOf(rows: readonly UndoneChange[], lever: BrainUndoLever, now: Date): LeverUndoHolds {
  const out: LeverUndoHolds = { campaigns: new Map(), terms: new Map(), portfolios: new Map() }
  for (const r of [...rows].sort((a, b) => a.actionAt.getTime() - b.actionAt.getTime())) {
    if (r.lever !== lever) continue
    const rule = ruleOf(lever, r.kind as BrainChangeKind)
    const until = new Date(r.actionAt.getTime() + rule.holdDays * DAY_MS)
    if (until <= now) continue
    const why = `auto-undo put back a brain change here on ${isoDay(r.actionAt)} (judgement ${r.id}): ${rule.hold} — held until ${isoDay(until)}`
    const at = until.toISOString()
    if (lever === 'negatives') { if (r.term) out.terms.set(normTerm(r.term), { why, until: at }) }
    else if (lever === 'portfolioCap') out.portfolios.set(r.externalPortfolioId ?? r.entityId, { why, until: at })
    else if (r.campaignId) out.campaigns.set(r.campaignId, { why, until: at, blocks: lever === 'state' ? (r.kind === 'pause' ? 'pause' : 'resume') : null })
  }
  return out
}

/** Does a negative of this text and match block a held term (exact: the same; phrase: its words inside the term)? Pure. */
export function blocksHeldTerm(text: string, match: string, held: ReadonlyMap<string, unknown>): string | null {
  const t = normTerm(text)
  if (held.has(t)) return t
  if (match !== 'PHRASE') return null
  const words = ` ${t} `
  for (const term of held.keys()) if (` ${term} `.includes(words)) return term
  return null
}

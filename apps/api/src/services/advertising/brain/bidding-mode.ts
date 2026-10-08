/**
 * ONE BRAIN AB-17 — the bidding-strategy lever of a product's brain (design 2026-10-08-ads-one-brain/DESIGN.md §2.11, §4
 * "weekly", §5 "one switch per 14 days per campaign — the stack ceiling counts the dynamic factor", §8 row AB-17, §10 N4).
 * Pure: brain/bidding-mode-load.ts reads the facts, brain/bidding-mode-run.ts logs, asks and writes, brain/bidding-mode-
 * read.ts shows them.
 *
 *   the choice   Amazon's three bidding strategies (Campaign.biddingStrategy): MANUAL "fixed", LEGACY_FOR_SALES "down only"
 *                (Amazon may lower a bid where a click is less likely to convert) and AUTO_FOR_SALES "up and down" (it may
 *                raise it too, up to +100 % [AMZ-5]). Rule-based bidding and "ROAS within budget" are never chosen: they put
 *                a second brain inside Amazon (§2.11, §2.12). For each of the product's own campaigns, the first that fits:
 *                  exact    fixed — the campaign's hourly plan sets its placement % hour by hour AND the brain writes those
 *                           placements (the bid brain runs the campaign LIVE or HELD, or the product's hours or placements
 *                           lever is the brain's): fixed bids pay exactly what the plan sets, Amazon adjusts nothing
 *                  new      down only — younger than NEW_CAMPAIGN_DAYS
 *                  launch   down only — the product's strategy phase is LAUNCH
 *                  thin     down only — the product had fewer than THIN_ORDERS_PER_30D ad orders in 30 settled days (design
 *                           §1), or they could not be read
 *                  tos      up and down — top of search converts at least TOS_CR_LIFT × the campaign's average over at least
 *                           TOS_MIN_ORDERS top-of-search orders (LANE_WINDOW_DAYS settled days of the placement report) AND
 *                           the stack with Amazon's raise stays inside the lane CPC ceiling (BB-18): the highest bid ×
 *                           (1 + placement %) × the dynamic factor (×2 top of search, ×1.5 elsewhere: rank-controller.ts
 *                           laneHeadroom) within the hourly plan's CPC ceiling, and top of search's within its sales per
 *                           click at the band's top ACoS. With no ceiling known it is never up and down
 *                  default  down only
 *   switchback   every switch is a test: the new strategy runs for whole weeks (TEST_WEEKS, or as many as the spacing), then
 *                the same days of the week after the switch are compared with as many before it — AB-15's judge
 *                (judgeStrategySwitch: ACoS up more than acosPointsUp points without more sales; up and down spending
 *                spendUpPct % more without more sales) and the product's band (ACoS after above the band's top by more than
 *                acosPointsUp points and above before). Worse → switched back. Too little data → up to EXTRA_TEST_WEEKS more
 *                weeks; then up and down goes back (no evidence it pays) and down only or fixed stays. Else kept
 *   no flip-flop a switch whose test was worse (switched back, or put back) is not tried again for RETEST_DAYS
 *   spacing      at most one switch per `biddingStrategySwitchDays` (14) per campaign — any switch on record outside a stop:
 *                the brain's, a person's, auto-undo's, one made outside Nexus. The stop recipe's down only and its give-back
 *                (AB-2) never count, and are never tests
 *   weekly       a NEW switch is decided on the weekly run (Monday, Europe/Rome — design §4); a test's verdict and the
 *                switch back on any run its data allows
 *   N4           for `strategyApprovalDays` (30) after the lever became the brain's on the product (the clock,
 *                AdsBrainLeverClock), every switch and every switch back is a request a person approves — at AUTO too.
 *                After them AUTO switches alone. strategySwitchMode ALWAYS_PROPOSE, or the lever at PROPOSE: always a
 *                request. The Owner sets each with set-ads-brain; his choice wins
 *   precedence   a stop holds the campaign → nothing: the stop recipe owns the strategy while it lasts (down only, given
 *                back after it, AB-2); a person's own strategy (a STRATEGY hold, or his change on record — in Nexus or one
 *                Amazon reports made outside it — for HOLD_DAYS) → nothing; the Owner's lock → nothing, the recommendation
 *                only; the bids pin → nothing (the gate would refuse); Amazon running its own strategy → nothing; the
 *                Owner's kill switch and auto-undo's hold after an undo (AB-15) → nothing
 *   levels       OFF / not enrolled / excluded / a shared campaign (D2) → nothing; OBSERVE → SHADOW (logged); PROPOSE → a
 *                request; AUTO → written as the brain (BRAIN_STRATEGY_ACTOR) through the normal campaign path and the
 *                write gate, only under the live server switch, while the account's ads automation runs, on the
 *                live-write allowlist
 *   never        a bid, a budget, a placement %, a status or a stock quantity: this lever writes the strategy only. No
 *                amount in a `why` (percent and counts only); the cents sit under `money`
 */
import { createHash } from 'node:crypto'
import { PLACEMENT_TOP } from '../ads-placement-math.js'
import type { AutoUndoThresholds } from '../ads-auto-undo-thresholds.js'
import { laneHeadroom } from '../rank-controller.js'
import { DOWN_ONLY, stackMaxCents, strategyWords, UP_AND_DOWN, type Placement } from '../bid-brain/stop-recipe.js'
import { judgeStrategySwitch, periodOf, plusDays, sumDays, type Band, type Period, type Sums } from './undo-levers.js'

export { DOWN_ONLY, UP_AND_DOWN }
/** Amazon's "fixed bids": never adjusted in the auction. */
export const FIXED = 'MANUAL'
/** The three strategies the brain chooses from (Campaign.biddingStrategy). */
export const KNOWN_STRATEGIES: readonly string[] = [FIXED, DOWN_ONLY, UP_AND_DOWN]

/** Up and down only where top of search converts at least this many times the campaign's average (§2.11). */
export const TOS_CR_LIFT = 1.3
/** … measured over at least this many top-of-search orders (§2.11: "over ≥ 30 orders"). */
export const TOS_MIN_ORDERS = 30
/** The placement report's settled days the lane evidence reads. */
export const LANE_WINDOW_DAYS = 60
/** A campaign younger than this runs down only (§2.11: "new"). */
export const NEW_CAMPAIGN_DAYS = 30
/** A product below this many ad orders in 30 settled days is thin (design §1; hours-research.ts THIN_ORDERS_PER_30D). */
export const THIN_ORDERS_PER_30D = 10
/** A switchback test runs at least this many whole weeks (as many as the spacing when that is longer). */
export const TEST_WEEKS = 2
/** A test short of data runs up to this many weeks more before its verdict is final. */
export const EXTRA_TEST_WEEKS = 2
/** A switch a person declined is not asked again for this long. */
export const DECLINE_DAYS = 14
/** A switch whose switchback test was worse is not tried again for this long (no flip-flop). */
export const RETEST_DAYS = 90
/** A person's own strategy holds the campaign this long (design §2.10, as the stop recipe's STRATEGY hold). */
export const HOLD_DAYS = 60
/** The lever's log is kept this long, its closed tests this long (Neon cost). */
export const DECISION_DAYS_KEPT = 30
export const TEST_DAYS_KEPT = 180
/** The weekly run: Monday in Europe/Rome (design §4). */
export const WEEKLY_DAY = 1
export const WEEKLY_TIME_ZONE = 'Europe/Rome'

const DAY_MS = 86_400_000
const day = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString()).slice(0, 10)
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const pts = (fraction: number) => Math.round(fraction * 1000) / 10
const times = (x: number) => `${Math.round(x * 100) / 100}×`
/** Amazon's strategy in the console's words: "fixed" · "down only" · "up and down". */
export const words = strategyWords

// ── The rules (pure) ─────────────────────────────────────────────────────────────────────────────────────────────────

export const MODE_RULES = ['exact', 'new', 'launch', 'thin', 'tos', 'default'] as const
export type ModeRule = (typeof MODE_RULES)[number]

/** One lane's figures from the placement report over the window. */
export interface LaneFigures { clicks: number; orders: number; salesCents: number }

/** Whether top of search converts well enough above the campaign's average to let Amazon raise its bids. Pure. */
export function laneEvidence(l: { tos: LaneFigures; all: LaneFigures } | null): { proves: boolean; lift: number | null; tosOrders: number; words: string } {
  if (!l || l.all.clicks <= 0) return { proves: false, lift: null, tosOrders: 0, words: `no placement report of its last ${LANE_WINDOW_DAYS} settled days` }
  const crAll = l.all.orders / l.all.clicks
  const crTos = l.tos.clicks > 0 ? l.tos.orders / l.tos.clicks : 0
  const lift = crAll > 0 ? crTos / crAll : null
  if (l.tos.orders < TOS_MIN_ORDERS) {
    return { proves: false, lift, tosOrders: l.tos.orders, words: `top of search had ${plural(l.tos.orders, 'order')} in ${LANE_WINDOW_DAYS} settled days — up and down needs ${TOS_MIN_ORDERS} to show it converts well above average` }
  }
  if (lift == null || lift < TOS_CR_LIFT) {
    return { proves: false, lift, tosOrders: l.tos.orders, words: `top of search converts ${lift == null ? 'no better than' : times(lift)} the campaign's average over ${plural(l.tos.orders, 'order')} — up and down needs ${times(TOS_CR_LIFT)}` }
  }
  return { proves: true, lift, tosOrders: l.tos.orders, words: `top of search converts ${times(lift)} the campaign's average over ${plural(l.tos.orders, 'order')} (${LANE_WINDOW_DAYS} settled days)` }
}

/** The bid stack under up and down against the lane CPC ceilings (BB-18). Cents; `words` names none. */
export interface CeilingCheck {
  allows: boolean
  words: string
  /** The most one click could cost under up and down on any lane, and on top of search. */
  stackCents: number | null
  tosStackCents: number | null
  /** The hourly plan's lowest CPC ceiling of the week; top of search's sales per click at the band's top ACoS. */
  planCeilingCents: number | null
  tosCeilingCents: number | null
}

/**
 * Whether Amazon's raise would keep the stack inside the lane CPC ceilings: the highest bid × (1 + the lane's placement %)
 * × the dynamic factor under up and down — within the hourly plan's CPC ceiling (every lane), and on top of search within
 * its sales per click at the band's top ACoS (what a click there may cost at the band's top). No ceiling known → no. Pure.
 */
export function ceilingCheck(x: { maxBidCents: number | null; placements: readonly Placement[]; planCeilingCents: number | null; tos: LaneFigures | null; band: Band | null }): CeilingCheck {
  const none = { stackCents: null, tosStackCents: null, planCeilingCents: x.planCeilingCents, tosCeilingCents: null }
  if (!x.maxBidCents || x.maxBidCents <= 0) return { allows: false, words: 'no enabled bid to measure the stack with', ...none }
  const tosPct = Math.max(0, x.placements.find((p) => p.placement === PLACEMENT_TOP)?.percentage ?? 0)
  const tosStackCents = Math.ceil(x.maxBidCents * (1 + tosPct / 100) * laneHeadroom(UP_AND_DOWN, PLACEMENT_TOP))
  const stackCents = Math.ceil(stackMaxCents(x.maxBidCents, x.placements, UP_AND_DOWN))
  const tosCeilingCents = x.band && x.tos && x.tos.clicks > 0 && x.tos.salesCents > 0 ? Math.floor((x.tos.salesCents / x.tos.clicks) * x.band.hi) : null
  const out = { stackCents, tosStackCents, planCeilingCents: x.planCeilingCents, tosCeilingCents }
  if (x.planCeilingCents == null && tosCeilingCents == null) {
    return { allows: false, words: 'no lane CPC ceiling holds the stack (no hourly plan ceiling, and no ACoS band or top-of-search sales to set one): never up and down without one', ...out }
  }
  const over: string[] = []
  if (x.planCeilingCents != null && stackCents > x.planCeilingCents) over.push('the hourly plan\'s CPC ceiling')
  if (tosCeilingCents != null && tosStackCents > tosCeilingCents) over.push('what a top-of-search click may cost at the band\'s top ACoS')
  const held = [x.planCeilingCents != null ? 'the hourly plan\'s CPC ceiling' : null, tosCeilingCents != null ? 'what a top-of-search click may cost at the band\'s top ACoS' : null].filter(Boolean).join(' and ')
  return over.length
    ? { allows: false, words: `with Amazon's raise (up to ×2 at the top of search) its highest bid could cost more than ${over.join(' and ')}`, ...out }
    : { allows: true, words: `with Amazon's raise its highest bid stays inside ${held}`, ...out }
}

/** The strategy the brain chooses for a campaign, the rule that chose it, and why. */
export interface ModeTarget {
  to: string
  rule: ModeRule
  why: string
  /** Top of search against the campaign (null: no report), its orders, and the stack check (made only for up and down). */
  lift: number | null
  tosOrders: number
  ceiling: CeilingCheck | null
}

/** What the rules read of one campaign (part of ModeFacts). */
export type TargetFacts = Pick<ModeFacts, 'ageDays' | 'phase' | 'productOrders30d' | 'band' | 'lanes' | 'placements' | 'maxBidCents' | 'plan' | 'brainRunsPlacements'>

/** The rules of §2.11 in their order (see the header). Pure. */
export function targetStrategy(f: TargetFacts): ModeTarget {
  const base = { lift: null, tosOrders: 0, ceiling: null }
  if (f.plan?.steersPlacements && f.brainRunsPlacements) {
    return { ...base, to: FIXED, rule: 'exact', why: `its hourly plan "${f.plan.name}" sets its placement % hour by hour and the brain writes them: fixed bids pay exactly what the plan sets (Amazon adjusts nothing)` }
  }
  if (f.ageDays < NEW_CAMPAIGN_DAYS) return { ...base, to: DOWN_ONLY, rule: 'new', why: `a new campaign (${plural(f.ageDays, 'day')} old, under ${NEW_CAMPAIGN_DAYS}): down only by default` }
  if (f.phase === 'LAUNCH') return { ...base, to: DOWN_ONLY, rule: 'launch', why: 'the product is in its LAUNCH phase: down only by default' }
  if (f.productOrders30d == null) return { ...base, to: DOWN_ONLY, rule: 'thin', why: 'the product\'s ad orders of 30 settled days could not be read: down only by default' }
  if (f.productOrders30d < THIN_ORDERS_PER_30D) return { ...base, to: DOWN_ONLY, rule: 'thin', why: `a thin product (${plural(f.productOrders30d, 'ad order')} in 30 settled days, under ${THIN_ORDERS_PER_30D}): down only by default` }
  const e = laneEvidence(f.lanes)
  if (!e.proves) return { ...base, lift: e.lift, tosOrders: e.tosOrders, to: DOWN_ONLY, rule: 'default', why: `${e.words}: down only` }
  const ceiling = ceilingCheck({ maxBidCents: f.maxBidCents, placements: f.placements, planCeilingCents: f.plan?.ceilingCents ?? null, tos: f.lanes?.tos ?? null, band: f.band })
  if (!ceiling.allows) return { lift: e.lift, tosOrders: e.tosOrders, ceiling, to: DOWN_ONLY, rule: 'default', why: `${e.words}, but ${ceiling.words}: down only` }
  return { lift: e.lift, tosOrders: e.tosOrders, ceiling, to: UP_AND_DOWN, rule: 'tos', why: `${e.words}, and ${ceiling.words}: up and down` }
}

// ── The switchback test (pure) ───────────────────────────────────────────────────────────────────────────────────────

/** A test's whole weeks: the one the spacing asks for, at least TEST_WEEKS. */
export const testWeeksOf = (switchDays: number): number => Math.max(TEST_WEEKS, Math.ceil(switchDays / 7))

/** The days a verdict compares: whole weeks after the switch day and as many before it (the same weekdays on both sides). */
export interface TestWindow { weeks: number; days: number; baseline: { from: string; to: string }; test: { from: string; to: string } }

/**
 * The test's windows on the days settled now: as many whole weeks after the switch day as have settled, at most `maxWeeks`,
 * and as many before it. The switch day itself is left out (half old, half new). Null while fewer than `weeks` weeks have
 * settled. Pure.
 */
export function testWindows(switchDay: string, settledThrough: string, weeks: number, maxWeeks: number): TestWindow | null {
  const first = plusDays(switchDay, 1)
  if (settledThrough < first) return null
  const have = Math.floor((daysBetween(first, settledThrough) + 1) / 7)
  const w = Math.min(have, maxWeeks)
  if (w < weeks) return null
  const days = w * 7
  return { weeks: w, days, baseline: { from: plusDays(switchDay, -days), to: plusDays(switchDay, -1) }, test: { from: first, to: plusDays(switchDay, days) } }
}

export interface SwitchbackVerdict {
  verdict: 'keep' | 'revert' | 'wait'
  why: string
  window: TestWindow | null
  before: Period | null
  after: Period | null
}

/**
 * The verdict of one switchback test (see the header): AB-15's judge, then the band; too little data waits up to
 * EXTRA_TEST_WEEKS more weeks, then up and down goes back and the others stay. Pure.
 */
export function switchbackVerdict(x: { from: string; to: string; switchDay: string; settledThrough: string; days: ReadonlyMap<string, Sums> | null | undefined; band: Band | null; t: AutoUndoThresholds; weeks: number }): SwitchbackVerdict {
  const maxWeeks = x.weeks + EXTRA_TEST_WEEKS
  const w = testWindows(x.switchDay, x.settledThrough, x.weeks, maxWeeks)
  if (!w) return { verdict: 'wait', why: `testing ${words(x.to)} since ${x.switchDay}: the verdict once ${plural(x.weeks, 'whole week')} after it have settled (${plusDays(x.switchDay, x.weeks * 7)})`, window: null, before: null, after: null }
  const before = periodOf(sumDays(x.days ?? undefined, w.baseline.from, w.baseline.to), w.days)
  const after = periodOf(sumDays(x.days ?? undefined, w.test.from, w.test.to), w.days)
  const judged = judgeStrategySwitch({ before, after, to: x.to, t: x.t })
  const span = `the ${plural(w.weeks, 'week')} after the switch against the ${plural(w.weeks, 'week')} before`
  if (judged.verdict === 'worse') return { verdict: 'revert', why: `worse over ${span}: ${judged.why} — back to ${words(x.from)}`, window: w, before, after }
  if (judged.verdict === 'not_enough_data') {
    if (w.weeks < maxWeeks) return { verdict: 'wait', why: `${judged.why}: the test runs on, up to ${plural(maxWeeks, 'week')}`, window: w, before, after }
    if (x.to === UP_AND_DOWN) return { verdict: 'revert', why: `still too little data after ${plural(maxWeeks, 'week')} (${judged.why}): no evidence that up and down pays — back to ${words(x.from)}`, window: w, before, after }
    return { verdict: 'keep', why: `still too little data after ${plural(maxWeeks, 'week')} (${judged.why}): ${words(x.to)} never bids above the brain's own bids — kept`, window: w, before, after }
  }
  if (x.band && after.acos != null && after.acos > x.band.hi && pts(after.acos - x.band.hi) > x.t.acosPointsUp && (before.acos == null || after.acos > before.acos)) {
    return { verdict: 'revert', why: `over ${span} its ACoS is ${pts(after.acos - x.band.hi)} points above the band's top (more than ${x.t.acosPointsUp}) and above before — back to ${words(x.from)}`, window: w, before, after }
  }
  const acos = (p: Period) => (p.acos == null ? 'no sales' : `${pts(p.acos)} %`)
  const sales = before.salesCents > 0 ? `, sales ${after.salesCents >= before.salesCents ? 'up' : 'down'} ${Math.abs(Math.round(((after.salesCents - before.salesCents) / before.salesCents) * 100))} %` : ''
  return { verdict: 'keep', why: `not worse over ${span} (ACoS ${acos(before)} → ${acos(after)}${sales}): ${words(x.to)} kept`, window: w, before, after }
}

// ── A test's state, followed to now (pure) ───────────────────────────────────────────────────────────────────────────

export const TEST_STATUSES = ['ASKED', 'DECLINED', 'REFUSED', 'TESTING', 'KEPT', 'REVERT_ASKED', 'REVERTED', 'ENDED', 'FAILED'] as const
export type TestStatus = (typeof TEST_STATUSES)[number]
/** A test still running or waiting for a person. */
export const OPEN_TEST_STATUSES: readonly TestStatus[] = ['ASKED', 'TESTING', 'REVERT_ASKED']
const WAITING = new Set(['pending', 'scheduled', 'approved', 'executing'])
/** The action log's outcomes of a write that never landed at Amazon (state-load.ts NOT_LANDED). */
export const NOT_LANDED: readonly string[] = ['SKIPPED', 'FAILED', 'CANCELLED', 'SUPERSEDED']

/** One test as stored (AdsBrainStrategyTest). */
export interface TestRecord {
  id: string
  status: TestStatus
  from: string
  to: string
  rule: string
  level: string
  approvalId: string | null
  switchedAt: Date | null
  actionLogId: string | null
  revertApprovalId: string | null
  createdAt: Date
  why: string
}

/** What the loader read about an open test: its request now, the switch it made, the switch's own row, auto-undo's view. */
export interface TestEvents {
  /** The open request (the switch's at ASKED, the switch back's at REVERT_ASKED) and its status; null: none, or gone. */
  approval: { status: string; decidedAt: Date | null } | null
  /** The strategy change that request made once approved (its action-log row), if any. */
  landed: { at: Date; actionLogId: string; to: string } | null
  /** The switch's own action-log row's result at Amazon (null: not sent yet, or no row). */
  switchResult: string | null
  /** Auto-undo's judgement of the switch (AB-15). */
  undo: { action: string; final: boolean } | null
}

export interface FollowedTest {
  status: TestStatus
  switchedAt: Date | null
  actionLogId: string | null
  revertedAt: Date | null
  revertActionLogId: string | null
  /** Auto-undo judged the switch worse and put it back: the test's verdict is revert (no retry for RETEST_DAYS). */
  verdict?: 'revert'
  /** What changed, in words; null: nothing. */
  why: string | null
}

/**
 * One open test followed to now (pure): a request approved and run starts the test (TESTING from when the switch reached
 * Nexus's copy) or ends it switched back (REVERTED); one declined or gone is DECLINED (a switch back declined: KEPT); a
 * switch that did not reach Amazon FAILED; one auto-undo put back, or whose strategy moved since, ENDED. A stop's down only
 * over the tested strategy (its memory holding it) is no move: the stop recipe gives it back.
 */
export function followTest(t: TestRecord, e: TestEvents, now: { current: string; savedStrategy: string | null }): FollowedTest {
  const same: FollowedTest = { status: t.status, switchedAt: t.switchedAt, actionLogId: t.actionLogId, revertedAt: null, revertActionLogId: null, why: null }
  const declined = (status: string) => (status === 'rejected' ? 'a person declined it' : status === 'expired' ? 'nobody decided it in time (expired)' : `its request ended ${status}`)
  if (t.status === 'ASKED') {
    if (!e.approval) return { ...same, status: 'DECLINED', why: 'its request is no longer in Nexus' }
    if (WAITING.has(e.approval.status)) return same
    if (e.approval.status === 'executed') {
      if (e.landed && e.landed.to === t.to) return { ...same, status: 'TESTING', switchedAt: e.landed.at, actionLogId: e.landed.actionLogId, why: `a person approved it: switched to ${words(t.to)} on ${day(e.landed.at)} — the test starts` }
      return { ...same, status: 'ENDED', why: 'its request ran, but no switch is on record (the write was refused, or the strategy had moved)' }
    }
    return { ...same, status: 'DECLINED', why: declined(e.approval.status) }
  }
  if (t.status === 'REVERT_ASKED') {
    if (!e.approval) return { ...same, status: 'KEPT', why: `the request to switch back is no longer in Nexus: ${words(t.to)} kept` }
    if (WAITING.has(e.approval.status)) return same
    if (e.approval.status === 'executed' && e.landed && e.landed.to === t.from) return { ...same, status: 'REVERTED', revertedAt: e.landed.at, revertActionLogId: e.landed.actionLogId, why: `a person approved it: back to ${words(t.from)} on ${day(e.landed.at)}` }
    if (e.approval.status === 'executed') return { ...same, status: now.current === t.to ? 'KEPT' : 'ENDED', why: 'the request to switch back ran, but no switch back is on record' }
    return { ...same, status: 'KEPT', why: `${declined(e.approval.status)} — the switch back: ${words(t.to)} kept` }
  }
  if (t.status === 'TESTING') {
    if (e.undo?.action === 'undone') return { ...same, status: 'ENDED', verdict: 'revert', why: 'auto-undo judged it worse and put the switch back (AB-15): the test ends' }
    if (e.switchResult && NOT_LANDED.includes(e.switchResult)) return { ...same, status: 'FAILED', why: `the switch did not reach Amazon (${e.switchResult})` }
    const serving = now.current === t.to || (now.current === DOWN_ONLY && now.savedStrategy === t.to)
    if (!serving) return { ...same, status: 'ENDED', why: `its strategy moved since the switch (now ${words(now.current)}): the test ends` }
  }
  return same
}

// ── Facts, context and the decision ──────────────────────────────────────────────────────────────────────────────────

export interface ModeFacts {
  campaignId: string
  name: string
  productId: string
  market: string
  status: string
  /** product: the brain's own campaign; shared: it advertises another product too (D2 = A: no brain's). */
  owner: 'product' | 'shared'
  /** The biddingStrategy lever on this campaign (brain/settings.ts) and the Owner's lock of it, in words. */
  lever: { effective: string; why: string; lock: { words: string; value: string | null } | null }
  /** Campaign.biddingStrategy now. */
  current: string
  /** Amazon running its own strategy on the campaign (rule-based bidding, one unknown to Nexus), in words; null: none. */
  native: string | null
  /** Days since the campaign started (its start date, or when Nexus first saw it). */
  ageDays: number
  /** The product's strategy phase (LAUNCH, GROW …), its ACoS band, its ad orders of 30 settled days (null: not read). */
  phase: string | null
  band: Band | null
  productOrders30d: number | null
  /** The placement report over LANE_WINDOW_DAYS settled days: top of search, and every placement. */
  lanes: { tos: LaneFigures; all: LaneFigures } | null
  /** The placement % live (Campaign.dynamicBidding.placementBidding; the stop's saved lanes while a stop holds them). */
  placements: Placement[]
  /** The highest enabled bid of the campaign (a keyword or target, else an ad group's default). */
  maxBidCents: number | null
  /** The campaign's hourly plan: whether it sets placement %, and its lowest CPC ceiling of the week (null: none). */
  plan: { name: string; steersPlacements: boolean; ceilingCents: number | null } | null
  /** The brain writes the plan's placements: the bid brain runs the campaign, or the hours or placements lever is owned. */
  brainRunsPlacements: boolean
  /** A stop holding the campaign now, in words (the stop recipe owns the strategy then); null: it serves. */
  stop: string | null
  /** The stop recipe's saved strategy (Campaign.suppressedFromBiddingStrategy). */
  savedStrategy: string | null
  /** A person's own strategy holding it, in words with its end; null: none. */
  personHold: string | null
  /** The bids pin (pinBids), in words: the gate refuses an automatic strategy write there. */
  pinned: string | null
  /** On the live-write allowlist (an automatic write needs it; a person's approval passes it). */
  allowlisted: boolean
  /** The Owner's kill switch on the lever, or auto-undo's hold after an undo (AB-15), in words; null: none. */
  held: string | null
  /** The newest switch on record outside a stop (anyone's), for the spacing. */
  lastSwitch: { at: Date; to: string; by: string } | null
  /** The open test, followed to now (null: none). */
  test: TestRecord | null
  /** The campaign's daily figures (for a test's verdict). */
  days: ReadonlyMap<string, Sums> | null
  /** The newest switch a person declined (or let expire) on the campaign, for the quiet days. */
  declined: { to: string; at: Date } | null
  /** The newest switch whose switchback test was worse (its verdict revert), for RETEST_DAYS. */
  lastReverted: { to: string; at: Date } | null
  /** The lever's settings here: the spacing, the approval mode, the approval days (N4). */
  switchDays: number
  switchMode: string
  approvalDays: number
  /** The N4 clock: since when the lever is the brain's on the product; null: not owned anywhere. */
  clockSince: Date | null
}

export interface ModeContext {
  now: Date
  /** NEXUS_BID_BRAIN_MODE is live: the gate judges the brain's writes only then, so AUTO writes only then. */
  ceilingLive: boolean
  /** The account's ads automation (ads-engine-guard.ts readEnginePosture): AUTO writes only at `auto`. */
  posture: { posture: 'auto' | 'suggest' | 'stopped'; why: string }
  /** The weekly run (Monday, Europe/Rome): new switches are decided only then. */
  weekly: boolean
  /** The next weekly run's day, for the words. */
  nextWeekly: string
  /** AB-15's thresholds of the market (the judge). */
  thresholds: AutoUndoThresholds
  /** The newest settled day of the market's daily report. */
  settledThrough: string
}

export type ModeAction = 'switch' | 'revert' | 'keep' | 'test' | 'hold' | 'skip'
export type ModeMode = 'SHADOW' | 'PROPOSE' | 'LIVE'
/** What the decision asks the runner to do: log only, ask a person, write, wait for a person, or nothing (and why not). */
export type ModeOutcome = 'shadow' | 'ask' | 'write' | 'waiting' | 'held' | 'none'

export interface ModeDecision {
  campaignId: string
  name: string
  productId: string
  market: string
  /** The lever's effective level here. */
  level: string
  status: string
  /** Campaign.biddingStrategy now. */
  current: string
  action: ModeAction
  mode: ModeMode
  outcome: ModeOutcome
  /** The rule behind a switch (or `test`: a switch back; `none`). */
  rule: ModeRule | 'test' | 'none'
  /** The strategy the decision sets or would set (null: none). */
  to: string | null
  /** The brain's own choice for the campaign, whatever its level (the recommendation a locked lever shows). */
  target: { to: string; rule: ModeRule; why: string; lift: number | null; tosOrders: number; ceiling: string | null } | null
  /** The open test, and what this decision does with it. */
  testId: string | null
  test: { status: TestStatus; from: string; to: string; switchedAt: string | null; weeks: number; window: TestWindow | null; verdict: string | null; figures?: { before: Period | null; after: Period | null } | null } | null
  /** The runner closes the open test so: its status, why, and the verdict's window and figures (minor units). */
  closeTest: { status: TestStatus; why: string; verdict?: 'keep' | 'revert'; window?: TestWindow | null; before?: Period | null; after?: Period | null } | null
  /** N4 — until when a switch asks a person (null: never at this level, or always). */
  asksUntil: string | null
  /** The spacing: the earliest day a next switch may come (null: no switch on record). */
  nextSwitchFrom: string | null
  /** The request this decision waits for. */
  approvalId: string | null
  /** What holds it, in words. */
  hold: string | null
  /** The cents behind the stack check (ad-spend money: the view hides them without the permission). */
  money: { maxBidCents: number | null; stackCents: number | null; tosStackCents: number | null; planCeilingCents: number | null; tosCeilingCents: number | null } | null
  why: string
}

const WATCHING: ReadonlySet<string> = new Set(['OBSERVE', 'PROPOSE', 'AUTO'])

/** N4 — why a switch asks a person here, and until when (null: AUTO may switch alone). Pure. */
export function asksWhy(f: Pick<ModeFacts, 'lever' | 'switchMode' | 'approvalDays' | 'clockSince'>, now: Date): { why: string; until: string | null } | null {
  if (f.lever.effective === 'PROPOSE') return { why: 'PROPOSE: every switch asks a person', until: null }
  if (f.lever.effective !== 'AUTO') return null
  if (f.switchMode === 'ALWAYS_PROPOSE') return { why: 'AUTO, but every bidding-strategy switch asks a person (strategySwitchMode ALWAYS_PROPOSE, the Owner\'s choice)', until: null }
  const since = f.clockSince ?? now
  const until = new Date(since.getTime() + f.approvalDays * DAY_MS)
  if (now.getTime() < until.getTime()) {
    return { why: `AUTO, but for the first ${plural(f.approvalDays, 'day')} the lever is the brain's (since ${day(since)}) every switch asks a person (N4) — it switches alone from ${day(until)}`, until: until.toISOString() }
  }
  return null
}

/** The weekly run's day on or after `now` in Europe/Rome (YYYY-MM-DD), and whether `now` is on it. Pure. */
export function weeklyRun(now: Date): { weekly: boolean; next: string } {
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: WEEKLY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(now)
  const get = (t: string) => local.find((p) => p.type === t)?.value ?? ''
  const today = `${get('year')}-${get('month')}-${get('day')}`
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  const ahead = (WEEKLY_DAY - weekday + 7) % 7
  return { weekly: ahead === 0, next: plusDays(today, ahead === 0 ? 7 : ahead) }
}

/** The bidding-strategy lever's decision for one campaign at its level (see the header). Pure. */
export function decideMode(f: ModeFacts, ctx: ModeContext): ModeDecision {
  const now = ctx.now
  const level = f.lever.effective
  const target = f.owner === 'product' && f.status !== 'ARCHIVED' ? targetStrategy(f) : null
  const weeks = testWeeksOf(f.switchDays)
  const t = f.test
  const n4 = asksWhy(f, now)
  const nextSwitchFrom = f.lastSwitch ? day(new Date(f.lastSwitch.at.getTime() + f.switchDays * DAY_MS)) : null
  const base: ModeDecision = {
    campaignId: f.campaignId, name: f.name, productId: f.productId, market: f.market, level, status: f.status, current: f.current,
    action: 'keep', mode: 'SHADOW', outcome: 'none', rule: 'none', to: null,
    target: target ? { to: target.to, rule: target.rule, why: target.why, lift: target.lift, tosOrders: target.tosOrders, ceiling: target.ceiling?.words ?? null } : null,
    testId: t?.id ?? null,
    test: t ? { status: t.status, from: t.from, to: t.to, switchedAt: t.switchedAt?.toISOString() ?? null, weeks, window: null, verdict: null } : null,
    closeTest: null, asksUntil: n4?.until ?? null, nextSwitchFrom, approvalId: null, hold: null,
    money: target?.ceiling ? { maxBidCents: f.maxBidCents, stackCents: target.ceiling.stackCents, tosStackCents: target.ceiling.tosStackCents, planCeilingCents: target.ceiling.planCeilingCents, tosCeilingCents: target.ceiling.tosCeilingCents } : null,
    why: '',
  }
  const recommend = target ? ` — the brain would run it ${words(target.to)}: ${target.why}` : ''
  // A running test ends with the lever's change; a request still waiting stays followed (a person may still approve it).
  const endTest = (why: string): ModeDecision['closeTest'] => (t?.status === 'TESTING' ? { status: 'ENDED', why } : null)
  const skip = (why: string, close: ModeDecision['closeTest'] = null): ModeDecision => ({ ...base, action: 'skip', why, closeTest: close })
  const hold = (holdWords: string, why: string, close: ModeDecision['closeTest'] = null): ModeDecision => ({ ...base, action: 'hold', outcome: 'held', hold: holdWords, why, closeTest: close })

  if (f.status === 'ARCHIVED') return skip('archived: nothing to decide', endTest('the campaign was archived'))
  if (f.owner === 'shared') return skip('it advertises another product too: no brain switches a shared campaign\'s strategy (D2 = A — the brain proposes a split)', endTest('the campaign is shared now (D2)'))
  if (f.native || !KNOWN_STRATEGIES.includes(f.current)) {
    const native = f.native ?? `its bidding strategy ${f.current} is not fixed, down only or up and down`
    return hold(native, `Amazon runs its own strategy here (${native}): the brain never switches it alone — two brains on one lever (§2.12); detach it in Amazon to let the brain choose${recommend}`, endTest('Amazon runs its own strategy on it now'))
  }
  if (!WATCHING.has(level)) {
    if (level === 'LOCKED') return hold(f.lever.lock?.words ?? f.lever.why, `${f.lever.why}${recommend}`, endTest('the Owner locked the strategy'))
    return skip(f.lever.why, endTest(`the lever is ${level} here`))
  }
  if (f.status !== 'ENABLED') return skip(`status ${f.status}: a campaign that does not serve has nothing to switch or test`)
  if (f.stop) return hold(f.stop, `${f.stop}: the stop recipe owns the bidding strategy while a stop lasts (down only, given back after it — AB-2)${recommend}`)
  if (f.personHold) return hold(f.personHold, `a person's own strategy (${f.personHold}): the brain leaves it until then${recommend}`, endTest(`a person's own strategy holds it (${f.personHold})`))
  if (f.pinned) return hold(f.pinned, `the strategy is ${f.pinned}: the gate refuses an automatic strategy write there${recommend}`)
  if (f.held) return hold(f.held, `${f.held}${recommend}`)

  // An open test: its request waits, its verdict is due, or it runs on.
  if (t) {
    const testOf = (window: TestWindow | null, verdict: string | null, figures: { before: Period | null; after: Period | null } | null = null) => ({ ...base.test!, window, verdict, figures })
    if (t.status === 'ASKED' || t.status === 'REVERT_ASKED') {
      const approvalId = t.status === 'ASKED' ? t.approvalId : t.revertApprovalId
      const what = t.status === 'ASKED' ? `switch to ${words(t.to)}` : `switch back to ${words(t.from)}`
      return { ...base, action: t.status === 'ASKED' ? 'switch' : 'revert', mode: 'PROPOSE', outcome: 'waiting', rule: t.status === 'ASKED' ? t.rule as ModeRule : 'test', to: t.status === 'ASKED' ? t.to : t.from, approvalId, why: `a request to ${what} waits for a person (${approvalId ?? 'no id'})` }
    }
    if (t.status === 'TESTING' && t.switchedAt) {
      const v = switchbackVerdict({ from: t.from, to: t.to, switchDay: day(t.switchedAt), settledThrough: ctx.settledThrough, days: f.days, band: f.band, t: ctx.thresholds, weeks })
      if (v.verdict === 'wait') return { ...base, action: 'test', test: testOf(v.window, null), why: v.why }
      if (v.verdict === 'keep') return { ...base, action: 'keep', test: testOf(v.window, 'keep'), closeTest: { status: 'KEPT', why: v.why, verdict: 'keep', window: v.window, before: v.before, after: v.after }, why: v.why }
      const revert: ModeDecision = { ...base, action: 'revert', rule: 'test', to: t.from, test: testOf(v.window, 'revert', { before: v.before, after: v.after }), why: v.why }
      // The lever in shadow now: the verdict is logged, nothing switched back — the test is closed with it.
      if (level === 'OBSERVE') return { ...revert, mode: 'SHADOW', outcome: 'shadow', closeTest: { status: 'ENDED', why: `the lever is in shadow (OBSERVE) now: would switch back — ${v.why}`, verdict: 'revert', window: v.window, before: v.before, after: v.after }, why: `SHADOW (OBSERVE) — would switch back: ${v.why}` }
      return act(revert, f, ctx, 'revert', n4)
    }
  }

  // A new switch.
  if (!target) return skip('nothing to decide')
  if (f.current === target.to) return { ...base, action: 'keep', rule: target.rule, why: `${words(f.current)} already: ${target.why}` }
  if (f.lastReverted && f.lastReverted.to === target.to && now.getTime() - f.lastReverted.at.getTime() < RETEST_DAYS * DAY_MS) {
    const again = day(new Date(f.lastReverted.at.getTime() + RETEST_DAYS * DAY_MS))
    return { ...base, action: 'keep', rule: target.rule, why: `${words(f.current)} kept: its switchback test of ${words(target.to)} was worse on ${day(f.lastReverted.at)} — tried again from ${again} (${target.why})` }
  }
  const switching: ModeDecision = { ...base, action: 'switch', rule: target.rule, to: target.to, why: `${words(f.current)} → ${words(target.to)}: ${target.why}` }
  if (f.lastSwitch && now.getTime() - f.lastSwitch.at.getTime() < f.switchDays * DAY_MS) {
    return { ...switching, action: 'hold', outcome: 'held', hold: `one switch per ${plural(f.switchDays, 'day')}`, why: `${switching.why} — but its strategy switched on ${day(f.lastSwitch.at)} (${f.lastSwitch.by}): at most one switch per ${plural(f.switchDays, 'day')}, the next from ${nextSwitchFrom}` }
  }
  if (!ctx.weekly) return { ...switching, why: `${switching.why} — decided on the weekly run (${ctx.nextWeekly}, Monday Europe/Rome)` }
  if (level === 'OBSERVE') return { ...switching, mode: 'SHADOW', outcome: 'shadow', why: `SHADOW (OBSERVE) — would switch: ${switching.why}` }
  if (f.declined && f.declined.to === target.to && now.getTime() - f.declined.at.getTime() < DECLINE_DAYS * DAY_MS) {
    return { ...switching, mode: 'PROPOSE', outcome: 'held', hold: `declined on ${day(f.declined.at)}`, why: `${switching.why} — a person declined this switch on ${day(f.declined.at)}: asked again after ${plural(DECLINE_DAYS, 'day')}` }
  }
  return act(switching, f, ctx, 'switch', n4)
}

/** How a switch or a switch back acts at PROPOSE or AUTO: a request (N4), a write, or held. Pure. */
function act(d: ModeDecision, f: ModeFacts, ctx: ModeContext, kind: 'switch' | 'revert', n4: { why: string } | null): ModeDecision {
  const verb = kind === 'switch' ? 'switch it' : 'switch it back'
  if (n4) return { ...d, mode: 'PROPOSE', outcome: 'ask', why: `${n4.why}: asks a person to ${verb} — ${d.why}` }
  if (!ctx.ceilingLive) return { ...d, mode: 'SHADOW', outcome: 'shadow', why: `AUTO, but the brain's server switch (NEXUS_BID_BRAIN_MODE) is not live: SHADOW — would ${verb}: ${d.why}` }
  if (ctx.posture.posture !== 'auto') return { ...d, mode: 'LIVE', outcome: 'held', hold: ctx.posture.why, why: `AUTO, but the account's ads automation is not running (${ctx.posture.why}): nothing written now — would ${verb}: ${d.why}` }
  if (!f.allowlisted) return { ...d, mode: 'LIVE', outcome: 'held', hold: 'off the live-write allowlist', why: `AUTO, but the campaign is not on the live-write allowlist (the gate refuses every automatic write there): nothing written — would ${verb}: ${d.why}` }
  return { ...d, mode: 'LIVE', outcome: 'write', why: `AUTO: ${kind === 'switch' ? 'switched' : 'switched back'} by the brain — ${d.why}` }
}

/**
 * What makes two decisions the same for the log: a rerun on unchanged facts writes no row. A refusal counts once a UTC day
 * (`refusedOn`).
 */
export function modeDecisionHash(d: Pick<ModeDecision, 'action' | 'level' | 'rule' | 'current' | 'to' | 'approvalId' | 'hold' | 'testId'> & { outcome: string; testStatus?: string | null; refusedOn?: string | null }): string {
  return createHash('sha256').update(JSON.stringify([d.action, d.outcome, d.level, d.rule, d.current, d.to, d.approvalId, d.hold, d.testId, d.testStatus ?? null, d.refusedOn ?? null])).digest('base64url').slice(0, 22)
}

/** Whether a decision is worth a row: it changed, or it is the UTC day's first while a test runs or a request waits. */
export function modeRowKind(hash: string, carries: boolean, prev: { decisionHash: string; createdAt: Date } | undefined, now: Date): 'change' | 'snapshot' | null {
  if (!prev || prev.decisionHash !== hash) return 'change'
  return carries && day(prev.createdAt) !== day(now) ? 'snapshot' : null
}

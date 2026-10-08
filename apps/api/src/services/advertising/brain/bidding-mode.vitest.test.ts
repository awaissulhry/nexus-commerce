/**
 * ONE BRAIN AB-17 — the bidding-strategy lever's pure rules (brain/bidding-mode.ts): the choice of §2.11 and the stack
 * check (the dynamic factor counted), the switchback test's windows and verdict, a test followed to now, the spacing, the
 * weekly run, N4's approval clock, the precedence of a stop, a person, the Owner's lock and the other holds, and the levels.
 * Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { AUTO_UNDO_DEFAULTS } from '../ads-auto-undo-thresholds.js'
import { THIN_ORDERS_PER_30D as HOURS_THIN } from './hours-research.js'
import {
  asksWhy, ceilingCheck, decideMode, DOWN_ONLY, FIXED, followTest, laneEvidence, modeDecisionHash, modeRowKind, switchbackVerdict, targetStrategy,
  testWeeksOf, testWindows, THIN_ORDERS_PER_30D, UP_AND_DOWN, weeklyRun,
  type ModeContext, type ModeFacts, type TestEvents, type TestRecord,
} from './bidding-mode.js'
import type { Sums } from './undo-levers.js'

const NOW = new Date('2026-11-16T07:00:00Z') // a Monday (Europe/Rome)
const DAY = 86_400_000
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)
const BAND = { aim: 0.25, lo: 0.2, hi: 0.3 }
const LANES_GOOD = { tos: { clicks: 400, orders: 40, salesCents: 320_000 }, all: { clicks: 2_000, orders: 120, salesCents: 960_000 } } // TOS CR 10 %, all 6 % → 1.67×
const T = { ...AUTO_UNDO_DEFAULTS }

function facts(over: Partial<ModeFacts> = {}): ModeFacts {
  return {
    campaignId: 'c-1', name: 'Jacket exact', productId: 'p-1', market: 'IT', status: 'ENABLED', owner: 'product',
    lever: { effective: 'AUTO', why: 'AUTO by the Owner', lock: null },
    current: UP_AND_DOWN, native: null, ageDays: 120, phase: 'GROW', band: BAND, productOrders30d: 40,
    lanes: null, placements: [{ placement: 'PLACEMENT_TOP', percentage: 50 }], maxBidCents: 60,
    plan: null, brainRunsPlacements: false, stop: null, savedStrategy: null, personHold: null, pinned: null, allowlisted: true, held: null,
    lastSwitch: null, test: null, days: null, declined: null, lastReverted: null, switchDays: 14, switchMode: 'PROPOSE_THEN_AUTO', approvalDays: 30,
    clockSince: ago(60),
    ...over,
  }
}
const ctx = (over: Partial<ModeContext> = {}): ModeContext => ({
  now: NOW, ceilingLive: true, posture: { posture: 'auto', why: 'running' }, weekly: true, nextWeekly: '2026-11-23', thresholds: T, settledThrough: '2026-11-12', ...over,
})
const test = (over: Partial<TestRecord> = {}): TestRecord => ({
  id: 't-1', status: 'TESTING', from: UP_AND_DOWN, to: DOWN_ONLY, rule: 'default', level: 'AUTO', approvalId: null, switchedAt: new Date('2026-10-20T08:00:00Z'), actionLogId: 'log-1', revertApprovalId: null, createdAt: new Date('2026-10-20T08:00:00Z'), why: 'w', ...over,
})
/** Daily figures: `before` per day up to the switch day, `after` per day from the day after. */
function days(switchDay: string, before: Sums, after: Sums, span = 40): Map<string, Sums> {
  const m = new Map<string, Sums>()
  const at = Date.parse(`${switchDay}T00:00:00Z`)
  for (let i = -span; i <= span; i++) { if (i === 0) continue; m.set(new Date(at + i * DAY).toISOString().slice(0, 10), i < 0 ? before : after) }
  return m
}

describe('the rules of §2.11', () => {
  it('down only for a new, LAUNCH or thin campaign, or when the orders cannot be read; thin is the design\'s 10 orders', () => {
    expect(THIN_ORDERS_PER_30D).toBe(HOURS_THIN)
    expect(targetStrategy(facts({ ageDays: 10 }))).toMatchObject({ to: DOWN_ONLY, rule: 'new' })
    expect(targetStrategy(facts({ phase: 'LAUNCH' }))).toMatchObject({ to: DOWN_ONLY, rule: 'launch' })
    expect(targetStrategy(facts({ productOrders30d: 9 }))).toMatchObject({ to: DOWN_ONLY, rule: 'thin', why: expect.stringMatching(/9 ad orders in 30 settled days/) })
    expect(targetStrategy(facts({ productOrders30d: null }))).toMatchObject({ to: DOWN_ONLY, rule: 'thin' })
  })

  it('fixed only where the hourly plan steers the placements AND the brain writes them', () => {
    const plan = { name: 'Jacket hours', steersPlacements: true, ceilingCents: 300 }
    expect(targetStrategy(facts({ plan, brainRunsPlacements: true, ageDays: 5 }))).toMatchObject({ to: FIXED, rule: 'exact' })
    expect(targetStrategy(facts({ plan, brainRunsPlacements: false }))).toMatchObject({ to: DOWN_ONLY, rule: 'default' })
    expect(targetStrategy(facts({ plan: { ...plan, steersPlacements: false }, brainRunsPlacements: true }))).toMatchObject({ to: DOWN_ONLY })
  })

  it('up and down only on top-of-search evidence (1.3× over 30 orders) and a CPC ceiling that holds Amazon\'s raise', () => {
    expect(laneEvidence(LANES_GOOD)).toMatchObject({ proves: true, tosOrders: 40 })
    expect(laneEvidence({ ...LANES_GOOD, tos: { clicks: 250, orders: 25, salesCents: 200_000 } })).toMatchObject({ proves: false, words: expect.stringMatching(/25 orders .* needs 30/) })
    expect(laneEvidence({ tos: { clicks: 600, orders: 42, salesCents: 300_000 }, all: { clicks: 2_000, orders: 120, salesCents: 960_000 } })).toMatchObject({ proves: false, words: expect.stringMatching(/1\.17× .* needs 1\.3×/) })
    expect(laneEvidence(null)).toMatchObject({ proves: false })
    // TOS sales per click 800¢ × band top 30 % = 240¢; 60¢ × 1.5 × 2 = 180¢ ≤ 240¢; the plan's ceiling 300¢ ≥ 180¢.
    const up = targetStrategy(facts({ lanes: LANES_GOOD, plan: { name: 'h', steersPlacements: false, ceilingCents: 300 } }))
    expect(up).toMatchObject({ to: UP_AND_DOWN, rule: 'tos' })
    expect(up.ceiling).toMatchObject({ allows: true, tosStackCents: 180, tosCeilingCents: 240, planCeilingCents: 300 })
    // A plan ceiling the raised stack passes: down only, and the why names the ceiling, no amount.
    const capped = targetStrategy(facts({ lanes: LANES_GOOD, plan: { name: 'h', steersPlacements: false, ceilingCents: 150 } }))
    expect(capped).toMatchObject({ to: DOWN_ONLY, rule: 'default', why: expect.stringMatching(/could cost more than the hourly plan's CPC ceiling/) })
    expect(capped.why).not.toMatch(/€|¢|\d+ ?cents/)
  })

  it('the stack counts the dynamic factor (the 60¢ trap) and never allows up and down without a ceiling', () => {
    const c = ceilingCheck({ maxBidCents: 3, placements: [{ placement: 'PLACEMENT_TOP', percentage: 900 }], planCeilingCents: 50, tos: null, band: null })
    expect(c).toMatchObject({ tosStackCents: 60, stackCents: 60, allows: false })
    expect(ceilingCheck({ maxBidCents: 60, placements: [], planCeilingCents: null, tos: null, band: BAND })).toMatchObject({ allows: false, words: expect.stringMatching(/no lane CPC ceiling/) })
    expect(ceilingCheck({ maxBidCents: null, placements: [], planCeilingCents: 100, tos: null, band: null })).toMatchObject({ allows: false, words: expect.stringMatching(/no enabled bid/) })
    // Rest of search counts ×1.5 under up and down: 60¢ × 2.0 × 1.5 = 180¢ beats a 170¢ plan ceiling.
    expect(ceilingCheck({ maxBidCents: 60, placements: [{ placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 100 }], planCeilingCents: 170, tos: null, band: null })).toMatchObject({ stackCents: 180, allows: false })
  })
})

describe('the switchback test', () => {
  it('whole weeks after the switch day and as many before: the same weekdays, the switch day left out', () => {
    expect(testWeeksOf(14)).toBe(2)
    expect(testWeeksOf(20)).toBe(3)
    expect(testWeeksOf(1)).toBe(2)
    expect(testWindows('2026-10-20', '2026-11-02', 2, 4)).toBeNull()
    expect(testWindows('2026-10-20', '2026-11-03', 2, 4)).toEqual({ weeks: 2, days: 14, baseline: { from: '2026-10-06', to: '2026-10-19' }, test: { from: '2026-10-21', to: '2026-11-03' } })
    expect(testWindows('2026-10-20', '2026-12-30', 2, 4)?.weeks).toBe(4)
  })

  const switchDay = '2026-10-20'
  const v = (to: string, before: Sums, after: Sums, settledThrough = '2026-11-05', band = BAND) =>
    switchbackVerdict({ from: to === DOWN_ONLY ? UP_AND_DOWN : DOWN_ONLY, to, switchDay, settledThrough, days: days(switchDay, before, after), band, t: T, weeks: 2 })

  it('waits until its weeks have settled', () => {
    expect(v(DOWN_ONLY, { spendCents: 500, salesCents: 2_000, clicks: 10, orders: 1 }, { spendCents: 500, salesCents: 2_000, clicks: 10, orders: 1 }, '2026-10-30')).toMatchObject({ verdict: 'wait', why: expect.stringMatching(/2026-11-03/) })
  })

  it('switches back when worse (AB-15\'s judge), keeps when not', () => {
    // ACoS 25 % → 50 % with flat sales: worse.
    const worse = v(UP_AND_DOWN, { spendCents: 500, salesCents: 2_000, clicks: 10, orders: 1 }, { spendCents: 1_000, salesCents: 2_000, clicks: 12, orders: 1 })
    expect(worse).toMatchObject({ verdict: 'revert', why: expect.stringMatching(/worse over the 2 weeks after the switch .* back to down only/) })
    expect(worse.before).toMatchObject({ spendCents: 7_000, salesCents: 28_000, days: 14 })
    const kept = v(DOWN_ONLY, { spendCents: 500, salesCents: 2_000, clicks: 10, orders: 1 }, { spendCents: 400, salesCents: 2_000, clicks: 9, orders: 1 })
    expect(kept).toMatchObject({ verdict: 'keep', why: expect.stringMatching(/not worse .*\(ACoS 25 % → 20 %, sales up 0 %\): down only kept/) })
    expect(kept.why).not.toMatch(/€|¢/)
  })

  it('switches back when the ACoS after sits above the band\'s top by more than the points and above before', () => {
    // Sales up (the judge says not worse), but ACoS 25 % → 45 %: 15 points over the band's 30 % top.
    expect(v(UP_AND_DOWN, { spendCents: 500, salesCents: 2_000, clicks: 10, orders: 1 }, { spendCents: 1_350, salesCents: 3_000, clicks: 14, orders: 2 })).toMatchObject({ verdict: 'revert', why: expect.stringMatching(/15 points above the band's top/) })
  })

  it('too little data: waits up to two more weeks, then up and down goes back and down only stays', () => {
    const thin = { spendCents: 20, salesCents: 0, clicks: 1, orders: 0 }
    expect(v(UP_AND_DOWN, thin, thin)).toMatchObject({ verdict: 'wait', why: expect.stringMatching(/too little data .* up to 4 weeks/) })
    expect(v(UP_AND_DOWN, thin, thin, '2026-12-01')).toMatchObject({ verdict: 'revert', why: expect.stringMatching(/no evidence that up and down pays/) })
    expect(v(DOWN_ONLY, thin, thin, '2026-12-01')).toMatchObject({ verdict: 'keep', why: expect.stringMatching(/never bids above the brain's own bids/) })
  })
})

describe('a test followed to now', () => {
  const none: TestEvents = { approval: null, landed: null, switchResult: null, undo: null }
  const now = { current: UP_AND_DOWN, savedStrategy: null }
  it('a request: waiting stays; approved and run starts the test from when it landed; declined or gone is DECLINED', () => {
    const asked = test({ status: 'ASKED', approvalId: 'ap-1', switchedAt: null, actionLogId: null })
    expect(followTest(asked, { ...none, approval: { status: 'pending', decidedAt: null } }, now)).toMatchObject({ status: 'ASKED', why: null })
    const landedAt = new Date('2026-11-02T09:00:00Z')
    expect(followTest(asked, { ...none, approval: { status: 'executed', decidedAt: landedAt }, landed: { at: landedAt, actionLogId: 'log-9', to: DOWN_ONLY } }, now)).toMatchObject({ status: 'TESTING', switchedAt: landedAt, actionLogId: 'log-9' })
    expect(followTest(asked, { ...none, approval: { status: 'executed', decidedAt: landedAt } }, now)).toMatchObject({ status: 'ENDED' })
    expect(followTest(asked, { ...none, approval: { status: 'rejected', decidedAt: landedAt } }, now)).toMatchObject({ status: 'DECLINED', why: 'a person declined it' })
    expect(followTest(asked, none, now)).toMatchObject({ status: 'DECLINED' })
  })

  it('a running test: a stop over it is no move; a move, a failed switch or auto-undo\'s undo ends it', () => {
    const t = test({ status: 'TESTING', from: DOWN_ONLY, to: UP_AND_DOWN })
    expect(followTest(t, none, { current: UP_AND_DOWN, savedStrategy: null })).toMatchObject({ status: 'TESTING', why: null })
    expect(followTest(t, none, { current: DOWN_ONLY, savedStrategy: UP_AND_DOWN })).toMatchObject({ status: 'TESTING', why: null })
    expect(followTest(t, none, { current: FIXED, savedStrategy: null })).toMatchObject({ status: 'ENDED', why: expect.stringMatching(/now fixed/) })
    expect(followTest(t, { ...none, switchResult: 'FAILED' }, { current: UP_AND_DOWN, savedStrategy: null })).toMatchObject({ status: 'FAILED' })
    expect(followTest(t, { ...none, undo: { action: 'undone', final: true } }, { current: DOWN_ONLY, savedStrategy: null })).toMatchObject({ status: 'ENDED', verdict: 'revert', why: expect.stringMatching(/auto-undo/) })
  })

  it('a switch back asked: run → REVERTED, declined → KEPT', () => {
    const t = test({ status: 'REVERT_ASKED', from: DOWN_ONLY, to: UP_AND_DOWN, revertApprovalId: 'ap-2' })
    const at = new Date('2026-11-10T10:00:00Z')
    expect(followTest(t, { ...none, approval: { status: 'executed', decidedAt: at }, landed: { at, actionLogId: 'log-r', to: DOWN_ONLY } }, now)).toMatchObject({ status: 'REVERTED', revertedAt: at, revertActionLogId: 'log-r' })
    expect(followTest(t, { ...none, approval: { status: 'expired', decidedAt: null } }, now)).toMatchObject({ status: 'KEPT', why: expect.stringMatching(/expired/) })
  })
})

describe('the decision: precedence, spacing, weekly, levels and N4', () => {
  // Thin product: the brain's choice is down only; the campaign runs up and down.
  const thin = (over: Partial<ModeFacts> = {}) => facts({ productOrders30d: 3, ...over })

  it('AUTO after the approval days writes the switch as the brain; inside them it asks a person (N4)', () => {
    expect(decideMode(thin(), ctx())).toMatchObject({ action: 'switch', mode: 'LIVE', outcome: 'write', to: DOWN_ONLY, rule: 'thin', asksUntil: null })
    const fresh = decideMode(thin({ clockSince: ago(10) }), ctx())
    expect(fresh).toMatchObject({ action: 'switch', mode: 'PROPOSE', outcome: 'ask', asksUntil: '2026-12-06T07:00:00.000Z', why: expect.stringMatching(/first 30 days .*since 2026-11-06.* \(N4\) — it switches alone from 2026-12-06/) })
    // No clock yet (the lever just became the brain's): it starts now, so it asks.
    expect(decideMode(thin({ clockSince: null }), ctx())).toMatchObject({ outcome: 'ask' })
    // The Owner's own numbers win: always ask, or alone at once.
    expect(decideMode(thin({ switchMode: 'ALWAYS_PROPOSE' }), ctx())).toMatchObject({ outcome: 'ask', why: expect.stringMatching(/ALWAYS_PROPOSE/) })
    expect(decideMode(thin({ clockSince: ago(1), approvalDays: 0 }), ctx())).toMatchObject({ outcome: 'write' })
    expect(asksWhy({ lever: { effective: 'PROPOSE', why: '', lock: null }, switchMode: 'PROPOSE_THEN_AUTO', approvalDays: 30, clockSince: ago(400) }, NOW)).toMatchObject({ why: expect.stringMatching(/PROPOSE: every switch asks/) })
  })

  it('OBSERVE logs, PROPOSE asks; AUTO under a shadow switch, a stopped account or off the allowlist writes nothing', () => {
    expect(decideMode(thin({ lever: { effective: 'OBSERVE', why: 'OBSERVE', lock: null } }), ctx())).toMatchObject({ mode: 'SHADOW', outcome: 'shadow', action: 'switch' })
    expect(decideMode(thin({ lever: { effective: 'PROPOSE', why: 'PROPOSE', lock: null } }), ctx())).toMatchObject({ mode: 'PROPOSE', outcome: 'ask' })
    expect(decideMode(thin(), ctx({ ceilingLive: false }))).toMatchObject({ mode: 'SHADOW', outcome: 'shadow' })
    expect(decideMode(thin(), ctx({ posture: { posture: 'stopped', why: 'kill switch' } }))).toMatchObject({ outcome: 'held', hold: 'kill switch' })
    expect(decideMode(thin({ allowlisted: false }), ctx())).toMatchObject({ outcome: 'held', hold: 'off the live-write allowlist' })
    // A person's approval passes the allowlist: inside the approval days it still asks.
    expect(decideMode(thin({ allowlisted: false, clockSince: ago(2) }), ctx())).toMatchObject({ outcome: 'ask' })
  })

  it('a new switch only on the weekly run; at most one switch per 14 days (the stop recipe\'s never counts: the loader leaves it out)', () => {
    expect(decideMode(thin(), ctx({ weekly: false }))).toMatchObject({ action: 'switch', outcome: 'none', why: expect.stringMatching(/weekly run \(2026-11-23/) })
    const spaced = decideMode(thin({ lastSwitch: { at: ago(5), to: UP_AND_DOWN, by: 'user:u-1' } }), ctx())
    expect(spaced).toMatchObject({ action: 'hold', outcome: 'held', nextSwitchFrom: '2026-11-25', why: expect.stringMatching(/at most one switch per 14 days, the next from 2026-11-25/) })
    expect(decideMode(thin({ lastSwitch: { at: ago(15), to: UP_AND_DOWN, by: 'the brain' } }), ctx())).toMatchObject({ outcome: 'write' })
    expect(decideMode(thin({ switchDays: 30, lastSwitch: { at: ago(15), to: UP_AND_DOWN, by: 'the brain' } }), ctx())).toMatchObject({ outcome: 'held' })
    // Already on the brain's choice: keep.
    expect(decideMode(thin({ current: DOWN_ONLY }), ctx())).toMatchObject({ action: 'keep', outcome: 'none', rule: 'thin' })
  })

  it('a stop, a person, the pin, Amazon\'s own strategy, the kill switch and auto-undo\'s hold each stop the brain; a stop keeps the test open', () => {
    const running = test({ status: 'TESTING' })
    const stopped = decideMode(thin({ stop: 'a stop holds it at down only (the stop recipe saved its up and down)', test: running }), ctx())
    expect(stopped).toMatchObject({ action: 'hold', outcome: 'held', closeTest: null, why: expect.stringMatching(/the stop recipe owns the bidding strategy while a stop lasts/) })
    expect(decideMode(thin({ personHold: 'user:u-1 set it on 2026-11-01: a hold until 2026-12-31', test: running }), ctx())).toMatchObject({ action: 'hold', closeTest: { status: 'ENDED' } })
    expect(decideMode(thin({ pinned: 'held by its bids pin' }), ctx())).toMatchObject({ action: 'hold', hold: 'held by its bids pin' })
    expect(decideMode(thin({ native: 'Amazon-run bidding strategy "RULE_BASED"' }), ctx())).toMatchObject({ action: 'hold', why: expect.stringMatching(/two brains on one lever/) })
    expect(decideMode(thin({ current: 'RULE_BASED' }), ctx())).toMatchObject({ action: 'hold' })
    expect(decideMode(thin({ held: 'the bidding strategy lever is stopped by the Owner\'s kill switch' }), ctx())).toMatchObject({ action: 'hold', outcome: 'held' })
  })

  it('the Owner\'s lock holds it with the brain\'s recommendation; OFF, excluded and a shared campaign are left; a declined switch waits 14 days', () => {
    const locked = decideMode(thin({ lever: { effective: 'LOCKED', why: 'locked at the Owner\'s own value by the Owner', lock: { words: 'locked by the Owner at up and down', value: UP_AND_DOWN } }, test: test() }), ctx())
    expect(locked).toMatchObject({ action: 'hold', hold: 'locked by the Owner at up and down', closeTest: { status: 'ENDED' }, why: expect.stringMatching(/the brain would run it down only/) })
    expect(decideMode(thin({ lever: { effective: 'OFF', why: 'OFF by the Owner', lock: null } }), ctx())).toMatchObject({ action: 'skip', why: 'OFF by the Owner' })
    expect(decideMode(thin({ owner: 'shared' }), ctx())).toMatchObject({ action: 'skip', why: expect.stringMatching(/D2 = A/) })
    expect(decideMode(thin({ declined: { to: DOWN_ONLY, at: ago(3) } }), ctx())).toMatchObject({ outcome: 'held', why: expect.stringMatching(/declined this switch .* after 14 days/) })
    expect(decideMode(thin({ declined: { to: DOWN_ONLY, at: ago(20) } }), ctx())).toMatchObject({ outcome: 'write' })
    // No flip-flop: a switch whose test was worse waits 90 days before it is tried again.
    expect(decideMode(thin({ lastReverted: { to: DOWN_ONLY, at: ago(30) } }), ctx())).toMatchObject({ action: 'keep', outcome: 'none', why: expect.stringMatching(/test of down only was worse on 2026-10-17 — tried again from 2027-01-15/) })
    expect(decideMode(thin({ lastReverted: { to: DOWN_ONLY, at: ago(91) } }), ctx())).toMatchObject({ outcome: 'write' })
    expect(decideMode(thin({ lastReverted: { to: FIXED, at: ago(30) } }), ctx())).toMatchObject({ outcome: 'write' })
  })

  it('an open test: a request waits; the verdict keeps it, or switches back (written, or asked inside the approval days); in shadow it closes logged', () => {
    expect(decideMode(thin({ test: test({ status: 'ASKED', approvalId: 'ap-1', switchedAt: null }) }), ctx())).toMatchObject({ action: 'switch', outcome: 'waiting', approvalId: 'ap-1' })
    const switchDay = '2026-10-20'
    const worse = days(switchDay, { spendCents: 500, salesCents: 2_000, clicks: 10, orders: 1 }, { spendCents: 1_000, salesCents: 2_000, clicks: 12, orders: 1 })
    const better = days(switchDay, { spendCents: 500, salesCents: 2_000, clicks: 10, orders: 1 }, { spendCents: 400, salesCents: 2_000, clicks: 10, orders: 1 })
    const onTest = (over: Partial<ModeFacts>) => thin({ current: DOWN_ONLY, test: test(), ...over })
    expect(decideMode(onTest({ days: better }), ctx())).toMatchObject({ action: 'keep', closeTest: { status: 'KEPT', verdict: 'keep' } })
    expect(decideMode(onTest({ days: worse }), ctx())).toMatchObject({ action: 'revert', outcome: 'write', to: UP_AND_DOWN, rule: 'test', test: { verdict: 'revert' } })
    expect(decideMode(onTest({ days: worse, clockSince: ago(5) }), ctx())).toMatchObject({ action: 'revert', outcome: 'ask' })
    // A switch back is not held to the weekly run.
    expect(decideMode(onTest({ days: worse }), ctx({ weekly: false }))).toMatchObject({ action: 'revert', outcome: 'write' })
    expect(decideMode(onTest({ days: worse, lever: { effective: 'OBSERVE', why: 'OBSERVE', lock: null } }), ctx())).toMatchObject({ action: 'revert', outcome: 'shadow', closeTest: { status: 'ENDED', verdict: 'revert' } })
    expect(decideMode(onTest({ days: worse }), ctx({ settledThrough: '2026-10-30' }))).toMatchObject({ action: 'test', outcome: 'none' })
  })
})

describe('the weekly run, the log', () => {
  it('Monday in Europe/Rome', () => {
    expect(weeklyRun(new Date('2026-11-16T07:00:00Z'))).toEqual({ weekly: true, next: '2026-11-23' })
    expect(weeklyRun(new Date('2026-11-15T23:30:00Z'))).toEqual({ weekly: true, next: '2026-11-23' }) // 00:30 Monday in Rome
    expect(weeklyRun(new Date('2026-11-18T12:00:00Z'))).toEqual({ weekly: false, next: '2026-11-23' })
  })

  it('a rerun on the same decision writes no row; a test or a request makes the day\'s first a snapshot', () => {
    const d = decideMode(facts({ productOrders30d: 3 }), ctx())
    const h = modeDecisionHash(d)
    expect(modeDecisionHash({ ...d })).toBe(h)
    expect(modeDecisionHash({ ...d, outcome: 'refused' })).not.toBe(h)
    expect(modeRowKind(h, false, { decisionHash: h, createdAt: ago(2) }, NOW)).toBeNull()
    expect(modeRowKind(h, true, { decisionHash: h, createdAt: ago(1) }, NOW)).toBe('snapshot')
    expect(modeRowKind(h, true, { decisionHash: h, createdAt: NOW }, NOW)).toBeNull()
    expect(modeRowKind('other', false, { decisionHash: h, createdAt: NOW }, NOW)).toBe('change')
  })
})

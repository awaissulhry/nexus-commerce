import { describe, expect, it } from 'vitest'
import { orderStageOf } from '@nexus/factory-domain/production-brand/stages'
import { lineStageFactsOf, type LineSizeRow } from './facts'
import { brandKeeperHandler, HOLD_EVENTS, KEEPER_EVENTS, planChanges, planKeep, STAGE_EVENTS, type KeeperRow, type KeeperTarget } from './keeper'
import { customerMaterialWaits, earliestMissingOf } from './facts' // B-PT-016
import { planLeaving } from './keeper' // B-MS-004
import type { BrandStage } from '@nexus/factory-domain/production-brand/stages' // B-MS-004
import { HAND_STAGE_NOTICE_DELAY_MS } from '@nexus/factory-domain/production-brand/stage-set' // B-MS-008
import { STAGE_TOLD, STAGE_UNTOLD, waitingTellsOff, type StageMarker } from './keeper' // B-MS-008
import { handNoticeOf } from './keeper' // B-MS-008 (ms-fx1)

/**
 * B-PR-17 — the keeper's plan, pure (production plan §4; review fixes R-20, R-21, R-35, R-69): what it writes and tells for
 * one order from its row and its facts. The database half (the row made at CONFIRMED, the stage told once, the hold, the
 * nightly run, PW-P07) is keeper.pg.vitest.test.ts.
 */

const NOW = new Date('2026-11-20T09:00:00.000Z')
const TODAY = '2026-11-20'
const EARLIER = new Date('2026-11-10T08:00:00.000Z')

const row = (over: Partial<KeeperRow> = {}): KeeperRow => ({
  id: '0195a000-0000-7000-8000-000000000001',
  partyId: '0195a000-0000-7000-8000-0000000000aa',
  salesOrderId: '0195a000-0000-7000-8000-0000000000bb',
  stage: 'PREPARING',
  stageSet: null, // B-MS-004: no stage set by hand (every plan below stays as it was)
  handFloor: null, // B-SC-003: the floor at the set (none known: read as set ahead)
  health: 'ON_TRACK',
  healthSet: null,
  healthReasonCode: null,
  healthSetUntil: null,
  waitingOn: 'US',
  waitingSince: EARLIER,
  version: 3,
  ...over,
})
const target = (over: Partial<KeeperTarget> = {}): KeeperTarget => ({ stage: 'PREPARING', reached: 'PREPARING' /* B-MS-004 */, computed: 'ON_TRACK', waiting: { on: 'US', since: EARLIER }, ...over })
const plan = (r: KeeperRow | null, t: KeeperTarget, today = TODAY) => planKeep({ row: r, target: t, now: NOW, today })

describe('the row is made when the order is CONFIRMED (R-21)', () => {
  it('a confirmed order with an open goods line gets its row: PREPARING, its health and who it waits on, the first stage told', () => {
    const made = plan(null, target({ computed: 'NO_DATE', waiting: { on: 'BRAND', since: null } }))!
    expect(made.create).toBe(true)
    expect(made.data).toEqual({ stage: 'PREPARING', stageAt: NOW, health: 'NO_DATE', healthAt: NOW, waitingOn: 'BRAND', waitingSince: NOW })
    expect(made.stageReached).toEqual({ stage: 'PREPARING', previous: null })
    expect(made.healthChanged).toEqual({ health: 'NO_DATE', previous: null, byNote: false })
  })

  it('an order with no open goods line and no row gets none (it is not in My production)', () => {
    expect(plan(null, target({ stage: null, computed: null }))).toBeNull()
    expect(planChanges(null)).toBe(false)
  })
})

describe('the stage: forward only (R-20)', () => {
  it('a forward move is written and told, with the stage before', () => {
    const moved = plan(row(), target({ stage: 'CUTTING' }))!
    expect(moved.data).toEqual({ stage: 'CUTTING', stageAt: NOW })
    expect(moved.stageReached).toEqual({ stage: 'CUTTING', previous: 'PREPARING' })
  })

  it('a stage going back is written (only true states) and never told', () => {
    const back = plan(row({ stage: 'QUALITY' }), target({ stage: 'SEWING' }))!
    expect(back.data).toEqual({ stage: 'SEWING', stageAt: NOW })
    expect(back.stageReached).toBeNull()
  })

  it('an order whose open lines are all done keeps its last stage and tells nothing', () => {
    const left = plan(row({ stage: 'READY' }), target({ stage: null, computed: null }))!
    expect(left.data.stage).toBeUndefined()
    expect(left.stageReached).toBeNull()
    expect(left.data.health).toBeNull()
  })

  it('nothing changed: nothing to write or tell', () => {
    expect(planChanges(plan(row(), target()))).toBe(false)
  })
})

describe('the health', () => {
  it('a computed change is written and told (not by a note)', () => {
    const late = plan(row(), target({ computed: 'LATE' }))!
    expect(late.data).toEqual({ health: 'LATE', healthAt: NOW })
    expect(late.healthChanged).toEqual({ health: 'LATE', previous: 'ON_TRACK', byNote: false })
  })

  it("the factory's raise stands while the computed health stays and its 7 days run: nothing is told", () => {
    const raised = row({ healthSet: 'AT_RISK', healthReasonCode: 'CAPACITY', healthSetUntil: '2026-11-25' })
    expect(planChanges(plan(raised, target()))).toBe(false)
  })

  it('the raise drops after its 7 days: the customer reads the computed health again, told as a note change', () => {
    const raised = row({ healthSet: 'AT_RISK', healthReasonCode: 'CAPACITY', healthSetUntil: '2026-11-20' })
    const dropped = plan(raised, target())!
    expect(dropped.data).toEqual({ raiseDropped: true })
    expect(dropped.healthChanged).toEqual({ health: 'ON_TRACK', previous: 'AT_RISK', byNote: true })
  })

  it('the raise drops as soon as the computed health changes; a computed LATE is never lowered by it', () => {
    const raised = row({ healthSet: 'AT_RISK', healthReasonCode: 'MATERIAL_LATE', healthSetUntil: '2026-11-25' })
    const late = plan(raised, target({ computed: 'LATE' }))!
    expect(late.data).toEqual({ health: 'LATE', healthAt: NOW, raiseDropped: true })
    expect(late.healthChanged).toEqual({ health: 'LATE', previous: 'AT_RISK', byNote: false })
  })
})

describe('waiting on', () => {
  it('a new owner is written with the start of its blockers, else now', () => {
    expect(plan(row(), target({ waiting: { on: 'BRAND', since: EARLIER } }))!.data).toEqual({ waitingOn: 'BRAND', waitingSince: EARLIER })
    expect(plan(row(), target({ waiting: { on: 'WORKSHOP', since: null } }))!.data).toEqual({ waitingOn: 'WORKSHOP', waitingSince: NOW })
  })

  it('the same owner with no known start keeps since when it waited', () => {
    expect(planChanges(plan(row(), target({ waiting: { on: 'US', since: null } })))).toBe(false)
  })
})

describe("a line's stage facts (R-35: a partly shipped order's open lines read READY once released)", () => {
  const size = (over: Partial<LineSizeRow>): LineSizeRow => ({ ordered: 4, released: 0, closedShort: 0, toShip: 4, ...over })

  it('a line shipped in full or closed short is done and no longer counts', () => {
    expect(lineStageFactsOf([size({ released: 4, toShip: 0 })], 'SHIPPED', true).done).toBe(true)
    expect(lineStageFactsOf([size({ closedShort: 2, toShip: 0 })], 'CUT', true).done).toBe(true)
  })

  it('a partly shipped order: its shipped line is done, its open line reads READY once all its pieces are released', () => {
    const shipped = lineStageFactsOf([size({ released: 4, toShip: 0 })], 'SHIPPED', true)
    const open = lineStageFactsOf([size({ released: 4, toShip: 4 })], 'FINISHED', true)
    expect(orderStageOf([shipped, open])).toMatchObject({ stage: 'READY', ahead: 0 })
    const partly = lineStageFactsOf([size({ released: 3, toShip: 4 })], 'FINISHED', true)
    expect(orderStageOf([shipped, partly])).toMatchObject({ stage: 'QUALITY' })
  })

  it('where sewing is not scanned, a cut line reads CUTTING with "sewing not counted here"; the slowest line wins, the others are ahead', () => {
    const cut = lineStageFactsOf([size({})], 'CUT', false)
    const sewn = lineStageFactsOf([size({})], 'SEWING', true)
    expect(orderStageOf([cut, sewn])).toEqual({ stage: 'CUTTING', ahead: 1, next: 'SEWING', sewingNotCounted: true })
  })
})

describe('what the keeper follows (R-69)', () => {
  it("never a brand_production event: one customer's urgency recomputes no order of another customer", () => {
    expect(KEEPER_EVENTS).not.toContain('brand_production.urgency_changed')
    expect(KEEPER_EVENTS.filter((type) => type.startsWith('brand_production.'))).toEqual([])
    expect(brandKeeperHandler().events).toEqual(KEEPER_EVENTS)
  })

  it('follows the facts of the stage (cut, bundle, first sewing scan, release), the holds, shipments, promises and gates', () => {
    for (const type of ['workorder.released', 'workorder.status_changed', 'production.cut_logged', 'production.bundle_created', 'production.scan_recorded', 'quality.garments_released', 'quality.hold_placed', 'quality.hold_released', 'work_order_hold.placed', 'work_order_hold.lifted', 'shipment.status_changed', 'sales_order.promise_changed', 'order_gate.changed', 'sales_order.created', 'sales_order.status_changed']) {
      expect(KEEPER_EVENTS, type).toContain(type)
    }
    expect(new Set(KEEPER_EVENTS).size).toBe(KEEPER_EVENTS.length)
    expect(STAGE_EVENTS.some((type) => (HOLD_EVENTS as readonly string[]).includes(type))).toBe(false)
  })
})

// ── B-MS-004 ──
describe('B-MS-004: the stage set by hand (design A: `stage` is the shown one; every decision reads the floor of this pass)', () => {
  /** A row whose stage was set by hand (while it stands `stage` equals it: the database's guard). */
  const hand = (stage: BrandStage, over: Partial<KeeperRow> = {}): KeeperRow => row({ stage, stageSet: stage, ...over })

  it('the floor moves under it: nothing written to the stage, nothing told', () => {
    expect(planChanges(plan(hand('SEWING'), target({ stage: 'CUTTING', reached: 'CUTTING' })))).toBe(false)
    expect(planChanges(plan(hand('QUALITY'), target({ stage: 'SEWING', reached: 'SEWING' })))).toBe(false)
  })

  it('the floor reaches it: the hand stage ends (its columns cleared in the same write), the stage stays, nothing told', () => {
    const reached = plan(hand('SEWING'), target({ stage: 'SEWING', reached: 'SEWING' }))!
    expect(reached.data).toEqual({ handDropped: 'REACHED' })
    expect(reached.stageReached).toBeNull()
    expect(planChanges(reached)).toBe(true)
  })

  it("the floor passes it: it ends, and the floor's stage is written and told from the hand stage", () => {
    const passed = plan(hand('SEWING'), target({ stage: 'QUALITY', reached: 'QUALITY' }))!
    expect(passed.data).toEqual({ handDropped: 'REACHED', stage: 'QUALITY', stageAt: NOW })
    expect(passed.stageReached).toEqual({ stage: 'QUALITY', previous: 'SEWING' })
  })

  it('no goods line left open: it ends, the stage is where the work reached, nothing told', () => {
    const none = plan(hand('QUALITY'), target({ stage: null, reached: 'SEWING', computed: null }))!
    expect(none.data).toMatchObject({ handDropped: 'NO_LINE', stage: 'SEWING', stageAt: NOW })
    expect(none.stageReached).toBeNull()
    // Where the work reached is the hand stage itself: the stage stays.
    expect(plan(hand('SEWING'), target({ stage: null, reached: 'SEWING', computed: null }))!.data).toMatchObject({ handDropped: 'NO_LINE' })
    expect(plan(hand('SEWING'), target({ stage: null, reached: 'SEWING', computed: null }))!.data.stage).toBeUndefined()
  })

  it('the floor goes back under it: nothing written, nothing told; once it ended, a step back is written and never told', () => {
    expect(planChanges(plan(hand('SEWING'), target({ stage: 'PREPARING', reached: 'PREPARING' })))).toBe(false)
    const back = plan(row({ stage: 'SEWING' }), target({ stage: 'CUTTING', reached: 'CUTTING' }))!
    expect(back.data).toEqual({ stage: 'CUTTING', stageAt: NOW })
    expect(back.stageReached).toBeNull()
  })

  it('a raise and a hand stage dropped in one update', () => {
    const both = plan(hand('SEWING', { healthSet: 'AT_RISK', healthReasonCode: 'CAPACITY', healthSetUntil: TODAY }), target({ stage: 'QUALITY', reached: 'QUALITY' }))!
    expect(both.data).toEqual({ handDropped: 'REACHED', stage: 'QUALITY', stageAt: NOW, raiseDropped: true })
    expect(both.stageReached).toEqual({ stage: 'QUALITY', previous: 'SEWING' })
    expect(both.healthChanged).toEqual({ health: 'ON_TRACK', previous: 'AT_RISK', byNote: true })
  })

  it("a person's Clear: it ends, the floor's stage is written back and never told; without a hand stage Clear changes nothing", () => {
    const cleared = planKeep({ row: hand('SEWING'), target: target({ stage: 'PREPARING' }), now: NOW, today: TODAY, clearHand: true })!
    expect(cleared.data).toEqual({ handDropped: 'CLEARED', stage: 'PREPARING', stageAt: NOW })
    expect(cleared.stageReached).toBeNull()
    expect(planChanges(planKeep({ row: row(), target: target(), now: NOW, today: TODAY, clearHand: true }))).toBe(false)
  })

  // ── B-SC-003 (stage control B, end rule E1: the floor agrees or moves on) ──
  it('B-SC-003: set ahead with the floor known at the set — as before: stands below it, ends when the floor reaches or passes it', () => {
    expect(planChanges(plan(hand('QUALITY', { handFloor: 'CUTTING' }), target({ stage: 'SEWING', reached: 'SEWING' })))).toBe(false)
    expect(plan(hand('QUALITY', { handFloor: 'CUTTING' }), target({ stage: 'QUALITY', reached: 'QUALITY' }))!.data).toEqual({ handDropped: 'REACHED' })
    // Ready by hand over a floor at Quality check: stands until quality releases every piece; then the floor's Ready, untold (same stage).
    expect(planChanges(plan(hand('READY', { handFloor: 'QUALITY' }), target({ stage: 'QUALITY', reached: 'QUALITY' })))).toBe(false)
    const released = plan(hand('READY', { handFloor: 'QUALITY' }), target({ stage: 'READY', reached: 'READY' }))!
    expect(released.data).toEqual({ handDropped: 'REACHED' })
    expect(released.stageReached).toBeNull()
  })

  it('B-SC-003: set back (a wrong scan) — stands under an equal or lower floor; nothing written, nothing told', () => {
    // Quality check by the floor, set back to Sewing: the customer reads Sewing while the floor still counts Quality check.
    expect(planChanges(plan(hand('SEWING', { handFloor: 'QUALITY' }), target({ stage: 'QUALITY', reached: 'QUALITY' })))).toBe(false)
    // The floor drops below it (a release reversed down to Cutting): it still stands.
    expect(planChanges(plan(hand('SEWING', { handFloor: 'QUALITY' }), target({ stage: 'CUTTING', reached: 'CUTTING' })))).toBe(false)
    // Preparing back from Cutting.
    expect(planChanges(plan(hand('PREPARING', { handFloor: 'CUTTING' }), target({ stage: 'CUTTING', reached: 'CUTTING' })))).toBe(false)
  })

  it("B-SC-003: set back — ends when the floor equals it (nothing told) or moves past where it stood at the set (the floor's stage written and told)", () => {
    const agrees = plan(hand('SEWING', { handFloor: 'QUALITY' }), target({ stage: 'SEWING', reached: 'SEWING' }))!
    expect(agrees.data).toEqual({ handDropped: 'REACHED' })
    expect(agrees.stageReached).toBeNull()
    const past = plan(hand('SEWING', { handFloor: 'QUALITY' }), target({ stage: 'READY', reached: 'READY' }))!
    expect(past.data).toEqual({ handDropped: 'REACHED', stage: 'READY', stageAt: NOW })
    expect(past.stageReached).toEqual({ stage: 'READY', previous: 'SEWING' })
    const prepared = plan(hand('PREPARING', { handFloor: 'CUTTING' }), target({ stage: 'SEWING', reached: 'SEWING' }))!
    expect(prepared.data).toEqual({ handDropped: 'REACHED', stage: 'SEWING', stageAt: NOW })
    expect(prepared.stageReached).toEqual({ stage: 'SEWING', previous: 'PREPARING' })
    // Without the floor at the set (a row written before B): read as set ahead — a hand Sewing under a floor at Quality check ends.
    expect(plan(hand('SEWING'), target({ stage: 'QUALITY', reached: 'QUALITY' }))!.data).toEqual({ handDropped: 'REACHED', stage: 'QUALITY', stageAt: NOW })
  })

  it('B-SC-003: a set back cleared by a person: the floor\'s stage again, a forward move (told as the usual notice)', () => {
    const cleared = planKeep({ row: hand('SEWING', { handFloor: 'QUALITY' }), target: target({ stage: 'QUALITY', reached: 'QUALITY' }), now: NOW, today: TODAY, clearHand: true })!
    expect(cleared.data).toEqual({ handDropped: 'CLEARED', stage: 'QUALITY', stageAt: NOW })
    expect(cleared.stageReached).toEqual({ stage: 'QUALITY', previous: 'SEWING' })
  })
  // ── end B-SC-003 ──

  it('the order left production (planLeaving): it ends, the stage is where the work reached, nothing told; no hand stage: nothing', () => {
    expect(planLeaving({ row: hand('SEWING'), reached: 'CUTTING', now: NOW })).toEqual({ create: false, data: { handDropped: 'LEFT_PRODUCTION', stage: 'CUTTING', stageAt: NOW }, stageReached: null, healthChanged: null })
    expect(planLeaving({ row: hand('SEWING'), reached: 'SEWING', now: NOW })!.data).toEqual({ handDropped: 'LEFT_PRODUCTION' })
    expect(planLeaving({ row: hand('SEWING'), reached: 'PREPARING', now: NOW, why: 'CLEARED' })!.data).toEqual({ handDropped: 'CLEARED', stage: 'PREPARING', stageAt: NOW })
    expect(planLeaving({ row: row(), reached: 'CUTTING', now: NOW })).toBeNull()
  })
})
// ── end B-MS-004 ──

// ── B-MS-008 (Owner D4: the 10-minute undo window; review R3a) ──
describe('B-MS-008: which stages a move leaves untold — a by-hand tell still in its window, no longer read', () => {
  const AT = new Date('2026-11-20T10:00:00.000Z')
  const later = (minutes: number) => new Date(AT.getTime() + minutes * 60_000)
  const told = (stage: BrandStage, byHand = true, at = AT): StageMarker => ({ action: STAGE_TOLD, stage, byHand, at, requestId: 'req-set' })
  const untold = (stage: BrandStage, at = AT): StageMarker => ({ action: STAGE_UNTOLD, stage, byHand: false, at, requestId: 'req-clear' })

  it('a Clear inside the window: the stage set by hand is left untold; the stage the customer reads now never is', () => {
    expect(waitingTellsOff([told('SEWING')], 'PREPARING', later(3))).toEqual([{ stage: 'SEWING', at: AT }])
    expect(waitingTellsOff([told('SEWING')], 'SEWING', later(3))).toEqual([])
  })

  it('after the window it was told and stays told; the floor\'s own tell (no flag) is never untold', () => {
    expect(HAND_STAGE_NOTICE_DELAY_MS).toBe(600_000)
    expect(waitingTellsOff([told('SEWING')], 'PREPARING', later(9.99))).toHaveLength(1)
    expect(waitingTellsOff([told('SEWING')], 'PREPARING', later(10))).toEqual([])
    expect(waitingTellsOff([told('CUTTING', false)], 'PREPARING', later(1))).toEqual([])
  })

  it('only the NEWEST marker of each stage counts (newest first): untold already, or told again by hand since', () => {
    expect(waitingTellsOff([untold('SEWING', later(2)), told('SEWING')], 'PREPARING', later(3))).toEqual([])
    expect(waitingTellsOff([told('SEWING', true, later(4)), untold('SEWING', later(2)), told('SEWING')], 'PREPARING', later(5))).toEqual([{ stage: 'SEWING', at: later(4) }])
  })

  it('a Change up inside the window leaves the stage it replaced untold, in stage order; the new one waits its own window', () => {
    const markers = [told('QUALITY', true, later(2)), told('CUTTING'), told('PREPARING', false, later(-60))]
    expect(waitingTellsOff(markers, 'QUALITY', later(2))).toEqual([{ stage: 'CUTTING', at: AT }])
    // Then a Clear back to Preparing: Quality check still waits (Cutting is untold already); with no untold yet, both, in stage order.
    expect(waitingTellsOff([untold('CUTTING', later(2)), ...markers], 'PREPARING', later(4))).toEqual([{ stage: 'QUALITY', at: later(2) }])
    expect(waitingTellsOff(markers, 'PREPARING', later(4))).toEqual([
      { stage: 'CUTTING', at: AT },
      { stage: 'QUALITY', at: later(2) },
    ])
  })

  // B-SC-004 (stage control B): a correction's tell waits the window too, and says so (its notice has the correction's key).
  it('B-SC-004: a correction still in its window, no longer read, is left untold with its flag; the floor never moved it', () => {
    const correction: StageMarker = { action: STAGE_TOLD, stage: 'CUTTING', byHand: true, at: later(1), requestId: 'req-back', correction: true }
    expect(waitingTellsOff([correction, untold('SEWING', later(1)), told('SEWING')], 'PREPARING', later(3))).toEqual([{ stage: 'CUTTING', at: later(1), correction: true }])
    expect(waitingTellsOff([correction], 'CUTTING', later(3))).toEqual([])
    expect(waitingTellsOff([correction], 'PREPARING', later(11))).toEqual([])
  })
})
// ── end B-MS-008 ──

// ── B-MS-008 (ms-fx1; Z01 note 2: the office's Clear… says what the customer was told, from the markers, never the set's time) ──
describe('B-MS-008 (ms-fx1): the notice of the stage set by hand that stands — told, waiting its window, or never told', () => {
  const AT = new Date('2026-11-20T09:00:00.000Z')
  const later = (minutes: number) => new Date(AT.getTime() + minutes * 60_000)
  const marker = (action: string, byHand: boolean, at = AT) => ({ action, byHand, at })

  it('a tell by hand inside its window, its notice not made: it waits, and says until when; made (a job run early) or past it: told', () => {
    expect(handNoticeOf(marker(STAGE_TOLD, true), false, later(4))).toEqual({ told: false, waitsUntil: later(10) })
    expect(handNoticeOf(marker(STAGE_TOLD, true), false, new Date(later(10).getTime() - 1))).toEqual({ told: false, waitsUntil: later(10) })
    expect(handNoticeOf(marker(STAGE_TOLD, true), false, later(10))).toEqual({ told: true, waitsUntil: null })
    expect(handNoticeOf(marker(STAGE_TOLD, true), true, later(1))).toEqual({ told: true, waitsUntil: null })
  })

  it('Z01 note 2: a Change to the same stage (or a set of a stage told before) writes a new set time but no tell — the markers say told', () => {
    // The set's tell 30 minutes ago went; the Change 2 minutes ago wrote no marker: the newest is still that tell — told, never "not yet".
    expect(handNoticeOf(marker(STAGE_TOLD, true, later(-30)), false, later(0))).toEqual({ told: true, waitsUntil: null })
    // The floor told it before the set by hand (a cut undone, then set by hand): told, at once.
    expect(handNoticeOf(marker(STAGE_TOLD, false, later(-1)), false, later(0))).toEqual({ told: true, waitsUntil: null })
  })

  it('never told: no marker (a Change going down is written and never told), or the newest is untold (its notice dropped)', () => {
    expect(handNoticeOf(null, false, later(1))).toEqual({ told: false, waitsUntil: null })
    expect(handNoticeOf(marker(STAGE_UNTOLD, false), false, later(1))).toEqual({ told: false, waitsUntil: null })
    expect(handNoticeOf(marker(STAGE_UNTOLD, false), true, later(30))).toEqual({ told: false, waitsUntil: null })
  })
})
// ── end B-MS-008 (ms-fx1) ──

// ── B-PT-016 (order production tab C2) ──
describe('B-PT-016: when an order waits on its customer’s material', () => {
  it('confirmed or in production with work still to do (no live work order yet, or one not made); never once the work is done', () => {
    expect(customerMaterialWaits('CONFIRMED', [])).toBe(true)
    expect(customerMaterialWaits('IN_PRODUCTION', ['COMPLETED', 'IN_PROGRESS'])).toBe(true)
    expect(customerMaterialWaits('IN_PRODUCTION', ['COMPLETED', 'CLOSED'])).toBe(false)
    for (const status of ['READY', 'PARTLY_SHIPPED', 'SHIPPED', 'CANCELLED', 'AWAITING_APPROVAL']) expect(customerMaterialWaits(status, []), status).toBe(false)
  })

  it('since the earliest row still expecting more than was received; none missing: null', () => {
    const at = (iso: string) => new Date(iso)
    expect(earliestMissingOf([{ expected: '8', received: '0', createdAt: at('2026-11-12T08:00:00.000Z') }, { expected: '2.5000', received: '1.0000', createdAt: at('2026-11-10T08:00:00.000Z') }, { expected: '3', received: '3', createdAt: at('2026-11-01T08:00:00.000Z') }])).toEqual(at('2026-11-10T08:00:00.000Z'))
    expect(earliestMissingOf([{ expected: '3.0000', received: '3.0000', createdAt: at('2026-11-01T08:00:00.000Z') }, { expected: '0', received: '0', createdAt: at('2026-11-01T08:00:00.000Z') }])).toBeNull()
    expect(earliestMissingOf([])).toBeNull()
  })
})
// ── end B-PT-016 ──

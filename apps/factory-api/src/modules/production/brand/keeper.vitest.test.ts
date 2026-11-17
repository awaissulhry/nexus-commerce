import { describe, expect, it } from 'vitest'
import { orderStageOf } from '@nexus/factory-domain/production-brand/stages'
import { lineStageFactsOf, type LineSizeRow } from './facts'
import { brandKeeperHandler, HOLD_EVENTS, KEEPER_EVENTS, planChanges, planKeep, STAGE_EVENTS, type KeeperRow, type KeeperTarget } from './keeper'

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
  health: 'ON_TRACK',
  healthSet: null,
  healthReasonCode: null,
  healthSetUntil: null,
  waitingOn: 'US',
  waitingSince: EARLIER,
  version: 3,
  ...over,
})
const target = (over: Partial<KeeperTarget> = {}): KeeperTarget => ({ stage: 'PREPARING', computed: 'ON_TRACK', waiting: { on: 'US', since: EARLIER }, ...over })
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

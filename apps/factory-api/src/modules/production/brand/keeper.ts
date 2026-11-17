import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { eventFor } from '@nexus/factory-domain/events/define'
import { assertOneParty, brandHealthChanged, brandHoldChanged, brandStageReached, type BrandHoldKind } from '@nexus/factory-domain/production-brand/events'
import { effectiveHealth, raiseStands, type BrandHealth, type HealthRaise, type HealthReasonCode } from '@nexus/factory-domain/production-brand/health'
import { brandStageRank, movedForward, type BrandStage } from '@nexus/factory-domain/production-brand/stages'
import type { Waiting, WaitingOn } from '@nexus/factory-domain/production-brand/waiting'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings, type CommandTools } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { activeTenants, asSystem, systemContext } from '../../../platform/outbox/system'
import { dayOf } from '../../planning/store'
import type { Reader } from '../../sales/orders/store'
import { KEEPER_ORDER_STATES, keeperPlanningContext, orderOfCell, ordersOfWorkOrders, readOrderProductionFacts, type LineRisk, type OrderProductionFacts } from './facts'

/**
 * The customer's stage and health keeper (B-PR-17; production plan §4, 08-backend §3 "Keeper"; review fixes R-20, R-21, R-31,
 * R-35, R-69; the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the
 * production unit, should be able to see it all. And manage it all as well."). It keeps each sales order's BrandOrderProduction
 * row (B-PR-15) in step with its facts (facts.ts) — the row is MADE when the order is CONFIRMED (R-21: a confirmed order that
 * waits for its PP answer or deposit is on My production before any work order) — and tells what moved
 * (B-PR-16's events):
 *
 *   stage            the plain stage of the order (its slowest unfinished line) and since when; `brand_production.stage_reached`
 *                    ONLY on a forward move (stages.ts movedForward), and once per order and stage: a stage reached, taken back
 *                    (a release reversed, a cut undone) and reached again is not told again (R-20; the audit marker
 *                    `production.brandKeeper.stageTold` on the order's BrandOrderProduction row says it was told: on the row,
 *                    so the order's own timeline stays the order's). A stage going back is written (the
 *                    customer reads only true states) and never told. An order with no open goods line keeps its last stage.
 *   health           the computed health (facts.ts) and when it changed; the factory's raise to At risk is dropped once 7
 *                    days passed or the computed health changed (health.ts raiseStands). `brand_production.health_changed`
 *                    when the health the customer reads (effectiveHealth) changed, `byNote` when only the raise's drop did it.
 *   waiting on       the first owner with a blocker (customer → supplier → workshop → us) and since when (the earliest
 *                    known start of its blockers; else when the order started waiting on that owner).
 *   hold             on a hold event: `brand_production.hold_changed` for each of the work order's orders, with whether the
 *                    order is still on hold (another hold may still hold it) and the kind of the hold placed or lifted.
 *
 * The worker's handler `production.brandKeeper` follows the events that move those facts (KEEPER_EVENTS) and recomputes the
 * orders they name — read in the tenant's system scope, by the order's own row: each event names ONE order and that order's
 * own customer (PW-P07; a legacy work order of two customers gives each customer an event of its own order only). It never
 * follows `brand_production.urgency_changed` (R-69): one customer's urgency recomputes no order of another customer. High
 * volume first, one indexed read, then skipped: a scan, or a start at an operation, only at a SEWING work centre and only for
 * an order not yet at SEWING; a cut or a bundle only for an order not yet at CUTTING. Stage events read no planning (the
 * health and waiting-on stay as they were); the others and the nightly cron read the planning risk too.
 *
 * The scheduler's clustered cron `production.brandKeeper` (00:35 Europe/Rome, just after the business date turns) recomputes
 * every kept order of every tenant, one by one as an event would: a promise that passed in the night shows LATE, a raise past
 * its 7 days drops, an order confirmed before the keeper existed gets its row.
 *
 * Each change is ONE system command on the order (an advisory lock per order, the facts read again under it — the planning
 * risk as read just before — then the row written): its audit rows on the BrandOrderProduction row (the change, the stage
 * marker), the events; nothing changed: no command at all. A hold event's command carries a key of the event and the order, so
 * a retried job tells the hold once. Safe to repeat: it moves on facts, never on the event.
 */

export const KEEP_COMMAND = 'production.brandKeeper'
/** The audit marker of a stage told to the customer (once per order and stage). */
export const STAGE_TOLD = 'production.brandKeeper.stageTold'

/** The events whose facts move an order's stage, health, waiting-on or hold mark. */
export const STAGE_EVENTS = [
  'production.cut_logged',
  'production.cut_reversed',
  'production.bundle_created',
  'production.bundle_voided',
  'production.scan_recorded',
  'production.operation_timed',
  'quality.garments_released',
  'quality.release_reversed',
] as const
export const HOLD_EVENTS = ['quality.hold_placed', 'quality.hold_released', 'work_order_hold.placed', 'work_order_hold.lifted'] as const
export const ORDER_EVENTS = [
  'sales_order.created',
  'sales_order.status_changed',
  'sales_order.promise_changed',
  'sales_order.amended',
  'sales_order.lines_closed',
  'workorder.released',
  'workorder.status_changed',
  'shipment.status_changed',
  'order_gate.changed',
  'order_change_request.asked',
  'order_change_request.withdrawn',
  'order_change_request.answered',
  'approval_request.asked',
  'approval_request.answered',
  'approval_request.withdrawn',
  'approval_request.expired',
  'deposit_request.waived',
  'production_issue.raised',
  'production_issue.answered',
  // B-PR-28: the follow-up task of a new date the customer did not accept (only such a task names orders: ordersOfEvent).
  'task.created',
  'task.completed',
  'task.changed',
] as const
export const KEEPER_EVENTS: readonly string[] = Object.freeze([...ORDER_EVENTS, ...STAGE_EVENTS, ...HOLD_EVENTS])

// ---- the plan (pure) ---------------------------------------------------------------------------------------------------------

/** The keeper's columns of an order's row, as read. */
export interface KeeperRow {
  readonly id: string
  readonly partyId: string
  readonly salesOrderId: string
  readonly stage: BrandStage
  readonly health: BrandHealth | null
  readonly healthSet: BrandHealth | null
  readonly healthReasonCode: HealthReasonCode | null
  readonly healthSetUntil: BusinessDate | null
  readonly waitingOn: WaitingOn | null
  readonly waitingSince: Date | null
  readonly version: number
}

export interface KeeperTarget {
  /** The plain stage now (null: no open goods line; the row keeps its stage). */
  readonly stage: BrandStage | null
  /** The computed health now (null: nothing left to make). */
  readonly computed: BrandHealth | null
  readonly waiting: Waiting
}

export interface KeepPlan {
  /** The order has no row yet: make it. */
  readonly create: boolean
  /** The columns to write (empty: nothing changed). */
  readonly data: {
    stage?: BrandStage
    stageAt?: Date
    health?: BrandHealth | null
    healthAt?: Date | null
    waitingOn?: WaitingOn
    waitingSince?: Date
    /** The raise dropped: every raise column cleared. */
    raiseDropped?: true
  }
  /** A forward move to tell (still once per order and stage: the command checks the marker). */
  readonly stageReached: { readonly stage: BrandStage; readonly previous: BrandStage | null } | null
  /** The health the customer reads changed. */
  readonly healthChanged: { readonly health: BrandHealth | null; readonly previous: BrandHealth | null; readonly byNote: boolean } | null
}

const sameTime = (a: Date | null, b: Date | null): boolean => (a === null ? b === null : b !== null && a.getTime() === b.getTime())

/**
 * What the keeper writes and tells for one order: from its row (null: none yet) and its facts now. A new row is made only
 * when the order has a stage (an open goods line).
 */
export function planKeep(input: { readonly row: KeeperRow | null; readonly target: KeeperTarget; readonly now: Date; readonly today: BusinessDate }): KeepPlan | null {
  const { row, target, now, today } = input
  if (row === null && target.stage === null) return null
  const data: KeepPlan['data'] = {}
  const previousStage = row?.stage ?? null
  if (target.stage !== null && target.stage !== previousStage) {
    data.stage = target.stage
    data.stageAt = now
  }
  const stageReached = target.stage !== null && movedForward(previousStage, target.stage) ? { stage: target.stage, previous: previousStage } : null

  // The health: the computed one, and the factory's raise while it stands.
  const computedBefore = row?.health ?? null
  const computedNow = target.computed
  const raise: HealthRaise | null = row?.healthSet && row.healthReasonCode && row.healthSetUntil ? { reasonCode: row.healthReasonCode, until: row.healthSetUntil } : null
  const stands = raise !== null && raiseStands(raise, { computedBefore, computedNow, today })
  if (raise !== null && !stands) data.raiseDropped = true
  if (row === null || computedNow !== computedBefore) {
    data.health = computedNow
    data.healthAt = row === null && computedNow === null ? null : now
  }
  const before = row === null ? null : effectiveHealth(computedBefore, raise).health
  const after = effectiveHealth(computedNow, stands ? raise : null).health
  const healthChanged = before !== after ? { health: after, previous: before, byNote: row !== null && computedNow === computedBefore } : null

  // What it waits on, and since when.
  const on = target.waiting.on
  const since = row !== null && on === row.waitingOn ? (target.waiting.since ?? row.waitingSince ?? now) : (target.waiting.since ?? now)
  if (row === null || on !== row.waitingOn || !sameTime(since, row.waitingSince)) {
    data.waitingOn = on
    data.waitingSince = since
  }
  return { create: row === null, data, stageReached, healthChanged }
}

/** Something to write or tell. */
export const planChanges = (plan: KeepPlan | null): boolean => plan !== null && (plan.create || Object.keys(plan.data).length > 0 || plan.stageReached !== null || plan.healthChanged !== null)

// ---- one order ---------------------------------------------------------------------------------------------------------------

const ROW_SELECT = {
  id: true,
  partyId: true,
  salesOrderId: true,
  stage: true,
  health: true,
  healthSet: true,
  healthReasonCode: true,
  healthSetUntil: true,
  waitingOn: true,
  waitingSince: true,
  version: true,
} as const

async function readRow(db: Reader, orderId: string): Promise<KeeperRow | null> {
  const row = await db.brandOrderProduction.findFirst({ where: { key: `brand-production:${orderId}` }, select: ROW_SELECT })
  if (!row) return null
  return {
    ...row,
    stage: row.stage as BrandStage,
    health: row.health as BrandHealth | null,
    healthSet: row.healthSet as BrandHealth | null,
    healthReasonCode: row.healthReasonCode as HealthReasonCode | null,
    healthSetUntil: row.healthSetUntil ? dayOf(row.healthSetUntil) : null,
    waitingOn: row.waitingOn as WaitingOn | null,
  }
}

/** A read without the planning (a stage event: a cut, a bundle, a scan, a release) keeps the health and waiting-on as they were. */
const targetOf = (facts: OrderProductionFacts, row: KeeperRow | null): KeeperTarget => {
  const planned = facts.computed !== undefined
  return {
    stage: facts.stage?.stage ?? null,
    computed: planned ? (facts.computed ?? null) : (row?.health ?? null),
    waiting: planned || row === null || row.waitingOn === null ? facts.waiting : { on: row.waitingOn, since: row.waitingSince },
  }
}

export interface KeepCause {
  /** What made the keeper look (an event type, `nightly`). */
  readonly what: string
  readonly causationId?: string
  /** Read the planning risk (default true). */
  readonly health?: boolean
  /** A hold placed or lifted on the order's work: tell it (once per event and order). */
  readonly hold?: { readonly kind: BrandHoldKind; readonly eventId: string }
}

export interface KeepResult {
  readonly orderId: string
  /** A command ran (and was not a replay). */
  readonly changed: boolean
  readonly told: readonly string[]
}

/** Keeps one order's row (a system or office caller); nothing to change or tell: no command. */
export async function keepOrder(caller: CommandCaller, orderId: string, cause: KeepCause, settings: CommandSettings = COMMAND_SETTINGS): Promise<KeepResult> {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'system' && context.audience !== 'office')) throw new ForbiddenError()
  const planningContext = keeperPlanningContext(context.tenantId, context.requestId)
  const now = settings.clock.now()
  const today = businessDate(now)
  const read = await caller.withClient(async (db) => {
    const facts = await readOrderProductionFacts(db, planningContext, orderId, now, { health: cause.health !== false })
    if (!facts || !facts.kept) return null
    const row = await readRow(db, orderId)
    return { facts, row, plan: planKeep({ row, target: targetOf(facts, row), now, today }) }
  })
  if (!read) return { orderId, changed: false, told: [] }
  if (!planChanges(read.plan) && !(cause.hold && (read.row !== null || read.plan !== null))) return { orderId, changed: false, told: [] }
  // The risks as read just now: the command reads every other fact again under the order's lock (a short transaction).
  const risks: ReadonlyMap<string, LineRisk> | undefined = cause.health === false ? undefined : read.facts.risks
  const { result, replayed } = await runCommand(
    caller,
    {
      name: KEEP_COMMAND,
      input: { orderId, cause: cause.what, ...(cause.hold ? { hold: cause.hold.kind, eventId: cause.hold.eventId } : {}) },
      ...(cause.hold ? { idempotencyKey: `brand-hold:${cause.hold.eventId}:${orderId}` } : {}),
      ...(cause.causationId ? { causationId: cause.causationId } : {}),
    },
    async (tools) => {
      const { tx, now: at } = tools
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.brand-keeper', ${orderId}::uuid), 0))`
      const facts = await readOrderProductionFacts(tx, planningContext, orderId, at, { health: cause.health !== false, ...(risks ? { risks } : {}) })
      if (!facts || !facts.kept) return { told: [] as string[], wrote: false }
      const row = await readRow(tx, orderId)
      const plan = planKeep({ row, target: targetOf(facts, row), now: at, today: businessDate(at) })
      return writePlan(tools, facts, row, plan, cause)
    },
    settings,
  )
  return { orderId, changed: !replayed && result.wrote, told: replayed ? [] : result.told }
}

async function writePlan(tools: CommandTools, facts: OrderProductionFacts, row: KeeperRow | null, plan: KeepPlan | null, cause: KeepCause): Promise<{ told: string[]; wrote: boolean }> {
  const { tx, now } = tools
  const order = facts.order
  const told: string[] = []
  let rowId = row?.id ?? null
  if (plan !== null && planChanges(plan)) {
    const { raiseDropped, ...columns } = plan.data
    const raise = raiseDropped ? { healthSet: null, healthReasonCode: null, healthNote: null, healthSetAt: null, healthSetById: null, healthSetUntil: null } : {}
    if (plan.create) {
      rowId = newId()
      await tx.brandOrderProduction.create({
        data: {
          id: rowId,
          companyId: order.companyId,
          partyId: order.partyId,
          salesOrderId: order.id,
          key: `brand-production:${order.id}`,
          stage: columns.stage ?? 'PREPARING',
          stageAt: columns.stageAt ?? now,
          health: columns.health ?? null,
          healthAt: columns.healthAt ?? null,
          ...(columns.waitingOn ? { waitingOn: columns.waitingOn, waitingSince: columns.waitingSince ?? now } : {}),
        },
        select: { id: true },
      })
    } else if (Object.keys(plan.data).length > 0) {
      await tx.brandOrderProduction.update({ where: { id: row!.id }, data: { ...columns, ...raise, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    }
    if (plan.create || Object.keys(plan.data).length > 0) {
      tools.audit({
        recordType: 'BrandOrderProduction',
        recordId: rowId!,
        companyId: order.companyId,
        before: row ? { stage: row.stage, health: row.health, raised: row.healthSet !== null, waitingOn: row.waitingOn, waitingSince: row.waitingSince ? toUtcIso(row.waitingSince) : null } : null,
        after: {
          salesOrderId: order.id,
          ...(plan.create ? { made: true } : {}),
          ...(columns.stage ? { stage: columns.stage } : {}),
          ...('health' in columns ? { health: columns.health ?? null } : {}),
          ...(raiseDropped ? { raiseDropped: true } : {}),
          ...(columns.waitingOn ? { waitingOn: columns.waitingOn, waitingSince: toUtcIso(columns.waitingSince ?? now) } : {}),
          ...(facts.promiseOnly ? { riskFrom: 'PROMISE_ONLY' } : {}),
        },
        reason: `Kept: ${cause.what}.`,
      })
    }
    // The wall (PW-P07): every event below names this one order and its own customer — the order's row and its production row
    // must agree before anything is told.
    const partyOf = new Map([[order.id, row?.partyId ?? order.partyId]])
    if (plan.stageReached) {
      const { stage, previous } = plan.stageReached
      const already = await tx.auditLog.findFirst({ where: { recordType: 'BrandOrderProduction', recordId: rowId!, action: STAGE_TOLD, after: { path: ['stage'], equals: stage } }, select: { id: true } })
      if (!already) {
        assertOneParty({ partyId: order.partyId, orderIds: [order.id] }, partyOf)
        tools.audit({ action: STAGE_TOLD, recordType: 'BrandOrderProduction', recordId: rowId!, companyId: order.companyId, after: { salesOrderId: order.id, stage, previous } })
        tools.emit(eventFor(brandStageReached, { subject: order.id, companyId: order.companyId, payload: { orderId: order.id, partyId: order.partyId, stage, previous } }))
        told.push('brand_production.stage_reached')
      }
    }
    if (plan.healthChanged) {
      assertOneParty({ partyId: order.partyId, orderIds: [order.id] }, partyOf)
      tools.emit(eventFor(brandHealthChanged, { subject: order.id, companyId: order.companyId, payload: { orderId: order.id, partyId: order.partyId, ...plan.healthChanged } }))
      told.push('brand_production.health_changed')
    }
  }
  if (cause.hold && rowId !== null) {
    assertOneParty({ partyId: order.partyId, orderIds: [order.id] }, new Map([[order.id, row?.partyId ?? order.partyId]]))
    tools.audit({ action: `${KEEP_COMMAND}.hold`, recordType: 'BrandOrderProduction', recordId: rowId, companyId: order.companyId, after: { salesOrderId: order.id, held: facts.held, kind: cause.hold.kind } })
    tools.emit(eventFor(brandHoldChanged, { subject: order.id, companyId: order.companyId, payload: { orderId: order.id, partyId: order.partyId, held: facts.held, kind: cause.hold.kind } }))
    told.push('brand_production.hold_changed')
  }
  if (told.length === 0 && !(plan !== null && planChanges(plan))) {
    // Under the lock nothing was left to do (another keeper did it): one audit row says so (every command records one).
    tools.audit({ recordType: rowId ? 'BrandOrderProduction' : 'SalesOrder', recordId: rowId ?? order.id, companyId: order.companyId, after: { salesOrderId: order.id, kept: false }, reason: `Kept: ${cause.what}.` })
    return { told, wrote: false }
  }
  return { told, wrote: true }
}

// ---- the worker's handler ----------------------------------------------------------------------------------------------------

/** The stage at or after which a high-volume event cannot move the order any more (null: never skipped). */
function skipFrom(type: string): BrandStage | null {
  if (type === 'production.scan_recorded' || type === 'production.operation_timed') return 'SEWING'
  if (type === 'production.cut_logged' || type === 'production.bundle_created') return 'CUTTING'
  return null
}

const asStrings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])

/**
 * The orders an event names (its own sales order, or the orders of the work orders and cells it names), and for a hold event
 * the kind of hold. Read in the event's tenant; a high-volume event at a step that cannot move a stage names none.
 */
export async function ordersOfEvent(db: Reader, event: Pick<EventEnvelope, 'type' | 'payload'>): Promise<{ orderIds: string[]; hold: BrandHoldKind | null }> {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const text = (key: string): string | null => (typeof payload[key] === 'string' ? (payload[key] as string) : null)
  switch (event.type) {
    case 'sales_order.created':
    case 'sales_order.status_changed':
    case 'sales_order.promise_changed':
    case 'sales_order.amended':
    case 'sales_order.lines_closed':
    case 'order_change_request.asked':
    case 'order_change_request.withdrawn':
    case 'order_change_request.answered':
    case 'deposit_request.waived':
      return { orderIds: asStrings([text('orderId')]), hold: null }
    case 'order_gate.changed':
      return { orderIds: asStrings([text('salesOrderId')]), hold: null }
    case 'production_issue.answered':
      return { orderIds: asStrings([text('salesOrderId')]), hold: null }
    // B-PR-28: a task on a sales order counts only as the follow-up of a refused new date (its id is the REPROMISE request's).
    case 'task.created':
    case 'task.completed':
    case 'task.changed': {
      const taskId = text('taskId')
      if (text('recordType') !== 'SalesOrder' || !taskId) return { orderIds: [], hold: null }
      const asked = await db.approvalRequest.findFirst({ where: { id: taskId, kind: 'REPROMISE', recordType: 'SalesOrder' }, select: { recordId: true } })
      return { orderIds: asked ? [asked.recordId] : [], hold: null }
    }
    case 'production_issue.raised':
    case 'approval_request.asked':
    case 'approval_request.answered':
    case 'approval_request.withdrawn':
    case 'approval_request.expired': {
      const recordType = text('recordType')
      const recordId = text('recordId')
      if (!recordId) return { orderIds: [], hold: null }
      if (recordType === 'SalesOrder') return { orderIds: [recordId], hold: null }
      if (recordType === 'WorkOrder') return { orderIds: await ordersOfWorkOrders(db, [recordId]), hold: null }
      if (recordType === 'SampleRound') {
        const gates = await db.orderGate.findMany({ where: { sampleRoundId: recordId }, select: { salesOrderId: true } })
        return { orderIds: [...new Set(gates.map((gate) => gate.salesOrderId))].sort(), hold: null }
      }
      return { orderIds: [], hold: null }
    }
    case 'workorder.released':
      return { orderIds: [...new Set(asStrings(payload.salesOrderIds))].sort(), hold: null }
    case 'shipment.status_changed': {
      const shipmentId = text('shipmentId')
      const shipment = shipmentId ? await db.shipment.findUnique({ where: { id: shipmentId }, select: { salesOrderId: true } }) : null
      return { orderIds: shipment ? [shipment.salesOrderId] : [], hold: null }
    }
    case 'quality.garments_released':
    case 'quality.release_reversed': {
      const cellId = text('workOrderSizeId')
      return { orderIds: cellId ? await orderOfCell(db, cellId) : [], hold: null }
    }
    case 'quality.hold_placed':
    case 'quality.hold_released': {
      const subjects = text('subjectType') === 'WorkOrder' ? asStrings(payload.subjectIds) : []
      const moved = asStrings(event.type === 'quality.hold_placed' ? payload.workOrdersHeld : payload.workOrdersLifted)
      return { orderIds: await ordersOfWorkOrders(db, [...subjects, ...moved]), hold: 'QUALITY' }
    }
    case 'work_order_hold.placed':
    case 'work_order_hold.lifted': {
      const workOrderId = text('workOrderId')
      const kind = text('kind') === 'BRAND' ? 'BRAND' : 'PRODUCTION'
      return { orderIds: workOrderId ? await ordersOfWorkOrders(db, [workOrderId]) : [], hold: kind }
    }
    case 'production.scan_recorded':
    case 'production.operation_timed': {
      if (event.type === 'production.operation_timed' && text('kind') !== 'START') return { orderIds: [], hold: null }
      const operationId = text('operationId')
      const operation = operationId ? await db.workOrderOperation.findUnique({ where: { id: operationId }, select: { workOrderId: true, workCentre: { select: { kind: true } } } }) : null
      if (!operation || operation.workCentre.kind !== 'SEWING') return { orderIds: [], hold: null }
      return { orderIds: await notYetAt(db, await ordersOfWorkOrders(db, [operation.workOrderId]), 'SEWING'), hold: null }
    }
    default: {
      // workorder.status_changed, the cuts and bundles: the work order's orders.
      const workOrderId = text('workOrderId')
      const orderIds = workOrderId ? await ordersOfWorkOrders(db, [workOrderId]) : []
      const from = skipFrom(event.type)
      return { orderIds: from ? await notYetAt(db, orderIds, from) : orderIds, hold: null }
    }
  }
}

/** The orders whose row is not yet at `stage` (an order with no row yet counts: its row is made). One indexed read. */
async function notYetAt(db: Reader, orderIds: readonly string[], stage: BrandStage): Promise<string[]> {
  if (orderIds.length === 0) return []
  const rows = await db.brandOrderProduction.findMany({ where: { key: { in: orderIds.map((id) => `brand-production:${id}`) } }, select: { salesOrderId: true, stage: true } })
  const at = new Map(rows.map((row) => [row.salesOrderId, row.stage as BrandStage]))
  return orderIds.filter((id) => {
    const known = at.get(id)
    return known === undefined || brandStageRank(known) < brandStageRank(stage)
  })
}

/** The worker's `production.brandKeeper` (background.ts): the orders an event names, each kept on its own facts. */
export function brandKeeperHandler(): EventHandler {
  return defineHandler({
    name: 'production.brandKeeper',
    events: KEEPER_EVENTS,
    attempts: 5,
    async handle(event, { caller }) {
      const { orderIds, hold } = await caller.withClient((db) => ordersOfEvent(db, event))
      const health = !(STAGE_EVENTS as readonly string[]).includes(event.type)
      for (const orderId of orderIds) {
        await keepOrder(caller, orderId, { what: event.type, causationId: event.eventId, health, ...(hold ? { hold: { kind: hold, eventId: event.eventId } } : {}) })
      }
    },
  })
}

// ---- the nightly cron --------------------------------------------------------------------------------------------------------

export interface KeeperNightlyOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

export interface KeeperNightlyRun {
  readonly tenants: number
  readonly orders: number
  readonly changed: number
  readonly failed: number
}

/** One run over every active tenant's kept orders (the cron's tick; tests call it directly). */
export async function runBrandKeeperNightly(options: KeeperNightlyOptions): Promise<KeeperNightlyRun> {
  const clock = options.clock ?? serverClock
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock }
  const requestId = `brand-keeper-${newId()}`
  let orders = 0
  let changed = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    try {
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      const ids = await asSystem(options.database, tenantId, requestId, async (client) =>
        (await client.salesOrder.findMany({ where: { status: { in: [...KEEPER_ORDER_STATES] } }, select: { id: true }, orderBy: { id: 'asc' } })).map((row) => row.id),
      )
      for (const orderId of ids) {
        orders++
        try {
          const result = await keepOrder(caller, orderId, { what: 'nightly' }, settings)
          if (result.changed) changed++
        } catch (error) {
          failed++
          options.log.error({ err: error, tenantId, orderId }, "an order's production state could not be kept")
        }
      }
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, "the orders' production states of a tenant could not be kept")
    }
  }
  const result = { tenants: tenants.length, orders, changed, failed }
  options.log.info({ ...result }, "customers' production states kept")
  return result
}

/** The scheduler's nightly cron (00:35 Europe/Rome). */
export function brandKeeperCron(options: KeeperNightlyOptions): CronJob {
  return defineCron({
    name: 'production.brandKeeper',
    schedule: '35 0 * * *',
    async run() {
      await runBrandKeeperNightly(options)
    },
  })
}

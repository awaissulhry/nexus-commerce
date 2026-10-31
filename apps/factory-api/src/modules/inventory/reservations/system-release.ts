import type { FactoryDatabase, Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Clock } from '@nexus/factory-domain/core/time'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import {
  DONE_WORK_ORDER_STATUSES,
  demandDone,
  isDoneWorkOrder,
  MAX_SYSTEM_RELEASE,
  OPEN_ORDER_STATUSES,
  systemReleaseReason,
  type ReservationDemand,
} from '@nexus/factory-domain/inventory/reservations/rules'
import { callerFor, command, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock } from '../../../core/time'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { lockReservations, RESERVATION_COLUMNS, type ReservationRow } from './store'

/**
 * Reservations released by the system (B-W2b-15; follow-up Z2:03 of B-W2a-11, SCM-211 "Reservation clean-up job"). A
 * reservation whose demand is done holds nothing (availability leaves it out: `stale`), but it stayed ACTIVE until a
 * person released it. The …_followups_stock_w2b_guards reservation trigger now lets the SYSTEM release it — status
 * RELEASED, when and why, nobody as `releasedById` — exactly once its demand is done (its work order COMPLETED, CLOSED or
 * CANCELLED; its order line closed short or its order no longer open); a person still releases anything else, with the
 * reason (./reserve.ts release).
 *
 *   the work order's own event   the worker's handler `inventory.releaseOnWorkOrderDone` on `workorder.status_changed`
 *                                to COMPLETED, CLOSED or CANCELLED: the rest of the work order's ACTIVE reservations,
 *                                in ONE system command (key `reservations-done:<work order>`: a repeat answers from the
 *                                receipt; a work order reopened meanwhile is left alone);
 *   the nightly clean-up         cron `inventory.reservationsCleanup` (every day at 02:40 Rome, clustered): per tenant the
 *                                ACTIVE reservations whose demand is done — order lines closed short or of a shipped,
 *                                closed or cancelled order, and any work order's the handler missed — at most 200 per
 *                                command, each re-read under the reserve lock (a row a person released meanwhile is
 *                                skipped), the run's figures logged.
 *
 * Each release is audited per reservation (action inventory.releaseReservation, no actor, the reason in words: "Released
 * by the system: …") and announced once per command (`inventory.reservations_released` with `bySystem`). Stock is not
 * touched: a stale reservation held nothing.
 */

type Tx = Prisma.TransactionClient

interface DemandFacts {
  readonly workOrders: ReadonlyMap<string, { readonly number: string; readonly status: string }>
  readonly orderLines: ReadonlyMap<string, { readonly seq: number; readonly number: string; readonly orderStatus: string; readonly closedShort: boolean }>
}

async function demandFactsOf(tx: Tx, rows: readonly ReservationRow[]): Promise<DemandFacts> {
  const workOrderIds = [...new Set(rows.flatMap((row) => (row.workOrderId ? [row.workOrderId] : [])))]
  const lineIds = [...new Set(rows.flatMap((row) => (row.salesOrderLineId ? [row.salesOrderLineId] : [])))]
  const workOrders = workOrderIds.length === 0 ? [] : await tx.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true, status: true } })
  const lines = lineIds.length === 0 ? [] : await tx.salesOrderLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, seq: true, closedShortAt: true, order: { select: { number: true, status: true } } } })
  return {
    workOrders: new Map(workOrders.map((row) => [row.id, { number: row.number, status: row.status }])),
    orderLines: new Map(lines.map((line) => [line.id, { seq: line.seq, number: line.order.number, orderStatus: line.order.status, closedShort: line.closedShortAt !== null }])),
  }
}

function demandOf(row: ReservationRow, facts: DemandFacts): ReservationDemand | null {
  if (row.workOrderId) {
    const workOrder = facts.workOrders.get(row.workOrderId)
    return workOrder ? { type: 'WorkOrder', number: workOrder.number, status: workOrder.status } : null
  }
  if (row.salesOrderLineId) {
    const line = facts.orderLines.get(row.salesOrderLineId)
    return line ? { type: 'SalesOrderLine', number: line.number, seq: line.seq, orderStatus: line.orderStatus, closedShort: line.closedShort } : null
  }
  return null
}

/**
 * Inside a system command: releases the ACTIVE reservations among `ids` whose demand is done, under their reserve locks,
 * re-read after the locks (one a person released or an issue changed meanwhile is skipped). Answers the released ids.
 */
export async function releaseBySystemInCommand(tools: CommandTools, ids: readonly string[], by: 'WORK_ORDER_DONE' | 'NIGHTLY_CLEANUP'): Promise<string[]> {
  const context = tools.context
  if (ids.length === 0 || context.audience !== 'system') return []
  const before = await tools.tx.reservation.findMany({ where: { id: { in: [...ids] } }, select: RESERVATION_COLUMNS })
  await lockReservations(tools.tx, context.tenantId, before.map((row) => ({ siteId: row.siteId, itemId: row.itemId, itemColourId: row.itemColourId })))
  const rows = await tools.tx.reservation.findMany({ where: { id: { in: [...ids] }, status: 'ACTIVE' }, select: RESERVATION_COLUMNS, orderBy: { id: 'asc' } })
  const facts = await demandFactsOf(tools.tx, rows)
  const released: ReservationRow[] = []
  for (const row of rows) {
    const demand = demandOf(row, facts)
    if (!demand || !demandDone(demand)) continue
    const reason = systemReleaseReason(demand, by)
    const changed = await tools.tx.reservation.updateMany({
      where: { id: row.id, status: 'ACTIVE', version: row.version },
      data: { status: 'RELEASED', releasedAt: tools.now, releasedById: null, releaseReason: reason, version: { increment: 1 }, updatedAt: tools.now },
    })
    if (changed.count !== 1) continue
    released.push(row)
    tools.audit({
      action: 'inventory.releaseReservation',
      recordType: 'Reservation',
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      before: { status: row.status, issuedQuantity: row.issuedQuantity.toFixed(4) },
      after: { status: 'RELEASED', released: quantityText(row.quantity.minus(row.issuedQuantity)), by: 'SYSTEM' },
      reason,
    })
  }
  if (released.length === 0) return []
  const sites = [...new Set(released.map((row) => row.siteId))]
  const companies = [...new Set(released.map((row) => row.companyId))]
  tools.emit({
    type: 'inventory.reservations_released',
    subject: released[0]!.id,
    companyId: companies.length === 1 ? companies[0]! : null,
    siteId: sites.length === 1 ? sites[0]! : null,
    payload: {
      reservationIds: released.map((row) => row.id),
      workOrderIds: [...new Set(released.flatMap((row) => (row.workOrderId ? [row.workOrderId] : [])))],
      salesOrderLineIds: [...new Set(released.flatMap((row) => (row.salesOrderLineId ? [row.salesOrderLineId] : [])))],
      itemIds: [...new Set(released.map((row) => row.itemId))],
      hideIds: [...new Set(released.flatMap((row) => (row.hideId ? [row.hideId] : [])))],
      bySystem: by,
    },
  })
  return released.map((row) => row.id)
}

// ---- the work order's own event ----------------------------------------------------------------------------------------------

/**
 * The rest of a done work order's ACTIVE reservations, released by the system in ONE command (the worker's handler; a
 * system or office caller). Nothing to release, or the work order not done (reopened meanwhile): nothing is written.
 */
export async function releaseForDoneWorkOrder(caller: CommandCaller, workOrderId: string, cause: { readonly causationId?: string } = {}): Promise<{ released: string[] }> {
  const context = caller.factoryContext
  if (!context || context.audience !== 'system') return { released: [] }
  const found = await caller.withClient(async (client) => {
    const workOrder = await client.workOrder.findUnique({ where: { id: workOrderId }, select: { status: true } })
    if (!workOrder || !isDoneWorkOrder(workOrder.status)) return []
    return client.reservation.findMany({ where: { workOrderId, status: 'ACTIVE' }, select: { id: true }, orderBy: { id: 'asc' }, take: MAX_SYSTEM_RELEASE })
  })
  if (found.length === 0) return { released: [] }
  const { result } = await command(
    caller,
    {
      name: 'inventory.releaseReservationsBySystem',
      idempotencyKey: `reservations-done:${workOrderId}:${found.length}:${found[0]!.id}`,
      input: { workOrderId, reservationIds: found.map((row) => row.id) },
      ...(cause.causationId ? { causationId: cause.causationId } : {}),
    },
    async (tools) => ({ released: await releaseBySystemInCommand(tools, found.map((row) => row.id), 'WORK_ORDER_DONE') }),
  )
  return result
}

/**
 * The worker's handler (listed in background.ts): a work order completed, closed or cancelled → the rest of its
 * reservations released by the system. Safe to repeat: a repeat finds nothing ACTIVE, or answers from the receipt.
 */
export function releaseOnWorkOrderDoneHandler(): EventHandler {
  return defineHandler({
    name: 'inventory.releaseOnWorkOrderDone',
    events: ['workorder.status_changed'],
    async handle(event, { caller }) {
      const payload = event.payload as { workOrderId: string; to: string }
      if (!isDoneWorkOrder(payload.to)) return
      await releaseForDoneWorkOrder(caller, payload.workOrderId, { causationId: event.eventId })
    },
  })
}

// ---- the nightly clean-up (SCM-211) -----------------------------------------------------------------------------------------

/** The ACTIVE reservations of the tenant whose demand is done (at most `take`, oldest first). */
export async function staleReservationIds(client: Tx, take: number): Promise<string[]> {
  const rows = await client.reservation.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { workOrder: { status: { in: [...DONE_WORK_ORDER_STATUSES] } } },
        { salesOrderLine: { OR: [{ closedShortAt: { not: null } }, { order: { status: { notIn: [...OPEN_ORDER_STATUSES] } } }] } },
      ],
    },
    select: { id: true },
    orderBy: { id: 'asc' },
    take,
  })
  return rows.map((row) => row.id)
}

export interface CleanupOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

export interface CleanupRun {
  readonly tenants: number
  /** Stale reservations found (their demand done). */
  readonly stale: number
  readonly released: number
  readonly failed: number
}

/** Batches per tenant and night: 10 × 200 reservations; the rest waits for the next night (the run says so). */
const MAX_BATCHES = 10

/** One pass over every active tenant (the cron's tick; tests call it directly). */
export async function runReservationCleanup(options: CleanupOptions): Promise<CleanupRun> {
  const clock = options.clock ?? serverClock
  const settings = { ...COMMAND_SETTINGS, clock }
  const requestId = `reservations-cleanup-${newId()}`
  const totals = { stale: 0, released: 0, failed: 0 }
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    const seen = new Set<string>()
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const ids = (await caller.withClient((client) => staleReservationIds(client as unknown as Tx, MAX_SYSTEM_RELEASE + seen.size))).filter((id) => !seen.has(id)).slice(0, MAX_SYSTEM_RELEASE)
      if (ids.length === 0) break
      for (const id of ids) seen.add(id)
      totals.stale += ids.length
      try {
        const { result } = await runCommand(caller, { name: 'inventory.releaseReservationsBySystem', input: { cleanup: true, reservationIds: ids } }, async (tools) => releaseBySystemInCommand(tools, ids, 'NIGHTLY_CLEANUP'), settings)
        totals.released += result.length
      } catch (error) {
        totals.failed += ids.length
        options.log.error({ err: error, tenantId, reservations: ids.length }, 'stale reservations could not be released')
      }
    }
  }
  const run = { tenants: tenants.length, ...totals }
  if (run.stale > 0) options.log.info({ ...run }, 'reservation clean-up')
  return run
}

/** The scheduler's cron: every day at 02:40 (Europe/Rome), after the day's work orders closed. */
export function reservationCleanupCron(options: CleanupOptions): CronJob {
  return defineCron({
    name: 'inventory.reservationsCleanup',
    schedule: '40 2 * * *',
    async run() {
      await runReservationCleanup(options)
    },
  })
}

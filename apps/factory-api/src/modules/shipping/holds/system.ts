import type { FactoryClient } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { LIFT_WORDS, systemHoldPlan, type SystemHoldFacts, type SystemHoldPlan } from '@nexus/factory-domain/shipping/holds/system'
import { HOLDABLE_STATUSES } from '@nexus/factory-domain/shipping/holds/holds'
import type { FactoryDatabase } from '@nexus/factory-db'
import { callerFor, command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock } from '../../../core/time'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { holdsInForce as accountHoldsInForce } from '../../parties/holds/holds'
import { newestCheck, planCredit } from '../../sales/credit/check'
import { factsOf, lockShipmentRow, placeHoldInCommand, readHolds, releaseHoldInCommand, type LockedShipment } from './store'

/**
 * The holds the system places and lifts by itself (B-W2b-386; FIN-079, follow-up LQ1:01; rules factory-domain
 * shipping/holds/system): the balance before shipping, the customer's account on hold, over the credit limit. Run in the
 * tenant's system context (placedById / releasedById null) by
 *
 *   the handler `shipping.systemHolds`   on shipment.created (the new shipment), sales_order.schedule_changed (the order's
 *                                        open shipments: a before-shipping step made, paid, waived or cancelled),
 *                                        party.hold_placed / party.hold_released, credit_check.recorded and
 *                                        credit_limit.changed (the customer's open shipments)
 *   the cron `shipping.systemHolds`      every 30 minutes: every open shipment of every tenant (what moves a customer's
 *                                        credit without an event of its own, a payment or an invoice, and the shipments
 *                                        made before this step)
 *   the split (../split)                 the new shipment, in the split's own command
 *
 * The plan is read first without a command (nothing to change: no command, no audit row); then ONE command per batch
 * locks each shipment's row, reads again and writes what is still due.
 */

type Reader = FactoryClient | CommandTx

/** The open shipments (DRAFT or PACKED) these facts concern, at most `limit`. */
async function openShipmentIds(db: Reader, where: { readonly shipmentIds?: readonly string[]; readonly salesOrderId?: string; readonly partyId?: string }, limit = 500): Promise<string[]> {
  const rows = await db.shipment.findMany({
    where: {
      status: { in: [...HOLDABLE_STATUSES] },
      ...(where.shipmentIds ? { id: { in: where.shipmentIds.filter(isUuid) } } : {}),
      ...(where.salesOrderId ? { salesOrderId: where.salesOrderId } : {}),
      ...(where.partyId ? { partyId: where.partyId } : {}),
    },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: limit,
  })
  return rows.map((row) => row.id)
}

interface ShipmentFacts {
  readonly id: string
  readonly status: string
  readonly companyId: string
  readonly partyId: string
  readonly salesOrderId: string
}

/** What the system rules read for one shipment (the credit plan once per customer and company). */
async function factsFor(db: Reader, shipment: ShipmentFacts, now: Date, credit: Map<string, Promise<boolean>>): Promise<SystemHoldFacts> {
  const order = await db.salesOrder.findUnique({ where: { id: shipment.salesOrderId }, select: { number: true } })
  const party = await db.party.findUnique({ where: { id: shipment.partyId }, select: { code: true } })
  const balance = await db.salesOrderMilestone.findFirst({ where: { orderId: shipment.salesOrderId, kind: 'BEFORE_SHIPPING', status: 'OPEN' }, select: { createdAt: true }, orderBy: { createdAt: 'asc' } })
  const accountHolds = await accountHoldsInForce(db, shipment.partyId, shipment.companyId)
  const key = `${shipment.partyId}|${shipment.companyId}`
  if (!credit.has(key)) credit.set(key, planCredit(db, { step: 'SHIPMENT', partyId: shipment.partyId, companyId: shipment.companyId, now, askers: [] }).then((plan) => plan?.result === 'HOLD'))
  let creditHeld: SystemHoldFacts['creditHeld'] = null
  if (await credit.get(key)!) {
    // A yes given on this shipment's last HOLD lets it through (the leaving gate does the same).
    const last = await newestCheck(db, { step: 'SHIPMENT', recordType: 'Shipment', recordId: shipment.id, partyId: shipment.partyId })
    if (!last?.overridesCheckId) {
      const newest = await db.creditCheck.findFirst({ where: { partyId: shipment.partyId, companyId: shipment.companyId, result: 'HOLD' }, select: { checkedAt: true }, orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }] })
      creditHeld = { since: newest?.checkedAt ?? null }
    }
  }
  const holds = (await readHolds(db, [shipment.id])).map(factsOf)
  return {
    customerCode: party?.code ?? 'The customer',
    orderNumber: order?.number ?? '',
    balanceOpenSince: balance?.createdAt ?? null,
    accountHolds: accountHolds.map((hold) => ({ reason: hold.reason, placedAt: hold.placedAt })),
    creditHeld,
    holds,
  }
}

const isEmpty = (plan: SystemHoldPlan): boolean => plan.place.length === 0 && plan.lift.length === 0

/** Inside a command: each shipment locked, its system holds placed and lifted as its causes stand now. How many writes. */
export async function syncSystemHoldsInCommand(tools: CommandTools, shipmentIds: readonly string[]): Promise<{ placed: number; lifted: number }> {
  const credit = new Map<string, Promise<boolean>>()
  let placed = 0
  let lifted = 0
  for (const id of [...new Set(shipmentIds)].sort()) {
    const shipment: LockedShipment = await lockShipmentRow(tools.tx, id)
    if (!(HOLDABLE_STATUSES as readonly string[]).includes(shipment.status)) continue
    const plan = systemHoldPlan(await factsFor(tools.tx, shipment, tools.now, credit))
    for (const hold of plan.lift) {
      const row = (await readHolds(tools.tx, [shipment.id])).find((candidate) => candidate.id === hold.id)
      if (!row || row.releasedAt !== null) continue
      await releaseHoldInCommand(tools, shipment, row, { words: LIFT_WORDS[hold.reason], bySystem: true })
      lifted++
    }
    for (const hold of plan.place) {
      await placeHoldInCommand(tools, shipment, { reason: hold.reason, words: hold.words, bySystem: true })
      placed++
    }
  }
  return { placed, lifted }
}

/** The shipments among these whose system holds must change now (read without a command). */
async function shipmentsToSync(db: Reader, shipmentIds: readonly string[], now: Date): Promise<string[]> {
  if (shipmentIds.length === 0) return []
  const credit = new Map<string, Promise<boolean>>()
  const rows = await db.shipment.findMany({ where: { id: { in: [...shipmentIds] } }, select: { id: true, status: true, companyId: true, partyId: true, salesOrderId: true } })
  const due: string[] = []
  for (const row of rows) {
    if (!(HOLDABLE_STATUSES as readonly string[]).includes(row.status)) continue
    if (!isEmpty(systemHoldPlan(await factsFor(db, row, now, credit)))) due.push(row.id)
  }
  return due.sort()
}

const BATCH = 50

/** The system's work for some shipments, as the caller (the tenant's system), in commands of at most 50. */
export async function syncSystemHolds(caller: CommandCaller, shipmentIds: readonly string[], options: { readonly causationId?: string; readonly now?: Date } = {}): Promise<{ placed: number; lifted: number }> {
  const due = await caller.withClient((db) => shipmentsToSync(db, shipmentIds, options.now ?? serverClock.now()))
  const totals = { placed: 0, lifted: 0 }
  for (let start = 0; start < due.length; start += BATCH) {
    const batch = due.slice(start, start + BATCH)
    const { result } = await command(caller, { name: 'shipping.systemHolds', input: { shipmentIds: batch }, ...(options.causationId ? { causationId: options.causationId } : {}) }, async (tools) => {
      const done = await syncSystemHoldsInCommand(tools, batch)
      // Every command writes at least one audit row: a batch the plan found due but that changed meanwhile says so.
      if (done.placed + done.lifted === 0) tools.audit({ action: 'shipping.systemHoldsChecked', recordType: 'Shipment', recordId: batch[0]!, after: { shipmentIds: batch, changed: 0 } })
      return done
    })
    totals.placed += result.placed
    totals.lifted += result.lifted
  }
  return totals
}

interface EventFacts {
  readonly shipmentId?: unknown
  readonly orderId?: unknown
  readonly partyId?: unknown
}

/** The open shipments an event concerns. */
async function shipmentsOfEvent(db: Reader, type: string, payload: EventFacts): Promise<string[]> {
  if (type === 'shipment.created') return typeof payload.shipmentId === 'string' ? openShipmentIds(db, { shipmentIds: [payload.shipmentId] }) : []
  if (type === 'sales_order.schedule_changed') return typeof payload.orderId === 'string' && isUuid(payload.orderId) ? openShipmentIds(db, { salesOrderId: payload.orderId }) : []
  return typeof payload.partyId === 'string' && isUuid(payload.partyId) ? openShipmentIds(db, { partyId: payload.partyId }) : []
}

export const SYSTEM_HOLD_EVENTS = ['shipment.created', 'sales_order.schedule_changed', 'party.hold_placed', 'party.hold_released', 'credit_check.recorded', 'credit_limit.changed'] as const

export function systemHoldsHandler(): EventHandler {
  return defineHandler({
    name: 'shipping.systemHolds',
    events: [...SYSTEM_HOLD_EVENTS],
    attempts: 10,
    async handle(event, { caller }) {
      const ids = await caller.withClient((db) => shipmentsOfEvent(db, event.type, event.payload as EventFacts))
      if (ids.length > 0) await syncSystemHolds(caller, ids, { causationId: event.eventId })
    },
  })
}

export interface SystemHoldsSweepOptions {
  readonly database: FactoryDatabase
  readonly log: Log
}

/** One pass over every active tenant's open shipments (the cron's tick; tests call it directly). */
export async function runSystemHoldsSweep(options: SystemHoldsSweepOptions): Promise<{ tenants: number; placed: number; lifted: number; failed: number }> {
  const totals = { placed: 0, lifted: 0, failed: 0 }
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, `shipping-system-holds-${Date.now()}`))
    try {
      const ids = await caller.withClient((db) => openShipmentIds(db, {}, 2000))
      const done = await syncSystemHolds(caller, ids)
      totals.placed += done.placed
      totals.lifted += done.lifted
    } catch (error) {
      totals.failed++
      options.log.error({ err: error, tenantId }, 'shipment system holds could not be kept')
    }
  }
  const run = { tenants: tenants.length, ...totals }
  if (run.placed + run.lifted + run.failed > 0) options.log.info({ ...run }, 'shipment system holds')
  return run
}

/** The scheduler's cron: every 30 minutes. */
export function systemHoldsCron(options: SystemHoldsSweepOptions): CronJob {
  return defineCron({
    name: 'shipping.systemHolds',
    schedule: '*/30 * * * *',
    async run() {
      await runSystemHoldsSweep(options)
    },
  })
}

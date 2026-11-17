import type { FactoryClient } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { effectiveSupervisor, workOrderSupervisor, type EffectiveSupervisor, type SupervisorSource } from '@nexus/factory-domain/production-brand/supervisor'
import type { CommandTx } from '../../../core/command'

/**
 * B-PR-42a (production plan §3 "Supervisor", lead picks L21, L22; review fixes R-41, R-58, R-62): WHO supervises a record's
 * production — the one resolver B-PR-32 (notices to the supervisor first), B-PR-43a/b (Ask the supervisor, Needs an answer),
 * B-PR-45 (issues and escalation to the backup) and B-PR-42b (the follows) read, and the work order list and record show.
 *
 *   a sales order  its own supervisor (BrandOrderProduction.supervisorId, B-PR-15), else its customer's default
 *                  (PortalSettings.productionSupervisorId, B-PR-12); the backup is the customer's (an order has none)
 *   a work order   its order's when every cell comes from ONE sales order, else its customer's default (factory-domain
 *                  production-brand/supervisor workOrderSupervisor; computed, no column); a work order of no customer (a
 *                  sample of none, a mixed one made before the one-customer rule) has none
 *
 * Read in the caller's scope (the office's walled reads, or a job's system scope): it never checks who may know — the caller
 * shows the name only inside one record the reader may open (lists say Me / Someone else / Not set). A person made inactive
 * stays named (the record reads "no longer active"; B-PR-42a's routes give such a person no new assignment).
 *
 * The threads platform never imports this module (R-62): ./threads-hooks registers `supervisorOf` through the threads' own hooks
 * (T7 "Supervisor" first in a note's @ list, people-tags.ts; T8 a sales order's owner after the thread's own, owner.ts).
 */

export type Reader = FactoryClient | CommandTx

/** The production state row of an order (one per order: `brand-production:<salesOrderId>`, B-PR-15). */
export const brandProductionKey = (salesOrderId: string): string => `brand-production:${salesOrderId}`

/** A record's production supervisor: who (null: none), from where, the customer's backup, and the customer. */
export interface SupervisorOf extends EffectiveSupervisor {
  /** The customer's backup (L21, L24; null: none). */
  readonly backupId: string | null
  readonly partyId: string
}

/** Each customer's default supervisor and backup (PortalSettings: one row per party; no row: none). */
export async function customerDefaultsOf(db: Reader, partyIds: readonly string[]): Promise<Map<string, { readonly supervisorId: string | null; readonly backupId: string | null }>> {
  const wanted = [...new Set(partyIds)]
  if (wanted.length === 0) return new Map()
  const rows = await db.portalSettings.findMany({ where: { partyId: { in: wanted } }, select: { partyId: true, productionSupervisorId: true, productionBackupId: true } })
  return new Map(rows.map((row) => [row.partyId, { supervisorId: row.productionSupervisorId, backupId: row.productionBackupId }]))
}

/** Each order's own supervisor (its production state row; no row yet: none). */
export async function orderSupervisorsOf(db: Reader, salesOrderIds: readonly string[]): Promise<Map<string, string | null>> {
  const wanted = [...new Set(salesOrderIds)]
  if (wanted.length === 0) return new Map()
  const rows = await db.brandOrderProduction.findMany({ where: { key: { in: wanted.map(brandProductionKey) } }, select: { salesOrderId: true, supervisorId: true } })
  return new Map(rows.map((row) => [row.salesOrderId, row.supervisorId]))
}

/** A sales order's supervisor (null: no such order in the caller's scope). */
export async function supervisorOfOrder(db: Reader, salesOrderId: string): Promise<SupervisorOf | null> {
  if (!isUuid(salesOrderId)) return null
  const order = await db.salesOrder.findUnique({ where: { id: salesOrderId }, select: { id: true, partyId: true } })
  if (!order) return null
  const own = (await orderSupervisorsOf(db, [order.id])).get(order.id) ?? null
  const customer = (await customerDefaultsOf(db, [order.partyId])).get(order.partyId)
  return { ...effectiveSupervisor(own, customer?.supervisorId ?? null), backupId: customer?.backupId ?? null, partyId: order.partyId }
}

/** The sales orders a work order's cells make (each once; a SAMPLE cell may name no order line). */
export async function workOrderOrdersOf(db: Reader, workOrderId: string): Promise<string[]> {
  const cells = await db.workOrderSize.findMany({ where: { workOrderId }, select: { salesOrderLine: { select: { orderId: true } } } })
  return [...new Set(cells.flatMap((cell) => (cell.salesOrderLine ? [cell.salesOrderLine.orderId] : [])))]
}

/** A work order's supervisor (null: no such work order in the caller's scope, or one of no customer). */
export async function supervisorOfWorkOrder(db: Reader, workOrderId: string): Promise<SupervisorOf | null> {
  if (!isUuid(workOrderId)) return null
  const workOrder = await db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, partyId: true } })
  if (!workOrder || workOrder.partyId === null) return null
  const orderIds = await workOrderOrdersOf(db, workOrder.id)
  const own = await orderSupervisorsOf(db, orderIds)
  const customer = (await customerDefaultsOf(db, [workOrder.partyId])).get(workOrder.partyId)
  const supervisor = workOrderSupervisor({ orders: orderIds.map((salesOrderId) => ({ salesOrderId, supervisorId: own.get(salesOrderId) ?? null })), customerDefault: customer?.supervisorId ?? null })
  return { ...supervisor, backupId: customer?.backupId ?? null, partyId: workOrder.partyId }
}

/** The record types that have a production supervisor. */
export const SUPERVISED_RECORD_TYPES = ['SalesOrder', 'WorkOrder'] as const

/**
 * THE resolver (B-PR-32, B-PR-43a/b, B-PR-45, B-PR-42b; threads' T7 / T8 hooks): the production supervisor of a sales
 * order or a work order, with the customer's backup; null for any other record type, an unknown record or one of no customer.
 */
export async function supervisorOf(db: Reader, record: { readonly type: string; readonly id: string }): Promise<SupervisorOf | null> {
  if (record.type === 'SalesOrder') return supervisorOfOrder(db, record.id)
  if (record.type === 'WorkOrder') return supervisorOfWorkOrder(db, record.id)
  return null
}

/** A work order as the list reads it for its supervisor: its customer and the orders its cells make. */
export interface WorkOrderOrders {
  readonly id: string
  readonly partyId: string | null
  readonly orderIds: readonly string[]
}

/**
 * The supervisor of many work orders at once (the list, its "Mine" filter and tile): two reads, whatever the number of rows.
 * A work order of no customer maps to null (it shows no supervisor).
 */
export async function workOrderSupervisorsOf(db: Reader, rows: readonly WorkOrderOrders[]): Promise<Map<string, EffectiveSupervisor | null>> {
  const own = await orderSupervisorsOf(
    db,
    rows.filter((row) => row.partyId !== null).flatMap((row) => row.orderIds),
  )
  const defaults = await customerDefaultsOf(
    db,
    rows.flatMap((row) => (row.partyId !== null ? [row.partyId] : [])),
  )
  return new Map(
    rows.map((row): [string, EffectiveSupervisor | null] => [
      row.id,
      row.partyId === null ? null : workOrderSupervisor({ orders: row.orderIds.map((salesOrderId) => ({ salesOrderId, supervisorId: own.get(salesOrderId) ?? null })), customerDefault: defaults.get(row.partyId)?.supervisorId ?? null }),
    ]),
  )
}

/** The supervisor inside ONE work order the reader opened: the name (worker privacy: never on a list), and the reader's own muted follow. */
export interface RecordSupervisor {
  readonly supervisor: { readonly id: string; readonly name: string; readonly active: boolean; readonly from: SupervisorSource; readonly me: boolean } | null
  /**
   * Only for the supervisor himself (R-60, F-PR-21 "You muted this order"): true when he muted his follow of this work order's
   * thread or of its order's; null for anyone else (another person's follow is never told). Read only: B-PR-42b's worker makes
   * the follows, a muted one stays muted.
   */
  readonly youMuted: boolean | null
}

/** GET /production/work-orders/:workOrderId: the work order's supervisor by name, and the supervisor's own muted follow. */
export async function recordSupervisorOf(db: Reader, workOrder: { readonly id: string; readonly partyId: string | null }, viewerId: string): Promise<RecordSupervisor> {
  if (workOrder.partyId === null) return { supervisor: null, youMuted: null }
  const orderIds = await workOrderOrdersOf(db, workOrder.id)
  const own = await orderSupervisorsOf(db, orderIds)
  const customer = (await customerDefaultsOf(db, [workOrder.partyId])).get(workOrder.partyId)
  const found = workOrderSupervisor({ orders: orderIds.map((salesOrderId) => ({ salesOrderId, supervisorId: own.get(salesOrderId) ?? null })), customerDefault: customer?.supervisorId ?? null })
  if (found.userId === null || found.from === null) return { supervisor: null, youMuted: null }
  const user = await db.user.findUnique({ where: { id: found.userId }, select: { id: true, displayName: true, status: true } })
  const me = found.userId === viewerId
  const supervisor = { id: found.userId, name: user?.displayName ?? '', active: user?.status === 'ACTIVE', from: found.from, me }
  if (!me) return { supervisor, youMuted: null }
  const records = [{ recordType: 'WorkOrder', recordId: workOrder.id }, ...orderIds.map((recordId) => ({ recordType: 'SalesOrder', recordId }))]
  const muted = await db.recordFollower.findFirst({ where: { userId: viewerId, muted: true, OR: records }, select: { id: true } })
  return { supervisor, youMuted: muted !== null }
}

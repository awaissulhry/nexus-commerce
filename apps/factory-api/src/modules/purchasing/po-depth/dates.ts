import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { isBusinessDate, parseInstant } from '@nexus/factory-domain/core/time'
import type { PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { dateChangeProblems, firstDateProblem, lineDateOf, moveDateProblem, type DateSource } from '@nexus/factory-domain/purchasing/po-depth/dates'
import { PURCHASING_MANAGE } from '@nexus/factory-domain/purchasing/permissions'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { onOrder } from '../orders'
import { actorIdOf, dayOf, dayValue, LINE_COLUMNS, officeOrder, type LineRow, type OrderRow } from '../store'
import { depthOf, type DepthView } from './read'
import { DELIVERY_COLUMNS, type DeliveryRow } from './store'

/**
 * The supplier's days kept apart from the asked ones, every change a row (B-W2b-296; SCM-088; factory-db buying-depth.prisma
 * PoDateChange). ONE route, ONE command on the order (its version guards it; the order is not changed otherwise):
 *
 *   POST /purchasing/orders/:purchaseOrderId/lines/:lineId/supplier-date                                 purchasing.manage
 *        {version, deliveryId?, date, source, reason?, supplierContactName?, changedAt?}
 *
 *   FIRST   a delivery without a confirmed day takes the supplier's (while the order is SENT, CHANGES_PROPOSED or
 *           CONFIRMED): no history row (a first confirmation is no change); purchase_order.dates_confirmed.
 *   MOVED   a confirmed day (the line's own, for a line without deliveries; or a delivery's) moves while the order is open:
 *           the PoDateChange row (seq above the line's last, from the day it holds, who, when, why) and the day, together
 *           (the triggers refuse either alone); purchase_order.date_changed.
 *   follows a scheduled line's own confirmed day is its earliest delivery's: when a delivery's day makes that earliest day
 *           another one, the line's day moves too, with its own row (same who, when and why).
 *
 * The day asked (the line's need date, a delivery's day) never changes here. Refusals are in words before the database's.
 */

export interface SupplierDateBody {
  readonly version: number
  readonly deliveryId?: string | null | undefined
  readonly date: string
  readonly source: DateSource
  readonly reason?: string | null | undefined
  readonly supplierContactName?: string | null | undefined
  readonly changedAt?: string | null | undefined
}

const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

interface Move {
  readonly line: LineRow
  readonly delivery: DeliveryRow | null
  readonly fromDate: string
  readonly toDate: string
}

/** One row of the history and the day it moves, in the caller's command (the line's next place). */
async function recordMove(tools: CommandTools, order: OrderRow, move: Move, body: SupplierDateBody, changedAt: Date, reason: string): Promise<string> {
  const { tx } = tools
  const last = await tx.poDateChange.findFirst({ where: { purchaseOrderLineId: move.line.id }, orderBy: { seq: 'desc' }, select: { seq: true } })
  const id = newId()
  await tx.poDateChange.create({
    data: {
      id,
      purchaseOrderLineId: move.line.id,
      partyId: order.partyId,
      siteId: order.siteId,
      deliveryId: move.delivery?.id ?? null,
      seq: (last?.seq ?? 0) + 1,
      fromDate: dayValue(move.fromDate),
      toDate: dayValue(move.toDate),
      source: body.source,
      changedAt,
      supplierContactName: body.source === 'SUPPLIER' ? blank(body.supplierContactName) : null,
      reason,
      createdById: actorIdOf(tools),
    },
    select: { id: true },
  })
  if (move.delivery) await tx.purchaseOrderLineDelivery.update({ where: { id: move.delivery.id }, data: { confirmedDate: dayValue(move.toDate), version: { increment: 1 } }, select: { id: true } })
  else await tx.purchaseOrderLine.update({ where: { id: move.line.id }, data: { confirmedDate: dayValue(move.toDate), version: { increment: 1 } }, select: { id: true } })
  return id
}

/** purchasing.manage: the supplier's first day of a delivery, or a confirmed day moved with its row. */
export async function recordSupplierDate(caller: CommandCaller, orderId: string, lineId: string, body: SupplierDateBody, idempotencyKey?: string): Promise<{ depth: DepthView; recorded: 'FIRST' | 'MOVED'; dateChangeIds: string[] }> {
  const order = await officeOrder(caller, orderId, PURCHASING_MANAGE)
  return onOrder(caller, order, { name: 'purchasing.supplierDate', idempotencyKey, input: { orderId, lineId, ...body }, version: body.version }, async (tools, current) => {
    const { tx, now } = tools
    const status = current.status as PurchaseOrderStatus
    const line = isUuid(lineId) ? await tx.purchaseOrderLine.findUnique({ where: { id: lineId }, select: LINE_COLUMNS }) : null
    if (!line || line.purchaseOrderId !== current.id) throw new NotFoundError('Line not found.')
    if (line.cancelledAt !== null || line.closedShortAt !== null) throw new ConflictError(`Line ${line.seq} is ${line.cancelledAt ? 'cancelled' : 'closed short'}: its days move no more.`)
    if (!isBusinessDate(body.date)) throw new ValidationError('A day (YYYY-MM-DD).', [{ path: 'body/date', message: 'A day (YYYY-MM-DD).' }])
    const deliveries = await tx.purchaseOrderLineDelivery.findMany({ where: { purchaseOrderLineId: line.id }, select: DELIVERY_COLUMNS, orderBy: { seq: 'asc' } })
    const delivery = body.deliveryId ? (deliveries.find((row) => row.id === body.deliveryId) ?? null) : null
    if (body.deliveryId && !delivery) throw new NotFoundError('Delivery not found.')
    if (!delivery && deliveries.length > 0) throw new ConflictError(`Line ${line.seq} is split into ${deliveries.length} deliveries: its confirmed day is its earliest delivery's. Name the delivery whose day the supplier gave.`)
    const changedAt = body.changedAt ? parseInstant(body.changedAt)! : now
    const ids: string[] = []
    let recorded: 'FIRST' | 'MOVED'

    if (delivery && delivery.confirmedDate === null) {
      // FIRST: the supplier's day of a delivery (no history row: a first confirmation is no change).
      const problem = firstDateProblem(status)
      if (problem) throw new InvalidStateError(problem)
      await tx.purchaseOrderLineDelivery.update({ where: { id: delivery.id }, data: { confirmedDate: dayValue(body.date), version: { increment: 1 } }, select: { id: true } })
      recorded = 'FIRST'
      tools.audit({ action: 'purchasing.deliveryConfirmed', recordType: 'PurchaseOrder', recordId: current.id, companyId: current.companyId, siteId: current.siteId, after: { lineId: line.id, seq: line.seq, deliveryId: delivery.id, deliverySeq: delivery.seq, needDate: dayOf(delivery.needDate), confirmedDate: body.date, source: body.source } })
      tools.emit({ type: 'purchase_order.dates_confirmed', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { purchaseOrderId: current.id, number: current.number, lineId: line.id, deliveryIds: [delivery.id] } })
    } else {
      // MOVED: the line's own day (no schedule) or a delivery's, with its row.
      const problem = moveDateProblem(status)
      if (problem) throw new InvalidStateError(problem)
      const from = delivery ? dayOf(delivery.confirmedDate) : dayOf(line.confirmedDate)
      if (from === null) throw new InvalidStateError(`Line ${line.seq} has no confirmed day yet: the supplier confirms the order first (its link, the portal, or "Record a confirmation").`)
      const problems = dateChangeProblems(from, { toDate: body.date, source: body.source, reason: body.reason, supplierContactName: body.supplierContactName, changedAt }, now)
      if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
      ids.push(await recordMove(tools, current, { line, delivery, fromDate: from, toDate: body.date }, body, changedAt, blank(body.reason)!))
      recorded = 'MOVED'
    }

    // A scheduled line's own day follows its earliest delivery (once the line has one: the supplier confirmed it).
    if (delivery && line.confirmedDate !== null) {
      const after = await tx.purchaseOrderLineDelivery.findMany({ where: { purchaseOrderLineId: line.id }, select: { confirmedDate: true } })
      const earliest = lineDateOf(after.map((row) => ({ confirmedDate: dayOf(row.confirmedDate) })))
      const held = dayOf(line.confirmedDate)!
      if (earliest !== null && earliest !== held) {
        const why = blank(body.reason) ?? `The supplier gave delivery ${delivery.seq} the day ${body.date}.`
        ids.push(await recordMove(tools, current, { line, delivery: null, fromDate: held, toDate: earliest }, body, changedAt, `Follows its earliest delivery: ${why}`.slice(0, 2000)))
      }
    }
    if (ids.length > 0) {
      tools.audit({ action: 'purchasing.dateChanged', recordType: 'PurchaseOrder', recordId: current.id, companyId: current.companyId, siteId: current.siteId, ...(blank(body.reason) ? { reason: blank(body.reason)! } : {}), after: { lineId: line.id, seq: line.seq, deliveryId: delivery?.id ?? null, date: body.date, source: body.source, supplierContactName: blank(body.supplierContactName), changedAt: changedAt.toISOString(), dateChangeIds: ids } })
      tools.emit({ type: 'purchase_order.date_changed', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { purchaseOrderId: current.id, number: current.number, lineId: line.id, deliveryId: delivery?.id ?? null, dateChangeIds: ids, source: body.source } })
    }
    return { depth: await depthOf(tx, current.id), recorded, dateChangeIds: ids }
  })
}

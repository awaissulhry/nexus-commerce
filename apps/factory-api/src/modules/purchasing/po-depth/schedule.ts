import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { planSchedule, scheduleProblems, type DeliveryInput } from '@nexus/factory-domain/purchasing/po-depth/schedule'
import { PURCHASING_MANAGE } from '@nexus/factory-domain/purchasing/permissions'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { linesChanged } from '../lines'
import { assertDraft, onOrder } from '../orders'
import { actorIdOf, dayOf, dayValue, LINE_COLUMNS, officeOrder, quantityText, type LineRow, type OrderRow } from '../store'
import { depthOf, type DepthView } from './read'
import { readDeliveries } from './store'

/**
 * A delivery schedule per line (B-W2b-296; SCM-052; design purchasing.orders record tab "Delivery schedule"): a DRAFT
 * line split into deliveries, each a day asked and a quantity, written whole in ONE command on the order (its version
 * guards it); the rules are factory-domain purchasing/po-depth/schedule. The line's need date moves to the first
 * delivery's day; the order's total is unchanged (the line's quantity and price are), and its audit row and
 * purchase_order.lines_changed say a line changed. Clearing the schedule leaves one delivery on the line's need date.
 *
 *   PUT    /purchasing/orders/:purchaseOrderId/lines/:lineId/deliveries {version, deliveries[]}    purchasing.manage
 *   DELETE /purchasing/orders/:purchaseOrderId/lines/:lineId/deliveries?version=                  purchasing.manage
 */

export interface ScheduleBody {
  readonly version: number
  readonly deliveries: readonly DeliveryInput[]
}

const deliveriesAudit = (rows: readonly { readonly seq: number; readonly quantity: { toFixed(places: number): string }; readonly needDate: Date }[]) =>
  rows.map((row) => ({ seq: row.seq, quantity: quantityText(row.quantity), needDate: dayOf(row.needDate) }))

/** The order's live line, or a 404 / 409 in words. */
async function liveLineOf(tools: CommandTools, order: OrderRow, lineId: string): Promise<LineRow> {
  const line = isUuid(lineId) ? await tools.tx.purchaseOrderLine.findUnique({ where: { id: lineId }, select: LINE_COLUMNS }) : null
  if (!line || line.purchaseOrderId !== order.id) throw new NotFoundError('Line not found.')
  if (line.cancelledAt !== null) throw new ConflictError(`Line ${line.seq} is cancelled: it takes no delivery.`)
  return line
}

/** purchasing.manage: the line's deliveries, written whole (they replace the ones before). */
export async function putSchedule(caller: CommandCaller, orderId: string, lineId: string, body: ScheduleBody, idempotencyKey?: string): Promise<{ depth: DepthView }> {
  const order = await officeOrder(caller, orderId, PURCHASING_MANAGE)
  return onOrder(caller, order, { name: 'purchasing.schedule.set', idempotencyKey, input: { orderId, lineId, ...body }, version: body.version }, async (tools, current) => {
    assertDraft(current)
    const { tx } = tools
    const line = await liveLineOf(tools, current, lineId)
    const scheduled = { seq: line.seq, quantity: quantityText(line.quantity), baseQuantity: quantityText(line.baseQuantity) }
    const problems = scheduleProblems(scheduled, body.deliveries, businessDate(tools.now))
    if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
    const planned = planSchedule(scheduled, body.deliveries)
    const before = (await readDeliveries(tx, [line.id])).get(line.id) ?? []
    // The deliveries before go first: the place (seq) of each is unique per line.
    await tx.purchaseOrderLineDelivery.deleteMany({ where: { purchaseOrderLineId: line.id } })
    await tx.purchaseOrderLineDelivery.createMany({
      data: planned.map((delivery) => ({
        id: newId(),
        purchaseOrderLineId: line.id,
        partyId: current.partyId,
        siteId: current.siteId,
        seq: delivery.seq,
        quantity: delivery.quantity,
        baseQuantity: delivery.baseQuantity,
        needDate: dayValue(delivery.needDate),
        note: delivery.note,
        createdById: actorIdOf(tools),
      })),
    })
    const firstDay = planned[0]!.needDate
    const lineMoved = firstDay !== dayOf(line.needDate)
    if (lineMoved) await tx.purchaseOrderLine.update({ where: { id: line.id }, data: { needDate: dayValue(firstDay), version: { increment: 1 } }, select: { id: true } })
    await linesChanged(tools, current, { changed: 1 }, {
      action: 'purchasing.schedule.set',
      before: { lineId: line.id, seq: line.seq, needDate: dayOf(line.needDate), deliveries: deliveriesAudit(before) },
      after: { lineId: line.id, seq: line.seq, needDate: firstDay, deliveries: planned.map((delivery) => ({ seq: delivery.seq, quantity: delivery.quantity, needDate: delivery.needDate })) },
    })
    return { depth: await depthOf(tx, current.id) }
  })
}

/** purchasing.manage: the line back to one delivery on its need date. */
export async function clearSchedule(caller: CommandCaller, orderId: string, lineId: string, query: { readonly version: number }, idempotencyKey?: string): Promise<{ depth: DepthView }> {
  const order = await officeOrder(caller, orderId, PURCHASING_MANAGE)
  return onOrder(caller, order, { name: 'purchasing.schedule.clear', idempotencyKey, input: { orderId, lineId, ...query }, version: query.version }, async (tools, current) => {
    assertDraft(current)
    const { tx } = tools
    const line = await liveLineOf(tools, current, lineId)
    const before = (await readDeliveries(tx, [line.id])).get(line.id) ?? []
    if (before.length === 0) throw new ConflictError(`Line ${line.seq} has no delivery schedule: it is one delivery on ${dayOf(line.needDate)}.`)
    await tx.purchaseOrderLineDelivery.deleteMany({ where: { purchaseOrderLineId: line.id } })
    await linesChanged(tools, current, { changed: 1 }, { action: 'purchasing.schedule.clear', before: { lineId: line.id, seq: line.seq, deliveries: deliveriesAudit(before) }, after: { lineId: line.id, seq: line.seq, needDate: dayOf(line.needDate), deliveries: [] } })
    return { depth: await depthOf(tx, current.id) }
  })
}

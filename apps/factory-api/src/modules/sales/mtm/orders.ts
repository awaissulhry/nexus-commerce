import type { CommandTools } from '../../../core/command'
import { creditHoldOf, orderShapeOf, planOrderApproval } from '../orders-depth/approval'
import { waitsForMeasures } from './order-gate'

/**
 * The review's CONFIRM lets the orders go on that waited only for it (B-W2b-358; SAL-292; see ./order-gate.ts for how an order
 * with a made-to-measure unit comes to wait): in the review's command, every PENDING_APPROVAL order with a unit on that revision
 * that now waits for nothing else goes on (CONFIRMED and W1's sales_order.status_changed, which B-W2b-294's handler follows to
 * carry the delivery schedule): no other unit unconfirmed, no SALES_ORDER request pending, no credit HOLD standing, and no
 * SALES_ORDER rule holding on it without an APPROVED request.
 */

/** See the file's head. Returns the orders that went on. */
export async function ordersAfterReview(tools: CommandTools, profileId: string): Promise<{ id: string; number: string }[]> {
  const { tx, now } = tools
  const waiting = await tx.salesOrder.findMany({ where: { status: 'PENDING_APPROVAL', lines: { some: { kind: 'MADE_TO_MEASURE', measurementProfileId: profileId } } }, select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const gone: { id: string; number: string }[] = []
  for (const { id } of waiting) {
    await tx.$queryRaw`SELECT 1 FROM "SalesOrder" WHERE id = ${id}::uuid FOR UPDATE`
    const order = await tx.salesOrder.findUnique({ where: { id }, select: { id: true, number: true, status: true, companyId: true, partyId: true, currency: true, netAmount: true, priorityLevel: true, quoteVersionId: true } })
    if (!order || order.status !== 'PENDING_APPROVAL') continue
    if (await waitsForMeasures(tx, order.id)) continue
    const tasks = await tx.approvalTask.findMany({ where: { kind: 'SALES_ORDER', recordType: 'SalesOrder', recordId: order.id }, select: { status: true } })
    if (tasks.some((task) => task.status === 'PENDING')) continue
    if (await creditHoldOf(tx, order.id)) continue
    if (!tasks.some((task) => task.status === 'APPROVED')) {
      const plan = await planOrderApproval(tools, { companyId: order.companyId, shape: await orderShapeOf(tx, order), requesterId: null })
      if (plan.waits) continue
    }
    await tx.salesOrder.update({ where: { id: order.id }, data: { status: 'CONFIRMED', version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'mtm.orderGoesOn', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: { status: 'PENDING_APPROVAL' }, after: { status: 'CONFIRMED' }, reason: 'The factory confirmed the measures of its made-to-measure units.' })
    tools.emit({ type: 'sales_order.status_changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, from: 'PENDING_APPROVAL', to: 'CONFIRMED', by: 'person' } })
    gone.push({ id: order.id, number: order.number })
  }
  return gone
}

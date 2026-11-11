import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { ACCEPTED_PROOFS_ACTION, acceptedProofsOf, PROOF_RECORD_TYPE } from '@nexus/factory-domain/sales/quote-proofs/rules'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { assertMay, officeContextOf } from '../orders/access'
import type { Reader } from '../quotes/store'
import { officeWorkOrder } from '../../production/work-orders/work-orders'

/**
 * An accepted quote's proofs go with the order to its work orders (B-W2b-165; SAL-199): the order keeps the accepted
 * version (SalesOrder.quoteVersionId), a work order its order lines (WorkOrderSize.salesOrderLineId), so both read the
 * proofs the customer accepted — the acceptance's evidence (name, SHA-256, version), whose files the send keeps ten years
 * — and copy nothing. Office only; no money.
 *
 *   GET /sales/orders/:orderId/proofs                orders.view over the order's company and customer
 *   GET /production/work-orders/:workOrderId/proofs  workorders.view over the work order: one entry per order it makes
 */

interface OrderFacts {
  readonly id: string
  readonly number: string
  readonly quoteVersionId: string | null
}

/** Each order's quote and the proofs accepted with its version (none accepted through a link: null). */
async function acceptedOf(db: Reader, orders: readonly OrderFacts[]) {
  const versionIds = orders.flatMap((order) => (order.quoteVersionId ? [order.quoteVersionId] : []))
  const versions = versionIds.length > 0 ? await db.quoteVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, revision: true, quoteId: true } }) : []
  const quotes = versions.length > 0 ? await db.quote.findMany({ where: { id: { in: versions.map((version) => version.quoteId) } }, select: { id: true, number: true } }) : []
  const acceptances = versionIds.length > 0 ? await db.quoteAcceptance.findMany({ where: { versionId: { in: versionIds } }, select: { id: true, versionId: true, signerName: true, acceptedAt: true } }) : []
  const evidence = acceptances.length > 0 ? await db.auditLog.findMany({ where: { recordType: PROOF_RECORD_TYPE, recordId: { in: versionIds }, action: ACCEPTED_PROOFS_ACTION }, select: { recordId: true, after: true } }) : []
  return orders.map((order) => {
    const version = versions.find((row) => row.id === order.quoteVersionId) ?? null
    const quote = version ? (quotes.find((row) => row.id === version.quoteId) ?? null) : null
    const acceptance = version ? (acceptances.find((row) => row.versionId === version.id) ?? null) : null
    const trail = acceptance ? evidence.find((row) => row.recordId === acceptance.versionId && (row.after as { acceptanceId?: unknown } | null)?.acceptanceId === acceptance.id) : undefined
    return {
      orderId: order.id,
      number: order.number,
      quoteId: quote?.id ?? null,
      quoteNumber: quote?.number ?? null,
      revision: version?.revision ?? null,
      accepted: acceptance ? { acceptanceId: acceptance.id, signerName: acceptance.signerName, acceptedAt: toUtcIso(acceptance.acceptedAt), proofs: acceptedProofsOf(trail?.after ?? null) } : null,
    }
  })
}

/** GET /sales/orders/:orderId/proofs */
export async function orderProofs(caller: CommandCaller, orderId: string) {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const order = isUuid(orderId) ? await client.salesOrder.findUnique({ where: { id: orderId }, select: { id: true, companyId: true, partyId: true, number: true, quoteVersionId: true } }) : null
    assertMay(context, ORDERS_VIEW, order)
    return (await acceptedOf(client, [order]))[0]!
  })
}

/** GET /production/work-orders/:workOrderId/proofs */
export async function workOrderProofs(caller: CommandCaller, workOrderId: string) {
  const workOrder = await officeWorkOrder(caller, workOrderId)
  return caller.withClient(async (client) => {
    const sizes = await client.workOrderSize.findMany({ where: { workOrderId: workOrder.id }, select: { salesOrderLineId: true } })
    // B-W2b-275: a SAMPLE cell may name no order line.
    const lineIds = [...new Set(sizes.flatMap((size) => (size.salesOrderLineId === null ? [] : [size.salesOrderLineId])))]
    const lines = lineIds.length > 0 ? await client.salesOrderLine.findMany({ where: { id: { in: lineIds } }, select: { orderId: true } }) : []
    const orderIds = [...new Set(lines.map((line) => line.orderId))]
    const orders = orderIds.length > 0 ? await client.salesOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true, quoteVersionId: true }, orderBy: { number: 'asc' } }) : []
    return { workOrderId: workOrder.id, orders: await acceptedOf(client, orders) }
  })
}

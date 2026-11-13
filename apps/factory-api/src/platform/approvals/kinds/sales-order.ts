import { fromMinorUnits } from '@nexus/factory-domain/core/money'
import { SALES_ORDER_CHANGES, SALES_ORDER_FIELDS, salesOrderFacts } from '@nexus/factory-domain/sales/orders-depth/rules'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandTools, CommandTx } from '../../../core/command'
// B-W2b-303: what the order does with the decision (CONFIRMED with the yes; CANCELLED with the no).
import { approvedInCommand, orderShapeOf, rejectedInCommand, SUBJECT_COLUMNS } from '../../../modules/sales/orders-depth/approval'
import type { ApprovalKindDefinition, ApprovalSubject, Reader, TaskRef } from './kind'

/**
 * SALES_ORDER (B-W2b-303; SAL-205; plan "An order that breaks a SALES_ORDER rule waits as PENDING_APPROVAL and goes on with the
 * yes"): a sales order made but waiting for a yes before it goes on. The order is INSERTED waiting (B-W2b-281: nothing moves
 * into PENDING_APPROVAL later) by every path that makes an order — an accepted quote, an office order, an imported sheet, a
 * portal request taken — when a rule of the company holds on its facts (modules/sales/orders-depth/approval.ts), and the
 * request is asked in the same command. A request asked from the generic route (POST /approvals/requests) is about a waiting
 * order with no request standing (orders.manage).
 *
 * The facts its rules test: the order's value (net, the price grain), its discount off the list (the lines' waterfalls), lines,
 * pieces, the customer's code, the currency, the priority, whether it came from a quote (factory-domain sales/orders-depth). The
 * fingerprint covers the order as it would go on: its header (customer, currency, totals, priority, PO number, promise date,
 * delivery address, season) and every line with its sizes and prices — a line changed while waiting makes the request STALE.
 * The yes: CONFIRMED (unless its credit HOLD still stands, B-W2b-304: it keeps waiting for that); the no: CANCELLED with the
 * approver's reason (W1's cancel).
 */

const HELD_GONE_ON = (number: string, status: string) => `${number} is ${status}: a yes is asked only while an order waits for one.`

async function readSubject(client: Reader, orderId: string): Promise<ApprovalSubject | null> {
  const order = await client.salesOrder.findUnique({ where: { id: orderId }, select: SUBJECT_COLUMNS })
  if (!order) return null
  const lines = await client.salesOrderLine.findMany({ where: { orderId }, orderBy: [{ seq: 'asc' }, { id: 'asc' }], select: { id: true, seq: true, kind: true, styleId: true, colourwayId: true, quantity: true, unitPrice: true, netAmount: true, priceSteps: true } })
  const sizes = lines.length === 0 ? [] : await client.salesOrderLineSize.findMany({ where: { lineId: { in: lines.map((line) => line.id) } }, orderBy: [{ lineId: 'asc' }, { size: 'asc' }], select: { lineId: true, size: true, quantity: true, unitPrice: true } })
  const party = await client.party.findUnique({ where: { id: order.partyId }, select: { code: true, legalName: true } })
  const shape = await orderShapeOf(client, order)
  const pieces = lines.filter((line) => line.kind !== 'FEE').reduce((sum, line) => sum + line.quantity, 0)
  const customer = party?.legalName ?? 'customer'
  return {
    companyId: order.companyId,
    siteId: null,
    label: `${order.number} · ${customer}`,
    summary: `${order.number} for ${customer}: ${lines.length === 1 ? '1 line' : `${lines.length} lines`}, ${pieces} pieces, waits for a yes before it goes on`.slice(0, 500),
    facts: salesOrderFacts(shape),
    snapshot: {
      number: order.number,
      stage: order.status === 'PENDING_APPROVAL' ? 'WAITING' : order.status,
      partyId: order.partyId,
      currency: order.currency,
      netAmount: fromMinorUnits(order.netAmount, order.currency).toFixed(),
      grossAmount: fromMinorUnits(order.grossAmount, order.currency).toFixed(),
      priorityLevel: order.priorityLevel,
      urgentReason: order.urgentReason,
      customerRef: order.customerRef,
      promiseDate: order.promiseDate ? order.promiseDate.toISOString().slice(0, 10) : null,
      shipTo: order.shipTo,
      seasonId: order.seasonId,
      lines: lines.map((line) => ({
        seq: line.seq,
        kind: line.kind,
        styleId: line.styleId,
        colourwayId: line.colourwayId,
        quantity: line.quantity,
        unitPrice: line.unitPrice.toString(),
        netAmount: line.netAmount,
        sizes: sizes.filter((size) => size.lineId === line.id).map((size) => ({ size: size.size, quantity: size.quantity, unitPrice: size.unitPrice === null ? null : size.unitPrice.toString() })),
      })),
    },
    changes: [...SALES_ORDER_CHANGES],
    held: order.status === 'PENDING_APPROVAL' ? null : HELD_GONE_ON(order.number, order.status),
  }
}

export const SALES_ORDER_KIND: ApprovalKindDefinition = Object.freeze({
  kind: 'SALES_ORDER',
  recordType: 'SalesOrder',
  label: { en: 'Sales order', it: 'Ordine di vendita' },
  view: ORDERS_VIEW,
  ask: ORDERS_MANAGE,
  fields: SALES_ORDER_FIELDS,
  read: readSubject,
  async lock(tx: CommandTx, recordId: string) {
    await tx.$queryRaw`SELECT 1 FROM "SalesOrder" WHERE id = ${recordId}::uuid FOR UPDATE`
  },
  async recent(client: Reader, companyId: string | null, limit: number) {
    const rows = await client.salesOrder.findMany({ where: companyId ? { companyId } : {}, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, select: { id: true } })
    return rows.map((row) => row.id)
  },
  onApproved: (tools: CommandTools, task: TaskRef) => approvedInCommand(tools, task),
  onRejected: (tools: CommandTools, task: TaskRef) => rejectedInCommand(tools, task),
})

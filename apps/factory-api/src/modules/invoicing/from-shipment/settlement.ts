import { isUuid } from '@nexus/factory-domain/core/ids'
import { orderSettlement, type OrderSettlement, type SettlementFacts } from '@nexus/factory-domain/invoicing/from-shipment/settlement'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { assertMay, officeContextOf, type Reader } from '../store'
import { lockInvoicing } from './locks'

/**
 * The order's settlement (B-W1-51; PLAN §4.7 "Closing the order"): the port B-W1-25's close command asks ("is every line
 * shipped, invoiced and paid?" = `settlementOf(db, orderId).settlement.settled`), the office's view of it, and the events
 * that say when it changes.
 *
 * Settled is not stored (no schema change in W1). Every command that may change it ends with `settleOrders`: under the
 * orders' 'order' locks, taken last, it compares the settled state now with what the order's audit trail last announced,
 * and on a change writes the audit row and emits `order.fully_settled` or `order.unsettled` (with what is missing), once.
 * Called by: a payment allocated or taken back (payments.ts, deposits.ts), an invoice issued (issue.ts: a TD04 or a new
 * invoice unsettles), an SDI outcome (sdi/record.ts syncInvoice notes the orders, `noteOrders`; the poll, the webhook and
 * the send result settle them at their end, `settleNoted`, after every invoice row they lock: settled only when every
 * document is DELIVERED or NOT_DELIVERABLE). Shipping and order amendments do not call it (their modules); the next call
 * announces their effect, and the close command asks the port anyway.
 */

const SHIPPED = ['SHIPPED', 'DELIVERED'] as const

export interface OrderSettlementOf {
  readonly orderId: string
  readonly number: string
  readonly companyId: string
  readonly partyId: string
  readonly settlement: OrderSettlement
}

/** The facts of an order's settlement, read now. Null: not found (or out of the reader's tenant). */
export async function settlementOf(db: Reader, orderId: string): Promise<OrderSettlementOf | null> {
  if (!isUuid(orderId)) return null
  const order = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: { id: true, number: true, status: true, currency: true, companyId: true, partyId: true, lines: { select: { id: true, seq: true, quantity: true, description: true, sizes: { select: { size: true, quantity: true } } } } },
  })
  if (!order) return null
  const lineIds = order.lines.map((line) => line.id)
  const shipped = await db.shipmentLine.findMany({ where: { salesOrderLineId: { in: lineIds }, shipment: { status: { in: [...SHIPPED] } } }, select: { salesOrderLineId: true, size: true, quantity: true } })
  const billed = await db.invoiceLine.findMany({
    where: { salesOrderLineId: { in: lineIds }, kind: 'GOODS', invoice: { docType: { in: ['TD01', 'TD24'] }, status: { not: 'DRAFT' } } },
    select: { salesOrderLineId: true, size: true, quantity: true },
  })
  const invoices = await db.invoice.findMany({
    where: { docType: { in: ['TD01', 'TD24'] }, status: { not: 'DRAFT' }, OR: [{ salesOrderId: order.id }, { lines: { some: { salesOrderLineId: { in: lineIds } } } }] },
    select: { id: true, docType: true, number: true, status: true, grossTotal: true },
    orderBy: { id: 'asc' },
  })
  const requests = await db.depositRequest.findMany({ where: { orderId: order.id }, select: { id: true, status: true, fiscalDocument: true, amount: true } })
  const deposits = await db.invoice.findMany({
    where: { docType: 'TD02', status: { not: 'DRAFT' }, OR: [{ salesOrderId: order.id }, ...(requests.length > 0 ? [{ depositRequestId: { in: requests.map((request) => request.id) } }] : [])] },
    select: { id: true, depositRequestId: true, number: true, status: true, netTotal: true, grossTotal: true },
    orderBy: { id: 'asc' },
  })
  const credited = [...invoices, ...deposits].map((invoice) => invoice.id)
  const credits = credited.length > 0 ? await db.invoice.findMany({ where: { creditOfId: { in: credited }, docType: 'TD04', status: { not: 'DRAFT' } }, select: { id: true, number: true, status: true, creditOfId: true, netTotal: true, grossTotal: true } }) : []
  const allocations = await db.paymentAllocation.findMany({
    where: { OR: [...(invoices.length > 0 ? [{ invoiceId: { in: invoices.map((invoice) => invoice.id) } }] : []), ...(requests.length > 0 ? [{ depositRequestId: { in: requests.map((request) => request.id) } }] : [])] },
    select: { invoiceId: true, depositRequestId: true, amount: true },
  })
  const deductions = deposits.length > 0 ? await db.invoiceLine.findMany({ where: { depositInvoiceId: { in: deposits.map((deposit) => deposit.id) }, invoice: { status: { not: 'DRAFT' } } }, select: { depositInvoiceId: true, netAmount: true } }) : []
  const sum = <T>(rows: readonly T[], value: (row: T) => number) => rows.reduce((total, row) => total + value(row), 0)

  const facts: SettlementFacts = {
    order: { id: order.id, number: order.number, status: order.status, currency: order.currency },
    lines: order.lines.map((line) => ({
      salesOrderLineId: line.id,
      seq: line.seq,
      description: line.description ?? `line ${line.seq}`,
      sizes: line.sizes.length > 0 ? line.sizes.map((size) => ({ size: size.size, ordered: size.quantity })) : [{ size: null, ordered: line.quantity }],
    })),
    shipped: shipped.map((row) => ({ salesOrderLineId: row.salesOrderLineId, size: row.size, quantity: row.quantity })),
    invoiced: billed.map((row) => ({ salesOrderLineId: row.salesOrderLineId!, size: row.size, quantity: row.quantity.toFixed(4) })),
    invoices: invoices.map((invoice) => ({
      id: invoice.id,
      docType: invoice.docType,
      number: invoice.number,
      status: invoice.status,
      grossTotal: invoice.grossTotal,
      creditedGross: sum(credits.filter((credit) => credit.creditOfId === invoice.id), (credit) => credit.grossTotal),
      paid: sum(allocations.filter((row) => row.invoiceId === invoice.id), (row) => row.amount),
    })),
    depositRequests: requests.map((request) => ({ id: request.id, status: request.status, fiscalDocument: request.fiscalDocument, amount: request.amount, paid: sum(allocations.filter((row) => row.depositRequestId === request.id), (row) => row.amount) })),
    depositInvoices: deposits.map((deposit) => ({
      id: deposit.id,
      depositRequestId: deposit.depositRequestId ?? '',
      number: deposit.number,
      status: deposit.status,
      netTotal: deposit.netTotal,
      grossTotal: deposit.grossTotal,
      creditedNet: sum(credits.filter((credit) => credit.creditOfId === deposit.id), (credit) => credit.netTotal),
      creditedGross: sum(credits.filter((credit) => credit.creditOfId === deposit.id), (credit) => credit.grossTotal),
      deductedNet: -sum(deductions.filter((line) => line.depositInvoiceId === deposit.id), (line) => line.netAmount),
    })),
    creditNotes: credits.map((credit) => ({ id: credit.id, number: credit.number, status: credit.status, creditOfId: credit.creditOfId! })),
  }
  return { orderId: order.id, number: order.number, companyId: order.companyId, partyId: order.partyId, settlement: orderSettlement(facts) }
}

/** The orders an invoice is about: its order, its lines' orders, a TD02's request's order, a TD04's credited invoice's. */
export async function ordersOfInvoices(db: Reader, invoiceIds: readonly string[]): Promise<string[]> {
  const orders = new Set<string>()
  let ids = [...new Set(invoiceIds)]
  for (let depth = 0; depth < 2 && ids.length > 0; depth++) {
    const rows = await db.invoice.findMany({ where: { id: { in: ids } }, select: { salesOrderId: true, creditOfId: true, depositRequest: { select: { orderId: true } } } })
    const lines = await db.invoiceLine.findMany({ where: { invoiceId: { in: ids }, salesOrderLineId: { not: null } }, select: { salesOrderLine: { select: { orderId: true } } } })
    for (const row of rows) {
      if (row.salesOrderId) orders.add(row.salesOrderId)
      if (row.depositRequest?.orderId) orders.add(row.depositRequest.orderId)
    }
    for (const line of lines) if (line.salesOrderLine) orders.add(line.salesOrderLine.orderId)
    ids = rows.flatMap((row) => (row.creditOfId ? [row.creditOfId] : []))
  }
  return [...orders]
}

/** The orders of deposit requests. */
export async function ordersOfRequests(db: Reader, requestIds: readonly string[]): Promise<string[]> {
  if (requestIds.length === 0) return []
  const rows = await db.depositRequest.findMany({ where: { id: { in: [...requestIds] } }, select: { orderId: true } })
  return [...new Set(rows.flatMap((row) => (row.orderId ? [row.orderId] : [])))]
}

type SettleTools = Pick<CommandTools, 'tx' | 'context' | 'audit' | 'emit'>

export const ORDER_SETTLED = 'invoices.orderSettled'
export const ORDER_UNSETTLED = 'invoices.orderUnsettled'

/** What each running command announced already (deposit received allocates, then issues: one command, two calls). */
const announcedIn = new WeakMap<object, Map<string, boolean>>()

/**
 * Whether the order was last announced settled: its newest settlement audit row (ids are time-ordered UUIDv7, written
 * while the order's lock is held, so they follow the announcements' order). None: never settled.
 */
async function lastAnnounced(db: Reader, orderId: string): Promise<boolean> {
  const row = await db.auditLog.findFirst({ where: { recordType: 'SalesOrder', recordId: orderId, action: { in: [ORDER_SETTLED, ORDER_UNSETTLED] } }, orderBy: { id: 'desc' }, select: { action: true } })
  return row?.action === ORDER_SETTLED
}

/**
 * At the END of a command's work, after all of its writes: takes the orders' locks (the command's last locks, id order)
 * and, for each order whose settled state now differs from what was last announced (its audit trail), records it (an
 * audit row on the SalesOrder) and emits `order.fully_settled` or `order.unsettled`. Two commands that complete an order
 * at once queue on its lock: the second sees the first's change and announcement. Nothing waits for another lock after
 * these, so no lock cycle can form; a change made by a command that does not call it (shipping, an order amendment) is
 * announced by the next one that does.
 */
export async function settleOrders(tools: SettleTools, orderIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(orderIds)].sort()
  if (ids.length === 0) return
  await lockInvoicing(tools.tx, tools.context, 'order', ids)
  const announced = announcedIn.get(tools) ?? new Map<string, boolean>()
  announcedIn.set(tools, announced)
  for (const id of ids) {
    const now = await settlementOf(tools.tx, id)
    if (!now) continue
    const last = announced.get(id) ?? (await lastAnnounced(tools.tx, id))
    if (now.settlement.settled === last) continue
    announced.set(id, now.settlement.settled)
    const missing = now.settlement.missing.map((gap) => gap.code)
    tools.audit({
      action: now.settlement.settled ? ORDER_SETTLED : ORDER_UNSETTLED,
      recordType: 'SalesOrder',
      recordId: id,
      companyId: now.companyId,
      before: { settled: last },
      after: { settled: now.settlement.settled, missing, balanceDue: markMoney('price', now.settlement.money.balanceDue), refundDue: markMoney('price', now.settlement.money.refundDue) },
    })
    if (now.settlement.settled) tools.emit({ type: 'order.fully_settled', subject: id, companyId: now.companyId, payload: { orderId: id, partyId: now.partyId } })
    else tools.emit({ type: 'order.unsettled', subject: id, companyId: now.companyId, payload: { orderId: id, partyId: now.partyId, missing } })
  }
}

/** Orders a command will settle at its end (an SDI command applies several sends' messages, each under its invoice's row). */
const notedIn = new WeakMap<object, Set<string>>()

/** Notes orders to settle at the end of the command (settleNoted), without taking their locks now. */
export function noteOrders(tools: object, orderIds: Iterable<string>): void {
  const noted = notedIn.get(tools) ?? new Set<string>()
  for (const id of orderIds) noted.add(id)
  notedIn.set(tools, noted)
}

/** At the end of a command's work: settles the orders noted (settleOrders). */
export async function settleNoted(tools: SettleTools): Promise<void> {
  const noted = notedIn.get(tools)
  if (!noted || noted.size === 0) return
  notedIn.delete(tools)
  await settleOrders(tools, noted)
}

/** invoices.view (A2 SCR-081 "Deposits & payments", SCR-082): the order's settlement, money with the price grain. */
export async function getSettlement(caller: CommandCaller, orderId: string) {
  const context = officeContextOf(caller)
  const found = await caller.withClient((client) => settlementOf(client, orderId))
  assertMay(context, INVOICES_VIEW, INVOICES_VIEW, found ? { companyId: found.companyId, partyId: found.partyId } : null, 'Order')
  const { settlement } = found!
  return {
    settlement: {
      orderId: found!.orderId,
      number: found!.number,
      settled: settlement.settled,
      gaps: settlement.missing.map((gap) => gap.code),
      // The words may name amounts: with the price grain only.
      missing: asMoney('price', [...settlement.missing]),
      fullyShipped: settlement.fullyShipped,
      fullyInvoiced: settlement.fullyInvoiced,
      documentsFinal: settlement.documentsFinal,
      lines: [...settlement.lines],
      invoices: settlement.invoices.map((invoice) => ({
        id: invoice.id,
        docType: invoice.docType,
        number: invoice.number,
        status: invoice.status,
        grossTotal: asMoney('price', invoice.grossTotal),
        creditedAmount: asMoney('price', invoice.creditedGross),
        paidAmount: asMoney('price', invoice.paid),
        openAmount: asMoney('price', invoice.open),
        refundDueAmount: asMoney('price', invoice.refundDue),
      })),
      invoicedAmount: asMoney('price', settlement.money.invoicedGross),
      creditedAmount: asMoney('price', settlement.money.creditedGross),
      paidAmount: asMoney('price', settlement.money.paidOnInvoices),
      depositsPaidWithoutInvoiceAmount: asMoney('price', settlement.money.depositsPaidWithoutInvoice),
      balanceDueAmount: asMoney('price', settlement.money.balanceDue),
      refundDueAmount: asMoney('price', settlement.money.refundDue),
    },
  }
}

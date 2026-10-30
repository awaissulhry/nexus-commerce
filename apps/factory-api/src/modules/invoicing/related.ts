import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { CommandCaller } from '../../core/command'
import { officeInvoice, readLines, type Reader } from './store'

/**
 * What an invoice record shows beside its own rows (A2 SCR-081: the DDTs it cites, "Deposits & payments", the credit
 * notes, the Documents tab): the DDTs its lines name, the deposit invoices (TD02) its deduction lines subtract, the
 * invoice it credits (a TD04), its credit notes, the payments placed on it (with the reversals), and the deposit
 * requests of its orders with what is paid on each and the TD02 that followed. Every record named here is of the
 * invoice's own company and customer (the database's keys hold that), so seeing the invoice is enough to see them.
 * Amounts only with money.price (the contract marks them).
 */

const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)

export async function invoiceRelated(caller: CommandCaller, invoiceId: string) {
  const invoice = await officeInvoice(caller, invoiceId)
  return caller.withClient(async (client) => ({ related: await relatedOf(client, invoice) }))
}

async function relatedOf(db: Reader, invoice: { id: string; creditOfId: string | null; salesOrderId: string | null }) {
  const lines = await readLines(db, invoice.id)
  const ddtIds = [...new Set(lines.flatMap((line) => (line.ddtId ? [line.ddtId] : [])))]
  const depositInvoiceIds = [...new Set(lines.flatMap((line) => (line.depositInvoiceId ? [line.depositInvoiceId] : [])))]
  const orderLineIds = [...new Set(lines.flatMap((line) => (line.salesOrderLineId ? [line.salesOrderLineId] : [])))]

  // A shipment's DDTs (an invoice bills goods shipped; a DDT for another reason, W2a wave 6/7, is B-W2a-54's to show).
  const ddts = ddtIds.length === 0 ? [] : await db.ddt.findMany({ where: { id: { in: ddtIds }, shipmentId: { not: null } }, select: { id: true, number: true, documentDate: true, shipmentId: true, shipment: { select: { number: true } } }, orderBy: [{ documentDate: 'asc' }, { number: 'asc' }] })
  const deposits = depositInvoiceIds.length === 0 ? [] : await db.invoice.findMany({ where: { id: { in: depositInvoiceIds } }, select: { id: true, number: true, issueDate: true, status: true, depositRequestId: true }, orderBy: { issueDate: 'asc' } })
  const creditOf = invoice.creditOfId ? await db.invoice.findUnique({ where: { id: invoice.creditOfId }, select: { id: true, docType: true, number: true, issueDate: true, status: true } }) : null
  const creditNotes = await db.invoice.findMany({ where: { creditOfId: invoice.id, docType: 'TD04' }, select: { id: true, number: true, issueDate: true, status: true, grossTotal: true }, orderBy: { createdAt: 'asc' } })
  const allocations = await db.paymentAllocation.findMany({
    where: { invoiceId: invoice.id },
    select: { id: true, amount: true, reversalOfId: true, note: true, createdAt: true, payment: { select: { id: true, externalRef: true, receivedOn: true, status: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const reversed = new Set(allocations.flatMap((row) => (row.reversalOfId ? [row.reversalOfId] : [])))

  const lineOrders = orderLineIds.length === 0 ? [] : await db.salesOrderLine.findMany({ where: { id: { in: orderLineIds } }, select: { orderId: true } })
  const orderIds = [...new Set([...(invoice.salesOrderId ? [invoice.salesOrderId] : []), ...lineOrders.map((line) => line.orderId)])]
  const orders = orderIds.length === 0 ? [] : await db.salesOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true }, orderBy: { number: 'asc' } })
  const requests = orderIds.length === 0 ? [] : await db.depositRequest.findMany({ where: { orderId: { in: orderIds } }, select: { id: true, orderId: true, kind: true, depositPct: true, currency: true, amount: true, dueDate: true, fiscalDocument: true, status: true, paidAt: true }, orderBy: { createdAt: 'asc' } })
  const requestIds = requests.map((request) => request.id)
  const paidOn = requestIds.length === 0 ? [] : await db.paymentAllocation.groupBy({ by: ['depositRequestId'], where: { depositRequestId: { in: requestIds } }, _sum: { amount: true } })
  const td02s = requestIds.length === 0 ? [] : await db.invoice.findMany({ where: { depositRequestId: { in: requestIds }, docType: 'TD02' }, select: { id: true, number: true, status: true, issueDate: true, depositRequestId: true }, orderBy: { createdAt: 'asc' } })

  return {
    ddts: ddts.map((ddt) => ({ id: ddt.id, number: ddt.number, date: day(ddt.documentDate)!, shipmentId: ddt.shipmentId!, shipmentNumber: ddt.shipment!.number })),
    depositInvoices: deposits.map((deposit) => ({ id: deposit.id, number: deposit.number, issueDate: day(deposit.issueDate), status: deposit.status, depositRequestId: deposit.depositRequestId })),
    creditOf: creditOf ? { id: creditOf.id, docType: creditOf.docType, number: creditOf.number, issueDate: day(creditOf.issueDate), status: creditOf.status } : null,
    creditNotes: creditNotes.map((note) => ({ id: note.id, number: note.number, issueDate: day(note.issueDate), status: note.status, grossTotal: asMoney('price', note.grossTotal) })),
    payments: allocations.map((row) => ({
      allocationId: row.id,
      paymentId: row.payment.id,
      externalRef: row.payment.externalRef,
      receivedOn: day(row.payment.receivedOn)!,
      paymentStatus: row.payment.status,
      amount: asMoney('price', row.amount),
      reversalOfId: row.reversalOfId,
      reversed: reversed.has(row.id),
      note: row.note,
      createdAt: toUtcIso(row.createdAt),
    })),
    orders: orders.map((order) => ({ id: order.id, number: order.number })),
    depositRequests: requests.map((request) => ({
      id: request.id,
      orderId: request.orderId,
      kind: request.kind,
      depositPct: request.depositPct === null ? null : request.depositPct.toFixed(4).replace(/\.?0+$/, ''),
      currency: request.currency,
      amount: asMoney('price', request.amount),
      paidAmount: asMoney('price', paidOn.find((entry) => entry.depositRequestId === request.id)?._sum.amount ?? 0),
      dueDate: day(request.dueDate)!,
      fiscalDocument: request.fiscalDocument,
      status: request.status,
      paidAt: request.paidAt ? toUtcIso(request.paidAt) : null,
      depositInvoices: td02s.filter((td02) => td02.depositRequestId === request.id).map((td02) => ({ id: td02.id, number: td02.number, status: td02.status, issueDate: day(td02.issueDate) })),
    })),
  }
}

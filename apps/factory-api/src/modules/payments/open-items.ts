import { PAYMENTS_VIEW } from '@nexus/factory-domain/payments/permissions'
import { openOnDeposit, openOnInvoice } from '@nexus/factory-domain/payments/payments'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { CommandCaller } from '../../core/command'
import { paymentTermsOf } from '../invoicing/facts'
import { assertMay, officeContextOf } from './store'

/**
 * A customer's open items in one company, oldest first (A2 SCR-082 "Record a payment", step 2; FIN-121): the OPEN
 * deposit requests and the issued TD01/TD24 invoices that still ask money, each with what is still open — the cap an
 * allocation may reach (the same sums allocateInCommand reads under its locks; this read takes none, the write checks
 * again). A TD02 is paid through its deposit request, a TD04 asks nothing: neither is listed.
 */

const day = (value: Date): string => value.toISOString().slice(0, 10)

export async function openItems(caller: CommandCaller, query: { companyId: string; partyId: string }) {
  const context = officeContextOf(caller)
  assertMay(context, PAYMENTS_VIEW, PAYMENTS_VIEW, { companyId: query.companyId, partyId: query.partyId }, 'Customer')
  return caller.withClient(async (client) => {
    const requests = await client.depositRequest.findMany({
      where: { companyId: query.companyId, partyId: query.partyId, status: 'OPEN' },
      select: { id: true, currency: true, amount: true, dueDate: true, createdAt: true, orderId: true, fiscalDocument: true, order: { select: { number: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    const invoices = await client.invoice.findMany({
      where: { companyId: query.companyId, buyerPartyId: query.partyId, docType: { in: ['TD01', 'TD24'] }, status: { not: 'DRAFT' } },
      select: { id: true, number: true, docType: true, issueDate: true, currency: true, grossTotal: true, paymentTerms: true, salesOrderId: true, salesOrder: { select: { number: true } } },
      orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
    })
    const requestIds = requests.map((request) => request.id)
    const invoiceIds = invoices.map((invoice) => invoice.id)
    const paidRequests = requestIds.length === 0 ? [] : await client.paymentAllocation.groupBy({ by: ['depositRequestId'], where: { depositRequestId: { in: requestIds } }, _sum: { amount: true } })
    const paidInvoices = invoiceIds.length === 0 ? [] : await client.paymentAllocation.groupBy({ by: ['invoiceId'], where: { invoiceId: { in: invoiceIds } }, _sum: { amount: true } })
    const credited = invoiceIds.length === 0 ? [] : await client.invoice.groupBy({ by: ['creditOfId'], where: { creditOfId: { in: invoiceIds }, docType: 'TD04', status: { not: 'DRAFT' } }, _sum: { grossTotal: true } })

    const items = [
      ...requests.map((request) => ({
        target: 'DEPOSIT_REQUEST' as const,
        id: request.id,
        number: null,
        docType: null,
        fiscalDocument: request.fiscalDocument,
        orderId: request.orderId,
        orderNumber: request.order?.number ?? null,
        date: day(request.createdAt),
        dueDate: day(request.dueDate),
        currency: request.currency,
        amount: request.amount,
        open: openOnDeposit(request.amount, paidRequests.find((entry) => entry.depositRequestId === request.id)?._sum.amount ?? 0),
      })),
      ...invoices.map((invoice) => ({
        target: 'INVOICE' as const,
        id: invoice.id,
        number: invoice.number,
        docType: invoice.docType,
        fiscalDocument: null,
        orderId: invoice.salesOrderId,
        orderNumber: invoice.salesOrder?.number ?? null,
        date: invoice.issueDate ? day(invoice.issueDate) : '',
        dueDate: paymentTermsOf(invoice.paymentTerms)?.installments.find((installment) => typeof installment.dueDate === 'string')?.dueDate ?? null,
        currency: invoice.currency,
        amount: invoice.grossTotal,
        open: openOnInvoice(invoice.grossTotal, credited.find((entry) => entry.creditOfId === invoice.id)?._sum.grossTotal ?? 0, paidInvoices.find((entry) => entry.invoiceId === invoice.id)?._sum.amount ?? 0),
      })),
    ]
      .filter((item) => item.open > 0)
      .sort((a, b) => a.date.localeCompare(b.date) || a.target.localeCompare(b.target) || a.id.localeCompare(b.id))
    return { items: items.map(({ open, amount, ...item }) => ({ ...item, amount: asMoney('price', amount), openAmount: asMoney('price', open) })) }
  })
}

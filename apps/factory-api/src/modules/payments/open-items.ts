import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { PAYMENTS_VIEW } from '@nexus/factory-domain/payments/permissions'
import { openOnDeposit, openOnInvoice } from '@nexus/factory-domain/payments/payments'
import { suggestOldestFirst, unplacedOf } from '@nexus/factory-domain/payments/refunds'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { CommandCaller } from '../../core/command'
import { paymentTermsOf } from '../invoicing/facts'
import { balancesOf, unplacedPayments } from './credit-balance'
import { refundedOf } from './refunds'
import { allocatedOf, assertMay, officeContextOf } from './store'

/**
 * A customer's open items in one company, oldest first (A2 SCR-082 "Record a payment", step 2; FIN-121): the OPEN
 * deposit requests and the issued TD01/TD24 invoices that still ask money, each with what is still open — the cap an
 * allocation may reach (the same sums allocateInCommand reads under its locks; this read takes none, the write checks
 * again). A TD02 is paid through its deposit request, a TD04 asks nothing: neither is listed.
 *
 * B-W2a-61 (FIN-122, one payment to many invoices; design finance.payments rec allocation "Where this money goes"):
 *   stepKind         a deposit request says which step of the order's payment schedule it is: DEPOSIT, or B-W2a-F2's
 *                    BEFORE_SHIPPING balance (its own request and TD02); null for a request no step names
 *   paymentId|amount the matcher's "Suggest": what is left of that payment (its unplaced part) or of that amount is spread
 *                    over the items oldest first (`suggestedAmount`); `left.afterSuggestion` stays on the payment — the
 *                    customer's credit balance. Saving the allocation is W1's POST /payments(/:id/allocations) with the
 *                    targets and amounts shown (one payment, many invoices, in one command)
 *   creditBalance    what the customer's RECEIVED payments hold unplaced, per currency (a refund of it, or an allocation)
 *   noInvoiceDeposit an invoice of an order whose deposit was paid on a request that issues no TD02 (NONE: an EU business
 *                    with a VIES proof): what that deposit holds. The money stays on the request (a PAID request's
 *                    allocations are final in the database): the settlement counts it as paying the order, the invoice's
 *                    open amount does not — the office should not ask it twice (named gap: a schema need to carry it)
 */

const day = (value: Date): string => value.toISOString().slice(0, 10)

export async function openItems(caller: CommandCaller, query: { companyId: string; partyId: string; paymentId?: string | undefined; amount?: number | undefined }) {
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
    // B-W2a-61: the step of the payment schedule each request is, and the NONE deposits paid on the invoices' orders.
    const steps = requestIds.length === 0 ? [] : await client.salesOrderMilestone.findMany({ where: { depositRequestId: { in: requestIds } }, select: { depositRequestId: true, kind: true } })
    const orderIds = [...new Set(invoices.flatMap((invoice) => (invoice.salesOrderId ? [invoice.salesOrderId] : [])))]
    const noneRequests = orderIds.length === 0 ? [] : await client.depositRequest.findMany({ where: { orderId: { in: orderIds }, fiscalDocument: 'NONE', status: 'PAID' }, select: { id: true, orderId: true } })
    const nonePaid = noneRequests.length === 0 ? [] : await client.paymentAllocation.groupBy({ by: ['depositRequestId'], where: { depositRequestId: { in: noneRequests.map((request) => request.id) } }, _sum: { amount: true } })
    const noInvoiceDepositOf = (orderId: string | null): number | null => {
      if (!orderId) return null
      const own = noneRequests.filter((request) => request.orderId === orderId)
      return own.length === 0 ? null : own.reduce((sum, request) => sum + (nonePaid.find((entry) => entry.depositRequestId === request.id)?._sum.amount ?? 0), 0)
    }

    const items = [
      ...requests.map((request) => {
        const kind = steps.find((step) => step.depositRequestId === request.id)?.kind
        return {
          target: 'DEPOSIT_REQUEST' as const,
          id: request.id,
          number: null,
          docType: null,
          fiscalDocument: request.fiscalDocument,
          stepKind: kind === 'DEPOSIT' || kind === 'BEFORE_SHIPPING' ? kind : null,
          orderId: request.orderId,
          orderNumber: request.order?.number ?? null,
          date: day(request.createdAt),
          dueDate: day(request.dueDate),
          currency: request.currency,
          amount: request.amount,
          open: openOnDeposit(request.amount, paidRequests.find((entry) => entry.depositRequestId === request.id)?._sum.amount ?? 0),
          noInvoiceDeposit: null as number | null,
        }
      }),
      ...invoices.map((invoice) => ({
        target: 'INVOICE' as const,
        id: invoice.id,
        number: invoice.number,
        docType: invoice.docType,
        fiscalDocument: null,
        stepKind: null,
        orderId: invoice.salesOrderId,
        orderNumber: invoice.salesOrder?.number ?? null,
        date: invoice.issueDate ? day(invoice.issueDate) : '',
        dueDate: paymentTermsOf(invoice.paymentTerms)?.installments.find((installment) => typeof installment.dueDate === 'string')?.dueDate ?? null,
        currency: invoice.currency,
        amount: invoice.grossTotal,
        open: openOnInvoice(invoice.grossTotal, credited.find((entry) => entry.creditOfId === invoice.id)?._sum.grossTotal ?? 0, paidInvoices.find((entry) => entry.invoiceId === invoice.id)?._sum.amount ?? 0),
        noInvoiceDeposit: noInvoiceDepositOf(invoice.salesOrderId),
      })),
    ]
      .filter((item) => item.open > 0)
      .sort((a, b) => a.date.localeCompare(b.date) || a.target.localeCompare(b.target) || a.id.localeCompare(b.id))

    // The matcher's "Suggest": what is left of the payment (or of the amount typed) placed oldest first.
    let left: number | null = null
    if (query.paymentId !== undefined) {
      const payment = isUuid(query.paymentId) ? await client.payment.findUnique({ where: { id: query.paymentId }, select: { id: true, companyId: true, partyId: true, status: true, amount: true } }) : null
      if (!payment || payment.companyId !== query.companyId || payment.partyId !== query.partyId) throw new NotFoundError("Not a payment of this customer and company.")
      left = unplacedOf({ status: payment.status, amount: payment.amount, allocated: await allocatedOf(client, payment.id), refunded: await refundedOf(client, payment.id) })
    } else if (query.amount !== undefined) left = query.amount
    const suggestion = left === null ? null : suggestOldestFirst(left, items.map((item) => ({ id: item.id, open: item.open })))
    const balances = balancesOf(await unplacedPayments(client, { companyId: query.companyId, partyId: query.partyId }))

    return {
      items: items.map(({ open, amount, noInvoiceDeposit, ...item }) => ({
        ...item,
        amount: asMoney('price', amount),
        openAmount: asMoney('price', open),
        ...(suggestion ? { suggestedAmount: asMoney('price', suggestion.suggested.get(item.id) ?? 0) } : {}),
        noInvoiceDepositAmount: asMoney('price', noInvoiceDeposit),
      })),
      left: suggestion ? { amount: asMoney('price', left!), afterSuggestion: asMoney('price', suggestion.left) } : null,
      creditBalance: balances.map((entry) => ({ currency: entry.currency, amount: asMoney('price', entry.amount) })),
    }
  })
}

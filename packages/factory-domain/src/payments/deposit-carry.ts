import type { MinorUnits } from '../core/money'
import { amountText } from '../invoicing/invoices'

/**
 * A deposit paid without a deposit invoice, carried onto its order's invoice (B-W2b-21, Z8:01; B-W2a-61's gap and schema
 * need, met by B-W2b-02's PaymentAllocation.carriedFromId), pure.
 *
 * A deposit request whose fiscal rule issues no TD02 (fiscalDocument NONE: an EU business with a VIES proof, B-W1-05)
 * keeps the money paid on it after it is PAID: no deposit invoice deducts it from the order's TD01 / TD24, so that invoice
 * stays open for its whole gross (the ageing, the reminders and the matcher would ask the money twice). Carrying it
 * places that money on the invoice in ONE command, for each live allocation of the request (an allocation not reversed):
 *   1. a reversal of the allocation (the same payment and request, the opposite amount, a note saying why)
 *   2. an allocation of the same payment to an issued TD01 / TD24 of the request's order, for the allocation's amount,
 *      naming the reversal (carriedFromId)
 * The database holds every part of it (…_followups_quality_money_w2b_guards: only a PAID NONE request of an order, only an
 * invoice of that order, the opposite amount, once per reversal; a reversal without its carry fails at commit). The request
 * stays PAID (its allocations add up to 0): the order's settlement counts the money on the invoice instead.
 *
 * An allocation is carried whole onto one invoice (one carry per reversal, of the opposite amount). With an invoice named,
 * every allocation goes onto it; without, each goes onto the order's oldest invoice whose open amount still takes it.
 */

export interface CarryRequest {
  readonly status: string
  readonly fiscalDocument: 'TD02' | 'NONE'
  readonly orderId: string | null
  readonly orderNumber: string | null
  readonly currency: string
}

/** A live allocation of the request (not reversed, above 0), oldest first. */
export interface CarryAllocation {
  readonly id: string
  readonly paymentId: string
  readonly amount: MinorUnits
}

/** An issued TD01 / TD24 of the order it may go onto, oldest first, with what it is still open for. */
export interface CarryInvoice {
  readonly id: string
  readonly number: string
  readonly currency: string
  readonly open: MinorUnits
}

export interface CarryStep {
  readonly allocationId: string
  readonly paymentId: string
  readonly amount: MinorUnits
  readonly invoiceId: string
}

/** Why the request's money cannot be carried at all (null: it can), in words. */
export function carryRequestProblem(request: CarryRequest): string | null {
  const order = request.orderNumber ? `order ${request.orderNumber}` : 'its order'
  if (request.fiscalDocument !== 'NONE') return `This deposit has a deposit invoice (TD02): the order's invoice deducts that invoice, nothing is carried.`
  if (request.orderId === null) return 'This deposit request names no order yet: its money is carried onto an invoice of the order once the order exists.'
  if (request.status !== 'PAID') return `The deposit of ${order} is ${request.status}: only a PAID deposit is carried onto the order's invoice.`
  return null
}

/**
 * Where each live allocation goes. `invoiceId` named: all of them onto it (its open amount must take them all); none
 * named: each onto the oldest invoice that still takes it whole. A problem in words when nothing is left to carry or the
 * invoices cannot take it.
 */
export function depositCarryPlan(request: CarryRequest, allocations: readonly CarryAllocation[], invoices: readonly CarryInvoice[], invoiceId?: string | null): { readonly steps: readonly CarryStep[]; readonly amount: MinorUnits; readonly problem: string | null } {
  const refused = (problem: string) => ({ steps: [] as CarryStep[], amount: 0, problem })
  const requestProblem = carryRequestProblem(request)
  if (requestProblem) return refused(requestProblem)
  const order = request.orderNumber ? `order ${request.orderNumber}` : 'the order'
  const live = allocations.filter((allocation) => allocation.amount > 0)
  const total = live.reduce((sum, allocation) => sum + allocation.amount, 0)
  if (live.length === 0) return refused(`Nothing is left on the deposit of ${order}: its money is carried onto the invoice already.`)
  const candidates = invoices.filter((invoice) => invoice.currency === request.currency)
  if (invoiceId) {
    const invoice = invoices.find((entry) => entry.id === invoiceId)
    if (!invoice) return refused(`The invoice named is not an issued invoice (TD01 or TD24) of ${order}: the deposit is carried onto an invoice of its own order.`)
    if (invoice.currency !== request.currency) return refused(`Invoice ${invoice.number} is in ${invoice.currency}, the deposit in ${request.currency}.`)
    if (invoice.open < total) return refused(`Invoice ${invoice.number} is open for ${amountText(invoice.open, invoice.currency)}; the deposit holds ${amountText(total, request.currency)}. Carry it onto an invoice open for at least that much, or credit what is wrong first.`)
    return { steps: live.map((allocation) => ({ allocationId: allocation.id, paymentId: allocation.paymentId, amount: allocation.amount, invoiceId: invoice.id })), amount: total, problem: null }
  }
  if (candidates.length === 0) return refused(`${order.charAt(0).toUpperCase()}${order.slice(1)} has no issued invoice (TD01 or TD24) open yet: the deposit is carried once the invoice is issued.`)
  const left = new Map(candidates.map((invoice) => [invoice.id, invoice.open]))
  const steps: CarryStep[] = []
  for (const allocation of live) {
    const onto = candidates.find((invoice) => (left.get(invoice.id) ?? 0) >= allocation.amount)
    if (!onto) return refused(`The invoices of ${order} are open for ${amountText(candidates.reduce((sum, invoice) => sum + invoice.open, 0), request.currency)} in all; the deposit holds ${amountText(total, request.currency)}, carried whole per payment. Name the invoice, or credit what is wrong first.`)
    left.set(onto.id, left.get(onto.id)! - allocation.amount)
    steps.push({ allocationId: allocation.id, paymentId: allocation.paymentId, amount: allocation.amount, invoiceId: onto.id })
  }
  return { steps, amount: total, problem: null }
}

/** The reversal's note (the database wants one): the order and the invoice, in the office's words. */
export const carryNote = (orderNumber: string | null, invoiceNumber: string, note: string | null | undefined): string =>
  (note && note.trim() !== '' ? note.trim() : `Deposit${orderNumber ? ` of order ${orderNumber}` : ''} carried onto invoice ${invoiceNumber}: the deposit issues no deposit invoice (fiscal document NONE).`).slice(0, 500)

import { isApiError } from '../../../../lib/api/errors'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import type { CostDocument, InvoiceDocument, OrderDocuments, PaymentDocument } from './api'
// B-W2b-F51: a refusal names the missing right in words, never its code.
import { rightRef } from '../../../../lib/i18n/rights'

/**
 * The order profitability report's documents on SCR-155's DetailModal (B-W2b-416; FIN-053): the pure rules — where each
 * document opens (its own record page: an invoice or a credit note in Finance › Invoices, a payment in Finance › Payments,
 * a shipment in Warehouse › Shipments, a subcontract order in Purchasing, a supplier invoice in Payables; a work order's cost
 * in Finance › Standard vs actual), the words of each kind and note, which groups the person may see, and the API's errors
 * in this part's words. No fetching, no React. No person is named.
 */

export interface DocumentsState {
  readonly orderId: string
  readonly value: OrderDocuments | null
  readonly problem: string | null
}

/** A document's own page (company-free; the caller adds the prefix), or null when it has none. */
export function documentHref(prefix: string, record: { readonly type: string; readonly id: string }): string | null {
  if (record.type === 'WorkOrder') return `${prefix}/finance/costing?open=${encodeURIComponent(record.id)}`
  if (record.type === 'DepositRequest') return null
  return `${prefix}${recordAddress({ type: record.type, id: record.id }, OFFICE_PAGES)}`
}

/** The record an invoice row opens. */
export const invoiceRecord = (row: InvoiceDocument) => ({ type: 'Invoice', id: row.id })
/** The record a payment row opens. */
export const paymentRecord = (row: PaymentDocument) => ({ type: 'Payment', id: row.id })
/** The record a cost row opens (its work order's cost, a shipment, a subcontract order, a supplier invoice). */
export const costRecord = (row: CostDocument) => row.record

/** Every group empty (nothing to show at all): the section says so once. */
export function isEmpty(documents: OrderDocuments): boolean {
  return [documents.invoices, documents.creditNotes, documents.costs, documents.freight, documents.payments].every((group) => group.held === null && group.rows.length === 0)
}

/** The words of an invoice row's kind (TD01 … as the design says them). */
export const invoiceKindKey = (row: InvoiceDocument): string => `invoiceKind.${row.kind}`

/** The words of a cost row's kind. */
export const costKindKey = (row: CostDocument): string => `costKind.${row.kind}`

/** A note's words. */
export const noteKey = (note: string): string => `note.${note}`

/** A group held for want of a permission: its words name the right in words, never its code (B-W2b-F51; as SCR-155 does). */
export const heldPhrase = (held: string): { key: string; params: { right: string } } => ({ key: 'held', params: { right: rightRef(held) } })

/** The API's error in this part's words. */
export function documentsProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.internal'
  if (['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited'].includes(error.kind)) return `problem.${error.kind}`
  return 'problem.internal'
}

/** The states each kind of document may be in (factory-db's enums), for their words; anything else reads "unknown". */
export const STATES: Readonly<Record<'Invoice' | 'Payment' | 'Shipment' | 'WorkOrder' | 'SubcontractOrder' | 'SupplierInvoice', readonly string[]>> = Object.freeze({
  Invoice: ['DRAFT', 'ISSUED', 'SENT', 'DELIVERED', 'NOT_DELIVERABLE', 'REJECTED', 'ERROR'],
  Payment: ['RECEIVED', 'VOIDED'],
  Shipment: ['DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED'],
  WorkOrder: ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED', 'CANCELLED', 'ON_HOLD'],
  SubcontractOrder: ['DRAFT', 'ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'],
  SupplierInvoice: ['RECEIVED', 'APPROVED', 'PAID', 'DISPUTED', 'VOIDED'],
})

/** A document's state in words (`state.<Type>.<CODE>`), or "unknown" for a state this screen does not know. */
export function stateKey(type: keyof typeof STATES, state: string | null): string {
  if (state === null) return 'state.none'
  return STATES[type].includes(state) ? `state.${type}.${state}` : 'state.unknown'
}

/** The payment methods (factory-db PaymentMethod) for their words. */
export const PAYMENT_METHODS = ['BANK_TRANSFER', 'CARD', 'SEPA_DEBIT'] as const
export const methodKey = (method: string): string => ((PAYMENT_METHODS as readonly string[]).includes(method) ? `method.${method}` : 'method.other')

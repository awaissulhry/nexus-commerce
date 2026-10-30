import type { Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { DEPOSIT_PAYMENT_CONDITION, instalmentsOf, invoiceDueOf } from '@nexus/factory-domain/sales/terms/terms'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { PaymentInput } from './drafts'
import { paymentTermsOf } from './facts'
import type { Reader } from './store'

/**
 * An invoice's payment terms (B-W2a-54; B-W2a-19's terms library, FIN-075; FatturaPA DatiPagamento): Invoice.paymentTerms
 * holds { condition, installments, source }, `source` saying where they come from so a new total (a line changed) and the
 * issue (the invoice's own date) make them again the same way:
 *
 *   MANUAL    the office's own (the W1 `payment` input): one instalment of the whole amount (TP02), its method, due date
 *             and IBAN as typed. A stored W1 row without a source reads as this.
 *   TERMS     a payment terms entry of the library: the order's (SalesOrder.paymentTermsId, kept as sold) when the
 *             invoice bills one order, else the customer's (Party.paymentTermsId): factory-domain sales/terms
 *             invoiceDueOf — the instalments counted from the invoice's date, their shares among themselves (TP01 for
 *             several, TP02 for one; terms that ask everything before the invoice leave one instalment due on its day),
 *             the company's IBAN on a bank transfer (MP05), and the early-payment discount as the terms state it (kept
 *             in the JSON only: FatturaPA ScontoPagamentoAnticipato is an amount, and its base is the accountant's).
 *   ADVANCE   a deposit invoice (TD02): TP03, one instalment of the whole amount, due the day it was paid.
 * A total of 0 or less asks nothing: no instalment (the file then has no DatiPagamento).
 */

export type TermsSource =
  | { readonly kind: 'MANUAL'; readonly method: string; readonly dueDate: string | null; readonly iban: string | null }
  | { readonly kind: 'TERMS'; readonly termsId: string }
  | { readonly kind: 'ADVANCE'; readonly method: string; readonly paidOn: string }

const METHOD = /^MP(0[1-9]|1[0-9]|2[0-3])$/

/** The office's payment input as a source (null: no terms). */
export const sourceOfPayment = (payment: PaymentInput | null): TermsSource | null =>
  payment === null ? null : { kind: 'MANUAL', method: payment.method ?? 'MP05', dueDate: payment.dueDate ?? null, iban: payment.iban ? payment.iban.replace(/\s+/g, '').toUpperCase() : null }

/** Where a stored invoice's terms came from: its `source`, else (a W1 row) the office's own from its first instalment. */
export function storedSourceOf(stored: unknown): TermsSource | null {
  if (!stored || typeof stored !== 'object') return null
  const source = (stored as { source?: Record<string, unknown> }).source
  if (source && typeof source === 'object') {
    if (source.kind === 'TERMS' && typeof source.termsId === 'string' && isUuid(source.termsId)) return { kind: 'TERMS', termsId: source.termsId }
    if (source.kind === 'ADVANCE' && typeof source.method === 'string' && METHOD.test(source.method) && typeof source.paidOn === 'string') return { kind: 'ADVANCE', method: source.method, paidOn: source.paidOn }
    if (source.kind === 'MANUAL' && typeof source.method === 'string' && METHOD.test(source.method)) {
      return { kind: 'MANUAL', method: source.method, dueDate: typeof source.dueDate === 'string' ? source.dueDate : null, iban: typeof source.iban === 'string' ? source.iban : null }
    }
  }
  const first = paymentTermsOf(stored)?.installments[0]
  return first ? { kind: 'MANUAL', method: first.method, dueDate: first.dueDate ?? null, iban: first.iban ?? null } : null
}

/** The library terms an invoice takes: the order's (when it bills one order that names them), else the customer's. */
export async function orderTermsSource(db: Reader, of: { readonly salesOrderId: string | null; readonly partyId: string }): Promise<TermsSource | null> {
  const order = of.salesOrderId && isUuid(of.salesOrderId) ? await db.salesOrder.findUnique({ where: { id: of.salesOrderId }, select: { paymentTermsId: true } }) : null
  if (order?.paymentTermsId) return { kind: 'TERMS', termsId: order.paymentTermsId }
  const party = await db.party.findUnique({ where: { id: of.partyId }, select: { paymentTermsId: true } })
  return party?.paymentTermsId ? { kind: 'TERMS', termsId: party.paymentTermsId } : null
}

/** Invoice.paymentTerms for a total of `gross` (minor units) issued on `day`, from `source`; null: none. */
export async function termsJsonOf(db: Reader, companyId: string, source: TermsSource | null, gross: number, day: BusinessDate): Promise<Prisma.InputJsonValue | null> {
  if (source === null) return null
  if (source.kind === 'MANUAL') {
    return {
      condition: 'TP02',
      installments: [{ method: source.method, amount: gross, ...(source.dueDate ? { dueDate: source.dueDate } : {}), ...(source.iban ? { iban: source.iban } : {}) }],
      source,
    }
  }
  if (source.kind === 'ADVANCE') {
    return { condition: DEPOSIT_PAYMENT_CONDITION, installments: gross > 0 ? [{ method: source.method, amount: gross, dueDate: source.paidOn }] : [], source }
  }
  const row = await db.paymentTerms.findUnique({ where: { id: source.termsId }, select: { code: true, method: true, instalments: true, earlyPaymentDiscountPct: true, earlyPaymentDays: true } })
  if (!row) return null
  const due = invoiceDueOf(
    { method: row.method, instalments: instalmentsOf(row.instalments), earlyPaymentDiscountPct: row.earlyPaymentDiscountPct === null ? null : decimalText(row.earlyPaymentDiscountPct.toString()), earlyPaymentDays: row.earlyPaymentDays },
    day,
    Math.max(0, gross),
  )
  const company = due.method === 'MP05' ? await db.company.findUnique({ where: { id: companyId }, select: { iban: true } }) : null
  const iban = company?.iban ? company.iban.replace(/\s+/g, '').toUpperCase() : null
  // A share that rounds to nothing (a cent split in two) is no instalment: TP01 needs two or more.
  const installments = gross > 0 ? due.instalments.filter((item) => item.amount > 0).map((item) => ({ method: due.method, amount: item.amount, dueDate: item.dueDate, ...(iban ? { iban } : {}) })) : []
  return {
    condition: installments.length > 1 ? 'TP01' : 'TP02',
    installments,
    source: { kind: 'TERMS', termsId: source.termsId, code: row.code },
    ...(due.earlyPayment ? { earlyPayment: due.earlyPayment } : {}),
  }
}

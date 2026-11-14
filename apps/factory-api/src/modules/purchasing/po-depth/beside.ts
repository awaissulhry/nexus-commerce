import { businessDate } from '@nexus/factory-domain/core/time'
import { rateWords } from '@nexus/factory-domain/money/currency/rates'
import { loadRateBook } from '../../../platform/currency/service'
import type { Reader } from '../store'

/**
 * B-W2b-389 (CY1:02; SCM-065): beside an order's rate at order, the day's rate of each of its receipts (the day it was
 * received, Europe/Rome) and of each supplier invoice that bills its lines (the invoice's date), from the rates table: what
 * the goods and the bill were worth that day. Read from the table each time (an ECB rate is never changed; a manual rate of
 * the day wins); nothing is stored on the receipt or the invoice yet (no column: a named schema need), so the accountant's
 * revaluation stays theirs. Newest first; a day with no rate kept says so (rate null).
 */
export interface RateBeside {
  readonly at: 'RECEIPT' | 'INVOICE'
  readonly id: string
  readonly number: string
  readonly day: string
  readonly rate: string | null
  readonly source: 'ECB' | 'MANUAL' | null
  readonly words: string | null
}

export async function ratesBeside(db: Reader, orderId: string, companyCurrency: string, orderCurrency: string): Promise<RateBeside[]> {
  const receipts = await db.goodsReceipt.findMany({ where: { purchaseOrderId: orderId, status: { not: 'CANCELLED' } }, select: { id: true, number: true, receivedAt: true }, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: 50 })
  const billed = await db.supplierInvoiceLine.findMany({ where: { purchaseOrderLine: { purchaseOrderId: orderId } }, select: { invoiceId: true }, distinct: ['invoiceId'], take: 50 })
  const invoices = billed.length === 0 ? [] : await db.supplierInvoice.findMany({ where: { id: { in: billed.map((row) => row.invoiceId) } }, select: { id: true, number: true, issueDate: true }, orderBy: [{ issueDate: 'desc' }, { id: 'desc' }] })
  const entries = [
    ...receipts.map((row) => ({ at: 'RECEIPT' as const, id: row.id, number: row.number, day: businessDate(row.receivedAt) })),
    ...invoices.map((row) => ({ at: 'INVOICE' as const, id: row.id, number: row.number, day: row.issueDate.toISOString().slice(0, 10) })),
  ].sort((a, b) => (a.day === b.day ? a.at.localeCompare(b.at) : b.day.localeCompare(a.day)))
  if (entries.length === 0) return []
  const days = entries.map((entry) => entry.day).sort()
  const book = await loadRateBook(db, days[0]!, days.at(-1)!)
  return entries.map((entry) => {
    const rate = book.rate(companyCurrency, orderCurrency, entry.day)
    return { ...entry, rate: rate?.rate ?? null, source: rate?.source ?? null, words: rate ? rateWords(rate) : null }
  })
}

import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { convertMinor } from '@nexus/factory-domain/money/currency/convert'
import { EURO } from '@nexus/factory-domain/money/currency/currencies'
import { rateWords, type DayRate } from '@nexus/factory-domain/money/currency/rates'
import { dayRate, noRateWords, type Reader } from './store'

/**
 * What other modules ask of the rates (B-W2b-389; PLT-132, PLT-133): always the day's rate of the table (store.ts dayRate,
 * loadRateBook: the ECB's rate of the day or before, a manual rate of that day winning), and the words a document waits
 * with when none is kept. A module keeps the rate it used on its own document (it is never read again later), so a later
 * rate never changes a document; revaluation stays the accountant's.
 *
 *   a purchase order    its rate at order is 1 <company currency> = rate <order currency> (modules/purchasing po-depth)
 *   an invoice          its exchangeRate is units of its currency per euro, its rateDate that rate's day and totalEur its
 *                       gross total in euro (FatturaPA keeps euro amounts): all three, or none in euro (invoiceRateOf)
 */
export { dayRate, loadRateBook, noRateWords, type RateBook } from './store'

/** The euro rate an invoice in another currency keeps when it is issued on `day`, or why it cannot be issued yet. */
export type InvoiceRate =
  | { readonly ok: true; readonly exchangeRate: string; readonly rateDate: BusinessDate; readonly totalEur: number; readonly words: string }
  | { readonly ok: false; readonly code: 'NO_RATE'; readonly path: 'exchangeRate'; readonly message: string }

/**
 * The rate trio of an invoice (B-W2b-369's columns; lead decision 11-13: a non-euro invoice is issued only with them): the
 * draft's own rate when it names one (typed: it stays), else the day's rate of the table (1 EUR = rate <currency>), its day
 * and the gross total in euro at it (one rounding). Null for an invoice in euro (it keeps none).
 */
export async function invoiceRateOf(db: Reader, invoice: { readonly id: string; readonly currency: string; readonly grossTotal: number }, day: BusinessDate): Promise<InvoiceRate | null> {
  if (invoice.currency === EURO) return null
  const kept = await db.invoice.findUnique({ where: { id: invoice.id }, select: { exchangeRate: true, rateDate: true } })
  const typed: DayRate | null =
    kept?.exchangeRate && kept.rateDate ? { base: EURO, quote: invoice.currency, rate: kept.exchangeRate.toString(), rateDate: kept.rateDate.toISOString().slice(0, 10), source: 'MANUAL', how: 'STORED' } : null
  const rate = typed ?? (await dayRate(db, EURO, invoice.currency, day))
  if (!rate) return { ok: false, code: 'NO_RATE', path: 'exchangeRate', message: `The invoice is in ${invoice.currency}: an Italian invoice also keeps its total in euro at a named rate. ${noRateWords(EURO, invoice.currency, day)}` }
  return { ok: true, exchangeRate: rate.rate, rateDate: rate.rateDate, totalEur: convertMinor(invoice.grossTotal, invoice.currency, EURO, rate), words: rateWords(rate) }
}

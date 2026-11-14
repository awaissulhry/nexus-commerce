import type { MinorUnits } from '@nexus/factory-domain/core/money'
import { draftLanguageOf, euroEquivalentOf, euroEquivalentWords, invoiceLanguageOf, printLanguageOf, type LanguageSource } from '@nexus/factory-domain/invoicing/language-currency/language-currency'
import { EURO } from '@nexus/factory-domain/money/currency/currencies'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { invoiceRateOf } from '../../../platform/currency/service'
import type { Reader } from '../store'

/**
 * The invoice's language and its euro equivalent as the other invoicing files read them (B-W2b-396; FIN-063): the language
 * a new draft takes (drafts.ts insertDraft), the language and euro words its files print (invoice-files.ts, the issue's
 * checks in facts.ts). Reads Invoice.language / exchangeRate / rateDate (B-W2b-369's columns) on their own: the invoice
 * core's columns stay W1's.
 */

/** The language a new draft for this customer is written in: its invoices contact's own, else the customer's (PLT-131). */
export async function draftLanguageFor(db: Reader, buyerPartyId: string): Promise<{ language: string; source: Exclude<LanguageSource, 'INVOICE'> }> {
  const party = await db.party.findUnique({ where: { id: buyerPartyId }, select: { language: true } })
  const contacts = await db.partyContact.findMany({ where: { partyId: buyerPartyId, status: 'ACTIVE', roles: { has: 'INVOICES' } }, select: { name: true, language: true, roles: true, status: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 50 })
  return draftLanguageOf(contacts, party?.language ?? 'it')
}

/** An invoice's language now (its own, else its customer's) and the rate it keeps (null in euro or none yet). */
export async function languageAndRateOf(db: Reader, invoiceId: string): Promise<{ language: string; source: LanguageSource; exchangeRate: string | null; rateDate: string | null; totalEur: number | null } | null> {
  const row = await db.invoice.findUnique({ where: { id: invoiceId }, select: { language: true, exchangeRate: true, rateDate: true, totalEur: true, buyerPartyId: true } })
  if (!row) return null
  const party = await db.party.findUnique({ where: { id: row.buyerPartyId }, select: { language: true } })
  const { language, source } = invoiceLanguageOf(row.language, party?.language ?? 'it')
  return { language, source, exchangeRate: row.exchangeRate?.toFixed(8) ?? null, rateDate: row.rateDate?.toISOString().slice(0, 10) ?? null, totalEur: row.totalEur }
}

/** The Causale the issue's check builds the file with: the euro equivalent at the rate the issue would take (none yet: the office's own). */
export async function checkedCausaleOf(db: Reader, invoice: { readonly id: string; readonly currency: string; readonly causale: string | null }, totals: { readonly netTotal: MinorUnits; readonly grossTotal: MinorUnits }, day: BusinessDate): Promise<string | null> {
  if (invoice.currency === EURO) return invoice.causale
  const rate = await invoiceRateOf(db, { id: invoice.id, currency: invoice.currency, grossTotal: totals.grossTotal }, day)
  const language = (await languageAndRateOf(db, invoice.id))?.language ?? 'it'
  return printedCausale(invoice.causale, { currency: invoice.currency, ...totals }, rate?.ok ? { exchangeRate: rate.exchangeRate, rateDate: rate.rateDate } : null, language)
}

/**
 * The Causale an e-invoice prints: the office's own, then (an invoice in another currency with its rate) the euro equivalent
 * of its taxable amount, VAT and total in the invoice's language. Null when there is neither.
 */
export function printedCausale(causale: string | null, totals: { readonly currency: string; readonly netTotal: MinorUnits; readonly grossTotal: MinorUnits }, rate: { readonly exchangeRate: string; readonly rateDate: string } | null, language: string): string | null {
  if (totals.currency === EURO || rate === null) return causale
  const words = euroEquivalentWords(totals.currency, rate, euroEquivalentOf(totals, rate.exchangeRate), printLanguageOf(language))
  return causale ? `${causale} ${words}` : words
}

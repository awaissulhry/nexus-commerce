import type { Issue } from '../../core/errors'
import { isCurrencyCode, minorPlaces, type MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import { formatDate, formatDecimal, formatMoney } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'
import { convertMinor } from '../../money/currency/convert'
import { EURO } from '../../money/currency/currencies'
import { normalRate } from '../../money/currency/rates'

/**
 * The invoice's language and currency (B-W2b-396; FIN-063 "Invoice language and currency"; PLT-131 the contact's language),
 * pure.
 *
 *   language   what the courtesy copy and the customer's mail are written in (Invoice.language, ISO 639-1). A new draft
 *              takes the language of the customer's invoices contact (the first active contact with the INVOICES role
 *              that reads its own language, by name), else the customer's own; the office may change it while DRAFT, and
 *              clearing it decides it again. A stored null (an invoice made before this step) reads as the customer's
 *              language, which is what its copy was printed in. The XML is the same in every language.
 *   currency   an invoice bills in the currency of the order(s) it bills (a draft of DDTs of orders in USD is in USD; one
 *              invoice never mixes currencies), else in the company's. In another currency than the euro it keeps, from
 *              the issue on, its rate (units of its currency per euro, as the ECB quotes them), the rate's day and its total
 *              in euro (DPR 633/1972 art. 13 c.4: the day's rate, else the invoice date's; B-W2b-389's day rate unless the
 *              office types one while DRAFT). The e-invoice prints its amounts in its currency (Divisa) and states the
 *              euro equivalent of the taxable amount, the VAT and the total in its Causale (art. 21 c.2 lett. l: the VAT in
 *              euro). FatturaPA amounts carry two decimals: a currency with more minor units is refused.
 *
 * UNVERIFIED (GATE-ACCOUNTANT, `INVOICE_CURRENCY_RULE`): where the euro equivalent is printed and which rate counts.
 */

export const INVOICE_CURRENCY_RULE = Object.freeze({
  status: 'UNVERIFIED' as const,
  gate: 'GATE-ACCOUNTANT' as const,
  words: "An invoice in another currency keeps the ECB rate of its day (or the rate the office typed) and prints the euro equivalent of its taxable amount, VAT and total in its Causale. Your accountant confirms the rate's day and where the euro amounts are printed.",
})

const LANGUAGE = /^[a-z]{2}$/

export type LanguageSource = 'INVOICE' | 'CONTACT' | 'CUSTOMER'

export const languageProblem = (value: string, path = 'language'): Issue | null => (LANGUAGE.test(value) ? null : { path, message: 'A language is its ISO 639-1 code: two small letters (it, en, de).' })

export interface ContactLanguage {
  readonly name: string
  readonly language: string | null
  readonly roles: readonly string[]
  readonly status: string
}

/** The language a new draft is written in: the invoices contact's own, else the customer's. */
export function draftLanguageOf(contacts: readonly ContactLanguage[], partyLanguage: string): { readonly language: string; readonly source: Exclude<LanguageSource, 'INVOICE'> } {
  const contact = [...contacts]
    .filter((entry) => entry.status === 'ACTIVE' && entry.roles.includes('INVOICES') && entry.language !== null && LANGUAGE.test(entry.language))
    .sort((a, b) => a.name.localeCompare(b.name))[0]
  return contact ? { language: contact.language!, source: 'CONTACT' } : { language: partyLanguage, source: 'CUSTOMER' }
}

/** The language an invoice is written in now: its own when stored, else the customer's (as its copy was printed). */
export const invoiceLanguageOf = (stored: string | null, partyLanguage: string): { readonly language: string; readonly source: LanguageSource } =>
  stored !== null ? { language: stored, source: 'INVOICE' } : { language: partyLanguage, source: 'CUSTOMER' }

/** The language a document is printed in (the copy knows Italian and English; any other prints in Italian, as W1's copy). */
export const printLanguageOf = (language: string): DocumentLanguage => (language === 'en' ? 'en' : 'it')

/** The currency an invoice of these orders bills in: their one currency, else the company's; several → a problem in words. */
export function invoiceCurrencyOf(orderCurrencies: readonly string[], companyCurrency: string): { readonly currency: string } | { readonly problem: string } {
  const currencies = [...new Set(orderCurrencies)].sort()
  if (currencies.length === 0) return { currency: companyCurrency }
  if (currencies.length > 1) return { problem: `One invoice bills one currency: these orders are in ${currencies.join(' and ')}. Invoice each currency on its own.` }
  return { currency: currencies[0]! }
}

/** Why an invoice cannot be in this currency, or null: ISO 4217 with at most two decimals (FatturaPA prints two). */
export function documentCurrencyProblem(currency: string): string | null {
  if (!isCurrencyCode(currency)) return `${currency} is not an ISO 4217 currency.`
  if (minorPlaces(currency) > 2) return `${currency} has ${minorPlaces(currency)} decimals: an e-invoice prints amounts with two, so it cannot be invoiced in ${currency}.`
  return null
}

export interface TypedRate {
  readonly exchangeRate: string
  readonly rateDate: BusinessDate
}

/** A rate the office types on a draft in another currency, checked: above 0 with at most 8 decimals, of today or before. */
export function typedRateProblems(currency: string, rate: TypedRate, today: BusinessDate): Issue[] {
  const issues: Issue[] = []
  if (currency === EURO) issues.push({ path: 'body/exchangeRate', message: 'The invoice is in euro: it keeps no exchange rate.' })
  if (normalRate(rate.exchangeRate) === null) issues.push({ path: 'body/exchangeRate', message: 'A rate is a plain decimal above 0 with at most eight decimals: how many units of the invoice currency make one euro (1.0850).' })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rate.rateDate)) issues.push({ path: 'body/rateDate', message: 'The rate\'s day is a date (YYYY-MM-DD).' })
  else if (rate.rateDate > today) issues.push({ path: 'body/rateDate', message: 'A rate is of today or a day before: the future has no rate yet.' })
  return issues
}

export interface EuroEquivalent {
  readonly netEur: MinorUnits
  readonly vatEur: MinorUnits
  readonly grossEur: MinorUnits
}

/**
 * The euro equivalent of an invoice's totals at its rate (units of its currency per euro): the total in euro and the
 * taxable amount each converted once (half up, cents); the VAT is the difference, so the three always add up.
 */
export function euroEquivalentOf(totals: { readonly currency: string; readonly netTotal: MinorUnits; readonly grossTotal: MinorUnits }, exchangeRate: string): EuroEquivalent {
  const rate = { base: EURO, quote: totals.currency, rate: exchangeRate }
  const grossEur = convertMinor(totals.grossTotal, totals.currency, EURO, rate)
  const netEur = convertMinor(totals.netTotal, totals.currency, EURO, rate)
  return { netEur, vatEur: grossEur - netEur, grossEur }
}

/** The euro equivalent as the e-invoice's Causale states it, in the invoice's language. */
export function euroEquivalentWords(currency: string, rate: TypedRate, equivalent: EuroEquivalent, language: DocumentLanguage): string {
  const rateText = formatDecimal(normalRate(rate.exchangeRate) ?? rate.exchangeRate, language, 2, 8)
  const day = formatDate(rate.rateDate, language)
  const money = (amount: MinorUnits) => formatMoney(amount, EURO, language)
  return language === 'it'
    ? `Controvalore in euro al cambio 1 EUR = ${rateText} ${currency} del ${day} (art. 13 c.4 DPR 633/1972): imponibile ${money(equivalent.netEur)}, IVA ${money(equivalent.vatEur)}, totale ${money(equivalent.grossEur)}.`
    : `Euro equivalent at 1 EUR = ${rateText} ${currency} of ${day} (art. 13 c.4 DPR 633/1972): taxable ${money(equivalent.netEur)}, VAT ${money(equivalent.vatEur)}, total ${money(equivalent.grossEur)}.`
}

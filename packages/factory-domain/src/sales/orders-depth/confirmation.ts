import { createHash } from 'node:crypto'
import { canonicalJson } from '../../accounting/manifest'
import type { CurrencyCode, MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import type { DocumentInput, DocumentLanguage, DocumentLine, DocumentReference, PostalAddress } from '../../documents/model'
import type { PrintedOption } from '../../documents/options-block'
import { decimalText, roundTo } from '../../product/units/units'
import { Dec, HUNDRED } from '../../tax/decimal'
import type { PriceBasis } from '../../tax/vat-summary'
import { lineAmountOf, sizesText, type CustomerSize } from '../quotes/document'

/**
 * The order confirmation (B-W2b-303; SAL-208; design order.docs.confirmation "The confirmation PDF with lines, sizes, prices,
 * dates, terms and certificate class per style"), pure: one model of a confirmed order — its lines with their size grids,
 * prices on the order's basis, the delivery schedule, the PPE class each style is made for, the totals, the terms — from
 * which the PDF of the fixed ORDER_CONFIRMATION layout is made. Prices only: no cost, margin or internal note reaches it.
 *
 * A version per order: 1, 2, … (GeneratedDocument kind ORDER_CONFIRMATION). Its fingerprint is the contents without the
 * day it was made and without the version number (`confirmationFingerprint`): the same order prints the same, so asking
 * for a confirmation of an unchanged order gives the newest version back instead of a new one. The document number is the
 * order's number and the version ("SO-2026-0012 v2").
 */

export const CONFIRMATION_KIND = 'ORDER_CONFIRMATION' as const

export interface ConfirmationLine {
  readonly seq: number
  /** The style's code and the colourway's (`JKT-01 BLK`). */
  readonly code: string
  readonly description: string
  readonly note: string | null
  /** The PPE category, standard and class the style is made for, in words ("PPE cat. II · EN 17092-4 · class AA"); null: none. */
  readonly ppe: string | null
  readonly quantity: number
  /** On the order's price basis. */
  readonly unitPrice: string
  /** The list price the line's waterfall starts from (shown only when the price list shows the discount). */
  readonly listUnitPrice: string | null
  readonly netAmount: MinorUnits
  readonly vatAmount: MinorUnits
  readonly sizes: readonly CustomerSize[]
  /** The line's delivery schedule (B-W2b-294): a day and the pieces then. */
  readonly deliveries: readonly { readonly date: BusinessDate; readonly quantity: number }[]
  /** B-W2b-374 (XF3:03): the options chosen on the line, as printed; left out when none (the fingerprint stays as it was). */
  readonly options?: readonly PrintedOption[]
}

export interface CustomerOrder {
  readonly number: string
  readonly version: number
  /** The day it is made: the document's date (not in the fingerprint). */
  readonly date: BusinessDate
  readonly language: DocumentLanguage
  readonly currency: CurrencyCode
  readonly priceBasis: PriceBasis
  readonly orderDate: BusinessDate
  readonly customerRef: string | null
  readonly quoteNumber: string | null
  readonly promiseDate: BusinessDate | null
  readonly paymentTerms: string | null
  /** The Incoterm and its place in words ("DAP Milano (Delivered at place)"); null: none. */
  readonly deliveryTerms: string | null
  readonly shipComplete: boolean
  readonly season: { readonly code: string; readonly name: string } | null
  readonly party: { readonly name: string; readonly address: PostalAddress | null; readonly vatNumber: string | null; readonly fiscalCode: string | null; readonly email: string | null }
  readonly shipTo: (PostalAddress & { readonly name?: string | null }) | null
  readonly lines: readonly ConfirmationLine[]
  readonly totals: { readonly net: MinorUnits; readonly vat: readonly { readonly rate: string | null; readonly nature: string | null; readonly taxable: MinorUnits; readonly vat: MinorUnits }[]; readonly gross: MinorUnits }
  readonly deposit: { readonly amount: MinorUnits; readonly kind: string } | null
}

/** The number a version prints: the order's number and the version. */
export const confirmationNumber = (number: string, version: number): string => `${number} v${version}`

const WORDS = {
  it: {
    sizes: 'Taglie',
    pieces: 'pz',
    deliveries: 'Consegne',
    season: (code: string, name: string) => `Stagione: ${code} - ${name}.`,
    complete: 'Spedizione completa: tutto parte insieme.',
    deposit: (amount: string) => `Acconto richiesto: ${amount}.`,
    confirm: "Con questo documento confermiamo l'ordine alle condizioni indicate. Vi preghiamo di segnalarci subito ogni differenza.",
  },
  en: {
    sizes: 'Sizes',
    pieces: 'pcs',
    deliveries: 'Deliveries',
    season: (code: string, name: string) => `Season: ${code} - ${name}.`,
    complete: 'Ship complete: everything leaves together.',
    deposit: (amount: string) => `Deposit asked: ${amount}.`,
    confirm: 'With this document we confirm the order on the terms shown. Please tell us at once of any difference.',
  },
} as const

const discountOf = (line: Pick<ConfirmationLine, 'unitPrice' | 'listUnitPrice'>): string | null => {
  if (line.listUnitPrice === null) return null
  const list = new Dec(line.listUnitPrice)
  const price = new Dec(line.unitPrice)
  if (!list.gt(0) || !price.lt(list)) return null
  return decimalText(roundTo(list.minus(price).dividedBy(list).times(HUNDRED), { scale: 2, rounding: 'HALF_UP' }))
}

/** The document of the fixed ORDER_CONFIRMATION layout (documents/compose), without the company's letterhead. */
export function confirmationDocument(order: CustomerOrder, money: (minor: MinorUnits) => string): Omit<DocumentInput, 'company' | 'sample'> {
  const words = WORDS[order.language]
  const lines: DocumentLine[] = order.lines.map((line) => ({
    code: line.code,
    description: [
      line.description,
      ...(line.sizes.length > 0 ? [`${words.sizes}: ${sizesText(line.sizes, order.currency, order.language)}`] : []),
      ...(line.ppe ? [line.ppe] : []),
      ...(line.deliveries.length > 0 ? [`${words.deliveries}: ${line.deliveries.map((delivery) => `${delivery.date} × ${delivery.quantity}`).join(' · ')}`] : []),
      ...(line.note ? [line.note] : []),
    ].join(' — '),
    quantity: String(line.quantity),
    uom: words.pieces,
    unitPrice: line.unitPrice,
    discountPercent: discountOf(line),
    amountMinor: lineAmountOf(line, order.priceBasis),
    // B-W2b-374: printed after the description (layout ORDER_CONFIRMATION/2).
    options: line.options ?? null,
  }))
  const references: DocumentReference[] = [
    ...(order.customerRef ? [{ kind: 'CUSTOMER_ORDER' as const, number: order.customerRef }] : []),
    ...(order.quoteNumber ? [{ kind: 'QUOTE' as const, number: order.quoteNumber }] : []),
    { kind: 'SALES_ORDER', number: order.number, date: order.orderDate },
  ]
  const notes = [
    ...(order.season ? [words.season(order.season.code, order.season.name)] : []),
    ...(order.shipComplete ? [words.complete] : []),
    ...(order.deposit ? [words.deposit(money(order.deposit.amount))] : []),
    words.confirm,
  ].join('\n')
  return {
    type: 'ORDER_CONFIRMATION',
    language: order.language,
    number: confirmationNumber(order.number, order.version),
    date: order.date,
    currency: order.currency,
    party: { name: order.party.name, address: order.party.address, vatNumber: order.party.vatNumber, fiscalCode: order.party.fiscalCode, email: order.party.email },
    references,
    lines,
    totals: {
      netMinor: order.totals.net,
      vat: order.totals.vat.map((entry) => ({ rate: entry.rate ?? '0', nature: entry.nature, taxableMinor: entry.taxable, vatMinor: entry.vat })),
      grossMinor: order.totals.gross,
    },
    deliveryDate: order.promiseDate,
    deliverTo: order.shipTo,
    paymentTerms: order.paymentTerms,
    deliveryTerms: order.deliveryTerms,
    notes,
  }
}

/** The contents' fingerprint (SHA-256 hex): the order as printed, without the day and the version number. */
export function confirmationFingerprint(order: CustomerOrder): string {
  const { date: _date, version: _version, ...contents } = order
  return createHash('sha256').update(`order-confirmation/1 ${canonicalJson(contents)}`).digest('hex')
}

/** The mail that carries a confirmation, in the order's language (the office may write its own words). */
export function confirmationMail(input: { readonly language: DocumentLanguage; readonly number: string; readonly recipientName: string | null; readonly message: string | null }): { readonly subject: string; readonly body: string } {
  if (input.language === 'it') {
    const opening = input.message?.trim() ? input.message.trim() : `${input.recipientName ? `Gentile ${input.recipientName},` : 'Buongiorno,'}\n\nin allegato la conferma del vostro ordine ${input.number}. Vi preghiamo di controllarla e di segnalarci subito ogni differenza.`
    return { subject: `Conferma d'ordine ${input.number}`, body: opening }
  }
  const opening = input.message?.trim() ? input.message.trim() : `${input.recipientName ? `Dear ${input.recipientName},` : 'Hello,'}\n\nplease find attached the confirmation of your order ${input.number}. Please check it and tell us at once of any difference.`
  return { subject: `Order confirmation ${input.number}`, body: opening }
}

/** The PPE words of a style ("PPE cat. II · EN 17092-4 · class AA"); null for a garment that is not PPE. */
export function ppeWords(style: { readonly ppeCategory: string; readonly ppeStandard: string | null; readonly ppeClass: string | null }, language: DocumentLanguage): string | null {
  const category = { CATEGORY_I: 'I', CATEGORY_II: 'II', CATEGORY_III: 'III' }[style.ppeCategory as 'CATEGORY_I' | 'CATEGORY_II' | 'CATEGORY_III']
  if (!category) return null
  const parts = [language === 'it' ? `DPI cat. ${category}` : `PPE cat. ${category}`, ...(style.ppeStandard ? [style.ppeStandard] : []), ...(style.ppeClass ? [language === 'it' ? `classe ${style.ppeClass}` : `class ${style.ppeClass}`] : [])]
  return parts.join(' · ')
}

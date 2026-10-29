import type { CurrencyCode, MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import { currencySign, formatDate, formatDateTime, formatUnitPrice } from '../../documents/format'
import type { DocumentInput, DocumentLanguage, DocumentLine } from '../../documents/model'
import type { PartyTaxMode } from '../../parties/tax'
import { decimalText, roundTo } from '../../product/units/units'
import type { PriceBasis } from '../../tax/vat-summary'
import type { DepositKind } from './quotes'
import type { BillToSnapshot, ShipToSnapshot } from './send'
import { clausesText, type QuoteTerms } from './terms'

/**
 * The quote the customer receives (B-W1-24; SAL-157, SAL-192; GAP-001, GAP-008), pure: one model of a frozen version —
 * its lines with their size grids and prices on the version's basis, the totals, the deposit, the terms — from which the
 * PDF (the documents' fixed QUOTE layout) and the link page are both made, so the page shows exactly what the PDF says.
 * Prices only: no cost, margin or internal note can reach it (the API builds it from price columns alone).
 *
 * The document number is the quote's number and its version ("Q-2026-0001 v2"); the date the day it was sent. A
 * consumer's lines show VAT-inclusive prices and amounts (Codice del Consumo art. 49), a business's net ones; the totals
 * show the net, the VAT per rate or nature and the gross either way.
 */

export interface CustomerSize {
  readonly size: string
  readonly quantity: number
  /** The size's own price on the version's basis, when it differs from the line's. */
  readonly unitPrice: string | null
}

export interface CustomerLine {
  readonly seq: number
  /** The style's code and the colourway's (`JKT-01 BLK`). */
  readonly code: string
  readonly description: string
  readonly note: string | null
  readonly quantity: number
  /** On the version's price basis. */
  readonly unitPrice: string
  readonly listUnitPrice: string | null
  readonly discountPct: string | null
  readonly netAmount: MinorUnits
  readonly vatAmount: MinorUnits
  readonly vatRatePct: string
  readonly vatNature: string | null
  readonly sizes: readonly CustomerSize[]
}

export interface CustomerVat {
  /** "22.00", or null for a nature (N3.2 …). */
  readonly rate: string | null
  readonly nature: string | null
  readonly taxable: MinorUnits
  readonly vat: MinorUnits
}

export interface CustomerQuote {
  readonly number: string
  readonly revision: number
  /** The day it was sent: the document's date. */
  readonly date: BusinessDate
  readonly language: DocumentLanguage
  readonly currency: CurrencyCode
  readonly priceBasis: PriceBasis
  readonly taxMode: PartyTaxMode
  readonly customerRef: string | null
  readonly validUntil: BusinessDate
  readonly firmOffer: boolean
  readonly promiseDate: BusinessDate | null
  readonly paymentTerms: string | null
  readonly billTo: BillToSnapshot
  readonly shipTo: ShipToSnapshot
  readonly contact: { readonly name: string; readonly email: string | null } | null
  readonly lines: readonly CustomerLine[]
  readonly totals: { readonly net: MinorUnits; readonly vat: readonly CustomerVat[]; readonly gross: MinorUnits }
  readonly deposit: { readonly pct: string; readonly kind: DepositKind; readonly amount: MinorUnits } | null
  readonly noWithdrawal: boolean
  readonly terms: QuoteTerms
}

/** The number a version prints: the quote's number and the version. */
export const quoteDocumentNumber = (number: string, revision: number): string => `${number} v${revision}`

const SIZE_WORDS = { it: { sizes: 'Taglie', pieces: 'pz' }, en: { sizes: 'Sizes', pieces: 'pcs' } } as const

/** A size grid as printed: "50×2 · 52×4 · 54×2", a size's own price beside it ("54×2 (€ 470,00)"). */
export function sizesText(sizes: readonly CustomerSize[], currency: CurrencyCode, language: DocumentLanguage): string {
  const sign = currencySign(currency)
  return sizes.map((row) => `${row.size}×${row.quantity}${row.unitPrice === null ? '' : ` (${sign} ${formatUnitPrice(row.unitPrice, language)})`}`).join(' · ')
}

/** A line's amount as the document prints it: VAT included on a GROSS basis, net otherwise. */
export const lineAmountOf = (line: Pick<CustomerLine, 'netAmount' | 'vatAmount'>, basis: PriceBasis): MinorUnits => (basis === 'GROSS' ? line.netAmount + line.vatAmount : line.netAmount)

/** The document of the fixed QUOTE layout (documents/compose) for a frozen version, without the company's letterhead. */
export function quoteDocument(quote: CustomerQuote): Omit<DocumentInput, 'company' | 'sample'> {
  const words = SIZE_WORDS[quote.language]
  const lines: DocumentLine[] = quote.lines.map((line) => ({
    code: line.code,
    description: [line.description, `${words.sizes}: ${sizesText(line.sizes, quote.currency, quote.language)}`, ...(line.note ? [line.note] : [])].join(' — '),
    quantity: String(line.quantity),
    uom: words.pieces,
    unitPrice: line.unitPrice,
    discountPercent: line.discountPct === null ? null : decimalText(roundTo(line.discountPct, { scale: 2, rounding: 'HALF_UP' })),
    amountMinor: lineAmountOf(line, quote.priceBasis),
  }))
  return {
    type: 'QUOTE',
    language: quote.language,
    number: quoteDocumentNumber(quote.number, quote.revision),
    date: quote.date,
    currency: quote.currency,
    party: {
      name: quote.billTo.legalName,
      address: quote.billTo.address,
      vatNumber: quote.billTo.vatNumber ?? null,
      fiscalCode: quote.billTo.fiscalCode ?? null,
      email: quote.contact?.email ?? null,
    },
    references: quote.customerRef ? [{ kind: 'CUSTOMER_ORDER', number: quote.customerRef }] : [],
    lines,
    totals: {
      netMinor: quote.totals.net,
      vat: quote.totals.vat.map((entry) => ({ rate: entry.rate ?? '0', nature: entry.nature, taxableMinor: entry.taxable, vatMinor: entry.vat })),
      grossMinor: quote.totals.gross,
    },
    validUntil: quote.validUntil,
    paymentTerms: quote.paymentTerms,
    notes: clausesText(quote.terms),
  }
}

// ---- the mail ---------------------------------------------------------------------------------------------------------

const MAIL = {
  it: {
    subject: (number: string) => `Offerta ${number}`,
    hello: (name: string | null) => (name ? `Gentile ${name},` : 'Buongiorno,'),
    intro: (number: string, until: string) => `le inviamo la nostra offerta ${number}, valida fino al ${until}: il documento è in allegato.`,
    again: (number: string, until: string) => `le inviamo un nuovo link personale per l'offerta ${number}, valida fino al ${until}: il documento è in allegato.`,
    linkStored: (until: string) => `Per accettarla o rifiutarla usi il link personale contenuto nell'e-mail inviata (valido fino al ${until}).`,
    link: (until: string) => `Per accettarla o rifiutarla apra questo link personale (valido fino al ${until}); le chiederemo di digitare nome e cognome:`,
    confirmSubject: (number: string) => `Conferma di accettazione dell'offerta ${number}`,
    confirmed: (number: string, at: string, name: string) => `grazie: abbiamo ricevuto l'accettazione dell'offerta ${number} il ${at}, a nome di ${name}. In allegato l'offerta accettata con le sue condizioni.`,
  },
  en: {
    subject: (number: string) => `Quotation ${number}`,
    hello: (name: string | null) => (name ? `Dear ${name},` : 'Hello,'),
    intro: (number: string, until: string) => `please find attached our quotation ${number}, valid until ${until}.`,
    again: (number: string, until: string) => `here is a new personal link for our quotation ${number}, valid until ${until}; the document is attached.`,
    linkStored: (until: string) => `To accept or decline it, use the personal link in the e-mail we sent (valid until ${until}).`,
    link: (until: string) => `To accept or decline it, open this personal link (valid until ${until}); we will ask you to type your full name:`,
    confirmSubject: (number: string) => `Acceptance of quotation ${number} confirmed`,
    confirmed: (number: string, at: string, name: string) => `thank you: we received the acceptance of quotation ${number} on ${at}, in the name of ${name}. The accepted quotation and its terms are attached.`,
  },
} as const

export interface QuoteMailInput {
  readonly language: DocumentLanguage
  /** The document number (`Q-2026-0001 v2`). */
  readonly number: string
  readonly validUntil: BusinessDate
  /** The link's last day. */
  readonly linkUntil: BusinessDate
  readonly recipientName: string | null
  /** The office's own words; null: the standard text. */
  readonly message: string | null
  readonly resend: boolean
}

export interface QuoteMail {
  readonly subject: string
  /** What the thread keeps: the mail's text WITHOUT the link (a bearer token is never stored). */
  readonly stored: string
  /** The mail's text with the link, made in memory just before it is sent. */
  withLink(url: string): string
}

/** The quote mail: the record thread keeps it without the link; only the mail sent holds it. */
export function quoteMail(input: QuoteMailInput): QuoteMail {
  const words = MAIL[input.language]
  const until = formatDate(input.validUntil, input.language)
  const linkUntil = formatDate(input.linkUntil, input.language)
  const opening = input.message?.trim() ? input.message.trim() : `${words.hello(input.recipientName)}\n\n${input.resend ? words.again(input.number, until) : words.intro(input.number, until)}`
  return {
    subject: words.subject(input.number),
    stored: `${opening}\n\n${words.linkStored(linkUntil)}`,
    withLink: (url) => `${opening}\n\n${words.link(linkUntil)}\n${url}`,
  }
}

/** The confirmation of an acceptance (SAL-093; Codice del Consumo art. 51 c.7: the contract confirmed on a durable medium). */
export function acceptanceMail(input: {
  readonly language: DocumentLanguage
  readonly number: string
  readonly acceptedAt: Date
  readonly timeZone: string
  readonly signerName: string
  /** The deposit's payment instructions in words (sales/deposits), or null. */
  readonly depositText: string | null
}): { readonly subject: string; readonly body: string } {
  const words = MAIL[input.language]
  const at = formatDateTime(input.acceptedAt, input.timeZone, input.language)
  const body = [words.hello(input.signerName), words.confirmed(input.number, at, input.signerName), ...(input.depositText ? [input.depositText] : [])].join('\n\n')
  return { subject: words.confirmSubject(input.number), body }
}

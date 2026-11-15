import { createHash } from 'node:crypto'
import { canonicalJson } from '../accounting/manifest'
import type { BusinessDate } from '../core/time'
import { formatDate, formatPercent, formatUnitPrice } from '../documents/format'
import type { DocumentLanguage } from '../documents/model'
import type { EightDCompany, EightDReport, EightDSection, EightDTable } from '../quality/capa/report'

/**
 * The price list PDF kept for mail (B-W2b-380, XF6:01; design sales.pricelists tab pricelists.pdf "Sent to a customer or
 * printed for a fair"), pure: one price list version on A4, painted by the CAPA module's report renderer (letterhead, facts,
 * sections, legal footer) — what the browser's print view (SCR-420) shows: the list, its version and days, its currency and
 * kind, whether its documents show the discount; every price with its own days; the quantity breaks; the size surcharges.
 * Never a cost or a margin. A version per price list version (GeneratedDocument PRICE_LIST 1, 2, …; recordType
 * PriceListVersion), its file a StoredFile of the version, so a mail attaches that same file; its fingerprint is everything
 * it prints but the day and the PDF's own version.
 */

export const PRICE_LIST_PDF_KIND = 'PRICE_LIST' as const
export const PRICE_LIST_PDF_RECORD = 'PriceListVersion' as const

export interface PriceListPdfPrice {
  /** "SEED-JKT-01 · Giacca": the style's code and name. */
  readonly style: string
  /** The colourway's code and name; null: every colourway of the style. */
  readonly colourway: string | null
  readonly validFrom: BusinessDate | null
  readonly validTo: BusinessDate | null
  /** Net, per piece, in the list's currency (a decimal string). */
  readonly unitPrice: string
}

export interface PriceListPdfBreak {
  /** The price it lowers ("SEED-JKT-01 · BLK"); null: every price of the version (a discount). */
  readonly of: string | null
  readonly minQuantity: number
  readonly unitPrice: string | null
  readonly discountPct: string | null
}

export interface PriceListPdfSurcharge {
  /** The style's code; null: every style of the version. */
  readonly style: string | null
  readonly size: string
  readonly amount: string | null
  readonly pct: string | null
}

export interface PriceListPdfInput {
  readonly language: DocumentLanguage
  /** The day it is printed. */
  readonly date: BusinessDate
  /** The PDF's own version (1, 2, … per price list version). */
  readonly version: number
  readonly company: EightDCompany
  readonly list: { readonly code: string; readonly name: string; readonly kind: 'BASE' | 'CUSTOMER' | 'GROUP' | 'CONTRACT'; readonly currency: string; readonly showDiscount: boolean }
  readonly priceVersion: { readonly revision: number; readonly draft: boolean; readonly validFrom: BusinessDate | null; readonly validTo: BusinessDate | null }
  readonly prices: readonly PriceListPdfPrice[]
  readonly breaks: readonly PriceListPdfBreak[]
  readonly surcharges: readonly PriceListPdfSurcharge[]
}

const WORDS = {
  it: {
    title: 'Listino prezzi',
    file: 'listino',
    list: 'Listino',
    version: 'Versione',
    versionOf: (revision: number, draft: boolean) => `${revision}${draft ? ' (bozza)' : ''}`,
    days: 'Validità',
    currency: 'Valuta',
    kind: 'Tipo',
    kinds: { BASE: 'Base', CUSTOMER: 'Cliente', GROUP: 'Gruppo', CONTRACT: 'Contratto' },
    discount: 'Sconto sui documenti',
    discountShown: 'Prezzo di listino e sconto',
    discountNet: 'Solo prezzo netto',
    printed: 'Stampato il',
    pdfVersion: 'Versione del PDF',
    prices: 'Prezzi',
    noPrices: 'Nessun prezzo in questa versione.',
    style: 'Modello',
    colourway: 'Variante',
    every: 'Ogni variante',
    valid: 'Validità',
    unitPrice: 'Prezzo unitario',
    fromTo: (from: string | null, to: string | null) => (from && to ? `dal ${from} al ${to}` : from ? `dal ${from}` : to ? `fino al ${to}` : 'Tutta la versione'),
    breaks: 'Sconti per quantità',
    noBreaks: 'Nessuno sconto per quantità.',
    of: 'Prezzo',
    everyPrice: 'Ogni prezzo',
    from: 'Da',
    pieces: (count: number) => `${count} pezzi`,
    breakValue: 'Prezzo o sconto',
    surcharges: 'Maggiorazioni per taglia',
    noSurcharges: 'Nessuna maggiorazione per taglia.',
    everyStyle: 'Ogni modello',
    size: 'Taglia',
    surcharge: 'Maggiorazione',
    netNote: 'Prezzi netti per pezzo, IVA esclusa.',
    page: (page: number, pages: number) => `Pagina ${page} di ${pages}`,
  },
  en: {
    title: 'Price list',
    file: 'price-list',
    list: 'Price list',
    version: 'Version',
    versionOf: (revision: number, draft: boolean) => `${revision}${draft ? ' (draft)' : ''}`,
    days: 'Valid',
    currency: 'Currency',
    kind: 'Kind',
    kinds: { BASE: 'Base', CUSTOMER: 'Customer', GROUP: 'Group', CONTRACT: 'Contract' },
    discount: 'Discount on documents',
    discountShown: 'List price and discount',
    discountNet: 'Net price only',
    printed: 'Printed on',
    pdfVersion: 'PDF version',
    prices: 'Prices',
    noPrices: 'No price in this version.',
    style: 'Style',
    colourway: 'Colourway',
    every: 'Every colourway',
    valid: 'Valid',
    unitPrice: 'Unit price',
    fromTo: (from: string | null, to: string | null) => (from && to ? `${from} to ${to}` : from ? `from ${from}` : to ? `until ${to}` : 'The whole version'),
    breaks: 'Quantity breaks',
    noBreaks: 'No quantity break.',
    of: 'Price',
    everyPrice: 'Every price',
    from: 'From',
    pieces: (count: number) => `${count} pieces`,
    breakValue: 'Price or discount',
    surcharges: 'Size surcharges',
    noSurcharges: 'No size surcharge.',
    everyStyle: 'Every style',
    size: 'Size',
    surcharge: 'Surcharge',
    netNote: 'Net prices per piece, VAT excluded.',
    page: (page: number, pages: number) => `Page ${page} of ${pages}`,
  },
} as const

const bySize = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true })

/** The number printed on a kept PDF ("LIST-P1 v2 · 1"): the list, its version and the PDF's own version. */
export const priceListPdfNumber = (code: string, revision: number, version: number): string => `${code} v${revision} · ${version}`

/** The report the renderer paints. */
export function priceListReport(input: PriceListPdfInput): EightDReport {
  const w = WORDS[input.language]
  const day = (date: BusinessDate | null) => (date ? formatDate(date, input.language) : null)
  const money = (value: string) => `${formatUnitPrice(value, input.language)} ${input.list.currency}`
  const number = priceListPdfNumber(input.list.code, input.priceVersion.revision, input.version)
  const facts = [
    { label: w.list, value: `${input.list.code} · ${input.list.name}` },
    { label: w.version, value: w.versionOf(input.priceVersion.revision, input.priceVersion.draft) },
    { label: w.days, value: w.fromTo(day(input.priceVersion.validFrom), day(input.priceVersion.validTo)) },
    { label: w.currency, value: input.list.currency },
    { label: w.kind, value: w.kinds[input.list.kind] },
    { label: w.discount, value: input.list.showDiscount ? w.discountShown : w.discountNet },
    { label: w.printed, value: formatDate(input.date, input.language) },
    { label: w.pdfVersion, value: String(input.version) },
  ]
  const prices: EightDTable = {
    columns: [
      { label: w.style, width: 0.36, align: 'left' },
      { label: w.colourway, width: 0.22, align: 'left' },
      { label: w.valid, width: 0.22, align: 'left' },
      { label: w.unitPrice, width: 0.2, align: 'right' },
    ],
    rows: input.prices.map((price) => [price.style, price.colourway ?? w.every, w.fromTo(day(price.validFrom), day(price.validTo)), money(price.unitPrice)]),
  }
  const breaks: EightDTable = {
    columns: [
      { label: w.of, width: 0.48, align: 'left' },
      { label: w.from, width: 0.22, align: 'right' },
      { label: w.breakValue, width: 0.3, align: 'right' },
    ],
    rows: input.breaks.map((row) => [row.of ?? w.everyPrice, w.pieces(row.minQuantity), row.unitPrice !== null ? money(row.unitPrice) : `-${formatPercent(row.discountPct ?? '0', input.language)}`]),
  }
  const surcharges: EightDTable = {
    columns: [
      { label: w.style, width: 0.48, align: 'left' },
      { label: w.size, width: 0.22, align: 'left' },
      { label: w.surcharge, width: 0.3, align: 'right' },
    ],
    rows: [...input.surcharges]
      .sort((a, b) => (a.style === b.style ? bySize(a.size, b.size) : a.style === null ? -1 : b.style === null ? 1 : a.style.localeCompare(b.style)))
      .map((row) => [row.style ?? w.everyStyle, row.size, `+ ${row.amount !== null ? money(row.amount) : formatPercent(row.pct ?? '0', input.language)}`]),
  }
  const sections: EightDSection[] = [
    { heading: w.prices, lines: input.prices.length === 0 ? [w.noPrices] : [w.netNote], table: input.prices.length === 0 ? null : prices },
    { heading: w.breaks, lines: input.breaks.length === 0 ? [w.noBreaks] : [], table: input.breaks.length === 0 ? null : breaks },
    { heading: w.surcharges, lines: input.surcharges.length === 0 ? [w.noSurcharges] : [], table: input.surcharges.length === 0 ? null : surcharges },
  ]
  return {
    language: input.language,
    meta: { title: `${w.title} ${number}`, subject: `${input.list.code} v${input.priceVersion.revision}`, createdAt: `${input.date}T00:00:00.000Z` },
    title: w.title,
    sample: null,
    company: input.company,
    facts,
    sections,
    page: w.page,
    fileName: `${w.file}-${input.list.code.toLowerCase()}-v${input.priceVersion.revision}-${input.version}-${input.language}.pdf`,
  }
}

/** The contents' fingerprint (SHA-256 hex): everything the PDF prints but the day and the PDF's own version. */
export function priceListPdfFingerprint(input: PriceListPdfInput): string {
  const { date: _date, version: _version, ...contents } = input
  return createHash('sha256').update(`price-list-pdf/1 ${canonicalJson(contents)}`).digest('hex')
}

/** The mail that carries the kept PDF (the person's own message, else these words). */
export function priceListMail(input: { readonly language: DocumentLanguage; readonly code: string; readonly name: string; readonly revision: number; readonly message: string | null }): { readonly subject: string; readonly body: string } {
  if (input.language === 'it') {
    return { subject: `Listino prezzi ${input.code} - ${input.name}`, body: input.message?.trim() ? input.message.trim() : `Buongiorno,\n\nin allegato il nostro listino prezzi ${input.code} (versione ${input.revision}).` }
  }
  return { subject: `Price list ${input.code} - ${input.name}`, body: input.message?.trim() ? input.message.trim() : `Hello,\n\nplease find attached our price list ${input.code} (version ${input.revision}).` }
}

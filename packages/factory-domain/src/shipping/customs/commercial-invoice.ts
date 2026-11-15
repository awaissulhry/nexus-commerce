import { createHash } from 'node:crypto'
import { canonicalJson } from '../../accounting/manifest'
import { isCurrencyCode, toMinorUnits, type CurrencyCode, type DecimalString } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import type { CustomsFacts, DocumentInput, DocumentLanguage, DocumentLine, DocumentParty, DocumentReference, PostalAddress } from '../../documents/model'
import { Dec, parseDecimal } from '../../tax/decimal'
import { lineAmount } from '../../tax/vat-summary'
import { customsDescription } from '../proforma/rules'

/**
 * The commercial invoice of an export (B-W2b-409; LOG-086 "the customs invoice with HS codes, origin, values, Incoterm,
 * EORI, weights and currency, in the right language"; LOG-095 the company's EORI on it), pure. One per shipment going outside
 * the EU, as many versions as its contents change (GeneratedDocument COMMERCIAL_INVOICE of the Shipment, the documents
 * framework's type COMMERCIAL_INVOICE, layout COMMERCIAL_INVOICE/1):
 *
 *   lines     one per order line and price (sizes in the description), each with its style's HS code and country of
 *             origin (both required: customs classifies and values every line), the quantity, the unit value as the order
 *             sells it (net, in the order's currency) and the line's value; no VAT column (the export is non-taxable)
 *   facts     the exporter's EORI, why the goods travel, the Incoterm and place, where they go, the parcels, gross and net
 *             weights, the countries of origin; the order, the customer's PO, the shipment, the DDT and the issued invoice
 *   notices   the values are declared for customs (the tax invoice is the FatturaPA XML), and outside the EU the supply is
 *             non-taxable (art. 8 c. 1 lett. a DPR 633/1972)
 *
 * Its number is the shipment's own (no series: it is not a tax document); the issued invoice is named in its references when
 * there is one. The same contents and language give the newest version back (the fingerprint, without the day).
 */

/** The GeneratedDocument kind and the documents framework's type. */
export const COMMERCIAL_INVOICE_KIND = 'COMMERCIAL_INVOICE' as const

/** One line as the API reads it from the shipment (whole pieces; the unit value in the document's currency, net). */
export interface CustomsLineInput {
  readonly code: string | null
  /** The goods in words (style, colour, the sizes and their pieces). */
  readonly goods: string
  readonly hsCode: string | null
  readonly originCountry: string | null
  readonly quantity: number
  readonly uom: string
  /** Decimal(18,6), per piece, net; null: the order prices it nowhere (a refusal before anything is made). */
  readonly unitPrice: DecimalString | null
}

export interface CommercialInvoiceSource {
  readonly number: string
  readonly date: BusinessDate
  readonly language: DocumentLanguage
  readonly currency: CurrencyCode
  readonly party: DocumentParty
  readonly deliverTo?: (PostalAddress & { readonly name?: string | null }) | null
  readonly references: readonly DocumentReference[]
  readonly lines: readonly CustomsLineInput[]
  readonly deliveryTerms?: string | null
  readonly paymentTerms?: string | null
  readonly notes?: string | null
  readonly facts: CustomsFacts
}

/** The lines customs cannot read (no HS code, no origin) and those without a price, by their code or goods. */
export function customsLineProblems(lines: readonly CustomsLineInput[]): { readonly customsData: string[]; readonly unpriced: string[] } {
  const customsData: string[] = []
  const unpriced: string[] = []
  for (const line of lines) {
    const name = line.code ?? line.goods
    const missing = [...(line.hsCode?.trim() ? [] : ['HS code']), ...(line.originCountry && /^[A-Z]{2}$/i.test(line.originCountry.trim()) ? [] : ['country of origin'])]
    if (missing.length > 0) customsData.push(`${name}: no ${missing.join(' and no ')}`)
    const price = line.unitPrice === null ? null : parseDecimal(line.unitPrice)
    if (price === null || price.isNegative()) unpriced.push(name)
  }
  return { customsData: [...new Set(customsData)], unpriced: [...new Set(unpriced)] }
}

/** What stops the commercial invoice before anything is made (empty when nothing does), in words. */
export function commercialInvoiceProblems(source: Pick<CommercialInvoiceSource, 'currency' | 'lines'>): string[] {
  const problems: string[] = []
  if (!isCurrencyCode(source.currency)) problems.push('The order has no currency to value the goods in.')
  if (source.lines.length === 0) problems.push('The shipment has no garments yet: add its lines first.')
  for (const line of source.lines) if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) problems.push(`${line.code ?? line.goods}: the quantity must be at least 1.`)
  return problems
}

/** The commercial invoice as a document (without the company, which the API reads from its Company row). */
export function commercialInvoiceDocument(source: CommercialInvoiceSource): Omit<DocumentInput, 'company' | 'sample'> {
  const lines: DocumentLine[] = source.lines.map((line) => {
    const unit = new Dec(line.unitPrice ?? '0')
    return {
      code: line.code,
      description: customsDescription(line.goods, { hsCode: line.hsCode, originCountry: line.originCountry }, source.language),
      quantity: String(line.quantity),
      uom: line.uom,
      unitPrice: unit.toDecimalPlaces(6).toFixed(),
      amountMinor: toMinorUnits(lineAmount(unit, new Dec(line.quantity)), source.currency),
    }
  })
  const netMinor = lines.reduce((total, line) => total + (line.amountMinor ?? 0), 0)
  return {
    type: 'COMMERCIAL_INVOICE',
    language: source.language,
    number: source.number,
    date: source.date,
    currency: source.currency,
    party: source.party,
    references: source.references,
    lines,
    // No VAT: the values are what customs reads (the export's VAT, none, is the tax invoice's).
    totals: { netMinor, vat: [], grossMinor: netMinor },
    deliverTo: source.deliverTo ?? null,
    deliveryTerms: source.deliveryTerms ?? null,
    paymentTerms: source.paymentTerms ?? null,
    notes: source.notes ?? null,
    customs: source.facts,
  }
}

/** What a version shows, without its day (made again on another day with the same contents, it is the same). */
export function commercialInvoiceFingerprint(document: Omit<DocumentInput, 'company' | 'sample'>): string {
  const { date: _date, ...contents } = document
  return createHash('sha256').update(`commercial-invoice/1 ${canonicalJson(contents)}`).digest('hex')
}

/** The longest notes a person may add to a commercial invoice. */
export const COMMERCIAL_INVOICE_NOTES_MAX = 1000

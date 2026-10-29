import type { CurrencyCode } from '../core/money'
import type { BusinessDate } from '../core/time'
import type { DocumentInput, DocumentLanguage, DocumentLine, DocumentParty, DocumentReference, PostalAddress } from '../documents/model'
import { Dec, sum } from '../tax/decimal'

/**
 * A shipment's packing list (B-W1-46; LOG-039: one consignment of several boxes), the PACKING_LIST document of
 * factory-domain documents: per parcel, which garments it holds (style, colourway, size, batch, serials), the number of
 * parcels and their gross weight once every one is weighed, where they go. No price. The API adds the company's legal
 * data from its Company row (platform/documents storeDocumentPdf) and stores the PDF as a file of the shipment.
 */

export interface PackingListLine {
  readonly parcelId: string
  readonly styleCode: string
  readonly styleName: string
  readonly colourway: string
  readonly size: string
  readonly quantity: number
  readonly batchNumber: string | null
  readonly serials: readonly string[]
}

export interface PackingListInput {
  /** The shipment's number. */
  readonly number: string
  readonly date: BusinessDate
  readonly language: DocumentLanguage
  readonly currency: CurrencyCode
  readonly party: DocumentParty
  /** Where the goods go (the shipment's ship-to snapshot). */
  readonly shipTo: (PostalAddress & { readonly name?: string | null }) | null
  readonly salesOrderNumber: string
  readonly customerRef: string | null
  readonly parcels: readonly { readonly id: string; readonly seq: number; readonly grossWeightKg: string | null }[]
  readonly lines: readonly PackingListLine[]
}

const WORDS: Readonly<Record<DocumentLanguage, { readonly size: string; readonly batch: string; readonly serials: string }>> = {
  it: { size: 'taglia', batch: 'lotto', serials: 'matricole' },
  en: { size: 'size', batch: 'batch', serials: 'serials' },
}

/** The packing list as a document (without the company, which the API reads from its row). */
export function packingListDocument(input: PackingListInput): Omit<DocumentInput, 'company' | 'sample'> {
  const words = WORDS[input.language]
  const seqOf = new Map(input.parcels.map((parcel) => [parcel.id, parcel.seq]))
  const lines: DocumentLine[] = [...input.lines]
    .sort((a, b) => (seqOf.get(a.parcelId) ?? 0) - (seqOf.get(b.parcelId) ?? 0) || a.styleCode.localeCompare(b.styleCode) || a.colourway.localeCompare(b.colourway) || a.size.localeCompare(b.size, undefined, { numeric: true }))
    .map((line) => ({
      parcel: String(seqOf.get(line.parcelId) ?? ''),
      code: line.styleCode,
      description: [
        `${line.styleName}, ${line.colourway}, ${words.size} ${line.size}`,
        ...(line.batchNumber ? [`${words.batch} ${line.batchNumber}`] : []),
        ...(line.serials.length > 0 ? [`${words.serials} ${[...line.serials].sort().join(', ')}`] : []),
      ].join(' - '),
      quantity: String(line.quantity),
      uom: 'PCS',
    }))
  const weights = input.parcels.map((parcel) => parcel.grossWeightKg)
  const weighed = weights.length > 0 && weights.every((weight) => weight !== null)
  const references: DocumentReference[] = [
    { kind: 'SALES_ORDER', number: input.salesOrderNumber },
    ...(input.customerRef ? [{ kind: 'CUSTOMER_ORDER' as const, number: input.customerRef }] : []),
  ]
  return {
    type: 'PACKING_LIST',
    language: input.language,
    number: input.number,
    date: input.date,
    currency: input.currency,
    party: input.party,
    references,
    lines,
    packing: {
      packages: input.parcels.length,
      grossWeightKg: weighed ? sum(weights.map((weight) => new Dec(weight ?? 0))).toFixed(4) : null,
      shipTo: input.shipTo,
    },
  }
}

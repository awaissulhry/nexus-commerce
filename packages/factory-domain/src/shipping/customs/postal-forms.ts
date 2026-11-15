import { createHash } from 'node:crypto'
import { canonicalJson } from '../../accounting/manifest'
import type { CurrencyCode, DecimalString, MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import type { DocumentLanguage } from '../../documents/model'
import type { ExportReason, PostalForm } from './rules'

/**
 * The postal customs declaration of each parcel of an export (B-W2b-409; LOG-087 "CN22 or CN23 for postal parcels outside the
 * EU by value and weight"), pure: the UPU forms CN 22 (a small packet: contents up to the CN 22 limit, rules.ts postalFormOf)
 * and CN 23 (a parcel, or contents worth more; always accepted), one page per parcel, painted by apps/factory-api
 * platform/print/layouts/cn22.ts. GeneratedDocument CN22 or CN23 of the Shipment keeps each version.
 *
 *   both    the category (gift, commercial sample, documents, returned goods, sale of goods, other with its words), per item
 *           its description, quantity, net weight and value, its HS code and country of origin; the parcel's gross weight
 *           and total value; the sender's declaration, the date and a line for the signature
 *   CN 23   also the sender (with its EORI, the customs reference) and the addressee in full, the invoice's number, comments
 *
 * The form's title carries the UPU's French words beside the document's language (the forms are read by any post office).
 */

/** One item of a parcel: a style and colour with its pieces, the net weight of those pieces and their value. */
export interface PostalItem {
  readonly description: string
  readonly quantity: number
  /** Net weight of the item's pieces in kilograms, Decimal(18,4). */
  readonly netKg: DecimalString
  readonly valueMinor: MinorUnits
  readonly hsCode: string
  readonly originCountry: string
}

export interface PostalParcel {
  /** The parcel's number on the shipment (1, 2…) and how many the shipment has. */
  readonly seq: number
  readonly grossKg: DecimalString
  readonly items: readonly PostalItem[]
}

export interface PostalPartyLines {
  readonly name: string
  /** The address in print lines. */
  readonly lines: readonly string[]
}

export interface PostalFormDocument {
  readonly form: PostalForm
  readonly language: DocumentLanguage
  /** The shipment's number. */
  readonly number: string
  readonly date: BusinessDate
  readonly currency: CurrencyCode
  readonly sender: PostalPartyLines & { readonly eori: string }
  readonly addressee: PostalPartyLines
  readonly reason: ExportReason
  readonly reasonText: string | null
  /** The issued invoice's number, else the commercial invoice's (the shipment's): CN 23 only. */
  readonly invoiceNumber: string | null
  readonly comments: string | null
  readonly parcels: readonly PostalParcel[]
}

/** What a version shows, without its day. */
export function postalFormFingerprint(document: PostalFormDocument): string {
  const { date: _date, ...contents } = document
  return createHash('sha256').update(`postal-form/1 ${canonicalJson(contents)}`).digest('hex')
}

/** A parcel's total value (minor units). */
export const parcelValueMinor = (parcel: PostalParcel): MinorUnits => parcel.items.reduce((total, item) => total + item.valueMinor, 0)

/** The layout version printed (platform/print/layouts/cn22.ts). */
export const POSTAL_FORM_LAYOUT = Object.freeze({ CN22: 'CN22/1', CN23: 'CN23/1' } as const satisfies Record<PostalForm, string>)

/** The longest comments a person may add to a CN 23. */
export const POSTAL_COMMENTS_MAX = 300

export interface PostalFormWords {
  readonly title: Readonly<Record<PostalForm, string>>
  readonly parcel: (seq: number, of: number) => string
  readonly shipment: string
  readonly sender: string
  readonly addressee: string
  readonly eori: string
  readonly category: string
  readonly reasons: Readonly<Record<ExportReason, string>>
  readonly explanation: string
  readonly description: string
  readonly quantity: string
  readonly netWeight: string
  readonly value: string
  readonly hsCode: string
  readonly origin: string
  readonly totalGross: string
  readonly totalValue: string
  readonly invoice: string
  readonly comments: string
  readonly declaration: string
  readonly dateSignature: string
}

export const POSTAL_FORM_WORDS: Readonly<Record<DocumentLanguage, PostalFormWords>> = Object.freeze({
  it: {
    title: { CN22: 'CN 22 - DÉCLARATION EN DOUANE / DICHIARAZIONE DOGANALE', CN23: 'CN 23 - DÉCLARATION EN DOUANE / DICHIARAZIONE DOGANALE' },
    parcel: (seq, of) => `Collo ${seq} di ${of}`,
    shipment: 'Spedizione',
    sender: 'Mittente',
    addressee: 'Destinatario',
    eori: 'Riferimento doganale del mittente (EORI)',
    category: 'Categoria',
    reasons: { SALE_OF_GOODS: 'Vendita di merci', COMMERCIAL_SAMPLE: 'Campione commerciale', RETURNED_GOODS: 'Merce resa', GIFT: 'Regalo', DOCUMENTS: 'Documenti', OTHER: 'Altro' },
    explanation: 'Spiegazione',
    description: 'Descrizione dettagliata del contenuto',
    quantity: 'Quantità',
    netWeight: 'Peso netto (kg)',
    value: 'Valore',
    hsCode: 'Voce tariffale SA',
    origin: 'Paese di origine',
    totalGross: 'Peso lordo totale (kg)',
    totalValue: 'Valore totale',
    invoice: 'Fattura n.',
    comments: 'Osservazioni',
    declaration:
      'Certifico che le indicazioni di questa dichiarazione doganale sono esatte e che questo invio non contiene oggetti pericolosi o vietati dalla normativa o dalle regole postali o doganali.',
    dateSignature: 'Data e firma del mittente',
  },
  en: {
    title: { CN22: 'CN 22 - DÉCLARATION EN DOUANE / CUSTOMS DECLARATION', CN23: 'CN 23 - DÉCLARATION EN DOUANE / CUSTOMS DECLARATION' },
    parcel: (seq, of) => `Parcel ${seq} of ${of}`,
    shipment: 'Shipment',
    sender: 'Sender',
    addressee: 'Addressee',
    eori: "Sender's customs reference (EORI)",
    category: 'Category of item',
    reasons: { SALE_OF_GOODS: 'Sale of goods', COMMERCIAL_SAMPLE: 'Commercial sample', RETURNED_GOODS: 'Returned goods', GIFT: 'Gift', DOCUMENTS: 'Documents', OTHER: 'Other' },
    explanation: 'Explanation',
    description: 'Detailed description of contents',
    quantity: 'Quantity',
    netWeight: 'Net weight (kg)',
    value: 'Value',
    hsCode: 'HS tariff number',
    origin: 'Country of origin',
    totalGross: 'Total gross weight (kg)',
    totalValue: 'Total value',
    invoice: 'Invoice No.',
    comments: 'Comments',
    declaration:
      'I certify that the particulars given in this customs declaration are correct and that this item does not contain any dangerous article or articles prohibited by legislation or by postal or customs regulations.',
    dateSignature: "Date and sender's signature",
  },
})

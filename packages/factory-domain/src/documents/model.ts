import type { BusinessDate } from '../core/time'
import type { CurrencyCode, DecimalString, MinorUnits } from '../core/money'

/**
 * The document model (plan A1 §3.9; GAP-008): what a printed company document says, before any layout. A module that
 * issues a document (a quote sent, a purchase order sent, a DDT issued, an invoice issued) builds one of these from its
 * frozen record, and `composeDocument` (./compose.ts) turns it into the fixed layout of its type in Italian or English:
 *
 *   header      the company's letterhead with its legal data (c.c. art. 2250), the title, number and date
 *   parties     the other party (customer or supplier), a place of delivery, a carrier
 *   facts       what the type needs beside the lines: a quote's validity, a PO's delivery, the DDT's transport (DPR
 *               472/1996), the invoice's SDI identity
 *   lines       goods or services, with prices where the type shows them (a DDT shows none)
 *   totals      net, VAT per rate, total (not on a DDT)
 *   notes       free text of the issuer; fixed notices of the type (the invoice copy's "courtesy copy")
 *   footer      the company's legal line again, on every page (art. 2250: on every document and letter)
 *
 * Pure data: amounts are minor units, unit prices, rates and quantities decimal strings (never floats); dates are
 * business dates (`YYYY-MM-DD`), the start of a transport an instant (ISO 8601 with a zone).
 */

/**
 * The fixed layouts (GAP-008). The invoice is a COPY: the legal invoice is the FatturaPA XML sent through SDI. The
 * packing list (B-W1-46, LOG-039) says which garments are in which parcel of a shipment: no prices, not a fiscal document.
 */
export const DOCUMENT_TYPES = ['QUOTE', 'PURCHASE_ORDER', 'DDT', 'INVOICE_COPY', 'PACKING_LIST'] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]

/** The languages every layout is printed in. */
export const DOCUMENT_LANGUAGES = ['it', 'en'] as const
export type DocumentLanguage = (typeof DOCUMENT_LANGUAGES)[number]

export const isDocumentType = (value: unknown): value is DocumentType => typeof value === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(value)
export const isDocumentLanguage = (value: unknown): value is DocumentLanguage =>
  typeof value === 'string' && (DOCUMENT_LANGUAGES as readonly string[]).includes(value)

/** An address as the Company and Site rows keep it (`address` JSON). */
export interface PostalAddress {
  readonly line1: string
  readonly line2?: string | null
  readonly postalCode: string
  readonly city: string
  /** Italian province code (MI, BO…). */
  readonly province?: string | null
  /** ISO 3166-1 alpha-2. */
  readonly country: string
}

/**
 * The issuing company's legal data, read from its Company row (never from a request). Codice civile art. 2250: the
 * documents and letters of a company in the Registro delle imprese show its registered office, the register office and
 * the registration number; a S.p.A., S.a.p.a. or S.r.l. also its share capital as actually paid in, whether it has a
 * single shareholder, and whether it is in liquidation. The VAT number is on every document too (DPR 633/1972 art. 35).
 */
export interface CompanyLegal {
  readonly legalName: string
  readonly tradeName?: string | null
  /** The registered office (sede legale). */
  readonly address: PostalAddress | null
  /** Partita IVA with its country prefix (IT12345670009). */
  readonly vatNumber: string | null
  /** Codice fiscale; for a company also its number in the Registro delle imprese. */
  readonly fiscalCode: string | null
  /** The Registro delle imprese office (a province code) and the REA number. */
  readonly reaOffice: string | null
  readonly reaNumber: string | null
  /** Share capital as actually paid in, in the company's currency; null when the company has none to show. */
  readonly shareCapital: DecimalString | null
  readonly currency: CurrencyCode
  /** Art. 2250 c. 4: a S.p.A. or S.r.l. with one shareholder says so. Unknown (not recorded): nothing is printed. */
  readonly soleShareholder?: boolean | null
  /** Art. 2250 c. 3: a company in liquidation says so. */
  readonly inLiquidation?: boolean | null
  readonly pec?: string | null
  /** The company's own footer text (Company.documentFooter): printed under the legal line. */
  readonly documentFooter?: string | null
}

/** The other party: the customer of a quote, DDT or invoice; the supplier of a purchase order. */
export interface DocumentParty {
  readonly name: string
  readonly address: PostalAddress | null
  readonly vatNumber?: string | null
  readonly fiscalCode?: string | null
  /** FatturaPA codice destinatario (invoice copy). */
  readonly sdiCode?: string | null
  readonly pec?: string | null
  readonly email?: string | null
}

/** One line. The type's layout decides which columns it shows. */
export interface DocumentLine {
  readonly code?: string | null
  /** For a DDT: the nature and quality of the goods (DPR 472/1996). */
  readonly description: string
  /** Decimal(18,4). */
  readonly quantity: DecimalString
  /** Unit of measure code (PCS, M2, PAIR…), printed as given. */
  readonly uom: string
  /** Decimal(18,6), in the document's currency. */
  readonly unitPrice?: DecimalString | null
  /** A line discount in percent, e.g. "10" or "12.5". */
  readonly discountPercent?: DecimalString | null
  /** The line's amount after discount, minor units. */
  readonly amountMinor?: MinorUnits | null
  /** VAT rate in percent ("22", "0"); with `vatNature` (FatturaPA Natura, N3.2…) when no VAT applies. */
  readonly vatRate?: DecimalString | null
  readonly vatNature?: string | null
  /** A purchase order line's requested delivery date. */
  readonly deliveryDate?: BusinessDate | null
  /** PACKING_LIST: the parcel (collo) the line is packed in, as printed ("1", "2"). */
  readonly parcel?: string | null
}

/** One VAT rate of the totals. */
export interface VatSummary {
  readonly rate: DecimalString
  /** FatturaPA Natura when the rate is 0 (N3.2 intra-EU, N3.1 export…). */
  readonly nature?: string | null
  readonly taxableMinor: MinorUnits
  readonly vatMinor: MinorUnits
}

/** The totals, computed by the issuing module (one rounding point, A1 §2.1); the layout only prints them. */
export interface DocumentTotals {
  readonly netMinor: MinorUnits
  readonly vat: readonly VatSummary[]
  readonly grossMinor: MinorUnits
  /** A deposit already invoiced and deducted (invoice copy). */
  readonly depositMinor?: MinorUnits | null
  /** What is left to pay, when it differs from the gross. */
  readonly dueMinor?: MinorUnits | null
}

/** Why the goods travel (causale del trasporto). OTHER needs its words in `reasonText`. */
export const DDT_REASONS = ['SALE', 'WORK_ON_ACCOUNT', 'RETURN_FROM_WORK', 'RETURN', 'ON_APPROVAL', 'REPAIR', 'SAMPLE', 'TRANSFER', 'OTHER'] as const
export type DdtReason = (typeof DDT_REASONS)[number]

/** Who carries the goods (trasporto a cura del). CARRIER needs the carrier. */
export const DDT_TRANSPORT_BY = ['SENDER', 'RECIPIENT', 'CARRIER'] as const
export type DdtTransportBy = (typeof DDT_TRANSPORT_BY)[number]

/** Porto: free (franco, the sender pays the carriage) or forward (assegnato, the recipient pays). */
export const DDT_FREIGHT = ['FREE', 'FORWARD'] as const
export type DdtFreight = (typeof DDT_FREIGHT)[number]

/**
 * The transport of a DDT (DPR 472/1996 art. 1 c. 3, with DPR 627/1978): beside the number, the date, the sender, the
 * recipient and the goods (nature, quality, quantity), the reason, who carries them (and the carrier's identity), the
 * start of the transport, the external appearance of the goods, the number of packages and the weight.
 */
export interface DdtTransport {
  readonly reason: DdtReason
  readonly reasonText?: string | null
  readonly transportBy: DdtTransportBy
  readonly carrier?: { readonly name: string; readonly address?: PostalAddress | null; readonly vatNumber?: string | null } | null
  /** When the transport starts (data e ora di inizio trasporto): an instant, printed in the company's zone. */
  readonly startAt: string
  /** External appearance of the goods (aspetto esteriore dei beni): boxes, pallets, rolls… */
  readonly appearance: string
  /** Number of packages (numero colli), at least 1. */
  readonly packages: number
  /** Gross weight in kilograms, Decimal(18,4). */
  readonly grossWeightKg: DecimalString
  readonly netWeightKg?: DecimalString | null
  readonly freight?: DdtFreight | null
  /** The place of delivery when it is not the recipient's address (luogo di destinazione). */
  readonly destination?: (PostalAddress & { readonly name?: string | null }) | null
}

/** What a packing list says beside its lines (B-W1-46, LOG-039). */
export interface PackingFacts {
  /** Number of parcels, at least 1. */
  readonly packages: number
  /** The parcels' gross weight in kilograms, Decimal(18,4); null while a parcel is not weighed. */
  readonly grossWeightKg?: DecimalString | null
  /** Where the parcels go, when it is not the party's address. */
  readonly shipTo?: (PostalAddress & { readonly name?: string | null }) | null
}

/** References to other documents, printed in the header facts. */
export const REFERENCE_KINDS = ['CUSTOMER_ORDER', 'QUOTE', 'SALES_ORDER', 'PURCHASE_ORDER', 'SUPPLIER_QUOTE', 'DDT', 'INVOICE'] as const
export type ReferenceKind = (typeof REFERENCE_KINDS)[number]

export interface DocumentReference {
  readonly kind: ReferenceKind
  /** The other document's number, with its date when known ("2026/0101 del 05/10/2026" is composed from both). */
  readonly number: string
  readonly date?: BusinessDate | null
}

/** The FatturaPA document kinds an invoice copy names (TipoDocumento). */
export const INVOICE_KINDS = ['TD01', 'TD02', 'TD04', 'TD05', 'TD24'] as const
export type InvoiceKind = (typeof INVOICE_KINDS)[number]

/** A document to compose. */
export interface DocumentInput {
  readonly type: DocumentType
  readonly language: DocumentLanguage
  /** The issued number (allocateNumber's formatted number). */
  readonly number: string
  readonly date: BusinessDate
  readonly currency: CurrencyCode
  /** The company's time zone, for the transport start (default Europe/Rome). */
  readonly timeZone?: string
  readonly company: CompanyLegal
  readonly party: DocumentParty
  readonly references?: readonly DocumentReference[]
  readonly lines: readonly DocumentLine[]
  /** Required on every type but the DDT, which shows no prices. */
  readonly totals?: DocumentTotals | null
  /** QUOTE: valid until. */
  readonly validUntil?: BusinessDate | null
  /** PURCHASE_ORDER: the delivery date asked for the whole order; the delivery address. */
  readonly deliveryDate?: BusinessDate | null
  readonly deliverTo?: (PostalAddress & { readonly name?: string | null }) | null
  readonly paymentTerms?: string | null
  /** Incoterms or delivery terms ("EXW Milano", "Franco destino"). */
  readonly deliveryTerms?: string | null
  /** DDT only, required there. */
  readonly transport?: DdtTransport | null
  /** PACKING_LIST only, required there: the parcels, their gross weight when every one is weighed, and where they go. */
  readonly packing?: PackingFacts | null
  /** INVOICE_COPY: the FatturaPA document kind (default TD01), the SDI file id once known, the due date. */
  readonly invoice?: { readonly kind?: InvoiceKind | null; readonly sdiId?: string | null; readonly dueDate?: BusinessDate | null } | null
  readonly notes?: string | null
  /** A preview: printed with a "sample, not a valid document" banner, never stored. */
  readonly sample?: boolean
}

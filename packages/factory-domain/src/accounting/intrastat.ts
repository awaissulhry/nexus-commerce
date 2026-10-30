import { Dec, type Decimal } from '../tax/decimal'
import { isEuMemberState } from '../tax/eu'
import type { ExportCell } from '../views/exports'
import { type BuyerAsInvoiced } from './journals'
import { fingerprint, type ExportDocument } from './manifest'

/**
 * Intrastat data for the EU sales of a month and its file (B-W2a-39; LOG-098, LOG-100; Reg. (EU) 2019/2152, Reg. (EU)
 * 2020/1197 Annex V and VI; design finance.accounting "Intrastat rows": "EU sales rows with the data the file needs;
 * missing data flagged with a fix"). Pure: the API reads the facts.
 *
 * An EU sale here is a GOODS line of an invoice issued in the month (TD01, TD24; a TD04 credit note as a RETURN) whose
 * goods go to another EU member state: the country of its DDT's place of delivery (else the DDT's recipient), else the
 * buyer's country on the invoice (flagged: no DDT). Charges, services and deposit deductions are not goods.
 *
 * Each row names what the file needs (design columns): the CN code (the style's commodity code, its first 8 digits),
 * the partner's VAT ID (the buyer's on the invoice, with its VIES prefix), the value (the line's net amount, euros), the
 * net mass (the style's mass per garment × the pieces), the supplementary units (the pieces), the nature of the
 * transaction, the delivery terms (the customer's Incoterm), the mode of transport (not recorded in Nexus: left blank)
 * and the country of origin (the style's). Anything missing is flagged with what fixes it (the style, the customer).
 *
 * TO CONFIRM WITH THE ACCOUNTANT (Q30, GATE-ACCOUNTANT): whether the company files Intrastat for sales at all, monthly or
 * quarterly, the official file layout (the file here is Nexus's DEFAULT CSV, one row per partner, CN code, nature,
 * delivery terms, origin and country, summing value, mass and units), the nature codes (the EU's 11 outright sale and
 * 21 return are SUGGESTED beside the words SALE and RETURN, never asserted), whether delivery terms and transport are
 * asked of this filer, the rounding of the net mass (kept to the gram here), and how a sale to a buyer without a VAT ID
 * is declared. Nothing is filed: a person hands the file to the accountant.
 */

export const INTRASTAT_FLAG_CODES = [
  'NOT_EUR',
  'NO_STYLE',
  'CN_CODE_MISSING',
  'CN_CODE_SHORT',
  'ORIGIN_MISSING',
  'NET_MASS_MISSING',
  'VAT_ID_MISSING',
  'DELIVERY_TERMS_MISSING',
  'DESTINATION_FROM_BILL_TO',
] as const
export type IntrastatFlagCode = (typeof INTRASTAT_FLAG_CODES)[number]

export type FlagSeverity = 'BLOCKING' | 'WARNING'

export interface RecordFix {
  /** The record to open to fix it (the web's record address). */
  readonly recordType: string
  readonly recordId: string
  /** The field to fill there, when one. */
  readonly field: string | null
}

export interface IntrastatFlag {
  readonly code: IntrastatFlagCode
  readonly severity: FlagSeverity
  readonly message: string
  readonly fix: RecordFix | null
}

export type IntrastatNature = 'SALE' | 'RETURN'
/** The EU codes of Annex VI, SUGGESTED only (to confirm with the accountant). */
export const SUGGESTED_NATURE_CODES: Readonly<Record<IntrastatNature, string>> = Object.freeze({ SALE: '11', RETURN: '21' })

export interface IntrastatLineFacts {
  readonly invoice: { readonly id: string; readonly number: string; readonly version: number; readonly docType: string; readonly issueDate: string; readonly currency: string }
  readonly line: { readonly id: string; readonly seq: number; readonly kind: string; readonly quantity: string; readonly netAmount: number; readonly description: string }
  readonly buyer: BuyerAsInvoiced & { readonly partyId: string; readonly code: string; readonly incoterm: string | null }
  /** Where the goods went, and from which record that is known. */
  readonly destination: { readonly country: string | null; readonly source: 'DDT' | 'BILL_TO' }
  readonly style: { readonly id: string; readonly code: string; readonly hsCode: string | null; readonly originCountry: string | null; readonly netMassKg: string | null } | null
}

export interface IntrastatRow {
  readonly invoiceId: string
  readonly invoiceNumber: string
  readonly docType: string
  readonly issueDate: string
  readonly lineId: string
  readonly lineSeq: number
  readonly description: string
  readonly style: { readonly id: string; readonly code: string } | null
  readonly partner: { readonly partyId: string; readonly code: string; readonly name: string }
  readonly partnerVatId: string | null
  readonly destinationCountry: string | null
  /** The 8-digit CN code, or null. */
  readonly cnCode: string | null
  readonly originCountry: string | null
  /** The line's net amount, minor units of `currency` (euros for the file). */
  readonly value: number
  readonly currency: string
  /** Kilograms, 3 decimals, or null when the style has no mass. */
  readonly netMassKg: string | null
  /** The pieces. */
  readonly supplementaryUnits: string
  readonly nature: IntrastatNature
  readonly suggestedNatureCode: string
  readonly deliveryTerms: string | null
  /** Not recorded in Nexus (no column): always null. */
  readonly transportMode: null
  readonly flags: readonly IntrastatFlag[]
}

/** The line is an EU sale of goods (dispatched from Italy to another member state). */
export function isEuSale(facts: Pick<IntrastatLineFacts, 'invoice' | 'line' | 'destination'>): boolean {
  if (!['TD01', 'TD24', 'TD04'].includes(facts.invoice.docType) || facts.line.kind !== 'GOODS') return false
  const country = facts.destination.country
  return country !== null && country !== 'IT' && isEuMemberState(country)
}

const styleFix = (styleId: string, field: string): RecordFix => ({ recordType: 'Style', recordId: styleId, field })

/** One EU sale line's Intrastat row with its flags. */
export function intrastatRowOf(facts: IntrastatLineFacts): IntrastatRow {
  const flags: IntrastatFlag[] = []
  const style = facts.style
  if (facts.invoice.currency !== 'EUR') {
    flags.push({ code: 'NOT_EUR', severity: 'BLOCKING', message: `Invoice ${facts.invoice.number} is in ${facts.invoice.currency}: Intrastat values are in euros, and Nexus converts no currency (the accountant gives the rate).`, fix: null })
  }
  let cnCode: string | null = null
  if (!style) {
    flags.push({ code: 'NO_STYLE', severity: 'BLOCKING', message: `Line ${facts.line.seq} of invoice ${facts.invoice.number} bills goods without a style (typed by hand): its CN code, origin and mass are not on record.`, fix: { recordType: 'Invoice', recordId: facts.invoice.id, field: null } })
  } else {
    if (!style.hsCode) flags.push({ code: 'CN_CODE_MISSING', severity: 'BLOCKING', message: `Style ${style.code} has no commodity code: add its CN code (8 digits).`, fix: styleFix(style.id, 'hsCode') })
    else if (style.hsCode.length < 8) flags.push({ code: 'CN_CODE_SHORT', severity: 'BLOCKING', message: `Style ${style.code} has the HS heading ${style.hsCode} (6 digits): Intrastat asks for the 8-digit CN code.`, fix: styleFix(style.id, 'hsCode') })
    else cnCode = style.hsCode.slice(0, 8)
    if (!style.originCountry) flags.push({ code: 'ORIGIN_MISSING', severity: 'BLOCKING', message: `Style ${style.code} has no country of origin.`, fix: styleFix(style.id, 'originCountry') })
    if (!style.netMassKg) flags.push({ code: 'NET_MASS_MISSING', severity: 'BLOCKING', message: `Style ${style.code} has no net mass per garment.`, fix: styleFix(style.id, 'netMassKg') })
  }
  if (!facts.buyer.vatId) {
    flags.push({ code: 'VAT_ID_MISSING', severity: 'BLOCKING', message: `Invoice ${facts.invoice.number} names no VAT ID of the buyer ${facts.buyer.code}: the partner's VAT ID is asked; how a sale without one is declared is the accountant's.`, fix: { recordType: 'Party', recordId: facts.buyer.partyId, field: 'taxIdentity' } })
  }
  if (!facts.buyer.incoterm) {
    flags.push({ code: 'DELIVERY_TERMS_MISSING', severity: 'WARNING', message: `Customer ${facts.buyer.code} has no delivery terms (Incoterm): asked of some filers only (to confirm with the accountant).`, fix: { recordType: 'Party', recordId: facts.buyer.partyId, field: 'incoterm' } })
  }
  if (facts.destination.source === 'BILL_TO') {
    flags.push({ code: 'DESTINATION_FROM_BILL_TO', severity: 'WARNING', message: `Line ${facts.line.seq} of invoice ${facts.invoice.number} names no DDT: the country of destination is the buyer's on the invoice.`, fix: null })
  }
  const pieces = new Dec(facts.line.quantity)
  const mass = style?.netMassKg ? new Dec(style.netMassKg).times(pieces).toDecimalPlaces(3).toFixed(3) : null
  const nature: IntrastatNature = facts.invoice.docType === 'TD04' ? 'RETURN' : 'SALE'
  return {
    invoiceId: facts.invoice.id,
    invoiceNumber: facts.invoice.number,
    docType: facts.invoice.docType,
    issueDate: facts.invoice.issueDate,
    lineId: facts.line.id,
    lineSeq: facts.line.seq,
    description: facts.line.description,
    style: style ? { id: style.id, code: style.code } : null,
    partner: { partyId: facts.buyer.partyId, code: facts.buyer.code, name: facts.buyer.name },
    partnerVatId: facts.buyer.vatId,
    destinationCountry: facts.destination.country,
    cnCode,
    originCountry: style?.originCountry ?? null,
    value: facts.line.netAmount,
    currency: facts.invoice.currency,
    netMassKg: mass,
    supplementaryUnits: pieces.toDecimalPlaces(4).toString(),
    nature,
    suggestedNatureCode: SUGGESTED_NATURE_CODES[nature],
    deliveryTerms: facts.buyer.incoterm,
    transportMode: null,
    flags,
  }
}

export interface IntrastatFileRow {
  readonly partnerVatId: string | null
  readonly destinationCountry: string | null
  readonly cnCode: string | null
  readonly nature: IntrastatNature
  readonly suggestedNatureCode: string
  readonly deliveryTerms: string | null
  readonly originCountry: string | null
  readonly value: number
  readonly currency: string
  readonly netMassKg: string | null
  readonly supplementaryUnits: string
  /** The invoices it sums. */
  readonly documents: readonly string[]
}

/** The file's rows: the EU sale rows summed per partner, country, CN code, nature, delivery terms, origin and currency. */
export function intrastatFileRows(rows: readonly IntrastatRow[]): IntrastatFileRow[] {
  const groups = new Map<string, { row: IntrastatRow; value: number; mass: Decimal | null; units: Decimal; documents: Set<string> }>()
  for (const row of rows) {
    const key = [row.partnerVatId, row.destinationCountry, row.cnCode, row.nature, row.deliveryTerms, row.originCountry, row.currency].map((part) => part ?? '').join('|')
    const group = groups.get(key) ?? { row, value: 0, mass: new Dec(0), units: new Dec(0), documents: new Set<string>() }
    group.value += row.value
    group.mass = group.mass === null || row.netMassKg === null ? null : group.mass.plus(row.netMassKg)
    group.units = group.units.plus(row.supplementaryUnits)
    group.documents.add(row.invoiceNumber)
    groups.set(key, group)
  }
  return [...groups.values()]
    .map(({ row, value, mass, units, documents }) => ({
      partnerVatId: row.partnerVatId,
      destinationCountry: row.destinationCountry,
      cnCode: row.cnCode,
      nature: row.nature,
      suggestedNatureCode: row.suggestedNatureCode,
      deliveryTerms: row.deliveryTerms,
      originCountry: row.originCountry,
      value,
      currency: row.currency,
      netMassKg: mass === null ? null : mass.toFixed(3),
      supplementaryUnits: units.toString(),
      documents: [...documents].sort(),
    }))
    .sort((a, b) => (a.destinationCountry ?? '').localeCompare(b.destinationCountry ?? '') || (a.partnerVatId ?? '').localeCompare(b.partnerVatId ?? '') || (a.cnCode ?? '').localeCompare(b.cnCode ?? '') || a.nature.localeCompare(b.nature))
}

export const INTRASTAT_HEADINGS = {
  en: ['Partner VAT ID', 'Country of destination', 'CN code', 'Nature of transaction', 'Nature code (suggested)', 'Delivery terms', 'Mode of transport', 'Country of origin', 'Value', 'Net mass (kg)', 'Supplementary units', 'Invoices'],
  it: ['Partita IVA acquirente', 'Paese di destinazione', 'Codice NC', 'Natura della transazione', 'Codice natura (suggerito)', 'Condizioni di consegna', 'Modo di trasporto', 'Paese di origine', 'Valore', 'Massa netta (kg)', 'Unità supplementari', 'Fatture'],
} as const

/** A file row's cells (the mode of transport stays blank: not recorded in Nexus). */
export function intrastatCells(row: IntrastatFileRow): ExportCell[] {
  return [
    row.partnerVatId,
    row.destinationCountry,
    row.cnCode,
    row.nature,
    row.suggestedNatureCode,
    row.deliveryTerms,
    null,
    row.originCountry,
    { minor: row.value, currency: row.currency },
    row.netMassKg === null ? null : { decimal: row.netMassKg },
    { decimal: row.supplementaryUnits },
    row.documents.join(' '),
  ]
}

/** The invoices the Intrastat package rests on, each with the fingerprint of its rows (a re-export sends the whole file). */
export function intrastatDocuments(rows: readonly IntrastatRow[], versions: ReadonlyMap<string, number>): ExportDocument[] {
  const byInvoice = new Map<string, IntrastatRow[]>()
  for (const row of rows) byInvoice.set(row.invoiceId, [...(byInvoice.get(row.invoiceId) ?? []), row])
  return [...byInvoice.entries()].map(([invoiceId, mine]) => ({
    package: 'INTRASTAT' as const,
    recordType: 'Invoice',
    recordId: invoiceId,
    number: mine[0]!.invoiceNumber,
    version: versions.get(invoiceId) ?? null,
    hash: fingerprint(mine.map((row) => [row.lineId, row.partnerVatId, row.destinationCountry, row.cnCode, row.originCountry, row.value, row.currency, row.netMassKg, row.supplementaryUnits, row.nature, row.deliveryTerms])),
  }))
}

export interface IntrastatSummary {
  readonly rows: number
  readonly fileRows: number
  readonly blocking: number
  readonly warnings: number
  /** Σ value per currency. */
  readonly values: readonly { readonly currency: string; readonly value: number }[]
}

export function intrastatSummary(rows: readonly IntrastatRow[]): IntrastatSummary {
  const values = new Map<string, number>()
  for (const row of rows) values.set(row.currency, (values.get(row.currency) ?? 0) + row.value)
  return {
    rows: rows.length,
    fileRows: intrastatFileRows(rows).length,
    blocking: rows.filter((row) => row.flags.some((flag) => flag.severity === 'BLOCKING')).length,
    warnings: rows.filter((row) => row.flags.some((flag) => flag.severity === 'WARNING')).length,
    values: [...values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, value]) => ({ currency, value })),
  }
}

export const INTRASTAT_WORDS =
  "Intrastat data of the month's EU sales: TO CONFIRM WITH THE ACCOUNTANT whether the company files them, how often, and the official file layout (Q30). The nature codes are suggested (11 sale, 21 return); the mode of transport is not recorded in Nexus and stays blank; the net mass is kept to the gram. Nothing is filed: a person hands the file to the accountant."

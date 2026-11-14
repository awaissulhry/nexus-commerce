import { createHash } from 'node:crypto'
import { canonicalJson } from '../../accounting/manifest'
import { isCurrencyCode, toMinorUnits, type CurrencyCode, type DecimalString } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import type { DocumentInput, DocumentLanguage, DocumentLine, DocumentParty, DocumentReference, PostalAddress, ProformaFacts, ProformaPurpose, VatSummary } from '../../documents/model'
import { Dec, parseDecimal } from '../../tax/decimal'
import { isNaturaCode } from '../../tax/natura'
import { ITALIAN_VAT_RATES } from '../../tax/vat-rates'
import { computeVat, lineAmount, type PriceBasis } from '../../tax/vat-summary'
import { nonTaxable, taxable, type VatTreatment } from '../../tax/vat-treatment'

/**
 * The proforma invoice (B-W2b-391; LOG-058 "Pro-forma for customs and samples; the W1 deposit request is FIN-066"; SAL-197
 * "the pro-forma document is owned by logistics"), pure: a non-fiscal document with its own numbers (the company's PROFORMA
 * series, PF-{YYYY}-{N:4}, B-W2b-367), made for ONE record:
 *
 *   Shipment         CUSTOMS     the goods of a shipment, priced as the order sells them (its price basis, VAT as on the
 *                                order's lines), with its parcels, weights and the goods' origin: what customs and the
 *                                consignee read
 *   SampleShipment   SAMPLES     the cells of the shipment's sample round; priced by the round's charge, else by a value per
 *                                piece the person gives "for customs purposes only" (no commercial value)
 *   DepositRequest   PREPAYMENT  the payment a deposit request asks, VAT included (GROSS), split into net and VAT at the
 *                                order's rate, due on its day
 *
 * The amounts come from tax/vat-summary computeVat, the one VAT computation of quotes, deposits and invoices (FatturaPA's
 * rounding), so a proforma's total is the invoice's.
 *
 * One number per record (NumberAllocation's key: the record and kind), taken once; every later version repeats it. A version
 * is kept per change of what it shows (the fingerprint below, without the day); the same contents give the newest back.
 * A proforma is never a tax document: the composed PDF always says so (documents/compose.ts proformaNotices).
 */

/** The records a proforma is made for (GeneratedDocument recordType; the database checks the pairing). */
export const PROFORMA_RECORD_TYPES = ['Shipment', 'SampleShipment', 'DepositRequest'] as const
export type ProformaRecordType = (typeof PROFORMA_RECORD_TYPES)[number]

/** The GeneratedDocument kind and the NumberKind of a proforma. */
export const PROFORMA_KIND = 'PROFORMA' as const

/** The layout version printed (documents/layouts.ts PROFORMA). */
export const PROFORMA_LAYOUT = 'PROFORMA/1' as const

export const isProformaRecordType = (value: unknown): value is ProformaRecordType => typeof value === 'string' && (PROFORMA_RECORD_TYPES as readonly string[]).includes(value)

/** Why a proforma of this record is made. */
export function purposeOf(recordType: ProformaRecordType): ProformaPurpose {
  return recordType === 'Shipment' ? 'CUSTOMS' : recordType === 'SampleShipment' ? 'SAMPLES' : 'PREPAYMENT'
}

/** One priced line as the API reads it from the record (quantities are whole pieces; prices in the document's currency). */
export interface ProformaLineInput {
  readonly code: string | null
  readonly description: string
  readonly quantity: number
  readonly uom: string
  /** Decimal(18,6) in the document's currency, per piece, on the source's price basis (with VAT on GROSS). */
  readonly unitPrice: DecimalString
  /** The VAT of the sale; null for samples valued for customs only (no VAT is printed: nothing is sold). */
  readonly treatment: VatTreatment | null
}

export interface ProformaSource {
  readonly purpose: ProformaPurpose
  /** The formatted PROFORMA number of the record (allocateNumber). */
  readonly number: string
  readonly date: BusinessDate
  readonly language: DocumentLanguage
  readonly currency: CurrencyCode
  readonly party: DocumentParty
  readonly deliverTo?: (PostalAddress & { readonly name?: string | null }) | null
  readonly references: readonly DocumentReference[]
  readonly lines: readonly ProformaLineInput[]
  /** The prices' basis: NET for a business price list, GROSS (VAT included) for a consumer's and for a payment asked. */
  readonly basis: PriceBasis
  readonly paymentTerms?: string | null
  readonly deliveryTerms?: string | null
  readonly notes?: string | null
  readonly facts: Omit<ProformaFacts, 'purpose'>
}

/** What stops a proforma before anything is numbered (empty when nothing does), in words. */
export function proformaSourceProblems(source: Pick<ProformaSource, 'purpose' | 'currency' | 'lines'>): string[] {
  const problems: string[] = []
  if (!isCurrencyCode(source.currency)) problems.push('The record has no currency to price the proforma in.')
  if (source.lines.length === 0) problems.push(source.purpose === 'CUSTOMS' ? 'The shipment has no garments yet: add its lines first.' : 'There is nothing to put on the proforma.')
  for (const line of source.lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) problems.push(`${line.code ?? line.description}: the quantity must be at least 1.`)
    const price = parseDecimal(line.unitPrice)
    if (price === null || price.isNegative()) problems.push(`${line.code ?? line.description}: it has no price to print.`)
  }
  if (source.purpose === 'PREPAYMENT' && source.lines.length !== 1) problems.push('A payment request has one line: the amount it asks.')
  if (source.lines.some((line) => line.treatment === null) && source.lines.some((line) => line.treatment !== null)) problems.push('The lines either all carry VAT or none does.')
  return problems
}

/** The treatment of a line's stored VAT (rate "22.00", or "0.00" with its Natura); null: one a proforma cannot print. */
export function treatmentOfStored(vatRatePct: DecimalString, vatNature: string | null): VatTreatment | null {
  const rate = parseDecimal(vatRatePct)
  if (rate === null) return null
  if (vatNature !== null) return rate.isZero() && isNaturaCode(vatNature) ? nonTaxable(vatNature, vatNature) : null
  const whole = ITALIAN_VAT_RATES.find((candidate) => new Dec(candidate).toFixed(2) === rate.toFixed(2))
  return whole === undefined ? null : taxable(whole)
}

/** The rate and nature a line or a total prints for a treatment. */
const printed = (treatment: VatTreatment): { rate: DecimalString; nature: string | null } =>
  treatment.kind === 'TAXABLE' ? { rate: String(treatment.rate), nature: null } : { rate: '0', nature: treatment.natura }

/** The proforma as a document (without the company, which the API reads from its Company row). */
export function proformaDocument(source: ProformaSource): Omit<DocumentInput, 'company' | 'sample'> {
  // Samples valued for customs only: the values, no VAT (one rounding per line).
  const withVat = source.lines.every((line) => line.treatment !== null)
  const computed = withVat
    ? computeVat(
        source.lines.map((line) => ({ treatment: line.treatment!, quantity: new Dec(line.quantity), unitPrice: new Dec(line.unitPrice) })),
        source.basis,
      )
    : { lines: source.lines.map((line) => ({ unitNetPrice: new Dec(line.unitPrice), net: lineAmount(new Dec(line.unitPrice), new Dec(line.quantity)) })), summary: [] }
  const lines: DocumentLine[] = source.lines.map((line, index) => {
    const amount = computed.lines[index]!
    return {
      code: line.code,
      description: line.description,
      quantity: String(line.quantity),
      uom: line.uom,
      // The net unit price (FatturaPA's PrezzoUnitario: without VAT, from the gross on the GROSS basis).
      unitPrice: amount.unitNetPrice.toDecimalPlaces(6).toFixed(),
      amountMinor: toMinorUnits(amount.net, source.currency),
      vatRate: line.treatment ? printed(line.treatment).rate : null,
      vatNature: line.treatment ? printed(line.treatment).nature : null,
    }
  })
  const vat: VatSummary[] = computed.summary.map((row) => ({
    ...printed(row.treatment),
    taxableMinor: toMinorUnits(row.taxable, source.currency),
    vatMinor: toMinorUnits(row.vat, source.currency),
  }))
  const netMinor = withVat ? vat.reduce((total, row) => total + row.taxableMinor, 0) : lines.reduce((total, line) => total + (line.amountMinor ?? 0), 0)
  return {
    type: 'PROFORMA',
    language: source.language,
    number: source.number,
    date: source.date,
    currency: source.currency,
    party: source.party,
    references: source.references,
    lines,
    totals: { netMinor, vat, grossMinor: netMinor + vat.reduce((total, row) => total + row.vatMinor, 0) },
    deliverTo: source.deliverTo ?? null,
    paymentTerms: source.paymentTerms ?? null,
    deliveryTerms: source.deliveryTerms ?? null,
    notes: source.notes ?? null,
    proforma: { purpose: source.purpose, ...source.facts },
  }
}

/** What a version shows, without its day (a proforma made again on another day with the same contents is the same). */
export function proformaFingerprint(document: Omit<DocumentInput, 'company' | 'sample'>): string {
  const { date: _date, ...contents } = document
  return createHash('sha256').update(`proforma/1 ${canonicalJson(contents)}`).digest('hex')
}

/** A line's description for customs: the goods, then the commodity code and origin when the style has them. */
export function customsDescription(goods: string, customs: { readonly hsCode: string | null; readonly originCountry: string | null }, language: DocumentLanguage): string {
  const parts = [goods.trim()]
  if (customs.hsCode?.trim()) parts.push(`HS ${customs.hsCode.trim()}`)
  if (customs.originCountry?.trim()) parts.push(`${language === 'it' ? 'Origine' : 'Origin'} ${customs.originCountry.trim().toUpperCase()}`)
  return parts.join(' · ')
}

/** The words of a deposit request's line, in the document's language. */
export function prepaymentLineText(kind: 'ACCONTO' | 'CAPARRA' | 'CAPARRA_PENITENZIALE', on: { readonly order: string | null; readonly quote: string | null }, language: DocumentLanguage): string {
  const what =
    language === 'it'
      ? { ACCONTO: 'Acconto', CAPARRA: 'Caparra confirmatoria (art. 1385 c.c.)', CAPARRA_PENITENZIALE: 'Caparra penitenziale (art. 1386 c.c.)' }[kind]
      : { ACCONTO: 'Advance payment', CAPARRA: 'Confirmatory deposit (art. 1385 Italian Civil Code)', CAPARRA_PENITENZIALE: 'Withdrawal deposit (art. 1386 Italian Civil Code)' }[kind]
  const target = on.order ? (language === 'it' ? `sull'ordine ${on.order}` : `on order ${on.order}`) : on.quote ? (language === 'it' ? `sull'offerta ${on.quote}` : `on quotation ${on.quote}`) : null
  return target ? `${what} ${target}` : what
}

/** The longest notes a person may add to a proforma. */
export const PROFORMA_NOTES_MAX = 1000

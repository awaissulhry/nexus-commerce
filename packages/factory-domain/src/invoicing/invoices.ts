import type { Issue } from '../core/errors'
import { fitsDecimal, fromMinorUnits, isMinorUnits, QUANTITY, toMinorUnits, UNIT_PRICE, type MinorUnits } from '../core/money'
import type { NumberKind } from '../numbering/kinds'
import { defineMachine } from '../state/machine'
import { Dec, parseDecimal, ZERO, type Decimal } from '../tax/decimal'
import { isNaturaCode } from '../tax/natura'
import { DEFAULT_TAX_RULES_CONFIG, type TaxRulesConfig } from '../tax/rules'
import { stampDutyFor } from '../tax/stamp-duty'
import { ITALIAN_VAT_RATES } from '../tax/vat-rates'
import { computeVat, type PriceBasis, type VatComputation } from '../tax/vat-summary'
import { nonTaxable, taxable, type VatTreatment } from '../tax/vat-treatment'

/**
 * The invoice core (B-W1-28; plan A1 §2.4 G, §2.5 "Invoice"; FIN-054, FIN-057, FIN-061, FIN-098, FIN-099), pure: the
 * document types and states, which fiscal series numbers each type, the rules of a line, and the one computation of a
 * draft's totals from its lines (factory-domain tax/vat-summary computeVat: line amounts rounded to the cent, the VAT
 * per treatment, the roundings of a GROSS basis; then minor units through core/money toMinorUnits, the one rounding
 * point), with the stamp duty the rule asks for. TD01, TD02, TD04 and TD24 share it: B-W1-28 builds TD02 from a deposit
 * request and generic TD01/TD24 drafts; B-W1-51 adds the TD24 from DDTs, the deposit deducted and the TD04.
 *
 * The lifecycle is the database's (factory-db money.prisma and the …_money_guards triggers): DRAFT → ISSUED (number,
 * date, seller and buyer as issued, frozen from then on: DPR 633/1972 art. 26, a correction is a credit note) → the SDI
 * states of B-W1-50.
 */

export const INVOICE_DOC_TYPES = ['TD01', 'TD02', 'TD04', 'TD24'] as const
export type InvoiceDocType = (typeof INVOICE_DOC_TYPES)[number]

export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'SENT', 'DELIVERED', 'NOT_DELIVERABLE', 'REJECTED', 'ERROR'] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

export const INVOICE_LINE_KINDS = ['GOODS', 'SERVICE', 'DEPOSIT_DEDUCTION'] as const
export type InvoiceLineKind = (typeof INVOICE_LINE_KINDS)[number]

export const PRICE_BASES = ['NET', 'GROSS'] as const satisfies readonly PriceBasis[]

/** The types in words with their code (A2 SCR-080: "Deposit invoice TD02"). */
export const DOC_TYPE_WORDS: Readonly<Record<InvoiceDocType, string>> = Object.freeze({
  TD01: 'Invoice',
  TD02: 'Deposit invoice',
  TD04: 'Credit note',
  TD24: 'Deferred invoice',
})

/** The moves of an invoice, as the database allows them (the issue is the only one this module makes in W1). */
export const invoiceMachine = defineMachine<InvoiceStatus>({
  name: 'invoice',
  states: INVOICE_STATUSES,
  transitions: {
    DRAFT: ['ISSUED'],
    ISSUED: ['SENT', 'ERROR'],
    SENT: ['DELIVERED', 'NOT_DELIVERABLE', 'REJECTED', 'ERROR'],
    ERROR: ['SENT', 'DELIVERED', 'NOT_DELIVERABLE', 'REJECTED'],
    REJECTED: ['SENT', 'ERROR'],
  },
})

/**
 * The series kinds that may number a type, in the order they are tried: a TD02 from the company's DEPOSIT_INVOICE
 * series when it keeps one (a sezionale), else its INVOICE series; a TD04 likewise from CREDIT_NOTE; TD01 and TD24 from
 * INVOICE (the …_money_guards trigger allows exactly these).
 */
export function seriesKindsFor(docType: InvoiceDocType): readonly NumberKind[] {
  if (docType === 'TD02') return ['DEPOSIT_INVOICE', 'INVOICE']
  if (docType === 'TD04') return ['CREDIT_NOTE', 'INVOICE']
  return ['INVOICE']
}

/** At most this many lines in one draft (one request, one transaction). */
export const MAX_INVOICE_LINES = 500
/** FatturaPA Descrizione and Causale limits; the causale is split in 200-character pieces by the builder. */
export const MAX_DESCRIPTION = 1000
export const MAX_CAUSALE = 2000

// ---- VAT as a line stores it -------------------------------------------------------------------------------------

/** A line's VAT as the InvoiceLine row keeps it: the rate ("22.00", "0.00"), and at 0 the Natura and its law. */
export interface StoredVat {
  readonly vatRatePct: string
  readonly vatNature: string | null
  readonly vatLegalRef: string | null
}

/** The treatment of a stored VAT, or null when the row holds none this module builds (a rate that is not Italian…). */
export function treatmentOf(vat: StoredVat): VatTreatment | null {
  const rate = parseDecimal(vat.vatRatePct)
  if (rate === null) return null
  if (rate.isZero()) {
    if (!isNaturaCode(vat.vatNature) || vat.vatLegalRef === null || vat.vatLegalRef.trim() === '') return null
    return nonTaxable(vat.vatNature, vat.vatLegalRef)
  }
  const rateText = rate.toFixed(2)
  const whole = ITALIAN_VAT_RATES.find((candidate) => new Dec(candidate).toFixed(2) === rateText)
  return whole !== undefined && vat.vatNature === null ? taxable(whole) : null
}

/** How a treatment is stored on a line. */
export function storedVatOf(treatment: VatTreatment): StoredVat {
  return treatment.kind === 'TAXABLE'
    ? { vatRatePct: new Dec(treatment.rate).toFixed(2), vatNature: null, vatLegalRef: null }
    : { vatRatePct: '0.00', vatNature: treatment.natura, vatLegalRef: treatment.legalReference }
}

// ---- lines --------------------------------------------------------------------------------------------------------

/** A line of a draft, as the core computes it (amounts are the core's output, never an input, but for a deduction). */
export interface CoreLine {
  readonly kind: InvoiceLineKind
  readonly description: string
  readonly itemCode?: string | null
  /** Decimal(18,4) as a string, above 0 (a deduction: 1). */
  readonly quantity: string
  readonly uom?: string | null
  /** Decimal(18,6) on the invoice's price basis; negative only on a deduction. */
  readonly unitPrice: string
  readonly discountPct?: string | null
  readonly vat: VatTreatment
  /** DEPOSIT_DEDUCTION only: its amounts as the deposit invoice charged them (negative minor units). */
  readonly deduction?: { readonly netAmount: MinorUnits; readonly grossAmount: MinorUnits } | null
}

/** Everything wrong with a line (paths under `at`), before it is saved. Deductions come from B-W1-51's builder. */
export function lineProblems(line: CoreLine, at: string): Issue[] {
  const issues: Issue[] = []
  if (typeof line.description !== 'string' || line.description.trim() === '') issues.push({ path: `${at}/description`, message: 'Say what the line bills.' })
  else if (line.description.length > MAX_DESCRIPTION) issues.push({ path: `${at}/description`, message: `At most ${MAX_DESCRIPTION} characters (FatturaPA Descrizione).` })
  const quantity = parseDecimal(line.quantity)
  if (quantity === null || !fitsDecimal(line.quantity, QUANTITY.precision, QUANTITY.scale) || quantity.lte(ZERO)) {
    issues.push({ path: `${at}/quantity`, message: 'A quantity above 0 with at most 4 decimals.' })
  }
  const price = parseDecimal(line.unitPrice)
  if (price === null || !fitsDecimal(line.unitPrice, UNIT_PRICE.precision, UNIT_PRICE.scale)) issues.push({ path: `${at}/unitPrice`, message: 'A unit price with at most 6 decimals.' })
  else if (line.kind !== 'DEPOSIT_DEDUCTION' && price.lt(ZERO)) issues.push({ path: `${at}/unitPrice`, message: 'A price of 0 or more: a credit is a credit note (TD04) with positive amounts.' })
  if (line.discountPct !== null && line.discountPct !== undefined) {
    const discount = parseDecimal(line.discountPct)
    if (discount === null || !fitsDecimal(line.discountPct, 7, 4) || discount.lte(ZERO) || discount.gte(100)) {
      issues.push({ path: `${at}/discountPct`, message: 'A discount above 0 and below 100 percent.' })
    }
  }
  if (line.uom !== null && line.uom !== undefined && (line.uom.trim() === '' || line.uom.length > 10)) issues.push({ path: `${at}/uom`, message: 'A unit of measure of 1 to 10 characters (PZ, PA…).' })
  if (line.itemCode !== null && line.itemCode !== undefined && (line.itemCode.trim() === '' || line.itemCode.length > 35)) {
    issues.push({ path: `${at}/itemCode`, message: 'An item code of 1 to 35 characters.' })
  }
  if (line.kind === 'DEPOSIT_DEDUCTION') {
    const deduction = line.deduction
    if (!deduction || !isMinorUnits(deduction.netAmount) || !isMinorUnits(deduction.grossAmount) || deduction.netAmount >= 0 || deduction.grossAmount > deduction.netAmount) {
      issues.push({ path: `${at}/deduction`, message: 'A deposit deducted takes its negative net and gross amounts from the deposit invoice.' })
    }
  }
  return issues
}

// ---- totals -------------------------------------------------------------------------------------------------------

/** One entry of Invoice.vatSummary (minor units), as the …_money_guards trigger reads it. */
export interface VatSummaryEntry {
  /** "22.00", or null when not taxable. */
  readonly rate: string | null
  readonly nature: string | null
  readonly legalRef: string | null
  readonly taxable: MinorUnits
  readonly vat: MinorUnits
  readonly rounding: MinorUnits
}

export interface ComputedLine {
  /** PrezzoTotale without VAT, minor units. */
  readonly netAmount: MinorUnits
  /** The line with VAT: GROSS basis and deductions only. */
  readonly grossAmount: MinorUnits | null
}

export interface InvoiceTotals {
  readonly lines: readonly ComputedLine[]
  readonly netTotal: MinorUnits
  readonly vatTotal: MinorUnits
  readonly grossTotal: MinorUnits
  readonly vatSummary: readonly VatSummaryEntry[]
  /** 2.00 euro when the stamp-duty rule says it is due (not part of the total), else null. */
  readonly stampDutyAmount: MinorUnits | null
}

const minor = (value: Decimal, currency: string): MinorUnits => toMinorUnits(value, currency)

/**
 * The totals of a draft from its lines: computeVat (each line rounded to the cent, VAT per treatment, a GROSS basis
 * keeping the VAT-inclusive total and putting the cents lost by splitting each line in Arrotondamento), in minor units.
 * The same arithmetic as the FatturaPA builder, so the stored totals are the XML's. Throws on a line lineProblems
 * refuses (check them first).
 */
export function computeInvoiceTotals(lines: readonly CoreLine[], basis: PriceBasis, currency: string, taxRules: TaxRulesConfig = DEFAULT_TAX_RULES_CONFIG): InvoiceTotals {
  const vat: VatComputation = computeVat(
    lines.map((line) => {
      const discount = line.discountPct === null || line.discountPct === undefined ? undefined : new Dec(line.discountPct)
      return {
        treatment: line.vat,
        quantity: new Dec(line.quantity),
        unitPrice: new Dec(line.unitPrice),
        ...(discount === undefined ? {} : { discountPercent: discount }),
        ...(line.kind === 'DEPOSIT_DEDUCTION' && line.deduction
          ? { fixed: { net: fromMinorUnits(line.deduction.netAmount, currency), gross: fromMinorUnits(line.deduction.grossAmount, currency) } }
          : {}),
      }
    }),
    basis,
  )
  const summary = vat.summary.map((row) => ({
    rate: row.treatment.kind === 'TAXABLE' ? new Dec(row.treatment.rate).toFixed(2) : null,
    nature: row.treatment.kind === 'NON_TAXABLE' ? row.treatment.natura : null,
    legalRef: row.treatment.kind === 'NON_TAXABLE' ? row.treatment.legalReference : null,
    taxable: minor(row.taxable, currency),
    vat: minor(row.vat, currency),
    rounding: minor(row.rounding, currency),
  }))
  const stamp = stampDutyFor(vat.summary, taxRules)
  return {
    lines: vat.lines.map((line) => ({ netAmount: minor(line.net, currency), grossAmount: line.gross === null ? null : minor(line.gross, currency) })),
    netTotal: minor(vat.taxable, currency),
    vatTotal: minor(vat.vat, currency),
    grossTotal: minor(vat.total, currency),
    vatSummary: summary,
    stampDutyAmount: stamp.amount === null ? null : minor(stamp.amount, currency),
  }
}

/** The totals an invoice row holds, as compared at issue. */
export interface StoredTotals {
  readonly netTotal: number
  readonly vatTotal: number
  readonly grossTotal: number
  readonly vatSummary: unknown
  readonly stampDutyAmount: number | null
  readonly lines: readonly { readonly netAmount: number; readonly grossAmount: number | null }[]
}

const summaryKey = (entries: readonly VatSummaryEntry[]): string =>
  JSON.stringify(entries.map((entry) => [entry.rate, entry.nature, entry.legalRef, entry.taxable, entry.vat, entry.rounding]))

/** Whether the stored totals are exactly what the lines compute (the issue refuses broken totals with this). */
export function totalsMatch(stored: StoredTotals, computed: InvoiceTotals): boolean {
  if (stored.netTotal !== computed.netTotal || stored.vatTotal !== computed.vatTotal || stored.grossTotal !== computed.grossTotal) return false
  if ((stored.stampDutyAmount ?? null) !== computed.stampDutyAmount) return false
  if (stored.lines.length !== computed.lines.length) return false
  if (stored.lines.some((line, index) => line.netAmount !== computed.lines[index]!.netAmount || (line.grossAmount ?? null) !== computed.lines[index]!.grossAmount)) return false
  if (!Array.isArray(stored.vatSummary)) return false
  const entries = (stored.vatSummary as Record<string, unknown>[]).map((entry) => ({
    rate: (entry.rate ?? null) as string | null,
    nature: (entry.nature ?? null) as string | null,
    legalRef: (entry.legalRef ?? null) as string | null,
    taxable: entry.taxable as number,
    vat: entry.vat as number,
    rounding: (entry.rounding ?? 0) as number,
  }))
  return summaryKey(entries) === summaryKey(computed.vatSummary)
}

/** A minor amount in words for a message: 1830.00 EUR. */
export const amountText = (amount: MinorUnits, currency: string): string => `${fromMinorUnits(amount, currency).toFixed(2)} ${currency}`

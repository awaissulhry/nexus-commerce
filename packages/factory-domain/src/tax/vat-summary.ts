import { Dec, HUNDRED, ONE_CENT, roundMoney, sum, ZERO, type Decimal } from './decimal'
import { treatmentKey, type VatTreatment } from './vat-treatment'

/**
 * VAT arithmetic per the FatturaPA technical rules, the one computation used by quotes, deposit requests and
 * invoices, so the total a customer sees before accepting is the total of the invoice.
 *
 *   PrezzoTotale      = PrezzoUnitario x (1 - discount%) x Quantita, rounded to cents       (SDI check 00423)
 *   ImponibileImporto = sum of PrezzoTotale of the treatment + Arrotondamento                 (SDI check 00422)
 *   Imposta           = AliquotaIVA x ImponibileImporto / 100, rounded half up to cents     (SDI check 00421)
 *
 * Two price bases:
 *   NET   — prices exclude VAT (business price lists). VAT is computed on each treatment's taxable total.
 *   GROSS — prices include VAT (consumer price lists, deposits paid). The VAT-inclusive total of each treatment is
 *           kept to the cent and split into taxable and VAT ("scorporo"); the cents lost by splitting each line go to
 *           the summary's Arrotondamento. The invoice total is then exactly the VAT-inclusive price the consumer saw
 *           and paid (Codice del Consumo artt. 49, 51).
 */
export type PriceBasis = 'NET' | 'GROSS'

export interface AmountLine {
  readonly treatment: VatTreatment
  readonly quantity: Decimal
  /** Unit price on the price basis: without VAT for NET, with VAT for GROSS. */
  readonly unitPrice: Decimal
  /** Percentage discount, 0 < d < 100. */
  readonly discountPercent?: Decimal
  /**
   * Amounts that are not computed but taken as they are, such as a deposit deducted (its taxable and VAT come from
   * the deposit invoice). net is PrezzoTotale; gross is net plus its VAT.
   */
  readonly fixed?: { readonly net: Decimal; readonly gross: Decimal }
}

export interface ComputedAmountLine {
  readonly treatment: VatTreatment
  /** PrezzoUnitario: the unit price without VAT (computed from the gross price on the GROSS basis, 8 decimals). */
  readonly unitNetPrice: Decimal
  /** PrezzoTotale: the line amount without VAT, in cents. */
  readonly net: Decimal
  /** The line amount with VAT, in cents (GROSS basis and fixed lines only; null on the NET basis). */
  readonly gross: Decimal | null
}

export interface VatSummaryRow {
  readonly treatment: VatTreatment
  /** ImponibileImporto. */
  readonly taxable: Decimal
  /** Imposta (0 for a non-taxable treatment). */
  readonly vat: Decimal
  /** Arrotondamento: taxable minus the sum of the lines' PrezzoTotale (non-zero on the GROSS basis only). */
  readonly rounding: Decimal
  /** taxable + vat. */
  readonly gross: Decimal
}

export interface VatComputation {
  readonly basis: PriceBasis
  readonly lines: readonly ComputedAmountLine[]
  /** One row per treatment, in a fixed order: taxable rates high to low, then Natura codes. */
  readonly summary: readonly VatSummaryRow[]
  readonly taxable: Decimal
  readonly vat: Decimal
  /** The VAT-inclusive total: ImportoTotaleDocumento. */
  readonly total: Decimal
}

function rateOf(treatment: VatTreatment): Decimal {
  return treatment.kind === 'TAXABLE' ? new Dec(treatment.rate) : ZERO
}

function discountFactor(discountPercent: Decimal | undefined): Decimal {
  return discountPercent === undefined ? new Dec(1) : HUNDRED.minus(discountPercent).dividedBy(HUNDRED)
}

/** VAT on a taxable amount: rate x amount / 100, half up to cents (spec 2.2.2.6 Imposta). */
export function vatOn(taxableAmount: Decimal, treatment: VatTreatment): Decimal {
  return roundMoney(taxableAmount.times(rateOf(treatment)).dividedBy(HUNDRED))
}

/** A line amount: unit price x (1 - discount%) x quantity, half up to cents (spec 2.2.1.11 PrezzoTotale). */
export function lineAmount(unitPrice: Decimal, quantity: Decimal, discountPercent?: Decimal): Decimal {
  return roundMoney(unitPrice.times(discountFactor(discountPercent)).times(quantity))
}

/**
 * Splits a VAT-inclusive amount into taxable and VAT ("scorporo"): taxable = gross x 100 / (100 + rate), half up to
 * cents; VAT = gross - taxable, so the two always add back to the gross to the cent. The VAT stays within one cent of
 * vatOn(taxable), the tolerance SDI allows (00421).
 */
export function splitGross(grossAmount: Decimal, treatment: VatTreatment): { taxable: Decimal; vat: Decimal } {
  if (treatment.kind === 'NON_TAXABLE') return { taxable: grossAmount, vat: ZERO }
  const taxableAmount = roundMoney(grossAmount.times(HUNDRED).dividedBy(HUNDRED.plus(rateOf(treatment))))
  return { taxable: taxableAmount, vat: grossAmount.minus(taxableAmount) }
}

function computeLine(line: AmountLine, basis: PriceBasis): ComputedAmountLine {
  const factor = discountFactor(line.discountPercent).times(line.quantity)
  if (line.fixed) {
    return {
      treatment: line.treatment,
      unitNetPrice: line.fixed.net.dividedBy(factor).toDecimalPlaces(8),
      net: line.fixed.net,
      gross: line.fixed.gross,
    }
  }
  if (basis === 'NET') {
    return {
      treatment: line.treatment,
      unitNetPrice: line.unitPrice,
      net: lineAmount(line.unitPrice, line.quantity, line.discountPercent),
      gross: null,
    }
  }
  const gross = lineAmount(line.unitPrice, line.quantity, line.discountPercent)
  const net = splitGross(gross, line.treatment).taxable
  return { treatment: line.treatment, unitNetPrice: net.dividedBy(factor).toDecimalPlaces(8), net, gross }
}

function compareTreatments(a: VatTreatment, b: VatTreatment): number {
  if (a.kind !== b.kind) return a.kind === 'TAXABLE' ? -1 : 1
  if (a.kind === 'TAXABLE' && b.kind === 'TAXABLE') {
    if (a.rate !== b.rate) return b.rate - a.rate
  }
  const ka = treatmentKey(a)
  const kb = treatmentKey(b)
  return ka < kb ? -1 : ka > kb ? 1 : 0
}

/** Computes the lines, the VAT summary per treatment and the totals. Deterministic; inputs are not changed. */
export function computeVat(lines: readonly AmountLine[], basis: PriceBasis): VatComputation {
  const computed = lines.map((line) => computeLine(line, basis))

  const groups = new Map<string, ComputedAmountLine[]>()
  for (const line of computed) {
    const key = treatmentKey(line.treatment)
    const group = groups.get(key)
    if (group) group.push(line)
    else groups.set(key, [line])
  }

  const summary: VatSummaryRow[] = [...groups.values()].map((group) => {
    const treatment = group[0]!.treatment
    const netSum = sum(group.map((line) => line.net))
    if (basis === 'NET') {
      // Fixed lines (a deposit deducted) count with their net only: VAT is computed once, on the treatment's total.
      const vat = vatOn(netSum, treatment)
      return { treatment, taxable: netSum, vat, rounding: ZERO, gross: netSum.plus(vat) }
    }
    const grossSum = sum(group.map((line) => line.gross ?? ZERO))
    const split = splitGross(grossSum, treatment)
    return {
      treatment,
      taxable: split.taxable,
      vat: split.vat,
      rounding: split.taxable.minus(netSum),
      gross: grossSum,
    }
  })
  summary.sort((a, b) => compareTreatments(a.treatment, b.treatment))

  for (const row of summary) {
    if (row.vat.minus(vatOn(row.taxable, row.treatment)).abs().gt(ONE_CENT)) {
      throw new Error(`internal: VAT ${row.vat.toFixed(2)} is more than a cent from the rate on ${row.taxable.toFixed(2)}`)
    }
  }

  const taxableTotal = sum(summary.map((row) => row.taxable))
  const vatTotal = sum(summary.map((row) => row.vat))
  return { basis, lines: computed, summary, taxable: taxableTotal, vat: vatTotal, total: taxableTotal.plus(vatTotal) }
}

/**
 * Splits an amount in cents over weights (for instance a deposit over the VAT treatments of an order, by their
 * VAT-inclusive totals), so the parts add up exactly to the amount: largest remainder, ties to the earlier weight.
 */
export function allocateByWeight(amount: Decimal, weights: readonly Decimal[]): Decimal[] {
  const totalWeight = sum(weights)
  if (weights.length === 0 || totalWeight.lte(ZERO)) throw new Error('allocateByWeight needs positive weights')
  if (weights.some((weight) => weight.lt(ZERO))) throw new Error('allocateByWeight needs weights of zero or more')
  if (amount.lt(ZERO)) throw new Error('allocateByWeight needs an amount of zero or more')
  const cents = roundMoney(amount).times(HUNDRED)
  const exact = weights.map((weight) => cents.times(weight).dividedBy(totalWeight))
  const floors = exact.map((share) => share.floor())
  let left = cents.minus(sum(floors))
  const order = exact
    .map((share, index) => ({ index, remainder: share.minus(floors[index]!) }))
    .sort((a, b) => (b.remainder.comparedTo(a.remainder) !== 0 ? b.remainder.comparedTo(a.remainder) : a.index - b.index))
  const parts = [...floors]
  for (const { index } of order) {
    if (left.lte(ZERO)) break
    parts[index] = parts[index]!.plus(1)
    left = left.minus(1)
  }
  return parts.map((part) => part.dividedBy(HUNDRED))
}

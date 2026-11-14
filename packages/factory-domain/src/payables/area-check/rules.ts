import { AREA_UOMS, areaIn, isAreaUom, type AreaUom } from '../../inventory/hides/area'
import { AREA_TOLERANCE_PERCENT, areaCheck } from '../../inventory/hides/measure'
import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import { sameUnit } from '../match'

/**
 * The leather area check on a supplier invoice (B-W2b-403; SCM-132; design finance.payables record tab Match "Ordered,
 * received, invoiced": "Leather area check (W2b): invoiced sq ft vs measured sq ft received; beyond tolerance → 'Open area
 * claim'"), pure. Leather is paid by area: a tannery invoices the area its tags say, the factory measures the hides it
 * received (HideMeasure, B-W2b-94 / B-W2b-98). Per invoice line mapped to a purchase order line of a material tracked by
 * the hide:
 *
 *   invoiced   what this invoice bills on the order line plus what the supplier's other live invoices bill on it (credit
 *              notes take off), in the material's base area unit
 *   received   the area of every hide received on the order line (the area it was received with, the tannery's tag)
 *   measured   each hide's latest measure; a hide not measured yet counts with the area it was received with (the words
 *              say how many were measured)
 *   outcome    measured against invoiced with the tolerance (the order line's agreed area tolerance, else the company's
 *              leather tolerance, else AREA_TOLERANCE_PERCENT): WITHIN, SHORT (we were billed more area than we measured:
 *              an area claim is in order) or OVER; NOT_RECEIVED while no hide came in on the order line
 *
 * Nothing is opened by itself: the claim is purchasing's (a person opens it from here, purchasing.claims.manage).
 */

export const AREA_LINE_OUTCOMES = ['WITHIN', 'SHORT', 'OVER', 'NOT_RECEIVED'] as const
export type AreaLineOutcome = (typeof AREA_LINE_OUTCOMES)[number]

export interface AreaHide {
  readonly hideId: string
  readonly code: string
  /** The area it was received with, in the base unit. */
  readonly received: DecimalInput
  /** Its latest measure in the base unit; null: not measured yet. */
  readonly measured: DecimalInput | null
}

export interface AreaLineFacts {
  /** This invoice line's quantity in the base unit. */
  readonly invoiced: DecimalInput
  /** What the supplier's other live invoices bill on the order line, base unit (credit notes subtracted, never below 0). */
  readonly billedElsewhere: DecimalInput
  readonly hides: readonly AreaHide[]
  readonly tolerancePercent?: DecimalInput | undefined
}

export interface AreaLineCheck {
  readonly invoiced: Decimal
  readonly invoicedTotal: Decimal
  readonly received: Decimal
  readonly measured: Decimal
  readonly measuredHides: number
  readonly unmeasuredHides: number
  /** measured − invoiced in total. */
  readonly difference: Decimal
  /** Two decimals; "0.00" when nothing is invoiced. */
  readonly differencePercent: string
  readonly tolerancePercent: string
  readonly outcome: AreaLineOutcome
  /** Short beyond the tolerance: an area claim is in order. */
  readonly opensClaim: boolean
  /** invoiced − measured when SHORT (what the claim asks back), else 0. */
  readonly shortfall: Decimal
}

const d = (value: DecimalInput): Decimal => new Dec(value.toString())

/** The area unit a supplier wrote on its line (FT2, MQ, m² …), or null when it is no area unit. */
export function areaUnitOf(uom: string | null): AreaUom | null {
  if (uom === null) return null
  return AREA_UOMS.find((unit) => sameUnit(uom, unit)) ?? null
}

/**
 * An invoice line's quantity in the material's base area unit: read in the line's own area unit when it names one, else in
 * the order line's unit (the match reads it so too); null when neither is an area unit or the line has no quantity.
 */
export function invoicedArea(quantity: DecimalInput | null, lineUom: string | null, orderUom: string, baseUom: string): Decimal | null {
  if (quantity === null || !isAreaUom(baseUom)) return null
  const unit = areaUnitOf(lineUom) ?? (isAreaUom(orderUom) ? orderUom : null)
  return unit ? areaIn(quantity, unit, baseUom) : null
}

/** The line's area check (see the module comment). */
export function areaLineCheck(facts: AreaLineFacts): AreaLineCheck {
  const tolerance = d(facts.tolerancePercent ?? AREA_TOLERANCE_PERCENT)
  const invoiced = d(facts.invoiced)
  const invoicedTotal = invoiced.plus(Dec.max(ZERO, d(facts.billedElsewhere)))
  const received = facts.hides.reduce<Decimal>((sum, hide) => sum.plus(d(hide.received)), ZERO)
  const measured = facts.hides.reduce<Decimal>((sum, hide) => sum.plus(d(hide.measured ?? hide.received)), ZERO)
  const measuredHides = facts.hides.filter((hide) => hide.measured !== null).length
  const base = { invoiced, invoicedTotal, received, measured, measuredHides, unmeasuredHides: facts.hides.length - measuredHides, tolerancePercent: tolerance.toFixed(2) }
  if (facts.hides.length === 0) return { ...base, difference: ZERO.minus(invoicedTotal), differencePercent: '0.00', outcome: 'NOT_RECEIVED', opensClaim: false, shortfall: ZERO }
  const check = areaCheck(invoicedTotal, measured, tolerance)
  const opensClaim = check.outcome === 'SHORT'
  return { ...base, difference: check.difference, differencePercent: check.differencePercent, outcome: check.outcome, opensClaim, shortfall: opensClaim ? invoicedTotal.minus(measured) : ZERO }
}

const two = (value: Decimal): string => value.toFixed(2, Dec.ROUND_HALF_UP)

/** The check in words (it/en), with the unit's symbol ("ft²"). */
export function areaCheckWords(check: AreaLineCheck, symbol: string): { readonly en: string; readonly it: string } {
  if (check.outcome === 'NOT_RECEIVED') return { en: `No hide received on this order line yet: ${two(check.invoicedTotal)} ${symbol} invoiced.`, it: `Nessuna pelle ricevuta su questa riga d'ordine: ${two(check.invoicedTotal)} ${symbol} fatturati.` }
  const hides = check.measuredHides + check.unmeasuredHides
  const counted =
    check.unmeasuredHides === 0
      ? { en: `all ${hides} hides measured`, it: `tutte le ${hides} pelli misurate` }
      : { en: `${check.measuredHides} of ${hides} hides measured, the others counted with the area received`, it: `${check.measuredHides} pelli misurate su ${hides}, le altre contate con l'area ricevuta` }
  const head = { en: `Invoiced ${two(check.invoicedTotal)} ${symbol}, measured ${two(check.measured)} ${symbol} received (${counted.en})`, it: `Fatturati ${two(check.invoicedTotal)} ${symbol}, misurati ${two(check.measured)} ${symbol} ricevuti (${counted.it})` }
  const pct = check.differencePercent.replace('-', '')
  if (check.outcome === 'SHORT')
    return { en: `${head.en}: ${two(check.shortfall)} ${symbol} (${pct} %) short, beyond the ${check.tolerancePercent} % tolerance. An area claim is in order.`, it: `${head.it}: ${two(check.shortfall)} ${symbol} (${pct} %) in meno, oltre la tolleranza del ${check.tolerancePercent} %. Si può aprire un reclamo per l'area.` }
  if (check.outcome === 'OVER') return { en: `${head.en}: more than invoiced (${pct} %), beyond the ${check.tolerancePercent} % tolerance. No claim.`, it: `${head.it}: più del fatturato (${pct} %), oltre la tolleranza del ${check.tolerancePercent} %. Nessun reclamo.` }
  return { en: `${head.en}: within the ${check.tolerancePercent} % tolerance.`, it: `${head.it}: entro la tolleranza del ${check.tolerancePercent} %.` }
}

/** The claim's words for the supplier (purchasing's reasonNote), naming the invoice and the order line. */
export function areaClaimNote(input: { readonly invoiceNumber: string; readonly lineSeq: number; readonly orderNumber: string; readonly orderLineSeq: number }, check: AreaLineCheck, symbol: string): string {
  return `Invoice ${input.invoiceNumber} line ${input.lineSeq} (order ${input.orderNumber} line ${input.orderLineSeq}): ${two(check.invoicedTotal)} ${symbol} invoiced against ${two(check.measured)} ${symbol} measured on the hides received, ${two(check.shortfall)} ${symbol} (${check.differencePercent.replace('-', '')} %) short, beyond the ${check.tolerancePercent} % tolerance.`
}

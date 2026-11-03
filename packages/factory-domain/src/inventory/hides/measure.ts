import type { Issue } from '../../core/errors'
import { fitsDecimal, QUANTITY } from '../../core/money'
import { QUANTITY_SCALE } from '../../product/units/units'
import { Dec, HUNDRED, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import { isAreaUom } from './area'

/**
 * Re-measure and area check (B-W2b-94; SCM-249, QHS-025; factory-db HideMeasure, append-only), pure. A whole hide is
 * measured again (a measuring machine, a pin wheel) and set against the tannery's area: the declared area typed from the
 * tannery's list, else the area the hide was received with (Hide.area, which never changes: W1's rule). A measure is a new
 * row; a wrong one is followed by another (the latest counts). The hide's stock changes only by an ADJUSTMENT move the office
 * asks for with the measure (inventory.adjust), never by rewriting the hide.
 *
 *   difference          measured − declared (negative: short)
 *   difference percent  difference ÷ declared × 100, two decimals
 *   outcome             WITHIN the tolerance either way; SHORT or OVER beyond it
 *
 * A lot is checked on its measured hides together (the tannery bills the lot): Σ measured against Σ declared, the same
 * outcome. A lot SHORT beyond the tolerance opens a claim to the supplier (purchasing's claims, B-W2a-44): the check says so
 * and gives the claim's lines (each hide measured short, by how much). The tolerance is the lot's purchase order line's
 * (PurchaseOrderLine.areaTolerancePct, agreed with the tannery); a lot with none takes AREA_TOLERANCE_PERCENT, until a
 * purchasing or inventory settings row keeps a default (B-W2b-80's schema need).
 */

/** The claim list's reason a short area is claimed with (the standard CLAIM list's "Short delivery"), when the tenant keeps it. */
export const AREA_CLAIM_REASON = 'SHORT_DELIVERY'

/** The default tolerance on a leather area, percent either way, for a lot whose order line says none (a schema need). */
export const AREA_TOLERANCE_PERCENT = '2.00'

export const AREA_OUTCOMES = ['WITHIN', 'SHORT', 'OVER'] as const
export type AreaOutcome = (typeof AREA_OUTCOMES)[number]

export const MEASURE_LIMITS = Object.freeze({ note: 500, reason: 500, futureMs: 2 * 60 * 1000 })

export interface AreaCheck {
  readonly declared: Decimal
  readonly measured: Decimal
  /** measured − declared. */
  readonly difference: Decimal
  /** Two decimals; "0.00" when nothing was declared. */
  readonly differencePercent: string
  readonly outcome: AreaOutcome
}

/** One area against the other, with the tolerance in percent. */
export function areaCheck(declared: DecimalInput, measured: DecimalInput, tolerancePercent: DecimalInput = AREA_TOLERANCE_PERCENT): AreaCheck {
  const said = new Dec(declared.toString())
  const found = new Dec(measured.toString())
  const difference = found.minus(said)
  const percent = said.isZero() ? ZERO : difference.times(HUNDRED).dividedBy(said)
  const tolerance = new Dec(tolerancePercent.toString())
  const outcome: AreaOutcome = percent.abs().lessThanOrEqualTo(tolerance) ? 'WITHIN' : percent.isNegative() ? 'SHORT' : 'OVER'
  return { declared: said, measured: found, difference, differencePercent: percent.toFixed(2, Dec.ROUND_HALF_UP), outcome }
}

export interface MeasureDraft {
  readonly measuredArea: string
  readonly declaredArea?: string | null | undefined
  readonly areaUom: string
  readonly measuredAt?: Date | null | undefined
  readonly note?: string | null | undefined
}

const positiveArea = (value: string): boolean => fitsDecimal(value, QUANTITY.precision, QUANTITY.scale) && new Dec(value).greaterThan(0)

/** What a measure must say: an area above 0 (and the declared one, when typed) in M2, DM2 or FT2, not in the future. */
export function measureDraftProblems(draft: MeasureDraft, now: Date): Issue[] {
  const problems: Issue[] = []
  if (!positiveArea(draft.measuredArea)) problems.push({ path: 'measuredArea', message: 'The measured area is above 0, at most four decimals.' })
  if (draft.declaredArea !== undefined && draft.declaredArea !== null && !positiveArea(draft.declaredArea)) problems.push({ path: 'declaredArea', message: "The tannery's area is above 0, at most four decimals." })
  if (!isAreaUom(draft.areaUom)) problems.push({ path: 'areaUom', message: 'An area is in m², dm² or ft².' })
  if (draft.measuredAt && draft.measuredAt.getTime() > now.getTime() + MEASURE_LIMITS.futureMs) problems.push({ path: 'measuredAt', message: 'A hide is measured now or before, never later.' })
  if (draft.note && draft.note.trim().length > MEASURE_LIMITS.note) problems.push({ path: 'note', message: `At most ${MEASURE_LIMITS.note} characters.` })
  return problems
}

/**
 * Why a hide cannot be measured against the tannery's area now, or null: only a whole hide (FULL) is; a cut one, a remnant,
 * a used, scrapped or returned one is not the hide the tannery measured.
 */
export function measureRefusal(hide: { readonly code: string; readonly state: string }): string | null {
  switch (hide.state) {
    case 'FULL':
      return null
    case 'PARTLY_CUT':
    case 'REMNANT':
      return `Hide ${hide.code} was cut already: only a whole hide is measured against the tannery's area.`
    case 'CONSUMED':
      return `Hide ${hide.code} is used up: there is nothing left to measure.`
    case 'SCRAPPED':
      return `Hide ${hide.code} was scrapped: it is not measured any more.`
    case 'RETURNED':
      return `Hide ${hide.code} went back to the supplier: it is not measured any more.`
    default:
      return `Hide ${hide.code} is ${hide.state}: it is not measured.`
  }
}

export interface StockCorrection {
  readonly direction: 'IN' | 'OUT'
  /** Above 0, in the item's base unit, four decimals. */
  readonly quantity: Decimal
}

/** The adjustment that makes the hide's stock say the measured area: null when it says it already. */
export function stockCorrection(onHand: DecimalInput, measured: DecimalInput): StockCorrection | null {
  const delta = new Dec(measured.toString()).minus(onHand.toString()).toDecimalPlaces(QUANTITY_SCALE, Dec.ROUND_HALF_UP)
  if (delta.isZero()) return null
  return { direction: delta.isNegative() ? 'OUT' : 'IN', quantity: delta.abs() }
}

/** The words of a correction move: what was measured against what the stock said. */
export function correctionNote(hideCode: string, measured: string, onHand: string, symbol: string, note?: string | null): string {
  const own = note?.trim()
  return `Hide ${hideCode} measured ${measured} ${symbol}; its stock said ${onHand} ${symbol}.${own ? ` ${own}` : ''}`
}

export interface MeasuredHide {
  readonly hideId: string
  readonly code: string
  /** Both in one unit (the lot's article's base unit). */
  readonly declared: DecimalInput
  readonly measured: DecimalInput
}

export interface ClaimLine {
  readonly hideId: string
  readonly quantity: string
  readonly reason: string
}

export interface LotCheck {
  readonly hides: number
  readonly check: AreaCheck | null
  /** A lot measured short beyond the tolerance: a claim to the supplier is in order. */
  readonly opensClaim: boolean
  /** One per hide measured short (any amount): how much it is short. */
  readonly claimLines: readonly ClaimLine[]
}

/** The lot's measured hides together. */
export function lotCheck(hides: readonly MeasuredHide[], uomSymbol: string, tolerancePercent: DecimalInput = AREA_TOLERANCE_PERCENT): LotCheck {
  if (hides.length === 0) return { hides: 0, check: null, opensClaim: false, claimLines: [] }
  const declared = hides.reduce<Decimal>((sum, hide) => sum.plus(hide.declared.toString()), ZERO)
  const measured = hides.reduce<Decimal>((sum, hide) => sum.plus(hide.measured.toString()), ZERO)
  const check = areaCheck(declared, measured, tolerancePercent)
  const opensClaim = check.outcome === 'SHORT'
  const claimLines = opensClaim
    ? hides.flatMap((hide) => {
        const short = new Dec(hide.declared.toString()).minus(hide.measured.toString())
        return short.greaterThan(0) ? [{ hideId: hide.hideId, quantity: short.toFixed(QUANTITY_SCALE), reason: `Hide ${hide.code}: ${short.toFixed(2)} ${uomSymbol} short of the tannery's area.` }] : []
      })
    : []
  return { hides: hides.length, check, opensClaim, claimLines }
}

/** The claim's words for the supplier (purchasing's reasonNote): the lot's shortfall against the tolerance. */
export function claimNote(lotCode: string, check: AreaCheck, hides: number, uomSymbol: string, tolerancePercent: DecimalInput = AREA_TOLERANCE_PERCENT): string {
  return `Lot ${lotCode}: ${hides} ${hides === 1 ? 'hide' : 'hides'} measured ${check.measured.toFixed(2)} ${uomSymbol} against the ${check.declared.toFixed(2)} ${uomSymbol} invoiced, ${check.difference.abs().toFixed(2)} ${uomSymbol} (${check.differencePercent.replace('-', '')} %) short, beyond the ${new Dec(tolerancePercent.toString()).toFixed(2)} % tolerance.`
}

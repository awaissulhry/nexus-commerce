import type { Issue } from '../../core/errors'
import { fromMinorUnits, minorPlaces } from '../../core/money'

/**
 * Insurance and declared value per parcel (B-W2b-400; LOG-042 "insurance for high-value suits"; factory-db Parcel
 * declaredValue, insuredValue and ShippingSettings.insureAbove, B-W2b-367), pure. Money of the price grain: the office with
 * money.price only, never the floor.
 *
 *   goods value   what a parcel holds at the order's prices: each line's net amount per piece times the pieces in the
 *                 parcel (the carton contents when the line was scanned into cartons, else the line's parcel), in the
 *                 order's currency, minor units
 *   declared      the value declared to the carrier (0 or more); the office types it, or takes the goods value
 *   insured       the value insured (above 0, at most the declared value when one is declared); null: not insured
 *   the rule      the site insures a parcel whose declared value is ABOVE its insureAbove (company currency): the parcel is
 *                 then insured for its declared value, and one at or below it is not. A parcel in another currency is
 *                 compared at the day's rate; with no rate, no declared value or no rule on the site the rule cannot say
 *                 (words) and the insurance typed by hand stays
 */

/** At most 10 000 000.00 in two-decimal currencies (an Int column; a parcel worth more is a typing slip). */
export const MAX_PARCEL_VALUE = 1_000_000_000

/** A line of the shipment with what its order line says (price grain). */
export interface ValuedLine {
  readonly id: string
  /** The parcel the whole line lies in (W1), when it has no carton contents. */
  readonly parcelId: string | null
  readonly quantity: number
  /** The order line's pieces and its net amount (minor units of the order's currency). */
  readonly orderLineQuantity: number
  readonly orderLineNet: number
}

/** Carton contents (B-W2b-384): pieces of a line scanned into a parcel. */
export interface ValuedContent {
  readonly shipmentLineId: string
  readonly parcelId: string
  readonly quantity: number
}

/** The net value of `pieces` of an order line (rounded half up to the minor unit). */
export const piecesValue = (pieces: number, line: Pick<ValuedLine, 'orderLineQuantity' | 'orderLineNet'>): number =>
  line.orderLineQuantity > 0 ? Math.round((line.orderLineNet * pieces) / line.orderLineQuantity) : 0

/** Each parcel's goods value (minor units of the order's currency); a parcel holding nothing is 0. */
export function goodsValues(parcelIds: readonly string[], lines: readonly ValuedLine[], contents: readonly ValuedContent[]): Map<string, number> {
  const values = new Map(parcelIds.map((id) => [id, 0]))
  for (const line of lines) {
    const scanned = contents.filter((content) => content.shipmentLineId === line.id)
    const placed = scanned.length > 0 ? scanned.map((content) => ({ parcelId: content.parcelId, pieces: content.quantity })) : line.parcelId ? [{ parcelId: line.parcelId, pieces: line.quantity }] : []
    for (const { parcelId, pieces } of placed) if (values.has(parcelId)) values.set(parcelId, values.get(parcelId)! + piecesValue(pieces, line))
  }
  return values
}

/** What the rule says of one parcel: insure it (true), not (false), or it cannot say (null), in words. */
export interface InsuranceRuleView {
  readonly insure: boolean | null
  readonly words: string
}

/**
 * The rule for a declared value already in the company's currency (`declaredInCompany`; null: no declared value, or no rate
 * to compare it). `insureAbove` null: the site insures nothing by rule. `amounts` false: the words name no amount (a reader
 * without the price grain).
 */
export function insuranceRuleOf(
  input: { readonly declared: number | null; readonly declaredInCompany: number | null; readonly insureAbove: number | null; readonly companyCurrency: string; readonly orderCurrency: string },
  amounts = true,
): InsuranceRuleView {
  if (input.insureAbove === null) return { insure: null, words: 'The site insures no parcel by rule: insure a parcel by hand.' }
  const above = amounts ? `above ${fromMinorUnits(input.insureAbove, input.companyCurrency).toFixed(minorPlaces(input.companyCurrency))} ${input.companyCurrency}` : "above the site's value"
  if (input.declared === null) return { insure: null, words: `No declared value yet: the site insures a parcel declared ${above}.` }
  if (input.declaredInCompany === null) return { insure: null, words: `No exchange rate of ${input.orderCurrency} today to compare with the rule (${above}): decide the insurance yourself.` }
  return input.declaredInCompany > input.insureAbove
    ? { insure: true, words: `Declared ${above}: insured for its declared value by the site's rule.` }
    : { insure: false, words: `Declared at or below the site's value${amounts ? ` (${above.slice('above '.length)})` : ''}: not insured by the site's rule.` }
}

/**
 * The insured value after the rule: the declared value when the rule insures the parcel, none when it does not, and the
 * present one (at most the declared value) when the rule cannot say (no rule on the site, no declared value, no rate).
 */
export function insuredAfterRule(declared: number | null, present: number | null, rule: InsuranceRuleView): number | null {
  if (rule.insure === true) return declared !== null && declared > 0 ? declared : null
  if (rule.insure === false) return null
  return present !== null && (declared === null || present <= declared) ? present : null
}

/** The field problems of a parcel's values (400): whole minor units, declared 0 or more, insured above 0 and at most declared. */
export function parcelValueProblems(declared: number | null, insured: number | null, at = 'body'): Issue[] {
  const problems: Issue[] = []
  const bad = (value: number | null) => value !== null && (!Number.isSafeInteger(value) || value > MAX_PARCEL_VALUE)
  if (bad(declared) || (declared !== null && declared < 0)) problems.push({ path: `${at}/declaredValue`, message: 'The declared value is a whole amount in minor units, 0 or more (at most 10 000 000.00).' })
  if (bad(insured) || (insured !== null && insured <= 0)) problems.push({ path: `${at}/insuredValue`, message: 'The insured value is a whole amount in minor units above 0 (at most 10 000 000.00); leave it empty for no insurance.' })
  if (problems.length === 0 && insured !== null && declared !== null && insured > declared) problems.push({ path: `${at}/insuredValue`, message: 'A parcel is insured for at most its declared value.' })
  return problems
}

/** The field problem of a site's rule value (400): 0 or more, or null (no rule). */
export function insureAboveProblem(value: number | null): string | null {
  if (value === null) return null
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_PARCEL_VALUE ? null : 'The value above which parcels are insured is a whole amount in minor units, 0 or more (at most 10 000 000.00); empty: no rule.'
}

/** A minor-unit value as the decimal a carrier takes ("520.00"). */
export const decimalOf = (value: number, currency: string): string => fromMinorUnits(value, currency).toFixed(minorPlaces(currency))

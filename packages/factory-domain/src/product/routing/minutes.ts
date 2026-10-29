import type { Decimal } from 'decimal.js'
import { decimalOf, decimalText, roundTo, type DecimalInput, type RoundTo } from '../units/units'
import { MINUTES_SCALE, WORK_CENTRE_KINDS, type WorkCentreKind } from './operations'
import type { StepFields } from './rules'

/**
 * What a routing takes in standard minutes (features PRD-110, PRD-111), pure: per garment, per kind of work centre (the
 * routing screen's department subtotals) and per size of the style's range. The cost sheet (B-W1-16) prices the minutes
 * per kind of work centre; capacity planning multiplies them by a work order's quantity.
 *
 * Per size: a step has one standard minute value for every size in W1 (the schema holds no per-size minutes; extra
 * minutes for big sizes and options, PRD-114, are W2b), so every size of the range takes the garment's minutes. The
 * per-size answer is there so the cost sheet and the screens read one shape now and later.
 *
 * Exact (decimal.js) until the one rounding the caller names (a screen: half up to MINUTES_SCALE); step minutes have 3
 * decimals, so a sum of them is exact at 3 decimals, and a product by a quantity is rounded once at the end.
 */

/** A screen's figures: half up to the minutes' scale. */
export const MINUTES_ROUND: RoundTo = { scale: MINUTES_SCALE, rounding: 'HALF_UP' }

/** The steps' minutes added up, exact. */
export function sumMinutes(steps: readonly Pick<StepFields, 'standardMinutes'>[]): Decimal {
  return steps.reduce((sum, step) => sum.plus(decimalOf(step.standardMinutes, 'standardMinutes')), decimalOf('0'))
}

/** One garment of this size, exact (the same for every size in W1: see above). */
export function sizeMinutes(steps: readonly Pick<StepFields, 'standardMinutes'>[], _size: string): Decimal {
  return sumMinutes(steps)
}

/** Minutes for a quantity of garments (a work order, a capacity check), rounded once as the caller says. */
export function minutesForQuantity(perGarment: DecimalInput, quantity: DecimalInput, round: RoundTo): string {
  return decimalText(roundTo(decimalOf(perGarment, 'minutes').times(decimalOf(quantity, 'quantity')), round))
}

export interface RoutingMinutes {
  /** One garment, every step. */
  readonly perGarment: string
  /** Per kind of work centre present, in floor order (WORK_CENTRE_KINDS): its minutes and steps. */
  readonly byKind: readonly { readonly workCentreKind: WorkCentreKind; readonly minutes: string; readonly steps: number }[]
  /** Per size of the range, in its order. */
  readonly bySize: readonly { readonly size: string; readonly minutes: string }[]
  readonly steps: number
  /** Steps the floor scans. */
  readonly scanPoints: number
}

/** The routing's minutes, each figure rounded once as the caller says. */
export function routingMinutes(steps: readonly Pick<StepFields, 'standardMinutes' | 'workCentreKind' | 'scanRequired'>[], sizes: readonly string[], round: RoundTo): RoutingMinutes {
  const shown = (value: Decimal): string => decimalText(roundTo(value, round))
  const byKind = WORK_CENTRE_KINDS.flatMap((workCentreKind) => {
    const ofKind = steps.filter((step) => step.workCentreKind === workCentreKind)
    return ofKind.length === 0 ? [] : [{ workCentreKind, minutes: shown(sumMinutes(ofKind)), steps: ofKind.length }]
  })
  return {
    perGarment: shown(sumMinutes(steps)),
    byKind,
    bySize: sizes.map((size) => ({ size, minutes: shown(sizeMinutes(steps, size)) })),
    steps: steps.length,
    scanPoints: steps.filter((step) => step.scanRequired).length,
  }
}

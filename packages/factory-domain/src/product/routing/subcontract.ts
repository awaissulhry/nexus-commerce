import type { Issue } from '../../core/errors'
import { fitsDecimal } from '../../core/money'
import { decimalOf, decimalText } from '../units/units'

/**
 * A subcontracted routing step (feature PRD-120; W2a; SCM-139 merged), pure: the step of a style revision's routing that
 * an outside workshop (a terzista: a party with the SUBCONTRACTOR role, checked by the API) does, with its fee per piece
 * (money of the cost grain, in euros: a subcontract order copies it in its own currency, SCM-138, B-W2a-25) and the
 * days the pieces travel there and back. Null: the step is done in-house.
 *
 *   workshop     required for a fee or transit days (the database's RoutingOperation_subcontract_guard holds it too)
 *   fee          0 or more, Decimal(18,6): at most 12 digits and 6 decimals; optional (agreed per order)
 *   transit      whole days, 0 to 365; optional
 *
 * Like the rest of the routing, it changes only while the revision is a DRAFT; a released revision is frozen. The floor
 * never reads the fee (its grant on RoutingOperation leaves pricePerPiece out); the office sees it with the cost grain.
 */

export const MAX_TRANSIT_DAYS = 365
export const FEE_PRECISION = 18
export const FEE_SCALE = 6

export interface Subcontract {
  readonly supplierId: string
  /** Per piece, a plain decimal string ("4.5"); null: agreed per order. */
  readonly pricePerPiece: string | null
  readonly transitDays: number | null
}

/**
 * A change to a step's subcontract details: null takes the step back in-house (fee and days go with it); an object sets
 * what it names (a field left out stays; a fee or days without a workshop needs one already there).
 */
export type SubcontractChange =
  | null
  | {
      readonly supplierId?: string | undefined
      readonly pricePerPiece?: string | null | undefined
      readonly transitDays?: number | null | undefined
    }

export type SubcontractPlan = { readonly ok: true; readonly subcontract: Subcontract | null } | { readonly ok: false; readonly issues: readonly Issue[] }

export function feeProblem(value: string): string | null {
  if (!/^\d+(?:\.\d+)?$/.test(value) || !fitsDecimal(value, FEE_PRECISION, FEE_SCALE)) return `Expected a fee per piece of 0 or more, with at most ${FEE_PRECISION - FEE_SCALE} digits and ${FEE_SCALE} decimals.`
  return null
}

export function transitProblem(value: number): string | null {
  return Number.isInteger(value) && value >= 0 && value <= MAX_TRANSIT_DAYS ? null : `Transit days are a whole number from 0 to ${MAX_TRANSIT_DAYS}.`
}

/** The step's subcontract details after the change, or every problem at once (paths under `subcontract/`). */
export function planSubcontract(current: Subcontract | null, change: SubcontractChange): SubcontractPlan {
  if (change === null) return { ok: true, subcontract: null }
  const issues: Issue[] = []
  const supplierId = change.supplierId ?? current?.supplierId
  if (supplierId === undefined) {
    return { ok: false, issues: [{ path: 'subcontract/supplierId', message: 'Name the workshop that does the step before its fee or transit days.' }] }
  }
  // Another workshop starts with its own terms: what the change leaves out is cleared, never carried over.
  const sameWorkshop = current !== null && current.supplierId === supplierId
  const fee = change.pricePerPiece !== undefined ? change.pricePerPiece : sameWorkshop ? current.pricePerPiece : null
  const days = change.transitDays !== undefined ? change.transitDays : sameWorkshop ? current.transitDays : null
  if (fee !== null) {
    const problem = feeProblem(fee)
    if (problem) issues.push({ path: 'subcontract/pricePerPiece', message: problem })
  }
  if (days !== null) {
    const problem = transitProblem(days)
    if (problem) issues.push({ path: 'subcontract/transitDays', message: problem })
  }
  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, subcontract: { supplierId, pricePerPiece: fee === null ? null : decimalText(fee), transitDays: days } }
}

/** Two subcontract details are the same (fees by value). */
export function sameSubcontract(a: Subcontract | null, b: Subcontract | null): boolean {
  if (a === null || b === null) return a === b
  const sameFee = a.pricePerPiece === null || b.pricePerPiece === null ? a.pricePerPiece === b.pricePerPiece : decimalOf(a.pricePerPiece).eq(decimalOf(b.pricePerPiece))
  return a.supplierId === b.supplierId && sameFee && a.transitDays === b.transitDays
}

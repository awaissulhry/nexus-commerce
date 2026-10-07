/**
 * Cases (Step 3, Owner D2 = B) — the ONE rule for sealed cases and loose units at a location, used by the API's
 * invariant keeper (`stock/stock-cases.service.ts`) and by the web's stock editor and Matrix Case column, so a screen
 * cannot show a split the server would not keep. Pure: no I/O, no clock.
 *
 *   StockLevel.quantity stays the UNIT total. StockCaseCount.cases = the sealed cases there.
 *   loose = quantity − sealed × unitsPerCase.    Invariant: sealed × unitsPerCase ≤ quantity.
 *
 * A sale takes loose units first, then opens a case. As a clamp: after any unit decrease the sealed count is
 * `min(cases, floor(quantityAfter / unitsPerCase))` — 4 cases + 3 loose (51 at 12 / case), sell 3 → 48 = 4 + 0, sell 1
 * more → 47 = 3 + 11. A unit increase can never break the invariant, so it never touches the count. Whole cases that
 * leave (Step 4, Send to FBA) pass an explicit `casesChange`: with 4 cases + 30 loose, sending 2 cases must leave 2,
 * which the clamp alone would not.
 */

/** Amazon's createInboundPlan prepOwner / labelOwner values Nexus offers (Seller Central's "Amazon" | "Seller"). */
export const CASE_OWNERS = ['AMAZON', 'SELLER'] as const
export type CaseOwner = (typeof CASE_OWNERS)[number]

/** The most units one case may hold. */
export const MAX_UNITS_PER_CASE = 10_000
/** The largest case side Nexus stores, in cm, and the heaviest case, in kg (`ProductPackage` Decimal(6,1) / (6,2)). */
export const MAX_CASE_SIDE_CM = 300
export const MAX_CASE_WEIGHT_KG = 1000

/** Amazon EU's box limits. Forum-sourced, so a warning in Step 3, never a refusal. */
export const AMAZON_EU_BOX = { maxSideCm: 63.5, maxKg: 23 } as const

export type CaseProblemCode = 'NO_CASE_SIZE' | 'NOT_A_WAREHOUSE' | 'INVALID_CASES' | 'CASES_EXCEED_UNITS'
export interface CaseProblem { code: CaseProblemCode; message: string }

/** The operator's words for every case cell, refusal and warning — one place for the API and both screens. */
export const CASE_COPY = {
  perCase: (n: number) => `${n} / case`,
  split: (sealed: number, loose: number) => `${sealed} + ${loose}`,
  exceeds: (cases: number, upc: number, qty: number) => `${cases} cases need ${cases * upc} units; on hand is ${qty}`,
  noSize: 'No case size — set it in the Matrix (Case column)',
  notHere: 'Cases are counted at your own warehouses only',
  invalidCases: 'Sealed cases must be a whole number, 0 or more',
  sealedOpen: (n: number, where: string) =>
    `${n} sealed ${n === 1 ? 'case' : 'cases'} at ${where} ${n === 1 ? 'becomes' : 'become'} loose units. Count them again under Stock.`,
  boxLimit: 'Amazon EU takes boxes up to 63.5 cm a side and 23 kg.',
} as const

/** A case size the rule can work with: a whole number of units, at least 1. */
function caseSize(unitsPerCase: number | null | undefined): number | null {
  return typeof unitsPerCase === 'number' && Number.isInteger(unitsPerCase) && unitsPerCase >= 1 ? unitsPerCase : null
}

/** A count as the rule reads it: a whole number, never below 0. */
function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

/** True for `'AMAZON'` and `'SELLER'` — narrows the string a `ProductPackage` owner column holds. */
export function isCaseOwner(value: unknown): value is CaseOwner {
  return typeof value === 'string' && (CASE_OWNERS as readonly string[]).includes(value)
}

/** What a reader shows: never more sealed cases than the units allow. No case size → 0. */
export function sealedCases(stored: number, quantity: number, unitsPerCase: number | null): number {
  const size = caseSize(unitsPerCase)
  if (size === null) return 0
  return Math.min(count(stored), Math.floor(count(quantity) / size))
}

/**
 * Sealed and loose, and what holds leave free. A hold takes loose units first, then whole cases:
 * `freeLoose = max(0, loose − reserved)`, `freeSealed = sealed − ceil(max(0, reserved − loose) / unitsPerCase)` — what
 * Step 4 may send as whole cases. No case size → everything is loose.
 */
export function caseSplit(i: { quantity: number; reserved: number; cases: number; unitsPerCase: number | null }): {
  sealed: number
  loose: number
  freeSealed: number
  freeLoose: number
} {
  const quantity = count(i.quantity)
  const reserved = count(i.reserved)
  const size = caseSize(i.unitsPerCase)
  const sealed = sealedCases(i.cases, quantity, size)
  const loose = quantity - sealed * (size ?? 0)
  const freeLoose = Math.max(0, loose - reserved)
  const freeSealed = size === null ? 0 : Math.max(0, sealed - Math.ceil(Math.max(0, reserved - loose) / size))
  return { sealed, loose, freeSealed, freeLoose }
}

/**
 * The sealed count after units moved at one level.
 * - No `casesChange` (every sale, consume, transfer out, count, import): `min(cases, floor(quantityAfter / unitsPerCase))`;
 *   `opened` = the cases that became loose.
 * - `casesChange` < 0 (whole cases left, Step 4): `cases + casesChange`, then the same clamp (the loose units that
 *   left with them may open one more case); refused when more cases leave than are sealed.
 * - `casesChange` > 0 (whole cases arrived sealed): `cases + casesChange`; refused when the units do not cover them.
 * - A `casesChange` that is not a whole number, or no case size, is refused.
 */
export function casesAfterMove(i: { cases: number; quantityAfter: number; unitsPerCase: number; casesChange?: number }):
  { cases: number; opened: number } | { refused: CaseProblem } {
  const size = caseSize(i.unitsPerCase)
  if (size === null) return { refused: { code: 'NO_CASE_SIZE', message: CASE_COPY.noSize } }
  const before = count(i.cases)
  const quantityAfter = count(i.quantityAfter)
  const fits = Math.floor(quantityAfter / size)
  if (i.casesChange === undefined) {
    const after = Math.min(before, fits)
    return { cases: after, opened: before - after }
  }
  if (!Number.isInteger(i.casesChange)) return { refused: { code: 'INVALID_CASES', message: CASE_COPY.invalidCases } }
  const moved = before + i.casesChange
  if (moved < 0) {
    return { refused: { code: 'INVALID_CASES', message: `${-i.casesChange} sealed cases cannot leave; ${before} are sealed here` } }
  }
  if (i.casesChange > 0) {
    if (moved > fits) return { refused: { code: 'CASES_EXCEED_UNITS', message: CASE_COPY.exceeds(moved, size, quantityAfter) } }
    return { cases: moved, opened: 0 }
  }
  const after = Math.min(moved, fits)
  return { cases: after, opened: moved - after }
}

/**
 * Why an absolute sealed count is not allowed at this location, or null. Cases are counted at WAREHOUSE locations
 * only (FBA and Shopify stay units, owned by the channel). 0 is always allowed at a warehouse: it can never break the
 * invariant.
 */
export function caseCountProblem(i: { cases: number; quantity: number; unitsPerCase: number | null; locationType: string }): CaseProblem | null {
  if (i.locationType !== 'WAREHOUSE') return { code: 'NOT_A_WAREHOUSE', message: CASE_COPY.notHere }
  if (!Number.isInteger(i.cases) || i.cases < 0) return { code: 'INVALID_CASES', message: CASE_COPY.invalidCases }
  if (i.cases === 0) return null
  const size = caseSize(i.unitsPerCase)
  if (size === null) return { code: 'NO_CASE_SIZE', message: CASE_COPY.noSize }
  const quantity = count(i.quantity)
  if (i.cases * size > quantity) return { code: 'CASES_EXCEED_UNITS', message: CASE_COPY.exceeds(i.cases, size, quantity) }
  return null
}

/** One SKU's case pack, absolute; null clears a value (`ProductPackage`). Sizes in cm, weight in kg. */
export interface CasePackValues {
  unitsPerCase: number | null
  caseLengthCm: number | null
  caseWidthCm: number | null
  caseHeightCm: number | null
  caseWeightKg: number | null
  fbaPrepOwner: CaseOwner | null
  fbaLabelOwner: CaseOwner | null
}

const SIDES = [
  ['caseLengthCm', 'Case length'],
  ['caseWidthCm', 'Case width'],
  ['caseHeightCm', 'Case height'],
] as const

/** Why these case pack values cannot be saved, or null: units a whole number 1..10000; 0 < side ≤ 300 cm; 0 < kg ≤ 1000; owners Amazon | Seller. */
export function packProblem(v: CasePackValues): string | null {
  if (v.unitsPerCase !== null && (!Number.isInteger(v.unitsPerCase) || v.unitsPerCase < 1 || v.unitsPerCase > MAX_UNITS_PER_CASE)) {
    return `Units per case must be a whole number from 1 to ${MAX_UNITS_PER_CASE}`
  }
  for (const [key, label] of SIDES) {
    const side = v[key]
    if (side !== null && (!Number.isFinite(side) || side <= 0 || side > MAX_CASE_SIDE_CM)) {
      return `${label} must be more than 0 and at most ${MAX_CASE_SIDE_CM} cm`
    }
  }
  if (v.caseWeightKg !== null && (!Number.isFinite(v.caseWeightKg) || v.caseWeightKg <= 0 || v.caseWeightKg > MAX_CASE_WEIGHT_KG)) {
    return `Case weight must be more than 0 and at most ${MAX_CASE_WEIGHT_KG} kg`
  }
  if (v.fbaPrepOwner !== null && !isCaseOwner(v.fbaPrepOwner)) return 'Prep by must be Amazon or Seller'
  if (v.fbaLabelOwner !== null && !isCaseOwner(v.fbaLabelOwner)) return 'Labels by must be Amazon or Seller'
  return null
}

/** Amazon EU's box limit, as a warning: a side over 63.5 cm or a weight over 23 kg. Never a refusal. */
export function amazonBoxWarning(v: CasePackValues): string | null {
  const sides = [v.caseLengthCm, v.caseWidthCm, v.caseHeightCm]
  const tooLong = sides.some(side => side !== null && side > AMAZON_EU_BOX.maxSideCm)
  const tooHeavy = v.caseWeightKg !== null && v.caseWeightKg > AMAZON_EU_BOX.maxKg
  return tooLong || tooHeavy ? CASE_COPY.boxLimit : null
}

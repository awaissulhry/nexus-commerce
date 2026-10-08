/**
 * Cases (Step 3, Owner D2 = B; several case sizes per SKU, Owner 2026-10-08) — the ONE rule for sealed cases and loose
 * units at a location, used by the API's invariant keeper (`stock/stock-cases.service.ts`) and by the web's stock
 * editor, Matrix Case column and Send to FBA, so a screen cannot show a split the server would not keep. Pure: no I/O,
 * no clock.
 *
 *   A SKU has 0..MAX_CASE_SIZES case sizes (`ProductCaseSize`). The units per case NAME a size: unique per SKU.
 *   StockLevel.quantity stays the UNIT total. StockCaseCount = the sealed cases of one size there.
 *   loose = quantity − Σ sealed × unitsPerCase.    Invariant: Σ sealed × unitsPerCase ≤ quantity.
 *
 * A sale takes loose units first, then opens the SMALLEST case: the big ones stay sealed. As a clamp: after any unit
 * decrease, biggest size first, each size keeps min(cases, floor(units not yet in a bigger case / unitsPerCase)).
 * 12 / case and 6 / case, 2×12 + 1×6 + 3 loose (33): sell 3 → 30 = 2×12 + 1×6 + 0; sell 1 more → 29 = 2×12 + 5.
 * A unit increase never breaks the invariant, so it never touches a count. Whole cases that leave (Step 4, Send to FBA)
 * pass an explicit change per size: with 4×12 + 30 loose, sending 2 cases must leave 2, which the clamp alone would not.
 */

/** Amazon's createInboundPlan prepOwner / labelOwner values Nexus offers (Seller Central's "Amazon" | "Seller"). */
export const CASE_OWNERS = ['AMAZON', 'SELLER'] as const
export type CaseOwner = (typeof CASE_OWNERS)[number]

/** The most case sizes one SKU may have. */
export const MAX_CASE_SIZES = 5
/** The most units one case may hold. */
export const MAX_UNITS_PER_CASE = 10_000
/** The largest case side Nexus stores, in cm, and the heaviest case, in kg (`ProductCaseSize` Decimal(6,1) / (6,2)). */
export const MAX_CASE_SIDE_CM = 300
export const MAX_CASE_WEIGHT_KG = 1000

/** Amazon EU's box limits. Forum-sourced, so a warning in Step 3, never a refusal. */
export const AMAZON_EU_BOX = { maxSideCm: 63.5, maxKg: 23 } as const

/** Sealed cases of one size. The units per case name the size within its SKU. */
export interface CaseCount { unitsPerCase: number; cases: number }
/** Whole cases of one size that move with units: −2 = two cases leave sealed, +1 = one arrives sealed. */
export interface CaseChange { unitsPerCase: number; change: number }

export type CaseProblemCode = 'NO_CASE_SIZE' | 'NOT_A_WAREHOUSE' | 'INVALID_CASES' | 'CASES_EXCEED_UNITS'
export interface CaseProblem { code: CaseProblemCode; message: string }

const byUnitsDesc = (a: { unitsPerCase: number }, b: { unitsPerCase: number }) => b.unitsPerCase - a.unitsPerCase

/** `4 cases` (one size) · `2×12 + 1×6` (several sizes; sizes with 0 cases left out; `0` when none). */
function casesWords(counts: readonly CaseCount[]): string {
  if (counts.length === 1) return `${counts[0].cases} ${counts[0].cases === 1 ? 'case' : 'cases'}`
  const sealed = counts.filter((c) => c.cases > 0)
  return sealed.length ? sealed.map((c) => `${c.cases}×${c.unitsPerCase}`).join(' + ') : '0'
}

/** The operator's words for every case cell, refusal and warning — one place for the API and the screens. */
export const CASE_COPY = {
  perCase: (n: number) => `${n} / case`,
  /** A SKU's case sizes, biggest first: `12 / case`, `12 · 6 / case`; '' = none. */
  sizes: (units: readonly number[]) => (units.length ? `${[...units].sort((a, b) => b - a).join(' · ')} / case` : ''),
  /** Sealed + loose at a level: `4 + 3` (one size), `2×12 + 1×6 + 3` (several), `0 + 5` (several, none sealed). */
  split: (sealed: readonly CaseCount[], loose: number) =>
    sealed.length === 1 ? `${sealed[0].cases} + ${loose}` : `${casesWords(sealed)} + ${loose}`,
  /** `4 cases`, `2×12 + 1×6` — the sealed part alone. */
  cases: (sealed: readonly CaseCount[]) => casesWords(sealed),
  exceeds: (counts: readonly CaseCount[], qty: number) => `${casesWords(counts)} need ${sealedUnits(counts)} units; on hand is ${qty}`,
  noSize: 'No case size — set it in the Matrix (Case column)',
  noSizeOf: (n: number) => `No ${n} / case size — set it in the Matrix (Case column)`,
  notHere: 'Cases are counted at your own warehouses only',
  invalidCases: 'Sealed cases must be a whole number, 0 or more',
  sealedOpen: (n: number, where: string) =>
    `${n} sealed ${n === 1 ? 'case' : 'cases'} at ${where} ${n === 1 ? 'becomes' : 'become'} loose units. Count them again under Stock.`,
  boxLimit: 'Amazon EU takes boxes up to 63.5 cm a side and 23 kg.',
  tooManySizes: `At most ${MAX_CASE_SIZES} case sizes`,
  sameSize: (n: number) => `Two case sizes hold ${n} units. Give each size its own units per case.`,
} as const

/** A case size the rule can work with: a whole number of units, at least 1. */
export function isCaseSize(unitsPerCase: unknown): unitsPerCase is number {
  return typeof unitsPerCase === 'number' && Number.isInteger(unitsPerCase) && unitsPerCase >= 1
}

/** A count as the rule reads it: a whole number, never below 0. */
function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

/** True for `'AMAZON'` and `'SELLER'` — narrows the string a `ProductPackage` owner column holds. */
export function isCaseOwner(value: unknown): value is CaseOwner {
  return typeof value === 'string' && (CASE_OWNERS as readonly string[]).includes(value)
}

/** Units in these sealed cases: Σ cases × unitsPerCase. */
export function sealedUnits(counts: readonly CaseCount[]): number {
  return counts.reduce((n, c) => n + count(c.cases) * (isCaseSize(c.unitsPerCase) ? c.unitsPerCase : 0), 0)
}

/** One entry per valid size, biggest first; a size named twice keeps its first count. */
function sizesOf(counts: readonly CaseCount[]): CaseCount[] {
  const seen = new Set<number>()
  const out: CaseCount[] = []
  for (const c of counts) {
    if (!isCaseSize(c.unitsPerCase) || seen.has(c.unitsPerCase)) continue
    seen.add(c.unitsPerCase)
    out.push({ unitsPerCase: c.unitsPerCase, cases: count(c.cases) })
  }
  return out.sort(byUnitsDesc)
}

/** The counts of these sizes (every size of the SKU), the stored ones where given, 0 elsewhere — biggest first. */
export function countsFor(sizes: readonly number[], stored: readonly CaseCount[]): CaseCount[] {
  const of = new Map(stored.map((c) => [c.unitsPerCase, c.cases]))
  return sizesOf(sizes.map((unitsPerCase) => ({ unitsPerCase, cases: of.get(unitsPerCase) ?? 0 })))
}

/**
 * What stays sealed with `quantity` units: biggest size first, each keeps min(its count, floor(units not yet in a
 * bigger case / unitsPerCase)). `stored` = every size of the SKU with its stored count (0 where none). Answers one entry
 * per size, biggest first. A valid split is returned unchanged; fewer units open the smallest cases first.
 */
export function sealedCases(stored: readonly CaseCount[], quantity: number): CaseCount[] {
  let left = count(quantity)
  return sizesOf(stored).map((c) => {
    const kept = Math.min(c.cases, Math.floor(left / c.unitsPerCase))
    left -= kept * c.unitsPerCase
    return { unitsPerCase: c.unitsPerCase, cases: kept }
  })
}

/**
 * Sealed and loose, and what holds leave free. A hold takes loose units first, then opens the smallest case — so what
 * is free is the clamp at `quantity − reserved`: `freeSealed` = the sealed cases Step 4 may send whole, `freeLoose` =
 * the units free outside them. No case size → everything is loose.
 */
export function caseSplit(i: { quantity: number; reserved: number; cases: readonly CaseCount[] }): {
  sealed: CaseCount[]
  loose: number
  freeSealed: CaseCount[]
  freeLoose: number
} {
  const quantity = count(i.quantity)
  const sealed = sealedCases(i.cases, quantity)
  const free = Math.max(0, quantity - count(i.reserved))
  const freeSealed = sealedCases(sealed, free)
  return { sealed, loose: quantity - sealedUnits(sealed), freeSealed, freeLoose: free - sealedUnits(freeSealed) }
}

/**
 * The sealed counts after units moved at one level. `cases` = every size of the SKU with its stored count.
 * - No `casesChange` (every sale, consume, transfer out, count, import): the clamp at `quantityAfter`;
 *   `opened` = the cases that became loose.
 * - `casesChange` (whole cases moved, Step 4): each size's count + its change, then the same clamp (the loose units that
 *   left with them may open one more case). Refused when a size the SKU does not have is named, a change is not a whole
 *   number, more cases of a size leave than are sealed, or cases arrive that the units do not cover.
 */
export function casesAfterMove(i: { cases: readonly CaseCount[]; quantityAfter: number; casesChange?: readonly CaseChange[] }):
  { cases: CaseCount[]; opened: number } | { refused: CaseProblem } {
  const before = sizesOf(i.cases)
  if (before.length === 0) return { refused: { code: 'NO_CASE_SIZE', message: CASE_COPY.noSize } }
  const quantityAfter = count(i.quantityAfter)
  const changes = (i.casesChange ?? []).filter((c) => c.change !== 0)
  const moved = before.map((c) => ({ ...c }))
  for (const c of changes) {
    if (!Number.isInteger(c.change)) return { refused: { code: 'INVALID_CASES', message: CASE_COPY.invalidCases } }
    const at = moved.find((m) => m.unitsPerCase === c.unitsPerCase)
    if (!at) return { refused: { code: 'NO_CASE_SIZE', message: CASE_COPY.noSizeOf(c.unitsPerCase) } }
    at.cases += c.change
    if (at.cases < 0) {
      const sealed = before.find((b) => b.unitsPerCase === c.unitsPerCase)?.cases ?? 0
      return { refused: { code: 'INVALID_CASES', message: `${-c.change} sealed cases of ${c.unitsPerCase} cannot leave; ${sealed} are sealed here` } }
    }
  }
  if (changes.some((c) => c.change > 0) && sealedUnits(moved) > quantityAfter) {
    return { refused: { code: 'CASES_EXCEED_UNITS', message: CASE_COPY.exceeds(moved, quantityAfter) } }
  }
  const after = sealedCases(moved, quantityAfter)
  const opened = moved.reduce((n, m, k) => n + (m.cases - after[k].cases), 0)
  return { cases: after, opened }
}

/** `base` with each count of `typed` put in place (absolute, by size); sizes `typed` does not name keep theirs. */
export function withCounts(base: readonly CaseCount[], typed: readonly CaseCount[]): CaseCount[] {
  const of = new Map(typed.map((c) => [c.unitsPerCase, c.cases]))
  return base.map((c) => (of.has(c.unitsPerCase) ? { unitsPerCase: c.unitsPerCase, cases: of.get(c.unitsPerCase)! } : { ...c }))
}

/**
 * Why these absolute sealed counts are not allowed at this location, or null. `cases` = the counts after the change
 * (sizes not named keep theirs: see `withCounts`); `sizes` = the SKU's case sizes. Cases are counted at WAREHOUSE
 * locations only (FBA and Shopify stay units, owned by the channel). All 0 is always allowed at a warehouse.
 */
export function caseCountProblem(i: { cases: readonly CaseCount[]; quantity: number; sizes: readonly number[]; locationType: string }): CaseProblem | null {
  if (i.locationType !== 'WAREHOUSE') return { code: 'NOT_A_WAREHOUSE', message: CASE_COPY.notHere }
  if (i.cases.some((c) => !Number.isInteger(c.cases) || c.cases < 0)) return { code: 'INVALID_CASES', message: CASE_COPY.invalidCases }
  const sealed = i.cases.filter((c) => c.cases > 0)
  if (sealed.length === 0) return null
  const missing = sealed.find((c) => !i.sizes.includes(c.unitsPerCase))
  if (missing) return { code: 'NO_CASE_SIZE', message: i.sizes.length ? CASE_COPY.noSizeOf(missing.unitsPerCase) : CASE_COPY.noSize }
  const quantity = count(i.quantity)
  if (sealedUnits(i.cases) > quantity) return { code: 'CASES_EXCEED_UNITS', message: CASE_COPY.exceeds(sizesOf(i.cases), quantity) }
  return null
}

/** One case size of a SKU, absolute (`ProductCaseSize`). Sizes in cm, weight in kg; null = not set. */
export interface CaseSizeValues {
  unitsPerCase: number
  caseLengthCm: number | null
  caseWidthCm: number | null
  caseHeightCm: number | null
  caseWeightKg: number | null
}

/** One SKU's FBA prep / label owner (`ProductPackage`); null = not set. */
export interface CaseOwnerValues {
  fbaPrepOwner: CaseOwner | null
  fbaLabelOwner: CaseOwner | null
}

const SIDES = [
  ['caseLengthCm', 'Case length'],
  ['caseWidthCm', 'Case width'],
  ['caseHeightCm', 'Case height'],
] as const

/** Why this case size cannot be saved, or null: units a whole number 1..10000; 0 < side ≤ 300 cm; 0 < kg ≤ 1000. */
export function sizeProblem(v: CaseSizeValues): string | null {
  if (!Number.isInteger(v.unitsPerCase) || v.unitsPerCase < 1 || v.unitsPerCase > MAX_UNITS_PER_CASE) {
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
  return null
}

/** Why this list of case sizes cannot be saved, or null: at most MAX_CASE_SIZES, each valid, no units per case twice. */
export function sizesProblem(list: readonly CaseSizeValues[]): string | null {
  if (list.length > MAX_CASE_SIZES) return CASE_COPY.tooManySizes
  const seen = new Set<number>()
  for (const v of list) {
    const problem = sizeProblem(v)
    if (problem) return problem
    if (seen.has(v.unitsPerCase)) return CASE_COPY.sameSize(v.unitsPerCase)
    seen.add(v.unitsPerCase)
  }
  return null
}

/** Why these owners cannot be saved, or null: Amazon | Seller | not set. */
export function ownersProblem(v: Partial<CaseOwnerValues>): string | null {
  if (v.fbaPrepOwner != null && !isCaseOwner(v.fbaPrepOwner)) return 'Prep by must be Amazon or Seller'
  if (v.fbaLabelOwner != null && !isCaseOwner(v.fbaLabelOwner)) return 'Labels by must be Amazon or Seller'
  return null
}

/** Amazon EU's box limit, as a warning: a side over 63.5 cm or a weight over 23 kg. Never a refusal. */
export function amazonBoxWarning(v: Pick<CaseSizeValues, 'caseLengthCm' | 'caseWidthCm' | 'caseHeightCm' | 'caseWeightKg'>): string | null {
  const sides = [v.caseLengthCm, v.caseWidthCm, v.caseHeightCm]
  const tooLong = sides.some(side => side !== null && side > AMAZON_EU_BOX.maxSideCm)
  const tooHeavy = v.caseWeightKg !== null && v.caseWeightKg > AMAZON_EU_BOX.maxKg
  return tooLong || tooHeavy ? CASE_COPY.boxLimit : null
}

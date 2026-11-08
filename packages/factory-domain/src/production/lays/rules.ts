import type { Issue } from '../../core/errors'
import { lengthIn, lengthText, type Language, type LengthUom } from '../../inventory/rolls/rolls'
import { CUT_ORDER_LIMITS } from '../cutorders/rules'
import { Dec, ZERO, type Decimal } from '../../tax/decimal'

/**
 * Lays at the table (B-W2b-116; MES-038 "Spreading (lay) report", MES-039 "Ply count check before cutting"; design floor.fabriccut
 * "Spread the lay" and "Count the plies at both ends", production.cutting › Cut › Lays), pure.
 *
 *   spread   the lay report, roll by roll: the plies each roll gave, its splices, the length lost at its end and the roll end
 *            returned to stock, in the roll's own unit. The lay is spread from its started ticket (the start scan, B-W2b-112),
 *            PLANNED → SPREADING; every roll the office allocated to it (B-W2b-112's LayRoll rows) counts as spread from then on,
 *            and the table confirms, corrects or takes off each one ("Undo last roll"). A roll added after the count sends the
 *            lay back to SPREADING (the count is taken again).
 *   ply      one ply takes the lay's length off a roll: the length spread on the table (at least the marker's), else the marker.
 *            What a roll gives a lay = its plies × the ply + its end loss.
 *   count    both ends are counted; a difference between them, or with the plies the rolls gave, blocks the cut and is stored
 *            nowhere ("Left 24, right 23. Recount before cutting."). Equal → CHECKED; the end scan (B-W2b-112) cuts it.
 *
 * Nothing here carries money or names the worker who spread or counted (Statuto dei Lavoratori art. 4). Lengths are Decimal.
 */

export const LAY_LIMITS = Object.freeze({
  /** Splices made in one roll. */
  splices: 99,
  /** Rolls in one lay. */
  rolls: 60,
  note: 500,
  /** The length one ply takes, in metres: the marker's limit and a metre of allowance at the ends. */
  plyMetres: CUT_ORDER_LIMITS.markerMetres + 1,
})

export const LAY_REFUSALS = [
  'NOT_FABRIC',
  'CUT_ORDER_NOT_AT_TABLE',
  'TICKET_NOT_STARTED',
  'LAY_NOT_OPEN',
  'LAY_NOT_SPREAD',
  'LAY_FULL',
  'ROLL_SHORT',
  'ROLL_NOT_IN_LAY',
  'NOT_LAST_ROLL',
  'PLY_TOO_SHORT',
  'NOTHING_SPREAD',
  'PLIES_DIFFER',
  'COUNT_NOT_SPREAD',
  'LAY_NOT_CUT',
  'CONSUMPTION_CLOSED',
] as const
export type LayRefusalCode = (typeof LAY_REFUSALS)[number]

export interface LayRefusal {
  readonly code: LayRefusalCode
  readonly message: string
}

export const LAY_WARNINGS = ['END_DIFFERS'] as const
export type LayWarningCode = (typeof LAY_WARNINGS)[number]
export interface LayWarning {
  readonly code: LayWarningCode
  readonly message: string
}

const DECIMAL = /^\d{1,14}(\.\d{1,4})?$/
const whole = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max

// ---- the lay at the table -------------------------------------------------------------------------------------------------

export interface TableFacts {
  readonly cutOrderNumber: string
  readonly kind: string
  readonly cutOrderStatus: string
  readonly laySeq: number
  readonly layStatus: string
  /** The lay's ticket (not void): its number and status; null when it has none. */
  readonly ticket: { readonly number: string; readonly status: string } | null
}

/** Why the table may not spread or count this lay now (null: it may). */
export function atTableRefusal(facts: TableFacts): LayRefusal | null {
  if (facts.kind !== 'FABRIC') return { code: 'NOT_FABRIC', message: `Cut order ${facts.cutOrderNumber} cuts leather hide by hide: it has no lays to spread.` }
  if (facts.cutOrderStatus !== 'RELEASED' && facts.cutOrderStatus !== 'IN_PROGRESS') {
    return { code: 'CUT_ORDER_NOT_AT_TABLE', message: `Cut order ${facts.cutOrderNumber} is ${words(facts.cutOrderStatus)}: its lays are spread and counted while it is released or cutting.` }
  }
  if (facts.layStatus === 'CUT' || facts.layStatus === 'CANCELLED') return { code: 'LAY_NOT_OPEN', message: `Lay ${facts.laySeq} is ${words(facts.layStatus)}: its report no longer changes.` }
  if (!facts.ticket || facts.ticket.status !== 'STARTED') {
    const which = facts.ticket ? `ticket ${facts.ticket.number}` : 'its ticket'
    return { code: 'TICKET_NOT_STARTED', message: `Scan ${which} at the start first: lay ${facts.laySeq} is spread from its started ticket.` }
  }
  return null
}

const words = (status: string): string => status.toLowerCase().replace('_', ' ')

// ---- one roll of the report -------------------------------------------------------------------------------------------------

export interface SpreadDraft {
  readonly plies?: number | undefined
  readonly splices?: number | undefined
  /** In the roll's unit. */
  readonly endLoss?: string | undefined
  readonly endReturned?: string | undefined
}

/** The row's own problems (paths relative to the body); lengths in the roll's unit, at most its length. */
export function spreadProblems(draft: SpreadDraft, rollLength: Decimal): Issue[] {
  const problems: Issue[] = []
  if (draft.plies !== undefined && !whole(draft.plies, 1, CUT_ORDER_LIMITS.pliesPerLay)) problems.push({ path: 'plies', message: `The plies from this roll, from 1 to ${CUT_ORDER_LIMITS.pliesPerLay}.` })
  if (draft.splices !== undefined && !whole(draft.splices, 0, LAY_LIMITS.splices)) problems.push({ path: 'splices', message: `Splices in this roll, from 0 to ${LAY_LIMITS.splices}.` })
  for (const field of ['endLoss', 'endReturned'] as const) {
    const value = draft[field]?.trim()
    if (value === undefined) continue
    if (!DECIMAL.test(value)) problems.push({ path: field, message: 'A length of 0 or more, at most four decimals.' })
    else if (new Dec(value).greaterThan(rollLength)) problems.push({ path: field, message: `At most the roll's length (${rollLength.toFixed(4)}).` })
  }
  return problems
}

/** The length one ply takes off a roll, in `to`: the lay's length on the table, else the marker. */
export function plyLength(marker: { readonly length: string; readonly uom: LengthUom }, lay: { readonly length: string; readonly uom: LengthUom } | null, to: LengthUom): Decimal {
  return lay ? lengthIn(lay.length, lay.uom, to) : lengthIn(marker.length, marker.uom, to)
}

/** A lay's length on the table shorter than the marker, or beyond the limit (null: fine). */
export function layLengthRefusal(marker: { readonly length: string; readonly uom: LengthUom }, lay: { readonly length: string; readonly uom: LengthUom }, laySeq: number, language: Language = 'en'): LayRefusal | null {
  const asked = lengthIn(lay.length, lay.uom, 'M')
  const markerM = lengthIn(marker.length, marker.uom, 'M')
  if (asked.lessThan(markerM)) {
    return { code: 'PLY_TOO_SHORT', message: `Lay ${laySeq}: a ply of ${lengthText(lay.length, lay.uom, language)} is shorter than the marker (${lengthText(marker.length, marker.uom, language)}).` }
  }
  if (asked.greaterThan(LAY_LIMITS.plyMetres)) return { code: 'PLY_TOO_SHORT', message: `Lay ${laySeq}: a ply is at most ${LAY_LIMITS.plyMetres} m long.` }
  return null
}

/** What a roll gives the lay: its plies × the ply and its end loss, in the roll's unit. */
export const rollUse = (plies: number, ply: Decimal, endLoss: Decimal | string): Decimal => ply.times(plies).plus(new Dec(endLoss.toString()))

/** Whole plies a roll still gives: what it has for this lay ÷ the ply, rounded down (an integer read from the decimal's text). */
export function pliesFromLength(available: Decimal, ply: Decimal): number {
  if (!ply.greaterThan(0) || !available.greaterThan(0)) return 0
  return Number.parseInt(available.dividedToIntegerBy(ply).toFixed(0), 10)
}

/** The plies the lay still needs (planned less spread). */
export const stillNeeded = (planned: number, spread: number): number => Math.max(0, planned - spread)

/** Why a roll's plies do not fit: the lay's plan (LAY_FULL) or the roll's length (ROLL_SHORT); null: they fit. */
export function pliesRefusal(asked: { readonly plies: number; readonly endLoss: Decimal }, facts: {
  readonly laySeq: number
  readonly planned: number
  /** Plies the lay's other rolls gave. */
  readonly others: number
  readonly rollCode: string
  /** What the roll has for this lay, in its unit. */
  readonly available: Decimal
  readonly ply: Decimal
  readonly uom: LengthUom
}, language: Language = 'en'): LayRefusal | null {
  const after = facts.others + asked.plies
  if (after > facts.planned) return { code: 'LAY_FULL', message: `Lay ${facts.laySeq} plans ${facts.planned} plies; with these it would have ${after}.` }
  const use = rollUse(asked.plies, facts.ply, asked.endLoss)
  if (use.greaterThan(facts.available)) {
    const gives = pliesFromLength(facts.available.minus(asked.endLoss), facts.ply)
    return {
      code: 'ROLL_SHORT',
      message: `Roll ${facts.rollCode} has ${lengthText(facts.available, facts.uom, language)} for this lay: ${gives} ${gives === 1 ? 'ply' : 'plies'} of ${lengthText(facts.ply, facts.uom, language)}, not ${asked.plies}. If it is longer, the warehouse measures it again.`,
    }
  }
  return null
}

/** The roll end measured back differs from what the report leaves on the roll (more than 1% of the roll, or 10 cm). */
export function endWarning(roll: { readonly code: string; readonly length: Decimal; readonly uom: LengthUom }, left: Decimal, endReturned: Decimal, language: Language = 'en'): LayWarning | null {
  if (endReturned.isZero()) return null
  const tolerance = Dec.max(roll.length.dividedBy(100), lengthIn('10', 'CM', roll.uom))
  if (endReturned.minus(left).abs().lessThanOrEqualTo(tolerance)) return null
  return {
    code: 'END_DIFFERS',
    message: `Roll ${roll.code}: the end back measures ${lengthText(endReturned, roll.uom, language)}, the lay report leaves ${lengthText(Dec.max(ZERO, left), roll.uom, language)} on it. The warehouse measures the roll again (correct the roll).`,
  }
}

// ---- the count at both ends -------------------------------------------------------------------------------------------------

/** Why both ends' counts do not check the lay (null: CHECKED). Neither count is stored when refused. */
export function countRefusal(count: { readonly left: number; readonly right: number }, spread: number, laySeq: number): LayRefusal | null {
  if (spread === 0) return { code: 'NOTHING_SPREAD', message: `Nothing is spread on lay ${laySeq} yet: add its rolls first.` }
  if (count.left !== count.right) return { code: 'PLIES_DIFFER', message: `Left ${count.left}, right ${count.right}. Recount before cutting.` }
  if (count.left !== spread) return { code: 'COUNT_NOT_SPREAD', message: `Both ends say ${count.left}; the rolls gave ${spread} ${spread === 1 ? 'ply' : 'plies'}. Recount, or correct the rolls.` }
  return null
}

// ---- words ------------------------------------------------------------------------------------------------------------------------

/** "6 plies · lay 2.1 m · 2 rolls" (it "6 strati · materasso 2,1 m · 2 rotoli"): the running sums of the report. */
export function spreadWords(spread: { readonly plies: number; readonly rolls: number; readonly ply: Decimal; readonly uom: LengthUom }, language: Language): string {
  const it = language === 'it'
  const plies = `${spread.plies} ${it ? (spread.plies === 1 ? 'strato' : 'strati') : spread.plies === 1 ? 'ply' : 'plies'}`
  const rolls = `${spread.rolls} ${it ? (spread.rolls === 1 ? 'rotolo' : 'rotoli') : spread.rolls === 1 ? 'roll' : 'rolls'}`
  return `${plies} · ${it ? 'materasso' : 'lay'} ${lengthText(spread.ply, spread.uom, language)} · ${rolls}`
}

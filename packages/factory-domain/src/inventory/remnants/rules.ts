import { UNITS } from '../../product/units/units'
import { Dec, type Decimal, type DecimalInput } from '../../tax/decimal'
import { areaIn, isAreaUom, type AreaUom } from '../hides/area'

/**
 * Remnant stock (B-W2b-100; SCM-254, MES-058; design floor.hidecut "Close the hide", floor.pick "Return unused", warehouse.hides
 * "Remnants"), pure. A usable offcut of a hide becomes stock with a tag of its own (RM-…, the tenant's REMNANT scan ids): the
 * REMNANT move that brought it back from the work order (RETURN's twin: it enters one place, names its work order and its
 * hide) and a Remnant row naming that move, its area and its place. The ledger stays per hide: a remnant's stock is its hide's
 * stock where the remnant lies; the row is the tag and the piece's state.
 *
 *   IN_STOCK  → ISSUED (its hide issued to a work order) | SCRAPPED (its hide written off) | VOID (its move reversed)
 *   ISSUED    → IN_STOCK (the issue undone or reversed, or the piece back whole) | USED (cut: the hide closed, or a part came
 *               back as a new remnant with a new tag)
 *   USED      → ISSUED (the close undone or its remnant's move reversed)
 *   SCRAPPED  → IN_STOCK (the write-off reversed)
 *   VOID      final, and only once its move is reversed (the database's factory_remnant_guard holds the same).
 *
 * A piece smaller than the minimum remnant is waste, not stock: it is refused in words and the hide is closed without it. The
 * minimum has no setting column yet (a schema need of B-W2b-80 and this step): MINIMUM_REMNANT is the default every site
 * uses until it has one.
 */

export const REMNANT_STATES = ['IN_STOCK', 'ISSUED', 'USED', 'SCRAPPED', 'VOID'] as const
export type RemnantState = (typeof REMNANT_STATES)[number]

/** The moves of a remnant's state (factory_remnant_guard). */
export const REMNANT_TRANSITIONS: Readonly<Record<RemnantState, readonly RemnantState[]>> = Object.freeze({
  IN_STOCK: ['ISSUED', 'SCRAPPED', 'VOID'],
  ISSUED: ['IN_STOCK', 'USED'],
  USED: ['ISSUED'],
  SCRAPPED: ['IN_STOCK'],
  VOID: [],
})

export const mayMoveRemnant = (from: RemnantState, to: RemnantState): boolean => REMNANT_TRANSITIONS[from].includes(to)

/** Why a remnant changed state: what the command did to its hide. */
export const REMNANT_CAUSES = ['ISSUE', 'ISSUE_REVERSED', 'RETURN', 'CUT', 'CLOSE_REVERSED', 'MOVE_REVERSED', 'RETURN_REVERSED', 'SCRAP', 'SCRAP_REVERSED'] as const
export type RemnantCause = (typeof REMNANT_CAUSES)[number]

/** Where a tag came from: a return at the pick, Hide done at the cutting table, or the office tagging a W1 remnant. */
export const REMNANT_SOURCES = ['RETURN', 'CUT', 'BACKFILL'] as const
export type RemnantSource = (typeof REMNANT_SOURCES)[number]

/** The smallest piece kept as stock, by default (no setting column yet): 10 dm² = 0.10 m² (1.08 ft²). */
export const MINIMUM_REMNANT: { readonly area: string; readonly uom: AreaUom } = Object.freeze({ area: '10', uom: 'DM2' })

/** The minimum in an area unit (a leather's base unit), four decimals. Null for a unit that is not an area. */
export function minimumRemnantIn(uom: string, minimum: { readonly area: DecimalInput; readonly uom: AreaUom } = MINIMUM_REMNANT): Decimal | null {
  return isAreaUom(uom) ? areaIn(minimum.area, minimum.uom, uom) : null
}

export const REMNANT_REFUSALS = ['REMNANT_TOO_SMALL', 'REMNANT_GONE_ON', 'NOT_A_REMNANT', 'TAGGED_ALREADY'] as const
export type RemnantRefusalCode = (typeof REMNANT_REFUSALS)[number]

export interface RemnantRefusal {
  readonly code: RemnantRefusalCode
  readonly message: string
}

const symbol = (uom: string): string => (uom in UNITS ? UNITS[uom as keyof typeof UNITS].symbol : uom)
const two = (value: Decimal): string => value.toFixed(2, Dec.ROUND_HALF_UP)

/** The minimum in words, in the leather's unit and in m² ("0.10 m² (1.08 ft²)"), for the refusal. */
export function minimumWords(baseUom: AreaUom, minimum: { readonly area: DecimalInput; readonly uom: AreaUom } = MINIMUM_REMNANT): string {
  const here = areaIn(minimum.area, minimum.uom, baseUom)
  const other: AreaUom = baseUom === 'FT2' ? 'M2' : 'FT2'
  return `${two(here)} ${symbol(baseUom)} (${two(areaIn(minimum.area, minimum.uom, other))} ${symbol(other)})`
}

/**
 * A piece coming back from a work order as a remnant: refused when it is smaller than the minimum (it is waste; the hide is
 * closed without it). Null when it may be kept, or when the leather is not counted in an area unit (nothing to compare).
 */
export function remnantSizeRefusal(facts: { readonly hideCode: string; readonly baseArea: DecimalInput; readonly baseUom: string }, minimum: { readonly area: DecimalInput; readonly uom: AreaUom } = MINIMUM_REMNANT): RemnantRefusal | null {
  if (!isAreaUom(facts.baseUom)) return null
  const least = areaIn(minimum.area, minimum.uom, facts.baseUom)
  const piece = new Dec(facts.baseArea.toString())
  if (piece.gte(least)) return null
  return {
    code: 'REMNANT_TOO_SMALL',
    message: `${two(piece)} ${symbol(facts.baseUom)} of hide ${facts.hideCode} is smaller than the smallest remnant kept, ${minimumWords(facts.baseUom, minimum)}: it is waste. Close the hide without a remnant.`,
  }
}

/** A REMNANT move's reversal while one of its pieces went on (issued, used or scrapped): the stock is no longer where it came back to. */
export function goneOnRefusal(pieces: readonly { readonly code: string; readonly state: RemnantState }[]): RemnantRefusal | null {
  const gone = pieces.filter((piece) => piece.state !== 'IN_STOCK' && piece.state !== 'VOID')
  if (gone.length === 0) return null
  const first = gone[0]!
  return {
    code: 'REMNANT_GONE_ON',
    message: `Remnant ${first.code} is ${first.state === 'ISSUED' ? 'issued to a work order' : first.state === 'USED' ? 'cut already' : 'scrapped'}: the move that brought it back is not reversed. Undo what happened to the remnant first.`,
  }
}

/**
 * What tagging a W1 remnant asks (the office, after the fact): a hide whose state is REMNANT, still in stock, whose last
 * move into stock is a RETURN from a work order not reversed, and no live tag on that move yet.
 */
export function backfillRefusal(facts: {
  readonly hideCode: string
  readonly hideState: string
  readonly onHand: DecimalInput
  readonly lastReturn: { readonly reversed: boolean } | null
  readonly liveTags: number
}): RemnantRefusal | null {
  if (facts.hideState !== 'REMNANT') return { code: 'NOT_A_REMNANT', message: `Hide ${facts.hideCode} is not a remnant (it is ${facts.hideState}): only a hide that came back cut gets a remnant tag.` }
  if (!new Dec(facts.onHand.toString()).greaterThan(0)) return { code: 'NOT_A_REMNANT', message: `None of hide ${facts.hideCode} is in stock: there is no remnant to tag.` }
  if (!facts.lastReturn || facts.lastReturn.reversed) return { code: 'NOT_A_REMNANT', message: `Hide ${facts.hideCode} has no return from a work order that brought it back: nothing to tag.` }
  if (facts.liveTags > 0) return { code: 'TAGGED_ALREADY', message: `Hide ${facts.hideCode}'s remnant has its tag already.` }
  return null
}

/**
 * The remnants a reversal of a close brings back to the work order (USED → ISSUED): the pieces of the hide that were used and
 * that no later live piece of another move followed. A piece's successor is a piece of the same hide made later (UUIDv7 ids
 * sort by time) by another move that is not VOID: the cycle after it. Pieces of one move travel together (the ledger is per
 * hide: a hide is issued whole).
 */
export function revivedOnReopen<Piece extends { readonly id: string; readonly moveId: string; readonly state: RemnantState }>(pieces: readonly Piece[]): Piece[] {
  return pieces.filter((piece) => piece.state === 'USED' && !pieces.some((later) => later.id > piece.id && later.moveId !== piece.moveId && later.state !== 'VOID'))
}

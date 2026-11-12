import { Dec, type Decimal } from '../../tax/decimal'

/**
 * Moves on the floor (B-W2b-292; SCM-218 move between bins, SCM-202 put away; design floor.move "Scan what you move", "In your
 * hands", "Scan the place"), the pure rules. Two scans: what is moved (a lot, a hide, a fabric roll or a remnant's tag) and the
 * place (its bin label; the label is the confirmation). Then:
 *
 *   whole      a hide (and its remnant) moves whole; a lot tracked hide by hide moves with every hide it has at that place; a
 *              roll moves whole (its own command, modules/inventory/rolls); only a lot counted by quantity moves in part.
 *   from       where it lies: the only place, or the one named when it lies in several.
 *   to         a place of the same site (a floor device sees no other), active, not the place it lies in; one that holds the
 *              item's kind and is not blocked (the ledger's checks, B-W2b-289); not a count's frozen line (the database's).
 *   quality    stock not released (a lot in quarantine, blocked or rejected, or under an active hold) moves only into a
 *              quarantine place: quarantined goods are never put back on an open shelf by a scan.
 *   undo       the poster's own move (the same tablet and worker, or the same office user), within 2 minutes, not undone yet:
 *              the same moves with the places swapped.
 */

export const SCANNED_KINDS = ['LOT', 'HIDE', 'ROLL', 'REMNANT'] as const
export type ScannedKind = (typeof SCANNED_KINDS)[number]

export const QUALITY_STATES = ['RELEASED', 'QUARANTINE', 'BLOCKED', 'REJECTED', 'ON_HOLD'] as const
export type QualityState = (typeof QUALITY_STATES)[number]

/** How long a move may be undone by its poster (design floor.move "Undo for 2 minutes"). */
export const UNDO_WINDOW_MS = 2 * 60 * 1000

/** What a scan names, as the move reads it. */
export interface InHand {
  readonly kind: ScannedKind
  readonly label: string
  /** The lot's quality status (W1), or null for an item without lots. */
  readonly lotStatus: 'QUARANTINE' | 'RELEASED' | 'REJECTED' | 'BLOCKED' | null
  /** An active quality hold names it (the lot, or the hide). */
  readonly onHold: boolean
  /** It moves whole (a hide, a remnant, a roll, a lot tracked hide by hide). */
  readonly whole: boolean
}

/** The quality state shown in your hands: a hold first, then the lot's status. */
export function qualityOf(hand: Pick<InHand, 'lotStatus' | 'onHold'>): QualityState {
  if (hand.onHold) return 'ON_HOLD'
  return hand.lotStatus ?? 'RELEASED'
}

export const usable = (state: QualityState): boolean => state === 'RELEASED'

const QUALITY_WORDS: Readonly<Record<Exclude<QualityState, 'RELEASED'>, string>> = Object.freeze({
  QUARANTINE: 'is in quarantine (waiting for quality)',
  BLOCKED: 'is blocked by quality',
  REJECTED: 'was rejected by quality',
  ON_HOLD: 'is on a quality hold',
})

export interface PlaceFacts {
  readonly id: string
  readonly code: string
  readonly kind: string
  readonly status: string
}

/** A refusal of a move: a stable code (the screens' words) and its sentence. */
export interface MoveRefusal {
  readonly code: 'NOTHING_HERE' | 'NAME_THE_PLACE' | 'SAME_PLACE' | 'ARCHIVED' | 'QUARANTINE_ONLY' | 'WHOLE_ONLY' | 'TOO_MUCH' | 'NOT_A_QUARANTINE_PLACE'
  readonly message: string
}

/**
 * Where it moves from: the place named (it must hold some), else the only place that holds it. `places` are where it lies at
 * the site (on hand above 0).
 */
export function fromRefusal(hand: Pick<InHand, 'label'>, places: readonly PlaceFacts[], named: string | null | undefined): MoveRefusal | null {
  if (places.length === 0) return { code: 'NOTHING_HERE', message: `${hand.label} lies nowhere at this site: there is nothing to move.` }
  if (named) return places.some((place) => place.id === named) ? null : { code: 'NOTHING_HERE', message: `${hand.label} does not lie in that place.` }
  if (places.length > 1) return { code: 'NAME_THE_PLACE', message: `${hand.label} lies in ${places.length} places (${places.map((place) => place.code).join(', ')}): say which one it is moved from.` }
  return null
}

/** The move into `to`: the checks in words that come before the ledger's (kind, block) and the database's (frozen line). */
export function toRefusal(hand: InHand, from: PlaceFacts, to: PlaceFacts): MoveRefusal | null {
  if (to.id === from.id) return { code: 'SAME_PLACE', message: `${hand.label} is in ${to.code} already.` }
  if (to.status !== 'ACTIVE') return { code: 'ARCHIVED', message: `${to.code} is archived: nothing goes into it.` }
  const state = qualityOf(hand)
  if (state !== 'RELEASED' && to.kind !== 'QUARANTINE') {
    return { code: 'QUARANTINE_ONLY', message: `${hand.label} ${QUALITY_WORDS[state]}: it moves only into a quarantine place until quality releases it.` }
  }
  return null
}

/**
 * How much moves: everything there for what moves whole (a quantity is refused unless it is all of it), else the quantity
 * asked (default all), never more than lies there. Answers the quantity in the base unit, or a refusal.
 */
export function quantityToMove(hand: Pick<InHand, 'label' | 'whole'>, onHand: Decimal | string, asked: string | null | undefined): { readonly quantity: Decimal } | { readonly refusal: MoveRefusal } {
  const there = new Dec(onHand)
  if (asked === null || asked === undefined || asked === '') return { quantity: there }
  const wanted = new Dec(asked)
  if (hand.whole && !wanted.eq(there)) return { refusal: { code: 'WHOLE_ONLY', message: `${hand.label} moves whole (${there.toString()} there): scan a hide or a roll to move part of it.` } }
  if (wanted.gt(there)) return { refusal: { code: 'TOO_MUCH', message: `Only ${there.toString()} of ${hand.label} lies there.` } }
  return { quantity: wanted }
}

/** A refusal of an undo: a stable code and its sentence. */
export interface UndoRefusal {
  readonly code: 'NOT_YOURS' | 'TOO_LATE' | 'UNDONE' | 'NOT_A_MOVE'
  readonly message: string
}

/** Whether the poster may still undo their move (all its rows), `now` and the move's command time. */
export function undoRefusal(move: { readonly own: boolean; readonly postedAt: Date; readonly undone: boolean; readonly transfer: boolean }, now: Date): UndoRefusal | null {
  if (!move.transfer) return { code: 'NOT_A_MOVE', message: 'Only a move between places is undone here.' }
  if (!move.own) return { code: 'NOT_YOURS', message: 'Only who made a move undoes it; ask the office to reverse it.' }
  if (move.undone) return { code: 'UNDONE', message: 'This move was undone already.' }
  if (now.getTime() - move.postedAt.getTime() > UNDO_WINDOW_MS) return { code: 'TOO_LATE', message: 'A move is undone within 2 minutes; move it back with a scan, or ask the office to reverse it.' }
  return null
}

/** The note of an undo's mirror moves (a reversal says why). */
export const UNDO_NOTE = 'Undone by who moved it, within 2 minutes (scanned by mistake).'

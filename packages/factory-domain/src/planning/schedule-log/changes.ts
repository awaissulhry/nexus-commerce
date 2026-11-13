import { clockText } from '../../production/scans/rules'
import { laneKey, type LaneRef } from '../schedule/slots'
import { whenWords } from '../schedule/time'

/**
 * The board's change log and its undo (B-W2b-329; PLN-149 "Undo and change log on the board"; design planning.board sec:log
 * "Changes": "Every move with who, when, from → to; undo per move while it is still ours", the Schedule's "⌘Z / ⌘⇧Z undo
 * while the bar is still where we put it"), pure. The log is ScheduleChange (B-W2b-286, append-only): one row per change of
 * the site's working plan, written by the command that made it.
 *
 *   kinds     PLACE (to a lane), MOVE (from → to), REMOVE (from a lane back to the tray), PIN / UNPIN (the slot only),
 *             PUBLISH (the plan published as a numbered version), UNDO (a change put back: it names the change it undoes)
 *   undo      a PLACE, MOVE, REMOVE, PIN or UNPIN, once, while it is still ours: the slot was not changed since (the change is
 *             the slot's latest standing change in the log — a later change that was itself undone, with its undo, does not
 *             count, so ⌘Z goes back one change at a time — AND the slot is still where the change left it: a write the log
 *             never saw, such as one made before the log existed, counts as a change). The undo is itself a change (UNDO), done by the
 *             same rules as a move: a PLACE is taken off the board, a MOVE goes back to where it was, a REMOVE comes back
 *             (a bar; a whole-order part goes back on the allocation board, whose garments the log does not keep), a PIN is
 *             unpinned, an UNPIN pinned again. A publish and an undo are never undone (publish again; move again).
 *   who       an office user (a planner), named inside the entry only; no count, group or total per person.
 */

export const CHANGE_KINDS = ['PLACE', 'MOVE', 'REMOVE', 'PIN', 'UNPIN', 'PUBLISH', 'UNDO'] as const
export type ChangeKind = (typeof CHANGE_KINDS)[number]

export const UNDOABLE_KINDS = ['PLACE', 'MOVE', 'REMOVE', 'PIN', 'UNPIN'] as const
export type UndoableKind = (typeof UNDOABLE_KINDS)[number]

/**
 * Why a change cannot be undone now (the feed's `undo.code`, the undo's 409 `refusal/<CODE>`). B-W2b-F39: OPERATION_GONE,
 * the change names an operation that left its work order since (a draft's release, revision or a repair's steps, once its
 * bar went back to the tray): the record keeps the change with its copy of the operation, nothing is put back.
 */
export const UNDO_HOLDS = ['NOT_UNDOABLE', 'ALREADY_UNDONE', 'CHANGED_SINCE', 'NO_PERMISSION', 'OPERATION_GONE'] as const
export type UndoHoldCode = (typeof UNDO_HOLDS)[number]

export const CHANGE_LOG_LIMITS = Object.freeze({ page: 50, maxPage: 200, reason: 500 })

/** A place on the board: a lane from a start to an end (epoch milliseconds). */
export interface ChangePlace {
  readonly lane: LaneRef
  readonly startAt: number
  readonly endAt: number
}

export interface ChangeFacts {
  readonly id: string
  readonly kind: ChangeKind
  readonly slotId: string | null
  /** null: a whole-order part (or a publish). */
  readonly operationId: string | null
  readonly from: ChangePlace | null
  readonly to: ChangePlace | null
}

/** The slot as it is now on the working plan. */
export interface SlotNow {
  readonly lane: LaneRef
  readonly startAt: number
  readonly endAt: number
  readonly pinned: boolean
}

/**
 * The slot's latest standing change: its changes newest first, without the undos and the changes they undid (null: none
 * stands). A change may be undone only while it is this one.
 */
export function standingLatest(newestFirst: readonly { readonly id: string; readonly kind: string; readonly undoesChangeId: string | null }[]): string | null {
  const undone = new Set(newestFirst.flatMap((change) => (change.kind === 'UNDO' && change.undoesChangeId ? [change.undoesChangeId] : [])))
  return newestFirst.find((change) => change.kind !== 'UNDO' && !undone.has(change.id))?.id ?? null
}

export const isUndoable = (kind: ChangeKind): kind is UndoableKind => (UNDOABLE_KINDS as readonly string[]).includes(kind)

/** The permission an undo asks: a pin's is planning.schedule.pin, a move's planning.schedule.manage. */
export const undoPermissionOf = (kind: UndoableKind): 'planning.schedule.pin' | 'planning.schedule.manage' => (kind === 'PIN' || kind === 'UNPIN' ? 'planning.schedule.pin' : 'planning.schedule.manage')

const samePlace = (a: ChangePlace, b: SlotNow): boolean => laneKey(a.lane) === laneKey(b.lane) && a.startAt === b.startAt && a.endAt === b.endAt

/** The slot is still where (and as) the change left it. */
export function resultHolds(change: ChangeFacts, slot: SlotNow | null): boolean {
  switch (change.kind) {
    case 'PLACE':
    case 'MOVE':
      return slot !== null && change.to !== null && samePlace(change.to, slot)
    case 'REMOVE':
      return slot === null
    case 'PIN':
      return slot !== null && slot.pinned
    case 'UNPIN':
      return slot !== null && !slot.pinned
    default:
      return false
  }
}

export interface UndoFacts {
  /** An UNDO of it exists. */
  readonly undone: boolean
  /** The latest standing change of its slot in the log (standingLatest). */
  readonly latestOfSlot: string | null
  readonly slot: SlotNow | null
  /** The person holds the undo's permission at the site. */
  readonly may: boolean
  /** B-W2b-F39: the change names an operation that is no longer on its work order. */
  readonly operationGone: boolean
}

/** Why the change cannot be undone now, first reason first; null: it may be. */
export function undoHoldOf(change: ChangeFacts, facts: UndoFacts): UndoHoldCode | null {
  if (!isUndoable(change.kind) || (change.kind === 'REMOVE' && change.operationId === null)) return 'NOT_UNDOABLE'
  if (facts.undone) return 'ALREADY_UNDONE'
  if (facts.operationGone) return 'OPERATION_GONE' // B-W2b-F39
  if (facts.latestOfSlot !== change.id || !resultHolds(change, facts.slot)) return 'CHANGED_SINCE'
  if (!facts.may) return 'NO_PERMISSION'
  return null
}

/**
 * What the undo does and the UNDO row's sides: `from` where the slot is before the undo (none: it is not on the board),
 * `to` where it goes (none: back to the tray, or it stays where it is).
 */
export function inverseOf(change: ChangeFacts & { readonly kind: UndoableKind }): { readonly action: 'TAKE_OFF' | 'MOVE_BACK' | 'PUT_BACK' | 'UNPIN' | 'PIN'; readonly from: ChangePlace | null; readonly to: ChangePlace | null } {
  switch (change.kind) {
    case 'PLACE':
      return { action: 'TAKE_OFF', from: change.to, to: null }
    case 'MOVE':
      return { action: 'MOVE_BACK', from: change.to, to: change.from }
    case 'REMOVE':
      return { action: 'PUT_BACK', from: null, to: change.from }
    case 'PIN':
      return { action: 'UNPIN', from: null, to: null }
    case 'UNPIN':
      return { action: 'PIN', from: null, to: null }
  }
}

/** "L1 · 17 Nov 08:00–12:00" (a stretch over midnight: both ends with their day). */
export function placeWords(place: ChangePlace, laneName: string, timeZone: string): string {
  const start = whenWords(place.startAt, timeZone)
  const sameDay = whenWords(place.endAt, timeZone).split(' ').slice(0, 2).join(' ') === start.split(' ').slice(0, 2).join(' ')
  return `${laneName} · ${start}–${sameDay ? clockText(new Date(place.endAt), timeZone) : whenWords(place.endAt, timeZone)}`
}

export interface ChangeWordsFacts {
  readonly kind: ChangeKind
  /**
   * "Op 20 Sew of SEED-WO-0001" / "SEED-WO-0001's part of the order"; B-W2b-F39: "Op 25 Sew of SEED-WO-0002 (no longer on
   * the work order)" (changeWhat).
   */
  readonly what: string
  readonly from: { readonly place: ChangePlace; readonly laneName: string } | null
  readonly to: { readonly place: ChangePlace; readonly laneName: string } | null
  /** PUBLISH: the version's number. */
  readonly published: number | null
  /** UNDO: the kind of the change it undid. */
  readonly undoes: ChangeKind | null
  /** It came from a what-if (applied). */
  readonly fromWhatIf: boolean
  readonly timeZone: string
}

/** One entry in words (English, for logs and the API's callers; a screen says its own from the kind and the places). */
export function changeWords(facts: ChangeWordsFacts): string {
  const at = (side: ChangeWordsFacts['from']) => (side ? placeWords(side.place, side.laneName, facts.timeZone) : '')
  const whatIf = facts.fromWhatIf ? ' (applied from a what-if)' : ''
  switch (facts.kind) {
    case 'PLACE':
      return `Placed ${facts.what} on ${at(facts.to)}${whatIf}.`
    case 'MOVE':
      return `Moved ${facts.what} from ${at(facts.from)} to ${at(facts.to)}${whatIf}.`
    case 'REMOVE':
      return `Sent ${facts.what} back to the tray from ${at(facts.from)}${whatIf}.`
    case 'PIN':
      return `Pinned ${facts.what} where it is.`
    case 'UNPIN':
      return `Unpinned ${facts.what}.`
    case 'PUBLISH':
      return facts.published === null ? 'Published the plan to the floor.' : `Published v${facts.published} to the floor.`
    case 'UNDO':
      switch (facts.undoes) {
        case 'PLACE':
          return `Undid the placing of ${facts.what}: back to the tray.`
        case 'MOVE':
          return `Undid the move of ${facts.what}: back on ${at(facts.to)}.`
        case 'REMOVE':
          return `Undid sending ${facts.what} back to the tray: on ${at(facts.to)} again.`
        case 'PIN':
          return `Undid the pin of ${facts.what}: unpinned.`
        case 'UNPIN':
          return `Undid the unpin of ${facts.what}: pinned again.`
        default:
          return `Undid a change of ${facts.what}.`
      }
  }
}

export interface UndoHoldWordsFacts {
  readonly kind: ChangeKind
  readonly operationId: string | null
  readonly what: string
  /** ALREADY_UNDONE: who undid it and when (words). */
  readonly undoneBy: string | null
  /** CHANGED_SINCE: the later change in words, when the log has one. */
  readonly later: string | null
  readonly permission: string
}

/** Why it cannot be undone, in words. */
export function undoHoldWords(code: UndoHoldCode, facts: UndoHoldWordsFacts): string {
  switch (code) {
    case 'NOT_UNDOABLE':
      if (facts.kind === 'PUBLISH') return 'A publish is not undone: publish the plan again to change what the floor has.'
      if (facts.kind === 'UNDO') return 'An undo is not undone: make the move again.'
      return `${facts.what} goes back on the allocation board: the log does not keep a part's garments.`
    case 'ALREADY_UNDONE':
      return `This change is already undone${facts.undoneBy ? ` (${facts.undoneBy})` : ''}.`
    case 'CHANGED_SINCE':
      return `${facts.what} changed since${facts.later ? `: ${facts.later}` : ': it is not where this change left it'}. Only the latest change of a bar is undone.`
    case 'NO_PERMISSION':
      return `Undoing it needs ${facts.permission} at this site.`
    case 'OPERATION_GONE': // B-W2b-F39
      return `${facts.what}: the record keeps this change, but it is not undone.`
  }
}

// ---- B-W2b-F39: the operation a change names, live or by the record's copy -----------------------------------------------

/** The operation a change names: on its work order now, or gone (the record's copy; a change written before B-W2b-F39 has none). */
export interface ChangeOperation {
  readonly seq: number | null
  readonly name: string | null
  readonly onWorkOrder: boolean
}

/**
 * "Op 20 Sew of SEED-WO-0001"; gone: "Op 25 Sew of SEED-WO-0002 (no longer on the work order)", or "SEED-WO-0002's operation
 * (no longer on the work order)" without a copy; no operation: "SEED-WO-0001's part of the order".
 */
export function changeWhat(workOrderNumber: string | null, operation: ChangeOperation | null): string {
  if (!operation) return `${workOrderNumber ?? 'The work order'}'s part of the order`
  if (operation.onWorkOrder) return `Op ${operation.seq} ${operation.name} of ${workOrderNumber ?? 'the work order'}`
  const named = operation.seq !== null && operation.name !== null ? `Op ${operation.seq} ${operation.name} of ${workOrderNumber ?? 'the work order'}` : `${workOrderNumber ?? 'The work order'}'s operation`
  return `${named} (no longer on the work order)`
}
// ---- end B-W2b-F39 -----------------------------------------------------------------------------------------------------

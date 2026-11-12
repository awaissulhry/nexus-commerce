import { UNDO_WINDOW_MS, type QualityState, type ScannedKind } from '@nexus/factory-domain/inventory/bin-moves/rules'
import type { SuggestionReason } from '@nexus/factory-domain/inventory/putaway/rules'
import { PUT_AWAY_FROM_KINDS } from '@nexus/factory-domain/inventory/tasks/sources'
import type { TaskPlace, WarehouseTask } from '../mywork/warehouse/model'

/**
 * SCR-177 — Move & put away (B-W2b-308; design floor.move; SCM-202, SCM-218, QHS-078; the API of B-W2b-292): the rules of the
 * screen without React or the network, so the tests hold them.
 *
 *   scan what   a lot's number, a hide's, a roll's or a remnant's tag: `GET /inventory/putaway/scan` answers what it is, where it
 *               lies at the site, its quality state, the open tasks that name it and, for goods on a dock or in quarantine, the
 *               suggested bin. Offline: what this tablet read in this visit ("as of"), else the code alone.
 *   in hand     item, quantity, where it is now, quality status. A hide, a remnant, a roll and a lot tracked hide by hide move
 *               whole; a lot counted by quantity opens the pad, defaulting to all of it. When it lies in several places and
 *               neither its task nor a single dock says which, the worker taps the place it is taken from.
 *   scan where  the bin label is the confirmation: the move posts on the scan (a put-away when it is taken from a dock or a
 *               quarantine place, else a move between bins), online first, else kept in the tablet's queue
 *               (inventory.putAway | inventory.binMove) with the same body. A hold's quarantine move is the hold's task: its
 *               place scan does the task (inventory.task.done), the office's confirm itself.
 *   undo        the poster's own move within 2 minutes, online only (`POST /inventory/bin-moves/:moveId/undo`).
 * No money, no person.
 */

export type MovePurpose = 'PUT_AWAY' | 'MOVE'

export interface HandPlace {
  readonly locationId: string
  readonly code: string
  readonly name: string
  readonly kind: string
  /** In the item's base unit (a decimal string). */
  readonly onHand: string
}

/** "In your hands": what a scan names (B-W2b-292 handView). */
export interface InHand {
  readonly kind: ScannedKind
  readonly code: string
  readonly item: { readonly id: string; readonly code: string; readonly name: string; readonly kind: string; readonly tracking: string; readonly baseUom: string }
  readonly colour: { readonly code: string; readonly name: string } | null
  readonly lot: { readonly id: string; readonly code: string; readonly qualityStatus: string; readonly lifecycle: string } | null
  readonly hide: { readonly id: string; readonly code: string; readonly state: string } | null
  readonly roll: { readonly id: string; readonly code: string; readonly state: string } | null
  readonly remnant: { readonly id: string; readonly code: string } | null
  readonly quality: QualityState
  readonly holdIds: readonly string[]
  /** It moves whole (a hide, a remnant, a roll, a lot tracked hide by hide). */
  readonly whole: boolean
  readonly uom: string
  readonly onHand: string
  /** Where it lies at the site now (most first). */
  readonly lying: readonly HandPlace[]
}

/** The put-away scan's answer: what is in hand, where it waits, the suggested bin and its open tasks. */
export interface MoveScan {
  readonly hand: InHand
  readonly from: { readonly locationId: string; readonly code: string } | null
  readonly suggestion: { readonly location: TaskPlace; readonly why: SuggestionReason } | null
  readonly tasks: readonly WarehouseTask[]
}

const OPEN = (task: WarehouseTask) => task.status === 'OPEN' || task.status === 'TAKEN'

/** The hold's quarantine move that names what is in hand (its place scan does it), or null. */
export function quarantineTaskOf(scan: Pick<MoveScan, 'tasks'>): WarehouseTask | null {
  return scan.tasks.find((task) => task.kind === 'QUARANTINE' && OPEN(task)) ?? null
}

/** A place a put-away takes from (a dock or a quarantine place). */
export const isWaitingPlace = (kind: string): boolean => (PUT_AWAY_FROM_KINDS as readonly string[]).includes(kind)

/**
 * Where it is taken from: the only place it lies in; the one the worker tapped; its task's place; for a put-away the one dock or
 * quarantine place it waits in. Null: the worker says (it lies in several places). As the API implies it (B-W2b-292 move.ts).
 */
export function fromOf(scan: Pick<MoveScan, 'hand' | 'tasks'>, picked: string | null, taskId: string | null): HandPlace | null {
  const lying = scan.hand.lying
  if (lying.length === 0) return null
  if (lying.length === 1) return lying[0]!
  if (picked) return lying.find((entry) => entry.locationId === picked) ?? null
  const task = taskId ? scan.tasks.find((entry) => entry.id === taskId) : null
  const ofTask = task?.from ? lying.find((entry) => entry.locationId === task.from!.id) : undefined
  if (ofTask) return ofTask
  const waiting = lying.filter((entry) => isWaitingPlace(entry.kind))
  return waiting.length === 1 ? waiting[0]! : null
}

/** A put-away when it is taken from a dock or a quarantine place, else a move between bins. */
export function purposeOf(from: Pick<HandPlace, 'kind'> | null): MovePurpose {
  return from && isWaitingPlace(from.kind) ? 'PUT_AWAY' : 'MOVE'
}

/** The put-away or move task this move works on: the one the worker opened, else the one taken from this place. */
export function taskOfMove(scan: Pick<MoveScan, 'tasks'>, from: HandPlace | null, opened: string | null): WarehouseTask | null {
  const moves = scan.tasks.filter((task) => (task.kind === 'PUT_AWAY' || task.kind === 'MOVE') && OPEN(task))
  if (opened) {
    const own = moves.find((task) => task.id === opened)
    if (own) return own
  }
  return moves.find((task) => task.from !== null && task.from.id === from?.locationId) ?? null
}

/** Where it should go, as a hint beside "Scan the place": the quarantine place, its task's place, else the suggestion. */
export function goesTo(scan: MoveScan, task: WarehouseTask | null, purpose: MovePurpose): { readonly code: string; readonly why: 'QUARANTINE' | 'TASK' | SuggestionReason } | null {
  const quarantine = quarantineTaskOf(scan)
  if (quarantine?.to) return { code: quarantine.to.code, why: 'QUARANTINE' }
  if (task?.to) return { code: task.to.code, why: 'TASK' }
  if (purpose === 'PUT_AWAY' && scan.suggestion) return { code: scan.suggestion.location.code, why: scan.suggestion.why }
  return null
}

// ---- the pad (a lot counted by quantity moves in part) --------------------------------------------------------------------

export interface MovePad {
  readonly min: number
  /** All that lies at the place it is taken from. */
  readonly max: number
  readonly decimals: number
}

const COUNTED = new Set(['PCS', 'PAIR', 'SET', 'HIDE', 'SIDE', 'ROLL', 'CONE', 'BOX'])

/** Decimals a unit is counted in on the pad: whole units for pieces, two for lengths, areas and weights. */
export const decimalsOf = (uom: string): number => (COUNTED.has(uom) ? 0 : 2)

/** The pad for a lot counted by quantity (null: it moves whole, or nothing lies there). */
export function padOf(hand: Pick<InHand, 'whole' | 'uom'>, from: HandPlace | null): MovePad | null {
  if (hand.whole || !from) return null
  const max = Number(from.onHand)
  if (!Number.isFinite(max) || max <= 0) return null
  const decimals = decimalsOf(hand.uom)
  return { min: decimals === 0 ? 1 : 1 / 10 ** decimals, max, decimals }
}

/** The pad's number as the API's decimal string (base unit). */
export const quantityText = (value: number, decimals: number): string => value.toFixed(decimals)

/** Why the pad's number cannot move: none typed, zero, or more than lies there; null when it can. */
export function padRefusal(pad: MovePad | null, value: number | null): 'empty' | 'tooMuch' | null {
  if (!pad) return null
  if (value === null || value <= 0) return 'empty'
  if (value > pad.max + 1e-9) return 'tooMuch'
  return null
}

// ---- the move's body ------------------------------------------------------------------------------------------------------

export interface MoveBody {
  readonly code: string
  readonly placeCode: string
  readonly fromLocationId?: string
  /** In the base unit; left out: all of it. */
  readonly quantity?: string
  readonly taskId?: string
}

/**
 * The move as the API takes it (and the queue keeps it): what, the place's label, the place it is taken from when it lies in
 * several, the quantity only for part of a lot, the task it works on.
 */
export function moveBody(input: { readonly code: string; readonly placeCode: string; readonly hand: Pick<InHand, 'lying'> | null; readonly from: HandPlace | null; readonly pad: MovePad | null; readonly value: number | null; readonly taskId: string | null }): MoveBody {
  const part = input.pad && input.value !== null && input.value < input.pad.max - 1e-9 ? quantityText(input.value, input.pad.decimals) : null
  return {
    code: input.code.trim(),
    placeCode: input.placeCode.trim(),
    ...(input.from && (input.hand?.lying.length ?? 0) > 1 ? { fromLocationId: input.from.locationId } : {}),
    ...(part ? { quantity: part } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
  }
}

/** What the place scan does: the hold's quarantine move (its task), or a put-away / move by its two scans. */
export type PlaceAct = { readonly kind: 'quarantine'; readonly task: WarehouseTask } | { readonly kind: 'move'; readonly purpose: MovePurpose }

export function placeActOf(scan: MoveScan | null, from: HandPlace | null): PlaceAct {
  const quarantine = scan ? quarantineTaskOf(scan) : null
  if (quarantine) return { kind: 'quarantine', task: quarantine }
  return { kind: 'move', purpose: purposeOf(from) }
}

/** Why the place scan cannot go yet, or null: it lies in several places and nobody said which; the pad's number. */
export function placeHeld(scan: MoveScan | null, from: HandPlace | null, pad: MovePad | null, value: number | null): 'from' | 'nothing' | 'empty' | 'tooMuch' | null {
  if (!scan) return null
  if (quarantineTaskOf(scan)) return null
  if (scan.hand.lying.length === 0) return 'nothing'
  if (!from) return 'from'
  return padRefusal(pad, value)
}

// ---- after the move ---------------------------------------------------------------------------------------------------------

export type Ticks = 'saved' | 'sending' | 'recorded' | 'refused'

/** The last thing this screen did, for the strip under the scan field (two ticks, Undo while its window is open). */
export interface MoveLast {
  readonly kind: 'moved' | 'quarantined' | 'undone'
  /** What moved ("LOT-0031", the hide's tag). */
  readonly code: string
  readonly purpose: MovePurpose | null
  readonly quantity: string | null
  readonly uom: string | null
  readonly from: string | null
  readonly to: string
  readonly ticks: Ticks
  /** Kept in the queue under this id (null: the office answered). */
  readonly clientEventId: string | null
  /** The first move's id (Undo); from the queue once the office recorded it. */
  readonly moveId: string | null
  /** When the office recorded it (the undo window starts there). */
  readonly at: string | null
  /** A quarantine move: what moved in, what stays at an outside workshop. */
  readonly moved?: readonly { readonly fromCode: string; readonly onHand: string; readonly uom: string }[]
  readonly stays?: readonly { readonly atCode: string; readonly onHand: string; readonly uom: string }[]
  /** A refusal of the queue, by its code. */
  readonly refusal?: string | null
}

/** Undo is offered while the move is the poster's, recorded, and within its 2 minutes. */
export function undoOpen(last: MoveLast | null, now: Date): boolean {
  if (!last || last.kind !== 'moved' || last.ticks !== 'recorded' || !last.moveId || !last.at) return false
  return now.getTime() - new Date(last.at).getTime() < UNDO_WINDOW_MS
}

/** When the undo window shuts (ms from now), or null. */
export function undoLeftMs(last: MoveLast | null, now: Date): number | null {
  if (!undoOpen(last, now)) return null
  return UNDO_WINDOW_MS - (now.getTime() - new Date(last!.at!).getTime())
}

// ---- refusals ---------------------------------------------------------------------------------------------------------------

/**
 * Every refusal the screen says in its own words (`refusal.<CODE>` in floor-move): the moves' (B-W2b-292 bin-moves rules), the
 * warehouse's (a blocked place, a count's frozen line, goods in transit), the tasks', the undo's, and the screen's own (a label of
 * no place here, a place that does not take the goods, nothing with that label, a place that is no quarantine place).
 */
export const MOVE_REFUSALS = [
  'NOTHING_HERE',
  'NAME_THE_PLACE',
  'SAME_PLACE',
  'ARCHIVED',
  'QUARANTINE_ONLY',
  'WHOLE_ONLY',
  'TOO_MUCH',
  'NOT_A_QUARANTINE_PLACE',
  'LOCATION_BLOCKED',
  'COUNT_FROZEN',
  'TRANSIT_ONLY_TRANSFER',
  'NOT_A_PLACE',
  'DOES_NOT_HOLD',
  'NOT_STOCK',
  'NOT_YOURS',
  'TOO_LATE',
  'UNDONE',
  'NOT_A_MOVE',
  'DONE',
  'CANCELLED',
  'TAKEN_BY_OTHER',
  'NOT_FOR_YOU',
  'SCAN_THE_PLACE',
  'STILL_THERE',
  'NOT_ALLOWED',
  'CONFLICT',
  'BADGE',
] as const
export type MoveRefusalCode = (typeof MOVE_REFUSALS)[number]

export const knownRefusal = (code: string): code is MoveRefusalCode => (MOVE_REFUSALS as readonly string[]).includes(code)

/** The quality state's tone on the card (icon + word + tone; never colour alone). */
export const QUALITY_TONE: Readonly<Record<QualityState, 'success' | 'warning' | 'danger'>> = Object.freeze({
  RELEASED: 'success',
  QUARANTINE: 'warning',
  ON_HOLD: 'warning',
  BLOCKED: 'danger',
  REJECTED: 'danger',
})

/** A decimal string as a number for the screen (NaN never shown: 0). */
export const num = (value: string | null | undefined): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

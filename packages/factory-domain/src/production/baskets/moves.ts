import type { WorkCentreKind } from '../../product/routing/operations'
import { standingKey, type ScanFact } from '../scans/rules'
import { effectiveMoves, type BasketPlace, type MoveFact } from './place'
import { scannedSteps, type RouteMarks, type RouteOperation } from './route'

/**
 * Moving a basket by hand and changing its route (owb- order workflow, S5 fl2; build/briefs/owb-fl2.md steps 2-3; LF
 * _owb-fl-common.md § 1 D, § 2 settles 6, 7, 8; PL-review § 4 "Move back"). Pure: the API reads each basket's route
 * (./route basketRoute), place (./place basketPlace), standing reports and moves inside its command and asks here; every
 * answer is "moves" or "stays" with the words the phone shows. A move writes no scan, no pay and no cost entry.
 *
 *   FORWARD     to a later scanned step of the basket's route, or to Ready to ship (`to` null) only once its last step has a
 *               standing report (settle 7: "Pack it first")
 *   TAKEN_HERE  "Take it here": to a scanned step of its route (the phone's department, settle 8); not to the step it is at
 *   BACK        to an earlier scanned step of its route, with a reason (the team leader: production.baskets.route)
 *   undo        a move that counts (not an UNDO, not undone); the mover's own while nobody moved the basket since needs only
 *               production.baskets.move, else production.baskets.route
 *   route       SKIP a scanned step that is not the last and has no standing report (what is done stays); PUT_BACK a
 *               skipped one; ADD a department's extra step (before the last); a warning, not a stop, when no quality step
 *               (INSPECTION) is left
 */

export const MOVE_KINDS = ['FORWARD', 'BACK', 'TAKEN_HERE'] as const
export type MoveKind = (typeof MOVE_KINDS)[number]
export const MOVE_REASONS = ['REDO', 'MISTAKE', 'OTHER'] as const
export type MoveReason = (typeof MOVE_REASONS)[number]
export const ROUTE_EDIT_KINDS = ['SKIP', 'PUT_BACK', 'ADD'] as const
export type RouteEditKind = (typeof ROUTE_EDIT_KINDS)[number]
export const ROUTE_REASONS = ['NOT_NEEDED', 'REDO', 'CUSTOMER', 'OTHER'] as const
export type RouteReason = (typeof ROUTE_REASONS)[number]

/** The most baskets one move, undo or route change takes (the phone's "all baskets of the order" included). */
export const MAX_BASKETS_PER_ACT = 50
/** The longest words beside a reason (the database refuses more: …_order_workflow_guards G5). */
export const MOVE_NOTE_MAX = 500

/** Why a basket stays where it is, as a code (the API says it in words: STAY_WORDS). */
export const STAY_CODES = ['NOT_ON_ROUTE', 'ALREADY_THERE', 'NOT_LATER', 'NOT_EARLIER', 'PACK_FIRST', 'NOT_A_BASKET', 'HELD'] as const
export type StayCode = (typeof STAY_CODES)[number]

/** The words a phone shows for a basket that stays (the codes; `{code}` is the basket's, `{step}` the step's name). */
export const STAY_WORDS: Readonly<Record<StayCode, string>> = Object.freeze({
  NOT_ON_ROUTE: '{code}: this step is not on its route.',
  ALREADY_THERE: '{code} is at this step already.',
  NOT_LATER: '{code} is past this step already: moving forward goes to a later step.',
  NOT_EARLIER: '{code} has not reached this step yet: moving back goes to an earlier step.',
  PACK_FIRST: '{code}: pack it first. Packed at Packing makes it ready to ship.',
  NOT_A_BASKET: 'Not a basket of this site.',
  HELD: '{code} is on hold: ask your team leader.',
})

export const stayWords = (code: StayCode, basketCode: string): string => STAY_WORDS[code].replace('{code}', basketCode)

/** One basket as the move rule reads it. */
export interface MoveBasketFacts {
  readonly bundleId: string
  readonly route: readonly (RouteOperation & RouteMarks)[]
  readonly place: BasketPlace
  readonly standing: ReadonlyMap<string, Pick<ScanFact, 'serverTime'>>
}

export type MoveDecision = { readonly ok: true; readonly from: string | null; readonly to: string | null } | { readonly ok: false; readonly stay: StayCode }

/** Whether a basket moves to `to` (null: Ready to ship) by this kind, from where it is. */
export function moveDecision(kind: MoveKind, basket: MoveBasketFacts, to: string | null): MoveDecision {
  const scanned = scannedSteps(basket.route)
  const at = basket.place.operationId === null ? scanned.length : scanned.findIndex((step) => step.id === basket.place.operationId)
  const from = basket.place.operationId
  if (to === null) {
    // Ready to ship by hand only once the route's last step has a standing report (settle 7); only forward.
    if (kind !== 'FORWARD') return { ok: false, stay: 'NOT_ON_ROUTE' }
    if (from === null) return { ok: false, stay: 'ALREADY_THERE' }
    const last = scanned.at(-1)
    if (!last || !basket.standing.has(standingKey(basket.bundleId, last.id))) return { ok: false, stay: 'PACK_FIRST' }
    return { ok: true, from, to: null }
  }
  const index = scanned.findIndex((step) => step.id === to)
  if (index < 0) return { ok: false, stay: 'NOT_ON_ROUTE' }
  if (to === from) return { ok: false, stay: 'ALREADY_THERE' }
  if (kind === 'FORWARD' && index <= at) return { ok: false, stay: 'NOT_LATER' }
  if (kind === 'BACK' && index >= at) return { ok: false, stay: 'NOT_EARLIER' }
  return { ok: true, from, to }
}

/** The facts of an undo: the move named, the basket's moves (oldest first), who asks. */
export interface UndoFacts {
  readonly move: MoveFact & { readonly workerId: string | null; readonly userId: string | null }
  readonly moves: readonly MoveFact[]
  /** The person asking: the floor's worker (actorId), or the office user. */
  readonly byWorkerId: string | null
  readonly byUserId: string | null
}

export type UndoDecision = { readonly ok: true; readonly needs: 'production.baskets.move' | 'production.baskets.route'; readonly to: string | null; readonly from: string | null } | { readonly ok: false; readonly code: 'NOT_UNDOABLE' | 'MOVED_SINCE_OTHER' }

/**
 * Whether the move can be undone, and the right it needs: a move that counts (not an UNDO, not undone); the basket goes back
 * to where the move took it from. The mover's own move while nobody moved the basket since: production.baskets.move;
 * another person's (or one moved again since): production.baskets.route.
 */
export function undoDecision(facts: UndoFacts): UndoDecision {
  const counting = effectiveMoves(facts.moves)
  if (facts.move.kind === 'UNDO' || !counting.some((move) => move.id === facts.move.id)) return { ok: false, code: 'NOT_UNDOABLE' }
  const own = (facts.byWorkerId !== null && facts.move.workerId === facts.byWorkerId) || (facts.byUserId !== null && facts.move.userId === facts.byUserId)
  const newest = counting.at(-1)!
  const needs = own && newest.id === facts.move.id ? 'production.baskets.move' : 'production.baskets.route'
  return { ok: true, needs, to: facts.move.fromOperationId, from: facts.move.toOperationId }
}

/** One basket as the route rule reads it: its route NOW (with its standing edits) and its standing reports. */
export interface RouteBasketFacts {
  readonly bundleId: string
  readonly route: readonly (RouteOperation & RouteMarks & { readonly workCentreKind?: WorkCentreKind | undefined })[]
  readonly standing: ReadonlyMap<string, unknown>
}

export type RouteEditDecision = { readonly ok: true } | { readonly ok: false; readonly code: 'LAST_STAYS' | 'DONE_STAYS' | 'NOT_SKIPPED' | 'NOT_ON_ROUTE' | 'ALREADY_ON_ROUTE' }

/** Whether one edit is taken for the basket (see the file's head). ADD names the extra operation already made for the basket's work order. */
export function routeEditDecision(kind: RouteEditKind, basket: RouteBasketFacts, operationId: string): RouteEditDecision {
  const step = basket.route.find((operation) => operation.id === operationId)
  if (!step) return { ok: false, code: 'NOT_ON_ROUTE' }
  const scanned = scannedSteps(basket.route)
  if (kind === 'SKIP') {
    if (!step.scanRequired) return { ok: false, code: 'NOT_ON_ROUTE' }
    if (scanned.at(-1)?.id === operationId) return { ok: false, code: 'LAST_STAYS' }
    if (basket.standing.has(standingKey(basket.bundleId, operationId))) return { ok: false, code: 'DONE_STAYS' }
    return { ok: true }
  }
  if (kind === 'PUT_BACK') return step.skipped === true ? { ok: true } : { ok: false, code: 'NOT_SKIPPED' }
  return step.scanRequired ? { ok: false, code: 'ALREADY_ON_ROUTE' } : { ok: true }
}

export const ROUTE_EDIT_WORDS: Readonly<Record<Exclude<RouteEditDecision, { ok: true }>['code'], string>> = Object.freeze({
  LAST_STAYS: '{code}: the last step stays (it is where the basket is finished).',
  DONE_STAYS: '{code}: this step is done already; what is done stays.',
  NOT_SKIPPED: '{code}: this step is not skipped.',
  NOT_ON_ROUTE: '{code}: this step is not on its route.',
  ALREADY_ON_ROUTE: '{code}: this step is on its route already.',
})

/** A warning (not a stop): the basket's route after the change has no quality step (no INSPECTION step is scanned). */
export function noQualityLeft(route: readonly (RouteOperation & { readonly workCentreKind?: WorkCentreKind | undefined })[]): boolean {
  return !scannedSteps(route).some((step) => step.workCentreKind === 'INSPECTION')
}

/** The step of a department in a basket's own route (web A's "the same department's step in each basket"), or null. */
export function stepOfDepartment<Op extends RouteOperation>(route: readonly Op[], departmentOf: ReadonlyMap<string, string | null>, departmentId: string, options: { readonly skipped?: boolean } = {}): Op | null {
  const candidates = [...route].sort((a, b) => a.seq - b.seq).filter((step) => departmentOf.get(step.id) === departmentId && (options.skipped ? (step as RouteMarks).skipped === true : step.scanRequired))
  return candidates[0] ?? null
}

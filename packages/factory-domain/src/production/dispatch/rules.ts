import type { BusinessDate } from '../../core/time'
import { sideBySide } from '../../product/routing/parallel'
import type { FloorRuleMode } from '../settings/floor-rules'

/**
 * Dispatch every shift (B-W2b-49; MES-023 assign operators, MES-025 sequence rules, MES-027 rebalance; design
 * production.dispatch "Board", "Not assigned", "Move bundles"), pure. The W2a dispatch list reads what the published plan
 * puts on a line or station; a DispatchAssignment (labour.prisma) is what the person running the board made of it for one
 * day. Its three shapes (the database's guard holds them):
 *
 *   STATION_OPERATOR       a station + an operator: who works there that day (the lane's header)
 *   OPERATION_OPERATOR     an operation + an operator, at a station or not: this work is theirs
 *   OPERATION_AT_STATION   an operation + a station, nobody named: the work is queued there
 *
 * An operation's rows may list some of its bundles; a row with no list holds "all the rest". So one operation falls into
 * placements: each group of rows at a place, with the open bundles it holds. A bundle named on a row belongs to that row's
 * place; the rest belongs to the row with no list, or has no place yet ("Not assigned"). A card on the board is one
 * placement, or what has no place.
 *
 * No person is ranked or measured: a row says who is to do what, never how fast (Statuto dei Lavoratori art. 4).
 */

export const DISPATCH_LIMITS = Object.freeze({ note: 500, overrideReason: 500, bundles: 500, operatorsListed: 200, stationOperationsChecked: 12 })

export const ASSIGNMENT_KINDS = ['STATION_OPERATOR', 'OPERATION_OPERATOR', 'OPERATION_AT_STATION'] as const
export type AssignmentKind = (typeof ASSIGNMENT_KINDS)[number]

export interface DispatchRefusal {
  readonly code: string
  readonly message: string
  readonly fix: string
}

const refusal = (code: string, message: string, fix: string): DispatchRefusal => Object.freeze({ code, message, fix })

export const DISPATCH_REFUSALS = Object.freeze({
  PAST_DAY: refusal('PAST_DAY', 'A day that is over stays as it was.', 'Pick today or a later day.'),
  SITE_NAMES_NO_WORKERS: refusal('SITE_NAMES_NO_WORKERS', "This site's floor records name the station, not the worker: no operator is named here.", 'Place the work at a station.'),
  NOT_RELEASED: refusal('NOT_RELEASED', 'Only a released work order is dispatched.', 'Release the work order first.'),
  WRONG_WORK_CENTRE: refusal('WRONG_WORK_CENTRE', "This station does not do this operation's work.", "Pick a station of the operation's work centre."),
  LINE_DOES_NOT_DO: refusal('LINE_DOES_NOT_DO', "This line has no active station for this operation's work.", 'Pick one of its stations, or another line.'),
  STATION_INACTIVE: refusal('STATION_INACTIVE', 'This station is not active.', 'Pick an active station.'),
  LINE_INACTIVE: refusal('LINE_INACTIVE', 'This line is not active.', 'Pick an active line.'),
  WORKER_INACTIVE: refusal('WORKER_INACTIVE', 'This person is not an active worker of the site.', 'Pick someone who works here.'),
  ALREADY_ASSIGNED: refusal('ALREADY_ASSIGNED', 'This person is already assigned to this work.', 'Nothing to do.'),
  WHOLE_ELSEWHERE: refusal('WHOLE_ELSEWHERE', 'This operation already sits at another station.', 'Move its bundles to share it between stations.'),
  BUNDLE_NOT_OPEN: refusal('BUNDLE_NOT_OPEN', 'A bundle named is not open at this operation.', 'Read the board again.'),
  BUNDLE_TAKEN: refusal('BUNDLE_TAKEN', 'A bundle named is already placed.', 'Move the bundle instead.'),
  NOT_SPLIT_OFF: refusal('NOT_SPLIT_OFF', 'Part of a card cannot go back to Not assigned.', 'Move the whole card, or move the bundles to a station.'),
  MOVED_ALREADY: refusal('MOVED_ALREADY', 'This card changed since you read it.', 'Read the board again.'),
  NOTHING_TO_MOVE: refusal('NOTHING_TO_MOVE', 'The card is already there.', 'Pick another place.'),
  SEQUENCE_ORDER: refusal('SEQUENCE_ORDER', 'This order puts an operation before the one it follows: this site keeps a strict sequence.', 'Put the earlier operation first.'),
  STALE: refusal('STALE', 'This assignment changed since you read it.', 'Read the board again.'),
})

/** A row of the day, as the rules read it. */
export interface AssignmentFacts {
  readonly id: string
  readonly version: number
  readonly lineId: string | null
  readonly stationId: string | null
  readonly workOrderOperationId: string | null
  readonly bundleIds: readonly string[]
  readonly workerId: string | null
  readonly sequence: number | null
  readonly createdAt: Date
}

export const assignmentKindOf = (row: Pick<AssignmentFacts, 'workOrderOperationId' | 'workerId'>): AssignmentKind =>
  row.workOrderOperationId === null ? 'STATION_OPERATOR' : row.workerId !== null ? 'OPERATION_OPERATOR' : 'OPERATION_AT_STATION'

/** The lane order: numbered rows first, then the oldest; the id settles the rest. */
export function byLane<Row extends Pick<AssignmentFacts, 'id' | 'sequence' | 'createdAt'>>(a: Row, b: Row): number {
  const sa = a.sequence ?? Number.MAX_SAFE_INTEGER
  const sb = b.sequence ?? Number.MAX_SAFE_INTEGER
  if (sa !== sb) return sa - sb
  const ta = a.createdAt.getTime()
  const tb = b.createdAt.getTime()
  if (ta !== tb) return ta - tb
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Where a row sits: its station, else its line, else nowhere in particular. */
export const placeOf = (row: { readonly stationId: string | null; readonly lineId: string | null }): string => (row.stationId ? `station:${row.stationId}` : row.lineId ? `line:${row.lineId}` : 'nowhere')

/** The card of what has no place yet. */
export const REST_CARD = 'REST'

/** The key of a card: a place and who, or a place and "all the rest". */
export const namedCardKey = (place: string, workerId: string | null): string => `${place}|${workerId ?? ''}`
export const wholeCardKey = (place: string): string => `${place}|all`

export interface Placement<Row extends AssignmentFacts = AssignmentFacts> {
  readonly key: string
  readonly stationId: string | null
  readonly lineId: string | null
  /** The open bundles held here (all the rest, on a card with `whole`). */
  readonly bundleIds: readonly string[]
  /** It holds what no row names (its operation may have no bundles yet). */
  readonly whole: boolean
  readonly rows: readonly Row[]
  readonly sequence: number | null
}

export interface OperationPlacements<Row extends AssignmentFacts = AssignmentFacts> {
  readonly placements: readonly Placement<Row>[]
  /** The open bundles nothing holds. */
  readonly rest: readonly string[]
  /** No row holds "all the rest": what no row names (`rest`, and garments not in a bundle yet) has no place. */
  readonly unplaced: boolean
}

/** One operation's rows of the day over its open bundles (rows only of that operation). */
export function placementsOf<Row extends AssignmentFacts>(rows: readonly Row[], openBundleIds: readonly string[]): OperationPlacements<Row> {
  const ordered = [...rows].sort(byLane)
  const open = new Set(openBundleIds)
  const owner = new Map<string, string>()
  const named = new Map<string, { stationId: string | null; lineId: string | null; bundleIds: string[]; rows: Row[] }>()
  for (const row of ordered.filter((candidate) => candidate.bundleIds.length > 0)) {
    const key = namedCardKey(placeOf(row), row.workerId)
    const fresh = row.bundleIds.filter((id) => open.has(id) && !owner.has(id))
    const group = named.get(key)
    if (fresh.length === 0 && !group) {
      // Every bundle it lists is held already: a second person on the same bundles joins that card, a spent row is no card.
      const held = row.bundleIds.map((id) => owner.get(id)).find((value) => value !== undefined)
      if (held) named.get(held)!.rows.push(row)
      continue
    }
    const entry = group ?? { stationId: row.stationId, lineId: row.lineId, bundleIds: [], rows: [] }
    entry.rows.push(row)
    for (const id of fresh) {
      entry.bundleIds.push(id)
      owner.set(id, key)
    }
    named.set(key, entry)
  }
  const placed = [...named.entries()].map(([key, group]): Placement<Row> => ({ key, ...group, whole: false, sequence: group.rows[0]?.sequence ?? null }))
  const left = openBundleIds.filter((id) => !owner.has(id))
  const wholeRows = ordered.filter((row) => row.bundleIds.length === 0)
  if (wholeRows.length === 0) return { placements: placed, rest: left, unplaced: true }
  // Rows with no list are one card: at the first station named (the write side keeps them at one station).
  const anchor = wholeRows.find((row) => row.stationId !== null) ?? wholeRows[0]!
  const key = wholeCardKey(placeOf(anchor))
  const same = placed.filter((placement) => placement.stationId === anchor.stationId && placement.lineId === anchor.lineId)
  const others = placed.filter((placement) => !same.includes(placement))
  const merged: Placement<Row> = {
    key,
    stationId: anchor.stationId,
    lineId: anchor.lineId,
    bundleIds: [...same.flatMap((placement) => placement.bundleIds), ...left],
    whole: true,
    rows: [...wholeRows, ...same.flatMap((placement) => placement.rows)],
    sequence: anchor.sequence,
  }
  return { placements: [...others, merged], rest: [], unplaced: false }
}

// ---- a move (MES-027) ---------------------------------------------------------------------------------------------------

export interface MoveTarget {
  readonly stationId: string | null
  readonly lineId: string | null
  readonly workerId: string | null
  /** Back to Not assigned. */
  readonly unplaced: boolean
  /** Nobody named any more (the undo of a move to an operator; the card stays at its station). */
  readonly clearWorker?: boolean | undefined
}

export interface MoveInput<Row extends AssignmentFacts = AssignmentFacts> {
  readonly rows: readonly Row[]
  readonly openBundleIds: readonly string[]
  /** The card's key, or REST_CARD. */
  readonly from: string
  /** Some bundles of the card; null: all of it. */
  readonly bundleIds: readonly string[] | null
  readonly to: MoveTarget
}

export interface RowChange {
  readonly id: string
  readonly version: number
  readonly stationId?: string | null
  readonly lineId?: string | null
  readonly workerId?: string | null
  readonly bundleIds?: readonly string[]
}

export interface RowToMake {
  readonly stationId: string | null
  readonly lineId: string | null
  readonly workerId: string | null
  readonly bundleIds: readonly string[]
}

export interface MovePlan {
  readonly updates: readonly RowChange[]
  readonly creates: readonly RowToMake[]
  readonly removes: readonly { readonly id: string; readonly version: number }[]
  /** What moved: the bundles, and whether the whole card went. */
  readonly bundleIds: readonly string[]
  readonly whole: boolean
  /** The card's key now, and how to put it back. */
  readonly key: string
  readonly back: { readonly bundleIds: readonly string[] | null; readonly to: MoveTarget }
}

export type MoveOutcome = { readonly ok: true; readonly plan: MovePlan } | { readonly ok: false; readonly refusal: DispatchRefusal }

const refused = (refusal: DispatchRefusal): MoveOutcome => ({ ok: false, refusal })

/** What a move changes on the operation's rows of the day. No row is touched when nothing moves. */
export function movePlan<Row extends AssignmentFacts>(input: MoveInput<Row>): MoveOutcome {
  const { rows, openBundleIds, from, bundleIds, to } = input
  const { placements, rest, unplaced } = placementsOf(rows, openBundleIds)
  const source = placements.find((placement) => placement.key === from) ?? null
  if (from === REST_CARD ? !unplaced : source === null) return refused(DISPATCH_REFUSALS.MOVED_ALREADY)
  const held = source ? source.bundleIds : rest
  if (bundleIds?.some((id) => !held.includes(id))) return refused(DISPATCH_REFUSALS.MOVED_ALREADY)
  const picked = bundleIds ?? held
  // Bundles named on a card that holds "all the rest" go by name: garments not in a bundle yet stay with the card.
  const all = bundleIds === null || (source !== null && !source.whole && picked.length === held.length)
  // Putting it back names a person only when this move changed who.
  const firstWorker = source?.rows[0]?.workerId ?? null
  const sourceTarget: MoveTarget = source ? { stationId: source.stationId, lineId: source.lineId, workerId: to.workerId !== null ? firstWorker : null, unplaced: false, clearWorker: to.workerId !== null && firstWorker === null } : { stationId: null, lineId: null, workerId: null, unplaced: true }
  const back = { bundleIds: all ? null : picked, to: sourceTarget }

  if (to.unplaced) {
    if (!source) return refused(DISPATCH_REFUSALS.NOTHING_TO_MOVE)
    if (source.whole && !all) return refused(DISPATCH_REFUSALS.NOT_SPLIT_OFF)
    const shrunk = source.whole ? null : withoutBundles(source.rows, picked)
    return {
      ok: true,
      plan: { updates: shrunk?.updates ?? [], creates: [], removes: shrunk?.removes ?? source.rows.map((row) => ({ id: row.id, version: row.version })), bundleIds: picked, whole: all, key: REST_CARD, back },
    }
  }

  const place = placeOf(to)
  const samePlace = source !== null && placeOf(source) === place
  const sameWorker = to.clearWorker ? source?.rows.every((row) => row.workerId === null) === true : to.workerId === null || source?.rows.some((row) => row.workerId === to.workerId) === true
  if (samePlace && sameWorker) return refused(DISPATCH_REFUSALS.NOTHING_TO_MOVE)
  const who = to.clearWorker ? { workerId: null } : to.workerId !== null ? { workerId: to.workerId } : {}
  const single = to.workerId !== null || to.clearWorker === true

  // The whole card with its rows: they go along (and a new operator takes the first, with no second person on it).
  if (source?.whole && all) {
    const [first, ...others] = source.rows
    const updates = source.rows.filter((row) => !(single && row !== first)).map((row): RowChange => ({ id: row.id, version: row.version, stationId: to.stationId, lineId: to.lineId, ...who }))
    const removes = single ? others.map((row) => ({ id: row.id, version: row.version })) : []
    return { ok: true, plan: { updates, creates: [], removes, bundleIds: picked, whole: true, key: wholeCardKey(place), back } }
  }

  const wholeThere = placements.find((placement) => placement.whole && placeOf(placement) === place) ?? null
  const keyThere = namedCardKey(place, to.workerId)
  const named = placements.find((placement) => !placement.whole && placement.key === keyThere && placement !== source) ?? null

  // What has no place, all of it: a row with no list ("all the rest").
  if (!source && all) {
    return { ok: true, plan: { updates: [], creates: [{ stationId: to.stationId, lineId: to.lineId, workerId: to.workerId, bundleIds: [] }], removes: [], bundleIds: picked, whole: true, key: wholeCardKey(place), back } }
  }

  // All of a card held by name, to a place with nothing of the operation: its rows go along.
  if (source && !source.whole && all && !wholeThere && !named) {
    const [first, ...others] = source.rows
    const updates = source.rows.filter((row) => !(single && row !== first)).map((row): RowChange => ({ id: row.id, version: row.version, stationId: to.stationId, lineId: to.lineId, ...who }))
    const removes = single ? others.map((row) => ({ id: row.id, version: row.version })) : []
    const worker = to.clearWorker ? null : (to.workerId ?? first?.workerId ?? null)
    return { ok: true, plan: { updates, creates: [], removes, bundleIds: picked, whole: false, key: namedCardKey(place, worker), back } }
  }

  // By name: the bundles leave their rows and join the place.
  const shrunk = source && !source.whole ? withoutBundles(source.rows, picked) : { updates: [] as RowChange[], removes: [] as { id: string; version: number }[] }
  if (wholeThere && to.workerId === null) return { ok: true, plan: { updates: shrunk.updates, creates: [], removes: shrunk.removes, bundleIds: picked, whole: all, key: wholeThere.key, back } }
  if (named) {
    const first = named.rows[0]!
    const bundles = [...new Set([...first.bundleIds, ...picked])]
    return { ok: true, plan: { updates: [...shrunk.updates, { id: first.id, version: first.version, bundleIds: bundles }], creates: [], removes: shrunk.removes, bundleIds: picked, whole: all, key: named.key, back } }
  }
  return { ok: true, plan: { updates: shrunk.updates, creates: [{ stationId: to.stationId, lineId: to.lineId, workerId: to.workerId, bundleIds: picked }], removes: shrunk.removes, bundleIds: picked, whole: all, key: keyThere, back } }
}

function withoutBundles<Row extends AssignmentFacts>(rows: readonly Row[], bundleIds: readonly string[]): { updates: RowChange[]; removes: { id: string; version: number }[] } {
  const leaving = new Set(bundleIds)
  const updates: RowChange[] = []
  const removes: { id: string; version: number }[] = []
  for (const row of rows) {
    const kept = row.bundleIds.filter((id) => !leaving.has(id))
    if (kept.length === row.bundleIds.length) continue
    if (kept.length === 0) removes.push({ id: row.id, version: row.version })
    else updates.push({ id: row.id, version: row.version, bundleIds: kept })
  }
  return { updates, removes }
}

/**
 * The new numbers of a lane with these rows at a position (1 = first): only the rows whose number changes. Rows of one
 * card stay together. `position` past the end: the end.
 */
export function laneNumbers<Row extends Pick<AssignmentFacts, 'id' | 'sequence' | 'createdAt'>>(rows: readonly Row[], movedIds: readonly string[], position: number | null): { readonly id: string; readonly sequence: number }[] {
  const moved = new Set(movedIds)
  const ordered = [...rows].sort(byLane)
  const staying = ordered.filter((row) => !moved.has(row.id))
  const going = ordered.filter((row) => moved.has(row.id))
  const at = position === null ? staying.length : Math.min(Math.max(position - 1, 0), staying.length)
  const next = [...staying.slice(0, at), ...going, ...staying.slice(at)]
  return next.flatMap((row, index) => (row.sequence === index + 1 ? [] : [{ id: row.id, sequence: index + 1 }]))
}

// ---- sequence rules (MES-025) -------------------------------------------------------------------------------------------

export const SEQUENCE_STATES = ['CLEAR', 'WARN', 'HELD'] as const
export type SequenceState = (typeof SEQUENCE_STATES)[number]

export interface SequenceFacts {
  readonly operation: { readonly seq: number; readonly name: string }
  readonly previous: { readonly seq: number; readonly name: string } | null
  /** The operation before it has passed nothing on yet. */
  readonly waiting: boolean
}

/**
 * What the site's rule (ProductionSettings.skippedOperationRule: STRICT, WARN or FREE, edited with the floor rules,
 * B-W2b-53) says about starting this work now. The scan's own guard (B-W2b-46) decides at the tablet; this is the same
 * rule on the list, before anyone walks to the machine. B-W2b-88: `previous` is the step before (product/routing/parallel
 * stepBefore), never a sibling of a parallel group: siblings start side by side.
 */
export function sequenceOf(mode: FloorRuleMode, facts: SequenceFacts): { readonly rule: FloorRuleMode; readonly state: SequenceState; readonly words: string | null } {
  if (!facts.previous || !facts.waiting) return { rule: mode, state: 'CLEAR', words: null }
  const before = `Op ${facts.previous.seq} ${facts.previous.name}`
  if (mode === 'STRICT') return { rule: mode, state: 'HELD', words: `Op ${facts.operation.seq} ${facts.operation.name} starts when ${before} has passed work on: this site keeps a strict sequence.` }
  if (mode === 'WARN') return { rule: mode, state: 'WARN', words: `${before} has passed nothing on yet: it may start, and the team leader is told.` }
  return { rule: mode, state: 'CLEAR', words: null }
}

export interface LaneEntry {
  readonly workOrderId: string
  readonly workOrderNumber: string
  readonly seq: number
  readonly name: string
  /** B-W2b-88: its parallel group; operations side by side may stand in either order. */
  readonly parallelGroup?: number | null | undefined
}

/**
 * The first pair of a lane out of order: a later operation of a work order before an earlier one of the same work order
 * (B-W2b-88: two operations of one parallel group are in no order).
 */
export function laneOrderIssue(lane: readonly LaneEntry[]): { readonly earlier: LaneEntry; readonly later: LaneEntry; readonly words: string } | null {
  for (let i = 0; i < lane.length; i += 1) {
    for (let j = i + 1; j < lane.length; j += 1) {
      const first = lane[i]!
      const second = lane[j]!
      if (first.workOrderId === second.workOrderId && first.seq > second.seq && !sideBySide(first, second)) {
        return { earlier: second, later: first, words: `Op ${first.seq} ${first.name} of ${first.workOrderNumber} stands before Op ${second.seq} ${second.name}.` }
      }
    }
  }
  return null
}

/** Today or a later day may change; a day that is over stays as it was. */
export const isPastDay = (day: BusinessDate, today: BusinessDate): boolean => day < today

/** Rush first (the W2a order), then the lane's order where the board set one; the W2a order settles the rest. */
export function laneFirst(a: { readonly rush: boolean; readonly order: number | null }, b: { readonly rush: boolean; readonly order: number | null }): number {
  if (a.rush !== b.rush) return a.rush ? -1 : 1
  if (a.order === null && b.order === null) return 0
  if (a.order === null) return 1
  if (b.order === null) return -1
  return a.order - b.order
}

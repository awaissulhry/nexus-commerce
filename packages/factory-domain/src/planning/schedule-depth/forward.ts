import type { Duration } from '../schedule/backward'
import { after, MINUTE_MS, startFrom, whenWords } from '../schedule/time'

/**
 * Forward scheduling on free time and the backlog reschedule (B-W2b-312; PLN-130 "schedule from today to get the earliest
 * finish when backward scheduling lands in the past", PLN-141 "operations left in the past are moved into the first feasible
 * slots in one action", PLN-139 pins; design planning.board "Reschedule backlog (W2b)"), pure.
 *
 * A lane works one bar at a time: a bar's working minutes are its standard minutes ÷ (people × efficiency) of the whole lane
 * (planning/schedule/time `workingMinutesFor`), so two bars on one lane at once would book it twice. Here a lane's time is
 * its working stretches (THE calendars service's, read by the API) less the bars that stay on it. Walking a work order's
 * operations by sequence (finish to start), each operation to (re)plan goes to the FIRST stretch of its lane, at or after
 * the moment it may start, where its working minutes run without meeting another bar:
 *
 *   may start   the later of now, the earliest start with material (planning/schedule-depth/material) and the finish of the
 *               operation before it
 *   pinned      a pinned bar never moves (PLN-139): it is an obstacle on its lane and the operation after it starts after
 *               it; a pinned bar that starts before the operation before it can finish is named (the planner unpins it
 *               or moves it by hand)
 *   a workshop  outside work takes its clock days (the routing step's transit days) from the moment it may start; a
 *               workshop's own capacity is B-W2b-321's
 *
 * How each operation is treated is the caller's (the mode): REPLAN always goes to the first fit (forward scheduling of a
 * late order: its whole chain from today); KEEP_IF_FITS stays where it is unless it would start before the operation
 * before it finishes (the backlog reschedule pushes what follows only as far as it must); FIXED stays (a pinned bar, or a
 * bar that is not this run's); UNPLACED is not on the board and is left alone (the backlog reschedule leaves the tray to
 * "Place all by due date"). Work orders are planned one after another in the caller's order (the most urgent first), each
 * taking the free time the earlier ones left. Instants are epoch milliseconds; no person, no money.
 */

export const CHAIN_MODES = ['REPLAN', 'KEEP_IF_FITS', 'FIXED', 'UNPLACED'] as const
export type ChainMode = (typeof CHAIN_MODES)[number]

/** Why an operation moves: forward from today, left in the past, pushed by the one before it, placed from the tray. */
export const MOVE_WHYS = ['FORWARD', 'PAST', 'PUSHED', 'PLACED'] as const
export type MoveWhy = (typeof MOVE_WHYS)[number]

/** What a run names and leaves where it is. */
export const KEPT_CODES = ['PINNED_IN_THE_PAST', 'PINNED_BEFORE_PREVIOUS', 'NO_WORKING_TIME'] as const
export type KeptCode = (typeof KEPT_CODES)[number]

export interface BusySpan {
  readonly start: number
  readonly end: number
  /** The slot (or the operation being placed) that keeps it busy. */
  readonly id: string
}

export interface ChainOperation {
  readonly id: string
  readonly seq: number
  /** "Op 20 Sew" (the words). */
  readonly label: string
  readonly laneKey: string
  readonly duration: Duration
  /** Its bar on the working plan now (null: not on the board). */
  readonly current: { readonly slotId: string; readonly start: number; readonly end: number; readonly pinned: boolean } | null
  readonly mode: ChainMode
  /** Why it moves when it does (FORWARD, PAST; a KEEP_IF_FITS bar that must move is PUSHED; an unplaced REPLAN is PLACED). */
  readonly why: MoveWhy
}

export interface ChainOrder {
  readonly workOrderId: string
  readonly number: string
  /** The earliest it may start: the later of now and the earliest start with material. */
  readonly from: number
  readonly operations: readonly ChainOperation[]
}

export interface ChainMove {
  readonly workOrderId: string
  readonly operationId: string
  readonly laneKey: string
  /** The bar it moves (null: placed from the tray). */
  readonly slotId: string | null
  readonly from: { readonly start: number; readonly end: number } | null
  readonly to: { readonly start: number; readonly end: number }
  readonly why: MoveWhy
}

export interface ChainKept {
  readonly workOrderId: string
  readonly operationId: string
  readonly slotId: string | null
  readonly code: KeptCode
  readonly words: string
}

export interface ChainResult {
  readonly moves: readonly ChainMove[]
  readonly kept: readonly ChainKept[]
  /** Per work order: its last operation's finish after the run (null: nothing of it on the board). */
  readonly finishes: ReadonlyMap<string, number | null>
}

/** The first start at or after `from` where `duration` runs on its lane without meeting a busy span; null beyond the calendar. */
export function firstFit(duration: Duration, from: number, busy: readonly BusySpan[]): { start: number; end: number } | null {
  if (duration.kind === 'CLOCK') return { start: from, end: from + Math.max(1, duration.minutes) * MINUTE_MS }
  const sorted = [...busy].sort((a, b) => a.start - b.start || a.end - b.end)
  let candidate = from
  // Each busy span can be met once (the next candidate starts after it), so this ends.
  for (let round = 0; round <= sorted.length; round += 1) {
    const start = startFrom(duration.spans, candidate)
    if (start === null) return null
    const end = after(duration.spans, start, Math.max(1, duration.minutes))
    if (end === null) return null
    const clash = sorted.find((span) => span.start < end && span.end > start)
    if (!clash) return { start, end: Math.max(end, start + MINUTE_MS) }
    candidate = Math.max(candidate, clash.end)
  }
  return null
}

const without = (spans: readonly BusySpan[], id: string): BusySpan[] => spans.filter((span) => span.id !== id)

/**
 * Plans the work orders in order on the lanes' free time (see above). `busy`: per lane key, the bars that stay where they
 * are, including every KEEP_IF_FITS and FIXED bar of the orders (a REPLAN bar is left out by the caller, or here). It is
 * not changed: the run works on its own copy.
 */
export function planChains(orders: readonly ChainOrder[], busy: ReadonlyMap<string, readonly BusySpan[]>, timeZone: string): ChainResult {
  const lanes = new Map<string, BusySpan[]>([...busy.entries()].map(([key, spans]) => [key, [...spans]]))
  // A REPLAN bar never blocks itself or another order's run.
  for (const order of orders) for (const operation of order.operations) if (operation.mode === 'REPLAN' && operation.current && !operation.current.pinned) lanes.set(operation.laneKey, without(lanes.get(operation.laneKey) ?? [], operation.current.slotId))
  const say = (instant: number) => whenWords(instant, timeZone)
  const moves: ChainMove[] = []
  const kept: ChainKept[] = []
  const finishes = new Map<string, number | null>()
  for (const order of orders) {
    let ready = order.from
    let finish: number | null = null
    let previous: { label: string; end: number } | null = null
    for (const operation of [...order.operations].sort((a, b) => a.seq - b.seq)) {
      const current = operation.current
      if (operation.mode === 'UNPLACED') continue
      const fixed = operation.mode === 'FIXED' || (current !== null && current.pinned)
      const stays = fixed || (operation.mode === 'KEEP_IF_FITS' && current !== null && current.start >= ready)
      if (stays && current) {
        if (current.pinned && previous && current.start < previous.end) {
          kept.push({ workOrderId: order.workOrderId, operationId: operation.id, slotId: current.slotId, code: 'PINNED_BEFORE_PREVIOUS', words: `${order.number} ${operation.label} is pinned to start ${say(current.start)}, before ${previous.label} can finish (${say(previous.end)}): unpin it, or move it by hand.` })
        }
        ready = Math.max(ready, current.end)
        finish = Math.max(finish ?? current.end, current.end)
        previous = { label: operation.label, end: current.end }
        continue
      }
      if (fixed) continue
      const spans = lanes.get(operation.laneKey) ?? []
      const free = current ? without(spans, current.slotId) : spans
      const fit = firstFit(operation.duration, ready, free)
      if (fit === null) {
        kept.push({ workOrderId: order.workOrderId, operationId: operation.id, slotId: current?.slotId ?? null, code: 'NO_WORKING_TIME', words: `${order.number} ${operation.label} does not fit in the working time loaded after ${say(ready)}: place it by hand.` })
        // What follows waits for it: the chain stops here.
        break
      }
      const id = current?.slotId ?? `new:${operation.id}`
      lanes.set(operation.laneKey, [...free, { start: fit.start, end: fit.end, id }])
      if (!current || current.start !== fit.start || current.end !== fit.end) {
        const why: MoveWhy = current === null ? 'PLACED' : operation.mode === 'KEEP_IF_FITS' ? 'PUSHED' : operation.why
        moves.push({ workOrderId: order.workOrderId, operationId: operation.id, laneKey: operation.laneKey, slotId: current?.slotId ?? null, from: current ? { start: current.start, end: current.end } : null, to: fit, why })
      }
      ready = fit.end
      finish = Math.max(finish ?? fit.end, fit.end)
      previous = { label: operation.label, end: fit.end }
    }
    finishes.set(order.workOrderId, finish)
  }
  return { moves, kept, finishes }
}

/** The order a run plans work orders in: rush first, then priority (higher first), then the earliest latest safe start, due date, number. */
export function runOrder(
  a: { readonly rush: boolean; readonly priority: number; readonly latestSafeStart: number | null; readonly dueDate: string | null; readonly number: string },
  b: { readonly rush: boolean; readonly priority: number; readonly latestSafeStart: number | null; readonly dueDate: string | null; readonly number: string },
): number {
  if (a.rush !== b.rush) return a.rush ? -1 : 1
  if (a.priority !== b.priority) return b.priority - a.priority
  const x = a.latestSafeStart ?? Number.POSITIVE_INFINITY
  const y = b.latestSafeStart ?? Number.POSITIVE_INFINITY
  if (x !== y) return x < y ? -1 : 1
  const da = a.dueDate ?? '9999-12-31'
  const db = b.dueDate ?? '9999-12-31'
  if (da !== db) return da < db ? -1 : 1
  return a.number < b.number ? -1 : a.number > b.number ? 1 : 0
}

/** A bar left in the past (PLN-141): it should have ended by now and its operation still has work left. */
export const leftInThePast = (slot: { readonly end: number }, remaining: number, now: number): boolean => remaining > 0 && slot.end <= now

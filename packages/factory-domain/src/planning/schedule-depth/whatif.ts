import { Dec, type Decimal } from '../../tax/decimal'
import type { LaneRef } from '../schedule/slots'
import { laneKey } from '../schedule/slots'

/**
 * What-if on the planning board (B-W2b-312; design planning.board sec:whatif "Try moves privately and see what they change
 * before anyone else does": the banner "What-if — nothing reaches the floor or other planners until you apply", the deltas
 * "late orders 4 → 2 · overtime needed 0 → 6 h · Line 2 load 104% → 92% · orders that move: 7", Apply to plan (merges; the
 * conflicts listed when the working plan changed meanwhile), Discard), pure.
 *
 * A scenario (WhatIfScenario, B-W2b-286) is one planner's DRAFT list of moves on the site's working plan, never seen by
 * another planner: a bar moved (MOVE: its lane and times), an operation placed from the tray (PLACE), a bar sent back to
 * the tray (REMOVE). One entry per bar (MOVE, REMOVE) or per operation (PLACE): trying a bar again replaces its entry. Each
 * entry keeps the bar's version and place when it was first tried, so Apply names what the working plan changed since
 * (another planner moved the bar, it was pinned, removed, or the operation got a bar). The effect is the API's (it reads the
 * world); its words are here. No money; no person (the owner is the scenario's own).
 */

export const WHAT_IF_MOVE_KINDS = ['MOVE', 'PLACE', 'REMOVE'] as const
export type WhatIfMoveKind = (typeof WHAT_IF_MOVE_KINDS)[number]

export const WHAT_IF_LIMITS = Object.freeze({ moves: 200, name: 200 })

/** Why a tried move cannot be applied as it is (Apply lists them; `skipConflicts` applies the rest). */
export const WHAT_IF_CONFLICTS = ['SLOT_GONE', 'SLOT_MOVED', 'SLOT_PINNED', 'ALREADY_ON_BOARD', 'NOT_OPEN', 'OPERATION_DONE', 'GATE_NOT_PASSED'] as const
export type WhatIfConflictCode = (typeof WHAT_IF_CONFLICTS)[number]

export interface WhatIfPlace {
  readonly lane: LaneRef
  /** UTC ISO instants. */
  readonly startAt: string
  readonly endAt: string
}

/** A move as the scenario stores it (WhatIfScenario.moves). */
export interface WhatIfMove {
  readonly kind: WhatIfMoveKind
  /** MOVE, REMOVE: the bar. */
  readonly slotId: string | null
  /** MOVE, REMOVE: the bar's version when it was first tried. */
  readonly slotVersion: number | null
  readonly workOrderId: string
  readonly operationId: string | null
  /** MOVE, REMOVE: where the bar was when it was first tried. */
  readonly from: WhatIfPlace | null
  /** MOVE, PLACE: where it goes. */
  readonly to: WhatIfPlace | null
}

/** The key of a move: its bar, or (a placement) its operation. */
export const moveKey = (move: Pick<WhatIfMove, 'kind' | 'slotId' | 'workOrderId' | 'operationId'>): string => (move.kind === 'PLACE' ? `op:${move.workOrderId}:${move.operationId}` : `slot:${move.slotId}`)

/**
 * The scenario's moves after a new list is tried: one per key, in the order they were first tried. An entry tried again
 * with the same target keeps the bar's version and place from when it was first tried (so Apply still names what another
 * planner changed since); one tried again with a new target is read again (the planner has seen the bar as it is now).
 */
export function mergeMoves(previous: readonly WhatIfMove[], next: readonly WhatIfMove[]): WhatIfMove[] {
  const before = new Map(previous.map((move) => [moveKey(move), move]))
  const out = new Map<string, WhatIfMove>()
  for (const move of next) {
    const key = moveKey(move)
    const first = before.get(key)
    out.delete(key)
    out.set(key, first && first.kind === move.kind && sameTarget(first.to, move.to) ? first : move)
  }
  return [...out.values()]
}

const sameTarget = (a: WhatIfPlace | null, b: WhatIfPlace | null): boolean =>
  a === null || b === null ? a === b : laneKey(a.lane) === laneKey(b.lane) && a.startAt === b.startAt && a.endAt === b.endAt

/** "6 h", "2.5 h" from standard minutes (one decimal, whole hours without it). */
export function hoursWords(minutes: Decimal | string): string {
  const hours = new Dec(minutes.toString()).div(60).toDecimalPlaces(1, Dec.ROUND_HALF_UP)
  return `${hours.isInteger() ? hours.toFixed(0) : hours.toFixed(1)} h`
}

export interface WhatIfLaneDelta {
  readonly lane: LaneRef
  readonly code: string
  /** Booked ÷ available on its busiest day among the days its moves touch, one decimal; null without working time. */
  readonly beforePct: string | null
  readonly afterPct: string | null
}

export interface WhatIfDelta {
  readonly lateOrders: { readonly before: number; readonly after: number }
  /** Standard minutes over the lanes' available minutes, every day of the window. */
  readonly overMinutes: { readonly before: string; readonly after: string }
  readonly lanes: readonly WhatIfLaneDelta[]
  /** Work orders whose planned start or finish changes. */
  readonly ordersThatMove: number
}

const pct = (value: string | null): string => (value === null ? '—' : `${new Dec(value).toDecimalPlaces(0, Dec.ROUND_HALF_UP).toFixed(0)}%`)

/** "late orders 4 → 2 · overtime needed 0 → 6 h · L2 load 104% → 92% · orders that move: 7". */
export function deltaWords(delta: WhatIfDelta): string {
  const parts = [`late orders ${delta.lateOrders.before} → ${delta.lateOrders.after}`, `overtime needed ${hoursWords(delta.overMinutes.before).replace(' h', '')} → ${hoursWords(delta.overMinutes.after)}`]
  for (const lane of delta.lanes) parts.push(`${lane.code} load ${pct(lane.beforePct)} → ${pct(lane.afterPct)}`)
  parts.push(`orders that move: ${delta.ordersThatMove}`)
  return parts.join(' · ')
}

/** The lanes a scenario's moves touch (where bars leave and arrive), each once, in the order met. */
export function touchedLanes(moves: readonly WhatIfMove[]): LaneRef[] {
  const out = new Map<string, LaneRef>()
  for (const move of moves) for (const place of [move.from, move.to]) if (place) out.set(laneKey(place.lane), place.lane)
  return [...out.values()]
}

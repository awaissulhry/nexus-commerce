import type { Issue } from '../../core/errors'

/**
 * Allocation of work orders to lines and workshops (B-W2a-34; PLN-160; design planning.allocation "Allocation board":
 * "Drag an order, or part of it, onto a line, plant or workshop"), pure.
 *
 *   the line    a work order's line (WorkOrder.lineId) makes every garment no part names: the capacity books its line
 *               operations there.
 *   parts       a part of the order on another lane: a whole-order slot of the site's working plan with its garments,
 *               on another line or a workshop (a party with the SUBCONTRACTOR role, ACTIVE). At most one part per
 *               lane; the parts' garments add up to at most the order's; the rest is the line's (or not allocated).
 *   plants      another site's line is a plant: W3 (a site's plan has only its own lanes).
 *
 * A card of the allocation board is the work order's line part (the garments no part names, on its line or "Not
 * allocated") or one of its parts. Moving a card (or some of its garments) from one column to another gives the next
 * allocation (`moveAllocation`), which the API stores as one change.
 */

export const ALLOCATION_LANE_KINDS = ['LINE', 'WORKSHOP'] as const
export type AllocationLaneKind = (typeof ALLOCATION_LANE_KINDS)[number]

export interface AllocationLane {
  readonly kind: AllocationLaneKind
  readonly id: string
}

export interface AllocationPart {
  readonly lane: AllocationLane
  readonly pieces: number
}

export interface Allocation {
  /** The line that makes the garments no part names; null: not allocated. */
  readonly lineId: string | null
  readonly parts: readonly AllocationPart[]
}

const same = (a: AllocationLane | null, b: AllocationLane | null): boolean => (a === null || b === null ? a === b : a.kind === b.kind && a.id === b.id)

/** The garments the line part keeps (or that are not allocated). */
export const mainPiecesOf = (allocation: Allocation, garments: number): number => garments - allocation.parts.reduce((sum, part) => sum + part.pieces, 0)

/** An allocation's own problems (400, issues at `body/…`). */
export function allocationProblems(allocation: Allocation, garments: number): Issue[] {
  const problems: Issue[] = []
  const seen = new Set<string>()
  allocation.parts.forEach((part, index) => {
    const key = `${part.lane.kind}:${part.lane.id}`
    if (seen.has(key)) problems.push({ path: `body/parts/${index}/lane`, message: 'One part per lane: add the garments to the part that is there.' })
    seen.add(key)
    if (part.lane.kind === 'LINE' && part.lane.id === allocation.lineId) problems.push({ path: `body/parts/${index}/lane`, message: "The work order's own line makes the garments no part names; a part goes to another line or a workshop." })
    if (!Number.isInteger(part.pieces) || part.pieces < 1) problems.push({ path: `body/parts/${index}/pieces`, message: 'Give whole garments, from 1.' })
  })
  if (problems.length === 0 && mainPiecesOf(allocation, garments) < 0) {
    problems.push({ path: 'body/parts', message: `The parts name ${garments - mainPiecesOf(allocation, garments)} garments; the work order has ${garments}.` })
  }
  return problems
}

export interface AllocationMove {
  /** The card's column: the work order's line (or null: not allocated), or a part's lane. */
  readonly from: AllocationLane | null
  readonly to: AllocationLane | null
  /** Garments to move; default all of the card's. */
  readonly pieces?: number | undefined
}

/**
 * The allocation after moving a card (or some of its garments). The line part moved whole to a line makes that line
 * the work order's; moved to a workshop (or a part of it anywhere) it becomes a part there, added to one already there;
 * a part moved onto the work order's line (or onto "Not allocated" when the order has no line) goes back to the line
 * part. A refusal is said in words.
 */
export function moveAllocation(current: Allocation, move: AllocationMove, garments: number): { allocation: Allocation } | { refusal: string } {
  const mainLane: AllocationLane | null = current.lineId ? { kind: 'LINE', id: current.lineId } : null
  const fromMain = same(move.from, mainLane)
  const fromPart = fromMain ? null : current.parts.find((part) => same(part.lane, move.from))
  if (!fromMain && !fromPart) return { refusal: 'The card is not in that column any more: reload the board.' }
  const available = fromMain ? mainPiecesOf(current, garments) : fromPart!.pieces
  const pieces = move.pieces ?? available
  if (!Number.isInteger(pieces) || pieces < 1) return { refusal: 'Move whole garments, from 1.' }
  if (pieces > available) return { refusal: `The card holds ${available} garments.` }
  if (same(move.from, move.to)) return { refusal: 'The card is already there.' }
  const toMain = same(move.to, mainLane) || (move.to === null && mainLane === null)
  let parts = current.parts.map((part) => ({ ...part }))
  let lineId = current.lineId
  const take = (lane: AllocationLane, count: number) => {
    parts = parts.map((part) => (same(part.lane, lane) ? { ...part, pieces: part.pieces - count } : part)).filter((part) => part.pieces > 0)
  }
  const give = (lane: AllocationLane, count: number) => {
    const there = parts.find((part) => same(part.lane, lane))
    parts = there ? parts.map((part) => (same(part.lane, lane) ? { ...part, pieces: part.pieces + count } : part)) : [...parts, { lane, pieces: count }]
  }
  if (fromMain) {
    if (move.to === null) {
      if (pieces < available) return { refusal: 'Part of an order cannot wait unallocated while the rest is on a line: move it to another lane.' }
      lineId = null
    } else if (move.to.kind === 'LINE' && pieces === available && !parts.some((part) => same(part.lane, move.to))) {
      lineId = move.to.id
    } else {
      give(move.to, pieces)
    }
  } else {
    take(move.from!, pieces)
    if (toMain) {
      // Back to the line part (or to "Not allocated" when the order has no line).
    } else if (move.to === null) {
      return { refusal: 'Part of an order cannot wait unallocated while the rest is on a line: move it back onto the line.' }
    } else if (move.to.kind === 'LINE' && mainLane === null && parts.length === 0 && pieces === garments) {
      // The order's only part, whole, onto a line: that line makes the order.
      lineId = move.to.id
    } else {
      give(move.to, pieces)
    }
  }
  return { allocation: { lineId, parts } }
}

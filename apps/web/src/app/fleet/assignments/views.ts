/**
 * NAF.SB.AS.4 — the list's arithmetic, extracted so it can be proven.
 *
 * The invariant this exists to protect: **every tile's number is exactly the
 * number of rows clicking it reveals, and the tiles plus the stated remainder
 * account for every assignment.** A strip that says 3 and a list that shows 2
 * is the defect most likely to ship on this page, and it is invisible to
 * typechecking — the counts and the filter were computed in two places by two
 * expressions that merely looked like each other.
 *
 * Now they are one function each, and a vitest asserts they agree.
 */
import { isOpenState, TILE_ORDER, type AssignmentState } from './states'

export interface CountableRow {
  id: string
  state: AssignmentState
  dueAt: string | null
  createdAt: string
}

/** One number per tile, in strip order. */
export function tileCounts<T extends CountableRow>(
  rows: T[],
): Record<AssignmentState, number> {
  const out = {} as Record<AssignmentState, number>
  for (const k of TILE_ORDER) out[k] = 0
  out.closed = 0
  out.cancelled = 0
  for (const r of rows) out[r.state] = (out[r.state] ?? 0) + 1
  return out
}

/** How many rows are NOT open, i.e. the remainder the strip states in words. */
export function closedCount<T extends CountableRow>(rows: T[]): number {
  return rows.filter((r) => !isOpenState(r.state)).length
}

/**
 * Overdue first, then newest. A deadline that slipped should be the first
 * thing an eye lands on — it classifies and raises, it never blocks.
 */
export function overdueRank(r: CountableRow, now = Date.now()): number {
  if (!r.dueAt || !isOpenState(r.state)) return 2
  return new Date(r.dueAt).getTime() < now ? 0 : 1
}

/**
 * The rows the list actually renders. THE SAME predicate the tiles count
 * with — that is the whole point of this module.
 */
export function visibleRows<T extends CountableRow>(
  rows: T[],
  opts: { filter?: AssignmentState | null; showClosed?: boolean; now?: number } = {},
): T[] {
  const { filter = null, showClosed = false, now = Date.now() } = opts
  let list = rows
  if (!showClosed) list = list.filter((r) => isOpenState(r.state))
  if (filter) list = list.filter((r) => r.state === filter)
  return [...list].sort((a, b) => {
    const ao = overdueRank(a, now)
    const bo = overdueRank(b, now)
    if (ao !== bo) return ao - bo
    return b.createdAt.localeCompare(a.createdAt)
  })
}

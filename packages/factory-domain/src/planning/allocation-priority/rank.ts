import type { BusinessDate } from '../../core/time'

/**
 * Scarce material by the backlog's priority (B-W2b-318; PLN-088, SCM-207; the "this suit first" of the Owner), pure: the
 * order in which the netting (planning/mrp/net `pegMaterial`) shares a material out when it cannot cover every order.
 *
 *   rank        SalesOrder.backlogRank (PLN-177; 1 is the first; ties allowed; null: not ranked), carried on each demand
 *               part of the order's lines (planning/explode)
 *   scarce      a material the walk by date (W1) leaves short, with at least one part of a ranked order: it is walked
 *               again by priority; a material that is not short, or whose orders are not ranked, keeps W1's walk
 *   priority    ranked parts first, by rank, then the parts of orders not ranked; within a rank by the day it is needed,
 *               then as the plan lists them. Each part takes its own reservations first (W1), then the open purchase
 *               lines that arrive in time — the latest first, so the earlier ones stay for the parts needed sooner — then
 *               free stock, then the firm planned order
 *
 * So the first-ranked order gets the hides first and a lower one is short instead: its need day is the line's need day
 * now, and its work order's readiness says so at once (readiness reads the same netting live). Nothing is reserved by it:
 * a rank changes the plan, never the stock.
 */

export const ALLOCATIONS = ['DATE', 'PRIORITY'] as const
export type Allocation = (typeof ALLOCATIONS)[number]

/** A part of a ranked order. */
export const isRanked = (part: { readonly rank?: number | null | undefined }): boolean => typeof part.rank === 'number' && Number.isSafeInteger(part.rank)

/** The walk's order by priority (see above). */
export function byPriority(a: { readonly part: { readonly rank?: number | null | undefined }; readonly day: BusinessDate; readonly index: number }, b: { readonly part: { readonly rank?: number | null | undefined }; readonly day: BusinessDate; readonly index: number }): number {
  const ra = isRanked(a.part) ? a.part.rank! : Number.MAX_SAFE_INTEGER
  const rb = isRanked(b.part) ? b.part.rank! : Number.MAX_SAFE_INTEGER
  if (ra !== rb) return ra - rb
  if (a.day !== b.day) return a.day < b.day ? -1 : 1
  return a.index - b.index
}

/** "Rank 1" / "not ranked". */
export const rankWords = (rank: number | null | undefined): string => (typeof rank === 'number' ? `rank ${rank}` : 'not ranked')

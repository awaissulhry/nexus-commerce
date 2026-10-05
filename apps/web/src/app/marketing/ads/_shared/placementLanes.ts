/**
 * CM-18 — send only the placement lanes the operator changed.
 *
 * The row Bid Multiplier modal, the bulk modal and the campaign detail page open on a copy of the campaign that can
 * be minutes old (the list and detail reads are cached). They used to send all three lanes from that copy, so a lane
 * nobody touched went back to its old value — a Top of Search move rank-defend made after the page loaded was undone.
 * Now they send `PATCH /campaigns/:id/placements` with `partial: true` and only the lanes that differ from what the
 * screen showed; the server keeps every other lane as it is.
 */

export type PlacementLane = 'tos' | 'pdp' | 'ros'
export const PLACEMENT_LANES: readonly PlacementLane[] = ['tos', 'pdp', 'ros']
/** Amazon's bidding names for the three lanes. */
export const AMAZON_PLACEMENT: Record<PlacementLane, string> = {
  tos: 'PLACEMENT_TOP',
  pdp: 'PLACEMENT_PRODUCT_PAGE',
  ros: 'PLACEMENT_REST_OF_SEARCH',
}

/**
 * A lane's percentage as Amazon takes it: a whole number 0–900. Empty or missing is 0 (Amazon reads a missing lane as
 * 0). `null` when the box holds something that is not a number, so the caller sends nothing for it.
 */
export function lanePercent(value: number | string | null | undefined): number | null {
  if (value == null) return 0
  const text = typeof value === 'string' ? value.trim() : value
  if (text === '') return 0
  const n = Number(text)
  return Number.isFinite(n) ? Math.max(0, Math.min(900, Math.round(n))) : null
}

/**
 * The lanes whose value differs between what the screen showed (`before`) and what the operator left (`after`), as the
 * adjustments of a partial write. A lane emptied or set to 0 is sent as 0, which clears it.
 */
export function changedPlacementLanes(
  before: Partial<Record<PlacementLane, number | string | null>>,
  after: Partial<Record<PlacementLane, number | string | null>>,
): Array<{ placement: string; percentage: number }> {
  const out: Array<{ placement: string; percentage: number }> = []
  for (const lane of PLACEMENT_LANES) {
    const next = lanePercent(after[lane])
    if (next === null || next === lanePercent(before[lane])) continue
    out.push({ placement: AMAZON_PLACEMENT[lane], percentage: next })
  }
  return out
}

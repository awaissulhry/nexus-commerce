/**
 * BL — pure placement-bidding math (no DB, no side effects), so it is unit-testable
 * without a database connection. Shared by ads-top-of-search.service + the rank engine.
 */
export const MAX_PCT = 900
export const clampPct = (p: number): number => Math.max(0, Math.min(MAX_PCT, Math.round(p)))

export const PLACEMENT_TOP = 'PLACEMENT_TOP'
export const PLACEMENT_REST = 'PLACEMENT_REST_OF_SEARCH'
export const PLACEMENT_PRODUCT = 'PLACEMENT_PRODUCT_PAGE'
// The three placements the rank engine manages (Amazon Sponsored Products).
export const MANAGED_PLACEMENTS = [PLACEMENT_TOP, PLACEMENT_REST, PLACEMENT_PRODUCT] as const
const isManaged = (p: string): boolean => (MANAGED_PLACEMENTS as readonly string[]).includes(p)

/**
 * Build the FULL placementBidding array for a BLENDED target — every declared lane's
 * placement set to its %, any managed placement NOT declared but currently boosted set
 * to 0 (the blend owns the whole profile, so dropping a lane removes its bias), and any
 * non-managed placement preserved untouched. Pure + order-independent.
 */
export function buildBlendedAdjustments(
  existing: Array<{ placement: string; percentage: number }>,
  lanes: Array<{ placement: string; percentage: number }>,
): Array<{ placement: string; percentage: number }> {
  const declared = new Map<string, number>()
  for (const l of lanes) {
    if (l?.placement) declared.set(l.placement, clampPct(l.percentage))
  }
  const out: Array<{ placement: string; percentage: number }> = []
  for (const p of MANAGED_PLACEMENTS) {
    if (declared.has(p)) {
      out.push({ placement: p, percentage: declared.get(p)! })
    } else {
      // actively drop a leftover bias on an undeclared managed placement; skip if already 0
      const cur = (existing ?? []).find((e) => e.placement === p)?.percentage ?? 0
      if (cur > 0) out.push({ placement: p, percentage: 0 })
    }
  }
  // defensive: a declared placement outside the managed set + preserve unmanaged existing
  for (const [p, pct] of declared) if (!isManaged(p)) out.push({ placement: p, percentage: pct })
  for (const e of existing ?? []) {
    if (!isManaged(e.placement) && !declared.has(e.placement)) out.push({ placement: e.placement, percentage: e.percentage })
  }
  return out
}

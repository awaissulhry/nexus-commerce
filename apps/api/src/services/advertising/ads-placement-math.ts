/**
 * BL — pure placement-bidding math (no DB, no side effects), so it is unit-testable
 * without a database connection. Shared by ads-top-of-search.service + the rank engine.
 */
export const MAX_PCT = 900
export const clampPct = (p: number): number => Math.max(0, Math.min(MAX_PCT, Math.round(p)))

// BL.7 — base-bid deltaPct: scale a STABLE baseline by ±% (clamped to a sane range),
// floored at 2¢. Pure so the no-compounding contract (always computed from the remembered
// baseline, NEVER from the current/already-modified bid) is unit-testable.
export const BASE_BID_FLOOR_CENTS = 2
export const clampDeltaPct = (d: number): number => Math.max(-95, Math.min(300, Math.round(d)))
export function deltaBidCents(baselineCents: number, deltaPct: number): number {
  return Math.max(BASE_BID_FLOOR_CENTS, Math.round(baselineCents * (1 + clampDeltaPct(deltaPct) / 100)))
}

export const PLACEMENT_TOP = 'PLACEMENT_TOP'
export const PLACEMENT_REST = 'PLACEMENT_REST_OF_SEARCH'
export const PLACEMENT_PRODUCT = 'PLACEMENT_PRODUCT_PAGE'
// The three placements the rank engine manages (Amazon Sponsored Products).
export const MANAGED_PLACEMENTS = [PLACEMENT_TOP, PLACEMENT_REST, PLACEMENT_PRODUCT] as const

/**
 * 🔴 Amazon's REPORT label → the bidding-API enum. THE two-vocabulary join, in one place.
 *
 * `AmazonAdsPlacementReport.placement` holds Amazon's report strings; `dynamicBidding.
 * placementBidding` is keyed by the bidding enums. Matching the report on an enum returns nothing —
 * not an error, a clean zero — and a clean zero reads exactly like "this lane does not deliver".
 * This programme has already produced one wrong hypothesis that way.
 *
 * Exactly three distinct labels exist in this account (verified 2026-08-11, and again 2026-08-22
 * over 4,075 rows). An unrecognised fourth is DROPPED rather than guessed at — a new Amazon label
 * must surface as missing spend a reader can count, never as a lane silently folded into another.
 *
 * PLC-P7 moved this out of `placement-grid.service.ts` (which now imports it) so the parked
 * placement page and the rule engine's lane-scoped criteria cannot disagree about which report row
 * is which lane.
 */
export const REPORT_LABEL_TO_PLACEMENT: Record<string, string> = {
  'Top of Search on-Amazon': PLACEMENT_TOP,
  'Other on-Amazon': PLACEMENT_REST,
  'Detail Page on-Amazon': PLACEMENT_PRODUCT,
}

/** The builder's own words for the three lanes (`conditions[].scope`, `action.placeTarget`). */
export const PLACEMENT_BY_BUILDER_KEY: Record<string, string> = {
  tos: PLACEMENT_TOP,
  pdp: PLACEMENT_PRODUCT,
  ros: PLACEMENT_REST,
}
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

/**
 * G.4 — merge a placement write onto Amazon's CURRENT array, read just before the PUT.
 *
 * Amazon's PUT replaces the whole `placementBidding` array (absent = 0), and every caller builds its
 * array from Nexus's local copy, which the settings sync refreshes only every 20 minutes. So a
 * placement nobody in Nexus touched went out at its local value, and a change made in Amazon's
 * console in those 20 minutes was overwritten.
 *
 * The request is read against the local copy it was built from (absent = 0 throughout):
 *  - requested at a value that differs from the local copy → SET by this write: the new value;
 *  - requested at its local value, or left out while the local copy has it at 0 → not touched:
 *    Amazon's current value;
 *  - left out while the local copy has it above 0 → removed (0), which is what the full-array PUT has
 *    always meant for it (the Ad Manager's multiplier dialog leaves out a lane set to 0).
 * `resend` (re-sending a write Amazon did not take) counts every requested placement as set: there the
 * local copy holds the undelivered values, not Amazon's last state.
 * `partial` (CM-18: the request lists only the lanes a person changed) also counts every requested
 * placement as set, and a placement it leaves out is never removed: it keeps Amazon's current value.
 *
 * Returns the array to send — a placement is listed when it ends above 0 or Amazon lists it, so no
 * "nothing → 0" entry is invented — and the drift: placements where Amazon differs from the local copy.
 * Pure + order-independent.
 */
export function mergeOntoAmazonPlacements(
  requested: Array<{ placement: string; percentage: number }>,
  local: Array<{ placement: string; percentage: number }>,
  amazon: Array<{ placement: string; percentage: number }>,
  opts: { resend?: boolean; partial?: boolean } = {},
): { adjustments: Array<{ placement: string; percentage: number }>; drift: Array<{ placement: string; local: number; amazon: number }> } {
  const toMap = (arr: Array<{ placement: string; percentage: number }>) => {
    const m = new Map<string, number>()
    for (const a of arr ?? []) if (a?.placement) m.set(a.placement, Number(a.percentage) || 0)
    return m
  }
  const req = toMap(requested), loc = toMap(local), amz = toMap(amazon)
  const adjustments: Array<{ placement: string; percentage: number }> = []
  const drift: Array<{ placement: string; local: number; amazon: number }> = []
  for (const p of new Set([...req.keys(), ...amz.keys(), ...loc.keys()])) {
    const l = loc.get(p) ?? 0
    const a = amz.get(p) ?? 0
    if (a !== l) drift.push({ placement: p, local: l, amazon: a })
    const r = req.get(p)
    const next = r !== undefined ? (opts.resend || opts.partial || r !== l ? r : a) : (l > 0 && !opts.partial ? 0 : a)
    if (next > 0 || amz.has(p)) adjustments.push({ placement: p, percentage: next })
  }
  return { adjustments, drift }
}

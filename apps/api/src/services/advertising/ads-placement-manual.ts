/**
 * PLC.3 — the manual placement write's merge, and the max-base-bid the preview measures against.
 *
 * Pure and unit-tested, with no DB in the first function, for one reason:
 *
 * ── 🔴 `updatePlacementBidding` REPLACES the whole array ──────────────────────────────────────
 *
 * `ads-create.service.ts:972`:
 *
 *     const db = { ...(c.dynamicBidding ?? {}), placementBidding: adjustments }
 *
 * `adjustments` is written wholesale. A request carrying only `[{ PLACEMENT_TOP, 150 }]` leaves
 * Rest and Product **absent**, and absent is identical to 0 as far as Amazon is concerned. So the
 * naive one-lane edit — the obvious thing to write, and the thing a bulk action does 144 times —
 * is a silent mass-erase of the two lanes nobody touched.
 *
 * `CampaignsGrid.tsx:1620` already carries the comment "merging the chosen placement with the
 * campaign's current ones". That comment exists because someone found this the hard way, in a
 * different surface, and the fix lived only in that surface's inline code.
 *
 * So the merge lives here instead: one exported function, unit-tested, that every manual caller
 * goes through. `buildBlendedAdjustments` (`ads-placement-math.ts:30`) solves the same problem for
 * the engine and is deliberately mirrored — same shape, same guarantee, different caller.
 */

import prisma from '../../db.js'
import {
  PLACEMENT_TOP, PLACEMENT_REST, PLACEMENT_PRODUCT, MANAGED_PLACEMENTS, clampPct,
} from './ads-placement-math.js'

export type ManagedPlacement = typeof PLACEMENT_TOP | typeof PLACEMENT_REST | typeof PLACEMENT_PRODUCT

export interface PlacementAdjustment { placement: string; percentage: number }

/**
 * The three lanes a campaign currently carries, as a map. Absent ⇒ 0, because that is what Amazon
 * means by absent — the same rule `laneMultipliers` applies on the read side.
 */
export function currentLanes(existing: PlacementAdjustment[] | null | undefined): Record<ManagedPlacement, number> {
  const out = {
    [PLACEMENT_TOP]: 0,
    [PLACEMENT_REST]: 0,
    [PLACEMENT_PRODUCT]: 0,
  } as Record<ManagedPlacement, number>
  for (const a of existing ?? []) {
    if (a && typeof a.placement === 'string' && a.placement in out) {
      out[a.placement as ManagedPlacement] = clampPct(Number(a.percentage) || 0)
    }
  }
  return out
}

/**
 * Build the FULL placement profile for a manual one-lane change.
 *
 * ALWAYS returns all three managed lanes, so the wholesale write above cannot erase anything the
 * operator did not touch. Non-managed placements Amazon may add later (Amazon Business, which this
 * account is not entitled to) are preserved untouched — the same rule `buildBlendedAdjustments`
 * follows, and for the same reason: this function owns the three lanes it knows about and must not
 * silently drop a fourth it does not.
 *
 * `pct` is clamped to Amazon's 0–900 and rounded to an integer here as well as in the service, so
 * a caller that skips the service still cannot send a fraction or an out-of-range value.
 */
export function buildManualAdjustments(
  existing: PlacementAdjustment[] | null | undefined,
  lane: ManagedPlacement,
  pct: number,
): PlacementAdjustment[] {
  const cur = currentLanes(existing)
  const next = { ...cur, [lane]: clampPct(pct) }
  /**
   * 🔴 A lane that is absent AND staying at 0 is not emitted.
   *
   * Caught by the first real write on production. Setting Product on a campaign with a bare
   * profile produced THREE `CampaignBidHistory` rows — `product absent→5` plus `top absent→0` and
   * `rest absent→0` — because the merge materialised the two untouched lanes as explicit zeroes and
   * `updatePlacementBidding`'s change-detection reads `undefined !== 0` as a change. Two rows
   * saying "changed from nothing to nothing", on every first edit.
   *
   * The study already measured that 30% of the ENGINE's history rows are writes of 0 over an
   * absent lane (§4.5). A manual bulk adding two more per campaign would have made this page a
   * contributor to the noise it exists to expose.
   *
   * The anti-erase guarantee is untouched, because it only ever needed the lanes that carry a
   * value: absent and 0 are the same instruction to Amazon, so a lane at 0 need not be sent — but a
   * lane at 45 must be, or the wholesale write drops it. That is exactly the rule
   * `buildBlendedAdjustments` follows ("skip if already 0"), so the two writers now agree.
   */
  const out: PlacementAdjustment[] = MANAGED_PLACEMENTS
    .filter((p) => p === lane || next[p as ManagedPlacement] > 0)
    .map((p) => ({ placement: p, percentage: next[p as ManagedPlacement] }))
  for (const e of existing ?? []) {
    if (e?.placement && !(MANAGED_PLACEMENTS as readonly string[]).includes(e.placement)) {
      out.push({ placement: e.placement, percentage: e.percentage })
    }
  }
  return out
}

/**
 * True when the proposed profile changes nothing. Used by the preview to say "already at 60%"
 * rather than counting a no-op as a write — 30% of the engine's own history rows are writes of 0
 * over an already-absent lane (study §4.5), and a manual bulk must not add to that.
 */
export function isNoOp(existing: PlacementAdjustment[] | null | undefined, lane: ManagedPlacement, pct: number): boolean {
  return currentLanes(existing)[lane] === clampPct(pct)
}

/**
 * ⚠ A LIFT, not a second derivation — `ad-rank-defend.job.ts:537-556`, verbatim in behaviour.
 *
 * The CPC ceiling and this page's effective-bid preview must measure against the same number or
 * they will disagree about whether a multiplier is affordable. The engine's copy is currently
 * inline in the job, and `ad-rank-defend.job.ts` is **claimed by RD.P2** while this ships, so the
 * job is not edited here: swapping its inline block for a call to this function is a one-line
 * change for whoever next holds that file with a clean claim, and it is posted as a hand-off in
 * locks §4. `_plc-page-write.mts` verifies the two agree today.
 *
 * Why the max and not the average: a ceiling derived from the average would still let the most
 * expensive keyword sail past it, which is the one thing "never bid above this" cannot mean.
 *
 * Why `suppressedFromBidCents` counts: it is what the bid RETURNS to the moment a serving target
 * takes over, so reading only the floored 2¢ of a suppressed campaign would report a base bid of
 * 2¢ for the very tick that restores it.
 */
export async function resolveMaxBaseBidByCampaign(campaignIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (campaignIds.length === 0) return out
  // Grouped rather than row-by-row — one campaign in this account holds 141 targets.
  // Unguarded on purpose: a swallowed failure here would report every base bid as absent, and
  // "no base bid" renders as "no effective bid change", which is a measured zero that is not one.
  const [agRows, agIndex] = await Promise.all([
    prisma.adGroup.groupBy({ by: ['campaignId'], where: { campaignId: { in: campaignIds } }, _max: { defaultBidCents: true, suppressedFromBidCents: true } }),
    prisma.adGroup.findMany({ where: { campaignId: { in: campaignIds } }, select: { id: true, campaignId: true } }),
  ])
  for (const r of agRows) {
    const v = Math.max(r._max.defaultBidCents ?? 0, r._max.suppressedFromBidCents ?? 0)
    if (v > 0) out.set(r.campaignId, v)
  }
  const campByAdGroup = new Map(agIndex.map((g) => [g.id, g.campaignId]))
  const tgRows = await prisma.adTarget.groupBy({
    by: ['adGroupId'],
    where: { adGroup: { campaignId: { in: campaignIds } }, isNegative: false },
    _max: { bidCents: true, suppressedFromBidCents: true },
  })
  for (const r of tgRows) {
    const cid = campByAdGroup.get(r.adGroupId); if (!cid) continue
    const v = Math.max(r._max.bidCents ?? 0, r._max.suppressedFromBidCents ?? 0)
    if (v > (out.get(cid) ?? 0)) out.set(cid, v)
  }
  return out
}

/**
 * NAF.C — fold a director's plan items into the blast-radius guard's
 * aggregate counters (plan V4). Pure. The guard's BlastInput speaks
 * bulksheet vocabulary; the mapping here is documented per field:
 *
 * - changedRows   = plan items (each item is one intended change)
 * - totalRows     = the candidate pool the director saw (open findings) —
 *                   NOT items.length, or changedPct would always be 100
 * - bidChanges    = set-target-bid items
 * - largeBidChanges = bid items whose expectedEffect.magnitudePct > 30
 *                   (the delta itself needs the current bid, which the
 *                   fold deliberately does not fetch — pure function)
 * - archives/pauses/budgetDeltaEur = 0 (no fleet tool can do these yet)
 * - campaignsTouched = distinct campaign refs across item args
 * - conflicts     = the plan's own conflicts list length
 */
import type { PlanItemT } from '@nexus/shared/agent-fleet'
import {
  evaluateBlastRadius,
  UNATTENDED_THRESHOLDS,
  type BlastInput,
  type BlastVerdict,
} from '../ads-core/blast-radius-guard.js'

const LARGE_BID_MAGNITUDE_PCT = 30

export function foldPlanBlast(
  items: PlanItemT[],
  opts: { totalCandidates?: number; conflictsCount?: number } = {},
): { input: BlastInput; verdict: BlastVerdict } {
  const bidItems = items.filter((i) => i.tool === 'set-target-bid')
  const campaigns = new Set<string>()
  for (const i of items) {
    const a = i.args as Record<string, unknown>
    const ref =
      a.externalCampaignId ??
      a.destExternalCampaignId ??
      a.sourceExternalCampaignId ??
      a.campaignId ??
      null
    if (ref) campaigns.add(String(ref))
  }
  const input: BlastInput = {
    changedRows: items.length,
    totalRows: Math.max(items.length, opts.totalCandidates ?? items.length * 4),
    archives: 0,
    pauses: 0,
    bidChanges: bidItems.length,
    largeBidChanges: bidItems.filter(
      (i) => i.expectedEffect.magnitudePct > LARGE_BID_MAGNITUDE_PCT,
    ).length,
    budgetDeltaEur: 0,
    campaignsTouched: campaigns.size,
    conflicts: opts.conflictsCount ?? 0,
  }
  return { input, verdict: evaluateBlastRadius(input, UNATTENDED_THRESHOLDS) }
}

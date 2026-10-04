/**
 * 4a (review 4.2, 4.14) — which campaigns each ads rule is BOUND to, answered in one place.
 *
 * Three readers must give the same answer, or the screen and the engine disagree:
 *   · the tick (`applyMarketplaceScope` in `advertising-rule-evaluator.job.ts`) — what runs;
 *   · Simulate (`simulateOneRule`) — what the operator is told would run;
 *   · the reach number (`reachForRules`) — how many campaigns the row says the rule can touch.
 * Each used to carry its own copy of this block, and Simulate had none at all, so a simulated
 * budget rule reached campaigns it was never assigned to.
 *
 * The answer is `RuleScope.assignedCampaignIds`, with its three states:
 *   · absent from the map — not bound (the reader passes `null`): the rule's scope columns decide;
 *   · `[]`  — bound to nothing, so it matches NO campaign;
 *   · `[ids]` — matches only those campaigns.
 *
 * Two sources:
 *   · D1 — an ENGINE-NATIVE budget rule (`adjust_ad_budget`) is governed by `CampaignRuleAssignment`.
 *     Every such rule is seeded with `[]` first: absent from the table must read "assigned to
 *     nothing", never "not governed", or an unassigned budget rule turns account-wide again.
 *   · BUD-P2 · 4a — a BUILDER rule is governed by its own picker list (`builderScopeCampaignIds`):
 *     Budget as before, and now Bid, SOV, Keyword Tracker and Placement too. Reading the rule rather
 *     than the table means a mirror that lost a race can leave the Apply Rules COLUMN stale, but can
 *     never make a live rule silently match nothing.
 *
 * The handlers keep their own picker checks (`campaignAllowed`, `bid_apply`): this decides what is
 * EVALUATED, they still decide what may be WRITTEN.
 */
import prisma from '../../db.js'
import { isEngineBudgetRule, builderScopeCampaignIds } from './ads-rule-adapter.service.js'

export async function resolveAssignedCampaignIds(
  rules: ReadonlyArray<{ id: string; actions?: unknown }>,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  const engineBudgetIds = rules.filter((r) => isEngineBudgetRule(r.actions)).map((r) => r.id)
  if (engineBudgetIds.length > 0) {
    for (const id of engineBudgetIds) out.set(id, [])
    const links = await prisma.campaignRuleAssignment.findMany({
      where: { ruleId: { in: engineBudgetIds }, kind: 'budget' },
      select: { ruleId: true, campaignId: true },
    })
    for (const l of links) out.get(l.ruleId)?.push(l.campaignId)
  }
  for (const r of rules) {
    const own = builderScopeCampaignIds(r.actions)
    if (own != null) out.set(r.id, own)
  }
  return out
}

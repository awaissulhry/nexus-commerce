/**
 * NAF.C — the critic's evidence: the newest draft plan plus the
 * DETERMINISTIC pre-check results (forced blocks, advisories, per-item
 * previews, blast verdict). The critic model may add blocks on the soft
 * checks; the hard ones are already decided by code and enforced again at
 * queue time regardless of the model's verdict.
 *
 * TTL 1 minute: each council run critiques the plan it just produced.
 * payload.planId is load-bearing — the executor's critic branch reads it.
 */
import prisma from '../../../db.js'
import type { ObservationBuilder } from '../observation-builder.js'
import { runPreChecks } from '../plan-critic.service.js'
import type { PlanItemT } from '@nexus/shared/agent-fleet'

export const pendingPlanBuilder: ObservationBuilder = {
  key: 'pending-plan',
  ttlMinutes: 1,
  async build() {
    const plan = await prisma.agentPlan.findFirst({
      where: { status: 'draft' },
      orderBy: { createdAt: 'desc' },
    })
    if (!plan) {
      return {
        payload: { planId: null, note: 'no draft plan exists — nothing to critique' },
        dataVintage: new Date(),
      }
    }
    const items = plan.items as unknown as PlanItemT[]
    const conflicts = (plan.conflicts as unknown[]) ?? []
    const prechecks = await runPreChecks({ items, conflicts })
    return {
      payload: {
        planId: plan.id,
        headline: plan.headline,
        narrative: plan.narrative,
        items,
        dropped: plan.droppedItems,
        conflicts,
        changeBudget: plan.changeBudget,
        prechecks: {
          forcedBlocks: prechecks.forcedBlocks,
          advisories: prechecks.advisories,
          blast: prechecks.blast,
          itemPreviews: prechecks.itemPreviews,
        },
        caveats: [
          'prechecks.forcedBlocks are DECIDED BY CODE — they will block regardless of your verdict; reflect them in your checks honestly.',
          'You may add blocks (blockedItems) on judgment grounds; you cannot remove a forced block.',
        ],
      },
      dataVintage: plan.createdAt,
    }
  },
}

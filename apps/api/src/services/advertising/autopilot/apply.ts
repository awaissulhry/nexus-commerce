/**
 * AC P-F — AUTO apply path. When a plan's autonomy is AUTO, translate the Conductor's proposed
 * actions into LIVE mutations, write-gated + audited + reversible. We delegate per-target bids to
 * the existing target-ACoS optimizer (within the plan's bid band) and apply budgets directly via
 * the shipped sync path. Placement live-apply is deferred (recorded SKIPPED). Harvest/Negate go
 * live through the Rule-Setting engine (coordination flips their rule dryRun off when AUTO).
 * Everything is sandbox-safe — the mutation layer short-circuits writes outside live mode.
 */
import { logger } from '../../../utils/logger.js'
import { checkAdsWriteGate } from '../ads-write-gate.js'
import { previewBidOptimization, applyBidOptimization } from '../ads-bid-optimizer.service.js'
import { updateCampaignWithSync } from '../ads-mutation.service.js'
import { effectiveTargetAcosPct, clamp, type Goal, type Guardrails, type CampaignSignals } from './presets.js'
import type { ProposedAction } from './modules.js'

export interface AppliedDecision {
  module: string; campaignId: string; action: string
  before?: unknown; after?: unknown; reason: string
  status: 'APPLIED' | 'DENIED' | 'SKIPPED'; executionId?: string | null
}

export async function applyPlanActions(opts: {
  planId: string; goal: Goal; marketplace: string; guardrails: Guardrails
  actions: ProposedAction[]; signals: CampaignSignals[]
}): Promise<{ applied: number; denied: number; decisions: AppliedDecision[] }> {
  const { planId, goal, marketplace, guardrails: g, actions, signals } = opts
  const sigById = new Map(signals.map((s) => [s.campaignId, s]))
  const byCampaign = new Map<string, ProposedAction[]>()
  for (const a of actions) { if (!byCampaign.has(a.campaignId)) byCampaign.set(a.campaignId, []); byCampaign.get(a.campaignId)!.push(a) }
  const decisions: AppliedDecision[] = []
  let applied = 0, denied = 0
  const actor = `automation:autopilot-${planId}`

  for (const [campaignId, acts] of byCampaign) {
    const payloadValueCents = Math.max(0, ...acts.map((a) => Number(a.afterCents ?? 0)))
    const gate = await checkAdsWriteGate({ marketplace, campaignId, payloadValueCents })
    if (!gate.allowed) {
      const why = 'reason' in gate ? gate.reason : 'write gate denied'
      denied += acts.length
      for (const a of acts) decisions.push({ module: a.module, campaignId, action: a.action, reason: `${a.reason} — blocked: ${why}`, status: 'DENIED' })
      continue
    }

    // BID — delegate to the per-target optimizer at the plan's effective target ACoS, clamped to the bid band.
    if (acts.some((a) => a.module === 'bid')) {
      try {
        const s = sigById.get(campaignId)
        const targetAcos = effectiveTargetAcosPct(goal, g, { marginPct: s?.marginPct ?? null }) / 100
        const preview = await previewBidOptimization({ campaignId, targetAcos, bayesian: true, profitMode: goal === 'PROFIT' })
        const changes = preview.proposals
          .map((p) => ({ targetId: p.targetId, current: p.currentBidCents, proposedBidCents: clamp(p.proposedBidCents, g.bidMinCents, g.bidMaxCents) }))
          .filter((c) => c.proposedBidCents !== c.current)
          .map((c) => ({ targetId: c.targetId, proposedBidCents: c.proposedBidCents }))
        if (changes.length) {
          await applyBidOptimization({ changes, actor, dryRun: false })
          applied += 1
          decisions.push({ module: 'bid', campaignId, action: 'BID_APPLY', after: { targets: changes.length, targetAcosPct: Math.round(targetAcos * 100) }, reason: `Optimised ${changes.length} keyword bids → ${Math.round(targetAcos * 100)}% target ACoS`, status: 'APPLIED' })
        }
      } catch (e) { logger.warn('[autopilot] bid apply failed', { planId, campaignId, error: (e as Error).message }) }
    }

    // BUDGET — apply the Conductor's proposed daily budget (€) directly via the shipped sync path.
    const bud = acts.find((a) => a.module === 'budget' && a.afterCents != null)
    if (bud) {
      try {
        await updateCampaignWithSync({ campaignId, patch: { dailyBudget: (bud.afterCents as number) / 100 }, actor, reason: bud.reason, applyImmediately: true } as never)
        applied += 1
        decisions.push({ module: 'budget', campaignId, action: bud.action, before: { cents: bud.beforeCents }, after: { cents: bud.afterCents }, reason: bud.reason, status: 'APPLIED' })
      } catch (e) { logger.warn('[autopilot] budget apply failed', { planId, campaignId, error: (e as Error).message }) }
    }

    // PLACEMENT — live-apply deferred to P-F.2; surface as SKIPPED so the feed still shows the intent.
    for (const a of acts.filter((x) => x.module === 'placement')) {
      decisions.push({ module: 'placement', campaignId, action: a.action, before: a.before, after: a.after, reason: `${a.reason} (live-apply pending)`, status: 'SKIPPED' })
    }
  }

  logger.info('[autopilot] AUTO applied', { planId, applied, denied })
  return { applied, denied, decisions }
}

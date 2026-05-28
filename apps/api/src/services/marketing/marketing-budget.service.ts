/**
 * UM-series (P7) — cross-channel budget command center.
 *
 * Generalizes advertising/budget-pool-rebalancer across channels onto the
 * P1 CampaignBudget / CampaignBudgetAllocation / CampaignBudgetRebalance
 * models. A pool can span Amazon SP + eBay Promoted + Shopify + external;
 * weights derive from FX-normalized CampaignMetric (costEurCents / sales),
 * so a single EUR currency is compared across channels.
 *
 * Strategies:
 *   STATIC          enforce each allocation's targetSharePct
 *   PROFIT_WEIGHTED weight by recent (salesEur − costEur) per campaign
 *   ROAS_WEIGHTED   weight by recent salesEur / costEur
 *   URGENCY_WEIGHTED (Amazon aged-stock) → falls back to STATIC here
 *
 * Guardrails (carried verbatim from the proven pool model):
 *   - per-allocation min/max floor/ceiling (€1/day default floor)
 *   - maxShiftPerRebalancePct (sum|new−old| ≤ pct × total) — scales shifts
 *   - coolDownMinutes since lastRebalancedAt
 *   - dryRun: compute + audit, never enqueue mutations
 * Apply routes each change through the P5 mutation path (gate + grace +
 * audit), so Amazon stays sandbox until P8.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { enqueueCampaignMutation } from './marketing-mutation.service.js'

const WEIGHT_WINDOW_DAYS = Number(process.env.NEXUS_MKT_BUDGET_WINDOW_DAYS ?? 30)

export interface AllocationProposal {
  allocationId: string
  campaignId: string
  campaignName: string
  channel: string
  marketplace: string | null
  currentCents: number
  proposedCents: number
  shiftCents: number
  weight: number
  minCents: number
  maxCents: number | null
}

export interface RebalanceOutcome {
  budgetId: string
  strategy: string
  totalDailyCents: number
  proposals: AllocationProposal[]
  totalShiftCents: number
  capped: boolean
  cooldownActive: boolean
  cooldownEndsAt: string | null
  note: string | null
}

/** Recent FX-normalized cost + sales per campaign (EUR cents). */
async function recentMetrics(campaignIds: string[]): Promise<Map<string, { costEur: number; salesEur: number }>> {
  const since = new Date(Date.now() - WEIGHT_WINDOW_DAYS * 86400_000)
  const rows = await prisma.campaignMetric.groupBy({
    by: ['campaignId'],
    where: { campaignId: { in: campaignIds }, entityType: 'CAMPAIGN', date: { gte: since } },
    _sum: { costEurCents: true, sales7dCents: true },
  })
  const map = new Map<string, { costEur: number; salesEur: number }>()
  for (const r of rows) {
    if (r.campaignId) map.set(r.campaignId, { costEur: Number(r._sum.costEurCents ?? 0n), salesEur: r._sum.sales7dCents ?? 0 })
  }
  return map
}

export async function computeRebalance(budgetId: string): Promise<RebalanceOutcome> {
  const budget = await prisma.campaignBudget.findUnique({
    where: { id: budgetId },
    include: { allocations: { include: { campaign: { select: { id: true, name: true, channel: true, budgetCents: true } } } } },
  })
  if (!budget) throw new Error(`budget ${budgetId} not found`)

  const cooldownActive =
    !!budget.lastRebalancedAt &&
    Date.now() - budget.lastRebalancedAt.getTime() < budget.coolDownMinutes * 60_000
  const cooldownEndsAt = budget.lastRebalancedAt
    ? new Date(budget.lastRebalancedAt.getTime() + budget.coolDownMinutes * 60_000).toISOString()
    : null

  const allocs = budget.allocations
  const metrics = await recentMetrics(allocs.map((a) => a.campaignId))

  // ── Weight per allocation by strategy ───────────────────────────────
  let note: string | null = null
  const rawWeights = allocs.map((a) => {
    const m = metrics.get(a.campaignId) ?? { costEur: 0, salesEur: 0 }
    switch (budget.strategy) {
      case 'PROFIT_WEIGHTED':
        return Math.max(0, m.salesEur - m.costEur)
      case 'ROAS_WEIGHTED':
        return m.costEur > 0 ? m.salesEur / m.costEur : 0
      case 'STATIC':
        return Number(a.targetSharePct)
      default:
        note = `strategy ${budget.strategy} not supported cross-channel — using STATIC shares`
        return Number(a.targetSharePct)
    }
  })
  let weightSum = rawWeights.reduce((s, w) => s + w, 0)
  // Degenerate (all-zero) weights → equal split.
  if (weightSum <= 0) {
    rawWeights.fill(1)
    weightSum = rawWeights.length
    note = note ?? 'no signal in window — even split'
  }

  // ── Proportional allocation, clamped to per-allocation min/max ───────
  const proposals: AllocationProposal[] = allocs.map((a, i) => {
    const share = rawWeights[i]! / weightSum
    const target = Math.round(budget.totalDailyCents * share)
    const min = a.minDailyBudgetCents
    const max = a.maxDailyBudgetCents
    let proposed = Math.max(min, target)
    if (max != null) proposed = Math.min(max, proposed)
    const current = a.campaign.budgetCents ?? 0
    return {
      allocationId: a.id,
      campaignId: a.campaignId,
      campaignName: a.campaign.name,
      channel: a.campaign.channel,
      marketplace: a.marketplace,
      currentCents: current,
      proposedCents: proposed,
      shiftCents: proposed - current,
      weight: rawWeights[i]!,
      minCents: min,
      maxCents: max,
    }
  })

  // ── maxShiftPerRebalancePct guardrail ────────────────────────────────
  let totalShiftCents = proposals.reduce((s, p) => s + Math.abs(p.shiftCents), 0)
  let capped = false
  const maxShiftCents = Math.round((budget.totalDailyCents * budget.maxShiftPerRebalancePct) / 100)
  if (maxShiftCents > 0 && totalShiftCents > maxShiftCents) {
    const scale = maxShiftCents / totalShiftCents
    for (const p of proposals) {
      p.proposedCents = Math.round(p.currentCents + p.shiftCents * scale)
      p.shiftCents = p.proposedCents - p.currentCents
    }
    totalShiftCents = proposals.reduce((s, p) => s + Math.abs(p.shiftCents), 0)
    capped = true
    note = (note ? note + '; ' : '') + `maxShift ${budget.maxShiftPerRebalancePct}% engaged (scaled ${scale.toFixed(3)})`
  }

  return {
    budgetId,
    strategy: budget.strategy,
    totalDailyCents: budget.totalDailyCents,
    proposals,
    totalShiftCents,
    capped,
    cooldownActive,
    cooldownEndsAt,
    note,
  }
}

/**
 * Apply a rebalance: writes the CampaignBudgetRebalance audit, and (unless
 * pool.dryRun or cooldown active) enqueues a MKT_BUDGET_UPDATE per changed
 * allocation through the P5 mutation path. Honors triggeredBy provenance.
 */
export async function applyRebalance(args: { budgetId: string; triggeredBy: string; force?: boolean }): Promise<{ applied: boolean; outcome: RebalanceOutcome; rebalanceId: string; reason?: string }> {
  const budget = await prisma.campaignBudget.findUnique({ where: { id: args.budgetId } })
  if (!budget) throw new Error(`budget ${args.budgetId} not found`)
  const outcome = await computeRebalance(args.budgetId)

  const blocked = outcome.cooldownActive && !args.force
  const willApply = !budget.dryRun && !blocked

  const rebalance = await prisma.campaignBudgetRebalance.create({
    data: {
      budgetId: args.budgetId,
      triggeredBy: args.triggeredBy,
      inputs: { strategy: outcome.strategy, totalDailyCents: outcome.totalDailyCents, note: outcome.note },
      outputs: outcome.proposals as never,
      dryRun: budget.dryRun || blocked,
      appliedAt: willApply ? new Date() : null,
      totalShiftCents: outcome.totalShiftCents,
    },
  })

  if (willApply) {
    for (const p of outcome.proposals) {
      if (p.shiftCents === 0) continue
      await enqueueCampaignMutation({
        campaignId: p.campaignId,
        syncType: 'MKT_BUDGET_UPDATE',
        payload: { budgetCents: p.proposedCents },
        userId: args.triggeredBy,
      })
    }
    await prisma.campaignBudget.update({ where: { id: args.budgetId }, data: { lastRebalancedAt: new Date() } })
  }

  logger.info(`[UM][budget] rebalance ${args.budgetId} applied=${willApply}`, { totalShiftCents: outcome.totalShiftCents, dryRun: budget.dryRun, blocked })
  return {
    applied: willApply,
    outcome,
    rebalanceId: rebalance.id,
    reason: blocked ? 'cooldown active' : budget.dryRun ? 'pool dryRun' : undefined,
  }
}

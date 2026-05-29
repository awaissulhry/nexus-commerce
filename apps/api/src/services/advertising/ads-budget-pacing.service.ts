/**
 * AX.10 — Budget pacing. Surfaces campaigns that are capping out (out of
 * budget) while profitable — the clearest "leaving money on the table"
 * signal — and proposes a budget raise; conversely flags poor-ROAS
 * spenders for a cut. preview() proposes; apply() writes via the shipped
 * grace+audit path. Also a `pace_budget` automation handler.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { updateCampaignWithSync } from './ads-mutation.service.js'
import { ACTION_HANDLERS, type ActionResult } from '../automation-rule.service.js'

const RAISE_PCT = 0.25
const CUT_PCT = 0.2
const MAX_BUDGET_CENTS = 50000 // €500/day cap

export interface PacingProposal {
  campaignId: string; name: string; marketplace: string | null
  currentBudgetCents: number; proposedBudgetCents: number
  spendCents: number; salesCents: number; roas: number | null; outOfBudget: boolean; reason: string
}

export async function previewPacing(opts: { targetRoas?: number } = {}): Promise<{ targetRoas: number; proposals: PacingProposal[] }> {
  const targetRoas = opts.targetRoas ?? 3 // raise winners pulling ≥3× ROAS
  const camps = await prisma.campaign.findMany({
    where: { status: 'ENABLED' },
    select: { id: true, name: true, marketplace: true, dailyBudget: true, spend: true, sales: true, roas: true, deliveryReasons: true },
    take: 1000,
  })
  const proposals: PacingProposal[] = []
  for (const c of camps) {
    const budgetCents = Math.round(parseFloat(c.dailyBudget?.toString() ?? '0') * 100)
    if (budgetCents <= 0) continue
    const spendCents = Math.round(parseFloat(c.spend?.toString() ?? '0') * 100)
    const salesCents = Math.round(parseFloat(c.sales?.toString() ?? '0') * 100)
    const roas = c.roas != null ? parseFloat(c.roas.toString()) : spendCents > 0 ? salesCents / spendCents : null
    const outOfBudget = (c.deliveryReasons ?? []).includes('OUT_OF_BUDGET')
    if (outOfBudget && roas != null && roas >= targetRoas) {
      const proposed = Math.min(MAX_BUDGET_CENTS, Math.round(budgetCents * (1 + RAISE_PCT)))
      if (proposed > budgetCents) proposals.push({ campaignId: c.id, name: c.name, marketplace: c.marketplace, currentBudgetCents: budgetCents, proposedBudgetCents: proposed, spendCents, salesCents, roas, outOfBudget, reason: `Out of budget at ${roas.toFixed(1)}× ROAS — raise ${Math.round(RAISE_PCT * 100)}% to capture demand` })
    } else if (roas != null && roas > 0 && roas < 1 && spendCents > 5000) {
      const proposed = Math.max(100, Math.round(budgetCents * (1 - CUT_PCT)))
      proposals.push({ campaignId: c.id, name: c.name, marketplace: c.marketplace, currentBudgetCents: budgetCents, proposedBudgetCents: proposed, spendCents, salesCents, roas, outOfBudget, reason: `ROAS ${roas.toFixed(1)}× below break-even — cut ${Math.round(CUT_PCT * 100)}%` })
    }
  }
  proposals.sort((a, b) => (b.outOfBudget ? 1 : 0) - (a.outOfBudget ? 1 : 0))
  return { targetRoas, proposals }
}

export async function applyPacing(args: { changes: Array<{ campaignId: string; proposedBudgetCents: number }>; actor?: string }): Promise<{ applied: number }> {
  let applied = 0
  for (const c of args.changes) {
    try { await updateCampaignWithSync({ campaignId: c.campaignId, patch: { dailyBudget: c.proposedBudgetCents / 100 }, actor: args.actor ?? 'budget-pacing', reason: 'AX.10 budget pacing' } as never); applied++ }
    catch (e) { logger.warn('[AX.10] pacing apply failed', { campaignId: c.campaignId, error: (e as Error).message }) }
  }
  return { applied }
}

ACTION_HANDLERS.pace_budget = async (action, _context, meta): Promise<ActionResult> => {
  const targetRoas = typeof action.targetRoas === 'number' ? (action.targetRoas as number) : 3
  const { proposals } = await previewPacing({ targetRoas })
  // Rule pacing only raises out-of-budget winners (never auto-cuts).
  const raises = proposals.filter((p) => p.outOfBudget && p.proposedBudgetCents > p.currentBudgetCents)
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, wouldRaise: raises.length, sample: raises.slice(0, 5) } }
  const r = await applyPacing({ changes: raises.map((p) => ({ campaignId: p.campaignId, proposedBudgetCents: p.proposedBudgetCents })), actor: `automation:${meta.ruleId}` })
  return { type: action.type, ok: true, estimatedValueCentsEur: raises.reduce((a, p) => a + (p.proposedBudgetCents - p.currentBudgetCents), 0), output: { raised: r.applied } }
}

logger.debug('[AX.10] pace_budget handler registered')

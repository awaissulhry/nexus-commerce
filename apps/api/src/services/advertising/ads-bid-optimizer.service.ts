/**
 * AX.8 — Target-ACOS bid optimization.
 *
 * For each enabled keyword/target with spend, move the bid toward a target
 * ACOS: if ACOS is above target → cut the bid proportionally; if below
 * target with conversions → raise it (capped). Zero-sale spenders get a
 * hard cut. Guardrailed: €0.05 floor, max ±change %, only acts on targets
 * with enough signal. preview() returns proposed changes; apply() writes
 * via the shipped bulkUpdateAdTargetBids (grace window + audit + sync).
 *
 * Also exposes a `bid_to_target_acos` automation handler so a rule can run
 * it on a schedule (registered into ACTION_HANDLERS by side-effect import).
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { bulkUpdateAdTargetBids } from './ads-mutation.service.js'
import { ACTION_HANDLERS, type ActionResult } from '../automation-rule.service.js'

const FLOOR_CENTS = 5
const MAX_DOWN = 0.5 // never cut a bid by more than 50% in one pass
const MAX_UP = 0.25 // never raise by more than 25% in one pass
const MIN_CLICKS = 5 // need signal before acting

export interface BidProposal {
  targetId: string; expression: string; matchType: string
  currentBidCents: number; proposedBidCents: number; deltaCents: number
  acos: number | null; spendCents: number; salesCents: number; clicks: number; reason: string
}

export async function previewBidOptimization(opts: { targetAcos?: number; campaignId?: string } = {}): Promise<{ targetAcos: number; proposals: BidProposal[] }> {
  const targetAcos = opts.targetAcos ?? 0.3 // 30% default
  const where: Record<string, unknown> = { status: 'ENABLED', isNegative: false, spendCents: { gt: 0 } }
  if (opts.campaignId) where.adGroup = { campaignId: opts.campaignId }
  const targets = await prisma.adTarget.findMany({ where, take: 2000, select: { id: true, expressionValue: true, expressionType: true, bidCents: true, spendCents: true, salesCents: true, clicks: true, ordersCount: true } })

  const proposals: BidProposal[] = []
  for (const t of targets) {
    if (t.clicks < MIN_CLICKS) continue
    const acos = t.salesCents > 0 ? t.spendCents / t.salesCents : null
    let proposed = t.bidCents
    let reason = ''
    if (t.salesCents === 0) {
      // Spending with no sales → cut hard toward the floor.
      proposed = Math.max(FLOOR_CENTS, Math.round(t.bidCents * (1 - MAX_DOWN)))
      reason = `${t.clicks} clicks, 0 sales — cut ${Math.round(MAX_DOWN * 100)}%`
    } else if (acos != null && acos > targetAcos) {
      const ratio = Math.max(1 - MAX_DOWN, targetAcos / acos)
      proposed = Math.max(FLOOR_CENTS, Math.round(t.bidCents * ratio))
      reason = `ACOS ${(acos * 100).toFixed(0)}% > target ${(targetAcos * 100).toFixed(0)}% — lower`
    } else if (acos != null && acos < targetAcos && t.ordersCount >= 1) {
      const ratio = Math.min(1 + MAX_UP, targetAcos / acos)
      proposed = Math.round(t.bidCents * ratio)
      reason = `ACOS ${(acos * 100).toFixed(0)}% < target — raise to capture volume`
    } else continue
    if (proposed === t.bidCents) continue
    proposals.push({ targetId: t.id, expression: t.expressionValue, matchType: t.expressionType, currentBidCents: t.bidCents, proposedBidCents: proposed, deltaCents: proposed - t.bidCents, acos, spendCents: t.spendCents, salesCents: t.salesCents, clicks: t.clicks, reason })
  }
  proposals.sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents))
  return { targetAcos, proposals }
}

export async function applyBidOptimization(args: { changes: Array<{ targetId: string; proposedBidCents: number }>; actor?: string; dryRun?: boolean }): Promise<{ applied: number; dryRun: boolean }> {
  if (args.dryRun) return { applied: 0, dryRun: true }
  const updates = args.changes.map((c) => ({ id: c.targetId, newBidCents: c.proposedBidCents }))
  if (updates.length === 0) return { applied: 0, dryRun: false }
  await bulkUpdateAdTargetBids({ updates, actor: args.actor ?? 'bid-optimizer', reason: 'AX.8 target-ACOS optimization' } as never)
  logger.info('[AX.8] bid optimization applied', { count: updates.length })
  return { applied: updates.length, dryRun: false }
}

// ── Automation handler: bid_to_target_acos ────────────────────────────────
ACTION_HANDLERS.bid_to_target_acos = async (action, _context, meta): Promise<ActionResult> => {
  const targetAcos = typeof action.targetAcos === 'number' ? (action.targetAcos as number) : 0.3
  const campaignId = typeof action.campaignId === 'string' ? (action.campaignId as string) : undefined
  const { proposals } = await previewBidOptimization({ targetAcos, campaignId })
  if (meta.dryRun) return { type: action.type, ok: true, output: { dryRun: true, wouldChange: proposals.length, sample: proposals.slice(0, 5) } }
  const r = await applyBidOptimization({ changes: proposals.map((p) => ({ targetId: p.targetId, proposedBidCents: p.proposedBidCents })), actor: `automation:${meta.ruleId}` })
  return { type: action.type, ok: true, output: { applied: r.applied } }
}

logger.debug('[AX.8] bid_to_target_acos handler registered')

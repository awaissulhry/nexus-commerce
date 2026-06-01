/**
 * TD.1 — automatic algorithmic bidding. Runs the profit-native target-ACOS
 * optimizer (ads-bid-optimizer, profit + Bayesian sparse-data) on a schedule
 * and applies the proposals — turning a manual "preview then apply" tool into a
 * 24/7 bid manager.
 *
 * Safety is layered, not bypassed: respects the autonomy dial (OFF/halt → skip,
 * SUGGEST → propose-only, AUTO → apply); applyBidOptimization routes every change
 * through the SAME gated write path (OutboundSyncQueue → write-gate), so the
 * per-campaign liveBidWritesEnabled allowlist (default-deny), per-campaign daily
 * write cap, and €-value cap all still apply. So in AUTO it only ever writes to
 * campaigns an operator has explicitly allowlisted.
 */
import { logger } from '../../utils/logger.js'
import { previewBidOptimization, applyBidOptimization } from './ads-bid-optimizer.service.js'
import { getAutomationState } from './ads-automation-state.service.js'
import { notifyAutomation } from './ads-automation-notify.service.js'

// Skip immaterial moves — protects the Amazon API rate budget + per-campaign
// daily write caps from churn on sub-cent noise.
const MIN_DELTA_CENTS = 2

export interface AutoBidResult { skipped?: string; proposed: number; applied: number; dryRun: boolean }

export async function runAutoBidOnce(): Promise<AutoBidResult> {
  const state = await getAutomationState()
  if (state.effectivelyStopped) return { skipped: 'halted-or-off', proposed: 0, applied: 0, dryRun: false }
  const forceDry = state.autonomy === 'SUGGEST'

  // Profit-native target ACOS + Bayesian sparse-data path (best signal).
  const preview = await previewBidOptimization({ profitMode: true, bayesian: true })
  const changes = preview.proposals
    .filter((p) => Math.abs(p.deltaCents) >= MIN_DELTA_CENTS)
    .map((p) => ({ targetId: p.targetId, proposedBidCents: p.proposedBidCents }))
  if (changes.length === 0) return { proposed: 0, applied: 0, dryRun: forceDry }

  const res = await applyBidOptimization({ changes, actor: 'automation:auto-bid', dryRun: forceDry })
  logger.info('[ads-auto-bid] run', { proposed: changes.length, applied: res.applied, dryRun: res.dryRun })
  await notifyAutomation({
    type: 'ads-auto-bid',
    severity: 'info',
    title: forceDry ? `Auto-bid: ${changes.length} bid changes proposed` : `Auto-bid: ${res.applied} bid changes applied`,
    body: `Profit-native target-ACOS optimization (${changes.length} candidates). ${forceDry ? 'SUGGEST mode — proposals only.' : 'Writes gated per-campaign allowlist + caps.'}`,
    href: '/marketing/trading-desk/automation',
  }).catch(() => {})
  return { proposed: changes.length, applied: res.applied, dryRun: res.dryRun }
}

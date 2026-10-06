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
 *
 * 1d — the dial is read through the shared engine guard (ads-engine-guard.ts), which also keeps this
 * engine's caps per run and per day: whole campaigns, biggest moves first, while there is room.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { previewBidOptimization, applyBidOptimization } from './ads-bid-optimizer.service.js'
import { notifyAutomation } from './ads-automation-notify.service.js'
import { allowChange, engineCapsText, engineGuardNote, nothingHeld, openEngineGuard, type EngineGuardReport } from './ads-engine-guard.js'

// Skip immaterial moves — protects the Amazon API rate budget + per-campaign
// daily write caps from churn on sub-cent noise.
const MIN_DELTA_CENTS = 2

/**
 * How auto-bid runs the optimiser: profit-native target ACOS + the Bayesian sparse-data path. Its preview (the
 * automation catalog's A4) runs the same, so what it shows is what a run would set. W0 — each keyword's target is its
 * campaign's own target ACoS, else (W1-5) the ads strategy's for its ad group, else the account default, else profit
 * data, else 30 % (ads-target-acos-resolver.ts); the strategy's bid limits hold every proposal.
 */
export const AUTO_BID_OPTIMIZER_OPTIONS = { profitMode: true, bayesian: true } as const

export interface AutoBidResult {
  skipped?: string; proposed: number; applied: number; dryRun: boolean
  /** 1d — the dial posture and the caps this run ran under, and what they held back. */
  guard?: EngineGuardReport
}

export async function runAutoBidOnce(): Promise<AutoBidResult> {
  // 1d — through the shared guard: halt / OFF / kill stand it down as before; a state it cannot read now stops the
  // run too (fail closed — the old read fell back to SUGGEST and still computed).
  const guard = await openEngineGuard('auto-bid')
  if (guard.posture === 'stopped') return { skipped: 'halted-or-off', proposed: 0, applied: 0, dryRun: false, guard: guard.report() }
  const forceDry = guard.posture === 'suggest'

  // Profit-native target ACOS + Bayesian sparse-data path (best signal), toward the Owner's targets where he set them.
  const preview = await previewBidOptimization(AUTO_BID_OPTIMIZER_OPTIONS)
  const changes = preview.proposals
    .filter((p) => Math.abs(p.deltaCents) >= MIN_DELTA_CENTS)
    .map((p) => ({ targetId: p.targetId, proposedBidCents: p.proposedBidCents, sources: p.sources }))
  if (changes.length === 0) return { proposed: 0, applied: 0, dryRun: forceDry, guard: guard.report() }

  // 1d — whole campaigns, in the optimiser's order (biggest moves first), while the caps have room: a campaign is
  // never split. Under SUGGEST each campaign is only counted (would-apply). Counted as planned — one bulk write
  // follows, and an entry it refuses only leaves room unused.
  const targets = await prisma.adTarget.findMany({ where: { id: { in: changes.map((c) => c.targetId) } }, select: { id: true, adGroup: { select: { campaignId: true } } } })
  const campaignOf = new Map(targets.map((t) => [t.id, t.adGroup.campaignId]))
  const byCampaign = new Map<string, typeof changes>()
  for (const c of changes) { const k = campaignOf.get(c.targetId) ?? c.targetId; byCampaign.set(k, [...(byCampaign.get(k) ?? []), c]) }
  const allowed: typeof changes = []
  for (const group of byCampaign.values()) {
    const permit = guard.permit()
    const held = nothingHeld()
    const ok = allowChange(true, permit, held, 'forward')
    if (ok) allowed.push(...group)
    guard.settle(permit, ok ? group.length : 0, held)
  }
  const report = guard.report()

  const res = await applyBidOptimization({ changes: allowed, actor: 'automation:auto-bid', dryRun: forceDry })
  logger.info('[ads-auto-bid] run', { proposed: changes.length, applied: res.applied, dryRun: res.dryRun, deferredByCap: report.deferredByCap })
  await notifyAutomation({
    type: 'ads-auto-bid',
    severity: 'info',
    title: forceDry ? `Auto-bid: ${changes.length} bid changes proposed` : `Auto-bid: ${res.applied} bid changes applied`,
    body: `Target-ACOS optimization: each campaign's own target, else the ads strategy's, else the account default, else profit data (${changes.length} candidates). ${forceDry ? 'The account dial is at Propose — proposals only.' : 'Writes gated per-campaign allowlist + caps.'}${report.deferredByCap ? ` ${report.deferredByCap} campaigns wait for the next run (its own cap: ${engineCapsText('auto-bid')}).` : ''}`,
  }).catch(() => {})
  return { proposed: changes.length, applied: res.applied, dryRun: res.dryRun, guard: report }
}

/** 1d — the run's summary line, for the cron and Run now: the counts, plus what the dial or the caps held back. */
export function autoBidSummaryLine(r: AutoBidResult): string {
  if (r.skipped) return `skipped=${r.skipped}`
  return `proposed=${r.proposed} applied=${r.applied} dryRun=${r.dryRun}${engineGuardNote(r.guard, {
    suggest: 'nothing is written; the bids it would set are counted',
    stopped: 'nothing is written',
  })}`
}

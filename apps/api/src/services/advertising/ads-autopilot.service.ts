/**
 * Apex F.1 — beginner autopilot (simulate / glass-box).
 *
 * One north star (a lifecycle mode → profit / balanced / growth) drives every
 * engine we built: profit-native per-SKU target ACOS (C.2), Bayesian sparse-
 * data bidding (C.3), and Top-of-Search defense (D.2). simulateAutopilot()
 * composes their dry-run output into ONE plain-language plan — "here's exactly
 * what autopilot would change and why" — so a non-expert can read it and trust
 * it before anything goes live. Simulation is read-only; the apply path
 * (allowlist + write-gated) lands in F.2.
 *
 * The summarizer is pure + unit-tested; the orchestrator just gathers the
 * dry-run results from the existing services.
 */

import { previewBidOptimization, type BidProposal } from './ads-bid-optimizer.service.js'
import { defendTopOfSearch, type DefendTosResult } from './ads-top-of-search.service.js'
import type { AcosMode } from './ads-target-acos.service.js'

const eur = (c: number) => `€${(c / 100).toFixed(2)}`

export interface AutopilotAction {
  kind: 'bid' | 'top_of_search'
  scope: string
  summary: string // plain English, beginner-readable
  deltaLabel: string
  basis: string
}

export interface AutopilotPlan {
  northStar: { mode: AcosMode; label: string }
  headline: string
  counts: { bidChanges: number; topOfSearchChanges: number }
  actions: AutopilotAction[]
  dryRun: true
}

const MODE_LABEL: Record<AcosMode, string> = {
  profit: 'Maximize profit (spend conservatively)',
  balanced: 'Balance profit and growth',
  growth: 'Grow aggressively (spend up to break-even)',
}

/** Plain-English line for a single bid proposal. Pure. */
export function describeBidProposal(p: BidProposal): AutopilotAction {
  const dir = p.proposedBidCents > p.currentBidCents ? 'Raise' : 'Lower'
  const why =
    p.targetBasis === 'bayesian' ? 'based on its smoothed conversion rate (sparse data)'
      : p.targetBasis === 'profit' ? 'to hit this product’s profit-based ACOS target'
        : 'to move toward your ACOS target'
  return {
    kind: 'bid',
    scope: p.expression,
    summary: `${dir} bid on “${p.expression}” ${why}.`,
    deltaLabel: `${eur(p.currentBidCents)} → ${eur(p.proposedBidCents)}`,
    basis: p.targetBasis,
  }
}

/** Compose the plan + headline from the engines' dry-run output. Pure. */
export function summarizeAutopilotPlan(
  mode: AcosMode,
  bidProposals: BidProposal[],
  tos: DefendTosResult,
): AutopilotPlan {
  const bidActions = bidProposals.map(describeBidProposal)
  const tosActions: AutopilotAction[] = tos.sample.map((t) => ({
    kind: 'top_of_search',
    scope: t.campaign,
    summary: t.action === 'raise'
      ? `Bid up for the top-of-search slot on “${t.campaign}” — it converts well there.`
      : `Ease off the top-of-search premium on “${t.campaign}” — it’s above target there.`,
    deltaLabel: `Top-of-search +${t.fromPct}% → +${t.toPct}%`,
    basis: 'top_of_search',
  }))
  const bidChanges = bidActions.length
  const topOfSearchChanges = tos.changed
  const parts: string[] = []
  if (bidChanges) parts.push(`adjust ${bidChanges} keyword bid${bidChanges === 1 ? '' : 's'}`)
  if (topOfSearchChanges) parts.push(`tune ${topOfSearchChanges} top-of-search placement${topOfSearchChanges === 1 ? '' : 's'}`)
  const headline = parts.length
    ? `Autopilot would ${parts.join(' and ')} to ${mode === 'profit' ? 'protect profit' : mode === 'growth' ? 'grow sales' : 'balance profit and growth'}.`
    : 'Autopilot has nothing to change right now — your bids are on target.'
  return {
    northStar: { mode, label: MODE_LABEL[mode] },
    headline,
    counts: { bidChanges, topOfSearchChanges },
    actions: [...bidActions, ...tosActions],
    dryRun: true,
  }
}

export async function simulateAutopilot(opts: {
  campaignId?: string
  marketplace?: string
  mode?: AcosMode
  bayesian?: boolean
  targetAcos?: number
} = {}): Promise<AutopilotPlan> {
  const mode = opts.mode ?? 'profit'
  const [bid, tos] = await Promise.all([
    previewBidOptimization({ campaignId: opts.campaignId, profitMode: true, bayesian: opts.bayesian ?? true, mode, targetAcos: opts.targetAcos }),
    defendTopOfSearch({ marketplace: opts.marketplace, dryRun: true }),
  ])
  // Cap the action list so the plan stays readable for a beginner.
  return summarizeAutopilotPlan(mode, bid.proposals.slice(0, 50), tos)
}

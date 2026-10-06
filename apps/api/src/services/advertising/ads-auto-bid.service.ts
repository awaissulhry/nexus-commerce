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
 *
 * Owner targets only (Owner decision 2026-10-06, A) — of the optimiser's proposals it moves only the bids whose target
 * ACoS the Owner set (the campaign's own, the ads strategy's, the account default), and it leaves every bid another
 * owner holds: an hourly bid plan or a product plan, a running autopilot plan, a person, a pin (planAutoBid). A
 * profit-derived or flat 30 % target is one he never chose, so such a bid is left alone and counted. The optimiser
 * itself is unchanged: previews, rules, recommendations and autopilot plans see what they saw before.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { previewBidOptimization, applyBidOptimization, type BidProposal } from './ads-bid-optimizer.service.js'
import { notifyAutomation } from './ads-automation-notify.service.js'
import { allowChange, engineCapsText, engineGuardNote, nothingHeld, openEngineGuard, type EngineGuardReport } from './ads-engine-guard.js'
import type { TargetAcosSource } from './ads-target-acos-resolver.js'
import { bidderByCampaign } from './bid-grid.service.js'
import { rankOwnedCampaignIds } from './rank-release.service.js'

// Skip immaterial moves — protects the Amazon API rate budget + per-campaign
// daily write caps from churn on sub-cent noise.
const MIN_DELTA_CENTS = 2

/**
 * How auto-bid runs the optimiser: profit-native target ACOS + the Bayesian sparse-data path. Its preview (the
 * automation catalog's A4) runs the same, so what it shows is what a run would set. W0 — each keyword's target is its
 * campaign's own target ACoS, else (W1-5) the ads strategy's for its ad group, else the account default, else profit
 * data, else 30 % (ads-target-acos-resolver.ts); the strategy's bid limits hold every proposal. A run then moves only
 * the first three (planAutoBid).
 */
export const AUTO_BID_OPTIMIZER_OPTIONS = { profitMode: true, bayesian: true } as const

/** What auto-bid does and leaves, in the words its summary, its notification and its catalog entry (A4) use. */
export const AUTO_BID_SCOPE_WORDS = 'it moves only bids where you set a target ACoS (campaign, ads strategy or account default) and leaves bids an hourly plan, a goal plan, a person or a pin holds'

/**
 * The target sources that are the Owner's: a number he set. `explicit` is a caller's own target (auto-bid passes none;
 * listed so the rule stays whole); `profit` and `flat` are worked out or assumed, never set by him.
 */
const OWNER_TARGET_SOURCES: ReadonlySet<TargetAcosSource> = new Set<TargetAcosSource>(['explicit', 'campaign', 'strategy', 'account'])

/** Who else holds a campaign's bids, for auto-bid (autoBidHolders). */
export type AutoBidHolder = 'pinned' | 'hourlyPlan' | 'goalPlan' | 'person'
/** The bids auto-bid would have moved and left alone, per reason: no target the Owner set, or another owner holds them. */
export type AutoBidLeftAlone = Record<'noTargetSetByYou' | AutoBidHolder, number>

const LEFT_ALONE_WORDS: Record<keyof AutoBidLeftAlone, string> = {
  noTargetSetByYou: 'with no target set by you',
  hourlyPlan: 'an hourly plan holds',
  goalPlan: 'a goal plan holds',
  person: 'a person holds',
  pinned: 'a pin holds',
}

export function noneLeftAlone(): AutoBidLeftAlone {
  return { noTargetSetByYou: 0, hourlyPlan: 0, goalPlan: 0, person: 0, pinned: 0 }
}

export function leftAloneTotal(l: AutoBidLeftAlone | null | undefined): number {
  return l ? Object.values(l).reduce((s, n) => s + n, 0) : 0
}

/** "4 with no target set by you, 2 an hourly plan holds" — the reasons that left a bid alone; '' when none did. */
export function leftAloneWords(l: AutoBidLeftAlone | null | undefined): string {
  if (!l) return ''
  return (Object.keys(LEFT_ALONE_WORDS) as Array<keyof AutoBidLeftAlone>).filter((k) => l[k] > 0).map((k) => `${l[k]} ${LEFT_ALONE_WORDS[k]}`).join(', ')
}

/**
 * Who else holds each named campaign's bids, first that applies. Each read is the one its own screen or engine uses:
 *   pinned      `Campaign.pinBids` — "hands off the bids" (ads-authority-pins.ts); the write gate refuses it too.
 *   hourlyPlan  the Bid page's owner `schedule` (bidderByCampaign, bid-grid.service.ts: an enabled schedule), and the
 *               campaigns Rank & Dayparting holds (rankOwnedCampaignIds, rank-release.service.ts: goal-mode schedules
 *               and the product plans' campaigns).
 *   goalPlan    an autopilot plan the autopilot cron runs (RUNNING_AUTOPILOT_PLANS) that names the campaign.
 *   person      the Bid page's owner `manual`: a person's bid edit in the last 60 days.
 * The Bid page's owner `goal` is the campaign's own target ACoS — the target auto-bid moves toward — so it holds nothing
 * from auto-bid. Not caught: a run that cannot read who holds a bid stops rather than move it.
 */
export async function autoBidHolders(campaignIds: string[]): Promise<Map<string, AutoBidHolder>> {
  const out = new Map<string, AutoBidHolder>()
  if (!campaignIds.length) return out
  const { RUNNING_AUTOPILOT_PLANS } = await import('../../jobs/ad-autopilot.job.js')
  const [bidders, rankHeld, plans, pinned] = await Promise.all([
    bidderByCampaign(),
    rankOwnedCampaignIds(),
    prisma.autopilotPlan.findMany({ where: RUNNING_AUTOPILOT_PLANS, select: { campaignIds: true } }),
    prisma.campaign.findMany({ where: { id: { in: campaignIds }, pinBids: true }, select: { id: true } }),
  ])
  const pins = new Set(pinned.map((c) => c.id))
  const planHeld = new Set(plans.flatMap((p) => (Array.isArray(p.campaignIds) ? (p.campaignIds as unknown[]).map(String) : [])))
  for (const id of campaignIds) {
    const bidder = bidders.get(id)?.kind
    const holder: AutoBidHolder | null = pins.has(id) ? 'pinned'
      : bidder === 'schedule' || rankHeld.has(id) ? 'hourlyPlan'
        : planHeld.has(id) ? 'goalPlan'
          : bidder === 'manual' ? 'person' : null
    if (holder) out.set(id, holder)
  }
  return out
}

/**
 * Which proposals auto-bid moves: a target the Owner set (else `noTargetSetByYou`), on a campaign nobody else holds
 * (else the holder). Pure; the order of `proposals` is kept.
 */
export function ownerMoves<P extends Pick<BidProposal, 'targetId' | 'targetSource'>>(
  proposals: P[], campaignOf: ReadonlyMap<string, string>, holders: ReadonlyMap<string, AutoBidHolder>,
): { moves: P[]; leftAlone: AutoBidLeftAlone } {
  const leftAlone = noneLeftAlone()
  const moves: P[] = []
  for (const p of proposals) {
    if (!OWNER_TARGET_SOURCES.has(p.targetSource)) { leftAlone.noTargetSetByYou++; continue }
    const campaignId = campaignOf.get(p.targetId)
    const holder = campaignId ? holders.get(campaignId) : undefined
    if (holder) { leftAlone[holder]++; continue }
    moves.push(p)
  }
  return { moves, leftAlone }
}

export interface AutoBidPlan {
  preview: Awaited<ReturnType<typeof previewBidOptimization>>
  /** The bids a run would set now, biggest first: moves of at least 2¢ that pass ownerMoves. */
  moves: BidProposal[]
  /** Each move's campaign. */
  campaignOf: Map<string, string>
  leftAlone: AutoBidLeftAlone
}

/** The bids auto-bid would set now — for the run and for its preview (A4) alike, so the preview is the run. */
export async function planAutoBid(): Promise<AutoBidPlan> {
  // Profit-native target ACOS + Bayesian sparse-data path (best signal); a run moves only the Owner's targets.
  const preview = await previewBidOptimization(AUTO_BID_OPTIMIZER_OPTIONS)
  const material = preview.proposals.filter((p) => Math.abs(p.deltaCents) >= MIN_DELTA_CENTS)
  // Who holds a bid is read only for the moves toward a target he set (none: no read at all).
  const withTarget = material.filter((p) => OWNER_TARGET_SOURCES.has(p.targetSource))
  const targets = withTarget.length
    ? await prisma.adTarget.findMany({ where: { id: { in: withTarget.map((p) => p.targetId) } }, select: { id: true, adGroup: { select: { campaignId: true } } } })
    : []
  const campaignOf = new Map(targets.map((t) => [t.id, t.adGroup.campaignId]))
  const holders = await autoBidHolders([...new Set(campaignOf.values())])
  const { moves, leftAlone } = ownerMoves(material, campaignOf, holders)
  return { preview, moves, campaignOf, leftAlone }
}

export interface AutoBidResult {
  skipped?: string; proposed: number; applied: number; dryRun: boolean
  /** Owner targets only — the bids it would have moved and left alone, per reason. */
  leftAlone?: AutoBidLeftAlone
  /** 1d — the dial posture and the caps this run ran under, and what they held back. */
  guard?: EngineGuardReport
}

export async function runAutoBidOnce(): Promise<AutoBidResult> {
  // 1d — through the shared guard: halt / OFF / kill stand it down as before; a state it cannot read now stops the
  // run too (fail closed — the old read fell back to SUGGEST and still computed).
  const guard = await openEngineGuard('auto-bid')
  if (guard.posture === 'stopped') return { skipped: 'halted-or-off', proposed: 0, applied: 0, dryRun: false, guard: guard.report() }
  const forceDry = guard.posture === 'suggest'

  // Toward the Owner's targets only, and never a bid another owner holds (planAutoBid).
  const plan = await planAutoBid()
  const { leftAlone, campaignOf } = plan
  const changes = plan.moves.map((p) => ({ targetId: p.targetId, proposedBidCents: p.proposedBidCents, sources: p.sources }))
  if (changes.length === 0) return { proposed: 0, applied: 0, dryRun: forceDry, leftAlone, guard: guard.report() }

  // 1d — whole campaigns, in the optimiser's order (biggest moves first), while the caps have room: a campaign is
  // never split. Under SUGGEST each campaign is only counted (would-apply). Counted as planned — one bulk write
  // follows, and an entry it refuses only leaves room unused.
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
  logger.info('[ads-auto-bid] run', { proposed: changes.length, applied: res.applied, dryRun: res.dryRun, deferredByCap: report.deferredByCap, leftAlone })
  const alone = leftAloneWords(leftAlone)
  await notifyAutomation({
    type: 'ads-auto-bid',
    severity: 'info',
    title: forceDry ? `Auto-bid: ${changes.length} bid changes proposed` : `Auto-bid: ${res.applied} bid changes applied`,
    body: `Target-ACoS optimization: ${AUTO_BID_SCOPE_WORDS} (${changes.length} to move${alone ? `; left alone: ${alone}` : ''}). ${forceDry ? 'The account dial is at Propose — proposals only.' : 'Writes gated per-campaign allowlist + caps.'}${report.deferredByCap ? ` ${report.deferredByCap} campaigns wait for the next run (its own cap: ${engineCapsText('auto-bid')}).` : ''}`,
  }).catch(() => {})
  return { proposed: changes.length, applied: res.applied, dryRun: res.dryRun, leftAlone, guard: report }
}

/**
 * Owner targets only — what the run left alone, for its summary line: the count, each reason, and the rule in words.
 * Empty when it left nothing alone, so such a run's line is unchanged.
 */
export function autoBidLeftAloneNote(l: AutoBidLeftAlone | null | undefined): string {
  const n = leftAloneTotal(l)
  return n ? ` left-alone=${n} (${leftAloneWords(l)}: ${AUTO_BID_SCOPE_WORDS})` : ''
}

/** 1d — the run's summary line, for the cron and Run now: the counts, plus what it left alone and what the dial or the caps held back. */
export function autoBidSummaryLine(r: AutoBidResult): string {
  if (r.skipped) return `skipped=${r.skipped}`
  return `proposed=${r.proposed} applied=${r.applied} dryRun=${r.dryRun}${autoBidLeftAloneNote(r.leftAlone)}${engineGuardNote(r.guard, {
    suggest: 'nothing is written; the bids it would set are counted',
    stopped: 'nothing is written',
  })}`
}

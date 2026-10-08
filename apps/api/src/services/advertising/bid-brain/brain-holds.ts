/**
 * BID BRAIN BB-6 — a person's bid on a campaign the brain owns becomes an explicit hold (BidHold), so the brain leaves
 * it alone for the days a person's bid is his today, and the read tool and auto-undo can say who holds it until when.
 *
 *   who       a person's own edit, and a Claude request a person approved (`manual`, as the write gate reads it —
 *             never the free-text actor): PERSON, or CLAUDE when the write names its request (its change set)
 *   replaces  the target's earlier open PERSON / CLAUDE hold ends when a newer one starts
 *   handBack  a request that hands the bid back (evidence.handBack): the target's open holds end, none starts
 *
 * Only on a campaign the brain owns now (bid-brain/live.ts). It never fails the write that called it.
 */
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { brainOwnedCampaignIds } from './live.js'
import { STRATEGY_HOLD_KIND } from './facts.js'

/** Days a person's bid holds — the same 60 as bid-grid.service.ts PERSON_BID_HOLD_DAYS (a test keeps them equal). */
export const BRAIN_HOLD_DAYS = 60

export type BrainHoldOutcome = 'held' | 'released' | null

export async function recordBrainHold(args: {
  campaignId: string | null | undefined
  targetId: string
  actor: string
  /** The write gate's person mark (isPersonEdit): a person's own edit or a request a person approved. */
  manual: boolean
  changeSetId?: string | null
  handBack?: boolean
  reason?: string | null
  now?: Date
}): Promise<BrainHoldOutcome> {
  if (!args.manual || !args.campaignId) return null
  try {
    const owned = await brainOwnedCampaignIds([args.campaignId])
    if (!owned.has(args.campaignId)) return null
    const now = args.now ?? new Date()
    await prisma.bidHold.updateMany({
      where: { campaignId: args.campaignId, targetId: args.targetId, endedAt: null, kind: { in: ['PERSON', 'CLAUDE'] } },
      data: { endedAt: now, endedBy: args.actor },
    })
    if (args.handBack) return 'released'
    await prisma.bidHold.create({
      data: {
        campaignId: args.campaignId,
        targetId: args.targetId,
        kind: args.changeSetId ? 'CLAUDE' : 'PERSON',
        until: new Date(now.getTime() + BRAIN_HOLD_DAYS * 86_400_000),
        by: args.actor,
        reason: args.reason?.trim() ? args.reason.trim().slice(0, 500) : null,
      },
    })
    return 'held'
  } catch (err) {
    logger.warn('[bid-brain] could not record a person\'s hold — the 60-day person bid still holds it', { campaignId: args.campaignId, targetId: args.targetId, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/**
 * ONE BRAIN AB-2 — a person's own bidding strategy on a campaign the brain owns (his edit, or a Claude request he approved:
 * `manual`) becomes a STRATEGY hold for BRAIN_HOLD_DAYS, as his bid does (design §2.10): the stop recipe leaves the
 * strategy alone — no switch to down only — until it ends (stop-recipe.ts). A newer one replaces the open one. Only on a
 * campaign the brain owns now; it never fails the write that called it.
 */
export async function recordStrategyHold(args: { campaignId: string; actor: string; manual: boolean; reason?: string | null; now?: Date }): Promise<BrainHoldOutcome> {
  if (!args.manual) return null
  try {
    const owned = await brainOwnedCampaignIds([args.campaignId])
    if (!owned.has(args.campaignId)) return null
    const now = args.now ?? new Date()
    await prisma.bidHold.updateMany({ where: { campaignId: args.campaignId, targetId: null, kind: STRATEGY_HOLD_KIND, endedAt: null }, data: { endedAt: now, endedBy: args.actor } })
    await prisma.bidHold.create({
      data: {
        campaignId: args.campaignId, targetId: null, kind: STRATEGY_HOLD_KIND, until: new Date(now.getTime() + BRAIN_HOLD_DAYS * 86_400_000), by: args.actor,
        reason: args.reason?.trim() ? args.reason.trim().slice(0, 500) : 'a person\'s own bidding strategy',
      },
    })
    return 'held'
  } catch (err) {
    logger.warn('[bid-brain] could not record a person\'s bidding-strategy hold', { campaignId: args.campaignId, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

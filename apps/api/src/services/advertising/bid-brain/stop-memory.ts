/**
 * ONE BRAIN AB-2 — the stop recipe's memory on a campaign the bid brain owns (stop-recipe.ts), kept beside the keywords'
 * own (`AdTarget.suppressedFromBidCents`): the placement % live when a stop began (`Campaign.suppressedFromPlacements`)
 * and the bidding strategy it switched from (`Campaign.suppressedFromBiddingStrategy`).
 *
 *   remember  before the write that zeroes the lanes or switches the strategy (a run cut off between the two leaves the
 *             memory and nothing else); never over an older memory — that one is the campaign before the stop
 *   forget    once the give-back was written (or nothing was left to give back, or the Owner's lock keeps the lever)
 *
 * And the anti-flap count: the brain's strategy switches of a campaign this UTC day, read from the action log its
 * campaign write leaves (actor automation:bid-brain, AD_BIDDING_STRATEGY_UPDATE).
 *
 * The rollback (giveBackStopMemory): when the brain no longer runs the campaign — op shadow, give-back, op live over an old
 * memory, and every restore of a stop's owner on a campaign the brain does not own (the server switch off, a product that
 * left the brain) — the saved lanes and strategy go back, as the one who hands it back, and the memory is cleared.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { BRAIN_ACTOR } from './live.js'
import { fullLanes, readSavedLanes, stopMemoryOwed, type Placement } from './stop-recipe.js'
import type { AdsActor } from '../ads-mutation.service.js'

/** Save the lanes live when the stop began, unless a memory is kept already. */
export async function rememberLanes(campaignId: string, lanes: readonly Placement[]): Promise<void> {
  await prisma.campaign.updateMany({
    where: { id: campaignId, suppressedFromPlacements: { equals: Prisma.DbNull } },
    data: { suppressedFromPlacements: lanes.map((l) => ({ placement: l.placement, percentage: l.percentage })) as Prisma.InputJsonArray },
  })
}

/** The lanes are back (or kept by the Owner): the memory goes. */
export async function forgetLanes(campaignId: string): Promise<void> {
  await prisma.campaign.updateMany({ where: { id: campaignId, NOT: { suppressedFromPlacements: { equals: Prisma.DbNull } } }, data: { suppressedFromPlacements: Prisma.DbNull } })
}

/** Save the strategy the stop switches from, unless a memory is kept already. */
export async function rememberStrategy(campaignId: string, strategy: string): Promise<void> {
  await prisma.campaign.updateMany({ where: { id: campaignId, suppressedFromBiddingStrategy: null }, data: { suppressedFromBiddingStrategy: strategy as never } })
}

/** The strategy is back (or kept by the Owner, or changed by someone during the stop): the memory goes. */
export async function forgetStrategy(campaignId: string): Promise<void> {
  await prisma.campaign.updateMany({ where: { id: campaignId, suppressedFromBiddingStrategy: { not: null } }, data: { suppressedFromBiddingStrategy: null } })
}

const utcMidnight = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

/** Each campaign's bidding-strategy switches by the brain since 00:00 UTC of `now` (campaigns with none are absent). */
export async function strategySwitchesToday(campaignIds: readonly string[], now: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!campaignIds.length) return out
  const rows = await prisma.advertisingActionLog.groupBy({
    by: ['entityId'],
    where: { entityType: 'CAMPAIGN', entityId: { in: [...campaignIds] }, actionType: 'AD_BIDDING_STRATEGY_UPDATE', userId: BRAIN_ACTOR, createdAt: { gte: utcMidnight(now) } },
    _count: { _all: true },
  })
  for (const r of rows) out.set(r.entityId, r._count._all)
  return out
}

/** Campaign.dynamicBidding.placementBidding as stored. */
const lanesOf = (dynamicBidding: unknown): Placement[] => {
  const list = ((dynamicBidding ?? {}) as { placementBidding?: unknown }).placementBidding
  return (Array.isArray(list) ? list : []).flatMap((p) => (typeof (p as Placement)?.placement === 'string' && Number.isFinite(Number((p as Placement).percentage)) ? [{ placement: (p as Placement).placement, percentage: Number((p as Placement).percentage) }] : []))
}

/**
 * AB-2 — the rollback: put back what a stop's memory still owes the campaign — the saved lanes (one placement write) and
 * the saved strategy (the campaign write, while the campaign still runs on the stop's down only) — as `write.actor`, and
 * clear each memory once it is back (or owes nothing: settled, or changed by someone since). A refused write keeps its
 * memory, so the next restore tries again. `lanes: false`: a give-back that puts the LIVE-time placements back itself
 * only clears the saved lanes. Answers what was sent and refused, and whether anything is still owed.
 */
export async function giveBackStopMemory(campaignId: string, write: { actor: AdsActor; reason: string; changeSetId?: string | null; manual?: boolean; confirmOwnLimits?: boolean; lanes?: boolean }): Promise<{ sent: number; refused: string[]; owed: boolean }> {
  const c = await prisma.campaign.findFirst({ where: { id: campaignId }, select: { dynamicBidding: true, biddingStrategy: true, suppressedFromPlacements: true, suppressedFromBiddingStrategy: true } })
  const out = { sent: 0, refused: [] as string[], owed: false }
  if (!c) return out
  const savedPlacements = readSavedLanes(c.suppressedFromPlacements)
  const savedStrategy = c.suppressedFromBiddingStrategy ? String(c.suppressedFromBiddingStrategy) : null
  if (!savedPlacements && !savedStrategy) return out
  const owed = stopMemoryOwed({ placements: lanesOf(c.dynamicBidding), biddingStrategy: String(c.biddingStrategy), savedPlacements, savedStrategy })
  const reason = `${write.reason} — the stop recipe's saved settings back`.slice(0, 480)
  if (savedPlacements) {
    if (!owed.lanes || write.lanes === false) await forgetLanes(campaignId)
    else {
      const { updatePlacementBidding } = await import('../ads-create.service.js')
      const r = await updatePlacementBidding({ campaignId, adjustments: fullLanes(savedPlacements), actor: write.actor, reason, changeSetId: write.changeSetId ?? null, manual: write.manual }) as { mode?: string; reason?: string }
      if (r.mode !== 'blocked') { out.sent++; await forgetLanes(campaignId) } else { out.refused.push(r.reason ?? 'placements refused'); out.owed = true }
    }
  }
  if (savedStrategy) {
    if (!owed.strategy) await forgetStrategy(campaignId)
    else {
      const { updateCampaignWithSync } = await import('../ads-mutation.service.js')
      const r = await updateCampaignWithSync({ campaignId, patch: { biddingStrategy: savedStrategy as 'LEGACY_FOR_SALES' | 'AUTO_FOR_SALES' | 'MANUAL' }, actor: write.actor, reason, changeSetId: write.changeSetId ?? null, manual: write.manual, confirmOwnLimits: write.confirmOwnLimits, applyImmediately: true })
      if (r.ok) { out.sent += r.outboundQueueId ? 1 : 0; await forgetStrategy(campaignId) } else { out.refused.push(r.error ?? 'bidding strategy refused'); out.owed = true }
    }
  }
  return out
}

/** AB-2 — a stop's memory on a campaign that is not given back yet: what it still owes, in words (null: nothing owed). */
export function owedWords(owed: { lanes: boolean; strategy: boolean }, savedStrategy: string | null): string | null {
  const parts = [owed.lanes ? 'the placements it set to 0 %' : '', owed.strategy ? `the bidding strategy it switched to down only (${savedStrategy === 'AUTO_FOR_SALES' ? 'up and down' : savedStrategy} saved)` : ''].filter(Boolean)
  return parts.length ? `a stop's saved settings are still owed: ${parts.join(' and ')}` : null
}

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
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { BRAIN_ACTOR } from './live.js'
import type { Placement } from './stop-recipe.js'

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

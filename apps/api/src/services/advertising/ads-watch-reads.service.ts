/**
 * ADS AUTONOMY W4-5 — the reads of advertising's own tables that the watch-week comparison needs
 * (agents/ads-watch-week.service.ts), behind the advertising context's boundary (scripts/check-context-boundary.mjs):
 * the campaign of an ad group, the ad groups of a campaign, and the engines' suggestions for named entities. Read
 * only, in the business of the call (row-level security).
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'

export interface CampaignBits { id: string; marketplace: string | null; dailyBudgetCurrency: string | null }

/** Each ad group with its campaign's id, market and currency. */
export async function adGroupCampaigns(ids: readonly string[]): Promise<Array<{ id: string; campaign: CampaignBits | null }>> {
  if (!ids.length) return []
  return prisma.adGroup.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, campaign: { select: { id: true, marketplace: true, dailyBudgetCurrency: true } } },
  })
}

/** The ad groups of these campaigns, by id, at most `take` in all. */
export async function adGroupsOfCampaigns(campaignIds: readonly string[], take: number): Promise<Array<{ id: string; campaignId: string }>> {
  if (!campaignIds.length) return []
  return prisma.adGroup.findMany({ where: { campaignId: { in: [...new Set(campaignIds)] } }, select: { id: true, campaignId: true }, orderBy: { id: 'asc' }, take })
}

export interface SuggestionRow {
  entityType: string
  entityId: string
  ruleName: string | null
  proposedAction: unknown
  proposedKey: string
  status: string
  createdAt: Date
  lastSeenAt: Date
}

/**
 * The engines' suggestions (AdsRuleSuggestion) for these targets, campaigns and search terms that were still proposed
 * on or after `seenSince` and first proposed by `createdBy`. A search term's suggestion is `${externalCampaignId}:${query}`
 * (ads-suggestions.service.ts extractEntity): it is matched by its campaign here, by its words by the caller.
 */
export async function suggestionsFor(opts: {
  targetIds: readonly string[]
  campaignIds: readonly string[]
  termCampaignExts: readonly string[]
  seenSince: Date
  createdBy: Date
  take: number
}): Promise<SuggestionRow[]> {
  const or: Prisma.AdsRuleSuggestionWhereInput[] = []
  if (opts.targetIds.length) or.push({ entityType: 'AD_TARGET', entityId: { in: [...new Set(opts.targetIds)] } })
  if (opts.campaignIds.length) or.push({ entityType: 'CAMPAIGN', entityId: { in: [...new Set(opts.campaignIds)] } })
  if (opts.termCampaignExts.length) {
    or.push({ entityType: 'SEARCH_TERM', OR: [...new Set(opts.termCampaignExts)].map((ext) => ({ entityId: { startsWith: `${ext}:` } })) })
  }
  if (!or.length) return []
  return prisma.adsRuleSuggestion.findMany({
    where: { OR: or, lastSeenAt: { gte: opts.seenSince }, createdAt: { lte: opts.createdBy } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: opts.take,
    select: { entityType: true, entityId: true, ruleName: true, proposedAction: true, proposedKey: true, status: true, createdAt: true, lastSeenAt: true },
  })
}

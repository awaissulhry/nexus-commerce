/**
 * E2 (eBay Ads) — entity sync: campaigns → ads (CPS) / ad groups + keywords +
 * negatives (CPC), idempotent upserts into the E2 tables. Read-only against
 * eBay. Inherits the ADS_SYNC_MIRROR reconciliation guards:
 *   - fetch-success gating: a failed fetch NEVER drives STALE-marking
 *   - mass-stale circuit breaker: an implausible disappearance fraction in
 *     one pass is skipped + logged, not applied
 *   - soft flips only (status='STALE'); nothing is deleted
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { normalizeCampaignStatus, EBAY_CAMPAIGN_STATUS_MAP } from '../ads-core/campaign-status.js'
import {
  getActiveEbayAdsAuth,
  fetchCampaigns,
  fetchAds,
  fetchAdGroups,
  fetchKeywords,
  fetchNegativeKeywords,
  type EbayCampaignDTO,
} from './ebay-ads-api.service.js'

export interface EntitySyncReport {
  connections: number
  campaigns: number
  ads: number
  adGroups: number
  keywords: number
  negatives: number
  staledAds: number
  skippedStaleFlip: boolean
  errors: string[]
}

/** Pure guard: skip the stale pass when too much vanished at once. */
export function shouldSkipStaleFlip(knownLive: number, seenNow: number, maxDropFraction = 0.5): boolean {
  if (knownLive === 0) return false
  const dropped = knownLive - seenNow
  if (dropped <= 0) return false
  return dropped / knownLive > maxDropFraction
}

const toDecimalString = (v: string | undefined | null): string | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n.toFixed(2) : null
}

function legacyFundingStrategy(fundingModel: string | undefined): string {
  return fundingModel === 'COST_PER_CLICK' ? 'ADVANCED' : 'STANDARD'
}

async function upsertCampaign(connectionId: string, c: EbayCampaignDTO): Promise<string> {
  const fs = c.fundingStrategy ?? {}
  const fundingModel = fs.fundingModel ?? 'COST_PER_SALE'
  const dailyVal = c.budget?.daily?.amount?.value
  const shared = {
    marketplace: c.marketplaceId ?? 'EBAY_IT',
    name: c.campaignName ?? c.campaignId,
    fundingStrategy: legacyFundingStrategy(fundingModel), // legacy dual-write
    fundingModel,
    campaignTargetingType: c.campaignTargetingType ?? null,
    channels: c.channels ?? [],
    adRateStrategy: fs.adRateStrategy ?? null,
    dynamicAdRatePrefs: (fs.dynamicAdRatePreferences as object | undefined) ?? undefined,
    campaignCriterion: (c.campaignCriterion as object | undefined) ?? undefined,
    isRulesBased: !!c.campaignCriterion?.selectionRules?.length,
    bidPercentage: toDecimalString(fs.bidPercentage),
    dailyBudget: toDecimalString(dailyVal),
    budgetCurrency: c.budget?.daily?.amount?.currency ?? null,
    status: c.campaignStatus ?? 'DRAFT',
    endDate: c.endDate ? new Date(c.endDate) : null,
    lastEntitySyncAt: new Date(),
  }
  const row = await prisma.ebayCampaign.upsert({
    where: { channelConnectionId_externalCampaignId: { channelConnectionId: connectionId, externalCampaignId: c.campaignId } },
    create: {
      channelConnectionId: connectionId,
      externalCampaignId: c.campaignId,
      startDate: c.startDate ? new Date(c.startDate) : new Date(),
      ...shared,
    },
    // nexusManaged is deliberately NOT in the update set — discovery must
    // never flip a Nexus-created campaign back to "discovered".
    update: shared,
  })
  return row.id
}

async function syncCpsAds(localCampaignId: string, marketplace: string, token: string, externalCampaignId: string, report: EntitySyncReport): Promise<void> {
  let ads
  try {
    ads = await fetchAds(token, externalCampaignId)
  } catch (e) {
    report.errors.push(`ads ${externalCampaignId}: ${(e as Error).message}`)
    return // fetch-success gating — no upserts, no stale pass
  }
  const seenListingIds = new Set<string>()
  for (const a of ads) {
    const listingId = a.listingId ?? null
    const invRef = a.inventoryReference?.inventoryReferenceId ?? a.inventoryReferenceId ?? null
    if (listingId) seenListingIds.add(listingId)
    const data = {
      marketplace,
      adGroupId: null as string | null,
      externalAdId: a.adId ?? null,
      inventoryReference: invRef,
      inventoryReferenceType: a.inventoryReference?.inventoryReferenceType ?? a.inventoryReferenceType ?? null,
      bidPercentage: toDecimalString(a.bidPercentage),
      status: a.adStatus ?? 'ACTIVE',
      lastSyncAt: new Date(),
    }
    if (listingId) {
      await prisma.ebayAd.upsert({
        where: { campaignId_listingId: { campaignId: localCampaignId, listingId } },
        create: { campaignId: localCampaignId, listingId, createdVia: 'DISCOVERED', ...data },
        update: data,
      })
    } else if (invRef) {
      await prisma.ebayAd.upsert({
        where: { campaignId_inventoryReference: { campaignId: localCampaignId, inventoryReference: invRef } },
        create: { campaignId: localCampaignId, listingId: null, createdVia: 'DISCOVERED', ...data },
        update: data,
      })
    } else {
      continue // an ad with neither key is unaddressable — skip, don't guess
    }
    report.ads++
  }

  // Stale pass (soft; guarded). SANDBOX ads exist only locally (gate closed
  // when created) — eBay can't return them, so they're exempt.
  const known = await prisma.ebayAd.findMany({
    where: { campaignId: localCampaignId, status: { notIn: ['STALE', 'SANDBOX'] }, listingId: { not: null } },
    select: { id: true, listingId: true },
  })
  const gone = known.filter((k) => k.listingId && !seenListingIds.has(k.listingId))
  if (gone.length === 0) return
  if (shouldSkipStaleFlip(known.length, known.length - gone.length)) {
    report.skippedStaleFlip = true
    logger.error(`[E2][ebay-ads] CIRCUIT BREAKER: ${gone.length}/${known.length} ads of campaign ${externalCampaignId} vanished in one pass — stale flip SKIPPED`)
    return
  }
  await prisma.ebayAd.updateMany({ where: { id: { in: gone.map((g) => g.id) } }, data: { status: 'STALE' } })
  report.staledAds += gone.length
}

async function syncCpcStructure(localCampaignId: string, token: string, externalCampaignId: string, report: EntitySyncReport): Promise<void> {
  let groups
  try {
    groups = await fetchAdGroups(token, externalCampaignId)
  } catch (e) {
    report.errors.push(`adGroups ${externalCampaignId}: ${(e as Error).message}`)
    return
  }
  const groupIdByExternal = new Map<string, string>()
  for (const g of groups) {
    const row = await prisma.ebayAdGroup.upsert({
      where: { campaignId_externalAdGroupId: { campaignId: localCampaignId, externalAdGroupId: g.adGroupId } },
      create: {
        campaignId: localCampaignId,
        externalAdGroupId: g.adGroupId,
        name: g.name ?? g.adGroupId,
        status: g.adGroupStatus ?? 'ACTIVE',
        defaultBidCents: g.defaultBid?.value ? Math.round(Number(g.defaultBid.value) * 100) : null,
        lastSyncAt: new Date(),
      },
      update: {
        name: g.name ?? g.adGroupId,
        status: g.adGroupStatus ?? 'ACTIVE',
        defaultBidCents: g.defaultBid?.value ? Math.round(Number(g.defaultBid.value) * 100) : null,
        lastSyncAt: new Date(),
      },
    })
    groupIdByExternal.set(g.adGroupId, row.id)
    report.adGroups++
  }

  try {
    const keywords = await fetchKeywords(token, externalCampaignId)
    for (const k of keywords) {
      const localGroup = k.adGroupId ? groupIdByExternal.get(k.adGroupId) : undefined
      if (!localGroup) continue
      await prisma.ebayKeyword.upsert({
        where: { adGroupId_externalKeywordId: { adGroupId: localGroup, externalKeywordId: k.keywordId } },
        create: {
          campaignId: localCampaignId,
          adGroupId: localGroup,
          externalKeywordId: k.keywordId,
          text: k.keywordText ?? '',
          matchType: k.matchType ?? 'EXACT',
          bidCents: k.bid?.value ? Math.round(Number(k.bid.value) * 100) : null,
          status: k.keywordStatus ?? 'ACTIVE',
          lastSyncAt: new Date(),
        },
        update: {
          text: k.keywordText ?? '',
          matchType: k.matchType ?? 'EXACT',
          bidCents: k.bid?.value ? Math.round(Number(k.bid.value) * 100) : null,
          status: k.keywordStatus ?? 'ACTIVE',
          lastSyncAt: new Date(),
        },
      })
      report.keywords++
    }
  } catch (e) {
    report.errors.push(`keywords ${externalCampaignId}: ${(e as Error).message}`)
  }

  try {
    const negatives = (
      await Promise.all([...groupIdByExternal.keys()].map((extGroupId) => fetchNegativeKeywords(token, externalCampaignId, extGroupId)))
    ).flat()
    for (const n of negatives) {
      await prisma.ebayNegativeKeyword.upsert({
        where: { campaignId_externalId: { campaignId: localCampaignId, externalId: n.negativeKeywordId } },
        create: {
          campaignId: localCampaignId,
          adGroupId: n.adGroupId ?? null,
          externalId: n.negativeKeywordId,
          text: n.negativeKeywordText ?? '',
          matchType: n.negativeKeywordMatchType ?? 'EXACT',
          status: n.negativeKeywordStatus ?? 'ACTIVE',
          lastSyncAt: new Date(),
        },
        update: {
          text: n.negativeKeywordText ?? '',
          matchType: n.negativeKeywordMatchType ?? 'EXACT',
          status: n.negativeKeywordStatus ?? 'ACTIVE',
          lastSyncAt: new Date(),
        },
      })
      report.negatives++
    }
  } catch (e) {
    report.errors.push(`negatives ${externalCampaignId}: ${(e as Error).message}`)
  }
}

/** Full entity sync for the active eBay connection. */
export async function syncEbayAdsEntities(): Promise<EntitySyncReport> {
  const report: EntitySyncReport = {
    connections: 0, campaigns: 0, ads: 0, adGroups: 0, keywords: 0, negatives: 0,
    staledAds: 0, skippedStaleFlip: false, errors: [],
  }
  const auth = await getActiveEbayAdsAuth()
  if (!auth) { report.errors.push('no active eBay connection'); return report }
  report.connections = 1

  let campaigns: EbayCampaignDTO[]
  try {
    campaigns = await fetchCampaigns(auth.token)
  } catch (e) {
    report.errors.push(`campaigns: ${(e as Error).message}`)
    return report
  }

  for (const c of campaigns) {
    if (!c.campaignId) continue
    const localId = await upsertCampaign(auth.connectionId, c)
    report.campaigns++
    const normalized = normalizeCampaignStatus(EBAY_CAMPAIGN_STATUS_MAP, c.campaignStatus)
    if (normalized === 'ENDED' || normalized === 'DELETED') continue // headers only for terminal campaigns
    const fundingModel = c.fundingStrategy?.fundingModel ?? 'COST_PER_SALE'
    const marketplace = c.marketplaceId ?? 'EBAY_IT'
    if (fundingModel === 'COST_PER_SALE') {
      await syncCpsAds(localId, marketplace, auth.token, c.campaignId, report)
    } else if ((c.channels ?? []).includes('OFF_SITE')) {
      // Offsite: campaign-level only — no ads/groups/keywords to pull.
    } else if (c.campaignTargetingType === 'SMART') {
      await syncCpsAds(localId, marketplace, auth.token, c.campaignId, report) // SMART: ads, no groups/keywords
    } else {
      await syncCpcStructure(localId, auth.token, c.campaignId, report)
      await syncCpsAds(localId, marketplace, auth.token, c.campaignId, report) // CPC manual also carries ads (listings)
    }
  }

  logger.info('[E2][ebay-ads] entity sync complete', report as unknown as Record<string, unknown>)
  return report
}

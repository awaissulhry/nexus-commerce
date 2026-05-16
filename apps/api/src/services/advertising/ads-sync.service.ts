/**
 * AD.1 — Pulls campaign / ad-group / target / product-ad structure
 * from Amazon Ads API (or sandbox fixtures) into local tables.
 *
 * Idempotent via UPSERT on externalCampaignId/externalAdGroupId/
 * externalTargetId/externalAdId. Re-running mid-day is safe.
 *
 * In sandbox mode (default), draws from __fixtures__/. In live mode
 * (AD.4+), iterates every active AmazonAdsConnection row and calls
 * the real API per profile.
 *
 * Returns a summary string suitable for the CronRun outputSummary.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import {
  listCampaigns,
  listAdGroups,
  listTargets,
  listProductAds,
  adsMode,
  type ClientContext,
  type AdsCampaignDTO,
  type AdsAdGroupDTO,
  type AdsTargetDTO,
  type AdsProductAdDTO,
  type AdsRegion,
} from './ads-api-client.js'

interface SyncSummary {
  profileCount: number
  campaigns: { upserted: number; skipped: number }
  adGroups: { upserted: number; skipped: number }
  targets: { upserted: number; skipped: number }
  productAds: { upserted: number; skipped: number }
  errors: string[]
  mode: 'sandbox' | 'live'
}

const STATE_TO_PRISMA: Record<string, 'ENABLED' | 'PAUSED' | 'ARCHIVED' | 'DRAFT'> = {
  enabled: 'ENABLED',
  paused: 'PAUSED',
  archived: 'ARCHIVED',
  draft: 'DRAFT',
}

const BIDDING_TO_PRISMA: Record<string, 'LEGACY_FOR_SALES' | 'AUTO_FOR_SALES' | 'MANUAL'> = {
  legacyForSales: 'LEGACY_FOR_SALES',
  autoForSales: 'AUTO_FOR_SALES',
  manual: 'MANUAL',
}

function dateFromAmazonYmd(ymd: string | undefined): Date | null {
  // Amazon SP Ads returns dates as 'YYYYMMDD'. Parse defensively.
  if (!ymd || ymd.length !== 8) return null
  const y = Number(ymd.slice(0, 4))
  const m = Number(ymd.slice(4, 6))
  const d = Number(ymd.slice(6, 8))
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null
  return new Date(Date.UTC(y, m - 1, d))
}

interface ProfileSyncContext {
  profileId: string
  region: AdsRegion
  marketplace: string
}

async function discoverActiveProfiles(): Promise<ProfileSyncContext[]> {
  // In sandbox we synthesize a single profile so the sync pipeline runs
  // without an operator having to create a connection first.
  if (adsMode() === 'sandbox') {
    return [
      { profileId: 'SANDBOX-PROFILE-IT-001', region: 'EU', marketplace: 'IT' },
      { profileId: 'SANDBOX-PROFILE-DE-002', region: 'EU', marketplace: 'DE' },
    ]
  }
  const conns = await prisma.amazonAdsConnection.findMany({
    where: { isActive: true },
    select: { profileId: true, region: true, marketplace: true },
  })
  return conns.map((c) => ({
    profileId: c.profileId,
    region: (c.region === 'NA' || c.region === 'FE' ? c.region : 'EU') as AdsRegion,
    marketplace: c.marketplace,
  }))
}

async function syncCampaignsForProfile(
  ctx: ClientContext,
  marketplace: string,
  campaigns: AdsCampaignDTO[],
): Promise<{ upserted: number; skipped: number; map: Map<string, string> }> {
  // Returns a map of externalCampaignId → local Campaign.id so the
  // ad-group sync can resolve the FK without an extra query per row.
  const out = new Map<string, string>()
  let upserted = 0
  let skipped = 0
  for (const c of campaigns) {
    try {
      const existing = await prisma.campaign.findFirst({
        where: { externalCampaignId: c.campaignId, marketplace },
        select: { id: true },
      })
      const data = {
        name: c.name,
        type: c.campaignType === 'sponsoredBrands'
          ? ('SB' as const)
          : c.campaignType === 'sponsoredDisplay'
            ? ('SD' as const)
            : ('SP' as const),
        status: STATE_TO_PRISMA[c.state] ?? 'ENABLED',
        dailyBudget: c.dailyBudget,
        startDate: dateFromAmazonYmd(c.startDate) ?? new Date(),
        endDate: dateFromAmazonYmd(c.endDate),
        marketplace,
        externalCampaignId: c.campaignId,
        portfolioId: c.portfolioId ?? null,
        biddingStrategy: c.biddingStrategy
          ? BIDDING_TO_PRISMA[c.biddingStrategy] ?? 'LEGACY_FOR_SALES'
          : 'LEGACY_FOR_SALES',
        lastSyncedAt: new Date(),
        lastSyncStatus: 'SUCCESS' as const,
        lastSyncError: null,
      }
      if (existing) {
        await prisma.campaign.update({ where: { id: existing.id }, data })
        out.set(c.campaignId, existing.id)
      } else {
        const row = await prisma.campaign.create({ data })
        out.set(c.campaignId, row.id)
      }
      upserted += 1
    } catch (err) {
      logger.warn('[ads-sync] campaign upsert failed', {
        campaignId: c.campaignId,
        error: err instanceof Error ? err.message : String(err),
      })
      skipped += 1
    }
  }
  void ctx
  return { upserted, skipped, map: out }
}

async function syncAdGroupsForProfile(
  campaignMap: Map<string, string>,
  adGroups: AdsAdGroupDTO[],
): Promise<{ upserted: number; skipped: number; map: Map<string, string> }> {
  const out = new Map<string, string>()
  let upserted = 0
  let skipped = 0
  for (const ag of adGroups) {
    const campaignId = campaignMap.get(ag.campaignId)
    if (!campaignId) {
      skipped += 1
      continue
    }
    try {
      const existing = await prisma.adGroup.findFirst({
        where: { externalAdGroupId: ag.adGroupId, campaignId },
        select: { id: true },
      })
      const data = {
        campaignId,
        externalAdGroupId: ag.adGroupId,
        name: ag.name,
        defaultBidCents: Math.round((ag.defaultBid ?? 0) * 100),
        status: STATE_TO_PRISMA[ag.state] ?? 'ENABLED',
        lastSyncedAt: new Date(),
        lastSyncStatus: 'SUCCESS' as const,
        lastSyncError: null,
      }
      if (existing) {
        await prisma.adGroup.update({ where: { id: existing.id }, data })
        out.set(ag.adGroupId, existing.id)
      } else {
        const row = await prisma.adGroup.create({ data })
        out.set(ag.adGroupId, row.id)
      }
      upserted += 1
    } catch (err) {
      logger.warn('[ads-sync] adGroup upsert failed', {
        adGroupId: ag.adGroupId,
        error: err instanceof Error ? err.message : String(err),
      })
      skipped += 1
    }
  }
  return { upserted, skipped, map: out }
}

async function syncTargetsForProfile(
  adGroupMap: Map<string, string>,
  targets: AdsTargetDTO[],
): Promise<{ upserted: number; skipped: number }> {
  let upserted = 0
  let skipped = 0
  for (const t of targets) {
    const adGroupId = adGroupMap.get(t.adGroupId)
    if (!adGroupId) {
      skipped += 1
      continue
    }
    try {
      const existing = await prisma.adTarget.findFirst({
        where: { externalTargetId: t.targetId, adGroupId },
        select: { id: true },
      })
      const data = {
        adGroupId,
        externalTargetId: t.targetId,
        kind: t.kind,
        expressionType: t.expressionType,
        expressionValue: t.expressionValue,
        bidCents: Math.round((t.bid ?? 0) * 100),
        status: STATE_TO_PRISMA[t.state] ?? 'ENABLED',
        lastSyncedAt: new Date(),
        lastSyncStatus: 'SUCCESS' as const,
        lastSyncError: null,
      }
      if (existing) {
        await prisma.adTarget.update({ where: { id: existing.id }, data })
      } else {
        await prisma.adTarget.create({ data })
      }
      upserted += 1
    } catch (err) {
      logger.warn('[ads-sync] target upsert failed', {
        targetId: t.targetId,
        error: err instanceof Error ? err.message : String(err),
      })
      skipped += 1
    }
  }
  return { upserted, skipped }
}

async function syncProductAdsForProfile(
  adGroupMap: Map<string, string>,
  productAds: AdsProductAdDTO[],
): Promise<{ upserted: number; skipped: number }> {
  let upserted = 0
  let skipped = 0
  for (const pa of productAds) {
    const adGroupId = adGroupMap.get(pa.adGroupId)
    if (!adGroupId) {
      skipped += 1
      continue
    }
    try {
      // Resolve productId via ASIN match where possible. Best-effort
      // — null productId is allowed; the join is optional.
      const product = pa.asin
        ? await prisma.product.findFirst({
            where: { amazonAsin: pa.asin },
            select: { id: true },
          })
        : null
      const existing = await prisma.adProductAd.findFirst({
        where: { adGroupId, asin: pa.asin ?? null },
        select: { id: true },
      })
      const data = {
        adGroupId,
        productId: product?.id ?? null,
        asin: pa.asin ?? null,
        sku: pa.sku ?? null,
        externalAdId: pa.adId,
        status: STATE_TO_PRISMA[pa.state] ?? 'ENABLED',
        lastSyncedAt: new Date(),
      }
      if (existing) {
        await prisma.adProductAd.update({ where: { id: existing.id }, data })
      } else {
        await prisma.adProductAd.create({ data })
      }
      upserted += 1
    } catch (err) {
      logger.warn('[ads-sync] productAd upsert failed', {
        adId: pa.adId,
        error: err instanceof Error ? err.message : String(err),
      })
      skipped += 1
    }
  }
  return { upserted, skipped }
}

export async function runAdsSyncOnce(): Promise<SyncSummary> {
  const mode = adsMode()
  const profiles = await discoverActiveProfiles()
  const summary: SyncSummary = {
    profileCount: profiles.length,
    campaigns: { upserted: 0, skipped: 0 },
    adGroups: { upserted: 0, skipped: 0 },
    targets: { upserted: 0, skipped: 0 },
    productAds: { upserted: 0, skipped: 0 },
    errors: [],
    mode,
  }

  for (const profile of profiles) {
    const ctx: ClientContext = { profileId: profile.profileId, region: profile.region }
    try {
      const campaigns = await listCampaigns(ctx)
      const campaignResult = await syncCampaignsForProfile(ctx, profile.marketplace, campaigns)
      summary.campaigns.upserted += campaignResult.upserted
      summary.campaigns.skipped += campaignResult.skipped

      const adGroups = await listAdGroups(ctx)
      // Filter to ad-groups whose campaign we know locally.
      const knownCampaignAdGroups = adGroups.filter((ag) =>
        campaignResult.map.has(ag.campaignId),
      )
      const adGroupResult = await syncAdGroupsForProfile(
        campaignResult.map,
        knownCampaignAdGroups,
      )
      summary.adGroups.upserted += adGroupResult.upserted
      summary.adGroups.skipped += adGroupResult.skipped

      const targets = await listTargets(ctx)
      const targetResult = await syncTargetsForProfile(adGroupResult.map, targets)
      summary.targets.upserted += targetResult.upserted
      summary.targets.skipped += targetResult.skipped

      const productAds = await listProductAds(ctx)
      const productAdResult = await syncProductAdsForProfile(adGroupResult.map, productAds)
      summary.productAds.upserted += productAdResult.upserted
      summary.productAds.skipped += productAdResult.skipped
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      summary.errors.push(`profile ${profile.profileId}: ${msg}`)
      logger.error('[ads-sync] profile failed', { profileId: profile.profileId, error: msg })
      // Touch the connection's lastError if it's a real row (skip for
      // the synthetic sandbox profile that has no DB representation).
      if (mode === 'live') {
        await prisma.amazonAdsConnection
          .updateMany({
            where: { profileId: profile.profileId },
            data: { lastErrorAt: new Date(), lastError: msg },
          })
          .catch(() => {
            /* swallow */
          })
      }
    }
  }

  return summary
}

export function summarizeAdsSync(s: SyncSummary): string {
  return [
    `mode=${s.mode}`,
    `profiles=${s.profileCount}`,
    `campaigns=${s.campaigns.upserted}+${s.campaigns.skipped}`,
    `adGroups=${s.adGroups.upserted}+${s.adGroups.skipped}`,
    `targets=${s.targets.upserted}+${s.targets.skipped}`,
    `productAds=${s.productAds.upserted}+${s.productAds.skipped}`,
    s.errors.length > 0 ? `errors=${s.errors.length}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

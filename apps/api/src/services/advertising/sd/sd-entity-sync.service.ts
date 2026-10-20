/**
 * SD-AUD (2026-10-20) — every Sponsored Display setting Amazon holds, written onto the rows Nexus already has.
 *
 * The v1 export (ads-v1-sync.service.ts) makes the SD rows but keeps only the common model: no tactic, no ad group
 * default bid (it leaves a 50-cent placeholder), no bid optimization, no landing page, no serving status, and an audience
 * target's nested expression is lost (`expressionValue` ''). The SP settings sync reads Sponsored Products only, and SD
 * portfolio membership was never read. So Claude could not see an SD campaign's settings. This reads the five
 * `/extended` lists (sd/sd-entities.client.ts) per Ads profile and fills, for SD rows only:
 *
 *   Campaign     tactic, costType, daily budget, start and end date, state, portfolio, servingStatus
 *   AdGroup      default bid, bidOptimization, creativeType, state, servingStatus
 *   AdProductAd  state, landing page (type, URL), ad name, servingStatus; SKU / ASIN only where Nexus has none
 *   AdTarget     the expression and Amazon's resolved expression, bid (when the target has its own), state, servingStatus
 *                — negative targets too (expression, state, servingStatus)
 *
 * Direction is one-way, Amazon → Nexus; nothing is ever sent. It ENRICHES rows the export made and creates none: an
 * entity Amazon holds that Nexus has no row for is counted (`notInNexus`) and left to the export, which owns creation.
 * Scoped to the SD campaigns Nexus holds open (not ARCHIVED) in the profile's market, so a profile with no SD runs no
 * call; an archived one is read (campaign only) while its tactic or cost type is still empty.
 *
 * Like every sync from Amazon (CM-16, ads-sync-hold-back.ts): a column with an undelivered write is left out, and a row
 * that moved since it was read is skipped (`raced`) for the next run. A kept-paused target Amazon reports ENABLED is
 * alerted as the export does (waste/hold.ts). A campaign leaving its portfolio at Amazon opens a drift row first
 * (AX-VT.3, ads-portfolio.service.ts). Called by the 20-minute settings sync cron (jobs/ads-sync.job.ts).
 */
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { normalizeMarketplaceCode } from '../../../utils/marketplace-code.js'
import type { AdsRegion, ClientContext } from '../ads-api-client.js'
import { syncHoldBack, type SyncHoldBack } from '../ads-sync-hold-back.js'
import { recordMembershipLoss } from '../ads-portfolio.service.js'
import { HOLD_SELECT, keptPausedTurnedOn } from '../waste/hold.js'
import {
  listSdAdGroupsEx, listSdCampaignsEx, listSdNegativeTargetsEx, listSdProductAdsEx, listSdTargetsEx,
} from './sd-entities.client.js'

const STATE: Record<string, 'ENABLED' | 'PAUSED' | 'ARCHIVED'> = { enabled: 'ENABLED', paused: 'PAUSED', archived: 'ARCHIVED' }
const stateOf = (s: unknown) => (typeof s === 'string' ? STATE[s.toLowerCase()] : undefined)
const idOf = (v: unknown): string | null => (v == null || v === '' ? null : String(v))
/** Amazon's YYYYMMDD as the UTC midnight the export stores; null when absent or not a date. */
function dayOf(v: unknown): Date | null {
  const m = typeof v === 'string' ? /^(\d{4})(\d{2})(\d{2})$/.exec(v.trim()) : null
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null
}
const cents = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null)

export interface SdSyncCounts { read: number; updated: number; notInNexus: number }
export interface SdSyncResult {
  profiles: number
  campaigns: SdSyncCounts
  adGroups: SdSyncCounts
  productAds: SdSyncCounts
  targets: SdSyncCounts
  negativeTargets: SdSyncCounts
  /** Rows written without a column an undelivered write holds (CM-16). */
  held: number
  /** Rows skipped because they changed between this sync's read and its write. */
  raced: number
  errors: string[]
}

const counts = (): SdSyncCounts => ({ read: 0, updated: 0, notInNexus: 0 })

/** One guarded write: without the held columns, only if the row has not moved. */
async function write(
  hb: SyncHoldBack, row: { id: string; updatedAt: Date }, data: Record<string, unknown>,
  update: (where: { id: string; updatedAt: Date }, data: Record<string, unknown>) => Promise<{ count: number }>,
  c: SdSyncCounts,
): Promise<void> {
  const w = await update({ id: row.id, updatedAt: row.updatedAt }, await hb.without(row.id, row.updatedAt, data))
  if (w.count) c.updated++
  else hb.raced++
}

export async function syncSdEntitiesFromAmazon(opts: { profileId?: string } = {}): Promise<SdSyncResult> {
  const res: SdSyncResult = {
    profiles: 0, campaigns: counts(), adGroups: counts(), productAds: counts(), targets: counts(), negativeTargets: counts(),
    held: 0, raced: 0, errors: [],
  }
  const conns = await prisma.amazonAdsConnection.findMany({
    where: opts.profileId ? { profileId: opts.profileId } : { isActive: true },
    select: { profileId: true, region: true, marketplace: true },
  })
  // Open campaigns are read whole; an archived one only while Nexus lacks its tactic or cost type (one campaigns read),
  // so no SD campaign reads empty there — Nexus's own creates leave costType empty until this sync fills it.
  const held = await prisma.campaign.findMany({
    where: {
      adProduct: 'SPONSORED_DISPLAY', externalCampaignId: { not: null },
      OR: [{ status: { not: 'ARCHIVED' } }, { tactic: null }, { costType: null }],
    },
    select: { externalCampaignId: true, marketplace: true, status: true },
  })
  const hbs = {
    campaign: await syncHoldBack('CAMPAIGN'), adGroup: await syncHoldBack('AD_GROUP'),
    productAd: await syncHoldBack('PRODUCT_AD'), target: await syncHoldBack('AD_TARGET'),
  }
  for (const conn of conns) {
    const market = normalizeMarketplaceCode(conn.marketplace, conn.marketplace)
    const mine = held.filter((c) => normalizeMarketplaceCode(c.marketplace, c.marketplace ?? '') === market)
    if (!mine.length) continue
    const all = mine.map((c) => c.externalCampaignId as string)
    const ids = mine.filter((c) => c.status !== 'ARCHIVED').map((c) => c.externalCampaignId as string)
    res.profiles++
    const ctx: ClientContext = { profileId: conn.profileId, region: (conn.region === 'NA' || conn.region === 'FE' ? conn.region : 'EU') as AdsRegion }
    const step = async (what: string, work: () => Promise<void>) => {
      try { await work() } catch (e) { res.errors.push(`${what} ${market}: ${(e as Error).message.slice(0, 200)}`) }
    }
    await step('campaigns', () => syncCampaigns(ctx, all, hbs.campaign, res.campaigns))
    if (!ids.length) continue
    await step('adGroups', () => syncAdGroups(ctx, ids, hbs.adGroup, res.adGroups))
    await step('productAds', () => syncProductAds(ctx, ids, hbs.productAd, res.productAds))
    await step('targets', () => syncTargets(ctx, ids, hbs.target, res.targets, market))
    await step('negativeTargets', () => syncNegativeTargets(ctx, ids, hbs.target, res.negativeTargets))
  }
  for (const hb of Object.values(hbs)) { res.held += hb.held; res.raced += hb.raced }
  logger.info('[sd-sync] done', {
    profiles: res.profiles, campaigns: res.campaigns, adGroups: res.adGroups, productAds: res.productAds,
    targets: res.targets, negativeTargets: res.negativeTargets, held: res.held, raced: res.raced, errors: res.errors.length,
  })
  return res
}

async function syncCampaigns(ctx: ClientContext, ids: string[], hb: SyncHoldBack, c: SdSyncCounts): Promise<void> {
  const remote = await listSdCampaignsEx(ctx, ids)
  c.read += remote.length
  const locals = await prisma.campaign.findMany({
    where: { externalCampaignId: { in: remote.map((r) => String(r.campaignId)) }, adProduct: 'SPONSORED_DISPLAY' },
    select: { id: true, externalCampaignId: true, portfolioId: true, updatedAt: true },
  })
  const byExt = new Map(locals.map((l) => [l.externalCampaignId as string, l]))
  for (const r of remote) {
    const local = byExt.get(String(r.campaignId))
    if (!local) { c.notInNexus++; continue }
    const portfolioId = idOf(r.portfolioId)
    // AX-VT.3 — membership Amazon no longer reports is recorded as drift before Nexus follows it.
    if (portfolioId == null && local.portfolioId) await recordMembershipLoss([String(r.campaignId)])
    // Amazon's full object: no portfolioId is "in no portfolio", no endDate is "no end date".
    const data: Record<string, unknown> = { portfolioId, endDate: dayOf(r.endDate), settingsSyncedAt: new Date() }
    if (r.name) data.name = r.name
    if (r.tactic) data.tactic = r.tactic
    if (r.costType) data.costType = r.costType
    if (typeof r.budget === 'number') data.dailyBudget = r.budget
    const start = dayOf(r.startDate)
    if (start) data.startDate = start
    const st = stateOf(r.state)
    if (st) data.status = st
    if (r.servingStatus) data.servingStatus = r.servingStatus
    await write(hb, local, data, (where, d) => prisma.campaign.updateMany({ where, data: d }), c)
  }
}

async function syncAdGroups(ctx: ClientContext, ids: string[], hb: SyncHoldBack, c: SdSyncCounts): Promise<void> {
  const remote = await listSdAdGroupsEx(ctx, ids)
  c.read += remote.length
  const locals = await prisma.adGroup.findMany({
    where: { externalAdGroupId: { in: remote.map((r) => String(r.adGroupId)) }, campaign: { adProduct: 'SPONSORED_DISPLAY' } },
    select: { id: true, externalAdGroupId: true, updatedAt: true },
  })
  const byExt = new Map(locals.map((l) => [l.externalAdGroupId as string, l]))
  for (const r of remote) {
    const local = byExt.get(String(r.adGroupId))
    if (!local) { c.notInNexus++; continue }
    const data: Record<string, unknown> = {}
    if (r.name) data.name = r.name
    const bid = cents(r.defaultBid)
    if (bid != null) data.defaultBidCents = bid
    if (r.bidOptimization) data.bidOptimization = r.bidOptimization
    if (r.creativeType) data.creativeType = r.creativeType
    const st = stateOf(r.state)
    if (st) data.status = st
    if (r.servingStatus) data.servingStatus = r.servingStatus
    await write(hb, local, data, (where, d) => prisma.adGroup.updateMany({ where, data: d }), c)
  }
}

async function syncProductAds(ctx: ClientContext, ids: string[], hb: SyncHoldBack, c: SdSyncCounts): Promise<void> {
  const remote = await listSdProductAdsEx(ctx, ids)
  c.read += remote.length
  const locals = await prisma.adProductAd.findMany({
    where: { externalAdId: { in: remote.map((r) => String(r.adId)) }, adGroup: { campaign: { adProduct: 'SPONSORED_DISPLAY' } } },
    select: { id: true, externalAdId: true, sku: true, asin: true, updatedAt: true },
  })
  const byExt = new Map(locals.map((l) => [l.externalAdId as string, l]))
  for (const r of remote) {
    const local = byExt.get(String(r.adId))
    if (!local) { c.notInNexus++; continue }
    const data: Record<string, unknown> = {
      landingPageType: r.landingPageType ?? null,
      landingPageUrl: r.landingPageURL ?? null,
      adName: r.adName ?? null,
    }
    // The export owns SKU/ASIN (and the product link it resolves from them): filled here only where it left none.
    if (!local.sku && r.sku) data.sku = r.sku
    if (!local.asin && r.asin) data.asin = r.asin
    const st = stateOf(r.state)
    if (st) data.status = st
    if (r.servingStatus) data.servingStatus = r.servingStatus
    try {
      await write(hb, local, data, (where, d) => prisma.adProductAd.updateMany({ where, data: d }), c)
    } catch (e) {
      // The ASIN filled in may already be advertised by another row of the ad group (unique per ad group): keep the rest.
      delete data.asin
      logger.warn('[sd-sync] product ad ASIN not filled', { adId: String(r.adId), error: (e as Error).message.slice(0, 160) })
      await write(hb, local, data, (where, d) => prisma.adProductAd.updateMany({ where, data: d }), c)
    }
  }
}

async function syncTargets(ctx: ClientContext, ids: string[], hb: SyncHoldBack, c: SdSyncCounts, market: string): Promise<void> {
  const remote = await listSdTargetsEx(ctx, ids)
  c.read += remote.length
  const locals = await prisma.adTarget.findMany({
    where: { externalTargetId: { in: remote.map((r) => String(r.targetId)) }, isNegative: false, adGroup: { campaign: { adProduct: 'SPONSORED_DISPLAY' } } },
    select: { id: true, externalTargetId: true, status: true, isNegative: true, expressionValue: true, updatedAt: true, ...HOLD_SELECT, adGroup: { select: { externalAdGroupId: true } } },
  })
  const byExt = new Map(locals.map((l) => [`${l.adGroup.externalAdGroupId}|${l.externalTargetId}`, l]))
  for (const r of remote) {
    const local = byExt.get(`${idOf(r.adGroupId)}|${r.targetId}`)
    if (!local) { c.notInNexus++; continue }
    const data: Record<string, unknown> = {}
    if (r.expression) data.expressionJson = r.expression
    if (r.resolvedExpression) data.resolvedExpressionJson = r.resolvedExpression
    // A target with no bid of its own serves at its ad group's default bid: Nexus's copy is left as it is.
    const bid = cents(r.bid)
    if (bid != null) data.bidCents = bid
    const st = stateOf(r.state)
    if (st) {
      data.status = st
      // A kept-paused target switched on at Amazon is shown and alerted, as the export does (Negative Targeting review M3).
      await keptPausedTurnedOn(local, st, market)
    }
    if (r.servingStatus) data.servingStatus = r.servingStatus
    await write(hb, local, data, (where, d) => prisma.adTarget.updateMany({ where, data: d }), c)
  }
}

async function syncNegativeTargets(ctx: ClientContext, ids: string[], hb: SyncHoldBack, c: SdSyncCounts): Promise<void> {
  const remote = await listSdNegativeTargetsEx(ctx, ids)
  c.read += remote.length
  const locals = await prisma.adTarget.findMany({
    where: { externalTargetId: { in: remote.map((r) => String(r.targetId)) }, isNegative: true, adGroup: { campaign: { adProduct: 'SPONSORED_DISPLAY' } } },
    select: { id: true, externalTargetId: true, updatedAt: true, adGroup: { select: { externalAdGroupId: true } } },
  })
  const byExt = new Map(locals.map((l) => [`${l.adGroup.externalAdGroupId}|${l.externalTargetId}`, l]))
  for (const r of remote) {
    const local = byExt.get(`${idOf(r.adGroupId)}|${r.targetId}`)
    if (!local) { c.notInNexus++; continue }
    const data: Record<string, unknown> = {}
    if (r.expression) data.expressionJson = r.expression
    const st = stateOf(r.state)
    if (st) data.status = st
    if (r.servingStatus) data.servingStatus = r.servingStatus
    await write(hb, local, data, (where, d) => prisma.adTarget.updateMany({ where, data: d }), c)
  }
}

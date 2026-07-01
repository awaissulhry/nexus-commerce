/**
 * AX.4 — Amazon Ads CREATE service (campaigns / ad groups / keywords /
 * product ads). Local-first: writes the local Prisma row immediately
 * (so the cockpit reflects it), and — when the write gate allows — calls
 * the v3 SP POST create and stores the returned external id. Sandbox
 * short-circuits inside ads-api-client (returns a generated sb- id), so
 * the full flow exercises end-to-end without touching the live account.
 * Every create writes an AdvertisingActionLog audit row.
 *
 * Creates intentionally skip the 5-min grace window (unlike updates) — a
 * created entity has no "previous value" to revert to; the local row is
 * the source of truth and a follow-up pause/archive handles unwind.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import {
  createCampaign, createAdGroup, createKeyword, createProductAd,
  createTarget, createNegativeProductTarget, createNegativeKeyword, createSdTarget, createSbAd, updateCampaign,
  type AdsRegion,
} from './ads-api-client.js'
import { checkAdsWriteGate } from './ads-write-gate.js'

async function resolveCtx(marketplace: string): Promise<{ profileId: string; region: AdsRegion } | null> {
  const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace, isActive: true }, select: { profileId: true, region: true } })
  return conn ? { profileId: conn.profileId, region: (conn.region as AdsRegion) ?? 'EU' } : null
}

async function audit(actionType: string, entityType: string, entityId: string, payloadAfter: object, userId?: string, payloadBefore: object = {}) {
  await prisma.advertisingActionLog.create({
    data: { userId: userId ?? null, actionType, entityType, entityId, payloadBefore, payloadAfter, amazonResponseStatus: 'SUCCESS' },
  }).catch(() => {})
}

export interface NewCampaign {
  name: string; type: 'SP' | 'SB' | 'SD'; marketplace: string
  targetingType?: 'MANUAL' | 'AUTO'; dailyBudgetEur: number
  biddingStrategy?: 'legacyForSales' | 'autoForSales' | 'manual'; portfolioId?: string; userId?: string
}
export async function createCampaignLocal(input: NewCampaign): Promise<{ id: string; externalCampaignId: string | null; mode: string }> {
  const ctx = await resolveCtx(input.marketplace)
  let externalId: string | null = null, mode = 'local'
  if (ctx) {
    const gate = await checkAdsWriteGate({ marketplace: input.marketplace, payloadValueCents: Math.round(input.dailyBudgetEur * 100) })
    if (gate.allowed) {
      const r = await createCampaign(ctx, { name: input.name, targetingType: input.targetingType ?? 'MANUAL', dailyBudget: input.dailyBudgetEur, biddingStrategy: input.biddingStrategy, state: 'enabled' })
      externalId = r.externalId; mode = r.mode
    }
  }
  const adProduct = { SP: 'SPONSORED_PRODUCTS', SB: 'SPONSORED_BRANDS', SD: 'SPONSORED_DISPLAY' }[input.type]
  const campaign = await prisma.campaign.create({
    data: {
      name: input.name, type: input.type, adProduct, status: 'ENABLED', marketplace: input.marketplace,
      externalCampaignId: externalId, dailyBudget: input.dailyBudgetEur, biddingStrategy: (input.biddingStrategy === 'autoForSales' ? 'AUTO_FOR_SALES' : input.biddingStrategy === 'manual' ? 'MANUAL' : 'LEGACY_FOR_SALES'),
      portfolioId: input.portfolioId || null,
      startDate: new Date(), lastSyncStatus: externalId ? 'SUCCESS' : 'PENDING',
    },
  })
  await audit('create_campaign', 'CAMPAIGN', campaign.id, { name: input.name, externalId, mode }, input.userId)
  logger.info('[AX.4] createCampaignLocal', { id: campaign.id, externalId, mode })
  return { id: campaign.id, externalCampaignId: externalId, mode }
}

export interface NewAdGroup { campaignId: string; name: string; defaultBidEur: number; userId?: string }
export async function createAdGroupLocal(input: NewAdGroup): Promise<{ id: string; externalAdGroupId: string | null }> {
  const campaign = await prisma.campaign.findUnique({ where: { id: input.campaignId }, select: { externalCampaignId: true, marketplace: true } })
  if (!campaign) throw new Error('campaign not found')
  let externalId: string | null = null
  if (campaign.externalCampaignId && campaign.marketplace) {
    const ctx = await resolveCtx(campaign.marketplace)
    if (ctx) {
      const gate = await checkAdsWriteGate({ marketplace: campaign.marketplace, payloadValueCents: Math.round(input.defaultBidEur * 100) })
      if (gate.allowed) { const r = await createAdGroup(ctx, { externalCampaignId: campaign.externalCampaignId, name: input.name, defaultBid: input.defaultBidEur, state: 'enabled' }); externalId = r.externalId }
    }
  }
  const ag = await prisma.adGroup.create({ data: { campaignId: input.campaignId, name: input.name, defaultBidCents: Math.round(input.defaultBidEur * 100), status: 'ENABLED', externalAdGroupId: externalId } })
  await audit('create_ad_group', 'AD_GROUP', ag.id, { name: input.name, externalId }, input.userId)
  return { id: ag.id, externalAdGroupId: externalId }
}

export interface NewKeyword { adGroupId: string; keywordText: string; matchType: 'EXACT' | 'PHRASE' | 'BROAD'; bidEur: number; userId?: string }
export async function createKeywordLocal(input: NewKeyword): Promise<{ id: string; externalTargetId: string | null }> {
  const ag = await prisma.adGroup.findUnique({ where: { id: input.adGroupId }, select: { externalAdGroupId: true, campaign: { select: { externalCampaignId: true, marketplace: true } } } })
  if (!ag) throw new Error('ad group not found')
  // H.1 — idempotent. A positive keyword is uniquely identified by (ad group, match type, text).
  // Harvest rules run on a schedule and re-surface the same converting term every tick; return the
  // existing target instead of piling up duplicate rows (Amazon rejects the dup keyword too). Text
  // match is case-insensitive because Amazon keyword matching is.
  const existing = await prisma.adTarget.findFirst({
    where: { adGroupId: input.adGroupId, kind: 'KEYWORD', isNegative: false, expressionType: input.matchType, expressionValue: { equals: input.keywordText, mode: 'insensitive' } },
    select: { id: true, externalTargetId: true },
  })
  if (existing) return { id: existing.id, externalTargetId: existing.externalTargetId }
  let externalId: string | null = null
  if (ag.externalAdGroupId && ag.campaign?.externalCampaignId && ag.campaign.marketplace) {
    const ctx = await resolveCtx(ag.campaign.marketplace)
    if (ctx) {
      const gate = await checkAdsWriteGate({ marketplace: ag.campaign.marketplace, payloadValueCents: Math.round(input.bidEur * 100) })
      if (gate.allowed) { const r = await createKeyword(ctx, { externalCampaignId: ag.campaign.externalCampaignId, externalAdGroupId: ag.externalAdGroupId, keywordText: input.keywordText, matchType: input.matchType, bid: input.bidEur, state: 'enabled' }); externalId = r.externalId }
    }
  }
  const t = await prisma.adTarget.create({ data: { adGroupId: input.adGroupId, kind: 'KEYWORD', expressionType: input.matchType, expressionValue: input.keywordText, bidCents: Math.round(input.bidEur * 100), status: 'ENABLED', externalTargetId: externalId } })
  await audit('create_keyword', 'AD_TARGET', t.id, { keywordText: input.keywordText, matchType: input.matchType, externalId }, input.userId)
  return { id: t.id, externalTargetId: externalId }
}

export interface NewProductAd { adGroupId: string; sku?: string; asin?: string; productId?: string; userId?: string }
export async function createProductAdLocal(input: NewProductAd): Promise<{ id: string; externalAdId: string | null }> {
  const ag = await prisma.adGroup.findUnique({ where: { id: input.adGroupId }, select: { externalAdGroupId: true, campaign: { select: { externalCampaignId: true, marketplace: true } } } })
  if (!ag) throw new Error('ad group not found')
  let externalId: string | null = null
  if (ag.externalAdGroupId && ag.campaign?.externalCampaignId && ag.campaign.marketplace) {
    const ctx = await resolveCtx(ag.campaign.marketplace)
    if (ctx) {
      const gate = await checkAdsWriteGate({ marketplace: ag.campaign.marketplace, payloadValueCents: 0 })
      if (gate.allowed) { const r = await createProductAd(ctx, { externalCampaignId: ag.campaign.externalCampaignId, externalAdGroupId: ag.externalAdGroupId, sku: input.sku, asin: input.asin, state: 'enabled' }); externalId = r.externalId }
    }
  }
  const ad = await prisma.adProductAd.create({ data: { adGroupId: input.adGroupId, asin: input.asin ?? null, sku: input.sku ?? null, productId: input.productId ?? null, status: 'ENABLED', externalAdId: externalId } })
  await audit('create_product_ad', 'PRODUCT_AD', ad.id, { sku: input.sku, asin: input.asin, externalId }, input.userId)
  return { id: ad.id, externalAdId: externalId }
}

// LAUNCH-REPAIR — push a campaign's EXISTING local structure (ad group → keywords/auto targets →
// product ads) to Amazon. Fixes campaigns whose sub-entities were saved locally but never pushed
// (e.g. the campaign wasn't allowlisted at launch, so the write-gate skipped them → empty on
// Amazon = "not eligible, no keyword and no ad"). Idempotent: only pushes rows with a null
// external id and reuses the existing local rows — never duplicates. Campaign must be allowlisted.
export async function pushCampaignStructure(campaignId: string): Promise<{ ok: boolean; adGroups: number; keywords: number; targets: number; productAds: number; errors: string[] }> {
  const out = { ok: true, adGroups: 0, keywords: 0, targets: 0, productAds: 0, errors: [] as string[] }
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { externalCampaignId: true, marketplace: true, adProduct: true } })
  if (!campaign?.externalCampaignId || !campaign.marketplace) { out.ok = false; out.errors.push('campaign missing externalCampaignId/marketplace'); return out }
  const ctx = await resolveCtx(campaign.marketplace)
  if (!ctx) { out.ok = false; out.errors.push('no connection for ' + campaign.marketplace); return out }
  const gate = await checkAdsWriteGate({ marketplace: campaign.marketplace, payloadValueCents: 0, campaignId })
  if (!gate.allowed) { out.ok = false; out.errors.push('write-gate closed — allowlist the campaign first'); return out }
  const extC = campaign.externalCampaignId
  const isSd = campaign.adProduct === 'SPONSORED_DISPLAY'
  const adGroups = await prisma.adGroup.findMany({ where: { campaignId } })
  for (const ag of adGroups) {
    let extAg = ag.externalAdGroupId
    // Amazon rejects the `·` middle-dot (U+00B7) in ad group names (same constraint as portfolio
    // names) — it silently drops the item into the error array so no adGroupId comes back. Sanitize.
    const safeName = ag.name.replace(/\s*·\s*/g, ' - ')
    if (!extAg) {
      try {
        const r = await createAdGroup(ctx, { externalCampaignId: extC, name: safeName, defaultBid: (ag.defaultBidCents ?? 75) / 100, state: 'enabled' })
        extAg = r.externalId
        await prisma.adGroup.update({ where: { id: ag.id }, data: { externalAdGroupId: extAg, name: safeName, lastSyncStatus: extAg ? 'SUCCESS' : 'FAILED' } })
        if (extAg) out.adGroups++
        else out.errors.push('adGroup "' + safeName + '": no external id — ' + JSON.stringify(r.rawResponse).slice(0, 300))
      } catch (e) { out.errors.push('adGroup "' + safeName + '": ' + ((e as Error)?.message || '')); continue }
    }
    if (!extAg) continue
    const targets = await prisma.adTarget.findMany({ where: { adGroupId: ag.id, isNegative: false, externalTargetId: null } })
    for (const t of targets) {
      // Amazon auto-generates the 4 auto-targeting clauses when an ad group is created in an AUTO
      // campaign — POST /sp/targets rejects expressionType AUTO. Skip (they already exist on Amazon).
      if (t.kind === 'AUTO') continue
      const bid = (t.bidCents ?? 75) / 100
      try {
        let extId: string | null = null
        if (t.kind === 'KEYWORD') {
          const r = await createKeyword(ctx, { externalCampaignId: extC, externalAdGroupId: extAg, keywordText: t.expressionValue ?? '', matchType: (t.expressionType as 'EXACT' | 'PHRASE' | 'BROAD') || 'BROAD', bid, state: 'enabled' })
          extId = r.externalId; if (extId) out.keywords++
          else out.errors.push('keyword "' + (t.expressionValue || '') + '": ' + JSON.stringify(r.rawResponse).slice(0, 200))
        } else {
          const expression = [{ type: 'ASIN_SAME_AS', value: t.expressionValue ?? '' }]
          const r = isSd
            ? await createSdTarget(ctx, { externalCampaignId: extC, externalAdGroupId: extAg, expression, bid, state: 'enabled' })
            : await createTarget(ctx, { externalCampaignId: extC, externalAdGroupId: extAg, expression, expressionType: 'MANUAL', bid, state: 'enabled' })
          extId = r.externalId; if (extId) out.targets++
          else out.errors.push('target "' + (t.expressionValue || '') + '": ' + JSON.stringify(r.rawResponse).slice(0, 200))
        }
        if (extId) await prisma.adTarget.update({ where: { id: t.id }, data: { externalTargetId: extId } })
      } catch (e) { out.errors.push('target "' + (t.expressionValue || '') + '": ' + ((e as Error)?.message || '')) }
    }
    const productAds = await prisma.adProductAd.findMany({ where: { adGroupId: ag.id, externalAdId: null } })
    for (const pa of productAds) {
      try {
        const r = await createProductAd(ctx, { externalCampaignId: extC, externalAdGroupId: extAg, sku: pa.sku ?? undefined, asin: pa.asin ?? undefined, state: 'enabled' })
        if (r.externalId) { await prisma.adProductAd.update({ where: { id: pa.id }, data: { externalAdId: r.externalId } }); out.productAds++ }
        else out.errors.push('productAd "' + (pa.asin || pa.sku || '') + '": ' + JSON.stringify(r.rawResponse).slice(0, 200))
      } catch (e) { out.errors.push('productAd "' + (pa.asin || pa.sku || '') + '": ' + ((e as Error)?.message || '')) }
    }
  }
  logger.info('[LAUNCH-REPAIR] pushCampaignStructure', { campaignId, ...out })
  return out
}

// ── AX2.1 — Product / category / auto targeting ─────────────────────────
// Amazon SP product-targeting expressions. AUTO targets are the four
// auto-campaign clauses (close-match / loose-match / substitutes /
// complements). PRODUCT = a specific ASIN; CATEGORY = a browse-node category
// (optionally refined by brand/price/rating — kept simple here: the node id).
const AUTO_EXPRESSION: Record<string, string> = {
  CLOSE_MATCH: 'queryHighRelMatches', LOOSE_MATCH: 'queryBroadRelMatches',
  SUBSTITUTES: 'asinSubstituteRelated', COMPLEMENTS: 'asinAccessoryRelated',
}
// SD audience expression builder. VIEWS/PURCHASES = remarketing lookback on
// a product/category; AUDIENCE = an Amazon-built audience (in-market /
// lifestyle / interests) by audienceId.
const AUDIENCE_EXPRESSION: Record<string, (v: string) => Array<{ type: string; value?: string }>> = {
  VIEWS_REMARKETING: (v) => [{ type: 'views', value: v }],
  PURCHASES_REMARKETING: (v) => [{ type: 'purchases', value: v }],
  AUDIENCE: (v) => [{ type: 'audience', value: v }],
}
export interface NewTarget {
  adGroupId: string
  kind: 'PRODUCT' | 'CATEGORY' | 'AUTO' | 'AUDIENCE'
  // PRODUCT → an ASIN; CATEGORY → a browse-node id; AUTO → one of AUTO_EXPRESSION keys;
  // AUDIENCE → audienceId (or product/category for remarketing), with audienceType set.
  value: string
  audienceType?: 'VIEWS_REMARKETING' | 'PURCHASES_REMARKETING' | 'AUDIENCE'
  bidEur: number; state?: 'enabled' | 'paused'; userId?: string
}
export async function createTargetLocal(input: NewTarget): Promise<{ id: string; externalTargetId: string | null; mode: string }> {
  const ag = await prisma.adGroup.findUnique({ where: { id: input.adGroupId }, select: { externalAdGroupId: true, campaign: { select: { externalCampaignId: true, marketplace: true, adProduct: true } } } })
  if (!ag) throw new Error('ad group not found')
  // H.5 — idempotent (mirror H.1): a positive target is identified by ad group + kind + value, so a
  // scheduled product/auto harvest re-run returns the existing target instead of duplicating it.
  const dupe = await prisma.adTarget.findFirst({ where: { adGroupId: input.adGroupId, kind: input.kind, isNegative: false, expressionValue: input.value }, select: { id: true, externalTargetId: true } })
  if (dupe) return { id: dupe.id, externalTargetId: dupe.externalTargetId, mode: 'local' }
  const isAudience = input.kind === 'AUDIENCE'
  const audType = input.audienceType ?? 'AUDIENCE'
  const expression = input.kind === 'PRODUCT'
    ? [{ type: 'asinSameAs', value: input.value }]
    : input.kind === 'CATEGORY'
      ? [{ type: 'asinCategorySameAs', value: input.value }]
      : isAudience
        ? (AUDIENCE_EXPRESSION[audType] ?? AUDIENCE_EXPRESSION.AUDIENCE)(input.value)
        : [{ type: AUTO_EXPRESSION[input.value] ?? input.value }]
  const expressionType = input.kind === 'PRODUCT' ? 'ASIN' : input.kind === 'CATEGORY' ? 'CATEGORY' : isAudience ? audType : 'AUTO'
  let externalId: string | null = null, mode = 'local'
  if (ag.externalAdGroupId && ag.campaign?.externalCampaignId && ag.campaign.marketplace) {
    const ctx = await resolveCtx(ag.campaign.marketplace)
    if (ctx) {
      const gate = await checkAdsWriteGate({ marketplace: ag.campaign.marketplace, payloadValueCents: Math.round(input.bidEur * 100) })
      if (gate.allowed) {
        const r = isAudience || ag.campaign.adProduct === 'SPONSORED_DISPLAY'
          ? await createSdTarget(ctx, { externalCampaignId: ag.campaign.externalCampaignId, externalAdGroupId: ag.externalAdGroupId, expression, bid: input.bidEur, state: input.state ?? 'enabled' })
          : await createTarget(ctx, { externalCampaignId: ag.campaign.externalCampaignId, externalAdGroupId: ag.externalAdGroupId, expression, expressionType: input.kind === 'AUTO' ? 'AUTO' : 'MANUAL', bid: input.bidEur, state: input.state ?? 'enabled' })
        externalId = r.externalId; mode = r.mode
      }
    }
  }
  const t = await prisma.adTarget.create({ data: { adGroupId: input.adGroupId, kind: input.kind, expressionType, expressionValue: input.value, bidCents: Math.round(input.bidEur * 100), status: input.state === 'paused' ? 'PAUSED' : 'ENABLED', externalTargetId: externalId } })
  await audit('create_target', 'AD_TARGET', t.id, { kind: input.kind, value: input.value, externalId, mode }, input.userId)
  logger.info('[AX2.1] createTargetLocal', { id: t.id, kind: input.kind, externalId, mode })
  return { id: t.id, externalTargetId: externalId, mode }
}

// ── AX2.9 — Sponsored Brands creative (brand headline + logo + ASINs +
// landing). Stored in AdProductAd.creativeJson (adType BRAND_AD); the full
// envelope is sent to SB v4 /sb/ads behind the write gate. ───────────────
export interface NewSbAd {
  adGroupId: string
  brandName: string; headline: string; logoAssetId?: string
  creativeType?: 'productCollection' | 'storeSpotlight' | 'video'
  landingType?: 'store' | 'productList' | 'url'; landingUrl?: string
  asins: string[]; userId?: string
}
export async function createSbAdLocal(input: NewSbAd): Promise<{ id: string; externalAdId: string | null; mode: string }> {
  const ag = await prisma.adGroup.findUnique({ where: { id: input.adGroupId }, select: { externalAdGroupId: true, campaign: { select: { externalCampaignId: true, marketplace: true } } } })
  if (!ag) throw new Error('ad group not found')
  const asins = input.asins.map((a) => a.trim()).filter(Boolean)
  if (asins.length === 0) throw new Error('at least one ASIN required')
  const creativeType = input.creativeType ?? 'productCollection'
  const landingType = input.landingType ?? 'productList'
  let externalId: string | null = null, mode = 'local'
  if (ag.externalAdGroupId && ag.campaign?.externalCampaignId && ag.campaign.marketplace) {
    const ctx = await resolveCtx(ag.campaign.marketplace)
    if (ctx) {
      const gate = await checkAdsWriteGate({ marketplace: ag.campaign.marketplace, payloadValueCents: 0 })
      if (gate.allowed) {
        const r = await createSbAd(ctx, { externalCampaignId: ag.campaign.externalCampaignId, externalAdGroupId: ag.externalAdGroupId, brandName: input.brandName, headline: input.headline, logoAssetId: input.logoAssetId, creativeType, landingType, landingUrl: input.landingUrl, asins, state: 'enabled' })
        externalId = r.externalId; mode = r.mode
      }
    }
  }
  const creativeJson = { brandName: input.brandName, headline: input.headline, logoAssetId: input.logoAssetId ?? null, creativeType, landingType, landingUrl: input.landingUrl ?? null, asins }
  const ad = await prisma.adProductAd.create({ data: { adGroupId: input.adGroupId, asin: asins[0], status: 'ENABLED', externalAdId: externalId, adType: 'BRAND_AD', creativeJson: creativeJson as never } })
  await audit('create_sb_ad', 'PRODUCT_AD', ad.id, { ...creativeJson, externalId, mode }, input.userId)
  logger.info('[AX2.9] createSbAdLocal', { id: ad.id, externalId, mode, asins: asins.length })
  return { id: ad.id, externalAdId: externalId, mode }
}

// ── AX2.2 — placement bid adjustments (top-of-search / product-pages /
// rest-of-search), stored in Campaign.dynamicBidding JSON + pushed to
// Amazon's dynamicBidding.placementBidding behind the write gate. ───────
export interface PlacementBiddingInput {
  campaignId: string
  adjustments: Array<{ placement: string; percentage: number }>
  biddingStrategy?: 'legacyForSales' | 'autoForSales' | 'manual'
  userId?: string
}
export async function updatePlacementBidding(input: PlacementBiddingInput): Promise<{ ok: boolean; adjustments: Array<{ placement: string; percentage: number }>; mode: string }> {
  const c = await prisma.campaign.findUnique({ where: { id: input.campaignId }, select: { externalCampaignId: true, marketplace: true, dynamicBidding: true } })
  if (!c) throw new Error('campaign not found')
  const adjustments = input.adjustments
    .filter((a) => a.placement)
    .map((a) => ({ placement: a.placement, percentage: Math.max(0, Math.min(900, Math.round(a.percentage))) }))
  // D1 — snapshot the prior placement bias so a mis-firing change can be rolled back.
  const priorAdjustments = ((c.dynamicBidding as { placementBidding?: Array<{ placement: string; percentage: number }> })?.placementBidding) ?? []
  const db = { ...((c.dynamicBidding as Record<string, unknown>) ?? {}), placementBidding: adjustments }
  let mode = 'local'
  // AR — placement writes go inline (not via the queued+stamped worker path), so a
  // failed push to Amazon was previously invisible AND unrecoverable. Stamp the
  // campaign with the push outcome so a failure is observable on lastSyncStatus and
  // the auto-reconcile sweep can re-push it. Only stamp on a real live attempt.
  let syncStamp: { lastSyncedAt: Date; lastSyncStatus: 'SUCCESS' | 'FAILED'; lastSyncError: string | null } | null = null
  if (c.externalCampaignId && c.marketplace) {
    const ctx = await resolveCtx(c.marketplace)
    if (ctx) {
      // C1 — pass campaignId so placement writes honour the SAME per-campaign live-write allowlist
      // as every bid write (previously omitted → placement bias bypassed the allowlist entirely).
      const gate = await checkAdsWriteGate({ marketplace: c.marketplace, campaignId: input.campaignId, payloadValueCents: 0 })
      if (!gate.allowed) {
        logger.warn('[AX2.2] placement write gated', { campaignId: input.campaignId, reason: (gate as { reason?: string }).reason })
      } else {
        const r = await updateCampaign(ctx, c.externalCampaignId, { placementBidding: adjustments, biddingStrategy: input.biddingStrategy })
        mode = r.mode
        if (r.mode !== 'sandbox') {
          syncStamp = { lastSyncedAt: new Date(), lastSyncStatus: r.ok ? 'SUCCESS' : 'FAILED', lastSyncError: r.ok ? null : (r.error ?? 'placement push failed') }
        }
      }
    }
  }
  await prisma.campaign.update({ where: { id: input.campaignId }, data: { dynamicBidding: db as never, ...(syncStamp ?? {}), ...(input.biddingStrategy ? { biddingStrategy: input.biddingStrategy === 'autoForSales' ? 'AUTO_FOR_SALES' : input.biddingStrategy === 'manual' ? 'MANUAL' : 'LEGACY_FOR_SALES' } : {}) } })
  await audit('update_placement_bidding', 'CAMPAIGN', input.campaignId, { adjustments, mode }, input.userId, { adjustments: priorAdjustments })
  logger.info('[AX2.2] updatePlacementBidding', { campaignId: input.campaignId, adjustments, mode })
  return { ok: true, adjustments, mode }
}

export interface NewNegativeProductTarget { adGroupId: string; asin: string; userId?: string }
export async function createNegativeProductTargetLocal(input: NewNegativeProductTarget): Promise<{ id: string; externalTargetId: string | null; mode: string }> {
  const ag = await prisma.adGroup.findUnique({ where: { id: input.adGroupId }, select: { externalAdGroupId: true, campaign: { select: { externalCampaignId: true, marketplace: true } } } })
  if (!ag) throw new Error('ad group not found')
  // H.5 — idempotent: a negative product target is identified by ad group + ASIN.
  const dupe = await prisma.adTarget.findFirst({ where: { adGroupId: input.adGroupId, kind: 'PRODUCT', isNegative: true, expressionValue: input.asin }, select: { id: true, externalTargetId: true } })
  if (dupe) return { id: dupe.id, externalTargetId: dupe.externalTargetId, mode: 'local' }
  let externalId: string | null = null, mode = 'local'
  if (ag.externalAdGroupId && ag.campaign?.externalCampaignId && ag.campaign.marketplace) {
    const ctx = await resolveCtx(ag.campaign.marketplace)
    if (ctx) {
      const gate = await checkAdsWriteGate({ marketplace: ag.campaign.marketplace, payloadValueCents: 0 })
      if (gate.allowed) { const r = await createNegativeProductTarget(ctx, { externalCampaignId: ag.campaign.externalCampaignId, externalAdGroupId: ag.externalAdGroupId, asin: input.asin, state: 'enabled' }); externalId = r.externalId; mode = r.mode }
    }
  }
  const t = await prisma.adTarget.create({ data: { adGroupId: input.adGroupId, kind: 'PRODUCT', expressionType: 'ASIN', expressionValue: input.asin, bidCents: 0, status: 'ENABLED', externalTargetId: externalId, isNegative: true, negativeLevel: 'AD_GROUP' } })
  await audit('create_negative_product_target', 'AD_TARGET', t.id, { asin: input.asin, externalId, mode }, input.userId)
  return { id: t.id, externalTargetId: externalId, mode }
}

// NT.4 — ad-group-level negative keyword (the funnel + Auto-isolation writes), match-typed.
export interface NewNegativeKeyword { adGroupId: string; keywordText: string; matchType: 'EXACT' | 'PHRASE'; userId?: string }
export async function createNegativeKeywordLocal(input: NewNegativeKeyword): Promise<{ id: string; externalTargetId: string | null; mode: string }> {
  const ag = await prisma.adGroup.findUnique({ where: { id: input.adGroupId }, select: { externalAdGroupId: true, campaign: { select: { externalCampaignId: true, marketplace: true } } } })
  if (!ag) throw new Error('ad group not found')
  let externalId: string | null = null, mode = 'local'
  if (ag.externalAdGroupId && ag.campaign?.externalCampaignId && ag.campaign.marketplace) {
    const ctx = await resolveCtx(ag.campaign.marketplace)
    if (ctx) {
      const gate = await checkAdsWriteGate({ marketplace: ag.campaign.marketplace, payloadValueCents: 0 })
      if (gate.allowed) { const r = await createNegativeKeyword(ctx, { externalCampaignId: ag.campaign.externalCampaignId, externalAdGroupId: ag.externalAdGroupId, keywordText: input.keywordText, matchType: input.matchType, state: 'enabled' }); externalId = r.externalId; mode = r.mode }
    }
  }
  const t = await prisma.adTarget.create({ data: { adGroupId: input.adGroupId, kind: 'KEYWORD', expressionType: input.matchType, expressionValue: input.keywordText, bidCents: 0, status: 'ENABLED', externalTargetId: externalId, isNegative: true, negativeLevel: 'AD_GROUP' } })
  await audit('create_negative_keyword', 'AD_TARGET', t.id, { keywordText: input.keywordText, matchType: input.matchType, externalId, mode }, input.userId)
  return { id: t.id, externalTargetId: externalId, mode }
}

// H.7 — persist a CAMPAIGN-scope negative keyword as a local mirror row so our platform reflects it
// immediately (gated-local), matching how the sync stores campaign negatives: AdTarget with
// negativeLevel='CAMPAIGN' + expressionType='NEGATIVE_<mt>', attached to a representative ad group of
// the campaign (the schema's legacy campaign-negative structure). The Amazon push is done separately
// by createNegative (so its existsLocally probe — which matches this exact shape — keeps the first
// push unblocked and dedupes subsequent runs). Idempotent + matches createNegative's probe precisely.
export async function createNegativeKeywordCampaignLocal(input: { externalCampaignId: string; keywordText: string; matchType: 'EXACT' | 'PHRASE'; externalTargetId?: string | null; userId?: string }): Promise<{ id: string; created: boolean } | null> {
  const camp = await prisma.campaign.findFirst({ where: { externalCampaignId: input.externalCampaignId }, select: { id: true, adGroups: { select: { id: true }, take: 1 } } })
  if (!camp || camp.adGroups.length === 0) return null // no ad group to attach the campaign-level negative to
  const expressionType = `NEGATIVE_${input.matchType}`
  const existing = await prisma.adTarget.findFirst({
    where: { adGroup: { campaignId: camp.id }, isNegative: true, negativeLevel: 'CAMPAIGN', expressionType, expressionValue: input.keywordText },
    select: { id: true },
  })
  if (existing) return { id: existing.id, created: false }
  const t = await prisma.adTarget.create({ data: { adGroupId: camp.adGroups[0].id, kind: 'KEYWORD', expressionType, expressionValue: input.keywordText, bidCents: 0, status: 'ENABLED', isNegative: true, negativeLevel: 'CAMPAIGN', externalTargetId: input.externalTargetId ?? null } })
  await audit('create_negative_keyword', 'AD_TARGET', t.id, { keywordText: input.keywordText, matchType: input.matchType, scope: 'CAMPAIGN', externalTargetId: input.externalTargetId ?? null }, input.userId)
  return { id: t.id, created: true }
}

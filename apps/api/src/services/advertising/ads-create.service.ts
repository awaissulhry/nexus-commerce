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
  listNegativeKeywords, listAdGroupsV3, listCampaignsServing, listCampaignsV3,
  type AdsRegion,
} from './ads-api-client.js'
import { checkAdsWriteGate } from './ads-write-gate.js'

async function resolveCtx(marketplace: string): Promise<{ profileId: string; region: AdsRegion } | null> {
  const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace, isActive: true }, select: { profileId: true, region: true } })
  return conn ? { profileId: conn.profileId, region: (conn.region as AdsRegion) ?? 'EU' } : null
}

/**
 * HX.1 — the audit row for a local ads operation.
 *
 * `status` used to be hardcoded 'SUCCESS'. That was wrong for any caller that pushes to Amazon
 * inline and can observe the push failing — most visibly updatePlacementBidding, which computes
 * `lastSyncStatus: 'FAILED'` and then logged the same write as a success. Every audit row is read
 * downstream as evidence that a change landed, so a hardcoded SUCCESS is worse than no row at all.
 *
 * Callers that only touch local state keep the default; callers that attempt a live push pass what
 * actually happened.
 */
async function audit(actionType: string, entityType: string, entityId: string, payloadAfter: object, userId?: string, payloadBefore: object = {}, status: 'SUCCESS' | 'FAILED' | 'PENDING' = 'SUCCESS') {
  await prisma.advertisingActionLog.create({
    data: { userId: userId ?? null, actionType, entityType, entityId, payloadBefore, payloadAfter, amazonResponseStatus: status },
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
      // AX-VT.1 — portfolioId travels with the create. It used to be collected by
      // every builder, stored on the local row below, and dropped right here.
      const r = await createCampaign(ctx, { name: input.name, targetingType: input.targetingType ?? 'MANUAL', dailyBudget: input.dailyBudgetEur, biddingStrategy: input.biddingStrategy, state: 'enabled', portfolioId: input.portfolioId })
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

/**
 * Find the seller SKU an SP product ad actually needs.
 *
 * **A Sponsored Products ad is created from a merchant SKU, not an ASIN.** Send
 * only an ASIN and Amazon answers 200 with an empty `success` array — no id, no
 * error, nothing thrown. Every caller that trusted that call therefore stored a
 * local row with a null external id and reported it as created. That is how a
 * replication reported 200 product ads while ZERO of them existed on Amazon, and
 * the ten campaigns it created could not serve a single impression.
 *
 * The identifier can arrive as either kind, because the campaign builders put
 * `asin || sku` into one flat list — so a product with no ASIN carries its SKU
 * in the ASIN field. Both are resolved here rather than at each call site.
 */
export async function resolveSellerSku(
  input: { sku?: string | null; asin?: string | null },
): Promise<{ sku: string; asin: string | null } | null> {
  if (input.sku) return { sku: input.sku, asin: input.asin ?? null }
  const value = input.asin
  if (!value) return null
  // Prefer FBA when one ASIN has several offers — that is the offer these
  // campaigns advertise.
  const byAsin = await prisma.product.findFirst({
    where: { amazonAsin: value, fulfillmentMethod: 'FBA' }, select: { sku: true, amazonAsin: true }, orderBy: { sku: 'asc' },
  }) ?? await prisma.product.findFirst({
    where: { amazonAsin: value }, select: { sku: true, amazonAsin: true }, orderBy: { sku: 'asc' },
  })
  if (byAsin) return { sku: byAsin.sku, asin: byAsin.amazonAsin ?? value }
  // The value is already a seller SKU (a product with no ASIN of its own).
  const bySku = await prisma.product.findFirst({ where: { sku: value }, select: { sku: true, amazonAsin: true } })
  if (bySku) return { sku: bySku.sku, asin: bySku.amazonAsin ?? null }
  return null
}

export async function createProductAdLocal(input: NewProductAd): Promise<{ id: string; externalAdId: string | null }> {
  const ag = await prisma.adGroup.findUnique({ where: { id: input.adGroupId }, select: { externalAdGroupId: true, campaign: { select: { externalCampaignId: true, marketplace: true } } } })
  if (!ag) throw new Error('ad group not found')
  const resolved = await resolveSellerSku(input)
  let externalId: string | null = null
  if (ag.externalAdGroupId && ag.campaign?.externalCampaignId && ag.campaign.marketplace) {
    const ctx = await resolveCtx(ag.campaign.marketplace)
    if (ctx) {
      const gate = await checkAdsWriteGate({ marketplace: ag.campaign.marketplace, payloadValueCents: 0 })
      if (gate.allowed) {
        if (!resolved) throw new Error(`no seller SKU for "${input.asin ?? input.sku ?? '?'}" — a Sponsored Products ad needs one`)
        const r = await createProductAd(ctx, { externalCampaignId: ag.campaign.externalCampaignId, externalAdGroupId: ag.externalAdGroupId, sku: resolved.sku, state: 'enabled' })
        externalId = r.externalId
        // Amazon answers 200 with an empty success list when it rejects an ad.
        // Silence here is what made 200 phantom product ads look like a clean run.
        if (!externalId) throw new Error(`Amazon did not create the ad for "${resolved.sku}": ${JSON.stringify(r.rawResponse).slice(0, 200)}`)
      }
    }
  }
  const ad = await prisma.adProductAd.create({ data: { adGroupId: input.adGroupId, asin: resolved?.asin ?? input.asin ?? null, sku: resolved?.sku ?? input.sku ?? null, productId: input.productId ?? null, status: 'ENABLED', externalAdId: externalId } })
  await audit('create_product_ad', 'PRODUCT_AD', ad.id, { sku: resolved?.sku ?? input.sku, asin: input.asin, externalId }, input.userId)
  return { id: ad.id, externalAdId: externalId }
}

// LAUNCH-REPAIR — push a campaign's EXISTING local structure (ad group → keywords/auto targets →
// product ads) to Amazon. Fixes campaigns whose sub-entities were saved locally but never pushed
// (e.g. the campaign wasn't allowlisted at launch, so the write-gate skipped them → empty on
// Amazon = "not eligible, no keyword and no ad"). Idempotent: only pushes rows with a null
// external id and reuses the existing local rows — never duplicates. Campaign must be allowlisted.
export async function pushCampaignStructure(campaignId: string): Promise<{ ok: boolean; adGroups: number; keywords: number; targets: number; productAds: number; negKeywords: number; errors: string[] }> {
  const out = { ok: true, adGroups: 0, keywords: 0, targets: 0, productAds: 0, negKeywords: 0, errors: [] as string[] }
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
        // Sponsored Products ads require a seller SKU (merchantSku), not just an ASIN. Shared with
        // the launch path so a repair can fix exactly what a launch should have created — including
        // rows whose "asin" is really a SKU, which the builders' flat `asin || sku` list produces.
        const resolved = await resolveSellerSku(pa)
        if (!resolved) { out.errors.push('productAd "' + (pa.asin || pa.sku || '') + '": no seller SKU in the catalog for this product'); continue }
        const sku = resolved.sku
        const r = await createProductAd(ctx, { externalCampaignId: extC, externalAdGroupId: extAg, sku, state: 'enabled' })
        // Write the real ASIN back too: rows created from the builders' flat list
        // carry a SKU in `asin`, and leaving that lie in place breaks every later
        // join that trusts the column's name.
        if (r.externalId) { await prisma.adProductAd.update({ where: { id: pa.id }, data: { externalAdId: r.externalId, sku, asin: resolved.asin } }); out.productAds++ }
        else out.errors.push('productAd "' + (pa.asin || sku) + '": ' + JSON.stringify(r.rawResponse).slice(0, 200))
      } catch (e) { out.errors.push('productAd "' + (pa.asin || pa.sku || '') + '": ' + ((e as Error)?.message || '')) }
    }
    // Ad-group negative keywords (funnel isolation) that exist locally but were never pushed.
    const negKws = await prisma.adTarget.findMany({ where: { adGroupId: ag.id, kind: 'KEYWORD', isNegative: true, externalTargetId: null } })
    for (const nk of negKws) {
      const mt: 'EXACT' | 'PHRASE' = nk.expressionType === 'PHRASE' ? 'PHRASE' : 'EXACT'
      try {
        const r = await createNegativeKeyword(ctx, { externalCampaignId: extC, externalAdGroupId: extAg, keywordText: nk.expressionValue ?? '', matchType: mt, state: 'enabled' })
        if (r.externalId) { await prisma.adTarget.update({ where: { id: nk.id }, data: { externalTargetId: r.externalId } }); out.negKeywords++ }
        else out.errors.push('negKw "' + (nk.expressionValue || '') + '" ' + mt + ': ' + JSON.stringify(r.rawResponse).slice(0, 220))
      } catch (e) { out.errors.push('negKw "' + (nk.expressionValue || '') + '": ' + ((e as Error)?.message || '')) }
    }
  }
  logger.info('[LAUNCH-REPAIR] pushCampaignStructure', { campaignId, ...out })
  return out
}

// LAUNCH-REPAIR — Amazon→DB reconcile for a set of campaigns. Read-mostly: (1) lists negative
// keywords from Amazon and back-fills local rows' externalTargetId (matched by ad group + match
// type + text), reporting Amazon total / dupes / local-unmatched; (2) reads real serving status
// (delivery) for each campaign + its ad group; (3) reads Amazon's authoritative portfolio membership
// per campaign. The only write is back-filling externalTargetId on already-existing local rows.
export async function reconcileNegativesAndDelivery(campaignIds: string[]): Promise<Record<string, unknown>> {
  const campaigns = await prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, name: true, marketplace: true, externalCampaignId: true, portfolioId: true } })
  const mkt = campaigns.find((c) => c.marketplace)?.marketplace
  if (!mkt) return { ok: false, error: 'no marketplace on campaigns' }
  const ctx = await resolveCtx(mkt)
  if (!ctx) return { ok: false, error: 'no connection for ' + mkt }
  const extIds = campaigns.map((c) => c.externalCampaignId).filter((x): x is string => !!x)

  const adGroups = await prisma.adGroup.findMany({ where: { campaignId: { in: campaignIds } }, select: { id: true, campaignId: true, externalAdGroupId: true } })
  const extAgToLocal = new Map(adGroups.filter((a) => a.externalAdGroupId).map((a) => [a.externalAdGroupId as string, a.id]))
  const localNegs = await prisma.adTarget.findMany({ where: { adGroupId: { in: adGroups.map((a) => a.id) }, kind: 'KEYWORD', isNegative: true }, select: { id: true, adGroupId: true, expressionType: true, expressionValue: true, externalTargetId: true } })

  // (1) negatives — index Amazon negs by localAdGroup|MATCH|text, back-fill ids
  const amzNegs = await listNegativeKeywords(ctx, { campaignIds: extIds })
  const amzIndex = new Map<string, Array<{ id: string | null }>>()
  for (const n of amzNegs) {
    const localAg = n.adGroupId ? extAgToLocal.get(n.adGroupId) : undefined
    const mt = (n.matchType || '').replace('NEGATIVE_', '')
    const key = `${localAg}|${mt}|${(n.keywordText || '').toLowerCase()}`
    const arr = amzIndex.get(key) ?? []; arr.push({ id: n.negativeKeywordId ?? n.keywordId ?? null }); amzIndex.set(key, arr)
  }
  let backfilled = 0, alreadyLinked = 0, unmatchedLocal = 0
  for (const ln of localNegs) {
    const key = `${ln.adGroupId}|${ln.expressionType}|${(ln.expressionValue || '').toLowerCase()}`
    const id = amzIndex.get(key)?.[0]?.id ?? null
    if (id) {
      if (ln.externalTargetId === id) alreadyLinked++
      else { await prisma.adTarget.update({ where: { id: ln.id }, data: { externalTargetId: id } }); backfilled++ }
    } else unmatchedLocal++
  }
  const duplicates = [...amzIndex.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ key: k, count: v.length }))

  // (2)+(3) serving status + portfolio membership
  const amzCamps = await listCampaignsServing(ctx, { campaignIds: extIds })
  const campByExt = new Map(amzCamps.map((c) => [c.campaignId, c]))
  const amzAgs = await listAdGroupsV3(ctx, { campaignIds: extIds })
  const agByExt = new Map(amzAgs.map((a) => [a.adGroupId, a]))
  const delivery = campaigns.map((c) => {
    const ac = c.externalCampaignId ? campByExt.get(c.externalCampaignId) : undefined
    const ag = adGroups.find((a) => a.campaignId === c.id)
    const aag = ag?.externalAdGroupId ? agByExt.get(ag.externalAdGroupId) : undefined
    return {
      name: c.name,
      campaignState: ac?.state ?? null,
      campaignServing: ac?.extendedData?.servingStatus ?? null,
      adGroupServing: aag?.extendedData?.servingStatus ?? null,
      amazonPortfolioId: ac?.portfolioId ?? null,
      localPortfolioId: c.portfolioId ?? null,
    }
  })

  const out = {
    ok: true,
    negatives: { amazonTotal: amzNegs.length, localTotal: localNegs.length, backfilled, alreadyLinked, unmatchedLocal, duplicates: duplicates.length, duplicateKeys: duplicates.slice(0, 10) },
    delivery,
  }
  logger.info('[LAUNCH-REPAIR] reconcileNegativesAndDelivery', { campaignIds, negatives: out.negatives })
  return out
}

// LAUNCH-REPAIR — force-push a campaign's portfolio membership to Amazon. The normal PATCH path
// diffs against LOCAL state, so when local already has the portfolioId (but Amazon has null — the
// launch never applied it) it no-ops. This bypasses the diff and pushes updateCampaign directly.
export async function assignPortfolioDirect(campaignId: string, portfolioId: string): Promise<{ ok: boolean; error?: string; rawResponse?: unknown }> {
  const c = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { externalCampaignId: true, marketplace: true } })
  if (!c?.externalCampaignId || !c.marketplace) return { ok: false, error: 'campaign missing externalCampaignId/marketplace' }
  const gate = await checkAdsWriteGate({ marketplace: c.marketplace, payloadValueCents: 0, campaignId })
  if (!gate.allowed) return { ok: false, error: 'write-gate closed: ' + ('reason' in gate ? gate.reason : 'denied') }
  const ctx = await resolveCtx(c.marketplace)
  if (!ctx) return { ok: false, error: 'no connection for ' + c.marketplace }
  const r = await updateCampaign(ctx, c.externalCampaignId, { portfolioId })
  if (r.ok) await prisma.campaign.update({ where: { id: campaignId }, data: { portfolioId } })
  logger.info('[LAUNCH-REPAIR] assignPortfolioDirect', { campaignId, portfolioId, ok: r.ok, error: r.error })
  return { ok: r.ok, error: r.error ?? undefined, rawResponse: r.rawResponse }
}

/**
 * AX-VT.1 — verify (and optionally repair) campaign→portfolio membership against Amazon.
 *
 * This is the read-back that should always have existed. `createCampaignLocal` now sends
 * portfolioId with the create, but Amazon's SP v3 create schema does not publicly document
 * whether it honours the field, and the create response echoes only campaignId — so a create
 * alone can never prove membership landed. One list call per marketplace settles it for a
 * whole launch, and the same function repairs the 62 campaigns the original defect stranded.
 *
 * The important subtlety is WHICH disagreements are ours to overwrite:
 *
 *   Amazon null, we hold a value   → MISSING_ON_AMAZON. Our write never landed. Repairable:
 *                                    the operator asked for this in Nexus and we failed to
 *                                    deliver it, so pushing is restoring their intent.
 *   Amazon holds a DIFFERENT id    → CONFLICT. Somebody moved the campaign in Seller Central.
 *                                    Reported, NEVER auto-pushed — "repairing" that would
 *                                    silently undo a human's deliberate decision, which is a
 *                                    worse bug than the one we are fixing.
 *
 * That distinction is why this cannot be a blind `assignPortfolioDirect` loop over everything
 * with a local portfolioId. Read first, then push only what we broke.
 */
export type PortfolioVerdict = 'AGREED' | 'MISSING_ON_AMAZON' | 'CONFLICT' | 'NOT_ON_AMAZON'

export interface PortfolioVerifyRow {
  campaignId: string
  name: string
  marketplace: string | null
  externalCampaignId: string | null
  intended: string | null
  amazon: string | null
  verdict: PortfolioVerdict
  repaired?: boolean
  error?: string
}

export interface PortfolioVerifyResult {
  ok: boolean
  dryRun: boolean
  checked: number
  agreed: number
  missingOnAmazon: number
  conflicts: number
  notOnAmazon: number
  repaired: number
  repairFailed: number
  rows: PortfolioVerifyRow[]
  errors: string[]
}

export async function verifyCampaignPortfolios(opts: {
  campaignIds?: string[]
  marketplace?: string
  dryRun?: boolean
} = {}): Promise<PortfolioVerifyResult> {
  const dryRun = opts.dryRun !== false // default SAFE: report unless explicitly told to write
  const out: PortfolioVerifyResult = {
    ok: true, dryRun, checked: 0, agreed: 0, missingOnAmazon: 0, conflicts: 0,
    notOnAmazon: 0, repaired: 0, repairFailed: 0, rows: [], errors: [],
  }

  const campaigns = await prisma.campaign.findMany({
    where: {
      portfolioId: { not: null },
      status: { not: 'ARCHIVED' },
      ...(opts.campaignIds?.length ? { id: { in: opts.campaignIds } } : {}),
      ...(opts.marketplace ? { marketplace: opts.marketplace } : {}),
    },
    select: { id: true, name: true, marketplace: true, externalCampaignId: true, portfolioId: true },
  })
  out.checked = campaigns.length
  if (!campaigns.length) return out

  // Group by marketplace — each one is a different Amazon profile, so a different read.
  const byMarket = new Map<string, typeof campaigns>()
  for (const c of campaigns) {
    if (!c.marketplace || !c.externalCampaignId) {
      out.notOnAmazon++
      out.rows.push({
        campaignId: c.id, name: c.name, marketplace: c.marketplace,
        externalCampaignId: c.externalCampaignId, intended: c.portfolioId, amazon: null,
        verdict: 'NOT_ON_AMAZON',
      })
      continue
    }
    const arr = byMarket.get(c.marketplace) ?? []
    arr.push(c)
    byMarket.set(c.marketplace, arr)
  }

  for (const [marketplace, rows] of byMarket) {
    const ctx = await resolveCtx(marketplace)
    if (!ctx) { out.ok = false; out.errors.push(`no connection for ${marketplace}`); continue }

    // Chunked so a large account cannot blow the filter size limit.
    const amzById = new Map<string, string | null>()
    try {
      for (let i = 0; i < rows.length; i += 100) {
        const ids = rows.slice(i, i + 100).map((r) => r.externalCampaignId as string)
        for (const a of await listCampaignsV3(ctx, { campaignIds: ids })) {
          amzById.set(a.campaignId, a.portfolioId ?? null)
        }
      }
    } catch (e) {
      out.ok = false
      out.errors.push(`read ${marketplace}: ${(e as Error).message.slice(0, 160)}`)
      continue
    }

    for (const c of rows) {
      const ext = c.externalCampaignId as string
      const intended = c.portfolioId as string
      if (!amzById.has(ext)) {
        out.notOnAmazon++
        out.rows.push({ campaignId: c.id, name: c.name, marketplace, externalCampaignId: ext, intended, amazon: null, verdict: 'NOT_ON_AMAZON' })
        continue
      }
      const amazon = amzById.get(ext) ?? null
      if (amazon === intended) { out.agreed++; continue }

      if (amazon !== null) {
        // Somebody moved it on Amazon. Surface it; do not touch it.
        out.conflicts++
        out.rows.push({ campaignId: c.id, name: c.name, marketplace, externalCampaignId: ext, intended, amazon, verdict: 'CONFLICT' })
        continue
      }

      out.missingOnAmazon++
      const row: PortfolioVerifyRow = {
        campaignId: c.id, name: c.name, marketplace, externalCampaignId: ext,
        intended, amazon: null, verdict: 'MISSING_ON_AMAZON',
      }
      if (!dryRun) {
        const gate = await checkAdsWriteGate({ marketplace, payloadValueCents: 0, campaignId: c.id })
        if (!gate.allowed) {
          row.repaired = false
          row.error = 'write-gate closed: ' + ('reason' in gate ? String(gate.reason) : 'denied')
          out.repairFailed++
        } else {
          const r = await updateCampaign(ctx, ext, { portfolioId: intended })
          row.repaired = r.ok
          if (r.ok) out.repaired++
          else { out.repairFailed++; row.error = r.error ?? 'patch failed' }
        }
      }
      out.rows.push(row)
    }
  }

  logger.info('[AX-VT.1] verifyCampaignPortfolios', {
    dryRun, checked: out.checked, agreed: out.agreed, missingOnAmazon: out.missingOnAmazon,
    conflicts: out.conflicts, notOnAmazon: out.notOnAmazon, repaired: out.repaired, repairFailed: out.repairFailed,
  })
  return out
}

/**
 * AX-VT.1 — settle portfolio membership at the end of a launch.
 *
 * Amazon's SP v3 create response echoes only `campaignId`, and the public docs do not say
 * whether the create honours `portfolioId` at all. So a launch that merely SENDS the field
 * cannot claim the campaigns joined the portfolio — which is the precise gap that produced
 * the original bug, where every layer reported success and 11 campaigns sat outside it.
 *
 * Rather than depend on an undocumented behaviour, every launch now reads back and repairs.
 * One list call per marketplace for the whole batch. If Amazon does honour portfolioId on
 * create this is a cheap confirmation that reports `repaired: 0`; if it does not, the launch
 * fixes itself before returning. Either way the operator gets a claim that was checked.
 *
 * Best-effort by construction: a launch that created campaigns must never be reported as
 * failed because the confirmation step could not run.
 */
export async function settleLaunchPortfolios(campaignIds: string[]): Promise<PortfolioVerifyResult | null> {
  if (!campaignIds.length) return null
  try {
    const r = await verifyCampaignPortfolios({ campaignIds, dryRun: false })
    if (r.checked === 0) return null // no portfolio was requested for this launch
    if (r.missingOnAmazon > 0) {
      // Worth a loud line: it means the create did NOT carry portfolioId through, and the
      // read-back is the only reason these campaigns ended up where the operator asked.
      logger.warn('[AX-VT.1] launch needed portfolio repair — create did not apply portfolioId', {
        campaigns: r.missingOnAmazon, repaired: r.repaired, failed: r.repairFailed,
      })
    }
    return r
  } catch (e) {
    logger.warn('[AX-VT.1] settleLaunchPortfolios failed', { error: (e as Error).message.slice(0, 160) })
    return null
  }
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
  /**
   * Write the local row but do NOT create it on Amazon.
   *
   * For the four SP auto-targeting clauses, which Amazon generates itself when
   * an ad group joins an AUTO campaign — POST /sp/targets rejects them. The row
   * still has to exist locally for bids and reporting to hang off.
   */
  skipAmazon?: boolean
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
    ? [{ type: 'ASIN_SAME_AS', value: input.value }]
    : input.kind === 'CATEGORY'
      ? [{ type: 'ASIN_CATEGORY_SAME_AS', value: input.value }]
      : isAudience
        ? (AUDIENCE_EXPRESSION[audType] ?? AUDIENCE_EXPRESSION.AUDIENCE)(input.value)
        : [{ type: AUTO_EXPRESSION[input.value] ?? input.value }]
  const expressionType = input.kind === 'PRODUCT' ? 'ASIN' : input.kind === 'CATEGORY' ? 'CATEGORY' : isAudience ? audType : 'AUTO'
  let externalId: string | null = null, mode = 'local'
  if (!input.skipAmazon && ag.externalAdGroupId && ag.campaign?.externalCampaignId && ag.campaign.marketplace) {
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
  // HX.1 — who caused this. Distinct from `userId` (a human id) because most placement writes come
  // from automation: `automation:rank-defend-<AdSchedule.id>` / `automation:rank-plan-<id>`. The
  // console resolves that prefix back to the schedule's name, so a change reads
  // "IT AIREON raised Top-of-Search bias" rather than showing an unattributed row.
  actor?: string
  reason?: string
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

  /**
   * HX.2 — placement writes join the audit spine.
   *
   * This is the single most-executed ads write we make: rank-defend holds a rank by moving the
   * placement bias, every 15 minutes, across every enabled schedule. Until now it wrote ONLY an
   * AdvertisingActionLog row — no CampaignBidHistory, and (because the push is inline rather than
   * queued) no AdMutation. Every history surface in the console reads those two tables, so the
   * dominant action of the whole rank system was invisible in all of them: the schedule activity
   * drawer rendered "No changes recorded yet" for a schedule doing its job correctly.
   *
   * ONE ROW PER CHANGED PLACEMENT, not one row for the set — that matches how CampaignBidHistory
   * is designed (a single field's old → new) and makes the diff read as
   * "PLACEMENT_TOP 100 → 115" instead of an opaque blob. Unchanged placements write nothing, so a
   * tick that moves only Top-of-Search doesn't manufacture three rows of noise.
   */
  const priorPct = new Map(priorAdjustments.map((a) => [a.placement, a.percentage]))
  const changed = adjustments.filter((a) => priorPct.get(a.placement) !== a.percentage)
  if (changed.length) {
    await prisma.campaignBidHistory.createMany({
      data: changed.map((a) => ({
        entityType: 'CAMPAIGN',
        entityId: input.campaignId,
        campaignId: input.campaignId,
        field: a.placement,
        oldValue: priorPct.has(a.placement) ? String(priorPct.get(a.placement)) : null,
        newValue: String(a.percentage),
        // HX.1 — without an actor these rows can't be attributed to the schedule, plan or person
        // that caused them, which is the whole point of the history. 'system' only when a caller
        // genuinely has no actor to give.
        changedBy: input.actor ?? input.userId ?? 'system',
        reason: input.reason ?? null,
      })),
    }).catch(() => { /* best-effort — an audit row must never fail the write it describes */ })
  }

  // HX.1 — the real outcome. `syncStamp` is null when nothing was pushed live (sandbox, gated, or
  // no external id), in which case the row is a truthful local-only SUCCESS.
  const auditStatus = syncStamp ? (syncStamp.lastSyncStatus === 'SUCCESS' ? 'SUCCESS' : 'FAILED') : 'SUCCESS'
  await audit('update_placement_bidding', 'CAMPAIGN', input.campaignId, { adjustments, mode, ...(syncStamp?.lastSyncError ? { error: syncStamp.lastSyncError } : {}) }, input.actor ?? input.userId, { adjustments: priorAdjustments }, auditStatus)
  logger.info('[AX2.2] updatePlacementBidding', { campaignId: input.campaignId, adjustments, mode, status: auditStatus })
  return { ok: auditStatus !== 'FAILED', adjustments, mode }
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

// LAUNCH-REPAIR — bulk ad-group negative keywords (funnel isolation). Idempotent: skips a negative
// that already exists for (adGroup, matchType, text). Used to back-fill the funnel de-dup negatives
// on campaigns launched via the API (which bypasses the wizard UI's applyAutoNegatives).
export async function bulkNegativeKeywords(items: Array<{ adGroupId: string; keywordText: string; matchType: 'EXACT' | 'PHRASE' }>, userId?: string): Promise<{ created: number; pushed: number; skipped: number; failed: number; errors: string[] }> {
  const out = { created: 0, pushed: 0, skipped: 0, failed: 0, errors: [] as string[] }
  for (const it of items) {
    const text = (it.keywordText || '').trim()
    if (!text || (it.matchType !== 'EXACT' && it.matchType !== 'PHRASE')) { out.failed++; out.errors.push('bad item ' + JSON.stringify(it)); continue }
    const dupe = await prisma.adTarget.findFirst({ where: { adGroupId: it.adGroupId, kind: 'KEYWORD', isNegative: true, expressionType: it.matchType, expressionValue: { equals: text, mode: 'insensitive' } }, select: { id: true } })
    if (dupe) { out.skipped++; continue }
    try {
      const r = await createNegativeKeywordLocal({ adGroupId: it.adGroupId, keywordText: text, matchType: it.matchType, userId })
      out.created++
      if (r.externalTargetId) out.pushed++
      else out.errors.push('not pushed (gate/local): ' + it.matchType + ' "' + text + '"')
    } catch (e) { out.failed++; out.errors.push('"' + text + '" ' + it.matchType + ': ' + ((e as Error)?.message || '')) }
  }
  logger.info('[LAUNCH-REPAIR] bulkNegativeKeywords', out)
  return out
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

// ── Phase 3 — named rank-schedule groups (one named schedule spanning many campaigns) ──────────
// A group is the authoring layer; saving it MATERIALIZES one AdSchedule row per member campaign
// (which the rank-defend cron already runs — engine untouched). Rebinds any existing per-campaign
// schedule to this group so a campaign is never double-scheduled (one campaign → one schedule row).
export interface RankScheduleGroupInput {
  id?: string; name: string; marketplace?: string | null; timezone?: string
  windows: unknown[]; defaultTargetKey?: string | null
  targetOverrides?: Record<string, unknown> // per-campaign map: { [campaignId]: { targetKey: {...} } }
  enabled?: boolean; campaignIds: string[]; portfolioId?: string | null; userId?: string
}
// A portfolio-scoped group covers the whole portfolio: its current, non-archived campaigns. Resolved
// by Campaign.portfolioId (the Amazon external id the /portfolios list also keys on).
export async function resolvePortfolioCampaignIds(portfolioId: string): Promise<string[]> {
  if (!portfolioId) return []
  const rows = await prisma.campaign.findMany({ where: { portfolioId, status: { not: 'ARCHIVED' } }, select: { id: true } })
  return rows.map((r) => r.id)
}

export async function saveRankScheduleGroup(input: RankScheduleGroupInput): Promise<{ id: string; members: number; moved: number }> {
  const name = (input.name || '').trim()
  if (!name) throw new Error('name is required')
  let campaignIds = [...new Set((input.campaignIds || []).filter(Boolean))]
  // Portfolio scope: auto-include the portfolio's current campaigns so a portfolio schedule always
  // covers the whole portfolio (and picks up any campaigns added to it since the last save). Members
  // still inherit `enabled` below, so a Manual group stays cron-safe even as it auto-grows.
  if (input.portfolioId) {
    const pcamps = await resolvePortfolioCampaignIds(String(input.portfolioId))
    campaignIds = [...new Set([...campaignIds, ...pcamps])]
  }
  const windows = Array.isArray(input.windows) ? input.windows : []
  const overrides = (input.targetOverrides ?? {}) as Record<string, unknown>
  const enabled = input.enabled !== false
  const tz = input.timezone || 'Europe/Rome'
  // RDX/B1 — derive the group's market from its members when the caller doesn't state one.
  // The rank builder has never sent `marketplace`, so this column was null on every live row and
  // the console's market switch had nothing to filter on. Derived only when the members agree:
  // a group spanning IT + DE has no single market, and guessing one would be worse than null.
  let marketplace = (input.marketplace as string | null | undefined) ?? null
  if (!marketplace && campaignIds.length) {
    try {
      const mc = await prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { marketplace: true } })
      const distinct = [...new Set(mc.map((c) => c.marketplace).filter(Boolean) as string[])]
      if (distinct.length === 1) marketplace = distinct[0]
    } catch { /* best-effort — a failed derive must not block the save */ }
  }
  const gdata = { name, marketplace, timezone: tz, windows: windows as never, defaultTargetKey: input.defaultTargetKey ?? null, targetOverrides: overrides as never, enabled, portfolioId: input.portfolioId ?? null }
  // DPS.1 — belt-and-braces against duplicate groups. The client now sends the id it minted on the
  // first save, but a stale bundle (or a double-submit) can still arrive with no id. Since the block
  // below REBINDS each campaign's schedule to whichever group saved last, a blind create would strand
  // the previous group at zero members — which is exactly how the live account accumulated 8 empty
  // groups ("IT AIRMESH" ×4 in 82 seconds). Same name + same portfolio scope = the same schedule, so
  // adopt the existing row instead of minting a rival.
  let targetId = input.id ?? null
  if (!targetId) {
    const twin = await prisma.rankScheduleGroup.findFirst({
      where: { name, portfolioId: input.portfolioId ?? null },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    })
    if (twin) {
      targetId = twin.id
      logger.info('[DPS.1] adopted existing rank schedule group instead of creating a duplicate', { id: twin.id, name })
    }
  }
  const group = targetId
    ? await prisma.rankScheduleGroup.update({ where: { id: targetId }, data: gdata })
    : await prisma.rankScheduleGroup.create({ data: { ...gdata, createdBy: input.userId ?? null } })

  const camps = campaignIds.length ? await prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, name: true } }) : []
  const nameById = new Map(camps.map((c) => [c.id, c.name]))

  // Materialize: one AdSchedule per member campaign, bound to the group. Reuse any existing schedule
  // for the campaign (rebind to this group) so we never create a duplicate → one campaign, one row.
  let moved = 0
  for (const cid of campaignIds) {
    const perCamp = overrides[cid]
    const memberName = nameById.get(cid) ? `${nameById.get(cid)} — ${name}` : name
    const data = { name: memberName, windows: windows as never, timezone: tz, defaultTargetKey: input.defaultTargetKey ?? null, targetOverrides: (perCamp ?? {}) as never, enabled }
    const existing = await prisma.adSchedule.findFirst({ where: { campaignId: cid }, select: { id: true, groupId: true } })
    if (existing) {
      if (existing.groupId && existing.groupId !== group.id) moved++
      await prisma.adSchedule.update({ where: { id: existing.id }, data: { ...data, groupId: group.id } })
    } else {
      await prisma.adSchedule.create({ data: { ...data, campaignId: cid, groupId: group.id } })
    }
  }
  // Campaigns removed from the group → drop their (now-orphaned) execution rows.
  await prisma.adSchedule.deleteMany({ where: { groupId: group.id, campaignId: { notIn: campaignIds.length ? campaignIds : ['__none__'] } } })
  /**
   * HX.8 — snapshot the plan as it now stands.
   *
   * `saveRankScheduleGroup` overwrites `windows` in place, so before this there was no way to answer
   * "what did we change, and when did this schedule start behaving differently" — the first question
   * worth asking when a schedule stops performing.
   *
   * Written only when something MEANINGFUL differs from the latest snapshot. The builder saves on
   * every "Save Changes" click and the coverage panel re-saves a group just to append a campaign; a
   * naive append would bury the real edits under identical rows. Campaign count is part of the
   * comparison because "went from 11 campaigns to 1" is a plan change even when the windows didn't move.
   */
  try {
    const last = await prisma.rankScheduleVersion.findFirst({ where: { groupId: group.id }, orderBy: { createdAt: 'desc' }, select: { name: true, windows: true, defaultTargetKey: true, campaignCount: true, enabled: true } })
    const changed = !last
      || last.name !== name
      || (last.defaultTargetKey ?? null) !== (input.defaultTargetKey ?? null)
      || last.campaignCount !== campaignIds.length
      || last.enabled !== enabled
      || JSON.stringify(last.windows) !== JSON.stringify(windows)
    if (changed) {
      await prisma.rankScheduleVersion.create({
        data: { groupId: group.id, name, windows: windows as never, defaultTargetKey: input.defaultTargetKey ?? null, campaignCount: campaignIds.length, enabled, changedBy: input.userId ?? null },
      })
    }
  } catch (e) { logger.warn('[HX.8] version snapshot failed', { id: group.id, error: (e as Error).message }) }

  logger.info('[Phase3] saveRankScheduleGroup', { id: group.id, name, members: campaignIds.length, moved })
  return { id: group.id, members: campaignIds.length, moved }
}

export async function deleteRankScheduleGroup(id: string): Promise<{ ok: boolean; removedSchedules: number }> {
  const del = await prisma.adSchedule.deleteMany({ where: { groupId: id } })
  await prisma.rankScheduleGroup.delete({ where: { id } }).catch(() => {})
  logger.info('[Phase3] deleteRankScheduleGroup', { id, removedSchedules: del.count })
  return { ok: true, removedSchedules: del.count }
}

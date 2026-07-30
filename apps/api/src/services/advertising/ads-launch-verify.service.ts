/**
 * AX-VT.4 — read a launch back from Amazon and report intended vs observed.
 *
 * Why this exists, plainly: on 2026-07-30 an operator launched 11 campaigns into a portfolio and
 * Amazon put none of them in it. Every layer reported success, because the only check anybody had
 * written was `if (!camp.externalCampaignId)` — existence, never fidelity. AX-VT.1 fixed the
 * portfolio field and made launches read that one field back. This generalises it: the whole
 * shape of a launch is now compared against what was asked for.
 *
 * Cost is bounded and small — FIVE list calls per marketplace for an entire launch, regardless of
 * how many campaigns it created, because every v3 list call takes a campaignIdFilter. An
 * 11-campaign launch costs the same as a 1-campaign launch.
 *
 * The receipt is persisted as an `AdvertisingActionLog` row (`actionType: 'launch_verification'`)
 * rather than a new table: every create already writes to that log, it is already the audit trail
 * an operator would reach for, and it needs no migration. If a later phase wants richer querying
 * over receipts, promote it to its own table then.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import {
  listCampaignsV3, listAdGroupsV3, listKeywords, listTargets, listSdTargets, listProductAds,
  ALL_STATES, type AdsRegion,
} from './ads-api-client.js'
import {
  verifyEntity, summarise, describeVerdict,
  type EntityPair, type LaunchEntityResult, type LaunchVerificationSummary,
} from '../ads-core/launch-verify.js'

async function resolveCtx(marketplace: string): Promise<{ profileId: string; region: AdsRegion } | null> {
  const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace, isActive: true }, select: { profileId: true, region: true } })
  return conn ? { profileId: conn.profileId, region: (conn.region as AdsRegion) ?? 'EU' } : null
}

const centsToUnits = (c: number | null | undefined): number | null => (c == null ? null : c / 100)

/** Amazon's SP match types come back as EXACT/PHRASE/BROAD; negatives are NEGATIVE_-prefixed. */
const stripNegative = (m: string | undefined): string | null => (m ? m.replace('NEGATIVE_', '') : null)

export interface LaunchVerification extends LaunchVerificationSummary {
  campaignIds: string[]
  entities: LaunchEntityResult[]
  /** Human lines for everything that is not VERIFIED — what the builder UI shows. */
  problems: string[]
  errors: string[]
}

export async function verifyLaunch(campaignIds: string[]): Promise<LaunchVerification> {
  const errors: string[] = []
  const entities: LaunchEntityResult[] = []

  const campaigns = await prisma.campaign.findMany({
    where: { id: { in: campaignIds } },
    select: {
      id: true, name: true, marketplace: true, externalCampaignId: true, status: true,
      dailyBudget: true, biddingStrategy: true, targetingType: true, portfolioId: true,
      adProduct: true,
    },
  })

  const byMarket = new Map<string, typeof campaigns>()
  for (const c of campaigns) {
    if (!c.marketplace) { errors.push(`campaign "${c.name}" has no marketplace`); continue }
    const arr = byMarket.get(c.marketplace) ?? []
    arr.push(c)
    byMarket.set(c.marketplace, arr)
  }

  for (const [marketplace, camps] of byMarket) {
    const ctx = await resolveCtx(marketplace)
    if (!ctx) { errors.push(`no connection for ${marketplace}`); continue }
    const extIds = camps.map((c) => c.externalCampaignId).filter((x): x is string => !!x)

    // Local children of this marketplace's campaigns.
    const localIds = camps.map((c) => c.id)
    // Which campaigns are Sponsored Display — their targets live behind a different endpoint.
    const sdCampaignIds = new Set(camps.filter((c) => c.adProduct === 'SPONSORED_DISPLAY').map((c) => c.id))
    const sdExtIds = camps.filter((c) => sdCampaignIds.has(c.id)).map((c) => c.externalCampaignId).filter((x): x is string => !!x)

    const adGroups = await prisma.adGroup.findMany({
      where: { campaignId: { in: localIds } },
      select: { id: true, campaignId: true, name: true, externalAdGroupId: true, status: true, defaultBidCents: true },
    })
    const agToCampaign = new Map(adGroups.map((a) => [a.id, a.campaignId]))
    const agIds = adGroups.map((a) => a.id)
    const targets = await prisma.adTarget.findMany({
      where: { adGroupId: { in: agIds }, isNegative: false },
      select: { id: true, adGroupId: true, kind: true, expressionType: true, expressionValue: true, externalTargetId: true, status: true, bidCents: true },
    })
    const productAds = await prisma.adProductAd.findMany({
      where: { adGroupId: { in: agIds } },
      select: { id: true, adGroupId: true, sku: true, asin: true, externalAdId: true, status: true },
    })

    // One read per entity kind for the whole launch. If a read fails we say so and skip that
    // kind rather than reporting its entities as broken — a failed READ is not a failed write,
    // and claiming otherwise would send someone chasing a problem that does not exist.
    let amzCampaigns, amzAdGroups, amzKeywords, amzTargets, amzProductAds
    try { amzCampaigns = new Map((await listCampaignsV3(ctx, { campaignIds: extIds, states: [...ALL_STATES] })).map((c) => [c.campaignId, c])) }
    catch (e) { errors.push(`read campaigns ${marketplace}: ${(e as Error).message.slice(0, 120)}`) }
    try { amzAdGroups = new Map((await listAdGroupsV3(ctx, { campaignIds: extIds, states: ALL_STATES })).map((a) => [a.adGroupId, a])) }
    catch (e) { errors.push(`read adGroups ${marketplace}: ${(e as Error).message.slice(0, 120)}`) }
    try { amzKeywords = new Map((await listKeywords(ctx, { campaignIds: extIds, states: ALL_STATES })).map((k) => [k.keywordId, k])) }
    catch (e) { errors.push(`read keywords ${marketplace}: ${(e as Error).message.slice(0, 120)}`) }
    try { amzTargets = new Map((await listTargets(ctx, { campaignIds: extIds, states: ALL_STATES })).map((t) => [t.targetId, t])) }
    catch (e) { errors.push(`read targets ${marketplace}: ${(e as Error).message.slice(0, 120)}`) }
    // Only ask for SD targets when the launch actually contains an SD campaign.
    let amzSdTargets: Map<string | undefined, { state?: string; bid?: number; expression?: Array<{ value?: string }> }> | undefined
    if (sdExtIds.length) {
      try { amzSdTargets = new Map((await listSdTargets(ctx, { externalCampaignIds: sdExtIds })).map((t) => [t.targetId, t])) }
      catch (e) { errors.push(`read SD targets ${marketplace}: ${(e as Error).message.slice(0, 120)}`) }
    }
    try { amzProductAds = new Map((await listProductAds(ctx, { campaignIds: extIds, states: ALL_STATES })).map((a) => [a.adId, a])) }
    catch (e) { errors.push(`read productAds ${marketplace}: ${(e as Error).message.slice(0, 120)}`) }

    if (amzCampaigns) {
      for (const c of camps) {
        const a = c.externalCampaignId ? amzCampaigns.get(c.externalCampaignId) : undefined
        const pair: EntityPair = {
          entityType: 'CAMPAIGN', localId: c.id, externalId: c.externalCampaignId, label: c.name,
          intended: {
            name: c.name, state: c.status,
            dailyBudget: c.dailyBudget == null ? null : Number(c.dailyBudget),
            biddingStrategy: c.biddingStrategy, targetingType: c.targetingType,
            portfolioId: c.portfolioId,
          },
          observed: a === undefined ? undefined : {
            name: a.name, state: a.state,
            dailyBudget: a.budget?.budget,
            biddingStrategy: a.dynamicBidding?.strategy,
            targetingType: a.targetingType,
            // Present-and-null is the answer that matters here, so it is passed through
            // explicitly rather than left off the object.
            portfolioId: a.portfolioId ?? null,
          },
        }
        entities.push(verifyEntity(pair, ['portfolioId']))
      }
    }

    if (amzAdGroups) {
      for (const g of adGroups) {
        const a = g.externalAdGroupId ? amzAdGroups.get(g.externalAdGroupId) : undefined
        entities.push(verifyEntity({
          entityType: 'AD_GROUP', localId: g.id, externalId: g.externalAdGroupId, label: g.name,
          intended: { name: g.name, state: g.status, defaultBid: centsToUnits(g.defaultBidCents) },
          observed: a === undefined ? undefined : { name: a.name, state: a.state, defaultBid: a.defaultBid },
        }))
      }
    }

    for (const t of targets) {
      // AUTO clauses are generated by Amazon when an AUTO ad group is created — we never push
      // them and hold no external id, so verifying them would report a permanent NOT_PUSHED for
      // something that is working correctly. Same reasoning as pushCampaignStructure skipping them.
      if (t.kind === 'AUTO') continue
      const isKeyword = t.kind === 'KEYWORD'
      const isSd = sdCampaignIds.has(agToCampaign.get(t.adGroupId) ?? '')
      const src = isKeyword ? amzKeywords : isSd ? amzSdTargets : amzTargets
      // No read for this kind (SD read failed, or it was never requested) — skip rather than
      // report MISSING_ON_AMAZON. A verifier that invents failures gets switched off.
      if (!src) continue
      const a = t.externalTargetId ? src.get(t.externalTargetId) : undefined
      // SD audience clauses carry an EMPTY expressionValue, not null, so `?? t.id` left the
      // receipt showing a blank row. Fall back to the kind, which at least names what it is.
      const label = (t.expressionValue || '').trim() || t.kind || t.id
      if (isKeyword) {
        const k = a as { keywordText?: string; matchType?: string; state?: string; bid?: number } | undefined
        entities.push(verifyEntity({
          entityType: 'KEYWORD', localId: t.id, externalId: t.externalTargetId, label,
          intended: { keywordText: t.expressionValue, matchType: t.expressionType, state: t.status, bid: centsToUnits(t.bidCents) },
          observed: k === undefined ? undefined : { keywordText: k.keywordText, matchType: stripNegative(k.matchType), state: k.state, bid: k.bid },
        }))
      } else {
        const tg = a as { state?: string; bid?: number; expression?: Array<{ value?: string }> } | undefined
        entities.push(verifyEntity({
          entityType: 'TARGET', localId: t.id, externalId: t.externalTargetId, label,
          intended: { value: t.expressionValue, state: t.status, bid: centsToUnits(t.bidCents) },
          observed: tg === undefined ? undefined : { value: tg.expression?.[0]?.value, state: tg.state, bid: tg.bid },
        }))
      }
    }

    if (amzProductAds) {
      for (const pa of productAds) {
        const a = pa.externalAdId ? amzProductAds.get(pa.externalAdId) : undefined
        entities.push(verifyEntity({
          entityType: 'PRODUCT_AD', localId: pa.id, externalId: pa.externalAdId, label: pa.sku ?? pa.asin ?? pa.id,
          // SKU only: an ad created from a SKU may report no asin, and asserting on a field
          // Amazon fills in from its own catalog would manufacture mismatches.
          intended: { sku: pa.sku, state: pa.status },
          observed: a === undefined ? undefined : { sku: a.sku, state: a.state },
        }))
      }
    }
  }

  const summary = summarise(entities)
  const problems = entities.filter((e) => e.verdict !== 'VERIFIED').map(describeVerdict)
  const out: LaunchVerification = { ...summary, campaignIds, entities, problems, errors }
  // A read failure means we do not actually know, so it must not read as a pass.
  if (errors.length) out.ok = false

  await prisma.advertisingActionLog.create({
    data: {
      actionType: 'launch_verification', entityType: 'CAMPAIGN',
      entityId: campaignIds[0] ?? 'unknown',
      payloadBefore: {}, payloadAfter: out as unknown as object,
      amazonResponseStatus: out.ok ? 'SUCCESS' : 'PARTIAL',
    },
  }).catch(() => {}) // an audit write must never fail the verification it records

  logger.info('[AX-VT.4] verifyLaunch', {
    campaigns: campaignIds.length, total: summary.total, verified: summary.verified,
    mismatch: summary.mismatch, missingOnAmazon: summary.missingOnAmazon, notPushed: summary.notPushed,
    errors: errors.length,
  })
  if (!out.ok) logger.warn('[AX-VT.4] launch did NOT fully verify', { problems: problems.slice(0, 12), errors })
  return out
}

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
  listCampaignsV3, listAdGroupsV3, listKeywords, listTargets, listProductAds,
  listSdCampaigns, listSdAdGroups, listSdProductAds, listSdTargets, listSbCampaigns,
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

/**
 * The three ad products are three separate Amazon APIs (`/sp/*`, `/sd/*`, `/sb/v4/*`), and asking
 * one about another's entities returns an empty result rather than an error. Anything unrecognised
 * is treated as SP only because that is what the builders create; it never grants coverage on its
 * own, since coverage is tracked per (kind, family) below.
 */
export type Family = 'SP' | 'SD' | 'SB'
const familyOf = (adProduct: string | null): Family =>
  adProduct === 'SPONSORED_DISPLAY' ? 'SD' : adProduct === 'SPONSORED_BRANDS' ? 'SB' : 'SP'

export interface LaunchVerification extends LaunchVerificationSummary {
  campaignIds: string[]
  entities: LaunchEntityResult[]
  /** Human lines for everything that is not VERIFIED — what the builder UI shows. */
  problems: string[]
  /**
   * Local entities we could NOT check, because no Amazon read is wired up for their (kind,
   * ad-product) pair — SB ad groups and ads, today. Reported rather than hidden: a silent skip
   * makes an unverifiable launch look like a verified one, which is the failure this whole phase
   * exists to remove. Does NOT set ok:false — the launch may be perfectly fine; we just can't say.
   */
  uncovered: number
  errors: string[]
}

export async function verifyLaunch(campaignIds: string[]): Promise<LaunchVerification> {
  const errors: string[] = []
  const entities: LaunchEntityResult[] = []
  let uncovered = 0

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
    // Split by ad-product family up front — each is a separate Amazon API.
    const familyOfCampaign = new Map<string, Family>(camps.map((c) => [c.id, familyOf(c.adProduct)]))
    const extIdsFor = (f: Family) => camps.filter((c) => familyOfCampaign.get(c.id) === f).map((c) => c.externalCampaignId).filter((x): x is string => !!x)
    const spExtIds = extIdsFor('SP')
    const sdExtIds = extIdsFor('SD')
    const sbExtIds = extIdsFor('SB')

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
    // ── Per-family reads, with EXPLICIT coverage tracking ──────────────────────────────────
    //
    // The three ad products are three separate APIs. `/sp/*` returns Sponsored Products only,
    // `/sd/*` Sponsored Display, `/sb/v4/*` Sponsored Brands — and asking the wrong one returns
    // nothing rather than erroring, which reads as "the entity is gone". That produced 50 false
    // MISSING_ON_AMAZON for SD before it was caught, and SB was heading the same way because it
    // was lumped in with SP.
    //
    // So coverage is tracked rather than assumed: `covered` records which (kind, family) pairs we
    // actually have a read for. An entity whose pair is NOT covered is SKIPPED — left out of the
    // receipt entirely rather than reported as a failure. Under-reporting is recoverable;
    // inventing failures gets the verifier switched off. `uncovered` counts what was skipped so a
    // gap in coverage is visible instead of looking like a clean pass.
    const covered = new Set<string>()
    const mark = (kind: string, family: Family) => covered.add(`${kind}:${family}`)
    const isCovered = (kind: string, family: Family) => covered.has(`${kind}:${family}`)

    let amzCampaigns, amzAdGroups, amzKeywords, amzTargets, amzProductAds
    let amzSdTargets: Map<string | undefined, { state?: string; bid?: number; expression?: Array<{ value?: string }> }> | undefined

    if (spExtIds.length) {
      try { amzCampaigns = new Map((await listCampaignsV3(ctx, { campaignIds: spExtIds, states: [...ALL_STATES] })).map((c) => [c.campaignId, c])); mark('CAMPAIGN', 'SP') }
      catch (e) { errors.push(`read campaigns ${marketplace}: ${(e as Error).message.slice(0, 120)}`) }
      try { amzAdGroups = new Map((await listAdGroupsV3(ctx, { campaignIds: spExtIds, states: ALL_STATES })).map((a) => [a.adGroupId, a])); mark('AD_GROUP', 'SP') }
      catch (e) { errors.push(`read adGroups ${marketplace}: ${(e as Error).message.slice(0, 120)}`) }
      try { amzKeywords = new Map((await listKeywords(ctx, { campaignIds: spExtIds, states: ALL_STATES })).map((k) => [k.keywordId, k])); mark('KEYWORD', 'SP') }
      catch (e) { errors.push(`read keywords ${marketplace}: ${(e as Error).message.slice(0, 120)}`) }
      try { amzTargets = new Map((await listTargets(ctx, { campaignIds: spExtIds, states: ALL_STATES })).map((t) => [t.targetId, t])); mark('TARGET', 'SP') }
      catch (e) { errors.push(`read targets ${marketplace}: ${(e as Error).message.slice(0, 120)}`) }
      try { amzProductAds = new Map((await listProductAds(ctx, { campaignIds: spExtIds, states: ALL_STATES })).map((a) => [a.adId, a])); mark('PRODUCT_AD', 'SP') }
      catch (e) { errors.push(`read productAds ${marketplace}: ${(e as Error).message.slice(0, 120)}`) }
    }

    if (sdExtIds.length) {
      try { for (const c of await listSdCampaigns(ctx, { externalCampaignIds: sdExtIds })) (amzCampaigns ??= new Map()).set(c.campaignId, c); mark('CAMPAIGN', 'SD') }
      catch (e) { errors.push(`read SD campaigns ${marketplace}: ${(e as Error).message.slice(0, 120)}`) }
      try { for (const a of await listSdAdGroups(ctx, { externalCampaignIds: sdExtIds })) (amzAdGroups ??= new Map()).set(a.adGroupId, a); mark('AD_GROUP', 'SD') }
      catch (e) { errors.push(`read SD adGroups ${marketplace}: ${(e as Error).message.slice(0, 120)}`) }
      try { for (const a of await listSdProductAds(ctx, { externalCampaignIds: sdExtIds })) (amzProductAds ??= new Map()).set(a.adId, a); mark('PRODUCT_AD', 'SD') }
      catch (e) { errors.push(`read SD productAds ${marketplace}: ${(e as Error).message.slice(0, 120)}`) }
      try { amzSdTargets = new Map((await listSdTargets(ctx, { externalCampaignIds: sdExtIds })).map((t) => [t.targetId, t])); mark('TARGET', 'SD') }
      catch (e) { errors.push(`read SD targets ${marketplace}: ${(e as Error).message.slice(0, 120)}`) }
    }

    // SB: campaigns only. Its ad groups / ads / keywords live behind further v4 endpoints that are
    // not wired up, so those kinds stay uncovered for SB and their entities are skipped.
    if (sbExtIds.length) {
      try { for (const c of await listSbCampaigns(ctx, { externalCampaignIds: sbExtIds })) (amzCampaigns ??= new Map()).set(c.campaignId, c); mark('CAMPAIGN', 'SB') }
      catch (e) { errors.push(`read SB campaigns ${marketplace}: ${(e as Error).message.slice(0, 120)}`) }
    }

    {
      for (const c of camps) {
        const fam = familyOfCampaign.get(c.id) as Family
        if (!isCovered('CAMPAIGN', fam)) { uncovered++; continue }
        const a = c.externalCampaignId ? amzCampaigns?.get(c.externalCampaignId) : undefined
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

    {
      for (const g of adGroups) {
        const fam = familyOfCampaign.get(g.campaignId) as Family
        if (!isCovered('AD_GROUP', fam)) { uncovered++; continue }
        const a = g.externalAdGroupId ? amzAdGroups?.get(g.externalAdGroupId) : undefined
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
      const fam = familyOfCampaign.get(agToCampaign.get(t.adGroupId) ?? '') as Family
      const kind = isKeyword ? 'KEYWORD' : 'TARGET'
      // Not covered for this family (SB keywords, or a read that failed) — skip rather than report
      // MISSING_ON_AMAZON. A verifier that invents failures gets switched off.
      if (!isCovered(kind, fam)) { uncovered++; continue }
      const src = isKeyword ? amzKeywords : fam === 'SD' ? amzSdTargets : amzTargets
      if (!src) { uncovered++; continue }
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

    {
      for (const pa of productAds) {
        const fam = familyOfCampaign.get(agToCampaign.get(pa.adGroupId) ?? '') as Family
        if (!isCovered('PRODUCT_AD', fam)) { uncovered++; continue }
        const a = pa.externalAdId ? amzProductAds?.get(pa.externalAdId) : undefined
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
  const out: LaunchVerification = { ...summary, campaignIds, entities, problems, uncovered, errors }
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
    uncovered, errors: errors.length,
  })
  if (!out.ok) logger.warn('[AX-VT.4] launch did NOT fully verify', { problems: problems.slice(0, 12), errors })
  return out
}

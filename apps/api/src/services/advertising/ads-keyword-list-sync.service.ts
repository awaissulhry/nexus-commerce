/**
 * AF.1b — synchronous keyword/negative sync via the Amazon Ads v3 LIST API.
 *
 * The v1 async targets EXPORT is snapshot-dedup'd: once a profile is exported,
 * fresh exports return empty until something changes — so it can't reliably
 * re-fetch existing keywords (left 74 campaigns positives-less). The v3 list
 * endpoints (POST /sp/keywords/list, /sp/negativeKeywords/list) return CURRENT
 * keywords directly, with clean numeric bids (also fixes the €0 bid). We upsert
 * them into AdTarget keyed by the Amazon keywordId.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { liveCall, adsMode, type AdsRegion } from './ads-api-client.js'

interface V3Keyword { keywordId?: string; adGroupId?: string; keywordText?: string; matchType?: string; bid?: number; state?: string }

async function listAll(profileId: string, region: AdsRegion, path: string, mime: string, key: string, filter: Record<string, unknown>): Promise<V3Keyword[]> {
  const out: V3Keyword[] = []
  let nextToken: string | undefined
  let guard = 0
  do {
    const resp = await liveCall<Record<string, unknown>>({
      profileId, region, method: 'POST', path,
      body: { ...filter, maxResults: 1000, ...(nextToken ? { nextToken } : {}) },
      contentType: mime, acceptHeader: mime,
    })
    const rows = (resp[key] as V3Keyword[] | undefined) ?? []
    out.push(...rows)
    nextToken = resp.nextToken as string | undefined
  } while (nextToken && ++guard < 20)
  return out
}

const STATE_MAP = (s: string | undefined): 'ENABLED' | 'PAUSED' | 'ARCHIVED' => {
  const u = (s ?? 'ENABLED').toUpperCase()
  return u === 'PAUSED' ? 'PAUSED' : u === 'ARCHIVED' ? 'ARCHIVED' : 'ENABLED'
}

export interface KeywordSyncResult { positives: number; negatives: number; upserted: number; adGroups: number; mode: string }

interface V3TargetingClause { targetId?: string; adGroupId?: string; bid?: number; state?: string }

/**
 * AF.7b — sync PRODUCT / AUTO targeting-clause bids via v3 /sp/targets/list.
 * Keywords come from /sp/keywords; product & auto targets (ASIN, category,
 * close/loose match, substitutes/complements) live here and carry their own
 * bid — the v1 export left these at €0. Updates bidCents in place by targetId;
 * when a clause inherits the ad-group default (no explicit bid), stamps the
 * ad-group default so the UI shows the real effective bid, not €0.
 */
export async function syncTargetsForAdGroups(opts: { profileId: string; region: AdsRegion; externalAdGroupIds: string[] }): Promise<{ updated: number; clauses: number }> {
  const { profileId, region, externalAdGroupIds } = opts
  if (adsMode() === 'sandbox' || externalAdGroupIds.length === 0) return { updated: 0, clauses: 0 }
  const clauses = await listAll(profileId, region, '/sp/targets/list', 'application/vnd.spTargetingClause.v3+json', 'targetingClauses', { adGroupIdFilter: { include: externalAdGroupIds } })
    .catch((e) => { logger.warn('[target-list-sync] list failed', { error: String(e).slice(0, 160) }); return [] }) as V3TargetingClause[]
  if (clauses.length === 0) return { updated: 0, clauses: 0 }

  const ags = await prisma.adGroup.findMany({ where: { externalAdGroupId: { in: externalAdGroupIds } }, select: { id: true, externalAdGroupId: true, defaultBidCents: true } })
  const agByExt = new Map(ags.map((g) => [g.externalAdGroupId ?? '', g]))
  let updated = 0
  for (const c of clauses) {
    if (!c.targetId || !c.adGroupId) continue
    const ag = agByExt.get(c.adGroupId)
    if (!ag) continue
    const bidNum = Number(c.bid)
    const bidCents = Number.isFinite(bidNum) && bidNum > 0 ? Math.round(bidNum * 100) : ag.defaultBidCents
    try {
      const r = await prisma.adTarget.updateMany({
        where: { externalTargetId: c.targetId, adGroupId: ag.id, isNegative: false },
        data: { bidCents, status: STATE_MAP(c.state), lastSyncedAt: new Date(), lastSyncStatus: 'SUCCESS', lastSyncError: null },
      })
      updated += r.count
    } catch (e) { logger.warn('[target-list-sync] update failed', { targetId: c.targetId, error: String(e).slice(0, 120) }) }
  }
  logger.info('[target-list-sync] done', { clauses: clauses.length, updated, adGroups: externalAdGroupIds.length })
  return { updated, clauses: clauses.length }
}

/** Sync positive + negative keywords for the given external ad-group ids. */
export async function syncKeywordsForAdGroups(opts: { profileId: string; region: AdsRegion; externalAdGroupIds: string[] }): Promise<KeywordSyncResult> {
  const { profileId, region, externalAdGroupIds } = opts
  if (adsMode() === 'sandbox' || externalAdGroupIds.length === 0) {
    return { positives: 0, negatives: 0, upserted: 0, adGroups: externalAdGroupIds.length, mode: adsMode() }
  }
  const filter = { adGroupIdFilter: { include: externalAdGroupIds } }
  const [pos, neg] = await Promise.all([
    listAll(profileId, region, '/sp/keywords/list', 'application/vnd.spKeyword.v3+json', 'keywords', filter).catch((e) => { logger.warn('[kw-list-sync] keywords list failed', { error: String(e).slice(0, 160) }); return [] }),
    listAll(profileId, region, '/sp/negativeKeywords/list', 'application/vnd.spNegativeKeyword.v3+json', 'negativeKeywords', filter).catch((e) => { logger.warn('[kw-list-sync] negativeKeywords list failed', { error: String(e).slice(0, 160) }); return [] }),
  ])

  const ags = await prisma.adGroup.findMany({ where: { externalAdGroupId: { in: externalAdGroupIds } }, select: { id: true, externalAdGroupId: true } })
  const agMap = new Map(ags.map((g) => [g.externalAdGroupId ?? '', g.id]))

  const rows = [
    ...pos.map((k) => ({ ext: k.keywordId, agExt: k.adGroupId, kw: k.keywordText ?? '', mt: (k.matchType ?? 'BROAD').toUpperCase(), bid: Number(k.bid), state: k.state, neg: false })),
    ...neg.map((k) => ({ ext: k.keywordId, agExt: k.adGroupId, kw: k.keywordText ?? '', mt: (k.matchType ?? '').toUpperCase().replace('NEGATIVE', '') || 'PHRASE', bid: 0, state: k.state, neg: true })),
  ]
  let upserted = 0
  for (const r of rows) {
    if (!r.ext || !r.agExt) continue
    const localAg = agMap.get(r.agExt)
    if (!localAg) continue
    const data = {
      adGroupId: localAg, externalTargetId: r.ext, kind: 'KEYWORD',
      expressionType: r.mt || 'BROAD', expressionValue: r.kw,
      bidCents: Number.isFinite(r.bid) && r.bid > 0 ? Math.round(r.bid * 100) : 0,
      status: STATE_MAP(r.state), isNegative: r.neg,
      negativeLevel: r.neg ? 'AD_GROUP' : null,
      lastSyncedAt: new Date(), lastSyncStatus: 'SUCCESS' as const, lastSyncError: null,
    }
    try {
      const existing = await prisma.adTarget.findFirst({ where: { externalTargetId: r.ext, adGroupId: localAg }, select: { id: true } })
      if (existing) await prisma.adTarget.update({ where: { id: existing.id }, data })
      else await prisma.adTarget.create({ data })
      upserted += 1
    } catch (e) { logger.warn('[kw-list-sync] upsert failed', { ext: r.ext, error: String(e).slice(0, 120) }) }
  }
  logger.info('[kw-list-sync] done', { positives: pos.length, negatives: neg.length, upserted, adGroups: externalAdGroupIds.length })
  return { positives: pos.length, negatives: neg.length, upserted, adGroups: externalAdGroupIds.length, mode: adsMode() }
}

/**
 * AF.7 — fleet-wide keyword resync. Pulls CURRENT keywords (with clean numeric
 * bids) for EVERY campaign's ad groups via the v3 list API, fixing the €0-bid
 * positives left by the v1 export (whose nested bid coerced to 0). Groups ad
 * groups by connection profile/region and chunks the list filter.
 */
export async function resyncAllCampaignKeywords(opts: { chunk?: number } = {}): Promise<{ profiles: number; adGroups: number; positives: number; negatives: number; upserted: number; targetsUpdated: number; stampedDefault?: number; mode: string }> {
  const chunk = opts.chunk ?? 40
  const mode = adsMode()
  if (mode === 'sandbox') return { profiles: 0, adGroups: 0, positives: 0, negatives: 0, upserted: 0, targetsUpdated: 0, mode }

  const { normalizeMarketplaceCode } = await import('../../utils/marketplace-code.js')
  const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { profileId: true, region: true, marketplace: true } })
  // Map each campaign's marketplace (short code or Amazon id) → a connection.
  const campaigns = await prisma.campaign.findMany({
    where: { externalCampaignId: { not: null } },
    select: { marketplace: true, adGroups: { select: { externalAdGroupId: true } } },
  })
  const agsByProfile = new Map<string, { region: AdsRegion; ids: Set<string> }>()
  for (const c of campaigns) {
    const code = normalizeMarketplaceCode(c.marketplace) ?? c.marketplace
    const conn = conns.find((x) => x.marketplace === code || x.marketplace === c.marketplace)
    if (!conn) continue
    const region: AdsRegion = (conn.region === 'NA' || conn.region === 'FE') ? (conn.region as AdsRegion) : 'EU'
    const bucket = agsByProfile.get(conn.profileId) ?? { region, ids: new Set<string>() }
    for (const ag of c.adGroups) if (ag.externalAdGroupId) bucket.ids.add(ag.externalAdGroupId)
    agsByProfile.set(conn.profileId, bucket)
  }

  let adGroups = 0, positives = 0, negatives = 0, upserted = 0, targetsUpdated = 0
  for (const [profileId, { region, ids }] of agsByProfile) {
    const all = [...ids]
    adGroups += all.length
    for (let i = 0; i < all.length; i += chunk) {
      const slice = all.slice(i, i + chunk)
      const [kw, tg] = await Promise.all([
        syncKeywordsForAdGroups({ profileId, region, externalAdGroupIds: slice }).catch((e) => { logger.warn('[kw-resync-all] kw chunk failed', { profileId, error: String(e).slice(0, 160) }); return null }),
        syncTargetsForAdGroups({ profileId, region, externalAdGroupIds: slice }).catch((e) => { logger.warn('[kw-resync-all] target chunk failed', { profileId, error: String(e).slice(0, 160) }); return null }),
      ])
      if (kw) { positives += kw.positives; negatives += kw.negatives; upserted += kw.upserted }
      if (tg) { targetsUpdated += tg.updated }
    }
  }
  // AF.7d — any ENABLED positive target still at €0 after both v3 syncs is a
  // stale row (its v1 id no longer matches a live Amazon clause) or an
  // auto-targeting clause inheriting the ad-group default. Stamp it with the
  // ad-group default bid so no enabled target misleadingly shows €0 — the
  // hourly resync still overwrites with the real bid for any we can fetch.
  const stamped = await prisma.$executeRaw`
    UPDATE "AdTarget" t SET "bidCents" = ag."defaultBidCents", "updatedAt" = NOW()
    FROM "AdGroup" ag
    WHERE t."adGroupId" = ag.id AND t."isNegative" = false
      AND t.status = 'ENABLED' AND t."bidCents" <= 0 AND ag."defaultBidCents" > 0`
  logger.info('[kw-resync-all] done', { profiles: agsByProfile.size, adGroups, positives, negatives, upserted, targetsUpdated, stampedDefault: stamped })
  return { profiles: agsByProfile.size, adGroups, positives, negatives, upserted, targetsUpdated, stampedDefault: stamped, mode }
}

/** Resolve a campaign's profile + ad groups, then sync its keywords via the list API. */
export async function syncCampaignKeywords(campaignId: string): Promise<KeywordSyncResult & { campaignId: string }> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { marketplace: true, adGroups: { select: { externalAdGroupId: true } } },
  })
  if (!campaign) throw new Error('campaign not found')
  const externalAdGroupIds = campaign.adGroups.map((g) => g.externalAdGroupId).filter((x): x is string => !!x)
  // Resolve the profile: campaign.marketplace is an Amazon marketplace id; the
  // connection stores the short code — match either.
  const { normalizeMarketplaceCode } = await import('../../utils/marketplace-code.js')
  const code = normalizeMarketplaceCode(campaign.marketplace) ?? campaign.marketplace
  const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { profileId: true, region: true, marketplace: true } })
  const conn = conns.find((c) => c.marketplace === code || c.marketplace === campaign.marketplace) ?? conns[0]
  if (!conn) throw new Error('no active ads connection')
  const region: AdsRegion = (conn.region === 'NA' || conn.region === 'FE') ? (conn.region as AdsRegion) : 'EU'
  const r = await syncKeywordsForAdGroups({ profileId: conn.profileId, region, externalAdGroupIds })
  return { ...r, campaignId }
}

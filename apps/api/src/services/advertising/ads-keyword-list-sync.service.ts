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

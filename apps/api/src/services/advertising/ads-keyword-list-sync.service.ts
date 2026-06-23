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

export interface KeywordSyncResult { positives: number; negatives: number; upserted: number; archived: number; adGroups: number; mode: string }

// H.9 — circuit-breaker for deletion reconciliation. Never archive an implausibly large fraction of a
// scope's live rows in one pass: a partial/empty fetch must not wipe the local mirror. Allow a small
// absolute floor (real small-scope deletions) but cap the proportion otherwise.
export function archiveAllowed(toArchive: number, liveTotal: number): boolean {
  if (toArchive === 0) return false
  return toArchive <= Math.max(20, Math.ceil(liveTotal * 0.5))
}

// H.9/H.11 — shared deletion reconciliation: archive ACTIVE local targets (with an external id) in the
// given ad groups that Amazon's current list no longer returns. `scope` narrows which targets this
// snapshot is authoritative for (kind / isNegative / negativeLevel) so e.g. the keyword list never
// archives product targets. Gated by the circuit-breaker; gated-local rows (no external id) are exempt.
// Caller must only invoke this when the upstream fetch SUCCEEDED. Exported for testing.
export async function archiveMissingTargets(localAdGroupIds: string[], seenExternalIds: Set<string>, scope: Record<string, unknown>): Promise<number> {
  if (localAdGroupIds.length === 0) return 0
  const live = await prisma.adTarget.findMany({
    where: { adGroupId: { in: localAdGroupIds }, externalTargetId: { not: null }, status: { in: ['ENABLED', 'PAUSED'] }, ...scope },
    select: { id: true, externalTargetId: true },
  })
  const toArchive = live.filter((t) => t.externalTargetId && !seenExternalIds.has(t.externalTargetId)).map((t) => t.id)
  if (!archiveAllowed(toArchive.length, live.length)) {
    if (toArchive.length) logger.warn('[target-archive] deletion guard tripped — skipping', { wouldArchive: toArchive.length, live: live.length })
    return 0
  }
  return (await prisma.adTarget.updateMany({ where: { id: { in: toArchive } }, data: { status: 'ARCHIVED', lastSyncedAt: new Date(), lastSyncStatus: 'SUCCESS', lastSyncError: null } })).count
}

interface V3TargetingClause { targetId?: string; adGroupId?: string; bid?: number; state?: string }

/**
 * AF.7b — sync PRODUCT / AUTO targeting-clause bids via v3 /sp/targets/list.
 * Keywords come from /sp/keywords; product & auto targets (ASIN, category,
 * close/loose match, substitutes/complements) live here and carry their own
 * bid — the v1 export left these at €0. Updates bidCents in place by targetId;
 * when a clause inherits the ad-group default (no explicit bid), stamps the
 * ad-group default so the UI shows the real effective bid, not €0.
 */
export async function syncTargetsForAdGroups(opts: { profileId: string; region: AdsRegion; externalAdGroupIds: string[] }): Promise<{ updated: number; archived: number; clauses: number }> {
  const { profileId, region, externalAdGroupIds } = opts
  if (adsMode() === 'sandbox' || externalAdGroupIds.length === 0) return { updated: 0, archived: 0, clauses: 0 }
  // H.11 — track fetch success so a failed list never drives deletion.
  let ok = true
  const clauses = await listAll(profileId, region, '/sp/targets/list', 'application/vnd.spTargetingClause.v3+json', 'targetingClauses', { adGroupIdFilter: { include: externalAdGroupIds } })
    .catch((e) => { ok = false; logger.warn('[target-list-sync] list failed', { error: String(e).slice(0, 160) }); return [] }) as V3TargetingClause[]

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
  // H.11 — reflect deletions: PRODUCT/AUTO/CATEGORY targets we hold locally (with an external id) that
  // /sp/targets/list no longer returns were deleted on Amazon → archive. Only on a successful fetch;
  // keywords + negatives are excluded (different lists own them).
  let archived = 0
  if (ok) {
    const seen = new Set(clauses.map((c) => c.targetId).filter((x): x is string => !!x))
    archived = await archiveMissingTargets([...agByExt.values()].map((g) => g.id), seen, { kind: { in: ['PRODUCT', 'AUTO', 'CATEGORY'] }, isNegative: false })
  }
  logger.info('[target-list-sync] done', { clauses: clauses.length, updated, archived, adGroups: externalAdGroupIds.length })
  return { updated, archived, clauses: clauses.length }
}

/** Sync positive + negative keywords for the given external ad-group ids. */
export async function syncKeywordsForAdGroups(opts: { profileId: string; region: AdsRegion; externalAdGroupIds: string[] }): Promise<KeywordSyncResult> {
  const { profileId, region, externalAdGroupIds } = opts
  if (adsMode() === 'sandbox' || externalAdGroupIds.length === 0) {
    return { positives: 0, negatives: 0, upserted: 0, archived: 0, adGroups: externalAdGroupIds.length, mode: adsMode() }
  }
  const filter = { adGroupIdFilter: { include: externalAdGroupIds } }
  // H.9 — track fetch success: an errored list must NEVER drive deletion (empty-on-error ≠ deleted).
  let posOk = true, negOk = true
  const [pos, neg] = await Promise.all([
    listAll(profileId, region, '/sp/keywords/list', 'application/vnd.spKeyword.v3+json', 'keywords', filter).catch((e) => { posOk = false; logger.warn('[kw-list-sync] keywords list failed', { error: String(e).slice(0, 160) }); return [] }),
    listAll(profileId, region, '/sp/negativeKeywords/list', 'application/vnd.spNegativeKeyword.v3+json', 'negativeKeywords', filter).catch((e) => { negOk = false; logger.warn('[kw-list-sync] negativeKeywords list failed', { error: String(e).slice(0, 160) }); return [] }),
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
  // H.9 — reflect deletions: a positive/ad-group-negative keyword we have locally WITH an external id
  // that Amazon's current list no longer returns was deleted on Amazon → archive it. Only when BOTH
  // fetches succeeded; never touches gated-local rows (no external id) or campaign-level negatives
  // (their ids come from a different list). Circuit-breaker guards against a partial fetch.
  let archived = 0
  if (posOk && negOk) {
    const seenExt = new Set(rows.map((r) => r.ext).filter((x): x is string => !!x))
    // Keyword list is authoritative for positive keywords + ad-group negatives only (campaign-level
    // negatives come from a different list, so they're excluded from this snapshot's deletion scope).
    archived = await archiveMissingTargets([...agMap.values()], seenExt, { kind: 'KEYWORD', OR: [{ isNegative: false }, { negativeLevel: 'AD_GROUP' }] })
  }
  logger.info('[kw-list-sync] done', { positives: pos.length, negatives: neg.length, upserted, archived, adGroups: externalAdGroupIds.length })
  return { positives: pos.length, negatives: neg.length, upserted, archived, adGroups: externalAdGroupIds.length, mode: adsMode() }
}

interface V3CampaignNegative { campaignNegativeKeywordId?: string; campaignId?: string; keywordText?: string; matchType?: string; state?: string }

/**
 * H.8 — upsert CAMPAIGN-level negatives pulled from Amazon. The v1 export skips these (no adGroupId)
 * so they were never mirrored. Stored as AdTarget (negativeLevel='CAMPAIGN', expressionType
 * 'NEGATIVE_<mt>') attached to a representative ad group of the campaign — the same shape
 * createNegativeKeywordCampaignLocal (H.7) writes. Reconciles by Amazon id first, then by
 * (campaign, matchType, text) so a locally-created H.7 row gets its Amazon id STAMPED rather than
 * duplicated. Exported so the dedup/reconcile can be tested without the live list API.
 */
export async function upsertCampaignNegativeRows(rows: V3CampaignNegative[], opts?: { archiveScopeCampaignExtIds?: string[] }): Promise<{ upserted: number; archived: number }> {
  const extIds = [...new Set(rows.map((r) => r.campaignId).filter((x): x is string => !!x))]
  const camps = await prisma.campaign.findMany({ where: { externalCampaignId: { in: extIds } }, select: { id: true, externalCampaignId: true, adGroups: { select: { id: true }, take: 1 } } })
  const campByExt = new Map(camps.map((c) => [c.externalCampaignId ?? '', c]))
  let upserted = 0
  for (const r of rows) {
    if (!r.campaignNegativeKeywordId || !r.campaignId) continue
    const camp = campByExt.get(r.campaignId)
    if (!camp || camp.adGroups.length === 0) continue // no ad group to attach the campaign-level negative to
    const mtRaw = (r.matchType ?? 'NEGATIVE_EXACT').toUpperCase()
    const expressionType = mtRaw.startsWith('NEGATIVE_') ? mtRaw : `NEGATIVE_${mtRaw}`
    const data = {
      adGroupId: camp.adGroups[0].id, externalTargetId: r.campaignNegativeKeywordId, kind: 'KEYWORD',
      expressionType, expressionValue: r.keywordText ?? '', bidCents: 0,
      status: STATE_MAP(r.state), isNegative: true, negativeLevel: 'CAMPAIGN',
      lastSyncedAt: new Date(), lastSyncStatus: 'SUCCESS' as const, lastSyncError: null,
    }
    try {
      // 1) match by Amazon id; 2) reconcile an H.7 local row (same campaign+mt+text, external id not yet
      //    stamped); 3) otherwise create. Prevents a duplicate when we created the negative locally first.
      const byId = await prisma.adTarget.findFirst({ where: { externalTargetId: r.campaignNegativeKeywordId }, select: { id: true } })
      const match = byId ?? await prisma.adTarget.findFirst({ where: { adGroup: { campaignId: camp.id }, isNegative: true, negativeLevel: 'CAMPAIGN', expressionType, expressionValue: r.keywordText ?? '' }, select: { id: true } })
      if (match) await prisma.adTarget.update({ where: { id: match.id }, data })
      else await prisma.adTarget.create({ data })
      upserted += 1
    } catch (e) { logger.warn('[camp-neg-sync] upsert failed', { ext: r.campaignNegativeKeywordId, error: String(e).slice(0, 120) }) }
  }
  // H.9 — reflect deletions: campaign negatives we have locally (WITH an external id) that Amazon's
  // current list no longer returns for the SCOPED campaigns were deleted on Amazon → archive. Caller
  // passes archiveScope only on a successful fetch, so an API error can never archive the mirror.
  let archived = 0
  const scope = opts?.archiveScopeCampaignExtIds
  if (scope?.length) {
    const scopeCamps = await prisma.campaign.findMany({ where: { externalCampaignId: { in: scope } }, select: { id: true } })
    const scopeIds = scopeCamps.map((c) => c.id)
    if (scopeIds.length) {
      const seenExt = new Set(rows.map((r) => r.campaignNegativeKeywordId).filter((x): x is string => !!x))
      const live = await prisma.adTarget.findMany({ where: { adGroup: { campaignId: { in: scopeIds } }, isNegative: true, negativeLevel: 'CAMPAIGN', externalTargetId: { not: null }, status: { in: ['ENABLED', 'PAUSED'] } }, select: { id: true, externalTargetId: true } })
      const toArchive = live.filter((t) => t.externalTargetId && !seenExt.has(t.externalTargetId)).map((t) => t.id)
      if (archiveAllowed(toArchive.length, live.length)) {
        archived = (await prisma.adTarget.updateMany({ where: { id: { in: toArchive } }, data: { status: 'ARCHIVED', lastSyncedAt: new Date(), lastSyncStatus: 'SUCCESS', lastSyncError: null } })).count
      } else if (toArchive.length) {
        logger.warn('[camp-neg-sync] deletion guard tripped — skipping archive', { wouldArchive: toArchive.length, live: live.length })
      }
    }
  }
  return { upserted, archived }
}

/** Sync CAMPAIGN-level negative keywords via v3 /sp/campaignNegativeKeywords/list for the given campaigns. */
export async function syncCampaignNegativesForCampaigns(opts: { profileId: string; region: AdsRegion; externalCampaignIds: string[] }): Promise<{ negatives: number; upserted: number; archived: number; campaigns: number }> {
  const { profileId, region, externalCampaignIds } = opts
  if (adsMode() === 'sandbox' || externalCampaignIds.length === 0) return { negatives: 0, upserted: 0, archived: 0, campaigns: externalCampaignIds.length }
  let ok = true
  const rows = (await listAll(profileId, region, '/sp/campaignNegativeKeywords/list', 'application/vnd.spCampaignNegativeKeyword.v3+json', 'campaignNegativeKeywords', { campaignIdFilter: { include: externalCampaignIds } })
    .catch((e) => { ok = false; logger.warn('[camp-neg-sync] list failed', { error: String(e).slice(0, 160) }); return [] })) as V3CampaignNegative[]
  // Pass archiveScope only when the fetch succeeded — so a failed list never archives the mirror.
  const { upserted, archived } = await upsertCampaignNegativeRows(rows, ok ? { archiveScopeCampaignExtIds: externalCampaignIds } : undefined)
  logger.info('[camp-neg-sync] done', { negatives: rows.length, upserted, archived, campaigns: externalCampaignIds.length })
  return { negatives: rows.length, upserted, archived, campaigns: externalCampaignIds.length }
}

/**
 * AF.7 — fleet-wide keyword resync. Pulls CURRENT keywords (with clean numeric
 * bids) for EVERY campaign's ad groups via the v3 list API, fixing the €0-bid
 * positives left by the v1 export (whose nested bid coerced to 0). Groups ad
 * groups by connection profile/region and chunks the list filter.
 */
export async function resyncAllCampaignKeywords(opts: { chunk?: number } = {}): Promise<{ profiles: number; adGroups: number; positives: number; negatives: number; upserted: number; targetsUpdated: number; campaignNegatives: number; archived: number; stampedDefault?: number; mode: string }> {
  const chunk = opts.chunk ?? 40
  const mode = adsMode()
  if (mode === 'sandbox') return { profiles: 0, adGroups: 0, positives: 0, negatives: 0, upserted: 0, targetsUpdated: 0, campaignNegatives: 0, archived: 0, mode }

  const { normalizeMarketplaceCode } = await import('../../utils/marketplace-code.js')
  const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { profileId: true, region: true, marketplace: true } })
  // Map each campaign's marketplace (short code or Amazon id) → a connection.
  const campaigns = await prisma.campaign.findMany({
    where: { externalCampaignId: { not: null } },
    select: { marketplace: true, externalCampaignId: true, adGroups: { select: { externalAdGroupId: true } } },
  })
  const agsByProfile = new Map<string, { region: AdsRegion; ids: Set<string>; campaignIds: Set<string> }>()
  for (const c of campaigns) {
    const code = normalizeMarketplaceCode(c.marketplace) ?? c.marketplace
    const conn = conns.find((x) => x.marketplace === code || x.marketplace === c.marketplace)
    if (!conn) continue
    const region: AdsRegion = (conn.region === 'NA' || conn.region === 'FE') ? (conn.region as AdsRegion) : 'EU'
    const bucket = agsByProfile.get(conn.profileId) ?? { region, ids: new Set<string>(), campaignIds: new Set<string>() }
    for (const ag of c.adGroups) if (ag.externalAdGroupId) bucket.ids.add(ag.externalAdGroupId)
    if (c.externalCampaignId) bucket.campaignIds.add(c.externalCampaignId)
    agsByProfile.set(conn.profileId, bucket)
  }

  let adGroups = 0, positives = 0, negatives = 0, upserted = 0, targetsUpdated = 0, campaignNegatives = 0, archived = 0
  for (const [profileId, { region, ids, campaignIds }] of agsByProfile) {
    const all = [...ids]
    adGroups += all.length
    for (let i = 0; i < all.length; i += chunk) {
      const slice = all.slice(i, i + chunk)
      const [kw, tg] = await Promise.all([
        syncKeywordsForAdGroups({ profileId, region, externalAdGroupIds: slice }).catch((e) => { logger.warn('[kw-resync-all] kw chunk failed', { profileId, error: String(e).slice(0, 160) }); return null }),
        syncTargetsForAdGroups({ profileId, region, externalAdGroupIds: slice }).catch((e) => { logger.warn('[kw-resync-all] target chunk failed', { profileId, error: String(e).slice(0, 160) }); return null }),
      ])
      if (kw) { positives += kw.positives; negatives += kw.negatives; upserted += kw.upserted; archived += kw.archived }
      if (tg) { targetsUpdated += tg.updated; archived += tg.archived }
    }
    // H.8 — campaign-level negatives (filtered by campaign, not ad group), chunked the same way.
    const allCamps = [...campaignIds]
    for (let i = 0; i < allCamps.length; i += chunk) {
      const cn = await syncCampaignNegativesForCampaigns({ profileId, region, externalCampaignIds: allCamps.slice(i, i + chunk) })
        .catch((e) => { logger.warn('[kw-resync-all] camp-neg chunk failed', { profileId, error: String(e).slice(0, 160) }); return null })
      if (cn) { campaignNegatives += cn.upserted; archived += cn.archived }
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
  logger.info('[kw-resync-all] done', { profiles: agsByProfile.size, adGroups, positives, negatives, upserted, targetsUpdated, campaignNegatives, archived, stampedDefault: stamped })
  return { profiles: agsByProfile.size, adGroups, positives, negatives, upserted, targetsUpdated, campaignNegatives, archived, stampedDefault: stamped, mode }
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

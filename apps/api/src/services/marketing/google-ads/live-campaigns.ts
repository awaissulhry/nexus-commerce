/**
 * Google Ads changes, PR 2 (2026-10-15) — the live reads campaigns, targeting and status changes stand on: a campaign's
 * criteria, the status of ad groups / keywords / ads by id, and Google's lookups (locations, languages, audiences) so a
 * person or Claude can name them by id. Fields checked on 2026-10-15 in the v25 field reference: geo_target_constant.{id,
 * name, canonical_name, country_code, target_type, status}, language_constant.{id, code, name, targetable},
 * user_interest.{user_interest_id, name, taxonomy_type, launched_to_all} — all selectable and filterable.
 */
import { liveRows } from './write-client.js'
import { gaqlId, liveCampaignCriteriaQuery, liveCriterionOf, type LiveCriterion, INCLUDE_DRAFTS, noteCampaignRow } from './live.js'
import type { GoogleAdsTarget } from './types.js'

type Json = Record<string, any>
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)

/** A campaign's criteria that are not removed (locations, languages, schedule, audiences, negatives …). */
export async function liveCampaignCriteria(target: GoogleAdsTarget, campaignId: string): Promise<LiveCriterion[]> {
  return (await liveRows<Json>(target, liveCampaignCriteriaQuery(campaignId), 'ads.search.live.criteria')).map(liveCriterionOf)
}

// ── status by id ────────────────────────────────────────────────────────────────────────────────────────────────

export interface LiveStatusItem {
  kind: 'campaign' | 'ad-group' | 'keyword' | 'ad'
  /** campaign / ad group: its id; keyword: `adGroupId~criterionId`; ad: `adGroupId~adId`. */
  id: string
  name: string
  status: string | null
  campaignId: string
  campaignName: string
  campaignStatus: string | null
  adGroupStatus: string | null
  /** A keyword: true when it is a negative keyword (removing one lets more searches show the ads). */
  negative?: boolean
}

const inList = (ids: string[], what: string) => ids.map((id) => gaqlId(id, what)).join(', ')

export const liveAdGroupStatusQuery = (adGroupIds: string[]): string =>
  'SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name, campaign.status, campaign.experiment_type FROM ad_group ' +
  `WHERE ad_group.id IN (${inList(adGroupIds, 'The ad group')})${INCLUDE_DRAFTS}`

export const liveKeywordStatusQuery = (adGroupIds: string[], criterionIds: string[]): string =>
  'SELECT ad_group.id, ad_group.status, ad_group_criterion.criterion_id, ad_group_criterion.status, ' +
  'ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.negative, campaign.id, ' +
  `campaign.name, campaign.status, campaign.experiment_type FROM ad_group_criterion WHERE ad_group.id IN (${inList(adGroupIds, 'The ad group')}) ` +
  `AND ad_group_criterion.criterion_id IN (${inList(criterionIds, 'The keyword')})${INCLUDE_DRAFTS}`

export const liveAdStatusQuery = (adGroupIds: string[], adIds: string[]): string =>
  'SELECT ad_group.id, ad_group.status, ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.ad.type, campaign.id, ' +
  `campaign.name, campaign.status, campaign.experiment_type FROM ad_group_ad WHERE ad_group.id IN (${inList(adGroupIds, 'The ad group')}) ` +
  `AND ad_group_ad.ad.id IN (${inList(adIds, 'The ad')})${INCLUDE_DRAFTS}`

/** `adGroupId~childId` → its two parts, or null. */
export function pairOf(id: string): [string, string] | null {
  const m = /^(\d{1,20})~(\d{1,20})$/.exec(id.trim())
  return m ? [m[1], m[2]] : null
}

/**
 * The current status of ad groups, keywords and ads by id (one query per kind asked; campaigns come from
 * liveCampaigns). What Google does not return is missing from the answer (removed, or not in this account).
 */
export async function liveStatuses(target: GoogleAdsTarget, ask: { adGroups: string[]; keywords: string[]; ads: string[] }): Promise<LiveStatusItem[]> {
  const out: LiveStatusItem[] = []
  if (ask.adGroups.length) {
    for (const r of await liveRows<Json>(target, liveAdGroupStatusQuery(ask.adGroups), 'ads.search.live.status')) {
      noteCampaignRow(r)
      out.push({
        kind: 'ad-group', id: str(r.adGroup?.id) ?? '', name: str(r.adGroup?.name) ?? '', status: str(r.adGroup?.status),
        campaignId: str(r.campaign?.id) ?? '', campaignName: str(r.campaign?.name) ?? '', campaignStatus: str(r.campaign?.status), adGroupStatus: str(r.adGroup?.status),
      })
    }
  }
  const pairs = (ids: string[]) => ids.map(pairOf).filter((p): p is [string, string] => !!p)
  const keywordPairs = pairs(ask.keywords)
  if (keywordPairs.length) {
    const wanted = new Set(ask.keywords)
    const rows = await liveRows<Json>(target, liveKeywordStatusQuery([...new Set(keywordPairs.map((p) => p[0]))], [...new Set(keywordPairs.map((p) => p[1]))]), 'ads.search.live.status')
    for (const r of rows) {
      const id = `${str(r.adGroup?.id)}~${str(r.adGroupCriterion?.criterionId)}`
      if (!wanted.has(id)) continue
      noteCampaignRow(r)
      const k = r.adGroupCriterion?.keyword ?? {}
      out.push({
        kind: 'keyword', id, name: `${str(k.text) ?? ''} (${str(k.matchType) ?? '?'}${r.adGroupCriterion?.negative ? ', negative' : ''})`, status: str(r.adGroupCriterion?.status), negative: r.adGroupCriterion?.negative === true,
        campaignId: str(r.campaign?.id) ?? '', campaignName: str(r.campaign?.name) ?? '', campaignStatus: str(r.campaign?.status), adGroupStatus: str(r.adGroup?.status),
      })
    }
  }
  const adPairs = pairs(ask.ads)
  if (adPairs.length) {
    const wanted = new Set(ask.ads)
    const rows = await liveRows<Json>(target, liveAdStatusQuery([...new Set(adPairs.map((p) => p[0]))], [...new Set(adPairs.map((p) => p[1]))]), 'ads.search.live.status')
    for (const r of rows) {
      const id = `${str(r.adGroup?.id)}~${str(r.adGroupAd?.ad?.id)}`
      if (!wanted.has(id)) continue
      noteCampaignRow(r)
      out.push({
        kind: 'ad', id, name: `ad ${str(r.adGroupAd?.ad?.id)} (${str(r.adGroupAd?.ad?.type) ?? 'ad'})`, status: str(r.adGroupAd?.status),
        campaignId: str(r.campaign?.id) ?? '', campaignName: str(r.campaign?.name) ?? '', campaignStatus: str(r.campaign?.status), adGroupStatus: str(r.adGroup?.status),
      })
    }
  }
  return out
}

// ── lookups ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type LookupKind = 'locations' | 'languages' | 'audiences'

/** GAQL string literal: single quotes and backslashes escaped; a LIKE pattern's own wildcards taken literally. */
function likeValue(text: string): string {
  const cleaned = text.trim().slice(0, 80).replace(/[\\'"]/g, ' ').replace(/[%_[\]]/g, ' ').trim()
  if (!cleaned) throw new Error('Give a word to look for. Nothing was sent.')
  return `'%${cleaned}%'`
}

export function lookupQuery(kind: LookupKind, search: string): string {
  const like = likeValue(search)
  switch (kind) {
    case 'locations':
      return 'SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.canonical_name, ' +
        'geo_target_constant.country_code, geo_target_constant.target_type, geo_target_constant.status FROM geo_target_constant ' +
        `WHERE geo_target_constant.name LIKE ${like} AND geo_target_constant.status = 'ENABLED' LIMIT 50`
    case 'languages':
      return 'SELECT language_constant.id, language_constant.code, language_constant.name, language_constant.targetable ' +
        `FROM language_constant WHERE language_constant.name LIKE ${like} LIMIT 50`
    case 'audiences':
      return 'SELECT user_interest.user_interest_id, user_interest.name, user_interest.taxonomy_type, user_interest.launched_to_all ' +
        `FROM user_interest WHERE user_interest.name LIKE ${like} LIMIT 50`
  }
}

export interface LookupRow { id: string; name: string | null; detail: string | null; type: string | null }

/** Google's own ids for locations, languages and audiences (in-market and affinity) whose name holds `search`. */
export async function liveLookup(target: GoogleAdsTarget, kind: LookupKind, search: string): Promise<LookupRow[]> {
  const rows = await liveRows<Json>(target, lookupQuery(kind, search), 'ads.search.live.lookup')
  return rows.map((r) => {
    if (kind === 'locations') {
      const g = r.geoTargetConstant ?? {}
      return { id: str(g.id) ?? '', name: str(g.name), detail: str(g.canonicalName) ?? str(g.countryCode), type: str(g.targetType) }
    }
    if (kind === 'languages') {
      const l = r.languageConstant ?? {}
      return { id: str(l.id) ?? '', name: str(l.name), detail: str(l.code), type: l.targetable === false ? 'not targetable' : 'language' }
    }
    const u = r.userInterest ?? {}
    return { id: str(u.userInterestId) ?? '', name: str(u.name), detail: u.launchedToAll === false ? 'not launched to all' : null, type: str(u.taxonomyType) }
  })
}

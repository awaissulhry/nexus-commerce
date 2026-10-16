/**
 * Google Ads changes, G7 (2026-10-15, Owner's brief "full control of Google Ads through Nexus") — exclusions, read live
 * from Google: the account's own exclusions (CustomerNegativeCriterion), a campaign's exclusions (CampaignCriterion,
 * negative), and the shared exclusion lists — the account's negative keyword list (ACCOUNT_LEVEL_NEGATIVE_KEYWORDS),
 * placement lists (NEGATIVE_PLACEMENTS) and brand lists (BRANDS) — with what they hold and where each is used. The "from"
 * side of set-google-account-exclusions, set-google-campaign-exclusions and set-google-exclusion-list, and of the
 * google-ads-live view exclusions. One GAQL query per part, on the account's change allowance (write-client.ts liveRows).
 *
 * Checked 2026-10-15 in Google's v25 reference (curl of developers.google.com/google-ads/api/reference/rpc/v25/… and
 * …/fields/v25/…):
 *   - CustomerNegativeCriterion: oneof content_label, ip_block ("up to 500 IP addresses per account"),
 *     mobile_app_category, mobile_application, negative_keyword_list, placement, placement_list, youtube_channel,
 *     youtube_video; id, type output only; resource name customers/{c}/customerNegativeCriteria/{id}. Every field of
 *     customer_negative_criterion below is selectable (and filterable); the resource has no status.
 *   - CampaignCriterion: the same infos (ip_block: "up to 500 IP addresses per campaign"), plus brand_list (BrandListInfo
 *     shared_set) and negative; every campaign_criterion field below selectable and filterable.
 *   - SharedSet.type (SharedSetType): ACCOUNT_LEVEL_NEGATIVE_KEYWORDS, BRANDS, NEGATIVE_KEYWORDS, NEGATIVE_PLACEMENTS, …
 *     SharedCriterion: oneof brand (BrandInfo entity_id; display_name, status, primary_url output only), keyword,
 *     mobile_app_category, mobile_application, placement, youtube_channel, youtube_video, …; every shared_criterion
 *     field below selectable. campaign_shared_set and ad_group_criterion.brand_list.shared_set selectable and filterable.
 *   - MobileAppCategoryConstant resource name: mobileAppCategoryConstants/{mobile_app_category_id}.
 *   - Guide targeting/criteria (v25): content label and IP block only negative, at campaign and customer level;
 *     placement, YouTube channel / video, mobile app and app category negative at every level; a negative keyword list
 *     only at customer level ("Links an ACCOUNT_LEVEL_NEGATIVE_KEYWORDS shared set to an account (at most one per
 *     account)"); a placement list only at customer level; placement URL ≤ 250 characters, adsenseformobileapps.com not
 *     allowed. Guide targeting/shared-sets: NEGATIVE_KEYWORDS / NEGATIVE_PLACEMENTS go on campaigns through
 *     CampaignSharedSet, BRANDS through CampaignCriterion.brand_list (an ad group only as an inclusion).
 *   - BrandSuggestionService.SuggestBrands: `POST /v25/customers/{customer_id}:suggestBrands`, body brand_prefix
 *     (required), selected_brands; answer brands[] of { id (the brand's id, a CKG MID for verified brands), name, state,
 *     urls } (googleapis brand_suggestion_service.proto v25; reference rpc/v25/SuggestBrandsRequest, BrandSuggestion).
 * Every filter below is on a field the same query selects (Google refuses some filters on a field it does not select).
 */
import { isIP } from 'node:net'
import { googleCall } from '../../gateway/google.js'
import type { GatewayNoAnswer, GatewayRefusal } from '../../gateway/gateway.js'
import { GOOGLE_ADS_API_BASE } from '../../google/api-version.js'
import { failureFromGatewayRefusal, failureFromNoAnswer, GoogleAdsReadError, localFailure, parseGoogleAdsFailure } from './errors.js'
import { gaqlId, idOf, type LiveListKeyword, type MatchType, INCLUDE_DRAFTS } from './live.js'
import { byGoogleId } from './live-keywords.js'
import { customerIdDigits } from './mappers.js'
import { markQuotaExhausted, releaseOps, reserveOps } from './ops-budget.js'
import { liveRows } from './write-client.js'
import type { GoogleAdsTarget } from './types.js'

type Json = Record<string, any>
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)

// ── what an exclusion is ─────────────────────────────────────────────────────────────────────────────────────────

/** What can be excluded one by one, at the account and at a campaign. */
export const EXCLUSION_KINDS = ['placement', 'youtube-channel', 'youtube-video', 'mobile-app', 'app-category', 'content-label', 'ip-block'] as const
export type ExclusionKind = typeof EXCLUSION_KINDS[number]
/** What a placement list (NEGATIVE_PLACEMENTS) holds: SharedCriterion has no content label and no IP block. */
export const PLACEMENT_LIST_KINDS = ['placement', 'youtube-channel', 'youtube-video', 'mobile-app', 'app-category'] as const

/** ContentLabelType (v25), without UNKNOWN / UNSPECIFIED. */
export const CONTENT_LABELS = [
  'BELOW_THE_FOLD', 'BRAND_SUITABILITY_CONTENT_FOR_FAMILIES', 'BRAND_SUITABILITY_GAMES_FIGHTING', 'BRAND_SUITABILITY_GAMES_MATURE',
  'BRAND_SUITABILITY_HEALTH_SENSITIVE', 'BRAND_SUITABILITY_HEALTH_SOURCE_UNDETERMINED', 'BRAND_SUITABILITY_NEWS_RECENT',
  'BRAND_SUITABILITY_NEWS_SENSITIVE', 'BRAND_SUITABILITY_NEWS_SOURCE_NOT_FEATURED', 'BRAND_SUITABILITY_POLITICS',
  'BRAND_SUITABILITY_RELIGION', 'EMBEDDED_VIDEO', 'JUVENILE', 'LIVE_STREAMING_VIDEO', 'PARKED_DOMAIN', 'PROFANITY',
  'SEXUALLY_SUGGESTIVE', 'SOCIAL_ISSUES', 'TRAGEDY', 'VIDEO', 'VIDEO_NOT_YET_RATED', 'VIDEO_RATING_DV_G', 'VIDEO_RATING_DV_MA',
  'VIDEO_RATING_DV_PG', 'VIDEO_RATING_DV_T',
] as const

/**
 * One exclusion: a website (placement: its URL), a YouTube channel (its channel id) or video (its video id), a mobile app
 * (Google's app id `1-<App Store id>` or `2-<Android package>`), an app category (its id), a content label (its type) or
 * an IP address / CIDR block.
 */
export interface ExclusionItem { kind: ExclusionKind; value: string }
export interface LiveExclusion extends ExclusionItem { criterionId: string; name: string | null }

const CRITERION_TYPE: Record<ExclusionKind, string> = {
  placement: 'PLACEMENT', 'youtube-channel': 'YOUTUBE_CHANNEL', 'youtube-video': 'YOUTUBE_VIDEO', 'mobile-app': 'MOBILE_APPLICATION',
  'app-category': 'MOBILE_APP_CATEGORY', 'content-label': 'CONTENT_LABEL', 'ip-block': 'IP_BLOCK',
}
export const KIND_WORD: Record<ExclusionKind, string> = {
  placement: 'website', 'youtube-channel': 'YouTube channel', 'youtube-video': 'YouTube video', 'mobile-app': 'app',
  'app-category': 'app category', 'content-label': 'content label', 'ip-block': 'IP address',
}

const APP_CATEGORY = 'mobileAppCategoryConstants/'

/** The criterion's info as Google's JSON names it (the same on CustomerNegativeCriterion, CampaignCriterion, SharedCriterion). */
export function exclusionInfo(item: ExclusionItem): Record<string, unknown> {
  switch (item.kind) {
    case 'placement': return { placement: { url: item.value } }
    case 'youtube-channel': return { youtubeChannel: { channelId: item.value } }
    case 'youtube-video': return { youtubeVideo: { videoId: item.value } }
    case 'mobile-app': return { mobileApplication: { appId: item.value } }
    case 'app-category': return { mobileAppCategory: { mobileAppCategoryConstant: `${APP_CATEGORY}${item.value}` } }
    case 'content-label': return { contentLabel: { type: item.value } }
    case 'ip-block': return { ipBlock: { ipAddress: item.value } }
  }
}

/** The exclusion a criterion's JSON holds (any of the three resources), or null for another kind of criterion. */
export function exclusionOf(c: Json): (ExclusionItem & { name: string | null }) | null {
  if (c.placement) return { kind: 'placement', value: str(c.placement.url) ?? '', name: null }
  if (c.youtubeChannel) return { kind: 'youtube-channel', value: str(c.youtubeChannel.channelId) ?? '', name: null }
  if (c.youtubeVideo) return { kind: 'youtube-video', value: str(c.youtubeVideo.videoId) ?? '', name: null }
  if (c.mobileApplication) return { kind: 'mobile-app', value: str(c.mobileApplication.appId) ?? '', name: str(c.mobileApplication.name) }
  if (c.mobileAppCategory) {
    const constant = str(c.mobileAppCategory.mobileAppCategoryConstant) ?? ''
    return { kind: 'app-category', value: constant.startsWith(APP_CATEGORY) ? constant.slice(APP_CATEGORY.length) : constant, name: null }
  }
  if (c.contentLabel) return { kind: 'content-label', value: str(c.contentLabel.type) ?? '', name: null }
  if (c.ipBlock) return { kind: 'ip-block', value: str(c.ipBlock.ipAddress) ?? '', name: null }
  return null
}

/** An exclusion's identity: the same website, channel, video, app, category, label or address however it is written. */
export function exclusionKey(item: ExclusionItem): string {
  const v = item.value.trim()
  switch (item.kind) {
    case 'placement': return `placement:${v.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
    case 'content-label': return `content-label:${v.toUpperCase()}`
    case 'ip-block': {
      // One address written as a CIDR block of itself (/32, /128) is that address.
      const low = v.toLowerCase()
      const [address, prefix] = low.split('/')
      const family = isIP(address)
      return `ip-block:${(family === 4 && prefix === '32') || (family === 6 && prefix === '128') ? address : low}`
    }
    default: return `${item.kind}:${v}`
  }
}

/** An exclusion in words: `website example.com`, `content label TRAGEDY`. */
export const exclusionWords = (item: ExclusionItem & { name?: string | null }) => `${KIND_WORD[item.kind]} ${item.value}${item.name ? ` (${item.name})` : ''}`

/**
 * The exclusion as Google takes it, or why not (checked before anything is sent): YouTube links become ids, an app
 * category resource name its id, a content label its upper-case type.
 */
export function normalizeExclusion(item: ExclusionItem): ExclusionItem | { problem: string } {
  const v = String(item.value ?? '').trim()
  const bad = (why: string) => ({ problem: `${KIND_WORD[item.kind] ?? item.kind} "${v.slice(0, 80)}": ${why}` })
  if (!v) return bad('it is empty')
  switch (item.kind) {
    case 'placement':
      if (v.length > 250) return bad('Google takes a placement URL of at most 250 characters')
      if (/\s/.test(v)) return bad('a placement URL has no spaces')
      if (/adsenseformobileapps\.com/i.test(v)) return bad('Google does not allow adsenseformobileapps.com as a placement (exclude the app instead)')
      return { kind: 'placement', value: v }
    case 'youtube-video': {
      const fromLink = /(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/.exec(v)?.[1]
      const id = fromLink ?? v
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? { kind: 'youtube-video', value: id } : bad('give the video id as on its YouTube watch page (11 characters), or its link')
    }
    case 'youtube-channel': {
      const id = /\/channel\/([A-Za-z0-9_-]+)/.exec(v)?.[1] ?? v
      return /^[A-Za-z0-9_-]{1,100}$/.test(id) ? { kind: 'youtube-channel', value: id } : bad('give the YouTube channel id (e.g. UC…) or a youtube.com/channel/… link')
    }
    case 'mobile-app':
      return /^[12]-[A-Za-z0-9._]{1,250}$/.test(v) ? { kind: 'mobile-app', value: v } : bad('Google\'s app id is "1-<App Store id>" (iOS) or "2-<package name>" (Android), e.g. 1-476943146 or 2-com.example.app')
    case 'app-category': {
      const id = v.startsWith(APP_CATEGORY) ? v.slice(APP_CATEGORY.length) : v
      return /^\d{1,12}$/.test(id) ? { kind: 'app-category', value: id } : bad('give the app category id (digits)')
    }
    case 'content-label': {
      const type = v.toUpperCase()
      return (CONTENT_LABELS as readonly string[]).includes(type) ? { kind: 'content-label', value: type } : bad(`Google's content labels are ${CONTENT_LABELS.join(', ')}`)
    }
    case 'ip-block': {
      const [address, prefix, ...rest] = v.split('/')
      const family = isIP(address)
      if (!family || rest.length) return bad('give an IPv4 or IPv6 address, or a CIDR block (e.g. 192.0.2.0/24)')
      if (prefix !== undefined && (!/^\d{1,3}$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128))) return bad(`the CIDR prefix is 0 to ${family === 4 ? 32 : 128}`)
      return { kind: 'ip-block', value: v.toLowerCase() }
    }
    default:
      return bad('Nexus does not know this kind of exclusion')
  }
}

/** Google's IP block limit (CustomerNegativeCriterion.ip_block, CampaignCriterion.ip_block, v25): 500 per account / campaign. */
export const MAX_IP_BLOCKS = 500

// ── the account's own exclusions ─────────────────────────────────────────────────────────────────────────────────

/**
 * The info fields of each kind. shared_criterion has no content_label and no ip_block (its oneof, v25; fields/v25/
 * shared_criterion lists neither, and Google refuses an unknown field in SELECT), so a list query leaves them out.
 */
const INFO_FIELDS = (resource: string) => [
  `${resource}.placement.url`, `${resource}.youtube_channel.channel_id`, `${resource}.youtube_video.video_id`,
  `${resource}.mobile_application.app_id`, `${resource}.mobile_application.name`,
  `${resource}.mobile_app_category.mobile_app_category_constant`,
  ...(resource === 'shared_criterion' ? [] : [`${resource}.content_label.type`, `${resource}.ip_block.ip_address`]),
]

export const LIVE_ACCOUNT_EXCLUSIONS_QUERY =
  `SELECT customer_negative_criterion.id, customer_negative_criterion.type, ${INFO_FIELDS('customer_negative_criterion').join(', ')}, ` +
  'customer_negative_criterion.negative_keyword_list.shared_set, customer_negative_criterion.placement_list.shared_set ' +
  'FROM customer_negative_criterion'

export interface LiveAccountExclusions {
  items: LiveExclusion[]
  /** The account's negative keyword list (Google allows one), by its link. */
  keywordList: { criterionId: string; listId: string } | null
  /** Placement lists on the whole account. */
  placementLists: Array<{ criterionId: string; listId: string }>
  /** Account-level criteria of another kind (read, not changed here). */
  other: Array<{ criterionId: string; type: string | null }>
}

export function liveAccountExclusionsOf(rows: Json[]): LiveAccountExclusions {
  const out: LiveAccountExclusions = { items: [], keywordList: null, placementLists: [], other: [] }
  for (const row of rows) {
    const c = row.customerNegativeCriterion ?? {}
    const criterionId = str(c.id) ?? ''
    const item = exclusionOf(c)
    if (item) out.items.push({ ...item, criterionId })
    else if (c.negativeKeywordList) out.keywordList = { criterionId, listId: idOf(c.negativeKeywordList.sharedSet) ?? '' }
    else if (c.placementList) out.placementLists.push({ criterionId, listId: idOf(c.placementList.sharedSet) ?? '' })
    else out.other.push({ criterionId, type: str(c.type) })
  }
  out.items.sort((a, b) => a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value))
  return out
}

export async function liveAccountExclusions(target: GoogleAdsTarget): Promise<LiveAccountExclusions> {
  return liveAccountExclusionsOf(await liveRows<Json>(target, LIVE_ACCOUNT_EXCLUSIONS_QUERY, 'ads.search.live.account-exclusions'))
}

// ── one campaign's exclusions ────────────────────────────────────────────────────────────────────────────────────

const CAMPAIGN_EXCLUSION_TYPES = [...Object.values(CRITERION_TYPE), 'BRAND_LIST']

export const liveCampaignExclusionsQuery = (campaignId: string): string =>
  'SELECT campaign.id, campaign.status, campaign_criterion.criterion_id, campaign_criterion.type, campaign_criterion.negative, ' +
  `campaign_criterion.status, ${INFO_FIELDS('campaign_criterion').join(', ')}, campaign_criterion.brand_list.shared_set ` +
  `FROM campaign_criterion WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} ` +
  `AND campaign_criterion.type IN (${CAMPAIGN_EXCLUSION_TYPES.map((t) => `'${t}'`).join(', ')}) ` +
  `AND campaign_criterion.status != 'REMOVED' AND campaign.status != 'REMOVED'${INCLUDE_DRAFTS}`

export interface LiveCampaignExclusions {
  /** Its exclusions (negative criteria of the kinds above). */
  items: LiveExclusion[]
  /** Brand lists on it: excluded (negative) or included (a brand restriction). */
  brandLists: Array<{ criterionId: string; listId: string; mode: 'exclude' | 'include' }>
  /** Websites, channels, videos or apps it TARGETS (a positive placement): read, not changed here. */
  targeted: number
}

export function liveCampaignExclusionsOf(rows: Json[]): LiveCampaignExclusions {
  const out: LiveCampaignExclusions = { items: [], brandLists: [], targeted: 0 }
  for (const row of rows) {
    const c = row.campaignCriterion ?? {}
    const criterionId = str(c.criterionId) ?? ''
    if (c.brandList) { out.brandLists.push({ criterionId, listId: idOf(c.brandList.sharedSet) ?? '', mode: c.negative === true ? 'exclude' : 'include' }); continue }
    const item = exclusionOf(c)
    if (!item) continue
    if (c.negative === true) out.items.push({ ...item, criterionId })
    else out.targeted += 1
  }
  out.items.sort((a, b) => a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value))
  return out
}

export async function liveCampaignExclusions(target: GoogleAdsTarget, campaignId: string): Promise<LiveCampaignExclusions> {
  return liveCampaignExclusionsOf(await liveRows<Json>(target, liveCampaignExclusionsQuery(campaignId), 'ads.search.live.campaign-exclusions'))
}

// ── exclusion lists ──────────────────────────────────────────────────────────────────────────────────────────────

export const EXCLUSION_LIST_TYPES = ['ACCOUNT_LEVEL_NEGATIVE_KEYWORDS', 'NEGATIVE_PLACEMENTS', 'BRANDS'] as const
export type ExclusionListType = typeof EXCLUSION_LIST_TYPES[number]

const inTypes = (types: readonly ExclusionListType[]) => types.map((t) => `'${t}'`).join(', ')

export const liveExclusionSetsQuery = (types: readonly ExclusionListType[] = EXCLUSION_LIST_TYPES): string =>
  'SELECT shared_set.id, shared_set.name, shared_set.type, shared_set.status, shared_set.member_count, shared_set.reference_count ' +
  `FROM shared_set WHERE shared_set.type IN (${inTypes(types)}) AND shared_set.status = 'ENABLED'`

/** Placement lists on campaigns (CampaignSharedSet). */
export const LIVE_PLACEMENT_LIST_LINKS_QUERY =
  'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, shared_set.id, shared_set.type, ' +
  "campaign_shared_set.status FROM campaign_shared_set WHERE shared_set.type = 'NEGATIVE_PLACEMENTS' " +
  "AND campaign_shared_set.status = 'ENABLED' AND campaign.status != 'REMOVED'"

/** Brand lists on campaigns (CampaignCriterion.brand_list: negative = excluded, else included). */
export const LIVE_BRAND_LIST_LINKS_QUERY =
  'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_criterion.criterion_id, ' +
  'campaign_criterion.type, campaign_criterion.negative, campaign_criterion.status, campaign_criterion.brand_list.shared_set ' +
  "FROM campaign_criterion WHERE campaign_criterion.type = 'BRAND_LIST' AND campaign_criterion.status != 'REMOVED' " +
  "AND campaign.status != 'REMOVED'"

/** Brand lists on ad groups (inclusions only; Google refuses an ad group exclusion): read, so a change says who it reaches. */
export const LIVE_AD_GROUP_BRAND_LIST_LINKS_QUERY =
  'SELECT campaign.id, campaign.status, ad_group.id, ad_group.name, ad_group.status, ad_group_criterion.criterion_id, ' +
  'ad_group_criterion.type, ad_group_criterion.status, ad_group_criterion.brand_list.shared_set FROM ad_group_criterion ' +
  "WHERE ad_group_criterion.type = 'BRAND_LIST' AND ad_group_criterion.status != 'REMOVED' AND ad_group.status != 'REMOVED' " +
  "AND campaign.status != 'REMOVED'"

export const liveExclusionListItemsQuery = (listId: string): string =>
  'SELECT shared_set.id, shared_criterion.criterion_id, shared_criterion.type, shared_criterion.keyword.text, ' +
  `shared_criterion.keyword.match_type, ${INFO_FIELDS('shared_criterion').join(', ')}, shared_criterion.brand.entity_id, ` +
  'shared_criterion.brand.display_name, shared_criterion.brand.status, shared_criterion.brand.primary_url ' +
  `FROM shared_criterion WHERE shared_set.id = ${gaqlId(listId, 'The list')}`

export interface LiveBrand { criterionId: string; entityId: string; name: string | null; status: string | null; url: string | null }

export interface ExclusionListCampaign {
  campaignId: string
  name: string
  status: string | null
  type: string | null
  mode: 'exclude' | 'include'
  /** The brand list's campaign criterion (a placement list's link is named by campaign~list). */
  criterionId: string | null
}

export interface LiveExclusionList {
  listId: string
  name: string | null
  type: ExclusionListType
  itemCount: number
  campaigns: ExclusionListCampaign[]
  /** A brand list included on ad groups (read only here). */
  adGroups: Array<{ adGroupId: string; name: string; status: string | null; campaignId: string; campaignStatus: string | null }>
  /** On the whole account (CustomerNegativeCriterion): the link's criterion id. */
  account: { criterionId: string } | null
  /** One list's content, when it was asked for. */
  keywords?: LiveListKeyword[]
  items?: LiveExclusion[]
  brands?: LiveBrand[]
}

export interface ExclusionListItems { keywords: LiveListKeyword[]; items: LiveExclusion[]; brands: LiveBrand[] }

export function exclusionListItemsOf(rows: Json[]): ExclusionListItems {
  const out: ExclusionListItems = { keywords: [], items: [], brands: [] }
  for (const row of rows) {
    const c = row.sharedCriterion ?? {}
    const criterionId = str(c.criterionId) ?? ''
    if (c.keyword) { out.keywords.push({ criterionId, text: str(c.keyword.text) ?? '', matchType: (str(c.keyword.matchType) ?? 'BROAD') as MatchType }); continue }
    if (c.brand) { out.brands.push({ criterionId, entityId: str(c.brand.entityId) ?? '', name: str(c.brand.displayName), status: str(c.brand.status), url: str(c.brand.primaryUrl) }); continue }
    const item = exclusionOf(c)
    if (item) out.items.push({ ...item, criterionId })
  }
  return out
}

export interface ExclusionListLinks {
  /** customer_negative_criterion (read with liveAccountExclusions). */
  account: LiveAccountExclusions | null
  placementLinks: Json[]
  brandLinks: Json[]
  adGroupBrandLinks: Json[]
}

/** The lists with where each is used; `items` holds the content of the list `listId` names. Pure. */
export function exclusionListsOf(sets: Json[], links: ExclusionListLinks, listId?: string, items?: ExclusionListItems): LiveExclusionList[] {
  return sets.map((row) => {
    const s = row.sharedSet ?? {}
    const id = str(s.id) ?? ''
    const type = str(s.type) as ExclusionListType
    const campaigns: ExclusionListCampaign[] = type === 'NEGATIVE_PLACEMENTS'
      ? links.placementLinks.filter((l) => str(l.sharedSet?.id) === id).map((l) => ({
        campaignId: str(l.campaign?.id) ?? '', name: str(l.campaign?.name) ?? '', status: str(l.campaign?.status), type: str(l.campaign?.advertisingChannelType), mode: 'exclude' as const, criterionId: null,
      }))
      : type === 'BRANDS'
        ? links.brandLinks.filter((l) => idOf(l.campaignCriterion?.brandList?.sharedSet) === id).map((l) => ({
          campaignId: str(l.campaign?.id) ?? '', name: str(l.campaign?.name) ?? '', status: str(l.campaign?.status), type: str(l.campaign?.advertisingChannelType),
          mode: l.campaignCriterion?.negative === true ? 'exclude' as const : 'include' as const, criterionId: str(l.campaignCriterion?.criterionId),
        }))
        : []
    const adGroups = type === 'BRANDS'
      ? links.adGroupBrandLinks.filter((l) => idOf(l.adGroupCriterion?.brandList?.sharedSet) === id).map((l) => ({
        adGroupId: str(l.adGroup?.id) ?? '', name: str(l.adGroup?.name) ?? '', status: str(l.adGroup?.status), campaignId: str(l.campaign?.id) ?? '', campaignStatus: str(l.campaign?.status),
      }))
      : []
    const account = links.account
    const accountLink = type === 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS'
      ? (account?.keywordList?.listId === id ? { criterionId: account.keywordList.criterionId } : null)
      : type === 'NEGATIVE_PLACEMENTS'
        ? (account?.placementLists.find((p) => p.listId === id) ? { criterionId: account.placementLists.find((p) => p.listId === id)!.criterionId } : null)
        : null
    return {
      listId: id,
      name: str(s.name),
      type,
      itemCount: Number(s.memberCount ?? 0) || 0,
      campaigns: campaigns.sort((a, b) => byGoogleId(a.campaignId, b.campaignId)),
      adGroups,
      account: accountLink,
      ...(listId === id && items ? (type === 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS' ? { keywords: items.keywords } : type === 'BRANDS' ? { brands: items.brands } : { items: items.items }) : {}),
    }
  }).sort((a, b) => a.type.localeCompare(b.type) || (a.name ?? '').localeCompare(b.name ?? '') || byGoogleId(a.listId, b.listId))
}

export interface LiveExclusionLists {
  lists: LiveExclusionList[]
  /** The account's own exclusions and list links, when they were read (a list type used on the account, or asked). */
  account: LiveAccountExclusions | null
}

/**
 * The account's exclusion lists of the types asked, with where each is used (the account, campaigns, and for a brand
 * list its ad groups), and the content of the list `listId` names. Only the links its types need are read (the
 * account's links also when `withAccount`): 1 to 6 queries.
 */
export async function liveExclusionLists(
  target: GoogleAdsTarget,
  options: { listId?: string; types?: readonly ExclusionListType[]; withAccount?: boolean } = {},
): Promise<LiveExclusionLists> {
  const sets = await liveRows<Json>(target, liveExclusionSetsQuery(options.types ?? EXCLUSION_LIST_TYPES), 'ads.search.live.exclusion-lists')
  const present = new Set(sets.map((r) => str(r.sharedSet?.type)))
  const wanted = options.listId ? sets.find((r) => str(r.sharedSet?.id) === options.listId) : null
  // With one list asked for, only its own links are read.
  const has = (type: ExclusionListType) => (options.listId ? str(wanted?.sharedSet?.type) === type : present.has(type))
  const account = options.withAccount || has('ACCOUNT_LEVEL_NEGATIVE_KEYWORDS') || has('NEGATIVE_PLACEMENTS') ? await liveAccountExclusions(target) : null
  const links: ExclusionListLinks = {
    account,
    placementLinks: has('NEGATIVE_PLACEMENTS') ? await liveRows<Json>(target, LIVE_PLACEMENT_LIST_LINKS_QUERY, 'ads.search.live.placement-list-links') : [],
    brandLinks: has('BRANDS') ? await liveRows<Json>(target, LIVE_BRAND_LIST_LINKS_QUERY, 'ads.search.live.brand-list-links') : [],
    adGroupBrandLinks: has('BRANDS') ? await liveRows<Json>(target, LIVE_AD_GROUP_BRAND_LIST_LINKS_QUERY, 'ads.search.live.brand-list-ad-groups') : [],
  }
  const items = wanted ? exclusionListItemsOf(await liveRows<Json>(target, liveExclusionListItemsQuery(options.listId!), 'ads.search.live.exclusion-list-items')) : undefined
  return { lists: exclusionListsOf(sets, links, options.listId, items), account }
}

// ── brands by name (BrandSuggestionService) ──────────────────────────────────────────────────────────────────────

export interface BrandSuggestion { entityId: string; name: string | null; state: string | null; urls: string[] }

const isRefusal = (err: unknown): err is GatewayRefusal => err instanceof Error && err.name === 'GatewayRefusal'
const isNoAnswer = (err: unknown): err is GatewayNoAnswer => err instanceof Error && err.name === 'GatewayNoAnswer'

export function brandSuggestionsOf(answer: Json): BrandSuggestion[] {
  return (Array.isArray(answer.brands) ? answer.brands : []).map((b: Json) => ({
    entityId: str(b.id) ?? '', name: str(b.name), state: str(b.state), urls: Array.isArray(b.urls) ? b.urls.map(String) : [],
  })).filter((b: BrandSuggestion) => b.entityId)
}

/**
 * Google's brands whose name starts with `prefix` (BrandSuggestionService.SuggestBrands, through the gateway as a read),
 * on the account's change allowance: one operation, reserved first. Rejects with a GoogleAdsReadError.
 */
export async function suggestBrands(target: GoogleAdsTarget, prefix: string): Promise<BrandSuggestion[]> {
  const operation = 'ads.suggestBrands'
  const customerId = customerIdDigits(target.customerId)
  if (!customerId) throw new GoogleAdsReadError(localFailure('The Google Ads account id is not a customer id. Nothing was sent.', 'INVALID_CUSTOMER_ID'), operation)
  const login = target.loginCustomerId ? customerIdDigits(target.loginCustomerId) : null
  const reservation = await reserveOps(customerId, 1, new Date(), 'write')
  if (!reservation.ok) throw new GoogleAdsReadError(localFailure(reservation.sentence, reservation.reason ?? 'OPS_REFUSED'), operation)
  let reached = false
  try {
    const response = await googleCall({
      connectionId: target.connectionId,
      operation,
      method: 'POST',
      url: `${GOOGLE_ADS_API_BASE}/customers/${customerId}:suggestBrands`,
      body: { brandPrefix: prefix },
      loginCustomerId: login,
      maxTransientRetries: 0,
      max429Retries: 0,
      timeoutMs: 60_000,
    })
    reached = true
    const text = await response.text()
    if (!response.ok) {
      const failure = parseGoogleAdsFailure(response.status, text, response.headers)
      if (failure.quotaExhausted) await markQuotaExhausted()
      throw new GoogleAdsReadError(failure, operation, 1)
    }
    try {
      return brandSuggestionsOf(text ? JSON.parse(text) : {})
    } catch {
      throw new GoogleAdsReadError(localFailure('Google Ads answered with something Nexus cannot read.', 'UNREADABLE_ANSWER'), operation, 1)
    }
  } catch (err) {
    if (err instanceof GoogleAdsReadError) throw err
    if (isRefusal(err)) throw new GoogleAdsReadError(failureFromGatewayRefusal(err), operation, 0)
    if (isNoAnswer(err)) { reached = true; throw new GoogleAdsReadError(failureFromNoAnswer(err), operation, 1) }
    throw err
  } finally {
    // Not sent: the reserved operation goes back. Sent once (no retry here): what was reserved is what it cost.
    if (!reached) await releaseOps(customerId, 1, reservation.reservedAt, 'write')
  }
}

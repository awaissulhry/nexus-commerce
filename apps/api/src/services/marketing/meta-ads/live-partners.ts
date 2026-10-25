/**
 * Meta ads step 16 (2026-10-21) — partnership content and research, read LIVE from Meta (GET only, through the gateway):
 *   meta-partnership-content  partnership content of the brand (search, look-up, organic insights), Instagram and Facebook
 *                             partnership-ad permissions, approved creators, the Facebook brand allowlist and tagged posts,
 *                             a creator's Instagram id, Collab invites and collaborative media, Creator Marketplace
 *   meta-ad-library           Meta's Ad Library (/ads_archive: other advertisers' ads, EU transparency), another Instagram
 *                             professional account's public numbers, hashtag search, another Page's public posts
 * Nothing here stores anything. Everything but /ads_archive reads only the business's chosen assets (the chosen ad
 * account's business portfolio, Facebook Page and Instagram account); a Page or Instagram account another business in
 * Nexus uses is answered by its id and the flag only (taken.ts), wherever it appears.
 *
 * Checked 2026-10-21 (developers.facebook.com, `.md` pages and the server-rendered /docs pages; Meta's Python Business
 * SDK, main, facebook_business/adobjects):
 *   - marketing-api/ad-creative/partnership-ads/content-discovery-api: GET /{business_id}/partnership-ads-advertisable-
 *     content with fb_page_id and/or ig_user_id (both the business's, linked); filters (ad_partner_ig_user_ids,
 *     ad_partner_page_ids, platform_types, media_types, post_types, content_types, ad_eligibilities, ad_usages,
 *     country_codes, start_date + end_date, search_key, sort_by, is_recommended); a look-up by ONE of content_ids,
 *     permalinks, ad_codes (≤ 50, no filters, no paging); limit 1–50; forward-only cursor (no `before`; no paging object =
 *     last page); only content_id unless fields names more (author{…}, partnership_info{…, eligibility_errors{code,
 *     message,severity}}, organic_insights{likes,comments,views,reach,shares,interaction,saves}); system-user tokens are
 *     supported; the IG scope without instagram_basic answers 403
 *   - …/partnership-ads/account-level-permissioning: GET /{ig_business_account_id}/branded_content_ad_permissions
 *     (creator_username since 2026-03-30, OCC 2026); SDK iguser.py get_branded_content_ad_permissions (creator_username)
 *   - …/partnership-ads/fb-account-level-permissioning and marketing-api/guides/branded-content-permissions: Meta's REST
 *     host api.facebook.com (gateway/meta-calls.ts metaRestVerdict): account-level permissions (status 1 PENDING_APPROVAL,
 *     2 and 7 APPROVED, 3 REJECTED, 4 REVOKED, 5 SELF_REMOVED, 6 CANCELED; partner_page_ids; permission_direction
 *     sent | received; offset; limit ≤ 1000), brand-allowlist-status (ENABLED | DISABLED), brand-allowlisted-creators
 *     (creator_ineligible_for_bc), branded-content-posts (start_date inclusive, end_date exclusive, creator_page_ids,
 *     limit ≤ 5000, offset); facebook_branded_content_ads_brand
 *   - …/partnership-ads/post-level-permissioning: GET /{ig_user_id}/branded_content_tag_approval?user_ids (≤ 100;
 *     instagram_branded_content_brand, a Facebook User token and Advanced Access)
 *   - …/partnership-ads/ads-creation/use-new-creative + instagram-platform/…/business-discovery and reference/ig-user/
 *     business_discovery: GET /{own_ig_user_id}?fields=business_discovery.username(<name>){…} (professional accounts
 *     only; age-gated ones are not returned; media_url omitted for copyrighted audio)
 *   - instagram-platform/…/collaboration: GET /{ig_user_id}/collaboration_invites (media_id, media_owner_username,
 *     caption, media_url; 300 calls per IG user per 24 h; no Stories), GET /{ig_user_id}/collaborative_media and
 *     ?fields=collaborative_media_search.media_id(<id>){…} (accepted collaborations only, not own media)
 *   - instagram-platform/…/creator-marketplace: GET /{ig_user_id}/creator_marketplace_creators (filters below; a
 *     username excludes the other filters, similar_to_creators ≤ 5 excludes query) and creator_marketplace_brand_info
 *     (custom_audiences_access_status, custom_audiences{id,name}; acting_business_id is an agency's and is never sent);
 *     instagram_creator_marketplace_discovery needs Advanced access (App Review), Standard answers test data only; a Page
 *     access token of the Page linked to the brand's Instagram account; 5000 calls per user per hour; OCC 2026 (2026-06-11:
 *     follower buckets, US states, recommendation_type, badges, thumbnail_url, audience-overlap search)
 *   - instagram-platform/…/hashtag-search and reference/ig-hashtag-search: GET /ig_hashtag_search?user_id&q, then
 *     /{hashtag_id}/top_media | recent_media?user_id (each counts against 30 unique hashtags per rolling 7 days),
 *     /{ig_user_id}/recently_searched_hashtags (SDK shadowighashtag.py: id, name); Instagram Public Content Access (App
 *     Review); no Stories, no emojis
 *   - graph-api/reference/ads_archive and archived-ad: ad_reached_countries (required; ISO or ALL; a non-political ad is
 *     returned only when it reached the EU), search_terms (≤ 100 characters, a space is AND, not translated),
 *     search_type, search_page_ids (≤ 10), ad_active_status, ad_delivery_date_min/max, ad_type, languages, media_type,
 *     publisher_platforms; fields as below (the EU ones only for ads delivered to the UK and EU); errors 613, 100, 2500,
 *     1009; ad_snapshot_url carries a token (the gateway removes it), so Nexus gives the public Ad Library link instead
 *   - graph-api/reference/page/feed: another Page's posts need Page Public Content Access (App Review)
 *   - IN-093: the Content and Creator Insights API page (affiliate_partnership/content-insights-api) is in Meta's index but
 *     answers "Page not found" today; the content discovery API's organic_insights is the documented creator-content read,
 *     so that is what view content-insights asks (LIVE-PROBES IN-093)
 */
import { metaAdAccountId, metaObjectId } from '../../cx/connectors/meta/discovery.js'
import { metaRestCall, type MetaQueryValue } from '../../gateway/meta.js'
import type { GatewayResponse } from '../../gateway/gateway.js'
import { failureOfAnswer, failureOfThrow, localFailure, MetaReadError } from './errors.js'
import { metaChosenAccount, MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { metaReadAll, metaReadOne } from './read-client.js'
import { takenIds } from './taken.js'
import { part as sharedPart } from './paging.js'

export type Row = Record<string, unknown>

// ── shared helpers (live-safety.ts uses them too) ─────────────────────────────────────────────────────────────────────

export const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
export const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
export const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const isRow = (v: unknown): v is Row => !!obj(v)
/** A Meta id as text: digits (a string, a safe number, or an object's `id`). */
export function idOf(v: unknown): string | null {
  if (typeof v === 'string' && /^\d{1,25}$/.test(v.trim())) return v.trim()
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return String(v)
  const o = obj(v)
  return o ? idOf(o.id) : null
}
/** The rows of an answer: a `data` list, or (Meta's REST host) a plain list. */
export const rowsOf = (body: unknown): Row[] => (Array.isArray(body) ? body.filter(isRow) : Array.isArray(obj(body)?.data) ? (obj(body)!.data as unknown[]).filter(isRow) : [])
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const texts = (v: unknown): string[] => list(v).map(text).filter((t): t is string => !!t)

export const NO_PAGE = 'No Facebook Page is chosen for this business yet. A person chooses it in Settings › Channels › Meta, or Claude asks for it with set-meta-connection (a person approves it).'
export const NO_INSTAGRAM = 'No Instagram account is chosen for this business yet. A person chooses it in Settings › Channels › Meta, or Claude asks for it with set-meta-connection (a person approves it).'
export const NO_PORTFOLIO = 'The chosen ad account names no Meta business portfolio, so Meta\'s business-level lists cannot be asked for (a person checks the ad account in Meta Business settings).'
export const pageOf = (account: MetaChosenAccount): string => { if (!account.pageId) throw new MetaLiveRefusal(NO_PAGE); return account.pageId }
export const instagramOf = (account: MetaChosenAccount): string => { if (!account.instagramId) throw new MetaLiveRefusal(NO_INSTAGRAM); return account.instagramId }
export const portfolioOf = (account: MetaChosenAccount): string => { if (!account.businessId) throw new MetaLiveRefusal(NO_PORTFOLIO); return account.businessId }

/** One page of a Graph read: the body, its rows and the cursor of the next page (`cursorOnly`: Meta gives no `next` link there). */
export async function graphPage(connectionId: string, operation: string, path: string, query: Record<string, MetaQueryValue>, opts: { cursorOnly?: boolean } = {}) {
  const { body } = await metaReadOne<Row>({ connectionId }, { operation, path, query })
  const paging = obj(body.paging)
  const after = text(obj(paging?.cursors)?.after)
  const more = !!after && (opts.cursorOnly ? !!paging : !!paging?.next)
  return { body, rows: rowsOf(body), nextAfter: more ? after : null }
}

/** Big integers (Page and post ids on Meta's REST host come as JSON numbers) kept exact as text before parsing. */
function parseExact(raw: string): unknown {
  try { return JSON.parse(raw.replace(/([:[,]\s*)(\d{16,})(?=\s*[,\]}])/g, '$1"$2"')) } catch { return null }
}

/** One read of Meta's REST host (api.facebook.com): its JSON, or a MetaReadError with Meta's own words. */
export async function restRead(connectionId: string, operation: string, path: string, query: Record<string, MetaQueryValue> = {}): Promise<unknown> {
  let answer: GatewayResponse
  try {
    answer = await metaRestCall({ connectionId, operation, path, query, timeoutMs: 30_000 })
  } catch (err) {
    const failure = failureOfThrow(err)
    if (failure) throw new MetaReadError(failure, operation, 0)
    throw err
  }
  if (!answer.ok) throw new MetaReadError(failureOfAnswer(answer), operation, 1)
  const body = parseExact(answer.text) ?? answer.json()
  if (body === null || typeof body !== 'object') throw new MetaReadError(localFailure('Meta answered with something that is not JSON.', 'NOT_JSON'), operation, 1)
  return body
}

/**
 * Each part of an answer on its own: a part Meta refuses says why, and never hides the others — a lost token or a throttle
 * too (step 16 as merged; the shared `part` of paging.ts with stopOnLost: false).
 */
export const part = <T>(work: () => Promise<T>) => sharedPart(work, { stopOnLost: false })

/** Meta refused the field list itself (code 100 from Meta, not a lost token or a throttle): read again with the core fields. */
export function fieldsRefused(err: unknown): err is MetaReadError {
  return err instanceof MetaReadError && err.failure.origin === 'meta' && !err.failure.authLost && !err.failure.throttled && /^100(\/|$)/.test(err.failure.code ?? '')
}

/** When Meta refuses for access (a permission, an App Review feature, a token kind), the plain next step is added. */
export async function noted<T>(work: () => Promise<T>, note: string): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof MetaReadError && (err.failure.permissionDenied || (err.failure.origin === 'meta' && (err.failure.httpStatus === 401 || err.failure.httpStatus === 403)))) {
      throw new MetaLiveRefusal(`${err.message} ${note}`)
    }
    throw err
  }
}

/** Which of these Page and Instagram ids another business in Nexus uses (never which business). */
export async function takenSets(pageIds: Array<string | null>, instagramIds: Array<string | null>) {
  const clean = (ids: Array<string | null>) => ids.filter((id): id is string => !!id)
  const [pages, instagram] = await Promise.all([takenIds('PAGE', clean(pageIds)), takenIds('INSTAGRAM', clean(instagramIds))])
  return { pages, instagram }
}

/** A list of ids from a caller: digits only, each once. */
export const idList = (ids: readonly string[] | null | undefined, what: string): string[] => {
  const out = [...new Set((ids ?? []).map((id) => metaObjectId(id) ?? ''))]
  if (out.some((id) => !id)) throw new MetaLiveRefusal(`Every ${what} is a Meta id (digits only).`)
  return out
}

/** A JSON list of ids as Meta reads an integer list (`[123,456]`), written from the digits so no id loses a digit. */
export const idArray = (ids: readonly string[]): string => `[${ids.join(',')}]`

const day = (v: string | null | undefined, what: string): string | null => {
  if (!v) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new MetaLiveRefusal(`${what} is a day, YYYY-MM-DD.`)
  return v
}

// ── meta-partnership-content ──────────────────────────────────────────────────────────────────────────────────────────

export const PARTNERSHIP_VIEWS = [
  'search', 'lookup', 'content-insights', 'instagram-permissions', 'facebook-permissions', 'tag-approvals', 'allowlist',
  'tagged-posts', 'creator-id', 'collab-invites', 'collab-media', 'creator-marketplace', 'creators',
] as const
export type PartnershipView = typeof PARTNERSHIP_VIEWS[number]

export const CONTENT_PLATFORMS = ['INSTAGRAM', 'FACEBOOK'] as const
export const CONTENT_MEDIA_TYPES = ['IMAGE', 'VIDEO', 'CAROUSEL', 'LINK'] as const
export const CONTENT_POST_TYPES = ['FEED', 'STORY', 'REEL'] as const
export const CONTENT_KINDS = ['BRANDED_CONTENT', 'PRODUCT', 'AFFILIATE', 'COLLAB_POST', 'TAGGED', 'REPOSTED'] as const
export const AD_ELIGIBILITIES = ['AD_READY', 'INELIGIBLE', 'NEEDS_ATTENTION', 'EXCLUDED'] as const
export const AD_USAGES = ['NEVER_USED', 'ACTIVE', 'PREVIOUSLY_USED'] as const
/** Meta's numbers for an account-level Facebook permission (fb-account-level-permissioning). */
export const FB_PERMISSION_STATUS: Readonly<Record<string, readonly number[]>> = {
  PENDING_APPROVAL: [1], APPROVED: [2, 7], REJECTED: [3], REVOKED: [4], SELF_REMOVED: [5], CANCELED: [6],
}
const FB_STATUS_WORD: Readonly<Record<number, string>> = { 1: 'PENDING_APPROVAL', 2: 'APPROVED', 7: 'APPROVED', 3: 'REJECTED', 4: 'REVOKED', 5: 'SELF_REMOVED', 6: 'CANCELED' }

const IDENTITY = 'display_name,ig_user_id,fb_page_id'
const CONTENT_CORE = `content_id,platform,media_type,post_type,caption,permalink,creation_time,author{${IDENTITY}}`
const CONTENT_FIELDS = `${CONTENT_CORE},is_recommended,ad_usage,partnership_info{ad_eligibility,permission_status,permission_type,ad_code,content_types,eligibility_errors{code,message,severity},tagged_partner{${IDENTITY}}}`
// Asked whole: Meta answers all seven numbers (likes, comments, views, reach, shares, interaction, saves). Naming them would
// put the word `comments` in the field list, which the gateway refuses everywhere (buyers' comments are never read).
const ORGANIC = 'organic_insights'

/** The creator filters Meta documents on creator_marketplace_creators (instagram-platform/…/creator-marketplace). */
export interface CreatorFilters {
  countries?: string[]; states?: string[]; minFollowers?: number; maxFollowers?: number; interests?: string[]
  minEngagedAccounts?: number; maxEngagedAccounts?: number; audienceAgeBuckets?: string[]; audienceGender?: string[]
  audienceCountries?: string[]; audienceStates?: string[]; audienceDevices?: string[]; query?: string; similarTo?: string[]
  recommendation?: string; platform?: string; pageName?: string; languages?: string[]; latestPostActivity?: string; followerGrowth?: string
  verified?: boolean; featuredInPaidAds?: boolean; hasPortfolio?: boolean; excludeMessaged?: boolean
}
const CREATOR_PARAM: Readonly<Record<keyof CreatorFilters, string>> = {
  countries: 'creator_countries', states: 'creator_states', minFollowers: 'creator_min_followers', maxFollowers: 'creator_max_followers',
  interests: 'creator_interests', minEngagedAccounts: 'creator_min_engaged_accounts',
  maxEngagedAccounts: 'creator_max_engaged_accounts', audienceAgeBuckets: 'major_audience_age_bucket', audienceGender: 'major_audience_gender',
  audienceCountries: 'major_audience_countries', audienceStates: 'major_audience_states', audienceDevices: 'major_audience_device_type',
  query: 'query', similarTo: 'similar_to_creators', recommendation: 'recommendation_type', platform: 'platform', pageName: 'page_name',
  languages: 'creator_language', latestPostActivity: 'creator_latest_post_activity', followerGrowth: 'creator_follower_growth',
  verified: 'verified_account', featuredInPaidAds: 'featured_in_paid_ads', hasPortfolio: 'has_portfolio', excludeMessaged: 'exclude_messaged_creators',
}
// Contact e-mail, gender and age of a creator are neither asked nor filtered on (review A1): Nexus does not pick or describe a
// person by gender or age. The audience filters (major_audience_*) describe a creator's followers as a group.
const CREATOR_CORE = 'id,username,is_account_verified,biography,country,onboarded_status,badges,portfolio_url,profile_picture_url,platforms,page_id,page_name,category'
/**
 * Review B5 (IN-093, the creator side) — one creator's Creator Insights (creator-marketplace page, "Creator Insights
 * Metrics"): total_followers, creator_reach, creator_engaged_accounts, reels_interaction_rate, total_views,
 * account_interactions. Only with a username; when Meta refuses them, the detail without them, then the profile only.
 */
const CREATOR_INSIGHTS = 'insights.metrics(total_followers,creator_reach,creator_engaged_accounts,reels_interaction_rate,total_views,account_interactions)'
const CREATOR_DETAIL = `${CREATOR_CORE},has_brand_partnership_experience,past_brand_partnership_partners,recent_media.limit(10){id,media_type,product_type,permalink,thumbnail_url,creation_time,caption,tagged_brand},branded_content_media.limit(10){id,media_type,product_type,permalink,creation_time,caption,tagged_brand}`

const COLLAB_FIELDS = 'id,caption,media_type,media_product_type,permalink,timestamp,username,total_like_count,total_comments_count,total_views_count'
const IG_USERNAME = /^[A-Za-z0-9._]{1,30}$/

export interface PartnershipInput {
  connectionId?: string | null
  view: PartnershipView
  platforms?: string[]; mediaTypes?: string[]; postTypes?: string[]; contentTypes?: string[]; eligibility?: string[]; usage?: string[]
  countries?: string[]; from?: string | null; to?: string | null; search?: string | null; sortBy?: string | null; recommendedOnly?: boolean
  partnerPageIds?: string[]; partnerInstagramIds?: string[]; insights?: boolean
  contentIds?: string[]; permalinks?: string[]; adCodes?: string[]
  creatorUsername?: string | null; statuses?: string[]; direction?: string | null; userIds?: string[]; creatorPageIds?: string[]
  username?: string | null; mediaId?: string | null; customAudienceId?: string | null; creatorFilters?: CreatorFilters
  limit?: number; after?: string | null; offset?: number
}

/** One partnership content row, in Nexus's words. */
function contentRow(r: Row) {
  const author = obj(r.author)
  const insights = obj(r.organic_insights)
  return {
    contentId: text(r.content_id), platform: text(r.platform), mediaType: text(r.media_type), postType: text(r.post_type),
    caption: text(r.caption), permalink: text(r.permalink), createdOn: text(r.creation_time),
    author: author ? { name: text(author.display_name), instagramId: idOf(author.ig_user_id), pageId: idOf(author.fb_page_id) } : null,
    recommended: typeof r.is_recommended === 'boolean' ? r.is_recommended : null, adUsage: text(r.ad_usage),
    partnerships: list(r.partnership_info).filter(isRow).map((p) => {
      const tagged = obj(p.tagged_partner)
      return {
        adEligibility: text(p.ad_eligibility), permissionStatus: text(p.permission_status), permissionType: text(p.permission_type),
        adCode: text(p.ad_code), contentTypes: texts(p.content_types),
        eligibilityErrors: list(p.eligibility_errors).filter(isRow).map((e) => ({ code: text(e.code), message: text(e.message), severity: text(e.severity) })),
        taggedPartner: tagged ? { name: text(tagged.display_name), instagramId: idOf(tagged.ig_user_id), pageId: idOf(tagged.fb_page_id) } : null,
      }
    }),
    ...(insights ? { organicInsights: Object.fromEntries(['likes', 'comments', 'views', 'reach', 'shares', 'interaction', 'saves'].map((k) => [k, num(insights[k])])) } : {}),
  }
}
type ContentRow = ReturnType<typeof contentRow>

/** Content whose author or tagged partner is another business's Page or Instagram account: its id and the flag only. */
async function maskContent(rows: ContentRow[]) {
  const people = rows.flatMap((r) => [r.author, ...r.partnerships.map((p) => p.taggedPartner)]).filter((p): p is NonNullable<ContentRow['author']> => !!p)
  const taken = await takenSets(people.map((p) => p.pageId), people.map((p) => p.instagramId))
  const isTaken = (p: ContentRow['author']) => !!p && ((!!p.pageId && taken.pages.has(p.pageId)) || (!!p.instagramId && taken.instagram.has(p.instagramId)))
  return rows.map((r) => (isTaken(r.author) || r.partnerships.some((p) => isTaken(p.taggedPartner)) ? { contentId: r.contentId, takenByAnotherBusiness: true } : r))
}

/** The brand's own ids for the content discovery API: the portfolio, and the chosen Page and/or Instagram account. */
function brandOf(account: MetaChosenAccount) {
  const businessId = portfolioOf(account)
  if (!account.pageId && !account.instagramId) throw new MetaLiveRefusal(`${NO_PAGE} (or an Instagram account)`)
  return { businessId, query: { ...(account.pageId ? { fb_page_id: account.pageId } : {}), ...(account.instagramId ? { ig_user_id: account.instagramId } : {}) } }
}

const PARTNERSHIP_ACCESS = 'Meta\'s partnership-content reads need business_management with facebook_branded_content_ads_brand and/or instagram_branded_content_ads_brand (+ instagram_basic) on the system user\'s token, and the Page / Instagram account assigned to the system user in Meta Business settings.'
const CREATOR_ACCESS = 'Creator Marketplace needs instagram_creator_marketplace_discovery with Advanced access (Meta\'s App Review; Standard access answers test data only), the brand accepted into Instagram\'s creator marketplace, and a Page access token of the Page linked to the brand\'s Instagram account — Nexus reads with the business\'s system-user token for now; the Owner can also use the Creator Marketplace in Meta\'s own apps.'
const IG_USER_TOKEN = 'Meta documents this Instagram read with a Facebook User token of a person with a task on the linked Page; Nexus reads with the business\'s system-user token (the Instagram account assigned to the system user). If Meta refuses here, the Owner sees it in the Instagram app.'

/**
 * A creator lookup on the chosen Instagram account (business_discovery): the creator's id, or the flag when another business
 * uses it. Step 24 — exported: a post's collaborator is checked the same way (live-posts.ts igUsernameTaken).
 */
export async function discover(account: MetaChosenAccount, username: string, inner: string, operation: string) {
  const name = username.trim().replace(/^@/, '')
  if (!IG_USERNAME.test(name)) throw new MetaLiveRefusal('An Instagram username is 1–30 letters, digits, dots and underscores.')
  const instagramId = instagramOf(account)
  const { body } = await noted(() => metaReadOne<Row>({ connectionId: account.connectionId }, { operation, path: instagramId, query: { fields: `business_discovery.username(${name}){${inner}}` } }), IG_USER_TOKEN)
  const found = obj(body.business_discovery)
  if (!found) throw new MetaLiveRefusal('Meta found no Instagram professional account with that username (personal and age-gated accounts are not returned).')
  const id = idOf(found.id)
  if (id && (await takenIds('INSTAGRAM', [id])).has(id)) return { found: null as Row | null, id, taken: true }
  return { found, id, taken: false }
}

/** The ids of the chosen ad account's own custom audiences (at most 500, enough for Meta's own limit per account). */
async function ownAudienceIds(account: MetaChosenAccount): Promise<Set<string>> {
  const ids = new Set<string>()
  await metaReadAll({ connectionId: account.connectionId }, { operation: 'partners.ownAudiences', path: `act_${account.adAccountId}/customaudiences`, query: { fields: 'id', limit: 100 }, maxPages: 5 }, (rows) => {
    for (const r of rows) { const id = idOf(r.id); if (id) ids.add(id) }
  })
  return ids
}

/** A custom audience id from a caller, used only when it is the chosen ad account's own (account_id and subtype, one read). */
async function ownAudience(account: MetaChosenAccount, id: string): Promise<string> {
  const audienceId = metaObjectId(id)
  if (!audienceId) throw new MetaLiveRefusal('customAudienceId is a Meta id (digits only).')
  const { body } = await metaReadOne<Row>({ connectionId: account.connectionId }, { operation: 'partners.audienceCheck', path: audienceId, query: { fields: 'account_id,subtype' } }).catch((err) => {
    if (err instanceof MetaReadError) throw new MetaLiveRefusal('That custom audience is not one of the ad account this business chose, so it is not used.')
    throw err
  })
  if (metaAdAccountId(body.account_id) !== account.adAccountId || !text(body.subtype)) throw new MetaLiveRefusal('That custom audience is not one of the ad account this business chose, so it is not used.')
  return audienceId
}

function creatorQuery(filters: CreatorFilters | undefined): Record<string, MetaQueryValue> {
  const out: Record<string, MetaQueryValue> = {}
  for (const [key, value] of Object.entries(filters ?? {}) as Array<[keyof CreatorFilters, unknown]>) {
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) continue
    out[CREATOR_PARAM[key]] = (key === 'similarTo' ? (value as string[]).map((u) => u.replace(/^@/, '')) : value) as MetaQueryValue
  }
  return out
}

function creatorRow(r: Row) {
  const media = (v: unknown) => rowsOf(v).map((m) => ({ id: idOf(m.id) ?? text(m.id), mediaType: text(m.media_type), productType: text(m.product_type), permalink: text(m.permalink), thumbnailUrl: text(m.thumbnail_url), createdAt: text(m.creation_time), caption: text(m.caption), taggedBrand: text(m.tagged_brand) }))
  return {
    id: idOf(r.id), username: text(r.username), pageId: idOf(r.page_id), pageName: text(r.page_name), platforms: texts(r.platforms),
    verified: typeof r.is_account_verified === 'boolean' ? r.is_account_verified : null, biography: text(r.biography), country: text(r.country),
    onboarded: r.onboarded_status ?? null, badges: texts(r.badges), category: text(r.category), portfolioUrl: text(r.portfolio_url), profilePictureUrl: text(r.profile_picture_url),
    ...(r.has_brand_partnership_experience !== undefined ? { hasBrandPartnershipExperience: r.has_brand_partnership_experience } : {}),
    ...(r.past_brand_partnership_partners !== undefined ? { pastBrandPartners: list(r.past_brand_partnership_partners).map((p) => text(p) ?? text(obj(p)?.name) ?? null).filter(Boolean) } : {}),
    ...(r.recent_media !== undefined ? { recentMedia: media(r.recent_media) } : {}),
    ...(r.branded_content_media !== undefined ? { brandedContentMedia: media(r.branded_content_media) } : {}),
    ...(r.insights !== undefined ? {
      insights: rowsOf(r.insights).map((i) => ({ metric: text(i.name), period: text(i.period), timeRange: text(i.time_range), value: num(obj(i.total_value)?.value), platform: text(i.platform) })),
    } : {}),
  }
}

/** One live view of the brand's partnership content and creators. */
export async function livePartnership(input: PartnershipInput) {
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId } = account
  const base = { adAccountId: account.adAccountId, pageId: account.pageId, instagramId: account.instagramId }
  switch (input.view) {
    case 'search': {
      const brand = brandOf(account)
      const from = day(input.from, 'from')
      const to = day(input.to, 'to')
      if (!!from !== !!to) throw new MetaLiveRefusal('Meta takes from and to together (YYYY-MM-DD; to not in the future).')
      const filters: Record<string, MetaQueryValue> = {
        ...(input.platforms?.length ? { platform_types: input.platforms } : {}),
        ...(input.mediaTypes?.length ? { media_types: input.mediaTypes } : {}),
        ...(input.postTypes?.length ? { post_types: input.postTypes } : {}),
        ...(input.contentTypes?.length ? { content_types: input.contentTypes } : {}),
        ...(input.eligibility?.length ? { ad_eligibilities: input.eligibility } : {}),
        ...(input.usage?.length ? { ad_usages: input.usage } : {}),
        ...(input.countries?.length ? { country_codes: input.countries } : {}),
        ...(from && to ? { start_date: from, end_date: to } : {}),
        ...(input.search ? { search_key: input.search } : {}),
        ...(input.sortBy ? { sort_by: input.sortBy } : {}),
        ...(input.recommendedOnly ? { is_recommended: true } : {}),
        ...(input.partnerPageIds?.length ? { ad_partner_page_ids: idArray(idList(input.partnerPageIds, 'partner Page')) } : {}),
        ...(input.partnerInstagramIds?.length ? { ad_partner_ig_user_ids: idArray(idList(input.partnerInstagramIds, 'partner Instagram account')) } : {}),
      }
      const query = { ...brand.query, ...filters, limit: Math.min(50, Math.max(1, input.limit ?? 25)), ...(input.after ? { after: input.after } : {}) }
      const fields = input.insights ? `${CONTENT_FIELDS},${ORGANIC}` : CONTENT_FIELDS
      const path = `${brand.businessId}/partnership-ads-advertisable-content`
      let read: Awaited<ReturnType<typeof graphPage>>
      let fieldsNote: string | null = null
      try {
        read = await noted(() => graphPage(connectionId, 'partners.content', path, { ...query, fields }, { cursorOnly: true }), PARTNERSHIP_ACCESS)
      } catch (err) {
        if (!fieldsRefused(err)) throw err
        read = await noted(() => graphPage(connectionId, 'partners.content', path, { ...query, fields: CONTENT_CORE }, { cursorOnly: true }), PARTNERSHIP_ACCESS)
        fieldsNote = `Meta refused the full field list (${err.failure.sentence}); these rows carry the core fields only.`
      }
      return { ...base, items: await maskContent(read.rows.map(contentRow)), nextAfter: read.nextAfter, fieldsNote, note: 'Partnership content of the brand on Facebook and Instagram (branded content, product tags, affiliate, Collab, tags, reposts) as Meta\'s Partnership Ads Hub shows it. Paging goes forward only (nextAfter).' }
    }
    case 'lookup':
    case 'content-insights': {
      const brand = brandOf(account)
      const kinds = [input.contentIds?.length ? 'content_ids' : null, input.permalinks?.length ? 'permalinks' : null, input.adCodes?.length ? 'ad_codes' : null].filter(Boolean)
      if (input.view === 'content-insights' && !input.contentIds?.length) throw new MetaLiveRefusal('Name the content (contentIds: Instagram media or Facebook post ids from view search, at most 50).')
      if (kinds.length !== 1) throw new MetaLiveRefusal('Look up by ONE of contentIds, permalinks or adCodes (at most 50); Meta takes one kind per request.')
      const key = kinds[0] as string
      const values = key === 'content_ids' ? input.contentIds! : key === 'permalinks' ? input.permalinks! : input.adCodes!
      if (key === 'content_ids' && values.some((v) => !/^\d{1,25}(_\d{1,25})?$/.test(v))) throw new MetaLiveRefusal('A content id is an Instagram media id or a Facebook post id (digits, or <page>_<post>).')
      if (key === 'permalinks' && values.some((v) => !/^https:\/\/(www\.)?(instagram|facebook)\.com\/[^\s]{1,400}$/.test(v))) throw new MetaLiveRefusal('A permalink is an https://www.instagram.com/… or https://www.facebook.com/… link.')
      if (key === 'ad_codes' && values.some((v) => !/^[A-Za-z0-9_=+/-]{1,200}$/.test(v))) throw new MetaLiveRefusal('An ad code is the code the creator shared (letters, digits and _ = + / -).')
      const fields = input.view === 'content-insights' ? `content_id,platform,permalink,author{${IDENTITY}},${ORGANIC}` : input.insights ? `${CONTENT_FIELDS},${ORGANIC}` : CONTENT_FIELDS
      const read = await noted(() => graphPage(connectionId, input.view === 'lookup' ? 'partners.contentLookup' : 'partners.contentInsights', `${brand.businessId}/partnership-ads-advertisable-content`, { ...brand.query, [key]: values, fields }), PARTNERSHIP_ACCESS)
      return {
        ...base, items: await maskContent(read.rows.map(contentRow)),
        note: input.view === 'content-insights'
          ? 'Organic numbers of partnership content (likes, comments, views, reach, shares, interactions, saves) from Meta\'s content discovery API; a number Meta does not give is null, never 0. Paid results of a partnership ad are in meta-ads-live view insights.'
          : 'A look-up answers every match in one go (Meta does not page it).',
      }
    }
    case 'instagram-permissions': {
      const instagramId = instagramOf(account)
      const name = input.creatorUsername?.trim().replace(/^@/, '') || null
      if (name && !IG_USERNAME.test(name)) throw new MetaLiveRefusal('An Instagram username is 1–30 letters, digits, dots and underscores.')
      // Review B1 — the guide's request names no fields and the SDK's IGBCAdsPermission lists only id, permission_type and
      // status, so Meta's own default answer is read and both spellings are mapped (LIVE-PROBES CR-345).
      const read = await noted(() => graphPage(connectionId, 'partners.igPermissions', `${instagramId}/branded_content_ad_permissions`, {
        limit: Math.min(100, input.limit ?? 50), ...(name ? { creator_username: name } : {}), ...(input.after ? { after: input.after } : {}),
      }), PARTNERSHIP_ACCESS)
      const rows = read.rows.map((r) => ({
        permissionId: idOf(r.id), creatorUsername: text(r.creator_username), creatorInstagramId: idOf(r.creator_id), creatorPageId: idOf(r.creator_fb_page),
        status: text(r.permission_status) ?? text(r.status), permissionType: text(r.permission_type),
      }))
      const taken = await takenSets(rows.map((r) => r.creatorPageId), rows.map((r) => r.creatorInstagramId))
      return {
        ...base,
        items: rows.map((r) => ((r.creatorPageId && taken.pages.has(r.creatorPageId)) || (r.creatorInstagramId && taken.instagram.has(r.creatorInstagramId)) ? { permissionId: r.permissionId, takenByAnotherBusiness: true } : r)),
        nextAfter: read.nextAfter, note: 'Instagram partnership-ad permissions of the brand, pending ones included (APPROVED, PENDING, REVOKED …). Meta also needs the system user to hold the ADS, CREATOR_MANAGEMENT or CREATOR_CONTENT role on the Instagram account.',
      }
    }
    case 'facebook-permissions': {
      const pageId = pageOf(account)
      const statuses = [...new Set((input.statuses ?? []).flatMap((s) => FB_PERMISSION_STATUS[s] ?? []))]
      const body = await noted(() => restRead(connectionId, 'partners.fbPermissions', `partnership-ads/fb-account-level-permissions/${pageId}`, {
        ...(statuses.length ? { status: statuses } : {}),
        ...(input.partnerPageIds?.length ? { partner_page_ids: idArray(idList(input.partnerPageIds, 'partner Page')) } : {}),
        ...(input.direction ? { permission_direction: input.direction } : {}),
        limit: Math.min(1000, Math.max(1, input.limit ?? 100)), offset: Math.max(0, input.offset ?? 0),
      }), PARTNERSHIP_ACCESS)
      const rows = rowsOf(body).map((r) => ({ permissionId: idOf(r.id), partnerPageId: idOf(r.partner_page_id), status: FB_STATUS_WORD[num(r.status) ?? -1] ?? (r.status == null ? null : `status ${String(r.status)}`), direction: text(r.permission_direction), createdAt: text(r.created_at) }))
      const taken = await takenIds('PAGE', rows.map((r) => r.partnerPageId).filter((id): id is string => !!id))
      return { ...base, items: rows.map((r) => (r.partnerPageId && taken.has(r.partnerPageId) ? { permissionId: r.permissionId, partnerPageId: r.partnerPageId, takenByAnotherBusiness: true } : r)), offset: Math.max(0, input.offset ?? 0), note: 'Account-level partnership-ad permissions of the chosen Facebook Page (sent and received). The next page: offset + limit.' }
    }
    case 'tag-approvals': {
      const instagramId = instagramOf(account)
      const ids = idList(input.userIds, 'creator Instagram id')
      if (ids.length === 0) throw new MetaLiveRefusal('Name the creators to check (userIds: their Instagram user ids, at most 100; view creator-id finds one by username).')
      const read = await noted(() => graphPage(connectionId, 'partners.tagApproval', `${instagramId}/branded_content_tag_approval`, { user_ids: ids.join(','), fields: 'id', limit: 100 }),
        'This read needs instagram_branded_content_brand with Advanced Access (Meta\'s App Review and Business Verification) and a Facebook User token; until the app has it, the Owner checks approved creators in the Instagram app (Settings › Business tools › Branded content).')
      const approved = new Set(read.rows.map((r) => idOf(r.id)).filter(Boolean))
      return { ...base, items: ids.map((id) => ({ instagramId: id, approvedToTag: approved.has(id) })), note: 'Whether each creator may tag the brand in the paid-partnership label (when the brand requires approval).' }
    }
    case 'allowlist': {
      const pageId = pageOf(account)
      const [status, creators] = await Promise.all([
        part(async () => text(obj(await restRead(connectionId, 'partners.allowlistStatus', `partnership-ads/fb-branded-content/${pageId}/brand-allowlist-status`))?.allowlist_status)),
        part(async () => {
          const rows = rowsOf(await restRead(connectionId, 'partners.allowlistCreators', `partnership-ads/fb-branded-content/${pageId}/brand-allowlisted-creators`))
            .map((r) => ({ creatorPageId: idOf(r.creator_page_id), creatorPageName: text(r.creator_page_name), ineligibleForBrandedContent: r.creator_ineligible_for_bc === true }))
          const taken = await takenIds('PAGE', rows.map((r) => r.creatorPageId).filter((id): id is string => !!id))
          return rows.map((r) => (r.creatorPageId && taken.has(r.creatorPageId) ? { creatorPageId: r.creatorPageId, takenByAnotherBusiness: true } : r))
        }),
      ])
      return {
        ...base, allowlistStatus: status.value, allowlistStatusNotRead: status.notRead, creators: creators.value, creatorsNotRead: creators.notRead,
        note: 'ENABLED: only the allowlisted creator Pages may tag the chosen Page in branded content; DISABLED: any creator allowed to make branded content may. A creator flagged ineligibleForBrandedContent can no longer make branded content at all.',
        ...(status.notRead && creators.notRead ? { access: PARTNERSHIP_ACCESS } : {}),
      }
    }
    case 'tagged-posts': {
      const pageId = pageOf(account)
      const from = day(input.from, 'from')
      const to = day(input.to, 'to')
      const body = await noted(() => restRead(connectionId, 'partners.brandedPosts', `partnership-ads/fb-branded-content/${pageId}/branded-content-posts`, {
        ...(from ? { start_date: from } : {}), ...(to ? { end_date: to } : {}),
        ...(input.creatorPageIds?.length ? { creator_page_ids: idArray(idList(input.creatorPageIds, 'creator Page')) } : {}),
        limit: Math.min(500, Math.max(1, input.limit ?? 100)), offset: Math.max(0, input.offset ?? 0),
      }), PARTNERSHIP_ACCESS)
      const rows = rowsOf(body).map((r) => ({ postId: idOf(r.fb_post_id), creatorPageId: idOf(r.creator_page_id), creatorPageName: text(r.creator_page_name), createdAt: text(r.created_at) }))
      const taken = await takenIds('PAGE', rows.map((r) => r.creatorPageId).filter((id): id is string => !!id))
      return { ...base, items: rows.map((r) => (r.creatorPageId && taken.has(r.creatorPageId) ? { postId: r.postId, creatorPageId: r.creatorPageId, takenByAnotherBusiness: true } : r)), offset: Math.max(0, input.offset ?? 0), note: 'Facebook branded-content posts that tag the chosen Page (to is exclusive). The next page: offset + limit.' }
    }
    case 'creator-id': {
      if (!input.username) throw new MetaLiveRefusal('Name the creator (username, their Instagram username).')
      const found = await discover(account, input.username, 'id,username', 'partners.creatorId')
      return found.taken ? { ...base, instagramId: found.id, takenByAnotherBusiness: true } : { ...base, instagramId: found.id, username: text(found.found?.username), note: 'The creator\'s Instagram user id, for partnership ads and permission requests.' }
    }
    case 'collab-invites': {
      const instagramId = instagramOf(account)
      const read = await noted(() => graphPage(connectionId, 'partners.collabInvites', `${instagramId}/collaboration_invites`, { fields: 'media_id,media_owner_username,caption,media_url', limit: Math.min(50, input.limit ?? 25), ...(input.after ? { after: input.after } : {}) }), IG_USER_TOKEN)
      return { ...base, items: read.rows.map((r) => ({ mediaId: idOf(r.media_id), ownerUsername: text(r.media_owner_username), caption: text(r.caption), mediaUrl: text(r.media_url) })), nextAfter: read.nextAfter, note: 'Pending Collab invites to the chosen Instagram account (feed images, Reels and carousels; never Stories). Meta allows 300 of these reads per account per day. Accepting or declining comes with a later Nexus change step.' }
    }
    case 'collab-media': {
      const instagramId = instagramOf(account)
      if (input.mediaId) {
        const mediaId = metaObjectId(input.mediaId)
        if (!mediaId) throw new MetaLiveRefusal('mediaId is an Instagram media id (digits only).')
        const { body } = await noted(() => metaReadOne<Row>({ connectionId }, { operation: 'partners.collabMedia', path: instagramId, query: { fields: `collaborative_media_search.media_id(${mediaId}){${COLLAB_FIELDS}}` } }), IG_USER_TOKEN)
        const found = obj(body.collaborative_media_search)
        return { ...base, item: found ? collabRow(found) : null, note: found ? 'One collaborative post the chosen account is an accepted collaborator on.' : 'Meta found no collaborative post with that id (the account must be an accepted collaborator, and it is not its own post).' }
      }
      const read = await noted(() => graphPage(connectionId, 'partners.collabMedia', `${instagramId}/collaborative_media`, { fields: COLLAB_FIELDS, limit: Math.min(50, input.limit ?? 25), ...(input.after ? { after: input.after } : {}) }), IG_USER_TOKEN)
      return { ...base, items: read.rows.map(collabRow), nextAfter: read.nextAfter, note: 'Posts made by others on which the chosen Instagram account is an accepted collaborator (its own posts are not here).' }
    }
    case 'creator-marketplace': {
      const instagramId = instagramOf(account)
      const { body } = await noted(() => metaReadOne<Row>({ connectionId }, { operation: 'partners.creatorBrandInfo', path: `${instagramId}/creator_marketplace_brand_info` }), CREATOR_ACCESS)
      const audiences = (Array.isArray(body.custom_audiences) ? body.custom_audiences : rowsOf(body.custom_audiences)).filter(isRow).slice(0, 500)
      const own = audiences.length ? await ownAudienceIds(account) : new Set<string>()
      return {
        ...base, customAudiencesAccess: text(body.custom_audiences_access_status) ?? (body.custom_audiences_access_status ?? null),
        customAudiences: audiences.map((a) => { const id = idOf(a.id); return id && own.has(id) ? { customAudienceId: id, name: text(a.name) } : { customAudienceId: id, inChosenAdAccount: false } }),
        note: 'The brand\'s Creator Marketplace standing and the saved audiences Meta lets it match creators against (view creators with customAudienceId). Only audiences of the ad account this business chose carry a name. Nexus reads as the brand itself, never as an agency for another business (acting_business_id is not sent).',
      }
    }
    case 'creators': {
      const instagramId = instagramOf(account)
      const filters = { ...(input.creatorFilters ?? {}) }
      if (input.username && (Object.keys(creatorQuery(filters)).length || input.customAudienceId)) throw new MetaLiveRefusal('Meta takes no other filter with a creator\'s username: ask either for one creator (username) or with filters / a saved audience.')
      if (filters.similarTo?.length && filters.query) throw new MetaLiveRefusal('Meta does not combine similarTo with a keyword query: ask with one of them.')
      const name = input.username?.trim().replace(/^@/, '') || null
      if (name && !IG_USERNAME.test(name)) throw new MetaLiveRefusal('An Instagram username is 1–30 letters, digits, dots and underscores.')
      const audience = input.customAudienceId ? await ownAudience(account, input.customAudienceId) : null
      const query = { ...creatorQuery(filters), ...(name ? { username: name } : {}), ...(audience ? { custom_audience_id: audience } : {}), limit: Math.min(50, input.limit ?? 25), ...(input.after ? { after: input.after } : {}) }
      const path = `${instagramId}/creator_marketplace_creators`
      // Each field list in turn while Meta refuses the one before for its fields (code 100): with a username the creator's
      // insights, media and partnerships, then the same without insights, then the profile only.
      const lists = name ? [`${CREATOR_DETAIL},${CREATOR_INSIGHTS}`, CREATOR_DETAIL, CREATOR_CORE] : [CREATOR_CORE]
      let read: Awaited<ReturnType<typeof graphPage>> | null = null
      let fieldsNote: string | null = null
      for (const [i, fields] of lists.entries()) {
        try {
          read = await noted(() => graphPage(connectionId, 'partners.creators', path, { ...query, fields }), CREATOR_ACCESS)
          break
        } catch (err) {
          if (i === lists.length - 1 || !fieldsRefused(err)) throw err
          fieldsNote = i === 0
            ? `Meta refused the creator's insights (${err.failure.sentence}); read without them.`
            : `Meta refused the creator's media and partnership fields (${err.failure.sentence}); the creator's profile only.`
        }
      }
      const rows = read!.rows.map(creatorRow)
      const taken = await takenSets(rows.map((r) => r.pageId), rows.map((r) => r.id))
      return {
        ...base, items: rows.map((r) => ((r.id && taken.instagram.has(r.id)) || (r.pageId && taken.pages.has(r.pageId)) ? { id: r.id, takenByAnotherBusiness: true } : r)), nextAfter: read!.nextAfter, fieldsNote,
        note: 'Creators from Meta\'s Creator Marketplace for partnership ads (Meta\'s ranking; with customAudienceId: creators whose followers overlap that saved audience). Contact e-mail, gender and age of creators are not read. Messaging a creator happens in Meta\'s apps.',
      }
    }
  }
}

function collabRow(r: Row) {
  return {
    mediaId: idOf(r.id), ownerUsername: text(r.username), caption: text(r.caption), mediaType: text(r.media_type), productType: text(r.media_product_type),
    permalink: text(r.permalink), timestamp: text(r.timestamp), likes: num(r.total_like_count), comments: num(r.total_comments_count), views: num(r.total_views_count),
  }
}

// ── meta-ad-library ───────────────────────────────────────────────────────────────────────────────────────────────────

export const LIBRARY_VIEWS = ['search', 'instagram-account', 'hashtag', 'recent-hashtags', 'page-posts'] as const
export type LibraryView = typeof LIBRARY_VIEWS[number]
export const LIBRARY_STATUSES = ['ACTIVE', 'INACTIVE', 'ALL'] as const
/** Nexus runs no political or social-issue ads (banned in the EU for it), so that type is not searched. */
export const LIBRARY_AD_TYPES = ['ALL', 'EMPLOYMENT_ADS', 'FINANCIAL_PRODUCTS_AND_SERVICES_ADS', 'HOUSING_ADS'] as const
export const LIBRARY_MEDIA = ['ALL', 'IMAGE', 'MEME', 'VIDEO', 'NONE'] as const
export const LIBRARY_PLATFORMS = ['FACEBOOK', 'INSTAGRAM', 'AUDIENCE_NETWORK', 'MESSENGER', 'WHATSAPP', 'OCULUS', 'THREADS', 'STREAMING_SERVICES'] as const
const LIBRARY_FIELDS = [
  'id', 'ad_creation_time', 'ad_creative_bodies', 'ad_creative_link_captions', 'ad_creative_link_descriptions', 'ad_creative_link_titles',
  'ad_delivery_start_time', 'ad_delivery_stop_time', 'languages', 'page_id', 'page_name', 'publisher_platforms',
  'eu_total_reach', 'total_reach_by_location', 'age_country_gender_reach_breakdown', 'beneficiary_payers', 'target_ages', 'target_gender', 'target_locations',
].join(',')
const IG_PUBLIC_MEDIA = 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count'

export interface LibraryInput {
  connectionId?: string | null
  view: LibraryView
  searchTerms?: string | null; exactPhrase?: boolean; pageIds?: string[]; countries?: string[]; status?: string | null
  from?: string | null; to?: string | null; languages?: string[]; mediaType?: string | null; platforms?: string[]; adType?: string | null
  username?: string | null; mediaLimit?: number; hashtag?: string | null; hashtagId?: string | null; order?: 'top' | 'recent'; pageId?: string | null
  limit?: number; after?: string | null
}

const LIBRARY_ACCESS = 'Meta\'s Ad Library API needs Ad Library API access for the app (Meta asks the person behind the app to confirm their identity and accept the Ad Library terms at facebook.com/ads/library/api). Until then, the public Ad Library at facebook.com/ads/library shows the same ads.'
const PUBLIC_CONTENT = 'Hashtag search needs Meta\'s Instagram Public Content Access feature (App Review) with instagram_basic; until the app has it, search the hashtag in the Instagram app.'
const PPCA = 'Reading another Page\'s posts needs Meta\'s Page Public Content Access feature (App Review); until the app has it, open the Page on Facebook.'

/** One live research read: Meta's Ad Library, another Instagram professional account, a hashtag, another Page's posts. */
export async function liveLibrary(input: LibraryInput) {
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId } = account
  switch (input.view) {
    case 'search': {
      const terms = input.searchTerms?.trim() || null
      const pageIds = idList(input.pageIds, 'Page')
      // Review A3 — the Ad Library is public, but Nexus never uses it to look into another business's own Page.
      const takenPages = await takenIds('PAGE', pageIds)
      if (takenPages.size) throw new MetaLiveRefusal(`Another business in Nexus uses ${[...takenPages].join(', ')}, so Nexus does not search its ads here.`)
      if (!terms && pageIds.length === 0) throw new MetaLiveRefusal('Name what to search: searchTerms (at most 100 characters; Meta does not translate them — search in the market\'s language) or pageIds (at most 10 Pages).')
      if (!input.countries?.length) throw new MetaLiveRefusal('Name the countries the ads reached (countries: ISO codes such as IT, DE, or ALL). Meta returns a non-political ad only when it reached the EU.')
      const from = day(input.from, 'from')
      const to = day(input.to, 'to')
      const read = await noted(() => graphPage(connectionId, 'library.search', 'ads_archive', {
        ad_reached_countries: input.countries!, fields: LIBRARY_FIELDS, limit: Math.min(100, Math.max(1, input.limit ?? 25)),
        ...(terms ? { search_terms: terms, search_type: input.exactPhrase ? 'KEYWORD_EXACT_PHRASE' : 'KEYWORD_UNORDERED' } : {}),
        ...(pageIds.length ? { search_page_ids: idArray(pageIds) } : {}),
        ...(input.status ? { ad_active_status: input.status } : {}),
        ...(from ? { ad_delivery_date_min: from } : {}), ...(to ? { ad_delivery_date_max: to } : {}),
        ...(input.languages?.length ? { languages: input.languages } : {}),
        ...(input.mediaType ? { media_type: input.mediaType } : {}),
        ...(input.platforms?.length ? { publisher_platforms: input.platforms } : {}),
        ...(input.adType ? { ad_type: input.adType } : {}),
        ...(input.after ? { after: input.after } : {}),
      }), LIBRARY_ACCESS)
      return {
        // Meta: an empty page while paging is the end.
        items: await maskLibrary(read.rows.map(libraryRow)), nextAfter: read.rows.length ? read.nextAfter : null,
        note: 'Ads from Meta\'s public Ad Library (other advertisers included): texts, dates, platforms and, for ads delivered to the EU or UK, Meta\'s EU transparency data (reach, ages, genders, locations, payer and beneficiary). Spend and impressions are public for political ads only. libraryUrl opens the ad on facebook.com/ads/library. Downloading creatives is allowed only for analysis under Meta\'s Ad Library terms; Nexus stores none of it.',
      }
    }
    case 'instagram-account': {
      if (!input.username) throw new MetaLiveRefusal('Name the Instagram professional account (username).')
      const n = Math.min(25, Math.max(1, input.mediaLimit ?? 12))
      const found = await discover(account, input.username, `id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url,media.limit(${n}){${IG_PUBLIC_MEDIA}}`, 'library.instagramAccount')
      if (found.taken) return { instagramId: found.id, takenByAnotherBusiness: true }
      const f = found.found!
      return {
        instagramId: found.id, username: text(f.username), name: text(f.name), biography: text(f.biography), website: text(f.website),
        followers: num(f.followers_count), follows: num(f.follows_count), mediaCount: num(f.media_count), profilePictureUrl: text(f.profile_picture_url),
        media: rowsOf(f.media).map(igMediaRow),
        note: 'Public numbers and recent posts of an Instagram professional account, read through the business\'s own Instagram account (Meta\'s business discovery; personal and age-gated accounts are not returned).',
      }
    }
    case 'hashtag': {
      const instagramId = instagramOf(account)
      let hashtagId = input.hashtagId ? metaObjectId(input.hashtagId) : null
      if (input.hashtagId && !hashtagId) throw new MetaLiveRefusal('hashtagId is a Meta id (digits only).')
      // Review A3 — an id that is another business's Page or Instagram account is never read as a "hashtag".
      if (hashtagId) {
        const taken = await takenSets([hashtagId], [hashtagId])
        if (taken.pages.size || taken.instagram.size) return { hashtagId, takenByAnotherBusiness: true }
      }
      const tag = input.hashtag?.trim().replace(/^#/, '') || null
      if (!hashtagId) {
        if (!tag || !/^[\p{L}\p{N}_]{1,100}$/u.test(tag)) throw new MetaLiveRefusal('Name the hashtag (letters, digits and _; no #, spaces or emojis) or its hashtagId.')
        const found = await noted(() => graphPage(connectionId, 'library.hashtagSearch', 'ig_hashtag_search', { user_id: instagramId, q: tag }), PUBLIC_CONTENT)
        hashtagId = idOf(found.rows[0]?.id) ?? idOf(found.body.id)
        if (!hashtagId) throw new MetaLiveRefusal('Meta has no hashtag by that name (or deems it sensitive).')
      }
      const edge = input.order === 'recent' ? 'recent_media' : 'top_media'
      const read = await noted(() => graphPage(connectionId, `library.${edge}`, `${hashtagId}/${edge}`, { user_id: instagramId, fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count', limit: Math.min(50, input.limit ?? 25), ...(input.after ? { after: input.after } : {}) }), PUBLIC_CONTENT)
      return {
        hashtagId, hashtag: tag, order: input.order === 'recent' ? 'recent' : 'top', items: read.rows.map(igMediaRow), nextAfter: read.nextAfter,
        note: 'Public Instagram posts with the hashtag (top or most recent; never Stories). Each hashtag counts against Meta\'s limit of 30 different hashtags per Instagram account per rolling 7 days (view recent-hashtags shows the ones used); found posts cannot be commented on through Meta\'s API.',
      }
    }
    case 'recent-hashtags': {
      const instagramId = instagramOf(account)
      const read = await noted(() => graphPage(connectionId, 'library.recentHashtags', `${instagramId}/recently_searched_hashtags`, { fields: 'id,name', limit: 30 }), PUBLIC_CONTENT)
      return { items: read.rows.map((r) => ({ hashtagId: idOf(r.id), name: text(r.name) })), used: read.rows.length, limit: 30, note: 'Hashtags the chosen Instagram account searched in the last 7 days (Meta allows 30 different ones per rolling 7 days).' }
    }
    case 'page-posts': {
      const pageId = input.pageId ? metaObjectId(input.pageId) : null
      if (!pageId) throw new MetaLiveRefusal('Name the Facebook Page (pageId, digits). The chosen Page\'s own posts are meta-page-posts.')
      if ((await takenIds('PAGE', [pageId])).has(pageId)) return { pageId, takenByAnotherBusiness: true, note: 'Another business in Nexus uses this Page, so it is not read here.' }
      const read = await noted(() => graphPage(connectionId, 'library.pagePosts', `${pageId}/feed`, { fields: 'id,message,created_time,permalink_url,status_type', limit: Math.min(100, input.limit ?? 25), ...(input.after ? { after: input.after } : {}) }), PPCA)
      return { pageId, items: read.rows.map((r) => ({ postId: text(r.id), message: text(r.message), createdAt: text(r.created_time), permalink: text(r.permalink_url), type: text(r.status_type) })), nextAfter: read.nextAfter, note: 'Public posts of another Facebook Page, for research.' }
    }
  }
}

/** Review A3 — an ad of a Page another business in Nexus uses: its Page id and the flag only. */
async function maskLibrary(rows: Array<ReturnType<typeof libraryRow>>) {
  const taken = await takenIds('PAGE', rows.map((r) => r.pageId).filter((id): id is string => !!id))
  return rows.map((r) => (r.pageId && taken.has(r.pageId) ? { pageId: r.pageId, takenByAnotherBusiness: true } : r))
}

function libraryRow(r: Row) {
  const id = idOf(r.id)
  return {
    libraryId: id, pageId: idOf(r.page_id), pageName: text(r.page_name), createdAt: text(r.ad_creation_time),
    deliveryStart: text(r.ad_delivery_start_time), deliveryStop: text(r.ad_delivery_stop_time),
    bodies: texts(r.ad_creative_bodies), linkTitles: texts(r.ad_creative_link_titles), linkCaptions: texts(r.ad_creative_link_captions), linkDescriptions: texts(r.ad_creative_link_descriptions),
    languages: texts(r.languages), platforms: texts(r.publisher_platforms),
    euTotalReach: num(r.eu_total_reach), reachByLocation: r.total_reach_by_location ?? null, reachByAgeCountryGender: r.age_country_gender_reach_breakdown ?? null,
    beneficiaryPayers: r.beneficiary_payers ?? null, targetAges: r.target_ages ?? null, targetGender: text(r.target_gender), targetLocations: r.target_locations ?? null,
    libraryUrl: id ? `https://www.facebook.com/ads/library/?id=${id}` : null,
  }
}

function igMediaRow(m: Row) {
  return { mediaId: idOf(m.id), caption: text(m.caption), mediaType: text(m.media_type), productType: text(m.media_product_type), permalink: text(m.permalink), timestamp: text(m.timestamp), likes: num(m.like_count), comments: num(m.comments_count) }
}

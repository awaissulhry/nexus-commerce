/**
 * Meta ads step 16 (2026-10-21) — brand safety and webhooks, read LIVE from Meta (GET only, through the gateway):
 *   meta-brand-safety  publisher block lists (of the chosen ad account and its business portfolio: the list, who it is
 *                      shared with, people's roles, the ad accounts it is applied to), content block lists (their posts,
 *                      the ad accounts using them), publisher and content delivery reports of an ad set (and their date
 *                      ranges), the content found in them, the adjacent-content report of an ad set (Feed verification),
 *                      Meta's partner-publisher list and its dates
 *   meta-webhooks      the app's webhook subscriptions (app token), the apps connected to the chosen ad account and to the
 *                      chosen Page, and the ad account's alert (threshold) subscriptions
 * Nothing here stores anything. Only the chosen ad account, its business portfolio, its own ad sets and the chosen Page are
 * read; an ad account or Page another business in Nexus uses is its id and the flag only (taken.ts).
 *
 * D6 (Owner decision, 2026-10-20): block lists, content block lists and delivery reports need a capability grant from Meta
 * that the business does not have (the grant process is undocumented). The reads are built; when Meta refuses, the answer
 * says so plainly and names the controls that need no grant (NO_GRANT_CONTROLS).
 *
 * Checked 2026-10-21 (developers.facebook.com `.md` pages under marketing-api/brand-safety-and-suitability, the
 * reference pages, and Meta's Python Business SDK, main):
 *   - block-list: grant block_list_management_v2_api_access; GET /{block_list_id}?fields=id,name,last_update_user,
 *     last_update_time,business_owner_id,owner_ad_account_id,items_count,web_publishers,app_publishers; GET …/agencies
 *     (businesses it is shared with, APPLY_BLOCK_LIST / MANAGE_BLOCK_LIST); GET …/assigned_users?business_id; GET
 *     …/auto_applied_ad_accounts (only accounts applied with that call, not shared-list use); 80011 = brand-safety rate
 *     limit; SDK publisherblocklist.py (is_auto_blocking_on, is_eligible_at_campaign_level)
 *   - reference/ad-account/publisher_block_lists: GET /act_{id}/publisher_block_lists (no parameters; adds is_auto_blocking_on)
 *   - content-block-lists: grant brand_safety_content_block_list; GET /{business_id}/content_block_lists?fields=id,name,
 *     business; GET /{cbl_id}?fields=id,name,business; GET /{cbl_id}/facebook_content | instagram_content | threads_content
 *     (fields=id); GET /{cbl_id}/applied_ad_accounts?fields=id,account_id; GET /act_{id}/content_block_lists and
 *     fields=contains.content_id(…) are "planned but not yet available"; the CSV export is a PUT on api.facebook.com
 *     ("every time this endpoint is called, a new file will be created") — not a read, so not here
 *   - publisher-delivery-report: grant brand_safety_third_party_partners, ads_read, an Admin-level business user token,
 *     View Performance on the account; GET /publisher_delivery_report_date_ranges (platform, position; at most two ranges
 *     for in-stream / Reels overlay); GET /{adset_id}/publisher_delivery_report (platform, position, sort_by (an_classic and
 *     rewarded_video only), name_contains, publisher_status (instream_video only), start_date, end_date (default the last
 *     30 days), summary; fields url, name, estimated_impressions, content_types, status); 144K calls per hour
 *   - content-delivery-report: same grant; GET /content_delivery_report_date_ranges (fields earliest_datetime,
 *     latest_datetime; global, not per campaign); GET /{adset_id}/content_delivery_report (platform facebook, position
 *     instream_video | facebook_reels_overlay, datetime YYYY-MM-DDTHH:00 in Pacific Time, limit 25–5000; 15-day lookback,
 *     public content only; content_id, creator_id, estimated_impressions); the content itself: GET /{video_id}?fields=…
 *     and GET /{page_id}?fields=name,about,category,link (Page Public Content Access)
 *   - feed-verification (AS-018): grant brand_safety_feed_verification; GET /adjacent_content_delivery_report_date_ranges
 *     (platform facebook | instagram | threads, position feed | reels; earliest_datetime, latest_datetime, missing_datetimes);
 *     the documented report is a business-level file download on api.facebook.com that covers every ad account of the
 *     portfolio — Nexus does not fetch it (it could hold another business's ads); the ad-set edge
 *     /{ad_set_id}/adjacent_content_delivery_report is in Meta's reference index but its page is not found (STILL-UNVERIFIED,
 *     not in the SDK): built, Meta's own answer says whether it exists (LIVE-PROBES AS-018)
 *   - publisher-list: grant brand_safety_third_party_partners; GET /brand_safety_publisher_list (platform audience_network |
 *     facebook, position instream_video | facebook_reels_overlay — the same unified list since 2025-09-02 — sort_by,
 *     search_query, start_date, end_date, blue_verified, follower_count, app_store_category_contains, include_summary;
 *     ≤ 5000 per page; 2.4K calls per hour); GET /brand_safety_publisher_list_metadata
 *   - webhooks (reference/app/subscriptions: object, callback_url, fields, active — app token; reference/ad-account/
 *     subscribed_apps (SDK adaccountsubscribedapps.py: app_id, app_name); reference/page/subscribed_apps (a Page token,
 *     pages_manage_metadata; subscribed_fields); ads-webhooks/subscriptions: GET /act_{id}/subscriptions[/{id}] (ads_read;
 *     scoped to the account and the app that made it; event_type, field, value, operator, filters ≤ 20, status; budgets,
 *     spend and bid amounts in the currency's minor unit)
 */
import { metaAdAccountId, metaObjectId } from '../../cx/connectors/meta/discovery.js'
import { metaAppIdOf } from '../../cx/token.service.js'
import { metaCall } from '../../gateway/meta.js'
import type { GatewayResponse } from '../../gateway/gateway.js'
import { failureOfAnswer, failureOfThrow, localFailure, MetaReadError } from './errors.js'
import { graphSafe, metaChosenAccount, MetaLiveRefusal, objectKindOf, type MetaChosenAccount } from './live.js'
import { metaReadOne } from './read-client.js'
import { takenIds } from './taken.js'
import { graphPage, idOf, noted, num, obj, pageOf, part, portfolioOf, rowsOf, text, type Row } from './live-partners.js'

// ── shared ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The controls that need no capability grant (D6), named in every answer where Meta refuses for the grant. */
export const NO_GRANT_CONTROLS = 'the inventory filter (Meta\'s brand_safety_content_filter_levels on the ad account — meta-ads-live view account shows it — and per ad set), placement choices and exclusions in each ad set\'s targeting, the excluded publisher categories (dating, gambling; on Audience Network and in-stream also debated social issues, mature audiences, tragedy and conflict) and the ad account\'s own controls; block lists themselves stay in Meta\'s Brand Safety and Suitability hub (Business settings).'

function grantRefusal(err: MetaReadError, grant: string): MetaLiveRefusal {
  return new MetaLiveRefusal(`Meta has not granted this capability to the business (${grant}): ${err.message} The no-grant controls are ${NO_GRANT_CONTROLS}`)
}

/** A brand-safety read: when Meta refuses for access, the D6 sentence (the grant it needs and the no-grant controls). */
async function granted<T>(grant: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof MetaReadError && err.failure.permissionDenied) throw grantRefusal(err, grant)
    throw err
  }
}

const GRANT = {
  blockLists: 'block_list_management_v2_api_access',
  contentBlockLists: 'brand_safety_content_block_list',
  deliveryReports: 'brand_safety_third_party_partners',
  feedVerification: 'brand_safety_feed_verification',
} as const

/**
 * An ad set id from a caller, read only when it is the chosen account's own AND an ad set: Nexus's rows, else ONE live
 * read of account_id with the two fields only an ad set has (optimization_goal, billing_event — as the gateway's change
 * check does, gateway.ts META_KIND_FIELD).
 */
async function ownAdSet(account: MetaChosenAccount, id: string | null | undefined): Promise<string> {
  const adSetId = metaObjectId(id)
  if (!adSetId) throw new MetaLiveRefusal('Name the ad set (adSetId: a Meta ad set id of the chosen ad account, digits).')
  const kind = await objectKindOf(account, adSetId)
  if (kind === 'adset') return adSetId
  if (kind) throw new MetaLiveRefusal(`That id is a ${kind} of this ad account, not an ad set.`)
  const notOwn = 'That ad set does not belong to the ad account this business chose, so it is not read.'
  let body: Row
  try {
    body = (await metaReadOne<Row>({ connectionId: account.connectionId }, { operation: 'safety.adSetCheck', path: adSetId, query: { fields: 'account_id,optimization_goal,billing_event' } })).body
  } catch (err) {
    if (err instanceof MetaReadError) throw new MetaLiveRefusal(/nonexisting field/i.test(err.message) ? 'That id is not an ad set of the chosen ad account.' : notOwn)
    throw err
  }
  if (metaAdAccountId(body.account_id) !== account.adAccountId) throw new MetaLiveRefusal(notOwn)
  if (!text(body.optimization_goal) || !text(body.billing_event)) throw new MetaLiveRefusal('That id is not an ad set of the chosen ad account.')
  return adSetId
}

const ACT = (account: MetaChosenAccount) => `act_${account.adAccountId}`
const cut = <T>(items: T[], max: number) => ({ items: items.slice(0, max), total: items.length, cut: items.length > max })

/** Ad accounts in a list (`id` or `account_id`, with or without act_): the chosen one marked, another business's flagged. */
async function accountRows(rows: Row[], chosen: string) {
  const ids = rows.map((r) => metaAdAccountId(r.account_id ?? r.id))
  const taken = await takenIds('AD_ACCOUNT', ids.filter((id): id is string => !!id))
  return ids.filter((id): id is string => !!id).map((id) => (taken.has(id) ? { adAccountId: id, takenByAnotherBusiness: true } : { adAccountId: id, chosenHere: id === chosen, takenByAnotherBusiness: false }))
}

// ── meta-brand-safety ─────────────────────────────────────────────────────────────────────────────────────────────────

export const SAFETY_VIEWS = [
  'block-lists', 'block-list', 'content-block-lists', 'content-block-list', 'content-block-list-file', 'account-content-block-lists',
  'publisher-report-dates', 'publisher-report', 'content-report-dates', 'content-report', 'content-lookup',
  'adjacent-report-dates', 'adjacent-report', 'partner-publishers', 'partner-publishers-dates',
] as const
export type SafetyView = typeof SAFETY_VIEWS[number]
export const PDR_PLATFORMS = ['audience_network', 'facebook', 'instagram'] as const
export const PDR_POSITIONS = ['instream_video', 'facebook_reels_overlay', 'an_classic', 'rewarded_video'] as const
export const CDR_POSITIONS = ['instream_video', 'facebook_reels_overlay'] as const
export const PDR_SORTS = ['impressions_desc', 'impressions_asc', 'url_desc', 'url_asc', 'name_desc', 'name_asc'] as const
export const PUBLISHER_STATUSES = ['all', 'partner', 'non_partner'] as const
export const ADJACENT_PLATFORMS = ['facebook', 'instagram', 'threads'] as const
export const ADJACENT_POSITIONS = ['feed', 'reels'] as const
export const PL_PLATFORMS = ['audience_network', 'facebook'] as const
export const FOLLOWER_BUCKETS = ['less_than_10K', 'between_10K_and_100K', 'between_100K_and_1M', 'between_1M_and_10M', 'greater_than_10M', 'all'] as const
export const CONTENT_PLATFORM_EDGES = { facebook: 'facebook_content', instagram: 'instagram_content', threads: 'threads_content' } as const

const BLOCK_LIST_FIELDS = 'id,name,last_update_user,last_update_time,business_owner_id,owner_ad_account_id,items_count'
const PL_FIELDS: Record<(typeof PL_PLATFORMS)[number], string> = {
  facebook: 'ads_in_live_videos,blue_verified_page,content_creator,date_added,language,median_views_per_video_in_last_28_days,page_followers,url,username,videos_uploaded_last_week',
  audience_network: 'age_rating,app_store_category,content_creator,date_added,is_audience_network_classic,is_audience_network_rewarded,language,url',
}

export interface SafetyInput {
  connectionId?: string | null
  view: SafetyView
  blockListId?: string | null; items?: boolean; contentBlockListId?: string | null; content?: keyof typeof CONTENT_PLATFORM_EDGES | null
  adSetId?: string | null; platform?: string | null; position?: string | null; sortBy?: string | null; nameContains?: string | null
  publisherStatus?: string | null; from?: string | null; to?: string | null; datetime?: string | null
  videoId?: string | null; pageId?: string | null; search?: string | null; blueVerified?: string | null; followerCount?: string | null
  appCategory?: string | null; limit?: number; after?: string | null
}

const dayOf = (v: string | null | undefined, what: string): string | null => {
  if (!v) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new MetaLiveRefusal(`${what} is a day, YYYY-MM-DD.`)
  return v
}

/** A block list read only when it is the chosen ad account's or its business portfolio's (Meta's owner fields). */
async function ownBlockList(account: MetaChosenAccount, id: string | null | undefined, items: boolean) {
  const blockListId = metaObjectId(id)
  if (!blockListId) throw new MetaLiveRefusal('Name the block list (blockListId, from view block-lists).')
  const { body } = await granted(GRANT.blockLists, () => metaReadOne<Row>({ connectionId: account.connectionId }, { operation: 'safety.blockList', path: blockListId, query: { fields: items ? `${BLOCK_LIST_FIELDS},web_publishers,app_publishers` : BLOCK_LIST_FIELDS } }))
  const ownerAccount = metaAdAccountId(body.owner_ad_account_id)
  const ownerBusiness = idOf(body.business_owner_id)
  if (ownerAccount !== account.adAccountId && (!account.businessId || ownerBusiness !== account.businessId)) {
    throw new MetaLiveRefusal('That block list is not the chosen ad account\'s or its business portfolio\'s, so it is not shown.')
  }
  return { blockListId, body }
}

/** One live brand-safety view. `canSeePeople`: the person may see the team (people's roles on a block list). */
export async function liveSafety(input: SafetyInput, canSeePeople: boolean) {
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId } = account
  const base = { adAccountId: account.adAccountId }
  const limit = (max: number, dflt = 100) => Math.min(max, Math.max(1, input.limit ?? dflt))
  const after = input.after ? { after: input.after } : {}
  switch (input.view) {
    case 'block-lists': {
      const read = await granted(GRANT.blockLists, () => graphPage(connectionId, 'safety.blockLists', `${ACT(account)}/publisher_block_lists`, { fields: `${BLOCK_LIST_FIELDS},is_auto_blocking_on`, limit: limit(100), ...after }))
      return { ...base, items: read.rows.map(blockListRow), nextAfter: read.nextAfter, note: 'Publisher block lists of the chosen ad account (apps on Audience Network, Facebook in-stream videos, Reels and Instagram profile feed). A block list holds at most 10,000 URLs; a business owns at most 200.' }
    }
    case 'block-list': {
      const { blockListId, body } = await ownBlockList(account, input.blockListId, !!input.items)
      const [agencies, people, applied] = await Promise.all([
        part(async () => (await granted(GRANT.blockLists, () => graphPage(connectionId, 'safety.blockListAgencies', `${blockListId}/agencies`, { fields: 'id,name', limit: 100 }))).rows.map((r) => ({ businessId: idOf(r.id), name: text(r.name) }))),
        canSeePeople && account.businessId
          ? part(async () => (await granted(GRANT.blockLists, () => graphPage(connectionId, 'safety.blockListPeople', `${blockListId}/assigned_users`, { business_id: account.businessId!, limit: 100 }))).rows.map((r) => ({ userId: idOf(r.id), name: text(r.name), roles: graphSafe(r.permitted_roles ?? r.tasks ?? r.role ?? null) })))
          : Promise.resolve({ value: null, notRead: account.businessId ? 'People\'s roles are shown only to someone who may see the team (Team & access).' : 'The chosen ad account names no business portfolio, which Meta needs to list people\'s roles.' }),
        part(async () => accountRows((await granted(GRANT.blockLists, () => graphPage(connectionId, 'safety.blockListApplied', `${blockListId}/auto_applied_ad_accounts`, { limit: 100 }))).rows, account.adAccountId)),
      ])
      const web = Array.isArray(body.web_publishers) ? body.web_publishers.filter((p): p is Row => !!obj(p)).map((p) => ({ url: text(p.domain_url), name: text(p.publisher_name), id: idOf(p.id) })) : null
      const apps = Array.isArray(body.app_publishers) ? body.app_publishers.filter((p): p is Row => !!obj(p)).map((p) => graphSafe(p)) : null
      return {
        ...base, blockList: blockListRow(body),
        ...(input.items ? { webPublishers: web ? cut(web, 500) : null, appPublishers: apps ? cut(apps, 500) : null } : {}),
        sharedWithBusinesses: agencies.value, sharedWithNotRead: agencies.notRead,
        peopleRoles: people.value, peopleRolesNotRead: people.notRead,
        appliedToAdAccounts: applied.value, appliedToNotRead: applied.notRead,
        note: 'appliedToAdAccounts lists only the ad accounts the list was applied to directly (Meta\'s auto_applied_ad_accounts), not where a shared list is used. Roles are APPLY_BLOCK_LIST or MANAGE_BLOCK_LIST.',
      }
    }
    case 'content-block-lists': {
      const businessId = portfolioOf(account)
      const read = await granted(GRANT.contentBlockLists, () => graphPage(connectionId, 'safety.contentBlockLists', `${businessId}/content_block_lists`, { fields: 'id,name,business', limit: limit(100), ...after }))
      return { ...base, businessId, items: read.rows.map((r) => ({ contentBlockListId: idOf(r.id), name: text(r.name) })), nextAfter: read.nextAfter, note: 'Content block lists of the business portfolio (Facebook, Instagram and Threads posts the ads must not appear next to). At most 200 per business, 2 million posts per list, 75 lists per ad account.' }
    }
    case 'content-block-list': {
      const businessId = portfolioOf(account)
      const cblId = metaObjectId(input.contentBlockListId)
      if (!cblId) throw new MetaLiveRefusal('Name the content block list (contentBlockListId, from view content-block-lists).')
      const { body } = await granted(GRANT.contentBlockLists, () => metaReadOne<Row>({ connectionId }, { operation: 'safety.contentBlockList', path: cblId, query: { fields: 'id,name,business' } }))
      if (idOf(body.business) !== businessId) throw new MetaLiveRefusal('That content block list is not the business portfolio\'s, so it is not shown.')
      const edge = input.content ? CONTENT_PLATFORM_EDGES[input.content] : null
      const [content, applied] = await Promise.all([
        edge ? part(async () => granted(GRANT.contentBlockLists, () => graphPage(connectionId, `safety.${edge}`, `${cblId}/${edge}`, { fields: 'id', limit: limit(500), ...after }))) : Promise.resolve(null),
        part(async () => accountRows((await granted(GRANT.contentBlockLists, () => graphPage(connectionId, 'safety.cblApplied', `${cblId}/applied_ad_accounts`, { fields: 'id,account_id', limit: 100 }))).rows, account.adAccountId)),
      ])
      return {
        ...base, contentBlockList: { contentBlockListId: idOf(body.id), name: text(body.name) },
        ...(content ? { content: { platform: input.content, ids: content.value?.rows.map((r) => text(r.id) ?? idOf(r.id)) ?? null, nextAfter: content.value?.nextAfter ?? null, notRead: content.notRead } } : {}),
        appliedToAdAccounts: applied.value, appliedToNotRead: applied.notRead,
        note: 'The posts on the list (content: facebook, instagram or threads) and the ad accounts it is applied to. Whether one post is on a list cannot be asked yet: Meta lists that read as planned but not available.',
      }
    }
    case 'content-block-list-file':
      // content-block-lists.md: "This endpoint is a PUT and not a GET, as every time this endpoint is called, a new file will
      // be created and stored for retrieval" (PUT https://api.facebook.com/content_block_lists/{id}/file_download).
      return { ...base, available: false, sentence: 'Meta makes the CSV of a content block list with a PUT that creates a new file every time, so it is not a read: Nexus\'s Meta reads send GETs only. View content-block-list with content facebook, instagram or threads lists the posts page by page; the CSV export comes with the block-list change tools (step 39), or a person downloads it in Meta\'s Brand Safety and Suitability hub.' }
    case 'account-content-block-lists':
      // content-block-lists.md: GET /<account_id>/content_block_lists and fields=contains.content_id(…) — "This endpoint is
      // planned but not yet available."
      return { ...base, available: false, sentence: 'Meta cannot list the content block lists applied to one ad account, or check whether a post is on a list, yet: its documentation marks both reads "planned but not yet available". View content-block-lists lists the business\'s lists, and view content-block-list shows the ad accounts each one is applied to.' }
    case 'publisher-report-dates':
    case 'content-report-dates':
    case 'adjacent-report-dates': {
      const adjacent = input.view === 'adjacent-report-dates'
      const content = input.view === 'content-report-dates'
      if (!input.position) throw new MetaLiveRefusal('Name the placement (platform and position).')
      const path = adjacent ? 'adjacent_content_delivery_report_date_ranges' : content ? 'content_delivery_report_date_ranges' : 'publisher_delivery_report_date_ranges'
      const read = await granted(adjacent ? GRANT.feedVerification : GRANT.deliveryReports, () => graphPage(connectionId, `safety.${path}`, path, {
        platform: content ? 'facebook' : input.platform ?? 'facebook', position: input.position,
        fields: adjacent ? 'earliest_datetime,latest_datetime,missing_datetimes' : content ? 'earliest_datetime,latest_datetime' : 'start_date,end_date',
      }))
      return {
        ...base, ranges: read.rows.map((r) => graphSafe(r)),
        note: content || adjacent
          ? 'The hours a content report can be asked for (global availability, Pacific Time; not every campaign has data in every hour).'
          : 'The days a publisher report can be asked for (in-stream and Reels overlay: at most two ranges, newest first).',
      }
    }
    case 'publisher-report': {
      const adSetId = await ownAdSet(account, input.adSetId)
      if (!input.platform || !input.position) throw new MetaLiveRefusal('Name the placement: platform (audience_network, facebook, instagram) and position (instream_video, facebook_reels_overlay, an_classic, rewarded_video).')
      const from = dayOf(input.from, 'from')
      const to = dayOf(input.to, 'to')
      if (!!from !== !!to) throw new MetaLiveRefusal('Meta takes from and to together (YYYY-MM-DD), inside the dates view publisher-report-dates gives.')
      const read = await granted(GRANT.deliveryReports, () => graphPage(connectionId, 'safety.publisherReport', `${adSetId}/publisher_delivery_report`, {
        platform: input.platform!, position: input.position!, fields: 'url,name,estimated_impressions,content_types,status', summary: 'true',
        ...(input.sortBy ? { sort_by: input.sortBy } : {}), ...(input.nameContains ? { name_contains: input.nameContains } : {}),
        ...(input.publisherStatus ? { publisher_status: input.publisherStatus } : {}), ...(from && to ? { start_date: from, end_date: to } : {}),
        ...(['an_classic', 'rewarded_video'].includes(input.position!) ? { limit: limit(500) } : {}), ...after,
      }))
      return {
        ...base, adSetId, summary: obj(read.body.summary) ? graphSafe(read.body.summary) : null,
        items: read.rows.map((r) => ({ url: text(r.url), name: text(r.name), estimatedImpressions: num(r.estimated_impressions), contentTypes: Array.isArray(r.content_types) ? r.content_types : null, status: text(r.status) })),
        nextAfter: read.nextAfter, note: 'Where the ad set\'s ads ran, by publisher, with Meta\'s estimated impressions (the number Meta bills on). Default: the last 30 days.',
      }
    }
    case 'content-report':
    case 'adjacent-report': {
      const adjacent = input.view === 'adjacent-report'
      const adSetId = await ownAdSet(account, input.adSetId)
      if (!input.position) throw new MetaLiveRefusal(adjacent ? 'Name the placement: platform (facebook, instagram, threads) and position (feed, reels).' : 'Name the placement: position (instream_video or facebook_reels_overlay; the platform is facebook).')
      if (input.datetime && !/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(input.datetime)) throw new MetaLiveRefusal('datetime is one hour, YYYY-MM-DDTHH:00, in Pacific Time (Meta\'s own clock for these reports).')
      const edge = adjacent ? 'adjacent_content_delivery_report' : 'content_delivery_report'
      const read = await granted(adjacent ? GRANT.feedVerification : GRANT.deliveryReports, () => graphPage(connectionId, `safety.${edge}`, `${adSetId}/${edge}`, {
        platform: adjacent ? input.platform ?? 'facebook' : 'facebook', position: input.position!, ...(input.datetime ? { datetime: input.datetime } : {}),
        ...(adjacent ? {} : { fields: 'content_id,creator_id,estimated_impressions', summary: 'true' }), ...(input.limit ? { limit: Math.max(25, limit(500)) } : {}), ...after,
      }))
      return {
        ...base, adSetId, summary: obj(read.body.summary) ? graphSafe(read.body.summary) : null,
        items: adjacent ? read.rows.map((r) => graphSafe(r)) : read.rows.map((r) => ({ contentId: idOf(r.content_id) ?? text(r.content_id), creatorId: idOf(r.creator_id), estimatedImpressions: num(r.estimated_impressions) })),
        nextAfter: read.nextAfter,
        note: adjacent
          ? 'The posts next to the ad set\'s ads in Feed or Reels, as Meta answers this ad-set read (shown as Meta gives it: this edge is in Meta\'s reference index but its page is not published).'
          : 'The posts and videos the ad set\'s ads ran in or next to, one hour at a time (Pacific Time, last 15 days, public content only). view content-lookup reads a video or Page found here.',
      }
    }
    case 'content-lookup': {
      if (input.pageId) {
        const pageId = metaObjectId(input.pageId)
        if (!pageId) throw new MetaLiveRefusal('pageId is a Meta Page id (digits only).')
        if ((await takenIds('PAGE', [pageId])).has(pageId)) return { ...base, pageId, takenByAnotherBusiness: true }
        const { body } = await noted(() => metaReadOne<Row>({ connectionId }, { operation: 'safety.lookupPage', path: pageId, query: { fields: 'id,name,about,category,link' } }), 'Reading another Page\'s details needs Meta\'s Page Public Content Access feature (App Review); until the app has it, open the Page on Facebook.')
        return { ...base, page: { pageId: idOf(body.id), name: text(body.name), about: text(body.about), category: text(body.category), link: text(body.link) } }
      }
      const videoId = metaObjectId(input.videoId)
      if (!videoId) throw new MetaLiveRefusal('Name what to look up: videoId (a content_id from view content-report) or pageId (a creator_id).')
      const { body } = await granted(GRANT.deliveryReports, () => metaReadOne<Row>({ connectionId }, { operation: 'safety.lookupVideo', path: videoId, query: { fields: 'id,permalink_url,created_time,updated_time,from{id,name},description,picture' } }))
      const from = obj(body.from)
      const fromId = idOf(from?.id)
      if (fromId && (await takenIds('PAGE', [fromId])).has(fromId)) return { ...base, videoId, pageId: fromId, takenByAnotherBusiness: true }
      return { ...base, video: { videoId: idOf(body.id), permalink: text(body.permalink_url), createdAt: text(body.created_time), updatedAt: text(body.updated_time), fromPageId: fromId, fromName: text(from?.name), description: text(body.description), picture: text(body.picture) }, note: 'The video\'s own download address is not read: Meta allows creatives to be used for review only.' }
    }
    case 'partner-publishers': {
      const platform = (input.platform === 'audience_network' ? 'audience_network' : 'facebook') as (typeof PL_PLATFORMS)[number]
      if (platform === 'facebook' && !input.position) throw new MetaLiveRefusal('Name the position for Facebook: instream_video or facebook_reels_overlay (Meta answers the same unified list for both since 2025-09-02).')
      const from = dayOf(input.from, 'from')
      const to = dayOf(input.to, 'to')
      const read = await granted(GRANT.deliveryReports, () => graphPage(connectionId, 'safety.partnerPublishers', 'brand_safety_publisher_list', {
        platform, ...(platform === 'facebook' ? { position: input.position! } : {}), fields: PL_FIELDS[platform], include_summary: true, limit: limit(500),
        ...(input.sortBy ? { sort_by: input.sortBy } : {}), ...(input.search ? { search_query: input.search } : {}),
        ...(from ? { start_date: from } : {}), ...(to ? { end_date: to } : {}),
        ...(input.blueVerified && platform === 'facebook' ? { blue_verified: input.blueVerified } : {}),
        ...(input.followerCount && platform === 'facebook' ? { follower_count: input.followerCount } : {}),
        ...(input.appCategory && platform === 'audience_network' ? { app_store_category_contains: input.appCategory } : {}),
        ...after,
      }))
      return { ...base, platform, summary: obj(read.body.summary) ? graphSafe(read.body.summary) : null, items: read.rows.map((r) => graphSafe(r)), nextAfter: read.nextAfter, note: 'Meta\'s partner publishers: Pages and apps that signed up for monetization and follow Meta\'s Partner Monetization Policies (who can show in-stream, Reels and Audience Network ads).' }
    }
    case 'partner-publishers-dates': {
      const read = await granted(GRANT.deliveryReports, () => graphPage(connectionId, 'safety.partnerPublishersDates', 'brand_safety_publisher_list_metadata', {
        fields: 'audience_network_latest_date,audience_network_total_publishers,facebook_instream_video_latest_date,facebook_instream_video_total_publishers,facebook_reels_overlay_latest_date,facebook_reels_overlay_total_publishers',
      }))
      return { ...base, placements: read.rows.map((r) => graphSafe(r))[0] ?? null, note: 'The latest date and the number of partner publishers per placement.' }
    }
  }
}

function blockListRow(r: Row) {
  return {
    blockListId: idOf(r.id), name: text(r.name), items: num(r.items_count), lastUpdate: text(r.last_update_time), lastUpdateUserId: idOf(r.last_update_user),
    ownerAdAccountId: metaAdAccountId(r.owner_ad_account_id), ownerBusinessId: idOf(r.business_owner_id),
    ...(typeof r.is_auto_blocking_on === 'boolean' ? { autoBlocking: r.is_auto_blocking_on } : {}),
  }
}

// ── meta-webhooks ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const WEBHOOK_VIEWS = ['all', 'app', 'ad-account', 'page', 'alerts'] as const
export type WebhookView = typeof WEBHOOK_VIEWS[number]

/**
 * ads-webhooks/subscriptions: budgets, spend, bid amounts and cost metrics in a subscription are in the account
 * currency's minor unit (cents). Each such field's value is answered as `…Cents` (money, restricted).
 */
const MONEY_FIELDS = new Set(['spent', 'today_spent', 'yesterday_spent', 'lifetime_spent', 'cpc', 'cpm', 'cpp', 'cpa', 'cost_per', 'daily_budget', 'lifetime_budget', 'spend_cap', 'bid_amount'])
export const isMoneyField = (field: string | null): boolean => !!field && (MONEY_FIELDS.has(field) || field.startsWith('cost_per_'))

/** A threshold as Meta sends it (text): one amount, or a range of two. */
function centsOf(value: unknown): number | number[] | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  const raw = typeof value === 'string' ? value.trim() : Array.isArray(value) ? value.join(',') : ''
  const parts = raw.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!parts.length || parts.some((p) => !/^-?\d+$/.test(p))) return null
  const nums = parts.map(Number)
  return nums.length === 1 ? nums[0] : nums
}

function condition(field: string | null, value: unknown, operator: unknown) {
  return isMoneyField(field)
    ? { field, operator: text(operator), valueCents: centsOf(value) }
    : { field, operator: text(operator), value: typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : value == null ? null : graphSafe(value) }
}

function alertRow(r: Row) {
  const field = text(r.field)
  const main = condition(field, r.value, r.operator)
  return {
    subscriptionId: idOf(r.subscription_id) ?? idOf(r.id), eventType: text(r.event_type), status: text(r.status), field,
    operator: main.operator, ...('valueCents' in main ? { thresholdCents: main.valueCents } : { threshold: main.value }),
    filters: (Array.isArray(r.filters) ? r.filters : []).filter((f): f is Row => !!obj(f)).slice(0, 20).map((f) => condition(text(f.field), f.value, f.operator)),
  }
}

/** A callback URL as it may be shown: origin and path only (a query could carry a secret someone put there). */
const callbackOf = (v: unknown): string | null => {
  const raw = text(v)
  if (!raw) return null
  try { const u = new URL(raw); return `${u.origin}${u.pathname}` } catch { return null }
}

/** One read with the business's Meta APP token (the app's own subscriptions), Meta's failure in words. */
async function appRead(connectionId: string, operation: string, path: string, fields: string): Promise<Row> {
  let answer: GatewayResponse
  try {
    answer = await metaCall({ connectionId, operation, path, query: { fields }, auth: 'app', timeoutMs: 30_000 })
  } catch (err) {
    const failure = failureOfThrow(err)
    if (failure) throw new MetaReadError(failure, operation, 0)
    throw err
  }
  if (!answer.ok) throw new MetaReadError(failureOfAnswer(answer), operation, 1)
  const body = answer.json<Row>()
  if (!body || typeof body !== 'object') throw new MetaReadError(localFailure('Meta answered with something that is not JSON.', 'NOT_JSON'), operation, 1)
  return body
}

/** The webhook set-up of the business's Meta app, ad account and Page, live. Never a verify token, secret or token. */
export async function liveWebhooks(input: { connectionId?: string | null; view: WebhookView; subscriptionId?: string | null; after?: string | null }) {
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId } = account
  const appId = await metaAppIdOf(connectionId)
  const want = (v: WebhookView) => input.view === 'all' || input.view === v
  const app = want('app') ? await part(async () => {
    if (!appId) throw new MetaLiveRefusal('No Meta app id is stored for this connection (a person enters it in Settings › Channels › Meta).')
    const body = await appRead(connectionId, 'webhooks.app', `${appId}/subscriptions`, 'object,callback_url,fields,active')
    return rowsOf(body).map((r) => ({
      object: text(r.object), callbackUrl: callbackOf(r.callback_url), active: typeof r.active === 'boolean' ? r.active : null,
      fields: (Array.isArray(r.fields) ? r.fields : []).map((f) => text(f) ?? text(obj(f)?.name)).filter(Boolean),
    }))
  }) : null
  const adAccount = want('ad-account') ? await part(async () => {
    const read = await graphPage(connectionId, 'webhooks.adAccountApps', `${ACT(account)}/subscribed_apps`, { fields: 'app_id,app_name', limit: 100 })
    return read.rows.map((r) => ({ appId: idOf(r.app_id) ?? idOf(r.id), appName: text(r.app_name) ?? text(r.name), isNexusApp: !!appId && (idOf(r.app_id) ?? idOf(r.id)) === appId }))
  }) : null
  const page = want('page') ? await part(async () => {
    const pageId = pageOf(account)
    const read = await graphPage(connectionId, 'webhooks.pageApps', `${pageId}/subscribed_apps`, { fields: 'id,name,subscribed_fields', limit: 100 }).catch((err) => {
      if (err instanceof MetaReadError && err.failure.permissionDenied) throw new MetaLiveRefusal(`${err.message} Meta answers a Page's connected apps only to a Page access token (pages_manage_metadata, a person with a task on the Page); Nexus reads with the business's system-user token, so this part comes with the webhook set-up step (step 30) or is seen in Meta Business settings.`)
      throw err
    })
    return { pageId, apps: read.rows.map((r) => ({ appId: idOf(r.id), name: text(r.name), fields: (Array.isArray(r.subscribed_fields) ? r.subscribed_fields : []).map((f) => text(f) ?? text(obj(f)?.name)).filter(Boolean), isNexusApp: !!appId && idOf(r.id) === appId })) }
  }) : null
  const alerts = want('alerts') ? await part(async () => {
    if (input.subscriptionId) {
      const id = metaObjectId(input.subscriptionId)
      if (!id) throw new MetaLiveRefusal('subscriptionId is a Meta id (digits only).')
      const { body } = await metaReadOne<Row>({ connectionId }, { operation: 'webhooks.alert', path: `${ACT(account)}/subscriptions/${id}` })
      return { items: [alertRow(body)], nextAfter: null }
    }
    const read = await graphPage(connectionId, 'webhooks.alerts', `${ACT(account)}/subscriptions`, { limit: 100, ...(input.after ? { after: input.after } : {}) })
    return { items: read.rows.map(alertRow), nextAfter: read.nextAfter }
  }) : null
  return {
    adAccountId: account.adAccountId, appId,
    ...(app ? { appSubscriptions: app.value, appSubscriptionsNotRead: app.notRead } : {}),
    ...(adAccount ? { adAccountApps: adAccount.value, adAccountAppsNotRead: adAccount.notRead } : {}),
    ...(page ? { pageApps: page.value, pageAppsNotRead: page.notRead } : {}),
    ...(alerts ? { alertSubscriptions: alerts.value?.items ?? null, alertSubscriptionsNextAfter: alerts.value?.nextAfter ?? null, alertSubscriptionsNotRead: alerts.notRead } : {}),
    note: 'Meta\'s ads webhooks take two connections: the app\'s subscription to the ad_account fields (appSubscriptions) and the ad account connected to the app (adAccountApps, isNexusApp). Alert subscriptions are this app\'s threshold and change alerts on the ad account (amounts in minor units of the account currency). No verify token, secret or token is ever read. Subscribing and connecting are changes (set-meta-webhooks, a later step).',
  }
}


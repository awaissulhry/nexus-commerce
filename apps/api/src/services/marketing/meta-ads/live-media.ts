/**
 * Meta ads step 10 (2026-10-21) — reads of media, Page posts, Instagram media, previews and Instant Experiences, LIVE
 * from Meta through the gateway (GET only). Nothing here stores anything; a preview link is handed to the caller and is
 * never stored or logged (the gateway's ledger keeps the path only, and no body of an answer that went well).
 *
 * ONLY the business's chosen assets (metaChosenAccount), with fixed field lists per node type (a caller never names a
 * Graph field or path):
 *   - the chosen ad account `act_<id>` (images, videos, playables, website assets) and its own campaigns, ads and creatives
 *     (live.ts objectInAccount, the one owner + kind check: Nexus's rows, else one live read of account_id and two
 *     fields only that kind has — services/meta/meta-kinds.ts);
 *   - the chosen ad account's own business portfolio (its media library, folders, tags) and the system user's own folders;
 *   - the chosen Facebook Page (`connection.page`): its posts (`<page id>_<post id>` only), live videos, playlists,
 *     Instant Experiences and insights; a video of the chosen ad account's library or of the chosen Page;
 *   - the chosen Instagram account (`connection.instagram`): its media (Meta's `owner`, else its `username`, must be the
 *     chosen account's), stories, quota, events and insights.
 * Anything another business in Nexus uses (a Page, an Instagram account) is `{ id, takenByAnotherBusiness: true }` only.
 *
 * Page reads use the business's system-user token (master ACC-014, the Page's own token, comes with steps 14/37/38):
 * when Meta refuses, the answer says so plainly (PAGE_TOKEN_NOTE) and LIVE-PROBES.md names the read to try once live.
 *
 * Checked 2026-10-21 (curl, ≥3 s apart; developers.facebook.com/documentation/ads-commerce/marketing-api/reference/*.md,
 * developers.facebook.com/docs/graph-api/reference/*, developers.facebook.com/docs/instagram-platform/instagram-graph-
 * api/reference/*, and Meta's Python Business SDK main, facebook_business/adobjects/*.py):
 *   - ad-account/adimages: params hashes, name, minwidth, minheight (also biz_tag_id, business_id — not sent); AdImage
 *     fields (SDK adimage.py); ad-account/advideos: title, minlength, maxlength (+ width / height / aspect filters, not
 *     sent); error 283 asks for Page permissions; ad-account/video_ads: since, until (SDK adaccount.py);
 *     ad-account/adplayables: no params (PlayableContent: SDK playablecontent.py)
 *   - business/images, videos, creatives: creative_folder_id; business/creative_folders, creative_asset_tags and
 *     system-user/assigned_creative_folders: no params (node fields: SDK businessimage.py, businesscreative.py,
 *     businesscreativefolder.py, creativeassettag.py)
 *   - ad-account/website_creative_assets, website_creative_info: link_url; urls_for_asset_extraction: none (node fields:
 *     SDK websitecreativeassetsuggestions.py, websitecreativeinfo.py, adaccounturlforassetextraction.py)
 *   - ad-campaign-group/video_groups: date_range {start, end} (VideoGroup: SDK videogroup.py; its Page and Instagram ids
 *     are not asked)
 *   - Video node: the Graph reference lists id, description, picture, source, created_time, updated_time (and `name`,
 *     which the SDK's AdVideo has only as an upload parameter — never asked, review B2); title, length, status,
 *     permalink_url, is_instagram_eligible are SDK only (advideo.py; RECHECK MD-022) — asked, and each one Meta refuses
 *     is dropped and named (MORE_VIDEO_FIELDS); video/thumbnails, video/captions edges
 *   - page/feed, published_posts, visitor_posts: include_hidden, show_expired (SDK page.py; the feed page: at most 100 per
 *     call, ~600 ranked posts a year, unpublished posts included, is_published says which); visitor_posts: "not supported
 *     for Pages migrated to the New Pages Experience" and "supported" on the same page (LIVE-PROBES); page/ads_posts:
 *     include_inline_create, exclude_dynamic_ads, since, until; page/live_videos: the edge page says reading "can't", the
 *     Page node and SDK say it reads (broadcast_status, source) — built, Meta's answer decides (LIVE-PROBES);
 *     page/video_lists + video_list/videos (SDK videolist.py)
 *   - post (PagePost, SDK pagepost.py): attachments, sponsor_tags; dynamic_posts (RTBDynamicPost) — the edge page says
 *     "can't", the Post node lists it (RECHECK MD-106: STILL-UNVERIFIED; LIVE-PROBES)
 *   - Page insights (pages-api/platforminsights/page.md and …/deprecated-metrics.md): metric, period, since, until,
 *     breakdown; only metrics not on Meta's deprecated list are offered (PAGE_METRICS, POST_METRICS); which of them still
 *     answer after the 2026-06-15 wave is settled live (LIVE-PROBES)
 *   - IG user media (since, until), stories, content_publishing_limit, upcoming_events; IG media fields incl.
 *     boost_eligibility_info, boost_ads_list, copyright_check_information, media_audio_type (ig-media reference; the
 *     shapes of boost_eligibility_info and boost_ads_list are the SDK's: igmediaboosteligibilityinfo.py, igboostmediaad.py);
 *     IG media insights (metric per media kind, breakdown; period is lifetime) and IG user insights (metric, period,
 *     metric_type, timeframe this_month | this_week, breakdown, since, until); IG container: id, status, status_code,
 *     copyright_check_status — it has no owner field, so it is not read here (the publish step adds it)
 *   - previews: ad-account/generatepreviews, ad-creative/previews, adgroup/previews: ad_format (the v26 enum, exactly),
 *     creative_feature (reference enum + the Advantage+ creative guide's features),
 *     dynamic_asset_label, dynamic_customization {language, country} (localized-catalog-da), product_item_ids; the
 *     iframe is "only valid for 24 hours"; adgroup field preview_shareable_link; multi-language-ads (asset_feed_spec,
 *     asset_customization_rules, preview with dynamic_asset_label); use-posts-as-ads (object_id, instagram_user_id,
 *     source_instagram_media_id); canvas/preview (instant-experiences guide)
 *   - Instant Experiences (instant-experiences guide, SDK canvas.py): page/canvases (is_hidden, is_published),
 *     page/canvas_elements, the five template ids and template → document → body_elements
 */
import { metaObjectId } from '../../cx/connectors/meta/discovery.js'
import type { MetaQueryValue } from '../../gateway/meta.js'
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { graphSafe, metaChosenAccount, MetaLiveRefusal, objectInAccount, objectKindOf, type MetaChosenAccount } from './live.js'
import { fieldRefused, listPaged } from './live-objects.js'
import { AD_FORMATS, IG_ACCOUNT_METRICS, IG_MEDIA_METRICS, PAGE_METRICS, POST_METRICS } from '../../meta/meta-media-lists.js'

export { AD_FORMATS, IG_ACCOUNT_METRICS, IG_MEDIA_METRICS, PAGE_METRICS, POST_METRICS }
import { maskTakenRows, takenIds } from './taken.js'

type Row = Record<string, unknown>

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const idText = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const rowsOf = (v: unknown): Row[] => (Array.isArray(obj(v)?.data) ? (obj(v)!.data as unknown[]).filter((r): r is Row => !!obj(r)) : [])
const act = (id: string) => `act_${id}`
const clampRows = (n: number | undefined, dflt = 100) => Math.min(500, Math.max(1, n ?? dflt))

const camelKey = (key: string) => key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())

/** Meta's answer for a caller: paging links and tokens removed (graphSafe), keys in camelCase, at most 8 levels deep. */
export function tidy(value: unknown, depth = 0): unknown {
  const safe = depth === 0 ? graphSafe(value) : value
  if (depth > 8) return null
  if (Array.isArray(safe)) return safe.map((v) => tidy(v, depth + 1))
  if (safe && typeof safe === 'object') {
    const out: Row = {}
    for (const [key, child] of Object.entries(safe as Row)) {
      if (key === 'paging') continue
      out[camelKey(key)] = tidy(child, depth + 1)
    }
    return out
  }
  return safe
}

/**
 * The SDK-only fields Meta refused: the ones its words name ("nonexisting field (x)"), else all of them. Only those are
 * dropped, so one refused field never takes the others with it.
 */
export function refusedFields(more: string[], err: MetaReadError): string[] {
  const named = [...err.failure.sentence.matchAll(/\(([a-z_]+)\)/g)].map((m) => m[1]).filter((f) => more.includes(f))
  return named.length ? named : more
}

/** Read with the documented fields plus the SDK-only ones; each refused SDK-only field is dropped (at most 4 tries). */
async function withFallback<T>(core: string, more: string, read: (fields: string) => Promise<T>): Promise<{ value: T; note: string | null }> {
  let asked = more ? more.split(',') : []
  const dropped: string[] = []
  let last = ''
  for (let attempt = 0; ; attempt++) {
    try {
      const value = await read(asked.length ? `${core},${asked.join(',')}` : core)
      return { value, note: dropped.length ? `Meta refused ${dropped.join(', ')} here, so ${dropped.length === 1 ? 'it is' : 'they are'} missing: ${last}` : null }
    } catch (err) {
      if (!asked.length || !fieldRefused(err) || attempt >= 3) throw err
      const refused = attempt === 2 ? asked : refusedFields(asked, err)
      dropped.push(...refused)
      asked = asked.filter((f) => !refused.includes(f))
      last = err.failure.sentence
    }
  }
}

async function oneWithFallback(connectionId: string, operation: string, path: string, core: string, more: string, query: Record<string, MetaQueryValue> = {}) {
  const read = await withFallback(core, more, async (fields) => (await metaReadOne({ connectionId }, { operation, path, query: { ...query, fields } })).body as Row)
  return { body: read.value, note: read.note }
}

async function listWithFallback(connectionId: string, operation: string, path: string, core: string, more: string, query: Record<string, MetaQueryValue>, maxRows: number) {
  const read = await withFallback(core, more, (fields) => listPaged(connectionId, operation, path, { ...query, fields }, maxRows))
  return { ...read.value, note: read.note }
}

/** One part of an answer that may fail on its own (an edge Meta may refuse): its rows, or Meta's sentence. */
export async function part<T>(work: () => Promise<T>): Promise<{ value: T | null; notRead: string | null }> {
  try {
    return { value: await work(), notRead: null }
  } catch (err) {
    if (err instanceof MetaReadError && !err.failure.authLost && !err.failure.throttled) return { value: null, notRead: err.failure.sentence }
    if (err instanceof MetaLiveRefusal) return { value: null, notRead: err.message }
    throw err
  }
}

// ── the chosen assets ────────────────────────────────────────────────────────────────────────────────────────────

const NO_PAGE = 'No Facebook Page is chosen for this business yet. A person chooses it in Settings › Channels › Meta, or Claude asks for it with set-meta-connection (a person approves it).'
const NO_INSTAGRAM = 'No Instagram account is chosen for this business yet. A person chooses it in Settings › Channels › Meta, or Claude asks for it with set-meta-connection (a person approves it).'
export const PAGE_TOKEN_NOTE = 'If Meta\'s words ask for a Page access token or a Page permission: Nexus reads the Page with the business\'s system-user token for now (the system user needs the Page assigned in Meta Business settings); reads that need the Page\'s own token come with a later Nexus step.'

export function pageOf(account: MetaChosenAccount): string {
  if (!account.pageId) throw new MetaLiveRefusal(NO_PAGE)
  return account.pageId
}

export function instagramOf(account: MetaChosenAccount): string {
  if (!account.instagramId) throw new MetaLiveRefusal(NO_INSTAGRAM)
  return account.instagramId
}

function portfolioOf(account: MetaChosenAccount): string {
  if (!account.businessId) throw new MetaLiveRefusal('The chosen ad account names no business portfolio, so a portfolio\'s media library is not read (only the ad account\'s own: views images and videos).')
  return account.businessId
}

export const PORTFOLIO_TAKEN = 'Another business in Nexus reads an ad account of this Meta business portfolio, so the portfolio\'s media library, folders and tags are not read here (they would show that business\'s media too). Read this ad account\'s own media with views images and videos.'

/**
 * Step 10 review A1 — a portfolio another business's chosen ad account belongs to (nexus_meta_links_taken PORTFOLIO) is
 * its id and the flag only, before any call: two businesses in one portfolio never read each other's library.
 */
async function portfolioTaken(portfolioId: string): Promise<{ portfolioId: string; takenByAnotherBusiness: true; sentence: string } | null> {
  return (await takenIds('PORTFOLIO', [portfolioId])).has(portfolioId) ? { portfolioId, takenByAnotherBusiness: true, sentence: PORTFOLIO_TAKEN } : null
}

/** Meta's words when a read needs the Page's own token (its #190 "must be called with a Page Access Token"). */
const PAGE_TOKEN_WORDS = /page access token/i

/**
 * A Page or Instagram read: when Meta refuses it for the token, the answer says what that means. Step 14 review A5 — a
 * token Meta no longer accepts keeps step 2's lost-token sentence (errors.ts: make a new token); only Meta's "needs a
 * Page Access Token" (#190, which the vocabulary files as a lost token) is answered as the Page-token way.
 */
export async function onPage<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof MetaReadError && err.failure.origin === 'meta' && !err.failure.throttled) {
      if (err.failure.permissionDenied) throw new MetaLiveRefusal(`${err.message} ${PAGE_TOKEN_NOTE}`)
      if (err.failure.authLost && PAGE_TOKEN_WORDS.test(err.failure.sentence)) {
        // Meta's own words only, without errors.ts's "make a new token" (the token still works).
        const words = /token \((.*)\)\. Make a new token/s.exec(err.failure.sentence)?.[1] ?? err.failure.sentence
        throw new MetaLiveRefusal(`Meta answers this read only to the Page's own access token, not to the business's system-user token, which still works (Meta's words: ${words}). ${PAGE_TOKEN_NOTE}`)
      }
    }
    throw err
  }
}

/** A post of the chosen Page: Meta's `<page id>_<post id>`; any other post is refused before a call. */
export function pagePostId(pageId: string, id: string): string {
  const value = id.trim()
  if (!/^\d{1,25}_\d{1,25}$/.test(value)) throw new MetaLiveRefusal(`"${id}" is not a Facebook post id (<Page id>_<post id>, as the posts views give it).`)
  if (!value.startsWith(`${pageId}_`)) throw new MetaLiveRefusal('That post is not on the Facebook Page this business chose, so it is not read.')
  return value
}

/** Meta answers a post with its own canonical id: it must still be the chosen Page's (else nothing of it is returned). */
export function stillOnPage(pageId: string, body: Row): void {
  const id = idText(body.id)
  if (id && !id.startsWith(`${pageId}_`)) throw new MetaLiveRefusal('Meta answered with a post that is not on the Facebook Page this business chose; nothing of it is returned.')
}

/** Who wrote a post: the chosen Page, or someone else (a visitor's name and id are never copied). */
function postedBy(pageId: string, row: Row): 'the Page' | 'someone else' | null {
  const from = idText(obj(row.from)?.id)
  return from === null ? null : from === pageId ? 'the Page' : 'someone else'
}

/** A video of the chosen ad account's library or of the chosen Page; any other is refused in words. */
export async function ownVideo(account: MetaChosenAccount, id: string): Promise<string> {
  const videoId = metaObjectId(id)
  if (!videoId) throw new MetaLiveRefusal(`"${id}" is not a Meta video id (digits).`)
  // 1. Meta's own word on who posted it (`from`: a Page) — one read of that alone.
  if (account.pageId) {
    const from = await part(() => metaReadOne({ connectionId: account.connectionId }, { operation: 'media.videoOwnerCheck', path: videoId, query: { fields: 'id,from{id}' } }))
    if (from.value && idText(obj((from.value.body as Row).from)?.id) === account.pageId) return videoId
  }
  // 2. The chosen ad account's library (its first 500 videos).
  const library = await listPaged(account.connectionId, 'media.videoLibraryCheck', `${act(account.adAccountId)}/advideos`, { fields: 'id' }, 500)
  if (library.rows.some((r) => idText(r.id) === videoId)) return videoId
  throw new MetaLiveRefusal(library.more
    ? 'That video is not the chosen Page\'s nor among the first 500 videos of the chosen ad account\'s library, so it is not read.'
    : 'That video is not in the chosen ad account\'s library or on the chosen Facebook Page, so it is not read.')
}

/**
 * An Instagram media of the chosen Instagram account (Meta's `owner`; else its `username` against the chosen account's
 * username read LIVE now, never the one stored at selection); any other is refused. Answers its product type too
 * (FEED, REELS, STORY, AD: which insights it has).
 */
export async function ownMedia(account: MetaChosenAccount, id: string): Promise<{ mediaId: string; productType: string | null }> {
  const instagramId = instagramOf(account)
  const mediaId = metaObjectId(id)
  if (!mediaId) throw new MetaLiveRefusal(`"${id}" is not an Instagram media id (digits).`)
  // Meta: `owner` is "only returned if the app user making the query also created the media; otherwise, username".
  const read = await onPage(() => metaReadOne({ connectionId: account.connectionId }, { operation: 'instagram.mediaOwnerCheck', path: mediaId, query: { fields: 'id,owner,username,media_product_type' } }))
  const body = read.body as Row
  const productType = text(body.media_product_type)
  const owner = idText(obj(body.owner)?.id ?? body.owner)
  if (owner === instagramId) return { mediaId, productType }
  const username = text(body.username)?.toLowerCase() ?? null
  if (!owner && username) {
    const chosen = await onPage(() => metaReadOne({ connectionId: account.connectionId }, { operation: 'instagram.accountUsername', path: instagramId, query: { fields: 'id,username' } }))
    if (text((chosen.body as Row).username)?.toLowerCase() === username) return { mediaId, productType }
  }
  throw new MetaLiveRefusal('That Instagram media is not the chosen Instagram account\'s, so it is not read.')
}

/** An object whose `owner` must be the chosen Page (an Instant Experience, a video playlist). */
async function ownedByPage(account: MetaChosenAccount, id: string, what: string, operation: string): Promise<string> {
  const pageId = pageOf(account)
  const objectId = metaObjectId(id)
  if (!objectId) throw new MetaLiveRefusal(`"${id}" is not a Meta ${what} id (digits).`)
  const read = await onPage(() => metaReadOne({ connectionId: account.connectionId }, { operation, path: objectId, query: { fields: 'id,owner' } }))
  const owner = obj((read.body as Row).owner)
  if (idText(owner?.id ?? (read.body as Row).owner) !== pageId) throw new MetaLiveRefusal(`That ${what} is not the chosen Facebook Page's, so it is not read.`)
  return objectId
}

const PAGE_MASKED = async (rows: Row[]) => (await maskTakenRows('PAGE', rows)) as Row[]
const IG_MASKED = async (rows: Row[]) => (await maskTakenRows('INSTAGRAM', rows)) as Row[]

// ── meta-media-library ───────────────────────────────────────────────────────────────────────────────────────────

export const MEDIA_VIEWS = [
  'images', 'videos', 'video', 'video-ads', 'playables', 'business-images', 'business-videos', 'business-creatives', 'folders',
  'tags', 'my-folders', 'website-assets', 'asset-urls', 'campaign-videos', 'live-videos', 'playlists', 'playlist-videos',
] as const
export type MediaView = typeof MEDIA_VIEWS[number]
export const BROADCAST_STATUSES = ['UNPUBLISHED', 'LIVE', 'LIVE_STOPPED', 'PROCESSING', 'VOD', 'SCHEDULED_UNPUBLISHED', 'SCHEDULED_LIVE', 'SCHEDULED_EXPIRED', 'SCHEDULED_CANCELED'] as const

/** Fixed field lists per node type: the ONLY fields these reads ask. */
export const MEDIA_FIELDS = {
  AdImage: 'id,hash,name,width,height,original_width,original_height,status,created_time,updated_time,url,url_128,permalink_url,creatives,is_associated_creatives_in_adgroups',
  // Review B2 — never `name`: the SDK's AdVideo `name` is an upload parameter, not a field Meta reads back.
  Video: 'id,description,picture,created_time,updated_time',
  VideoDetail: 'id,description,picture,source,created_time,updated_time',
  VideoThumbnail: 'id,uri,width,height,scale,is_preferred',
  /** Meta documents no VideoCaption fields on v26: `locale` asked, the rest asked and dropped when refused. */
  VideoCaption: 'locale',
  VideoCaptionMore: 'locale_name,is_default,is_auto_generated,create_time',
  VideoAd: 'id,updated_time',
  Playable: 'id,name,app_id',
  BusinessImage: 'id,name,hash,width,height,url,url_128,creation_time,media_library_url',
  BusinessCreative: 'id,name,type,hash,video_id,width,height,url,thumbnail,duration,creation_time',
  Folder: 'id,name,description,creation_time,parent_folder_id,media_library_url',
  AssignedFolder: 'id,name,description,tasks',
  Tag: 'name',
  WebsiteAssets: 'id,link_url,extraction_status',
  WebsiteInfo: 'id,link_url,image_urls',
  AssetUrl: 'source_type,source_url',
  VideoGroup: 'id,name,description,created_time',
  /** SDK videogroup.py only (Meta documents no VideoGroup fields): asked, and dropped when refused. */
  VideoGroupMore: 'length,picture,last_used_time,placements,video_group_types,is_disabled,disable_reason,videos',
  // Never stream_url, secure_stream_url, dash_ingest_url or ingest_streams: they carry the live stream's key.
  LiveVideo: 'id,title,description,status,permalink_url,creation_time,planned_start_time,broadcast_start_time,live_views,total_views,video{id}',
  VideoList: 'id,title,description,videos_count,creation_time,last_modified,season_number,thumbnail',
} as const
/** SDK-only fields of a Video (RECHECK MD-022): asked, and asked again without them when Meta refuses. */
export const MORE_VIDEO_FIELDS = 'title,length,status,permalink_url,is_instagram_eligible'

/** Meta's video status in words (VideoStatus; the video-ads guide adds `expired`). */
export function videoStatusText(status: unknown): string | null {
  const s = obj(status)
  const state = text(s?.video_status)
  if (!state) return null
  const progress = typeof s?.processing_progress === 'number' ? ` (${s.processing_progress}%)` : ''
  switch (state) {
    case 'ready': return 'ready: a creative can use it'
    case 'processing': return `Meta is still processing it${progress}: wait before a creative uses it`
    case 'error': return 'Meta could not process it: upload it again'
    case 'expired': return 'the upload expired before it finished: upload it again'
    default: return state
  }
}

function videoRow(row: Row) {
  return { ...(tidy(row) as Row), statusText: videoStatusText(row.status) }
}

export interface MediaInput {
  connectionId?: string | null
  view: MediaView
  hashes?: string[]
  name?: string | null
  minWidth?: number
  minHeight?: number
  minSeconds?: number
  maxSeconds?: number
  videoId?: string | null
  folderId?: string | null
  link?: string | null
  campaignId?: string | null
  playlistId?: string | null
  broadcastStatus?: string[]
  from?: string | null
  to?: string | null
  maxRows?: number
}

/** One view of the media the business's chosen ad account, portfolio and Page hold. */
export async function liveMedia(input: MediaInput) {
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId, adAccountId } = account
  const maxRows = clampRows(input.maxRows)
  const base = { adAccountId }
  switch (input.view) {
    case 'images': {
      const query: Record<string, MetaQueryValue> = { fields: MEDIA_FIELDS.AdImage }
      if (input.hashes?.length) query.hashes = input.hashes
      if (input.name) query.name = input.name
      if (input.minWidth) query.minwidth = input.minWidth
      if (input.minHeight) query.minheight = input.minHeight
      const read = await listPaged(connectionId, 'media.images', `${act(adAccountId)}/adimages`, query, maxRows)
      return {
        ...base,
        items: read.rows.map((r) => {
          const t = tidy(r) as Row
          const creatives = obj(r.creatives) ? rowsOf(r.creatives).map((c) => idText(c.id)) : Array.isArray(r.creatives) ? (r.creatives as unknown[]).map(idText) : []
          return { ...t, creatives: undefined, usedByCreatives: creatives.filter(Boolean), usedInAds: r.is_associated_creatives_in_adgroups === true }
        }),
        more: read.more,
        note: 'url and url128 are Meta\'s temporary links to its copy (Meta: never use them in a creative; a creative takes the hash). usedByCreatives misses creatives that took a picture URL instead of the hash: meta-ad-details reads a creative\'s own image.',
      }
    }
    case 'videos': {
      const query: Record<string, MetaQueryValue> = {}
      if (input.name) query.title = input.name
      if (input.minSeconds) query.minlength = input.minSeconds
      if (input.maxSeconds) query.maxlength = input.maxSeconds
      const read = await onPage(() => listWithFallback(connectionId, 'media.videos', `${act(adAccountId)}/advideos`, MEDIA_FIELDS.Video, MORE_VIDEO_FIELDS, query, maxRows))
      return { ...base, items: read.rows.map(videoRow), more: read.more, fieldsNote: read.note }
    }
    case 'video': {
      if (!input.videoId) throw new MetaLiveRefusal('Name the video (videoId, from view videos).')
      const videoId = await ownVideo(account, input.videoId)
      const node = await onPage(() => oneWithFallback(connectionId, 'media.video', videoId, MEDIA_FIELDS.VideoDetail, MORE_VIDEO_FIELDS))
      const [thumbnails, captions] = await Promise.all([
        part(() => listPaged(connectionId, 'media.videoThumbnails', `${videoId}/thumbnails`, { fields: MEDIA_FIELDS.VideoThumbnail }, 50)),
        part(() => listWithFallback(connectionId, 'media.videoCaptions', `${videoId}/captions`, MEDIA_FIELDS.VideoCaption, MEDIA_FIELDS.VideoCaptionMore, {}, 50)),
      ])
      return {
        ...base,
        video: videoRow(node.body),
        thumbnails: thumbnails.value ? thumbnails.value.rows.map((r) => tidy(r)) : null,
        thumbnailsNotRead: thumbnails.notRead,
        captions: captions.value ? captions.value.rows.map((r) => tidy(r)) : null,
        captionsNotRead: captions.notRead,
        fieldsNote: node.note,
        note: 'A creative may use the video only when Meta says ready; an expired upload starts over. source is Meta\'s temporary link to the file.',
      }
    }
    case 'video-ads': {
      const query: Record<string, MetaQueryValue> = { fields: MEDIA_FIELDS.VideoAd }
      if (input.from) query.since = input.from
      if (input.to) query.until = input.to
      const read = await listPaged(connectionId, 'media.videoAds', `${act(adAccountId)}/video_ads`, query, maxRows)
      return { ...base, items: read.rows.map((r) => tidy(r)), more: read.more, note: 'Videos uploaded through Meta\'s video-ads upload: an id and when it changed; view video reads one (status, details).' }
    }
    case 'playables': {
      const read = await listPaged(connectionId, 'media.playables', `${act(adAccountId)}/adplayables`, { fields: MEDIA_FIELDS.Playable }, maxRows)
      return { ...base, items: read.rows.map((r) => tidy(r)), more: read.more, note: 'Playable (HTML5) assets are for app-install ads only.' }
    }
    case 'business-images':
    case 'business-videos':
    case 'business-creatives': {
      const portfolio = portfolioOf(account)
      const taken = await portfolioTaken(portfolio)
      if (taken) return { ...base, ...taken }
      const folder = input.folderId ? metaObjectId(input.folderId) : null
      if (input.folderId && !folder) throw new MetaLiveRefusal(`"${input.folderId}" is not a Meta folder id (digits).`)
      const query: Record<string, MetaQueryValue> = folder ? { creative_folder_id: folder } : {}
      const edge = input.view === 'business-images' ? 'images' : input.view === 'business-videos' ? 'videos' : 'creatives'
      if (edge === 'videos') {
        const read = await listWithFallback(connectionId, 'media.businessVideos', `${portfolio}/videos`, MEDIA_FIELDS.Video, MORE_VIDEO_FIELDS, query, maxRows)
        return { ...base, portfolioId: portfolio, items: read.rows.map(videoRow), more: read.more, fieldsNote: read.note }
      }
      const fields = edge === 'images' ? MEDIA_FIELDS.BusinessImage : MEDIA_FIELDS.BusinessCreative
      const read = await listPaged(connectionId, `media.business${edge === 'images' ? 'Images' : 'Creatives'}`, `${portfolio}/${edge}`, { ...query, fields }, maxRows)
      return { ...base, portfolioId: portfolio, items: read.rows.map((r) => tidy(r)), more: read.more }
    }
    case 'folders': {
      const portfolio = portfolioOf(account)
      const taken = await portfolioTaken(portfolio)
      if (taken) return { ...base, ...taken }
      const read = await listPaged(connectionId, 'media.folders', `${portfolio}/creative_folders`, { fields: MEDIA_FIELDS.Folder }, maxRows)
      return { ...base, portfolioId: portfolio, items: read.rows.map((r) => tidy(r)), more: read.more, note: 'Nexus does not create or change folders here (Meta has a create call; a later Nexus media step may use it); a person can in Business Settings › Media library.' }
    }
    case 'tags': {
      const portfolio = portfolioOf(account)
      const taken = await portfolioTaken(portfolio)
      if (taken) return { ...base, ...taken }
      const read = await listPaged(connectionId, 'media.tags', `${portfolio}/creative_asset_tags`, { fields: MEDIA_FIELDS.Tag }, maxRows)
      return { ...base, portfolioId: portfolio, items: read.rows.map((r) => tidy(r)), more: read.more, note: 'Meta documents no API to create, change or delete these tags.' }
    }
    case 'my-folders': {
      // Round 3 F1 — the system user's folders are its portfolio's: when another business shares that portfolio (and the
      // system user), they would list that business's folders too, so they are the portfolio's id and the flag only.
      const taken = await portfolioTaken(portfolioOf(account))
      if (taken) return { ...base, ...taken }
      const systemUser = idText(account.connection.systemUser?.id)
      if (!systemUser) throw new MetaLiveRefusal('Nexus has not read which system user this connection acts as yet (meta-connection view check reads it).')
      const read = await listPaged(connectionId, 'media.assignedFolders', `${systemUser}/assigned_creative_folders`, { fields: MEDIA_FIELDS.AssignedFolder }, maxRows)
      return { ...base, items: read.rows.map((r) => tidy(r)), more: read.more, note: 'The folders the business\'s system user may use, with its tasks on each.' }
    }
    case 'website-assets': {
      if (!input.link) throw new MetaLiveRefusal('Name the landing page (link, a full https:// address).')
      const [assets, info] = await Promise.all([
        part(() => listPaged(connectionId, 'media.websiteAssets', `${act(adAccountId)}/website_creative_assets`, { fields: MEDIA_FIELDS.WebsiteAssets, link_url: input.link! }, 50)),
        part(() => listPaged(connectionId, 'media.websiteInfo', `${act(adAccountId)}/website_creative_info`, { fields: MEDIA_FIELDS.WebsiteInfo, link_url: input.link! }, 50)),
      ])
      if (!assets.value && !info.value) throw new MetaLiveRefusal(assets.notRead ?? 'Meta refused the read.')
      return {
        ...base, link: input.link,
        extracted: assets.value ? assets.value.rows.map((r) => tidy(r)) : null, extractedNotRead: assets.notRead,
        stored: info.value ? info.value.rows.map((r) => tidy(r)) : null, storedNotRead: info.notRead,
        note: 'What Meta pulls from the page by itself for Advantage+ creative (Meta documents only these fields of each).',
      }
    }
    case 'asset-urls': {
      const read = await listPaged(connectionId, 'media.assetUrls', `${act(adAccountId)}/urls_for_asset_extraction`, { fields: MEDIA_FIELDS.AssetUrl }, maxRows)
      return { ...base, items: read.rows.map((r) => tidy(r)), more: read.more, note: 'The addresses Meta takes website media and site links from for this ad account.' }
    }
    case 'campaign-videos': {
      if (!input.campaignId) throw new MetaLiveRefusal('Name the campaign (campaignId).')
      const campaignId = await objectInAccount(account, input.campaignId, 'campaign', 'media.campaignCheck')
      const query: Record<string, MetaQueryValue> = {}
      if (input.from || input.to) query.date_range = { ...(input.from ? { start: input.from } : {}), ...(input.to ? { end: input.to } : {}) }
      const read = await listWithFallback(connectionId, 'media.campaignVideoGroups', `${campaignId}/video_groups`, MEDIA_FIELDS.VideoGroup, MEDIA_FIELDS.VideoGroupMore, query, maxRows)
      return { ...base, campaignId, items: read.rows.map((r) => tidy(r)), more: read.more, fieldsNote: read.note, note: 'The video groups the campaign\'s ads use (Meta documents no fields of a video group; the rest are its SDK\'s).' }
    }
    case 'live-videos': {
      const pageId = pageOf(account)
      const query: Record<string, MetaQueryValue> = { fields: MEDIA_FIELDS.LiveVideo }
      if (input.broadcastStatus?.length) query.broadcast_status = input.broadcastStatus
      const read = await onPage(() => listPaged(connectionId, 'media.liveVideos', `${pageId}/live_videos`, query, maxRows))
      return { ...base, pageId, items: read.rows.map((r) => tidy(r)), more: read.more, note: 'A finished live broadcast becomes a video (video.id) that can be boosted. No stream address or key is ever read.' }
    }
    case 'playlists': {
      const pageId = pageOf(account)
      const read = await onPage(() => listPaged(connectionId, 'media.playlists', `${pageId}/video_lists`, { fields: MEDIA_FIELDS.VideoList }, maxRows))
      return { ...base, pageId, items: read.rows.map((r) => tidy(r)), more: read.more, note: 'Meta has no API to create playlists; view playlist-videos lists one.' }
    }
    case 'playlist-videos': {
      if (!input.playlistId) throw new MetaLiveRefusal('Name the playlist (playlistId, from view playlists).')
      const playlistId = await ownedByPage(account, input.playlistId, 'video playlist', 'media.playlistOwnerCheck')
      const read = await onPage(() => listWithFallback(connectionId, 'media.playlistVideos', `${playlistId}/videos`, MEDIA_FIELDS.Video, MORE_VIDEO_FIELDS, {}, maxRows))
      return { ...base, playlistId, items: read.rows.map(videoRow), more: read.more, fieldsNote: read.note }
    }
  }
}

// ── meta-page-posts ──────────────────────────────────────────────────────────────────────────────────────────────

export const POST_VIEWS = ['feed', 'published', 'ads-posts', 'visitor', 'post', 'post-sponsors', 'post-dynamic', 'ad-post', 'page-insights', 'post-insights'] as const
export type PostView = typeof POST_VIEWS[number]

export const POST_FIELDS = {
  // `from{id}` only to say who wrote it (the Page or someone else); a visitor's name or id is never handed on.
  PagePost: 'id,message,story,created_time,updated_time,permalink_url,status_type,is_published,is_hidden,is_expired,is_eligible_for_promotion,promotable_id,scheduled_publish_time,full_picture,is_instagram_eligible,from{id}',
  /** SDK pagepost.py and master MD-101 (not in the v26 feed field table): asked, and asked again without when refused. */
  ListMore: 'is_inline_created',
  Eligibility: 'instagram_eligibility,video_buying_eligibility,attachments{media_type,type,title,description,url,unshimmed_url,media,target,subattachments}',
  /** Not in the v26 feed field table (SDK pagepost.py / master MD-101); `allowed_advertising_objects` is the feed
   * reference's name. Each is asked, and only the ones Meta refuses are dropped. */
  More: 'is_inline_created,allowed_advertising_objects,promotion_status',
  Sponsor: 'id,name',
  DynamicPost: 'id,title,message,description,link,image_url,product_id,created',
  AdPost: 'id,account_id,effective_object_story_id,object_story_id,effective_instagram_media_id,instagram_permalink_url,source_instagram_media_id',
} as const

export const PAGE_PERIODS = ['day', 'week', 'days_28', 'month', 'lifetime', 'total_over_range'] as const
/** The breakdowns Meta's deprecation page names for the media-view metrics. */
export const PAGE_BREAKDOWNS = ['is_from_ads', 'is_from_followers'] as const

function postRow(pageId: string, row: Row) {
  const t = tidy(row) as Row
  const by = postedBy(pageId, row)
  delete t.from
  // Meta's `story` names who did what ("<a person> wrote on …"): kept only for the Page's own posts.
  if (by !== 'the Page') delete t.story
  return { ...t, postedBy: by }
}

/** A list of the chosen Page's posts: a row whose id is not `<page id>_…` is dropped (and counted), never shown. */
function pageRows(pageId: string, rows: Row[]) {
  const own = rows.filter((r) => idText(r.id)?.startsWith(`${pageId}_`))
  return { items: own.map((r) => postRow(pageId, r)), droppedNotOnPage: rows.length - own.length }
}

export interface PostsInput {
  connectionId?: string | null
  view: PostView
  postId?: string | null
  adId?: string | null
  creativeId?: string | null
  includeHidden?: boolean
  showExpired?: boolean
  includeInlineCreated?: boolean
  excludeDynamic?: boolean
  from?: string | null
  to?: string | null
  metrics?: string[]
  period?: string | null
  breakdown?: string | null
  maxRows?: number
}

/** One view of the chosen Page's posts (and the post behind one of the chosen account's ads). */
export async function livePagePosts(input: PostsInput) {
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId } = account
  const maxRows = clampRows(input.maxRows, 50)
  if (input.view === 'ad-post') return adPost(account, input)
  const pageId = pageOf(account)
  const base = { pageId }
  const hiddenExpired = (): Record<string, MetaQueryValue> => ({ ...(input.includeHidden ? { include_hidden: true } : {}), ...(input.showExpired ? { show_expired: true } : {}) })
  switch (input.view) {
    case 'feed':
    case 'published':
    case 'visitor': {
      const edge = input.view === 'feed' ? 'feed' : input.view === 'published' ? 'published_posts' : 'visitor_posts'
      // The feed answers at most 100 posts per call (listPaged() never asks more than 100).
      const read = await onPage(() => listWithFallback(connectionId, `posts.${edge}`, `${pageId}/${edge}`, POST_FIELDS.PagePost, POST_FIELDS.ListMore, hiddenExpired(), maxRows))
      return {
        ...base, ...pageRows(pageId, read.rows), more: read.more, fieldsNote: read.note,
        note: input.view === 'feed'
          ? 'Published, unpublished (dark) and scheduled posts: isPublished says which (Meta: always false for posts made inside an ad). Meta answers about 600 ranked posts a year; expired posts cannot be read.'
          : input.view === 'visitor'
            ? 'Posts other people wrote on the Page. Who wrote each is never copied here: open its permalink. Replying and hiding are comment tools (a later Nexus step). Meta\'s reference says this read may not work for a Page on the New Pages Experience: Meta\'s answer then says so.'
            : 'Published posts only.',
      }
    }
    case 'ads-posts': {
      const query: Record<string, MetaQueryValue> = { include_inline_create: input.includeInlineCreated !== false }
      if (input.excludeDynamic) query.exclude_dynamic_ads = true
      if (input.from) query.since = input.from
      if (input.to) query.until = input.to
      const read = await onPage(() => listWithFallback(connectionId, 'posts.adsPosts', `${pageId}/ads_posts`, POST_FIELDS.PagePost, POST_FIELDS.ListMore, query, maxRows))
      return { ...base, ...pageRows(pageId, read.rows), more: read.more, fieldsNote: read.note, note: 'The Page\'s ad posts, with the dark posts creatives made inline (unless includeInlineCreated is false).' }
    }
    case 'post': {
      if (!input.postId) throw new MetaLiveRefusal('Name the post (postId, from a posts view).')
      const postId = pagePostId(pageId, input.postId)
      const read = await onPage(() => oneWithFallback(connectionId, 'posts.post', postId, `${POST_FIELDS.PagePost},${POST_FIELDS.Eligibility}`, POST_FIELDS.More))
      stillOnPage(pageId, read.body)
      return {
        ...base, post: postRow(pageId, read.body), fieldsNote: read.note,
        note: 'Boost it with promotableId (Meta: "the promotable_id must be used to create ads"; it is not always the post id). isEligibleForPromotion, instagramEligibility and videoBuyingEligibility say where and how; attachments are the photo, video, link and title behind it (subattachments: each card). Once boosted, Meta lets the post be edited only with access to the ad account.',
      }
    }
    case 'post-sponsors':
    case 'post-dynamic':
    case 'post-insights': {
      if (!input.postId) throw new MetaLiveRefusal('Name the post (postId, from a posts view).')
      const postId = pagePostId(pageId, input.postId)
      const check = await onPage(() => metaReadOne({ connectionId }, { operation: 'posts.postCheck', path: postId, query: { fields: 'id' } }))
      stillOnPage(pageId, check.body as Row)
      if (input.view === 'post-sponsors') {
        const read = await onPage(() => listPaged(connectionId, 'posts.sponsors', `${postId}/sponsor_tags`, { fields: POST_FIELDS.Sponsor }, maxRows))
        const rows = await PAGE_MASKED(read.rows)
        return {
          ...base, postId,
          sponsors: rows.map((r) => (r.takenByAnotherBusiness === true ? { pageId: idText(r.id), takenByAnotherBusiness: true } : { pageId: idText(r.id), name: text(r.name), takenByAnotherBusiness: false })),
          more: read.more, note: 'The brands (Pages) tagged as paid partners on the post.',
        }
      }
      if (input.view === 'post-dynamic') {
        const read = await onPage(() => listPaged(connectionId, 'posts.dynamicPosts', `${postId}/dynamic_posts`, { fields: POST_FIELDS.DynamicPost }, maxRows))
        return { ...base, postId, items: read.rows.map((r) => tidy(r)), more: read.more, note: 'The catalog-ad posts Meta made from this post (Meta documents only the edge; these fields are its SDK\'s).' }
      }
      return insights(account, `${postId}/insights`, 'posts.postInsights', input, POST_METRICS, ['post_media_view', 'post_total_media_view_unique', 'post_clicks', 'post_reactions_by_type_total'], { postId })
    }
    case 'page-insights':
      return insights(account, `${pageId}/insights`, 'posts.pageInsights', input, PAGE_METRICS, ['page_media_view', 'page_total_media_view_unique', 'page_post_engagements', 'page_follows', 'page_daily_follows_unique'], base)
  }
}

async function insights(account: MetaChosenAccount, path: string, operation: string, input: PostsInput, allowed: readonly string[], dflt: string[], base: Row) {
  const metrics = input.metrics?.length ? input.metrics : dflt
  const odd = metrics.find((m) => !allowed.includes(m))
  if (odd) throw new MetaLiveRefusal(`"${odd}" is not a metric Nexus asks here; it asks ${allowed.join(', ')}.`)
  const query: Record<string, MetaQueryValue> = { metric: metrics.join(',') }
  if (input.period) query.period = input.period
  if (input.from) query.since = input.from
  if (input.to) query.until = input.to
  if (input.breakdown) query.breakdown = input.breakdown
  const read = await onPage(() => metaReadOne({ connectionId: account.connectionId }, { operation, path, query }))
  return {
    ...base, metrics, period: input.period ?? null, from: input.from ?? null, to: input.to ?? null,
    items: rowsOf(read.body).map((r) => tidy(r)),
    note: 'Meta\'s organic Page numbers (needs read_insights and pages_read_engagement; Pages with at least 100 likes; kept 2 years; a day\'s end_time is the next day). A metric Meta has retired answers "invalid metric".',
  }
}

/** EN-001 / EN-016 — the Facebook post and the Instagram media behind one of the chosen account's ads or creatives. */
async function adPost(account: MetaChosenAccount, input: PostsInput) {
  if (!input.adId && !input.creativeId) throw new MetaLiveRefusal('Name the ad (adId) or the creative (creativeId).')
  let creative: Row
  if (input.adId) {
    const adId = await objectInAccount(account, input.adId, 'ad', 'posts.adCheck')
    const read = await metaReadOne({ connectionId: account.connectionId }, { operation: 'posts.adCreative', path: adId, query: { fields: `id,account_id,creative{${POST_FIELDS.AdPost}}` } })
    const body = read.body as Row
    if (idText(body.account_id) !== account.adAccountId) throw new MetaLiveRefusal('That ad does not belong to the ad account this business chose, so it is not read.')
    creative = obj(body.creative) ?? {}
  } else {
    const creativeId = await objectInAccount(account, input.creativeId!, 'creative', 'posts.creativeCheck')
    const read = await metaReadOne({ connectionId: account.connectionId }, { operation: 'posts.creative', path: creativeId, query: { fields: POST_FIELDS.AdPost } })
    creative = read.body as Row
    if (idText(creative.account_id) !== account.adAccountId) throw new MetaLiveRefusal('That creative does not belong to the ad account this business chose, so it is not read.')
  }
  const postId = text(creative.effective_object_story_id) ?? text(creative.object_story_id)
  return {
    adId: input.adId ?? null,
    creativeId: idText(creative.id),
    facebookPostId: postId,
    facebookPostOnChosenPage: postId && account.pageId ? postId.startsWith(`${account.pageId}_`) : null,
    instagramMediaId: idText(creative.effective_instagram_media_id),
    sourceInstagramMediaId: idText(creative.source_instagram_media_id),
    instagramPermalink: text(creative.instagram_permalink_url),
    note: 'The post id is what the comment tools read (a later Nexus step); view post reads it when it is on the chosen Page. Meta gives no Instagram link for Advantage+ catalog ads (template creatives) or story ads.',
  }
}

// ── meta-instagram-media ─────────────────────────────────────────────────────────────────────────────────────────

// MD-134 (a publish container's status) is not a view: Nexus makes no containers yet, and a container has no owner on
// Meta to check; the Instagram publish step adds it for the container ids it stores.
export const INSTAGRAM_VIEWS = ['accounts', 'media', 'stories', 'media-detail', 'media-insights', 'account-insights', 'quota', 'upcoming-events', 'video-check'] as const
export type InstagramView = typeof INSTAGRAM_VIEWS[number]

export const IG_FIELDS = {
  Media: 'id,caption,media_type,media_product_type,permalink,timestamp,thumbnail_url,media_url,like_count,comments_count,children{id,media_type,media_url,thumbnail_url}',
  MediaDetail: 'boost_eligibility_info,boost_ads_list,copyright_check_information,media_audio_type,shortcode,is_comment_enabled',
  Story: 'id,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp',
  Account: 'id,username',
  Quota: 'config,quota_usage',
  Event: 'id,title,start_time,end_time,notification_subtypes,notification_target_time',
} as const
/** Which media each metric exists on (ig-media/insights, "Media Product Type"); AD media are judged as FEED. */
export const IG_MEDIA_METRIC_TYPES: Readonly<Record<typeof IG_MEDIA_METRICS[number], readonly string[]>> = {
  views: ['FEED', 'REELS', 'STORY'], reach: ['FEED', 'REELS', 'STORY'], likes: ['FEED', 'REELS'], comments: ['FEED', 'REELS'], saved: ['FEED', 'REELS'],
  shares: ['FEED', 'REELS', 'STORY'], reposts: ['FEED', 'REELS', 'STORY'], total_interactions: ['FEED', 'REELS', 'STORY'], follows: ['FEED', 'STORY'],
  profile_visits: ['FEED', 'STORY'], profile_activity: ['FEED', 'STORY'], navigation: ['STORY'], replies: ['STORY'], link_clicks: ['STORY'],
  ig_reels_avg_watch_time: ['REELS'], ig_reels_video_view_total_time: ['REELS'], reels_skip_rate: ['REELS'], facebook_views: ['FEED', 'REELS', 'STORY'],
  crossposted_views: ['REELS'], total_views: ['FEED', 'REELS', 'STORY'], total_likes: ['FEED', 'REELS'], total_comments: ['FEED', 'REELS'],
}
const IG_MEDIA_DEFAULTS: Readonly<Record<string, string[]>> = {
  STORY: ['views', 'reach', 'shares', 'total_interactions', 'replies', 'navigation'],
  FEED: ['views', 'reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions'],
  REELS: ['views', 'reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions'],
}
export const IG_MEDIA_BREAKDOWNS = ['action_type', 'story_navigation_action_type'] as const
export const IG_ACCOUNT_BREAKDOWNS = ['media_product_type', 'follow_type', 'follower_type', 'contact_button_type', 'age', 'city', 'country', 'gender'] as const
/** Review B1 — the last_… and prev_month timeframes are gone since v20 (ig-user/insights): only these two answer. */
export const IG_TIMEFRAMES = ['this_month', 'this_week'] as const
export const IG_METRIC_TYPES = ['total_value', 'time_series'] as const

export interface InstagramInput {
  connectionId?: string | null
  view: InstagramView
  mediaId?: string | null
  videoId?: string | null
  from?: string | null
  to?: string | null
  metrics?: string[]
  breakdown?: string | null
  metricType?: string | null
  timeframe?: string | null
  maxRows?: number
}

function igAccountRow(row: Row, chosen: string | null, where: string) {
  return row.takenByAnotherBusiness === true
    ? { instagramId: idText(row.id), takenByAnotherBusiness: true, where }
    : { instagramId: idText(row.id), username: text(row.username), chosenHere: idText(row.id) === chosen, takenByAnotherBusiness: false, where }
}

/** One view of the chosen Instagram account (accounts: the portfolio's and the chosen Page's, masked). */
export async function liveInstagram(input: InstagramInput) {
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId } = account
  const maxRows = clampRows(input.maxRows, 50)
  if (input.view === 'accounts') return instagramAccounts(account, maxRows)
  if (input.view === 'video-check') {
    if (!input.videoId) throw new MetaLiveRefusal('Name the video (videoId, from meta-media-library view videos).')
    const videoId = await ownVideo(account, input.videoId)
    const read = await metaReadOne({ connectionId }, { operation: 'instagram.videoCheck', path: videoId, query: { fields: 'id,is_instagram_eligible' } })
    return {
      videoId, isInstagramEligible: (read.body as Row).is_instagram_eligible ?? null,
      rules: 'Instagram ad video: at most 2.3 GB; 3–60 s for stream ads; the thumbnail has the video\'s aspect ratio and is at least 600 px wide; a caption at most 2,200 characters. With Instagram-only placements Meta refuses a video that breaks them; with mixed placements it makes the ad but never delivers it on Instagram.',
    }
  }
  const instagramId = instagramOf(account)
  const base = { instagramId }
  switch (input.view) {
    case 'media': {
      const query: Record<string, MetaQueryValue> = { fields: IG_FIELDS.Media }
      if (input.from) query.since = input.from
      if (input.to) query.until = input.to
      const read = await onPage(() => listPaged(connectionId, 'instagram.media', `${instagramId}/media`, query, maxRows))
      return { ...base, items: read.rows.map((r) => tidy(r)), more: read.more, note: 'Posts, reels and carousels (children: each card), newest first; Meta answers the 10,000 most recent, without stories (view stories). mediaUrl is missing when the media holds copyrighted music.' }
    }
    case 'stories': {
      const read = await onPage(() => listPaged(connectionId, 'instagram.stories', `${instagramId}/stories`, { fields: IG_FIELDS.Story }, maxRows))
      return { ...base, items: read.rows.map((r) => tidy(r)), more: read.more, note: 'Stories live 24 hours; Meta returns no live or reshared stories.' }
    }
    case 'media-detail': {
      if (!input.mediaId) throw new MetaLiveRefusal('Name the media (mediaId, from view media or stories).')
      const { mediaId } = await ownMedia(account, input.mediaId)
      const read = await onPage(() => oneWithFallback(connectionId, 'instagram.mediaDetail', mediaId, IG_FIELDS.Media, IG_FIELDS.MediaDetail))
      const body = read.body
      const boosts = rowsOf(body.boost_ads_list).concat(Array.isArray(body.boost_ads_list) ? (body.boost_ads_list as unknown[]).filter((r): r is Row => !!obj(r)) : [])
      const ads = await Promise.all(boosts.map(async (b) => {
        // SDK IGBoostMediaAd: ad_id, ad_status.
        const adId = idText(b.ad_id)
        return { adId, status: text(b.ad_status), inChosenAdAccount: adId ? (await objectKindOf(account, adId)) === 'ad' : false }
      }))
      const out = tidy(body) as Row
      delete out.boostAdsList
      delete out.boostEligibilityInfo
      // SDK IGMediaBoostEligibilityInfo: eligible_to_boost, boost_ineligible_reason.
      const eligibility = obj(body.boost_eligibility_info)
      return {
        ...base, media: out,
        boost: eligibility ? { eligible: typeof eligibility.eligible_to_boost === 'boolean' ? eligibility.eligible_to_boost : null, reason: text(eligibility.boost_ineligible_reason) } : null,
        boostAds: ads, fieldsNote: read.note,
        note: 'boost is Meta\'s word on whether it can be boosted and why not (copyrighted music, filters and other interactive parts cannot). boostAds: the ACTIVE ads boosting it (inChosenAdAccount: an ad Nexus has read for the chosen account). A boosted organic post can no longer be edited.',
      }
    }
    case 'media-insights': {
      if (!input.mediaId) throw new MetaLiveRefusal('Name the media (mediaId).')
      const { mediaId, productType } = await ownMedia(account, input.mediaId)
      const kind = productType === 'STORY' || productType === 'REELS' ? productType : 'FEED'
      const metrics = input.metrics?.length ? input.metrics : IG_MEDIA_DEFAULTS[kind]
      const odd = metrics.find((m) => !(IG_MEDIA_METRICS as readonly string[]).includes(m))
      if (odd) throw new MetaLiveRefusal(`"${odd}" is not a metric Nexus asks of a media; it asks ${IG_MEDIA_METRICS.join(', ')}.`)
      // Review B3 — a metric the media's kind has not (likes on a story, replies on a reel) is refused before the read.
      const other = metrics.find((m) => !IG_MEDIA_METRIC_TYPES[m as typeof IG_MEDIA_METRICS[number]].includes(kind))
      if (other) throw new MetaLiveRefusal(`Meta has no "${other}" for ${kind === 'STORY' ? 'a story' : kind === 'REELS' ? 'a reel' : 'a feed post'}; it has ${IG_MEDIA_METRICS.filter((m) => IG_MEDIA_METRIC_TYPES[m].includes(kind)).join(', ')}.`)
      const query: Record<string, MetaQueryValue> = { metric: metrics.join(',') }
      if (input.breakdown) query.breakdown = input.breakdown
      const read = await onPage(() => metaReadOne({ connectionId }, { operation: 'instagram.mediaInsights', path: `${mediaId}/insights`, query }))
      return { ...base, mediaId, productType, metrics, items: rowsOf(read.body).map((r) => tidy(r)), note: 'Organic numbers of the media over its life (likes, comments, views: organic only; total_…: with ads). Delayed up to 48 hours; an unavailable metric comes back empty, not 0; a story under 5 viewers has none.' }
    }
    case 'account-insights': {
      const metrics = input.metrics?.length ? input.metrics : ['reach', 'views', 'accounts_engaged', 'total_interactions']
      const odd = metrics.find((m) => !(IG_ACCOUNT_METRICS as readonly string[]).includes(m))
      if (odd) throw new MetaLiveRefusal(`"${odd}" is not a metric Nexus asks of an account; it asks ${IG_ACCOUNT_METRICS.join(', ')}.`)
      const demographic = metrics.some((m) => m.endsWith('_demographics'))
      // Round 3 F2 — demographics are period=lifetime with a timeframe (which overrides since / until, so neither is sent);
      // the interaction metrics are period=day: Meta refuses the two kinds in one read.
      if (demographic && !metrics.every((m) => m.endsWith('_demographics'))) {
        throw new MetaLiveRefusal('Ask the demographics (follower_demographics, engaged_audience_demographics) apart from the other metrics: Meta reads them over a timeframe, the others by day.')
      }
      const query: Record<string, MetaQueryValue> = { metric: metrics.join(','), period: demographic ? 'lifetime' : 'day', metric_type: input.metricType ?? 'total_value' }
      if (demographic) query.timeframe = input.timeframe ?? 'this_month'
      else {
        if (input.from) query.since = input.from
        if (input.to) query.until = input.to
      }
      if (input.breakdown) query.breakdown = input.breakdown
      const read = await onPage(() => metaReadOne({ connectionId }, { operation: 'instagram.accountInsights', path: `${instagramId}/insights`, query }))
      return { ...base, metrics, items: rowsOf(read.body).map((r) => tidy(r)), note: 'Organic account numbers (without from/to: the last 24 hours). Demographics: the top 45 only, for the timeframe. Delayed up to 48 hours; an unavailable metric comes back empty, not 0.' }
    }
    case 'quota': {
      const read = await onPage(() => metaReadOne({ connectionId }, { operation: 'instagram.quota', path: `${instagramId}/content_publishing_limit`, query: { fields: IG_FIELDS.Quota } }))
      return { ...base, quota: rowsOf(read.body).map((r) => tidy(r)), note: 'How many posts the account published through the API in the last 24 hours (quotaUsage) against Meta\'s limit (config).' }
    }
    case 'upcoming-events': {
      const read = await onPage(() => listPaged(connectionId, 'instagram.upcomingEvents', `${instagramId}/upcoming_events`, { fields: IG_FIELDS.Event }, maxRows))
      return { ...base, items: read.rows.map((r) => tidy(r)), more: read.more, note: 'Events a reminder ad can point to.' }
    }
  }
  throw new MetaLiveRefusal(`Unknown view "${input.view}".`)
}

/** MD-118–120 — the portfolio's Instagram accounts, the chosen Page's connected and Page-backed ones; masked. */
async function instagramAccounts(account: MetaChosenAccount, maxRows: number) {
  const { connectionId } = account
  const chosen = account.instagramId
  const parts: Record<string, unknown> = {}
  if (account.businessId) {
    for (const edge of ['instagram_accounts', 'instagram_business_accounts'] as const) {
      const read = await part(() => listPaged(connectionId, `instagram.${edge}`, `${account.businessId}/${edge}`, { fields: IG_FIELDS.Account }, maxRows))
      parts[edge === 'instagram_accounts' ? 'portfolio' : 'portfolioBusiness'] = read.value ? (await IG_MASKED(read.value.rows)).map((r) => igAccountRow(r, chosen, 'portfolio')) : { notRead: read.notRead }
    }
  } else parts.portfolio = { notRead: 'The chosen ad account names no business portfolio.' }
  if (account.pageId) {
    const pageId = account.pageId
    const connected = await part(() => metaReadOne({ connectionId }, { operation: 'instagram.pageConnected', path: pageId, query: { fields: 'id,instagram_business_account{id,username}' } }))
    parts.pageConnected = connected.value
      ? (await IG_MASKED([obj((connected.value.body as Row).instagram_business_account)].filter((r): r is Row => !!r))).map((r) => igAccountRow(r, chosen, 'page'))
      : { notRead: `${connected.notRead} ${PAGE_TOKEN_NOTE}` }
    for (const edge of ['instagram_accounts', 'page_backed_instagram_accounts'] as const) {
      const read = await part(() => listPaged(connectionId, `instagram.page.${edge}`, `${pageId}/${edge}`, { fields: IG_FIELDS.Account }, maxRows))
      parts[edge === 'instagram_accounts' ? 'pageAccounts' : 'pageBacked'] = read.value ? (await IG_MASKED(read.value.rows)).map((r) => igAccountRow(r, chosen, 'page')) : { notRead: `${read.notRead} ${PAGE_TOKEN_NOTE}` }
    }
  } else parts.page = { notRead: NO_PAGE }
  return {
    chosenInstagramId: chosen, ...parts,
    note: 'portfolio / portfolioBusiness: the Instagram accounts of the chosen account\'s business portfolio; pageConnected: the account connected to the chosen Page; pageBacked: the Page-backed (shadow) account Meta makes when none is connected. One another business in Nexus uses is its id only. To choose another, set-meta-connection asks for it (a person approves it).',
  }
}

// ── meta-ad-preview ──────────────────────────────────────────────────────────────────────────────────────────────

export const PREVIEW_VIEWS = ['ad', 'creative', 'spec', 'instant-experience', 'share-link'] as const
export type PreviewView = typeof PREVIEW_VIEWS[number]

/** creative_feature: the reference enum plus the features the Advantage+ creative guide previews. */
export const CREATIVE_FEATURES = [
  'ig_video_native_subtitle', 'image_animation', 'product_browsing', 'product_metadata_automation', 'profile_card', 'standard_enhancements_catalog',
  'text_overlay_translation', 'image_templates', 'image_touchups', 'video_auto_crop', 'enhance_cta', 'text_optimizations', 'image_background_gen',
  'image_uncrop', 'description_automation', 'translate_voiceover', 'video_filtering', 'video_uncrop',
] as const
/** call_to_action types a preview spec may name (the common shop ones; the full list is Meta's creative reference). */
export const PREVIEW_CTAS = [
  'SHOP_NOW', 'LEARN_MORE', 'BUY_NOW', 'ORDER_NOW', 'GET_OFFER', 'SIGN_UP', 'SUBSCRIBE', 'CONTACT_US', 'SEE_MORE', 'SEE_DETAILS', 'BOOK_NOW',
  'APPLY_NOW', 'DOWNLOAD', 'WATCH_MORE', 'VIEW_PRODUCT', 'ADD_TO_CART', 'GET_QUOTE', 'MESSAGE_PAGE', 'WHATSAPP_MESSAGE', 'NO_BUTTON',
] as const
export const SPEC_KINDS = ['image', 'video', 'carousel', 'page-post', 'instagram-post', 'multi-language'] as const

/** A preview spec is sent in the URL of a GET (generatepreviews): at most this many characters of Meta's spec. */
export const MAX_SPEC_CHARS = 7000

export const PREVIEW_PUBLIC = 'Each preview link shows the ad as Meta renders it, for 24 hours. Treat every link as PUBLIC: Meta says a generatepreviews link (view spec) is visible to anyone who has it, and an ad or creative preview link can be passed on too. Nexus hands the links to you only and never stores or logs them; do not paste them anywhere public.'

export interface PreviewCard { link: string; headline?: string | null; description?: string | null; imageHash?: string | null; imageUrl?: string | null }
export interface PreviewLanguage { label: string; locales: number[]; isDefault?: boolean; message: string; headline: string; description?: string | null; link: string }
export interface PreviewSpec {
  kind: typeof SPEC_KINDS[number]
  link?: string | null
  message?: string | null
  headline?: string | null
  description?: string | null
  callToAction?: typeof PREVIEW_CTAS[number] | null
  imageHash?: string | null
  imageUrl?: string | null
  videoId?: string | null
  cards?: PreviewCard[]
  postId?: string | null
  instagramMediaId?: string | null
  languages?: PreviewLanguage[]
  withInstagram?: boolean
}

export interface PreviewInput {
  connectionId?: string | null
  view: PreviewView
  adId?: string | null
  creativeId?: string | null
  canvasId?: string | null
  adFormats?: string[]
  creativeFeature?: string | null
  assetLabel?: string | null
  productItemIds?: string[]
  language?: string | null
  country?: string | null
  spec?: PreviewSpec | null
}

const cta = (type: string | null | undefined, link: string | null | undefined) => (type ? { type, ...(link ? { value: { link } } : {}) } : undefined)
const picture = (hash?: string | null, url?: string | null) => (hash ? { image_hash: hash } : url ? { picture: url } : {})
const drop = (o: Row): Row => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''))

/**
 * The creative spec of a preview, built ONLY from these fixed parts: the chosen Page (and the chosen Instagram account),
 * the account's own image hashes (Meta resolves a hash in the account's own library only), a video of the account or the
 * chosen Page, a post of the chosen Page, a media of the chosen Instagram account. A caller never sends a raw spec.
 */
export async function previewSpec(account: MetaChosenAccount, spec: PreviewSpec): Promise<Row> {
  const pageId = pageOf(account)
  const ig = spec.withInstagram === false ? null : account.instagramId
  const story = (data: Row): Row => drop({ page_id: pageId, instagram_user_id: ig ?? undefined, ...data })
  const need = (v: unknown, what: string) => { if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) throw new MetaLiveRefusal(`A ${spec.kind} preview needs ${what}.`) }
  switch (spec.kind) {
    case 'image':
      need(spec.link, 'link'); need(spec.imageHash ?? spec.imageUrl, 'imageHash or imageUrl')
      return { object_story_spec: story({ link_data: drop({ link: spec.link, message: spec.message, name: spec.headline, description: spec.description, ...picture(spec.imageHash, spec.imageUrl), call_to_action: cta(spec.callToAction, spec.link) }) }) }
    case 'video': {
      need(spec.videoId, 'videoId'); need(spec.imageHash ?? spec.imageUrl, 'a thumbnail (imageHash or imageUrl)')
      const videoId = await ownVideo(account, spec.videoId!)
      return {
        object_story_spec: story({
          video_data: drop({ video_id: videoId, message: spec.message, title: spec.headline, link_description: spec.description, ...(spec.imageHash ? { image_hash: spec.imageHash } : { image_url: spec.imageUrl }), call_to_action: cta(spec.callToAction ?? (spec.link ? 'LEARN_MORE' : null), spec.link) }),
        }),
      }
    }
    case 'carousel':
      need(spec.link, 'link'); need(spec.cards, 'cards (2 to 10)')
      if (spec.cards!.length < 2) throw new MetaLiveRefusal('A carousel preview needs 2 to 10 cards.')
      for (const c of spec.cards!) need(c.imageHash ?? c.imageUrl, 'an image on every card (imageHash or imageUrl)')
      return {
        object_story_spec: story({
          link_data: drop({
            link: spec.link, message: spec.message,
            child_attachments: spec.cards!.map((c) => drop({ link: c.link, name: c.headline, description: c.description, ...picture(c.imageHash, c.imageUrl), call_to_action: cta(spec.callToAction, c.link) })),
            call_to_action: cta(spec.callToAction, spec.link),
          }),
        }),
      }
    case 'page-post':
      need(spec.postId, 'postId (a post of the chosen Page)')
      return { object_story_id: pagePostId(pageId, spec.postId!) }
    case 'instagram-post': {
      need(spec.instagramMediaId, 'instagramMediaId (a media of the chosen Instagram account)')
      const { mediaId } = await ownMedia(account, spec.instagramMediaId!)
      return drop({ object_id: pageId, instagram_user_id: instagramOf(account), source_instagram_media_id: mediaId, call_to_action: cta(spec.callToAction, spec.link) })
    }
    case 'multi-language': {
      need(spec.languages, 'languages (2 to 10, exactly one isDefault)')
      const langs = spec.languages!
      if (langs.length < 2 || langs.filter((l) => l.isDefault).length !== 1) throw new MetaLiveRefusal('A multi-language preview needs 2 to 10 languages, exactly one of them isDefault.')
      need(spec.imageHash ?? spec.imageUrl ?? spec.videoId, 'one imageHash, imageUrl or videoId')
      const videoId = spec.videoId ? await ownVideo(account, spec.videoId) : null
      if (langs.some((l) => l.label === VIDEO_LABEL || l.label === IMAGE_LABEL)) throw new MetaLiveRefusal(`"${VIDEO_LABEL}" and "${IMAGE_LABEL}" are the media's own labels: name the language another way.`)
      const label = (l: PreviewLanguage) => [{ name: l.label }]
      return {
        object_story_spec: story({}),
        asset_feed_spec: drop({
          ad_formats: [videoId ? 'SINGLE_VIDEO' : 'SINGLE_IMAGE'],
          // Round 3 N1 — the image labelled like the video (Meta's table asks image_label for SINGLE_IMAGE; its example omits it).
          images: videoId ? undefined : [{ ...(spec.imageHash ? { hash: spec.imageHash } : { url: spec.imageUrl }), adlabels: [{ name: IMAGE_LABEL }] }],
          // Review B6 — SINGLE_VIDEO needs the video labelled and each rule's video_label (one video for every language).
          videos: videoId ? [drop({ video_id: videoId, adlabels: [{ name: VIDEO_LABEL }], ...(spec.imageHash ? { thumbnail_hash: spec.imageHash } : spec.imageUrl ? { thumbnail_url: spec.imageUrl } : {}) })] : undefined,
          bodies: langs.map((l) => ({ text: l.message, adlabels: label(l) })),
          titles: langs.map((l) => ({ text: l.headline, adlabels: label(l) })),
          descriptions: langs.map((l) => ({ text: l.description?.trim() ? l.description : ' ', adlabels: label(l) })),
          link_urls: langs.map((l) => ({ website_url: l.link, adlabels: label(l) })),
          call_to_action_types: [spec.callToAction ?? 'SHOP_NOW'],
          asset_customization_rules: langs.map((l) => drop({
            customization_spec: { locales: l.locales }, is_default: l.isDefault ? true : undefined,
            body_label: { name: l.label }, title_label: { name: l.label }, description_label: { name: l.label }, link_url_label: { name: l.label },
            video_label: videoId ? { name: VIDEO_LABEL } : undefined,
            image_label: videoId ? undefined : { name: IMAGE_LABEL },
          })),
        }),
      }
    }
  }
}

/** The one video's label in a multi-language spec (asset_feed_spec videos[].adlabels and each rule's video_label). */
const VIDEO_LABEL = 'nexus_video'
/** The one image's label in a multi-language image spec (images[].adlabels and each rule's image_label). */
const IMAGE_LABEL = 'nexus_image'

/** The link inside Meta's iframe (`src="…"`), with Meta's `&amp;` read back. */
export function linkOfIframe(iframe: string | null): string | null {
  const src = iframe ? /src=["']([^"']+)["']/.exec(iframe)?.[1] ?? null : null
  return src ? src.replace(/&amp;/g, '&') : null
}

/** CR-403 — each Advantage+ feature Meta previewed: its status (eligible, pending, ineligible) and its own preview link. */
function featuresOf(spec: unknown) {
  const s = obj(spec)
  if (!s) return null
  return Object.fromEntries(Object.entries(s).map(([feature, value]) => [feature, (Array.isArray(value) ? value : [value]).map((v) => ({ status: text(obj(v)?.status), link: linkOfIframe(text(obj(v)?.body)) }))]))
}

function previewsOf(body: unknown) {
  return rowsOf(body).map((d) => {
    const iframe = text(d.body)
    return { link: linkOfIframe(iframe), iframe, features: featuresOf(d.transformation_spec) }
  })
}

/** Previews of an ad, a creative, an unsaved spec (the chosen assets only), or an Instant Experience; or an ad's share link. */
export async function livePreview(input: PreviewInput) {
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId, adAccountId } = account
  if (input.view === 'share-link') {
    if (!input.adId) throw new MetaLiveRefusal('Name the ad (adId).')
    const adId = await objectInAccount(account, input.adId, 'ad', 'preview.adCheck')
    const read = await metaReadOne({ connectionId }, { operation: 'preview.shareLink', path: adId, query: { fields: 'id,account_id,preview_shareable_link' } })
    const body = read.body as Row
    if (idText(body.account_id) !== adAccountId) throw new MetaLiveRefusal('That ad does not belong to the ad account this business chose, so it is not read.')
    return { adId, shareLink: text(body.preview_shareable_link), note: `Meta does not say who can open this link: treat it as shareable outside the business. ${PREVIEW_PUBLIC}` }
  }
  if (input.view === 'instant-experience') {
    if (!input.canvasId) throw new MetaLiveRefusal('Name the Instant Experience (canvasId, from meta-instant-experiences).')
    const canvasId = await ownedByPage(account, input.canvasId, 'Instant Experience', 'preview.canvasOwnerCheck')
    // The instant-experiences guide's own call: no parameters; Meta answers data[{ body: <iframe> }].
    const read = await onPage(() => metaReadOne({ connectionId }, { operation: 'preview.canvas', path: `${canvasId}/preview` }))
    return { canvasId, previews: previewsOf(read.body), note: PREVIEW_PUBLIC }
  }
  const formats = input.adFormats?.length ? input.adFormats : ['MOBILE_FEED_STANDARD']
  const options: Record<string, MetaQueryValue> = {}
  if (input.creativeFeature) options.creative_feature = input.creativeFeature
  if (input.assetLabel) options.dynamic_asset_label = input.assetLabel
  // Review A7 — product item ids are the caller's, unchecked: Meta renders them only with the creative's own catalog, and
  // the catalog steps (12/13) add the check that each item is in the business's chosen catalog.
  if (input.productItemIds?.length) options.product_item_ids = input.productItemIds
  if (input.language || input.country) options.dynamic_customization = drop({ language: input.language, country: input.country })
  let path: string
  let subject: Row
  if (input.view === 'ad' || input.view === 'creative') {
    const id = input.view === 'ad' ? input.adId : input.creativeId
    if (!id) throw new MetaLiveRefusal(input.view === 'ad' ? 'Name the ad (adId).' : 'Name the creative (creativeId).')
    const own = await objectInAccount(account, id, input.view, `preview.${input.view}Check`)
    path = `${own}/previews`
    subject = input.view === 'ad' ? { adId: own } : { creativeId: own }
  } else {
    if (!input.spec) throw new MetaLiveRefusal('Describe the creative (spec: kind and its parts).')
    options.creative = await previewSpec(account, input.spec)
    // The spec travels in the URL of a GET: keep it well inside what a URL carries.
    if (JSON.stringify(options.creative).length > MAX_SPEC_CHARS) throw new MetaLiveRefusal(`That spec is too long to preview in one read (at most ${MAX_SPEC_CHARS} characters of Meta's spec): shorten the texts or preview fewer languages.`)
    path = `${act(adAccountId)}/generatepreviews`
    subject = { spec: input.spec.kind }
  }
  // One call per placement (Meta answers one ad_format per call); a format Meta cannot render says so on its own.
  const previews = []
  for (const adFormat of formats) {
    const read = await part(() => metaReadOne({ connectionId }, { operation: `preview.${input.view}`, path, query: { ...options, ad_format: adFormat } }))
    if (read.value) {
      const rendered = previewsOf(read.value.body)
      previews.push({
        adFormat, link: rendered[0]?.link ?? null, iframe: rendered[0]?.iframe ?? null,
        ...(input.creativeFeature ? {
          features: rendered[0]?.features ?? null,
          featureNote: rendered[0]?.features ? null : `Meta sent no preview of ${input.creativeFeature}: the ad is not eligible for it, and Meta will not apply it (pending means ask again).`,
        } : {}),
      })
    } else previews.push({ adFormat, link: null, notRendered: read.notRead })
  }
  return {
    ...subject, previews,
    note: `${PREVIEW_PUBLIC} Only some creative and placement pairs render (Meta error 2606: "Unable to display a preview"); a page-post ad renders on RIGHT_COLUMN_STANDARD, DESKTOP_FEED_STANDARD, MOBILE_FEED_STANDARD and INSTAGRAM_STANDARD (and INSTAGRAM_STORY for a saved creative); FACEBOOK_STORY_MOBILE takes a single image or video only.`,
  }
}

// ── meta-instant-experiences ─────────────────────────────────────────────────────────────────────────────────────

export const IX_VIEWS = ['list', 'one', 'elements', 'template'] as const
export type IxView = typeof IX_VIEWS[number]
/** The template ids the instant-experiences guide names ("AR Experience" is Ads Manager only). */
export const IX_TEMPLATES = {
  'get-new-customers': '133471657203838',
  'showcase-your-business': '1063217037112304',
  'sell-products-without-catalog': '424787857903852',
  'sell-products-lifestyle': '1369752616394017',
  'sell-products-grid': '1932289657009030',
} as const
export type IxTemplate = keyof typeof IX_TEMPLATES

export const IX_FIELDS = {
  // Never last_editor (a person).
  Canvas: 'id,name,is_published,is_hidden,canvas_link,update_time,background_color',
  CanvasDetail: 'id,name,is_published,is_hidden,canvas_link,update_time,background_color,body_elements',
  /** SDK canvas.py only (the guide reads the fields above): asked, and dropped when refused. */
  CanvasMore: 'collection_hero_image,collection_thumbnails,linked_documents,unused_body_elements,store_url,source_template',
  /** CanvasBodyElement has one field (SDK canvasbodyelement.py). */
  Element: 'element',
} as const

export interface IxInput {
  connectionId?: string | null
  view: IxView
  canvasId?: string | null
  template?: IxTemplate | null
  published?: boolean
  hidden?: boolean
  maxRows?: number
}

/** One view of the chosen Page's Instant Experiences. */
export async function liveInstantExperiences(input: IxInput) {
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId } = account
  const maxRows = clampRows(input.maxRows, 50)
  if (input.view === 'template') {
    if (!input.template) throw new MetaLiveRefusal(`Name the template (${Object.keys(IX_TEMPLATES).join(', ')}).`)
    const templateId = IX_TEMPLATES[input.template]
    const doc = await onPage(() => metaReadOne({ connectionId }, { operation: 'ix.template', path: templateId, query: { fields: 'id,document' } }))
    const documentId = idText(obj((doc.body as Row).document)?.id)
    if (!documentId || !/^\d{1,25}$/.test(documentId)) throw new MetaLiveRefusal('Meta answered the template without its document, so its parts cannot be read.')
    const parts = await onPage(() => metaReadOne({ connectionId }, { operation: 'ix.templateDocument', path: documentId, query: { fields: 'id,body_elements' } }))
    return { template: input.template, templateId, document: tidy(obj((doc.body as Row).document)), parts: tidy((parts.body as Row).body_elements ?? []), note: 'The parts this template takes, in order (Meta\'s template; the layout is fixed). Making one is a change tool (a later Nexus step).' }
  }
  const pageId = pageOf(account)
  switch (input.view) {
    case 'list': {
      const query: Record<string, MetaQueryValue> = { fields: IX_FIELDS.Canvas }
      if (typeof input.published === 'boolean') query.is_published = input.published
      if (typeof input.hidden === 'boolean') query.is_hidden = input.hidden
      const read = await onPage(() => listPaged(connectionId, 'ix.canvases', `${pageId}/canvases`, query, maxRows))
      return { pageId, items: read.rows.map((r) => tidy(r)), more: read.more, note: 'An unpublished one can still be changed (and may be left behind by an unfinished builder); a published one cannot. meta-ad-preview view instant-experience shows one.' }
    }
    case 'one': {
      if (!input.canvasId) throw new MetaLiveRefusal('Name the Instant Experience (canvasId, from view list).')
      const canvasId = await ownedByPage(account, input.canvasId, 'Instant Experience', 'ix.canvasOwnerCheck')
      const read = await onPage(() => oneWithFallback(connectionId, 'ix.canvas', canvasId, IX_FIELDS.CanvasDetail, IX_FIELDS.CanvasMore))
      return { pageId, canvas: tidy(read.body), fieldsNote: read.note }
    }
    case 'elements': {
      const read = await onPage(() => listPaged(connectionId, 'ix.elements', `${pageId}/canvas_elements`, { fields: IX_FIELDS.Element }, maxRows))
      return { pageId, items: read.rows.map((r) => tidy(r)), more: read.more, note: 'The parts (photos, videos, buttons, text, product sets…) made on the Page for Instant Experiences.' }
    }
  }
  throw new MetaLiveRefusal(`Unknown view "${input.view}".`)
}

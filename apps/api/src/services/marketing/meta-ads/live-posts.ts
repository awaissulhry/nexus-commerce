/**
 * Meta ads step 24 (2026-10-25) — the live reads the post tools stand on (create-meta-page-post, set-meta-page-post,
 * remove-meta-page-post, create-meta-instagram-post), through the gateway (GET only, the business's system-user token).
 * Nothing here stores anything. They reuse step 10's own checks (live-media.ts: pagePostId, stillOnPage, onPage, ownMedia,
 * liveInstagram) and never another path:
 *   - the chosen Page, Instagram account and ad account of the business (live.ts metaChosenAccount);
 *   - one post of the chosen Page as an edit or a delete stands on it: its text, hidden and published state, schedule,
 *     timeline visibility, who wrote it, its paid-partner sponsors (post/sponsor_tags), and whether Nexus made it
 *     (create-meta-page-post's change records);
 *   - one media of the chosen Instagram account (step 10's ownMedia: Meta's owner, else its username) and whether Nexus
 *     published it; one container's publishing status (ig-container `status_code`, `status`) — a container has no owner Meta
 *     names, so only containers Nexus made are read; the account's publishing limit (step 10's quota view);
 *   - the chosen ad account's creatives that show a post or a media (its first 500, act_<id>/adcreatives: object_story_id,
 *     effective_object_story_id, effective_instagram_media_id, source_instagram_media_id) — a post an ad shows is never
 *     deleted, and an edit of one says the ads show the new text.
 * Checked 2026-10-25: docs/graph-api/reference/page-post (fields message, is_hidden, is_published, scheduled_publish_time,
 * timeline_visibility, permalink_url, from), reference/instagram-media.md, ig-container.md (status_code, status),
 * ig-user/content_publishing_limit.md (config {quota_total, quota_duration}, quota_usage), SDK adcreative.py fields.
 */
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { metaChosenAccount, MetaLiveRefusal } from './live.js'
import { listPaged } from './paging.js'
import { liveInstagram, onPage, ownMedia, pagePostId, stillOnPage } from './live-media.js'
import { discover } from './live-partners.js'
import { metaPagePostVideoOf, metaPostNexusMade } from '../../gateway/account.js'
import { metaVideoPostIdOf } from '../../gateway/meta-post-rules.js'

type Row = Record<string, unknown>
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const idText = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const boolOf = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
/** A Meta time (Unix seconds, or ISO with an offset) in Unix seconds, or null. */
const unixOf = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^\d{9,11}$/.test(v)) return Number(v)
  const ms = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

const NO_PAGE = 'No Facebook Page is chosen for this business yet. A person chooses it in Settings › Channels › Meta, or Claude asks for it with set-meta-connection (a person approves it).'
const NO_INSTAGRAM = 'No Instagram account is chosen for this business yet. A person chooses it in Settings › Channels › Meta, or Claude asks for it with set-meta-connection (a person approves it).'

export interface PostAccount { connectionId: string; adAccountId: string; pageId: string | null; instagramId: string | null }

/** The business's chosen Page, Instagram account and ad account (refused in words when `need` is not chosen). */
export async function livePostAccount(connectionId: string, need: 'page' | 'instagram' | null = null): Promise<PostAccount> {
  const chosen = await metaChosenAccount(connectionId)
  if (need === 'page' && !chosen.pageId) throw new MetaLiveRefusal(NO_PAGE)
  if (need === 'instagram' && !chosen.instagramId) throw new MetaLiveRefusal(NO_INSTAGRAM)
  return { connectionId: chosen.connectionId, adAccountId: chosen.adAccountId, pageId: chosen.pageId, instagramId: chosen.instagramId }
}

/** The fields a post change stands on (the Page Post reference's read fields). */
export const PAGE_POST_STATE_FIELDS = 'id,message,is_hidden,is_published,scheduled_publish_time,timeline_visibility,permalink_url,from{id}'

export interface PagePostState {
  pageId: string
  postId: string
  message: string | null
  hidden: boolean | null
  published: boolean | null
  /** Unix seconds of a scheduled post, else null. */
  scheduledAt: number | null
  timelineVisibility: string | null
  permalink: string | null
  /** Written by the chosen Page itself (a visitor's post is not the Page's to change). */
  byThePage: boolean
  /** The brands tagged as paid partners (post/sponsor_tags), when asked; null when not asked or not readable. */
  sponsorPageIds: string[] | null
  /** Made by Nexus's create-meta-page-post (its change records). */
  nexusMade: boolean
  /** A video post Nexus made: its video (its record's, or the one the caller named that Meta ties to this post), else null. */
  videoId: string | null
}

/**
 * One post of the chosen Page as a change stands on it. Throws MetaLiveRefusal in words (another Page's post, none).
 * `videoId`: the video of a video post Nexus made whose record does not name the post yet (remove-meta-page-post's videoId).
 */
export async function livePagePost(connectionId: string, postId: string, opts: { sponsors?: boolean; videoId?: string } = {}): Promise<PagePostState> {
  const account = await livePostAccount(connectionId, 'page')
  const pageId = account.pageId!
  const id = pagePostId(pageId, postId)
  const read = await onPage(() => metaReadOne({ connectionId }, { operation: 'posts.changeState', path: id, query: { fields: PAGE_POST_STATE_FIELDS } }))
  const body = read.body as Row
  stillOnPage(pageId, body)
  let sponsorPageIds: string[] | null = null
  if (opts.sponsors) {
    try {
      const tags = await listPaged(connectionId, 'posts.changeSponsors', `${id}/sponsor_tags`, { fields: 'id' }, 100)
      sponsorPageIds = tags.more ? null : tags.rows.map((r) => idText(r.id)).filter((v): v is string => !!v)
    } catch (err) {
      if (!(err instanceof MetaReadError)) throw err
      sponsorPageIds = null
    }
  }
  return {
    pageId, postId: id,
    message: text(body.message),
    hidden: boolOf(body.is_hidden),
    published: boolOf(body.is_published),
    scheduledAt: unixOf(body.scheduled_publish_time),
    timelineVisibility: text(body.timeline_visibility),
    permalink: text(body.permalink_url),
    byThePage: idText(obj(body.from)?.id) === pageId,
    sponsorPageIds,
    ...(await pagePostMadeBy(connectionId, id, pageId, opts.videoId)),
  }
}

/**
 * Did Nexus make this post of the chosen Page, and with which video? Its record names the post (and a video post's video,
 * re-review N1) — or (review B-F2) only the video the caller names, whose post Meta names later: then a record names that
 * video and its post_id, read now (a video the chosen Page posted), must be this post. The same rule as the gateway's owner
 * check (meta-post-owner.ts); no other video is read (re-review N4). A read of that video that fails says so in its words.
 */
async function pagePostMadeBy(connectionId: string, postId: string, pageId: string, videoId?: string): Promise<{ nexusMade: boolean; videoId: string | null }> {
  if (await metaPostNexusMade('pagepost', postId, pageId)) return { nexusMade: true, videoId: await metaPagePostVideoOf(postId, pageId) }
  if (videoId && /^\d{1,25}$/.test(videoId) && await metaPostNexusMade('pagevideo', videoId, pageId)
    && await liveVideoPostOf(connectionId, videoId, pageId) === postId) return { nexusMade: true, videoId }
  return { nexusMade: false, videoId: null }
}

/** The post of a video the chosen Page posted (`GET /<video>?fields=id,post_id,from{id}`), or null when Meta names none yet. */
async function liveVideoPostOf(connectionId: string, videoId: string, pageId: string): Promise<string | null> {
  const read = await onPage(() => metaReadOne({ connectionId }, { operation: 'posts.videoPost', path: videoId, query: { fields: 'id,post_id,from{id}' } }))
  const body = read.body as Row
  if (idText(body.id) !== videoId || idText(obj(body.from)?.id) !== pageId) throw new MetaLiveRefusal(`Video ${videoId} is not one the Facebook Page this business chose posted.`)
  return metaVideoPostIdOf(body.post_id, pageId)
}

/** Review B-F2 — a video post of the chosen Page by its video id: its post, once Meta names it (null before). */
export async function liveVideoPost(connectionId: string, videoId: string): Promise<{ pageId: string; videoId: string; postId: string | null }> {
  const account = await livePostAccount(connectionId, 'page')
  if (!/^\d{1,25}$/.test(videoId)) throw new MetaLiveRefusal(`"${videoId}" is not a Meta video id (digits).`)
  return { pageId: account.pageId!, videoId, postId: await liveVideoPostOf(connectionId, videoId, account.pageId!) }
}

export interface IgMediaState { instagramId: string; mediaId: string; productType: string | null; nexusMade: boolean }

/** One media of the chosen Instagram account (step 10's owner rule) and whether Nexus published it. */
export async function liveIgMedia(connectionId: string, mediaId: string): Promise<IgMediaState> {
  const chosen = await metaChosenAccount(connectionId)
  if (!chosen.instagramId) throw new MetaLiveRefusal(NO_INSTAGRAM)
  const own = await ownMedia(chosen, mediaId)
  return { instagramId: chosen.instagramId, mediaId: own.mediaId, productType: own.productType, nexusMade: await metaPostNexusMade('igmedia', own.mediaId, chosen.instagramId) }
}

export interface IgContainerState { containerId: string; statusCode: string | null; status: string | null }

/**
 * One container's publishing status (ig-container: status_code EXPIRED | ERROR | FINISHED | IN_PROGRESS | PUBLISHED; status
 * the error subcode). Null when Meta answers no status to the business's system-user token (its reference names a user
 * token): the publish's own answer then decides. Throws a MetaReadError for a throttle, a lost token or no answer.
 */
export async function liveIgContainer(connectionId: string, containerId: string): Promise<IgContainerState | null> {
  try {
    const read = await metaReadOne({ connectionId }, { operation: 'posts.igContainerStatus', path: containerId, query: { fields: 'id,status_code,status' } })
    const body = read.body as Row
    if (idText(body.id) !== containerId) return null
    return { containerId, statusCode: text(body.status_code), status: text(body.status) }
  } catch (err) {
    if (err instanceof MetaReadError && err.failure.origin === 'meta' && !err.failure.throttled && !err.failure.transient && !(err.failure.authLost && !/page access token|user access token/i.test(err.failure.sentence))) return null
    throw err
  }
}

/** Was this container made by an earlier create-meta-instagram-post of this business, on the chosen Instagram account? */
export async function igContainerNexusMade(connectionId: string, containerId: string): Promise<{ instagramId: string; made: boolean }> {
  const account = await livePostAccount(connectionId, 'instagram')
  return { instagramId: account.instagramId!, made: await metaPostNexusMade('igcontainer', containerId, account.instagramId!) }
}

/** The chosen Instagram account's publishing limit now (step 10's quota view), or null when Meta did not answer it. */
export async function liveIgQuota(connectionId: string): Promise<{ usage: number; total: number; durationSec: number | null } | null> {
  try {
    const read = await liveInstagram({ connectionId, view: 'quota' }) as { quota?: Array<Record<string, unknown>> }
    const row = read.quota?.[0]
    const config = obj(row?.config)
    const usage = typeof row?.quotaUsage === 'number' ? row.quotaUsage : null
    const total = typeof config?.quotaTotal === 'number' ? config.quotaTotal : null
    if (usage === null || total === null) return null
    return { usage, total, durationSec: typeof config?.quotaDuration === 'number' ? config.quotaDuration : null }
  } catch (err) {
    if (err instanceof MetaReadError || err instanceof MetaLiveRefusal) return null
    throw err
  }
}

/**
 * Is this Instagram username an account another Nexus business chose? Step 16's Business Discovery read on the chosen
 * account (professional accounts only — every Nexus business's account is one). ONLY Meta's documented "user not found"
 * answer (code 110, subcode 2207013: a personal or unknown account) means it is none; every other answer — an empty one,
 * a refusal, "object does not exist or cannot be loaded" (100/33: the system user cannot load the chosen account), a
 * throttle — is thrown, so the tool refuses in words and nothing is invited or tagged unchecked (fail closed).
 */
export async function igUsernameTaken(connectionId: string, username: string): Promise<boolean> {
  const chosen = await metaChosenAccount(connectionId)
  try {
    return (await discover(chosen, username, 'id', 'posts.instagramAccountCheck')).taken
  } catch (err) {
    if (err instanceof MetaReadError && err.failure.origin === 'meta' && err.failure.code === META_IG_USER_NOT_FOUND) return false
    throw err
  }
}
/** Meta's Business Discovery answer for a username it cannot find (code 110, subcode 2207013). */
export const META_IG_USER_NOT_FOUND = '110/2207013'

/** The creative fields that name the post or media a creative shows. */
export const CREATIVE_POST_FIELDS = 'id,object_story_id,effective_object_story_id,effective_instagram_media_id,source_instagram_media_id,video_id'

/**
 * The chosen ad account's creatives that show this Facebook post, its video, or this Instagram media (its first 500 creatives).
 * `complete`: every creative was read (else a post may be used by one Nexus did not read).
 */
export async function liveCreativesUsing(account: { connectionId: string; adAccountId: string }, target: { postId?: string; mediaId?: string; videoId?: string }): Promise<{ creativeIds: string[]; complete: boolean }> {
  const read = await listPaged(account.connectionId, 'posts.creativesUsing', `act_${account.adAccountId}/adcreatives`, { fields: CREATIVE_POST_FIELDS }, 500)
  const uses = (r: Row) => (target.postId ? [r.object_story_id, r.effective_object_story_id].some((v) => idText(v) === target.postId) : false)
    || (target.mediaId ? [r.effective_instagram_media_id, r.source_instagram_media_id].some((v) => idText(v) === target.mediaId) : false)
    // Review B-F2 — a creative that shows a video post's video itself.
    || (target.videoId ? idText(r.video_id) === target.videoId : false)
  return { creativeIds: read.rows.filter(uses).map((r) => idText(r.id)).filter((v): v is string => !!v), complete: !read.more }
}


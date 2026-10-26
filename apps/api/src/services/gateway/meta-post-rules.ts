/**
 * Meta step 24 (2026-10-25) — the write allow-list entries of create-meta-page-post, set-meta-page-post,
 * remove-meta-page-post and create-meta-instagram-post: ORGANIC posts of the business's CHOSEN Facebook Page and its
 * CHOSEN Instagram account (master rows MD-107 … MD-115, MD-133, MD-136, MD-140, EN-047, EN-050, CR-256, CR-259, CR-367,
 * OT-037). EXACT keys per kind of object, every value judged — enums by list, booleans as `true` / `false`, JSON values in
 * ONE spelling (`JSON.stringify(JSON.parse(v)) === v`) with every key at every depth on a list, text only where a person
 * types it, links https to a public host only. Every rule here is `auth: 'page'` (step 36's Page token mode, the ONE mode):
 * it goes with the business's CHOSEN Facebook Page's own token, which the gateway reads for that one call
 * (meta-page-token.ts), and only for an object the gateway confirmed is that Page, a post of it, the chosen Instagram
 * account, or a post / media Nexus itself made there (meta-post-owner.ts), with every id inside the body checked there too.
 * A post is never public by an omission: `published` is a REQUIRED key of every Page post Nexus makes.
 *
 * Checked 2026-10-25 (curl ≥ 3.5 s apart; developers.facebook.com, and Meta's Python Business SDK main,
 * facebook_business/adobjects/page.py, pagepost.py, iguser.py, igmedia.py, igupcomingevent.py, advideo.py):
 *   - docs/graph-api/reference/page/feed (v26.0), Publishing: "A Page access token requested by a user who can perform the
 *     CREATE_CONTENT task", pages_manage_posts, pages_read_engagement, pages_show_list; "If the viewer or app cannot see the
 *     link URL, the post will fail"; fields actions, backdated_time, child_attachments ("min 2 and max 5 objects. If you
 *     set multi_share_optimized to true, you can upload a max of 10 objects but Facebook will display the top 5") with
 *     description, image_hash, link (required), name, picture ("one of picture and image_hash must be specified"),
 *     feed_targeting, link (+ description, name, picture, thumbnail), message ("may include Page mentions, @[page-id]"),
 *     multi_share_end_card (default true), multi_share_optimized ("when the post is used in an ad, Facebook will
 *     automatically select the order of links in child_attachments"; default TRUE — a silent automation, so Nexus always
 *     sends it, false unless asked), object_attachment, place ("Page ID of a place associated with this post": sent, the place checked as no other Nexus
 *     business's Page), published ("Unpublished posts can be used in ads"),
 *     scheduled_publish_time ("between 10 minutes and 75 days"; the Pages API guide says 30 days: Nexus holds 30), tags
 *     (people's ids — never sent), targeting {age_min 13|15|18|21|25, geo_locations}; call_to_action {type, value{link}} with
 *     the types BOOK_TRAVEL … WATCH_VIDEO (GET_DIRECTIONS: "you must specify the coordinates in the link field"); custom
 *     link images: "The link must be owned by the posting Page. To verify link ownership, check the
 *     ownership_permissions{can_customize_link_posts} field on the URL node. You must call this endpoint before posting new
 *     links. Without this step, custom link Page posts will not work for un-scraped links" (master MD-140: the URL node is
 *     documented on v26 as GET /?id={url} — v26 removed only GET /?ids= — but that is a read of Graph's ROOT, the batch
 *     endpoint, which this gateway refuses on purpose; so Nexus makes no such read, the preview says the shop's domain must be
 *     verified in Business Manager, and Meta's answer to the post says when the Page does not own the link; LIVE-PROBES
 *     MD-140). A link call to action: "This link should be the same as the link parameter of the Page Post" (the value's
 *     link IS the post's link, review B-F7). Returns {id: "<page>_<post>"}.
 *   - docs/graph-api/reference/page/photos (v26.0): CREATE_CONTENT, pages_read_engagement, pages_manage_posts,
 *     pages_show_list; url ("a photo that is already on the internet"), published, temporary ("published must be false, and
 *     you can't set scheduled_publish_time"; "If the photo is used in a scheduled post, temporary=true must be used"),
 *     alt_text_custom, unpublished_content_type; "If you do not publish these photos within 24 hours, we delete them";
 *     "Publishing a multi-photo post": POST /page-id/feed with attached_media [{"media_fbid": …}] — "When the photos are part
 *     of a scheduled post, the published, scheduled_publish_time, and unpublished_content_type parameters must be included"
 *     (unpublished_content_type=SCHEDULED) — an UNPUBLISHED, unscheduled photo post is documented nowhere, so it waits for
 *     LIVE-PROBES PG24-03 (META_DARK_PHOTO_POSTS_PROVEN); files "can not exceed 10MB" ("For .png files, we recommend not
 *     exceeding 1MB"; .jpeg, .bmp, .png, .gif, .tiff); returns {id, post_id}.
 *   - docs/graph-api/reference/page/videos (v26.0): "To create an unpublished video for advertising": the ADVERTISE task,
 *     pages_manage_ads, pages_show_list; to publish: CREATE_CONTENT, pages_manage_posts, pages_read_engagement,
 *     pages_show_list; file_url ("Accessible URL of a video file. Cannot be used with upload_phase"), title, description,
 *     published (default true), scheduled_publish_time ("between 10 mins and 6 months": Nexus holds 30 days),
 *     unpublished_content_type {SCHEDULED, …, ADS_POST, …}; the reference names no host, and every v26 example of POST
 *     /{page}/videos (documentation/video-api/guides/publishing, the event-ads local video post, the branded-content video)
 *     names graph-video.facebook.com — so this rule goes there (`videoHost`, pre-approved for Page videos, D3; review B-F1);
 *     its return type has id / video_id and NO post_id (the video node's post_id comes later: review B-F2; the Pages API
 *     guide also names publish_video for publishing a video); SDK page.py create_video also takes call_to_action, which the event-ads guide uses for a local video
 *     post: GET_DIRECTIONS with value.link_format VIDEO_LPP only ("Video Page posts are available only if you use the
 *     GET_DIRECTIONS call to action").
 *   - documentation/ads-commerce/marketing-api/guides/event-ads.md (Local Ads, master CR-256): an unpublished Page post for a
 *     local ad; "Unless you use the LEARN_MORE call to action, the link must match your business's Facebook Page URL";
 *     GET_DIRECTIONS {"link": "fbgeo://<lat>, <long>, \"<address>\""}; CALL_NOW {"link": "tel:+<country code><number>"}
 *     ("must start with a plus sign (+) and the country code", digits only, no premium-rate number, same country, 18+,
 *     with mobile targeting); MESSAGE_PAGE "no value is necessary".
 *   - docs/graph-api/reference/page-post (v26.0), Updating `POST /{page_post_id}`: attached_media, backdated_time,
 *     direct_share_status, is_hidden, is_pinned, is_published, message, place, privacy, scheduled_publish_time, sponsor_id,
 *     sponsor_relationship, tags, timeline_visibility {hidden, normal, forced_allow}, … ; read-after-write; errors 200, 100,
 *     210, 368, 190, 104, 80001 ("too many calls to this Page account"). Deleting `DELETE /{page_post_id}`: "Only select
 *     developers can perform this operation using the API. You can use the Business Manager to delete posts." (the Pages API
 *     guide documents the same DELETE with no such note — master MD-114: built, Meta's refusal answers; LIVE-PROBES). The
 *     guide: "An app can only update a Page post if the post was made using that app". SDK pagepost.py api_update (the same
 *     keys), api_delete.
 *   - documentation/ads-commerce/marketing-api/guides/branded-content.md, "Updating branded content" (master MD-115): POST
 *     /{page-post-id} sponsor_id (a brand's Page), direct_share_status 1 / 0 ("allow or prohibit a brand partner directly
 *     boosting a post"); "Changes to post content with a brand ID on the web or on mobile devices are not supported". No
 *     removal of a sponsor tag is documented (only "to change the sponsor … pass in a new sponsor_id"); sponsor_relationship
 *     has no documented values — never sent.
 *   - documentation/instagram-platform/content-publishing.md: with Facebook Login the token is a "Facebook Page access
 *     token" (instagram_basic, instagram_content_publish, pages_read_engagement; ads_management or ads_read with a Business
 *     Manager role); media on a public server; JPEG only; "Shopping tags are not supported" there, but the product-tagging
 *     guide documents `product_tags` on a feed image, a reel and each carousel item (step 35's Q9 hunk below, judged by
 *     meta-instagram-tags.ts); 100 API posts per 24 h (the limit
 *     reference: 50 — Nexus reads quota_total live); carousel ≤ 20 ("children — A comma separated list of up to 20 container
 *     IDs"); trial reels trial_params {graduation_strategy MANUAL | SS_PERFORMANCE}; is_ai_generated ("Setting this parameter
 *     on carousel children will result in an error"); partnership label branded_content_sponsor_ids (≤ 2 brands' Instagram
 *     user ids) and is_paid_partnership (master CR-367); container status_code EXPIRED | ERROR | FINISHED | IN_PROGRESS |
 *     PUBLISHED, "querying a container's status once per minute, for no more than 5 minutes".
 *   - instagram-graph-api/reference/ig-user/media.md (v26.0), Creating: containers expire after 24 h, 400 per 24 h; reels
 *     cannot be in carousels; stories take no stickers; keys alt_text (images only, ≤ 1000), audio_name (reels), caption
 *     (≤ 2200 characters, 30 hashtags, 20 @ tags; not on carousel items), collaborators (≤ 3 usernames; feed image, reels,
 *     carousels — not stories; master OT-037), children, cover_url (reels), image_url, is_carousel_item, location_id (a
 *     place Page; not on carousel items), media_type CAROUSEL | REELS | STORIES (a carousel's video item: VIDEO),
 *     product_tags (step 35), share_to_feed (reels), thumb_offset (videos and reels), upload_type (resumable: not used —
 *     Meta fetches the public link), user_tags [{username, x, y}] (x / y required for images), video_url, trial_params,
 *     branded_content_sponsor_ids, is_paid_partnership, is_ai_generated; poll_attachment / is_comment_prompt_used (caption
 *     add-ons) are not offered yet. The reference names a USER token; the guide a Page token for Facebook Login: Nexus uses
 *     the Page token mode (never a second mode) and Meta's refusal answers in its own words (LIVE-PROBES IG24-01).
 *   - ig-user/media_publish.md: creation_id (required) → {id, config_issue? CAPTION_NOT_ATTACHED | USER_TAGGING_FAILURE}.
 *   - reference/instagram-media.md, Deleting (master MD-136): `DELETE /<IG_MEDIA_ID>` → {success, deleted_id}; Facebook
 *     Login only; instagram_basic + instagram_manage_contents; "Non-ad posts, Stories, Reels and entire carousel albums are
 *     supported … Individually deleting media within a carousel is not supported". Updating: comment_enabled only — an
 *     Instagram post's caption or media cannot be edited by API (step 37's set-meta-comments switches comments).
 *   - instagram-api-with-facebook-login/upcoming-events.md (master CR-259): POST /<ig>/upcoming_events title, start_time
 *     (required), end_time, notification_subtypes, notification_target_time EVENT_START | EVENT_END (EVENT_END: exactly
 *     BEFORE_EVENT_2DAY, BEFORE_EVENT_1DAY, BEFORE_EVENT_1HOUR and no end_time; EVENT_START: EVENT_START and
 *     BEFORE_EVENT_1DAY and one more); instagram_basic + instagram_manage_upcoming_events; no delete is documented (SDK
 *     igupcomingevent.py has none).
 */
import type { MetaWriteBodyId, MetaWriteRule } from './meta-calls.js'
import { META_COMMENT_TEXT, META_NAME_TEXT } from './meta-write-text.js'
import { metaPublicLinkProblem } from './meta-media-rules.js'
import { metaCreativeTextProblem } from './meta-creative-rules.js'
// Step 35 (Q9) — the one Instagram product-tag judge (a leaf).
import { metaIgProductTagIds, metaIgProductTagsProblem, type MetaIgTagTarget } from './meta-instagram-tags.js'

type Params = ReadonlyMap<string, string>
type Row = Record<string, unknown>

/**
 * What only these tools name (the gateway confirms each before anything is sent; meta-post-owner.ts):
 *   postpage      the chosen Facebook Page itself, as it makes a post, an unpublished photo of a post, or a video post;
 *   pagepostedit  a post OF the chosen Page that the Page itself wrote (an edit, a publish, a hide, a sponsor);
 *   pagepostmade  a post Nexus itself made on the chosen Page (create-meta-page-post's records): the only one it deletes;
 *   postig        the chosen Instagram account itself (a media container, its publish, an upcoming event);
 *   igmediamade   an Instagram media Nexus itself published there (create-meta-instagram-post's records): the only one it deletes.
 */
export type MetaPostKind = 'postpage' | 'pagepostedit' | 'pagepostmade' | 'postig' | 'igmediamade'
/**
 * The ids inside these changes' bodies (each checked by meta-post-owner.ts):
 *   postphoto        an unpublished photo of the chosen Page a post attaches (made in the same run, else read: `from` the Page);
 *   postimagehash    an image of the chosen ad account's library by its hash (a link preview's or a carousel card's image);
 *   postsponsorpage  a brand's Facebook Page tagged as the post's paid partner (never the chosen Page, never another Nexus
 *                    business's Page);
 *   igcontainer      an Instagram media container made in the same run (a carousel's item, the one published), else one an
 *                    earlier create-meta-instagram-post of this business made (its change record);
 *   igsponsor        a brand's Instagram account tagged as paid partner (never the chosen one, never another Nexus business's);
 *   postplace        a place's Page a post is tagged with (Facebook `place`, Instagram `location_id`; never another
 *                    Nexus business's Page).
 */
export type MetaPostBodyKind = 'postphoto' | 'postimagehash' | 'postsponsorpage' | 'igcontainer' | 'igsponsor' | 'postplace'
/** Is this an id kind only a post's body names? (gateway.ts refuses them on any rule that is not a post rule.) */
const META_POST_BODY_KINDS: ReadonlySet<string> = new Set<MetaPostBodyKind>(['postphoto', 'postimagehash', 'postsponsorpage', 'igcontainer', 'igsponsor', 'postplace'])
export const isMetaPostBodyKind = (kind: string): kind is MetaPostBodyKind => META_POST_BODY_KINDS.has(kind)
/** Meta's video host: a Page's video post goes there (every v26 example of POST /<page>/videos names it; D3). */
export const META_GRAPH_VIDEO_HOST = 'graph-video.facebook.com'
/** The edges these changes post to. */
export type MetaPostEdge = 'feed' | 'photos' | 'videos' | 'media' | 'media_publish' | 'upcoming_events'

/** Nexus's caps (Meta states none for a post's text in its API pages; the Instagram ones are Meta's own). */
export const META_POST_LIMITS = {
  message: 10_000, name: 255, description: 1_000, link: 1_000, picture: 2_000, childrenMin: 2, childrenMax: 5, childrenOptimizedMax: 10,
  photos: 10, altText: 1_000, videoTitleBytes: 254, countries: 25, scheduleMinSec: 600, scheduleMaxSec: 30 * 86_400,
  caption: 2_200, hashtags: 30, mentions: 20, collaborators: 3, userTags: 20, sponsors: 2, carouselMin: 2, carouselMax: 20,
  audioName: 100, eventTitle: 255, eventMaxDays: 366, address: 200,
} as const
/** The longest body of a post rule (a message of 10,000 characters form-encoded, five cards with their text). */
export const META_POST_MAX_BODY = 200_000

/** The call-to-action types Nexus sends on a Page post (the feed reference's list, less the app and Page-likes ones). */
export const META_POST_CTA_TYPES = [
  'SHOP_NOW', 'LEARN_MORE', 'SIGN_UP', 'SUBSCRIBE', 'GET_QUOTE', 'WATCH_MORE', 'WATCH_VIDEO', 'OPEN_LINK', 'BOOK_TRAVEL', 'LISTEN_MUSIC',
  'NO_BUTTON', 'MESSAGE_PAGE', 'CALL_NOW', 'GET_DIRECTIONS',
] as const
export type MetaPostCtaType = typeof META_POST_CTA_TYPES[number]
/** The feed reference's types Nexus does not send, each with why (said in the tool). */
export const META_POST_CTA_REFUSED: Readonly<Record<string, string>> = {
  BUY_NOW: 'Meta uses BUY_NOW "only for desktop app ads for virtual goods"',
  DOWNLOAD: 'it opens an app download, and the business has no app',
  INSTALL_APP: 'it installs an app, and the business has no app',
  INSTALL_MOBILE_APP: 'it installs a mobile app, and the business has no app',
  USE_APP: 'it opens an app, and the business has no app',
  USE_MOBILE_APP: 'it opens a mobile app, and the business has no app',
  PLAY_GAME: 'it opens a game app, and the business has no app',
  LIKE_PAGE: 'Meta uses it only for ads with the Page-likes objective, and it names the Page in its value',
}
/**
 * Review B-F5 — an UNPUBLISHED, unscheduled photo post (attached_media with published=false) is not documented (the photos
 * reference documents attached photos for a published or a scheduled post, and deletes unpublished photos not "published"
 * within 24 hours). Refused until LIVE-PROBES PG24-03 shows its photos stay: THE LEADER FLIPS THIS after the probe.
 */
export const META_DARK_PHOTO_POSTS_PROVEN = false

/** The local calls to action (event-ads guide, Local Ads): the post's link must be the chosen Page's own URL. */
export const META_POST_LOCAL_CTAS: ReadonlySet<string> = new Set(['CALL_NOW', 'GET_DIRECTIONS', 'MESSAGE_PAGE'])
/** The calls to action that carry no link of their own. */
const NO_VALUE_CTAS: ReadonlySet<string> = new Set(['NO_BUTTON', 'MESSAGE_PAGE'])

/** A post's audience (targeting.age_min, the feed reference's enum). */
export const META_POST_AGE_MINS = [13, 15, 18, 21, 25] as const
/** The Instagram container media types Nexus sends (a carousel's video item is VIDEO). */
export const META_IG_MEDIA_TYPES = ['CAROUSEL', 'REELS', 'STORIES', 'VIDEO'] as const
/** A trial reel's graduation strategies (content-publishing guide). */
export const META_IG_TRIAL_STRATEGIES = ['MANUAL', 'SS_PERFORMANCE'] as const
/** An upcoming event's notification times (upcoming-events guide; SDK igupcomingevent.py also names RESCHEDULED, Meta's own). */
export const META_IG_EVENT_SUBTYPES = [
  'AFTER_EVENT_1DAY', 'AFTER_EVENT_2DAY', 'AFTER_EVENT_3DAY', 'AFTER_EVENT_4DAY', 'AFTER_EVENT_5DAY', 'AFTER_EVENT_6DAY', 'AFTER_EVENT_7DAY',
  'BEFORE_EVENT_15MIN', 'BEFORE_EVENT_1DAY', 'BEFORE_EVENT_1HOUR', 'BEFORE_EVENT_2DAY', 'EVENT_START',
] as const
export const META_IG_EVENT_END_SUBTYPES = ['BEFORE_EVENT_2DAY', 'BEFORE_EVENT_1DAY', 'BEFORE_EVENT_1HOUR'] as const

const DIGITS = /^[1-9]\d{0,24}$/
const isObj = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const bool = (v: string | undefined) => v === 'true' || v === 'false'

/** A JSON value in Nexus's ONE spelling (the string judged is the string sent), or null. */
function json(value: string | undefined): unknown {
  if (value === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return JSON.stringify(parsed) === value ? parsed : null
  } catch { return null }
}

/** Why a link Meta fetches or shows is refused (https, a public host by its name, no key or sign-in), or null. */
const linkProblem = (value: unknown, where: string, max: number = META_POST_LIMITS.link): string | null => (typeof value === 'string' ? metaPublicLinkProblem(value, where, max) : `${where} is an https link`)

/** A post's text: 1 to `max` characters, a visible one, no control or format character (line breaks allowed in `lines`). */
export function metaPostTextProblem(value: unknown, max: number, where: string, lines = false): string | null {
  if (typeof value !== 'string') return `${where} is text`
  const problem = metaCreativeTextProblem(value, max, where, { lines })
  if (problem) return problem
  // Review-ready rule — a Page is never tagged from Nexus (`@[<page id>]` mentions are tags Meta reviews; write the name).
  if (/@\[\d/.test(value)) return `${where} tags no Page (@[<page id>]): Nexus does not tag Pages or people in a post — write the name instead`
  return null
}

/** Unix seconds 10 minutes to 30 days ahead of now (Meta: 10 minutes to 30 days in the Pages API guide). */
export function metaPostScheduleProblem(value: string | undefined, now: number = Date.now()): string | null {
  if (!/^\d{9,11}$/.test(value ?? '')) return 'scheduled_publish_time is a time in Unix seconds'
  const ahead = Number(value) - Math.floor(now / 1000)
  if (ahead < META_POST_LIMITS.scheduleMinSec) return 'scheduled_publish_time is at least 10 minutes ahead (Meta\'s limit)'
  if (ahead > META_POST_LIMITS.scheduleMaxSec) return 'scheduled_publish_time is at most 30 days ahead (Meta\'s Pages API guide)'
  return null
}

/**
 * Review B-F2 — the post of a Page video as Meta's video node names it (`post_id`, SDK advideo.py): `<page>_<post>` as
 * given, or the post's own digits on the Page; null for anything else (another Page's post, no post yet).
 */
export function metaVideoPostIdOf(value: unknown, pageId: string): string | null {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
  if (/^\d{1,25}_\d{1,25}$/.test(text)) return text.startsWith(`${pageId}_`) ? text : null
  return /^\d{1,25}$/.test(text) ? `${pageId}_${text}` : null
}

/** An image hash of an ad account's library (as Meta writes it). */
export const META_IMAGE_HASH = /^[A-Za-z0-9]{1,64}$/

/** `fbgeo://<lat>, <long>, "<address>"` (event-ads guide), with a real latitude and longitude and a plain address. */
export const META_FBGEO = /^fbgeo:\/\/(-?\d{1,3}(?:\.\d{1,8})?), (-?\d{1,3}(?:\.\d{1,8})?), "([^"\\\u0000-\u001f]{1,200})"$/u
/** `tel:+<country code><number>`: a plus, then digits only (E.164: at most 15). */
export const META_TEL = /^tel:\+[1-9]\d{6,14}$/

function fbgeoProblem(value: unknown, where: string): string | null {
  const m = typeof value === 'string' ? META_FBGEO.exec(value) : null
  if (!m) return `${where} is fbgeo://<latitude>, <longitude>, "<address>" (Meta's GET_DIRECTIONS link)`
  const lat = Number(m[1])
  const long = Number(m[2])
  if (Math.abs(lat) > 90 || Math.abs(long) > 180) return `${where} names a real latitude (−90 … 90) and longitude (−180 … 180)`
  return META_NAME_TEXT.test(m[3]) && m[3].trim() ? null : `${where}: the address is printable text`
}

/**
 * A post's call_to_action, as Nexus writes it: {type} for NO_BUTTON and MESSAGE_PAGE ("no value is necessary"),
 * {type, value: {link: tel:+…}} for CALL_NOW, {type, value: {link: fbgeo://…}} for GET_DIRECTIONS (`video`: and
 * link_format VIDEO_LPP, the only one a video post takes), {type, value: {link: https://…}} for every other type.
 */
export function metaPostCtaProblem(raw: string | undefined, where = 'call_to_action', opts: { video?: boolean } = {}): string | null {
  const cta = json(raw)
  if (!isObj(cta)) return `${where} is a JSON object, as Nexus writes it`
  const keys = Object.keys(cta)
  if (keys.some((k) => k !== 'type' && k !== 'value')) return `${where} has only type and value`
  const type = cta.type
  if (typeof type !== 'string' || !(META_POST_CTA_TYPES as readonly string[]).includes(type)) {
    const why = typeof type === 'string' ? META_POST_CTA_REFUSED[type] : undefined
    return why ? `${where}: Nexus does not send ${type} (${why})` : `${where}.type is one of ${META_POST_CTA_TYPES.join(', ')}`
  }
  if (opts.video && type !== 'GET_DIRECTIONS') return `${where}: a video post takes only GET_DIRECTIONS (Meta: "Video Page posts are available only if you use the GET_DIRECTIONS call to action"); put another button on the ad's creative`
  if (NO_VALUE_CTAS.has(type)) return 'value' in cta ? `${where}: ${type} carries no value` : null
  const value = cta.value
  if (!isObj(value)) return `${where}.value is an object with its link`
  const allowed = opts.video ? ['link', 'link_format'] : ['link']
  if (Object.keys(value).some((k) => !allowed.includes(k)) || !('link' in value)) return `${where}.value has ${allowed.join(' and ')} only`
  if (opts.video && value.link_format !== 'VIDEO_LPP') return `${where}.value.link_format is VIDEO_LPP (the event-ads guide's video post)`
  if (type === 'CALL_NOW') return typeof value.link === 'string' && META_TEL.test(value.link) ? null : `${where}.value.link is tel:+<country code><number>, digits only (Meta: "must start with a plus sign (+) and the country code")`
  if (type === 'GET_DIRECTIONS') return fbgeoProblem(value.link, `${where}.value.link`)
  return linkProblem(value.link, `${where}.value.link`)
}

/** The ids of a JSON list of {"media_fbid":"<digits>"} (attached_media), or why it is not one. */
function attachedMediaOf(raw: string | undefined): { ids: string[] } | { problem: string } {
  const list = json(raw)
  if (!Array.isArray(list) || !list.length || list.length > META_POST_LIMITS.photos) return { problem: `attached_media is a JSON list of 1 to ${META_POST_LIMITS.photos} photos, as Nexus writes it: [{"media_fbid":"<id>"}]` }
  const ids: string[] = []
  for (const item of list) {
    if (!isObj(item) || Object.keys(item).join() !== 'media_fbid' || typeof item.media_fbid !== 'string' || !DIGITS.test(item.media_fbid)) return { problem: 'attached_media names each photo as {"media_fbid":"<photo id>"} and nothing else' }
    ids.push(item.media_fbid)
  }
  return new Set(ids).size === ids.length ? { ids } : { problem: 'attached_media names each photo once' }
}

/** A carousel card of child_attachments: link (required), name, description, and picture OR image_hash (one of them). */
function childProblem(item: unknown, where: string): string | null {
  if (!isObj(item)) return `${where} is an object`
  for (const k of Object.keys(item)) if (!['link', 'name', 'description', 'picture', 'image_hash'].includes(k)) return `${where} has no key "${k.slice(0, 40)}" Nexus sends (link, name, description, picture or image_hash)`
  const link = linkProblem(item.link, `${where}.link`)
  if (link) return link
  if ('name' in item) { const p = metaPostTextProblem(item.name, META_POST_LIMITS.name, `${where}.name`); if (p) return p }
  if ('description' in item) { const p = metaPostTextProblem(item.description, META_POST_LIMITS.description, `${where}.description`); if (p) return p }
  if (('picture' in item) === ('image_hash' in item)) return `${where} has one image: picture (a link) or image_hash (Meta: "one of picture and image_hash must be specified")`
  if ('picture' in item) return linkProblem(item.picture, `${where}.picture`, META_POST_LIMITS.picture)
  return typeof item.image_hash === 'string' && META_IMAGE_HASH.test(item.image_hash) ? null : `${where}.image_hash is an image hash of the ad account's library`
}

/** The cards of child_attachments, or why they are refused (2 to 5; up to 10 only with multi_share_optimized=true). */
function childrenOf(raw: string | undefined, optimized: boolean): { cards: Row[] } | { problem: string } {
  const list = json(raw)
  const max = optimized ? META_POST_LIMITS.childrenOptimizedMax : META_POST_LIMITS.childrenMax
  if (!Array.isArray(list) || list.length < META_POST_LIMITS.childrenMin || list.length > max) {
    return { problem: `child_attachments is a JSON list of ${META_POST_LIMITS.childrenMin} to ${max} cards, as Nexus writes it (Meta: 2–5; up to 10 when multi_share_optimized is true, and then it shows the top 5)` }
  }
  for (const [i, item] of list.entries()) { const p = childProblem(item, `child_attachments[${i}]`); if (p) return { problem: p } }
  return { cards: list as Row[] }
}

/** ISO 3166 country codes, upper case, each once. */
function countriesProblem(v: unknown, where: string): string | null {
  if (!Array.isArray(v) || !v.length || v.length > META_POST_LIMITS.countries || !v.every((c) => typeof c === 'string' && /^[A-Z]{2}$/.test(c)) || new Set(v).size !== v.length) {
    return `${where} is a list of 1 to ${META_POST_LIMITS.countries} two-letter country codes (IT, DE, …), each once`
  }
  return null
}

/** targeting (who may see the post): {"geo_locations":{"countries":[…]}, "age_min": 13|15|18|21|25} — those keys only. */
function targetingProblem(raw: string | undefined): string | null {
  const t = json(raw)
  if (!isObj(t) || !Object.keys(t).length || Object.keys(t).some((k) => k !== 'geo_locations' && k !== 'age_min')) return 'targeting is a JSON object with geo_locations (countries) and / or age_min only, as Nexus writes it'
  if ('geo_locations' in t) {
    if (!isObj(t.geo_locations) || Object.keys(t.geo_locations).join() !== 'countries') return 'targeting.geo_locations has countries only'
    const p = countriesProblem(t.geo_locations.countries, 'targeting.geo_locations.countries')
    if (p) return p
  }
  if ('age_min' in t && !(META_POST_AGE_MINS as readonly number[]).includes(t.age_min as number)) return `targeting.age_min is one of ${META_POST_AGE_MINS.join(', ')} (Meta's enum)`
  return null
}

/** feed_targeting (who is MORE likely to see it): geo_locations.countries, age_min 13–65, age_max 13–65 — those keys only. */
function feedTargetingProblem(raw: string | undefined): string | null {
  const t = json(raw)
  if (!isObj(t) || !Object.keys(t).length || Object.keys(t).some((k) => !['geo_locations', 'age_min', 'age_max'].includes(k))) return 'feed_targeting is a JSON object with geo_locations (countries), age_min and / or age_max only, as Nexus writes it'
  if ('geo_locations' in t) {
    if (!isObj(t.geo_locations) || Object.keys(t.geo_locations).join() !== 'countries') return 'feed_targeting.geo_locations has countries only'
    const p = countriesProblem(t.geo_locations.countries, 'feed_targeting.geo_locations.countries')
    if (p) return p
  }
  const age = (v: unknown) => Number.isInteger(v) && (v as number) >= 13 && (v as number) <= 65
  if ('age_min' in t && !age(t.age_min)) return 'feed_targeting.age_min is a whole number 13 to 65'
  if ('age_max' in t && !age(t.age_max)) return 'feed_targeting.age_max is a whole number 13 to 65'
  if ('age_min' in t && 'age_max' in t && (t.age_min as number) > (t.age_max as number)) return 'feed_targeting.age_min is at most age_max'
  return null
}

// ── Facebook: a post on the chosen Page ─────────────────────────────────────────────────────────────────────────────

/** The keys of a post on the chosen Page's feed (POST /<page>/feed). */
export const META_PAGE_FEED_KEYS = [
  'message', 'link', 'name', 'description', 'picture', 'image_hash', 'call_to_action', 'child_attachments', 'multi_share_optimized', 'multi_share_end_card',
  'attached_media', 'scheduled_publish_time', 'unpublished_content_type', 'targeting', 'feed_targeting', 'place',
] as const

/** Why a post on the chosen Page's feed is refused, or null. */
export function metaPageFeedProblem(params: Params, now: number = Date.now()): string | null {
  const has = (k: string) => params.has(k)
  if (!bool(params.get('published'))) return 'published is true or false (Nexus always says it: a post is never public by an omission)'
  const published = params.get('published') === 'true'
  if (!has('message') && !has('link') && !has('attached_media')) return 'a post has message, link or attached_media'
  if (has('message')) { const p = metaPostTextProblem(params.get('message'), META_POST_LIMITS.message, 'message', true); if (p) return p }
  if (has('attached_media') && (has('link') || has('child_attachments'))) return 'a photo post (attached_media) has no link or child_attachments'
  const linkOnly = ['name', 'description', 'picture', 'image_hash', 'call_to_action', 'child_attachments']
  if (!has('link')) { const k = linkOnly.find(has); if (k) return `${k} goes only with link (a link post)` }
  if (has('link')) { const p = linkProblem(params.get('link'), 'link'); if (p) return p }
  if (has('name')) { const p = metaPostTextProblem(params.get('name'), META_POST_LIMITS.name, 'name'); if (p) return p }
  if (has('description')) { const p = metaPostTextProblem(params.get('description'), META_POST_LIMITS.description, 'description'); if (p) return p }
  if (has('picture') && has('image_hash')) return 'a link preview has one image: picture or image_hash'
  if (has('picture')) { const p = linkProblem(params.get('picture'), 'picture', META_POST_LIMITS.picture); if (p) return p }
  if (has('image_hash') && !META_IMAGE_HASH.test(params.get('image_hash')!)) return 'image_hash is an image hash of the ad account\'s library'
  if (has('call_to_action')) {
    const p = metaPostCtaProblem(params.get('call_to_action'))
    if (p) return p
    const cta = json(params.get('call_to_action')) as Row
    // Review B-F6 — a local call to action only on a dark post ("Only used for local awareness ads").
    if (META_POST_LOCAL_CTAS.has(cta.type as string) && (published || has('scheduled_publish_time'))) return `${cta.type} goes on an unpublished (dark) post only: Meta uses it only in local awareness ads`
    // Review B-F7 — a link button goes to the post's own link (Meta: "This link should be the same as the link parameter").
    const value = isObj(cta.value) ? cta.value : null
    if (value && !META_POST_LOCAL_CTAS.has(cta.type as string) && value.link !== params.get('link')) return 'call_to_action.value.link is the post\'s own link (Meta: "This link should be the same as the link parameter of the Page Post")'
  }
  const multi = ['multi_share_optimized', 'multi_share_end_card']
  if (!has('child_attachments')) { const k = multi.find(has); if (k) return `${k} goes only with child_attachments (a carousel post)` }
  if (has('child_attachments')) {
    // Meta's default for multi_share_optimized is TRUE (it reorders the cards in an ad): Nexus always says it.
    if (!has('multi_share_optimized')) return 'a carousel post says multi_share_optimized (Meta\'s default true lets it reorder the cards in an ad: Nexus sends it, false unless asked)'
    for (const k of multi) if (has(k) && !bool(params.get(k))) return `${k} is true or false`
    if (has('picture') || has('image_hash')) return 'a carousel post has an image per card (child_attachments), not one for the link'
    const cards = childrenOf(params.get('child_attachments'), params.get('multi_share_optimized') === 'true')
    if ('problem' in cards) return cards.problem
  }
  if (has('attached_media')) {
    const m = attachedMediaOf(params.get('attached_media'))
    if ('problem' in m) return m.problem
    if (!published && !has('scheduled_publish_time') && !META_DARK_PHOTO_POSTS_PROVEN) return 'an unpublished photo post that is not scheduled waits for a live check (LIVE-PROBES PG24-03): for an ad, create-meta-creative makes the dark photo post itself'
  }
  if (has('scheduled_publish_time')) {
    if (published) return 'scheduled_publish_time goes only with published=false (Meta publishes it at that time)'
    const p = metaPostScheduleProblem(params.get('scheduled_publish_time'), now)
    if (p) return p
  }
  if (has('unpublished_content_type')) {
    // The photos reference: a scheduled multi-photo post sends published=false, scheduled_publish_time and SCHEDULED.
    if (params.get('unpublished_content_type') !== 'SCHEDULED' || !has('scheduled_publish_time') || !has('attached_media')) return 'unpublished_content_type is SCHEDULED, on a scheduled photo post only (the photos reference)'
  } else if (has('scheduled_publish_time') && has('attached_media')) return 'a scheduled photo post says unpublished_content_type=SCHEDULED (Meta: "the published, scheduled_publish_time, and unpublished_content_type parameters must be included")'
  if (has('targeting')) { const p = targetingProblem(params.get('targeting')); if (p) return p }
  if (has('feed_targeting')) { const p = feedTargetingProblem(params.get('feed_targeting')); if (p) return p }
  if (has('place') && !DIGITS.test(params.get('place')!)) return 'place is a place\'s Facebook Page id (digits)'
  return null
}

/** The local calls to action: the post's link is the chosen Page's own URL (event-ads guide) — the Page of the route. */
function localLinkProblem(route: string, params: Params): string | null {
  const cta = json(params.get('call_to_action'))
  if (!isObj(cta) || typeof cta.type !== 'string' || !META_POST_LOCAL_CTAS.has(cta.type)) return null
  const page = /^(\d{1,25})\//.exec(route)?.[1]
  return params.get('link') === `https://www.facebook.com/${page}` ? null : `with ${cta.type} the post's link is the Page's own URL, https://www.facebook.com/${page} (Meta: "Unless you use the LEARN_MORE call to action, the link must match your business's Facebook Page URL")`
}

/** The ids inside a feed post: its photos and its library images. */
function feedIds(params: Params): MetaWriteBodyId[] {
  const out: MetaWriteBodyId[] = []
  const media = attachedMediaOf(params.get('attached_media'))
  if (params.has('attached_media') && 'ids' in media) for (const id of media.ids) out.push({ id, kind: 'postphoto' })
  const hash = params.get('image_hash')
  if (hash) out.push({ id: hash, kind: 'postimagehash' })
  const place = params.get('place')
  if (place && DIGITS.test(place)) out.push({ id: place, kind: 'postplace' })
  const cards = params.has('child_attachments') ? json(params.get('child_attachments')) : null
  if (Array.isArray(cards)) for (const c of cards) if (isObj(c) && typeof c.image_hash === 'string') out.push({ id: c.image_hash, kind: 'postimagehash' })
  return out
}

/** Why an unpublished photo of a post (POST /<page>/photos) is refused, or null: a link, never published by itself. */
export function metaPagePhotoProblem(params: Params): string | null {
  for (const k of params.keys()) if (!['url', 'published', 'temporary', 'alt_text_custom'].includes(k)) return `${k} is not a key of a post's photo`
  const p = linkProblem(params.get('url'), 'url', META_POST_LIMITS.picture)
  if (p) return p
  if (params.get('published') !== 'false') return 'a post\'s photo is uploaded with published=false (Nexus posts photos only through the post that attaches them)'
  if (params.has('temporary') && params.get('temporary') !== 'true') return 'temporary is true (a photo of a scheduled post), or not sent'
  if (params.has('alt_text_custom')) return metaPostTextProblem(params.get('alt_text_custom'), META_POST_LIMITS.altText, 'alt_text_custom')
  return null
}

/** Why a video post (POST /<page>/videos, Meta fetches the file) is refused, or null. */
export function metaPageVideoProblem(params: Params, now: number = Date.now()): string | null {
  for (const k of params.keys()) if (!['file_url', 'published', 'title', 'description', 'scheduled_publish_time', 'unpublished_content_type', 'call_to_action'].includes(k)) return `${k} is not a key of a video post`
  const p = linkProblem(params.get('file_url'), 'file_url', 2_000)
  if (p) return p
  if (!bool(params.get('published'))) return 'published is true or false (Nexus always says it)'
  const published = params.get('published') === 'true'
  if (params.has('title')) {
    const title = params.get('title')!
    const t = metaPostTextProblem(title, META_POST_LIMITS.message, 'title')
    if (t) return t
    if (Buffer.byteLength(title, 'utf8') > META_POST_LIMITS.videoTitleBytes) return `title is at most ${META_POST_LIMITS.videoTitleBytes} bytes (UTF-8)`
  }
  if (params.has('description')) { const d = metaPostTextProblem(params.get('description'), META_POST_LIMITS.message, 'description', true); if (d) return d }
  const type = params.get('unpublished_content_type')
  if (published) {
    if (params.has('scheduled_publish_time') || type) return 'a published video post has no scheduled_publish_time or unpublished_content_type'
  } else if (params.has('scheduled_publish_time')) {
    if (type !== 'SCHEDULED') return 'a scheduled video post says unpublished_content_type=SCHEDULED'
    const s = metaPostScheduleProblem(params.get('scheduled_publish_time'), now)
    if (s) return s
  } else if (type !== 'ADS_POST') return 'an unpublished video post for ads says unpublished_content_type=ADS_POST (the videos reference: "To create an unpublished video for advertising")'
  if (params.has('call_to_action')) {
    if (published || type !== 'ADS_POST') return 'call_to_action goes only on an unpublished video post for a local ad (the event-ads guide)'
    return metaPostCtaProblem(params.get('call_to_action'), 'call_to_action', { video: true })
  }
  return null
}

/** The keys of an edit of a post of the chosen Page (POST /<page>_<post>). */
export const META_PAGE_POST_EDIT_KEYS = ['message', 'is_hidden', 'is_published', 'scheduled_publish_time', 'timeline_visibility', 'sponsor_id', 'direct_share_status'] as const

/** Why an edit of a post of the chosen Page is refused, or null. */
export function metaPagePostEditProblem(params: Params, now: number = Date.now()): string | null {
  if (params.has('message')) { const p = metaPostTextProblem(params.get('message'), META_POST_LIMITS.message, 'message', true); if (p) return p }
  if (params.has('is_hidden') && !bool(params.get('is_hidden'))) return 'is_hidden is true or false'
  if (params.has('is_published')) {
    if (params.get('is_published') !== 'true') return 'is_published is true only (a publish now; Nexus never un-publishes a post: Meta documents no way back)'
    if (params.has('scheduled_publish_time')) return 'a publish now has no scheduled_publish_time'
  }
  if (params.has('scheduled_publish_time')) { const p = metaPostScheduleProblem(params.get('scheduled_publish_time'), now); if (p) return p }
  if (params.has('timeline_visibility') && !['hidden', 'normal'].includes(params.get('timeline_visibility')!)) return 'timeline_visibility is hidden or normal (Meta\'s forced_allow is not documented)'
  if (params.has('sponsor_id') && !DIGITS.test(params.get('sponsor_id')!)) return 'sponsor_id is a Facebook Page id (digits)'
  if (params.has('direct_share_status')) {
    if (!['0', '1'].includes(params.get('direct_share_status')!)) return 'direct_share_status is 1 (the brand may boost the post) or 0'
    if (!params.has('sponsor_id')) return 'direct_share_status goes with sponsor_id (the branded-content guide: "providing the sponsor_id and a change to the direct_share_status field")'
  }
  return null
}

// ── Instagram: a post of the chosen Instagram account ──────────────────────────────────────────────────────────────

type IgJudge = (value: string, params: Params) => string | null

const USERNAME = /^[A-Za-z0-9._]{1,30}$/
/** Instagram usernames as a JSON list, each once (collaborators). */
function usernamesProblem(raw: string, max: number, where: string): string | null {
  const list = json(raw)
  if (!Array.isArray(list) || !list.length || list.length > max || !list.every((u) => typeof u === 'string' && USERNAME.test(u)) || new Set(list.map((u) => (u as string).toLowerCase())).size !== list.length) {
    return `${where} is a JSON list of 1 to ${max} Instagram usernames (letters, digits, . and _), each once, as Nexus writes it`
  }
  return null
}
/**
 * user_tags: [{username, x, y}] — x / y from 0.0 to 1.0, "Required for images, optional for stories"; a reel's or a
 * video's tag is {username} only (x / y "Applies only to images and stories").
 */
function userTagsProblem(raw: string, params: Params): string | null {
  const list = json(raw)
  if (!Array.isArray(list) || !list.length || list.length > META_POST_LIMITS.userTags) return `user_tags is a JSON list of 1 to ${META_POST_LIMITS.userTags} tags, as Nexus writes it`
  const story = params.get('media_type') === 'STORIES'
  const image = params.has('image_url') && !story
  const xy = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
  const names = new Set<string>()
  for (const [i, tag] of list.entries()) {
    const where = `user_tags[${i}]`
    if (!isObj(tag) || typeof tag.username !== 'string' || !USERNAME.test(tag.username)) return `${where} names an Instagram username`
    const keys = Object.keys(tag).sort().join()
    const placed = keys === 'username,x,y' && xy(tag.x) && xy(tag.y)
    if (image && !placed) return `${where} is {username, x, y} with x and y from 0.0 to 1.0 (Meta: required for images)`
    if (story && !placed && keys !== 'username') return `${where} is {username} or {username, x, y} with x and y from 0.0 to 1.0`
    if (!image && !story && keys !== 'username') return `${where} is {username} (a reel's or a video's tag has no place on a picture)`
    names.add(tag.username.toLowerCase())
  }
  return names.size === list.length ? null : 'user_tags names each account once'
}
/** branded_content_sponsor_ids: a JSON list of 1–2 Instagram user ids, as integers (Meta: "array of integers"). */
export const META_IG_SPONSORS = /^\[([1-9]\d{0,24})(?:,([1-9]\d{0,24}))?\]$/
const sponsorIdsOf = (raw: string | undefined): string[] => {
  const m = META_IG_SPONSORS.exec(raw ?? '')
  return m ? [m[1], m[2]].filter((v): v is string => !!v) : []
}
/** children: a comma list of 2–20 container ids, each once (the content-publishing guide's form). */
export const META_IG_CHILDREN = /^[1-9]\d{0,24}(?:,[1-9]\d{0,24}){1,19}$/
const childrenIdsOf = (raw: string | undefined): string[] => (META_IG_CHILDREN.test(raw ?? '') ? raw!.split(',') : [])

/** A caption: ≤ 2,200 characters, ≤ 30 hashtags, ≤ 20 @ tags (ig-user/media). */
export function metaIgCaptionProblem(value: string): string | null {
  const p = metaPostTextProblem(value, META_POST_LIMITS.caption, 'caption', true)
  if (p) return p
  if ((value.match(/(^|[^\w&])#[\p{L}\p{N}_]+/gu) ?? []).length > META_POST_LIMITS.hashtags) return `caption has at most ${META_POST_LIMITS.hashtags} hashtags (Meta's limit)`
  if ((value.match(/(^|[^\w.])@[A-Za-z0-9._]+/g) ?? []).length > META_POST_LIMITS.mentions) return `caption has at most ${META_POST_LIMITS.mentions} @ tags (Meta's limit)`
  return null
}

/**
 * The judge of each Instagram container key (step 35's `product_tags` at the end, judged by meta-instagram-tags.ts).
 */
export const META_IG_CONTAINER_JUDGES: Record<string, IgJudge> = {
  image_url: (v) => linkProblem(v, 'image_url', 2_000),
  video_url: (v) => linkProblem(v, 'video_url', 2_000),
  media_type: (v) => ((META_IG_MEDIA_TYPES as readonly string[]).includes(v) ? null : `media_type is one of ${META_IG_MEDIA_TYPES.join(', ')} (no media_type: a feed image)`),
  is_carousel_item: (v) => (v === 'true' ? null : 'is_carousel_item is true, or not sent'),
  caption: (v) => metaIgCaptionProblem(v),
  children: (v) => (META_IG_CHILDREN.test(v) && new Set(v.split(',')).size === v.split(',').length ? null : `children is a comma list of ${META_POST_LIMITS.carouselMin} to ${META_POST_LIMITS.carouselMax} container ids, each once`),
  collaborators: (v) => usernamesProblem(v, META_POST_LIMITS.collaborators, 'collaborators'),
  user_tags: userTagsProblem,
  location_id: (v) => (DIGITS.test(v) ? null : 'location_id is a place\'s Facebook Page id (digits)'),
  alt_text: (v) => metaPostTextProblem(v, META_POST_LIMITS.altText, 'alt_text'),
  is_ai_generated: (v) => (bool(v) ? null : 'is_ai_generated is true or false'),
  branded_content_sponsor_ids: (v) => (META_IG_SPONSORS.test(v) && new Set(sponsorIdsOf(v)).size === sponsorIdsOf(v).length ? null : `branded_content_sponsor_ids is a JSON list of 1 to ${META_POST_LIMITS.sponsors} Instagram account ids, each once: [<id>,<id>]`),
  is_paid_partnership: (v) => (bool(v) ? null : 'is_paid_partnership is true or false'),
  share_to_feed: (v) => (bool(v) ? null : 'share_to_feed is true or false'),
  cover_url: (v) => linkProblem(v, 'cover_url', 2_000),
  thumb_offset: (v) => (/^(0|[1-9]\d{0,8})$/.test(v) ? null : 'thumb_offset is the frame in milliseconds (a whole number)'),
  audio_name: (v) => metaPostTextProblem(v, META_POST_LIMITS.audioName, 'audio_name'),
  trial_params: (v) => {
    const t = json(v)
    return isObj(t) && Object.keys(t).join() === 'graduation_strategy' && (META_IG_TRIAL_STRATEGIES as readonly string[]).includes(t.graduation_strategy as string)
      ? null : `trial_params is {"graduation_strategy":"MANUAL" | "SS_PERFORMANCE"}, as Nexus writes it`
  },
  // Step 35 (Q9) — product tags on a new post, judged by the one tag judge (its limits and shape per target): a feed image
  // (20, x / y), a reel (30, no place), a carousel item (5 each, x / y on an image item; product-tagging "Carousels").
  product_tags: (v, params) => {
    const target = IG_TAG_TARGET_OF[metaIgContainerKind(params) ?? ''] ?? null
    return target ? metaIgProductTagsProblem(v, target, 'product_tags') : 'product_tags go on a feed image, a reel or a carousel item only (Meta: no product tags on Stories)'
  },
}
/** Step 35 (Q9) — the tag target of each container kind that takes product tags. */
const IG_TAG_TARGET_OF: Readonly<Record<string, MetaIgTagTarget>> = { image: 'image', reel: 'reel', carouselImage: 'carousel-image', carouselVideo: 'carousel-video' }

/**
 * The keys each kind of container takes (ig-user/media's request syntax per kind, and its key table's "only" notes). Step
 * 35 (Q9): `product_tags` on the image, reel, carouselImage and carouselVideo lists — a carousel's tags go on its items
 * (product-tagging "Carousels": "create tagged media containers for each tagged image or video"), never on the album.
 */
export const META_IG_CONTAINER_KEYS: Record<'image' | 'reel' | 'storyImage' | 'storyVideo' | 'carouselImage' | 'carouselVideo' | 'carousel', string[]> = {
  image: ['image_url', 'caption', 'alt_text', 'collaborators', 'user_tags', 'location_id', 'is_ai_generated', 'branded_content_sponsor_ids', 'is_paid_partnership', 'product_tags'],
  reel: ['media_type', 'video_url', 'caption', 'share_to_feed', 'collaborators', 'cover_url', 'audio_name', 'user_tags', 'location_id', 'thumb_offset', 'trial_params', 'is_ai_generated', 'branded_content_sponsor_ids', 'is_paid_partnership', 'product_tags'],
  storyImage: ['media_type', 'image_url', 'user_tags'],
  storyVideo: ['media_type', 'video_url', 'user_tags'],
  carouselImage: ['image_url', 'is_carousel_item', 'alt_text', 'user_tags', 'product_tags'],
  carouselVideo: ['media_type', 'video_url', 'is_carousel_item', 'thumb_offset', 'user_tags', 'product_tags'],
  carousel: ['media_type', 'children', 'caption', 'collaborators', 'location_id', 'is_ai_generated', 'branded_content_sponsor_ids', 'is_paid_partnership'],
}

/** Which kind of container a body is (by its media_type and media keys), or null. */
export function metaIgContainerKind(params: Params): keyof typeof META_IG_CONTAINER_KEYS | null {
  const type = params.get('media_type')
  const item = params.get('is_carousel_item') === 'true'
  const image = params.has('image_url')
  const video = params.has('video_url')
  if (image === video && type !== 'CAROUSEL') return null
  if (type === undefined) return image ? (item ? 'carouselImage' : 'image') : null
  if (type === 'REELS') return video && !item ? 'reel' : null
  if (type === 'STORIES') return item ? null : image ? 'storyImage' : 'storyVideo'
  if (type === 'VIDEO') return video && item ? 'carouselVideo' : null
  if (type === 'CAROUSEL') return !image && !video && !item ? 'carousel' : null
  return null
}

/** Why an Instagram media container is refused, or null. */
export function metaIgContainerProblem(params: Params): string | null {
  const kind = metaIgContainerKind(params)
  if (!kind) return 'an Instagram container is a feed image (image_url), a reel (media_type=REELS, video_url), a story (media_type=STORIES with image_url or video_url), a carousel item (is_carousel_item=true: image_url, or media_type=VIDEO with video_url) or a carousel (media_type=CAROUSEL with children)'
  const keys = META_IG_CONTAINER_KEYS[kind]
  for (const [key, value] of params) {
    if (!keys.includes(key)) return `${key} is not a key of ${kind === 'carouselImage' || kind === 'carouselVideo' ? 'a carousel item' : kind === 'storyImage' || kind === 'storyVideo' ? 'a story' : `a ${kind}`} (ig-user/media)`
    const judge = META_IG_CONTAINER_JUDGES[key]
    if (!judge) return `${key} is not a key Nexus sends`
    const problem = judge(value, params)
    if (problem) return problem
  }
  if (kind === 'carousel' && !params.has('children')) return 'a carousel names its children'
  // Meta: "Automatically set to true when branded_content_sponsor_ids is provided" — so never false beside sponsors.
  if (params.has('branded_content_sponsor_ids') && params.get('is_paid_partnership') === 'false') return 'is_paid_partnership cannot be false with branded_content_sponsor_ids (Meta sets it true)'
  return null
}

/** The ids inside a container: its children, its sponsors, its place. */
function containerIds(params: Params): MetaWriteBodyId[] {
  return [
    ...childrenIdsOf(params.get('children')).map((id): MetaWriteBodyId => ({ id, kind: 'igcontainer' })),
    ...sponsorIdsOf(params.get('branded_content_sponsor_ids')).map((id): MetaWriteBodyId => ({ id, kind: 'igsponsor' })),
    ...(params.has('location_id') && DIGITS.test(params.get('location_id')!) ? [{ id: params.get('location_id')!, kind: 'postplace' } as MetaWriteBodyId] : []),
    // Step 35 (Q9) — every tagged product: an item of a catalog this business may read (step 25's productitem rule).
    ...metaIgProductTagIds(params.get('product_tags')).map((id): MetaWriteBodyId => ({ id, kind: 'productitem' })),
  ]
}

/** An ISO time as Meta's examples write it (`2026-11-30T19:00:00+0000`): a real moment, UTC. */
export const META_IG_EVENT_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+0000$/
const eventTimeOf = (v: string | undefined): number | null => {
  if (!v || !META_IG_EVENT_TIME.test(v)) return null
  const ms = Date.parse(v.replace('+0000', 'Z'))
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === v.slice(0, 19) ? ms : null
}

/** Why an upcoming event (POST /<ig>/upcoming_events) is refused, or null — the guide's rules for its notifications. */
export function metaIgEventProblem(params: Params, now: number = Date.now()): string | null {
  const title = metaPostTextProblem(params.get('title'), META_POST_LIMITS.eventTitle, 'title')
  if (title) return title
  const start = eventTimeOf(params.get('start_time'))
  if (start === null) return 'start_time is a UTC time as Meta writes it: 2026-11-30T19:00:00+0000'
  if (start <= now) return 'start_time is in the future'
  if (start - now > META_POST_LIMITS.eventMaxDays * 86_400_000) return `start_time is at most ${META_POST_LIMITS.eventMaxDays} days ahead (Nexus's own limit)`
  if (params.has('end_time')) {
    const end = eventTimeOf(params.get('end_time'))
    if (end === null || end <= start) return 'end_time is a UTC time after start_time (2026-11-30T21:00:00+0000)'
  }
  const target = params.get('notification_target_time')
  if (target !== undefined && target !== 'EVENT_START' && target !== 'EVENT_END') return 'notification_target_time is EVENT_START or EVENT_END'
  if (params.has('notification_subtypes')) {
    const list = json(params.get('notification_subtypes'))
    if (!Array.isArray(list) || list.length !== 3 || !list.every((s) => typeof s === 'string' && (META_IG_EVENT_SUBTYPES as readonly string[]).includes(s)) || new Set(list).size !== 3) {
      return 'notification_subtypes is a JSON list of three of Meta\'s notification times, each once, as Nexus writes it'
    }
    if (target === 'EVENT_END') {
      if (!META_IG_EVENT_END_SUBTYPES.every((s) => list.includes(s))) return `with EVENT_END the notifications are exactly ${META_IG_EVENT_END_SUBTYPES.join(', ')} (Meta's rule)`
    } else if (!list.includes('EVENT_START') || !list.includes('BEFORE_EVENT_1DAY') || list.includes('BEFORE_EVENT_2DAY') || list.includes('BEFORE_EVENT_1HOUR')) {
      return 'with EVENT_START the notifications are EVENT_START, BEFORE_EVENT_1DAY and one of BEFORE_EVENT_15MIN or AFTER_EVENT_1DAY … AFTER_EVENT_7DAY (Meta\'s rule)'
    }
  } else if (target === 'EVENT_END') return 'with EVENT_END the notifications are named: BEFORE_EVENT_2DAY, BEFORE_EVENT_1DAY, BEFORE_EVENT_1HOUR'
  if (target === 'EVENT_END' && params.has('end_time')) return 'with EVENT_END the event has no end_time (Meta\'s rule)'
  return null
}

// ── the rules ───────────────────────────────────────────────────────────────────────────────────────────────────────

const LINES = META_COMMENT_TEXT
const LINE = META_NAME_TEXT

/** Step 24 — the post rules (gateway meta-calls.ts writeRules). Every one goes with the chosen Page's own token. */
export const META_POST_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    // create-meta-page-post: a text, link, carousel or photo post on the chosen Page — dark, public or scheduled (MD-107,
    // MD-109, MD-111, EN-047, CR-256).
    name: 'pagepost.feed',
    method: 'POST',
    path: /^\d{1,25}\/feed$/,
    kinds: ['postpage'],
    auth: 'page',
    required: ['published'],
    optional: [...META_PAGE_FEED_KEYS],
    // Text where a person types it; a card's or a call to action's text lives inside its JSON.
    text: { message: LINES, name: LINE, description: LINE, child_attachments: LINE, call_to_action: LINE },
    maxBody: META_POST_MAX_BODY,
    values: (params) => metaPageFeedProblem(params),
    routeCheck: localLinkProblem,
    ids: feedIds,
    // A new post on the Page's edge edits no object: no 30-s per-object gap (step 23's edgeCall).
    edgeCall: true,
    budget: false,
  },
  {
    // create-meta-page-post: an UNPUBLISHED photo of the chosen Page, which the post of the same change attaches (MD-108,
    // EN-050); Meta deletes one no post attaches within 24 hours.
    name: 'pagepost.photo',
    method: 'POST',
    path: /^\d{1,25}\/photos$/,
    kinds: ['postpage'],
    auth: 'page',
    required: ['url', 'published'],
    optional: ['temporary', 'alt_text_custom'],
    text: { alt_text_custom: LINE },
    maxBody: 20_000,
    values: metaPagePhotoProblem,
    edgeCall: true,
    budget: false,
  },
  {
    // create-meta-page-post: a video post of the chosen Page from a public link Meta fetches — dark for ads (ADS_POST),
    // public or scheduled (MD-110, CR-256's GET_DIRECTIONS video).
    name: 'pagepost.video',
    method: 'POST',
    path: /^\d{1,25}\/videos$/,
    kinds: ['postpage'],
    auth: 'page',
    // Review B-F1 — on Meta's video host (graph-video.facebook.com), as every v26 example sends it; only this rule goes there.
    videoHost: true,
    required: ['file_url', 'published'],
    optional: ['title', 'description', 'scheduled_publish_time', 'unpublished_content_type', 'call_to_action'],
    text: { title: LINE, description: LINES, call_to_action: LINE },
    maxBody: META_POST_MAX_BODY,
    values: (params) => metaPageVideoProblem(params),
    edgeCall: true,
    budget: false,
  },
  {
    // set-meta-page-post: an edit of a post of the chosen Page (MD-112 publish now, MD-113 edit, MD-115 sponsor).
    name: 'pagepost.update',
    method: 'POST',
    path: /^\d{1,25}_\d{1,25}$/,
    kinds: ['pagepostedit'],
    auth: 'page',
    required: [],
    optional: [...META_PAGE_POST_EDIT_KEYS],
    anyOf: [...META_PAGE_POST_EDIT_KEYS],
    text: { message: LINES },
    maxBody: META_POST_MAX_BODY,
    values: (params) => metaPagePostEditProblem(params),
    ids: (params) => (params.has('sponsor_id') && DIGITS.test(params.get('sponsor_id')!) ? [{ id: params.get('sponsor_id')!, kind: 'postsponsorpage' }] : []),
    budget: false,
  },
  {
    // remove-meta-page-post: a post Nexus made on the chosen Page, on a person's explicit ask (MD-114; Meta: "Only select
    // developers can perform this operation using the API" — its refusal answers in words).
    name: 'pagepost.delete',
    method: 'DELETE',
    path: /^\d{1,25}_\d{1,25}$/,
    kinds: ['pagepostmade'],
    auth: 'page',
    required: [],
    optional: [],
    values: () => null,
    budget: false,
  },
  {
    // create-meta-instagram-post: one media container on the chosen Instagram account (MD-133, CR-367, OT-037).
    name: 'igmedia.container',
    method: 'POST',
    path: /^\d{1,25}\/media$/,
    kinds: ['postig'],
    auth: 'page',
    required: [],
    optional: [...new Set(Object.values(META_IG_CONTAINER_KEYS).flat())],
    text: { caption: LINES, alt_text: LINE, audio_name: LINE },
    maxBody: META_POST_MAX_BODY,
    values: metaIgContainerProblem,
    ids: containerIds,
    edgeCall: true,
    budget: false,
  },
  {
    // create-meta-instagram-post: publish a container made by this change (or by an earlier one of this business) — PUBLIC.
    name: 'igmedia.publish',
    method: 'POST',
    path: /^\d{1,25}\/media_publish$/,
    kinds: ['postig'],
    auth: 'page',
    required: ['creation_id'],
    optional: [],
    values: (params) => (DIGITS.test(params.get('creation_id') ?? '') ? null : 'creation_id is a media container id (digits)'),
    ids: (params) => (DIGITS.test(params.get('creation_id') ?? '') ? [{ id: params.get('creation_id')!, kind: 'igcontainer' }] : []),
    edgeCall: true,
    budget: false,
  },
  {
    // create-meta-instagram-post: an upcoming event of the chosen Instagram account (CR-259; reminder ads use it).
    name: 'iguser.upcomingEvent',
    method: 'POST',
    path: /^\d{1,25}\/upcoming_events$/,
    kinds: ['postig'],
    auth: 'page',
    required: ['title', 'start_time'],
    optional: ['end_time', 'notification_subtypes', 'notification_target_time'],
    text: { title: LINE },
    maxBody: 10_000,
    values: (params) => metaIgEventProblem(params),
    edgeCall: true,
    budget: false,
  },
  {
    // remove-meta-page-post: an Instagram media Nexus published on the chosen account, on a person's explicit ask (MD-136).
    name: 'igmedia.delete',
    method: 'DELETE',
    path: /^\d{1,25}$/,
    kinds: ['igmediamade'],
    auth: 'page',
    required: [],
    optional: [],
    values: () => null,
    budget: false,
  },
]

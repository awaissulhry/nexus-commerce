/**
 * Meta step 24 (2026-10-25) — the post tools as drafts (master rows MD-107 … MD-115, MD-133, MD-136, MD-140, EN-047,
 * EN-050, CR-256, CR-259, CR-367, OT-037): organic posts of the business's CHOSEN Facebook Page and CHOSEN Instagram
 * account, each request made AS the Page (the gateway's Page token mode; gateway/meta-post-rules.ts judges every key, and
 * gateway/meta-post-owner.ts confirms every object and every id inside a body). Each draft is built from the request and
 * what Meta holds NOW (reads only, live-posts.ts), judged here by the gateway's OWN judges, so a request the gateway would
 * refuse is never queued.
 *
 *   create-meta-page-post   a text, link (with a call to action: CR-256's local ones too), carousel (2–5 cards, 10 when Meta
 *                           may reorder them), photo (1–10 unpublished photos, then the post that attaches them: MD-108,
 *                           MD-109, EN-050) or video post (Meta fetches a public link: MD-110) — DARK (unpublished, for ads:
 *                           MD-107), PUBLIC at once, or SCHEDULED (MD-111). Undo deletes a post that is still unpublished;
 *                           a public post has none (remove-meta-page-post deletes it on an explicit ask).
 *   set-meta-page-post      an edit of a post the Page wrote: its text, hidden from the Page, timeline visibility, a new
 *                           schedule, publish now (MD-112, one way), a brand partner as its paid-partner sponsor and
 *                           whether that brand may boost it (MD-113, MD-115). Undo writes the old values back (a publish and
 *                           a first sponsor cannot be taken back: said).
 *   remove-meta-page-post   the delete of a post or Instagram media NEXUS made (MD-114, MD-136), on a person's explicit ask,
 *                           never one an ad of the chosen ad account shows. Final.
 *   create-meta-instagram-post  a feed image, a reel, a story or a carousel (2–20 items): its container(s), then the publish
 *                           of the one container once Meta says it is FINISHED (MD-133; caption, collaborators OT-037, user
 *                           tags, a place, the paid-partnership label CR-367, AI disclosure, trial reels); an upcoming event
 *                           (CR-259); or the publish of a container an earlier run made but could not publish yet. PUBLIC
 *                           once published, no edit by API, no undo (remove-meta-page-post deletes it on an explicit ask).
 * Plain answers (no call): MD-140 — Meta's URL node (`GET /?id=<link>`, documented on v26; the field
 * `ownership_permissions{can_customize_link_posts}` is named only on the feed page) is a read of Graph's ROOT, which
 * Nexus's gateway refuses on purpose (the root is the batch endpoint), so Nexus makes no such read: the preview says that a
 * custom preview needs the shop's domain verified in Meta Business Manager and a link Meta scraped before, and Meta refuses a
 * link the Page does not own in its own words (LIVE-PROBES MD-140). Nexus never tags people
 * or Pages in a post (Meta's `tags` are people's ids; `@[page-id]` a Page tag Meta reviews) and never backdates one.
 *
 * Nothing here spends money: an organic post is not an ad (a boost is create-meta-boost, SPENDS MONEY).
 */
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { createdIdOf, MetaWriteError, type MetaChangeResult } from './write-client.js'
import { localFailure, MetaReadError } from './errors.js'
import { liveIgContainer, type IgContainerState, type IgMediaState, type PagePostState } from './live-posts.js'
import { libraryImageLink } from '../google-ads/asset-images.js'
import { libraryVideoLink } from './change-media.js'
import { metaPublicLinkProblem } from '../../gateway/meta-media-rules.js'
// Step 35 (Q9) — product tags on a new post: the one tag judge's spelling and limits.
import { META_IG_TAG_LIMITS, META_IG_TAGGED_POSTS_PER_DAY, metaIgProductTagsParam, type MetaIgProductTag, type MetaIgTagTarget } from '../../gateway/meta-instagram-tags.js'
import {
  META_POST_CTA_REFUSED, META_POST_CTA_TYPES, META_POST_LIMITS, META_POST_LOCAL_CTAS, metaIgContainerProblem, metaIgEventProblem,
  META_DARK_PHOTO_POSTS_PROVEN, metaPageFeedProblem, metaPagePhotoProblem, metaPagePostEditProblem, metaPageVideoProblem, metaPostTextProblem, metaVideoPostIdOf,
} from '../../gateway/meta-post-rules.js'

type Row = Record<string, unknown>

// ── words ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const POST_NO_CHECK = 'Meta has no check (validate_only) for a Page post, its photos, a video post, a post edit, a delete or an Instagram container, publish or event (none of their references lists one): the preview is built from the live state, and Meta judges each request when it runs.'
export const POST_NO_SPEND = 'Nothing spends: an organic post is not an ad. Boosting it is create-meta-boost (SPENDS MONEY); an ad that shows it is create-meta-creative + create-meta-ad.'
export const POST_AS_PAGE = 'Every request goes AS the chosen Facebook Page (Nexus\'s gateway reads the Page\'s own token for it; it is never shown) and counts against the Page\'s own rate limit, not the ad account\'s.'
export const POST_DELETE_SELECT = 'Meta\'s Page Post reference says: "Only select developers can perform this operation using the API. You can use the Business Manager to delete posts." If Meta refuses this delete, nothing changed: a person deletes the post in Meta Business Suite (Content › Posts).'
export const POST_LINK_OWNERSHIP = 'A link post with its own name, description or picture works only when the Page owns the link: the shop\'s domain verified for the business in Meta Business Manager (Brand safety › Domains), and a link Meta has already scraped (Meta: "Without this step, custom link Page posts will not work for un-scraped links"). Meta answers it on the link\'s URL node (GET /?id=<link>), a read of Graph\'s root that Nexus\'s gateway refuses on purpose (the root is the batch endpoint), so Nexus does not check it first: if the Page does not own the link, Meta refuses the post in its own words. Without a name, description or picture Meta takes them from the link\'s page.'
export const IG_NO_EDIT = 'Meta has no edit of a published Instagram post by API (only its comments switch on or off: set-meta-comments): a change means deleting it (remove-meta-page-post) and posting again.'
export const IG_PUBLIC = 'PUBLIC AT ONCE: once Meta publishes it, the post is on the business\'s Instagram account for everyone — followers see it in their feeds, buyers see it. No undo: remove-meta-page-post deletes it on an explicit ask (Meta allows that for posts, stories, reels and whole carousels).'
/** Review A-3 — what an undo of a create can truly do: delete the post while unpublished and no ad shows it, if Meta lets it. */
const UNDO_WORDS = 'Its undo deletes it only while it is still unpublished and no ad shows it, and Meta may refuse a delete by API (only "select developers" may delete a Page post by API) — then a person deletes it in Meta Business Suite.'
const SCHEDULE_WORDS = (when: number) => `SCHEDULED: Meta publishes it by itself at ${new Date(when * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC — from then it is PUBLIC (on the Page and in followers' feeds). Until then it is unpublished: set-meta-page-post can change, publish or reschedule it. ${UNDO_WORDS}`
const DARK_WORDS = `UNPUBLISHED (a "dark" post): it is not on the Page or in anyone's feed; an ad can show it (create-meta-creative with its post id as object_story_id, or create-meta-boost). ${UNDO_WORDS}`
const NOW_WORDS = 'PUBLIC AT ONCE: as soon as Meta makes it, the post is on the business\'s Facebook Page for everyone — followers see it in their feeds, buyers see it. No undo: remove-meta-page-post deletes it on an explicit ask, if Meta allows (only "select developers" may delete a Page post by API).'

/** Meta's codes a post request may meet, in plain words (the kit adds them to the step's sentence). */
export const POST_EXPLAIN: Readonly<Record<string, string>> = {
  80001: 'Meta allows only so many calls to one Page in a while (they count against the Page, not the ad account): wait a few minutes and ask again.',
  368: 'Meta judged this request abusive or not allowed for this Page (its own policy check, not Nexus\'s): a person looks at the Page in Meta\'s Business Support Home before asking again.',
  324: 'Meta could not use the photo from its link (a missing or broken image file): the link must be a public JPEG, PNG, GIF, BMP or TIFF of at most 10 MB (Meta recommends a PNG under 1 MB).',
  389: 'Meta could not fetch the video from its link: it must be public (no sign-in) at the time Meta fetches it.',
  352: 'Meta does not take this video\'s format: MP4 or MOV are the safe choices.',
  351: 'Meta found a problem in the video file.',
  9004: 'Meta could not fetch the media from its link: it must be public when Meta fetches it, a JPEG image (Instagram takes JPEG only) or an MP4 / MOV video.',
  9007: 'Meta says the media is not ready to publish yet: ask again with kind publish-container and the containerId (Meta keeps a container 24 hours).',
  36003: 'Instagram refused the image\'s shape: a feed image is between 4:5 and 1.91:1.',
  // Review B-F11 — Instagram's error codes (instagram-graph-api/reference/error-codes; its subcodes in Meta's words).
  9: 'Instagram\'s limit of API posts in 24 hours is reached (2207042), or Meta asks Nexus to slow down: ask again later (meta-instagram-media view quota shows the limit).',
  36000: 'The image is too large for Instagram (2207004): at most 8 MB.',
}
/** Review B-F11 — Instagram's refusals on a container or a delete, in plain words (the post words above, plus these). */
const IG_EXPLAIN: Readonly<Record<string, string>> = {
  ...POST_EXPLAIN,
  100: 'Meta refused a value of the Instagram post (its words say which). A carousel holds 2 to 20 items (Meta\'s guide and reference say 20; its error 2207028 still says 10 — Meta\'s own pages differ).',
  '-1': 'Meta does not delete this kind of Instagram media by API (2207073, "Media Type Not Supported": an ad\'s media, or one item of a carousel — the whole carousel is deleted by its own id).',
}
const DELETE_EXPLAIN: Readonly<Record<string, string>> = {
  ...POST_EXPLAIN,
  200: POST_DELETE_SELECT,
  3: POST_DELETE_SELECT,
  100: `Meta refused the delete (it may not let this app delete the post). ${POST_DELETE_SELECT}`,
}

// ── timing (tests set sleep to resolve at once) ─────────────────────────────────────────────────────────────────────

/**
 * How the run waits for Meta to finish an Instagram container before its publish (review B-F10): one read at once, then one
 * a minute, at most 5 minutes in all for the whole run (Meta: "querying a container's status once per minute, for no more
 * than 5 minutes"); an image gets 2 more reads. A container still in progress then is published later with kind
 * publish-container.
 */
export const __postTiming = {
  pollMs: 60_000,
  imagePolls: 2,
  videoPolls: 5,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}

// ── media sources ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface PostImageSource { imageUrl?: string; libraryImageId?: string; imageHash?: string }
export interface PostVideoSource { videoUrl?: string; libraryVideoId?: string }
type Linked = { url: string; source: string; jpeg: boolean }

const jpegLink = (url: string) => { try { return /\.jpe?g$/i.test(new URL(url).pathname) } catch { return false } }
/** A link in the URL parser's ONE spelling, which the gateway judges (`https://shop.example` → `https://shop.example/`). */
export const linkOf = (value: string): string => { try { return new URL(value.trim()).href } catch { return value.trim() } }

/** A public link Meta fetches, from a library image of THIS business or a link a person gives — never a local path. */
async function imageLinkOf(src: PostImageSource | undefined, where: string, hashAllowed: boolean): Promise<Linked | { hash: string } | { problem: string }> {
  const given = [src?.imageUrl, src?.libraryImageId, src?.imageHash].filter((v) => typeof v === 'string' && v.trim())
  if (given.length !== 1) return { problem: `${where}: give exactly one of ${hashAllowed ? 'imageHash (an image of the chosen ad account\'s library, create-meta-media answers it), ' : ''}libraryImageId (Nexus's image library) or imageUrl (a public https link)` }
  if (src?.imageHash) return hashAllowed ? { hash: src.imageHash.trim() } : { problem: `${where}: Meta takes this image only by a public link (libraryImageId or imageUrl), not by an image hash` }
  let url: string
  let source: string
  if (src?.libraryImageId) {
    const found = await libraryImageLink(src.libraryImageId)
    if ('problem' in found) return found
    url = linkOf(found.url)
    source = src.libraryImageId.trim()
  } else {
    url = linkOf(src!.imageUrl!)
    source = url
  }
  const problem = metaPublicLinkProblem(url, where, META_POST_LIMITS.picture)
  return problem ? { problem: src?.libraryImageId ? `${source}: its link is not one Meta can fetch (${problem})` : problem } : { url, source, jpeg: jpegLink(url) }
}

/** A public video link Meta fetches (a library video of THIS business, or a link a person gives). */
async function videoLinkOf(src: PostVideoSource | undefined, where: string): Promise<Linked | { problem: string }> {
  const given = [src?.videoUrl, src?.libraryVideoId].filter((v) => typeof v === 'string' && v.trim())
  if (given.length !== 1) return { problem: `${where}: give exactly one of libraryVideoId (Nexus's library) or videoUrl (a public https link Meta fetches)` }
  let url: string
  let source: string
  if (src?.libraryVideoId) {
    const found = await libraryVideoLink(src.libraryVideoId)
    if ('problem' in found) return found
    url = linkOf(found.url)
    source = src.libraryVideoId.trim()
  } else {
    url = linkOf(src!.videoUrl!)
    source = url
  }
  const problem = metaPublicLinkProblem(url, where, 2_000)
  return problem ? { problem: src?.libraryVideoId ? `${source}: its link is not one Meta can fetch (${problem})` : problem } : { url, source, jpeg: false }
}

/** An ISO time a person gives, in Unix seconds, or null. */
export const unixOfIso = (iso: string | undefined): number | null => {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}
const isoOf = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'

/** The id Meta answered for a step made in this run, or a MetaWriteError that ends the run there (nothing more is sent). */
function madeIdOf(done: ReadonlyArray<{ request: MetaChangeRequest; result: MetaChangeResult }>, step: number, operation: string): string {
  const made = done.find((d) => d.request.step === step)
  const id = made ? createdIdOf(made.result.node) : null
  if (!id) throw new MetaWriteError(localFailure(`Not sent: step ${step} ${made ? 'gave no id in Meta\'s answer' : 'was not made'}, so nothing that stands on it was sent.`, 'POST_NO_PART_ID'), operation, 'not_sent')
  return id
}
const nodeOf = (done: ReadonlyArray<{ request: MetaChangeRequest; result: MetaChangeResult }>, operation: string) => done.find((d) => d.request.operation === operation)?.result.node ?? null
const idTextOf = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null)

const base = (step: number, label: string, objectId: string): Pick<MetaChangeRequest, 'step' | 'label' | 'objectId' | 'check' | 'raisesSpend' | 'readBackInPost' | 'budget' | 'undoable' | 'asPage' | 'explain'> => ({
  step, label, objectId, check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false, asPage: true, explain: POST_EXPLAIN,
})

// ── create-meta-page-post ─────────────────────────────────────────────────────────────────────────────────────────

export const POST_FORMATS = ['text', 'link', 'carousel', 'photos', 'video'] as const
export type PostFormat = typeof POST_FORMATS[number]
export const PUBLISH_MODES = ['dark', 'now', 'schedule'] as const
export type PublishMode = typeof PUBLISH_MODES[number]

/** A call to action (review B-F7: a link button goes to the post's own link — Meta: "This link should be the same as the link parameter"). */
export interface PostCta { type: string; phone?: string; latitude?: number; longitude?: number; address?: string }
export interface PostCard { link: string; name?: string; description?: string; image: PostImageSource }
export interface PagePostInput {
  format: PostFormat
  publish: PublishMode
  scheduledAt?: string
  message?: string
  link?: string
  name?: string
  description?: string
  image?: PostImageSource
  callToAction?: PostCta
  cards?: PostCard[]
  reorderCards?: boolean
  endCard?: boolean
  photos?: Array<PostImageSource & { altText?: string }>
  video?: PostVideoSource & { title?: string }
  audience?: { countries?: string[]; ageMin?: number }
  preferAudience?: { countries?: string[]; ageMin?: number; ageMax?: number }
  placeId?: string
}

/** What create-meta-page-post records (undo deletes the post while it is unpublished; remove-meta-page-post finds it by postId). */
export interface PagePostRecord {
  action: 'create'
  platform: 'facebook'
  format: PostFormat
  pageId: string
  postId: string | null
  photoIds: string[]
  videoId: string | null
  publish: PublishMode
  scheduledAt: number | null
}

/** A call to action as the gateway judges it (meta-post-rules.ts metaPostCtaProblem). */
function ctaValue(cta: PostCta, postLink: string | undefined, video: boolean): string | { problem: string } {
  const type = cta.type
  if (META_POST_CTA_REFUSED[type]) return { problem: `Nexus does not send the call to action ${type}: ${META_POST_CTA_REFUSED[type]}.` }
  if (!(META_POST_CTA_TYPES as readonly string[]).includes(type)) return { problem: `callToAction.type is one of ${META_POST_CTA_TYPES.join(', ')}.` }
  const extra = [cta.phone !== undefined && 'phone', (cta.latitude !== undefined || cta.longitude !== undefined || cta.address !== undefined) && 'latitude / longitude / address'].filter(Boolean)
  if (type === 'NO_BUTTON' || type === 'MESSAGE_PAGE') {
    if (extra.length) return { problem: `${type} carries nothing else (Meta: "no value is necessary"); leave out ${extra.join(', ')}.` }
    return JSON.stringify({ type })
  }
  if (type === 'CALL_NOW') {
    if (!cta.phone || cta.address !== undefined || cta.latitude !== undefined) return { problem: 'CALL_NOW takes phone only: +<country code><number>, digits only (Meta: "must start with a plus sign (+) and the country code").' }
    return JSON.stringify({ type, value: { link: `tel:${cta.phone}` } })
  }
  if (type === 'GET_DIRECTIONS') {
    if (cta.latitude === undefined || cta.longitude === undefined || !cta.address || cta.phone !== undefined) return { problem: 'GET_DIRECTIONS takes latitude, longitude and address only (Meta: "you must specify the coordinates").' }
    const n = (v: number) => String(Number(v.toFixed(6)))
    return JSON.stringify({ type, value: { link: `fbgeo://${n(cta.latitude)}, ${n(cta.longitude)}, "${cta.address}"`, ...(video ? { link_format: 'VIDEO_LPP' } : {}) } })
  }
  if (cta.phone !== undefined || cta.address !== undefined || cta.latitude !== undefined) return { problem: `${type} goes to the post's own link and takes nothing else.` }
  if (!postLink) return { problem: `${type} needs the post's link.` }
  return JSON.stringify({ type, value: { link: postLink } })
}

const audienceJson = (a: PagePostInput['audience']) => (a && (a.countries?.length || a.ageMin !== undefined)
  ? JSON.stringify({ ...(a.countries?.length ? { geo_locations: { countries: a.countries } } : {}), ...(a.ageMin !== undefined ? { age_min: a.ageMin } : {}) }) : null)
const preferJson = (a: PagePostInput['preferAudience']) => (a && (a.countries?.length || a.ageMin !== undefined || a.ageMax !== undefined)
  ? JSON.stringify({ ...(a.countries?.length ? { geo_locations: { countries: a.countries } } : {}), ...(a.ageMin !== undefined ? { age_min: a.ageMin } : {}), ...(a.ageMax !== undefined ? { age_max: a.ageMax } : {}) }) : null)

/** The arguments a format takes: one it does not take is refused before any read. */
function formatRefusal(input: PagePostInput): string | null {
  const f = input.format
  const given = (k: keyof PagePostInput) => input[k] !== undefined
  const allowed: Record<PostFormat, Array<keyof PagePostInput>> = {
    text: ['message', 'placeId'],
    link: ['message', 'link', 'name', 'description', 'image', 'callToAction', 'placeId'],
    carousel: ['message', 'link', 'cards', 'reorderCards', 'endCard', 'placeId'],
    photos: ['message', 'photos', 'placeId'],
    video: ['message', 'video', 'callToAction'],
  }
  const content: Array<keyof PagePostInput> = ['message', 'link', 'name', 'description', 'image', 'callToAction', 'cards', 'reorderCards', 'endCard', 'photos', 'video', 'placeId']
  const stray = content.find((k) => given(k) && !allowed[f].includes(k))
  if (stray) return `${stray} is not part of a ${f} post (a ${f} post takes ${allowed[f].join(', ')}).`
  if (f === 'text' && !input.message) return 'A text post has its message.'
  if (f === 'carousel' && (!input.link || !input.cards?.length)) return 'A carousel post has its link (the "see more" end card\'s) and its cards.'
  if (f === 'photos' && !input.photos?.length) return 'A photo post has its photos (1 to 10).'
  if (f === 'video' && !input.video) return 'A video post has its video.'
  if (f === 'link' && !input.link && !(input.callToAction && META_POST_LOCAL_CTAS.has(input.callToAction.type))) return 'A link post has its link.'
  if (input.publish === 'schedule' && !input.scheduledAt) return 'A scheduled post names scheduledAt (10 minutes to 30 days ahead).'
  if (input.publish !== 'schedule' && input.scheduledAt) return 'scheduledAt goes with publish: schedule.'
  if (f === 'photos' && input.publish === 'dark' && !META_DARK_PHOTO_POSTS_PROVEN) return 'A DARK photo post waits for a live check (LIVE-PROBES PG24-03: Meta deletes unpublished photos not "published" within 24 hours, and documents attached photos only for a published or scheduled post). For an ad, make the photo creative with create-meta-creative: its object_story_spec makes the dark post itself (Meta\'s inline post). A photo post that is public now or scheduled works here.'
  if (input.callToAction && META_POST_LOCAL_CTAS.has(input.callToAction.type) && input.publish !== 'dark') return `${input.callToAction.type} is a local-ad call to action (Meta: "Only used for local awareness ads"; the event-ads guide makes an UNPUBLISHED Page post for it): it goes on a dark post only (publish: dark).`
  if (f === 'video' && input.callToAction && (input.callToAction.type !== 'GET_DIRECTIONS' || input.publish !== 'dark')) return 'A video post takes only GET_DIRECTIONS, on an unpublished video for a local ad (Meta: "Video Page posts are available only if you use the GET_DIRECTIONS call to action"); put another button on the ad\'s creative (create-meta-creative).'
  return null
}

/** create-meta-page-post as a draft: its unpublished photos first (a photo post), then the post — or the video post. */
export async function pagePostCreateDraft(input: PagePostInput, ctx: { pageId: string; now?: number; placeTaken?: boolean }): Promise<MetaChangeDraft | { refusal: string }> {
  const refusal = formatRefusal(input)
  if (refusal) return { refusal }
  if (input.placeId && ctx.placeTaken) return { refusal: `Page ${input.placeId} is one another business in Nexus uses, so no post of this business tags it as its place.` }
  const now = ctx.now ?? Date.now()
  const pageId = ctx.pageId
  const scheduledAt = input.publish === 'schedule' ? unixOfIso(input.scheduledAt) : null
  if (input.publish === 'schedule') {
    if (scheduledAt === null) return { refusal: 'scheduledAt is a time (ISO 8601, e.g. 2026-11-01T09:00:00Z).' }
    const ahead = scheduledAt - Math.floor(now / 1000)
    if (ahead < META_POST_LIMITS.scheduleMinSec + 60) return { refusal: `scheduledAt is at least 11 minutes ahead (Meta takes 10 minutes at least; it is now ${isoOf(Math.floor(now / 1000))}).` }
    if (ahead > META_POST_LIMITS.scheduleMaxSec) return { refusal: 'scheduledAt is at most 30 days ahead (Meta\'s Pages API guide).' }
  }
  const published = input.publish === 'now' ? 'true' : 'false'
  const schedule = scheduledAt !== null ? { scheduled_publish_time: String(scheduledAt) } : {}
  const warnings: string[] = [POST_NO_CHECK, POST_NO_SPEND]
  const lines: Array<[string, unknown, unknown]> = [
    ['Post', 'none', `new ${input.format} post on the chosen Facebook Page ${pageId}`],
    ['Who sees it', null, input.publish === 'now' ? 'PUBLIC at once' : input.publish === 'dark' ? 'no one (unpublished, for ads)' : `PUBLIC from ${isoOf(scheduledAt!)}`],
    ...(input.message !== undefined ? [['Text (exactly as sent)', null, input.message] as [string, unknown, unknown]] : []),
  ]
  const requests: MetaChangeRequest[] = []
  const audience = audienceJson(input.audience)
  const prefer = preferJson(input.preferAudience)
  if (audience) lines.push(['Only these people can see it', null, input.audience])
  if (prefer) lines.push(['Shown more to', null, input.preferAudience])

  if (input.format === 'video') {
    const video = await videoLinkOf(input.video, 'video')
    if ('problem' in video) return { refusal: video.problem }
    let cta: string | undefined
    if (input.callToAction) {
      const value = ctaValue(input.callToAction, undefined, true)
      if (typeof value !== 'string') return { refusal: value.problem }
      cta = value
    }
    const params: Record<string, string> = {
      file_url: video.url, published,
      ...(input.video!.title !== undefined ? { title: input.video!.title } : {}),
      ...(input.message !== undefined ? { description: input.message } : {}),
      ...schedule,
      ...(input.publish === 'schedule' ? { unpublished_content_type: 'SCHEDULED' } : input.publish === 'dark' ? { unpublished_content_type: 'ADS_POST' } : {}),
      ...(cta ? { call_to_action: cta } : {}),
    }
    const judged = metaPageVideoProblem(new Map(Object.entries(params)), now)
    if (judged) return { refusal: `Nexus would not send this video post: ${judged}.` }
    if (audience || prefer) return { refusal: 'Nexus sets an audience on a text, link, carousel or photo post only (Meta\'s video post takes its own targeting shape, which Nexus does not send).' }
    requests.push({
      ...base(1, `Make the ${input.publish === 'now' ? 'PUBLIC' : input.publish === 'dark' ? 'UNPUBLISHED (for ads)' : 'SCHEDULED'} video post on the Facebook Page ${pageId} from ${video.source} (Meta fetches it)`, pageId),
      objectKind: 'postpage', edge: 'videos', operation: 'pagepost.video', params, readBackFields: 'id,post_id,published', explain: POST_EXPLAIN,
      // Review B-F1 — on Meta's video host, as every v26 example of POST /<page>/videos sends it.
      videoHost: true,
      doneSentence: (r) => `Video post: Meta took video ${idTextOf(r.node?.id) ?? '(no id)'}${idTextOf(r.node?.post_id) ? ` (post ${idTextOf(r.node?.post_id)})` : ''}; Meta fetches and processes the file now — meta-page-posts shows the post once it is ready.`,
    })
    lines.push(['Video', null, video.source])
    if (input.video!.title !== undefined) lines.push(['Video title (exactly as sent)', null, input.video!.title])
    if (cta) lines.push(['Call to action', null, cta])
    warnings.push('Meta fetches the video from its link and processes it after this answer: the post shows once Meta finishes (minutes for a long video); a link Meta cannot fetch fails there, in Meta\'s words.')
    warnings.push(input.publish === 'dark'
      ? 'An unpublished video for ads needs the Page\'s ADVERTISE task and pages_manage_ads, pages_show_list for the system user (Meta\'s videos reference).'
      : 'A published or scheduled video post needs the Page\'s CREATE_CONTENT task and pages_manage_posts, pages_read_engagement, pages_show_list, and publish_video (Meta\'s Pages API guide) on the system user\'s token.')
  } else {
    // A photo post: the photos go up UNPUBLISHED first, one request each; the post attaches them.
    const photoSteps: number[] = []
    const photoLines: Array<Record<string, unknown>> = []
    if (input.format === 'photos') {
      if (input.photos!.length > META_POST_LIMITS.photos) return { refusal: `A photo post has at most ${META_POST_LIMITS.photos} photos in Nexus.` }
      for (const [i, photo] of input.photos!.entries()) {
        const linked = await imageLinkOf(photo, `photos[${i}]`, false)
        if ('problem' in linked) return { refusal: linked.problem }
        if (!('url' in linked)) return { refusal: `photos[${i}] is a link (libraryImageId or imageUrl).` }
        const params: Record<string, string> = { url: linked.url, published: 'false', ...(scheduledAt !== null ? { temporary: 'true' } : {}), ...(photo.altText !== undefined ? { alt_text_custom: photo.altText } : {}) }
        const judged = metaPagePhotoProblem(new Map(Object.entries(params)))
        if (judged) return { refusal: `Nexus would not send photos[${i}]: ${judged}.` }
        const step = requests.length + 1
        photoSteps.push(step)
        requests.push({
          ...base(step, `Upload photo ${i + 1} of ${input.photos!.length} to the Facebook Page ${pageId}, UNPUBLISHED (${linked.source})`, pageId),
          objectKind: 'postpage', edge: 'photos', operation: 'pagepost.photo', params,
          doneSentence: (r) => `Photo ${i + 1}: Meta took it UNPUBLISHED (photo ${idTextOf(r.node?.id) ?? '(no id)'}); the post of step ${input.photos!.length + 1} attaches it.`,
        })
        photoLines.push({ photo: i + 1, source: linked.source, ...(photo.altText !== undefined ? { altText: photo.altText } : {}) })
      }
      lines.push(['Photos (alt text exactly as sent)', null, photoLines])
      warnings.push(`Each photo is its own request, UNPUBLISHED, before the post (Meta: "If you do not publish these photos within 24 hours, we delete them" — so if the post fails, the photos go by themselves). Meta takes photo files of at most 10 MB (JPEG, PNG, GIF, BMP, TIFF; a PNG best under 1 MB).`)
    }
    const fixed: Record<string, string> = { published }
    if (input.message !== undefined) fixed.message = input.message
    if (input.format === 'link' || input.format === 'carousel') {
      const localCta = input.callToAction && META_POST_LOCAL_CTAS.has(input.callToAction.type)
      const pageUrl = `https://www.facebook.com/${pageId}`
      if (localCta && input.link && linkOf(input.link) !== pageUrl) return { refusal: `With ${input.callToAction!.type} the post's link is the Page's own URL, ${pageUrl} (Meta: "Unless you use the LEARN_MORE call to action, the link must match your business's Facebook Page URL"); leave link out and Nexus uses it.` }
      fixed.link = localCta ? pageUrl : linkOf(input.link!)
      if (input.name !== undefined) { fixed.name = input.name; lines.push(['Link title (exactly as sent)', null, input.name]) }
      if (input.description !== undefined) { fixed.description = input.description; lines.push(['Link description (exactly as sent)', null, input.description]) }
      if (input.image) {
        const linked = await imageLinkOf(input.image, 'image', true)
        if ('problem' in linked) return { refusal: linked.problem }
        if ('hash' in linked) fixed.image_hash = linked.hash
        else fixed.picture = linked.url
        lines.push(['Link preview image', null, 'hash' in linked ? `library image ${linked.hash}` : linked.source])
      }
      if (input.callToAction) {
        const value = ctaValue(input.callToAction, fixed.link, false)
        if (typeof value !== 'string') return { refusal: value.problem }
        fixed.call_to_action = value
        lines.push(['Call to action', null, value])
        if (localCta) {
          warnings.push(`${input.callToAction.type} is a local-ad call to action (Meta's event-ads guide): the post links to the Page itself, and the ad that shows it runs with the objective OUTCOME_AWARENESS, optimization REACH, the Page as its promoted object and places in ONE country (no countries list).${input.callToAction.type === 'CALL_NOW' ? ' CALL_NOW: the ad set targets people 18 or older, in the phone number\'s own country, on mobile; no premium-rate number.' : ''}`)
        }
      }
      if (input.format === 'carousel') {
        const cards: Row[] = []
        const cardLines: Row[] = []
        const max = input.reorderCards ? META_POST_LIMITS.childrenOptimizedMax : META_POST_LIMITS.childrenMax
        if (input.cards!.length < META_POST_LIMITS.childrenMin || input.cards!.length > max) return { refusal: `A carousel post has ${META_POST_LIMITS.childrenMin} to ${max} cards (Meta: 2–5; up to 10 when it may reorder them, and then it shows the top 5).` }
        for (const [i, card] of input.cards!.entries()) {
          const linked = await imageLinkOf(card.image, `cards[${i}].image`, true)
          if ('problem' in linked) return { refusal: linked.problem }
          cards.push({ link: linkOf(card.link), ...(card.name !== undefined ? { name: card.name } : {}), ...(card.description !== undefined ? { description: card.description } : {}), ...('hash' in linked ? { image_hash: linked.hash } : { picture: linked.url }) })
          cardLines.push({ card: i + 1, link: linkOf(card.link), ...(card.name !== undefined ? { name: card.name } : {}), ...(card.description !== undefined ? { description: card.description } : {}), image: 'hash' in linked ? `library image ${linked.hash}` : linked.source })
        }
        lines.push(['Cards (exactly as sent)', null, cardLines])
        fixed.child_attachments = JSON.stringify(cards)
        // Meta's default is TRUE (it reorders the cards when the post runs in an ad): Nexus always says it.
        fixed.multi_share_optimized = String(input.reorderCards === true)
        fixed.multi_share_end_card = String(input.endCard !== false)
        lines.push(['Meta may reorder the cards in an ad (multi_share_optimized)', null, input.reorderCards === true ? 'yes (you opted in)' : 'no'])
        lines.push(['"See more" end card', null, input.endCard !== false ? 'shown' : 'not shown'])
        warnings.push(`Meta's multi_share_optimized lets Meta reorder the cards when the post runs in an ad, and Meta's default is ON: Nexus sends it ${input.reorderCards === true ? 'ON, as you asked' : 'OFF (reorderCards: true switches it on)'}.`)
      }
      if (input.name !== undefined || input.description !== undefined || input.image) warnings.push(POST_LINK_OWNERSHIP)
      lines.push(['Link', null, fixed.link])
    }
    if (audience) fixed.targeting = audience
    if (prefer) fixed.feed_targeting = prefer
    if (input.placeId) {
      fixed.place = input.placeId
      lines.push(['Place', null, `Page ${input.placeId}`])
    }
    Object.assign(fixed, schedule)
    if (scheduledAt !== null && photoSteps.length) fixed.unpublished_content_type = 'SCHEDULED'
    const placeholder = photoSteps.length ? { attached_media: JSON.stringify(photoSteps.map((s) => ({ media_fbid: String(9_000_000_000_000_000 + s) }))) } : {}
    const judged = metaPageFeedProblem(new Map(Object.entries({ ...fixed, ...placeholder })), now)
    if (judged) return { refusal: `Nexus would not send this post: ${judged}.` }
    const step = requests.length + 1
    const operation = 'pagepost.feed'
    requests.push({
      ...base(step, `Make the ${input.publish === 'now' ? 'PUBLIC' : input.publish === 'dark' ? 'UNPUBLISHED (dark)' : 'SCHEDULED'} ${input.format} post on the Facebook Page ${pageId}${photoSteps.length ? ` with the photos of step${photoSteps.length === 1 ? '' : 's'} ${photoSteps.join(', ')}` : ''}`, pageId),
      objectKind: 'postpage', edge: 'feed', operation,
      params: fixed,
      // Review B-F9 — a Page post's own fields (it has no status / effective_status).
      readBackFields: 'id,is_published,scheduled_publish_time,permalink_url',
      ...(photoSteps.length ? {
        planParams: { ...fixed, attached_media: JSON.stringify(photoSteps.map((s) => ({ media_fbid: `@${s}` }))) },
        needs: photoSteps,
        prepare: async (done) => ({ attached_media: JSON.stringify(photoSteps.map((s) => ({ media_fbid: madeIdOf(done, s, operation) }))) }),
      } : {}),
      explain: input.name !== undefined || input.description !== undefined || input.image ? { ...POST_EXPLAIN, 100: `Meta refused a value of the post (its words say which). ${POST_LINK_OWNERSHIP}` } : POST_EXPLAIN,
      doneSentence: (r) => `Post: Meta made it — ${idTextOf(r.node?.id) ?? '(Meta gave no id)'} (${input.publish === 'now' ? 'PUBLIC' : input.publish === 'dark' ? 'unpublished' : `scheduled for ${isoOf(scheduledAt!)}`}).`,
    })
  }
  if (input.publish === 'now') warnings.push(NOW_WORDS)
  else if (input.publish === 'dark') warnings.push(DARK_WORDS)
  else warnings.push(SCHEDULE_WORDS(scheduledAt!))
  warnings.push(POST_AS_PAGE, 'Meta lets an app change only the posts it made: set-meta-page-post edits this one later (its text, hidden, schedule, publish now).')
  if (audience) warnings.push('targeting limits who can see the post at all (Meta: "Anyone not in these demographics will not be able to view this content").')
  const { changes, more } = changeLines(lines)
  const record: PagePostRecord = { action: 'create', platform: 'facebook', format: input.format, pageId, postId: null, photoIds: [], videoId: null, publish: input.publish, scheduledAt }
  return {
    summary: `Make a ${input.format} post on the chosen Facebook Page — ${input.publish === 'now' ? 'PUBLIC at once' : input.publish === 'dark' ? 'unpublished (a dark post for ads)' : `scheduled, PUBLIC from ${isoOf(scheduledAt!)}`}. Nothing spends.`,
    changes,
    totals: { requests: requests.length, ...(input.photos?.length ? { photos: input.photos.length } : {}), ...(input.cards?.length ? { cards: input.cards.length } : {}), ...(more ? { moreLines: more } : {}) },
    warnings,
    spendsMoney: [],
    skipped: [],
    requests,
    stands: { pageId },
    before: record,
    after: record,
  }
}

/** What Meta made, from each done request: the post id, its photos, its video. */
export function pagePostMade(draft: MetaChangeDraft, done: ReadonlyArray<{ request: MetaChangeRequest; result: MetaChangeResult }>): PagePostRecord {
  const after = { ...(draft.after as PagePostRecord) }
  after.photoIds = done.filter((d) => d.request.operation === 'pagepost.photo').map((d) => createdIdOf(d.result.node)).filter((v): v is string => !!v)
  const feed = nodeOf(done, 'pagepost.feed')
  const video = nodeOf(done, 'pagepost.video')
  const feedId = idTextOf(feed?.id)
  if (feedId && /^\d{1,25}_\d{1,25}$/.test(feedId)) after.postId = feedId
  if (video) {
    after.videoId = createdIdOf(video)
    // Meta names a video's post by post_id (SDK advideo.py), as <page>_<post> or the post's own digits — often only later
    // (review B-F2): the record keeps the video id, and the undo and remove-meta-page-post find the post from it.
    after.postId = metaVideoPostIdOf(video.post_id, after.pageId)
  }
  return after
}

// ── set-meta-page-post ───────────────────────────────────────────────────────────────────────────────────────────

export interface PagePostEditInput {
  message?: string
  hidden?: boolean
  timelineVisibility?: 'hidden' | 'normal'
  scheduledAt?: string
  publishNow?: boolean
  sponsorPageId?: string
  sponsorCanBoost?: boolean
}
export interface PagePostEditFields {
  message?: string | null
  hidden?: boolean | null
  timelineVisibility?: string | null
  scheduledAt?: number | null
  published?: boolean | null
  sponsorPageId?: string | null
  sponsorCanBoost?: boolean | null
}
/** What set-meta-page-post records: the fields it changed, before and after (undo writes `before` back where Meta allows). */
export interface PagePostEditRecord { action: 'edit'; pageId: string; postId: string; fields: PagePostEditFields }

/** set-meta-page-post as a draft: ONE request on the post, the fields asked that differ from now. */
/**
 * The creatives of the chosen ad account that show the post, as the tool read them (review A-4): read for a text edit, a
 * publish now and a new schedule; 'unreadable' when Meta did not answer that read; null when not read.
 */
export type CreativesUsing = { creativeIds: string[]; complete: boolean } | 'unreadable' | null

export function pagePostEditDraft(input: PagePostEditInput, state: PagePostState, ctx: { now?: number; creativesUsing?: CreativesUsing; sponsorTaken?: boolean }): MetaChangeDraft | { refusal: string } {
  const now = ctx.now ?? Date.now()
  if (!state.byThePage) return { refusal: `Post ${state.postId} was not written by the chosen Facebook Page (a visitor's post is not the Page's to change).` }
  const asked = Object.entries(input).filter(([, v]) => v !== undefined)
  if (!asked.length) return { refusal: 'Name what to change: message, hidden, timelineVisibility, scheduledAt, publishNow, sponsorPageId or sponsorCanBoost.' }
  if (input.publishNow && input.scheduledAt) return { refusal: 'Publish now or schedule — not both.' }
  if (input.publishNow !== undefined && input.publishNow !== true) return { refusal: 'publishNow is true (Nexus never un-publishes a post: Meta documents no way back).' }
  const params: Record<string, string> = {}
  const expect: Record<string, string> = {}
  const before: PagePostEditFields = {}
  const after: PagePostEditFields = {}
  const skipped: string[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = [POST_NO_CHECK, POST_NO_SPEND, POST_AS_PAGE]
  if (input.message !== undefined) {
    if (input.message === state.message) skipped.push('The text already reads so.')
    else {
      params.message = input.message; expect.message = input.message
      before.message = state.message; after.message = input.message
      lines.push(['Text (exactly as sent)', state.message, input.message])
    }
  }
  if (input.hidden !== undefined) {
    if (input.hidden === state.hidden) skipped.push(`The post is already ${input.hidden ? 'hidden' : 'shown'} on the Page.`)
    else {
      params.is_hidden = String(input.hidden); expect.is_hidden = String(input.hidden)
      before.hidden = state.hidden; after.hidden = input.hidden
      lines.push(['Hidden from the Page', state.hidden, input.hidden])
    }
  }
  if (input.timelineVisibility !== undefined) {
    if (input.timelineVisibility === state.timelineVisibility) skipped.push(`Its timeline visibility is already ${input.timelineVisibility}.`)
    else {
      params.timeline_visibility = input.timelineVisibility; expect.timeline_visibility = input.timelineVisibility
      before.timelineVisibility = state.timelineVisibility; after.timelineVisibility = input.timelineVisibility
      lines.push(['Timeline visibility', state.timelineVisibility, input.timelineVisibility])
    }
  }
  if (input.scheduledAt !== undefined) {
    const at = unixOfIso(input.scheduledAt)
    if (at === null) return { refusal: 'scheduledAt is a time (ISO 8601, e.g. 2026-11-01T09:00:00Z).' }
    if (state.published !== false) return { refusal: `Post ${state.postId} is already published: only an unpublished (dark or scheduled) post takes a schedule.` }
    const ahead = at - Math.floor(now / 1000)
    if (ahead < META_POST_LIMITS.scheduleMinSec + 60) return { refusal: 'scheduledAt is at least 11 minutes ahead (Meta takes 10 minutes at least).' }
    if (ahead > META_POST_LIMITS.scheduleMaxSec) return { refusal: 'scheduledAt is at most 30 days ahead (Meta\'s Pages API guide).' }
    if (at === state.scheduledAt) skipped.push('It is already scheduled for that time.')
    else {
      params.scheduled_publish_time = String(at)
      before.scheduledAt = state.scheduledAt; after.scheduledAt = at
      lines.push(['Goes public at', state.scheduledAt ? isoOf(state.scheduledAt) : 'not scheduled (unpublished)', isoOf(at)])
      warnings.push(SCHEDULE_WORDS(at))
    }
  }
  if (input.publishNow) {
    if (state.published === true) skipped.push('The post is already published.')
    else {
      params.is_published = 'true'; expect.is_published = 'true'
      before.published = state.published; after.published = true
      lines.push(['Published', state.published, 'PUBLIC now'])
      warnings.push(`PUBLIC AT ONCE: once Meta takes it, the post is on the Page for everyone. This is ONE WAY — Nexus never un-publishes a post (Meta documents no way back); remove-meta-page-post deletes it on an explicit ask. Meta's reference lists is_published as an update parameter without describing it (master MD-112): Meta's answer decides, in its words.`)
    }
  }
  if (input.sponsorPageId !== undefined || input.sponsorCanBoost !== undefined) {
    const current = state.sponsorPageIds
    const sponsor = input.sponsorPageId ?? (current?.length === 1 ? current[0] : undefined)
    if (!sponsor) return { refusal: 'sponsorCanBoost goes with the post\'s brand partner: name sponsorPageId (the post has none, or Nexus could not read it).' }
    if (!/^[1-9]\d{0,24}$/.test(sponsor)) return { refusal: 'sponsorPageId is a Facebook Page id (digits).' }
    if (sponsor === state.pageId) return { refusal: 'The sponsor is a brand partner\'s Page, never the chosen Page itself.' }
    if (ctx.sponsorTaken) return { refusal: `Page ${sponsor} is one another business in Nexus uses, so no post of this business tags it.` }
    const same = current?.length === 1 && current[0] === sponsor
    if (same && input.sponsorCanBoost === undefined) skipped.push(`Page ${sponsor} is already the post's paid partner.`)
    else {
      params.sponsor_id = sponsor
      if (input.sponsorCanBoost !== undefined) params.direct_share_status = input.sponsorCanBoost ? '1' : '0'
      before.sponsorPageId = current === null ? null : current[0] ?? null
      after.sponsorPageId = sponsor
      if (input.sponsorCanBoost !== undefined) { before.sponsorCanBoost = null; after.sponsorCanBoost = input.sponsorCanBoost }
      lines.push(['Paid partner (sponsor)', current === null ? 'not read' : current.length ? current.join(', ') : 'none', sponsor])
      if (input.sponsorCanBoost !== undefined) lines.push(['The brand may boost it', 'not read', input.sponsorCanBoost ? 'yes' : 'no'])
      warnings.push('Branded content (Meta\'s branded-content guide): the Page must be eligible for branded content (a verified Page with the branded content tool), and the post follows Meta\'s Branded Content Policy. Meta documents no removal of a paid-partner tag by API — only a change to another brand: the undo puts back the brand that was there, and cannot take a first one off.')
    }
  }
  if (!Object.keys(params).length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  const judged = metaPagePostEditProblem(new Map(Object.entries(params)), now)
  if (judged) return { refusal: `Nexus would not send this edit: ${judged}.` }
  // Review A-4 — the ads that show this post, for a text edit, a publish now and a new schedule (or why they are not named).
  const uses = ctx.creativesUsing
  const touchesAds = params.message !== undefined || params.is_published !== undefined || params.scheduled_publish_time !== undefined
  if (touchesAds && uses === 'unreadable') warnings.push('Nexus could not read which ads show this post (the chosen ad account\'s creatives): an ad that shows it would show this change at once.')
  else if (touchesAds && uses && uses !== 'unreadable') {
    const n = uses.creativeIds.length
    if (n) {
      const what = [params.message !== undefined && 'the new text at once (Meta does not document whether an edit sends those ads back to review)', (params.is_published !== undefined || params.scheduled_publish_time !== undefined) && 'a post that is PUBLIC on the Page once it is published (its likes and comments show there too)'].filter(Boolean).join(', and ')
      warnings.push(`${plural(n, 'creative')} of the chosen ad account show${n === 1 ? 's' : ''} this post (${uses.creativeIds.join(', ')}): their ads show ${what}.`)
    } else if (!uses.complete) warnings.push('Nexus read the first 500 creatives of the chosen ad account and none shows this post; an older one may, and its ad would show this change at once.')
  }
  // Review A-3 — the undo's truth in the preview: what it cannot write back.
  const noUndo = editUndoProblem(before, now)
  if (noUndo.length) warnings.push(`No undo for this edit: ${noUndo.join('; ')}.`)
  if (!state.nexusMade) warnings.push('Meta lets an app change only the posts it made ("An app can only update a Page post if the post was made using that app"): Nexus\'s records do not name this post as one it made, so Meta may refuse it, in its own words.')
  const { changes, more } = changeLines(lines)
  const record = { action: 'edit' as const, pageId: state.pageId, postId: state.postId }
  return {
    summary: `Change post ${state.postId} of the chosen Facebook Page: ${lines.map(([label]) => label.replace(/ \(exactly as sent\)$/, '').toLowerCase()).join(', ')}. Nothing spends.`,
    changes,
    totals: { fields: Object.keys(params).length, requests: 1, ...(more ? { moreLines: more } : {}) },
    warnings,
    spendsMoney: [],
    skipped,
    requests: [{
      ...base(1, `Change post ${state.postId} on the Facebook Page ${state.pageId} (${Object.keys(params).join(', ')})`, state.postId),
      objectKind: 'pagepostedit', operation: 'pagepost.update', params, expect,
      readBackFields: 'id,message,is_hidden,is_published,scheduled_publish_time,timeline_visibility',
      undoable: !params.is_published,
    }],
    stands: { postId: state.postId, message: state.message, hidden: state.hidden, published: state.published, scheduledAt: state.scheduledAt, timelineVisibility: state.timelineVisibility, sponsorPageIds: state.sponsorPageIds },
    before: { ...record, fields: before } satisfies PagePostEditRecord,
    after: { ...record, fields: after } satisfies PagePostEditRecord,
  }
}

/** Why each part of an edit's undo cannot write its value back (empty: all of it can; the old text must be sendable as it was). */
export function editUndoProblem(fields: PagePostEditFields, now: number = Date.now()): string[] {
  const out: string[] = []
  if (fields.message !== undefined && (fields.message === null || metaPostTextProblem(fields.message, META_POST_LIMITS.message, 'message', true))) out.push('the old text is not one Nexus can send again exactly (none, or a Page tag)')
  if (fields.published !== undefined) out.push('a publish is one way (Meta documents no un-publish)')
  if (fields.scheduledAt !== undefined && (fields.scheduledAt === null || fields.scheduledAt - Math.floor(now / 1000) < META_POST_LIMITS.scheduleMinSec + 60)) out.push('the old schedule is gone or too close (Meta takes 10 minutes ahead at least)')
  if (fields.sponsorPageId !== undefined && !fields.sponsorPageId) out.push('Meta documents no removal of a first paid-partner tag')
  if (fields.sponsorCanBoost !== undefined && fields.sponsorCanBoost === null) out.push('whether the brand could boost it before was not readable')
  if (fields.timelineVisibility !== undefined && !['hidden', 'normal'].includes(fields.timelineVisibility ?? '')) out.push('the old timeline visibility was not hidden or normal')
  if (fields.hidden !== undefined && fields.hidden === null) out.push('the old hidden state was not readable')
  return out
}

// ── remove-meta-page-post ───────────────────────────────────────────────────────────────────────────────────────────

export interface PostRemoveRecord { action: 'remove'; platform: 'facebook' | 'instagram'; pageId?: string; instagramId?: string; postId?: string; videoId?: string; mediaId?: string; published?: boolean | null; deleted: boolean }

const usedRefusal = (uses: { creativeIds: string[]; complete: boolean }, what: string): string | null => {
  if (uses.creativeIds.length) return `${what} is shown by ${plural(uses.creativeIds.length, 'creative')} of the chosen ad account (${uses.creativeIds.join(', ')}): Nexus never deletes what an ad shows. Remove those ads and creatives first (remove-meta-ads-items).`
  if (!uses.complete) return `Nexus read the first 500 creatives of the chosen ad account and could not read them all: it does not delete ${what} unless it can confirm no ad shows it.`
  return null
}

/**
 * remove-meta-page-post (Facebook) as a draft: ONE DELETE of a post Nexus made, which no creative shows (by the post, or by a
 * video post's video). A video post names its video to the gateway (`pagevideo`), whose owner check reads that one video.
 */
export function pagePostRemoveDraft(state: PagePostState, uses: { creativeIds: string[]; complete: boolean }): MetaChangeDraft | { refusal: string } {
  const videoId = state.videoId
  if (!state.nexusMade) return { refusal: `Post ${state.postId} is not one Nexus made (create-meta-page-post): Nexus deletes only its own posts. A person deletes another in Meta Business Suite.` }
  const used = usedRefusal(uses, `Post ${state.postId}`)
  if (used) return { refusal: used }
  const record = { action: 'remove' as const, platform: 'facebook' as const, pageId: state.pageId, postId: state.postId, ...(videoId ? { videoId } : {}), published: state.published }
  return {
    summary: `Delete post ${state.postId} that Nexus made on the chosen Facebook Page (${state.published ? 'it is PUBLIC now' : 'unpublished'}) — for good. Nothing spends.`,
    changes: { [`Post ${state.postId}`]: { from: state.published ? 'public on the Page' : state.scheduledAt ? `scheduled for ${isoOf(state.scheduledAt)}` : 'unpublished (dark)', to: 'deleted' } },
    totals: { requests: 1 },
    warnings: [
      POST_NO_CHECK, POST_AS_PAGE,
      `FINAL: a deleted post cannot come back (no undo)${state.published ? ' — it is public now: its reactions, comments and numbers go with it' : ''}. To take it off the Page but keep it, set-meta-page-post hidden: true.`,
      POST_DELETE_SELECT,
    ],
    spendsMoney: [], skipped: [],
    requests: [{
      ...base(1, `Delete post ${state.postId} from the Facebook Page ${state.pageId}`, state.postId),
      objectKind: 'pagepostmade', operation: 'pagepost.delete', method: 'DELETE', params: {}, explain: DELETE_EXPLAIN,
      ...(videoId ? { parent: { kind: 'pagevideo' as const, id: videoId } } : {}),
    }],
    stands: { postId: state.postId, published: state.published, nexusMade: true, usedBy: uses.creativeIds },
    before: { ...record, deleted: false } satisfies PostRemoveRecord,
    after: { ...record, deleted: true } satisfies PostRemoveRecord,
  }
}

/** remove-meta-page-post (Instagram) as a draft: ONE DELETE of a media Nexus published, which no creative shows. */
export function igMediaRemoveDraft(state: IgMediaState, uses: { creativeIds: string[]; complete: boolean }): MetaChangeDraft | { refusal: string } {
  if (!state.nexusMade) return { refusal: `Instagram media ${state.mediaId} is not one Nexus published (create-meta-instagram-post): Nexus deletes only its own posts. A person deletes another in the Instagram app.` }
  if (state.productType === 'AD') return { refusal: `Instagram media ${state.mediaId} is an ad's media: Meta's delete covers "Non-ad posts, Stories, Reels and entire carousel albums" only.` }
  const used = usedRefusal(uses, `Instagram media ${state.mediaId}`)
  if (used) return { refusal: used }
  const record = { action: 'remove' as const, platform: 'instagram' as const, instagramId: state.instagramId, mediaId: state.mediaId, published: true }
  return {
    summary: `Delete Instagram ${state.productType === 'STORY' ? 'story' : state.productType === 'REELS' ? 'reel' : 'post'} ${state.mediaId} that Nexus published on the chosen Instagram account — for good. Nothing spends.`,
    changes: { [`Instagram media ${state.mediaId}`]: { from: 'public on the account', to: 'deleted' } },
    totals: { requests: 1 },
    warnings: [
      POST_NO_CHECK, POST_AS_PAGE,
      'FINAL: a deleted Instagram post cannot come back (no undo): its likes, comments and numbers go with it. A carousel is deleted whole (Meta: "Individually deleting media within a carousel is not supported").',
      'Meta deletes Instagram media only with instagram_manage_contents on the token (Facebook Login): if the token lacks it, Meta refuses in its words and nothing changes.',
    ],
    spendsMoney: [], skipped: [],
    requests: [{
      ...base(1, `Delete Instagram media ${state.mediaId} from the chosen Instagram account ${state.instagramId}`, state.mediaId),
      objectKind: 'igmediamade', operation: 'igmedia.delete', method: 'DELETE', params: {}, explain: IG_EXPLAIN,
    }],
    stands: { mediaId: state.mediaId, productType: state.productType, nexusMade: true, usedBy: uses.creativeIds },
    before: { ...record, deleted: false } satisfies PostRemoveRecord,
    after: { ...record, deleted: true } satisfies PostRemoveRecord,
  }
}

// ── create-meta-instagram-post ────────────────────────────────────────────────────────────────────────────────────

export const IG_POST_KINDS = ['image', 'reel', 'story', 'carousel', 'upcoming-event', 'publish-container'] as const
export type IgPostKind = typeof IG_POST_KINDS[number]
export interface IgTag { username: string; x?: number; y?: number }
export interface IgItemInput { image?: PostImageSource; video?: PostVideoSource; altText?: string; userTags?: IgTag[]; productTags?: MetaIgProductTag[] }
export interface IgEventInput { title: string; startTime: string; endTime?: string; notifications?: string[]; notifyRelativeTo?: 'EVENT_START' | 'EVENT_END' }
export interface IgPostInput {
  kind: IgPostKind
  image?: PostImageSource
  video?: PostVideoSource
  altText?: string
  items?: IgItemInput[]
  caption?: string
  collaborators?: string[]
  userTags?: IgTag[]
  locationId?: string
  sponsorInstagramIds?: string[]
  paidPartnership?: boolean
  aiGenerated?: boolean
  shareToFeed?: boolean
  cover?: PostImageSource
  thumbOffsetMs?: number
  audioName?: string
  trial?: 'MANUAL' | 'SS_PERFORMANCE'
  event?: IgEventInput
  containerId?: string
  /** Step 35 (Q9): products tagged on a feed image or a reel (a carousel tags them on its items). */
  productTags?: MetaIgProductTag[]
}

/** What create-meta-instagram-post records (remove-meta-page-post finds its media by mediaId; a later run publishes containerId). */
export interface IgPostRecord {
  action: 'create'
  platform: 'instagram'
  kind: IgPostKind
  instagramId: string
  containerId: string | null
  itemContainerIds: string[]
  mediaId: string | null
  eventId: string | null
  /** Step 35 (Q9): it carried product tags (Meta's 25 tagged posts a day per account count it). */
  productTagged?: true
}

/**
 * Wait until Meta says the container is FINISHED (one read at once, then one a minute — `deadline`: the run's 5 minutes,
 * shared by every container it waits for), then the publish may go. Throws a MetaWriteError (not_sent: nothing more is sent) when it failed, expired, is
 * already published or is still in progress.
 */
export async function waitForContainer(connectionId: string, containerId: string, video: boolean, operation: string, deadline?: number): Promise<IgContainerState | null> {
  const polls = video ? __postTiming.videoPolls : __postTiming.imagePolls
  let state: IgContainerState | null = null
  for (let i = 0; i <= polls; i++) {
    if (i) {
      if (deadline !== undefined && Date.now() >= deadline) break
      await __postTiming.sleep(__postTiming.pollMs)
    }
    try {
      state = await liveIgContainer(connectionId, containerId)
    } catch (err) {
      const words = err instanceof MetaReadError ? err.message : err instanceof Error ? err.message : String(err)
      throw new MetaWriteError(localFailure(`Not sent: Nexus could not read container ${containerId}'s status (${words}). It stays 24 hours: ask again with kind publish-container and containerId ${containerId}.`, 'IG_CONTAINER_UNREAD'), operation, 'not_sent')
    }
    // Meta answers no status to the business's token: the publish's own answer decides.
    if (state === null) return null
    if (state.statusCode === 'FINISHED') return state
    if (state.statusCode === 'ERROR' || state.statusCode === 'EXPIRED' || state.statusCode === 'PUBLISHED') {
      const why = state.statusCode === 'ERROR' ? `Meta could not prepare it${state.status ? ` (${state.status})` : ''}` : state.statusCode === 'EXPIRED' ? 'it expired (Meta keeps a container 24 hours)' : 'it is already published'
      throw new MetaWriteError(localFailure(`Not sent: container ${containerId} cannot be published — ${why}.`, `IG_CONTAINER_${state.statusCode}`), operation, 'not_sent')
    }
  }
  throw new MetaWriteError(localFailure(`Not sent yet: Meta is still preparing container ${containerId} (${state?.statusCode ?? 'IN_PROGRESS'}). Nothing is public. It stays 24 hours: ask again with kind publish-container and containerId ${containerId} to publish it once Meta finishes.`, 'IG_CONTAINER_IN_PROGRESS'), operation, 'not_sent')
}

const tagsJson = (tags: IgTag[] | undefined) => (tags?.length ? JSON.stringify(tags.map((t) => (t.x !== undefined || t.y !== undefined ? { username: t.username, x: t.x, y: t.y } : { username: t.username }))) : null)
/** Step 35 (Q9) — product tags as Meta takes them on a container (meta-instagram-tags.ts: one spelling; x / y on an image only). */
const productTagsJson = (tags: MetaIgProductTag[] | undefined, target: MetaIgTagTarget) => (tags?.length ? metaIgProductTagsParam(tags, target) : null)

/** The arguments a kind takes: one it does not take is refused before any read. */
function igKindRefusal(input: IgPostInput): string | null {
  const allowed: Record<IgPostKind, Array<keyof IgPostInput>> = {
    image: ['image', 'altText', 'caption', 'collaborators', 'userTags', 'locationId', 'sponsorInstagramIds', 'paidPartnership', 'aiGenerated', 'productTags'],
    reel: ['video', 'caption', 'collaborators', 'userTags', 'locationId', 'sponsorInstagramIds', 'paidPartnership', 'aiGenerated', 'shareToFeed', 'cover', 'thumbOffsetMs', 'audioName', 'trial', 'productTags'],
    story: ['image', 'video', 'userTags'],
    carousel: ['items', 'caption', 'collaborators', 'locationId', 'sponsorInstagramIds', 'paidPartnership', 'aiGenerated'],
    'upcoming-event': ['event'],
    'publish-container': ['containerId'],
  }
  const keys: Array<keyof IgPostInput> = ['image', 'video', 'altText', 'items', 'caption', 'collaborators', 'userTags', 'locationId', 'sponsorInstagramIds', 'paidPartnership', 'aiGenerated', 'shareToFeed', 'cover', 'thumbOffsetMs', 'audioName', 'trial', 'event', 'containerId', 'productTags']
  const stray = keys.find((k) => input[k] !== undefined && !allowed[input.kind].includes(k))
  if (stray) {
    const why: Partial<Record<keyof IgPostInput, string>> = {
      caption: 'Meta takes no caption on a story', altText: 'Meta takes alt text on images only (not reels or stories; a carousel\'s image takes its own)',
      collaborators: 'Meta takes collaborators on a feed image, a reel or a carousel only', locationId: 'Meta takes no place on a story',
      userTags: input.kind === 'carousel' ? 'a carousel tags people on each item (items[].userTags)' : 'not here',
      productTags: input.kind === 'carousel' ? 'a carousel tags products on each item (items[].productTags; Meta: 5 an item, 20 in all)' : input.kind === 'story' ? 'Meta takes no product tags on a story' : 'not here',
    }
    return `${stray} is not part of an Instagram ${input.kind}${why[stray] ? ` (${why[stray]})` : ''}; a ${input.kind} takes ${allowed[input.kind].join(', ')}.`
  }
  if (input.kind === 'image' && !input.image) return 'An Instagram image post has its image.'
  if (input.kind === 'reel' && !input.video) return 'A reel has its video.'
  if (input.kind === 'story' && !!input.image === !!input.video) return 'A story has an image or a video (one of them).'
  if (input.kind === 'carousel' && (!input.items || input.items.length < META_POST_LIMITS.carouselMin || input.items.length > META_POST_LIMITS.carouselMax)) return `A carousel has ${META_POST_LIMITS.carouselMin} to ${META_POST_LIMITS.carouselMax} items (Meta: up to 20).`
  if (input.kind === 'upcoming-event' && !input.event) return 'An upcoming event has its title and start time (event).'
  if (input.kind === 'publish-container' && !input.containerId) return 'Name the container to publish (containerId, from an earlier create-meta-instagram-post).'
  if (input.paidPartnership === false && input.sponsorInstagramIds?.length) return 'paidPartnership cannot be false with sponsors (Meta: "Automatically set to true when branded_content_sponsor_ids is provided").'
  if (input.kind === 'carousel' && input.items?.some((i) => i.productTags?.length) && input.items.some((i) => i.video && i.productTags?.some((t) => t.x !== undefined || t.y !== undefined))) return 'A carousel video item takes product tags without a place (x and y are for images only).'
  const productTagsInAll = (input.productTags?.length ?? 0) + (input.items ?? []).reduce((n, i) => n + (i.productTags?.length ?? 0), 0)
  if (input.kind === 'carousel' && productTagsInAll > META_IG_TAG_LIMITS.carouselPost) return `A carousel takes at most ${META_IG_TAG_LIMITS.carouselPost} product tags in all (${productTagsInAll} asked; Meta: 5 an item).`
  return null
}

export interface IgDraftContext {
  instagramId: string
  connectionId: string
  quota: { usage: number; total: number } | null
  /** Sponsors and the place another Nexus business uses (checked before; the gateway checks again), a collaborator too. */
  takenSponsor?: string | null
  takenLocation?: boolean
  takenCollaborator?: string | null
  /** publish-container: the recorded container's status now (null: Meta answered none). */
  container?: { made: boolean; state: IgContainerState | null }
  now?: number
  /** Step 35 (Q9): what the tool read of the tagged products and the account (review status, eligibility, the day's count). */
  productTagNotes?: string[]
}

/** create-meta-instagram-post as a draft: the container(s), then the publish; or an upcoming event; or a recorded container's publish. */
export async function igPostCreateDraft(input: IgPostInput, ctx: IgDraftContext): Promise<MetaChangeDraft | { refusal: string }> {
  const refusal = igKindRefusal(input)
  if (refusal) return { refusal }
  const ig = ctx.instagramId
  const now = ctx.now ?? Date.now()
  const warnings: string[] = [POST_NO_CHECK, POST_NO_SPEND]
  const lines: Array<[string, unknown, unknown]> = []
  const requests: MetaChangeRequest[] = []
  const record: IgPostRecord = { action: 'create', platform: 'instagram', kind: input.kind, instagramId: ig, containerId: null, itemContainerIds: [], mediaId: null, eventId: null }
  const finishDraft = (summary: string): MetaChangeDraft => {
    warnings.push(POST_AS_PAGE)
    const { changes, more } = changeLines(lines)
    return { summary, changes, totals: { requests: requests.length, ...(more ? { moreLines: more } : {}) }, warnings, spendsMoney: [], skipped: [], requests, stands: { instagramId: ig, kind: input.kind }, before: record, after: record }
  }

  if (input.kind === 'upcoming-event') {
    const e = input.event!
    const start = unixOfIso(e.startTime)
    const end = e.endTime !== undefined ? unixOfIso(e.endTime) : null
    if (start === null || (e.endTime !== undefined && end === null)) return { refusal: 'startTime and endTime are times (ISO 8601, e.g. 2026-11-30T19:00:00Z).' }
    const metaTime = (unix: number) => `${new Date(unix * 1000).toISOString().slice(0, 19)}+0000`
    const params: Record<string, string> = {
      title: e.title, start_time: metaTime(start), ...(end !== null ? { end_time: metaTime(end) } : {}),
      ...(e.notifications?.length ? { notification_subtypes: JSON.stringify(e.notifications) } : {}),
      ...(e.notifyRelativeTo ? { notification_target_time: e.notifyRelativeTo } : {}),
    }
    const judged = metaIgEventProblem(new Map(Object.entries(params)), now)
    if (judged) return { refusal: `Nexus would not send this event: ${judged}.` }
    requests.push({
      ...base(1, `Make the upcoming event "${e.title}" (${isoOf(start)}) on the Instagram account ${ig}`, ig),
      objectKind: 'postig', edge: 'upcoming_events', operation: 'iguser.upcomingEvent', params, readBackFields: 'id,title,start_time', explain: IG_EXPLAIN,
      doneSentence: (r) => `Upcoming event: Meta made it (${idTextOf(r.node?.id) ?? 'no id'}); a reminder ad uses it (create-meta-creative, asset_feed_spec upcoming_events).`,
    })
    lines.push(['Upcoming event', 'none', `"${e.title}", ${isoOf(start)}${end !== null ? ` to ${isoOf(end)}` : ''}`])
    if (e.notifications?.length) lines.push(['Reminders', null, e.notifications.join(', ')])
    warnings.push('An upcoming event is shown to the people who see a reminder ad or the account\'s post, who can ask to be reminded. Meta documents no delete of an upcoming event by API (no undo): it ends at its time.', 'It needs instagram_manage_upcoming_events on the token (Meta\'s guide), and a professional account linked to a business.')
    return finishDraft(`Make the upcoming event "${e.title}" on the chosen Instagram account (for reminder ads). Nothing spends.`)
  }

  // Every publish: Instagram's own limit of API posts in 24 hours (read now; a carousel counts as one).
  if (ctx.quota && ctx.quota.usage >= ctx.quota.total) return { refusal: `The chosen Instagram account has used Instagram's limit of ${ctx.quota.total} API posts in the last 24 hours (${ctx.quota.usage}): ask again later.` }
  warnings.push(ctx.quota ? `Instagram's limit: ${ctx.quota.usage} of ${ctx.quota.total} API posts used in the last 24 hours; this uses one.` : 'Nexus could not read Instagram\'s publishing limit (about 50–100 API posts in 24 hours): if it is reached, Meta refuses the publish in its words.')

  if (input.kind === 'publish-container') {
    const id = input.containerId!
    if (!ctx.container?.made) return { refusal: `Container ${id} is not one an earlier create-meta-instagram-post of this business made on the chosen Instagram account: Nexus publishes only its own containers (a container has no owner Meta names).` }
    const code = ctx.container.state?.statusCode
    if (code === 'PUBLISHED') return { refusal: `Container ${id} is already published.` }
    if (code === 'EXPIRED') return { refusal: `Container ${id} expired (Meta keeps a container 24 hours): post it again.` }
    if (code === 'ERROR') return { refusal: `Meta could not prepare container ${id}${ctx.container.state?.status ? ` (${ctx.container.state.status})` : ''}: post it again.` }
    const operation = 'igmedia.publish'
    requests.push({
      ...base(1, `PUBLISH container ${id} on the Instagram account ${ig} — public at once`, ig),
      objectKind: 'postig', edge: 'media_publish', operation, params: { creation_id: id }, readBackFields: 'id,permalink,media_product_type', explain: IG_EXPLAIN,
      // A container still in progress is waited for (at most a minute) before the publish.
      prepare: async () => { await waitForContainer(ctx.connectionId, id, true, operation); return {} },
      doneSentence: (r) => publishedSentence(r),
    })
    record.containerId = id
    lines.push([`Container ${id}`, code ?? 'status not read', 'PUBLISHED (public)'])
    warnings.push(IG_PUBLIC, IG_NO_EDIT)
    return finishDraft(`Publish container ${id} on the chosen Instagram account — PUBLIC at once. Nothing spends.`)
  }

  // The sponsors and the place (CR-367): never the chosen account, never another Nexus business's.
  if (input.sponsorInstagramIds?.length) {
    if (input.sponsorInstagramIds.length > META_POST_LIMITS.sponsors) return { refusal: `At most ${META_POST_LIMITS.sponsors} brands are tagged as paid partners (Meta's limit).` }
    if (input.sponsorInstagramIds.includes(ig)) return { refusal: 'A paid-partner tag names a brand, never the chosen Instagram account itself (Meta: "Cannot tag yourself as sponsor").' }
    if (ctx.takenSponsor) return { refusal: `Instagram account ${ctx.takenSponsor} is one another business in Nexus uses, so no post of this business tags it.` }
  }
  if (ctx.takenCollaborator) return { refusal: `Instagram account ${ctx.takenCollaborator} is one another business in Nexus uses, so no post of this business invites or tags it.` }
  if (input.locationId && ctx.takenLocation) return { refusal: `Page ${input.locationId} is one another business in Nexus uses, so no post of this business tags it as its place.` }
  const common: Record<string, string> = {}
  if (input.caption !== undefined) common.caption = input.caption
  if (input.collaborators?.length) common.collaborators = JSON.stringify(input.collaborators)
  if (input.locationId) common.location_id = input.locationId
  if (input.aiGenerated !== undefined) common.is_ai_generated = String(input.aiGenerated)
  if (input.sponsorInstagramIds?.length) common.branded_content_sponsor_ids = `[${input.sponsorInstagramIds.join(',')}]`
  if (input.paidPartnership !== undefined) common.is_paid_partnership = String(input.paidPartnership)
  if (input.caption !== undefined) lines.push(['Caption (exactly as sent)', null, input.caption])
  if (input.collaborators?.length) lines.push(['Collaborators (invited)', null, input.collaborators.join(', ')])
  if (input.locationId) lines.push(['Place', null, `Page ${input.locationId}`])
  if (input.sponsorInstagramIds?.length || input.paidPartnership) lines.push(['Paid partnership label', null, input.sponsorInstagramIds?.length ? `brands ${input.sponsorInstagramIds.join(', ')}` : 'label only'])
  if (input.aiGenerated !== undefined) lines.push(['Made with AI (Meta\'s label)', null, input.aiGenerated ? 'yes' : 'no'])

  const containers: Array<{ step: number; video: boolean }> = []
  // Review B-F10 — at most 5 minutes of waiting in the whole run (a minute between reads), set at the run's first wait.
  let runDeadline: number | undefined
  const deadline = () => (runDeadline ??= Date.now() + __postTiming.pollMs * __postTiming.videoPolls)
  const judge = (params: Record<string, string>, where: string): string | null => {
    const judged = metaIgContainerProblem(new Map(Object.entries(params)))
    return judged ? `Nexus would not send ${where}: ${judged}.` : null
  }
  const container = (step: number, label: string, params: Record<string, string>, video: boolean, extra: Partial<MetaChangeRequest> = {}): MetaChangeRequest => ({
    ...base(step, label, ig), objectKind: 'postig', edge: 'media', operation: 'igmedia.container', params, readBackFields: 'id,status_code', explain: IG_EXPLAIN, ...extra,
    doneSentence: (r) => `${label.replace(/^Make /, '')}: Meta made container ${idTextOf(r.node?.id) ?? '(no id)'}${typeof r.node?.status_code === 'string' ? ` (${r.node.status_code})` : ''} — not public yet.`,
  })
  const jpegWarn = (linked: Linked, where: string) => { if (!linked.jpeg) warnings.push(`${where}: Instagram takes JPEG images only (Meta: "JPEG is the only image format supported"); ${linked.source} does not end in .jpg / .jpeg — if it is another format, Meta refuses it in its words.`) }

  if (input.kind === 'image' || (input.kind === 'story' && input.image)) {
    const linked = await imageLinkOf(input.image, 'image', false)
    if ('problem' in linked) return { refusal: linked.problem }
    if (!('url' in linked)) return { refusal: 'image is a link (libraryImageId or imageUrl).' }
    jpegWarn(linked, 'image')
    const story = input.kind === 'story'
    const tags = tagsJson(input.userTags)
    const params: Record<string, string> = story
      ? { media_type: 'STORIES', image_url: linked.url, ...(tags ? { user_tags: tags } : {}) }
      : { image_url: linked.url, ...common, ...(input.altText !== undefined ? { alt_text: input.altText } : {}), ...(tags ? { user_tags: tags } : {}), ...(productTagsJson(input.productTags, 'image') ? { product_tags: productTagsJson(input.productTags, 'image')! } : {}) }
    const bad = judge(params, story ? 'this story' : 'this image post')
    if (bad) return { refusal: bad }
    requests.push(container(1, `Make the ${story ? 'story' : 'image post'}'s container on the Instagram account ${ig} (${linked.source})`, params, false))
    containers.push({ step: 1, video: false })
    lines.unshift([story ? 'Instagram story' : 'Instagram image post', 'none', linked.source])
    if (input.altText !== undefined) lines.push(['Alt text (exactly as sent)', null, input.altText])
    if (tags) lines.push(['People tagged (exactly as sent)', null, JSON.parse(tags)])
    if (params.product_tags) lines.push(['Products tagged (exactly as sent)', null, JSON.parse(params.product_tags)])
  } else if (input.kind === 'reel' || input.kind === 'story') {
    const linked = await videoLinkOf(input.video, 'video')
    if ('problem' in linked) return { refusal: linked.problem }
    const story = input.kind === 'story'
    let cover: string | undefined
    if (input.cover) {
      const c = await imageLinkOf(input.cover, 'cover', false)
      if ('problem' in c) return { refusal: c.problem }
      if (!('url' in c)) return { refusal: 'cover is a link (libraryImageId or imageUrl).' }
      jpegWarn(c, 'cover')
      cover = c.url
    }
    const tags = tagsJson(input.userTags)
    const params: Record<string, string> = story
      ? { media_type: 'STORIES', video_url: linked.url, ...(tags ? { user_tags: tags } : {}) }
      : {
        media_type: 'REELS', video_url: linked.url, ...common,
        ...(input.shareToFeed !== undefined ? { share_to_feed: String(input.shareToFeed) } : {}),
        ...(cover ? { cover_url: cover } : {}), ...(input.audioName !== undefined ? { audio_name: input.audioName } : {}),
        ...(tags ? { user_tags: tags } : {}), ...(input.thumbOffsetMs !== undefined ? { thumb_offset: String(input.thumbOffsetMs) } : {}),
        ...(input.trial ? { trial_params: JSON.stringify({ graduation_strategy: input.trial }) } : {}),
        ...(productTagsJson(input.productTags, 'reel') ? { product_tags: productTagsJson(input.productTags, 'reel')! } : {}),
      }
    const bad = judge(params, story ? 'this story' : 'this reel')
    if (bad) return { refusal: bad }
    requests.push(container(1, `Make the ${story ? 'story' : 'reel'}'s container on the Instagram account ${ig} (${linked.source}; Meta fetches it)`, params, true))
    containers.push({ step: 1, video: true })
    lines.unshift([story ? 'Instagram story (video)' : 'Instagram reel', 'none', linked.source])
    if (input.trial) lines.push(['Trial reel (shown to non-followers first)', null, input.trial === 'MANUAL' ? 'graduates when a person says so in the app' : 'Meta graduates it if it performs well'])
    if (input.shareToFeed !== undefined) lines.push(['Also in the feed', null, input.shareToFeed ? 'yes' : 'Reels tab only'])
    if (tags) lines.push(['People tagged (exactly as sent)', null, JSON.parse(tags)])
    if (params.product_tags) lines.push(['Products tagged (exactly as sent)', null, JSON.parse(params.product_tags)])
    if (input.audioName !== undefined) lines.push(['Audio name (exactly as sent)', null, input.audioName])
    if (input.cover) lines.push(['Cover picture', null, cover])
    if (input.thumbOffsetMs !== undefined) lines.push(['Thumbnail frame', null, `${input.thumbOffsetMs} ms into the video${cover ? ' (Meta uses the cover instead)' : ''}`])
    warnings.push('Meta fetches the video from its link and prepares it (a reel: MP4 or MOV, 3 s to 15 min, at most 300 MB; a story: at most 60 s, 100 MB): Nexus reads its state at once, then once a minute for at most 5 minutes, before the publish; if Meta is still working then, nothing is public and the answer names the container to publish later (kind publish-container).')
  } else {
    // A carousel: one container per item, then the carousel's container from them, then the publish.
    const itemLines: Array<Record<string, unknown>> = []
    for (const [i, item] of input.items!.entries()) {
      const where = `items[${i}]`
      if (!!item.image === !!item.video) return { refusal: `${where} has an image or a video (one of them).` }
      if (item.video && item.altText !== undefined) return { refusal: `${where}: Meta takes alt text on images only.` }
      const linked = item.image ? await imageLinkOf(item.image, `${where}.image`, false) : await videoLinkOf(item.video, `${where}.video`)
      if ('problem' in linked) return { refusal: linked.problem }
      if (!('url' in linked)) return { refusal: `${where}.image is a link (libraryImageId or imageUrl).` }
      if (item.image) jpegWarn(linked, `${where}.image`)
      const tags = tagsJson(item.userTags)
      const products = productTagsJson(item.productTags, item.image ? 'carousel-image' : 'carousel-video')
      const params: Record<string, string> = item.image
        ? { image_url: linked.url, is_carousel_item: 'true', ...(item.altText !== undefined ? { alt_text: item.altText } : {}), ...(tags ? { user_tags: tags } : {}), ...(products ? { product_tags: products } : {}) }
        : { media_type: 'VIDEO', video_url: linked.url, is_carousel_item: 'true', ...(tags ? { user_tags: tags } : {}), ...(products ? { product_tags: products } : {}) }
      const bad = judge(params, where)
      if (bad) return { refusal: bad }
      const step = requests.length + 1
      requests.push(container(step, `Make item ${i + 1} of ${input.items!.length} (${item.image ? 'image' : 'video'}) of the carousel on the Instagram account ${ig} (${linked.source})`, params, !!item.video))
      containers.push({ step, video: !!item.video })
      itemLines.push({ item: i + 1, kind: item.image ? 'image' : 'video', source: linked.source, ...(item.altText !== undefined ? { altText: item.altText } : {}), ...(tags ? { peopleTagged: JSON.parse(tags) } : {}), ...(products ? { productsTagged: JSON.parse(products) } : {}) })
    }
    lines.push(['Items (exactly as sent)', null, itemLines])
    const itemSteps = containers.map((c) => c.step)
    const fixed: Record<string, string> = { media_type: 'CAROUSEL', ...common }
    const bad = judge({ ...fixed, children: itemSteps.map((s) => String(9_000_000_000_000_000 + s)).join(',') }, 'this carousel')
    if (bad) return { refusal: bad }
    const step = requests.length + 1
    const operation = 'igmedia.container'
    const videos = containers.filter((c) => c.video).map((c) => c.step)
    requests.push(container(step, `Make the carousel's container on the Instagram account ${ig} from items ${itemSteps.join(', ')}`, fixed, false, {
      planParams: { ...fixed, children: itemSteps.map((s) => `@${s}`).join(',') },
      needs: itemSteps,
      // A video item is waited for until Meta says FINISHED before the carousel names it.
      prepare: async (done) => {
        const ids = itemSteps.map((s) => madeIdOf(done, s, operation))
        // The run's 5 minutes in all for the video items (Meta prepares them side by side), never 5 minutes each.
        for (const s of videos) await waitForContainer(ctx.connectionId, madeIdOf(done, s, operation), true, operation, deadline())
        return { children: ids.join(',') }
      },
    }))
    containers.push({ step, video: false })
    lines.unshift(['Instagram carousel', 'none', `${plural(input.items!.length, 'item')}`])
    warnings.push('Carousel images are all cropped like the first one (1:1 by default); a carousel counts as one post against Instagram\'s limit.')
  }

  // Step 35 (Q9) — product tags reach buyers with the post; Meta's own rules, said.
  if (input.productTags?.length || input.items?.some((i) => i.productTags?.length)) {
    record.productTagged = true
    warnings.push(`Products tagged show on the public post at once (a product Meta has not approved for tagging yet shows once it is). Meta allows ${META_IG_TAGGED_POSTS_PER_DAY} tagged posts per account in 24 hours (a carousel counts once); a product tag cannot be removed by API afterwards (the Instagram app removes it).`, ...(ctx.productTagNotes ?? []))
  }

  // The publish of the last container, once Meta says it is FINISHED.
  const top = containers[containers.length - 1]
  const video = input.kind === 'reel' || (input.kind === 'story' && !!input.video) || (input.kind === 'carousel' && containers.some((c) => c.video))
  const step = requests.length + 1
  const operation = 'igmedia.publish'
  requests.push({
    ...base(step, `PUBLISH the ${input.kind} on the Instagram account ${ig} (the container of step ${top.step}) — public at once`, ig),
    objectKind: 'postig', edge: 'media_publish', operation, params: {}, planParams: { creation_id: `@${top.step}` }, needs: [top.step],
    readBackFields: 'id,permalink,media_product_type', explain: IG_EXPLAIN,
    prepare: async (done) => {
      const id = madeIdOf(done, top.step, operation)
      await waitForContainer(ctx.connectionId, id, video, operation, deadline())
      return { creation_id: id }
    },
    doneSentence: (r) => publishedSentence(r),
  })
  warnings.push(IG_PUBLIC, IG_NO_EDIT)
  if (input.collaborators?.length) warnings.push('Each collaborator gets an invite; the post shows on their account too once they accept.')
  if (input.sponsorInstagramIds?.length || input.paidPartnership) warnings.push('The paid partnership label (Meta\'s content-publishing guide): the account must be eligible for branded content; a brand that pre-approved it shows its name at once, otherwise the label reads "Paid partnership" while the brand is asked to approve.')
  if (input.kind !== 'story' && (input.caption ?? '').includes('@')) warnings.push('Every account @mentioned in the caption is notified when the post is published. Nexus does NOT check @mentions against the accounts other businesses in Nexus use (it checks collaborators and people tags only): read them before approving.')
  if (input.kind === 'story') warnings.push('A story lives 24 hours; Meta publishes no stickers (link, poll, place) through its API.')
  return finishDraft(`Post ${input.kind === 'image' ? 'an image' : input.kind === 'reel' ? 'a reel' : input.kind === 'story' ? 'a story' : 'a carousel'} on the chosen Instagram account — PUBLIC once published. Nothing spends.`)
}

/** The publish step's sentence: the media, its link, and what Meta dropped while publishing (config_issue). */
function publishedSentence(r: MetaChangeResult): string {
  const id = idTextOf(r.node?.id)
  const link = typeof r.node?.permalink === 'string' ? r.node.permalink : null
  const issue = typeof r.node?.config_issue === 'string' ? r.node.config_issue : null
  const dropped = issue === 'CAPTION_NOT_ATTACHED' ? ' Meta published it WITHOUT its caption (config_issue CAPTION_NOT_ATTACHED).' : issue === 'USER_TAGGING_FAILURE' ? ' Meta published it WITHOUT its people tags (config_issue USER_TAGGING_FAILURE).' : issue ? ` Meta reports ${issue}.` : ''
  return `Published: Instagram media ${id ?? '(Meta gave no id)'}${link ? ` (${link})` : ''} is PUBLIC now.${dropped}`
}

/** What Meta made, from each done request: the containers, the media, the event. */
export function igPostMade(draft: MetaChangeDraft, done: ReadonlyArray<{ request: MetaChangeRequest; result: MetaChangeResult }>): IgPostRecord {
  const after = { ...(draft.after as IgPostRecord) }
  const containers = done.filter((d) => d.request.operation === 'igmedia.container')
  if (containers.length) {
    const top = draft.requests.filter((r) => r.operation === 'igmedia.container').at(-1)
    const topDone = containers.find((d) => d.request.step === top?.step)
    after.containerId = topDone ? createdIdOf(topDone.result.node) : null
    after.itemContainerIds = after.kind === 'carousel' ? containers.filter((d) => d !== topDone).map((d) => createdIdOf(d.result.node)).filter((v): v is string => !!v) : []
  }
  const published = nodeOf(done, 'igmedia.publish')
  if (published) after.mediaId = createdIdOf(published)
  const event = nodeOf(done, 'iguser.upcomingEvent')
  if (event) after.eventId = createdIdOf(event)
  return after
}

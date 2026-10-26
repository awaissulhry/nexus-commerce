/**
 * Meta ads changes, step 24 (2026-10-25) — organic posts of the business's CHOSEN Facebook Page and CHOSEN Instagram account
 * (master rows MD-107 … MD-115, MD-133, MD-136, MD-140, EN-047, EN-050, CR-256, CR-259, CR-367, OT-037):
 *   create-meta-page-post       a text, link (call to action; the local ones of CR-256 too), carousel, photo or video post —
 *                               DARK (unpublished, for ads), PUBLIC at once, or SCHEDULED; undo deletes it while unpublished
 *   set-meta-page-post          edit a post the Page wrote: text, hidden, timeline visibility, schedule, publish now (one
 *                               way), its brand partner (paid-partner sponsor) and whether that brand may boost it
 *   remove-meta-page-post       delete a Facebook post or an Instagram media NEXUS made (explicit ask; never one an ad shows)
 *   create-meta-instagram-post  a feed image, reel, story or carousel (containers, then the publish once Meta finished), an
 *                               upcoming event, or the publish of a container an earlier run left ready
 * A Nexus change like every other Meta change (meta-ads-kit.ts): a preview from the live state (Meta has no check for any of
 * these: said), an approvalId, a person approves it, it runs as that person, request by request.
 *
 * Every request goes AS the Page: the gateway reads the chosen Page's own token for that one call (gateway/meta-page-token.ts,
 * step 36's Page token mode — the one mode, reused) and sends it only for the chosen Page, a post the Page wrote, the chosen
 * Instagram account or what Nexus itself made there (gateway/meta-post-owner.ts), with every id inside a body confirmed the
 * business's own. The tools never see a token. Nothing spends: an organic post is not an ad (a boost is create-meta-boost).
 * Product tags on an Instagram post are step 35's (meta-instagram-product-tags; it adds them to this tool).
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import { META_IG_POST_CREATE_TOOL, META_PAGE_POST_CREATE_TOOL, metaLinkTaken } from '../../gateway/account.js'
import { META_COMMENT_TEXT, META_NAME_TEXT } from '../../gateway/meta-write-text.js'
import { META_IG_EVENT_SUBTYPES, META_POST_AGE_MINS, META_POST_LIMITS as L } from '../../gateway/meta-post-rules.js'
import {
  editUndoProblem, igMediaRemoveDraft, type CreativesUsing, igPostCreateDraft, igPostMade, IG_POST_KINDS, pagePostCreateDraft, pagePostEditDraft, pagePostMade, pagePostRemoveDraft, POST_FORMATS, PUBLISH_MODES,
  type IgPostInput, type IgPostRecord, type PagePostEditFields, type PagePostEditInput, type PagePostEditRecord, type PagePostInput, type PagePostRecord, type PostRemoveRecord,
} from '../../marketing/meta-ads/change-posts.js'
import { igContainerNexusMade, igUsernameTaken, liveCreativesUsing, liveIgContainer, liveIgMedia, liveIgQuota, livePagePost, livePostAccount, liveVideoPost } from '../../marketing/meta-ads/live-posts.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import type { MetaChangeDraft, MetaChangeRequest } from '../../marketing/meta-ads/change-draft.js'
import type { MetaChangeResult } from '../../marketing/meta-ads/write-client.js'

/** The most different Instagram accounts one post invites or tags (each is one Business Discovery read before it is queued). */
const MAX_ACCOUNTS_CHECKED = 30

export const META_PAGE_POST_SET_TOOL = 'set-meta-page-post'
export const META_POST_REMOVE_TOOL = 'remove-meta-page-post'

// ── arguments ───────────────────────────────────────────────────────────────────────────────────────────────────

const lines = (max: number, what: string) => z.string().min(1).max(max).regex(META_COMMENT_TEXT, 'printable text (line breaks allowed; no control or format characters)').describe(what)
const line = (max: number, what: string) => z.string().trim().min(1).max(max).regex(META_NAME_TEXT, 'printable text (no control or format characters)').describe(what)
const httpsLink = (what: string) => z.string().trim().max(2_000).regex(/^https:\/\/[^\s]+$/, 'an https:// link').describe(what)
const when = (what: string) => z.string().trim().datetime({ offset: true }).describe(what)
const pagePostIdArg = z.string().trim().regex(/^\d{1,25}_\d{1,25}$/, '<Page id>_<post id>').describe('the chosen Page\'s post (<Page id>_<post id>, as meta-page-posts or create-meta-page-post gives it)')
const libraryImage = z.string().trim().regex(/^(da|pi)_[A-Za-z0-9_-]{1,64}$/, 'an image-library id (da_… or pi_…)')
const imageSource = (what: string, hash: boolean) => z.object({
  imageUrl: httpsLink('a public https link to the image (Meta fetches it; no key or sign-in in the link)').optional(),
  libraryImageId: libraryImage.describe('an image of THIS business\'s Nexus image library or a product photo (image-library lists them: da_… / pi_…)').optional(),
  ...(hash ? { imageHash: z.string().trim().regex(/^[A-Za-z0-9]{1,64}$/, 'an image hash').describe('an image of the chosen ad account\'s library by its hash (create-meta-media uploads one and answers it)').optional() } : {}),
}).strict().describe(`${what} — exactly one of ${hash ? 'imageHash, ' : ''}libraryImageId or imageUrl`)
const videoSource = z.object({
  videoUrl: httpsLink('a public https link to the video file (Meta fetches it; no video byte goes through Nexus)').optional(),
  libraryVideoId: z.string().trim().regex(/^da_[A-Za-z0-9_-]{1,64}$/, 'a library file id (da_…)').describe('a video of THIS business\'s Nexus library (image-library lists them with type video)').optional(),
}).strict()
const countries = z.array(z.string().regex(/^[A-Z]{2}$/, 'a two-letter country code (IT, DE, …)')).min(1).max(L.countries)

// ── create-meta-page-post ──────────────────────────────────────────────────────────────────────────────────────────

const pageInput = z.object({
  connectionId: metaConnectionArg,
  format: z.enum(POST_FORMATS).describe('text (message only) · link (a link with its preview and a call to action) · carousel (2–5 link cards; 10 with reorderCards) · photos (1–10 photos) · video (Meta fetches it from a link)'),
  publish: z.enum(PUBLISH_MODES).describe('dark (UNPUBLISHED: seen by no one; an ad can show it — what an ads task wants) · now (PUBLIC at once on the Page and in followers\' feeds) · schedule (PUBLIC at scheduledAt, 10 minutes to 30 days ahead)'),
  scheduledAt: when('publish schedule: when Meta publishes it (ISO 8601, e.g. 2026-11-01T09:00:00Z; 10 minutes to 30 days ahead)').optional(),
  message: lines(L.message, 'the post\'s text, EXACTLY as the person approved it (sent as written; a video post: its description). No @[page-id] tags').optional(),
  link: httpsLink('link / carousel: the link the post shares (a carousel\'s "see more" end card). With CALL_NOW, GET_DIRECTIONS or MESSAGE_PAGE leave it out: Nexus uses the Page\'s own URL').optional(),
  name: line(L.name, 'link: the preview\'s title instead of the link page\'s (Meta: the Page must own the link\'s domain)').optional(),
  description: line(L.description, 'link: the preview\'s description instead of the link page\'s (same rule)').optional(),
  image: imageSource('link: the preview\'s image instead of the link page\'s (same rule)', true).optional(),
  callToAction: z.object({
    type: z.string().trim().regex(/^[A-Z_]{2,30}$/).describe('SHOP_NOW, LEARN_MORE, SIGN_UP, SUBSCRIBE, GET_QUOTE, WATCH_MORE, WATCH_VIDEO, OPEN_LINK, BOOK_TRAVEL, LISTEN_MUSIC (each goes to the post\'s own link, as Meta asks), NO_BUTTON — or, on a DARK post only, a local one: MESSAGE_PAGE, CALL_NOW (phone), GET_DIRECTIONS (latitude, longitude, address; the only one on a video post). App buttons are refused: the business has no app'),
    phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, '+<country code><number>, digits only').describe('CALL_NOW: the phone number, +<country code><number> (no premium-rate number; the ad targets 18+ in its country, on mobile)').optional(),
    latitude: z.number().min(-90).max(90).describe('GET_DIRECTIONS: the store\'s latitude').optional(),
    longitude: z.number().min(-180).max(180).describe('GET_DIRECTIONS: the store\'s longitude').optional(),
    address: line(L.address, 'GET_DIRECTIONS: the store\'s address as shown').optional(),
  }).strict().describe('link (or video): a call-to-action button').optional(),
  cards: z.array(z.object({
    link: httpsLink('the card\'s link'),
    name: line(L.name, 'the card\'s title').optional(),
    description: line(L.description, 'the card\'s description').optional(),
    image: imageSource('the card\'s image', true),
  }).strict()).min(L.childrenMin).max(L.childrenOptimizedMax).describe('carousel: the cards, in order (2–5; up to 10 with reorderCards true)').optional(),
  reorderCards: z.boolean().describe('carousel: let Meta reorder the cards when the post runs in an ad (multi_share_optimized; Meta\'s default is ON — Nexus sends it OFF unless true)').optional(),
  endCard: z.boolean().describe('carousel: show the "see more" end card (default true)').optional(),
  photos: z.array(imageSource('a photo', false).extend({ altText: line(L.altText, 'its alternative text for people who cannot see it').optional() })).min(1).max(L.photos).describe('photos: 1–10 photos, in order (each goes up UNPUBLISHED first, then the post attaches them)').optional(),
  video: videoSource.extend({ title: line(L.message, 'the video\'s title (at most 254 bytes)').optional() }).describe('video: exactly one of libraryVideoId or videoUrl').optional(),
  audience: z.object({
    countries: countries.describe('only people in these countries can see the post').optional(),
    ageMin: z.number().int().refine((n) => (META_POST_AGE_MINS as readonly number[]).includes(n), `one of ${META_POST_AGE_MINS.join(', ')} (Meta's choices)`).describe(`only people at least this old can see it (${META_POST_AGE_MINS.join(', ')})`).optional(),
  }).strict().describe('text, link, carousel, photos: who can see the post at all (Meta\'s targeting)').optional(),
  preferAudience: z.object({
    countries: countries.describe('show it more to people in these countries').optional(),
    ageMin: z.number().int().min(13).max(65).optional().describe('show it more to people at least this old'),
    ageMax: z.number().int().min(13).max(65).optional().describe('show it more to people at most this old'),
  }).strict().describe('text, link, carousel, photos: who sees it MORE (Meta\'s feed_targeting; others may still see it)').optional(),
  placeId: metaIdArg('text, link, carousel, photos: the Facebook Page of the place the post is tagged with (a Page with a location)').optional(),
  why: metaWhyArg,
})
type PageArgs = z.infer<typeof pageInput>

const refusalOf = (err: unknown): { refusal: string } => {
  if (err instanceof MetaLiveRefusal) return { refusal: err.message }
  throw err
}

const buildPagePost = (args: Record<string, unknown>): MetaDraftBuilder => async (account) => {
  const a = args as unknown as PageArgs
  try {
    const where = await livePostAccount(account.accountId, 'page')
    const placeTaken = a.placeId ? await metaLinkTaken('PAGE', a.placeId) : false
    return await pagePostCreateDraft(a as PagePostInput, { pageId: where.pageId!, placeTaken })
  } catch (err) { return refusalOf(err) }
}

/** Undo's "now": the post as Meta reads it (published since? gone?), in the shape of the record. */
const pagePostUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as PagePostRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const stamp = { accountId: account.accountId, adAccountId: account.adAccountId }
    // Review B-F2 — a video post whose post Meta named only later: found from its video now.
    let postId = after.postId
    if (!postId && after.videoId) {
      try { postId = (await liveVideoPost(account.accountId, after.videoId)).postId } catch (err) {
        if (err instanceof MetaLiveRefusal || (err instanceof MetaReadError && err.failure.notFound)) return { ...after, videoId: null, ...stamp }
        throw err
      }
    }
    if (!postId) return { ...after, ...stamp }
    try {
      const state = await livePagePost(account.accountId, postId)
      // A dark or scheduled post that is public now is no longer what this change made: its undo never deletes it.
      return { ...after, ...(state.published === true && after.publish !== 'now' ? { publish: 'now' as const } : {}), ...stamp }
    } catch (err) {
      // Gone, or no longer the chosen Page's: not what this change made (a read Meta could not answer is said upstream).
      if (err instanceof MetaLiveRefusal || (err instanceof MetaReadError && err.failure.notFound)) return { ...after, postId: null, ...stamp }
      throw err
    }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as PagePostRecord & { accountId?: string }
    if (after.publish === 'now') return { refusal: 'A post that went public at once has no undo (people saw it): remove-meta-page-post deletes it on an explicit ask.' }
    if (!after.postId && !after.videoId) return { refusal: 'This change kept no id of a post it made, so there is nothing to delete (Meta deletes unpublished photos not published within 24 hours).' }
    // A video post whose post Meta named only later goes by its video (remove-meta-page-post finds the post from it).
    const target = after.postId ? { postId: after.postId } : { videoId: after.videoId! }
    return { tool: META_POST_REMOVE_TOOL, args: { ...(after.accountId ? { connectionId: after.accountId } : {}), platform: 'facebook', ...target, confirmDelete: true, why: 'undo of create-meta-page-post: deletes the post it made, still unpublished' } }
  },
}

function pagePostFinish(draft: MetaChangeDraft, done: Array<{ request: MetaChangeRequest; result: MetaChangeResult }>) {
  const after = pagePostMade(draft, done)
  const madePhotos = after.photoIds.length
  return {
    data: {
      format: after.format, publish: after.publish, pageId: after.pageId, postId: after.postId, ...(after.videoId ? { videoId: after.videoId } : {}), ...(madePhotos ? { photoIds: after.photoIds } : {}),
      note: after.postId
        ? `meta-page-posts view post postId ${after.postId} reads it. ${after.publish === 'dark' ? 'An ad shows it with create-meta-creative (object_story_id) or create-meta-boost; set-meta-page-post edits it.' : 'set-meta-page-post edits it.'}`
        : after.videoId ? `The video post exists (video ${after.videoId}); Meta names its post once it has processed the video — meta-page-posts view feed lists it then, and remove-meta-page-post (videoId) or this change's undo finds it from the video.` : madePhotos ? 'The photos went up, the post did not: Meta deletes unpublished photos not published within 24 hours.' : 'Meta made no post.',
    },
    before: draft.before,
    after,
    ...(after.postId || after.videoId ? {} : { noUndo: madePhotos ? 'No post was made, so nothing needs undoing: Meta deletes the unpublished photos by itself within 24 hours.' : 'No post was made, so nothing needs undoing.' }),
  }
}

const createPagePost: AgentTool = {
  name: META_PAGE_POST_CREATE_TOOL,
  title: 'Make a Facebook Page post',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // A dark or scheduled post is deleted by its undo while still unpublished (Meta may refuse a delete: said); a post that
  // went public at once has no undo.
  reversibility: 'partial',
  consequencesFor: (args) => (args.publish === 'now' ? { reversibility: 'none' } : typeof args.publish === 'string' ? { reversibility: 'partial' } : null),
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: pageInput,
  description:
    'Make a post on the business\'s chosen Facebook Page, as the Page: format text, link (its preview — your own name, '
    + 'description or image only when the Page owns the link\'s domain — and a call-to-action button, the local ones too: '
    + 'MESSAGE_PAGE, CALL_NOW, GET_DIRECTIONS on a DARK post only, which link to the Page itself; a link button goes to the post\'s own link), carousel (2–5 link cards, 10 when Meta may '
    + 'reorder them — sent OFF unless reorderCards), photos (1–10: uploaded UNPUBLISHED first, then the post attaches them; public now or scheduled — a DARK photo post waits for a live check: create-meta-creative makes one) or '
    + 'video (Meta fetches it from a library video or a public link; a dark video takes only GET_DIRECTIONS). publish: dark — '
    + 'UNPUBLISHED, seen by no one, for ads (create-meta-creative object_story_id / create-meta-boost show it); now — PUBLIC at '
    + 'once, buyers see it; schedule — PUBLIC at scheduledAt (10 minutes to 30 days). audience limits who can see it, '
    + 'preferAudience who sees it more. Images: a library image (libraryImageId), an ad-library image (imageHash) or a public '
    + 'https link — never a local file. placeId tags a place (its Page). Nexus never tags people or Pages and never backdates. Meta has no '
    + 'check for posts. Nothing spends (a post is not an ad; a boost is create-meta-boost). The gateway reads the chosen Page\'s '
    + 'own token for each request (the system user needs the Page\'s CREATE_CONTENT task — ADVERTISE for a dark video — and '
    + 'pages_manage_posts); a token is never shown. Undo deletes a dark or scheduled post while it is still unpublished and no ad shows it (Meta '
    + 'may refuse: only "select developers" may delete by API — then a person deletes it in Meta Business Suite); a post that '
    + 'went public at once has no undo (remove-meta-page-post on an explicit ask).'
    + META_CHANGE_RULES,
  undo: pagePostUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildPagePost(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildPagePost(args), pagePostFinish),
}

// ── set-meta-page-post ─────────────────────────────────────────────────────────────────────────────────────────────

const editInput = z.object({
  connectionId: metaConnectionArg,
  postId: pagePostIdArg,
  message: lines(L.message, 'the post\'s new text, EXACTLY as the person approved it (sent as written; no @[page-id] tags)').optional(),
  hidden: z.boolean().describe('hide it from the Page (true) or show it again (false); it is not deleted').optional(),
  timelineVisibility: z.enum(['hidden', 'normal']).describe('whether the post shows on the Page\'s timeline').optional(),
  scheduledAt: when('an UNPUBLISHED post only: when Meta publishes it (ISO 8601; 10 minutes to 30 days ahead) — PUBLIC from then').optional(),
  publishNow: z.literal(true).describe('publish an unpublished or scheduled post NOW — PUBLIC at once, one way (Nexus never un-publishes)').optional(),
  sponsorPageId: metaIdArg('a brand partner\'s Facebook Page to tag as the post\'s paid partner (branded content: the business\'s Page is the creator)').optional(),
  sponsorCanBoost: z.boolean().describe('whether that brand may boost the post itself (Meta\'s direct_share_status)').optional(),
  why: metaWhyArg,
})
type EditArgs = z.infer<typeof editInput>

const buildEdit = (args: Record<string, unknown>): MetaDraftBuilder => async (account) => {
  const a = args as unknown as EditArgs
  try {
    const state = await livePagePost(account.accountId, a.postId, { sponsors: a.sponsorPageId !== undefined || a.sponsorCanBoost !== undefined })
    // Review A-4 — the ads that show the post, for a text edit, a publish now and a new schedule; a read Meta did not answer is said.
    let uses: CreativesUsing = null
    if ((a.message !== undefined && a.message !== state.message) || a.publishNow || a.scheduledAt !== undefined) {
      try { uses = await liveCreativesUsing({ connectionId: account.accountId, adAccountId: account.adAccountId }, { postId: state.postId }) } catch (err) {
        if (!(err instanceof MetaReadError)) throw err
        uses = 'unreadable'
      }
    }
    const sponsorTaken = a.sponsorPageId ? await metaLinkTaken('PAGE', a.sponsorPageId) : false
    const input: PagePostEditInput = { message: a.message, hidden: a.hidden, timelineVisibility: a.timelineVisibility, scheduledAt: a.scheduledAt, publishNow: a.publishNow, sponsorPageId: a.sponsorPageId, sponsorCanBoost: a.sponsorCanBoost }
    return pagePostEditDraft(input, state, { creativesUsing: uses, sponsorTaken })
  } catch (err) { return refusalOf(err) }
}

/** The fields of a recorded edit as the post reads them now. */
async function editNow(after: PagePostEditRecord, connectionId: string): Promise<PagePostEditFields> {
  const keys = Object.keys(after.fields) as Array<keyof PagePostEditFields>
  const state = await livePagePost(connectionId, after.postId, { sponsors: keys.includes('sponsorPageId') })
  const now: PagePostEditFields = {}
  for (const key of keys) {
    if (key === 'message') now.message = state.message
    else if (key === 'hidden') now.hidden = state.hidden
    else if (key === 'timelineVisibility') now.timelineVisibility = state.timelineVisibility
    else if (key === 'scheduledAt') now.scheduledAt = state.scheduledAt
    else if (key === 'published') now.published = state.published
    else if (key === 'sponsorPageId') now.sponsorPageId = state.sponsorPageIds?.length === 1 ? state.sponsorPageIds[0] : state.sponsorPageIds === null ? after.fields.sponsorPageId : null
    // Meta answers no read of whether the brand may boost it: as recorded.
    else if (key === 'sponsorCanBoost') now.sponsorCanBoost = after.fields.sponsorCanBoost
  }
  return now
}

const editUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as PagePostEditRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    try {
      return { ...after, fields: await editNow(after, account.accountId), accountId: account.accountId, adAccountId: account.adAccountId }
    } catch (err) {
      if (err instanceof MetaLiveRefusal) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as PagePostEditRecord
    const after = (change.after ?? {}) as PagePostEditRecord & { accountId?: string }
    const fields = before.fields ?? {}
    const problems = editUndoProblem(fields)
    if (problems.length) return { refusal: `This edit has no undo: ${problems.join('; ')}.` }
    const args: Record<string, unknown> = {
      ...(after.accountId ? { connectionId: after.accountId } : {}), postId: before.postId,
      ...(fields.message !== undefined ? { message: fields.message } : {}),
      ...(fields.hidden !== undefined ? { hidden: fields.hidden } : {}),
      ...(fields.timelineVisibility !== undefined ? { timelineVisibility: fields.timelineVisibility } : {}),
      ...(fields.scheduledAt ? { scheduledAt: new Date(fields.scheduledAt * 1000).toISOString() } : {}),
      ...(fields.sponsorPageId ? { sponsorPageId: fields.sponsorPageId } : {}),
      ...(typeof fields.sponsorCanBoost === 'boolean' ? { sponsorCanBoost: fields.sponsorCanBoost } : {}),
      why: 'undo of an earlier set-meta-page-post: puts the old values back',
    }
    return { tool: META_PAGE_POST_SET_TOOL, args }
  },
}

const setPagePost: AgentTool = {
  name: META_PAGE_POST_SET_TOOL,
  title: 'Change a Facebook Page post',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Text, hidden and timeline visibility go back; a new schedule goes back while the old one is still ahead; a publish is
  // one way; a first paid-partner tag cannot be taken off by API.
  reversibility: 'partial',
  // Review A-3 — a publish is one way, and whether the brand could boost it before is not readable (so its undo cannot write
  // it back); every other edit is undone only where the old value can be sent again (the preview says when not).
  consequencesFor: (args) => (args.publishNow === true || args.sponsorCanBoost !== undefined ? { reversibility: 'none' } : typeof args.postId === 'string' ? { reversibility: 'partial' } : null),
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: editInput,
  description:
    'Change a post of the business\'s chosen Facebook Page that the Page wrote (postId <Page id>_<post id>): its text '
    + '(EXACTLY as approved; ads that show the post show the new text at once — the preview names them), hide it from the '
    + 'Page or show it again (not a delete), its timeline visibility, a new schedule for an UNPUBLISHED post (PUBLIC from '
    + 'then), publish it NOW (PUBLIC at once, one way), and as branded content its brand partner\'s Page (paid-partner sponsor) '
    + 'and whether that brand may boost it. Meta lets an app change only the posts it made ("An app can only update a Page post '
    + 'if the post was made using that app": Nexus\'s own come from create-meta-page-post) — Meta refuses any other in its own '
    + 'words. Nexus does not change a post\'s photos, place, tags or privacy (make a new post instead). Meta has no check for an '
    + 'edit. Nothing spends. As the Page: the gateway reads its token for the request. Undo writes the old values back (not a '
    + 'publish; not a first sponsor — Meta documents no removal of a paid-partner tag by API).'
    + META_CHANGE_RULES,
  undo: editUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildEdit(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildEdit(args), (draft) => ({
    data: { postId: (draft.after as PagePostEditRecord).postId, fields: (draft.after as PagePostEditRecord).fields, note: 'meta-page-posts view post reads it now.' },
    before: draft.before, after: draft.after,
  })),
}

// ── remove-meta-page-post ──────────────────────────────────────────────────────────────────────────────────────────

const removeInput = z.object({
  connectionId: metaConnectionArg,
  platform: z.enum(['facebook', 'instagram']).describe('facebook: a post Nexus made on the chosen Page · instagram: a media Nexus published on the chosen Instagram account'),
  postId: pagePostIdArg.optional(),
  videoId: metaIdArg('facebook: a video post Nexus made, by its video (create-meta-page-post\'s videoId) — while Meta has not named its post id yet').optional(),
  mediaId: metaIdArg('instagram: the media Nexus published (create-meta-instagram-post\'s mediaId)').optional(),
  confirmDelete: z.literal(true).describe('true — the person asked to delete it (FINAL: a deleted post cannot come back; set-meta-page-post hidden: true takes a Facebook post off the Page but keeps it)'),
  why: metaWhyArg,
})
type RemoveArgs = z.infer<typeof removeInput>

const buildRemove = (args: Record<string, unknown>): MetaDraftBuilder => async (account) => {
  const a = args as unknown as RemoveArgs
  if (a.platform === 'facebook' ? !!a.postId === !!a.videoId || a.mediaId : !a.mediaId || a.postId || a.videoId) return { refusal: a.platform === 'facebook' ? 'A Facebook post is named by postId, or a video post by its videoId (one of them).' : 'An Instagram media is named by mediaId (only).' }
  try {
    const target = { connectionId: account.accountId, adAccountId: account.adAccountId }
    if (a.platform === 'facebook') {
      // Review B-F2 — a video post by its video: its post, as Meta's video node names it now.
      let postId = a.postId
      if (a.videoId) {
        postId = (await liveVideoPost(account.accountId, a.videoId)).postId ?? undefined
        if (!postId) return { refusal: `Meta has not named the post of video ${a.videoId} yet (it names it once it has processed the video): ask again in a few minutes; nothing was asked of Meta.` }
      }
      // Re-review N1 — a video post (its record's video, or the video named): its creatives are checked by the video too.
      const state = await livePagePost(account.accountId, postId!, a.videoId ? { videoId: a.videoId } : {})
      const videoId = state.videoId ?? a.videoId
      return pagePostRemoveDraft(state, await liveCreativesUsing(target, { postId: state.postId, ...(videoId ? { videoId } : {}) }))
    }
    const media = await liveIgMedia(account.accountId, a.mediaId!)
    return igMediaRemoveDraft(media, await liveCreativesUsing(target, { mediaId: media.mediaId }))
  } catch (err) {
    if (err instanceof MetaReadError) return { refusal: `Nexus could not read what it must check before deleting (${err.message}); nothing was asked of Meta.` }
    return refusalOf(err)
  }
}

const removePost: AgentTool = {
  name: META_POST_REMOVE_TOOL,
  title: 'Delete a post Nexus made on Meta',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: removeInput,
  description:
    'Delete, on a person\'s explicit ask (confirmDelete: true), a Facebook post Nexus made on the business\'s chosen Page '
    + '(create-meta-page-post; also the undo of a dark or scheduled one) or an Instagram media Nexus published on its chosen '
    + 'Instagram account (create-meta-instagram-post) — never another post, and never one a creative of the chosen ad account '
    + 'shows (Nexus reads its first 500 creatives; remove those ads first with remove-meta-ads-items). FINAL: no undo; to take '
    + 'a Facebook post off the Page but keep it, set-meta-page-post hidden: true. Meta: a Page post delete — "Only select '
    + 'developers can perform this operation using the API. You can use the Business Manager to delete posts." (if Meta '
    + 'refuses, a person deletes it in Meta Business Suite); an Instagram delete covers posts, stories, reels and whole '
    + 'carousels, not ad media, and needs instagram_manage_contents. Meta has no check for a delete. Nothing spends.'
    + META_CHANGE_RULES,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildRemove(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildRemove(args), (draft) => ({
    data: { ...(draft.after as PostRemoveRecord), note: 'Deleted for good.' },
    before: draft.before, after: draft.after, noUndo: 'A delete is final.',
  })),
}

// ── create-meta-instagram-post ─────────────────────────────────────────────────────────────────────────────────────

const username = z.string().trim().regex(/^[A-Za-z0-9._]{1,30}$/, 'an Instagram username (letters, digits, . and _)')
const xy = z.number().min(0).max(1)
const userTags = (what: string) => z.array(z.object({
  username: username.describe('the account to tag'),
  x: xy.describe('images (required) and stories: from the left edge, 0.0–1.0').optional(),
  y: xy.describe('images (required) and stories: from the top edge, 0.0–1.0').optional(),
}).strict().refine((t) => (t.x === undefined) === (t.y === undefined), 'x and y go together')).min(1).max(L.userTags).describe(what)

const igInput = z.object({
  connectionId: metaConnectionArg,
  kind: z.enum(IG_POST_KINDS).describe('image (a feed post) · reel · story (24 hours) · carousel (2–20 images / videos) · upcoming-event (for reminder ads) · publish-container (publish a container an earlier run made, once Meta finished it)'),
  image: imageSource('image / story: the picture (Instagram takes JPEG only)', false).optional(),
  video: videoSource.describe('reel / story: the video — exactly one of libraryVideoId or videoUrl (Meta fetches it)').optional(),
  altText: line(L.altText, 'image: alternative text for people who cannot see it (not reels or stories)').optional(),
  items: z.array(z.object({
    image: imageSource('the item\'s picture (JPEG)', false).optional(),
    video: videoSource.describe('the item\'s video').optional(),
    altText: line(L.altText, 'an image item\'s alternative text').optional(),
    userTags: userTags('accounts tagged on this item').optional(),
  }).strict()).min(L.carouselMin).max(L.carouselMax).describe('carousel: its items in order (an image or a video each)').optional(),
  caption: lines(L.caption, `the caption, EXACTLY as approved (at most ${L.caption} characters, ${L.hashtags} hashtags, ${L.mentions} @ tags — each @ account is notified); not on a story`).optional(),
  collaborators: z.array(username).min(1).max(L.collaborators).describe('image, reel, carousel: up to 3 accounts invited as collaborators (the post shows on their account too once they accept)').optional(),
  userTags: userTags('image, reel, story: accounts tagged in it (an image needs x and y; a reel takes usernames only)').optional(),
  locationId: metaIdArg('image, reel, carousel: the Facebook Page of the place to tag (a Page with a location)').optional(),
  sponsorInstagramIds: z.array(metaIdArg('a brand\'s Instagram account id')).min(1).max(L.sponsors).describe('image, reel, carousel: up to 2 brands tagged as paid partners (the "Paid partnership" label; the brand approves it unless it pre-approved the account)').optional(),
  paidPartnership: z.boolean().describe('image, reel, carousel: the "Paid partnership" label (true without sponsors: label only)').optional(),
  aiGenerated: z.boolean().describe('image, reel, carousel: Meta\'s "made with AI" self-disclosure').optional(),
  shareToFeed: z.boolean().describe('reel: also show it in the feed (false: the Reels tab only)').optional(),
  cover: imageSource('reel: its cover picture (JPEG)', false).optional(),
  thumbOffsetMs: z.number().int().min(0).max(900_000).describe('reel: the frame (in ms) used as its thumbnail when there is no cover').optional(),
  audioName: line(L.audioName, 'reel: the name of its original audio (Meta lets it be named once)').optional(),
  trial: z.enum(['MANUAL', 'SS_PERFORMANCE']).describe('reel: a trial reel, shown to non-followers first — MANUAL (a person graduates it in the app) or SS_PERFORMANCE (Meta graduates it if it performs well)').optional(),
  event: z.object({
    title: line(L.eventTitle, 'the event\'s title'),
    startTime: when('when it starts (ISO 8601)'),
    endTime: when('when it ends (not with notifyRelativeTo EVENT_END)').optional(),
    notifications: z.array(z.enum(META_IG_EVENT_SUBTYPES)).length(3).describe('three reminder times: with EVENT_START (default) EVENT_START, BEFORE_EVENT_1DAY and one of BEFORE_EVENT_15MIN or AFTER_EVENT_1DAY…7DAY; with EVENT_END exactly BEFORE_EVENT_2DAY, BEFORE_EVENT_1DAY, BEFORE_EVENT_1HOUR').optional(),
    notifyRelativeTo: z.enum(['EVENT_START', 'EVENT_END']).describe('reminders relative to the start (default) or the end').optional(),
  }).strict().describe('upcoming-event: the event').optional(),
  containerId: metaIdArg('publish-container: a container an earlier create-meta-instagram-post made (its answer names it)').optional(),
  why: metaWhyArg,
})
type IgArgs = z.infer<typeof igInput>

const buildIg = (args: Record<string, unknown>): MetaDraftBuilder => async (account) => {
  const a = args as unknown as IgArgs
  try {
    const where = await livePostAccount(account.accountId, 'instagram')
    const quota = a.kind === 'upcoming-event' ? null : await liveIgQuota(account.accountId)
    let takenSponsor: string | null = null
    for (const id of a.sponsorInstagramIds ?? []) if (!takenSponsor && await metaLinkTaken('INSTAGRAM', id)) takenSponsor = id
    const takenLocation = a.locationId ? await metaLinkTaken('PAGE', a.locationId) : false
    // A collaborator is invited to co-own the post, a tagged account is notified: never an account another Nexus business
    // chose (step 16's Business Discovery read). Fail closed: a read Meta does not answer as "not found" refuses the post.
    const names = [...new Set([...(a.collaborators ?? []), ...(a.userTags ?? []).map((t) => t.username), ...(a.items ?? []).flatMap((i) => (i.userTags ?? []).map((t) => t.username))].map((n) => n.toLowerCase()))]
    if (names.length > MAX_ACCOUNTS_CHECKED) return { refusal: `A post names at most ${MAX_ACCOUNTS_CHECKED} different Instagram accounts as collaborators or tags in Nexus (each is checked with Meta first).` }
    let takenCollaborator: string | null = null
    for (const name of names) {
      try {
        if (await igUsernameTaken(account.accountId, name)) { takenCollaborator = name; break }
      } catch (err) {
        if (err instanceof MetaReadError) return { refusal: `Nexus could not check whether Instagram account ${name} is one another business in Nexus uses (${err.message}), so nothing was asked of Meta: leave that account out, or ask again.` }
        throw err
      }
    }
    let container: { made: boolean; state: Awaited<ReturnType<typeof liveIgContainer>> } | undefined
    if (a.kind === 'publish-container' && a.containerId) {
      const made = await igContainerNexusMade(account.accountId, a.containerId)
      let state: Awaited<ReturnType<typeof liveIgContainer>> = null
      if (made.made) { try { state = await liveIgContainer(account.accountId, a.containerId) } catch (err) { if (!(err instanceof MetaReadError)) throw err } }
      container = { made: made.made, state }
    }
    return await igPostCreateDraft(a as IgPostInput, { instagramId: where.instagramId!, connectionId: account.accountId, quota, takenSponsor, takenLocation, takenCollaborator, container })
  } catch (err) { return refusalOf(err) }
}

function igFinish(draft: MetaChangeDraft, done: Array<{ request: MetaChangeRequest; result: MetaChangeResult }>) {
  const after: IgPostRecord = igPostMade(draft, done)
  const later = !after.mediaId && after.containerId && after.kind !== 'upcoming-event'
  return {
    data: {
      kind: after.kind, instagramId: after.instagramId,
      ...(after.mediaId ? { mediaId: after.mediaId } : {}), ...(after.containerId ? { containerId: after.containerId } : {}), ...(after.eventId ? { eventId: after.eventId } : {}),
      note: after.mediaId
        ? `PUBLIC now. meta-instagram-media view media-detail mediaId ${after.mediaId} reads it; remove-meta-page-post platform instagram deletes it on an explicit ask (no edit by API).`
        : after.eventId ? 'meta-instagram-media view upcoming-events lists it; a reminder ad names it in its creative.'
          : later ? `Nothing is public: container ${after.containerId} waits (Meta keeps it 24 hours) — create-meta-instagram-post kind publish-container containerId ${after.containerId} publishes it once Meta finished.` : 'Meta made nothing public.',
    },
    before: draft.before,
    after,
    // Review A-5 / B-F12 — what has no undo, in its own words (an event, a post that is public, or nothing published at all).
    noUndo: later ? `Nothing is public, so nothing needs undoing: container ${after.containerId} expires by itself in 24 hours unless published (kind publish-container).`
      : after.mediaId ? 'An Instagram post has no undo (it is public, and Meta has no edit by API); remove-meta-page-post deletes it on an explicit ask.'
        : after.eventId ? 'An upcoming event has no undo: Meta documents no delete of one (it ends at its time).'
          : 'Nothing was published, so nothing needs undoing (containers Meta made expire by themselves in 24 hours).',
  }
}

const createIgPost: AgentTool = {
  name: META_IG_POST_CREATE_TOOL,
  title: 'Post on Instagram',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Published Instagram media is public at once and Meta has no edit of it; an upcoming event has no delete.
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: igInput,
  description:
    'Post on the business\'s chosen Instagram account, as its Page: an image (feed), a reel, a story (24 hours) or a carousel '
    + '(2–20 images and videos) — Nexus makes its media container(s) from a library file or a public https link (Meta fetches '
    + 'it; Instagram takes JPEG images only), reads their state at once and then once a minute, for at most 5 minutes, until Meta finished them, then PUBLISHES: PUBLIC at once, '
    + 'buyers see it. With a caption (exactly as approved), collaborators (up to 3), people tags, a place, the paid-partnership '
    + 'label (up to 2 brands, never another Nexus business\'s), the made-with-AI label, and for a reel its cover, audio name, '
    + 'feed sharing and trial reel. A container Meta is still preparing is not published: the answer names it, and kind '
    + 'publish-container publishes it later (Meta keeps it 24 hours). Also an upcoming event for reminder ads. Instagram\'s '
    + 'limit of API posts per 24 hours is read first. Product tags are not set here yet. Meta has no check for any of these; '
    + 'nothing spends (boosting is create-meta-boost). As the Page: the gateway reads its token for each request (the system '
    + 'user needs CREATE_CONTENT or MANAGE on the Page, and instagram_basic, instagram_content_publish, pages_read_engagement). '
    + 'No undo: Meta has no edit of a published Instagram post by API and no delete of an upcoming event; remove-meta-page-post '
    + 'deletes a post Nexus published on an explicit ask.'
    + META_CHANGE_RULES,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildIg(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildIg(args), igFinish),
}

export const META_ADS_POSTS_TOOLS: AgentTool[] = [createPagePost, setPagePost, removePost, createIgPost]

/**
 * Meta ads changes, step 37 (2026-10-21) — comments and moderation (master rows EN-006…EN-010, EN-014, EN-021…EN-025,
 * EN-028, EN-031, EN-032, OT-032; Owner decision D5):
 *   set-meta-comments   hide / unhide, delete (explicit ask), reply, comment, edit the Page's own comment, like / unlike,
 *                       block / unblock a person on the Page, comments on / off for one Instagram media, reply where the
 *                       Instagram account was @mentioned — on the business's CHOSEN Facebook Page's posts, its CHOSEN
 *                       Instagram account's media and the Threads posts of its own ads.
 * A Nexus change like every other Meta change (meta-ads-kit.ts): a preview from the live state (Meta has no check for any of
 * these: said), an approvalId, a person approves it, it runs as that person, undo puts back what Meta allows.
 *
 * Facebook and Instagram requests go AS the Page: the gateway reads the chosen Page's own token for that one call
 * (gateway/meta-page-token.ts) and sends it only for an object it confirmed is the Page's or the chosen Instagram account's
 * (gateway/meta-comment-owner.ts). Threads requests go with the system-user token (ads_management of the ad account that owns
 * the ad). The tool never sees a token. Nexus keeps no person's words or name. An id you name for a block is kept in the
 * change record, for its undo (marketing/meta-ads/live-comments.ts).
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import { META_COMMENTS_TOOL } from '../../gateway/account.js'
import { META_COMMENT_LIMITS, META_COMMENT_TEXT } from '../../gateway/meta-comment-rules.js'
import { metaLeadUrlProblem } from '../../gateway/meta-lead-form-rules.js'
import {
  ADVANTAGE_CATALOG, COMMENT_ACTIONS, COMMENT_DELETE_FINAL, COMMENT_PLATFORMS, brandedHideDraft, editUndoProblem, facebookCommentDraft, facebookDeleteDraft, facebookEditDraft, facebookHideDraft,
  facebookLikeDraft, instagramCommentDraft, instagramCommentsSwitchDraft, instagramDeleteDraft, instagramHideDraft, instagramMentionDraft, instagramReplyDraft, pageBlockDraft,
  threadsHideDraft, threadsReplyDraft, type CommentAction, type CommentPlatform, type CommentRecord,
} from '../../marketing/meta-ads/change-comments.js'
import {
  liveBrandedComment, liveCommentAccount, liveFacebookComment, liveFacebookPost, liveInstagramComment, liveInstagramMedia, liveInstagramMention, livePageBlocked, liveThreadsReply,
} from '../../marketing/meta-ads/live-comments.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import type { MetaChangeDraft, MetaChangeRequest } from '../../marketing/meta-ads/change-draft.js'
import type { MetaChangeResult } from '../../marketing/meta-ads/write-client.js'

const httpsUrl = (what: string) => z.string().trim().max(META_COMMENT_LIMITS.url).refine((v) => metaLeadUrlProblem(v, 'it') === null, 'an https link (https://…, a host, no user or password)').describe(what)

const input = z.object({
  connectionId: metaConnectionArg,
  action: z.enum(COMMENT_ACTIONS).describe(
    'hide / unhide (out of public view, not deleted — the reversible choice) · delete (for good: explicit ask, confirmDelete) · reply (to a comment) · '
    + 'comment (on a post, an Instagram media or an ad\'s Threads post) · edit (the Facebook Page\'s OWN comment) · like / unlike (Facebook, as the Page) · '
    + 'block / unblock (a person or Page on the Facebook Page) · comments-off / comments-on (one Instagram media) · reply-to-mention (Instagram: where another '
    + 'account @mentioned the business\'s account)'),
  platform: z.enum(COMMENT_PLATFORMS).describe('facebook (the chosen Page\'s posts and the ads\' posts), instagram (the chosen Instagram account\'s media and the ads\' Instagram media), threads (the Threads post of one of the business\'s ads)'),
  postId: z.string().trim().regex(/^\d{1,25}_\d{1,25}$/, '<Page id>_<post id>').optional()
    .describe('facebook: the chosen Page\'s post (<Page id>_<post id>, meta-page-posts / meta-comments) — or give adId'),
  adId: metaIdArg('an ad of the chosen ad account: its Facebook post (facebook), its Instagram media (instagram) or its Threads post (threads: required)').optional(),
  commentId: z.string().trim().regex(/^\d{1,25}(_\d{1,25})?$/, 'a Meta comment id').optional()
    .describe('the comment: Facebook <post id>_<comment id>; Instagram digits; Threads a direct reply of the ad\'s Threads post (meta-comments shows each)'),
  brandedPostId: z.string().trim().regex(/^\d{1,25}_\d{1,25}$/, '<creator Page id>_<post id>').optional()
    .describe('facebook hide / unhide only: a creator\'s branded-content post that tags the chosen Page as its sponsor (meta-partnerships branded posts) — the brand hides comments there without the creator'),
  mediaId: metaIdArg('instagram: the chosen account\'s media (comment, comments-off / on) — or give adId; reply-to-mention: the other account\'s media the account was @mentioned in').optional(),
  personId: metaIdArg('facebook block / unblock: the person\'s Page-scoped id (PSID, as meta-comments view blocked lists it; kept in the change record for the undo) — or give the comment whose author it is').optional(),
  message: z.string().min(1).max(META_COMMENT_LIMITS.facebook).regex(META_COMMENT_TEXT, 'printable text (line breaks allowed; no control or format characters)').optional()
    .describe(`reply / comment / edit / reply-to-mention: the EXACT words, as the person approved them (sent as written, nothing added; at most ${META_COMMENT_LIMITS.facebook} characters on Facebook, ${META_COMMENT_LIMITS.instagram} on Instagram, ${META_COMMENT_LIMITS.threads} on Threads)`),
  imageUrl: httpsUrl('facebook reply / comment / edit: an image Meta fetches from this https link (Nexus uploads no file)').optional(),
  gifUrl: httpsUrl('facebook reply / comment / edit: a GIF Meta fetches from this https link').optional(),
  confirmDelete: z.literal(true).optional().describe('delete: true — the person asked to delete it (a deleted comment cannot come back; hide it instead)'),
  why: metaWhyArg,
})

type Args = z.infer<typeof input>

/** The arguments each action takes, checked before any read: an argument it does not use is refused. */
function argsRefusal(a: Args): string | null {
  const words = a.action === 'reply' || a.action === 'comment' || a.action === 'edit' || a.action === 'reply-to-mention'
  if (!words && a.message !== undefined) return 'message is for reply, comment, edit and reply-to-mention only.'
  if (words && a.message === undefined && !(a.platform === 'facebook' && (a.imageUrl || a.gifUrl) && a.action !== 'reply-to-mention')) return `${a.action} sends the exact words: give message.`
  if ((a.imageUrl || a.gifUrl) && !(a.platform === 'facebook' && (a.action === 'reply' || a.action === 'comment' || a.action === 'edit'))) return 'imageUrl and gifUrl are for a Facebook reply, comment or edit only (Instagram and Threads take text only).'
  if (a.action !== 'delete' && a.confirmDelete) return 'confirmDelete is for action delete only.'
  if (a.action === 'delete' && a.confirmDelete !== true) return `Deleting is only on an explicit ask: confirmDelete: true. ${COMMENT_DELETE_FINAL}`
  if (a.brandedPostId && !(a.platform === 'facebook' && (a.action === 'hide' || a.action === 'unhide'))) return 'brandedPostId is for a Facebook hide or unhide only (Meta lets a brand only hide comments on a creator\'s branded-content post).'
  if (a.personId && !(a.platform === 'facebook' && (a.action === 'block' || a.action === 'unblock'))) return 'personId is for a Facebook block or unblock only.'
  if (a.postId && a.platform !== 'facebook') return 'postId is a Facebook post: for Instagram give mediaId or adId, for Threads adId.'
  if (a.mediaId && a.platform !== 'instagram') return 'mediaId is an Instagram media.'
  return null
}

/** The refusals per platform for what Meta has no API for, in plain words. */
const NOT_ON: Readonly<Record<CommentPlatform, Partial<Record<CommentAction, string>>>> = {
  facebook: {
    'comments-off': 'Switching comments off is for one Instagram media (platform instagram); on Facebook, hide or delete the comments, or limit who can comment on the post in Meta Business Suite.',
    'comments-on': 'Switching comments on is for one Instagram media (platform instagram).',
    'reply-to-mention': 'Replying where the account was @mentioned is Instagram\'s (platform instagram).',
  },
  instagram: {
    edit: 'Meta has no edit for an Instagram comment: delete it and comment again.',
    like: 'Meta has no API to like an Instagram comment or media as the account.',
    unlike: 'Meta has no API to like or unlike an Instagram comment or media as the account.',
    block: 'Meta\'s API blocks people from a Facebook Page only; to block or restrict someone on Instagram, a person does it in the Instagram app.',
    unblock: 'Meta\'s API unblocks people on a Facebook Page only; on Instagram a person does it in the Instagram app.',
  },
  threads: {
    delete: 'Nexus cannot delete a reply on a Threads ad: the Threads API deletes only with a Threads login token and threads_delete, which Nexus does not hold. Hide it instead (action hide).',
    edit: 'Meta has no edit for a reply on a Threads ad.',
    like: 'Meta has no API to like a reply on a Threads ad.',
    unlike: 'Meta has no API to like or unlike a reply on a Threads ad.',
    block: 'Meta\'s API blocks people from a Facebook Page only.',
    unblock: 'Meta\'s API unblocks people on a Facebook Page only.',
    'comments-off': 'Switching comments off is for one Instagram media.',
    'comments-on': 'Switching comments on is for one Instagram media.',
    'reply-to-mention': 'Replying where the account was @mentioned is Instagram\'s.',
  },
}

const NO_POST_BEHIND_AD = /Meta names no (Facebook post|Instagram media) behind that ad/

const need = (value: string | undefined, sentence: string): string => {
  if (!value) throw new MetaLiveRefusal(sentence)
  return value
}

/** The draft of one request, from the live state (MetaLiveRefusal = a refusal in words). */
const buildComments = (args: Record<string, unknown>): MetaDraftBuilder => async (account) => {
  const a = args as unknown as Args
  const argProblem = argsRefusal(a)
  if (argProblem) return { refusal: argProblem }
  const notOn = NOT_ON[a.platform][a.action]
  if (notOn) return { refusal: notOn }
  const conn = account.accountId
  const words = { ...(a.message !== undefined ? { message: a.message } : {}), ...(a.imageUrl ? { imageUrl: a.imageUrl } : {}), ...(a.gifUrl ? { gifUrl: a.gifUrl } : {}) }
  try {
    if (a.platform === 'facebook') {
      const post = { postId: a.postId ?? null, adId: a.adId ?? null }
      const comment = async () => liveFacebookComment(conn, { ...post, commentId: need(a.commentId, 'Name the comment (commentId) and its post (postId or adId).') })
      switch (a.action) {
        case 'hide':
        case 'unhide':
          if (a.brandedPostId) return brandedHideDraft(a.action, await liveBrandedComment(conn, { brandedPostId: a.brandedPostId, commentId: need(a.commentId, 'Name the comment on the branded-content post (commentId).') }))
          return facebookHideDraft(a.action, await comment())
        case 'delete': return facebookDeleteDraft(await comment())
        case 'reply': {
          const s = await comment()
          return facebookCommentDraft({ pageId: s.pageId, postId: s.postId, commentId: s.commentId, canReply: s.canReply, hidden: s.hidden }, words)
        }
        case 'comment': {
          if (a.commentId) return { refusal: 'comment goes on a post (postId or adId); to answer a comment use action reply.' }
          const p = await liveFacebookPost(conn, post)
          return facebookCommentDraft(p, words)
        }
        case 'edit': return facebookEditDraft(await liveFacebookComment(conn, { ...post, commentId: need(a.commentId, 'Name the Page\'s comment (commentId) and its post (postId or adId).'), pageText: true }), words)
        case 'like':
        case 'unlike': {
          if (a.commentId) { const s = await comment(); return facebookLikeDraft(a.action, { pageId: s.pageId, postId: s.postId, commentId: s.commentId }) }
          return facebookLikeDraft(a.action, await liveFacebookPost(conn, post))
        }
        case 'block':
        case 'unblock': {
          if (a.personId && a.commentId) return { refusal: 'Name the person either by personId or by a comment of theirs (commentId), not both.' }
          if (a.personId) {
            const page = await liveCommentAccount(conn)
            if (!page.pageId) return { refusal: 'No Facebook Page is chosen for this business yet. A person chooses it in Settings › Channels › Meta, or Claude asks for it with set-meta-connection (a person approves it).' }
            return pageBlockDraft(a.action, { pageId: page.pageId, personId: a.personId, via: 'id' }, await livePageBlocked(conn, a.personId))
          }
          const s = await comment()
          // A comment's `from.id` is the commenter's Page-scoped id (pages-api/comments-mentions.md): blocked by psid.
          if (!s.authorId) return { refusal: `Meta does not say who wrote comment ${s.commentId} (it answers a comment's author to the Page's MODERATE task), so Nexus cannot name them; block them in the Page's settings, or give personId.` }
          if (s.byThePage) return { refusal: `Comment ${s.commentId} was written by the chosen Page itself.` }
          return pageBlockDraft(a.action, { pageId: s.pageId, personId: s.authorId, via: 'comment', postId: s.postId, commentId: s.commentId }, await livePageBlocked(conn, s.authorId))
        }
        default: return { refusal: `${a.action} is not a Facebook comment change.` }
      }
    }
    if (a.platform === 'instagram') {
      const igComment = async () => liveInstagramComment(conn, need(a.commentId, 'Name the Instagram comment (commentId, meta-comments view instagram).'))
      const media = async () => liveInstagramMedia(conn, { mediaId: a.mediaId ?? null, adId: a.adId ?? null })
      switch (a.action) {
        case 'hide':
        case 'unhide': return instagramHideDraft(a.action, await igComment())
        case 'delete': return instagramDeleteDraft(await igComment())
        case 'reply': return instagramReplyDraft(await igComment(), a.message!)
        case 'comment':
          if (a.commentId) return { refusal: 'comment goes on a media (mediaId or adId); to answer a comment use action reply.' }
          return instagramCommentDraft(await media(), a.message!)
        case 'comments-off':
        case 'comments-on': return instagramCommentsSwitchDraft(a.action, await media())
        case 'reply-to-mention':
          return instagramMentionDraft(await liveInstagramMention(conn, { mediaId: need(a.mediaId, 'Name the media the account was @mentioned in (mediaId, from Meta\'s mention notification or meta-comments view mentioned-media / mentioned-comment).'), commentId: a.commentId ?? null }), a.message!)
        default: return { refusal: `${a.action} is not an Instagram comment change.` }
      }
    }
    const adId = need(a.adId, 'Name the ad (adId: an ad of the chosen ad account that runs on Threads).')
    switch (a.action) {
      case 'hide':
      case 'unhide': return threadsHideDraft(a.action, await liveThreadsReply(conn, { adId, replyId: need(a.commentId, 'Name the reply (commentId: a direct reply of the ad\'s Threads post, meta-comments view threads-replies).') }))
      case 'reply': return threadsReplyDraft(await liveThreadsReply(conn, { adId, replyId: need(a.commentId, 'Name the reply to answer (commentId), or use action comment to reply to the ad\'s Threads post.') }), a.message!)
      case 'comment':
        if (a.commentId) return { refusal: 'comment goes on the ad\'s Threads post; to answer a reply use action reply.' }
        return threadsReplyDraft(await liveThreadsReply(conn, { adId }), a.message!)
      default: return { refusal: `${a.action} is not a Threads change.` }
    }
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: a.adId && NO_POST_BEHIND_AD.test(err.message) ? `${err.message} ${ADVANTAGE_CATALOG[a.platform]}` : err.message }
    throw err
  }
}

const idOf = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null)
const MADE: ReadonlySet<string> = new Set(['fbcomment.create', 'igcomment.reply', 'igmedia.comment', 'iguser.mention', 'threads.reply'])

/** What a recorded change reads now, in the shape of its `after` (an unreadable state: as recorded — its undo answers for itself). */
async function currentOf(after: CommentRecord, connectionId: string): Promise<CommentRecord> {
  const ids = { postId: after.postId ?? null, adId: after.adId ?? null }
  switch (after.action) {
    case 'hide':
    case 'unhide':
      if (after.platform === 'facebook') {
        const s = after.brandedPostId
          ? await liveBrandedComment(connectionId, { brandedPostId: after.brandedPostId, commentId: after.commentId! })
          : await liveFacebookComment(connectionId, { ...ids, commentId: after.commentId! })
        return { ...after, hidden: s.hidden }
      }
      if (after.platform === 'instagram') return { ...after, hidden: (await liveInstagramComment(connectionId, after.commentId!)).hidden }
      return { ...after, hidden: (await liveThreadsReply(connectionId, { adId: after.adId!, replyId: after.commentId })).hidden }
    case 'reply':
    case 'comment':
      if (!after.replyId || after.platform === 'threads') return after
      // The reply Nexus made is still there (its undo deletes exactly it): else it reads as gone.
      try {
        if (after.platform === 'facebook') await liveFacebookComment(connectionId, { postId: after.postId ?? null, commentId: after.replyId })
        else await liveInstagramComment(connectionId, after.replyId)
        return after
      } catch (err) {
        if (err instanceof MetaLiveRefusal) return { ...after, replyId: null }
        throw err
      }
    case 'edit':
      return { ...after, message: (await liveFacebookComment(connectionId, { ...ids, commentId: after.commentId!, pageText: true })).pageText }
    case 'block':
    case 'unblock': {
      let person = after.personId ?? null
      if (after.via === 'comment') person = (await liveFacebookComment(connectionId, { ...ids, commentId: after.commentId! })).authorId
      if (!person) return { ...after, blocked: null }
      const now = await livePageBlocked(connectionId, person)
      return now.blocked === null ? after : { ...after, blocked: now.blocked }
    }
    case 'comments-off':
    case 'comments-on':
      return { ...after, commentsEnabled: (await liveInstagramMedia(connectionId, { mediaId: after.mediaId ?? null })).commentsEnabled }
    default:
      // like / unlike: Meta answers no read of the Page's own like to the system user — as recorded; delete, mention: no undo.
      return after
  }
}

const OPPOSITE: Partial<Record<CommentAction, CommentAction>> = { hide: 'unhide', unhide: 'hide', like: 'unlike', unlike: 'like', block: 'unblock', unblock: 'block', 'comments-off': 'comments-on', 'comments-on': 'comments-off' }

const undo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as CommentRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    try {
      const now = await currentOf(after, account.accountId)
      return { ...now, accountId: account.accountId, adAccountId: account.adAccountId }
    } catch (err) {
      if (err instanceof MetaLiveRefusal) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as CommentRecord & { accountId?: string }
    const base = { ...(after.accountId ? { connectionId: after.accountId } : {}), platform: after.platform }
    const why = `undo of an earlier ${after.action} (set-meta-comments)`
    const where = {
      ...(after.postId ? { postId: after.postId } : {}), ...(after.adId ? { adId: after.adId } : {}), ...(after.brandedPostId ? { brandedPostId: after.brandedPostId } : {}),
    }
    const opposite = OPPOSITE[after.action]
    if (opposite) {
      if (after.action === 'block' || after.action === 'unblock') {
        return { tool: META_COMMENTS_TOOL, args: { ...base, action: opposite, ...(after.via === 'id' ? { personId: after.personId } : { ...where, commentId: after.commentId }), why } }
      }
      if (after.action === 'comments-off' || after.action === 'comments-on') return { tool: META_COMMENTS_TOOL, args: { ...base, action: opposite, mediaId: after.mediaId, why } }
      return { tool: META_COMMENTS_TOOL, args: { ...base, action: opposite, ...where, ...(after.commentId ? { commentId: after.commentId } : {}), why } }
    }
    if (after.action === 'reply' || after.action === 'comment') {
      if (after.platform === 'threads') return { refusal: 'A reply on a Threads ad cannot be deleted by Nexus (the Threads API deletes only with a Threads login token and threads_delete, which Nexus does not hold): hide it with set-meta-comments action hide.' }
      if (!after.replyId) return { refusal: 'This change kept no id of the reply it made, so there is nothing to delete.' }
      return { tool: META_COMMENTS_TOOL, args: { ...base, action: 'delete', ...(after.platform === 'facebook' ? { postId: after.postId } : {}), commentId: after.replyId, confirmDelete: true, why: `${why}: deletes the reply Nexus made` } }
    }
    if (after.action === 'edit') {
      // Review fix A2 — the same rule as the preview: the old words only when Nexus can send them again exactly.
      const noUndo = editUndoProblem(after.oldMessage)
      if (noUndo) return { refusal: `This edit has no undo: ${noUndo}.` }
      return { tool: META_COMMENTS_TOOL, args: { ...base, action: 'edit', postId: after.postId, commentId: after.commentId, message: after.oldMessage, why } }
    }
    if (after.action === 'reply-to-mention') return { refusal: 'A reply on another account\'s media cannot be deleted by the business (Meta lets only the media\'s owner delete it).' }
    return { refusal: COMMENT_DELETE_FINAL }
  },
}

/** What Meta made, from each done request: the new reply's id (its answer, or its read-back). */
function finishOf(draft: MetaChangeDraft, done: Array<{ request: MetaChangeRequest; result: MetaChangeResult }>) {
  const after = { ...(draft.after as CommentRecord) }
  const made = done.find(({ request }) => MADE.has(request.operation ?? ''))
  if (made) after.replyId = idOf(made.result.node?.id)
  // A block Meta answered `{<id>: false}` is not a block: say so (the person's id itself is never kept).
  const blockAnswer = done.find(({ request }) => request.operation === 'pageblock.create')?.result.node
  const notBlocked = blockAnswer && Object.values(blockAnswer).some((v) => v === false)
  if (notBlocked) after.blocked = null
  return {
    data: {
      action: after.action, platform: after.platform,
      ...(after.postId ? { postId: after.postId } : {}), ...(after.mediaId ? { mediaId: after.mediaId } : {}), ...(after.commentId ? { commentId: after.commentId } : {}),
      ...(after.brandedPostId ? { brandedPostId: after.brandedPostId } : {}), ...(after.adId ? { adId: after.adId } : {}),
      ...(made ? { replyId: after.replyId, note: after.replyId ? 'meta-comments shows it. Its id is kept with this change: its undo deletes it (Threads and mention replies: no undo).' : 'Meta made it but Nexus could not read its id from Meta\'s answer: meta-comments shows it.' } : {}),
      ...(notBlocked ? { note: 'Meta answered that it did not block them (false): the Page\'s blocked list (meta-comments view blocked) shows who is blocked.' } : {}),
    },
    before: { ...(draft.before as CommentRecord) },
    after,
  }
}

const setMetaComments: AgentTool = {
  name: META_COMMENTS_TOOL,
  title: 'Moderate Meta comments',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // hide ⇄ unhide, like ⇄ unlike, block ⇄ unblock, comments off ⇄ on and an edit are undone; a reply Nexus made is deleted by
  // its undo; a delete, a Threads reply and a reply on another account's media cannot be taken back.
  reversibility: 'partial',
  consequencesFor: (args) => {
    if (args.action === 'delete' || args.action === 'reply-to-mention') return { reversibility: 'none' }
    if ((args.action === 'reply' || args.action === 'comment') && args.platform === 'threads') return { reversibility: 'none' }
    // Review fix A2 — an edit is undone only when the old words can be sent again (read live: the preview says when not).
    if (args.action === 'edit') return { reversibility: 'partial' }
    // A reply or comment was public until its undo deletes it; an unblock's undo meets Meta's "not so soon" (3802).
    if (args.action === 'reply' || args.action === 'comment' || args.action === 'unblock') return { reversibility: 'partial' }
    return typeof args.action === 'string' ? { reversibility: 'full' } : null
  },
  maxClaudeTrust: 'ask',
  // A reply is public at once and speaks as the business, to a person: the buyer-message tools' permission too.
  requires: [F.adsCampaignsManage, F.ordersEdit],
  input,
  description:
    'Moderate and answer comments on the business\'s chosen Facebook Page\'s posts, its chosen Instagram account\'s media and '
    + 'the Threads posts of its own ads (an ad\'s post or media is found from adId). Facebook: hide / unhide a comment (also '
    + 'on a creator\'s branded-content post that tags the Page: brandedPostId), delete one (confirmDelete: true — final; hide '
    + 'is the reversible choice), reply to a comment or comment on a post as the Page (text, an image or GIF link), edit the '
    + 'Page\'s OWN comment, like / unlike a post or comment as the Page (a Page review cannot be liked), block / unblock a '
    + 'person by their Page-scoped id (psid: a comment of theirs, or personId; Meta: 3801 block limit, 3802 not so soon after '
    + 'an unblock; a Page that commented is blocked in the Page\'s settings). '
    + 'Instagram (as the account): hide / unhide (its own comments always show), delete (only on its own media), reply to a '
    + 'top-level comment (not a hidden one), comment on its own media, switch comments off / on for one media (read back '
    + 'is_comment_enabled; not a carousel item), reply where another account @mentioned it (no undo). Threads ads: hide / '
    + 'unhide a direct reply, reply to the ad\'s post or a direct reply (text only; no undo: the Threads API deletes only with '
    + 'a Threads login token and threads_delete, which Nexus does not hold). Nexus does not moderate comments on Advantage+ '
    + 'catalog ads (Meta documents none on Instagram and Threads). A reply or comment is PUBLIC at once and speaks as the business: the '
    + 'preview shows the exact words, sent as written. Meta has no check for any of these. Nothing spends. Facebook and '
    + 'Instagram go AS the Page (Nexus\'s gateway reads the chosen Page\'s own token for each request; the system user needs '
    + 'the Page\'s MODERATE task, and CREATE_CONTENT for a comment or like) — a token is never shown; Threads goes with the ad '
    + 'account\'s token. Nexus keeps no person\'s words or name. An id you name for a block is kept in the change record, for '
    + 'its undo. meta-comments reads the comments (Instagram has no comment webhook without Advanced access: Nexus '
    + 'checks the newest Instagram posts every 15 minutes and tells the business of new comments). Undo: hide ⇄ unhide, like ⇄ '
    + 'unlike, block ⇄ unblock, comments off ⇄ on, an edit writes the old words back (only when it had words Nexus can send '
    + 'again — else the preview says it has no undo), a reply Nexus made is deleted.'
    + META_CHANGE_RULES,
  undo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildComments(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildComments(args), finishOf),
}

export const META_ADS_COMMENTS_TOOLS: AgentTool[] = [setMetaComments]

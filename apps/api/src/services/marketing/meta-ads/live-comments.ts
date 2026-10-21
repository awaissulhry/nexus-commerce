/**
 * Meta step 37 (2026-10-21) — the live state a comment change stands on, read through the gateway (GET only, the business's
 * system-user token) and step 14's checks (live-engagement.ts: postOf, ownFacebookComment, mediaOf, ownInstagramComment,
 * threadsMediaOf), never copied. Only the business's CHOSEN Page, Instagram account and ad account.
 *
 * PEOPLE'S DATA. A comment's words and its author are a person's: nothing here returns a person's words, name or username,
 * and the author's Page-scoped id (PSID, the one a block needs — pages-api/comments-mentions.md: a comment's `from.id`)
 * stays in memory for the request that is sent — never in a preview, a change record or a log. (An id a PERSON names for a
 * block is kept in the change record, for its undo: the tool's.) The Page's OWN comment text is the business's words: it
 * is read for an edit (and its undo).
 */
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { metaChosenAccount, MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { fieldRefused, listPaged } from './live-objects.js'
import { instagramOf, onPage, pageOf } from './live-media.js'
import { liveComments, mediaOf, ownFacebookComment, ownInstagramComment, postOf, threadsMediaOf } from './live-engagement.js'

type Row = Record<string, unknown>
const idText = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/**
 * The fields of a Facebook comment a change needs (Comment reference v26 / SDK comment.py) — never its words: `message` is
 * asked only for an edit, which changes only the Page's own comment (FB_PAGE_TEXT_FIELD).
 */
export const FB_COMMENT_STATE_FIELDS = 'id,is_hidden,can_hide,can_remove,can_comment,from{id}'
/**
 * Review fix B4 — the can_* flags are the VIEWER's (the system user's read), not the Page's, and the v26 Comment page no
 * longer lists can_hide / can_remove: they only warn, and when Meta refuses them the comment is read without them.
 */
export const FB_COMMENT_CORE_FIELDS = 'id,is_hidden,from{id}'
export const FB_PAGE_TEXT_FIELD = 'message'
/**
 * The fields of an Instagram comment a change needs (ig-comment.md). Review fix B3 — `user` (the IG User who wrote it, "only
 * returned if the app user created the IG Comment") tells the account's own comment; `from.id` is the commenter's IGSID,
 * never the account's id, so it is not asked.
 */
export const IG_COMMENT_STATE_FIELDS = 'id,hidden,parent_id,user,media{id,media_product_type}'
/** The fields of an Instagram media a change needs (instagram-media.md: is_comment_enabled excludes album children). */
export const IG_MEDIA_STATE_FIELDS = 'id,is_comment_enabled,media_product_type,media_type'

export interface CommentAccount { connectionId: string; pageId: string | null; instagramId: string | null }

/** The chosen Page and Instagram account of the business, as a comment change names them. */
export async function liveCommentAccount(connectionId: string): Promise<CommentAccount> {
  const account = await metaChosenAccount(connectionId)
  return { connectionId: account.connectionId, pageId: account.pageId, instagramId: account.instagramId }
}

/** A post of the chosen Page: postId, or the Facebook post behind one of the chosen account's ads (step 14's postOf). */
export async function liveFacebookPost(connectionId: string, input: { postId?: string | null; adId?: string | null }): Promise<{ pageId: string; postId: string }> {
  const account = await metaChosenAccount(connectionId)
  const pageId = pageOf(account)
  return { pageId, postId: await postOf(account, { view: 'post', postId: input.postId ?? null, adId: input.adId ?? null }) }
}

export interface FacebookCommentState {
  pageId: string
  postId: string
  commentId: string
  hidden: boolean | null
  canHide: boolean | null
  canRemove: boolean | null
  canReply: boolean | null
  /** Written by the chosen Page itself (null: Meta did not say). */
  byThePage: boolean | null
  /** The Page's OWN words (only when byThePage; never a person's). */
  pageText: string | null
  /** In memory only: the author's Page-scoped id (PSID), for a block. Never stored, shown or logged. */
  authorId: string | null
}

/** One comment on a post of the chosen Page (step 14's ownFacebookComment first), as a change needs it. */
export async function liveFacebookComment(connectionId: string, input: { postId?: string | null; adId?: string | null; commentId: string; pageText?: boolean }): Promise<FacebookCommentState> {
  const account = await metaChosenAccount(connectionId)
  const pageId = pageOf(account)
  const postId = await postOf(account, { view: 'comment', postId: input.postId ?? null, adId: input.adId ?? null })
  const own = await ownFacebookComment(account, postId, input.commentId)
  return facebookCommentState(account, pageId, own.postId, own.commentId, input.pageText === true)
}

async function facebookCommentState(account: MetaChosenAccount, pageId: string, postId: string, commentId: string, withText: boolean): Promise<FacebookCommentState> {
  const withWords = (f: string) => (withText ? `${f},${FB_PAGE_TEXT_FIELD}` : f)
  const readWith = (f: string) => onPage(() => metaReadOne<Row>({ connectionId: account.connectionId }, { operation: 'comments.changeState', path: commentId, query: { fields: withWords(f) } }))
  let read: { body: Row }
  try {
    read = await readWith(FB_COMMENT_STATE_FIELDS)
  } catch (err) {
    if (!fieldRefused(err)) throw err
    read = await readWith(FB_COMMENT_CORE_FIELDS)
  }
  const b = read.body
  if (idText(b.id) !== commentId) throw new MetaLiveRefusal('Meta answered with another comment than the one asked; nothing is changed.')
  const author = idText(obj(b.from)?.id)
  const byThePage = author === null ? null : author === pageId
  return {
    pageId, postId, commentId,
    hidden: bool(b.is_hidden), canHide: bool(b.can_hide), canRemove: bool(b.can_remove), canReply: bool(b.can_comment),
    byThePage,
    pageText: byThePage && withText ? text(b.message) : null,
    authorId: author,
  }
}

/**
 * OT-032 — a comment on a creator's branded-content post that tags the chosen Page as its sponsor: the post's
 * `sponsor_tags` edge (graph-api/reference/post) must list the chosen Page; the comment must carry the post's own id.
 */
export async function liveBrandedComment(connectionId: string, input: { brandedPostId: string; commentId: string }): Promise<{ pageId: string; brandedPostId: string; commentId: string; hidden: boolean | null; canHide: boolean | null }> {
  const account = await metaChosenAccount(connectionId)
  const pageId = pageOf(account)
  const post = /^(\d{1,25})_(\d{1,25})$/.exec(input.brandedPostId.trim())
  if (!post) throw new MetaLiveRefusal(`"${input.brandedPostId}" is not a Facebook post id (<creator Page id>_<post id>, as the branded-content posts of meta-partnerships give it).`)
  const commentId = input.commentId.trim()
  if (!new RegExp(`^${post[2]}_\\d{1,25}$`).test(commentId)) throw new MetaLiveRefusal('That comment is not on that branded-content post, so nothing is changed.')
  const tags = await onPage(() => listPaged(account.connectionId, 'comments.brandedSponsorCheck', `${post[0]}/sponsor_tags`, { fields: 'id' }, 100))
  if (!tags.rows.some((r) => idText(r.id) === pageId)) throw new MetaLiveRefusal('That post does not tag the Facebook Page this business chose as its branded-content sponsor, so its comments are not changed here.')
  const read = await onPage(() => metaReadOne<Row>({ connectionId: account.connectionId }, { operation: 'comments.brandedState', path: commentId, query: { fields: 'id,is_hidden,can_hide' } }))
  if (idText(read.body.id) !== commentId) throw new MetaLiveRefusal('Meta answered with another comment than the one asked; nothing is changed.')
  return { pageId, brandedPostId: post[0], commentId, hidden: bool(read.body.is_hidden), canHide: bool(read.body.can_hide) }
}

export interface InstagramCommentState {
  instagramId: string
  mediaId: string
  commentId: string
  hidden: boolean | null
  /** A reply (Meta answers replies only to top-level comments). */
  isReply: boolean
  /** Written by the chosen Instagram account itself (its own comments always show, even hidden); false when Meta answered no `user`; null: unreadable. */
  byTheAccount: boolean | null
  productType: string | null
}

/** One comment on a media of the chosen Instagram account (step 14's ownInstagramComment first). */
export async function liveInstagramComment(connectionId: string, commentId: string): Promise<InstagramCommentState> {
  const account = await metaChosenAccount(connectionId)
  const instagramId = instagramOf(account)
  const own = await ownInstagramComment(account, commentId)
  const read = await onPage(() => metaReadOne<Row>({ connectionId: account.connectionId }, { operation: 'comments.instagramChangeState', path: own.commentId, query: { fields: IG_COMMENT_STATE_FIELDS } }))
  const b = read.body
  if (idText(b.id) !== own.commentId) throw new MetaLiveRefusal('Meta answered with another comment than the one asked; nothing is changed.')
  // Re-review B — Meta answers `user` "only … if the app user created the IG Comment, otherwise username": an answer without
  // it is someone else's comment (false); null only when `user` came back but names no id Nexus can read.
  const writer = idText(obj(b.user)?.id ?? b.user)
  return {
    instagramId, mediaId: own.mediaId, commentId: own.commentId,
    hidden: bool(b.hidden), isReply: idText(b.parent_id) !== null,
    byTheAccount: writer !== null ? writer === instagramId : b.user === undefined || b.user === null ? false : null,
    productType: text(obj(b.media)?.media_product_type),
  }
}

export interface InstagramMediaState { instagramId: string; mediaId: string; commentsEnabled: boolean | null; productType: string | null; mediaType: string | null }

/** A media of the chosen Instagram account: mediaId, or the Instagram media behind one of the chosen account's ads. */
export async function liveInstagramMedia(connectionId: string, input: { mediaId?: string | null; adId?: string | null }): Promise<InstagramMediaState> {
  const account = await metaChosenAccount(connectionId)
  const instagramId = instagramOf(account)
  const mediaId = await mediaOf(account, { view: 'instagram', mediaId: input.mediaId ?? null, adId: input.adId ?? null })
  const read = await onPage(() => metaReadOne<Row>({ connectionId: account.connectionId }, { operation: 'comments.mediaChangeState', path: mediaId, query: { fields: IG_MEDIA_STATE_FIELDS } }))
  const b = read.body
  if (idText(b.id) !== mediaId) throw new MetaLiveRefusal('Meta answered with another media than the one asked; nothing is changed.')
  return { instagramId, mediaId, commentsEnabled: bool(b.is_comment_enabled), productType: text(b.media_product_type), mediaType: text(b.media_type) }
}

/**
 * EN-028 — the media (and comment) of another account in which the chosen Instagram account was @mentioned: step 14's
 * mentioned-comment / mentioned-media read, its ids only (a person's words and username are not kept).
 */
export async function liveInstagramMention(connectionId: string, input: { mediaId: string; commentId?: string | null }): Promise<{ instagramId: string; mediaId: string; commentId: string | null }> {
  if (input.commentId) {
    const read = await liveComments({ connectionId, view: 'mentioned-comment', commentId: input.commentId }) as { instagramId: string; mention: { commentId: string | null; media: { mediaId: string | null } | null } }
    if (read.mention.commentId !== input.commentId.trim()) throw new MetaLiveRefusal('Meta answered another comment than the one asked; nothing is sent.')
    if (read.mention.media?.mediaId !== input.mediaId.trim()) throw new MetaLiveRefusal('That comment is not on that media (Meta names another media for it); nothing is sent.')
    return { instagramId: read.instagramId, mediaId: input.mediaId.trim(), commentId: read.mention.commentId }
  }
  const read = await liveComments({ connectionId, view: 'mentioned-media', mediaId: input.mediaId }) as { instagramId: string; mention: { mediaId: string | null } }
  if (read.mention.mediaId !== input.mediaId.trim()) throw new MetaLiveRefusal('Meta answered another media than the one asked; nothing is sent.')
  return { instagramId: read.instagramId, mediaId: read.mention.mediaId, commentId: null }
}

export interface ThreadsState { adId: string; threadsMediaId: string; replyId: string | null; hidden: boolean | null }

/** At most this many direct replies are looked through to find one (the gateway confirms one page of 100). */
export const MAX_THREADS_REPLIES = 100

/** The Threads post of an ad of the chosen ad account (step 14's threadsMediaOf), and one direct reply on it. */
export async function liveThreadsReply(connectionId: string, input: { adId: string; replyId?: string | null }): Promise<ThreadsState> {
  const account = await metaChosenAccount(connectionId)
  const threadsMediaId = await threadsMediaOf(account, input.adId)
  const adId = input.adId.trim()
  if (!input.replyId) return { adId, threadsMediaId, replyId: null, hidden: null }
  const replyId = input.replyId.trim()
  const read = await listPaged(account.connectionId, 'comments.threadsReplyState', `${threadsMediaId}/replies`, { fields: 'id,hide_status' }, MAX_THREADS_REPLIES)
  const row = read.rows.find((r) => idText(r.id) === replyId)
  if (!row) {
    throw new MetaLiveRefusal(read.more
      ? `That reply is not among the first ${MAX_THREADS_REPLIES} direct replies of the ad's Threads post, so Nexus cannot confirm it is one of them (Meta answers direct replies only).`
      : 'That reply is not a direct reply on the ad\'s Threads post (Meta answers and moderates direct replies only), so nothing is changed.')
  }
  const status = text(row.hide_status)
  return { adId, threadsMediaId, replyId, hidden: status === 'HUSHED' ? true : status === 'UNHUSHED' ? false : null }
}

/**
 * Is this id on the chosen Page's blocked list (its first 500)? null when Meta would not list it (the list needs the
 * Page's own token: Meta's refusal is the note). The ids stay in memory.
 */
export async function livePageBlocked(connectionId: string, personId: string): Promise<{ pageId: string; blocked: boolean | null; note?: string }> {
  const account = await metaChosenAccount(connectionId)
  const pageId = pageOf(account)
  try {
    const read = await onPage(() => listPaged(account.connectionId, 'comments.blockedCheck', `${pageId}/blocked`, { fields: 'id' }, 500))
    const listed = read.rows.some((r) => idText(r.id) === personId)
    return { pageId, blocked: listed ? true : read.more ? null : false, ...(!listed && read.more ? { note: 'The Page blocks more than 500 people and Pages; Nexus looked at the first 500.' } : {}) }
  } catch (err) {
    if (err instanceof MetaLiveRefusal || (err instanceof MetaReadError && !err.failure.throttled)) return { pageId, blocked: null, note: err.message }
    throw err
  }
}

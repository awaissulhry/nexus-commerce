/**
 * Meta step 37 (2026-10-21) — comment changes as drafts (pure: built from a request and the live state, no call). Master
 * rows EN-006…EN-010, EN-014, EN-021…EN-025, EN-028, EN-031, EN-032, OT-032; what Meta allows is checked on its v26
 * reference, guides and Python SDK (gateway/meta-comment-rules.ts names each page):
 *   - Facebook (as the chosen Page): comment on a post / reply to a comment, edit the Page's OWN comment, hide / unhide,
 *     delete (explicit ask), like / unlike a post or comment, block / unblock a person or Page; hide / unhide a comment on a
 *     creator's branded-content post that tags the chosen Page;
 *   - Instagram (the chosen account, as the Page): reply to a top-level comment, comment on its own media, hide / unhide,
 *     delete (explicit ask), comments on / off for one media, reply where the account was @mentioned;
 *   - Threads (an ad of the chosen ad account, system-user token): hide / unhide a direct reply, add a text reply.
 * Meta has no check (validate_only) for any of these: every preview says so. Nothing here spends money.
 *
 * PEOPLE'S DATA: Nexus keeps no person's words or name. An id you name for a block is kept in the change record, for its
 * undo; the author id a block reads from a comment is in the request only (its plan is a hash), never in the preview or the
 * record (its undo reads the same comment's author again).
 */
import type { MetaChangeDraft, MetaChangeRequest } from './change-draft.js'
import { changeLines } from './change-draft.js'
import { META_COMMENT_LIMITS, META_COMMENT_MAX_BODY, META_COMMENT_TEXT, META_THREADS_MAX_BODY, metaCommentTextProblem } from '../../gateway/meta-comment-rules.js'
import type { FacebookCommentState, InstagramCommentState, InstagramMediaState, ThreadsState } from './live-comments.js'

export const COMMENT_ACTIONS = ['hide', 'unhide', 'delete', 'reply', 'comment', 'edit', 'like', 'unlike', 'block', 'unblock', 'comments-off', 'comments-on', 'reply-to-mention'] as const
export type CommentAction = typeof COMMENT_ACTIONS[number]
export const COMMENT_PLATFORMS = ['facebook', 'instagram', 'threads'] as const
export type CommentPlatform = typeof COMMENT_PLATFORMS[number]

/** What a comment change replaced and wrote (AgentChange before / after; undo reads it). Never a person's words or name. */
export interface CommentRecord {
  action: CommentAction
  platform: CommentPlatform
  pageId?: string | null
  instagramId?: string | null
  postId?: string | null
  commentId?: string | null
  brandedPostId?: string | null
  mediaId?: string | null
  adId?: string | null
  threadsMediaId?: string | null
  hidden?: boolean | null
  liked?: boolean | null
  blocked?: boolean | null
  commentsEnabled?: boolean | null
  /** reply / comment / reply-to-mention: the comment Meta made (its undo deletes it, where Meta allows). */
  replyId?: string | null
  /** reply / comment / edit: the business's own words, as sent. */
  message?: string | null
  /** edit: the Page's own words before (its undo writes them back). */
  oldMessage?: string | null
  /** block / unblock: who — the author of a comment (re-read for the undo), or an id the person named (personId). */
  via?: 'comment' | 'id'
  personId?: string | null
}

// ── what Meta's codes and limits mean here ────────────────────────────────────────────────────────────────────────

export const COMMENT_EXPLAIN: Readonly<Record<string, string>> = {
  80001: 'Meta allows only so many calls to this Page in a while: wait a few minutes and ask again.',
  368: 'Meta judged this request abusive or not allowed for this Page (its own policy check, not Nexus\'s): a person looks at the Page in Meta\'s Business Support Home before asking again.',
  1705: 'Meta takes a comment as the Page only with the Page\'s own token (a person\'s token answers 1705): the system user needs the chosen Page assigned with the MODERATE task (a comment or like: CREATE_CONTENT too).',
  3801: 'The Page has blocked as many people as Meta allows: unblock someone in the Page\'s settings first.',
  3802: 'Meta does not let the Page block this person again so soon after unblocking them: try again later.',
  210: 'Meta says this person or Page is not visible to the Page (they may have left or hidden themselves).',
  200: 'Comment changes need the chosen Page\'s MODERATE task (a comment or like as the Page: CREATE_CONTENT too) for the system user in Meta Business settings, and pages_manage_engagement, pages_read_engagement and pages_read_user_engagement (Instagram: instagram_manage_comments) on its token.',
  10: 'Comment changes need the chosen Page\'s MODERATE task (a comment or like as the Page: CREATE_CONTENT too) for the system user in Meta Business settings, and pages_manage_engagement, pages_read_engagement and pages_read_user_engagement (Instagram: instagram_manage_comments) on its token.',
}

export const COMMENT_NO_CHECK = 'Meta has no check (validate_only) for comment changes: the preview is built from the live state, and Meta judges the request when it runs.'
export const COMMENT_PUBLIC = 'A reply or comment is PUBLIC at once and speaks as the business; the words below are sent exactly as written, nothing added by Nexus.'
export const COMMENT_DELETE_FINAL = 'A deleted comment cannot come back (Meta has no restore): hide it instead to keep it out of view and be able to show it again.'
/** Review fix B7 — per platform: Meta documents no comment moderation for these ads on Instagram and Threads; on Facebook Nexus's own choice. */
export const ADVANTAGE_CATALOG: Readonly<Record<'facebook' | 'instagram' | 'threads', string>> = {
  facebook: 'Nexus does not moderate comments on Advantage+ catalog ads: their comments sit on the catalog posts Meta makes per product (meta-comments view dynamic-posts reads them); a person moderates them in Meta Business Suite.',
  instagram: 'Meta documents no comment moderation for Advantage+ catalog ads on Instagram (it names no Instagram media for them); a person moderates them in Meta Business Suite.',
  threads: 'Meta documents no reply moderation for Advantage+ catalog ads on Threads (threads-ads/reply-moderation, "Limitations").',
}
export const PAGE_REVIEW_NO_LIKE = 'Meta does not support liking a Page review (object/likes reference).'
/** Review fix B5 — why a Threads reply Nexus makes has no undo. */
export const THREADS_NO_DELETE = 'It has NO undo: the Threads API deletes a reply only with a Threads login token and the threads_delete permission, which Nexus does not hold (it changes Threads ads with the ad account\'s token); hide it instead.'

const T = { true: 'true', false: 'false' } as const
const tf = (v: boolean) => (v ? T.true : T.false)
const shown = (v: boolean | null | undefined, yes: string, no: string) => (v === null || v === undefined ? 'unknown' : v ? yes : no)
/**
 * Review fix B4 — Meta's can_* flags are read with the system-user token (the viewer), while the change goes with the
 * Page's own token, and the v26 Comment page no longer lists can_hide / can_remove: a `false` is a warning, never a refusal.
 */
const canWarning = (field: string, what: string) => `Meta answered ${field} false to the system user's read (the viewer, not the Page): the Page may still ${what}; if it may not, Meta refuses in its own words and nothing changes.`

/**
 * One request of a comment change (Meta has no check for any of them; nothing spends). Facebook and Instagram go AS the
 * chosen Page (step 27b's `asPage`: the Page's own rate limit, said in the preview); Threads with the ad account's token.
 */
function request(r: Omit<MetaChangeRequest, 'step' | 'check' | 'raisesSpend' | 'readBackInPost' | 'budget' | 'explain'>): MetaChangeRequest {
  const asPage = !String(r.objectKind ?? '').startsWith('threads')
  return { step: 1, check: 'none', raisesSpend: false, readBackInPost: false, budget: false, explain: COMMENT_EXPLAIN, ...(asPage ? { asPage: true as const } : {}), ...r }
}

function draftOf(input: {
  summary: string; lines: Array<[string, unknown, unknown]>; warnings: string[]; requests: MetaChangeRequest[]; skipped?: string[]
  stands: unknown; before: CommentRecord; after: CommentRecord
}): MetaChangeDraft {
  const { changes, more } = changeLines(input.lines)
  return {
    summary: input.summary, changes, totals: { requests: input.requests.length, ...(more ? { moreLines: more } : {}) },
    warnings: input.warnings, spendsMoney: [], skipped: input.skipped ?? [], requests: input.requests,
    stands: input.stands, before: input.before, after: input.after,
  }
}

function alreadySo(summary: string, before: CommentRecord, stands: unknown): MetaChangeDraft {
  return { summary, changes: {}, totals: { requests: 0 }, warnings: [], spendsMoney: [], skipped: [summary], requests: [], stands, before, after: { ...before } }
}

/** The exact words of a reply, comment or edit: the tool's text, judged as the gateway judges it. */
export function commentTextRefusal(message: string | undefined, platform: CommentPlatform): string | null {
  if (message === undefined) return null
  const problem = metaCommentTextProblem(message, META_COMMENT_LIMITS[platform])
  if (problem) return `The text: ${problem}.`
  // Review fix A5 — the body as it is sent (form-encoded: an emoji is 12 characters there) must fit the gateway's cap, so a
  // long emoji or CJK reply is refused here, never after approval.
  return bodyTooLong({ message }, platform)
}

/** Review fix A5 — the encoded body of a request against its rule's cap (null: it fits). */
export function bodyTooLong(params: Record<string, string>, platform: CommentPlatform): string | null {
  const max = platform === 'threads' ? META_THREADS_MAX_BODY : META_COMMENT_MAX_BODY
  const length = new URLSearchParams(params).toString().length
  return length > max ? `The text is too long once encoded for Meta (${length} characters, at most ${max}: emoji and non-Latin letters take up to 12 each): shorten it.` : null
}

/**
 * Review fix A2 — an edit can be undone only when the Page's old words can be written back exactly: not empty, printable
 * (META_COMMENT_TEXT, as the gateway judges them) and within the cap, also once encoded. Null when they can.
 */
export function editUndoProblem(old: string | null | undefined): string | null {
  if (old === null || old === undefined || !old.trim()) return 'its old comment had no words Nexus can write back (an image or GIF only, or none read)'
  if (!META_COMMENT_TEXT.test(old)) return 'its old words hold characters Nexus does not send (a control or format character)'
  if (metaCommentTextProblem(old, META_COMMENT_LIMITS.facebook) || bodyTooLong({ message: old }, 'facebook')) return 'its old words are longer than Nexus sends'
  return null
}

// ── Facebook ──────────────────────────────────────────────────────────────────────────────────────────────────────

const fbRecord = (action: CommentAction, s: { pageId: string; postId: string; commentId?: string | null }, extra: Partial<CommentRecord> = {}): CommentRecord => ({
  action, platform: 'facebook', pageId: s.pageId, postId: s.postId, ...(s.commentId !== undefined ? { commentId: s.commentId } : {}), ...extra,
})

/** hide / unhide a comment on a post of the chosen Page (EN-008). */
export function facebookHideDraft(action: 'hide' | 'unhide', s: FacebookCommentState): MetaChangeDraft | { refusal: string } {
  const wanted = action === 'hide'
  const before = fbRecord(action, s, { hidden: s.hidden })
  const stands = { platform: 'facebook', commentId: s.commentId, postId: s.postId, hidden: s.hidden, canHide: s.canHide }
  if (s.hidden === wanted) return alreadySo(`Comment ${s.commentId} is already ${wanted ? 'hidden' : 'shown'}.`, before, stands)
  return draftOf({
    summary: `${wanted ? 'Hide' : 'Show again'} comment ${s.commentId} on the chosen Facebook Page's post ${s.postId} — ${wanted ? 'it leaves public view (its author and their friends still see it); it is not deleted' : 'everyone sees it again'}.`,
    lines: [[`Comment ${s.commentId}${s.byThePage ? ' (by the Page)' : ' (by a person)'}`, shown(s.hidden, 'hidden', 'shown'), wanted ? 'hidden' : 'shown']],
    warnings: [COMMENT_NO_CHECK, `Its undo ${wanted ? 'shows it again' : 'hides it again'}.`, ...(wanted && s.canHide === false ? [canWarning('can_hide', 'hide it')] : [])],
    requests: [request({ label: `${wanted ? 'Hide' : 'Unhide'} comment ${s.commentId}`, objectId: s.commentId, objectKind: 'fbcomment', operation: 'fbcomment.hide', params: { is_hidden: tf(wanted) }, readBackFields: 'id,is_hidden', expect: { is_hidden: tf(wanted) }, undoable: true })],
    stands, before, after: { ...before, hidden: wanted },
  })
}

/** OT-032 — hide / unhide a comment on a creator's branded-content post that tags the chosen Page as its sponsor. */
export function brandedHideDraft(action: 'hide' | 'unhide', s: { pageId: string; brandedPostId: string; commentId: string; hidden: boolean | null; canHide: boolean | null }): MetaChangeDraft | { refusal: string } {
  const wanted = action === 'hide'
  const before: CommentRecord = { action, platform: 'facebook', pageId: s.pageId, brandedPostId: s.brandedPostId, commentId: s.commentId, hidden: s.hidden }
  const stands = { platform: 'facebook', brandedPostId: s.brandedPostId, commentId: s.commentId, hidden: s.hidden, canHide: s.canHide }
  if (s.hidden === wanted) return alreadySo(`Comment ${s.commentId} is already ${wanted ? 'hidden' : 'shown'}.`, before, stands)
  return draftOf({
    summary: `${wanted ? 'Hide' : 'Show again'} comment ${s.commentId} on the creator's branded-content post ${s.brandedPostId} that tags the chosen Facebook Page — the brand moderates it without the creator (Meta's branded-content guide).`,
    lines: [[`Comment ${s.commentId} on branded post ${s.brandedPostId}`, shown(s.hidden, 'hidden', 'shown'), wanted ? 'hidden' : 'shown']],
    warnings: [COMMENT_NO_CHECK, 'Meta allows only hiding a comment on another Page\'s branded-content post (no reply, delete or like there).', `Its undo ${wanted ? 'shows it again' : 'hides it again'}.`, ...(wanted && s.canHide === false ? [canWarning('can_hide', 'hide it')] : [])],
    requests: [request({ label: `${wanted ? 'Hide' : 'Unhide'} comment ${s.commentId} on branded post ${s.brandedPostId}`, objectId: s.commentId, objectKind: 'brandedcomment', parent: { kind: 'brandedpost', id: s.brandedPostId }, operation: 'fbcomment.hide', params: { is_hidden: tf(wanted) }, readBackFields: 'id,is_hidden', expect: { is_hidden: tf(wanted) }, undoable: true })],
    stands, before, after: { ...before, hidden: wanted },
  })
}

/** delete a comment on a post of the chosen Page (EN-009) — explicit ask only; final. */
export function facebookDeleteDraft(s: FacebookCommentState): MetaChangeDraft | { refusal: string } {
  const before = fbRecord('delete', s)
  return draftOf({
    summary: `Delete comment ${s.commentId} on the chosen Facebook Page's post ${s.postId} — for good.`,
    lines: [[`Comment ${s.commentId}${s.byThePage ? ' (by the Page)' : ' (by a person)'}`, 'there', 'deleted (for good)']],
    warnings: [COMMENT_NO_CHECK, COMMENT_DELETE_FINAL, ...(s.canRemove === false ? [canWarning('can_remove', 'delete it')] : [])],
    requests: [request({ label: `Delete comment ${s.commentId}`, objectId: s.commentId, objectKind: 'fbcomment', method: 'DELETE', operation: 'fbcomment.delete', params: {}, undoable: false })],
    stands: { platform: 'facebook', commentId: s.commentId, postId: s.postId, canRemove: s.canRemove }, before, after: { ...before },
  })
}

export interface FacebookWords { message?: string; imageUrl?: string; gifUrl?: string }
const fbParams = (w: FacebookWords): Record<string, string> => ({
  ...(w.message !== undefined ? { message: w.message } : {}), ...(w.imageUrl ? { attachment_url: w.imageUrl } : {}), ...(w.gifUrl ? { attachment_share_url: w.gifUrl } : {}),
})
const wordsLine = (w: FacebookWords): string => [w.message !== undefined ? `"${w.message}"` : '', w.imageUrl ? `image ${w.imageUrl}` : '', w.gifUrl ? `GIF ${w.gifUrl}` : ''].filter(Boolean).join(' + ')

/**
 * comment on a post of the chosen Page, or reply to a comment on one (EN-006): POST /{post | comment}/comments as the Page.
 * Undo: delete the reply Nexus made (its record holds the new id).
 */
export function facebookCommentDraft(target: { pageId: string; postId: string; commentId?: string; canReply?: boolean | null; hidden?: boolean | null }, words: FacebookWords): MetaChangeDraft | { refusal: string } {
  if (words.message === undefined && !words.imageUrl && !words.gifUrl) return { refusal: 'Give the words (message), and optionally an image or GIF link.' }
  const refusal = commentTextRefusal(words.message, 'facebook')
  if (refusal) return { refusal }
  const tooLong = bodyTooLong(fbParams(words), 'facebook')
  if (tooLong) return { refusal: tooLong }
  const reply = !!target.commentId
  const on = reply ? `comment ${target.commentId}` : `post ${target.postId}`
  const before = fbRecord(reply ? 'reply' : 'comment', { pageId: target.pageId, postId: target.postId, commentId: target.commentId ?? null }, { replyId: null, message: words.message ?? null })
  return draftOf({
    summary: `${reply ? 'Reply to' : 'Comment on'} ${on} of the chosen Facebook Page, as the Page — public at once.`,
    lines: [[`${reply ? 'Reply to' : 'Comment on'} ${on}`, 'none', wordsLine(words)]],
    warnings: [
      COMMENT_NO_CHECK, COMMENT_PUBLIC, 'Its undo deletes the reply Nexus made (a deleted comment cannot come back).',
      ...(words.message && /@\[\d+\]/.test(words.message) ? ['@[Page id] mentions in a comment need Meta\'s "Page Mentioning" feature: without it Meta refuses the reply in its own words.'] : []),
      ...(target.hidden ? ['That comment is hidden: the reply may be seen only by its author and their friends.'] : []),
      ...(target.commentId && target.canReply === false ? [canWarning('can_comment', 'reply to it')] : []),
      ...(words.imageUrl || words.gifUrl ? ['The image or GIF is fetched by Meta from the link you gave (https); Nexus uploads no file.'] : []),
    ],
    requests: [request({ label: `${reply ? 'Reply to' : 'Comment on'} ${on} as the Page`, objectId: reply ? target.commentId! : target.postId, objectKind: reply ? 'fbcomment' : 'fbpost', edge: 'comments', operation: 'fbcomment.create', params: fbParams(words), readBackFields: 'id', undoable: false })],
    stands: { platform: 'facebook', postId: target.postId, commentId: target.commentId ?? null, canReply: target.canReply ?? null }, before, after: { ...before },
  })
}

/** edit the chosen Page's OWN comment (EN-007): POST /{comment} message. Undo writes the old words back. */
export function facebookEditDraft(s: FacebookCommentState, words: FacebookWords): MetaChangeDraft | { refusal: string } {
  if (s.byThePage !== true) return { refusal: `Comment ${s.commentId} was not written by the chosen Facebook Page: Meta lets the Page edit only its own comments (a person's comment can be hidden or deleted).` }
  if (words.message === undefined && !words.imageUrl && !words.gifUrl) return { refusal: 'Give the new words (message), and optionally an image or GIF link.' }
  const refusal = commentTextRefusal(words.message, 'facebook')
  if (refusal) return { refusal }
  // Review fix A2 — its undo only when the old words can be written back exactly; else the record holds none.
  const noUndo = editUndoProblem(s.pageText)
  const before = fbRecord('edit', s, { message: s.pageText, oldMessage: noUndo ? null : s.pageText })
  const stands = { platform: 'facebook', commentId: s.commentId, postId: s.postId, byThePage: true, pageText: s.pageText }
  const tooLong = bodyTooLong(fbParams(words), 'facebook')
  if (tooLong) return { refusal: tooLong }
  if (words.message !== undefined && words.message === s.pageText && !words.imageUrl && !words.gifUrl) return alreadySo(`Comment ${s.commentId} already reads so.`, before, stands)
  return draftOf({
    summary: `Edit the chosen Facebook Page's own comment ${s.commentId} on post ${s.postId} — public at once.`,
    lines: [[`The Page's comment ${s.commentId}`, s.pageText === null ? '(no text, or not read)' : `"${s.pageText}"`, wordsLine(words)]],
    warnings: [
      COMMENT_NO_CHECK, COMMENT_PUBLIC,
      noUndo ? `This edit has NO undo: ${noUndo}.` : 'Its undo writes the old words back (an image or GIF it replaced is not put back).',
    ],
    requests: [request({ label: `Edit the Page's comment ${s.commentId}`, objectId: s.commentId, objectKind: 'fbpagecomment', operation: 'fbcomment.edit', params: fbParams(words), readBackFields: 'id,message', ...(words.message !== undefined ? { expect: { message: words.message } } : {}), undoable: !noUndo })],
    stands, before, after: { ...before, message: words.message ?? s.pageText },
  })
}

/** like / unlike a post or comment of the chosen Page as the Page (EN-010). */
export function facebookLikeDraft(action: 'like' | 'unlike', target: { pageId: string; postId: string; commentId?: string | null }): MetaChangeDraft {
  const like = action === 'like'
  const objectId = target.commentId ?? target.postId
  const what = target.commentId ? `comment ${target.commentId}` : `post ${target.postId}`
  const before = fbRecord(action, { pageId: target.pageId, postId: target.postId, commentId: target.commentId ?? null }, { liked: !like })
  return draftOf({
    summary: `${like ? 'Like' : 'Unlike'} ${what} of the chosen Facebook Page, as the Page.`,
    lines: [[`The Page's like of ${what}`, like ? 'not liked' : 'liked', like ? 'liked' : 'not liked']],
    warnings: [COMMENT_NO_CHECK, like ? 'Meta refuses a like the Page already gave, in its own words; a reaction the Page gave (Wow, …) stays as it is.' : 'Meta refuses to remove a like the Page did not give, in its own words.', `Its undo ${like ? 'unlikes' : 'likes'} it again.`, PAGE_REVIEW_NO_LIKE],
    requests: [request({ label: `${like ? 'Like' : 'Unlike'} ${what} as the Page`, objectId, objectKind: target.commentId ? 'fbcomment' : 'fbpost', edge: 'likes', ...(like ? {} : { method: 'DELETE' as const }), operation: like ? 'fblike.create' : 'fblike.delete', params: {}, skipReadBack: true, answerOnly: true, undoable: true })],
    stands: { platform: 'facebook', objectId }, before, after: { ...before, liked: like },
  })
}

/**
 * block / unblock a person or Page from the chosen Page (EN-014): POST / DELETE /{page}/blocked with `user`. The person is
 * a comment's author (its id is read now and stays in the request) or an id the person named (personId).
 */
export function pageBlockDraft(action: 'block' | 'unblock', who: { pageId: string; personId: string; via: 'comment' | 'id'; postId?: string | null; commentId?: string | null }, blockedNow: { blocked: boolean | null; note?: string }): MetaChangeDraft | { refusal: string } {
  const block = action === 'block'
  const named = who.via === 'comment' ? `the author of comment ${who.commentId}` : `the person with Page-scoped id ${who.personId}`
  const before: CommentRecord = {
    action, platform: 'facebook', pageId: who.pageId, via: who.via, blocked: blockedNow.blocked,
    ...(who.via === 'comment' ? { postId: who.postId ?? null, commentId: who.commentId ?? null } : { personId: who.personId }),
  }
  const stands = { platform: 'facebook', pageId: who.pageId, via: who.via, commentId: who.commentId ?? null, blocked: blockedNow.blocked }
  if (blockedNow.blocked === block) return alreadySo(`${named[0].toUpperCase()}${named.slice(1)} is already ${block ? 'blocked from' : 'not blocked from'} the chosen Facebook Page.`, before, stands)
  if (who.personId === who.pageId) return { refusal: 'That is the chosen Page itself: it cannot block itself.' }
  return draftOf({
    summary: `${block ? 'Block' : 'Unblock'} ${named} ${block ? 'from' : 'on'} the chosen Facebook Page${block ? ' — they can no longer comment on, like or message the Page' : ''}.`,
    lines: [[`${named[0].toUpperCase()}${named.slice(1)}`, shown(blockedNow.blocked, 'blocked', 'not blocked'), block ? 'blocked' : 'not blocked']],
    warnings: [
      COMMENT_NO_CHECK,
      block ? 'Meta allows only so many blocked people per Page (3801), and does not let the Page block someone again soon after unblocking them (3802).' : 'Once unblocked, Meta does not let the Page block the same person again for a while (3802).',
      'Nexus blocks a person by their Page-scoped id (psid); a Page that commented is blocked in the Page\'s settings.',
      ...(blockedNow.blocked === null ? [`Nexus could not read the Page's blocked list${blockedNow.note ? ` (${blockedNow.note})` : ''}: Meta's answer says whether it was needed.`] : []),
      who.via === 'comment' ? `Its undo ${block ? 'unblocks' : 'blocks'} the author of the same comment again (while the comment is there; else a person does it in the Page's settings).` : `Its undo ${block ? 'unblocks' : 'blocks'} them again.`,
    ],
    requests: [request({
      label: `${block ? 'Block' : 'Unblock'} ${named} ${block ? 'from' : 'on'} the Page`, objectId: who.pageId, objectKind: 'page', edge: 'blocked', ...(block ? {} : { method: 'DELETE' as const }),
      operation: block ? 'pageblock.create' : 'pageblock.delete', params: { psid: block ? JSON.stringify([who.personId]) : who.personId }, skipReadBack: true, answerOnly: true, undoable: true,
    })],
    stands, before, after: { ...before, blocked: block },
  })
}

// ── Instagram ─────────────────────────────────────────────────────────────────────────────────────────────────────

const igRecord = (action: CommentAction, s: { instagramId: string; mediaId: string; commentId?: string | null }, extra: Partial<CommentRecord> = {}): CommentRecord => ({
  action, platform: 'instagram', instagramId: s.instagramId, mediaId: s.mediaId, ...(s.commentId !== undefined ? { commentId: s.commentId } : {}), ...extra,
})

/** hide / unhide a comment on a media of the chosen Instagram account (EN-023). */
export function instagramHideDraft(action: 'hide' | 'unhide', s: InstagramCommentState): MetaChangeDraft | { refusal: string } {
  const wanted = action === 'hide'
  const before = igRecord(action, s, { hidden: s.hidden })
  const stands = { platform: 'instagram', commentId: s.commentId, mediaId: s.mediaId, hidden: s.hidden }
  if (s.hidden === wanted) return alreadySo(`Instagram comment ${s.commentId} is already ${wanted ? 'hidden' : 'shown'}.`, before, stands)
  if (wanted && s.byTheAccount) return { refusal: `Instagram comment ${s.commentId} is the account's own: Meta says the media owner's own comments "will always be displayed", even hidden (ig-comment reference). Delete it instead only if that is what you mean.` }
  return draftOf({
    summary: `${wanted ? 'Hide' : 'Show again'} Instagram comment ${s.commentId} on the chosen account's media ${s.mediaId}.`,
    lines: [[`Instagram comment ${s.commentId}`, shown(s.hidden, 'hidden', 'shown'), wanted ? 'hidden' : 'shown']],
    warnings: [
      COMMENT_NO_CHECK, 'Meta does not hide comments on live video.', `Its undo ${wanted ? 'shows it again' : 'hides it again'}.`,
      ...(wanted && s.byTheAccount === null ? ['Meta\'s answer named the comment\'s writer (`user`) in a form Nexus could not read: if the account wrote it, Meta shows it anyway ("will always be displayed").'] : []),
    ],
    requests: [request({ label: `${wanted ? 'Hide' : 'Unhide'} Instagram comment ${s.commentId}`, objectId: s.commentId, objectKind: 'igcomment', operation: 'igcomment.hide', params: { hide: tf(wanted) }, readBackFields: 'id,hidden', expect: { hidden: tf(wanted) }, undoable: true })],
    stands, before, after: { ...before, hidden: wanted },
  })
}

/** delete a comment on a media of the chosen Instagram account (EN-024) — explicit ask only; final. */
export function instagramDeleteDraft(s: InstagramCommentState): MetaChangeDraft {
  const before = igRecord('delete', s)
  return draftOf({
    summary: `Delete Instagram comment ${s.commentId} on the chosen account's media ${s.mediaId} — for good.`,
    lines: [[`Instagram comment ${s.commentId}${s.byTheAccount ? ' (by the account)' : ' (by a person)'}`, 'there', 'deleted (for good)']],
    warnings: [COMMENT_NO_CHECK, COMMENT_DELETE_FINAL, 'Only the media\'s owner can delete a comment on it (Meta), so this works on the chosen account\'s own media only; not on live video.'],
    requests: [request({ label: `Delete Instagram comment ${s.commentId}`, objectId: s.commentId, objectKind: 'igcomment', method: 'DELETE', operation: 'igcomment.delete', params: {}, undoable: false })],
    stands: { platform: 'instagram', commentId: s.commentId, mediaId: s.mediaId }, before, after: { ...before },
  })
}

/** reply to a top-level comment on the chosen account's media (EN-021). Undo: delete the reply Nexus made. */
export function instagramReplyDraft(s: InstagramCommentState, message: string): MetaChangeDraft | { refusal: string } {
  const refusal = commentTextRefusal(message, 'instagram')
  if (refusal) return { refusal }
  if (s.isReply) return { refusal: `Instagram comment ${s.commentId} is itself a reply: Meta answers replies only to top-level comments (a reply to a reply goes to the top-level comment). Reply to its top-level comment instead.` }
  if (s.hidden) return { refusal: `Instagram comment ${s.commentId} is hidden: Meta does not take a reply to a hidden comment. Show it again first (action unhide).` }
  const before = igRecord('reply', s, { replyId: null, message })
  return draftOf({
    summary: `Reply to Instagram comment ${s.commentId} on the chosen account's media ${s.mediaId}, as the account — public at once.`,
    lines: [[`Reply to Instagram comment ${s.commentId}`, 'none', `"${message}"`]],
    warnings: [COMMENT_NO_CHECK, COMMENT_PUBLIC, 'Its undo deletes the reply Nexus made (a deleted comment cannot come back).', 'Meta takes no reply on live video (a private reply by message is create-meta-message: one per comment, within 7 days).'],
    requests: [request({ label: `Reply to Instagram comment ${s.commentId}`, objectId: s.commentId, objectKind: 'igcomment', edge: 'replies', operation: 'igcomment.reply', params: { message }, readBackFields: 'id', undoable: false })],
    stands: { platform: 'instagram', commentId: s.commentId, mediaId: s.mediaId, hidden: s.hidden, isReply: s.isReply }, before, after: { ...before },
  })
}

/** a top-level comment on the chosen account's own media (EN-022). Undo: delete it. */
export function instagramCommentDraft(m: InstagramMediaState, message: string): MetaChangeDraft | { refusal: string } {
  const refusal = commentTextRefusal(message, 'instagram')
  if (refusal) return { refusal }
  if (m.commentsEnabled === false) return { refusal: `Comments are off on Instagram media ${m.mediaId}: switch them on first (action comments-on).` }
  if (m.productType === 'STORY') return { refusal: `Instagram media ${m.mediaId} is a story: stories take no comments.` }
  const before = igRecord('comment', m, { commentId: null, replyId: null, message })
  return draftOf({
    summary: `Comment on the chosen Instagram account's own media ${m.mediaId}, as the account — public at once.`,
    lines: [[`Comment on Instagram media ${m.mediaId}`, 'none', `"${message}"`]],
    warnings: [COMMENT_NO_CHECK, COMMENT_PUBLIC, 'Its undo deletes the comment Nexus made (a deleted comment cannot come back).', 'Meta takes no comment on live video.'],
    requests: [request({ label: `Comment on Instagram media ${m.mediaId}`, objectId: m.mediaId, objectKind: 'igmedia', edge: 'comments', operation: 'igmedia.comment', params: { message }, readBackFields: 'id', undoable: false })],
    stands: { platform: 'instagram', mediaId: m.mediaId, commentsEnabled: m.commentsEnabled, productType: m.productType }, before, after: { ...before },
  })
}

/** comments on / off for one media of the chosen account (EN-025): read back `is_comment_enabled`. */
export function instagramCommentsSwitchDraft(action: 'comments-off' | 'comments-on', m: InstagramMediaState): MetaChangeDraft | { refusal: string } {
  const on = action === 'comments-on'
  const before = igRecord(action, m, { commentsEnabled: m.commentsEnabled })
  const stands = { platform: 'instagram', mediaId: m.mediaId, commentsEnabled: m.commentsEnabled, productType: m.productType }
  if (m.commentsEnabled === on) return alreadySo(`Comments are already ${on ? 'on' : 'off'} on Instagram media ${m.mediaId}.`, before, stands)
  if (m.productType === 'STORY') return { refusal: `Instagram media ${m.mediaId} is a story: stories have no comments to switch.` }
  return draftOf({
    summary: `Switch comments ${on ? 'on' : 'off'} for the chosen Instagram account's media ${m.mediaId}${on ? '' : ' — nobody can comment on it until they are switched on again; the comments it has stay'}.`,
    lines: [[`Comments on Instagram media ${m.mediaId}`, shown(m.commentsEnabled, 'on', 'off'), on ? 'on' : 'off']],
    warnings: [COMMENT_NO_CHECK, 'Meta switches comments for a whole post: for a carousel use the album\'s own id (not one of its items); not for live video.', `Its undo switches them ${on ? 'off' : 'on'} again.`],
    requests: [request({ label: `Switch comments ${on ? 'on' : 'off'} for Instagram media ${m.mediaId}`, objectId: m.mediaId, objectKind: 'igmedia', operation: 'igmedia.commentEnabled', params: { comment_enabled: tf(on) }, readBackFields: 'id,is_comment_enabled', expect: { is_comment_enabled: tf(on) }, undoable: true })],
    stands, before, after: { ...before, commentsEnabled: on },
  })
}

/** reply where the chosen account was @mentioned by another account (EN-028) — on their media: no undo (Meta). */
export function instagramMentionDraft(mention: { instagramId: string; mediaId: string; commentId: string | null }, message: string): MetaChangeDraft | { refusal: string } {
  const refusal = commentTextRefusal(message, 'instagram')
  if (refusal) return { refusal }
  const on = mention.commentId ? `the comment ${mention.commentId} that @mentions the account` : `media ${mention.mediaId}, whose caption @mentions the account`
  const before: CommentRecord = { action: 'reply-to-mention', platform: 'instagram', instagramId: mention.instagramId, mediaId: mention.mediaId, commentId: mention.commentId, replyId: null, message }
  return draftOf({
    summary: `Reply to ${on}, as the chosen Instagram account — public at once, on another account's media.`,
    lines: [[`Reply to ${on}`, 'none', `"${message}"`]],
    warnings: [COMMENT_NO_CHECK, COMMENT_PUBLIC, 'It has NO undo: Meta lets only the media\'s owner delete a comment on it, and the media is another account\'s.', 'Meta takes no reply on stories, nor on media the account was only tagged in.'],
    requests: [request({
      label: `Reply to ${on}`, objectId: mention.instagramId, objectKind: 'iguser', edge: 'mentions', operation: 'iguser.mention',
      params: { media_id: mention.mediaId, ...(mention.commentId ? { comment_id: mention.commentId } : {}), message }, skipReadBack: true, undoable: false,
    })],
    stands: { platform: 'instagram', mediaId: mention.mediaId, commentId: mention.commentId }, before, after: { ...before },
  })
}

// ── Threads ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** hide / unhide a direct reply on the Threads post of an ad of the chosen ad account (EN-031): judged by its hide_status. */
export function threadsHideDraft(action: 'hide' | 'unhide', s: ThreadsState): MetaChangeDraft | { refusal: string } {
  if (!s.replyId) return { refusal: 'Name the reply (commentId: a direct reply of the ad\'s Threads post, meta-comments view threads-replies).' }
  const wanted = action === 'hide'
  const before: CommentRecord = { action, platform: 'threads', adId: s.adId, threadsMediaId: s.threadsMediaId, commentId: s.replyId, hidden: s.hidden }
  const stands = { platform: 'threads', adId: s.adId, threadsMediaId: s.threadsMediaId, replyId: s.replyId, hidden: s.hidden }
  if (s.hidden === wanted) return alreadySo(`Threads reply ${s.replyId} is already ${wanted ? 'hidden' : 'shown'}.`, before, stands)
  const status = wanted ? 'HUSHED' : 'UNHUSHED'
  return draftOf({
    summary: `${wanted ? 'Hide' : 'Show again'} reply ${s.replyId} on the Threads post of ad ${s.adId} — hidden is out of public view, not deleted.`,
    lines: [[`Threads reply ${s.replyId}`, shown(s.hidden, 'hidden', 'shown'), wanted ? 'hidden' : 'shown']],
    warnings: [COMMENT_NO_CHECK, `Its undo ${wanted ? 'shows it again' : 'hides it again'}.`],
    requests: [request({
      label: `${wanted ? 'Hide' : 'Unhide'} Threads reply ${s.replyId}`, objectId: s.replyId, objectKind: 'threadsreply', parent: { kind: 'ad', id: s.adId }, edge: 'manage_reply', operation: 'threadsreply.hide',
      params: { hide: tf(wanted) }, readBackFields: 'id,hide_status',
      judge: (node) => ({ moved: node.hide_status === status ? [] : ['hide_status'], reads: `hide_status ${typeof node.hide_status === 'string' ? node.hide_status : '(not sent back)'}` }),
      undoable: true,
    })],
    stands, before, after: { ...before, hidden: wanted },
  })
}

/** a text reply on the Threads post of an ad of the chosen ad account, or to a direct reply on it (EN-032): no undo. */
export function threadsReplyDraft(s: ThreadsState, text: string): MetaChangeDraft | { refusal: string } {
  const refusal = metaCommentTextProblem(text, META_COMMENT_LIMITS.threads, 'text') ? `The text: ${metaCommentTextProblem(text, META_COMMENT_LIMITS.threads, 'text')}.` : bodyTooLong({ text }, 'threads')
  if (refusal) return { refusal }
  const on = s.replyId ? `reply ${s.replyId} on the Threads post of ad ${s.adId}` : `the Threads post of ad ${s.adId}`
  const before: CommentRecord = { action: s.replyId ? 'reply' : 'comment', platform: 'threads', adId: s.adId, threadsMediaId: s.threadsMediaId, commentId: s.replyId, replyId: null, message: text }
  return draftOf({
    summary: `Reply to ${on} — public at once, text only.`,
    lines: [[`Reply to ${on}`, 'none', `"${text}"`]],
    warnings: [
      COMMENT_NO_CHECK, COMMENT_PUBLIC, THREADS_NO_DELETE,
      ...(s.replyId ? ['Meta answers and adds direct replies only (nested replies are not available): if it refuses a reply to a reply, its words say so; reply to the ad\'s post instead.'] : []),
    ],
    requests: [request({
      label: `Reply to ${on}`, objectId: s.replyId ?? s.threadsMediaId, objectKind: s.replyId ? 'threadsreply' : 'threadsmedia', parent: { kind: 'ad', id: s.adId }, edge: 'add_reply', operation: 'threads.reply',
      params: { text }, skipReadBack: true, undoable: false,
    })],
    stands: { platform: 'threads', adId: s.adId, threadsMediaId: s.threadsMediaId, replyId: s.replyId }, before, after: { ...before },
  })
}

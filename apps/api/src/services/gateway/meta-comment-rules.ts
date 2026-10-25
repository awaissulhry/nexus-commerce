/**
 * Meta step 37 (2026-10-21) — the write allow-list entries of set-meta-comments: comments and moderation on the business's
 * CHOSEN Facebook Page's posts, its CHOSEN Instagram account's media and its own Threads ads. EXACT keys per kind of
 * object, every value judged, text only where a person types it (the reply's exact words), links https only. Every
 * Facebook and Instagram rule here is `auth: 'page'`: it goes with the chosen Page's own token, which the gateway reads for
 * that one call (meta-page-token.ts), and only for an object the gateway confirmed is the Page's, a post or comment of it,
 * or the chosen Instagram account's media, comment or own node (meta-comment-owner.ts). The two Threads rules go with the
 * business's system-user token (`ads_management` of the ad account that owns the ad), only for the Threads post of an ad of
 * the chosen ad account and its direct replies.
 *
 * Checked 2026-10-21 (curl ≥3 s apart) on developers.facebook.com and Meta's Python Business SDK (main,
 * facebook_business/adobjects):
 *   - docs/graph-api/reference/comment (v26.0): Updating `POST /{comment_id}` with attachment_id, attachment_share_url,
 *     attachment_url, is_hidden ("Only applicable to Page comments"), message; read-after-write; errors 200, 368, 100,
 *     80001 (too many calls to this Page), 190, 210. Deleting `DELETE /{comment_id}` (no parameters) → {success}. SDK
 *     comment.py api_update (the same five keys), api_delete.
 *   - docs/graph-api/reference/object/comments: Publishing `POST /{object-id}/comments` — "a Page access token requested by
 *     a person who can perform the MODERATE task", pages_manage_engagement; one of attachment_id, attachment_share_url (a
 *     GIF), attachment_url (an image), message, source (a file); `@[page-id]` mentions are subject to review. Nexus sends
 *     message and the two links only (no file, no unpublished photo id).
 *   - docs/graph-api/reference/object/likes: Publishing `POST /{object-id}/likes` (no fields; CREATE_CONTENT task) and
 *     Deleting `DELETE /{object-id}/likes` (MODERATE task); "the Page must not have liked the object already"; "liking a
 *     Page review is not supported".
 *   - docs/graph-api/reference/page/blocked: Creating `POST /{page_id}/blocked` with asid / psid / uid (deprecated) / user
 *     (lists; "This or uid is required"), answers {id: bool}; Deleting `DELETE /{page_id}/blocked` with asid / psid / uid /
 *     user (one id); errors 3801 (block limit reached), 3802 (cannot re-block so soon after unblocking). SDK page.py
 *     create_blocked (psid list<int>, user list<string>), delete_blocked (psid int). documentation/pages-api/
 *     comments-mentions.md: a comment's `from.id` is the commenter's Page-scoped id (PSID). Review fix B1 — Nexus blocks a
 *     PERSON by `psid` only (a comment's author, or a PSID from meta-comments view blocked): exactly that one key, never
 *     `user`, `uid` or `asid` (a Page that commented is blocked in the Page's settings).
 *   - documentation/ads-commerce/marketing-api/guides/branded-content.md, "Comments moderation": `POST /{comment-id}`
 *     is_hidden on a branded-content post made by another Page, "without needing the creator to take action" (Page posts
 *     only) — master OT-032; graph-api/reference/post: the `sponsor_tags` edge ("sponsor pages tagged in the post").
 *   - documentation/instagram-platform/comment-moderation.md: with Facebook Login the token is a "Facebook Page access token"
 *     (instagram_basic, instagram_manage_comments, pages_read_engagement; ads_management or ads_read with a Business Manager
 *     Page role); endpoints POST /<IG_COMMENT_ID>/replies, POST /<IG_COMMENT_ID> (hide), POST /<IG_MEDIA_ID>
 *     (comment_enabled), DELETE /<IG_COMMENT_ID>. The node pages (ig-comment.md, ig-media.md, ig-media/comments.md,
 *     ig-user/mentions.md) name a Facebook USER token instead: Nexus uses the Page token mode (never a second token mode)
 *     and Meta's refusal says so in its own words (LIVE-PROBES CM37-01).
 *   - instagram-graph-api/reference/ig-comment.md: hide `POST /<IG_COMMENT_ID>?hide=<bool>` — the media owner's token;
 *     the owner's own comments always show; not on live video. Delete — "can only be deleted by the owner of the object
 *     upon which the comment was made"; SDK igcomment.py api_update (hide, ad_id), api_delete (ad_id) — `ad_id` is SDK-only
 *     and not sent.
 *   - ig-comment/replies.md: `POST /{ig-comment-id}/replies?message=` — top-level comments only ("replies to a reply will
 *     be added to the top-level comment"), not a hidden comment, not live video. SDK igcomment.py create_reply (message).
 *   - ig-media/comments.md: `POST /<IG_MEDIA_ID>/comments?message=` (not live video). SDK igmedia.py create_comment.
 *   - reference/instagram-media.md, Updating: `POST /<IG_MEDIA_ID>?comment_enabled=<bool>` (required), live video not
 *     supported; `is_comment_enabled` reads it back ("Excludes album children"). SDK igmedia.py api_update (comment_enabled).
 *   - ig-user/mentions.md: `POST /{ig-user-id}/mentions` with media_id (required) and message, plus comment_id for a reply
 *     to a comment the account was @mentioned in (both media_id and comment_id required then); not on Stories, not on
 *     photos the account was only tagged in. SDK iguser.py create_mention (comment_id, media_id, message).
 *   - marketing-api/ad-creative/threads-ads/reply-moderation.md: `POST /{reply-id}/manage_reply` hide (required bool) →
 *     {success}; `POST /{reply-id}/add_reply` text (required) → {id}, text only; ads_management of the ad account that owns
 *     the ad; direct replies only (nested replies not available); not for Advantage+ catalog ads, boosted posts, Instagram-
 *     or Page-backed Threads accounts. This guide has no delete; the Threads API deletes only with a Threads login token and
 *     `threads_delete`, which Nexus does not hold — so a Threads reply Nexus makes has no undo.
 * Caps Nexus keeps (Meta's API pages state none for the text): a Facebook comment 8,000 characters, an Instagram comment
 * 2,200, a Threads reply 500 — the limits of Meta's own apps.
 */
import type { MetaWriteBodyId, MetaWriteRule } from './meta-calls.js'
import { META_COMMENT_TEXT } from './meta-write-text.js'
import { metaLeadUrlProblem } from './meta-lead-form-rules.js'

type Params = ReadonlyMap<string, string>

/**
 * The text of a comment or reply: step 18's ONE shared pattern (meta-write-text.ts META_NAME_TEXT — no control or format
 * character, the zero-width joiner only between two emoji), and a line break (U+000A) — a reply is often a few lines.
 * Step 24 moved it to the leaf meta-write-text.ts; re-exported here for step 37's importers.
 */
export { META_COMMENT_TEXT }

/** Nexus's caps per platform (Meta's own apps' limits; its API pages state none). */
export const META_COMMENT_LIMITS = { facebook: 8000, instagram: 2200, threads: 500, url: 2000 } as const

/** The longest body of a comment rule (a Facebook comment of 8,000 characters, form-encoded, with two links). */
export const META_COMMENT_MAX_BODY = 80_000
/** The longest body of a Threads reply (500 characters form-encoded fit; review A5: the preview checks it too). */
export const META_THREADS_MAX_BODY = 10_000

const ids = /^\d{1,25}$/
const bool = (v: string | undefined) => v === 'true' || v === 'false'

/** Why a comment's text is refused, or null: text (not only spaces), at most `max` characters. */
export function metaCommentTextProblem(value: string | undefined, max: number, key = 'message'): string | null {
  if (value === undefined || !value.trim()) return `${key} is the reply's text`
  if ([...value].length > max) return `${key} is at most ${max} characters`
  return null
}

/** A Facebook comment's text and links: at least one of them; each link https. */
function facebookCommentProblem(params: Params): string | null {
  if (params.has('message')) {
    const problem = metaCommentTextProblem(params.get('message'), META_COMMENT_LIMITS.facebook)
    if (problem) return problem
  }
  for (const key of ['attachment_url', 'attachment_share_url']) {
    if (!params.has(key)) continue
    const problem = metaLeadUrlProblem(params.get(key), key)
    if (problem) return problem
  }
  return null
}

/** `psid` of a block: a JSON list of ONE person's Page-scoped id (digits), in Nexus's one spelling. */
function blockPsidProblem(value: string | undefined): string | null {
  let list: unknown
  try { list = JSON.parse(value ?? '') } catch { return 'psid is a JSON list of one id' }
  if (!Array.isArray(list) || list.length !== 1 || typeof list[0] !== 'string' || !ids.test(list[0]) || JSON.stringify(list) !== value) {
    return 'psid is a JSON list of exactly one Page-scoped id (digits), as Nexus writes it: ["<id>"]'
  }
  return null
}

/** The ids inside a mention reply: the media (and the comment) the chosen Instagram account was @mentioned in. */
function mentionIds(params: Params): MetaWriteBodyId[] {
  const out: MetaWriteBodyId[] = []
  const media = params.get('media_id')
  const comment = params.get('comment_id')
  // A reply to a comment names both: the comment must be a mention of the account ON this media.
  if (comment) out.push({ id: comment, kind: 'mentionedcomment' })
  if (media) out.push({ id: media, kind: 'mentionedmedia' })
  return out
}

const TEXT = { message: META_COMMENT_TEXT }

/** Step 37 — the comment rules (gateway meta-calls.ts writeRules). */
export const META_COMMENT_WRITE_RULES: readonly MetaWriteRule[] = [
  // ── Facebook, as the chosen Page ──
  {
    // comment on a post of the chosen Page, or reply to a comment on it (EN-006): POST /{post | comment}/comments.
    name: 'fbcomment.create',
    method: 'POST',
    path: /^\d{1,25}_\d{1,25}\/comments$/,
    kinds: ['fbpost', 'fbcomment'],
    auth: 'page',
    required: [],
    optional: ['message', 'attachment_url', 'attachment_share_url'],
    anyOf: ['message', 'attachment_url', 'attachment_share_url'],
    text: TEXT,
    maxBody: META_COMMENT_MAX_BODY,
    values: facebookCommentProblem,
    budget: false,
  },
  {
    // edit the Page's OWN comment (EN-007): POST /{comment} message and/or a link (never is_hidden here).
    name: 'fbcomment.edit',
    method: 'POST',
    path: /^\d{1,25}_\d{1,25}$/,
    kinds: ['fbpagecomment'],
    auth: 'page',
    required: [],
    optional: ['message', 'attachment_url', 'attachment_share_url'],
    anyOf: ['message', 'attachment_url', 'attachment_share_url'],
    text: TEXT,
    maxBody: META_COMMENT_MAX_BODY,
    values: facebookCommentProblem,
    budget: false,
  },
  {
    // hide / unhide a comment on a post of the chosen Page (EN-008), or on a creator's branded-content post that tags the
    // chosen Page as its sponsor (OT-032): POST /{comment} is_hidden=true|false.
    name: 'fbcomment.hide',
    method: 'POST',
    path: /^\d{1,25}_\d{1,25}$/,
    kinds: ['fbcomment', 'fbpagecomment', 'brandedcomment'],
    auth: 'page',
    required: ['is_hidden'],
    optional: [],
    values: (params) => (bool(params.get('is_hidden')) ? null : 'is_hidden is true or false'),
    budget: false,
  },
  {
    // delete a comment on a post of the chosen Page (EN-009, explicit ask) — and the undo of a reply Nexus made.
    name: 'fbcomment.delete',
    method: 'DELETE',
    path: /^\d{1,25}_\d{1,25}$/,
    kinds: ['fbcomment', 'fbpagecomment'],
    auth: 'page',
    required: [],
    optional: [],
    values: () => null,
    budget: false,
  },
  {
    // like a post or comment of the chosen Page as the Page (EN-010): POST /{object}/likes, no body at all.
    name: 'fblike.create',
    method: 'POST',
    path: /^\d{1,25}_\d{1,25}\/likes$/,
    kinds: ['fbpost', 'fbcomment', 'fbpagecomment'],
    auth: 'page',
    emptyBody: true,
    required: [],
    optional: [],
    values: () => null,
    budget: false,
  },
  {
    // unlike it (EN-010): DELETE /{object}/likes, no body.
    name: 'fblike.delete',
    method: 'DELETE',
    path: /^\d{1,25}_\d{1,25}\/likes$/,
    kinds: ['fbpost', 'fbcomment', 'fbpagecomment'],
    auth: 'page',
    required: [],
    optional: [],
    values: () => null,
    budget: false,
  },
  {
    // block a person from the chosen Page (EN-014): POST /{page}/blocked psid=["<their Page-scoped id>"].
    name: 'pageblock.create',
    method: 'POST',
    path: /^\d{1,25}\/blocked$/,
    kinds: ['page'],
    auth: 'page',
    required: ['psid'],
    optional: [],
    values: (params) => blockPsidProblem(params.get('psid')),
    // A person's id is never kept in the ledger, even of a failed block.
    ledger: () => ({ psid: '["(a person)"]' }),
    budget: false,
  },
  {
    // unblock them (EN-014): DELETE /{page}/blocked psid=<their Page-scoped id> (the form body Meta's reference names).
    name: 'pageblock.delete',
    method: 'DELETE',
    path: /^\d{1,25}\/blocked$/,
    kinds: ['page'],
    auth: 'page',
    required: ['psid'],
    optional: [],
    values: (params) => (ids.test(params.get('psid') ?? '') ? null : 'psid is one Page-scoped id (digits)'),
    ledger: () => ({ psid: '(a person)' }),
    budget: false,
  },
  // ── Instagram, as the chosen Page (the chosen Instagram account's own token in the Facebook Login flavour) ──
  {
    // hide / unhide a comment on the chosen account's media (EN-023): POST /{ig_comment} hide=true|false.
    name: 'igcomment.hide',
    method: 'POST',
    path: /^\d{1,25}$/,
    kinds: ['igcomment'],
    auth: 'page',
    required: ['hide'],
    optional: [],
    values: (params) => (bool(params.get('hide')) ? null : 'hide is true or false'),
    budget: false,
  },
  {
    // delete a comment on the chosen account's media (EN-024, explicit ask) — and the undo of a reply Nexus made there.
    name: 'igcomment.delete',
    method: 'DELETE',
    path: /^\d{1,25}$/,
    kinds: ['igcomment'],
    auth: 'page',
    required: [],
    optional: [],
    values: () => null,
    budget: false,
  },
  {
    // reply to a top-level comment on the chosen account's media (EN-021): POST /{ig_comment}/replies message.
    name: 'igcomment.reply',
    method: 'POST',
    path: /^\d{1,25}\/replies$/,
    kinds: ['igcomment'],
    auth: 'page',
    required: ['message'],
    optional: [],
    text: TEXT,
    maxBody: META_COMMENT_MAX_BODY,
    values: (params) => metaCommentTextProblem(params.get('message'), META_COMMENT_LIMITS.instagram),
    budget: false,
  },
  {
    // a top-level comment on the chosen account's own media (EN-022): POST /{ig_media}/comments message.
    name: 'igmedia.comment',
    method: 'POST',
    path: /^\d{1,25}\/comments$/,
    kinds: ['igmedia'],
    auth: 'page',
    required: ['message'],
    optional: [],
    text: TEXT,
    maxBody: META_COMMENT_MAX_BODY,
    values: (params) => metaCommentTextProblem(params.get('message'), META_COMMENT_LIMITS.instagram),
    budget: false,
  },
  {
    // comments on / off for one media of the chosen account (EN-025): POST /{ig_media} comment_enabled=true|false.
    name: 'igmedia.commentEnabled',
    method: 'POST',
    path: /^\d{1,25}$/,
    kinds: ['igmedia'],
    auth: 'page',
    required: ['comment_enabled'],
    optional: [],
    values: (params) => (bool(params.get('comment_enabled')) ? null : 'comment_enabled is true or false'),
    budget: false,
  },
  {
    // reply where the chosen account was @mentioned (EN-028): POST /{ig_user}/mentions media_id [comment_id] message — the
    // media (and comment) must be ones Meta answers as a mention of that account (meta-comment-owner.ts).
    name: 'iguser.mention',
    method: 'POST',
    path: /^\d{1,25}\/mentions$/,
    kinds: ['iguser'],
    auth: 'page',
    required: ['media_id', 'message'],
    optional: ['comment_id'],
    text: TEXT,
    maxBody: META_COMMENT_MAX_BODY,
    values: (params) => {
      if (!ids.test(params.get('media_id') ?? '')) return 'media_id is an Instagram media id (digits)'
      if (params.has('comment_id') && !ids.test(params.get('comment_id')!)) return 'comment_id is an Instagram comment id (digits)'
      return metaCommentTextProblem(params.get('message'), META_COMMENT_LIMITS.instagram)
    },
    ids: mentionIds,
    budget: false,
  },
  // ── Threads ads, with the system-user token (ads_management of the ad account that owns the ad) ──
  {
    // hide / unhide a direct reply on the Threads post of an ad of the chosen ad account (EN-031): POST /{reply}/manage_reply.
    name: 'threadsreply.hide',
    method: 'POST',
    path: /^\d{1,25}\/manage_reply$/,
    kinds: ['threadsreply'],
    required: ['hide'],
    optional: [],
    values: (params) => (bool(params.get('hide')) ? null : 'hide is true or false'),
    budget: false,
  },
  {
    // a text reply on that Threads post, or to one of its direct replies (EN-032): POST /{id}/add_reply text.
    name: 'threads.reply',
    method: 'POST',
    path: /^\d{1,25}\/add_reply$/,
    kinds: ['threadsmedia', 'threadsreply'],
    required: ['text'],
    optional: [],
    text: { text: META_COMMENT_TEXT },
    maxBody: META_THREADS_MAX_BODY,
    values: (params) => metaCommentTextProblem(params.get('text'), META_COMMENT_LIMITS.threads, 'text'),
    budget: false,
  },
]

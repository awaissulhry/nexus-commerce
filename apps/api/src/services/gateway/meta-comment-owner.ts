/**
 * Meta step 37 (2026-10-21) — the owner check of a comment change (meta-comment-rules.ts). Before the gateway reads the
 * chosen Page's token (meta-page-token.ts) — or, for a Threads ad, sends with the system-user token — the object the change
 * names must be, by its kind:
 *   fbpost          a post of the business's CHOSEN Facebook Page: Meta's `<page id>_<post id>` with the chosen Page's id
 *                   first, and ONE live read of its id alone answering that same id;
 *   fbcomment       a comment on such a post: its id `<object>_<comment>` names the post's own part — `<page>_<object>`
 *                   answers as a post of the chosen Page — or a photo or video of that Page (`from` the chosen Page, the
 *                   way step 14's ownFacebookComment checks a comment on a photo or video post); then ONE read of the
 *                   comment's id must answer that same id;
 *   fbpagecomment   the same, and the comment was written BY the chosen Page (`from`): only the Page's own comment is edited;
 *   brandedcomment  a comment on a creator's branded-content post (master OT-032): the change names the post (`parent`,
 *                   kind `brandedpost`), the post's `sponsor_tags` edge must list the chosen Page (one page of 100), the
 *                   comment's id must name that post's own part, and one read of the comment must answer its id;
 *   igmedia         a media of the CHOSEN Instagram account: Meta's `owner` (else its `username` against the account's own,
 *                   read now — step 10's ownMedia rule);
 *   igcomment       a comment whose `media{id}` is such a media (step 14's ownInstagramComment rule);
 *   iguser          the chosen Instagram account itself — and the ids inside a mention reply: Meta must answer the comment
 *                   (`mentioned_comment.comment_id(<id>){id,media{id}}`, its media the one named) or the media
 *                   (`mentioned_media.media_id(<id>){id}`) as one the account was @mentioned in;
 *   threadsmedia    the Threads post of an ad of the CHOSEN ad account: the change names the ad (`parent`, kind `ad`), whose
 *                   `account_id` must be the chosen account and whose creative's `threads_media_id` must be this id;
 *   threadsreply    a direct reply on that post: in its `/replies` (one page of 100; more pages: not confirmed).
 * Every read goes through this gateway (its read gate, ledger and rate bucket). Gap 46b (Meta refuses the chosen Page's posts
 * to the system-user token, live #10 of 2026-10-26): a read of a post of the chosen Page (`<chosen Page>_<id>`) and the exact
 * owner read of a Page photo or video (`id,from{id}`) go with the CHOSEN Page's own token (meta-page-reads.ts), and a missing
 * or refused one refuses the change; a comment's own read, and every other read here, keeps the business's system-user
 * token. Anything else — another business's Page, account, post, comment or ad, a node of another kind, an id Meta cannot
 * place — gets nothing sent, and the sentence never names the other business's asset.
 */
import { metaChosenAdAccountOf, metaChosenInstagramOf, metaChosenPageOf } from './account.js'
import type { MetaJudgedWrite, MetaWriteKind } from './meta-calls.js'
import type { MetaCheckRead } from './meta-brand-safety-owner.js'

/** The comment kinds made AS the chosen Page (their rules are `auth: 'page'`; meta-page-owner.ts routes them here). */
export const META_COMMENT_PAGE_KINDS: ReadonlySet<MetaWriteKind> = new Set<MetaWriteKind>(['fbpost', 'fbcomment', 'fbpagecomment', 'brandedcomment', 'igmedia', 'igcomment', 'iguser'])
/** The Threads kinds (system-user token; gateway.ts routes them here). */
export const META_THREADS_KINDS: ReadonlySet<string> = new Set(['threadsmedia', 'threadsreply'])

type Problem = { code: string; sentence: string } | null
type Row = Record<string, unknown>
const idOf = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const rowsOf = (v: unknown): Row[] => (Array.isArray(obj(v)?.data) ? (obj(v)!.data as unknown[]).map(obj).filter((r): r is Row => !!r) : [])
const NOT_SENT = 'Nothing was sent to Meta:'
const meta = (words: string | null) => (words ? ` (Meta: ${words})` : '')
const notKind = (id: string, what: string, words: string | null): Problem => ({ code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} ${id} is not ${what}${meta(words)}.` })
const unconfirmed = (sentence: string, words: string | null): Problem => ({ code: 'META_PAGE_UNCONFIRMED', sentence: `${NOT_SENT} ${sentence}${meta(words)}.` })

/** Why this comment change made as the chosen Page is refused, or null. `kind` is one of META_COMMENT_PAGE_KINDS. */
export async function metaCommentOwnerProblem(connectionId: string, write: MetaJudgedWrite, kind: string, read: MetaCheckRead, parent?: { kind: string; id: string }): Promise<Problem> {
  const id = write.objectId
  // Only a mention reply names ids inside its body (the media and comment of the mention).
  if (kind !== 'iguser' && write.ids?.length) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} this change names an id inside its body that Nexus does not check.` }
  if (kind === 'igmedia' || kind === 'igcomment' || kind === 'iguser') {
    const instagramId = await metaChosenInstagramOf(connectionId)
    if (!instagramId) return { code: 'META_INSTAGRAM_NOT_CHOSEN', sentence: `${NOT_SENT} this business has no Instagram account chosen through this Meta connection, so Nexus changes no Instagram comment.` }
    if (kind === 'igmedia') return instagramMediaProblem(id, instagramId, read)
    if (kind === 'igcomment') return instagramCommentProblem(id, instagramId, read)
    if (id !== instagramId) return { code: 'META_INSTAGRAM_NOT_CHOSEN', sentence: `${NOT_SENT} ${id} is not the Instagram account this business chose through this connection.` }
    return mentionIdsProblem(write, instagramId, read)
  }
  const pageId = await metaChosenPageOf(connectionId)
  if (!pageId) return { code: 'META_PAGE_NOT_CHOSEN', sentence: `${NOT_SENT} this business has no Facebook Page chosen through this Meta connection, so Nexus changes no comment made as a Page.` }
  if (kind === 'fbpost') return postProblem(id, pageId, read)
  if (kind === 'brandedcomment') return brandedCommentProblem(id, pageId, read, parent)
  return facebookCommentProblem(id, pageId, read, kind === 'fbpagecomment')
}

/** A post of the chosen Page: `<page>_<post>` with the chosen Page first, and Meta answers that same id. */
async function postProblem(id: string, pageId: string, read: MetaCheckRead): Promise<Problem> {
  const shape = /^(\d{1,25})_(\d{1,25})$/.exec(id)
  if (!shape) return notKind(id, 'a Facebook post (<Page id>_<post id>)', null)
  if (shape[1] !== pageId) return { code: 'META_PAGE_NOT_CHOSEN', sentence: `${NOT_SENT} ${id} is not a post of the Facebook Page this business chose.` }
  const answer = await read(id, { fields: 'id' })
  if (!answer.body) return unconfirmed(`Nexus could not confirm that post ${id} is the chosen Facebook Page's`, answer.words)
  return idOf(answer.body.id) === id ? null : unconfirmed(`Meta answered another object than post ${id}`, null)
}

/**
 * A comment on a post (or a photo or video) of the chosen Page; `byThePage`: and written by the chosen Page itself (an edit
 * changes only the Page's own words).
 */
async function facebookCommentProblem(id: string, pageId: string, read: MetaCheckRead, byThePage: boolean): Promise<Problem> {
  const shape = /^(\d{1,25})_(\d{1,25})$/.exec(id)
  if (!shape) return notKind(id, 'a Facebook comment (<post id>_<comment id>)', null)
  const object = shape[1]
  // 1. Its post's own part, as a post of the chosen Page (`<page>_<object>` answers that same id).
  const post = await read(`${pageId}_${object}`, { fields: 'id' })
  let onPage = idOf(post.body?.id) === `${pageId}_${object}`
  // 2. Else a photo or video of the chosen Page (its `from`): a comment on a photo or video post carries that object's id.
  if (!onPage) {
    const owner = await read(object, { fields: 'id,from{id}' })
    if (owner.body && idOf(owner.body.id) === object) {
      if (idOf(obj(owner.body.from)?.id) !== pageId) return { code: 'META_PAGE_NOT_CHOSEN', sentence: `${NOT_SENT} comment ${id} is not on a post of the Facebook Page this business chose.` }
      onPage = true
    } else if (!post.body && !owner.body) {
      return unconfirmed(`Nexus could not confirm that comment ${id} is on a post of the Facebook Page this business chose`, post.words ?? owner.words)
    }
  }
  if (!onPage) return { code: 'META_PAGE_NOT_CHOSEN', sentence: `${NOT_SENT} comment ${id} is not on a post of the Facebook Page this business chose.` }
  // 3. The comment itself: Meta answers that same id (and, for an edit, the chosen Page as its author).
  const comment = await read(id, { fields: byThePage ? 'id,from{id}' : 'id' })
  if (!comment.body) {
    return /nonexisting field|does not exist/i.test(comment.words ?? '') ? notKind(id, 'a comment Meta knows', comment.words) : unconfirmed(`Nexus could not read comment ${id}`, comment.words)
  }
  if (idOf(comment.body.id) !== id) return unconfirmed(`Meta answered another object than comment ${id}`, null)
  if (byThePage && idOf(obj(comment.body.from)?.id) !== pageId) {
    return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} comment ${id} was not written by the chosen Facebook Page: Nexus edits only the Page's own comments.` }
  }
  return null
}

/** OT-032 — a comment on a creator's branded-content post that tags the chosen Page as its sponsor. */
async function brandedCommentProblem(id: string, pageId: string, read: MetaCheckRead, parent: { kind: string; id: string } | undefined): Promise<Problem> {
  const post = parent?.kind === 'brandedpost' ? /^(\d{1,25})_(\d{1,25})$/.exec(parent.id) : null
  if (!post) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} a change of a comment on a branded-content post names that post (<creator Page id>_<post id>).` }
  if (!new RegExp(`^${post[2]}_\\d{1,25}$`).test(id)) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} comment ${id} is not on branded-content post ${parent!.id}.` }
  const tags = await read(`${parent!.id}/sponsor_tags`, { fields: 'id', limit: '100' })
  if (!tags.body) return unconfirmed(`Nexus could not read which brands post ${parent!.id} tags as its sponsor`, tags.words)
  if (!rowsOf(tags.body).some((r) => idOf(r.id) === pageId)) {
    return obj(tags.body.paging)?.next
      ? unconfirmed(`Meta lists more than 100 sponsors on post ${parent!.id}; Nexus could not confirm the chosen Page is one of them`, null)
      : { code: 'META_PAGE_NOT_CHOSEN', sentence: `${NOT_SENT} post ${parent!.id} does not tag the Facebook Page this business chose as its branded-content sponsor.` }
  }
  const comment = await read(id, { fields: 'id' })
  if (!comment.body) return unconfirmed(`Nexus could not read comment ${id}`, comment.words)
  return idOf(comment.body.id) === id ? null : unconfirmed(`Meta answered another object than comment ${id}`, null)
}

/** A media of the chosen Instagram account: Meta's `owner`, else its `username` against the account's own (read now). */
async function instagramMediaProblem(id: string, instagramId: string, read: MetaCheckRead): Promise<Problem> {
  if (!/^\d{1,25}$/.test(id)) return notKind(id, 'an Instagram media id', null)
  const answer = await read(id, { fields: 'id,owner,username' })
  if (!answer.body) {
    return /nonexisting field/i.test(answer.words ?? '') ? notKind(id, 'an Instagram media', answer.words) : unconfirmed(`Nexus could not confirm that Instagram media ${id} is the chosen account's`, answer.words)
  }
  if (idOf(answer.body.id) !== id) return unconfirmed(`Meta answered another object than Instagram media ${id}`, null)
  const owner = idOf(obj(answer.body.owner)?.id ?? answer.body.owner)
  if (owner === instagramId) return null
  const username = typeof answer.body.username === 'string' ? answer.body.username.toLowerCase() : null
  if (!owner && username) {
    const own = await read(instagramId, { fields: 'id,username' })
    if (own.body && idOf(own.body.id) === instagramId && typeof own.body.username === 'string' && own.body.username.toLowerCase() === username) return null
    if (!own.body) return unconfirmed('Nexus could not read the chosen Instagram account\'s username to confirm the media is its own', own.words)
  }
  return { code: 'META_INSTAGRAM_NOT_CHOSEN', sentence: `${NOT_SENT} Instagram media ${id} is not the Instagram account's this business chose.` }
}

/** A comment on a media of the chosen Instagram account: its `media{id}` first, then that media's check. */
async function instagramCommentProblem(id: string, instagramId: string, read: MetaCheckRead): Promise<Problem> {
  if (!/^\d{1,25}$/.test(id)) return notKind(id, 'an Instagram comment id', null)
  const answer = await read(id, { fields: 'id,media{id}' })
  if (!answer.body) {
    return /nonexisting field/i.test(answer.words ?? '') ? notKind(id, 'an Instagram comment', answer.words) : unconfirmed(`Nexus could not confirm which Instagram media comment ${id} is on`, answer.words)
  }
  if (idOf(answer.body.id) !== id) return unconfirmed(`Meta answered another object than Instagram comment ${id}`, null)
  const media = idOf(obj(answer.body.media)?.id)
  if (!media) return notKind(id, 'an Instagram comment on a media Meta names', null)
  const problem = await instagramMediaProblem(media, instagramId, read)
  return problem ? { code: problem.code, sentence: problem.sentence.replace(`${NOT_SENT} `, `${NOT_SENT} comment ${id} is on a media that is not the chosen account's — `) } : null
}

/** The ids inside a mention reply: Meta must answer them as a mention of the chosen Instagram account. */
async function mentionIdsProblem(write: MetaJudgedWrite, instagramId: string, read: MetaCheckRead): Promise<Problem> {
  const inner = write.ids ?? []
  const comment = inner.find((i) => i.kind === 'mentionedcomment')
  const media = inner.find((i) => i.kind === 'mentionedmedia')
  if (!media || inner.some((i) => i.kind !== 'mentionedcomment' && i.kind !== 'mentionedmedia') || inner.length > 2 || inner.some((i) => !/^\d{1,25}$/.test(i.id))) {
    return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} a mention reply names the media (and the comment) the chosen Instagram account was @mentioned in, and nothing else.` }
  }
  if (comment) {
    const answer = await read(instagramId, { fields: `id,mentioned_comment.comment_id(${comment.id}){id,media{id}}` })
    const found = obj(answer.body?.mentioned_comment)
    if (!answer.body) return unconfirmed(`Nexus could not confirm that comment ${comment.id} @mentions the chosen Instagram account`, answer.words)
    if (idOf(found?.id) !== comment.id) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} Meta does not answer comment ${comment.id} as one that @mentions the chosen Instagram account.` }
    if (idOf(obj(found!.media)?.id) !== media.id) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} comment ${comment.id} is not on media ${media.id}.` }
    return null
  }
  const answer = await read(instagramId, { fields: `id,mentioned_media.media_id(${media.id}){id}` })
  if (!answer.body) return unconfirmed(`Nexus could not confirm that media ${media.id} @mentions the chosen Instagram account`, answer.words)
  return idOf(obj(answer.body.mentioned_media)?.id) === media.id ? null : { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} Meta does not answer media ${media.id} as one whose caption @mentions the chosen Instagram account.` }
}

/**
 * The Threads post of an ad of the chosen ad account, or a direct reply on it (system-user token). The change names the
 * ad (`parent`, kind `ad`): one read of its account_id and its creative's threads_media_id; a reply: one page of the post's
 * `/replies`.
 */
export async function metaThreadsOwnerProblem(connectionId: string, write: MetaJudgedWrite, kind: string, read: MetaCheckRead, parent?: { kind: string; id: string }): Promise<Problem> {
  const id = write.objectId
  if (!write.kinds?.includes(kind as MetaWriteKind) || !META_THREADS_KINDS.has(kind)) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} a Threads change names the kind of object it changes (the ad's Threads post, a direct reply on it), and ${id} is not named so.` }
  if (write.auth) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} a Threads ad's replies are changed with the ad account's own token only.` }
  if (parent?.kind !== 'ad' || !/^\d{1,25}$/.test(parent.id)) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} a change of a Threads ad's replies names the ad it belongs to.` }
  if (write.ids?.length) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} this change names an id inside its body that Nexus does not check.` }
  const chosen = await metaChosenAdAccountOf(connectionId)
  if (!chosen) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `${NOT_SENT} this business has no Meta ad account chosen through this connection.` }
  const ad = await read(parent.id, { fields: 'id,account_id,creative{threads_media_id}' })
  if (!ad.body) return { code: 'META_ACCOUNT_UNCONFIRMED', sentence: `${NOT_SENT} Nexus could not confirm which ad account ad ${parent.id} belongs to${meta(ad.words)}.` }
  const account = idOf(ad.body.account_id)?.replace(/^act_/, '') ?? null
  if (idOf(ad.body.id) !== parent.id || account !== chosen) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `${NOT_SENT} ad ${parent.id} is not of the Meta ad account this business chose through this connection.` }
  const threads = idOf(obj(ad.body.creative)?.threads_media_id)
  if (!threads) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} Meta names no Threads post on ad ${parent.id}'s creative.` }
  if (kind === 'threadsmedia') return id === threads ? null : { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} ${id} is not the Threads post of ad ${parent.id}.` }
  const replies = await read(`${threads}/replies`, { fields: 'id', limit: '100' })
  if (!replies.body) return { code: 'META_ACCOUNT_UNCONFIRMED', sentence: `${NOT_SENT} Nexus could not read the replies of ad ${parent.id}'s Threads post${meta(replies.words)}.` }
  if (rowsOf(replies.body).some((r) => idOf(r.id) === id)) return null
  return obj(replies.body.paging)?.next
    ? { code: 'META_ACCOUNT_UNCONFIRMED', sentence: `${NOT_SENT} ${id} is not among the first 100 direct replies of ad ${parent.id}'s Threads post, so Nexus could not confirm it is one of them.` }
    : { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} ${id} is not a direct reply on ad ${parent.id}'s Threads post.` }
}

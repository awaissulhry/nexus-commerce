/**
 * Meta step 24 (2026-10-25) — the owner check of a post change (meta-post-rules.ts), made AS the chosen Facebook Page
 * (`auth: 'page'`: meta-page-owner.ts routes these kinds here, before the gateway reads the Page's token). The object the
 * change names must be, by its kind:
 *   postpage      the business's CHOSEN Facebook Page itself (its PAGE MetaAccountLink);
 *   pagepostedit  a post of that Page (`<chosen page id>_<post id>`) that Meta answers, ONE read, with that same id and
 *                 written BY the Page (`from`): a visitor's post is not the Page's to change;
 *   pagepostmade  a post Nexus itself made on that Page (create-meta-page-post's change records, row-level security): the
 *                 only posts Nexus deletes — a video post's record may name only its video (Meta names the post later):
 *                 then the change names that video (`metaParent` kind `pagevideo`), a record names it, and ONE read of it
 *                 (`GET /<video>?fields=id,post_id,from{id}`, the Page's own video) must answer this post;
 *   postig        the business's CHOSEN Instagram account itself;
 *   igmediamade   an Instagram media Nexus itself published on that account (create-meta-instagram-post's records).
 * And every id inside the body, each confirmed before anything is sent:
 *   postphoto        a photo THIS gateway saw Meta make for this connection in the SAME run of the change (the kit's run
 *                    id), else ONE read `GET /<photo>?fields=id,from{id}` answering that id with `from` the chosen Page;
 *   postimagehash    an image of the chosen ad account's library (ONE read of the change's hashes on act_<id>/adimages);
 *   postsponsorpage  a brand's Page: never the chosen Page, never one another Nexus business chose (nexus_meta_links_taken);
 *   igcontainer      a container THIS gateway saw Meta make in the same run, else one an earlier change of this business
 *                    recorded (create-meta-instagram-post's `containerId`) on the same Instagram account;
 *   igsponsor        a brand's Instagram account: never the chosen one, never one another Nexus business chose;
 *   postplace        a place's Page: never one another Nexus business chose.
 * A collaborator is an Instagram USERNAME, not an id, so it is not a body id here: create-meta-instagram-post checks each by
 * step 16's Business Discovery read before it queues anything (live-posts.ts igUsernameTaken).
 * Every read goes through this gateway with the business's system-user token (its read gate, ledger and rate bucket), never
 * the Page's. Anything else — another business's Page, account, post or media, a node of another kind, an id Meta cannot
 * place — gets nothing sent, and the sentence never names the other business's asset.
 */
import { metaChosenAdAccountOf, metaChosenInstagramOf, metaChosenPageOf, metaLinkTaken, metaPostNexusMade } from './account.js'
import type { MetaJudgedWrite, MetaWriteKind } from './meta-calls.js'
import type { MetaCheckRead } from './meta-brand-safety-owner.js'
import { metaVideoPostIdOf, type MetaPostBodyKind } from './meta-post-rules.js'

/** The post kinds (their rules are `auth: 'page'`; meta-page-owner.ts routes them here). */
export const META_POST_KINDS: ReadonlySet<MetaWriteKind> = new Set<MetaWriteKind>(['postpage', 'pagepostedit', 'pagepostmade', 'postig', 'igmediamade'])

/** Which ids each object kind's body may name (anything else is refused). */
const BODY_KINDS: Readonly<Record<string, ReadonlySet<MetaPostBodyKind>>> = {
  postpage: new Set<MetaPostBodyKind>(['postphoto', 'postimagehash', 'postplace']),
  pagepostedit: new Set<MetaPostBodyKind>(['postsponsorpage']),
  pagepostmade: new Set<MetaPostBodyKind>(),
  postig: new Set<MetaPostBodyKind>(['igcontainer', 'igsponsor', 'postplace']),
  igmediamade: new Set<MetaPostBodyKind>(),
}

type Problem = { code: string; sentence: string } | null
const NOT_SENT = 'Nothing was sent to Meta:'
const idOf = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null)
const fromOf = (body: Record<string, unknown> | null): string | null => (body?.from && typeof body.from === 'object' ? idOf((body.from as Record<string, unknown>).id) : null)
const meta = (words: string | null) => (words ? ` (Meta: ${words})` : '')
const DIGITS = /^[1-9]\d{0,24}$/

// ── what this gateway saw made in a run ───────────────────────────────────────────────────────────────────────────

/** A run makes its photos or containers, then the post from them, within minutes: an older note is not used. */
const MADE_TTL_MS = 60 * 60_000
const MAX_MADE = 5_000
const made = new Map<string, number>()
const madeKey = (connectionId: string, run: string, kind: 'postphoto' | 'igcontainer', id: string) => `${connectionId}:${run}:${kind}:${id}`

/**
 * After a write Meta accepted: remember the photo (`pagepost.photo`) or the container (`igmedia.container`) it made, for this
 * connection AND this run of a change (the kit's run id), so the post (or the carousel, or its publish) made from it in the
 * same run may name it. Any other rule, or a call with no run id, is not remembered. gateway.ts calls it.
 */
export function noteMetaPostPartMade(connectionId: string, run: string | undefined, rule: string, answer: string, now = Date.now()): void {
  const kind = rule === 'pagepost.photo' ? 'postphoto' : rule === 'igmedia.container' ? 'igcontainer' : null
  if (!run || !kind) return
  let id: string | null = null
  try { id = idOf((JSON.parse(answer) as Record<string, unknown> | null)?.id) } catch { id = null }
  if (!id || !DIGITS.test(id)) return
  for (const [key, at] of made) if (now - at > MADE_TTL_MS || made.size >= MAX_MADE) made.delete(key)
  made.set(madeKey(connectionId, run, kind, id), now)
}
const madeInRun = (connectionId: string, run: string | undefined, kind: 'postphoto' | 'igcontainer', id: string, now = Date.now()) => {
  if (!run) return false
  const at = made.get(madeKey(connectionId, run, kind, id))
  return at !== undefined && now - at <= MADE_TTL_MS
}
export const __postOwnerTest = { reset: () => made.clear() }

// ── the checks ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Why this post change made as the chosen Page is refused for this connection, or null. `kind` is one of META_POST_KINDS;
 * `parent`: a delete of a video post names its video (`pagevideo`).
 */
export async function metaPostOwnerProblem(connectionId: string, write: MetaJudgedWrite, kind: string, read: MetaCheckRead, run?: string, parent?: { kind: string; id: string }): Promise<Problem> {
  const id = write.objectId
  const allowed = BODY_KINDS[kind]
  if (!allowed) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} a post change names the kind of object it changes, and ${id} is not named so.` }
  if ((write.ids ?? []).some((inner) => !allowed.has(inner.kind as MetaPostBodyKind))) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} this change names an id inside its body that Nexus does not check.` }
  if (kind === 'postig' || kind === 'igmediamade') {
    const instagramId = await metaChosenInstagramOf(connectionId)
    if (!instagramId) return { code: 'META_INSTAGRAM_NOT_CHOSEN', sentence: `${NOT_SENT} this business has no Instagram account chosen through this Meta connection, so Nexus posts nothing on Instagram.` }
    if (kind === 'postig') {
      if (id !== instagramId) return { code: 'META_INSTAGRAM_NOT_CHOSEN', sentence: `${NOT_SENT} ${id} is not the Instagram account this business chose through this connection.` }
    } else if (!DIGITS.test(id) || !(await metaPostNexusMade('igmedia', id, instagramId))) {
      return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} ${id} is not an Instagram media Nexus published on the chosen Instagram account. Nexus deletes only its own posts (a person deletes another in the Instagram app).` }
    }
    return bodyIdsProblem(connectionId, write, { instagramId }, read, run)
  }
  const pageId = await metaChosenPageOf(connectionId)
  if (!pageId) return { code: 'META_PAGE_NOT_CHOSEN', sentence: `${NOT_SENT} this business has no Facebook Page chosen through this Meta connection, so Nexus posts nothing as a Page.` }
  if (kind === 'postpage') {
    if (id !== pageId) return { code: 'META_PAGE_NOT_CHOSEN', sentence: `${NOT_SENT} ${id} is not the Facebook Page this business chose through this connection.` }
    return bodyIdsProblem(connectionId, write, { pageId }, read, run)
  }
  const shape = /^(\d{1,25})_(\d{1,25})$/.exec(id)
  if (!shape) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} ${id} is not a Facebook post id (<Page id>_<post id>).` }
  if (shape[1] !== pageId) return { code: 'META_PAGE_NOT_CHOSEN', sentence: `${NOT_SENT} ${id} is not a post of the Facebook Page this business chose.` }
  if (kind === 'pagepostmade') {
    if (await metaPostNexusMade('pagepost', id, pageId)) return null
    // Review B-F2 / re-review N4 — a video post Nexus made whose post Meta named only later: the change names its video, a
    // record names that video, and its post_id (read now, the chosen Page's own video) must be this post.
    const videoId = parent?.kind === 'pagevideo' ? parent.id : null
    if (videoId && DIGITS.test(videoId) && await metaPostNexusMade('pagevideo', videoId, pageId)) {
      const answer = await read(videoId, { fields: 'id,post_id,from{id}' })
      if (answer.body && idOf(answer.body.id) === videoId && fromOf(answer.body) === pageId && metaVideoPostIdOf(answer.body.post_id, pageId) === id) return null
    }
    return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} post ${id} is not one Nexus made on the chosen Facebook Page. Nexus deletes only its own posts (a person deletes another in Meta Business Suite).` }
  }
  // pagepostedit — a post of the Page that the Page itself wrote.
  const answer = await read(id, { fields: 'id,from{id}' })
  if (!answer.body) return { code: 'META_PAGE_UNCONFIRMED', sentence: `${NOT_SENT} Nexus could not confirm that post ${id} is the chosen Facebook Page's own${meta(answer.words)}.` }
  if (idOf(answer.body.id) !== id) return { code: 'META_PAGE_UNCONFIRMED', sentence: `${NOT_SENT} Meta answered another object than post ${id}.` }
  if (fromOf(answer.body) !== pageId) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} post ${id} was not written by the chosen Facebook Page (a visitor's post is not the Page's to change).` }
  return bodyIdsProblem(connectionId, write, { pageId }, read, run)
}

/** At most this many ids inside one body are checked (a carousel names at most 20 items, a photo post 10 photos). */
const MAX_BODY_IDS = 30

async function bodyIdsProblem(connectionId: string, write: MetaJudgedWrite, mine: { pageId?: string; instagramId?: string }, read: MetaCheckRead, run: string | undefined): Promise<Problem> {
  const ids = write.ids ?? []
  if (!ids.length) return null
  if (ids.length > MAX_BODY_IDS) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} a post change names at most ${MAX_BODY_IDS} ids inside its body.` }
  const inside = (code: string, what: string): Problem => ({ code, sentence: `${NOT_SENT} inside this change, ${what}` })
  // The library images, read once for every hash the change names.
  let library: Promise<{ hashes: Set<string> } | { words: string | null }> | undefined
  const libraryOf = async (hashes: string[]) => {
    const chosen = await metaChosenAdAccountOf(connectionId)
    if (!chosen) return { words: 'this business has no Meta ad account chosen' }
    const answer = await read(`act_${chosen}/adimages`, { fields: 'hash', hashes: JSON.stringify(hashes) })
    if (!answer.body || !Array.isArray(answer.body.data)) return { words: answer.words }
    return { hashes: new Set((answer.body.data as unknown[]).map((r) => (r && typeof r === 'object' ? idOf((r as Record<string, unknown>).hash) : null)).filter((h): h is string => !!h)) }
  }
  for (const inner of ids) {
    switch (inner.kind as MetaPostBodyKind) {
      case 'postphoto': {
        if (!DIGITS.test(inner.id)) return inside('META_WRITE_NOT_ALLOWED', `${inner.id} is not a photo id.`)
        if (madeInRun(connectionId, run, 'postphoto', inner.id)) continue
        const answer = await read(inner.id, { fields: 'id,from{id}' })
        if (answer.body && idOf(answer.body.id) === inner.id && fromOf(answer.body) === mine.pageId) continue
        return answer.body
          ? inside('META_PAGE_NOT_CHOSEN', `photo ${inner.id} is not one of the Facebook Page this business chose.`)
          : inside('META_PAGE_UNCONFIRMED', `Nexus could not confirm that photo ${inner.id} is the chosen Facebook Page's${meta(answer.words)}.`)
      }
      case 'postimagehash': {
        library ??= libraryOf([...new Set(ids.filter((i) => i.kind === 'postimagehash').map((i) => i.id))])
        const images = await library
        if ('hashes' in images) {
          if (images.hashes.has(inner.id)) continue
          return inside('META_ACCOUNT_NOT_CHOSEN', `image ${inner.id} is not one Nexus can confirm in the chosen ad account's image library (create-meta-media uploads it and answers its hash).`)
        }
        return inside('META_ACCOUNT_UNCONFIRMED', `Nexus could not read the chosen ad account's image library to confirm image ${inner.id}${meta(images.words)}.`)
      }
      case 'postsponsorpage':
      case 'postplace': {
        if (!DIGITS.test(inner.id)) return inside('META_WRITE_NOT_ALLOWED', `${inner.id} is not a Facebook Page id.`)
        if (inner.kind === 'postsponsorpage' && inner.id === mine.pageId) return inside('META_WRITE_NOT_ALLOWED', 'the sponsor is the chosen Page itself: a paid-partner tag names another brand\'s Page.')
        if (await metaLinkTaken('PAGE', inner.id)) return inside('META_WRITE_NOT_ALLOWED', `Page ${inner.id} is one another business in Nexus uses, so no post of this business names it.`)
        continue
      }
      case 'igsponsor': {
        if (!DIGITS.test(inner.id)) return inside('META_WRITE_NOT_ALLOWED', `${inner.id} is not an Instagram account id.`)
        if (inner.id === mine.instagramId) return inside('META_WRITE_NOT_ALLOWED', 'the sponsor is the chosen Instagram account itself (Meta: "Cannot tag yourself as sponsor").')
        if (await metaLinkTaken('INSTAGRAM', inner.id)) return inside('META_WRITE_NOT_ALLOWED', `Instagram account ${inner.id} is one another business in Nexus uses, so no post of this business names it.`)
        continue
      }
      case 'igcontainer': {
        if (!DIGITS.test(inner.id)) return inside('META_WRITE_NOT_ALLOWED', `${inner.id} is not a media container id.`)
        if (madeInRun(connectionId, run, 'igcontainer', inner.id)) continue
        if (mine.instagramId && await metaPostNexusMade('igcontainer', inner.id, mine.instagramId)) continue
        return inside('META_WRITE_NOT_ALLOWED', `container ${inner.id} is not one this change made, nor one an earlier create-meta-instagram-post of this business made on the chosen Instagram account (a container has no owner Meta can name, so Nexus publishes only its own).`)
      }
      default:
        return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} this change names an id inside its body that Nexus does not check.` }
    }
  }
  return null
}

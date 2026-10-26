/**
 * Meta step 36 (2026-10-21) — the owner check of a change made AS the chosen Facebook Page (a write rule with
 * `auth: 'page'`, meta-lead-form-rules.ts). Before the gateway reads the Page's token (meta-page-token.ts) and sends
 * anything, the object the change names must be:
 *   page      the business's CHOSEN Page itself (its PAGE MetaAccountLink, row-level security: never another business's;
 *             step 30 part 3: the app installed on it, page.subscribed_apps);
 *   leadform  a lead form OF that Page: one create-meta-lead-form made there (Nexus's own change records), else ONE live
 *             read of the form through this gateway (`GET /<form>?fields=id,page_id,questions{type}`, the business's
 *             system-user token): the same id must come back, its `page_id` must be the chosen Page and it must have
 *             questions (SDK leadgenform.py: `page_id`, `questions` — only a lead form has both);
 *   testlead  a TEST lead Nexus made itself on a form of that Page (set-meta-lead-form's change records): a real lead is
 *             never in them, so Nexus never deletes one (LD-039: Meta documents deleting for test leads only);
 *   canvas    (step 27b) an Instant Experience OF that Page: one create-meta-instant-experience made there (its change
 *             records), else ONE live read (`GET /<canvas>?fields=id,owner,is_published`): the same id, `owner` the chosen
 *             Page, and `is_published` true or false (SDK canvas.py: only an Instant Experience has both);
 *   ownpagevideo (gap 46b, MD-024: its thumbnail) a video the chosen Page POSTED: ONE live read (`GET /<video>?fields=id,
 *             from{id}`): the same id and `from` the chosen Page (review: no field Nexus does not use is asked, so a field
 *             Meta leaves out never refuses it; Meta itself refuses a thumbnail on a node that is not a video).
 * And every id inside the body (step 27b's Instant Experience parts name many), each confirmed before anything is sent:
 *   pagephoto       a photo OF the chosen Page (ONE live read `GET /<photo>?fields=id,from{id},width,height`: the same id,
 *                   `from` the chosen Page, a width and height — a post, video, album or comment has no such pair);
 *   pagepost        a post of the chosen Page (`<page id>_<post id>`, step 25's rule) or a photo or video it posted (its own
 *                   digits: ONE read `GET /<id>?fields=id,from{id}`, `from` the chosen Page);
 *   instagrammedia  a media of the chosen Instagram account (Meta's `owner`, else its `username` against the account's own,
 *                   read live — step 25's rule);
 *   canvasvideo     a video the chosen Page posted (`from`), else one of the chosen ad account's library (its first 500,
 *                   step 22's rule);
 *   canvaselement   a part THIS gateway saw Meta make for this connection in the SAME run of a change (the kit's run id),
 *                   else one listed on the chosen Page (`<page>/canvas_elements`, its first 500 — step 22's rule);
 *   canvas          an Instant Experience of the chosen Page (as above: a link from a part to another one);
 *   leadform        a lead form of the chosen Page (as above);
 *   productset / productitem  step 18's ONE catalog rule (catalog-rule.ts, one memo per call): of the chosen ad account's
 *                   business portfolio, and that portfolio no other Nexus business's.
 * Anything else — another business's Page, form, lead, experience, media or catalog, a node of another kind, an id Meta
 * cannot place — gets nothing sent, and the sentence never names the other business's asset. Lanes C2 (posts) and C4
 * (comments, messages) add their own kinds here — step 37's comment kinds are checked by meta-comment-owner.ts.
 */
import { metaChosenAdAccountOf, metaChosenInstagramOf, metaChosenPageOf, metaPageObjectNexusMade } from './account.js'
import type { MetaJudgedWrite, MetaWriteKind } from './meta-calls.js'
// Step 39's one read for an owner check, through the gateway (its read gate, ledger and rate bucket).
import type { MetaCheckRead } from './meta-brand-safety-owner.js'
// Step 37 — the comment kinds made as the Page (posts, comments, the chosen Instagram account's media and comments).
import { META_COMMENT_PAGE_KINDS, metaCommentOwnerProblem } from './meta-comment-owner.js'
// Step 24 — the post kinds made as the Page (the chosen Page's posts, the chosen Instagram account's media and events).
import { META_POST_KINDS, metaPostOwnerProblem } from './meta-post-owner.js'
// Step 38 — the messaging kinds made as the Page (its messages, labels, personas, templates and messaging setup).
import { META_MESSAGING_PAGE_KINDS } from './meta-messaging-rules.js'
import { metaMessagingOwnerProblem } from './meta-messaging-owner.js'

/** The kinds this check confirms (every rule marked `auth: 'page'` names one of them). */
export const META_PAGE_KINDS: ReadonlySet<MetaWriteKind> = new Set<MetaWriteKind>(['page', 'leadform', 'testlead', 'canvas', 'ownpagevideo', ...META_COMMENT_PAGE_KINDS, ...META_POST_KINDS, ...META_MESSAGING_PAGE_KINDS as ReadonlySet<MetaWriteKind>])

type Problem = { code: string; sentence: string } | null
const idOf = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null
const rowsOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : v && typeof v === 'object' && Array.isArray((v as { data?: unknown }).data) ? (v as { data: unknown[] }).data : [])
const fromOf = (body: Record<string, unknown> | null): string | null => (body?.from && typeof body.from === 'object' ? idOf((body.from as Record<string, unknown>).id) : null)
const ownerOf = (v: unknown): string | null => idOf(v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>).id : v)
const NOTHING = 'Nothing was sent to Meta: '

// ── parts this gateway saw made (step 27b) ────────────────────────────────────────────────────────────────────────

/** A run makes its parts, then the experience from them, within minutes: a part noted longer ago than this is not used. */
const PART_TTL_MS = 60 * 60_000
const MAX_PARTS = 5_000
const parts = new Map<string, number>()
const partKey = (connectionId: string, run: string, id: string) => `${connectionId}:${run}:${id}`

/**
 * After a part's create Meta accepted (`canvas.element.create`): remember its id for this connection AND this run of a
 * change (the kit's own run id), so the experience (or a footer, header or carousel) made from it in the same run may name
 * it. A create with no run id (not a Nexus change's run) is not remembered.
 */
export function noteCanvasElementMade(connectionId: string, run: string | undefined, answer: string, now = Date.now()): void {
  if (!run) return
  let id: string | null = null
  try { id = idOf((JSON.parse(answer) as Record<string, unknown> | null)?.id) } catch { id = null }
  if (!id || !/^\d{1,25}$/.test(id)) return
  for (const [key, at] of parts) if (now - at > PART_TTL_MS || parts.size >= MAX_PARTS) parts.delete(key)
  parts.set(partKey(connectionId, run, id), now)
}
const partMadeInRun = (connectionId: string, run: string | undefined, id: string, now = Date.now()) => {
  if (!run) return false
  const at = parts.get(partKey(connectionId, run, id))
  return at !== undefined && now - at <= PART_TTL_MS
}
export const __pageOwnerTest = { reset: () => parts.clear() }

// ── the checks ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Why this change made as the chosen Page is refused for this connection, or null (its object and body ids are the Page's). */
export async function metaPageOwnerProblem(connectionId: string, write: MetaJudgedWrite, kind: string | undefined, read: MetaCheckRead, run?: string, parent?: { kind: string; id: string }): Promise<Problem> {
  const id = write.objectId
  if (!kind || !META_PAGE_KINDS.has(kind as MetaWriteKind) || !write.kinds?.includes(kind as MetaWriteKind)) {
    return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: a change made as the Facebook Page names the kind of object it changes (the Page, a lead form of it, a test lead Nexus made, an Instant Experience of it, a video it posted, a post or comment of it, the chosen Instagram account's media or comments), and ${id} is not named so.` }
  }
  if (write.auth !== 'page') return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: ${id} is a Page object, and only a change made as the Page writes one.` }
  // Step 37 — a comment change: its own owner check (meta-comment-owner.ts), the ids inside its body included.
  if (META_COMMENT_PAGE_KINDS.has(kind as MetaWriteKind)) return metaCommentOwnerProblem(connectionId, write, kind, read, parent)
  // Step 24 — a post change: its own owner check (meta-post-owner.ts), the ids inside its body included.
  if (META_POST_KINDS.has(kind as MetaWriteKind)) return metaPostOwnerProblem(connectionId, write, kind, read, run, parent)
  // Step 38 — a messaging change: its own owner check (meta-messaging-owner.ts), the ids inside its body included.
  if (META_MESSAGING_PAGE_KINDS.has(kind)) return metaMessagingOwnerProblem(connectionId, write, kind, read, parent)
  const pageId = await metaChosenPageOf(connectionId)
  if (!pageId) return { code: 'META_PAGE_NOT_CHOSEN', sentence: 'Nothing was sent to Meta: this business has no Facebook Page chosen through this connection, so Nexus changes nothing made as a Page.' }
  const problem = kind === 'page' ? (id === pageId ? null : { code: 'META_PAGE_NOT_CHOSEN', sentence: `Nothing was sent to Meta: ${id} is not the Facebook Page this business chose through this connection.` })
    : kind === 'leadform' ? await formOfPage(id, pageId, read)
      : kind === 'canvas' ? await canvasOfPage(id, pageId, read)
        // Gap 46b (MD-024) — a Page video's thumbnail: a video the chosen Page posted.
        : kind === 'ownpagevideo' ? await videoOfPage(id, pageId, read)
          : await testLeadNexusMade(id, pageId)
  return problem ?? bodyIdsProblem(connectionId, write, pageId, read, run)
}

/** Step 38 — the same lead-form check for an instant form a message names (meta-messaging-owner.ts). */
export const metaLeadFormOfPageProblem = (formId: string, pageId: string, read: MetaCheckRead): Promise<Problem> => formOfPage(formId, pageId, read)

async function formOfPage(formId: string, pageId: string, read: MetaCheckRead): Promise<Problem> {
  if (await metaPageObjectNexusMade('leadform', formId, pageId)) return null
  const answer = await read(formId, { fields: 'id,page_id,questions{type}' })
  if (!answer.body) {
    const notForm = /nonexisting field/i.test(answer.words ?? '')
    return notForm
      ? { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: ${formId} is not a lead form (Meta: ${answer.words}).` }
      : { code: 'META_PAGE_UNCONFIRMED', sentence: `Nothing was sent to Meta: Nexus could not confirm that lead form ${formId} is of the Facebook Page this business chose${answer.words ? ` (Meta: ${answer.words})` : ''}.` }
  }
  if (idOf(answer.body.id) !== formId) return { code: 'META_PAGE_UNCONFIRMED', sentence: `Nothing was sent to Meta: Meta answered another object than lead form ${formId}.` }
  if (idOf(answer.body.page_id) !== pageId) return { code: 'META_PAGE_NOT_CHOSEN', sentence: `Nothing was sent to Meta: lead form ${formId} is not a form of the Facebook Page this business chose.` }
  if (!rowsOf(answer.body.questions).length) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: ${formId} is not a lead form Nexus can confirm (Meta names no questions on it).` }
  return null
}

/** Step 27b — an Instant Experience of the chosen Page: one Nexus made there, else one live read of its owner. */
async function canvasOfPage(canvasId: string, pageId: string, read: MetaCheckRead): Promise<Problem> {
  if (await metaPageObjectNexusMade('canvas', canvasId, pageId)) return null
  const answer = await read(canvasId, { fields: 'id,owner,is_published' })
  if (!answer.body) {
    return /nonexisting field/i.test(answer.words ?? '')
      ? { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: ${canvasId} is not an Instant Experience (Meta: ${answer.words}).` }
      : { code: 'META_PAGE_UNCONFIRMED', sentence: `Nothing was sent to Meta: Nexus could not confirm that Instant Experience ${canvasId} is of the Facebook Page this business chose${answer.words ? ` (Meta: ${answer.words})` : ''}.` }
  }
  if (idOf(answer.body.id) !== canvasId) return { code: 'META_PAGE_UNCONFIRMED', sentence: `Nothing was sent to Meta: Meta answered another object than Instant Experience ${canvasId}.` }
  if (ownerOf(answer.body.owner) !== pageId) return { code: 'META_PAGE_NOT_CHOSEN', sentence: `Nothing was sent to Meta: Instant Experience ${canvasId} is not one of the Facebook Page this business chose.` }
  if (typeof answer.body.is_published !== 'boolean') return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: ${canvasId} is not an Instant Experience Nexus can confirm.` }
  return null
}

/** Gap 46b (MD-024) — a video the chosen Page posted: one live read of the id Meta answers and who posted it. */
async function videoOfPage(videoId: string, pageId: string, read: MetaCheckRead): Promise<Problem> {
  if (!/^[1-9]\d{0,24}$/.test(videoId)) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: ${videoId} is not a Meta video id.` }
  const answer = await read(videoId, { fields: 'id,from{id}' })
  if (!answer.body) {
    return /nonexisting field/i.test(answer.words ?? '')
      ? { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: ${videoId} is not a video (Meta: ${answer.words}).` }
      : { code: 'META_PAGE_UNCONFIRMED', sentence: `Nothing was sent to Meta: Nexus could not confirm that video ${videoId} is one the Facebook Page this business chose posted${answer.words ? ` (Meta: ${answer.words})` : ''}.` }
  }
  if (idOf(answer.body.id) !== videoId) return { code: 'META_PAGE_UNCONFIRMED', sentence: `Nothing was sent to Meta: Meta answered another object than video ${videoId}.` }
  if (fromOf(answer.body) !== pageId) return { code: 'META_PAGE_NOT_CHOSEN', sentence: `Nothing was sent to Meta: video ${videoId} is not one the Facebook Page this business chose posted (Meta takes a custom thumbnail only for a video of a Page).` }
  return null
}

async function testLeadNexusMade(leadId: string, pageId: string): Promise<Problem> {
  if (await metaPageObjectNexusMade('testlead', leadId, pageId)) return null
  return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: ${leadId} is not a test lead Nexus made on a lead form of the Facebook Page this business chose. Nexus deletes only its own test leads, never a real lead (a person deletes another test lead in Meta's lead ads testing tool).` }
}

/** A Meta list's own ids (fields=id), page by page (Meta's `after` cursor, never its next link), up to `maxPages` of 100; null when a page could not be read. */
async function listedIds(read: MetaCheckRead, path: string, maxPages = 5): Promise<{ ids: Set<string>; more: boolean } | null> {
  const ids = new Set<string>()
  let after: string | null = null
  for (let page = 0; page < maxPages; page++) {
    const answer = await read(path, { fields: 'id', limit: '100', ...(after ? { after } : {}) })
    if (!answer.body || !Array.isArray(answer.body.data)) return null
    for (const row of answer.body.data as unknown[]) { const id = ownerOf(row); if (id) ids.add(id) }
    const paging = answer.body.paging && typeof answer.body.paging === 'object' ? answer.body.paging as { cursors?: { after?: unknown }; next?: unknown } : null
    after = typeof paging?.cursors?.after === 'string' && paging.next ? paging.cursors.after : null
    if (!after) return { ids, more: false }
  }
  return { ids, more: true }
}

/** At most this many ids inside one body are checked (an Instant Experience names at most 50 parts). */
const MAX_PAGE_BODY_IDS = 60

async function bodyIdsProblem(connectionId: string, write: MetaJudgedWrite, pageId: string, read: MetaCheckRead, run: string | undefined): Promise<Problem> {
  const ids = write.ids ?? []
  if (ids.length > MAX_PAGE_BODY_IDS) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: a change made as the Page names at most ${MAX_PAGE_BODY_IDS} ids inside its body.` }
  const inside = (code: string, what: string): Problem => ({ code, sentence: `${NOTHING}inside this change, ${what}` })
  // This call's memos: the Page's parts and the ad account's videos read once, one catalog-rule memo (dropped with the call).
  let pageParts: Promise<{ ids: Set<string>; more: boolean } | null> | undefined
  let libraryVideos: Promise<{ ids: Set<string>; more: boolean } | null> | undefined
  let catalogMemo: import('../marketing/meta-ads/catalog-rule.js').CatalogRuleMemo | undefined
  for (const inner of ids) {
    if (!/^\d{1,25}(_\d{1,25})?$/.test(inner.id)) return { code: 'META_WRITE_NOT_ALLOWED', sentence: 'Nothing was sent to Meta: this change names an id inside its body that Nexus does not check.' }
    switch (inner.kind) {
      case 'pagephoto': {
        const answer = await read(inner.id, { fields: 'id,from{id},width,height' })
        const from = fromOf(answer.body)
        const sized = (v: unknown) => typeof v === 'number' && v > 0
        if (!answer.body) {
          return /nonexisting field/i.test(answer.words ?? '')
            ? { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: inside this change, ${inner.id} is not a photo (Meta: ${answer.words}).` }
            : { code: 'META_PAGE_UNCONFIRMED', sentence: `Nothing was sent to Meta: Nexus could not confirm that photo ${inner.id} is the chosen Facebook Page's${answer.words ? ` (Meta: ${answer.words})` : ''}.` }
        }
        if (idOf(answer.body.id) !== inner.id || from !== pageId) return { code: 'META_PAGE_NOT_CHOSEN', sentence: `Nothing was sent to Meta: inside this change, ${inner.id} is not a photo of the Facebook Page this business chose.` }
        if (!sized(answer.body.width) || !sized(answer.body.height)) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: inside this change, ${inner.id} is not a photo Nexus can confirm.` }
        continue
      }
      case 'pagepost': {
        // `<page id>_<post id>`: a post of the chosen Page by its id alone (step 25's rule); a photo or video by who posted it.
        if (inner.id.includes('_')) {
          if (inner.id.startsWith(`${pageId}_`)) continue
          return inside('META_PAGE_NOT_CHOSEN', `post ${inner.id} is not a post of the Facebook Page this business chose.`)
        }
        const answer = await read(inner.id, { fields: 'id,from{id}' })
        if (answer.body && idOf(answer.body.id) === inner.id && fromOf(answer.body) === pageId) continue
        return answer.body
          ? inside('META_PAGE_NOT_CHOSEN', `${inner.id} is not a photo or video the Facebook Page this business chose posted.`)
          : inside('META_PAGE_UNCONFIRMED', `Nexus could not confirm that ${inner.id} is a photo or video of the chosen Facebook Page${answer.words ? ` (Meta: ${answer.words})` : ''}.`)
      }
      case 'instagrammedia': {
        const instagram = await metaChosenInstagramOf(connectionId)
        if (!instagram) return inside('META_ACCOUNT_NOT_CHOSEN', 'this business has no Instagram account chosen through this connection, so no Instagram media is named.')
        if (await instagramMediaOwned(read, inner.id, instagram)) continue
        return inside('META_ACCOUNT_NOT_CHOSEN', `Instagram media ${inner.id} is not one Nexus can confirm as the chosen Instagram account's.`)
      }
      case 'canvasvideo': {
        const answer = await read(inner.id, { fields: 'id,from{id}' })
        if (answer.body && idOf(answer.body.id) === inner.id && fromOf(answer.body) === pageId) continue
        const chosen = await metaChosenAdAccountOf(connectionId)
        libraryVideos ??= chosen ? listedIds(read, `act_${chosen}/advideos`) : Promise.resolve(null)
        const library = await libraryVideos
        if (library?.ids.has(inner.id)) continue
        return library === null
          ? inside('META_PAGE_UNCONFIRMED', `Nexus could not confirm that video ${inner.id} is the chosen Page's or in the chosen ad account's library.`)
          : inside('META_ACCOUNT_NOT_CHOSEN', `video ${inner.id} is not one the chosen Facebook Page posted, nor in the chosen ad account's library${library.more ? ' (Nexus looks at its first 500)' : ''}.`)
      }
      case 'canvaselement': {
        if (partMadeInRun(connectionId, run, inner.id)) continue
        pageParts ??= listedIds(read, `${pageId}/canvas_elements`)
        const listed = await pageParts
        if (listed?.ids.has(inner.id)) continue
        return listed === null
          ? inside('META_PAGE_UNCONFIRMED', `Nexus could not read the chosen Page's Instant Experience parts to confirm part ${inner.id} is one of them.`)
          : inside('META_PAGE_NOT_CHOSEN', `part ${inner.id} is not one made in this same change nor one of the chosen Page's Instant Experience parts${listed.more ? ' (Nexus looks at its first 500)' : ''}.`)
      }
      case 'canvas': {
        const problem = await canvasOfPage(inner.id, pageId, read)
        if (problem) return { code: problem.code, sentence: problem.sentence.replace(/^Nothing was sent to Meta: /, `${NOTHING}inside this change, `) }
        continue
      }
      case 'leadform': {
        const problem = await formOfPage(inner.id, pageId, read)
        if (problem) return { code: problem.code, sentence: problem.sentence.replace(/^Nothing was sent to Meta: /, `${NOTHING}inside this change, `) }
        continue
      }
      case 'productset':
      case 'productitem': {
        const chosen = await metaChosenAdAccountOf(connectionId)
        if (!chosen) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: 'Nothing was sent to Meta: this business has no Meta ad account chosen through this connection, so Nexus cannot check a catalog id.' }
        const { metaCatalogProblem, newCatalogRuleMemo } = await import('../marketing/meta-ads/catalog-rule.js')
        catalogMemo ??= newCatalogRuleMemo()
        const problem = await metaCatalogProblem({ connectionId, adAccountId: chosen }, inner.kind === 'productset' ? { productSetId: inner.id } : { productItemId: inner.id }, catalogMemo)
        if (problem) return inside('META_ACCOUNT_NOT_CHOSEN', problem)
        continue
      }
      default:
        return { code: 'META_WRITE_NOT_ALLOWED', sentence: 'Nothing was sent to Meta: this change names an id inside its body that Nexus does not check.' }
    }
  }
  return null
}

/** Is this Instagram media the chosen Instagram account's (Meta's owner, else its username against the account's own, read live)? */
async function instagramMediaOwned(read: MetaCheckRead, mediaId: string, instagramId: string): Promise<boolean> {
  const media = await read(mediaId, { fields: 'id,owner,username' })
  if (!media.body || idOf(media.body.id) !== mediaId) return false
  const owner = ownerOf(media.body.owner)
  if (owner) return owner === instagramId
  const username = typeof media.body.username === 'string' ? media.body.username.trim().toLowerCase() : ''
  if (!username) return false
  const account = await read(instagramId, { fields: 'id,username' })
  return typeof account.body?.username === 'string' && account.body.username.trim().toLowerCase() === username
}

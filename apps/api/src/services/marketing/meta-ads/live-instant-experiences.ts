/**
 * Meta step 27b (2026-10-21) — the live state an Instant Experience change stands on, read through the gateway (GET only,
 * the business's system-user token) with the earlier steps' own checks, never copied:
 *   - the chosen Facebook Page (and Instagram account) the experience is made on (step 10's pageOf);
 *   - one Instant Experience of the chosen Page (step 10's ownedByPage owner check, then its fields: name, published,
 *     hidden, colour, its parts in order — and, asked and dropped when Meta refuses them, the SDK-only hero assets,
 *     template and link);
 *   - every id a change names inside a part or the experience, confirmed the business's own BEFORE it is queued (the
 *     gateway checks each again before anything is sent, meta-page-owner.ts): a photo the chosen Page posted, a video of the
 *     Page or of the chosen ad account's library (step 10's ownVideo), a post of the Page (step 10's pagePostId) or a photo
 *     or video it posted, a media of the chosen Instagram account (step 10's ownMedia), a lead form of the Page that is
 *     ACTIVE (step 36's liveLeadFormState), a product set or catalog item (step 18's ONE catalog rule, one memo), a part of
 *     the Page (step 22's livePageCanvasElements, the first 500), another Instant Experience of the Page (ownedByPage).
 * Reading an Instant Experience with the system-user token is LIVE-PROBES CR-490 (step 10) / IX27b-08: when Meta answers
 * only to the Page's own token, the answer says so (step 10's onPage) and nothing is queued.
 */
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { metaChosenAccount, MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { onPage, ownedByPage, ownMedia, ownVideo, pageOf, pagePostId } from './live-media.js'
import { oneWithFallback } from './paging.js'
import { livePageCanvasElements } from './live-remove.js'
import { liveLeadFormState } from './live-lead-forms.js'
import { metaCatalogProblem, newCatalogRuleMemo } from './catalog-rule.js'

type Row = Record<string, unknown>
const idText = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const rowsOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : Array.isArray(obj(v)?.data) ? obj(v)!.data as unknown[] : [])

/** The chosen Page (and Instagram account, ad account) an Instant Experience change works on. */
export interface IxContext { connectionId: string; pageId: string; instagramId: string | null; adAccountId: string }

export async function liveIxContext(connectionId: string): Promise<IxContext> {
  const account = await metaChosenAccount(connectionId)
  return { connectionId: account.connectionId, pageId: pageOf(account), instagramId: account.instagramId, adAccountId: account.adAccountId }
}

/** One Instant Experience of the chosen Page as a change needs it (null: Meta did not answer that field). */
export interface IxCanvasState {
  pageId: string
  canvasId: string
  name: string | null
  published: boolean | null
  hidden: boolean | null
  backgroundColor: string | null
  /** Its parts in order, by id (each body element's own id); null when Meta did not answer them. */
  elementIds: string[] | null
  heroFacebookPostId: string | null
  heroInstagramMediaId: string | null
  templateId: string | null
  link: string | null
  /** The SDK-only fields Meta refused (step 10's fallback note), when any. */
  fieldsNote?: string
}

/** Read with step 10's fields (the guide's) plus the SDK-only ones a change needs to put back; refused ones are dropped. */
const CANVAS_CORE = 'id,name,is_published,is_hidden,background_color,body_elements'
const CANVAS_MORE = 'hero_asset_facebook_post_id,hero_asset_instagram_media_id,source_template{id},canvas_link'

export async function liveIxCanvas(connectionId: string, canvasId: string): Promise<IxCanvasState> {
  const account = await metaChosenAccount(connectionId)
  const pageId = pageOf(account)
  const id = await ownedByPage(account, canvasId, 'Instant Experience', 'ix.change.canvasOwnerCheck')
  const read = await onPage(() => oneWithFallback(account.connectionId, 'ix.change.canvas', id, CANVAS_CORE, CANVAS_MORE))
  const body = read.body ?? {}
  if (idText(body.id) !== id) throw new MetaLiveRefusal('Meta answered another object than the Instant Experience asked; nothing of it is used.')
  const parts = body.body_elements === undefined ? null : rowsOf(body.body_elements).map((r) => idText(obj(r)?.id)).filter((x): x is string => !!x)
  return {
    pageId,
    canvasId: id,
    name: typeof body.name === 'string' ? body.name : null,
    published: typeof body.is_published === 'boolean' ? body.is_published : null,
    hidden: typeof body.is_hidden === 'boolean' ? body.is_hidden : null,
    backgroundColor: typeof body.background_color === 'string' ? body.background_color : null,
    elementIds: parts,
    heroFacebookPostId: idText(body.hero_asset_facebook_post_id),
    heroInstagramMediaId: idText(body.hero_asset_instagram_media_id),
    templateId: idText(obj(body.source_template)?.id),
    link: typeof body.canvas_link === 'string' ? body.canvas_link : null,
    ...(read.note ? { fieldsNote: read.note } : {}),
  }
}

/** Every id a change names, by kind (change-instant-experiences.ts ixRefsOf collects them). */
export interface IxRefs {
  photos: string[]
  videos: string[]
  posts: string[]
  instagramMedia: string[]
  forms: string[]
  productSets: string[]
  productItems: string[]
  elements: string[]
  canvases: string[]
}

/** The words of a refused read, as a change's refusal. */
function wordsOf(err: unknown): string {
  if (err instanceof MetaLiveRefusal) return err.message
  if (err instanceof MetaReadError) return `Nexus could not confirm it (${err.failure.sentence.replace(/\.$/, '')}).`
  throw err
}

/** A photo the chosen Page posted (Meta's `from`, and a width and height: a photo's own pair). */
async function pagePhoto(account: MetaChosenAccount, pageId: string, photoId: string): Promise<string | null> {
  const read = await onPage(() => metaReadOne({ connectionId: account.connectionId }, { operation: 'ix.change.photoOwnerCheck', path: photoId, query: { fields: 'id,from{id},width,height' } }))
  const body = read.body as Row
  const sized = (v: unknown) => typeof v === 'number' && v > 0
  if (idText(body.id) !== photoId || idText(obj(body.from)?.id) !== pageId) return `Photo ${photoId} is not one the chosen Facebook Page posted (upload it to the Page first; an Instant Experience photo is a photo of the Page or a public https link).`
  return sized(body.width) && sized(body.height) ? null : `${photoId} is not a photo Nexus can confirm.`
}

/** A photo or video the chosen Page posted, by its own id (`from`). */
async function pageMedia(account: MetaChosenAccount, pageId: string, mediaId: string): Promise<string | null> {
  const read = await onPage(() => metaReadOne({ connectionId: account.connectionId }, { operation: 'ix.change.postOwnerCheck', path: mediaId, query: { fields: 'id,from{id}' } }))
  const body = read.body as Row
  return idText(body.id) === mediaId && idText(obj(body.from)?.id) === pageId ? null : `${mediaId} is not a post, photo or video of the Facebook Page this business chose.`
}

/**
 * Why one of these ids is not the business's own (the first one, in words), or null when every one is. Nothing is queued
 * on a refusal; the gateway checks each again before anything is sent.
 */
export async function liveIxRefsProblem(connectionId: string, refs: IxRefs): Promise<string | null> {
  const account = await metaChosenAccount(connectionId)
  const pageId = pageOf(account)
  /** One check: its sentence when it refuses, null when the id is the business's own (a helper that returns its id passed). */
  const check = async (work: () => Promise<string | null>): Promise<string | null> => {
    try {
      return await work()
    } catch (err) {
      return wordsOf(err)
    }
  }
  const passes = (work: () => Promise<unknown>) => async (): Promise<null> => { await work(); return null }
  for (const photoId of refs.photos) {
    const problem = await check(() => pagePhoto(account, pageId, photoId))
    if (problem) return problem
  }
  for (const videoId of refs.videos) {
    const problem = await check(passes(() => ownVideo(account, videoId)))
    if (problem) return problem
  }
  for (const postId of refs.posts) {
    const problem = await check(postId.includes('_') ? passes(async () => pagePostId(pageId, postId)) : () => pageMedia(account, pageId, postId))
    if (problem) return problem
  }
  for (const mediaId of refs.instagramMedia) {
    const problem = await check(passes(() => ownMedia(account, mediaId)))
    if (problem) return problem
  }
  for (const formId of refs.forms) {
    const problem = await check(async () => {
      const form = await liveLeadFormState(account.connectionId, formId)
      return form.status === 'ACTIVE' ? null : `Lead form ${formId} is ${form.status ?? 'not readable as active'}: an Instant Experience takes a published (ACTIVE) lead form of the chosen Page (set-meta-lead-form activates an archived one).`
    })
    if (problem) return problem
  }
  const memo = newCatalogRuleMemo()
  const target = { connectionId: account.connectionId, adAccountId: account.adAccountId }
  for (const productSetId of refs.productSets) {
    const problem = await check(() => metaCatalogProblem(target, { productSetId }, memo))
    if (problem) return `Product set ${productSetId}: ${problem}`
  }
  for (const productItemId of refs.productItems) {
    const problem = await check(() => metaCatalogProblem(target, { productItemId }, memo))
    if (problem) return `Catalog item ${productItemId}: ${problem}`
  }
  if (refs.elements.length) {
    const problem = await check(async () => {
      const parts = await livePageCanvasElements(target, pageId)
      const missing = refs.elements.find((id) => !parts.ids.has(id))
      return missing ? `Part ${missing} is not one of the chosen Page's Instant Experience parts${parts.more ? ' (Nexus looks at its first 500)' : ''} (meta-instant-experiences view elements lists them).` : null
    })
    if (problem) return problem
  }
  for (const canvasId of refs.canvases) {
    const problem = await check(passes(() => ownedByPage(account, canvasId, 'Instant Experience', 'ix.change.linkOwnerCheck')))
    if (problem) return problem
  }
  return null
}

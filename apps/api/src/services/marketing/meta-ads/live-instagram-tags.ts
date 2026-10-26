/**
 * Meta ads step 35 (2026-10-25) — what set-meta-instagram-product-tags reads LIVE before it drafts (GET only, through the
 * gateway, with the system user's token as step 13's tag reads): the post (a media of the CHOSEN Instagram account: step
 * 10's ownMedia), its type and, for a carousel, the slide and every slide's tags; the tags on it now; whether the account
 * may tag (an approved Instagram Shop); the catalogs it may tag from (each checked by step 12's read rule); a product (an
 * item of such a catalog: step 12's catalogChild) and its review state; a product's appeal state. Reuses step 13's field
 * lists and words (live-commerce.ts) — never another business's media, catalog or product.
 *
 * Checked 2026-10-25: product-tagging.md (eligibility, available_catalogs, catalog_product_search, product_tags GET / POST,
 * product_appeal, children; limits), ig-media/product_tags (POST: Stories, IGTV, Live, Mentions not supported; additive),
 * ig-user/product_appeal (POST appeal_reason + product_id → {success}, not the outcome; GET eligible_for_appeal,
 * review_status).
 */
import prisma from '../../../db.js'
import { metaObjectId } from '../../cx/connectors/meta/discovery.js'
import { metaReadOne } from './read-client.js'
import { MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { listPaged } from './paging.js'
import { catalogChild, readableCatalog } from './catalog-rule.js'
import { instagramOf, ownMedia } from './live-media.js'
import { IG_SHOP_NOTE, IG_TAG_READ_NOTE } from './live-commerce.js'
import { MetaReadError } from './errors.js'
import type { MetaIgTagTarget } from '../../gateway/meta-instagram-tags.js'

type Row = Record<string, unknown>
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null }
/** Meta sends product ids as JSON numbers on these edges (step 13's exactId): a safe integer or a string of digits only. */
const idOf = (v: unknown): string | null => (typeof v === 'number' ? (Number.isSafeInteger(v) && v > 0 ? String(v) : null) : metaObjectId(v))

/** A Meta refusal of an Instagram shopping read, with that edge's permissions (step 13's words). */
async function withShop<T>(work: () => Promise<T>, note: string): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof MetaReadError && err.failure.permissionDenied) throw new MetaLiveRefusal(`${err.message} ${note}`)
    throw err
  }
}

/** The tool whose records count the tagged posts of the last 24 hours. */
export const TAG_TOOL = 'set-meta-instagram-product-tags'
/** Step 24's publish of a new post (its records say when it carried product tags). */
export const POST_TOOL = 'create-meta-instagram-post'
/** content-publishing.md: "Carousels are limited to 20 images, videos, or a mix of the two". */
export const META_CAROUSEL_SLIDES_MAX = 20

export interface IgTagPost {
  /** The post (a carousel's album). */
  mediaId: string
  /** What the tags go on: the post itself, or one slide of a carousel. */
  targetId: string
  target: MetaIgTagTarget
  /** The tags on the target now (product id → place), or null when Meta's tag read does not cover it (a Reel). */
  tagsNow: Map<string, { x: number | null; y: number | null }> | null
  /** A carousel: the tags on its other slides (Meta: 20 on one carousel). */
  otherSlidesTagged: number
  slidesNotRead: string[]
}

const NOT_TAGGABLE: Readonly<Record<string, string>> = {
  STORY: 'A Story takes no product tags (Meta: Stories are not supported).',
  IGTV: 'An IGTV video takes no product tags through the API.',
  LIVE: 'A Live video takes no product tags.',
  AD: 'This is an ad\'s media: product tags of an ad go in its creative (create-meta-creative).',
}

async function tagsOn(account: MetaChosenAccount, targetId: string): Promise<Map<string, { x: number | null; y: number | null }>> {
  const read = await withShop(() => listPaged(account.connectionId, 'igTagsChange.tagsNow', `${targetId}/product_tags`, { fields: 'product_id,x,y' }, 50), IG_TAG_READ_NOTE)
  const out = new Map<string, { x: number | null; y: number | null }>()
  for (const r of read.rows) { const id = idOf(r.product_id); if (id) out.set(id, { x: num(r.x), y: num(r.y) }) }
  return out
}

/**
 * The post the tags go on — a media of the chosen Instagram account (ownMedia: Meta's owner, else its username) — its
 * type, and for a carousel the slide (one of the post's own children) and the tags of every other slide.
 */
export async function liveIgTagPost(account: MetaChosenAccount, mediaId: string, slideId?: string | null): Promise<IgTagPost> {
  const media = await ownMedia(account, mediaId)
  const body = (await metaReadOne({ connectionId: account.connectionId }, { operation: 'igTagsChange.media', path: media.mediaId, query: { fields: 'id,media_type,media_product_type' } })).body as Row
  const productType = (text(body.media_product_type) ?? media.productType ?? '').toUpperCase()
  const mediaType = (text(body.media_type) ?? '').toUpperCase()
  if (NOT_TAGGABLE[productType]) throw new MetaLiveRefusal(NOT_TAGGABLE[productType])
  if (productType === 'REELS') {
    if (slideId) throw new MetaLiveRefusal('A Reel has no slides: tag the Reel itself (no slideId).')
    return { mediaId: media.mediaId, targetId: media.mediaId, target: 'reel', tagsNow: null, otherSlidesTagged: 0, slidesNotRead: [] }
  }
  if (mediaType === 'CAROUSEL_ALBUM') {
    const slide = slideId ? metaObjectId(slideId) : null
    if (!slide) throw new MetaLiveRefusal('A carousel takes its tags slide by slide (Meta: 5 a slide, 20 for the carousel): name the slide (slideId, from meta-instagram-product-tags view tags with slides).')
    // Review B-F6 — Meta: "Carousels are limited to 20 images, videos, or a mix of the two": all 20 read, or nothing is asked.
    const children = await listPaged(account.connectionId, 'igTagsChange.slides', `${media.mediaId}/children`, { fields: 'id,media_type' }, META_CAROUSEL_SLIDES_MAX)
    if (children.more) throw new MetaLiveRefusal(`Meta lists more than ${META_CAROUSEL_SLIDES_MAX} slides for this carousel (its limit is ${META_CAROUSEL_SLIDES_MAX}), so Nexus cannot count its tags and tags nothing on it.`)
    const own = children.rows.find((r) => metaObjectId(r.id) === slide)
    if (!own) throw new MetaLiveRefusal(`${slide} is not a slide of this carousel (Meta's list of its children).`)
    const slideType = (text(own.media_type) ?? '').toUpperCase()
    let other = 0
    const notRead: string[] = []
    for (const child of children.rows) {
      const id = metaObjectId(child.id)
      if (!id || id === slide) continue
      try { other += (await tagsOn(account, id)).size } catch (err) {
        if (err instanceof MetaReadError || err instanceof MetaLiveRefusal) notRead.push(`slide ${id}: ${err.message}`)
        else throw err
      }
    }
    return { mediaId: media.mediaId, targetId: slide, target: slideType === 'VIDEO' ? 'carousel-video' : 'carousel-image', tagsNow: await tagsOn(account, slide), otherSlidesTagged: other, slidesNotRead: notRead }
  }
  if (slideId) throw new MetaLiveRefusal('This post is not a carousel: tag the post itself (no slideId).')
  if (mediaType !== 'IMAGE' && mediaType !== 'VIDEO') throw new MetaLiveRefusal(`Meta did not say this media is a photo or a video (media_type ${mediaType || 'not read'}), so Nexus tags nothing on it.`)
  return { mediaId: media.mediaId, targetId: media.mediaId, target: mediaType === 'VIDEO' ? 'video' : 'image', tagsNow: await tagsOn(account, media.mediaId), otherSlidesTagged: 0, slidesNotRead: [] }
}

/** May the chosen Instagram account tag products (an approved Instagram Shop)? true, false, or null when Meta did not say. */
export async function liveIgMayTag(account: MetaChosenAccount): Promise<boolean | null> {
  const ig = instagramOf(account)
  const read = await withShop(() => metaReadOne({ connectionId: account.connectionId }, { operation: 'igTagsChange.eligibility', path: ig, query: { fields: 'id,shopping_product_tag_eligibility' } }), IG_SHOP_NOTE)
  const v = (read.body as Row).shopping_product_tag_eligibility
  return typeof v === 'boolean' ? v : null
}

/** The catalogs the chosen Instagram account may tag from that this business may read (step 12's rule), by id. */
export async function liveIgTagCatalogs(account: MetaChosenAccount): Promise<Set<string>> {
  const ig = instagramOf(account)
  const read = await withShop(() => listPaged(account.connectionId, 'igTagsChange.catalogs', `${ig}/available_catalogs`, { fields: 'catalog_id' }, 25), IG_SHOP_NOTE)
  const out = new Set<string>()
  for (const r of read.rows) {
    const id = idOf(r.catalog_id)
    if (!id) continue
    try { await readableCatalog(account, id); out.add(id) } catch (err) { if (!(err instanceof MetaLiveRefusal)) throw err }
  }
  return out
}

export interface IgProduct { productId: string; catalogId: string; sku: string | null; name: string | null; reviewStatus: string | null }
/** A product of a catalog this business may read (step 12's catalogChild kind item), with its review state. */
export async function liveIgProduct(account: MetaChosenAccount, productId: string): Promise<IgProduct> {
  const { id, catalog } = await catalogChild(account, { kind: 'item', id: productId })
  const b = (await metaReadOne({ connectionId: account.connectionId }, { operation: 'igTagsChange.product', path: id, query: { fields: 'id,retailer_id,name,review_status' } })).body as Row
  return { productId: id, catalogId: catalog.catalogId, sku: text(b.retailer_id), name: text(b.name), reviewStatus: text(b.review_status) }
}

/** A product's appeal state (step 13's appeal read: eligible_for_appeal, review_status). */
export async function liveIgAppealState(account: MetaChosenAccount, productId: string): Promise<{ eligible: boolean | null; reviewStatus: string | null }> {
  const ig = instagramOf(account)
  const read = await withShop(() => listPaged(account.connectionId, 'igTagsChange.appeal', `${ig}/product_appeal`, { product_id: productId, fields: 'product_id,review_status,eligible_for_appeal' }, 5), IG_SHOP_NOTE)
  // Review A-N2 — only this product's own row is judged: another product's state never stands in for it.
  const row = read.rows.find((r) => idOf(r.product_id) === productId)
  if (!row) throw new MetaLiveRefusal(`Meta's appeal read names no state for product ${productId} (ig-user/product_appeal), so Nexus asks no appeal: Commerce Manager shows the product's review.`)
  return { eligible: typeof row.eligible_for_appeal === 'boolean' ? row.eligible_for_appeal : null, reviewStatus: text(row.review_status) }
}

/**
 * How many posts of THIS Instagram account Nexus added tags to in the last 24 hours (its own records; Meta allows 25 per
 * account — review A-N1: keyed by the Instagram account, newest first).
 */
export async function taggedPostsLastDay(instagramId: string, now = Date.now()): Promise<number> {
  // Re-review nit (c): posts Nexus published WITH product tags (create-meta-instagram-post) count too.
  const rows = await prisma.agentChange.findMany({ where: { toolName: { in: [TAG_TOOL, POST_TOOL] }, executedAt: { gte: new Date(now - 24 * 3_600_000) } }, select: { after: true }, orderBy: { executedAt: 'desc' }, take: 500 })
  const posts = new Set<string>()
  for (const row of rows) {
    const after = row.after && typeof row.after === 'object' ? row.after as Row : null
    if (after?.op === 'tag' && after.instagramId === instagramId && Array.isArray(after.added) && after.added.length && typeof after.mediaId === 'string') posts.add(after.mediaId)
    if (after?.platform === 'instagram' && after.productTagged === true && after.instagramId === instagramId && typeof after.mediaId === 'string') posts.add(after.mediaId)
  }
  return posts.size
}

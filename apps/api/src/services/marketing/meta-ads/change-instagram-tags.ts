/**
 * Meta ads step 35 (2026-10-25) — the drafts of set-meta-instagram-product-tags (pure: built from the request and the live
 * state the tool read):
 *   tag      CT-155: product tags added to, or moved on, a published post of the chosen Instagram account (a photo or video
 *            post, one slide of a carousel, a Reel) — POST /{media | slide}/product_tags updated_tags. Meta's tagging is
 *            additive: a product already tagged moves (its x / y), a new one is added. Meta cannot remove a tag through its
 *            API (CT-156), so the undo moves a moved tag back and says the added ones stay (the Instagram app removes them).
 *   appeal   CT-158: a product Meta rejected for tagging, appealed — POST /{ig-user}/product_appeal appeal_reason + product_id
 *            (Meta answers success only, never the outcome; an appeal cannot be withdrawn: no undo).
 * Tags reach buyers: they show on the public post at once, to everyone who sees it. No ad spend moves (a tag is no ad), so
 * nothing here is SPENDS MONEY; a post that also runs as an ad shows its new tags in that ad too (said).
 */
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { metaIgProductTagsParam, metaIgTagRoomProblem, META_IG_TAGGED_POSTS_PER_DAY, targetWords, type MetaIgProductTag, type MetaIgTagTarget } from '../../gateway/meta-instagram-tags.js'
import type { IgProduct, IgTagPost } from './live-instagram-tags.js'

type Line = [string, unknown, unknown]
/** Meta's permission codes on an Instagram shopping write, in plain words (ig-media/product_tags, ig-user/product_appeal "Requirements"). */
export const IG_SHOP_WRITE_EXPLAIN: Readonly<Record<string, string>> = Object.fromEntries(['10', '200'].map((code) => [code, 'For product tags Meta needs: the system user as an ADMIN of the business portfolio that owns the Instagram Shop, an approved Instagram Shop on the account, and the token\'s catalog_management, instagram_basic, instagram_shopping_tag_products and ads_management (Meta Business settings › System users).']))
const NO_CHECK = 'Meta has no check for this change (validate_only is documented on no Instagram shopping edge): the preview is built from the live state, read again before it is sent.'

export interface IgTagsRecord {
  op: 'tag'
  /** The Instagram account the post is of (Meta's 25 tagged posts a day are per account: review A-N1). */
  instagramId?: string | null
  mediaId: string
  targetId: string
  target: MetaIgTagTarget
  /** before: the places of the tags this change moves; after: the places it sent. */
  moved: Array<{ productId: string; x: number | null; y: number | null }>
  /** after: the products it added (Meta cannot take them off through the API). */
  added: string[]
  noUndo?: string[]
}

const place = (x: number | null | undefined, y: number | null | undefined) => (x === null || x === undefined ? 'on the post' : `x ${x}, y ${y}`)
/** A place as Nexus sends and records it: at most 4 decimals, 0..1 (Meta reads it back as a 32-bit float). */
export const four = (v: number | null) => (v === null ? null : Math.min(1, Math.max(0, Math.round(v * 10_000) / 10_000)))
/** Meta reads a place back as a 32-bit float (0.8 → 0.80000001192093): two places are the same within 0.0005. */
export const samePlace = (a: unknown, b: number | null | undefined) => typeof b === 'number' && Number.isFinite(Number(a)) && a !== null && Math.abs(Number(a) - b) < 0.0005

export function tagDraft(input: { post: IgTagPost; asked: MetaIgProductTag[]; products: ReadonlyMap<string, IgProduct>; taggedToday: number; instagramId?: string | null; why?: 'asked' | 'undo' }): MetaChangeDraft | { refusal: string } {
  const { post } = input
  const now = post.tagsNow
  const lines: Line[] = []
  const skipped: string[] = []
  const send: MetaIgProductTag[] = []
  const moved: IgTagsRecord['moved'] = []
  const movedBefore: IgTagsRecord['moved'] = []
  const added: string[] = []
  const placed = post.target === 'image' || post.target === 'carousel-image'
  for (const tag of input.asked) {
    const product = input.products.get(tag.productId)
    const label = `${product?.name ? `"${product.name}" ` : ''}(${tag.productId}${product?.sku ? `, SKU ${product.sku}` : ''})`
    const there = now?.get(tag.productId)
    if (there && (!placed || (samePlace(there.x, tag.x) && samePlace(there.y, tag.y)))) { skipped.push(`${label} is tagged there already${placed ? ' at that place' : ''}.`); continue }
    send.push(tag)
    if (there) {
      moved.push({ productId: tag.productId, x: tag.x ?? null, y: tag.y ?? null })
      // Meta reads places back as 32-bit floats: kept to Nexus's 4 decimals, so the undo sends a place the gateway takes.
      movedBefore.push({ productId: tag.productId, x: four(there.x), y: four(there.y) })
      lines.push([`Tag ${label}`, place(there.x, there.y), place(tag.x, tag.y)])
    } else {
      added.push(tag.productId)
      lines.push([`Tag ${label}`, now === null ? 'not known (Meta\'s tag read does not cover Reels)' : 'not tagged', place(tag.x, tag.y)])
    }
  }
  if (!send.length) return { summary: '', changes: {}, totals: {}, warnings: [], spendsMoney: [], skipped, requests: [], stands: null, before: null, after: null }
  const room = metaIgTagRoomProblem(post.target, send.map((t) => t.productId), now ? [...now.keys()] : null, post.otherSlidesTagged)
  if (room) return { refusal: `Not asked: ${room}` }
  const unapproved = send.filter((t) => input.products.get(t.productId)?.reviewStatus !== 'approved').map((t) => t.productId)
  const newPost = added.length > 0
  const what = post.targetId === post.mediaId ? `Instagram post ${post.mediaId}` : `slide ${post.targetId} of Instagram carousel ${post.mediaId}`
  const noUndo = added.length ? [`Meta cannot remove a product tag through its API ("tagging media is additive"): the ${plural(added.length, 'tag')} added here stay${added.length === 1 ? 's' : ''} until a person removes ${added.length === 1 ? 'it' : 'them'} in the Instagram app.`] : []
  const changes = changeLines(lines)
  const request: MetaChangeRequest = {
    step: 1, label: `${input.why === 'undo' ? 'Move back' : 'Tag'} ${plural(send.length, 'product')} on ${what}`, kind: 'ad', objectId: post.targetId, objectKind: 'igmedia',
    params: { updated_tags: metaIgProductTagsParam(send, post.target) }, check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: moved.length > 0,
    operation: 'igmedia.productTags', edge: 'product_tags', explain: IG_SHOP_WRITE_EXPLAIN,
    // Meta answers {success}: the tags are read back (a Reel's are not: Meta's tag read does not cover Reels).
    ...(post.target === 'reel' ? {} : {
      readBackOf: `${post.targetId}/product_tags`, readBackFields: 'product_id,x,y',
      judge: (node: Record<string, unknown>) => {
        const rows = Array.isArray(node.data) ? node.data as Array<Record<string, unknown>> : []
        const at = new Map(rows.map((r) => [String(r.product_id), r]))
        const missing = send.filter((t) => !at.has(t.productId) || (placed && (!samePlace(at.get(t.productId)!.x, t.x) || !samePlace(at.get(t.productId)!.y, t.y)))).map((t) => t.productId)
        return { moved: missing, reads: `${rows.length} tag${rows.length === 1 ? '' : 's'} on it${missing.length ? ` (not as sent: ${missing.join(', ')})` : ''}` }
      },
    }),
  }
  return {
    summary: input.why === 'undo' ? `Move ${plural(send.length, 'product tag')} back on ${what}` : `Tag ${plural(send.length, 'product')} on ${what}`,
    changes: changes.changes,
    totals: { tags: send.length, added: added.length, moved: moved.length, ...(changes.more ? { linesNotShown: changes.more } : {}) },
    warnings: [
      `The tags show on the public post at once, to everyone who sees it (${targetWords(post.target)}). If the post also runs as an ad, the ad shows them too.`,
      ...(unapproved.length ? [`Not approved for tagging yet (${unapproved.join(', ')}): Meta takes the tag but shows it only once the product is approved (meta-instagram-product-tags view search shows each one's review state).`] : []),
      ...(post.targetId !== post.mediaId ? ['A carousel slide is tagged through its own id (Meta\'s SDK also names child_index on the album, which Nexus never sends: a wrong index would tag another slide). Meta\'s answer decides (LIVE-PROBES CT35-07).'] : []),
      ...(post.target === 'reel' ? ['Meta\'s tag read does not cover Reels: Nexus cannot see the Reel\'s tags now nor read them back — a product already tagged keeps its tag, a new one is added (at most 30).'] : []),
      ...(post.slidesNotRead.length ? [`Nexus could not read the tags of every other slide (${post.slidesNotRead.join('; ')}): Meta refuses past 20 on one carousel.`] : []),
      ...(newPost ? [`Meta allows ${META_IG_TAGGED_POSTS_PER_DAY} tagged posts per account in 24 hours (a carousel counts once): Nexus tagged ${input.taggedToday} of this account in the last 24 hours${input.taggedToday >= META_IG_TAGGED_POSTS_PER_DAY ? ', so Meta may refuse this one' : ''} (tags made in the Instagram app count too; a Reel counts each time Nexus tags it, as Nexus cannot read a Reel's tags).`] : []),
      ...noUndo,
      NO_CHECK,
    ],
    spendsMoney: [],
    skipped,
    requests: [request],
    stands: { targetId: post.targetId, target: post.target, tags: now ? [...now.entries()].map(([id, p]) => `${id}:${p.x}:${p.y}`).sort() : null, other: post.otherSlidesTagged },
    before: { op: 'tag', instagramId: input.instagramId ?? null, mediaId: post.mediaId, targetId: post.targetId, target: post.target, moved: movedBefore, added: [] } satisfies IgTagsRecord,
    after: { op: 'tag', instagramId: input.instagramId ?? null, mediaId: post.mediaId, targetId: post.targetId, target: post.target, moved, added, ...(noUndo.length ? { noUndo } : {}) } satisfies IgTagsRecord,
  }
}

export function appealDraft(input: { instagramId: string; product: IgProduct; state: { eligible: boolean | null; reviewStatus: string | null }; reason: string }): MetaChangeDraft | { refusal: string } {
  const { product } = input
  const label = `product ${product.name ? `"${product.name}" ` : ''}(${product.productId}${product.sku ? `, SKU ${product.sku}` : ''})`
  if (input.state.eligible === false) return { refusal: `Meta says ${label} cannot be appealed now (eligible_for_appeal false; review status ${input.state.reviewStatus ?? 'not said'}). Commerce Manager shows why.` }
  if (input.state.reviewStatus && input.state.reviewStatus !== 'rejected') return { refusal: `${label} is not rejected for tagging (review status ${input.state.reviewStatus}): there is nothing to appeal.` }
  return {
    summary: `Appeal Meta's rejection of ${label} for Instagram tagging`,
    changes: changeLines([[`Appeal of ${label}`, input.state.reviewStatus ?? 'rejected', 'appealed']]).changes,
    totals: {},
    warnings: [
      'Meta answers an appeal with success only, never its outcome: meta-instagram-product-tags view appeal shows the state later.',
      'An appeal cannot be withdrawn (Meta documents no way): there is no undo.',
      ...(input.state.eligible === null ? ['Meta did not say whether this product may be appealed: its answer decides.'] : []),
      NO_CHECK,
    ],
    spendsMoney: [],
    skipped: [],
    requests: [{
      step: 1, label: `Appeal the rejection of ${label}`, kind: 'ad', objectId: input.instagramId, objectKind: 'iguser', params: { appeal_reason: input.reason, product_id: product.productId },
      check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false, operation: 'iguser.productAppeal', edge: 'product_appeal', answerOnly: true, explain: IG_SHOP_WRITE_EXPLAIN,
    }],
    stands: { productId: product.productId, catalogId: product.catalogId, reviewStatus: input.state.reviewStatus, eligible: input.state.eligible },
    before: { op: 'appeal', productId: product.productId, reviewStatus: input.state.reviewStatus },
    after: { op: 'appeal', productId: product.productId, appealed: true },
  }
}

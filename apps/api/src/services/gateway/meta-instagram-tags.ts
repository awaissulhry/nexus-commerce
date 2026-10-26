/**
 * Meta step 35 (Q9, 2026-10-25) — Instagram product tags: what a list of tags may be, in ONE leaf module (it imports
 * nothing), so the gateway's write rules (meta-instagram-tag-rules.ts: `updated_tags` on a published post), the tools
 * (set-meta-instagram-product-tags) and the publish of a new post (step 24's create-meta-instagram-post: `product_tags` on
 * POST /{ig-user-id}/media, added by lane C4 once step 24 is merged) judge tags the same way, in any load order.
 *
 * Checked 2026-10-25 (curl, ≥ 3 s apart):
 *   - instagram-platform/instagram-api-with-facebook-login/product-tagging.md: "up to 20 tags for photo and video feed posts
 *     and up to 20 tags total per carousel post (up to 5 per carousel slide)", Reels up to 30; "The tags and product IDs must
 *     be unique"; x / y floats 0.0–1.0 from the top-left, images only ("required" for images on an existing post); no tags on
 *     Stories or Live, none for Creator accounts; "Accounts are limited to 25 tagged media posts within a 24 hour period.
 *     Carousel albums count as a single post."; a tag on a product not yet approved is taken without an error but does not
 *     show until it is approved.
 *   - docs/instagram-platform/instagram-graph-api/reference/ig-media/product_tags: POST /{ig-media-id}/product_tags
 *     `updated_tags` (required) [{product_id (required), x, y}] — "Tagging media is additive until the tag limit has been
 *     reached (20 for feed posts, 30 for Reels). If the targeted media has already been tagged by a product in the request,
 *     the old tag's x and y values will be updated" → {success}. Stories, Instagram TV, Live and Mentions are not supported.
 *     No DELETE: a tag cannot be removed through the API (RECHECK CT-156 NOT-AVAILABLE; the Instagram app removes it).
 * Meta's own examples write product_id as a quoted string and x / y as numbers; Nexus writes exactly that, in one spelling
 * (JSON.stringify of the list): `[{"product_id":"<digits>","x":0.5,"y":0.8}]` — x and y only on an image, never on a video.
 */

/** Meta's tag limits per post (product-tagging.md). */
export const META_IG_TAG_LIMITS = { feedPost: 20, carouselSlide: 5, carouselPost: 20, reel: 30 } as const
/** Meta: 25 tagged posts per Instagram account per 24 hours (a carousel counts as one). */
export const META_IG_TAGGED_POSTS_PER_DAY = 25

/**
 * What a list of tags goes on, as the tool reads the media first: a feed image or video (20), an image or video slide of a
 * carousel (5 each, 20 for the whole carousel), a Reel (30). `image*` targets carry x and y; `video*` and `reel` never.
 */
export type MetaIgTagTarget = 'image' | 'video' | 'carousel-image' | 'carousel-video' | 'reel'
export const META_IG_TAG_TARGETS: readonly MetaIgTagTarget[] = ['image', 'video', 'carousel-image', 'carousel-video', 'reel']

/** One tag as the tools take it: a catalog product's Meta id, and its place on an image (0–1 from the top-left). */
export interface MetaIgProductTag { productId: string; x?: number; y?: number }

const DIGITS = /^\d{1,25}$/
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** The most tags one request may carry on this target (Meta's limit for the post it goes on). */
export function metaIgTagMax(target: MetaIgTagTarget): number {
  if (target === 'reel') return META_IG_TAG_LIMITS.reel
  if (target === 'carousel-image' || target === 'carousel-video') return META_IG_TAG_LIMITS.carouselSlide
  return META_IG_TAG_LIMITS.feedPost
}

const hasPlace = (target: MetaIgTagTarget) => target === 'image' || target === 'carousel-image'

/** A tag's x or y: a finite number 0.0–1.0 with at most 4 decimals (Nexus's own spelling). */
export function metaIgCoordinateOk(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 && Math.round(v * 10_000) / 10_000 === v
}

/**
 * The ONE spelling Nexus sends a tag list in (`updated_tags`, `product_tags`): JSON.stringify of
 * [{product_id, x, y}] in that key order — x and y only for an image target.
 */
export function metaIgProductTagsParam(tags: readonly MetaIgProductTag[], target: MetaIgTagTarget): string {
  return JSON.stringify(tags.map((t) => (hasPlace(target) ? { product_id: t.productId, x: t.x, y: t.y } : { product_id: t.productId })))
}

/**
 * Why a tag list (a form value, JSON) is refused for this target, or null: JSON in Nexus's one spelling; 1..the target's
 * limit tags; each exactly {product_id: "<digits>", x, y} on an image (both, each 0–1) or {product_id} on a video or Reel;
 * every product once. `what` names the form key in the sentence.
 */
export function metaIgProductTagsProblem(value: string, target: MetaIgTagTarget, what = 'updated_tags'): string | null {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return `${what} is a JSON list of tags` }
  if (JSON.stringify(parsed) !== value) return `${what} is JSON in one spelling only (as Nexus writes it: no spaces, each key once)`
  const max = metaIgTagMax(target)
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > max) return `${what} lists 1 to ${max} tags (Meta's limit for ${targetWords(target)})`
  const seen = new Set<string>()
  for (const tag of parsed) {
    const keys = plainObject(tag) ? Object.keys(tag).join(',') : ''
    const want = hasPlace(target) ? 'product_id,x,y' : 'product_id'
    if (keys !== want) {
      return hasPlace(target)
        ? `each tag on an image is exactly {"product_id": "<digits>", "x": 0–1, "y": 0–1} (Meta needs both places on an image)`
        : `each tag on ${targetWords(target)} is exactly {"product_id": "<digits>"} (x and y are for images only)`
    }
    const t = tag as Record<string, unknown>
    if (typeof t.product_id !== 'string' || !DIGITS.test(t.product_id)) return 'product_id is a catalog product\'s Meta id (a string of digits)'
    if (hasPlace(target) && (!metaIgCoordinateOk(t.x) || !metaIgCoordinateOk(t.y))) return 'x and y are numbers from 0 to 1 (at most 4 decimals), from the top-left of the image'
    if (seen.has(t.product_id)) return `${what} names each product once (Meta: tags and product ids are unique)`
    seen.add(t.product_id)
  }
  return null
}

/** The product ids inside a tag list Nexus wrote (for the gateway's catalog check of each); [] when it is not one. */
export function metaIgProductTagIds(value: string | undefined): string[] {
  if (value === undefined) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((t) => (plainObject(t) ? t.product_id : null)).filter((id): id is string => typeof id === 'string' && DIGITS.test(id)) : []
  } catch {
    return []
  }
}

/** The target as a person reads it. */
export function targetWords(target: MetaIgTagTarget): string {
  switch (target) {
    case 'image': return 'a photo feed post (20 tags)'
    case 'video': return 'a video feed post (20 tags)'
    case 'carousel-image': return 'a photo slide of a carousel (5 tags a slide, 20 for the carousel)'
    case 'carousel-video': return 'a video slide of a carousel (5 tags a slide, 20 for the carousel)'
    case 'reel': return 'a Reel (30 tags)'
  }
}

/**
 * What a post can take after this change, from what it has: on one target `existing` product ids (Meta's tag read) and the
 * asked ones (a product already tagged moves, a new one adds: Meta's tagging is additive); a carousel also counts every other
 * slide's tags against its 20. Null when it fits; else the sentence. `existing` null = Meta's read does not cover the
 * target (a Reel): only the request itself is counted, and the tool says so.
 */
export function metaIgTagRoomProblem(target: MetaIgTagTarget, asked: readonly string[], existing: readonly string[] | null, otherSlidesTagged = 0): string | null {
  const max = metaIgTagMax(target)
  const added = existing === null ? asked.length : asked.filter((id) => !existing.includes(id)).length
  const after = (existing?.length ?? 0) + added
  if (after > max) return `${targetWords(target)} would carry ${after} tags (${existing?.length ?? 0} now, ${added} new): Meta takes at most ${max}. Tags cannot be removed through the API (the Instagram app removes them).`
  if ((target === 'carousel-image' || target === 'carousel-video') && after + otherSlidesTagged > META_IG_TAG_LIMITS.carouselPost) {
    return `the carousel would carry ${after + otherSlidesTagged} tags across its slides: Meta takes at most ${META_IG_TAG_LIMITS.carouselPost} on one carousel.`
  }
  return null
}

/** An appeal's reason: what a person typed, 1..1000 characters, trimmed (Meta documents no limit; Nexus's own). */
export const META_IG_APPEAL_REASON_MAX = 1000

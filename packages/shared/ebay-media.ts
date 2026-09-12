import { z } from 'zod'

/** General eBay photo limits; category exceptions are reviewed before publication. */
export const EBAY_MEDIA_LISTING_LIMIT = 24
export const EBAY_MEDIA_VARIATION_LIMIT = 12
export function galleryLimit(gallery: { axis: string | null }) {
  return gallery.axis === null ? EBAY_MEDIA_LISTING_LIMIT : EBAY_MEDIA_VARIATION_LIMIT
}
export const ebayMediaDraftSchema = z.object({
  axis: z.string().min(1).max(200).nullable(),
  galleries: z.array(z.object({
    axis: z.string().min(1).max(200).nullable(),
    value: z.string().min(1).max(200).nullable(),
    assetIds: z.array(z.string().min(1).max(300)).max(200),
  })).max(1000),
})
export type EbayMediaDraft = z.infer<typeof ebayMediaDraftSchema>
export type EbayMediaGallery = EbayMediaDraft['galleries'][number]
export interface EbayMediaAsset {
  id: string
  url: string
  label: string
  width: number | null
  height: number | null
  origin: 'product' | 'saved-gallery'
}
export interface EbayMediaAxis { name: string; key: string; label: string; values: string[] }
export const ebayMediaDestinationSchema = z.object({
  accountId: z.string(), marketplace: z.string(), listingId: z.string().nullable(),
  aliasKey: z.string().nullable(), label: z.string(), inherited: z.boolean(),
  listings: z.array(z.object({ id: z.string(), aliasKey: z.string(), label: z.string(), externalListingId: z.string().nullable() })),
})
export interface EbayMediaWorkspace {
  productId: string
  revision: string
  draft: EbayMediaDraft
  assets: EbayMediaAsset[]
  axes: EbayMediaAxis[]
  axisLabels: Record<string, string>
  destination: z.infer<typeof ebayMediaDestinationSchema>
  warnings: string[]
  otherImageCount: number
  publication: { available: false; reason: string }
}

export const ebayMediaWorkspaceSchema = z.object({
  productId: z.string(), revision: z.string().regex(/^[a-f0-9]{64}$/), draft: ebayMediaDraftSchema,
  assets: z.array(z.object({ id: z.string(), url: z.string(), label: z.string(), width: z.number().nullable(), height: z.number().nullable(), origin: z.enum(['product', 'saved-gallery']) })),
  axes: z.array(z.object({ name: z.string(), key: z.string(), label: z.string(), values: z.array(z.string()) })),
  axisLabels: z.record(z.string(), z.string()), destination: ebayMediaDestinationSchema,
  warnings: z.array(z.string()), otherImageCount: z.number(),
  publication: z.object({ available: z.literal(false), reason: z.string() }),
})

export function galleryKey(gallery: Pick<EbayMediaGallery, 'axis' | 'value'>): string {
  return JSON.stringify([gallery.axis, gallery.value])
}

/** Stable comparison ignores empty, unassigned groups and gallery navigation order. */
export function draftFingerprint(draft: EbayMediaDraft): string {
  return JSON.stringify({ axis: draft.axis, galleries: draft.galleries.filter(g => g.assetIds.length)
    .map(g => ({ ...g, key: galleryKey(g) })).sort((a, b) => a.key.localeCompare(b.key)) })
}

export function galleryLabel(gallery: Pick<EbayMediaGallery, 'axis' | 'value'>, labels: Record<string, string> = {}): string {
  return gallery.axis === null ? 'Cover & common photos' : `${labels[gallery.axis] ?? gallery.axis}: ${gallery.value}`
}

export function isUsableMediaUrl(value: string): boolean {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password }
  catch { return false }
}

/** Checks describe only observable facts. Unknown dimensions are never treated as passing. */
export function inspectMediaDraft(draft: EbayMediaDraft, assets: readonly EbayMediaAsset[], labels: Record<string, string> = {}) {
  const byId = new Map(assets.map(a => [a.id, a]))
  const problems: string[] = []
  const review: string[] = []
  const keys = new Set<string>()
  for (const gallery of draft.galleries) {
    const label = galleryLabel(gallery, labels)
    const key = galleryKey(gallery)
    if (keys.has(key)) problems.push(`${label} appears more than once.`)
    keys.add(key)
    if ((gallery.axis === null) !== (gallery.value === null)) problems.push(`${label} has an incomplete grouping.`)
    if (gallery.assetIds.length > galleryLimit(gallery)) problems.push(`${label} exceeds the supported limit of ${galleryLimit(gallery)} images. Remove images explicitly; nothing will be trimmed automatically.`)
    const urls = new Set<string>()
    for (const id of gallery.assetIds) {
      const asset = byId.get(id)
      if (!asset) { problems.push(`${label} contains an image that is no longer available.`); continue }
      if (urls.has(asset.url)) problems.push(`${label} contains the same image more than once.`)
      urls.add(asset.url)
      if (!isUsableMediaUrl(asset.url)) problems.push(`${asset.label} does not have a usable image URL.`)
      if (asset.width === null || asset.height === null || asset.width <= 0 || asset.height <= 0)
        review.push(`${asset.label}: original dimensions are unknown.`)
      else if (Math.max(asset.width, asset.height) < 500)
        review.push(`${asset.label}: below eBay's 500-pixel minimum on the longest side.`)
    }
  }
  if (!draft.galleries.some(g => g.axis === null && g.assetIds.length)) review.push('Cover & common photos has no cover image.')
  return { problems: [...new Set(problems)], review: [...new Set(review)] }
}

/** Reuse between galleries is intentional. A duplicate within a gallery is refused. */
export function appendGalleryAssets(gallery: EbayMediaGallery, ids: readonly string[], assets: readonly EbayMediaAsset[]): EbayMediaGallery {
  const byId = new Map(assets.map(a => [a.id, a]))
  const urls = new Set(gallery.assetIds.map(id => byId.get(id)?.url))
  const next = [...gallery.assetIds]
  for (const id of ids) {
    const asset = byId.get(id)
    if (!asset) throw new Error('An image is no longer available. Refresh the source library.')
    if (urls.has(asset.url)) continue
    urls.add(asset.url); next.push(id)
  }
  if (next.length > galleryLimit(gallery)) throw new Error(`This would create ${next.length} images. This gallery supports ${galleryLimit(gallery)}; choose fewer images.`)
  return { ...gallery, assetIds: next }
}

/** eBay initially focuses the first common photo; a selection focuses its first associated photo.
 * Missing variation photos leave the common photo visible with an explicit missing-photo state. */
export function resolveGalleryFocus(draft: EbayMediaDraft, value: string | null) {
  const common = draft.galleries.find(g => g.axis === null && g.value === null)
  const variation = draft.axis !== null && value !== null ? draft.galleries.find(g => g.axis === draft.axis && g.value === value) : undefined
  if (variation?.assetIds.length) return { assetId: variation.assetIds[0], kind: 'variation' as const }
  return { assetId: common?.assetIds[0] ?? null, kind: draft.axis !== null && value !== null ? 'missing-variation' as const : 'common' as const }
}

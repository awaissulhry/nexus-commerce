import { z } from 'zod'

export const PRODUCT_MEDIA_KEY = '_productMedia'
export const mediaLocaleSchema = z.string().min(2).max(64).refine(value => {
  try { return Intl.getCanonicalLocales(value).length === 1 } catch { return false }
}, 'Choose a valid language tag.').transform(value => Intl.getCanonicalLocales(value)[0])
const httpsUrl = z.url().max(4096).refine(value => new URL(value).protocol === 'https:', 'Use a public HTTPS file URL.')
export const mediaCaptionSchema = z.object({ url: httpsUrl, language: mediaLocaleSchema, label: z.string().trim().min(1).max(160) }).strict()
export const productMediaItemSchema = z.object({
  assetId: z.string().min(1).max(256), alt: z.string().max(2000).optional(),
  captions: z.array(mediaCaptionSchema).max(30).optional(), transcript: z.string().max(50000).optional(),
}).strict()
export const productMediaCollectionSchema = z.object({ version: z.literal(1), items: z.array(productMediaItemSchema).max(250) }).strict()
  .refine(value => new Set(value.items.map(item => item.assetId)).size === value.items.length, 'A file can appear only once in a gallery.')
export const productMediaSaveSchema = z.object({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), collection: productMediaCollectionSchema.nullable() }).strict()
export const productMediaQuerySchema = z.object({
  scope: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/), market: z.string().min(1).max(64), locale: mediaLocaleSchema,
  accountId: z.string().min(1).max(256).optional(), listingId: z.string().min(1).max(256).optional(),
  aliasKey: z.string().max(256).optional(),
}).strict().refine(q => q.scope === 'MASTER' ? q.market === 'GLOBAL' && !q.accountId && !q.listingId && q.aliasKey === undefined : !!q.accountId && (!!q.listingId || q.aliasKey !== undefined),
  'Channel media requires an explicit store and listing or alias; shared media must not include a channel destination.')

export type ProductMediaItem = z.infer<typeof productMediaItemSchema>
export type ProductMediaCollection = z.infer<typeof productMediaCollectionSchema>
export type ProductMediaQuery = z.infer<typeof productMediaQuerySchema>
export const productMediaCopySchema = z.object({
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.object({ productId: z.string().min(1).max(256), context: productMediaQuerySchema, expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
}).strict()
export interface ProductMediaAsset {
  id: string; type: string; url: string; preview: string | null; alt: string; mimeType?: string | null
  width?: number | null; height?: number | null; durationSec?: number | null; fileSize?: number | null
}
export interface ProductMediaWorkspace {
  revision: string; productId: string; title: string; context: ProductMediaQuery
  assets: ProductMediaAsset[]; collection: ProductMediaCollection; hasOverride: boolean
  source: 'locale' | 'all-languages' | 'shared' | 'parent' | 'library'
  missingAssetIds: string[]
}

export function mediaObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Invalid saved collections are surfaced to the caller, never replaced by an empty gallery. */
export function readMediaCollection(content: unknown, locale: string): ProductMediaCollection | undefined {
  const value = mediaObject(mediaObject(content)[locale])[PRODUCT_MEDIA_KEY]
  return value === undefined ? undefined : productMediaCollectionSchema.parse(value)
}

export function writeMediaCollection(content: unknown, locale: string, collection: ProductMediaCollection | null) {
  const root = mediaObject(content), language = { ...mediaObject(root[locale]) }
  if (collection === null) delete language[PRODUCT_MEDIA_KEY]
  else language[PRODUCT_MEDIA_KEY] = collection
  return { ...root, [locale]: language }
}

/** Exact language, neutral language, then shared product; an explicit empty gallery is an override. */
export function resolveMediaCollection(input: { locale: string; own: unknown; shared?: unknown; parent?: unknown; ownIds: string[]; parentIds: string[] }) {
  const exact = readMediaCollection(input.own, input.locale)
  if (exact) return { collection: exact, source: 'locale' as const, hasOverride: true }
  const neutral = input.locale === 'und' ? undefined : readMediaCollection(input.own, 'und')
  if (neutral) return { collection: neutral, source: 'all-languages' as const, hasOverride: false }
  if (input.shared !== undefined) {
    const shared = readMediaCollection(input.shared, input.locale) ?? readMediaCollection(input.shared, 'und')
    if (shared) return { collection: shared, source: 'shared' as const, hasOverride: false }
  }
  if (!input.ownIds.length && input.parent !== undefined) {
    const parent = readMediaCollection(input.parent, input.locale) ?? readMediaCollection(input.parent, 'und')
    if (parent) return { collection: parent, source: 'parent' as const, hasOverride: false }
  }
  return { collection: { version: 1 as const, items: (input.ownIds.length ? input.ownIds : input.parentIds).map(assetId => ({ assetId })) },
    source: input.shared !== undefined ? 'shared' as const : input.ownIds.length || !input.parentIds.length ? 'library' as const : 'parent' as const, hasOverride: false }
}

import type { Prisma } from '@prisma/client'
import { readMediaCollection, resolveMediaCollection } from '@nexus/shared/product-media'
import { emptyShopifyContent, type ShopifyContent } from '@nexus/shared/shopify-content'
import type { ShopifySheetGallery, ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import type { MediaOrderEdit } from '@nexus/shared/shopify-information'
import { WorkspaceScopeError, type WorkspaceDestination } from '../pim/workspace-destination.js'
import { object, digest } from './content-workspace.service.js'
import { assertShopifyResult, type ShopifyGraphql } from './admin-client.js'
import { readInformationMedia, advanceMediaOrder } from './information-gateway.js'
import { mediaRemovalVariants } from './information-media-membership.js'
import { publishContentImages, publishTranslations } from './content-publisher.js'

export const SHEET_MEDIA_SYNC = '_nexusSheetMediaSync'
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const gid = (kind: string, value: unknown): string | undefined => typeof value === 'string' && new RegExp(`^(gid://shopify/${kind}/)?\\d+$`).test(value) ? value.startsWith('gid:') ? value : `gid://shopify/${kind}/${value}` : undefined

/** Batched Nexus reads, shared media resolution and exact persisted listing identities. */
export async function readSheetGallerySources(tx: Prisma.TransactionClient, destination: WorkspaceDestination, schema: ShopifyStoreSchema) {
  const products = await tx.product.findMany({ where: { OR: [{ id: destination.familyId }, { parentId: destination.familyId }], deletedAt: null }, select: { id: true, parentId: true, name: true, localizedContent: true } })
  const [listings, files] = await Promise.all([
    tx.channelListing.findMany({ where: { productId: { in: products.map(p => p.id) }, channel: 'SHOPIFY', marketplace: destination.marketplace, channelConnectionId: destination.accountId, aliasKey: destination.aliasKey ?? '' } }),
    tx.productImage.findMany({ where: { productId: { in: products.map(p => p.id) } }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
  ])
  const locale = schema.locales.find(l => l.primary)?.locale
  if (!locale) throw new WorkspaceScopeError('The Shopify primary language could not be read. Refresh store capabilities.', 422)
  const root = products.find(p => p.id === destination.familyId), rootListing = listings.find(l => l.productId === destination.familyId)
  const published = object(object(rootListing?.platformAttributes)._nexusContentPublish)
  const galleries: ShopifySheetGallery[] = [], signatures: unknown[] = [], warnings: string[] = []
  const owners = new Set<string>()
  for (const listing of listings.sort((a, b) => Number(b.productId === destination.familyId) - Number(a.productId === destination.familyId) || a.id.localeCompare(b.id))) {
    const pa = object(listing.platformAttributes), localized = object(pa._productMediaLocales), previous = object(pa[SHEET_MEDIA_SYNC])
    if (!Object.keys(localized).some(l => readMediaCollection(localized, l)) && !previous.signature) continue
    const product = products.find(p => p.id === listing.productId)!
    const ownFiles = files.filter(f => f.productId === product.id), parentFiles = product.parentId ? files.filter(f => f.productId === product.parentId) : []
    const base = resolveMediaCollection({ locale, own: localized, shared: product.localizedContent, parent: product.parentId ? root?.localizedContent : undefined, ownIds: ownFiles.map(f => f.id), parentIds: parentFiles.map(f => f.id) }).collection
    for (const language of Object.keys(localized).filter(l => l !== 'und' && l !== locale)) {
      const translated = readMediaCollection(localized, language)
      if (!translated) continue
      if (!schema.locales.some(l => l.locale === language)) throw new WorkspaceScopeError(`${language} is not enabled in this Shopify store. Its gallery draft is retained.`, 422)
      if (!same(translated.items.map(i => i.assetId), base.items.map(i => i.assetId))) throw new WorkspaceScopeError(`${product.name}: Shopify shares gallery membership and order across languages. Match the ${locale} gallery before synchronizing ${language}.`, 422)
    }
    const assets: ShopifyContent['assets'] = base.items.map(item => {
      const file = [...ownFiles, ...parentFiles].find(f => f.id === item.assetId)
      if (!file) throw new WorkspaceScopeError(`${product.name}: a selected gallery file is no longer in this product’s library.`, 422)
      const type = file.mediaType ?? 'IMAGE'
      if (!['IMAGE', 'VIDEO', 'MODEL_3D'].includes(type)) throw new WorkspaceScopeError(`${product.name}: Shopify galleries accept images, videos and 3D models; ${type} remains in Nexus.`, 422)
      if (!file.url.startsWith('https://')) throw new WorkspaceScopeError(`${product.name}: Shopify requires a public HTTPS media source.`, 422)
      const translations: Record<string, string> = {}
      for (const language of Object.keys(localized).filter(l => l !== 'und' && l !== locale)) {
        const translated = readMediaCollection(localized, language)
        if (!translated) continue
        const alt = translated.items.find(i => i.assetId === item.assetId)?.alt
        if (alt !== undefined) translations[language] = alt
      }
      if (type !== 'IMAGE' && Object.keys(translations).length) throw new WorkspaceScopeError(`${product.name}: Shopify translates image alt text; video and model alt text is shared across languages. Keep localized descriptions in Nexus.`, 422)
      return { id: file.id, url: file.url, type: type as 'IMAGE' | 'VIDEO' | 'MODEL_3D', alt: item.alt ?? file.alt ?? '', translations }
    })
    const productId = gid('Product', listing.externalListingId) ?? gid('Product', pa.shopifyProductId) ?? gid('Product', rootListing?.externalListingId) ?? gid('Product', published.productId)
    const variantId = gid('ProductVariant', pa.variantId) ?? gid('ProductVariant', object(published.variantIds)[product.id])
    if (!productId) continue // An unlinked draft uses the existing reviewed content publication.
    // A child with its own Shopify product owns that gallery. A child sharing the parent's
    // Shopify product owns the native variant image, never the other variants' gallery.
    const ownerVariant = product.parentId && productId === (gid('Product', rootListing?.externalListingId) ?? gid('Product', published.productId)) ? variantId : undefined
    if (product.parentId && !ownerVariant && !gid('Product', listing.externalListingId) && !gid('Product', pa.shopifyProductId)) throw new WorkspaceScopeError(`${product.name}: no persisted Shopify variant identity is available. Link the variant before synchronizing its media.`, 422)
    if (ownerVariant && (assets.length > 1 || assets.some(a => a.type !== 'IMAGE'))) throw new WorkspaceScopeError(`${product.name}: Shopify assigns one image to a native variant. Select one image here, or edit the owning product row for a full gallery. The Nexus collection is retained.`, 422)
    const owner = ownerVariant ?? productId
    if (owners.has(owner)) throw new WorkspaceScopeError('Two Nexus rows target the same Shopify gallery. Resolve their listing identities before synchronization.', 422)
    owners.add(owner)
    const signature = digest([destination.accountId, listing.id, productId, ownerVariant, locale, assets, localized])
    signatures.push([listing.id, signature])
    if (signature === previous.signature) continue
    if (Object.values(localized).some(value => { const items = object(object(value)._productMedia).items; return Array.isArray(items) && items.some((i: any) => i.captions?.length || i.transcript !== undefined) })) warnings.push(`${product.name}: captions and transcripts remain in Nexus. Shopify's native file mutations do not accept these fields; the theme content publication handles them separately.`)
    galleries.push({ listingId: listing.id, nexusProductId: product.id, productId, ...(ownerVariant ? { variantId: ownerVariant } : {}), ownerLabel: product.name, locale, assets, signature, value: [] })
  }
  return { galleries, warnings, revision: digest(signatures.sort((a: any, b: any) => a[0].localeCompare(b[0]))) }
}

async function variantMedia(gql: ShopifyGraphql, gallery: ShopifySheetGallery) {
  const { productVariant: variant } = await gql(`query NexusSheetVariantMedia($id:ID!) { productVariant(id:$id) { id product { id } media(first:250) { nodes { id } pageInfo { hasNextPage } } } }`, { id: gallery.variantId })
  if (variant?.id !== gallery.variantId || variant.product.id !== gallery.productId || variant.media.pageInfo.hasNextPage) throw new WorkspaceScopeError('The reviewed variant identity or its media is unavailable.', 409)
  return variant.media.nodes.map((m: any) => m.id) as string[]
}
export async function reviewSheetGalleries(gql: ShopifyGraphql, galleries: ShopifySheetGallery[], schema: ShopifyStoreSchema) {
  if (galleries.length && schema.native && (!schema.native.scopes.includes('write_products') || !schema.native.scopes.includes('write_files'))) throw new WorkspaceScopeError('Gallery synchronization requires this store’s write_products and write_files permissions. Nexus drafts are retained.', 422)
  const result: ShopifySheetGallery[] = []
  for (const gallery of galleries) {
    if (gallery.assets.some(a => Object.keys(a.translations).length) && schema.native && !schema.native.scopes.includes('write_translations')) throw new WorkspaceScopeError('Image alt translations require write_translations in this store.', 422)
    const value = (await readInformationMedia(gql, gallery.productId)).map(m => m.id)
    const edit = { productId: gallery.productId, ownerLabel: gallery.ownerLabel, value, nextValue: [] }
    result.push({ ...gallery, value, ...(gallery.variantId ? { variantValue: await variantMedia(gql, gallery) } : { affectedVariants: await mediaRemovalVariants(gql, edit) }) })
  }
  return result
}
export interface SheetGalleryProgress { mediaIds?: Record<string, string>; edit?: MediaOrderEdit; order?: { submitted: boolean; jobId?: string }; variantStarted?: boolean }
/** Uploads and product associations are checkpointed within the existing durable linked job. */
export async function advanceSheetGallery(gql: ShopifyGraphql, gallery: ShopifySheetGallery, initial: SheetGalleryProgress | undefined, checkpoint: (state: SheetGalleryProgress) => Promise<void>) {
  let state: SheetGalleryProgress = { ...initial }
  const save = async (patch: Partial<SheetGalleryProgress>) => { state = { ...state, ...patch }; await checkpoint(state) }
  if (!state.edit) {
    const current = (await readInformationMedia(gql, gallery.productId)).map(m => m.id)
    if (!same(current, gallery.value)) throw new WorkspaceScopeError(`${gallery.ownerLabel}: Shopify gallery changed after review. No associations were changed.`, 409)
    const content = { ...emptyShopifyContent([]), assets: gallery.assets }
    const mediaIds = await publishContentImages(gql, content, async patch => save({ mediaIds: patch.mediaIds as Record<string, string> }), gallery.listingId)
    const ids = gallery.assets.map(a => mediaIds[a.id])
    if (new Set(ids).size !== ids.length) throw new WorkspaceScopeError('Two selected library files resolve to one Shopify file. Keep one copy in the gallery.', 422)
    const nextValue = gallery.variantId ? [...gallery.value, ...ids.filter(id => !gallery.value.includes(id))] : ids
    const added = gallery.assets.filter(a => !gallery.value.includes(mediaIds[a.id])).map(a => ({ id: mediaIds[a.id], alt: a.alt, type: a.type ?? 'IMAGE', status: 'READY', url: a.url, preview: a.url }))
    await save({ mediaIds, edit: { productId: gallery.productId, ownerLabel: gallery.ownerLabel, value: gallery.value, nextValue, membershipChanged: true, added, affectedVariants: gallery.affectedVariants ?? [] } })
  }
  const done = await advanceMediaOrder(gql, state.edit!, state.order, order => save({ order }))
  if (!done) return false
  if (gallery.variantId) {
    const next = gallery.assets.map(a => state.mediaIds![a.id]), current = await variantMedia(gql, gallery)
    const removed = (gallery.variantValue ?? []).filter(id => !next.includes(id))
    if (current.some(id => !(gallery.variantValue ?? []).includes(id) && !next.includes(id)) || !state.variantStarted && !same(current, gallery.variantValue)) throw new WorkspaceScopeError('This variant image changed after review. Your intended image is retained.', 409)
    await save({ variantStarted: true })
    if (removed.some(id => current.includes(id))) assertShopifyResult((await gql(`mutation NexusSheetVariantDetach($id:ID!,$media:[ProductVariantDetachMediaInput!]!) { productVariantDetachMedia(productId:$id,variantMedia:$media) { userErrors { field message } } }`, { id: gallery.productId, media: [{ variantId: gallery.variantId, mediaIds: removed.filter(id => current.includes(id)) }] })).productVariantDetachMedia, 'Detach variant image')
    if (next.some(id => !current.includes(id))) assertShopifyResult((await gql(`mutation NexusSheetVariantAppend($id:ID!,$media:[ProductVariantAppendMediaInput!]!) { productVariantAppendMedia(productId:$id,variantMedia:$media) { userErrors { field message } } }`, { id: gallery.productId, media: [{ variantId: gallery.variantId, mediaIds: next }] })).productVariantAppendMedia, 'Assign variant image')
    if (!same(await variantMedia(gql, gallery), next)) throw new WorkspaceScopeError('Shopify has not confirmed the reviewed variant image.', 502)
  }
  for (const asset of gallery.assets.filter(a => Object.keys(a.translations).length)) {
    // New/reused files are keyed by the reviewed metadata. Only explicitly saved locales
    // participate; absent locales must never remove another destination's translations.
    await publishTranslations(gql, state.mediaIds![asset.id], { alt: { value: asset.alt, translations: asset.translations } }, { ...emptyShopifyContent([]), defaultLocale: gallery.locale, locales: [gallery.locale, ...Object.keys(asset.translations)] })
  }
  return true
}
export async function verifySheetGallery(gql: ShopifyGraphql, gallery: ShopifySheetGallery, state: SheetGalleryProgress) {
  const media = await readInformationMedia(gql, gallery.productId)
  if (!state.edit || !same(media.map(m => m.id), state.edit.nextValue) || gallery.assets.some(a => media.find(m => m.id === state.mediaIds?.[a.id])?.alt !== a.alt)) throw new WorkspaceScopeError('Gallery or alt text changed before final verification. Resume after review.', 409)
  if (gallery.variantId && !same(await variantMedia(gql, gallery), gallery.assets.map(a => state.mediaIds![a.id]))) throw new WorkspaceScopeError('Variant image changed before final verification.', 409)
  for (const asset of gallery.assets) for (const [locale, value] of Object.entries(asset.translations)) {
    const result = await gql(`query NexusSheetAltReadback($id:ID!,$locale:String!) { translatableResource(resourceId:$id) { translations(locale:$locale) { key value outdated } } }`, { id: state.mediaIds![asset.id], locale })
    const translated = result.translatableResource?.translations.find((t: any) => t.key === 'alt')
    if (translated?.value !== value || translated.outdated) throw new WorkspaceScopeError(`Image alt text (${locale}) changed before final verification.`, 409)
  }
}

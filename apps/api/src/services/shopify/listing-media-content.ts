import { readMediaCollection, mediaObject } from '@nexus/shared/product-media'
import type { ShopifyContent } from '@nexus/shared/shopify-content'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'

type File = { id: string; productId: string; url: string; mediaType: string | null; alt: string | null }
/** Overlay the explicitly saved sheet gallery on the reviewed publication document.
 * Shopify has one native gallery. Different language galleries remain Nexus drafts;
 * only matching gallery membership can supply localized alt text. */
export function applyListingMediaContent(content: ShopifyContent, familyId: string, listings: { productId: string; platformAttributes: unknown }[], files: File[]): ShopifyContent {
  const result = structuredClone(content)
  for (const listing of listings) {
    const localized = mediaObject(mediaObject(listing.platformAttributes)._productMediaLocales)
    const base = readMediaCollection(localized, content.defaultLocale) ?? readMediaCollection(localized, 'und')
    if (!base) {
      if (Object.keys(localized).some(locale => readMediaCollection(localized, locale))) throw new WorkspaceScopeError('Save the Shopify gallery in the store’s primary language or All languages before publishing localized media.', 422)
      continue
    }
    const selected = base.items.map(item => {
      const file = files.find(file => file.id === item.assetId && (file.productId === listing.productId || file.productId === familyId))
      if (!file) throw new WorkspaceScopeError('A saved Shopify gallery file is no longer in this product’s library.', 422)
      if (!['IMAGE', 'VIDEO', 'MODEL_3D'].includes(file.mediaType ?? 'IMAGE')) throw new WorkspaceScopeError(`Shopify product galleries cannot attach the ${file.mediaType} file type. The Nexus file is preserved.`, 422)
      if (!file.url.startsWith('https://')) throw new WorkspaceScopeError('Shopify media import requires a public HTTPS source.', 422)
      const translations: Record<string, string> = {}
      const accessibility: NonNullable<ShopifyContent['assets'][number]['accessibility']> = {}
      if (item.captions || item.transcript !== undefined) accessibility[content.defaultLocale] = { captions: item.captions, transcript: item.transcript }
      for (const locale of Object.keys(localized).filter(locale => locale !== 'und' && locale !== content.defaultLocale)) {
        const translated = readMediaCollection(localized, locale)
        if (!translated) continue
        if (JSON.stringify(translated.items.map(i => i.assetId)) !== JSON.stringify(base.items.map(i => i.assetId))) throw new WorkspaceScopeError(`${locale}: Shopify has one native gallery across languages. Match the primary gallery membership and order before synchronizing; localized alt text remains separate.`, 422)
        const translatedItem = translated.items.find(i => i.assetId === item.assetId), alt = translatedItem?.alt
        if (alt !== undefined) translations[locale] = alt
        if (translatedItem?.captions || translatedItem?.transcript !== undefined) accessibility[locale] = { captions: translatedItem.captions, transcript: translatedItem.transcript }
      }
      if (item.alt && item.alt.length > 512 || Object.values(translations).some(alt => alt.length > 512)) throw new WorkspaceScopeError('The Shopify publication manifest allows at most 512 characters of alt text per language.', 422)
      return { id: file.id, url: file.url, type: (file.mediaType ?? 'IMAGE') as 'IMAGE' | 'VIDEO' | 'MODEL_3D', alt: item.alt ?? file.alt ?? '', translations, ...(Object.keys(accessibility).length ? { accessibility } : {}) }
    })
    for (const asset of selected) {
      const existing = result.assets.find(a => a.id === asset.id)
      if (existing && JSON.stringify({ alt: existing.alt, translations: existing.translations }) !== JSON.stringify({ alt: asset.alt, translations: asset.translations }) && listings.some(other => other.productId !== listing.productId && readMediaCollection(mediaObject(mediaObject(other.platformAttributes)._productMediaLocales), content.defaultLocale)?.items.some(i => i.assetId === asset.id))) throw new WorkspaceScopeError('A shared gallery file has conflicting alt text in two rows. Use consistent file metadata before publication.', 422)
      result.assets = [...result.assets.filter(a => a.id !== asset.id), asset]
    }
    const key = `sheet-gallery-${listing.productId}`, featuredId = selected.find(a => a.type === 'IMAGE')?.id ?? null
    result.groups = [...result.groups.filter(g => g.id !== key), { id: key, name: 'Information gallery', assetIds: selected.map(a => a.id), featuredId }]
    result.assignments = [...result.assignments.filter(a => a.id !== key), { id: key, name: 'Information gallery', target: listing.productId === familyId ? { kind: 'family' } : { kind: 'variant', variantId: listing.productId }, priority: 100, values: {}, gallery: { mode: 'replace', groupIds: [key], featuredId, preserveOrder: true } }]
  }
  return result
}

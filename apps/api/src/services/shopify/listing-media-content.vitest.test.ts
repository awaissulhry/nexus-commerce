import { describe, expect, it } from 'vitest'
import { emptyShopifyContent, resolveShopifyContent } from '@nexus/shared/shopify-content'
import { writeMediaCollection } from '@nexus/shared/product-media'
import { applyListingMediaContent } from './listing-media-content.js'
const content = { ...emptyShopifyContent(), defaultLocale: 'en', locales: ['en', 'it'] }
const files = [{ id: 'video', productId: 'family', mediaType: 'VIDEO', url: 'https://example.test/a.mp4', alt: 'Original video' }, { id: 'image', productId: 'family', mediaType: 'IMAGE', url: 'https://example.test/a.jpg', alt: 'Original image' }]
const listing = (items: { assetId: string; alt?: string }[]) => ({ productId: 'family', platformAttributes: { _productMediaLocales: writeMediaCollection({}, 'en', { version: 1, items }) } })
describe('Unlinked Information media publication bridge', () => {
  it('preserves typed files, an explicit order and alt text without modifying the saved source document', () => {
    const next = applyListingMediaContent(content, 'family', [listing([{ assetId: 'video', alt: '' }, { assetId: 'image', alt: 'Accessible image' }])], files)
    expect(next.assets).toMatchObject([{ id: 'video', type: 'VIDEO', alt: '' }, { id: 'image', type: 'IMAGE', alt: 'Accessible image' }])
    const resolved = resolveShopifyContent(next, { id: 'child', sku: 'C', options: {}, price: '0', stock: 0 })
    expect(resolved.assetIds).toEqual(['video', 'image']); expect(resolved.featuredId).toBe('image'); expect(content.assets).toEqual([])
  })
  it('preserves an explicit empty gallery instead of inheriting product images', () => {
    const next = applyListingMediaContent(content, 'family', [listing([])], files)
    expect(resolveShopifyContent(next, { id: 'child', sku: 'C', options: {}, price: '0', stock: 0 }).assetIds).toEqual([])
  })
  it('rejects a file from another product before any Shopify writes', () => {
    expect(() => applyListingMediaContent(content, 'family', [listing([{ assetId: 'foreign' }])], [...files, { ...files[0], id: 'foreign', productId: 'other' }])).toThrow('library')
  })
  it('distinguishes native shared membership from localized alt metadata', () => {
    const row = listing([{ assetId: 'image' }]); row.platformAttributes._productMediaLocales = writeMediaCollection(row.platformAttributes._productMediaLocales, 'it', { version: 1, items: [{ assetId: 'image', alt: 'Immagine' }] })
    expect(applyListingMediaContent(content, 'family', [row], files).assets[0].translations.it).toBe('Immagine')
    row.platformAttributes._productMediaLocales = writeMediaCollection(row.platformAttributes._productMediaLocales, 'it', { version: 1, items: [] })
    expect(() => applyListingMediaContent(content, 'family', [row], files)).toThrow('one native gallery')
  })
  it('preserves captions and transcripts for the Shopify content manifest, including empty transcripts', () => {
    const row = { productId: 'family', platformAttributes: { _productMediaLocales: writeMediaCollection({}, 'en', { version: 1, items: [{ assetId: 'video', transcript: '', captions: [{ language: 'en', label: 'English', url: 'https://example.test/captions.vtt' }] }] }) } }
    expect(applyListingMediaContent(content, 'family', [row], files).assets[0].accessibility).toEqual({ en: { transcript: '', captions: [{ language: 'en', label: 'English', url: 'https://example.test/captions.vtt' }] } })
  })
})

import { describe, expect, it } from 'vitest'
import { galleryUploads } from './ShopifyGalleryReview'

const gallery = (ids: string[], storeFiles?: Record<string, string>) => ({ listingId: 'l', nexusProductId: 'p', productId: 'gid://shopify/Product/1', ownerLabel: 'Black', signature: 's', locale: 'it',
  value: [], assets: ids.map(id => ({ id, url: `https://cdn.shopify.com/${id}.jpg`, alt: '', translations: {} })), ...(storeFiles ? { storeFiles } : {}) })

describe('galleryUploads', () => {
  it('says which photos are used as they are and which upload', () => {
    expect(galleryUploads(gallery(['a', 'b'], { a: 'gid://shopify/MediaImage/1', b: 'gid://shopify/MediaImage/2' }))).toBe('2 photos are already files of this store and are used as they are (no new upload).')
    expect(galleryUploads(gallery(['a', 'b'], { a: 'gid://shopify/MediaImage/1' }))).toBe('1 photo is already a file of this store and is used as it is (no new upload). 1 new file uploads when you synchronize.')
    expect(galleryUploads(gallery(['a', 'b']))).toBe('2 new files upload when you synchronize.')
    expect(galleryUploads(gallery([]))).toBe('')
  })
})

import { describe, expect, it } from 'vitest'
import { cloudinaryPhotoKey, isLegacyPhotoId, legacyImageUrls, legacyPhotoId, legacyPhotoItems, matchLibraryPhoto, photoAddresses } from './listing-photos.pure.js'

const cdn = (path: string) => `https://res.cloudinary.com/demo-cloud/image/upload/${path}`

describe('cloudinaryPhotoKey', () => {
  it('names the same Cloudinary photo whatever size, version or format the address asks for', () => {
    const key = 'demo-cloud/product-images/fam-1/abc123'
    expect(cloudinaryPhotoKey(cdn('v1791190924/product-images/fam-1/abc123.jpg'))).toBe(key)
    expect(cloudinaryPhotoKey(cdn('w_800,c_fill/v1791190924/product-images/fam-1/abc123.webp'))).toBe(key)
    expect(cloudinaryPhotoKey(cdn('f_auto,q_auto/product-images/fam-1/abc123.png'))).toBe(key)
    expect(cloudinaryPhotoKey(cdn('product-images/fam-1/abc123'))).toBe(key)
  })

  it('keeps a folder that looks like a step when a version marks where the photo id starts', () => {
    expect(cloudinaryPhotoKey(cdn('v1/my_folder/photo.jpg'))).toBe('demo-cloud/my_folder/photo')
  })

  it('is null for any other address', () => {
    expect(cloudinaryPhotoKey('https://i.ebayimg.com/images/g/abc/s-l1600.jpg')).toBeNull()
    expect(cloudinaryPhotoKey('https://res.cloudinary.com/demo-cloud/video/upload/v1/clip.mp4')).toBeNull()
  })
})

describe('matchLibraryPhoto', () => {
  const files = [
    { id: 'parent-a', productId: 'parent', url: cdn('v2/product-images/fam-1/a.jpg') },
    { id: 'own-a', productId: 'row', url: cdn('v3/product-images/fam-1/a.jpg') },
    { id: 'video', productId: 'row', url: 'https://cdn.example/clip.mp4', mediaType: 'VIDEO' },
    { id: 'parent-b', productId: 'parent', url: 'https://cdn.example/b.jpg' },
  ]

  it('takes the same address first, then the same Cloudinary photo, the row\'s own files first', () => {
    expect(matchLibraryPhoto('https://cdn.example/b.jpg', files, 'row')?.id).toBe('parent-b')
    expect(matchLibraryPhoto(cdn('v2/product-images/fam-1/a.jpg'), files, 'row')?.id).toBe('parent-a')
    expect(matchLibraryPhoto(cdn('w_500/v9/product-images/fam-1/a.jpg'), files, 'row')?.id).toBe('own-a')
  })

  it('never matches a video, and is undefined for a photo outside the library', () => {
    expect(matchLibraryPhoto('https://cdn.example/clip.mp4', files, 'row')).toBeUndefined()
    expect(matchLibraryPhoto('https://i.ebayimg.com/images/g/x/s-l1600.jpg', files, 'row')).toBeUndefined()
  })
})

describe('the old Image URLs list', () => {
  it('reads clean addresses, in order, each once', () => {
    expect(photoAddresses([' https://a.example/1.jpg ', '', 3, 'https://a.example/1.jpg', 'https://a.example/2.jpg'])).toEqual(['https://a.example/1.jpg', 'https://a.example/2.jpg'])
    expect(photoAddresses('https://a.example/1.jpg')).toEqual([])
  })

  it('decides only while the listing has no Product media saved', () => {
    expect(legacyImageUrls({ imageUrls: ['https://a.example/1.jpg'] })).toEqual(['https://a.example/1.jpg'])
    expect(legacyImageUrls({ imageUrls: ['https://a.example/1.jpg'], _productMediaLocales: {} })).toBeUndefined()
    expect(legacyImageUrls({})).toBeUndefined()
  })

  it('becomes Product media items: library photos by their id, others by a stable address id, each photo once', () => {
    const files = [{ id: 'lib-1', productId: 'row', url: cdn('v1/p/one.jpg') }]
    const outside = 'https://i.ebayimg.com/images/g/x/s-l1600.jpg'
    const result = legacyPhotoItems([outside, cdn('v1/p/one.jpg'), cdn('w_300/v1/p/one.jpg')], files, 'row')
    expect(result.items).toEqual([{ assetId: legacyPhotoId(outside) }, { assetId: 'lib-1' }])
    expect(result.outside).toEqual([{ id: legacyPhotoId(outside), url: outside }])
    expect(isLegacyPhotoId(legacyPhotoId(outside))).toBe(true)
    expect(legacyPhotoId(outside)).toBe(legacyPhotoId(outside))
    expect(isLegacyPhotoId('lib-1')).toBe(false)
  })
})

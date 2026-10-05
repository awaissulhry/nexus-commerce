import { describe, expect, it } from 'vitest'
import { cloudinaryPhotoKey, ebayListingPhotos, isLegacyPhotoId, legacyImageUrls, legacyPhotoId, legacyPhotoItems, matchLibraryPhoto, photoAddresses, restatesPhotoList } from './listing-photos.pure.js'

const cdn = (path: string) => `https://res.cloudinary.com/demo-cloud/image/upload/${path}`

describe('cloudinaryPhotoKey', () => {
  it('names the same photo whatever version marker or file ending the address has', () => {
    const key = 'demo-cloud/product-images/fam-1/abc123'
    expect(cloudinaryPhotoKey(cdn('v1791190924/product-images/fam-1/abc123.jpg'))).toBe(key)
    expect(cloudinaryPhotoKey(cdn('v1/product-images/fam-1/abc123.webp'))).toBe(key)
    expect(cloudinaryPhotoKey(cdn('product-images/fam-1/abc123'))).toBe(key)
  })

  it('keeps a transformation step: another rendering is another photo for eBay', () => {
    expect(cloudinaryPhotoKey(cdn('w_800,c_fill/v1/product-images/fam-1/abc123.jpg'))).not.toBe(cloudinaryPhotoKey(cdn('v1/product-images/fam-1/abc123.jpg')))
    expect(cloudinaryPhotoKey(cdn('c_pad,b_white,w_1600/v1/x.jpg'))).toBe('demo-cloud/c_pad,b_white,w_1600/v1/x')
  })

  it('keeps every folder: two folders that look like steps are two photos', () => {
    expect(cloudinaryPhotoKey(cdn('xr_photos/helmet.jpg'))).toBe('demo-cloud/xr_photos/helmet')
    expect(cloudinaryPhotoKey(cdn('mv_photos/helmet.jpg'))).toBe('demo-cloud/mv_photos/helmet')
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
    expect(matchLibraryPhoto(cdn('v9/product-images/fam-1/a.jpg'), files, 'row')?.id).toBe('own-a')
    expect(matchLibraryPhoto(cdn('w_500/v9/product-images/fam-1/a.jpg'), files, 'row')).toBeUndefined()
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
    const result = legacyPhotoItems([outside, cdn('v1/p/one.jpg'), cdn('v2/p/one.jpg')], files, 'row')
    expect(result.items).toEqual([{ assetId: legacyPhotoId(outside) }, { assetId: 'lib-1' }])
    expect(result.outside).toEqual([{ id: legacyPhotoId(outside), url: outside }])
    expect(isLegacyPhotoId(legacyPhotoId(outside))).toBe(true)
    expect(legacyPhotoId(outside)).toBe(legacyPhotoId(outside))
    expect(isLegacyPhotoId('lib-1')).toBe(false)
  })
})

// Owner 2026-10-05 — the import compares a file's eBay Image URLs with the list Publish sends.
describe('ebayListingPhotos — the list Publish sends, held by the listing or followed from Shared', () => {
  const url = (id: string) => `https://cdn.example/${id}.jpg`
  const media = (...ids: string[]) => ({ _productMedia: { version: 1, items: ids.map(assetId => ({ assetId })) } })
  const files = [{ id: 'p1', productId: 'root', url: url('p1') }, { id: 'p2', productId: 'root', url: url('p2') }]
  const root = { id: 'root', localizedContent: { und: media('p2', 'p1') } }
  const child = { id: 'child', localizedContent: null }

  it('own: an old Image URLs list, or Product media saved on the listing for this language or all languages', () => {
    expect(ebayListingPhotos({ listingAttributes: { imageUrls: [url('x')] }, locale: 'it', product: child, parent: root, files })).toEqual({ urls: [url('x')], own: true })
    expect(ebayListingPhotos({ listingAttributes: { _productMediaLocales: { it: media('p1') } }, locale: 'it', product: child, parent: root, files })).toEqual({ urls: [url('p1')], own: true })
    expect(ebayListingPhotos({ listingAttributes: { _productMediaLocales: { und: media('p1') } }, locale: 'it', product: child, parent: root, files })).toEqual({ urls: [url('p1')], own: true })
  })
  it('following: nothing saved on the listing for this language — the Shared (here the parent\'s) list', () => {
    expect(ebayListingPhotos({ listingAttributes: {}, locale: 'it', product: child, parent: root, files })).toEqual({ urls: [url('p2'), url('p1')], own: false })
    expect(ebayListingPhotos({ listingAttributes: { _productMediaLocales: { de: media('p1') } }, locale: 'it', product: child, parent: root, files })).toEqual({ urls: [url('p2'), url('p1')], own: false })
  })
})

describe('restatesPhotoList — a file restates the list only with the same addresses in the same order', () => {
  const sent = ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg']
  it('the same list, cleaned and each address once', () => {
    expect(restatesPhotoList([...sent], sent)).toBe(true)
    expect(restatesPhotoList([` ${sent[0]} `, sent[0], '', sent[1]], sent)).toBe(true)
  })
  it('another order, a missing or extra photo, another size of the same Cloudinary photo: a change', () => {
    expect(restatesPhotoList([sent[1], sent[0]], sent)).toBe(false)
    expect(restatesPhotoList([sent[0]], sent)).toBe(false)
    expect(restatesPhotoList([...sent, 'https://cdn.example/c.jpg'], sent)).toBe(false)
    const cdn = (path: string) => `https://res.cloudinary.com/demo-cloud/image/upload/${path}`
    expect(restatesPhotoList([cdn('w_800/v1/p/a.jpg')], [cdn('v1/p/a.jpg')])).toBe(false)
  })
  it('not a list of addresses, or an empty list: restates nothing', () => {
    expect(restatesPhotoList(sent.join(','), sent)).toBe(false)
    expect(restatesPhotoList([sent[0], 5, sent[1]], sent)).toBe(false)
    expect(restatesPhotoList([], [])).toBe(false)
    expect(restatesPhotoList(null, sent)).toBe(false)
  })
})

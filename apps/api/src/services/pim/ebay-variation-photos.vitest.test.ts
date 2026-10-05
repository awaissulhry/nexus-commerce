import { describe, expect, it } from 'vitest'
import { ebayVariationPhotoSets, legacyImageUrls, rowHasOwnPhotos } from './ebay-variation-photos.js'

const collection = (...ids: string[]) => ({ und: { _productMedia: { version: 1, items: ids.map(assetId => ({ assetId })) } } })
const url = (name: string) => `https://img.example/${name}.jpg`

describe('rowHasOwnPhotos', () => {
  it('counts the listing\'s own Product media, its old Image URLs, its product gallery and its own files', () => {
    expect(rowHasOwnPhotos({ listingAttributes: { _productMediaLocales: collection('a') }, productContent: {}, ownFileCount: 0, locale: 'it' })).toBe(true)
    expect(rowHasOwnPhotos({ listingAttributes: { imageUrls: [url('red')] }, productContent: {}, ownFileCount: 0, locale: 'it' })).toBe(true)
    expect(rowHasOwnPhotos({ listingAttributes: {}, productContent: collection('a'), ownFileCount: 0, locale: 'it' })).toBe(true)
    expect(rowHasOwnPhotos({ listingAttributes: {}, productContent: {}, ownFileCount: 2, locale: 'it' })).toBe(true)
  })

  it('a row that only inherits the main row\'s gallery has none of its own', () => {
    expect(rowHasOwnPhotos({ listingAttributes: {}, productContent: {}, ownFileCount: 0, locale: 'it' })).toBe(false)
    expect(rowHasOwnPhotos({ listingAttributes: { imageUrls: [] }, productContent: {}, ownFileCount: 0, locale: 'it' })).toBe(false)
  })

  it('a saved Product media list wins over the old Image URLs list', () => {
    // Saved for another language only: the old list is not read any more, and this language falls back to the product.
    expect(rowHasOwnPhotos({ listingAttributes: { _productMediaLocales: { de: collection('a').und }, imageUrls: [url('red')] }, productContent: {}, ownFileCount: 0, locale: 'it' })).toBe(false)
  })
})

describe('legacyImageUrls', () => {
  it('is the old Image URLs list only while the listing has no Product media saved', () => {
    expect(legacyImageUrls({ imageUrls: [url('a'), url('b')] })).toEqual([url('a'), url('b')])
    expect(legacyImageUrls({ imageUrls: [] })).toEqual([])
    expect(legacyImageUrls({ imageUrls: [url('a')], _productMediaLocales: collection('x') })).toBeUndefined()
    expect(legacyImageUrls({})).toBeUndefined()
    expect(legacyImageUrls(null)).toBeUndefined()
  })
})

describe('ebayVariationPhotoSets', () => {
  const gallery = [url('main-1'), url('main-2')]
  const row = (sku: string, colour: string, urls: string[], own = true, size = 'M') => ({ sku, specifics: { Colore: colour, Taglia: size }, urls, own })

  it('each colour row\'s own photos become that colour\'s set, in the listing\'s value order', () => {
    const result = ebayVariationPhotoSets({ names: ['Colore'], order: { Colore: ['Nero', 'Rosso'] }, gallery,
      rows: [row('R', 'Rosso', [url('red'), url('main-1')]), row('N', 'Nero', [url('black')])] })
    expect(result.sets).toEqual({ axisName: 'Colore', order: ['Nero', 'Rosso'], byValue: { Nero: [url('black')], Rosso: [url('red'), url('main-1')] } })
    expect(result.notes).toEqual([])
  })

  it('sends nothing when every row shows the main gallery', () => {
    expect(ebayVariationPhotoSets({ names: ['Colore'], gallery, rows: [row('R', 'Rosso', gallery, false), row('N', 'Nero', gallery)] })).toEqual({ notes: [] })
  })

  it('a row without photos of its own counts as the main gallery: another value\'s photos never reach its buyers', () => {
    // Review 2026-10-05: Rosso-S/M own [red], Nero-S/M follow the gallery. Sizes disagree, so the sets go by colour.
    const result = ebayVariationPhotoSets({ names: ['Taglia', 'Colore'], gallery, rows: [row('RS', 'Rosso', [url('red')], true, 'S'), row('RM', 'Rosso', [url('red')], true, 'M'),
      row('NS', 'Nero', [], false, 'S'), row('NM', 'Nero', [], false, 'M')] })
    expect(result.sets).toEqual({ axisName: 'Colore', order: ['Rosso'], byValue: { Rosso: [url('red')] } })
  })

  it('uses the photo axis the person chose, in any language', () => {
    const rows = [row('RS', 'Rosso', [url('red')], true, 'S'), row('RM', 'Rosso', [url('red')], true, 'M')]
    expect(ebayVariationPhotoSets({ names: ['Taglia', 'Colore'], gallery, rows, chosen: 'color' }).sets?.axisName).toBe('Colore')
    // The chosen axis does not fit: nothing is sent, and the note names it.
    const result = ebayVariationPhotoSets({ names: ['Taglia', 'Colore'], gallery, rows: [row('RS', 'Rosso', [url('red')], true, 'S'), row('NS', 'Nero', [url('black')], true, 'S')], chosen: 'Taglia' })
    expect(result.sets).toBeUndefined()
    expect(result.notes[0]).toMatch(/same Taglia show different photos/)
  })

  it('sends nothing, with a note, when rows of one value show different photos under every name', () => {
    const result = ebayVariationPhotoSets({ names: ['Colore'], gallery, rows: [row('R1', 'Rosso', [url('red')]), row('R2', 'Rosso', [url('other')])] })
    expect(result.sets).toBeUndefined()
    expect(result.notes[0]).toMatch(/not sent/)
  })

  it('sends the first 12 photos of a value with more, and says so — a publish is never stopped', () => {
    const many = Array.from({ length: 13 }, (_, i) => url(`red-${i}`))
    const result = ebayVariationPhotoSets({ names: ['Colore'], gallery, rows: [row('R', 'Rosso', many)] })
    expect(result.sets?.byValue.Rosso).toEqual(many.slice(0, 12))
    expect(result.notes).toEqual(['The Rosso photos: eBay shows at most 12 per variation; the first 12 of 13 are sent.'])
  })
})

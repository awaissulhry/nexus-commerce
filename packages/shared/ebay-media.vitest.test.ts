import { describe, expect, it } from 'vitest'
import { appendGalleryAssets, draftFingerprint, galleryKey, galleryLabel, resolveGalleryFocus, inspectMediaDraft, type EbayMediaAsset, type EbayMediaDraft } from './ebay-media'

const assets: EbayMediaAsset[] = Array.from({ length: 25 }, (_, i) => ({ id: `a${i}`, url: `https://images.example/${i}.jpg`, label: `Image ${i}`, width: 1600, height: 1200, origin: 'product' }))
const listing = { axis: null, value: null, assetIds: ['a0'] }
describe('eBay gallery semantics', () => {
  it('reuses photos across galleries without moving them out of the source', () => {
    const target = appendGalleryAssets({ axis: 'Colour', value: 'Blue', assetIds: [] }, listing.assetIds, assets)
    expect(target.assetIds).toEqual(['a0']); expect(listing.assetIds).toEqual(['a0'])
  })
  it('skips repeated URLs, including separate asset records of the same image', () => {
    expect(appendGalleryAssets(listing, ['a0', 'same', 'a1'], [...assets, { ...assets[0], id: 'same' }]).assetIds).toEqual(['a0', 'a1'])
  })
  it('refuses a partial append when the result exceeds the supported limit', () => {
    expect(() => appendGalleryAssets(listing, assets.slice(1).map(a => a.id), assets)).toThrow('25 images')
    expect(listing.assetIds).toEqual(['a0'])
  })
  it('accepts 24 common photos but refuses more than 12 variation photos without trimming', () => {
    const ids = assets.slice(0, 24).map(a => a.id)
    expect(appendGalleryAssets({ axis: null, value: null, assetIds: [] }, ids, assets).assetIds).toEqual(ids)
    const variation = { axis: 'Color', value: 'Blue', assetIds: [] }
    expect(() => appendGalleryAssets(variation, ids.slice(0, 13), assets)).toThrow('12')
    expect(inspectMediaDraft({ axis: 'Color', galleries: [{ axis: null, value: null, assetIds: ids }, { ...variation, assetIds: ids.slice(0, 13) }] }, assets).problems).toHaveLength(1)
    expect(variation.assetIds).toEqual([])
  })
  it('focuses common cover first, then the selected variation without combining or changing sets', () => {
    const draft = { axis: 'Color', galleries: [{ axis: null, value: null, assetIds: ['a0', 'a1'] }, { axis: 'Color', value: 'Blue', assetIds: ['a2', 'a3'] }, { axis: 'Size', value: 'M', assetIds: ['a4'] }] }
    const before = structuredClone(draft)
    expect(resolveGalleryFocus(draft, null)).toEqual({ assetId: 'a0', kind: 'common' })
    expect(resolveGalleryFocus(draft, 'Blue')).toEqual({ assetId: 'a2', kind: 'variation' })
    expect(resolveGalleryFocus(draft, 'Red')).toEqual({ assetId: 'a0', kind: 'missing-variation' })
    expect(resolveGalleryFocus({ ...draft, axis: null }, 'Blue')).toEqual({ assetId: 'a0', kind: 'common' })
    expect(resolveGalleryFocus({ axis: null, galleries: [] }, null)).toEqual({ assetId: null, kind: 'common' })
    expect(draft).toEqual(before)
  })
  it('does not mistake unknown dimensions for compliant images', () => {
    const result = inspectMediaDraft({ axis: null, galleries: [listing] }, [{ ...assets[0], width: null, height: null }])
    expect(result.problems).toEqual([]); expect(result.review).toEqual(['Image 0: original dimensions are unknown.'])
  })
  it('uses longest-side minimum, and permits saving below-minimum draft photos with an explicit review note', () => {
    expect(inspectMediaDraft({ axis: null, galleries: [listing] }, [{ ...assets[0], width: 500, height: 300 }]).review).toEqual([])
    expect(inspectMediaDraft({ axis: null, galleries: [listing] }, [{ ...assets[0], width: 499, height: 300 }]).review[0]).toContain('below eBay')
  })
  it('flags missing cover, duplicate assignments and foreign source IDs', () => {
    const result = inspectMediaDraft({ axis: 'Colour', galleries: [{ axis: 'Colour', value: 'Blue', assetIds: ['a0', 'a0', 'foreign'] }] }, assets)
    expect(result.problems).toHaveLength(2); expect(result.review).toContain('Cover & common photos has no cover image.')
  })
  it('never permits executable URLs as source images', () => {
    expect(inspectMediaDraft({ axis: null, galleries: [listing] }, [{ ...assets[0], url: 'javascript:alert(1)' }]).problems).toHaveLength(1)
  })
  it('uses English display labels in gallery headings and validation without altering identity', () => {
    const gallery = { axis: 'Colore', value: 'Blu', assetIds: ['foreign'] }
    expect(galleryLabel(gallery, { Colore: 'Color' })).toBe('Color: Blu')
    expect(inspectMediaDraft({ axis: 'Colore', galleries: [gallery] }, assets, { Colore: 'Color' }).problems[0]).toContain('Color: Blu')
    expect(galleryKey(gallery)).toBe('["Colore","Blu"]')
  })
  it('preserves case and punctuation in grouping identities', () => {
    expect(galleryKey({ axis: 'A:B', value: 'C' })).not.toBe(galleryKey({ axis: 'A', value: 'B:C' }))
    expect(galleryKey({ axis: 'Colour', value: 'blue' })).not.toBe(galleryKey({ axis: 'Colour', value: 'Blue' }))
  })
  it('ignores empty groups when detecting edits but detects order and grouping changes', () => {
    const draft: EbayMediaDraft = { axis: null, galleries: [listing] }
    expect(draftFingerprint(draft)).toBe(draftFingerprint({ ...draft, galleries: [...draft.galleries, { axis: 'Colour', value: 'Blue', assetIds: [] }] }))
    expect(draftFingerprint(draft)).not.toBe(draftFingerprint({ ...draft, axis: 'Colour' }))
    expect(draftFingerprint({ ...draft, galleries: [{ ...listing, assetIds: ['a0', 'a1'] }] })).not.toBe(draftFingerprint({ ...draft, galleries: [{ ...listing, assetIds: ['a1', 'a0'] }] }))
  })
})

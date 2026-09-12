import { describe, expect, it } from 'vitest'
import { amazonImageSlots, amazonSafetyImageSlots, buildImagePatches, effectiveImageSlots, groupAmazonItems, imageCatalogMatches, imageContributionMatches, imageDraftFingerprint, inspectAmazonImages, publicImageUrl, planAmazonBulkImages, planAmazonSafetyExport,
  type AmazonMediaDraft, type AmazonMediaWorkspace, type AmazonMediaItem, type AmazonMediaObservation } from './amazon-media'

const image = { assetId: 'photo', language: 'zxx' }
const assets = [{ id: 'photo', url: 'https://cdn.example/photo.jpg', label: 'Photo', width: 1600, height: 1600, origin: 'product' as const }]
const observed: AmazonMediaObservation = { checkedAt: '2026-09-08T10:00:00Z', error: null, asin: 'ASIN', productType: 'SHIRT', theme: null, attributes: {}, slots: { MAIN: assets[0].url }, catalog: [{ slot: 'MAIN', url: 'https://m.media-amazon.com/images/I/xyz._SL1600_.jpg', width: 1600, height: 1600 }], catalogError: null, issues: [], supported: ['MAIN', 'PT01'] }
describe('Amazon media contract', () => {
  it('resolves common → SKU overrides and retains explicit empty slots', () => {
    expect(effectiveImageSlots({ common: { MAIN: image, PT01: image }, items: { blue: { PT01: null } } }, 'blue')).toEqual({ MAIN: image, PT01: null })
    expect(effectiveImageSlots({ common: {}, items: {} }, 'red')).toEqual({})
  })
  it('ignores property order when detecting unsaved changes', () => {
    expect(imageDraftFingerprint({ common: { MAIN: image, PT01: null }, items: {} })).toBe(imageDraftFingerprint({ common: { PT01: null, MAIN: image }, items: { empty: {} } }))
  })
  it('requires a main image, source identity and market language review', () => {
    expect(inspectAmazonImages({}, assets, ['it'])).toContain('A main image is required.')
    expect(inspectAmazonImages({ MAIN: { ...image, language: 'de' } }, assets, ['it']).join()).toContain('confirm the image language')
    expect(inspectAmazonImages({ MAIN: { ...image, language: 'und' } }, assets, ['it']).join()).toContain('confirm the image language')
    expect(inspectAmazonImages({ MAIN: image }, assets, ['it'])).toEqual([])
    expect(inspectAmazonImages({ MAIN: { ...image, assetId: 'foreign' } }, assets, ['it']).join()).toContain('unavailable')
  })
  it('rejects repeated gallery photos but permits a separate swatch using the main image', () => {
    expect(inspectAmazonImages({ MAIN: image, PT01: image }, assets, ['it']).join()).toContain('already appears')
    expect(inspectAmazonImages({ MAIN: image, SWCH: image }, assets, ['it'])).toEqual([])
  })
  it.each(['http://cdn.example/a.jpg', 'https://localhost/a.jpg', 'https://127.0.0.1/a.jpg', 'https://172.16.1.1/a.jpg', 'https://user:pass@cdn.example/a.jpg', 'data:image/png;base64,xx', 'https://cdn.example:3000/a.jpg'])('refuses an unsuitable publication URL %s', value => expect(publicImageUrl(value)).toBe(false))
  it('sends only changed supported gallery slots with an explicit marketplace selector', () => {
    const result = buildImagePatches({ MAIN: 'new', SWCH: 'swatch' }, { MAIN: 'old', PT01: 'extra', PS01: 'safety' }, ['MAIN', 'PT01'], 'IT-ID')
    expect(result.changes).toEqual([{ slot: 'MAIN', before: 'old', after: 'new' }, { slot: 'PT01', before: 'extra', after: null }])
    expect(result.patches).toEqual([
      { op: 'replace', path: '/attributes/main_product_image_locator', value: [{ marketplace_id: 'IT-ID', media_location: 'new' }] },
      { op: 'delete', path: '/attributes/other_product_image_locator_1', value: [{ marketplace_id: 'IT-ID', media_location: 'extra' }] },
    ])
    expect(amazonImageSlots.some(s => s.code === 'PS01')).toBe(false)
  })
  it('does not equate an accepted contribution URL with Amazon’s transformed catalog upload', () => {
    expect(imageContributionMatches({ MAIN: assets[0].url }, observed)).toBe(true)
    expect(imageCatalogMatches({ MAIN: assets[0].url }, observed)).toBe(false)
    expect(imageCatalogMatches({ MAIN: 'https://m.media-amazon.com/images/I/xyz.jpg' }, observed)).toBe(true)
    expect(imageCatalogMatches({ MAIN: 'https://fake.amazon.example/images/I/xyz.jpg' }, observed)).toBe(false)
    expect(imageContributionMatches({ MAIN: assets[0].url }, { ...observed, error: 'Read failed' })).toBe(false)
  })
  it('requires empty slots to match too, and refuses missing catalog evidence', () => {
    expect(imageContributionMatches({}, observed)).toBe(false)
    expect(imageCatalogMatches({}, { ...observed, catalog: [] })).toBe(false)
    expect(imageCatalogMatches({ MAIN: 'https://m.media-amazon.com/images/I/xyz.jpg' }, { ...observed, catalogError: 'Unavailable' })).toBe(false)
  })
  it('groups arbitrary product attributes without merging missing values or parent listings', () => {
    const item = (id: string, material?: string, parent = false) => ({ id, parent, attributes: material ? { material } : {} }) as AmazonMediaItem
    expect(groupAmazonItems([item('a', 'Cotton'), item('b', 'Cotton'), item('c', 'Linen'), item('d'), item('p', undefined, true)], 'material').map(g => [g.label, g.items.map(i => i.id)])).toEqual([
      ['Cotton', ['a', 'b']], ['Linen', ['c']], ['Value unavailable', ['d']], ['Parent listing', ['p']],
    ])
  })
})

describe('Amazon bulk assignments', () => {
  const chart = { assetId: 'chart', language: 'it' }
  const draft: AmazonMediaDraft = { common: { PT01: chart, PS01: image }, items: { blue: { MAIN: image, PS02: null }, red: { MAIN: { ...image, assetId: 'red' } } } }
  it('fills only unassigned slots, retaining inherited photos, mains and explicit clears', () => {
    const plan = planAmazonBulkImages(draft, { PS01: chart, PS02: chart, PS03: chart }, ['blue', 'red'], ['PS01', 'PS02', 'PS03'], 'fill')
    expect(plan.changes.map(c => [c.listingId, c.slot])).toEqual([['blue', 'PS03'], ['red', 'PS02'], ['red', 'PS03']])
    expect(plan.draft.items.blue).toEqual({ MAIN: image, PS02: null, PS03: chart })
    expect(draft.items.blue).toEqual({ MAIN: image, PS02: null })
  })
  it('replaces exactly chosen slots once per SKU and can confirm their language', () => {
    const plan = planAmazonBulkImages(draft, { PS01: chart, PT01: image }, ['blue', 'blue'], ['PS01', 'PS01'], 'replace', 'zxx')
    expect(plan.changes).toHaveLength(1)
    expect(plan.draft.items.blue).toEqual({ MAIN: image, PS02: null, PS01: { ...chart, language: 'zxx' } })
    expect(plan.draft.items.red).toEqual(draft.items.red)
  })
  it('does not clear a target when a selected source slot is empty', () => {
    expect(planAmazonBulkImages(draft, { MAIN: null }, ['blue'], ['MAIN'], 'replace').changes).toEqual([])
  })
  it('restores inheritance including explicitly empty overrides, without freezing common images', () => {
    const plan = planAmazonBulkImages(draft, {}, ['blue'], ['MAIN', 'PS02'], 'inherit')
    expect(plan.draft.items.blue).toEqual({})
    expect(plan.changes).toHaveLength(2)
    expect(effectiveImageSlots({ ...plan.draft, common: { ...draft.common, PS02: chart } }, 'blue').PS02).toEqual(chart)
  })
  it('clears only chosen slots and prevents future common inheritance', () => {
    const plan = planAmazonBulkImages(draft, {}, ['blue'], ['PS01'], 'clear')
    expect(plan.draft.items.blue).toEqual({ MAIN: image, PS01: null, PS02: null })
    expect(effectiveImageSlots(plan.draft, 'blue').PS01).toBeNull()
  })
  it('does not create a second change for an identical assignment or accept unknown slots', () => {
    expect(planAmazonBulkImages(draft, { MAIN: image, PS07: chart }, ['blue'], ['MAIN', 'PS07'], 'replace').changes).toEqual([])
  })
})

describe('PS export contract', () => {
  const workspace = (draft: AmazonMediaDraft, extraItems: Partial<AmazonMediaItem>[] = []) => ({ draft, assets, languages: ['it'], items: [
    { id: 'blue', sku: 'BLUE', asin: 'B000000001' }, { id: 'red', sku: 'RED', asin: 'B000000002' }, ...extraItems,
  ] }) as AmazonMediaWorkspace
  it('supports exactly PS01–PS06 while API patch construction excludes every PS slot', () => {
    expect(amazonSafetyImageSlots.map(s => s.code)).toEqual(['PS01', 'PS02', 'PS03', 'PS04', 'PS05', 'PS06'])
    expect(buildImagePatches({ PS01: 'new' }, { PS01: 'old' }, ['PS01'], 'IT').patches).toEqual([])
  })
  it('exports market common safety images and SKU overrides without requiring a main', () => {
    const plan = planAmazonSafetyExport(workspace({ common: { PS01: image, PS06: image }, items: { red: { PS06: null } } }), ['blue', 'red'])
    expect(plan.issues).toEqual([])
    expect(plan.files.map(f => `${f.asin}.${f.slot}`)).toEqual(['B000000001.PS01', 'B000000001.PS06', 'B000000002.PS01'])
  })
  it('requires known targets, an exact ASIN, assigned sources and market language review', () => {
    const w = workspace({ common: { PS01: { ...image, language: 'de' } }, items: {} }, [{ id: 'missing', sku: 'MISSING', asin: null }])
    expect(planAmazonSafetyExport(w, ['blue', 'foreign', 'missing']).issues.join(' ')).toMatch(/language.*destination.*ASIN/)
    expect(planAmazonSafetyExport(workspace({ common: {}, items: {} }), ['blue']).issues.join()).toContain('no safety images')
    expect(planAmazonSafetyExport(workspace({ common: { PS01: { ...image, assetId: 'foreign' } }, items: {} }), ['blue']).issues.join()).toContain('source image')
  })
  it('deduplicates equivalent ASIN files and blocks conflicting galleries including empty slots', () => {
    const w = workspace({ common: { PS01: image }, items: {} }, [{ id: 'alias', sku: 'ALIAS', asin: 'B000000001' }])
    const plan = planAmazonSafetyExport(w, ['blue', 'alias'])
    expect(plan.files).toHaveLength(1); expect(plan.files[0].listingIds).toEqual(['blue', 'alias'])
    w.draft.items.alias = { PS02: image }
    expect(planAmazonSafetyExport(w, ['blue', 'alias']).issues.join()).toContain('conflicting safety images')
  })
})

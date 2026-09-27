import { describe, expect, it } from 'vitest'
import type { MediaPlan, MediaPlanStack } from './media-plan'
import { amazonSlotsFor, channelNames, pickVersion, projectAmazon, projectEbay, projectEtsy, projectShopify, type MediaAsset, type MediaDestination, type MediaFamily } from './media-plan-channels'

const ids = (...list: string[]) => list.map(assetId => ({ assetId }))
const plan = (sets: MediaPlan['sets'], axis?: string | null): MediaPlan => ({ version: 1, ...(axis !== undefined ? { axis } : {}), sets })
const asset = (id: string, extra: Partial<MediaAsset> = {}): MediaAsset => ({ id, url: `https://cdn.example/${id}.jpg`, mediaType: 'IMAGE', width: 1600, height: 1600, mimeType: 'image/jpeg', fileSize: 400_000, languageTag: 'zxx', versionGroupId: null, label: id, ...extra })
const library = (...list: MediaAsset[]) => new Map(list.map(a => [a.id, a]))

const family: MediaFamily = {
  productId: 'root', defaultAxis: 'color',
  // Yellow is listed first in the rows on purpose: the family's value order (black, yellow) must decide the output order.
  variants: [
    { productId: 'y-m', sku: 'GALE-YELLOW-M', values: { color: 'color:yellow', size: 'size:m' }, included: true },
    { productId: 'b-m', sku: 'GALE-BLACK-M', values: { color: 'color:black', size: 'size:m' }, included: true },
    { productId: 'b-l', sku: 'GALE-BLACK-L', values: { color: 'color:black', size: 'size:l' }, included: true },
    { productId: 'b-xl', sku: 'GALE-BLACK-XL', values: { color: 'color:black', size: 'size:xl' }, included: false },
  ],
  valueOrder: { color: ['color:black', 'color:yellow'], size: ['size:m', 'size:l', 'size:xl'] },
  valueLabels: { 'color:black': 'Nero', 'color:yellow': 'Giallo' },
}
const ebayIT: MediaDestination = { channel: 'EBAY', market: 'IT', languages: ['it'], mainLanguage: 'it', api: 'TRADING', axisName: 'Colore', valueNames: { 'color:black': 'Nero', 'color:yellow': 'Giallo' } }
const ebayDE: MediaDestination = { ...ebayIT, market: 'DE', languages: ['de'], axisName: 'Farbe', valueNames: { 'color:black': 'Schwarz', 'color:yellow': 'Gelb' } }
const assets = library(asset('cover'), asset('detail'), asset('n1'), asset('n2'), asset('g1'), asset('g2'),
  asset('chart-it', { languageTag: 'it', versionGroupId: 'chart' }), asset('chart-de', { languageTag: 'de', versionGroupId: 'chart' }))
const shared = plan({ common: ids('cover', 'detail', 'chart-it'), values: { 'color:yellow': ids('g1', 'g2'), 'color:black': ids('cover', 'n1', 'n2') } }, 'color')
const stack: MediaPlanStack = { shared }

describe('eBay layout — the two sections and their order', () => {
  it('sends Common in order, then one set per value in the family value order, named for the market', () => {
    const it = projectEbay(stack, family, assets, ebayIT)
    expect(it.gallery).toEqual(['cover', 'detail', 'chart-it'])
    expect(it.axisName).toBe('Colore')
    expect(it.sets.map(s => [s.value, s.items])).toEqual([['Nero', ['cover', 'n1', 'n2']], ['Giallo', ['g1', 'g2']]])
    expect(it.sets[0].skus).toEqual(['GALE-BLACK-M', 'GALE-BLACK-L'])
    expect(it.sets[0].productIds).toEqual(['b-m', 'b-l'])
    expect(it.checks.filter(c => c.severity === 'error')).toEqual([])
    const de = projectEbay(stack, family, assets, ebayDE)
    expect(de.axisName).toBe('Farbe')
    expect(de.sets.map(s => s.value)).toEqual(['Schwarz', 'Gelb'])
  })
  it('keeps the cover in Nero when it is also Nero\'s main photo (the 2026-07-27 regression)', () => {
    expect(projectEbay(stack, family, assets, ebayIT).sets[0].items[0]).toBe('cover')
  })
  it('gives each market its language version of a photo and warns when it falls back', () => {
    expect(projectEbay(stack, family, assets, ebayDE).gallery).toEqual(['cover', 'detail', 'chart-de'])
    const es = projectEbay(stack, family, assets, { ...ebayIT, market: 'ES', languages: ['es'] })
    expect(es.gallery[2]).toBe('chart-it')
    expect(es.checks.some(c => c.code === 'language-fallback')).toBe(true)
  })
  it('blocks — never cuts — a value without photos, too many photos, no Common and a missing market name', () => {
    const over = plan({ common: [], values: { 'color:black': ids(...Array.from({ length: 13 }, (_, i) => `x${i}`)) } }, 'color')
    const big = library(...assets.values(), ...Array.from({ length: 13 }, (_, i) => asset(`x${i}`)))
    const out = projectEbay({ shared: over }, family, big, { ...ebayIT, valueNames: { 'color:black': 'Nero' } })
    expect(out.sets[0].items).toHaveLength(13)
    expect(out.checks.map(c => c.code).sort()).toEqual(['no-common', 'over-limit', 'value-name-missing', 'value-without-photos'])
  })
  it('refuses a value that is not a dictionary option, small photos, and over-long Trading addresses', () => {
    const fam = { ...family, variants: [{ productId: 'z', sku: 'Z', values: { color: 'color:text:neroopaco' }, included: true }], valueLabels: {} }
    const small = library(asset('cover', { width: 400, height: 300, url: `https://cdn.example/${'a'.repeat(4000)}.jpg` }))
    const out = projectEbay({ shared: plan({ common: ids('cover'), values: { 'color:text:neroopaco': ids('cover') } }, 'color') }, fam, small, ebayIT)
    expect(out.checks.map(c => c.code)).toEqual(expect.arrayContaining(['value-unmapped', 'value-name-missing', 'too-small', 'url-length']))
  })
  it('a layer can switch the picture axis: the sets follow that axis\'s values in its order', () => {
    const bySize = plan({ values: { 'size:l': ids('n2'), 'size:m': ids('n1') } }, 'size')
    const out = projectEbay({ shared, listing: bySize }, family, assets, { ...ebayIT, axisName: 'Taglia', valueNames: { 'size:m': 'M', 'size:l': 'L' } })
    expect(out.axisName).toBe('Taglia')
    expect(out.sets.map(s => [s.value, s.items, s.skus])).toEqual([['M', ['n1'], ['GALE-YELLOW-M', 'GALE-BLACK-M']], ['L', ['n2'], ['GALE-BLACK-L']]])
  })
  it('one shared gallery (axis off) sends Common only, no variation sets', () => {
    const out = projectEbay({ shared, listing: plan({}, null) }, family, assets, ebayIT)
    expect(out.sets).toEqual([]); expect(out.axisName).toBeNull()
  })
})

describe('Amazon layout', () => {
  const amazon: MediaDestination = { channel: 'AMAZON', market: 'IT', languages: ['mul', 'it'], mainLanguage: 'it', axisName: null, valueNames: {} }
  it('MAIN is the colour\'s first photo, then the rest of the colour, then Common without repeating a photo', () => {
    const out = projectAmazon(stack, family, assets, amazon)
    const black = out.items.find(i => i.sku === 'GALE-BLACK-M')!
    expect(black.slots).toEqual({ MAIN: 'cover', PT01: 'n1', PT02: 'n2', PT03: 'detail', PT04: 'chart-it' })
    expect(out.items.map(i => i.sku)).toEqual(['GALE-YELLOW-M', 'GALE-BLACK-M', 'GALE-BLACK-L'])
    expect(out.parent?.slots.MAIN).toBe('cover')
  })
  it('gives each product its own slots, the parent its Common slots, and nothing to a product not in the layout', () => {
    const out = projectAmazon(stack, family, assets, amazon)
    expect(amazonSlotsFor(out, 'b-m')?.MAIN).toBe('cover')
    expect(amazonSlotsFor(out, 'root')?.MAIN).toBe('cover')
    expect(amazonSlotsFor(out, 'b-xl')).toBeNull()
  })
  it('names what does not fit, adds the swatch, and lets a per-SKU set win', () => {
    const many = library(...assets.values(), ...Array.from({ length: 10 }, (_, i) => asset(`m${i}`)), asset('sw'), asset('own'))
    const p = plan({ common: ids('cover'), values: { 'color:black': ids(...Array.from({ length: 10 }, (_, i) => `m${i}`)) }, skus: { 'b-l': ids('own') }, swatches: { 'color:black': { assetId: 'sw' } } }, 'color')
    const out = projectAmazon({ shared: p }, family, many, amazon)
    const m = out.items.find(i => i.sku === 'GALE-BLACK-M')!
    expect(m.cut).toEqual(['m9', 'cover']); expect(m.slots.SWCH).toBe('sw')
    expect(out.checks.filter(c => c.code === 'does-not-fit')).toHaveLength(1)
    expect(out.items.find(i => i.sku === 'GALE-BLACK-L')!.slots.MAIN).toBe('own')
  })
  it('warns under 1000 px (no zoom) and blocks under 500 px', () => {
    const lib = library(asset('cover', { width: 800, height: 800 }), asset('n1', { width: 400, height: 400 }), asset('n2'), asset('g1'), asset('g2'), asset('detail'), asset('chart-it'))
    const codes = projectAmazon({ shared: plan({ common: ids('cover'), values: { 'color:black': ids('n1') } }, 'color') }, family, lib, amazon).checks.map(c => c.code)
    expect(codes).toEqual(expect.arrayContaining(['no-zoom', 'too-small']))
  })
})

describe('Shopify and Etsy layouts', () => {
  const shopify: MediaDestination = { channel: 'SHOPIFY', market: 'GLOBAL', languages: ['it'], mainLanguage: 'it', axisName: null, valueNames: {} }
  it('Shopify: more than 50 photos in the gallery is refused (the Nexus storefront rule), never cut', () => {
    const lib = library(...Array.from({ length: 51 }, (_, i) => asset(`s${i}`)))
    const out = projectShopify({ shared: plan({ common: ids(...Array.from({ length: 51 }, (_, i) => `s${i}`)) }) }, { ...family, variants: [] }, lib, shopify)
    expect(out.media).toHaveLength(51)
    expect(out.checks.map(c => c.code)).toEqual(['over-limit'])
  })
  it('Shopify keeps 3D models under either stored spelling, never as a variant image', () => {
    const lib = library(asset('cover'), asset('m3d', { mediaType: 'MODEL_3D' }), asset('m3d-old', { mediaType: 'MODEL3D' }))
    const out = projectShopify({ shared: plan({ common: ids('m3d', 'cover', 'm3d-old') }) }, { ...family, variants: [] }, lib, shopify)
    expect(out.media).toEqual(['m3d', 'cover', 'm3d-old'])
  })
  it('Shopify: product media is Common then each value once; each variant shows its value\'s first photo', () => {
    const out = projectShopify(stack, family, assets, shopify)
    expect(out.media).toEqual(['cover', 'detail', 'chart-it', 'n1', 'n2', 'g1', 'g2'])
    expect(out.variantImages).toEqual({ 'y-m': 'g1', 'b-m': 'cover', 'b-l': 'cover' })
  })
  it('Etsy: 20 photos, the rest named; one photo per option; its main photo must be among the 20', () => {
    const etsy: MediaDestination = { channel: 'ETSY', market: 'GLOBAL', languages: ['it'], mainLanguage: 'it', axisName: 'Colore', valueNames: {} }
    const lib = library(...assets.values(), ...Array.from({ length: 20 }, (_, i) => asset(`c${i}`)))
    const out = projectEtsy({ shared: plan({ common: ids(...Array.from({ length: 20 }, (_, i) => `c${i}`)), values: { 'color:black': ids('n1'), 'color:yellow': ids('g1') } }, 'color') }, family, lib, etsy)
    expect(out.images).toHaveLength(20); expect(out.cut).toEqual(['n1', 'g1'])
    expect(out.checks.map(c => c.code)).toEqual(expect.arrayContaining(['does-not-fit', 'variation-photo-cut']))
    expect(projectEtsy(stack, family, assets, etsy).variationImages.map(v => [v.value, v.assetId])).toEqual([['Nero', 'cover'], ['Giallo', 'g1']])
  })
})

describe('language versions (D6)', () => {
  it('prefers the market language, then English, several languages, the main language', () => {
    const lib = library(asset('a-it', { languageTag: 'it', versionGroupId: 'a' }), asset('a-en', { languageTag: 'en', versionGroupId: 'a' }), asset('a-mul', { languageTag: 'mul', versionGroupId: 'a' }))
    expect(pickVersion('a-it', lib, ['de'], 'it')).toMatchObject({ assetId: 'a-en', exact: false })
    expect(pickVersion('a-it', lib, ['mul', 'it'], 'it')).toMatchObject({ assetId: 'a-mul', exact: true })
    expect(pickVersion('a-en', lib, ['it'], 'it')).toMatchObject({ assetId: 'a-it', exact: true })
    expect(pickVersion('gone', lib, ['it'], 'it')).toBeNull()
  })
})

describe('channel names', () => {
  const axes = [{ code: 'color', label: 'Colore' }, { code: 'size', label: 'Taglia' }]
  it('names each value with what the listing receives (a pin wins over Shared) and the axis with the listing name', () => {
    const out = channelNames({ axes, variants: family.variants, axis: 'color', valueLabels: family.valueLabels, channelValues: {
      byProduct: { 'y-m': { Colore: 'Giallo', Taglia: 'M' }, 'b-m': { Colore: 'Nero opaco', Taglia: 'M' }, 'b-l': { Colore: 'Nero opaco', Taglia: 'L' } },
      axisNames: { Colore: 'Colore', Taglia: 'Taglia' } } })
    expect(out).toEqual({ axisName: 'Colore', conflicts: [], valueNames: { 'color:yellow': 'Giallo', 'color:black': 'Nero opaco', 'size:m': 'M', 'size:l': 'L' } })
  })
  it('reports one value named two ways, and leaves an unnamed value for the checks', () => {
    const out = channelNames({ axes, variants: family.variants, axis: 'color', valueLabels: family.valueLabels, channelValues: {
      byProduct: { 'b-m': { Colore: 'Nero' }, 'b-l': { Colore: 'Schwarz' } }, axisNames: { Colore: 'Farbe' } } })
    expect(out.conflicts).toEqual(['Nero is named both "Nero" and "Schwarz" on this listing.'])
    expect(out.valueNames['color:yellow']).toBeUndefined()
  })
})

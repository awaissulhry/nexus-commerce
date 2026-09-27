import { describe, expect, it } from 'vitest'
import type { MediaPlan } from '@nexus/shared/media-plan'

import type { LibraryAsset, MediaRead } from './model'
import { fileNameContext, libraryUpdate, placementOps, rowFromFile, type UploadRow, type UploadStatus } from './uploadModel'

const ids = (...list: string[]) => list.map(assetId => ({ assetId }))
const asset = (id: string, extra: Partial<LibraryAsset> = {}): LibraryAsset => ({ id, productId: 'root', url: `https://cdn.test/${id}.jpg`, alt: null, mediaType: 'IMAGE',
  width: 1600, height: 1600, mimeType: 'image/jpeg', fileSize: 1000, languageTag: 'zxx', versionGroupId: null, label: id, ...extra })
const SHARED: MediaPlan = { version: 1, axis: 'color', sets: { common: ids('cover'), values: { 'color:black': ids('cover', 'n1') } } }
const read: MediaRead = {
  productId: 'root', rootId: 'root', sku: 'T', name: 'T', mainLanguage: 'it',
  family: { productId: 'root', defaultAxis: 'color', valueOrder: { color: ['color:black', 'color:yellow'] }, valueLabels: { 'color:black': 'Nero', 'color:yellow': 'Giallo' },
    variants: [{ productId: 'n', sku: 'T-NERO', values: { color: 'color:black' }, included: true }, { productId: 'g', sku: 'T-GIALLO', values: { color: 'color:yellow' }, included: true }],
    axes: [{ code: 'color', label: 'Colore', dictionary: true, values: [{ key: 'color:black', label: 'Nero' }, { key: 'color:yellow', label: 'Giallo' }] }], unmapped: [] },
  library: [asset('cover'), asset('n1'), asset('chart-es', { languageTag: 'es', versionGroupId: 'chart' })],
  layers: [{ key: 'SHARED', layer: 'SHARED', channel: '', marketplace: '', accountId: '', aliasKey: '', plan: SHARED, revision: 1 }],
  destinations: [],
}
const context = fileNameContext(read)
const row = (name: string, status: UploadStatus, extra: Partial<UploadRow> = {}) => ({ ...rowFromFile(name, name, null, context), status, ...extra })

describe('upload dialog', () => {
  it('reads the set, position and language from each name — Italian labels and dictionary codes both work', () => {
    const read = (name: string) => { const r = rowFromFile(name, name, null, context); return `${r.set}|${r.position}|${r.language}${r.swatch ? '|swatch' : ''}` }
    expect(read('gale-black-01.jpg')).toBe('value:color:black|1|zxx')
    expect(read('GALE_giallo_2.png')).toBe('value:color:yellow|2|zxx')
    expect(read('size-chart-it.jpg')).toBe('common|null|it')
    expect(read('T-NERO-main.jpg')).toBe('sku:n|1|zxx')
    expect(read('nero-swatch.jpg')).toBe('value:color:black|null|zxx|swatch')
    // A camera number is not a position: the photo goes to the end of Common, where one click moves it.
    expect(read('IMG_0042.jpg')).toBe('common|null|zxx')
  })
  it('places each photo at its position, once per language group, skips what the set already holds and sets swatches', () => {
    const rows = [
      row('gale-black-01.jpg', { kind: 'new', assetId: 'a1' }),
      row('gale-black-detail.jpg', { kind: 'new', assetId: 'a2' }),
      row('size-chart-it.jpg', { kind: 'new', assetId: 'cit' }),
      row('size-chart-de.jpg', { kind: 'new', assetId: 'cde' }),
      row('cover-again.jpg', { kind: 'exact', assetId: 'cover' }),
      row('look-alike.jpg', { kind: 'similar', candidate: { id: 'n1', url: 'u', label: 'n1' } }, { set: 'value:color:black' }),
      row('giallo-swatch.jpg', { kind: 'new', assetId: 'sw' }),
      row('broken.jpg', { kind: 'failed', message: 'Too large' }),
    ]
    const placed = placementOps(read, { layer: 'SHARED' }, rows)
    expect(placed.ops).toEqual([
      { op: 'swatch', value: 'color:yellow', assetId: 'sw' },
      { op: 'insert', set: 'value:color:black', assetIds: ['a1'], index: 0 },
      { op: 'insert', set: 'value:color:black', assetIds: ['a2'] },
      // The Italian chart is placed; the German one is its version (the main language is Italian).
      { op: 'insert', set: 'common', assetIds: ['cit'] },
    ])
    // "cover" is already in Common; the look-alike resolves to n1, already in Nero.
    expect(placed.skipped).toEqual(['look-alike.jpg', 'cover-again.jpg'])
    expect(placed.sets.map(s => `${s.label}:${s.count}`)).toEqual(['Nero:2', 'Common:1'])
  })
  it('a look-alike that is another SKU\'s copy of a picture places the picture\'s library card, and counts as already there', () => {
    const withCopies: MediaRead = { ...read, library: read.library.map(a => a.id === 'n1' ? { ...a, copies: ['n1-kid'] } : a) }
    const placed = placementOps(withCopies, { layer: 'SHARED' }, [row('nero-again.jpg', { kind: 'similar', candidate: { id: 'n1-kid', url: 'u', label: 'n1' } }, { set: 'common' })])
    expect(placed.ops).toEqual([{ op: 'insert', set: 'common', assetIds: ['n1'] }])
    expect(placementOps(withCopies, { layer: 'SHARED' }, [row('nero-again.jpg', { kind: 'exact', assetId: 'n1-kid' }, { set: 'value:color:black' })]).skipped).toEqual(['nero-again.jpg'])
  })
  it('names each new photo\'s language and groups the versions; a version of a photo already in the library joins it', () => {
    expect(libraryUpdate([row('size-chart-it.jpg', { kind: 'new', assetId: 'cit' }), row('size-chart-de.jpg', { kind: 'new', assetId: 'cde' }), row('gale-black-01.jpg', { kind: 'new', assetId: 'a1' })]))
      .toEqual({ languages: [{ id: 'cit', languageTag: 'it' }, { id: 'cde', languageTag: 'de' }, { id: 'a1', languageTag: 'zxx' }], groups: [{ ids: ['cit', 'cde'], join: null }] })
    expect(libraryUpdate([row('size-chart-es.jpg', { kind: 'exact', assetId: 'chart-es' }), row('size-chart-fr.jpg', { kind: 'new', assetId: 'cfr' })]).groups)
      .toEqual([{ ids: ['cfr'], join: 'chart-es' }])
  })
})

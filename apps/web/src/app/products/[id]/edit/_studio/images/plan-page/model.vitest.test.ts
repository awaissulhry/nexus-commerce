import { describe, expect, it } from 'vitest'
import { applyMediaOps, type MediaPlan } from '@nexus/shared/media-plan'

import {
  applyLocal, computeLayouts, copyFromOps, destinationCells, filterLibrary, followAllOps, libraryUsage, setRows, showAsOptions,
  shownVersion, assetMap, viewAddress, withLayer, type LibraryAsset, type MediaDestinationRow, type MediaRead,
} from './model'

const ids = (...list: string[]) => list.map(assetId => ({ assetId }))
const plan = (sets: MediaPlan['sets'], axis?: string | null): MediaPlan => ({ version: 1, ...(axis !== undefined ? { axis } : {}), sets })
const asset = (id: string, extra: Partial<LibraryAsset> = {}): LibraryAsset => ({ id, productId: 'root', url: `https://cdn.test/${id}.jpg`, alt: null, mediaType: 'IMAGE',
  width: 1600, height: 1600, mimeType: 'image/jpeg', fileSize: 1000, languageTag: 'zxx', versionGroupId: null, label: id, ...extra })
const dest = (key: string, extra: Partial<MediaDestinationRow>): MediaDestinationRow => ({ key, channel: 'EBAY', marketplace: 'IT', markets: ['IT'], accountId: 'acc',
  accountLabel: 'Test eBay', accountActive: true, alias: null, languages: ['it'], listed: 3, productIds: ['n', 'g'], targetable: true, refusal: null, api: 'TRADING', ...extra })

const EBAY = 'LISTING:EBAY:IT:acc:', WINTER = 'LISTING:EBAY:IT:acc:winter', AMAZON = 'LISTING:AMAZON:GLOBAL:amz:'
function read(layers: Array<{ key: string; plan: MediaPlan }> = []): MediaRead {
  return {
    productId: 'root', rootId: 'root', sku: 'TEST', name: 'Test', mainLanguage: 'it',
    family: { productId: 'root', defaultAxis: 'color', valueOrder: { color: ['color:yellow', 'color:black'] }, valueLabels: { 'color:black': 'Nero', 'color:yellow': 'Giallo' },
      variants: [{ productId: 'n', sku: 'T-NERO', values: { color: 'color:black' }, included: true }, { productId: 'g', sku: 'T-GIALLO', values: { color: 'color:yellow' }, included: true }],
      axes: [{ code: 'color', label: 'Colore', dictionary: true, values: [] }], unmapped: [] },
    library: [asset('cover'), asset('n1'), asset('g1'), asset('chart-it', { languageTag: 'it', versionGroupId: 'chart' }), asset('chart-de', { languageTag: 'de', versionGroupId: 'chart' }), asset('spare')],
    layers: layers.map(l => {
      const [layer, channel = '', marketplace = '', accountId = '', aliasKey = ''] = l.key.split(':')
      return { key: l.key, layer: layer as 'SHARED', channel, marketplace, accountId, aliasKey, plan: l.plan, revision: 1 }
    }),
    destinations: [dest(EBAY, {}), dest(WINTER, { alias: { id: 'winter', label: 'Winter', position: 1 } }),
      dest(AMAZON, { channel: 'AMAZON', marketplace: 'GLOBAL', markets: ['IT', 'DE'], accountId: 'amz', languages: ['mul', 'it'], api: undefined })],
  }
}
const SHARED = plan({ common: ids('cover', 'chart-it'), values: { 'color:black': ids('cover', 'n1'), 'color:yellow': ids('g1') } }, 'color')

describe('Media page model', () => {
  it('rows follow the family value order and say where each set comes from', () => {
    const r = read([{ key: 'SHARED', plan: SHARED }, { key: WINTER, plan: plan({ values: { 'color:black': ids('n1') } }) }])
    expect(setRows(r, { layer: 'SHARED' }).map(x => `${x.label}:${x.items.join('+')}:${x.source}`)).toEqual(['Common:cover+chart-it:SHARED', 'Giallo:g1:SHARED', 'Nero:cover+n1:SHARED', 'Safety (Amazon PS01–PS06)::null'])
    const winter = setRows(r, { layer: 'LISTING', destination: WINTER })
    expect(winter.find(x => x.label === 'Nero')).toMatchObject({ items: ['n1'], source: 'LISTING', skus: ['T-NERO'] })
    expect(destinationCells(r, r.destinations[1]).map(c => `${c.label}:${c.source}:${c.count}`)).toEqual(['Common:shared:2', 'Giallo:shared:1', 'Nero:own:1'])
    // Amazon shows its safety set; eBay does not.
    expect(destinationCells(r, r.destinations[2]).map(c => c.label)).toContain('Safety')
  })
  it('the library says where each photo is used, counting language versions as the placed photo', () => {
    const r = read([{ key: 'SHARED', plan: SHARED }])
    const usage = libraryUsage(r)
    expect(usage.get('cover')).toEqual(['Common · main', 'Nero · main'])
    expect(usage.get('chart-de')).toEqual(['Common · 2'])
    expect(filterLibrary(r, usage, 'unused', '').map(a => a.id)).toEqual(['spare'])
    expect(filterLibrary(r, usage, 'text', 'chart').map(a => a.id)).toEqual(['chart-it', 'chart-de'])
  })
  it('local edits refuse what the server refuses and keep the layer shape the server stores', () => {
    const r = read([{ key: 'SHARED', plan: SHARED }])
    expect(() => applyLocal(r, { layer: 'SHARED' }, [{ op: 'insert', set: 'common', assetIds: ['chart-de'] }])).toThrow(/already in that set/)
    const own = applyLocal(r, { layer: 'LISTING', destination: WINTER }, [{ op: 'remove', set: 'value:color:black', assetId: 'cover' }])
    expect(own.layers.find(l => l.key === WINTER)).toMatchObject({ layer: 'LISTING', channel: 'EBAY', marketplace: 'IT', accountId: 'acc', aliasKey: 'winter', plan: { sets: { values: { 'color:black': ids('n1') } } } })
    // The server removes a layer that owns nothing; the page does the same.
    expect(withLayer(own, { layer: 'LISTING', destination: WINTER }, { version: 1, sets: {} }, 2).layers.some(l => l.key === WINTER)).toBe(false)
    expect(viewAddress(r, { layer: 'LISTING', destination: WINTER })).toEqual({ layer: 'LISTING', channel: 'EBAY', marketplace: 'IT', accountId: 'acc', aliasKey: 'winter' })
  })
  it('computes each destination\'s layout with the shared projection: eBay per market language, Amazon one set per ASIN', () => {
    const layouts = computeLayouts(read([{ key: 'SHARED', plan: SHARED }]))
    expect(layouts[EBAY]).toMatchObject({ gallery: ['cover', 'chart-it'] })
    expect((layouts[AMAZON] as { items: Array<{ sku: string; slots: Record<string, string> }> }).items.map(i => `${i.sku}:${i.slots.MAIN}`)).toEqual(['T-NERO:cover', 'T-GIALLO:g1'])
  })
  it('"Copy photos from" makes the target show the same photos with the fewest changes; "Follow all" drops every own set', () => {
    const r = read([{ key: 'SHARED', plan: SHARED }, { key: WINTER, plan: plan({ common: ids('spare'), values: { 'color:black': ids('n1') } }) }])
    const [primary, winter] = r.destinations
    const ops = copyFromOps(r, primary, winter)
    // Both sets Winter owns go back to following, which shows the primary listing's photos (it follows Shared).
    expect(ops).toEqual([{ op: 'follow', set: 'common' }, { op: 'follow', set: 'value:color:black' }])
    const after = applyMediaOps({ shared: SHARED, listing: r.layers[1].plan }, 'LISTING', ops)
    expect(after).toEqual({ version: 1, sets: {} })
    expect(copyFromOps(r, winter, primary)).toEqual([{ op: 'replace', set: 'common', assetIds: ['spare'] }, { op: 'replace', set: 'value:color:black', assetIds: ['n1'] }])
    expect(followAllOps(r, { layer: 'LISTING', destination: WINTER })).toEqual([{ op: 'follow', set: 'common' }, { op: 'follow', set: 'value:color:black' }])
    expect(followAllOps(r, { layer: 'SHARED' })).toEqual([])
  })
  it('"Show as" shows each market its language version, and says when it falls back', () => {
    const r = read([{ key: 'SHARED', plan: SHARED }])
    const assets = assetMap(r)
    expect(shownVersion(r, assets, 'chart-it', ['de'])).toEqual({ id: 'chart-de', exact: true, language: 'de' })
    expect(shownVersion(r, assets, 'chart-it', ['fr'])).toMatchObject({ exact: false })
    expect(shownVersion(r, assets, 'chart-it', null)).toEqual({ id: 'chart-it', exact: true, language: 'it' })
    expect(showAsOptions(r).map(o => o.label)).toEqual(['eBay IT · IT', 'Amazon (all markets) · IT'])
  })
})

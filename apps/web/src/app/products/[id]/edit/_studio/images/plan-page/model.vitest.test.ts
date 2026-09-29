import { describe, expect, it } from 'vitest'
import { applyMediaOps, type MediaPlan } from '@nexus/shared/media-plan'

import {
  applyLocal, compareDestinations, computeLayouts, copyFromOps, defaultKeep, destinationCells, destinationLabel, filterLibrary, guessLanguage, photoPlacements, photoSource, sharedPlacements, versionLanguages, followAllOps, libraryUsage, setRows, gridShape, isCodeName, ownerLabel, readableNames, scopeDestinationKey, siblingListings, slotLabel,
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
  it('one picture stored on several SKUs is one photo: its copies show its picture, count as its usage, and are never placed twice', () => {
    const r = read([{ key: 'SHARED', plan: plan({ common: ids('cover-kid'), values: { 'color:black': ids('n1') } }, 'color') }])
    r.library = r.library.map(a => a.id === 'cover' ? { ...a, copies: ['cover-kid', 'cover-kid2'] } : a)
    expect(assetMap(r).get('cover-kid')?.url).toBe('https://cdn.test/cover.jpg')
    // The plan points at a copy; the library card says where it is used.
    expect(libraryUsage(r).get('cover')).toEqual(['Common · main'])
    expect(() => applyLocal(r, { layer: 'SHARED' }, [{ op: 'insert', set: 'common', assetIds: ['cover'] }])).toThrow(/already in that set/)
    expect(() => applyLocal(r, { layer: 'SHARED' }, [{ op: 'insert', set: 'common', assetIds: ['cover-kid2'] }])).toThrow(/already in that set/)
  })
  it('Compare puts the chosen destinations\' sets side by side and names each difference against the first one', () => {
    const r = read([{ key: 'SHARED', plan: SHARED }, { key: WINTER, plan: plan({ common: ids('chart-de', 'cover'), values: { 'color:black': ids('n1', 'spare') } }) },
      { key: AMAZON, plan: plan({ skus: { n: ids('spare') }, safety: ids('spare') }) }])
    const rows = compareDestinations(r, [EBAY, WINTER, AMAZON])
    const row = (label: string) => rows.find(x => x.label === label)!
    // Common: Winter has the German version of the same chart, in another order — the same photos, reordered.
    expect(row('Common').cells.map(c => `${c.source}:${c.same}:${c.reordered}`)).toEqual(['shared:true:false', 'own:false:true', 'shared:true:false'])
    // Nero: Winter drops "cover" and adds "spare".
    expect(row('Nero').cells[1]).toMatchObject({ added: ['spare'], missing: ['cover'], same: false })
    expect(row('Giallo').same).toBe(true)
    // Safety and per-SKU photos are Amazon's: eBay cells do not apply, and the first cell that applies is the reference.
    expect(row('Safety').cells.map(c => c.applies)).toEqual([false, false, true])
    expect(row('Safety')).toMatchObject({ same: true })
    expect(rows.filter(x => x.kind === 'sku').map(x => x.label)).toEqual(['SKU T-NERO'])
    // An unknown or untargetable destination is left out; nothing chosen = nothing to compare.
    expect(compareDestinations(r, ['nope'])).toEqual([])
  })
  it('a market sees its language version of each photo, and the grid says when it falls back', () => {
    const r = read([{ key: 'SHARED', plan: SHARED }])
    const assets = assetMap(r)
    expect(shownVersion(r, assets, 'chart-it', ['de'])).toEqual({ id: 'chart-de', exact: true, language: 'de' })
    expect(shownVersion(r, assets, 'chart-it', ['fr'])).toMatchObject({ exact: false })
    expect(shownVersion(r, assets, 'chart-it', null)).toEqual({ id: 'chart-it', exact: true, language: 'it' })
  })

  it('names a listing with its mark (★ ①②③) only when its account and market hold more than one listing', () => {
    expect(destinationLabel(dest(EBAY, { listingMark: 0 }))).toBe('eBay IT · Test eBay · ★ Main listing')
    expect(destinationLabel(dest(WINTER, { alias: { id: 'winter', label: 'Winter', position: 1 }, listingMark: 1 }))).toBe('eBay IT · Test eBay · ① Winter')
    expect(destinationLabel(dest(EBAY, { listingMark: null }))).toBe('eBay IT · Test eBay · Main listing')
    expect(destinationLabel(dest(AMAZON, { channel: 'AMAZON', marketplace: 'GLOBAL', accountLabel: 'Test Amazon', listingMark: null }))).toBe('Amazon · Test Amazon')
  })
  it('warns both eBay listings on one account and market that would show the same photos, and stops when they differ', () => {
    const same = read([{ key: 'SHARED', plan: SHARED }])
    const warned = (r: MediaRead) => Object.entries(computeLayouts(r)).filter(([, l]) => l.checks.some(c => c.code === 'duplicate-listing-photos')).map(([k]) => k)
    expect(warned(same)).toEqual([EBAY, WINTER])
    expect(computeLayouts(same)[WINTER].checks.find(c => c.code === 'duplicate-listing-photos')?.message).toMatch(/^Same photos as Main listing on this account and market/)
    // Winter's own Nero set makes it different: no warning on either.
    expect(warned(read([{ key: 'SHARED', plan: SHARED }, { key: WINTER, plan: plan({ values: { 'color:black': ids('n1') } }) }]))).toEqual([])
  })

  it('look-alikes (W4a): the filter, where a photo sits in every layer, and which one to keep by default', () => {
    const r = read([{ key: 'SHARED', plan: SHARED }, { key: WINTER, plan: plan({ values: { 'color:black': ids('n1') }, swatches: { 'color:black': { assetId: 'n1' } } }) }])
    r.destinations[1].listingMark = 1
    r.library = r.library.map(a => a.id === 'spare' ? { ...a, lookalikes: [{ id: 'n1', distance: 4 }] } : a)
    expect(filterLibrary(r, new Map(), 'lookalikes', '').map(a => a.id)).toEqual(['spare'])
    expect(photoPlacements(r, ['n1'])).toEqual(['Shared: Nero', 'eBay IT · Test eBay · ① Winter: Nero', 'eBay IT · Test eBay · ① Winter: Nero swatch'])
    expect(photoPlacements(r, ['spare'])).toEqual([])
    expect(photoSource('https://m.media-amazon.com/images/I/81x.jpg')).toBe('Amazon image')
    expect(photoSource('https://res.cloudinary.com/x/a.jpg')).toBe('Nexus upload')
    const amazon = { ...r.library[0], id: 'amz', url: 'https://m.media-amazon.com/images/I/81x.jpg', width: 3000, height: 3000 }
    const ours = { ...r.library[0], id: 'ours', url: 'https://res.cloudinary.com/x/a.jpg', width: 1000, height: 1000 }
    // A Nexus upload wins over an Amazon image even when the Amazon one is larger.
    expect(defaultKeep(r, amazon, ours).id).toBe('ours')
    // Between two uploads: the one in more sets, then the larger.
    expect(defaultKeep(r, { ...ours, id: 'n1' }, { ...ours, id: 'spare' }).id).toBe('n1')
    expect(defaultKeep(r, { ...ours, id: 'x1' }, { ...ours, id: 'x2', width: 2000, height: 2000 }).id).toBe('x2')
  })

  it('language versions (W4b): the languages to offer, a guess from the name, and the sets that show both', () => {
    const r = read([{ key: 'SHARED', plan: plan({ common: ids('cover', 'spare') }) }, { key: WINTER, plan: plan({ common: ids('spare', 'cover') }) }])
    expect(versionLanguages(r)).toEqual(['de', 'it'])
    expect(guessLanguage({ ...r.library[0], label: 'size-chart-es', languageTag: 'zxx' })).toBe('es')
    expect(guessLanguage({ ...r.library[0], label: 'size chart', languageTag: 'zxx' })).toBe('')
    expect(guessLanguage({ ...r.library[0], label: 'size-chart-es', languageTag: 'fr' })).toBe('fr')
    const cover = r.library.find(a => a.id === 'cover')!, spare = r.library.find(a => a.id === 'spare')!, n1 = r.library.find(a => a.id === 'n1')!
    expect(sharedPlacements(r, cover, spare)).toEqual(['Shared: Common', 'eBay IT · Test eBay · Winter: Common'])
    expect(sharedPlacements(r, cover, n1)).toEqual([])
  })
})

describe('Media page redesign (2026-09-29): the grid, the scope and readable names', () => {
  it('names the slots of each set: MAIN and PT01…PT08, then numbers; safety PS01…', () => {
    expect([0, 1, 8, 9].map(i => slotLabel('value', i))).toEqual(['MAIN', 'PT01', 'PT08', '10'])
    expect(slotLabel('safety', 0)).toBe('PS01')
    expect(gridShape('EBAY').columns.slice(0, 3)).toEqual(['MAIN', '2', '3'])
    expect([gridShape('EBAY').capacity('common'), gridShape('EBAY').capacity('value'), gridShape('AMAZON').capacity('value'), gridShape(null).capacity('safety')]).toEqual([24, 12, 9, 6])
    expect(gridShape(null).slots('safety')?.[5]).toBe('PS06')
  })
  it('finds the destination the scope selector points at: eBay per market and listing, Amazon per account', () => {
    expect(scopeDestinationKey({ channel: 'EBAY', marketplace: 'IT', accountId: 'acc', aliasKey: 'winter' })).toBe(WINTER)
    expect(scopeDestinationKey({ channel: 'EBAY', marketplace: 'DE', accountId: 'acc', aliasKey: null })).toBe('LISTING:EBAY:DE:acc:')
    expect(scopeDestinationKey({ channel: 'AMAZON', marketplace: 'DE', accountId: 'amz', aliasKey: 'x' })).toBe(AMAZON)
    expect(scopeDestinationKey(null)).toBeNull()
  })
  it('marks a row that is not Shared with its owner, naming the listing when the market holds several', () => {
    const r = read([{ key: 'SHARED', plan: SHARED }])
    r.destinations[1].listingMark = 1
    expect(siblingListings(r, r.destinations[1]).map(d => d.key)).toEqual([EBAY, WINTER])
    expect(ownerLabel(r, { source: 'LISTING' }, r.destinations[1])).toBe('Own for ① Winter')
    expect(ownerLabel(r, { source: 'LISTING' }, r.destinations[2])).toBe('Own for Amazon')
    expect(ownerLabel(r, { source: 'CHANNEL' }, r.destinations[0])).toBe('Own for all eBay listings')
    expect(ownerLabel(r, { source: 'SHARED' }, r.destinations[0])).toBeNull()
  })
  it('gives storage-code photos a readable name from where they sit; real names stay', () => {
    expect(['vija9w5xgwhywk2ld7hq.jpg', 'PT02', 'MAIN', '81Kp1xYzA7L._AC_SL1500_.jpg', '71AbC+dEfGL.jpg'].map(isCodeName)).toEqual([true, true, true, true, true])
    expect(['Size chart IT', 'CE user information sheet', 'common-1', 'abcdefghijklmnopq'].map(isCodeName)).toEqual([false, false, false, false])
    const r = read([{ key: 'SHARED', plan: plan({ common: ids('c0de0000000000001', 'chart-it'), values: { 'color:black': ids('n1') } }, 'color') },
      { key: WINTER, plan: plan({ values: { 'color:black': ids('w1nter00000000001') } }) }])
    r.library = [...r.library, asset('c0de0000000000001'), asset('w1nter00000000001'), asset('l0st0000000000001'), asset('l0st0000000000002'),
      asset('de0000000000000001', { languageTag: 'de', versionGroupId: 'v' }), asset('it0000000000000001', { languageTag: 'it', versionGroupId: 'v' })]
    r.layers[0].plan.sets.safety = ids('it0000000000000001')
    const names = readableNames(r)
    expect(names.get('c0de0000000000001')).toBe('Common MAIN')
    expect(names.get('chart-it')).toBe('chart-it')
    expect(names.get('w1nter00000000001')).toBe('Nero MAIN')
    expect([names.get('l0st0000000000001'), names.get('l0st0000000000002')]).toEqual(['Unused photo 1', 'Unused photo 2'])
    expect([names.get('de0000000000000001'), names.get('it0000000000000001')]).toEqual(['Safety PS01 · DE', 'Safety PS01 · IT'])
  })
})

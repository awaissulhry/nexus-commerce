import { describe, expect, it } from 'vitest'
import type { MediaPlan } from '@nexus/shared/media-plan'

import type { LibraryAsset, MediaDestinationRow, MediaRead } from '../images/plan-page/model'
import {
  POPUP_TEXT, addItem, afterSave, cellAfterSave, changedSince, checks, followAgain, initialDraft, landedAnyway, localRefusal, mainRef, moveItem, planBase, planView,
  refusalSentence, removeItem, removePicture, saveLine, saveOps, setSkuOnly, setSource, setTitle, tiles,
} from './mediaPopupModel'

// A made-up family: two colours, three SKUs (two black sizes, one yellow), photos with made-up ids.
const ids = (...list: string[]) => list.map(assetId => ({ assetId }))
const plan = (sets: MediaPlan['sets'], axis?: string | null): MediaPlan => ({ version: 1, ...(axis !== undefined ? { axis } : {}), sets })
const asset = (id: string, extra: Partial<LibraryAsset> = {}): LibraryAsset => ({ id, productId: 'root', url: `https://cdn.test/${id}.jpg`, alt: null, mediaType: 'IMAGE',
  width: 1600, height: 1600, mimeType: 'image/jpeg', fileSize: 1000, languageTag: 'zxx', versionGroupId: null, label: id, ...extra })
const dest = (key: string, extra: Partial<MediaDestinationRow> = {}): MediaDestinationRow => ({ key, channel: 'EBAY', marketplace: 'IT', markets: ['IT'], accountId: 'acc',
  accountLabel: 'Test eBay', accountActive: true, alias: null, languages: ['it'], listed: 3, productIds: ['b-s', 'b-m', 'y-s'], targetable: true, refusal: null, api: 'TRADING', ...extra })

const EBAY = 'LISTING:EBAY:IT:acc:'
const AMAZON = 'LISTING:AMAZON:GLOBAL:amz:'
function read(layers: Array<{ key: string; plan: MediaPlan }>, library: LibraryAsset[] = LIBRARY): MediaRead {
  return {
    productId: 'root', rootId: 'root', sku: 'LAB', name: 'Lab', mainLanguage: 'it',
    family: { productId: 'root', defaultAxis: 'color', valueOrder: { color: ['color:black', 'color:yellow'] }, valueLabels: { 'color:black': 'Nero', 'color:yellow': 'Giallo' },
      variants: [
        { productId: 'b-s', sku: 'LAB-BLACK-S', values: { color: 'color:black' }, included: true },
        { productId: 'b-m', sku: 'LAB-BLACK-M', values: { color: 'color:black' }, included: true },
        { productId: 'y-s', sku: 'LAB-YELLOW-S', values: { color: 'color:yellow' }, included: true },
      ],
      axes: [{ code: 'color', label: 'Colore', dictionary: true, values: [] }], unmapped: [] },
    library,
    layers: layers.map(l => {
      const [layer, channel = '', marketplace = '', accountId = '', aliasKey = ''] = l.key.split(':')
      return { key: l.key, layer: layer as 'SHARED', channel, marketplace, accountId, aliasKey, plan: l.plan, revision: 1 }
    }),
    destinations: [dest(EBAY), dest(AMAZON, { channel: 'AMAZON', marketplace: 'GLOBAL', markets: ['IT'], accountId: 'amz', languages: ['mul', 'it'], api: undefined })],
  }
}
const LIBRARY = [asset('cover'), asset('b1'), asset('b2'), asset('y1'), asset('small', { width: 420, height: 300 }),
  asset('chart-it', { languageTag: 'it', versionGroupId: 'chart' }), asset('chart-de', { languageTag: 'de', versionGroupId: 'chart' })]
const SHARED = plan({ common: ids('cover', 'chart-it'), values: { 'color:black': ids('b1', 'b2'), 'color:yellow': ids('y1') } }, 'color')
const onShared = { layer: 'SHARED' as const }
const onEbay = { layer: 'LISTING' as const, channel: 'EBAY', marketplace: 'IT', accountId: 'acc', aliasKey: '' }

describe('which set a cell edits, and where', () => {
  it('Shared sheet: the parent edits Common; a variant edits its colour, shared by every SKU of the colour', () => {
    const r = read([{ key: 'SHARED', plan: SHARED }])
    const parent = planBase(r, { rowProductId: 'root', address: onShared })
    expect(parent.variant).toBeNull()
    expect(mainRef(parent, { skuOnly: false })).toBe('common')
    expect(setTitle(parent, initialDraft(r, parent))).toEqual({ label: 'Common', detail: '2 photos · every variant' })
    const black = planBase(r, { rowProductId: 'b-s', address: onShared })
    expect(black).toMatchObject({ valueRef: 'value:color:black', valueLabel: 'Nero', valueSkus: 2, skuOnly: false, skuElsewhere: false })
    expect(initialDraft(r, black)).toEqual({ skuOnly: false, items: ['b1', 'b2'], follow: false })
    expect(setTitle(black, initialDraft(r, black))).toEqual({ label: 'Nero', detail: '2 photos · used by 2 SKUs' })
  })
  it('channel sheet: the listing\'s own layer, keyed like the Media page (Amazon and Etsy per account)', () => {
    const r = read([{ key: 'SHARED', plan: SHARED }])
    expect(planView(r, onEbay)).toMatchObject({ view: { layer: 'LISTING', destination: EBAY }, refusal: null })
    expect(planView(r, { layer: 'LISTING', channel: 'AMAZON', marketplace: 'DE', accountId: 'amz', aliasKey: 'ignored' })).toMatchObject({ view: { layer: 'LISTING', destination: AMAZON } })
  })
  it('says why it cannot edit: no account, not a destination, a destination with a refusal', () => {
    const r = read([{ key: 'SHARED', plan: SHARED }])
    expect(planView(r, null)).toMatchObject({ view: null, refusal: POPUP_TEXT.noAccount })
    expect(planView(r, { ...onEbay, marketplace: 'DE' })).toMatchObject({ view: null, refusal: POPUP_TEXT.notDestination })
    const archived = { ...r, destinations: [dest(EBAY, { targetable: false, refusal: 'This listing alias is archived.' })] }
    expect(planView(archived, onEbay)).toMatchObject({ view: null, refusal: 'This listing alias is archived.' })
  })
  it('a SKU set on Shared, seen from a channel sheet, is changed on Shared', () => {
    const r = read([{ key: 'SHARED', plan: plan({ ...SHARED.sets, skus: { 'b-s': ids('b2') } }, 'color') }])
    expect(planBase(r, { rowProductId: 'b-s', address: onShared })).toMatchObject({ skuOnly: true, skuElsewhere: false })
    expect(planBase(r, { rowProductId: 'b-s', address: onEbay })).toMatchObject({ skuOnly: true, skuElsewhere: true })
  })
})

describe('Enter sends ONE change, bound to what the layer held when the pop-up opened', () => {
  const r = read([{ key: 'SHARED', plan: SHARED }])
  const black = planBase(r, { rowProductId: 'b-s', address: onShared })
  it('no change, no request', () => {
    expect(saveOps(r, black, initialDraft(r, black))).toEqual([])
    // Moving a photo back where it was is no change either.
    expect(saveOps(r, black, moveItem(moveItem(initialDraft(r, black), 'b2', 0), 'b2', 1))).toEqual([])
  })
  it('a reorder replaces the set, expecting what Shared holds', () => {
    expect(saveOps(r, black, moveItem(initialDraft(r, black), 'b2', 0))).toEqual([{ op: 'replace', set: 'value:color:black', assetIds: ['b2', 'b1'], expect: ['b1', 'b2'] }])
  })
  it('on a listing that follows Shared, the first change makes it own (expect: it owned nothing)', () => {
    const base = planBase(r, { rowProductId: 'b-s', address: onEbay })
    const draft = removeItem(initialDraft(r, base), 'b2')
    expect(setSource(r, base, initialDraft(r, base))).toBe('shared')
    expect(setSource(r, base, draft)).toBe('own')
    expect(saveOps(r, base, draft)).toEqual([{ op: 'replace', set: 'value:color:black', assetIds: ['b1'], expect: null }])
  })
  it('"Follow Shared again" drops the listing\'s copy, expecting that copy', () => {
    const owned = read([{ key: 'SHARED', plan: SHARED }, { key: EBAY, plan: plan({ values: { 'color:black': ids('b2') } }) }])
    const base = planBase(owned, { rowProductId: 'b-s', address: onEbay })
    expect(initialDraft(owned, base).items).toEqual(['b2'])
    const back = followAgain(owned, base, initialDraft(owned, base))
    expect(back.items).toEqual(['b1', 'b2'])
    expect(saveOps(owned, base, back)).toEqual([{ op: 'follow', set: 'value:color:black', expect: ['b2'] }])
    // Editing after "follow again" makes it own again; ending where the listing already is sends nothing.
    expect(saveOps(owned, base, removeItem(back, 'b2'))).toEqual([{ op: 'replace', set: 'value:color:black', assetIds: ['b1'], expect: ['b2'] }])
    expect(saveOps(owned, base, removeItem(back, 'b1'))).toEqual([])
  })
  it('"Only this SKU": ticked starts from the colour\'s photos; unticked follows the colour again', () => {
    const on = setSkuOnly(r, black, initialDraft(r, black), true)
    expect(saveOps(r, black, on)).toEqual([{ op: 'replace', set: 'sku:b-s', assetIds: ['b1', 'b2'], expect: null }])
    const withSku = read([{ key: 'SHARED', plan: plan({ ...SHARED.sets, skus: { 'b-s': ids('b2') } }, 'color') }])
    const base = planBase(withSku, { rowProductId: 'b-s', address: onShared })
    const off = setSkuOnly(withSku, base, initialDraft(withSku, base), false)
    expect(off.items).toEqual(['b1', 'b2'])
    expect(saveOps(withSku, base, off)).toEqual([{ op: 'follow', set: 'sku:b-s', expect: ['b2'] }])
    // Unticked AND the colour changed: both in the one request.
    expect(saveOps(withSku, base, removeItem(off, 'b1'))).toEqual([{ op: 'follow', set: 'sku:b-s', expect: ['b2'] }, { op: 'replace', set: 'value:color:black', assetIds: ['b2'], expect: ['b1', 'b2'] }])
  })
})

describe('review findings (2026-09-28)', () => {
  it('unticking "Only this SKU" and then "Follow Shared again" sends both follows', () => {
    const r = read([{ key: 'SHARED', plan: plan({ ...SHARED.sets, values: { ...SHARED.sets.values, 'color:black': ids('b1', 'b2', 'cover') } }, 'color') },
      { key: EBAY, plan: plan({ values: { 'color:black': ids('b1', 'b2') }, skus: { 'b-s': ids('b2') } }) }])
    const base = planBase(r, { rowProductId: 'b-s', address: onEbay })
    const off = setSkuOnly(r, base, initialDraft(r, base), false)
    const back = followAgain(r, base, off)
    expect(back.items).toEqual(['b1', 'b2', 'cover'])
    expect(saveOps(r, base, back)).toEqual([{ op: 'follow', set: 'sku:b-s', expect: ['b2'] }, { op: 'follow', set: 'value:color:black', expect: ['b1', 'b2'] }])
  })
  it('a SKU set this listing owns AND Shared owns: "Only this SKU" is changed on Shared', () => {
    const r = read([{ key: 'SHARED', plan: plan({ ...SHARED.sets, skus: { 'b-s': ids('b1') } }, 'color') }, { key: EBAY, plan: plan({ skus: { 'b-s': ids('b2') } }) }])
    expect(planBase(r, { rowProductId: 'b-s', address: onEbay })).toMatchObject({ skuOnly: true, skuElsewhere: true })
    // Only the listing owns it: unticking here is right.
    const own = read([{ key: 'SHARED', plan: SHARED }, { key: EBAY, plan: plan({ skus: { 'b-s': ids('b2') } }) }])
    expect(planBase(own, { rowProductId: 'b-s', address: onEbay })).toMatchObject({ skuOnly: true, skuElsewhere: false })
  })
  it('a change to the set a listing FOLLOWS is seen, so the save does not freeze an old copy', () => {
    const r = read([{ key: 'SHARED', plan: SHARED }])
    const base = planBase(r, { rowProductId: 'b-s', address: onEbay })
    const sharedChanged = read([{ key: 'SHARED', plan: plan({ ...SHARED.sets, values: { ...SHARED.sets.values, 'color:black': ids('b1', 'b2', 'y1') } }, 'color') }])
    expect(changedSince(r, sharedChanged, base)).toBe(true)
    expect(changedSince(r, read([{ key: 'SHARED', plan: SHARED }]), base)).toBe(false)
    // A new photo in the library (an upload) is not a change of the set.
    expect(changedSince(r, read([{ key: 'SHARED', plan: SHARED }], [...LIBRARY, asset('new')]), base)).toBe(false)
    // Another colour's set is not this row's.
    expect(changedSince(r, read([{ key: 'SHARED', plan: plan({ ...SHARED.sets, values: { ...SHARED.sets.values, 'color:yellow': ids('y1', 'cover') } }, 'color') }]), base)).toBe(false)
    expect(changedSince(r, null, base)).toBe(false)
  })
  it('a lost answer: the save landed when the photos are exactly what it makes, not when they are unchanged', () => {
    const r = read([{ key: 'SHARED', plan: SHARED }])
    const black = planBase(r, { rowProductId: 'b-s', address: onShared })
    const ops = saveOps(r, black, moveItem(initialDraft(r, black), 'b2', 0))
    expect(landedAnyway(r, afterSave(r, black, ops), black, ops)).toBe(true)
    expect(landedAnyway(r, r, black, ops)).toBe(false)
    expect(landedAnyway(r, null, black, ops)).toBe(false)
    expect(landedAnyway(r, r, black, [])).toBe(false)
  })
})

describe('refusals', () => {
  const r = read([{ key: 'SHARED', plan: SHARED }])
  const parent = planBase(r, { rowProductId: 'root', address: onShared })
  it('a language version of a photo already in the set is not added twice', () => {
    const draft = initialDraft(r, parent)
    expect(addItem(r, draft, 'chart-de')).toBe(draft)
    expect(removePicture(r, draft, 'chart-de').items).toEqual(['cover'])
  })
  it('the local check refuses what the server refuses, before any request', () => {
    expect(localRefusal(r, parent, [{ op: 'replace', set: 'common', assetIds: ['cover', 'chart-it', 'chart-de'], expect: ['cover', 'chart-it'] }])).toBe('The same photo was added twice.')
    expect(localRefusal(r, parent, [{ op: 'replace', set: 'common', assetIds: ['chart-it', 'cover'], expect: ['cover', 'chart-it'] }])).toBeNull()
  })
  it('a set someone changed meanwhile is said plainly; any other refusal keeps the server\'s words', () => {
    const ops = saveOps(r, parent, moveItem(initialDraft(r, parent), 'chart-it', 0))
    const changed = read([{ key: 'SHARED', plan: plan({ ...SHARED.sets, common: ids('cover') }, 'color') }])
    expect(refusalSentence(changed, parent, ops, 'These photos changed since your edit, so it cannot be undone. Nothing was changed.')).toBe(POPUP_TEXT.conflict)
    expect(refusalSentence(r, parent, ops, 'A photo is not in this product\'s library any more. Reload the page.')).toBe('A photo is not in this product\'s library any more. Reload the page.')
    expect(refusalSentence(null, parent, ops, 'The server could not be reached.')).toBe('The server could not be reached.')
  })
})

describe('what the pop-up shows', () => {
  it('channel sheet: that channel\'s own checks for this set (the publishers\' projection)', () => {
    const r = read([{ key: 'SHARED', plan: SHARED }])
    const base = planBase(r, { rowProductId: 'y-s', address: onEbay })
    const draft = addItem(r, initialDraft(r, base), 'small')
    expect(checks(r, base, draft)).toContainEqual({ severity: 'error', message: 'small is 420 px — eBay needs 500 px on the longest side.' })
    expect(checks(r, base, removeItem(initialDraft(r, base), 'y1'))).toContainEqual({ severity: 'error', message: 'Giallo has no photos — eBay would show "no picture available".' })
    expect(checks(r, base, initialDraft(r, base))).toEqual([])
    expect(saveLine(base, initialDraft(r, base))).toBe('Saves in Nexus · Publish sends it to eBay')
  })
  it('a check tied to a photo and not to a set (Amazon\'s size rule) is shown for this set\'s photos only', () => {
    const r = read([{ key: 'SHARED', plan: SHARED }])
    const amazon = { layer: 'LISTING' as const, channel: 'AMAZON', marketplace: 'IT', accountId: 'amz', aliasKey: '' }
    const base = planBase(r, { rowProductId: 'y-s', address: amazon })
    expect(checks(r, base, addItem(r, initialDraft(r, base), 'small'))).toContainEqual({ severity: 'error', message: 'small is 420 px — Amazon needs 500 px.' })
    expect(checks(r, base, initialDraft(r, base))).toEqual([])
  })
  it('Shared sheet: each photo\'s own problems, and a deleted photo', () => {
    const r = read([{ key: 'SHARED', plan: plan({ ...SHARED.sets, common: ids('cover', 'gone') }, 'color') }])
    const parent = planBase(r, { rowProductId: 'root', address: onShared })
    const found = checks(r, parent, addItem(r, initialDraft(r, parent), 'small'))
    expect(found).toContainEqual({ severity: 'error', message: 'A photo in this set was deleted from the library. Remove it or add it again.' })
    expect(found).toContainEqual({ severity: 'error', message: 'small: 420 px — eBay and Amazon need 500 px on the longest side.' })
    expect(saveLine(parent, initialDraft(r, parent))).toBe('Saves in Nexus · every channel follows it unless a listing has its own')
    const black = planBase(r, { rowProductId: 'b-s', address: onShared })
    expect(saveLine(black, initialDraft(r, black))).toBe('Saves in Nexus · every SKU of this value changes together')
    expect(saveLine(black, setSkuOnly(r, black, initialDraft(r, black), true))).toBe('Saves in Nexus · only this SKU changes')
  })
  it('tiles show the sheet language\'s version, say when it is not that language, and mark Common photos', () => {
    const r = read([{ key: 'SHARED', plan: plan({ ...SHARED.sets, values: { ...SHARED.sets.values, 'color:black': ids('b1', 'chart-it') } }, 'color') }])
    const black = planBase(r, { rowProductId: 'b-s', address: onShared })
    const [b1, chart] = tiles(r, black, initialDraft(r, black), 'de')
    expect(b1).toMatchObject({ id: 'b1', language: null, alsoInCommon: false })
    expect(chart).toMatchObject({ id: 'chart-it', label: 'chart-de', language: 'de', exact: true, alsoInCommon: true })
    expect(tiles(r, black, initialDraft(r, black), 'fr')[1]).toMatchObject({ exact: false })
  })
  it('the cells after Enter: every SKU of the colour shows the new set, then the Common photos it does not show', () => {
    const r = read([{ key: 'SHARED', plan: SHARED }])
    const black = planBase(r, { rowProductId: 'b-s', address: onShared })
    const ops = saveOps(r, black, moveItem(addItem(r, initialDraft(r, black), 'cover'), 'cover', 0))
    const next = { ...r, layers: r.layers.map(l => ({ ...l, plan: plan({ ...SHARED.sets, values: { ...SHARED.sets.values, 'color:black': ids('cover', 'b1', 'b2') } }, 'color') })) }
    expect(ops).toHaveLength(1)
    for (const sku of ['b-s', 'b-m']) {
      const cell = cellAfterSave(next, black, sku, 'it')
      expect(cell.set).toEqual({ ref: 'value:color:black', label: 'Nero', sharedBy: 2 })
      expect(cell.items.map(i => `${i.id}${i.muted ? '*' : ''}`)).toEqual(['cover', 'b1', 'b2', 'chart-it*'])
    }
    expect(cellAfterSave(next, black, 'y-s', 'it').items.map(i => i.id)).toEqual(['y1', 'cover', 'chart-it'])
  })
})

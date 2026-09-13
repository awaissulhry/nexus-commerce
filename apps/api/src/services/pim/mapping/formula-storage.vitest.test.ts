import { describe, expect, it } from 'vitest'
import { formulaStorage, formulaStoragePatch } from './formula-storage.js'
const coord = { productId: 'fixture', scope: 'master' as const, fieldKey: 'brand' }
const col = { key: 'brand', writeField: 'attr_brand', writeTarget: 'master', storage: 'categoryAttributes' } as any
const set = { coordinates: [{ label: 'Amazon Italy', channel: 'AMAZON', marketplace: 'IT' }] } as any

describe('formula undo storage', () => {
  it('restores absence while preserving unrelated attributes and inheritance markers', () => {
    const storage = formulaStorage(coord, col, set, { categoryAttributes: {}, cascadedFields: ['attr_brand'] }, null)
    expect(formulaStoragePatch(storage, { categoryAttributes: { brand: 'Applied', material: 'Cotton' }, cascadedFields: ['name'] })).toEqual({ categoryAttributes: { material: 'Cotton' }, cascadedFields: ['name', 'attr_brand'] })
  })
  it('distinguishes an explicit empty value from an absent attribute', () => {
    const storage = formulaStorage(coord, col, set, { categoryAttributes: { brand: null } }, null)
    expect(formulaStoragePatch(storage, { categoryAttributes: { brand: 'Applied' } })).toEqual({ categoryAttributes: { brand: null }, cascadedFields: [] })
  })
  // LX.F R-LX-13 (fixture drift, not a code defect). These two arms used a BRAND
  // column (`key: 'brand'`, `storage: 'categoryAttributes'`) with the write field
  // swapped to `amazon_title` — a shape the real column builder never produces:
  // the studio's channel sheet is MASTER-keyed (`key: 'name'`, `writeField:
  // 'amazon_title'`), which is why the legacy-restore refusal they now hit is
  // unreachable in production. Re-pointed at the writer-produced shape, and they
  // now assert LX's addressed capture — the contract that replaced the legacy one.
  it('captures a channel title through the ADDRESSED content path, not the legacy columns', () => {
    const column = { key: 'name', writeField: 'amazon_title', writeTarget: 'channelListing', storage: 'column' } as any
    const storage = formulaStorage({ ...coord, fieldKey: 'name', scope: 'channel', channel: 'AMAZON', marketplace: 'IT', locale: 'de' }, column, set, {}, { title: 'Snapshot', titleOverride: null, followMasterTitle: true, overrideData: { item_name: 'Legacy' }, translations: [] })
    expect(storage.content).toMatchObject({ address: { tier: 'pin', language: 'de', coordinate: { channel: 'AMAZON', market: 'IT' } }, reset: ['title'] })
    // An addressed capture restores through the sheet writer, so the legacy patch is empty by construction.
    expect(formulaStoragePatch(storage, { overrideData: { title: 'Applied', unrelated: 'Keep' } })).toEqual({})
  })
  it('captures a channel bullet list through the addressed content path', () => {
    const column = { key: 'bulletPoints', writeField: 'amazon_bulletPoints[1]', writeTarget: 'channelListing', storage: 'column', slot: { of: 'bulletPoints', index: 1 } } as any
    const storage = formulaStorage({ ...coord, fieldKey: 'bulletPoints', scope: 'channel', channel: 'AMAZON', marketplace: 'IT', locale: 'de' }, column, set, {}, { bulletPointsOverride: ['One', '', 'Three'], followMasterBulletPoints: false, translations: [] })
    expect(storage.content?.address).toMatchObject({ tier: 'pin', language: 'de' })
    expect(formulaStoragePatch(storage, {})).toEqual({})
  })
  // POSITIVE CONTROL for the legacy path, which is still the right answer for a
  // FACTUAL channel field: the ordinary writer map, no content address.
  it('still captures a factual channel field through the ordinary writer map', () => {
    const column = { ...col, writeTarget: 'channelListing', writeField: 'attr_brand' }
    const storage = formulaStorage({ ...coord, scope: 'channel', channel: 'AMAZON', marketplace: 'IT' }, column, set, {}, { overrideData: { attr_brand: 'Legacy' } })
    expect(storage.content).toBeUndefined()
    expect(formulaStoragePatch(storage, { overrideData: { attr_brand: 'Applied', unrelated: 'Keep' } })).toMatchObject({ overrideData: { unrelated: 'Keep' } })
  })
  it('restores one nested channel path without replacing its siblings', () => {
    const column = { ...col, writeTarget: 'channelListing', channels: { 'Amazon Italy': { store: { kind: 'platformAttributes', path: ['specifics', 'brand'] } } } }
    const storage = formulaStorage({ ...coord, scope: 'channel', channel: 'AMAZON', marketplace: 'IT' }, column, set, {}, { platformAttributes: { specifics: {} } })
    expect(formulaStoragePatch(storage, { platformAttributes: { specifics: { brand: 'Applied', material: 'Cotton' } } })).toMatchObject({ platformAttributes: { specifics: { material: 'Cotton' } } })
  })
})

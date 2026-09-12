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
  it('captures all title aliases and follow flags using the ordinary writer map', () => {
    const column = { ...col, writeTarget: 'channelListing', writeField: 'amazon_title' }
    const storage = formulaStorage({ ...coord, scope: 'channel', channel: 'AMAZON', marketplace: 'IT' }, column, set, {}, { title: 'Snapshot', titleOverride: null, followMasterTitle: true, overrideData: { item_name: 'Legacy' } })
    expect(formulaStoragePatch(storage, { overrideData: { title: 'Applied', unrelated: 'Keep' } })).toMatchObject({ title: 'Snapshot', titleOverride: null, followMasterTitle: true, overrideData: { item_name: 'Legacy', unrelated: 'Keep' } })
  })
  it('captures an entire list for a slot, preserving empty positions', () => {
    const storage = formulaStorage(coord, { ...col, writeField: 'amazon_bulletPoints[1]', writeTarget: 'channelListing' }, set, {}, { bulletPointsOverride: ['One', '', 'Three'], followMasterBulletPoints: false })
    expect(formulaStoragePatch(storage, {})).toMatchObject({ bulletPointsOverride: ['One', '', 'Three'], followMasterBulletPoints: false })
  })
  it('restores one nested channel path without replacing its siblings', () => {
    const column = { ...col, writeTarget: 'channelListing', channels: { 'Amazon Italy': { store: { kind: 'platformAttributes', path: ['specifics', 'brand'] } } } }
    const storage = formulaStorage({ ...coord, scope: 'channel', channel: 'AMAZON', marketplace: 'IT' }, column, set, {}, { platformAttributes: { specifics: {} } })
    expect(formulaStoragePatch(storage, { platformAttributes: { specifics: { brand: 'Applied', material: 'Cotton' } } })).toMatchObject({ platformAttributes: { specifics: { material: 'Cotton' } } })
  })
})

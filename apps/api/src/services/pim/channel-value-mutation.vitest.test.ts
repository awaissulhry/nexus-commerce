import { describe, expect, it } from 'vitest'
import { applyPlatformMutations, channelValueMutation, channelValuePatch, storedChannelState, type ValueRecord } from './channel-value-mutation.js'
import { readStoredChannelValue } from './channel-inheritance.js'
import type { ChannelStore } from './channel-specs/types.js'

const cases: Array<{ name: string; store?: ChannelStore; keys: string[]; value: unknown }> = [
  { name: 'text', keys: ['material', 'fabric_type'], value: 'Leather' },
  { name: 'boolean', keys: ['exemption'], value: false },
  { name: 'price', store: { kind: 'listingColumn', column: 'price', followFlag: 'followMasterPrice' }, keys: ['price'], value: 0 },
  { name: 'title', store: { kind: 'listingColumn', column: 'title', followFlag: 'followMasterTitle' }, keys: ['name', 'item_name'], value: 'Listing title' },
  { name: 'list', store: { kind: 'listingColumn', column: 'bulletPointsOverride', followFlag: 'followMasterBulletPoints' }, keys: ['bulletPoints', 'bullet_point'], value: ['One', '', 'Three'] },
  { name: 'measure', store: { kind: 'platformAttributes', path: ['package', 'weight'], unitPath: ['package', 'unit'] }, keys: ['weight'], value: { value: 0, unit: 'kg' } },
  { name: 'platform setting', store: { kind: 'platformAttributes', path: ['itemSpecifics', 'Brand'] }, keys: ['brand'], value: 'Listing brand' },
]

describe('one stored-value contract for editor, import and mapping', () => {
  it.each(['_nexusLinkedAutomation', '_nexusLinkedProducts', '_nexusLinkedProductsOperation'])('prevents imports and mapped edits from changing %s', key => {
    expect(() => channelValueMutation({ kind: 'platformAttributes', path: [key, 'mode'] }, ['x'], 'SET', 'AUTOMATIC')).toThrow('Shopify family workspace')
    expect(() => applyPlatformMutations({}, [{ path: [key], value: {}, remove: true }])).toThrow('Shopify family workspace')
  })
  it('refuses whole attribute-column replacements and preserves managed state during ordinary path edits', () => {
    expect(() => channelValueMutation({ kind: 'listingColumn', column: 'platformAttributes' }, ['x'], 'SET', {})).toThrow('validated platform-attribute path')
    const original = { _nexusLinkedAutomation: { mode: 'PAUSED' }, colour: 'Red' }
    expect(applyPlatformMutations(original, [{ path: ['colour'], value: 'Blue', remove: false }])).toEqual({ ...original, colour: 'Blue' })
    expect(original.colour).toBe('Red')
  })
  it.each(cases)('$name: set → read → clear → read → inherit → read', ({ store, keys, value }) => {
    let listing: ValueRecord = { overrideData: { unrelated: 'keep' }, platformAttributes: { policies: { returns: 'keep' } } }
    const original = JSON.stringify(listing)
    const patch = channelValuePatch(listing, store, keys, 'SET', value)
    expect(JSON.stringify(listing)).toBe(original)
    listing = { ...listing, ...patch }
    expect(storedChannelState(listing, store, keys)).toEqual({ state: 'stored', value })
    expect(readStoredChannelValue(store, listing, keys)).toEqual(store?.kind === 'platformAttributes' && store.unitPath ? (value as any).value : value)
    listing = { ...listing, ...channelValuePatch(listing, store, keys, 'CLEAR') }
    expect(storedChannelState(listing, store, keys)).toEqual({ state: 'stored', value: store?.kind === 'listingColumn' && store.column === 'bulletPointsOverride' ? [] : null })
    listing = { ...listing, ...channelValuePatch(listing, store, keys, 'INHERIT') }
    expect(storedChannelState(listing, store, keys)).toEqual({ state: 'inherited', value: null })
    expect(readStoredChannelValue(store, listing, keys)).toBeUndefined()
    expect(listing.overrideData).toEqual({ unrelated: 'keep' })
    expect((listing.platformAttributes as any).policies).toEqual({ returns: 'keep' })
  })

  it('deletes a legacy override under a second field name when setting the canonical field', () => {
    const patch = channelValuePatch({ overrideData: { fabric_type: 'Stale', retain: 1 } }, undefined, ['material', 'fabric_type'], 'SET', 'Cotton')
    expect(patch.overrideData).toEqual({ material: 'Cotton', retain: 1 })
    expect(channelValueMutation(undefined, ['material', 'fabric_type'], 'SET', 'Cotton')).toMatchObject({ overrideSet: { material: 'Cotton' }, overrideRemove: ['fabric_type'] })
  })

  it('resetting an absent nested field does not invent empty parent objects', () => {
    expect(channelValuePatch({ platformAttributes: { retained: true } }, { kind: 'platformAttributes', path: ['missing', 'field'] }, ['field'], 'INHERIT').platformAttributes).toEqual({ retained: true })
  })

  it('normalizes imported bullet positions for the database without moving later values', () => {
    const store = { kind: 'listingColumn' as const, column: 'bulletPointsOverride', followFlag: 'followMasterBulletPoints' }
    expect(channelValuePatch({}, store, ['bulletPoints'], 'SET', [' First ', null, 3]).bulletPointsOverride).toEqual(['First', '', '3'])
    expect(() => channelValuePatch({}, store, ['bulletPoints'], 'SET', [{ value: 'object' }])).toThrow('simple values')
  })

  it('refuses unsafe paths and keys before constructing a mutation', () => {
    expect(() => channelValueMutation(undefined, ['__proto__'], 'SET', {})).toThrow('Invalid channel storage key')
    expect(() => channelValueMutation({ kind: 'platformAttributes', path: ['constructor', 'prototype'] }, ['x'], 'SET', {})).toThrow('Invalid channel storage key')
  })
})

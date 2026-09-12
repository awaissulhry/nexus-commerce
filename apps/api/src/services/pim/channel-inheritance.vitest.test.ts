import { describe, expect, it } from 'vitest'
import { readStoredChannelValue } from './channel-inheritance.js'

describe('channel values follow Master unless explicitly overridden', () => {
  const title = { kind: 'listingColumn' as const, column: 'title', followFlag: 'followMasterTitle' }
  it('ignores stale synced content and old override values after restoring Master', () => {
    expect(readStoredChannelValue(title, { followMasterTitle: true, title: 'Old sync', titleOverride: 'Old override' })).toBeUndefined()
  })
  it('uses the explicit override before the synced snapshot', () => {
    expect(readStoredChannelValue(title, { followMasterTitle: false, title: 'Old sync', titleOverride: 'New override' })).toBe('New override')
  })
  it('retains the legacy snapshot for a deliberately overridden listing', () => {
    expect(readStoredChannelValue(title, { followMasterTitle: false, title: 'Existing listing', titleOverride: null })).toBe('Existing listing')
  })
  it('defaults an absent follow flag to inheritance', () => {
    expect(readStoredChannelValue(title, { title: 'Old sync' })).toBeUndefined()
  })
  it('preserves an explicit zero quantity', () => {
    expect(readStoredChannelValue({ kind: 'listingColumn', column: 'quantity', followFlag: 'followMasterQuantity' }, { followMasterQuantity: false, quantityOverride: 0, quantity: 5 })).toBe(0)
  })
  it('keeps channel-only policies and item specifics in their listing stores', () => {
    expect(readStoredChannelValue({ kind: 'platformAttributes', path: ['itemSpecifics', 'Marca'] }, { platformAttributes: { itemSpecifics: { Marca: 'Listing brand' } } })).toBe('Listing brand')
    expect(readStoredChannelValue({ kind: 'listingColumn', column: 'variationTheme' }, { variationTheme: 'COLOR/SIZE' })).toBe('COLOR/SIZE')
  })
})

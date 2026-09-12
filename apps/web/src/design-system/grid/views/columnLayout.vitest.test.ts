import { describe, expect, it } from 'vitest'
import { moveAttributesToGroup, toggleColumn, toggleLock } from '../../patterns/preferencesLogic'
import { layoutFromPreferences, mergeVisibleColumnOrder, preferencesFromLayout } from './columnLayout'

describe('mergeVisibleColumnOrder', () => {
  it('incorporates live header drags without moving hidden or unavailable saved slots', () => {
    expect(mergeVisibleColumnOrder(['title', 'hidden', 'price', 'unavailable', 'stock'], ['stock', 'title', 'price'])).toEqual([
      'stock', 'hidden', 'title', 'unavailable', 'price',
    ])
  })

  it('keeps newly visible columns in their live order and appends the remaining live keys', () => {
    const saved = ['hidden', 'title', 'unavailable', 'price']
    const live = ['new-field', 'price', 'title']
    const merged = mergeVisibleColumnOrder(saved, live)
    expect(merged).toEqual(['hidden', 'new-field', 'unavailable', 'price', 'title'])
    expect(merged.filter((key) => live.includes(key))).toEqual(live)
    expect(mergeVisibleColumnOrder(['hidden'], ['new-field', 'title'])).toEqual(['hidden', 'new-field', 'title'])
  })

  it('deduplicates both inputs and leaves their readonly arrays unchanged', () => {
    const saved = Object.freeze(['title', 'hidden', 'title', 'price'])
    const live = Object.freeze(['price', 'price', 'title', 'new-field', 'new-field'])
    const merged = mergeVisibleColumnOrder(saved, live)
    expect(merged).toEqual(['price', 'hidden', 'title', 'new-field'])
    expect(mergeVisibleColumnOrder(merged, live)).toEqual(merged)
    expect(saved).toEqual(['title', 'hidden', 'title', 'price'])
    expect(live).toEqual(['price', 'price', 'title', 'new-field', 'new-field'])
  })

  it('handles no saved layout or no visible columns without dropping saved IDs', () => {
    expect(mergeVisibleColumnOrder([], ['price', 'title'])).toEqual(['price', 'title'])
    expect(mergeVisibleColumnOrder(['hidden', 'unavailable', 'hidden'], [])).toEqual(['hidden', 'unavailable'])
  })

  it('preserves a live drag when Customise is saved and reloaded while a sibling field stays hidden', () => {
    const registry = ['title', 'hidden', 'price'].map((key) => ({ key, label: key, groupKey: 'content', group: 'Content' }))
    const previous = layoutFromPreferences(registry, { ...preferencesFromLayout(null, registry), visibleColumns: ['title', 'price'], columnOrder: ['title', 'hidden', 'price', 'unavailable'] })
    const draft = preferencesFromLayout(previous, registry)
    draft.columnOrder = mergeVisibleColumnOrder(draft.columnOrder ?? [], ['price', 'title'])
    const saved = layoutFromPreferences(registry, draft)
    expect(saved.columns).toEqual(['price', 'title'])
    expect(saved.columnOrder).toEqual(['price', 'hidden', 'title', 'unavailable'])
    expect(layoutFromPreferences(registry, preferencesFromLayout(JSON.parse(JSON.stringify(saved)), registry))).toEqual(saved)
  })
})

describe('shared column layouts across grid hosts', () => {
  const columns = [
    { key: 'product', label: 'Product', groupKey: 'products-next:identity', group: 'Identity', defaultLocked: true },
    { key: 'price', label: 'Price', groupKey: 'products-next:commerce', group: 'Commerce' },
    { key: 'actions', label: 'Actions', groupKey: 'products-next:meta', group: 'Meta', defaultLocked: true, lockSide: 'right' as const },
  ]

  it('preserves unlockable bookends in page layouts and supports hiding them after reload', () => {
    const initial = { ...preferencesFromLayout(null, columns), lockedColumns: ['product', 'actions'] }
    const saved = layoutFromPreferences(columns, initial)
    expect(saved.columns).toEqual(['product', 'price', 'actions'])
    expect(saved.lockedColumns).toEqual(['product', 'actions'])
    const reloaded = preferencesFromLayout(JSON.parse(JSON.stringify(saved)), columns)
    const unlocked = toggleLock(toggleLock(reloaded, 'product', []), 'actions', [])
    const hidden = toggleColumn(toggleColumn(unlocked, 'product'), 'actions')
    const hiddenLayout = layoutFromPreferences(columns, hidden)
    expect(hiddenLayout.columns).toEqual(['price'])
    expect(hiddenLayout.lockedColumns).toEqual([])
    expect(hiddenLayout.columnOrder).toEqual(expect.arrayContaining(['product', 'actions']))
  })

  it('uses each host’s explicit immutable flags rather than reserving product or actions keys globally', () => {
    const pageDraft = moveAttributesToGroup(columns, preferencesFromLayout(null, columns), ['product', 'actions'], 'products-next:commerce')
    expect(layoutFromPreferences(columns, pageDraft).groupOverrides).toEqual({ product: 'products-next:commerce', actions: 'products-next:commerce' })
    const sheetColumns = columns.map((column) => ({ ...column, locked: column.key === 'product' }))
    const sheetDraft = moveAttributesToGroup(sheetColumns, preferencesFromLayout(null, sheetColumns), ['product', 'actions'], 'products-next:commerce')
    const sheetLayout = layoutFromPreferences(sheetColumns, sheetDraft)
    expect(sheetLayout.columns).not.toContain('product')
    expect(sheetLayout.groupOverrides).toEqual({ actions: 'products-next:commerce' })
  })
})

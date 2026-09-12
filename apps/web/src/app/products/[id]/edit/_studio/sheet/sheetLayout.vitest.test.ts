import { describe, expect, it } from 'vitest'
import { moveAttributesToGroup, moveAttributeGroup, toggleColumn, toggleLock } from '@/design-system/patterns/preferencesLogic'
import { prefsToColumnState } from '@/design-system/grid/columns/columnPrefs'
import { layoutFromPreferences, preferencesFromLayout, visibleLayoutKeys } from './sheetLayout'

const columns = [
  { key: 'product', label: 'Identity', locked: true },
  { key: 'title', label: 'Title', group: 'Content', groupKey: 'master:content' },
  { key: 'description', label: 'Description', group: 'Content', groupKey: 'master:content' },
  { key: 'price', label: 'Price', group: 'Offer', groupKey: 'AMAZON:offer' },
  { key: 'image', label: 'Image', group: 'Images', groupKey: 'AMAZON:images' },
]
const bridge = { columns: columns.map((c) => ({ key: c.key, locked: c.locked })) }

describe('complete product sheet layout round trip', () => {
  it('keeps group moves, group order, hidden fields and pins through a server JSON round trip', () => {
    let draft = preferencesFromLayout(null, columns)
    draft = toggleColumn(draft, 'description')
    draft = moveAttributesToGroup(columns, draft, ['title', 'description'], 'AMAZON:offer')
    draft = moveAttributeGroup(columns, draft, 'AMAZON:images', 'AMAZON:offer')
    draft = toggleLock(draft, 'price', [])
    const payload = layoutFromPreferences(columns, draft)
    const reloaded = preferencesFromLayout(JSON.parse(JSON.stringify(payload)), columns)
    expect(layoutFromPreferences(columns, reloaded)).toEqual(payload)
    expect(payload.groupOverrides).toEqual({ title: 'AMAZON:offer', description: 'AMAZON:offer' })
    expect(visibleLayoutKeys(payload, columns)).toEqual(['image', 'price', 'title'])
    const grid = prefsToColumnState({ ...reloaded, visibleColumns: visibleLayoutKeys(payload, columns) }, bridge)
    expect(grid.filter((c) => !c.hide && c.colId !== 'ag-Grid-SelectionColumn').map((c) => [c.colId, c.pinned])).toEqual([
      ['product', 'left'], ['price', 'left'], ['image', null], ['title', null],
    ])
    expect(grid.find((c) => c.colId === 'description')?.hide).toBe(true)
  })

  it('allows another bulk move and show after reload without changing exact field identifiers', () => {
    const originalKeys = columns.map((c) => c.key)
    let draft = moveAttributesToGroup(columns, preferencesFromLayout(null, columns), ['title', 'description'], 'AMAZON:offer')
    draft = toggleColumn(draft, 'description')
    draft = preferencesFromLayout(layoutFromPreferences(columns, draft), columns)
    draft = moveAttributesToGroup(columns, draft, ['title', 'description'], 'AMAZON:images')
    draft = toggleColumn(draft, 'description')
    const saved = layoutFromPreferences(columns, draft)
    expect(saved.groupOverrides).toEqual({ title: 'AMAZON:images', description: 'AMAZON:images' })
    expect(saved.columns).toEqual(['price', 'image', 'title', 'description'])
    expect(columns.map((c) => c.key)).toEqual(originalKeys)
  })

  it('retains unavailable IDs and their layout metadata when saving on a different product type', () => {
    let draft = preferencesFromLayout(null, columns)
    draft = { ...draft, visibleColumns: ['title', 'future-field'], columnOrder: ['future-field', 'title'], lockedColumns: ['future-pin'], groupOverrides: { 'future-field': 'future-group' }, groupOrder: ['future-group'] }
    const saved = layoutFromPreferences(columns, draft)
    expect(saved.columns).toContain('future-field')
    expect(saved.columns).toContain('future-pin')
    expect(saved.columnOrder).toEqual(expect.arrayContaining(['future-field', 'future-pin']))
    expect(saved.groupOverrides['future-field']).toBe('future-group')
    expect(visibleLayoutKeys(saved, columns)).toEqual(['title'])
    expect(layoutFromPreferences(columns, preferencesFromLayout(saved, columns))).toEqual(saved)
  })

  it('keeps schema group order when required fields are ranked first in the grid', () => {
    const draft = { ...preferencesFromLayout(null, columns), columnOrder: ['price', 'description', 'image', 'title'] }
    const saved = layoutFromPreferences(columns, draft)
    expect(saved.groupOrder).toEqual(['master:content', 'AMAZON:offer', 'AMAZON:images'])
    expect(saved.columns).toEqual(['description', 'title', 'price', 'image'])
    expect(layoutFromPreferences(columns, preferencesFromLayout(saved, columns))).toEqual(saved)
  })

  it('upgrades schema 2 on save while keeping structural identity out of the payload', () => {
    const draft = preferencesFromLayout({ v: 2, kind: 'columns', columns: ['price', 'title'] }, columns)
    const saved = layoutFromPreferences(columns, { ...draft, visibleColumns: ['product', ...draft.visibleColumns], lockedColumns: ['product'] })
    expect(saved.v).toBe(3)
    expect(saved.columnOrder).toEqual(['price', 'title', 'description', 'image'])
    expect(saved.columns).not.toContain('product')
    expect(saved.lockedColumns).not.toContain('product')
  })
})

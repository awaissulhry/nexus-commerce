import { describe, expect, it } from 'vitest'

import { addColumns, effectiveLocks, inViewCount, moveVisible, orderedForDisplay, removeColumns, setHas, toggleColumn, toggleLock, togglableKeysOf, resolveAttributeGroups, moveAttributesToGroup, moveAttributeGroup, moveAttributeColumn, resetAttributeGroups } from './preferencesLogic'
import type { PreferencesColumnSpec, PreferencesValue } from './PreferencesModal'

const COLS: PreferencesColumnSpec[] = [
  { key: 'product', label: 'Product', locked: true },
  { key: 'brand', label: 'Brand', group: 'Identity' },
  { key: 'name', label: 'Name', group: 'Identity' },
  { key: 'price', label: 'Price', group: 'Pricing' },
  { key: 'stock', label: 'Stock', group: 'Inventory' },
  { key: 'actions', label: '', locked: true },
]
const TOGGLABLE = new Set(togglableKeysOf(COLS))
const V = (over: Partial<PreferencesValue> = {}): PreferencesValue => ({
  visibleColumns: ['brand', 'name', 'price'],
  lockedColumns: [],
  stickyFirstColumn: true,
  stickyLastColumn: false,
  pageSize: 0,
  sortBy: '',
  sortDir: 'asc',
  ...over,
})

describe('attribute group layouts', () => {
  const columns: PreferencesColumnSpec[] = [
    { key: 'identity', label: 'SKU', locked: true },
    { key: 'title', label: 'Title', groupKey: 'master:content', group: 'Content' },
    { key: 'description', label: 'Description', groupKey: 'master:content', group: 'Content' },
    { key: 'price', label: 'Price', groupKey: 'amazon:offer', group: 'Offer' },
    { key: 'quantity', label: 'Quantity', groupKey: 'amazon:offer', group: 'Offer' },
    { key: 'image', label: 'Main image', groupKey: 'amazon:images', group: 'Images' },
  ]
  const layout = V({ visibleColumns: ['title', 'price'], columnOrder: ['description', 'title', 'price', 'quantity', 'image'], lockedColumns: ['price'] })
  const groupsOf = (value: PreferencesValue) => resolveAttributeGroups(columns, value).map((g) => [g.key, g.columns.map((c) => c.key)])

  it('resolves every attribute exactly once, including hidden and pinned fields, using complete order', () => {
    expect(groupsOf(layout)).toEqual([
      ['master:content', ['description', 'title']], ['amazon:offer', ['price', 'quantity']], ['amazon:images', ['image']],
    ])
    expect(resolveAttributeGroups(columns, layout).flatMap((g) => g.columns)).toHaveLength(5)
  })
  it('stable group IDs keep different groups separate when labels collide or translate', () => {
    const relabelled = columns.map((c) => ({ ...c, group: 'Translated group' }))
    const next = moveAttributesToGroup(columns, layout, ['title'], 'amazon:offer')
    const groups = resolveAttributeGroups(relabelled, next)
    expect(groups).toHaveLength(3)
    expect(groups.find((g) => g.key === 'amazon:offer')?.columns.map((c) => c.key)).toEqual(['price', 'quantity', 'title'])
  })
  it('moves a bulk selection including hidden attributes, preserving visibility, values and pins through JSON reload', () => {
    const next = moveAttributesToGroup(columns, layout, ['title', 'description', 'identity', 'missing'], 'amazon:images')
    const reloaded = JSON.parse(JSON.stringify(next)) as PreferencesValue
    expect(groupsOf(reloaded)).toEqual([
      ['master:content', []], ['amazon:offer', ['price', 'quantity']], ['amazon:images', ['image', 'description', 'title']],
    ])
    expect(reloaded.visibleColumns).toEqual(layout.visibleColumns)
    expect(reloaded.lockedColumns).toEqual(['price'])
    expect(reloaded.groupOverrides).toEqual({ description: 'amazon:images', title: 'amazon:images' })
    expect(reloaded.columnOrder).not.toContain('identity')
  })
  it('keeps hidden assignments across repeated hide/show and move operations', () => {
    const moved = moveAttributesToGroup(columns, layout, ['title', 'description'], 'amazon:images')
    const hidden = removeColumns(moved, ['title', 'description'])
    const movedAgain = moveAttributesToGroup(columns, hidden, ['title', 'description'], 'amazon:offer')
    const shown = addColumns(movedAgain, ['title', 'description'], new Set(togglableKeysOf(columns)))
    expect(resolveAttributeGroups(columns, shown).find((g) => g.key === 'amazon:offer')?.columns.map((c) => c.key)).toEqual(['price', 'quantity', 'description', 'title'])
    expect(shown.visibleColumns).toEqual(['price', 'title', 'description'])
  })
  it('refuses nonexistent groups and structural moves; invalid persisted group IDs fall back to schema', () => {
    expect(moveAttributesToGroup(columns, layout, ['title'], 'missing')).toBe(layout)
    expect(moveAttributesToGroup(columns, layout, ['identity'], 'amazon:offer')).toBe(layout)
    expect(groupsOf({ ...layout, groupOrder: ['missing', 'amazon:offer', 'amazon:offer'], groupOverrides: { title: 'missing' }, columnOrder: ['title', 'title', 'missing'] })).toEqual([
      ['amazon:offer', ['price', 'quantity']], ['master:content', ['title', 'description']], ['amazon:images', ['image']],
    ])
  })
  it('reorders complete groups without modifying membership, pins or within-group order', () => {
    const next = moveAttributeGroup(columns, layout, 'amazon:images', 'master:content')
    expect(groupsOf(next)).toEqual([
      ['amazon:images', ['image']], ['master:content', ['description', 'title']], ['amazon:offer', ['price', 'quantity']],
    ])
    expect(next.visibleColumns).toBe(layout.visibleColumns)
    expect(next.lockedColumns).toBe(layout.lockedColumns)
  })
  it('reorders a column before or after its peer and supports a drop into another group', () => {
    expect(groupsOf(moveAttributeColumn(columns, layout, 'title', 'description'))[0]).toEqual(['master:content', ['title', 'description']])
    expect(groupsOf(moveAttributeColumn(columns, layout, 'description', 'title', true))[0]).toEqual(['master:content', ['title', 'description']])
    const moved = moveAttributeColumn(columns, layout, 'title', 'quantity')
    expect(moved.groupOverrides?.title).toBe('amazon:offer')
    expect(resolveAttributeGroups(columns, moved).find((g) => g.key === 'amazon:offer')?.columns.map((c) => c.key)).toEqual(['price', 'title', 'quantity'])
  })
  it('never silently unpins a column when reordering or moving it to a group', () => {
    expect(moveAttributeColumn(columns, layout, 'price', 'title')).toBe(layout)
    expect(moveAttributeColumn(columns, layout, 'title', 'price')).toBe(layout)
    const grouped = moveAttributesToGroup(columns, layout, ['price'], 'master:content')
    expect(grouped.lockedColumns).toEqual(['price'])
    expect(grouped.groupOverrides?.price).toBe('master:content')
  })
  it('resetting selected groups leaves other moves intact and moving back removes redundant overrides', () => {
    const moved = moveAttributesToGroup(columns, layout, ['title', 'description'], 'amazon:images')
    expect(resetAttributeGroups(moved, ['title']).groupOverrides).toEqual({ description: 'amazon:images' })
    expect(moveAttributesToGroup(columns, moved, ['title'], 'master:content').groupOverrides).toEqual({ description: 'amazon:images' })
  })
  it('supports legacy group labels and ungrouped callers without creating duplicate columns', () => {
    expect(resolveAttributeGroups(COLS, V()).map((g) => g.key)).toEqual(['Identity', 'Pricing', 'Inventory'])
    expect(resolveAttributeGroups([{ key: 'a', label: 'A' }], V({ visibleColumns: [] }), 'Attributes')).toEqual([
      { key: 'Attributes', label: 'Attributes', columns: [{ key: 'a', label: 'A' }] },
    ])
  })
  it('retains temporarily unavailable field and group IDs through moves and reorders', () => {
    const partial = {
      ...layout,
      columnOrder: [...layout.columnOrder!, 'future_field'],
      groupOrder: ['future_group', 'master:content', 'amazon:offer', 'amazon:images'],
      groupOverrides: { future_field: 'future_group' },
    }
    const moved = moveAttributesToGroup(columns, partial, ['description'], 'amazon:images')
    const reordered = moveAttributeColumn(columns, moved, 'title', 'quantity')
    const groupsMoved = moveAttributeGroup(columns, reordered, 'amazon:images', 'master:content')
    expect(groupsMoved.columnOrder).toContain('future_field')
    expect(groupsMoved.groupOrder).toContain('future_group')
    expect(groupsMoved.groupOverrides?.future_field).toBe('future_group')
    const restored = resolveAttributeGroups([...columns, { key: 'future_field', label: 'Future field', groupKey: 'future_group', group: 'Future group' }], groupsMoved)
    expect(restored.find((g) => g.key === 'future_group')?.columns.map((c) => c.key)).toEqual(['future_field'])
  })
})

describe('effectiveLocks / togglableKeysOf', () => {
  it('falls back to the specs’ defaults only when the value predates the control', () => {
    const { lockedColumns: _d, ...pre } = V()
    expect(effectiveLocks(pre as PreferencesValue, ['brand'])).toEqual(['brand'])
    expect(effectiveLocks(V({ lockedColumns: [] }), ['brand'])).toEqual([])
  })
  it('structural columns are never togglable', () => {
    expect(togglableKeysOf(COLS)).toEqual(['brand', 'name', 'price', 'stock'])
  })
})

describe('toggleColumn', () => {
  it('ticks and unticks', () => {
    expect(toggleColumn(V(), 'stock').visibleColumns).toEqual(['brand', 'name', 'price', 'stock'])
    expect(toggleColumn(V(), 'name').visibleColumns).toEqual(['brand', 'price'])
  })
  it('🔴 a locked column cannot be unticked — a lock implies visible', () => {
    const v = V({ lockedColumns: ['name'] })
    expect(toggleColumn(v, 'name')).toBe(v)
  })
})

describe('bulk sets — the Owner’s "select all the columns of a group at once"', () => {
  it('addColumns appends only what this grid has and is not already in, in the given order', () => {
    const v = addColumns(V(), ['stock', 'ghost', 'brand', 'price'], TOGGLABLE)
    expect(v.visibleColumns).toEqual(['brand', 'name', 'price', 'stock'])
  })
  it('addColumns with nothing to add returns the SAME value, so a caller can tell', () => {
    const v = V()
    expect(addColumns(v, ['brand', 'ghost'], TOGGLABLE)).toBe(v)
  })
  it('removeColumns drops a set and keeps the rest in order', () => {
    expect(removeColumns(V(), ['brand', 'price']).visibleColumns).toEqual(['name'])
  })
  it('🔴 removeColumns never drops a LOCKED column', () => {
    expect(removeColumns(V({ lockedColumns: ['brand'] }), ['brand', 'price']).visibleColumns).toEqual(['brand', 'name'])
  })
  it('setHas is pressed only when every APPLICABLE key is in view, and never for an empty applicable set', () => {
    expect(setHas(V(), ['brand', 'name'], TOGGLABLE)).toBe(true)
    expect(setHas(V(), ['brand', 'stock'], TOGGLABLE)).toBe(false)
    expect(setHas(V(), ['brand', 'ghost'], TOGGLABLE)).toBe(true)
    expect(setHas(V(), ['ghost'], TOGGLABLE)).toBe(false)
  })
})

describe('toggleLock — frozen at the left, a lock implies visible', () => {
  it('locking appends to the lock set in the order locked, and shows a hidden column', () => {
    const v = toggleLock(toggleLock(V(), 'stock', []), 'brand', [])
    expect(v.lockedColumns).toEqual(['stock', 'brand'])
    expect(v.visibleColumns).toEqual(['brand', 'name', 'price', 'stock'])
  })
  it('🔴 unlocking moves the column to the FRONT of the visible order — right after the frozen block, where the operator was looking', () => {
    const v = toggleLock(V({ visibleColumns: ['brand', 'name', 'price'], lockedColumns: ['price'] }), 'price', [])
    expect(v.lockedColumns).toEqual([])
    expect(v.visibleColumns).toEqual(['price', 'brand', 'name'])
  })
  it('starts from the defaults when the value predates the control', () => {
    const { lockedColumns: _d, ...pre } = V()
    expect(toggleLock(pre as PreferencesValue, 'name', ['brand']).lockedColumns).toEqual(['brand', 'name'])
  })
})

describe('moveVisible — a drop is honoured only within its block', () => {
  it('reorders unlocked rows', () => {
    expect(moveVisible(V(), 'price', 'brand', []).visibleColumns).toEqual(['price', 'brand', 'name'])
  })
  it('reorders the frozen block', () => {
    const v = moveVisible(V({ lockedColumns: ['brand', 'price'] }), 'price', 'brand', [])
    expect(v.lockedColumns).toEqual(['price', 'brand'])
  })
  it('🔴 refuses a drop across the block boundary, both ways, returning the same value', () => {
    const v = V({ lockedColumns: ['brand'] })
    expect(moveVisible(v, 'name', 'brand', [])).toBe(v)
    expect(moveVisible(v, 'brand', 'name', [])).toBe(v)
  })
  it('a drop on itself or on an unknown key changes nothing', () => {
    const v = V()
    expect(moveVisible(v, 'name', 'name', [])).toBe(v)
    expect(moveVisible(v, 'name', 'ghost', [])).toBe(v)
  })
})

describe('orderedForDisplay — structural lead · frozen block · visible · hidden · structural trail', () => {
  it('puts the operator’s frozen block right after the structural lead, in lock order', () => {
    const keys = orderedForDisplay(COLS, V({ visibleColumns: ['brand', 'name', 'price'], lockedColumns: ['price', 'name'] }), []).map((c) => c.key)
    expect(keys).toEqual(['product', 'price', 'name', 'brand', 'stock', 'actions'])
  })
  it('a locked column absent from visibleColumns still shows in the block, not among the hidden', () => {
    const keys = orderedForDisplay(COLS, V({ visibleColumns: ['brand'], lockedColumns: ['stock'] }), []).map((c) => c.key)
    expect(keys).toEqual(['product', 'stock', 'brand', 'name', 'price', 'actions'])
  })
  it('a lock naming a structural or unknown column is ignored', () => {
    const keys = orderedForDisplay(COLS, V({ lockedColumns: ['product', 'ghost'] }), []).map((c) => c.key)
    expect(keys).toEqual(['product', 'brand', 'name', 'price', 'stock', 'actions'])
  })
  it('with no structural columns the block leads the list', () => {
    const cols = COLS.filter((c) => !c.locked)
    expect(orderedForDisplay(cols, V({ lockedColumns: ['name'] }), []).map((c) => c.key)).toEqual(['name', 'brand', 'price', 'stock'])
  })
})

describe('inViewCount — locking a column shrinks neither side', () => {
  it('counts visible OR locked non-structural columns over every non-structural column', () => {
    expect(inViewCount(COLS, V(), [])).toEqual({ shown: 3, total: 4 })
    // lock `price` (already visible): same numbers
    expect(inViewCount(COLS, V({ lockedColumns: ['price'] }), [])).toEqual({ shown: 3, total: 4 })
    // lock a hidden one: it is on screen now — the count says so
    expect(inViewCount(COLS, V({ lockedColumns: ['stock'] }), [])).toEqual({ shown: 4, total: 4 })
  })
  it('structural columns are in neither number', () => {
    expect(inViewCount(COLS, V({ visibleColumns: [] }), []).total).toBe(4)
  })
})

describe('lockSide — a right-side lock (an actions bookend) reads in SCREEN order', () => {
  const COLS_R: PreferencesColumnSpec[] = [
    { key: 'product', label: 'Product', defaultLocked: true },
    { key: 'brand', label: 'Brand' },
    { key: 'price', label: 'Price' },
    { key: 'actions', label: 'Actions', defaultLocked: true, lockSide: 'right' },
  ]
  const DEF = ['product', 'actions']
  it('🔴 orderedForDisplay lists a right-side lock LAST, after the visible and hidden rows', () => {
    const keys = orderedForDisplay(COLS_R, V({ visibleColumns: ['brand'], lockedColumns: undefined as unknown as string[] }), DEF).map((c) => c.key)
    expect(keys).toEqual(['product', 'brand', 'price', 'actions'])
  })
  it('a left lock added by the operator joins the left block; the right bookend stays last', () => {
    const keys = orderedForDisplay(COLS_R, V({ visibleColumns: ['brand', 'price'], lockedColumns: ['product', 'actions', 'price'] }), DEF).map((c) => c.key)
    expect(keys).toEqual(['product', 'price', 'brand', 'actions'])
  })
  it('🔴 moveVisible refuses a drop between the two edges, and still reorders within one', () => {
    const sideOf = (k: string) => (k === 'actions' ? 'right' as const : 'left' as const)
    const v = V({ visibleColumns: ['brand', 'price'], lockedColumns: ['product', 'price', 'actions'] })
    expect(moveVisible(v, 'actions', 'product', DEF, sideOf)).toBe(v)
    expect(moveVisible(v, 'product', 'actions', DEF, sideOf)).toBe(v)
    expect(moveVisible(v, 'price', 'product', DEF, sideOf).lockedColumns).toEqual(['price', 'product', 'actions'])
  })
  it('inViewCount counts the right bookend like any other locked column', () => {
    expect(inViewCount(COLS_R, V({ visibleColumns: ['brand'], lockedColumns: ['product', 'actions'] }), DEF)).toEqual({ shown: 3, total: 4 })
  })
})

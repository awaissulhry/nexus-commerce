import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MenuItemDef } from '@/design-system/components'
import type { GridStateApi } from '../hooks/useGridState'
import type { SavedGridView } from '../hooks/useGridViews'
import { columnsViewPayload } from '../views/viewPayload'

/* The DS Menu renders its items only when open; capture what GridViewsMenu hands it instead. */
const captured = vi.hoisted(() => ({ items: [] as MenuItemDef[] }))
vi.mock('@/design-system/components', async (original) => ({
  ...(await original<typeof import('@/design-system/components')>()),
  Menu: (props: { items: MenuItemDef[] }) => { captured.items = props.items; return null },
}))

import { GridViewsMenu } from './GridViewsMenu'

const text = (node: ReactNode) => render(createElement('span', null, node)).replace(/<[^>]+>/g, '')
const view = (id: string, over: Partial<SavedGridView<unknown>> = {}): SavedGridView<unknown> =>
  ({ id, name: id, isDefault: false, payload: columnsViewPayload(['brand']), updatedAt: '2026-09-26T10:00:00.000Z', owned: true, shared: false, teamShared: false, sharedBy: null, defaultProductTypes: [], ...over })
const api = (views: SavedGridView<unknown>[], activeId: string | null, extra: Record<string, unknown> = {}) =>
  ({ views, activeId, save: vi.fn(), apply: vi.fn(), remove: vi.fn(), rename: vi.fn(), duplicate: vi.fn(), setDefault: vi.fn(), clearDefault: vi.fn(), ...extra }) as unknown as GridStateApi<unknown>
const menu = (views: GridStateApi<unknown>, productType: { code: string; label: string } | null = null) => {
  render(createElement(GridViewsMenu<unknown>, { views, productType }))
  return captured.items
}
const ids = (items: MenuItemDef[]) => items.map((item) => item.id)

beforeEach(() => { captured.items = [] })

describe('GridViewsMenu — team views (SHEET-VIEWS P2)', () => {
  const mine = view('mine')
  const bob = view('bob', { owned: false, teamShared: true, sharedBy: 'Bob Rossi' })
  const anon = view('anon', { owned: false, teamShared: true, sharedBy: null })

  it('lists my views first, then the team\'s after a rule, each team view naming who shared it', () => {
    const items = menu(api([bob, mine, anon], null))
    expect(ids(items).slice(0, 4)).toEqual(['mine', 'sep-team', 'bob', 'anon'])
    expect(text(items[2].description)).toBe('Shared by Bob Rossi')
    // No display name: never an email or an id — a neutral phrase.
    expect(text(items[3].description)).toBe('Shared by a teammate')
  })

  it('offers only "Duplicate…" on a teammate\'s view', () => {
    const items = menu(api([mine, bob], 'bob', { setShared: vi.fn(), setTypeDefault: vi.fn() }), { code: 'OUTERWEAR', label: 'Outerwear' })
    const verbs = ids(items).slice(ids(items).indexOf('sep-1') + 1)
    expect(verbs).toEqual(['save-new', 'duplicate'])
  })

  it('treats any view I do not own as a teammate\'s, even without the team flag (never offers to change it)', () => {
    const notMine = view('notMine', { owned: false, teamShared: false, legacyShared: false })
    const items = menu(api([mine, notMine], 'notMine', { setShared: vi.fn(), setTypeDefault: vi.fn() }))
    expect(ids(items)).toContain('sep-team')
    expect(ids(items)).not.toContain('update')
    expect(ids(items)).not.toContain('delete')
  })

  it('adds Share with team and the product-type default on my own view', () => {
    const items = menu(api([mine], 'mine', { setShared: vi.fn(), setTypeDefault: vi.fn() }), { code: 'OUTERWEAR', label: 'Outerwear' })
    expect(ids(items)).toEqual(expect.arrayContaining(['update', 'rename', 'default', 'type-default', 'share', 'delete']))
    expect(items.find((item) => item.id === 'share')!.label).toBe('Share with team')
    expect(items.find((item) => item.id === 'type-default')!.label).toBe('Make default for Outerwear products')
  })

  it('offers the way back once shared or once the type default is set, and marks the view', () => {
    const shared = view('mine', { shared: true, defaultProductTypes: ['OUTERWEAR'] })
    const items = menu(api([shared], 'mine', { setShared: vi.fn(), setTypeDefault: vi.fn() }), { code: 'outerwear', label: 'Outerwear' })
    expect(items.find((item) => item.id === 'share')!.label).toBe('Stop sharing')
    expect(items.find((item) => item.id === 'type-default')!.label).toBe('Stop default for Outerwear products')
    expect(text(items[0].label)).toBe('mine · Outerwear default · shared ✓')
  })

  it('leaves a caller without the new verbs, or without a product type, exactly as before', () => {
    expect(ids(menu(api([mine], 'mine')))).not.toContain('share')
    expect(ids(menu(api([mine], 'mine', { setShared: vi.fn(), setTypeDefault: vi.fn() })))).not.toContain('type-default')
  })

  it('does not offer sharing on a legacy template — saving it makes my copy first', () => {
    const legacy = view('legacy', { owned: false, legacyShared: true })
    const items = menu(api([legacy], 'legacy', { setShared: vi.fn(), setTypeDefault: vi.fn() }), { code: 'OUTERWEAR', label: 'Outerwear' })
    expect(ids(items)).toContain('update')
    expect(ids(items)).not.toContain('share')
    expect(ids(items)).not.toContain('type-default')
    expect(ids(items)).not.toContain('sep-team')
  })

  it('prints the count the surface gives for a view — a rule view counts what its rules add', () => {
    render(createElement(GridViewsMenu<unknown>, { views: api([mine], null), showCounts: true, viewColumnCount: () => 7 }))
    expect(text(captured.items[0].label)).toBe('mine (7)')
    render(createElement(GridViewsMenu<unknown>, { views: api([mine], null), showCounts: true }))
    expect(text(captured.items[0].label)).toBe('mine (1)')
  })

  it('runs the verb the item names', () => {
    const setShared = vi.fn(async () => {})
    const setTypeDefault = vi.fn(async () => {})
    const items = menu(api([mine], 'mine', { setShared, setTypeDefault }), { code: 'OUTERWEAR', label: 'Outerwear' })
    items.find((item) => item.id === 'share')!.onSelect!()
    items.find((item) => item.id === 'type-default')!.onSelect!()
    expect(setShared).toHaveBeenCalledWith('mine', true)
    expect(setTypeDefault).toHaveBeenCalledWith('mine', 'OUTERWEAR', true)
  })
})

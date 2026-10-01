import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => {
  type Slot = { value?: unknown; deps?: unknown[]; cleanup?: () => void }
  const state = { cursor: 0, slots: [] as Slot[], effects: [] as Array<() => void> }
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const memo = (make: () => unknown, deps: unknown[]) => {
    const index = state.cursor++
    if (!state.slots[index] || !same(state.slots[index].deps, deps)) state.slots[index] = { value: make(), deps }
    return state.slots[index].value
  }
  return { state, react: {
    useMemo: memo,
    useCallback: (fn: unknown, deps: unknown[]) => memo(() => fn, deps),
    useRef: (initial: unknown) => memo(() => ({ current: initial }), []),
    useState: (initial: unknown) => {
      const index = state.cursor++
      if (!state.slots[index]) state.slots[index] = { value: typeof initial === 'function' ? (initial as () => unknown)() : initial }
      const slot = state.slots[index]
      return [slot.value, (value: unknown) => { slot.value = typeof value === 'function' ? (value as (old: unknown) => unknown)(slot.value) : value }]
    },
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const index = state.cursor++, previous = state.slots[index]
      if (previous && same(previous.deps, deps)) return
      const slot: Slot = { deps }
      state.slots[index] = slot
      state.effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect() || undefined })
    },
  } }
})
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...hooks.react }))

const fixture = vi.hoisted(() => ({ actor: 'owner-a', business: 'business-a', gridLoaded: false, save: vi.fn(), paint: vi.fn(), markActive: vi.fn(), loadOwn: vi.fn() }))
/** The person's own layout record (2026-10-01, `/api/sheet-layouts`); per actor and business here, so each owner's replies are told apart. */
const ownRecord = () => ({ id: `${fixture.actor}:${fixture.business}:record`, name: 'Current layout', updatedAt: '2026-09-30T10:00:00Z',
  filters: { v: 2, kind: 'columns', columns: fixture.actor === 'owner-a' && fixture.business === 'business-a' ? ['brand'] : ['brand', 'name'] } })
vi.mock('@/lib/workspaces/navigation', () => ({ useParams: () => ({ workspaceId: fixture.business }) }))
vi.mock('@/lib/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: fixture.actor } }) }))
vi.mock('@/design-system/grid/hooks/useGridState', async original => ({
  ...await original<typeof import('@/design-system/grid/hooks/useGridState')>(),
  useGridState: () => ({ loaded: fixture.gridLoaded, views: [], loadError: null, markActive: fixture.markActive, markDirty: vi.fn(), refresh: async () => {} }),
}))
vi.mock('@/design-system/grid/views/savedViewTransport', async original => ({
  ...await original<typeof import('@/design-system/grid/views/savedViewTransport')>(),
  savedViewRequest: async () => ({ results: [
    { surface: 'product-edit:views:master', items: [] },
    { surface: 'product-edit:layout:master', items: [{ id: `${fixture.actor}:${fixture.business}:record`, name: 'Current layout',
      updatedAt: '2026-09-30T10:00:00Z', filters: { v: 2, kind: 'columns', columns: fixture.actor === 'owner-a' && fixture.business === 'business-a' ? ['brand'] : ['brand', 'name'] } }] },
  ] }),
  saveWorkingLayout: (...args: unknown[]) => fixture.save(fixture.actor, ...args),
  loadUserSheetLayout: (...args: unknown[]) => fixture.loadOwn(...args),
  saveUserSheetLayout: (...args: unknown[]) => fixture.save(fixture.actor, ...args),
}))

import { useSheetColumns, type UseSheetColumnsArgs } from './useSheetColumns'
import { forgetSessionPicks } from './sheetLayoutMemory'

const columns = ['brand', 'name'].map(key => ({ key, label: key, kind: 'text', group: 'General', groupKey: 'general', requiredBy: [], editable: true, defaultVisible: true, writeField: key }))
const options = { apiRef: { current: null }, gridReady: null, columns, identityColumn: 'sku', activeChip: null,
  prefsBridge: { columns: [{ key: 'sku', locked: true }, ...columns] }, viewCtx: { locale: 'it', variationAxes: [] }, productType: null, layoutSurface: 'product-edit:layout:master',
  grid: { surface: 'product-edit:views:master', baseUrl: '/backend', getPageState: () => ({}), applyPageState: () => {} },
} as unknown as UseSheetColumnsArgs<unknown, Record<string, never>>
const render = (flushEffects = true) => {
  hooks.state.cursor = 0
  const result = useSheetColumns(options)
  if (flushEffects) for (const effect of hooks.state.effects.splice(0)) effect()
  return result
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const preferences = (keys: string[]) => ({ stickyFirstColumn: false, stickyLastColumn: false, pageSize: 25, sortBy: '', sortDir: 'asc' as const, visibleColumns: keys, columnOrder: ['sku', 'brand', 'name'], lockedColumns: [], groupOrder: ['general'], groupOverrides: {} })

beforeEach(() => {
  hooks.state.slots = []; hooks.state.effects = []
  fixture.actor = 'owner-a'; fixture.business = 'business-a'; fixture.gridLoaded = false; options.apiRef.current = null; options.gridReady = null; fixture.save.mockReset(); fixture.markActive.mockClear()
  fixture.loadOwn.mockReset(); fixture.loadOwn.mockImplementation(async () => ownRecord())
  forgetSessionPicks()
})
afterEach(() => { for (const slot of hooks.state.slots) slot.cleanup?.(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('working layout replies stay with the requesting owner', () => {
  it.each(['actor', 'business'] as const)('ignores the old save acknowledgement after the %s changes on the same surface', async changed => {
    let finish!: (value: unknown) => void
    fixture.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    render(); await settle()
    const old = render()
    const pending = old.savePreferences(preferences(['brand']))
    await settle()
    expect(fixture.save).toHaveBeenCalledTimes(1)
    const oldFilters = fixture.save.mock.calls[0][3]
    if (changed === 'actor') fixture.actor = 'owner-b'
    else fixture.business = 'business-b'
    render(); await settle()
    expect(render().myLayout).toEqual({ count: 2 })
    finish({ id: 'owner-a-saved', name: 'Current layout', updatedAt: '2026-09-30T11:00:00Z', filters: oldFilters })
    await pending; await settle()
    const current = render()
    expect(current.myLayout).toEqual({ count: 2 })
    expect(current.active.kind).toBe('all')
    expect(fixture.markActive).not.toHaveBeenCalled()
    expect(fixture.save).toHaveBeenCalledTimes(1)
    fixture.save.mockImplementationOnce(async (_actor, _base, _surface, filters) => ({ id: 'owner-b-record', name: 'Current layout', updatedAt: '2026-09-30T12:00:00Z', filters }))
    await current.savePreferences(preferences(['name']))
    expect(fixture.save.mock.calls[1][0]).toBe(fixture.actor)
    expect(fixture.save.mock.calls[1][4].id).toBe(`${fixture.actor}:${fixture.business}:record`)
  })

  it('keeps a confirmed layout when an older empty read answers afterward', async () => {
    let finish!: (record: null) => void
    fixture.save.mockImplementation(async (_actor, _base, _surface, filters) => ({ id: 'confirmed-record', name: 'Current layout', updatedAt: '2026-09-30T12:00:00Z', filters }))
    render(); await settle()
    const current = render()
    fixture.loadOwn.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const older = current.reloadSavedPreferences().catch(() => null)
    await settle()
    await current.savePreferences(preferences(['name']))
    finish(null)
    await older; await settle()
    await render().savePreferences(preferences(['brand']))
    expect(fixture.save.mock.calls[1][4]?.id).toBe('confirmed-record')
  })

  it('does not run an old arrangement timer between the next owner render and effect cleanup', async () => {
    vi.useFakeTimers()
    const timers = vi.spyOn(globalThis, 'setTimeout')
    fixture.gridLoaded = true
    const api = { isDestroyed: () => false, getColumnState: () => [{ colId: 'sku' }, { colId: 'brand' }, { colId: 'name' }],
      applyColumnState: fixture.paint, getState: () => ({}), refreshHeader: () => {} } as unknown as NonNullable<typeof options.gridReady>
    options.apiRef.current = api; options.gridReady = api
    fixture.save.mockImplementation(async (_actor, _base, _surface, filters) => ({ id: 'saved', name: 'Current layout', updatedAt: '2026-09-30T12:00:00Z', filters }))
    render(); await settle(); render()
    const old = render()
    expect(old.landed).toBe(true)
    old.onColumnPinned({ source: 'columnMenu' })
    await vi.advanceTimersByTimeAsync(400)
    expect(fixture.save).toHaveBeenCalledTimes(1) // positive control: a user gesture saves
    old.onColumnPinned({ source: 'columnMenu' })
    const queued = timers.mock.calls.at(-1)![0]
    fixture.actor = 'owner-b'
    render(false) // New refs are live; passive cleanup has not run yet.
    if (typeof queued !== 'function') throw new Error('No arrangement callback was scheduled')
    queued()
    await settle()
    expect(fixture.save).toHaveBeenCalledTimes(1)
    render()
  })

  it('drops an old queued choice before it can write under the next owner', async () => {
    let finish!: (value: unknown) => void
    fixture.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    render(); await settle()
    const old = render()
    const all = old.presets.find(preset => preset.id === 'all')!
    old.applyPreset(all)
    old.applyPreset(all)
    await settle()
    expect(fixture.save).toHaveBeenCalledTimes(1)
    fixture.actor = 'owner-b'
    render(); await settle()
    finish({ id: 'owner-a-saved', name: 'Current layout', updatedAt: '2026-09-30T11:00:00Z', filters: fixture.save.mock.calls[0][3] })
    await settle()
    expect(fixture.save).toHaveBeenCalledTimes(1)
    expect(render().myLayout).toEqual({ count: 2 })
  })
})

describe('a person\'s own layout (2026-10-01: the same after a reload, in every profile)', () => {
  const landOn = async () => {
    vi.useFakeTimers()
    fixture.gridLoaded = true
    const api = { isDestroyed: () => false, getColumnState: () => [{ colId: 'sku' }, { colId: 'brand' }, { colId: 'name' }],
      applyColumnState: fixture.paint, getState: () => ({}), refreshHeader: () => {} } as unknown as NonNullable<typeof options.gridReady>
    options.apiRef.current = api; options.gridReady = api
    fixture.save.mockImplementation(async (_actor, _base, _surface, filters) => ({ id: 'own', name: 'Current layout', updatedAt: '2026-10-01T12:00:00Z', filters }))
    render(); await settle(); render()
    const landed = render()
    expect(landed.landed).toBe(true)
    return landed
  }

  it('makes what the person sees their own on the first landing, when they have no record yet', async () => {
    fixture.loadOwn.mockImplementation(async () => null)
    await landOn()
    await vi.advanceTimersByTimeAsync(400)
    expect(fixture.save).toHaveBeenCalledTimes(1)
    const [, , surface, filters, previous] = fixture.save.mock.calls[0]
    expect(surface).toBe('product-edit:layout:master')
    expect(previous).toBeNull() // created, not written over another record
    expect(filters).toMatchObject({ columns: ['brand'], picked: { kind: 'custom' }, density: 'compact' }) // this profile's layout, kept
  })

  it('keeps a width the operator changes, and not one the sheet applies itself', async () => {
    const sheet = await landOn()
    await vi.advanceTimersByTimeAsync(400)
    expect(fixture.save).not.toHaveBeenCalled() // a person with a record: landing writes nothing
    sheet.onColumnResized({ finished: true, source: 'api' })
    sheet.onSortChanged({ source: 'api' })
    await vi.advanceTimersByTimeAsync(400)
    expect(fixture.save).not.toHaveBeenCalled()
    sheet.onColumnResized({ finished: true, source: 'uiColumnResized' })
    sheet.onSortChanged({ source: 'uiColumnSorted' })
    await vi.advanceTimersByTimeAsync(400)
    expect(fixture.save).toHaveBeenCalledTimes(1) // a burst saves once
    expect(fixture.save.mock.calls[0][3]).toMatchObject({ columnWidths: {}, sort: [], density: 'compact' })
  })
})


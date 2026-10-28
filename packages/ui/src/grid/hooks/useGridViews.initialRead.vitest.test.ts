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

import { useGridViews, type UseGridViewsOptions } from './useGridViews'

const view = (id: string) => ({ id, name: id, isDefault: false, updatedAt: '2026-09-30T10:00:00Z', filters: { v: 2, kind: 'columns', columns: ['brand'] } })
const base = { surface: 'product-edit:views:EBAY', baseUrl: '/backend', getPageState: () => ({}), applyPageState: () => {} }
const render = (options: UseGridViewsOptions<Record<string, never>>) => {
  hooks.state.cursor = 0
  const result = useGridViews(options)
  for (const effect of hooks.state.effects.splice(0)) effect()
  return result
}

beforeEach(() => { hooks.state.slots = []; hooks.state.effects = [] })
afterEach(() => { for (const slot of hooks.state.slots) slot.cleanup?.(); vi.unstubAllGlobals() })

describe('initial saved-view source', () => {
  it('uses the initial source once and bypasses it on every explicit refresh', async () => {
    const initial = vi.fn(async () => ({ items: [view('initial')] }))
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [view('fresh')] })))
    vi.stubGlobal('fetch', fetcher)
    const options = { ...base, initialRead: { key: 'business-a:user-a', read: initial } }
    render(options)
    expect(initial).toHaveBeenCalledOnce()
    await initial.mock.results[0].value
    let state = render(options)
    expect(state.views.map(v => v.id)).toEqual(['initial'])
    expect(fetcher).not.toHaveBeenCalled()
    await state.refresh()
    state = render(options)
    expect(state.views.map(v => v.id)).toEqual(['fresh'])
    expect(initial).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('ignores an old source reply after the actor or business changed', async () => {
    let finish!: (value: unknown) => void
    const old = new Promise(resolve => { finish = resolve })
    const first = { ...base, initialRead: { key: 'business-a:user-a', read: () => old } }
    const next = vi.fn(async () => ({ items: [view('business-b-view')] }))
    const second = { ...base, initialRead: { key: 'business-b:user-b', read: next } }
    render(first)
    render(second)
    expect(next).toHaveBeenCalledOnce()
    await next.mock.results[0].value
    finish({ items: [view('business-a-view')] })
    await old
    expect(render(second).views.map(v => v.id)).toEqual(['business-b-view'])
  })

  it('keeps ordinary single-surface hosts on their existing request', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [] })))
    vi.stubGlobal('fetch', fetcher)
    render(base)
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/backend/api/saved-views?surface=product-edit%3Aviews%3AEBAY',
      { credentials: 'include', cache: 'no-store' })
  })
})

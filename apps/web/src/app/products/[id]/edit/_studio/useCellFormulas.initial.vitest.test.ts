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
vi.mock('./contracts', () => ({ useSaveReporter: () => ({ pending: vi.fn(), resolved: vi.fn() }) }))

import { useCellFormulas, type UseCellFormulasInput } from './useCellFormulas'

const input: UseCellFormulasInput = {
  productId: 'family-a', scope: 'channel', channel: 'EBAY', marketplace: 'IT', market: 'IT', locale: 'it',
  rowIds: ['row-a'], columnKeys: ['brand'], seedRows: [{ rowId: 'row-a', values: { brand: { formula: 'upper($brand)', formulaError: 'Review this source' } } }],
}
const render = (props: UseCellFormulasInput) => {
  hooks.state.cursor = 0
  const result = useCellFormulas(props)
  for (const effect of hooks.state.effects.splice(0)) effect()
  return result
}

describe('initial formula reads', () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ functions: [], formulas: [] })))
  beforeEach(() => { hooks.state.slots = []; hooks.state.effects = []; fetcher.mockClear(); vi.stubGlobal('fetch', fetcher) })
  afterEach(() => { for (const slot of hooks.state.slots) slot.cleanup?.(); vi.unstubAllGlobals() })

  it('uses the complete sheet formula state and function catalog without another initial request', () => {
    const formulas = render(input)
    expect(formulas.exprFor('row-a', 'brand')).toBe('upper($brand)')
    expect(formulas.errorFor('row-a', 'brand')).toBe('Review this source')
    expect(formulas.ready).toBe(true)
    expect(formulas.functions.some(fn => fn.name === 'upper')).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reads a row absent from the current coordinate seed', () => {
    render({ ...input, rowIds: ['row-a', 'row-b'] })
    const batches = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/formulas/batch'))
    expect(batches).toHaveLength(1)
    expect(JSON.parse((batches[0][1] as RequestInit).body as string).productIds).toEqual(['row-b'])
  })

  it('still makes an explicit reload for all rows, including seeded rows', () => {
    const formulas = render(input)
    fetcher.mockClear()
    formulas.reload()
    render(input)
    const batches = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/formulas/batch'))
    expect(batches).toHaveLength(1)
    expect(JSON.parse((batches[0][1] as RequestInit).body as string).productIds).toEqual(['row-a'])
  })

  it('keeps the account, listing alias and product address when only one alias needs a read', () => {
    render({ ...input, rowIds: ['row-a', 'alias-row'], channelConnectionId: 'account-a',
      rowScopes: { 'row-a': { productId: 'product-a', aliasKey: '' }, 'alias-row': { productId: 'product-a', aliasKey: 'alias-b' } },
    })
    const batches = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/formulas/batch'))
    expect(batches).toHaveLength(1)
    expect(JSON.parse((batches[0][1] as RequestInit).body as string)).toMatchObject({
      channelConnectionId: 'account-a', aliasKey: 'alias-b', productIds: ['product-a'], channel: 'EBAY', marketplace: 'IT', locale: 'it',
    })
  })
})

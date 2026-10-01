/**
 * P2 (2026-09-30, I4-4) — the reference names (category path, category labels, policies, description themes) are read
 * once per set of references, not again after every read of the sheet. Before, the lookup effect depended on the
 * columns ARRAY, which every read replaces, so each edit asked eBay IT's four name endpoints again.
 *
 * The web tests run in Node without a renderer, so React's three hooks this uses are replaced by a minimal runner that
 * keeps state between renders and runs an effect only when its dependencies change — exactly React's rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => {
  const same = (a: unknown[] | undefined, b: unknown[] | undefined) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const s = { slots: [] as Array<{ deps?: unknown[]; value?: unknown }>, i: 0, effects: [] as Array<() => void> }
  return {
    s,
    react: {
      useRef: (initial: unknown) => {
        const i = s.i++
        if (!(i in s.slots)) s.slots[i] = { value: { current: initial } }
        return s.slots[i].value
      },
      useState: (init: unknown) => {
        const i = s.i++
        if (!(i in s.slots)) s.slots[i] = { value: typeof init === 'function' ? (init as () => unknown)() : init }
        const slot = s.slots[i]
        return [slot.value, (next: unknown) => { slot.value = typeof next === 'function' ? (next as (v: unknown) => unknown)(slot.value) : next }]
      },
      useMemo: (fn: () => unknown, deps: unknown[]) => {
        const i = s.i++
        const prev = s.slots[i]
        if (prev && same(prev.deps, deps)) return prev.value
        s.slots[i] = { deps, value: fn() }
        return s.slots[i].value
      },
      useEffect: (fn: () => void, deps: unknown[]) => {
        const i = s.i++
        const prev = s.slots[i]
        if (prev && same(prev.deps, deps)) return
        s.slots[i] = { deps }
        s.effects.push(fn)
      },
    },
  }
})
vi.mock('react', () => hooks.react)

import { useReferenceNames } from './useReferenceNames'

type Sheet = Parameters<typeof useReferenceNames>[0]
const render = (sheet: Sheet) => {
  hooks.s.i = 0
  const out = useReferenceNames(sheet, 'EBAY', 'IT', 'acc-1')
  for (const effect of hooks.s.effects.splice(0)) effect()
  return out
}
const sheet = (brand: string): NonNullable<Sheet> => ({
  family: { id: 'fam-1' },
  scope: { kind: 'channel', connectionId: 'acc-1', locale: 'it' },
  columns: [{ key: 'categoryId', label: 'Category' }, { key: 'brand', label: 'Brand' }] as never,
  rows: [{ productType: null, values: { categoryId: { value: '177104' }, brand: { value: brand } } }],
})

describe('useReferenceNames', () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ labels: {}, breadcrumbs: {} })))
  beforeEach(() => { hooks.s.slots = []; fetch.mockClear(); vi.stubGlobal('fetch', fetch) })
  afterEach(() => vi.unstubAllGlobals())

  it('asks once for the names of one set of references', () => {
    render(sheet('A'))
    const asked = fetch.mock.calls.length
    expect(asked).toBeGreaterThan(0)
    // The sheet is read again (new objects, same columns) and a value that is not a reference changed.
    render(sheet('B'))
    render(sheet('C'))
    expect(fetch.mock.calls.length).toBe(asked)
  })

  it('does not ask Amazon for category names on a master sheet whose market is GLOBAL (2026-10-01)', () => {
    // The final browser round saw the master sheet at GLOBAL ask /categories/reference-labels four times; GLOBAL is not an
    // Amazon marketplace, so the API answered 400 every time. A real Amazon market still asks.
    const master = (market: string) => {
      hooks.s.i = 0; hooks.s.slots = []
      const out = useReferenceNames({ family: { id: 'fam-1' }, scope: { kind: 'master', locale: 'en' }, columns: [{ key: 'productType', label: 'Product type' }] as never,
        rows: [{ productType: 'E2E_COAT', values: {} }] } as never, 'MASTER', market)
      for (const effect of hooks.s.effects.splice(0)) effect()
      return out
    }
    const labelReads = () => fetch.mock.calls.filter(call => String((call as unknown[])[0]).includes('/categories/reference-labels')).length
    master('GLOBAL')
    expect(labelReads()).toBe(0)
    master('IT')
    expect(labelReads()).toBeGreaterThan(0)
  })

  it('asks again when the references themselves change', () => {
    render(sheet('A'))
    const asked = fetch.mock.calls.length
    const other = sheet('A')
    other.rows[0].values.categoryId = { value: '57988' }
    render(other)
    expect(fetch.mock.calls.length).toBeGreaterThan(asked)
  })
})

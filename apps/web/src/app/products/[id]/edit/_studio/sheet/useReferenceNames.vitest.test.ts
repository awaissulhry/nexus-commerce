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

  it('asks again when the references themselves change', () => {
    render(sheet('A'))
    const asked = fetch.mock.calls.length
    const other = sheet('A')
    other.rows[0].values.categoryId = { value: '57988' }
    render(other)
    expect(fetch.mock.calls.length).toBeGreaterThan(asked)
  })
})

/**
 * Audit B35 — each name lookup that landed after load set the names on its own, and each set gave the sheet new column
 * objects, so the grid rebuilt every column definition once per lookup (GALE eBay IT: 3 in the first seconds).
 */
describe('useReferenceNames — the lookups that land together rebuild the columns once', () => {
  beforeEach(() => { hooks.s.slots = []; vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  const withPolicies = (): NonNullable<Sheet> => ({ ...sheet('A'), columns: [{ key: 'categoryId', label: 'Category' }, { key: 'brand', label: 'Brand' }, { key: 'fulfillmentPolicyId', label: 'Shipping' }] as never })

  it('three lookups answering at different moments → one new set of columns', async () => {
    const answers: Record<string, unknown> = {
      'reference-labels': { labels: { brand: { X: 'Xavia' } } },
      'category-breadcrumbs': { breadcrumbs: { 177104: { local: 'Giacche' } } },
      policies: { fulfillment: [{ id: 'f1', name: 'Standard' }], payment: [], return: [] },
    }
    let delay = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const key = Object.keys(answers).find(k => String(url).includes(k)) ?? 'none'
      await new Promise(resolve => setTimeout(resolve, (delay += 100)))
      return new Response(JSON.stringify(answers[key] ?? {}))
    }))
    const input = withPolicies()
    const identities = new Set<unknown>([render(input)?.columns])
    for (let t = 0; t < 12; t++) { await vi.advanceTimersByTimeAsync(100); identities.add(render(input)?.columns) }
    // The first columns (no names yet), then ONE set with every name in it.
    expect(identities.size).toBe(2)
    const last = render(input)!.columns as Array<{ key: string; optionLabels?: Record<string, string> }>
    expect(last.find(c => c.key === 'categoryId')?.optionLabels).toMatchObject({ 177104: 'Giacche' })
  })

  it('a lookup still out after NAMES_FLUSH_MS does not hold back the names already in', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('category-breadcrumbs')) await new Promise(resolve => setTimeout(resolve, 5_000))
      return new Response(JSON.stringify({ labels: { brand: { A: 'Alpha' } }, breadcrumbs: { 177104: { local: 'Giacche' } } }))
    }))
    const input = sheet('A')
    const first = render(input)?.columns
    await vi.advanceTimersByTimeAsync(1_100)
    expect(render(input)?.columns).not.toBe(first)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => {
  type Slot = { value?: unknown; deps?: unknown[]; cleanup?: () => void }
  const state = { cursor: 0, slots: [] as Slot[], effects: [] as Array<() => void>, updates: 0 }
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
      return [slot.value, (value: unknown) => {
        const next = typeof value === 'function' ? (value as (old: unknown) => unknown)(slot.value) : value
        if (!Object.is(slot.value, next)) state.updates++
        slot.value = next
      }]
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

const reads = vi.hoisted(() => ({ policies: vi.fn(), themes: vi.fn() }))
vi.mock('./ebayPolicies', () => ({ policyLists: { paymentPolicyId: 'paymentPolicies' }, loadEbayPolicies: reads.policies }))
vi.mock('./referenceOptions', () => ({ isReferenceField: () => false, loadReferenceChoices: reads.themes }))
import { useReferenceNames } from './useReferenceNames'
import type { NamedColumn } from './referenceLabels'
const hydration = (market = 'IT'): { channel: string; market: string; lookups: Array<{ field: 'descriptionThemeId' | 'categoryId'; ids: string[]; labels: Record<string, string> }> } => ({ channel: 'EBAY', market, lookups: [
  { field: 'descriptionThemeId', ids: ['theme-a'], labels: { 'theme-a': 'Fresh theme' } },
  { field: 'categoryId', ids: ['123'], labels: { '123': 'Stored category path' } },
] })
const sheet = (meta: unknown = { referenceNames: hydration() }, theme = 'theme-a') => ({ family: { id: 'family-a' }, scope: { kind: 'channel', connectionId: 'account-a', locale: 'it' },
  columns: ['categoryId', 'descriptionThemeId', 'paymentPolicyId'].map((key): NamedColumn => ({ key, kind: 'text' })),
  rows: [{ values: { categoryId: { value: '123' }, descriptionThemeId: { value: theme }, paymentPolicyId: { value: 'policy-a' } } }], meta,
})
const render = (input: ReturnType<typeof sheet>) => {
  hooks.state.cursor = 0
  const output = useReferenceNames(input, 'EBAY', 'IT', 'account-a')
  for (const effect of hooks.state.effects.splice(0)) effect()
  return output!
}
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
const fetcher = vi.fn(async (_url: RequestInfo | URL) => new Response(JSON.stringify({ labels: {}, breadcrumbs: {} })))
const categoryCalls = () => fetcher.mock.calls.filter(([url]) => String(url).includes('/categories/reference-labels?'))
const breadcrumbCalls = () => fetcher.mock.calls.filter(([url]) => String(url).includes('/category-breadcrumbs?'))
beforeEach(() => {
  hooks.state.slots = []; hooks.state.effects = []; hooks.state.updates = 0
  reads.policies.mockReset().mockResolvedValue({ paymentPolicies: [{ id: 'policy-a', name: 'Policy name' }] })
  reads.themes.mockReset().mockResolvedValue({ labels: { 'theme-a': 'Fallback theme', 'theme-b': 'Second theme' }, options: [] })
  fetcher.mockReset().mockImplementation(async () => new Response(JSON.stringify({ labels: {}, breadcrumbs: {} })))
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { for (const slot of hooks.state.slots) slot.cleanup?.(); vi.unstubAllGlobals() })

describe('selected names carried by the sheet', () => {
  it('shows verified names immediately and retains the cold policy and breadcrumb reads', () => {
    const input = sheet(), output = render(input)
    expect(output.rows).toBe(input.rows)
    expect(output.columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-a']).toBe('Fresh theme')
    expect(output.columns.find(c => c.key === 'categoryId')?.optionLabels?.['123']).toBe('Stored category path')
    expect(reads.themes).not.toHaveBeenCalled()
    expect(categoryCalls()).toEqual([])
    expect(reads.policies).toHaveBeenCalledExactlyOnceWith('IT', false, 'account-a')
    expect(breadcrumbCalls()).toHaveLength(1)
  })
  it.each(['older-api','wrong-market','ambiguous'] as const)('keeps original lookups for %s metadata', kind => {
    const names = hydration(kind === 'wrong-market' ? 'DE' : 'IT')
    if (kind === 'ambiguous') names.lookups.push(...names.lookups)
    render(sheet(kind === 'older-api' ? {} : { referenceNames: names }))
    expect(reads.themes).toHaveBeenCalledOnce()
    expect(categoryCalls()).toHaveLength(1)
  })
  it('looks up a newly assigned uncovered theme without refetching unrelated names', async () => {
    render(sheet()); await settle()
    reads.themes.mockClear(); reads.policies.mockClear(); fetcher.mockClear()
    render(sheet({ referenceNames: hydration() }, 'theme-b')); await settle()
    const output = render(sheet({ referenceNames: hydration() }, 'theme-b'))
    expect(reads.themes).toHaveBeenCalledExactlyOnceWith('descriptionThemeId', {}, { live: false, refresh: true, reusePending: false })
    expect(output.columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-b']).toBe('Second theme')
    expect(reads.policies).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('gets a newly assigned theme even when another editor left an older module catalog warm', async () => {
    const actual = await vi.importActual<typeof import('./referenceOptions')>('./referenceOptions')
    let themes = [{ id: 'theme-a', name: 'Old catalog name', active: true, isDefault: false }]
    fetcher.mockImplementation(async url => new Response(JSON.stringify(String(url).includes('/ebay/description-themes?') ? { themes } : { labels: {}, breadcrumbs: {} })))
    // Use the real shared module cache, as an earlier editor or sheet mount would.
    await actual.loadReferenceChoices('descriptionThemeId', {}, { live: false, refresh: true })
    reads.themes.mockImplementation(actual.loadReferenceChoices)
    const themeCalls = () => fetcher.mock.calls.filter(([url]) => String(url).includes('/ebay/description-themes?'))
    fetcher.mockClear()
    const initial = sheet()
    render(initial); await settle()
    expect(themeCalls()).toHaveLength(0)
    expect(reads.themes).not.toHaveBeenCalled()

    themes = [...themes, { id: 'theme-b', name: 'Newly created theme', active: true, isDefault: false }]
    const assigned = { ...initial, rows: [...initial.rows, sheet(initial.meta, 'theme-b').rows[0]] }
    render(assigned); await settle()
    await reads.themes.mock.results.at(-1)?.value
    const output = render(assigned)
    expect(output.columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-b']).toBe('Newly created theme')
    expect(themeCalls()).toHaveLength(1)
  })
  it('does not join a catalog request that predates the hydrated sheet and its new assignment', async () => {
    const actual = await vi.importActual<typeof import('./referenceOptions')>('./referenceOptions')
    let releaseOld!: (response: Response) => void
    let themeReads = 0
    const theme = (id: string, name: string) => ({ id, name, active: true, isDefault: false })
    fetcher.mockImplementation(async url => {
      if (!String(url).includes('/ebay/description-themes?')) return new Response(JSON.stringify({ labels: {}, breadcrumbs: {} }))
      if (++themeReads === 1) return new Promise<Response>(resolve => { releaseOld = resolve })
      return new Response(JSON.stringify({ themes: [theme('theme-a', 'Current catalog name'), theme('theme-b', 'New theme')] }))
    })
    const old = actual.loadReferenceChoices('descriptionThemeId', {}, { live: true, refresh: true })
    reads.themes.mockImplementation(actual.loadReferenceChoices)
    const initial = sheet()
    render(initial); await settle()
    expect(reads.themes).not.toHaveBeenCalled()
    const assigned = { ...initial, rows: [...initial.rows, sheet(initial.meta, 'theme-b').rows[0]] }
    render(assigned); await settle()
    releaseOld(new Response(JSON.stringify({ themes: [theme('theme-a', 'Older catalog name')] })))
    await old; await reads.themes.mock.results.at(-1)?.value; await settle()
    const output = render(assigned)
    expect(output.columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-b']).toBe('New theme')
    expect(output.columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-a']).toBe('Current catalog name')
    expect(themeReads).toBe(2)
    expect((await actual.loadReferenceChoices('descriptionThemeId', {}, { live: false })).labels['theme-b']).toBe('New theme')
    expect(themeReads).toBe(2)
  })
  it('refreshes a prior fallback catalog when a newly assigned theme was absent from it', async () => {
    reads.themes.mockResolvedValueOnce({ labels: { 'theme-a': 'First theme' }, options: [] })
    const original = sheet({})
    render(original); await settle()
    expect(render(original).columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-a']).toBe('First theme')
    expect(reads.themes).toHaveBeenCalledOnce()
    reads.themes.mockClear(); reads.policies.mockClear(); fetcher.mockClear()

    // An exact-ID save can patch the assignment without a new sheet response. The old catalog did not know B.
    reads.themes.mockResolvedValue({ labels: { 'theme-a': 'First theme', 'theme-b': 'New theme' }, options: [] })
    const assigned = sheet(original.meta, 'theme-b')
    expect(assigned.meta).toBe(original.meta)
    render(assigned); await settle()
    const output = render(assigned)
    expect(output.columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-b']).toBe('New theme')
    expect(output.rows).toBe(assigned.rows)
    expect(reads.themes).toHaveBeenCalledExactlyOnceWith('descriptionThemeId', {}, { live: false, refresh: true, reusePending: false })
    expect(reads.policies).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('keeps correct catalog names when a new-theme refresh fails', async () => {
    reads.themes.mockResolvedValueOnce({ labels: { 'theme-a': 'First theme' }, options: [] })
    render(sheet({})); await settle()
    reads.themes.mockRejectedValue(new Error('Theme lookup failed'))
    const assigned = sheet({}, 'theme-b')
    render(assigned); await settle()
    const output = render(assigned)
    expect(reads.themes).toHaveBeenCalledTimes(2)
    expect(output.columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-a']).toBe('First theme')
    expect(output.columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-b']).toBeUndefined()
  })
  it('removes an old catalog name when a successful complete refresh verifies its absence', async () => {
    reads.themes.mockResolvedValueOnce({ labels: { 'theme-a': 'First theme' }, options: [] })
    render(sheet({})); await settle()
    reads.themes.mockResolvedValue({ labels: { 'theme-b': 'New theme' }, options: [] })
    const assigned = sheet({}, 'theme-b')
    render(assigned); await settle()
    const output = render(assigned)
    expect(output.columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-a']).toBeUndefined()
    expect(output.columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-b']).toBe('New theme')
  })
  it('uses a completed catalog absence over older sheet metadata until a fresh sheet arrives', async () => {
    const initial = sheet()
    render(initial); await settle()
    reads.themes.mockResolvedValue({ labels: { 'theme-b': 'New theme' }, options: [] })
    const assigned = sheet()
    assigned.rows.push(sheet({}, 'theme-b').rows[0])
    render(assigned); await settle()
    const output = render(assigned)
    expect(output.columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-a']).toBeUndefined()
    expect(output.columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-b']).toBe('New theme')
    const fresh = hydration()
    fresh.lookups[0].labels['theme-a'] = 'Restored theme'
    expect(render({ ...assigned, meta: { referenceNames: fresh } }).columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-a']).toBe('Restored theme')
  })
  it('accepts a fresh sheet read whose names equal the original metadata after an intervening catalog rename', async () => {
    const initial = sheet()
    render(initial); await settle()
    reads.themes.mockResolvedValue({ labels: { 'theme-a': 'Renamed theme', 'theme-b': 'Second theme' }, options: [] })
    const assigned = { ...initial, rows: [...initial.rows, sheet({}, 'theme-b').rows[0]] }
    render(assigned); await settle()
    expect(render(assigned).columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-a']).toBe('Renamed theme')

    // A rename back to the original text yields equal JSON, but this new meta object came from a fresh read.
    const fresh = { ...initial, meta: structuredClone(initial.meta) }
    expect(fresh.meta).toEqual(initial.meta)
    expect(fresh.meta).not.toBe(initial.meta)
    expect(render(fresh).columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-a']).toBe('Fresh theme')
  })
  it('keeps ordinary local edits with the same meta reference free of name reads and extra state updates', async () => {
    const initial = sheet()
    initial.columns.push({ key: 'brand', kind: 'text' })
    render(initial); await settle(); render(initial)
    reads.themes.mockClear(); reads.policies.mockClear(); fetcher.mockClear()
    const updates = hooks.state.updates
    const edited = { ...initial, rows: initial.rows.map(row => ({ ...row, values: { ...row.values, brand: { value: 'Edited brand' } } })) }
    expect(edited.meta).toBe(initial.meta)
    const output = render(edited)
    await settle()
    expect(render(edited)).toBe(output)
    expect(hooks.state.updates).toBe(updates)
    expect(reads.themes).not.toHaveBeenCalled()
    expect(reads.policies).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('keeps a last known name during optional failure and adopts a fresh server rename', async () => {
    render(sheet()); await settle()
    reads.themes.mockRejectedValue(new Error('Unavailable'))
    render(sheet({})); await settle()
    expect(render(sheet({})).columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-a']).toBe('Fresh theme')
    const names = hydration(); names.lookups[0].labels['theme-a'] = 'Renamed theme'
    expect(render(sheet({ referenceNames: names })).columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-a']).toBe('Renamed theme')
  })
  it('drops a cached name only when the new sheet verifies that the assigned ID has no name', async () => {
    render(sheet()); await settle()
    reads.themes.mockClear(); fetcher.mockClear()
    const names = hydration()
    // Empty labels with completed ID coverage are a measured absence, not a failed lookup.
    names.lookups[0].labels = {}
    const output = render(sheet({ referenceNames: names }))
    expect(output.columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-a']).toBeUndefined()
    expect(reads.themes).not.toHaveBeenCalled()
  })

  it('lets the selected-market taxonomy path take priority over the stored mapping label', async () => {
    fetcher.mockImplementation(async url => new Response(JSON.stringify(String(url).includes('category-breadcrumbs') ? { breadcrumbs: { '123': { local: 'Taxonomy path' } } } : { labels: {} })))
    render(sheet()); await settle()
    expect(render(sheet()).columns.find(c => c.key === 'categoryId')?.optionLabels?.['123']).toBe('Taxonomy path')
  })
})

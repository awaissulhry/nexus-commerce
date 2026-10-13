import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * G4 (2026-10-13) — a formula write takes its turn in the sheet's ONE write line (`writeLine`, over
 * `SheetWriter.exclusive`), and the row goes on from the version the formula route answered.
 *
 * The repro: Manufacturer `=upper("acme")`, then Cost 16 at once. The formula left through its own queue, the Cost save
 * left beside it with the version from before the formula, and came back 409 "Another change landed first".
 */
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
const reporter = vi.hoisted(() => ({ pending: vi.fn(), resolved: vi.fn(), cleared: vi.fn() }))
vi.mock('./contracts', () => ({ useSaveReporter: () => reporter }))

import { CellSaveTracker, SheetWriter, type SheetWriteRequest } from '@/design-system/grid'
import { useCellFormulas, type UseCellFormulasInput } from './useCellFormulas'
import { sheetFormulaLine } from './sheet/formulaWriteLine'

type Row = { id: string; listing?: { id: string; version?: number } | null }

const render = (props: UseCellFormulasInput) => {
  hooks.state.cursor = 0
  const result = useCellFormulas(props)
  for (const effect of hooks.state.effects.splice(0)) effect()
  return result
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((ok) => { resolve = ok })
  return { promise, resolve }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const flushMicrotasks = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

describe('formula writes in the sheet\'s write line', () => {
  let answer: ReturnType<typeof deferred<Response>>
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => answer.promise)
  const commits: SheetWriteRequest<Row>[] = []
  let writer: SheetWriter<Row>

  beforeEach(() => {
    vi.useFakeTimers()
    hooks.state.slots = []; hooks.state.effects = []
    answer = deferred<Response>()
    fetcher.mockClear(); commits.length = 0
    for (const fn of Object.values(reporter)) fn.mockClear()
    vi.stubGlobal('fetch', fetcher)
    writer = new SheetWriter<Row>({
      tracker: new CellSaveTracker(), getApi: () => null, flushMs: 5,
      commit: async (req) => { commits.push(req); return { ok: true, version: (req.expectedVersion ?? 0) + 1 } },
    })
  })
  afterEach(() => { for (const slot of hooks.state.slots) slot.cleanup?.(); vi.unstubAllGlobals(); vi.useRealTimers() })

  const sheet = (scope: Partial<UseCellFormulasInput> = {}): UseCellFormulasInput => ({
    productId: 'family-x', market: 'IT', locale: 'it', rowIds: ['row-x'], columnKeys: ['manufacturer', 'costPrice'],
    seedRows: [{ rowId: 'row-x', values: { manufacturer: { value: 'Acme Ltd' }, costPrice: { value: 15 } } }],
    writeLine: sheetFormulaLine(() => writer), ...scope,
  })

  it('G4: Cost typed right after a Manufacturer formula waits for it and sends the version the formula answered', async () => {
    writer.seed([{ id: 'row-x', version: 5 }])
    const formulas = render(sheet())
    const saved = formulas.save('row-x', 'manufacturer', 'upper("acme")')
    writer.set('row-x', 'costPrice', 16)
    await vi.advanceTimersByTimeAsync(50)

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String(fetcher.mock.calls[0]![0])).toContain('/api/pim/formulas/product/row-x')
    expect(commits).toHaveLength(0)

    answer.resolve(json({ ok: true, value: 'ACME', formula: { fieldKey: 'manufacturer', expr: 'upper("acme")', lastError: null },
      currentVersion: 6, versionOf: 'product', versionBefore: 5 }))
    await expect(saved).resolves.toMatchObject({ ok: true })
    await vi.advanceTimersByTimeAsync(50)
    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({ rowId: 'row-x', expectedVersion: 6, cells: [{ colId: 'costPrice', value: 16 }] })
  })

  it('a formula over a cell save already in the air leaves after it, with the version it answered', async () => {
    writer.seed([{ id: 'row-x', version: 5 }])
    const formulas = render(sheet())
    writer.set('row-x', 'brand', 'Acme')
    const replaced = formulas.replace('row-x', 'manufacturer', 'Zeta')
    await flushMicrotasks()
    expect(commits).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String(fetcher.mock.calls[0]![0])).toContain('/api/pim/formulas/product/row-x/value')
    answer.resolve(json({ ok: true, value: 'Zeta', currentVersion: 7, versionOf: 'product', versionBefore: 6 }))
    await expect(replaced).resolves.toMatchObject({ ok: true })
    expect(writer.versionOf('row-x')).toBe(7)
  })

  it('another change in between is not on screen: the row keeps the version it holds', async () => {
    writer.seed([{ id: 'row-x', version: 5 }])
    const formulas = render(sheet())
    const saved = formulas.save('row-x', 'manufacturer', 'upper("acme")')
    await vi.advanceTimersByTimeAsync(0)
    answer.resolve(json({ ok: true, value: 'ACME', formula: { expr: 'upper("acme")', lastError: null }, currentVersion: 9, versionOf: 'product', versionBefore: 8 }))
    await saved
    expect(writer.versionOf('row-x')).toBe(5)
  })

  it('a channel listing\'s version goes to the row\'s listing, never to the product version the writer holds', async () => {
    const row: Row = { id: 'row-x', listing: { id: 'listing-x', version: 3 } }
    writer.seed([{ id: 'row-x', version: 5, row }])
    const formulas = render(sheet({ scope: 'channel', channel: 'EBAY', marketplace: 'IT' }))
    const saved = formulas.save('row-x', 'manufacturer', 'upper("acme")')
    await vi.advanceTimersByTimeAsync(0)
    answer.resolve(json({ ok: true, value: 'ACME', formula: { expr: 'upper("acme")', lastError: null }, currentVersion: 4, versionOf: 'channelListing', versionBefore: 3, listingId: 'listing-x' }))
    await saved
    expect(row.listing!.version).toBe(4)
    expect(writer.versionOf('row-x')).toBe(5)
  })

  it('a removal takes its turn too, and a write the sheet discarded first never leaves and fails nothing', async () => {
    writer.seed([{ id: 'row-x', version: 5 }])
    const formulas = render(sheet())
    const held = deferred<{ ok: boolean; version: number }>()
    const slow = new SheetWriter<Row>({ tracker: new CellSaveTracker(), getApi: () => null, flushMs: 5, commit: () => held.promise })
    writer = slow
    slow.set('row-x', 'brand', 'Acme')
    const removed = formulas.pinOver('row-x', 'manufacturer')
    await vi.advanceTimersByTimeAsync(10)
    expect(fetcher).not.toHaveBeenCalled()
    slow.discard()
    await expect(removed).resolves.toMatchObject({ ok: false, dropped: true })
    expect(fetcher).not.toHaveBeenCalled()
    expect(reporter.resolved).not.toHaveBeenCalled()
    expect(reporter.cleared).toHaveBeenCalledTimes(1)
    held.resolve({ ok: true, version: 6 })
  })
})

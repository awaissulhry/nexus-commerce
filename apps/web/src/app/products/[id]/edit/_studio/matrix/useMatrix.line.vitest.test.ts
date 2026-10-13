/**
 * One save line (2026-10-13): the bulk Edit's verbs go through the SAME line as every cell write. A price typed just before
 * Apply lands first (the run is never refused as "Changed since the preview" against the person's own edit); the preview
 * waits too; and the versions a run leaves are this page's own moves, so a cell typed before the run landed is sent at the
 * version the run left. Node has no React renderer, so only hook scheduling is replaced (as in `useMatrix.reload`).
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { MatrixWriteCell, MatrixWriteOutcome, VerbPreview } from './contract'

const hooks = vi.hoisted(() => {
  type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }
  const state = { slots: [] as Slot[], index: 0, effects: [] as Array<() => void> }
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const memo = (make: () => unknown, deps: readonly unknown[]) => {
    const index = state.index++, prior = state.slots[index]
    if (!prior || !same(prior.deps, deps)) state.slots[index] = { deps, value: make() }
    return state.slots[index].value
  }
  return { state, react: {
    useState: (initial: unknown) => {
      const index = state.index++
      if (!state.slots[index]) state.slots[index] = { value: typeof initial === 'function' ? (initial as () => unknown)() : initial }
      const slot = state.slots[index]
      return [slot.value, (next: unknown) => { slot.value = typeof next === 'function' ? (next as (old: unknown) => unknown)(slot.value) : next }]
    },
    useMemo: memo,
    useRef: (initial: unknown) => memo(() => ({ current: initial }), []),
    useCallback: (fn: unknown, deps: readonly unknown[]) => memo(() => fn, deps),
    useEffect: (run: () => void | (() => void), deps: readonly unknown[]) => {
      const index = state.index++, prior = state.slots[index]
      if (prior && same(prior.deps, deps)) return
      const slot: Slot = { deps }
      state.slots[index] = slot
      state.effects.push(() => { prior?.cleanup?.(); const cleanup = run(); if (cleanup) slot.cleanup = cleanup })
    },
  } }
})
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...hooks.react }))

/** The server: the listing's version, the cell writes it received (and the account each named), a gate that holds the
    next one, and whether it answers a conflict. */
const server = vi.hoisted(() => ({ version: 3, patches: [] as MatrixWriteCell[][], accounts: [] as Array<string | null | undefined>, hold: null as null | Promise<void>, conflict: false }))
const cellsAt = (version: number) => ({
  listingId: 'L1', version, listing: null, fulfilment: null, sync: null, queue: null, sale: { value: null, start: null, end: null },
  price: { value: 100, currency: 'EUR', source: 'override', formula: null, clamped: null }, writable: { price: true, salePrice: true }, writeBlockedReason: {},
})
vi.mock('./source', async original => ({
  ...await original<typeof import('./source')>(),
  fetchMatrix: vi.fn(async () => ({ kind: 'live', read: { source: 'live', productId: 'p1', coordinates: [], rows: [{ id: 'r1', cells: { 'EBAY:IT': cellsAt(server.version) } }] } })),
  patchMatrix: vi.fn(async (_p: string, cells: MatrixWriteCell[], opts?: { accountId?: string | null }) => {
    server.patches.push(cells)
    server.accounts.push(opts?.accountId)
    if (server.hold) await server.hold
    // A conflict answers without a sentence of its own: the page says the one sentence.
    const results: MatrixWriteOutcome[] = cells.map((c) => (server.conflict
      ? { rowId: c.rowId, coordinateKey: c.coordinateKey, cell: c.cell, outcome: 'conflict', version: server.version }
      : { rowId: c.rowId, coordinateKey: c.coordinateKey, cell: c.cell, outcome: 'applied', version: ++server.version }))
    return { results, version: 1 }
  }),
}))
vi.mock('../useListingValuesLive', () => ({ useListingValuesLive: () => {} }))
vi.mock('@/lib/sync/invalidation-channel', () => ({ emitInvalidation: () => {} }))

import { MATRIX_COPY } from './contract'
import { useMatrix, type MatrixState } from './useMatrix'

let current: MatrixState
let account: string | null = null
const marks: Array<[string, string, string, string | undefined]> = []
const tracker = { set: (rowId: string, colId: string, state: string, reason?: string) => { marks.push([rowId, colId, state, reason]) }, get: () => undefined, clear: () => {} }
const api = { isDestroyed: () => false, getEditingCells: () => [], refreshCells: () => {}, getRowNode: () => null, addEventListener: () => {}, removeEventListener: () => {} }
const render = () => {
  hooks.state.index = 0
  current = useMatrix({ productId: 'p1', accountId: account, locale: null, tracker: tracker as never, getApi: () => api as never })
  for (const effect of hooks.state.effects.splice(0)) effect()
  return current
}
const settle = async () => { for (let i = 0; i < 12; i++) { await Promise.resolve(); render() } return current }

/** The verbs endpoint: every call, and a run that moves L1 by one version, checked at the version it had. */
const verbCalls: Array<{ commit: boolean }> = []
const preview: VerbPreview = {
  verb: 'set-price', confirm: 'none', confirmWord: null, simulated: false, notices: [], refusals: [],
  changes: [{ rowId: 'r1', sku: 'A', coordinateKey: 'EBAY:IT', cell: 'price', from: 100, to: 90, fromLabel: '€100.00', toLabel: '€90.00' }],
}

beforeEach(async () => {
  hooks.state.slots = []; hooks.state.effects = []; hooks.state.index = 0
  Object.assign(server, { version: 3, patches: [], accounts: [], hold: null, conflict: false })
  verbCalls.length = 0
  marks.length = 0
  account = null
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(init.body ?? '{}') as { commit: boolean }
    verbCalls.push({ commit: body.commit })
    if (!body.commit) return new Response(JSON.stringify(preview), { status: 200 })
    const at = server.version
    server.version += 1
    const results: MatrixWriteOutcome[] = [{ rowId: 'r1', coordinateKey: 'EBAY:IT', cell: 'price', outcome: 'applied', version: server.version, writtenAt: at, listings: [{ listingId: 'L1', productId: 'r1', version: server.version }] }]
    return new Response(JSON.stringify({ operation: { id: 'op1', verb: 'set-price', appliedAt: '', applied: 1, refused: 0, before: [] }, results }), { status: 200 })
  }))
  render(); await settle()
  expect(current.status).toBe('ready')
})
afterEach(() => {
  for (const slot of hooks.state.slots) slot.cleanup?.()
  vi.unstubAllGlobals()
})

const typed = (cell: MatrixWriteCell['cell'], value: unknown, expectedVersion: number): MatrixWriteCell =>
  ({ rowId: 'r1', coordinateKey: 'EBAY:IT', cell, value, expectedVersion, expectedListingId: 'L1' })

it('Apply waits for a price typed just before it: the run is sent only once that write has landed', async () => {
  let release!: () => void
  server.hold = new Promise((resolve) => { release = resolve })
  const typing = current.write([typed('price', 95, 3)])
  const applying = current.applyVerbRun(preview)
  await settle()
  expect(server.patches).toHaveLength(1)
  expect(verbCalls).toEqual([])
  expect(current.pending()).toBe(2)
  release(); server.hold = null
  await typing; await applying; await settle()
  expect(verbCalls).toEqual([{ commit: true }])
  expect(current.pending()).toBe(0)
})

it('the preview waits for the writes ahead of it, and reads nothing while one is in flight', async () => {
  let release!: () => void
  server.hold = new Promise((resolve) => { release = resolve })
  const typing = current.write([typed('price', 95, 3)])
  const previewing = current.previewVerbRun({ params: { verb: 'set-price', value: 90 }, targets: [{ rowId: 'r1', coordinateKey: 'EBAY:IT' }], commit: false })
  await settle()
  expect(verbCalls).toEqual([])
  release(); server.hold = null
  await typing
  expect(await previewing).toEqual(preview)
  expect(verbCalls).toEqual([{ commit: false }])
})

it('the versions a run leaves are this page\'s own moves: a cell typed before it landed is sent at the version it left', async () => {
  // The Sale cell was edited on the view while the run was on its way: built at version 3.
  const applying = current.applyVerbRun(preview)
  const sale = current.write([typed('salePrice', { value: 79, start: null, end: null }, 3)])
  await applying; await sale
  expect(server.patches.at(-1)!.map((c) => [c.cell, c.expectedVersion])).toEqual([['salePrice', 4]])
})

/* Moved here from `listingValuesWiring` (2026-10-13): it asserted useMatrix's source text, which #610's field stamps
   changed; the behaviour it guards is asserted here instead. */
it('writes name the read\'s account and each cell\'s listing; a conflict says the one sentence', async () => {
  hooks.state.slots = []; hooks.state.effects = []; hooks.state.index = 0
  account = 'acc-1'
  render(); await settle()
  // A typed cell names no listing: the write names the one the read showed on that coordinate.
  server.conflict = true
  await current.write([{ rowId: 'r1', coordinateKey: 'EBAY:IT', cell: 'price', value: 95, expectedVersion: 3 }])
  expect(server.accounts).toEqual(['acc-1'])
  expect(server.patches[0]).toEqual([expect.objectContaining({ expectedListingId: 'L1', expectedVersion: 3 })])
  expect(marks.at(-1)).toEqual(['r1', 'EBAY:IT.price', 'refused', MATRIX_COPY.changedElsewhere])
})

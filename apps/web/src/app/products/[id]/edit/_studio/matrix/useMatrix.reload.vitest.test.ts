/**
 * Grid audit F8 — a Reload of the family on screen keeps its cells (`reloading` draws the grid's loading veil) and never
 * repaints an open editor. Node has no React renderer, so only hook scheduling is replaced (as in the useMasterSheet
 * tests); the real hook runs against a stubbed `fetchMatrix`.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

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

const server = vi.hoisted(() => ({ name: 'A', reads: 0, hold: false, held: [] as Array<() => void> }))
vi.mock('./source', async original => ({
  ...await original<typeof import('./source')>(),
  fetchMatrix: vi.fn(async () => {
    server.reads++
    const answer = { kind: 'live', read: { source: 'live', productId: 'p1', rows: [{ id: 'r1', cells: {}, name: server.name }] } }
    return server.hold ? new Promise(resolve => server.held.push(() => resolve(answer))) : answer
  }),
}))
vi.mock('../useListingValuesLive', () => ({ useListingValuesLive: () => {} }))

import { useMatrix, type MatrixState } from './useMatrix'

let current: MatrixState
let editing: unknown[]
let onStop: (() => void) | null
const api = {
  isDestroyed: () => false,
  getEditingCells: () => editing,
  refreshCells: () => {},
  addEventListener: (_: string, fn: () => void) => { onStop = fn },
  removeEventListener: () => { onStop = null },
}
const render = () => {
  hooks.state.index = 0
  current = useMatrix({ productId: 'p1', accountId: null, locale: null, tracker: {} as never, getApi: () => api as never })
  for (const effect of hooks.state.effects.splice(0)) effect()
  return current
}
const settle = async () => { for (let i = 0; i < 12; i++) { await Promise.resolve(); render() } return current }
const nameOf = () => (current.read?.rows[0] as unknown as { name: string } | undefined)?.name

beforeEach(async () => {
  hooks.state.slots = []; hooks.state.effects = []; hooks.state.index = 0
  Object.assign(server, { name: 'A', reads: 0, hold: false, held: [] })
  editing = []; onStop = null
  render(); await settle()
  expect(current.status).toBe('ready')
})
afterEach(() => {
  for (const slot of hooks.state.slots) slot.cleanup?.()
  for (const release of server.held) release()
})

it('a Reload keeps the read on screen with the veil on, and replaces it when the new read lands', async () => {
  const before = current.read
  server.hold = true; server.name = 'B'
  current.reload(); await settle()
  expect(current.status).toBe('ready')
  expect(current.reloading).toBe(true)
  expect(current.read).toBe(before)
  server.held.shift()!()
  await settle()
  expect(current.reloading).toBe(false)
  expect(nameOf()).toBe('B')
  expect(server.reads).toBe(2)
})

it('a Reload while an editor is open waits for it to close, with no veil over the editor, then lands', async () => {
  editing = [{ rowIndex: 0 }]
  server.name = 'B'
  current.reload(); await settle()
  expect(server.reads).toBe(1)
  expect(current.reloading).toBe(false)
  expect(nameOf()).toBe('A')
  editing = []
  onStop!()
  await new Promise(resolve => setTimeout(resolve, 0))
  await settle()
  expect(server.reads).toBe(2)
  expect(nameOf()).toBe('B')
})

it('two Reloads close together (the one after a stock-source switch) read twice and leave no veil on', async () => {
  server.hold = true
  current.reload(); await settle()
  current.reload(); await settle()
  expect(server.held).toHaveLength(1)
  server.held.shift()!()
  await settle()
  expect(current.reloading).toBe(true)
  server.held.shift()!()
  await settle()
  expect(current.reloading).toBe(false)
  expect(server.reads).toBe(3)
})

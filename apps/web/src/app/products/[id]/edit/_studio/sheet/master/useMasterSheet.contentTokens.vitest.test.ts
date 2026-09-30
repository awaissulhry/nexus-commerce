/**
 * Current sheet paths, without qualified receipts: a refusal and quiet reads must not teach an old content cell a
 * newer write token. Node has no React renderer, so only hook scheduling is replaced (as in useReferenceNames tests).
 * The real master hook, read/merge, SheetWriter, bulk client and request builder run against a synthetic CAS server.
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

import { useMasterSheet, type MasterSheetState } from './useMasterSheet'
import type { StudioSheet } from './types'

type Sent = { expectedVersion?: number; changes: Array<{ field: string; value: string; contentVersion?: number }> }
let current: MasterSheetState
let stored: { owner: number; content: number; name: string; description: string; brand: string }
let sent: Sent[]
let readCount: number
let holdReads: boolean
let heldReads: Array<() => void>
let formulaOnBrand: boolean

const page = (): StudioSheet => ({
  family: { id: 'proof-product' }, scope: { kind: 'master', label: 'Shared German', marketplace: 'DE', locale: 'de' },
  columns: ['name', 'description', 'brand'].map(key => ({ key, writeField: key, label: key, kind: 'text', group: 'content',
    storage: key === 'brand' ? 'column' : 'localizedContent', scope: 'global', requiredBy: [], editable: true })),
  rows: [{ id: 'proof-product', sku: 'synthetic-content-proof', rowKind: 'parent', version: stored.owner,
    values: Object.fromEntries(['name', 'description', 'brand'].map(key => [key, { value: stored[key as 'name' | 'description' | 'brand'],
      ...(key === 'brand' ? {} : { contentAddress: { tier: 'language', language: 'de' }, contentVersion: stored.content }),
      writeField: key, writeTarget: 'master', writeVerb: 'master', writable: true, editable: true, source: 'translation', layer: 'master' }])) }],
  meta: { source: 'studio' },
} as unknown as StudioSheet)

const render = () => {
  hooks.state.index = 0
  current = useMasterSheet({ productId: 'proof-product', market: 'DE', locale: 'de' })
  for (const effect of hooks.state.effects.splice(0)) effect()
  return current
}
// Render after queued fetch/json/state work. No debounce is awaited: writes explicitly flush their real queue.
const settle = async () => {
  for (let i = 0; i < 12; i++) { await Promise.resolve(); render() }
  return current
}

beforeEach(async () => {
  hooks.state.slots = []; hooks.state.effects = []; hooks.state.index = 0
  stored = { owner: 10, content: 4, name: 'Name A', description: 'Description A', brand: 'Brand A' }
  sent = []; readCount = 0; holdReads = false; heldReads = []; formulaOnBrand = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') {
      expect(String(url)).toContain('/studio/sheet?')
      readCount++
      const response = new Response(JSON.stringify(page()))
      return holdReads ? new Promise<Response>(resolve => heldReads.push(() => resolve(response))) : response
    }
    expect(String(url)).toContain('/products/bulk-save')
    const input = JSON.parse(String(init.body)) as { units: Array<Sent & { key: string }> }
    const units = input.units.map(unit => {
      sent.push(unit)
      const accepted = unit.expectedVersion === stored.owner && unit.changes.every(change => change.contentVersion === undefined || change.contentVersion === stored.content)
      if (!accepted) return { key: unit.key, status: 409, body: { error: 'Changed', currentVersion: stored.owner, versionOf: 'product' } }
      for (const change of unit.changes) stored[change.field as 'name' | 'description' | 'brand'] = change.value
      const writesContent = unit.changes.some(change => change.contentVersion !== undefined)
      stored.owner++
      if (writesContent) stored.content++
      if (formulaOnBrand && unit.changes.some(change => change.field === 'brand')) {
        stored.description = stored.brand.toUpperCase(); stored.owner++; stored.content++
      }
      return { key: unit.key, status: 200, body: { updated: unit.changes.length, currentVersion: stored.owner, versionOf: 'product',
        ...(writesContent ? { contentVersions: [{ id: 'proof-product', tier: 'language', language: 'de', version: stored.content }] } : {}) } }
    })
    return new Response(JSON.stringify({ units, saved: units.filter(unit => unit.status === 200).length, failed: units.filter(unit => unit.status !== 200).length }))
  }))
  render(); await settle()
  expect(current.loading).toBe(false)
  expect(current.contractProblems).toEqual([])
})
afterEach(() => {
  for (const slot of hooks.state.slots) slot.cleanup?.()
  for (const release of heldReads) release()
  vi.unstubAllGlobals()
})

const edit = async (field: string, value: string) => {
  const row = current.sheet!.rows[0]
  current.writer.set(row.id, field, value, { row })
  await current.writer.flush()
  await settle()
}
const refresh = async () => { current.refresh(); render(); await settle() }

it.each(['set', 'retry'] as const)('a refused Name keeps its token through two quiet reads, seed and %s', async action => {
  stored = { ...stored, owner: 11, content: 5, name: 'Name B', description: 'Description B' }
  await edit('name', 'First attempted name')
  expect(current.tracker.get('proof-product', 'name')?.state).toBe('refused')
  expect(sent[0]).toMatchObject({ expectedVersion: 10, changes: [{ contentVersion: 4 }] })
  await refresh()
  expect(current.sheet!.rows[0].values.name.contentVersion).toBe(4)
  expect(current.sheet!.rows[0].values.description.contentVersion).toBe(5)
  await refresh()
  expect(readCount).toBe(3)
  expect.soft(current.sheet!.rows[0].values.name.contentVersion).toBe(4)
  if (action === 'set') await edit('name', 'Second attempted name')
  else { expect(current.writer.retryFailed()).toBe(1); await current.writer.flush(); await settle() }
  expect.soft(sent[1]).toMatchObject({ expectedVersion: 10, changes: [{ contentVersion: 4 }] })
  expect.soft(current.tracker.get('proof-product', 'name')?.state).toBe('refused')
  expect(stored.name).toBe('Name B')
})

it('a diagnostic 409 does not pair a recreated content counter with the newer generic owner', async () => {
  // A delete/recreate can end with the same content counter; only the owner distinguishes the snapshots.
  stored = { ...stored, owner: 12, content: 4, name: 'Name B', description: 'Description B' }
  await edit('description', 'Refused description')
  expect(current.tracker.get('proof-product', 'description')?.state).toBe('refused')
  expect(current.writer.versionOf('proof-product')).toBe(12)
  await edit('name', 'Unseen overwrite')
  expect.soft(sent[1]).toMatchObject({ expectedVersion: 10, changes: [{ contentVersion: 4 }] })
  expect.soft(current.tracker.get('proof-product', 'name')?.state).toBe('refused')
  expect(stored.name).toBe('Name B')
})

it('the control: a fresh read of the recreated Name supplies a valid pair for its next edit', async () => {
  stored = { ...stored, owner: 12, content: 4, name: 'Name B', description: 'Description B' }
  await refresh()
  expect(current.sheet!.rows[0].values.name.value).toBe('Name B')
  await edit('name', 'Reviewed next name')
  expect(sent[0]).toMatchObject({ expectedVersion: 12, changes: [{ contentVersion: 4 }] })
  expect(current.tracker.get('proof-product', 'name')?.state).toBe('saved')
  expect(stored.name).toBe('Reviewed next name')
})

it('refuses a batch of differing confirmed pairs before sending any of that batch', async () => {
  stored = { ...stored, owner: 11, content: 5, name: 'Name B', description: 'Description B' }
  await edit('name', 'Refused name')
  await refresh()
  const row = current.sheet!.rows[0]
  current.writer.set(row.id, 'name', 'New name', { row })
  current.writer.set(row.id, 'description', 'New description', { row })
  await current.writer.flush(); await settle()
  expect(sent).toHaveLength(1)
  expect(current.tracker.get(row.id, 'name')).toMatchObject({ state: 'refused', reason: expect.stringContaining('Reload') })
  expect(current.tracker.get(row.id, 'description')).toMatchObject({ state: 'refused', reason: expect.stringContaining('Reload') })
  expect(stored).toMatchObject({ name: 'Name B', description: 'Description B' })
})

it.each([false, true])('a proven own fact CAS advances the owner but never invents a content counter (formula=%s)', async formula => {
  holdReads = true; formulaOnBrand = formula
  await edit('brand', 'Own brand')
  expect(current.tracker.get('proof-product', 'brand')?.state).toBe('saved')
  expect(heldReads.length).toBeGreaterThan(0)
  expect(current.sheet!.rows[0].values.name.contentVersion).toBe(4)
  await edit('name', 'Own next name')
  expect(sent[1]).toMatchObject({ expectedVersion: formula ? 12 : 11, changes: [{ contentVersion: 4 }] })
  expect(current.tracker.get('proof-product', 'name')?.state).toBe(formula ? 'refused' : 'saved')
  expect(stored.name).toBe(formula ? 'Name A' : 'Own next name')
})

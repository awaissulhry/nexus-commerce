/**
 * 2.4 — the Variants page (channel scope) sends its writes one at a time, re-based on its own versions, shows no read
 * older than what is on screen, and keeps an unsaved mapping until a real 409. Node has no React renderer, so only hook
 * scheduling is replaced (as in `useMatrix.reload.vitest.test.ts`); the real hook runs against a stub server that
 * checks `expectedVersion` the way the projection routes do.
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

import { MAPPING_CHANGED_ELSEWHERE } from './copy'
import { draftDirty, draftOf, heldAfter, startDraft } from './mappingDraft'
import type { ProjectionDraft, ProjectionMapping, ProjectionPage, ProjectionSaveResult, ProjectionSource } from './types'
import { useProjection, type ProjectionState } from './useProjection'

/* ── the stub server: one parent listing version, checked on every write ─────────────────────────────────────────── */

type Held = Array<() => void>
const server = {
  version: 5,
  included: new Map<string, boolean>(),
  mapping: [] as ProjectionMapping[],
  sent: [] as Array<{ kind: 'children' | 'mapping'; expectedVersion: number }>,
  holdReads: false, heldReads: [] as Held,
  holdWrites: false, heldWrites: [] as Held,
}
const mapped = (target: string): ProjectionMapping[] => [{ axisKey: 'Colore', axisLabel: 'Colore', target, order: 0 }]
const pageOf = (): ProjectionPage => ({
  version: server.version,
  mapping: server.mapping.map(m => ({ ...m })),
  split: { mode: 'single', listings: [], creatable: false },
  children: [...server.included].map(([id, included]) => ({ id, sku: id.toUpperCase(), included, values: {}, listing: { state: 'live', externalId: null } })),
} as unknown as ProjectionPage)
const hold = (on: boolean, line: Held) => (on ? new Promise<void>(resolve => line.push(resolve)) : Promise.resolve())

/** Each write is checked when it reaches the server — the projection routes' compare-and-set on the parent listing. */
async function written(kind: 'children' | 'mapping', expectedVersion: number, apply: () => void): Promise<ProjectionSaveResult> {
  server.sent.push({ kind, expectedVersion })
  await hold(server.holdWrites, server.heldWrites)
  if (expectedVersion !== server.version) {
    return { ok: false, conflict: true, current: pageOf(), reason: 'This listing changed after you opened it.', code: 'version_conflict' }
  }
  apply()
  server.version += 1
  return { ok: true, version: server.version }
}
const source: ProjectionSource = {
  /* The snapshot is taken when the read REACHES the server; a held read answers it later. */
  async read() { const snapshot = pageOf(); await hold(server.holdReads, server.heldReads); return snapshot },
  setIncluded: (expectedVersion, changes) => written('children', expectedVersion, () => { for (const c of changes) server.included.set(c.id, c.included) }),
  saveMapping: (expectedVersion, draft) => written('mapping', expectedVersion, () => { server.mapping = draft.mapping.map(m => ({ ...m })) }),
}

/* ── the harness ─────────────────────────────────────────────────────────────────────────────────────────────────── */

let current: ProjectionState
const render = () => {
  hooks.state.index = 0
  current = useProjection(source)
  for (const effect of hooks.state.effects.splice(0)) effect()
  return current
}
const settle = async () => { for (let i = 0; i < 16; i++) { await Promise.resolve(); render() } return current }
/** Microtasks WITHOUT a render: answers land, but no effect re-runs (a re-read's abort has not happened yet). */
const drain = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
const includedOf = (id: string) => current.page?.children.find(c => c.id === id)?.included

beforeEach(async () => {
  hooks.state.slots = []; hooks.state.effects = []; hooks.state.index = 0
  Object.assign(server, {
    version: 5, included: new Map([['c1', false], ['c2', false]]), mapping: mapped('Color'), sent: [],
    holdReads: false, heldReads: [], holdWrites: false, heldWrites: [],
  })
  render(); await settle()
  expect(current.page?.version).toBe(5)
})
afterEach(() => {
  for (const slot of hooks.state.slots) slot.cleanup?.()
  for (const release of [...server.heldReads, ...server.heldWrites]) release()
})

/* ── the tests ───────────────────────────────────────────────────────────────────────────────────────────────────── */

it('two quick ticks both land: the second is sent at the version the first left, never beside it', async () => {
  server.holdWrites = true
  current.setIncluded('c1', true)
  current.setIncluded('c2', true)
  await settle()
  /* One at a time: the second waits in line, and both rows say they are pending. */
  expect(server.sent).toEqual([{ kind: 'children', expectedVersion: 5 }])
  expect([...current.pending].sort()).toEqual(['c1', 'c2'])
  expect([includedOf('c1'), includedOf('c2')]).toEqual([true, true])

  server.heldWrites.shift()!()
  await settle()
  expect(server.sent.map(s => s.expectedVersion)).toEqual([5, 6])
  /* A re-read between the two writes does not flip the tick still in line back. */
  expect(includedOf('c2')).toBe(true)

  server.heldWrites.shift()!()
  await settle()
  expect(server.included.get('c1')).toBe(true)
  expect(server.included.get('c2')).toBe(true)
  expect(server.version).toBe(7)
  expect(current.writeError).toBeNull()
  expect(current.pending.size).toBe(0)
  expect([includedOf('c1'), includedOf('c2'), current.page?.version]).toEqual([true, true, 7])
})

it('an older read never replaces a newer one: a read that left before a tick landed is dropped when it answers after', async () => {
  server.holdWrites = true
  current.setIncluded('c1', true)
  await settle()
  server.holdReads = true
  current.reload()
  await settle()
  expect(server.heldReads).toHaveLength(1) // it read c1 excluded at version 5

  server.heldWrites.shift()!() // the tick lands: version 6, c1 included
  await drain()
  server.heldReads.shift()!() // … and the older read answers after it, before any re-render could abort it
  await drain()
  render()
  expect(includedOf('c1')).toBe(true)
  expect(current.page?.version).toBe(6)

  /* The next tick goes out at the version the page now stands at, and lands. */
  server.holdReads = false; server.holdWrites = false
  for (const release of server.heldReads.splice(0)) release()
  await settle()
  current.setIncluded('c2', true)
  await settle()
  expect(server.sent.at(-1)).toEqual({ kind: 'children', expectedVersion: 6 })
  expect(server.included.get('c2')).toBe(true)
  expect(current.writeError).toBeNull()
})

it('a refresh during an unsaved mapping keeps it, and the save goes out re-based past this page\'s own tick', async () => {
  const edited: ProjectionDraft = { ...draftOf(current.page!), mapping: mapped('Colour') }
  let held = { ...startDraft(current.page!), draft: edited }
  expect(draftDirty(held)).toBe(true)

  current.setIncluded('c1', true) // this page's own write: 5 → 6, then a re-read
  await settle()
  current.reload() // and a Reload on top
  await settle()
  expect(current.page?.version).toBe(6)
  held = heldAfter(held, current.page!, false)
  expect(held.draft).toBe(edited)
  expect(held.base.version).toBe(5)

  const ok = await current.saveMapping(held.draft, held.base.version)
  await settle()
  expect(ok).toBe(true)
  expect(server.sent.at(-1)).toEqual({ kind: 'mapping', expectedVersion: 6 })
  expect(server.mapping[0].target).toBe('Colour')
  expect(current.mappingConflicts).toBe(0)
  expect(current.writeError).toBeNull()
})

it('an untouched draft follows a refresh — there is nothing of the operator\'s to keep', async () => {
  const held = startDraft(current.page!)
  server.mapping = mapped('Shade'); server.version = 9
  current.reload()
  await settle()
  const after = heldAfter(held, current.page!, false)
  expect(after.base.version).toBe(9)
  expect(after.draft.mapping[0].target).toBe('Shade')
})

it('a real 409 resets the unsaved mapping to the server\'s and says so; the other edit is not overwritten', async () => {
  let held = { ...startDraft(current.page!), draft: { ...draftOf(current.page!), mapping: mapped('Colour') } }
  /* Someone else saves a mapping: the listing moves 5 → 6 outside this page. */
  server.mapping = mapped('Shade'); server.version = 6
  current.reload()
  await settle()
  held = heldAfter(held, current.page!, false)
  expect(held.draft.mapping[0].target).toBe('Colour') // the refresh alone keeps the edit

  const seen = current.mappingConflicts
  const ok = await current.saveMapping(held.draft, held.base.version)
  await settle()
  expect(ok).toBe(false)
  expect(server.sent.at(-1)).toEqual({ kind: 'mapping', expectedVersion: 5 })
  expect(server.mapping[0].target).toBe('Shade')
  expect(current.mappingConflicts).toBe(seen + 1)
  expect(current.writeError).toBe(MAPPING_CHANGED_ELSEWHERE)
  expect(current.page?.mapping[0].target).toBe('Shade')

  held = heldAfter(held, current.page!, current.mappingConflicts !== seen)
  expect(held.draft.mapping[0].target).toBe('Shade')
  expect(held.base.version).toBe(6)
  expect(draftDirty(held)).toBe(false)
})

it('a 409 that is a rule (axes_locked), not a move elsewhere, keeps the draft and states the server\'s reason', async () => {
  const locked: ProjectionSource = {
    ...source,
    saveMapping: async () => ({ ok: false, conflict: true, current: pageOf(), reason: 'Specifics are locked on a live listing.', code: 'axes_locked' }),
  }
  hooks.state.slots = []; hooks.state.effects = []
  const renderLocked = () => { hooks.state.index = 0; current = useProjection(locked); for (const e of hooks.state.effects.splice(0)) e() }
  renderLocked()
  for (let i = 0; i < 16; i++) { await Promise.resolve(); renderLocked() }
  const ok = await current.saveMapping({ ...draftOf(current.page!), mapping: mapped('Colour') })
  for (let i = 0; i < 16; i++) { await Promise.resolve(); renderLocked() }
  expect(ok).toBe(false)
  expect(current.mappingConflicts).toBe(0)
  expect(current.writeError).toBe('Specifics are locked on a live listing.')
})

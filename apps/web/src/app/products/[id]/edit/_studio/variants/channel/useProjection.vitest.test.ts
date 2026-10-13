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

import { MAPPING_CHANGED_ELSEWHERE, unknownOutcome } from './copy'
import { draftDirty, draftOf, heldAfter, startDraft } from './mappingDraft'
import type { ProjectionDraft, ProjectionMapping, ProjectionPage, ProjectionSaveResult, ProjectionSource } from './types'
import { useProjection, type ProjectionState } from './useProjection'

/* ── the stub server ─────────────────────────────────────────────────────────────────────────────────────────────────
 * One parent listing version, checked on every write, as the projection routes check it. It also models:
 *  - eBay's ORDER TOKEN (`ebay-presentation-order.service.ts`): built from every family listing row, so a tick (the
 *    parent version and a variant's row) and a pin (a variant's row only) both move it; a save carrying an order change
 *    with an old token answers 409 with the current page;
 *  - WHICH version a write answers: the one it wrote (`written`), or the read made after its commit (`after-read`, the
 *    server before 2.4), which may already carry someone else's write (`afterCommit`);
 *  - a write that lands and whose answer is lost (`loseNextAnswer`: the connection drops after the commit).
 */

type Held = Array<() => void>
const server = {
  version: 5,
  included: new Map<string, boolean>(),
  mapping: [] as ProjectionMapping[],
  /** Bumped by a pin: a variant's eBay row moved, the parent version did not. */
  rowStamp: 0,
  ebay: false,
  answer: 'written' as 'written' | 'after-read',
  afterCommit: null as null | (() => void),
  loseNextAnswer: false,
  sent: [] as Array<{ kind: 'children' | 'mapping'; expectedVersion: number; token?: string }>,
  holdReads: false, heldReads: [] as Held,
  holdWrites: false, heldWrites: [] as Held,
}
const mapped = (target: string): ProjectionMapping[] => [{ axisKey: 'Colore', axisLabel: 'Colore', target, order: 0 }]
const tokenOf = () => `T:${server.version}:${[...server.included].map(([id, v]) => `${id}=${v}`).join(',')}:${server.rowStamp}`
const pageOf = (): ProjectionPage => ({
  version: server.version,
  mapping: server.mapping.map(m => ({ ...m })),
  split: { mode: 'single', listings: [], creatable: false },
  children: [...server.included].map(([id, included]) => ({ id, sku: id.toUpperCase(), included, values: {}, listing: { state: 'live', externalId: null } })),
  ...(server.ebay ? { order: { axes: ['Colore'], valueOrder: {}, editorUrl: '', writableHere: true, reason: '', token: tokenOf() } } : {}),
} as unknown as ProjectionPage)
const hold = (on: boolean, line: Held) => (on ? new Promise<void>(resolve => line.push(resolve)) : Promise.resolve())
/** Someone else's write: the parent listing moves (and the order token with it). */
const otherWrite = (change: () => void = () => {}) => { change(); server.version += 1 }

/** Each write is checked when it reaches the server — the projection routes' compare-and-set on the parent listing. */
async function written(kind: 'children' | 'mapping', expectedVersion: number, apply: () => void, opts: { token?: string; noop?: () => boolean } = {}): Promise<ProjectionSaveResult> {
  server.sent.push({ kind, expectedVersion, ...(opts.token ? { token: opts.token } : {}) })
  await hold(server.holdWrites, server.heldWrites)
  if (expectedVersion !== server.version || (opts.token !== undefined && opts.token !== tokenOf())) {
    return { ok: false, conflict: true, current: pageOf(), reason: 'This listing changed after you opened it.', code: 'version_conflict' }
  }
  if (opts.noop?.()) return { ok: true, version: server.version } // nothing to write: the route answers the page as it is
  apply()
  server.version += 1
  const wrote = server.version
  server.afterCommit?.(); server.afterCommit = null
  if (server.loseNextAnswer) { server.loseNextAnswer = false; return { ok: false, conflict: false, unknown: true, reason: 'Failed to fetch' } }
  return { ok: true, version: server.answer === 'written' ? wrote : server.version }
}
const sameMapping = (draft: ProjectionDraft) => JSON.stringify(draft.mapping.map(m => [m.axisKey, m.target])) === JSON.stringify(server.mapping.map(m => [m.axisKey, m.target]))
const source: ProjectionSource = {
  /* The snapshot is taken when the read REACHES the server; a held read answers it later. */
  async read() { const snapshot = pageOf(); await hold(server.holdReads, server.heldReads); return snapshot },
  setIncluded: (expectedVersion, changes) => written('children', expectedVersion, () => { for (const c of changes) server.included.set(c.id, c.included) }),
  saveMapping: (expectedVersion, draft) => written('mapping', expectedVersion, () => { server.mapping = draft.mapping.map(m => ({ ...m })) },
    { token: draft.presentationOrder?.expectedToken, noop: () => !draft.presentationOrder && sameMapping(draft) }),
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
    rowStamp: 0, ebay: false, answer: 'written', afterCommit: null, loseNextAnswer: false,
    holdReads: false, heldReads: [], holdWrites: false, heldWrites: [],
  })
  render(); await settle()
  expect(current.page?.version).toBe(5)
})
afterEach(() => {
  vi.unstubAllGlobals()
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

/* ── review of #608: the eBay order token, the answer's version, a lost answer, the leave guard ─────────────────── */

/** An eBay page: the read carries the order token, and the dock's draft carries it from the first Specifics edit. */
const ebayDraft = async (): Promise<{ draft: ProjectionDraft; base: number }> => {
  server.ebay = true
  current.reload()
  await settle()
  const page = current.page!
  expect(page.order?.token).toBe(tokenOf())
  return { draft: { ...draftOf(page), mapping: mapped('Colour'), presentationOrder: { expectedToken: page.order!.token!, change: { axes: ['Colore'] } } }, base: page.version }
}

it('eBay: an edited mapping plus one tick still saves — the order token is taken again at Save', async () => {
  const { draft, base } = await ebayDraft()
  current.setIncluded('c1', true) // 5 → 6: the version AND the order token move
  await settle()
  const now = tokenOf()
  expect(now).not.toBe(draft.presentationOrder!.expectedToken)
  const ok = await current.saveMapping(draft, base)
  await settle()
  expect(ok).toBe(true)
  expect(server.sent.at(-1)).toEqual({ kind: 'mapping', expectedVersion: 6, token: now })
  expect(server.mapping[0].target).toBe('Colour')
  expect(current.writeError).toBeNull()
  expect(current.mappingConflicts).toBe(0)
})

it('eBay: a pin on a variant row (the token moves, the version does not) does not block the Save either', async () => {
  const { draft, base } = await ebayDraft()
  server.rowStamp += 1 // the pin: a variant's eBay row moved
  current.reload()
  await settle()
  const ok = await current.saveMapping(draft, base)
  await settle()
  expect(ok).toBe(true)
  expect(server.mapping[0].target).toBe('Colour')
})

it('eBay: an order change made elsewhere still answers 409 — the dock resets and says so', async () => {
  const { draft, base } = await ebayDraft()
  otherWrite(() => { server.mapping = mapped('Shade') }) // someone else saved the mapping: 5 → 6
  const seen = current.mappingConflicts
  const ok = await current.saveMapping(draft, base)
  await settle()
  expect(ok).toBe(false)
  expect(server.mapping[0].target).toBe('Shade')
  expect(current.mappingConflicts).toBe(seen + 1)
  expect(current.writeError).toBe(MAPPING_CHANGED_ELSEWHERE)
})

it('an answer that already carries someone else\'s write is not counted as this page\'s own move', async () => {
  server.answer = 'after-read' // the server before 2.4 answered the read made after its commit
  const held = { ...startDraft(current.page!), draft: { ...draftOf(current.page!), mapping: mapped('Colour') } }
  /* The tick commits 5 → 6; before the read after it, someone else saves a mapping 6 → 7; the tick answers 7. */
  server.afterCommit = () => otherWrite(() => { server.mapping = mapped('Shade') })
  current.setIncluded('c1', true)
  await settle()
  expect(server.version).toBe(7)
  const ok = await current.saveMapping(held.draft, held.base.version)
  await settle()
  expect(ok).toBe(false)
  expect(server.mapping[0].target).toBe('Shade') // not overwritten
  expect(current.writeError).toBe(MAPPING_CHANGED_ELSEWHERE)
})

it('a tick whose answer is lost but which landed: the page reads again, says so, and the next tick goes on from there', async () => {
  server.loseNextAnswer = true
  current.setIncluded('c1', true)
  await settle()
  expect(server.included.get('c1')).toBe(true)
  expect(includedOf('c1')).toBe(true) // what the server holds, not reverted
  expect(current.writeError).toBe(unknownOutcome('Failed to fetch'))
  current.setIncluded('c2', true)
  await settle()
  expect(server.sent.at(-1)).toEqual({ kind: 'children', expectedVersion: 6 })
  expect(server.included.get('c2')).toBe(true)
  expect(current.writeError).toBeNull()
})

it('a Save whose answer is lost but which landed: it says "may or may not", and saving again is not called a conflict', async () => {
  const draft = { ...draftOf(current.page!), mapping: mapped('Colour') }
  server.loseNextAnswer = true
  expect(await current.saveMapping(draft, 5)).toBe(false)
  await settle()
  expect(server.mapping[0].target).toBe('Colour')
  expect(current.writeError).toBe(unknownOutcome('Failed to fetch'))
  expect(await current.saveMapping(draft, 5)).toBe(true) // the dock's draft, at the same base
  await settle()
  expect(current.mappingConflicts).toBe(0)
  expect(current.writeError).toBeNull()
})

it('ticks waiting or in flight keep the tab: closing it asks first, until they settle', async () => {
  const unload = new Set<unknown>()
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: unknown) => { if (type === 'beforeunload') unload.add(fn) },
    removeEventListener: (type: string, fn: unknown) => { if (type === 'beforeunload') unload.delete(fn) },
  })
  server.holdWrites = true
  current.setIncluded('c1', true)
  current.setIncluded('c2', true)
  await settle()
  expect(unload.size).toBe(1)
  server.heldWrites.shift()!()
  await settle()
  expect(unload.size).toBe(1) // the second is still in line
  server.heldWrites.shift()!()
  await settle()
  expect(unload.size).toBe(0)
})

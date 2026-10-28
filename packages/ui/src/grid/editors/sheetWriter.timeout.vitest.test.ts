import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SheetWriter, type SheetWriteResult } from './sheetWriter'

/**
 * 🔴 The hang that loses data silently.
 *
 * A `commit` that never settles is not a rejection — `try/catch` cannot see it. Before the race,
 * one such request latched `q.inFlight = true` for the life of the page: `schedule()` returned
 * early on every later edit to that row, so those edits entered the queue and were **never sent**,
 * while `set()` had already painted each cell `saving`. A progress indicator over lost work.
 */
describe('SheetWriter — a commit that never settles', () => {
  const tracker = () => {
    const m = new Map<string, { state: string; reason?: string }>()
    return {
      map: m,
      set: (rowId: string, colId: string, state: string, reason?: string) => m.set(`${rowId}:${colId}`, { state, reason }),
      get: (rowId: string, colId: string) => m.get(`${rowId}:${colId}`),
      clear: () => m.clear(),
    }
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('🔴 at 30s paints WAITING — not refused — and keeps the flight open', async () => {
    /*
     * The old behaviour was a `Promise.race` that resolved a loser at 30 s with "the server did not
     * answer within 30s — this change was not saved". Measured 2026-09-02: a write took 34 s (a dev
     * connection-pool limit, not the route), was painted `refused` at 30 s, and then SUCCEEDED.
     * The operator was told a saved change had failed, and the natural response is to retype a
     * value that is already there.
     *
     * **A timeout cannot know.** The mark says what is true — we have not heard back.
     */
    const t = tracker()
    const commit = vi.fn(() => new Promise<never>(() => {}))
    const w = new SheetWriter<{ id: string }>({ commit, tracker: t as never, getApi: () => null as never })
    w.set('r1', 'name', 'v', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(31_000)
    expect(t.get('r1', 'name')?.state).toBe('waiting')
    expect(t.get('r1', 'name')?.state).not.toBe('refused')
    expect(t.get('r1', 'name')?.reason).toMatch(/not confirmed/i)
  })

  it('🔴 a flight that answers AFTER the patience window paints saved, never refused', async () => {
    // The exact case that shipped wrong: 34s, then success.
    const t = tracker()
    let settle: (v: SheetWriteResult) => void = () => {}
    const commit = vi.fn(() => new Promise<SheetWriteResult>((res) => { settle = res }))
    const w = new SheetWriter<{ id: string }>({ commit, tracker: t as never, getApi: () => null as never })
    w.set('r1', 'name', 'v', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(31_000)
    expect(t.get('r1', 'name')?.state).toBe('waiting')
    settle({ ok: true, cells: { name: { ok: true } } })
    await vi.advanceTimersByTimeAsync(10)
    expect(t.get('r1', 'name')?.state).toBe('saved')
  })

  it('🔴 a REJECTED fetch paints unknown and asks the host to reconcile', async () => {
    // A dropped connection is not a refusal: the request may or may not have applied, and only a
    // read can say which. Painting `refused` here is the timeout's lie by another road.
    const t = tracker()
    const readRow = vi.fn(async () => null)
    const commit = vi.fn(() => Promise.reject(new Error('network down')))
    const w = new SheetWriter<{ id: string }>({ commit, tracker: t as never, getApi: () => null as never, readRow })
    w.set('r1', 'name', 'v', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(100)
    expect(t.get('r1', 'name')?.state).toBe('unknown')
    expect(t.get('r1', 'name')?.reason).toMatch(/refresh to see whether/i)
    // The read is the only thing that can settle it — see sheetWriter.reconcile.vitest.test.ts.
    await vi.advanceTimersByTimeAsync(2_100)
    expect(readRow).toHaveBeenCalledWith('r1')
  })

  it('🔴 a commit that RETURNS unreachable paints unknown — the shape the real commit has', async () => {
    /*
     * The test above mocks a commit that REJECTS, and it passed while this path was unreachable in
     * production: `commitMasterRow` catches its own network error and RETURNS `{ ok: false }`, so
     * the writer's catch never ran and the cell painted `refused`. Measured against a real API
     * restart — `net::ERR_CONNECTION_REFUSED`, cell `refused`.
     *
     * 🔴 **A unit test that mocks a collaborator cannot see that the real collaborator behaves
     * differently.** This one asserts the shape the real commit actually produces.
     */
    const t = tracker()
    const readRow = vi.fn(async () => null)
    const commit = vi.fn(async () => ({ ok: false, reason: 'Failed to fetch', unreachable: true, cells: { name: { ok: false, reason: 'Failed to fetch' } } }))
    const w = new SheetWriter<{ id: string }>({ commit: commit as never, tracker: t as never, getApi: () => null as never, readRow })
    w.set('r1', 'name', 'v', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(100)
    expect(t.get('r1', 'name')?.state).toBe('unknown')
    expect(t.get('r1', 'name')?.state).not.toBe('refused')
    expect(t.get('r1', 'name')?.reason).toMatch(/refresh to see whether/i)
    await vi.advanceTimersByTimeAsync(2_100)
    expect(readRow).toHaveBeenCalledWith('r1')
  })

  it('a plain refusal (no unreachable flag) still paints refused', async () => {
    // The discriminator: without the flag this must NOT become `unknown`, or every server refusal
    // would start telling the operator to go and look.
    const t = tracker()
    const commit = vi.fn(async () => ({ ok: false, reason: 'Too long', cells: { name: { ok: false, reason: 'Too long' } } }))
    const w = new SheetWriter<{ id: string }>({ commit: commit as never, tracker: t as never, getApi: () => null as never })
    w.set('r1', 'name', 'v', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(100)
    expect(t.get('r1', 'name')?.state).toBe('refused')
  })

  it('🔴 a second edit does NOT send while the first flight is unsettled', async () => {
    // The row queue stays blocked. A second write overtaking the first is how a stale
    // `expectedVersion` reaches the server and loses a CAS it should never have entered.
    const t = tracker()
    const commit = vi.fn(() => new Promise<never>(() => {}))
    const w = new SheetWriter<{ id: string }>({ commit, tracker: t as never, getApi: () => null as never })
    w.set('r1', 'name', 'first', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(100)
    expect(commit).toHaveBeenCalledTimes(1)
    w.set('r1', 'name', 'second', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(31_000)
    expect(commit).toHaveBeenCalledTimes(1) // still one — the queue is blocked, not lost
  })

  it('does not strand OTHER rows while one is hung', async () => {
    const t = tracker()
    const commit = vi.fn((r: { rowId: string }) =>
      r.rowId === 'stuck' ? new Promise<never>(() => {}) : Promise.resolve({ ok: true, cells: { name: { ok: true } } }))
    const w = new SheetWriter<{ id: string }>({ commit: commit as never, tracker: t as never, getApi: () => null as never })
    w.set('stuck', 'name', 'v', { row: { id: 'stuck' } })
    w.set('fine', 'name', 'v', { row: { id: 'fine' } })
    await vi.advanceTimersByTimeAsync(200)
    expect(t.get('fine', 'name')?.state).toBe('saved')
  })
})

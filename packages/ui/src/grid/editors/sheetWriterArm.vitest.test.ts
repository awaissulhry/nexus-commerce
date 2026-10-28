import { describe, expect, it, vi } from 'vitest'

import { SheetWriter } from './sheetWriter'
import { CellSaveTracker } from './roundTrip'

/*
 * 🔴 The StrictMode state machine — the test that would have caught a silently dead sheet.
 *
 * A host memoises the writer and destroys it on unmount. StrictMode runs mount → cleanup → mount,
 * and `useMemo` returns the SAME instance because its deps did not change — so the host held a
 * DESTROYED writer for the life of the page and `set()` returned on its first line.
 *
 * Nothing showed it: the cell displayed the typed value (AG updates its own data; only the save is
 * dead), the tracker never painted `saving` because `set()` returns before that line, and no
 * request was made to fail. 23 unit tests on the commit function passed throughout, because they
 * call it directly and never travel through the writer.
 *
 * `apps/web` vitest is node-only and cannot render the hook, so the mount sequence is exercised
 * here as the state machine it is. **This file is the only thing standing between that bug and a
 * repeat**, and its assertions are about `commit` being CALLED — never about a return value, which
 * is what a destroyed writer would still happily produce.
 */
const harness = () => {
  const commit = vi.fn(async () => ({ ok: true, cells: { c: { ok: true } } }))
  const writer = new SheetWriter<{ id: string }>({
    tracker: new CellSaveTracker(),
    commit,
    getApi: () => null,
    flushMs: 1,
  })
  return { commit, writer }
}
const settle = () => new Promise((r) => setTimeout(r, 40))

describe('SheetWriter — surviving a StrictMode mount cycle', () => {
  it('🔴 destroy() → arm() → set() reaches commit', async () => {
    const { commit, writer } = harness()
    writer.destroy()          // StrictMode's first cleanup
    writer.arm()              // the second mount's effect body
    writer.set('r1', 'c', 'v', { row: { id: 'r1' } })
    await settle()
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('🔴 without arm(), a destroyed writer silently accepts and discards — the bug itself', async () => {
    const { commit, writer } = harness()
    writer.destroy()
    writer.set('r1', 'c', 'v', { row: { id: 'r1' } })
    await settle()
    // `set` does not throw and returns nothing. THAT is the defect: the caller cannot tell.
    expect(commit).not.toHaveBeenCalled()
  })

  it('arming a live writer changes nothing', async () => {
    const { commit, writer } = harness()
    writer.arm()
    writer.set('r1', 'c', 'v', { row: { id: 'r1' } })
    await settle()
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('destroy() is idempotent — a second cleanup does not re-flush', async () => {
    const { commit, writer } = harness()
    writer.set('r1', 'c', 'v', { row: { id: 'r1' } })
    writer.destroy()
    const afterFirst = commit.mock.calls.length
    writer.destroy()
    await settle()
    expect(commit.mock.calls.length).toBe(afterFirst)
  })

  it('🔴 the full StrictMode sequence: mount, cleanup, mount, then an edit', async () => {
    // Exactly what React does in development, in order. This is the case that shipped broken.
    const { commit, writer } = harness()
    writer.arm()              // mount 1 effect body
    writer.destroy()          // mount 1 cleanup
    writer.arm()              // mount 2 effect body
    writer.set('r1', 'c', 'typed', { row: { id: 'r1' } })
    await settle()
    expect(commit).toHaveBeenCalledTimes(1)
    // `calls.at(0)` with a guard: the mock is inferred as an empty tuple, so `calls[0][0]` is a
    // type error rather than a runtime one — and asserting the ARGUMENT is the point of this test.
    const first = commit.mock.calls.at(0) as unknown[] | undefined
    expect(first?.[0]).toMatchObject({ rowId: 'r1' })
  })
})

import { describe, expect, it, vi } from 'vitest'

import { CellSaveTracker } from './roundTrip'
import { SheetWriter, type SheetWriteRequest, type SheetWriteResult } from './sheetWriter'

interface Row {
  id: string
  version: number
}

/** A fake grid: the writer only ever asks it to repaint, and a null api must be survivable. */
const noApi = () => null

/**
 * A recording `commit`. `answer` decides each response; every request is kept so a test can assert
 * on what the server was actually SENT — the version in particular, which is the whole point.
 */
function recorder(answer: (req: SheetWriteRequest<Row>, n: number) => SheetWriteResult | Promise<SheetWriteResult>) {
  const seen: SheetWriteRequest<Row>[] = []
  const commit = async (req: SheetWriteRequest<Row>) => {
    // Snapshot: the writer clears its queue, and a live reference would read back empty.
    seen.push({ ...req, cells: req.cells.map((c) => ({ ...c })) })
    return answer(req, seen.length)
  }
  return { seen, commit }
}

const make = (
  commit: (req: SheetWriteRequest<Row>) => Promise<SheetWriteResult>,
  extra: Partial<ConstructorParameters<typeof SheetWriter<Row>>[0]> = {},
) => {
  const tracker = new CellSaveTracker()
  const writer = new SheetWriter<Row>({ tracker, commit, getApi: noApi, flushMs: 1, ...extra })
  return { tracker, writer }
}

describe('SheetWriter — the version round trip', () => {
  /**
   * 🔴 The regression this class exists for. Before it, the sheet sent the version it first READ on
   * every write, so the second edit to a row was refused 409 by the row's own previous save.
   */
  it('advances the row version from the server answer, so a second edit is not refused by the first', async () => {
    const { seen, commit } = recorder((req) => ({ ok: true, version: (req.expectedVersion ?? 0) + 1 }))
    const { writer } = make(commit)
    writer.seed([{ id: 'r1', version: 2 }])

    writer.set('r1', 'brand', 'Xavia')
    await writer.flush()
    writer.set('r1', 'material', 'Cordura')
    await writer.flush()
    writer.set('r1', 'color', 'Nero')
    await writer.flush()

    expect(seen.map((r) => r.expectedVersion)).toEqual([2, 3, 4])
    expect(writer.versionOf('r1')).toBe(5)
  })

  it('sends NO expectedVersion for a row it was never seeded for, rather than guessing one', async () => {
    const { seen, commit } = recorder(() => ({ ok: true, version: 9 }))
    const { writer } = make(commit)

    writer.set('unseeded', 'brand', 'Xavia')
    await writer.flush()

    expect(seen[0].expectedVersion).toBeUndefined()
    // The answer still teaches it the version, so the NEXT write is guarded.
    expect(writer.versionOf('unseeded')).toBe(9)
  })

  it('adopts the version a conflict reports, so the retry is not stuck one behind', async () => {
    const onConflict = vi.fn()
    const { seen, commit } = recorder((_req, n) =>
      n === 1 ? { ok: false, conflict: true, version: 7, reason: 'Someone else changed this row' } : { ok: true, version: 8 },
    )
    const { writer, tracker } = make(commit, { onConflict })
    writer.seed([{ id: 'r1', version: 2 }])

    writer.set('r1', 'brand', 'Xavia')
    await writer.flush()
    expect(tracker.get('r1', 'brand')?.state).toBe('refused')
    expect(onConflict).toHaveBeenCalledWith('r1', 7)

    writer.set('r1', 'brand', 'Xavia')
    await writer.flush()
    expect(seen[1].expectedVersion).toBe(7)
  })

  /**
   * The damaging order is the one that looks harmless: a page refetch issued BEFORE a save lands,
   * resolving AFTER it. Nothing is in flight by then, so "is a write in flight" does not catch it —
   * only "versions never go backwards" does.
   */
  it('ignores a STALE seed that resolves after a save, in both orderings', async () => {
    const { seen, commit } = recorder(() => ({ ok: true, version: 5 }))
    const { writer } = make(commit)
    writer.seed([{ id: 'r1', version: 4 }])

    writer.set('r1', 'brand', 'Xavia')
    await writer.flush()
    expect(writer.versionOf('r1')).toBe(5)

    writer.seed([{ id: 'r1', version: 4 }]) // the in-flight refetch finally answers, with the OLD version
    expect(writer.versionOf('r1')).toBe(5)

    writer.set('r1', 'material', 'Cordura')
    await writer.flush()
    expect(seen[1].expectedVersion).toBe(5)
  })

  it('a seed carrying a NEWER version is adopted — another operator’s write, seen on refetch', async () => {
    const { seen, commit } = recorder(() => ({ ok: true, version: 12 }))
    const { writer } = make(commit)
    writer.seed([{ id: 'r1', version: 4 }])
    writer.seed([{ id: 'r1', version: 11 }])

    writer.set('r1', 'brand', 'Xavia')
    await writer.flush()
    expect(seen[0].expectedVersion).toBe(11)
  })
})

describe('SheetWriter — batching', () => {
  it('coalesces a row’s cells into ONE request: a 5-column paste is 1 call, not 5', async () => {
    const { seen, commit } = recorder(() => ({ ok: true, version: 3 }))
    const { writer } = make(commit)
    writer.seed([{ id: 'r1', version: 2 }])

    for (const [col, v] of [['brand', 'Xavia'], ['material', 'Cordura'], ['color', 'Nero'], ['size', 'L'], ['ean', '5060']] as const) {
      writer.set('r1', col, v)
    }
    await writer.flush()

    expect(seen).toHaveLength(1)
    expect(seen[0].cells.map((c) => c.colId)).toEqual(['brand', 'material', 'color', 'size', 'ean'])
    // Nothing said otherwise, so every one is a plain `set`.
    expect(seen[0].cells.every((c) => c.intent === 'set')).toBe(true)
  })

  it('a fill down 20 rows is 20 requests — one per row, each with that row’s own version', async () => {
    const { seen, commit } = recorder((req) => ({ ok: true, version: (req.expectedVersion ?? 0) + 1 }))
    const { writer } = make(commit)
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, version: i }))
    writer.seed(rows)

    for (const r of rows) writer.set(r.id, 'material', 'Cordura')
    await writer.flush()

    expect(seen).toHaveLength(20)
    expect(seen.map((s) => s.expectedVersion)).toEqual(rows.map((r) => r.version))
  })

  it('never has two batches in flight for the SAME row — the invariant every inFlight guard keeps', async () => {
    let live = 0
    let peak = 0
    const releases: Array<(r: SheetWriteResult) => void> = []
    const commit = async () => {
      live++
      peak = Math.max(peak, live)
      const out = await new Promise<SheetWriteResult>((res) => releases.push(res))
      live--
      return out
    }
    const { writer } = make(commit)
    writer.seed([{ id: 'r1', version: 1 }])

    writer.set('r1', 'brand', 'a')
    await new Promise((r) => setTimeout(r, 5))
    writer.set('r1', 'material', 'b') // mid-flight
    void writer.flush() // and a caller asking for everything NOW, mid-flight
    await new Promise((r) => setTimeout(r, 5))
    expect(peak).toBe(1)

    releases.shift()?.({ ok: true, version: 2 })
    await new Promise((r) => setTimeout(r, 10))
    expect(peak).toBe(1)
    releases.shift()?.({ ok: true, version: 3 })
    await writer.flush()
    expect(peak).toBe(1)
  })

  it('the last write to a cell inside the window wins, and is sent once', async () => {
    const { seen, commit } = recorder(() => ({ ok: true, version: 3 }))
    const { writer } = make(commit)
    writer.seed([{ id: 'r1', version: 2 }])

    writer.set('r1', 'brand', 'first')
    writer.set('r1', 'brand', 'second')
    writer.set('r1', 'brand', 'third')
    await writer.flush()

    expect(seen).toHaveLength(1)
    expect(seen[0].cells).toEqual([{ colId: 'brand', value: 'third', intent: 'set' }])
  })

  it('serialises a row: a cell edited during a flight goes in the NEXT batch, at the new version', async () => {
    let release: (r: SheetWriteResult) => void = () => {}
    const { seen, commit } = recorder(
      (_req, n) => (n === 1 ? new Promise<SheetWriteResult>((res) => { release = res }) : { ok: true, version: 4 }),
    )
    const { writer } = make(commit)
    writer.seed([{ id: 'r1', version: 2 }])

    writer.set('r1', 'brand', 'Xavia')
    await new Promise((r) => setTimeout(r, 5))
    writer.set('r1', 'material', 'Cordura') // arrives mid-flight
    expect(seen).toHaveLength(1)

    release({ ok: true, version: 3 })
    await writer.flush()

    expect(seen).toHaveLength(2)
    expect(seen[1].cells.map((c) => c.colId)).toEqual(['material'])
    expect(seen[1].expectedVersion).toBe(3)
  })
})

describe('SheetWriter — outcomes are painted, never thrown', () => {
  it('paints each cell of a batch with its OWN outcome when the server answers per field', async () => {
    const { commit } = recorder(() => ({
      ok: true,
      version: 3,
      cells: { ean: { ok: false, reason: 'Not a valid EAN-13' } },
    }))
    const { writer, tracker } = make(commit)
    writer.seed([{ id: 'r1', version: 2 }])

    writer.set('r1', 'brand', 'Xavia')
    writer.set('r1', 'ean', '12345')
    await writer.flush()

    expect(tracker.get('r1', 'brand')?.state).toBe('saved')
    expect(tracker.get('r1', 'ean')).toMatchObject({ state: 'refused', reason: 'Not a valid EAN-13' })
  })

  it('a whole-batch refusal marks every cell in it, with the batch’s reason', async () => {
    const { commit } = recorder(() => ({ ok: false, reason: 'Refused (HTTP 500)' }))
    const { writer, tracker } = make(commit)
    writer.seed([{ id: 'r1', version: 2 }])

    writer.set('r1', 'brand', 'Xavia')
    writer.set('r1', 'material', 'Cordura')
    await writer.flush()

    for (const c of ['brand', 'material']) {
      expect(tracker.get('r1', c)).toMatchObject({ state: 'refused', reason: 'Refused (HTTP 500)' })
    }
  })

  it('🔴 a commit that THROWS becomes UNKNOWN, not a refusal — it is not an unhandled rejection either', async () => {
    /*
     * This asserted `refused` until 2026-09-02. A thrown commit means the request died; it may or
     * may not have been applied on the server, and the client cannot tell. `refused` claims the
     * server said no — a claim about an answer that was never received — and it makes the operator
     * retype a value that may already be saved. `unknown` says what is true and the host re-reads.
     *
     * Still not an unhandled rejection, which is what this test was originally written to catch.
     */
    const { writer, tracker } = make(async () => {
      throw new Error('network down')
    })
    writer.seed([{ id: 'r1', version: 2 }])

    writer.set('r1', 'brand', 'Xavia')
    await writer.flush()

    expect(tracker.get('r1', 'brand')).toMatchObject({ state: 'unknown' })
    expect(tracker.get('r1', 'brand')?.reason).toMatch(/refresh to see whether/i)
  })

  it('reports pending work from the first frame, and is quiet once settled', async () => {
    let release: (r: SheetWriteResult) => void = () => {}
    const { commit } = recorder(() => new Promise<SheetWriteResult>((res) => { release = res }))
    const { writer } = make(commit)
    writer.seed([{ id: 'r1', version: 2 }])

    writer.set('r1', 'brand', 'Xavia')
    expect(writer.pending).toBe(1) // queued, before anything has left
    await new Promise((r) => setTimeout(r, 5))
    expect(writer.busy).toBe(true)

    release({ ok: true, version: 3 })
    await writer.flush()
    expect(writer.pending).toBe(0)
    expect(writer.busy).toBe(false)
  })

  /**
   * 🔴 The data-loss net. A cell edited inside the flush window immediately before an unmount used
   * to be cleared without ever being sent — type, navigate, gone, with nothing on screen saying so.
   * The old edit page flushes on unmount for exactly this reason; a smaller window is still a
   * window, and the operator cannot know they landed in it.
   */
  it('SENDS what is still queued when destroyed, rather than dropping it', async () => {
    const { seen, commit } = recorder(() => ({ ok: true, version: 3 }))
    const { writer } = make(commit)
    writer.seed([{ id: 'r1', version: 2 }])

    writer.set('r1', 'brand', 'typed just before navigating away')
    writer.destroy() // before the flush timer fires
    await new Promise((r) => setTimeout(r, 10))

    expect(seen).toHaveLength(1)
    expect(seen[0].cells).toEqual([{ colId: 'brand', value: 'typed just before navigating away', intent: 'set' }])
    expect(seen[0].expectedVersion).toBe(2)
  })

  it('accepts no NEW work once destroyed', async () => {
    const { seen, commit } = recorder(() => ({ ok: true, version: 3 }))
    const { writer } = make(commit)
    writer.seed([{ id: 'r1', version: 2 }])

    writer.destroy()
    writer.set('r1', 'brand', 'Xavia')
    await new Promise((r) => setTimeout(r, 10))

    // Nothing was queued at teardown, so nothing was flushed; and the post-destroy edit is refused.
    expect(seen).toHaveLength(0)
  })
})


describe('SheetWriter — intent (ruling #30)', () => {
  it('defaults to `set` and carries an explicit intent to commit', async () => {
    const { seen, commit } = recorder(() => ({ ok: true, version: 3 }))
    const { writer } = make(commit)
    writer.seed([{ id: 'r1', version: 2 }])

    writer.set('r1', 'brand', 'Xavia')
    writer.set('r1', 'material', null, { intent: 'reset' })
    writer.set('r1', 'colour', 'Nero', { intent: 'pin' })
    await writer.flush()

    expect(seen[0].cells).toEqual([
      { colId: 'brand', value: 'Xavia', intent: 'set' },
      { colId: 'material', value: null, intent: 'reset' },
      { colId: 'colour', value: 'Nero', intent: 'pin' },
    ])
  })

  /**
   * 🔴 The intent must be replaced along with the value. A reset landing after a set inside the
   * same window is a RESET — keeping the earlier `set` would send the reset's null as an ordinary
   * write, which on a channel scope blanks the listing instead of restoring inheritance.
   */
  it('the last edit to a cell wins its INTENT too, not only its value', async () => {
    const { seen, commit } = recorder(() => ({ ok: true, version: 3 }))
    const { writer } = make(commit)
    writer.seed([{ id: 'r1', version: 2 }])

    writer.set('r1', 'material', 'Cordura')
    writer.set('r1', 'material', null, { intent: 'reset' })
    await writer.flush()

    expect(seen[0].cells).toEqual([{ colId: 'material', value: null, intent: 'reset' }])
  })

  it('still accepts the row object alongside the intent', async () => {
    const { seen, commit } = recorder(() => ({ ok: true, version: 3 }))
    const { writer } = make(commit)
    writer.set('r1', 'brand', 'Xavia', { row: { id: 'r1', version: 9 }, intent: 'pin' })
    await writer.flush()
    expect(seen[0].row).toEqual({ id: 'r1', version: 9 })
    expect(seen[0].cells[0].intent).toBe('pin')
  })
})

/* ── `onSettled` carries `ok` (#705) ──────────────────────────────────────────────────────────
 * The save clock on both sheets is stamped from this callback. It fires for EVERY settled batch,
 * refusals included, so `ok` is the only thing separating "saved" from "the server said no". A
 * caller that ignores it writes a false "Saved HH:MM" over a refused write — measured by PES.3 on
 * the channel sheet, with the false clock 700px from a red cell and a header reading "1 change not
 * saved". These pin the DATA that makes the distinction possible.
 */
describe('SheetWriter.onSettled — the save clock can only be honest if `ok` is right', () => {
  const settle = async (result: SheetWriteResult) => {
    const calls: Array<{ rowId: string; ok: boolean; savedAt: string }> = []
    const { commit } = recorder(() => result)
    const { writer } = make(commit, { onSettled: (i) => calls.push(i) })
    writer.seed([{ id: 'r1', version: 1 }])
    writer.set('r1', 'name', 'x', { row: { id: 'r1', version: 1 } })
    await writer.flush()
    return calls
  }

  it('a SAVED batch settles with ok true and a timestamp', async () => {
    const calls = await settle({ ok: true, version: 2 })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ rowId: 'r1', ok: true })
    expect(Number.isNaN(Date.parse(calls[0].savedAt))).toBe(false)
  })

  it('🔴 a REFUSED batch still settles — with ok FALSE, which is the whole point', async () => {
    const calls = await settle({ ok: false, reason: 'Someone else changed this row.' })
    expect(calls).toHaveLength(1)
    expect(calls[0].ok).toBe(false)
  })

  it('🔴 an UNREACHABLE batch settles with ok false — no answer is not a save', async () => {
    // The dangerous one: the server may yet apply it, so the cell paints `unknown`. A clock stamped
    // here would claim a save nobody has confirmed.
    const calls = await settle({ ok: false, reason: 'Failed to fetch', unreachable: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].ok).toBe(false)
  })
})

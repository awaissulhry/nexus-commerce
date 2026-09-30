import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CellSaveTracker } from './roundTrip'
import { SheetWriter, type SheetWriteRequest, type SheetWriteResult } from './sheetWriter'

/**
 * BATCH MODE — one operation, one call (`SheetWriterOptions.commitBatch`).
 *
 * The defect (measured 2026-09-29, product sheet, eBay · IT "Description theme", 250 variations): the fill handle sent
 * one request per row, all at once; the server rebuilt the whole family per request and 224 of 250 rows came back
 * failed or unconfirmed. These pin what the writer promises in batch mode: one call per operation, one call in flight,
 * versions chained between calls, a refused row alone, a retry of exactly the refused cells, and an unknown outcome
 * resolved by ONE read — never a guess.
 */
interface Row { id: string }

type Answer = (requests: SheetWriteRequest<Row>[], call: number) => Map<string, SheetWriteResult> | Promise<Map<string, SheetWriteResult>>
const allOk: Answer = (requests) => new Map(requests.map((r) => [r.rowId, { ok: true, version: (r.expectedVersion ?? 0) + 1 }]))

function batchWriter(answer: Answer = allOk, extra: Partial<ConstructorParameters<typeof SheetWriter<Row>>[0]> = {}) {
  const calls: SheetWriteRequest<Row>[][] = []
  const perRow = vi.fn(async (): Promise<SheetWriteResult> => ({ ok: true }))
  const tracker = new CellSaveTracker()
  const writer = new SheetWriter<Row>({
    tracker, getApi: () => null, flushMs: 5, commit: perRow,
    commitBatch: async (requests) => {
      calls.push(requests.map((r) => ({ ...r, cells: r.cells.map((c) => ({ ...c })) })))
      return answer(requests, calls.length)
    },
    ...extra,
  })
  return { writer, tracker, calls, perRow }
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => `r${i + 1}`)

describe('SheetWriter batch mode — one operation, one call', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sends a 250-row fill as ONE call and paints every row saved, with its own new version', async () => {
    const { writer, tracker, calls, perRow } = batchWriter()
    writer.seed(rows(250).map((id, i) => ({ id, version: i + 1 })))
    for (const id of rows(250)) writer.set(id, 'theme', 'clean')
    expect(writer.pending).toBe(250)
    await vi.advanceTimersByTimeAsync(10)

    expect(perRow).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(250)
    expect(calls[0][41]).toMatchObject({ rowId: 'r42', expectedVersion: 42, cells: [{ colId: 'theme', value: 'clean', intent: 'set' }] })
    expect(rows(250).every((id) => tracker.get(id, 'theme')?.state === 'saved')).toBe(true)
    expect(writer.versionOf('r42')).toBe(43)
    expect(writer.pending).toBe(0)
  })

  it('holds everything inside an operation fence and sends it the moment the fence closes', async () => {
    const { writer, calls } = batchWriter()
    writer.beginOperation()
    writer.set('r1', 'theme', 'a')
    await vi.advanceTimersByTimeAsync(50)
    writer.set('r2', 'theme', 'a')
    await vi.advanceTimersByTimeAsync(50)
    expect(calls).toHaveLength(0)
    writer.endOperation()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    expect(calls[0].map((r) => r.rowId)).toEqual(['r1', 'r2'])
  })

  it('keeps ONE call in flight: edits made meanwhile go next, in order, with the version the first call returned', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { writer, tracker, calls } = batchWriter(async (requests, call) => {
      if (call === 1) await gate
      return allOk(requests, call)
    })
    writer.seed([{ id: 'r1', version: 5 }, { id: 'r2', version: 9 }])
    writer.set('r1', 'theme', 'first')
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toHaveLength(1)

    // While the first call is on the wire: the same row again (twice — the last value wins) and a new row.
    writer.set('r1', 'theme', 'second')
    writer.set('r1', 'theme', 'third')
    writer.set('r2', 'theme', 'other')
    await vi.advanceTimersByTimeAsync(50)
    expect(calls).toHaveLength(1)
    expect(writer.pending).toBe(3)

    release()
    await vi.advanceTimersByTimeAsync(20)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual([
      { rowId: 'r1', row: null, cells: [{ colId: 'theme', value: 'third', intent: 'set' }], expectedVersion: 6 },
      { rowId: 'r2', row: null, cells: [{ colId: 'theme', value: 'other', intent: 'set' }], expectedVersion: 9 },
    ])
    expect(tracker.get('r1', 'theme')?.state).toBe('saved')
    expect(writer.versionOf('r1')).toBe(7)
  })

  it('refuses a row ALONE, announces every refusal of the operation once, and retries exactly the refused cells', async () => {
    const onRefused = vi.fn()
    const { writer, tracker, calls } = batchWriter((requests, call) => new Map(requests.map((r) => [r.rowId,
      call === 1 && r.rowId === 'r2' ? { ok: false, conflict: true, version: 12, reason: 'Someone else changed this listing (now v12).' } : { ok: true, version: (r.expectedVersion ?? 0) + 1 }])),
    { onRefused })
    writer.seed([{ id: 'r1', version: 1 }, { id: 'r2', version: 3 }, { id: 'r3', version: 1 }])
    for (const id of ['r1', 'r2', 'r3']) writer.set(id, 'theme', 'clean')
    await vi.advanceTimersByTimeAsync(10)

    expect(tracker.get('r1', 'theme')?.state).toBe('saved')
    expect(tracker.get('r2', 'theme')).toMatchObject({ state: 'refused', reason: 'Someone else changed this listing (now v12).' })
    expect(tracker.get('r3', 'theme')?.state).toBe('saved')
    expect(onRefused).toHaveBeenCalledTimes(1)
    expect(writer.failedCount).toBe(1)

    expect(writer.retryFailed()).toBe(1)
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toHaveLength(2)
    // Only the refused cell, with the version the 409 taught the writer.
    expect(calls[1]).toEqual([{ rowId: 'r2', row: null, cells: [{ colId: 'theme', value: 'clean', intent: 'set' }], expectedVersion: 12 }])
    expect(tracker.get('r2', 'theme')?.state).toBe('saved')
    expect(writer.failedCount).toBe(0)
  })

  it('never retries a refused value the operator has since replaced', async () => {
    const { writer, calls } = batchWriter((requests, call) => new Map(requests.map((r) => [r.rowId, call === 1 ? { ok: false, reason: 'Invalid' } : { ok: true }])))
    writer.set('r1', 'theme', 'bad')
    await vi.advanceTimersByTimeAsync(10)
    expect(writer.failedCount).toBe(1)
    writer.set('r1', 'theme', 'good')
    expect(writer.failedCount).toBe(0)
    await vi.advanceTimersByTimeAsync(10)
    expect(writer.retryFailed()).toBe(0)
    expect(calls.map((c) => c[0].cells[0].value)).toEqual(['bad', 'good'])
  })

  it('reports saved ONCE the whole operation is settled, not once per row', async () => {
    const pendingAtSettle: number[] = []
    const { writer } = batchWriter(allOk, { onSettled: () => pendingAtSettle.push(writer.pending) })
    for (const id of rows(5)) writer.set(id, 'theme', 'x')
    await vi.advanceTimersByTimeAsync(10)
    // Every row settles, but only the last sees an idle sheet — the host's "re-read after save" fires once.
    expect(pendingAtSettle.filter((n) => n === 0)).toHaveLength(1)
    expect(pendingAtSettle.at(-1)).toBe(0)
  })

  it('treats a row missing from the answer, and a dropped call, as UNKNOWN — resolved by ONE read for all rows', async () => {
    const reads: string[][] = []
    const { writer, tracker } = batchWriter(
      (requests, call) => {
        if (call === 1) throw new Error('Failed to fetch')
        return allOk(requests, call)
      },
      { readBackBatch: async (requests) => {
        reads.push(requests.map((r) => r.rowId))
        return new Map(requests.map((r) => [r.rowId, { values: { theme: r.rowId === 'r3' ? 'someone-else' : 'clean' }, version: 20 }]))
      } },
    )
    for (const id of ['r1', 'r2', 'r3']) writer.set(id, 'theme', 'clean')
    await vi.advanceTimersByTimeAsync(10)
    expect(['r1', 'r2', 'r3'].map((id) => tracker.get(id, 'theme')?.state)).toEqual(['unknown', 'unknown', 'unknown'])
    expect(writer.unreachable).toBe(true)

    await vi.advanceTimersByTimeAsync(2_100)
    expect(reads).toEqual([['r1', 'r2', 'r3']])
    expect(tracker.get('r1', 'theme')?.state).toBe('saved')
    expect(tracker.get('r3', 'theme')?.state).toBe('refused')
    expect(writer.unreachable).toBe(false)
    // The row whose stored value differs is retryable like any refusal.
    expect(writer.failedCount).toBe(1)
    expect(writer.versionOf('r1')).toBe(20)
  })

  it('discard() drops the queue, the marks and the retry list, and sends nothing', async () => {
    const { writer, tracker, calls } = batchWriter((requests) => new Map(requests.map((r) => [r.rowId, { ok: false, reason: 'No' }])))
    writer.set('r1', 'theme', 'x')
    await vi.advanceTimersByTimeAsync(10)
    writer.set('r2', 'theme', 'y')
    writer.discard()
    await vi.advanceTimersByTimeAsync(20)
    expect(calls).toHaveLength(1)
    expect(writer.failedCount).toBe(0)
    expect(tracker.get('r1', 'theme')).toBeUndefined()
    expect(writer.pending).toBe(0)
  })

  it('a writer WITHOUT commitBatch is unchanged: one call per row, fences ignored', async () => {
    const commit = vi.fn(async (): Promise<SheetWriteResult> => ({ ok: true }))
    const writer = new SheetWriter<Row>({ tracker: new CellSaveTracker(), getApi: () => null, flushMs: 5, commit })
    writer.beginOperation()
    writer.set('r1', 'a', 1)
    writer.set('r2', 'a', 1)
    await vi.advanceTimersByTimeAsync(10)
    expect(commit).toHaveBeenCalledTimes(2)
  })
})

describe('SheetWriter batch mode — a fence that never closes', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('holds nothing back while an operation is open but has changed no cell yet (a long drag)', async () => {
    const { writer, calls } = batchWriter()
    writer.beginOperation()
    // The drag lasts 6 s; the cells change only when the button is released.
    await vi.advanceTimersByTimeAsync(6_000)
    // The grid reports the changed cells over more than one turn (AG delivers its events in batches).
    for (const id of rows(500).slice(0, 493)) writer.set(id, 'theme', 'a')
    await vi.advanceTimersByTimeAsync(10)
    for (const id of rows(500).slice(493)) writer.set(id, 'theme', 'a')
    writer.endOperation()
    await vi.advanceTimersByTimeAsync(20)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(500)
  })

  it('opens itself after FENCE_MAX_MS, so no edit is held forever', async () => {
    const { writer, calls } = batchWriter()
    writer.beginOperation()
    writer.set('r1', 'theme', 'a')
    await vi.advanceTimersByTimeAsync(1_900)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(calls).toHaveLength(1)
    // A late end event after that changes nothing and sends nothing twice.
    writer.endOperation()
    await vi.advanceTimersByTimeAsync(20)
    expect(calls).toHaveLength(1)
  })
})

describe('SheetWriter batch mode — a record shared by several rows (audit A03)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  // Rows `b1:p` and `b2:p` show ONE product `p` in two bands; `title` writes the product, `stock` each row's own record.
  const sharedRecordOf = (request: SheetWriteRequest<Row>, cell: { colId: string }) => cell.colId === 'title' ? `product:${request.rowId.split(':')[1]}` : null

  it('sends the same edit to a shared record once and settles every row that asked for it with that answer', async () => {
    const { writer, tracker, calls } = batchWriter(allOk, { sharedRecordOf })
    writer.beginOperation()
    for (const id of ['b1:p', 'b2:p', 'b3:p', 'b1:q']) writer.set(id, 'title', 'Neu')
    writer.set('b2:p', 'stock', 5)
    writer.endOperation()
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toHaveLength(1)
    expect(calls[0].map((r) => [r.rowId, r.cells.map((c) => c.colId)])).toEqual([['b1:p', ['title']], ['b2:p', ['stock']], ['b1:q', ['title']]])
    expect(['b1:p', 'b2:p', 'b3:p', 'b1:q'].map((id) => tracker.get(id, 'title')?.state)).toEqual(['saved', 'saved', 'saved', 'saved'])
    expect(tracker.get('b2:p', 'stock')?.state).toBe('saved')
    expect(writer.pending).toBe(0)
  })

  it('a carried cell takes the writing row\'s refusal, and only the refused cells are retried', async () => {
    const refuse: Answer = (requests) => new Map(requests.map((r) => [r.rowId, r.rowId === 'b1:p' ? { ok: false, reason: 'Title changed. Reload before saving it.' } : { ok: true }]))
    const { writer, tracker } = batchWriter(refuse, { sharedRecordOf })
    writer.beginOperation()
    writer.set('b1:p', 'title', 'Neu')
    writer.set('b2:p', 'title', 'Neu')
    writer.set('b2:p', 'stock', 5)
    writer.endOperation()
    await vi.advanceTimersByTimeAsync(10)
    expect(['b1:p', 'b2:p'].map((id) => tracker.get(id, 'title'))).toEqual([
      expect.objectContaining({ state: 'refused', reason: 'Title changed. Reload before saving it.' }),
      expect.objectContaining({ state: 'refused', reason: 'Title changed. Reload before saving it.' }),
    ])
    expect(tracker.get('b2:p', 'stock')?.state).toBe('saved')
    expect(writer.failedCount).toBe(2)
  })

  it('a different edit to a record another row writes waits for the next call, with the version the first answered', async () => {
    const { writer, tracker, calls } = batchWriter(allOk, { sharedRecordOf })
    writer.seed([{ id: 'b1:p', version: 7 }, { id: 'b2:p', version: 7 }])
    writer.beginOperation()
    writer.set('b1:p', 'title', 'Erste')
    writer.set('b2:p', 'title', 'Zweite')
    writer.endOperation()
    // The host moves every band of the product when one band's save confirms its new version.
    await vi.advanceTimersByTimeAsync(1)
    writer.seed([{ id: 'b2:p', version: 8 }])
    await vi.advanceTimersByTimeAsync(20)
    expect(calls.map((call) => call.map((r) => [r.rowId, r.expectedVersion, r.cells[0].value]))).toEqual([[['b1:p', 7, 'Erste']], [['b2:p', 8, 'Zweite']]])
    expect(['b1:p', 'b2:p'].map((id) => tracker.get(id, 'title')?.state)).toEqual(['saved', 'saved'])
  })
})

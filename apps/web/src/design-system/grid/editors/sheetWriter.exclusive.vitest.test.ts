import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CellSaveTracker } from './roundTrip'
import { SheetWriter, type SheetExclusiveAnswer, type SheetWriteRequest, type SheetWriteResult } from './sheetWriter'

/**
 * G4 (2026-10-13) — ONE write line per row: a write that is not a cell edit (the product sheet's formula save, replace
 * and removal) takes its turn with the row's cell saves (`SheetWriter.exclusive`).
 *
 * The defect: formula writes went through their own per-row queue beside this writer, and their answer carried no row
 * version. Manufacturer `=upper("acme")`, then Cost 16 at once: the Cost save sent the version from before the formula and
 * came back 409 "Another change landed first" — the other change was the page's own formula.
 */
interface Row { id: string }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

/** Per-row mode: each answer moves the row one version on, like `PATCH /products/bulk`. */
function rowWriter(answer?: (req: SheetWriteRequest<Row>) => Promise<SheetWriteResult>) {
  const commits: SheetWriteRequest<Row>[] = []
  const tracker = new CellSaveTracker()
  const writer = new SheetWriter<Row>({
    tracker, getApi: () => null, flushMs: 5,
    commit: async (req) => {
      commits.push({ ...req, cells: req.cells.map((c) => ({ ...c })) })
      return answer ? answer(req) : { ok: true, version: (req.expectedVersion ?? 0) + 1 }
    },
  })
  return { writer, tracker, commits }
}

describe('SheetWriter.exclusive — a formula write takes its turn in the row\'s line', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('G4: a cell edited right after a formula waits for it and sends the version the formula answered', async () => {
    const { writer, commits } = rowWriter()
    writer.seed([{ id: 'p1', version: 5 }])
    const formula = deferred<SheetExclusiveAnswer<string>>()
    const turns: Array<number | undefined> = []
    const saved = writer.exclusive('p1', (turn) => { turns.push(turn.expectedVersion); return formula.promise })
    writer.set('p1', 'costPrice', 16)
    await vi.advanceTimersByTimeAsync(50)

    expect(turns).toEqual([5])
    expect(commits).toHaveLength(0)
    expect(writer.pending).toBe(2)
    expect(writer.busy).toBe(true)

    formula.resolve({ result: 'stored', version: 6 })
    await expect(saved).resolves.toBe('stored')
    await vi.advanceTimersByTimeAsync(50)
    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({ rowId: 'p1', expectedVersion: 6, cells: [{ colId: 'costPrice', value: 16 }] })
    expect(writer.versionOf('p1')).toBe(7)
    expect(writer.pending).toBe(0)
  })

  it('a cell edited before the formula leaves first, and the formula is handed the version that save answered', async () => {
    const { writer, commits } = rowWriter()
    writer.seed([{ id: 'p1', version: 5 }])
    writer.set('p1', 'brand', 'Acme')
    const turns: Array<number | undefined> = []
    const saved = writer.exclusive('p1', async (turn) => { turns.push(turn.expectedVersion); return { result: 'stored', version: (turn.expectedVersion ?? 0) + 1 } })
    // No window: the cells a formula closed are complete and leave at once.
    await vi.advanceTimersByTimeAsync(0)
    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({ expectedVersion: 5, cells: [{ colId: 'brand', value: 'Acme' }] })
    await expect(saved).resolves.toBe('stored')
    expect(turns).toEqual([6])
    expect(writer.versionOf('p1')).toBe(7)
  })

  it('waits for the row\'s cell save already in the air', async () => {
    const answer = deferred<SheetWriteResult>()
    const { writer, commits } = rowWriter(() => answer.promise)
    writer.seed([{ id: 'p1', version: 5 }])
    writer.set('p1', 'brand', 'Acme')
    await vi.advanceTimersByTimeAsync(10)
    expect(commits).toHaveLength(1)
    const run = vi.fn(async () => ({ result: 'stored' }))
    const saved = writer.exclusive('p1', run)
    await vi.advanceTimersByTimeAsync(50)
    expect(run).not.toHaveBeenCalled()
    answer.resolve({ ok: true, version: 6 })
    await expect(saved).resolves.toBe('stored')
    expect(run).toHaveBeenCalledWith({ expectedVersion: 6, row: null })
  })

  it('keeps every write of the row in the order it was made: cells, formula, cells, formula', async () => {
    const order: string[] = []
    const { writer } = rowWriter(async (req) => { order.push(req.cells.map((c) => `${c.colId}=${String(c.value)}`).join(',')); return { ok: true } })
    writer.set('p1', 'brand', 'A')
    void writer.exclusive('p1', async () => { order.push('formula 1'); return { result: 1 } })
    writer.set('p1', 'brand', 'B')
    writer.set('p1', 'model', 'M')
    void writer.exclusive('p1', async () => { order.push('formula 2'); return { result: 2 } })
    await vi.advanceTimersByTimeAsync(100)
    expect(order).toEqual(['brand=A', 'formula 1', 'brand=B,model=M', 'formula 2'])
  })

  it('never holds another row', async () => {
    const formula = deferred<SheetExclusiveAnswer<string>>()
    const { writer, commits } = rowWriter()
    void writer.exclusive('p1', () => formula.promise)
    writer.set('p2', 'brand', 'Acme')
    await vi.advanceTimersByTimeAsync(10)
    expect(commits.map((c) => c.rowId)).toEqual(['p2'])
    formula.resolve({ result: 'stored' })
  })

  it('an answer that names no version leaves the row\'s version as it was (the app decides what may be adopted)', async () => {
    const { writer } = rowWriter()
    writer.seed([{ id: 'p1', version: 5 }])
    await writer.exclusive('p1', async () => ({ result: 'stored' }))
    expect(writer.versionOf('p1')).toBe(5)
  })

  it('a write that throws rejects, and the row\'s later cells still go', async () => {
    const { writer, commits } = rowWriter()
    const failed = writer.exclusive('p1', async () => { throw new Error('offline') })
    writer.set('p1', 'brand', 'Acme')
    await expect(failed).rejects.toThrow('offline')
    await vi.advanceTimersByTimeAsync(100)
    expect(commits.map((c) => c.cells[0]?.colId)).toEqual(['brand'])
  })

  it('flush() waits for a formula write too (Publish flushes first)', async () => {
    const formula = deferred<SheetExclusiveAnswer<string>>()
    const { writer } = rowWriter()
    void writer.exclusive('p1', () => formula.promise)
    let flushed = false
    void writer.flush().then(() => { flushed = true })
    await vi.advanceTimersByTimeAsync(50)
    expect(flushed).toBe(false)
    formula.resolve({ result: 'stored' })
    await vi.advanceTimersByTimeAsync(10)
    expect(flushed).toBe(true)
  })

  it('discard(): a formula write still waiting never runs and resolves undefined; one in the air is not adopted', async () => {
    const answer = deferred<SheetWriteResult>()
    const { writer } = rowWriter(() => answer.promise)
    writer.seed([{ id: 'p1', version: 5 }, { id: 'p2', version: 1 }])
    writer.set('p1', 'brand', 'Acme')
    await vi.advanceTimersByTimeAsync(10)
    const waiting = vi.fn(async () => ({ result: 'stored', version: 9 }))
    const queued = writer.exclusive('p1', waiting)
    const inAir = deferred<SheetExclusiveAnswer<string>>()
    const flying = writer.exclusive('p2', () => inAir.promise)
    await vi.advanceTimersByTimeAsync(0)
    writer.discard()
    await expect(queued).resolves.toBeUndefined()
    inAir.resolve({ result: 'stored', version: 2 })
    await expect(flying).resolves.toBeUndefined()
    answer.resolve({ ok: true, version: 6 })
    await vi.advanceTimersByTimeAsync(10)
    expect(waiting).not.toHaveBeenCalled()
    expect(writer.versionOf('p2')).toBe(1)
    expect(writer.pending).toBe(0)
  })

  it('destroy(): the row\'s writes still leave, in their order, each with the version the one before answered', async () => {
    const order: string[] = []
    const { writer } = rowWriter(async (req) => { order.push(`${req.cells[0]!.colId}@${req.expectedVersion}`); return { ok: true, version: (req.expectedVersion ?? 0) + 1 } })
    writer.seed([{ id: 'p1', version: 5 }])
    writer.set('p1', 'brand', 'A')
    const saved = writer.exclusive('p1', async (turn) => { order.push(`formula@${turn.expectedVersion}`); return { result: 'stored', version: (turn.expectedVersion ?? 0) + 1 } })
    writer.set('p1', 'model', 'M')
    writer.destroy()
    await vi.advanceTimersByTimeAsync(10)
    await saved
    await vi.advanceTimersByTimeAsync(10)
    expect(order).toEqual(['brand@5', 'formula@6', 'model@7'])
  })
})

describe('SheetWriter.exclusive in batch mode', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a paste over a formula cell: the row\'s cells before it go with the paste\'s ONE call, the formula next, the cells after it last', async () => {
    const calls: SheetWriteRequest<Row>[][] = []
    const tracker = new CellSaveTracker()
    const writer = new SheetWriter<Row>({
      tracker, getApi: () => null, flushMs: 5, commit: async () => ({ ok: true }),
      commitBatch: async (requests) => {
        calls.push(requests.map((r) => ({ ...r, cells: r.cells.map((c) => ({ ...c })) })))
        return new Map(requests.map((r) => [r.rowId, { ok: true, version: (r.expectedVersion ?? 0) + 1 }]))
      },
    })
    writer.seed([{ id: 'm', version: 10 }, { id: 'n', version: 20 }])
    const turns: Array<number | undefined> = []
    writer.beginOperation()
    writer.set('m', 'brand', 'Acme')
    writer.set('n', 'brand', 'Acme')
    const formula = writer.exclusive('m', async (turn) => { turns.push(turn.expectedVersion); return { result: 'stored', version: (turn.expectedVersion ?? 0) + 1 } })
    writer.set('m', 'model', 'X')
    await vi.advanceTimersByTimeAsync(50)
    expect(calls).toHaveLength(0)
    expect(turns).toEqual([])
    writer.endOperation()
    await expect(formula).resolves.toBe('stored')
    await vi.advanceTimersByTimeAsync(100)

    expect(calls[0]!.map((r) => [r.rowId, r.expectedVersion, r.cells.map((c) => c.colId)])).toEqual([['m', 10, ['brand']], ['n', 20, ['brand']]])
    expect(turns).toEqual([11])
    expect(calls[1]!.map((r) => [r.rowId, r.expectedVersion, r.cells.map((c) => c.colId)])).toEqual([['m', 12, ['model']]])
    expect(tracker.get('m', 'brand')?.state).toBe('saved')
    expect(writer.pending).toBe(0)
  })

  it('a formula with nothing before it is not held by the operation fence', async () => {
    const writer = new SheetWriter<Row>({
      tracker: new CellSaveTracker(), getApi: () => null, flushMs: 5, commit: async () => ({ ok: true }),
      commitBatch: async (requests) => new Map(requests.map((r) => [r.rowId, { ok: true }])),
    })
    const run = vi.fn(async () => ({ result: 'stored' }))
    writer.beginOperation()
    const formula = writer.exclusive('m', run)
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    await expect(formula).resolves.toBe('stored')
    writer.endOperation()
  })
})

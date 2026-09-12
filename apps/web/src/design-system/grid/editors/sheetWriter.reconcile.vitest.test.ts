import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SheetWriter, sheetValuesMatch, type SheetWriteRequest, type SheetWriteResult } from './sheetWriter'

/**
 * 🔴 THE QUIET RECONCILE (hub ruling #641).
 *
 * A write that dies on the wire may or may not have applied. The writer paints `unknown` and then
 * has exactly one way to find out: read the row back. Everything here is about that read being
 * (a) quiet — the grid is never torn down, so the mark and the typed value stay on screen,
 * (b) patient — it retries while the server is away instead of guessing, and
 * (c) HONEST — `unknown` resolves from what the database holds, never from what we hoped.
 *
 * The first version of this called the host's `reload()`, which begins `setLoading(true)`: the grid
 * dropped its rows and the `unknown` mark went with them a second after it appeared. The operator's
 * edit vanished and an empty sheet sat there for the whole outage. **The one thing they needed to
 * see was the thing the fix destroyed.**
 */
describe('SheetWriter — reconciling an unreachable write', () => {
  const tracker = () => {
    const m = new Map<string, { state: string; reason?: string }>()
    return {
      map: m,
      set: (rowId: string, colId: string, state: string, reason?: string) => m.set(`${rowId}:${colId}`, { state, reason }),
      get: (rowId: string, colId: string) => m.get(`${rowId}:${colId}`),
      clear: (rowId: string, colId: string) => m.delete(`${rowId}:${colId}`),
      clearAll: () => m.clear(),
    }
  }
  /** The shape the REAL commit produces when the port is closed — see the dead-port test. */
  const unreachable = async (): Promise<SheetWriteResult> => ({
    ok: false,
    reason: 'Failed to fetch',
    unreachable: true,
    cells: { name: { ok: false, reason: 'Failed to fetch' } },
  })

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('uses the recovered version for an edit queued during the outage without painting that edit saved early', async () => {
    const t = tracker()
    const commit = vi.fn().mockResolvedValueOnce({ ok: false, unreachable: true }).mockResolvedValueOnce({ ok: true, version: 10 })
    const w = new SheetWriter({ tracker: t as never, getApi: () => null, commit,
      readBack: async () => ({ values: { name: 'First' }, version: 9 }),
    })
    w.seed([{ id: 'r1', version: 8 }])
    w.set('r1', 'name', 'First')
    await vi.advanceTimersByTimeAsync(100)
    w.set('r1', 'name', 'Second')
    await w.flush()
    expect(commit).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1900)
    expect(t.get('r1', 'name')?.state).toBe('saving')
    await vi.advanceTimersByTimeAsync(200)
    expect(commit.mock.calls[1][0]).toMatchObject({ expectedVersion: 9, cells: [{ value: 'Second' }] })
    expect(w.versionOf('r1')).toBe(10)
    w.destroy()
  })

  it('ignores a recovery read that returns after Reload discarded its edits', async () => {
    const t = tracker()
    let finish!: (value: { values: { name: string }; version: number }) => void
    const w = new SheetWriter({ tracker: t as never, getApi: () => null, commit: unreachable,
      readBack: () => new Promise(resolve => { finish = resolve }),
    })
    w.set('r1', 'name', 'First')
    await vi.advanceTimersByTimeAsync(2200)
    w.discard()
    finish({ values: { name: 'First' }, version: 20 })
    await vi.advanceTimersByTimeAsync(100)
    expect(t.get('r1', 'name')).toBeUndefined()
    expect(w.versionOf('r1')).toBeUndefined()
    w.destroy()
  })

  it('continues recovery when the response omits the requested cell', async () => {
    const t = tracker()
    const readBack = vi.fn(async () => ({ values: { another: null } }))
    const w = new SheetWriter({ tracker: t as never, getApi: () => null, commit: unreachable, readBack })
    w.set('r1', 'name', null)
    await vi.advanceTimersByTimeAsync(6300)
    expect(t.get('r1', 'name')?.state).toBe('unknown')
    expect(w.unknownCount).toBe(1)
    expect(readBack).toHaveBeenCalledTimes(2)
    w.destroy()
  })

  it('reconciles only unanswered cells in a mixed-scope write', async () => {
    const t = tracker()
    const readRow = vi.fn(async () => ({ name: 'Already saved', material: 'New material', description: 'Old description' }))
    const w = new SheetWriter<{ id: string }>({ tracker: t as never, getApi: () => null as never, readRow,
      commit: async () => ({ ok: false, unreachable: true, cells: {
        name: { ok: true, unreachable: false }, material: { ok: false, unreachable: true },
        description: { ok: false, reason: 'Invalid value', unreachable: false },
      } }),
    })
    w.set('r1', 'name', 'Already saved', { row: { id: 'r1' } })
    w.set('r1', 'material', 'New material', { row: { id: 'r1' } })
    w.set('r1', 'description', 'Bad description', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(100)
    expect(t.get('r1', 'name')?.state).toBe('saved')
    expect(t.get('r1', 'material')?.state).toBe('unknown')
    expect(t.get('r1', 'description')?.state).toBe('refused')
    await vi.advanceTimersByTimeAsync(2100)
    expect(t.get('r1', 'material')?.state).toBe('saved')
    expect(t.get('r1', 'description')?.reason).toBe('Invalid value')
    w.destroy()
  })

  it('🔴 resolves to SAVED when the row now holds the typed value — the write did land', async () => {
    // The whole reason `unknown` exists: a dropped connection is not a failed write. The request
    // reached the server, applied, and the answer died on the way back. Calling that "refused"
    // makes the operator retype work that is already in the database.
    const t = tracker()
    const readRow = vi.fn(async () => ({ name: 'Merino Throw' }))
    const w = new SheetWriter<{ id: string }>({ commit: unreachable, tracker: t as never, getApi: () => null as never, readRow })
    w.set('r1', 'name', 'Merino Throw', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(100)
    expect(t.get('r1', 'name')?.state).toBe('unknown')
    await vi.advanceTimersByTimeAsync(2_100)
    expect(readRow).toHaveBeenCalledWith('r1')
    expect(t.get('r1', 'name')?.state).toBe('saved')
  })

  it('🔴 resolves to REFUSED, with the sentence, when the row still holds the old value', async () => {
    const t = tracker()
    const readRow = vi.fn(async () => ({ name: 'the old value' }))
    const w = new SheetWriter<{ id: string }>({ commit: unreachable, tracker: t as never, getApi: () => null as never, readRow })
    w.set('r1', 'name', 'Merino Throw', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(2_200)
    expect(t.get('r1', 'name')?.state).toBe('refused')
    // It says what happened AND what to do. "Not saved" alone leaves them looking for a button.
    expect(t.get('r1', 'name')?.reason).toMatch(/stored value differs.*review/i)
  })

  it('🔴 keeps asking while the read fails — 2s, 4s, 8s, capped at 30s', async () => {
    // A dev API cold-boots in tens of seconds. Hammering a closed port neither speeds it up nor
    // tells us anything we did not know a moment ago; giving up strands the mark forever.
    const t = tracker()
    const readRow = vi.fn(async () => null)
    const w = new SheetWriter<{ id: string }>({ commit: unreachable, tracker: t as never, getApi: () => null as never, readRow })
    w.set('r1', 'name', 'v', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(2_200)
    expect(readRow).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(readRow).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(readRow).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(16_000)
    expect(readRow).toHaveBeenCalledTimes(4)
    // The cap: two more attempts inside 61s only if the wait stopped doubling at 30s.
    await vi.advanceTimersByTimeAsync(61_000)
    expect(readRow).toHaveBeenCalledTimes(6)
  })

  it('the mark says what is happening between attempts, and stops saying "refresh"', async () => {
    // The first sentence ("refresh to see whether this saved") is right for a page with nothing
    // watching. Once the loop is running, the sheet IS checking, and saying otherwise sends the
    // operator to do by hand the thing already being done for them.
    const t = tracker()
    const w = new SheetWriter<{ id: string }>({ commit: unreachable, tracker: t as never, getApi: () => null as never, readRow: async () => null })
    w.set('r1', 'name', 'v', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(2_200)
    expect(t.get('r1', 'name')?.state).toBe('unknown')
    expect(t.get('r1', 'name')?.reason).toMatch(/checking whether this saved/i)
  })

  it('🔴 the OUTAGE is a page fact: `unreachable` goes true while reads fail and clears on an answer', async () => {
    const t = tracker()
    let up = false
    const readRow = vi.fn(async () => (up ? { name: 'v' } : null))
    const w = new SheetWriter<{ id: string }>({ commit: unreachable, tracker: t as never, getApi: () => null as never, readRow })
    expect(w.unreachable).toBe(false)
    w.set('r1', 'name', 'v', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(2_200)
    expect(w.unreachable).toBe(true) // the header states it once, here
    up = true
    await vi.advanceTimersByTimeAsync(4_100)
    expect(w.unreachable).toBe(false) // and takes it back without being asked
  })

  it('🔴 a keystroke during the outage is HELD, not lost, and flushes on recovery', async () => {
    /*
     * Two failures avoided at once. Sending each keystroke into the dead port would paint another
     * `unknown` and start another reconcile loop per keystroke; dropping it would lose typed work.
     * It waits in the queue — `pending` counts it, so the strip stays honest — and goes when the
     * server comes back.
     */
    const t = tracker()
    let up = false
    const commit = vi.fn(async (_req: SheetWriteRequest<{ id: string }>): Promise<SheetWriteResult> =>
      up ? { ok: true, cells: { colour: { ok: true } } } : { ok: false, reason: 'Failed to fetch', unreachable: true, cells: { name: { ok: false } } },
    )
    const w = new SheetWriter<{ id: string }>({ commit, tracker: t as never, getApi: () => null as never, readRow: async () => (up ? { name: 'v' } : null) })
    w.set('r1', 'name', 'v', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(2_200)
    expect(commit).toHaveBeenCalledTimes(1)

    w.set('r1', 'colour', 'Slate', { row: { id: 'r1' } }) // typed while the server is away
    await vi.advanceTimersByTimeAsync(4_000)
    expect(commit).toHaveBeenCalledTimes(1) // held — no second doomed flight
    expect(w.pending).toBeGreaterThan(0) // and counted as unsaved, because it is

    up = true
    await vi.advanceTimersByTimeAsync(8_200)
    expect(commit).toHaveBeenCalledTimes(2)
    expect(commit.mock.calls[1]?.[0]?.cells?.[0]?.colId).toBe('colour')
    expect(commit.mock.calls[1]?.[0]?.cells?.[0]?.value).toBe('Slate')
    expect(t.get('r1', 'colour')?.state).toBe('saved')
  })

  it('a second batch swallowed by the same outage joins the loop rather than starting a rival', async () => {
    // Two loops for one row resolve half the cells each and race each other's `unreachableRows`
    // entry; the survivor's `delete` clears the flag while the other is still failing.
    const t = tracker()
    const readRow = vi.fn(async () => null)
    const w = new SheetWriter<{ id: string }>({ commit: unreachable, tracker: t as never, getApi: () => null as never, readRow })
    w.set('r1', 'name', 'v', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(100)
    await w.flush() // flush() bypasses schedule() — the one route that could start a second loop
    await vi.advanceTimersByTimeAsync(2_200)
    expect(readRow).toHaveBeenCalledTimes(1)
  })

  it('🔴 a COLUMN write resolves from the read-back — the interim guard is gone (#681)', async () => {
    /*
     * Until PES.5's `studio-sheet.service.ts` fix at 13:40:45 this case had to be REFUSED to
     * resolve: the sheet read served a stale value for column fields (`brand`, `name`) while
     * attributes were fresh, so comparing against it would have said `refused` about a write that
     * landed. An interim option held those columns at `unknown` and told the operator to reload —
     * a false "retype" being worse than an honest "look".
     *
     * It came out because the read was fixed at the source, and I measured that rather than taking
     * it on report: `PATCH brand` on AIREON, then the sheet read returned the new value with
     * `source: masterColumn` in the same second, where the old path returned the stale value with
     * `source: master`. This test is what the guard left behind — if the read goes stale again it
     * fails here rather than lying to an operator.
     */
    const t = tracker()
    const w = new SheetWriter<{ id: string }>({
      commit: unreachable, tracker: t as never, getApi: () => null as never,
      readRow: async () => ({ brand: 'What I typed' }), // the read is fresh for columns now
    })
    w.set('r1', 'brand', 'What I typed', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(2_200)
    expect(t.get('r1', 'brand')?.state).toBe('saved')
  })

  it('a column write the read-back CONTRADICTS is refused, like any other', async () => {
    const t = tracker()
    const w = new SheetWriter<{ id: string }>({
      commit: unreachable, tracker: t as never, getApi: () => null as never,
      readRow: async () => ({ brand: 'the stored value' }),
    })
    w.set('r1', 'brand', 'What I typed', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(2_200)
    expect(t.get('r1', 'brand')?.state).toBe('refused')
    expect(t.get('r1', 'brand')?.reason).toMatch(/stored value differs.*review/i)
  })

  it('a host with no readRow paints unknown and claims no outage — it cannot know', async () => {
    // Other sheets use this writer. Without a read there is nothing to reconcile FROM, so the
    // writer must not raise a header claim it has no way to withdraw.
    const t = tracker()
    const w = new SheetWriter<{ id: string }>({ commit: unreachable, tracker: t as never, getApi: () => null as never })
    w.set('r1', 'name', 'v', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.get('r1', 'name')?.state).toBe('unknown')
    expect(w.unreachable).toBe(false)
  })

  it('destroy() withdraws the outage claim — the loop it describes is gone', async () => {
    const t = tracker()
    const w = new SheetWriter<{ id: string }>({ commit: unreachable, tracker: t as never, getApi: () => null as never, readRow: async () => null })
    w.set('r1', 'name', 'v', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(2_200)
    expect(w.unreachable).toBe(true)
    w.destroy()
    expect(w.unreachable).toBe(false)
  })

  it('🔴 discard() sends NOTHING and takes the marks with the values (#663)', async () => {
    /*
     * The opposite of `destroy()`, which fires the queue at the server on the way out because the
     * operator meant to save. Here they pressed Reload and said yes to discarding, so nothing is
     * sent — and the marks go too, in the same call. Measured before this existed: Reload replaced
     * a refused cell's typed value with the stored one and LEFT the refusal on it, so the sheet
     * showed a red cell, "1 cell blocked" and "1 change not saved" about a change that was gone.
     */
    const t = tracker()
    const commit = vi.fn(async (): Promise<SheetWriteResult> => ({ ok: true, cells: {} }))
    const w = new SheetWriter<{ id: string }>({ commit, tracker: t as never, getApi: () => null as never })
    w.set('r1', 'name', 'typed but not sent', { row: { id: 'r1' } })
    t.set('r1', 'colour', 'refused', 'Too long')
    expect(w.pending).toBeGreaterThan(0) // the control: there IS something to discard
    w.discard()
    expect(commit).not.toHaveBeenCalled()
    expect(w.pending).toBe(0)
    expect(t.get('r1', 'colour')).toBeUndefined() // the mark went with the value
    // And it stays sent-nothing: the queue is gone, not merely deferred.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(commit).not.toHaveBeenCalled()
  })

  it('discard() ends a reconcile in flight and withdraws the outage', async () => {
    // The loop is reasoning about writes that no longer exist; its verdict would land on cells
    // that no longer hold what it is comparing.
    const t = tracker()
    const readRow = vi.fn(async () => null)
    const w = new SheetWriter<{ id: string }>({ commit: unreachable, tracker: t as never, getApi: () => null as never, readRow })
    w.set('r1', 'name', 'v', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(2_200)
    expect(w.unreachable).toBe(true)
    const readsBefore = readRow.mock.calls.length
    w.discard()
    expect(w.unreachable).toBe(false)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(readRow.mock.calls.length).toBe(readsBefore) // it stopped asking
  })

  it('the writer stays usable after discard — the operator is still on the sheet', async () => {
    const t = tracker()
    const commit = vi.fn(async (_req: SheetWriteRequest<{ id: string }>): Promise<SheetWriteResult> => ({ ok: true, cells: { name: { ok: true } } }))
    const w = new SheetWriter<{ id: string }>({ commit, tracker: t as never, getApi: () => null as never })
    w.set('r1', 'name', 'first', { row: { id: 'r1' } })
    w.discard()
    w.set('r1', 'name', 'after the reload', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(200)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]?.[0]?.cells?.[0]?.value).toBe('after the reload')
  })

  it('flush() does not hang on a held queue', async () => {
    // Publish awaits flush(). If a held (unreachable) row counted as "still settling", the button
    // would wait out the entire outage with a spinner and no way to say why.
    const t = tracker()
    const w = new SheetWriter<{ id: string }>({ commit: unreachable, tracker: t as never, getApi: () => null as never, readRow: async () => null })
    w.set('r1', 'name', 'v', { row: { id: 'r1' } })
    await vi.advanceTimersByTimeAsync(2_200)
    w.set('r1', 'colour', 'Slate', { row: { id: 'r1' } })
    let done = false
    void w.flush().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(200)
    expect(done).toBe(true)
  })
})

/**
 * The comparison that decides `saved` vs `refused`. A rule, so it is tested as one.
 */
describe('sheetValuesMatch', () => {
  it('compares structured values rather than their generic object string', () => {
    expect(sheetValuesMatch({ value: 4, unit: 'cm' }, { value: 9, unit: 'cm' })).toBe(false)
    expect(sheetValuesMatch({ value: 4, unit: 'cm' }, { unit: 'cm', value: '4' })).toBe(true)
    expect(sheetValuesMatch(['a,b', 'c'], ['a', 'b,c'])).toBe(false)
  })
  it('🔴 a normalised read-back is a MATCH — the value is in the database', () => {
    // `===` would call each of these "not saved; retype", sending the operator to redo work that
    // is already done. That is the 30s timeout's lie wearing a different hat.
    expect(sheetValuesMatch('5', 5)).toBe(true)
    expect(sheetValuesMatch('Merino Throw ', 'Merino Throw')).toBe(true)
    expect(sheetValuesMatch(120, '120')).toBe(true)
  })

  it('empty is empty however the column spells it', () => {
    expect(sheetValuesMatch(null, '')).toBe(true)
    expect(sheetValuesMatch(undefined, null)).toBe(true)
    expect(sheetValuesMatch('   ', '')).toBe(true)
  })

  it('🔴 a real difference is a real difference — including empty against a value', () => {
    expect(sheetValuesMatch('the old value', 'Merino Throw')).toBe(false)
    expect(sheetValuesMatch(null, 'Merino Throw')).toBe(false)
    expect(sheetValuesMatch('Merino Throw', '')).toBe(false)
    expect(sheetValuesMatch(4, 5)).toBe(false)
  })

  it('booleans compare as booleans, not as their spelling', () => {
    // `String(false) === String('false')` is true, and a checkbox that failed to save would read
    // back as saved.
    expect(sheetValuesMatch(false, 'false')).toBe(false)
    expect(sheetValuesMatch(false, false)).toBe(true)
    expect(sheetValuesMatch(true, true)).toBe(true)
  })
})

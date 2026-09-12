import { describe, expect, it, vi } from 'vitest'
import type { GridApi } from 'ag-grid-community'

// The contract under test is the handlers retained by AG and asynchronous saves.
// Browser QA covers React mounting, StrictMode, error rendering and retry with real AG Grid.
vi.mock('react', () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => {
    let state = initial
    return [state, (next: unknown) => { state = typeof next === 'function' ? next(state) : next }]
  },
  useCallback: (callback: unknown) => callback,
}))

import { useGridLifetime } from './useGridLifetime'
import { CellSaveTracker } from '../editors/roundTrip'
import { SheetWriter, type SheetWriteResult } from '../editors/sheetWriter'

interface Row { id: string; version: number }
function grid() {
  let destroyed = false
  const getRowNode = vi.fn(() => {
    if (destroyed) throw new Error('Called a destroyed grid')
    return { data: { id: 'one', version: 1 } }
  })
  const refreshCells = vi.fn(() => {
    if (destroyed) throw new Error('Called a destroyed grid')
  })
  const api = { isDestroyed: () => destroyed, getRowNode, refreshCells } as unknown as GridApi<Row>
  return { api, getRowNode, refreshCells, destroy: () => { destroyed = true } }
}

describe('grid lifetime across failed reads and retry', () => {
  it('disconnects before AG teardown, and rejects a missed destruction event', () => {
    const lifetime = useGridLifetime<GridApi<Row>>()
    const first = grid()
    expect(lifetime.getApi()).toBeNull()
    lifetime.bind(first.api)
    expect(lifetime.getApi()).toBe(first.api)
    lifetime.onGridPreDestroyed({ api: first.api })
    expect(lifetime.apiRef.current).toBeNull()
    expect(lifetime.getApi()).toBeNull()
    lifetime.bind(first.api)
    first.destroy()
    expect(lifetime.getApi()).toBeNull()
  })

  it('ignores a late teardown from the old grid after its replacement is ready', () => {
    const lifetime = useGridLifetime<GridApi<Row>>()
    const first = grid(), replacement = grid()
    lifetime.bind(first.api)
    lifetime.bind(replacement.api)
    first.destroy()
    lifetime.onGridPreDestroyed({ api: first.api })
    expect(lifetime.getApi()).toBe(replacement.api)
  })

  it.each([false, true])('settles an in-flight save after teardown (replacement: %s)', async replace => {
    const lifetime = useGridLifetime<GridApi<Row>>()
    const first = grid(), replacement = grid()
    const tracker = new CellSaveTracker()
    let resolve!: (result: SheetWriteResult) => void
    const commit = vi.fn(() => new Promise<SheetWriteResult>(done => { resolve = done }))
    const settled = vi.fn()
    const writer = new SheetWriter<Row>({ tracker, getApi: lifetime.getApi, commit, onSettled: settled, flushMs: 60_000 })
    lifetime.bind(first.api)
    writer.seed([{ id: 'one', version: 1 }])
    writer.set('one', 'name', 'Retain this edit')
    const pending = writer.flush()
    lifetime.onGridPreDestroyed({ api: first.api })
    first.destroy()
    first.getRowNode.mockClear()
    first.refreshCells.mockClear()
    if (replace) lifetime.bind(replacement.api)
    resolve({ ok: true, version: 2 })
    await pending
    expect(commit).toHaveBeenCalledOnce()
    expect(tracker.get('one', 'name')?.state).toBe('saved')
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
    expect(first.getRowNode).not.toHaveBeenCalled()
    expect(first.refreshCells).not.toHaveBeenCalled()
    expect(replacement.refreshCells.mock.calls.length > 0).toBe(replace)
    writer.destroy()
  })
})

import { describe, expect, it, vi } from 'vitest'

import { SheetWriter, type SheetWriteResult } from './sheetWriter'

/**
 * R-VT-15 — a refused commit reports the server's sentence ONCE, and never reports a non-refusal.
 *
 * The defect this closes (VT.F2): the reason reached `tracker.set(…, 'refused', reason)` and stopped
 * there, so the operator met a red cell mark whose words they could only reach by double-clicking the
 * cell again. `onRefused` is the engine's side of the fix; the surface says it through the one DS
 * toast provider its route mounts.
 *
 * Every arm here is a `must` and a `must not`, because the dangerous version of this callback is the
 * one that also fires when the server never answered: announcing "refused" for a write that may well
 * have landed is the exact lie the `unknown` state exists to prevent.
 */
describe('SheetWriter — announcing a refusal', () => {
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

  /* REAL timers, deliberately: `flush()` settles by polling `setTimeout(…, 5)`, so a fake clock that
     nobody advances makes every one of these hang (measured: 5 timeouts at 10 s each). The sibling
     suites advance the clock because they assert intermediate states; these assert the settled one. */

  it('reports the server sentence for a refused cell, and paints it refused', async () => {
    const t = tracker()
    const onRefused = vi.fn()
    const commit = async (): Promise<SheetWriteResult> => ({
      ok: false,
      cells: { name: { ok: false, reason: 'Title needs a choice: Edit the shared Italian or Pin on Amazon · IT · it.' } },
    })
    const w = new SheetWriter({ tracker: t as never, getApi: () => null, commit, onRefused })
    w.set('r1', 'name', 'Nuovo')
    await w.flush()
    expect(t.get('r1', 'name')?.state).toBe('refused')
    expect(onRefused).toHaveBeenCalledTimes(1)
    expect(onRefused.mock.calls[0][0]).toEqual([
      { rowId: 'r1', colId: 'name', reason: 'Title needs a choice: Edit the shared Italian or Pin on Amazon · IT · it.' },
    ])
    w.destroy()
  })

  it('falls back to the BATCH reason when the server refused without naming cells', async () => {
    const t = tracker()
    const onRefused = vi.fn()
    const commit = async (): Promise<SheetWriteResult> => ({ ok: false, reason: 'Map each shared axis once to a nonempty channel value.' })
    const w = new SheetWriter({ tracker: t as never, getApi: () => null, commit, onRefused })
    w.set('r1', 'variation_theme', { axes: [] })
    await w.flush()
    expect(onRefused.mock.calls[0][0]).toEqual([
      { rowId: 'r1', colId: 'variation_theme', reason: 'Map each shared axis once to a nonempty channel value.' },
    ])
    w.destroy()
  })

  it('does NOT report a write that got no answer — that is `unknown`, not a refusal', async () => {
    const t = tracker()
    const onRefused = vi.fn()
    // The shape the real commit produces when the port is closed (the dead-port test's fixture).
    const unreachable = async (): Promise<SheetWriteResult> => ({
      ok: false, reason: 'Failed to fetch', unreachable: true,
      cells: { name: { ok: false, reason: 'Failed to fetch', unreachable: true } },
    })
    const w = new SheetWriter({ tracker: t as never, getApi: () => null, commit: unreachable, onRefused, readBack: async () => null })
    w.set('r1', 'name', 'Nuovo')
    await w.flush()
    expect(t.get('r1', 'name')?.state).toBe('unknown')
    expect(onRefused).not.toHaveBeenCalled()
    w.destroy()
  })

  it('reports one event per settled batch, naming every refused cell in it', async () => {
    const t = tracker()
    const onRefused = vi.fn()
    const commit = async (): Promise<SheetWriteResult> => ({
      ok: false,
      cells: {
        name: { ok: false, reason: 'One line only.' },
        price: { ok: false, reason: 'One line only.' },
        status: { ok: true },
      },
    })
    const w = new SheetWriter({ tracker: t as never, getApi: () => null, commit, onRefused })
    w.set('r1', 'name', 'a')
    w.set('r1', 'price', '1')
    w.set('r1', 'status', 'ACTIVE')
    await w.flush()
    // ONE call — a paste that refuses twenty cells is one event, not twenty. The saved cell is absent.
    expect(onRefused).toHaveBeenCalledTimes(1)
    expect(onRefused.mock.calls[0][0]).toEqual([
      { rowId: 'r1', colId: 'name', reason: 'One line only.' },
      { rowId: 'r1', colId: 'price', reason: 'One line only.' },
    ])
    expect(t.get('r1', 'status')?.state).toBe('saved')
    w.destroy()
  })

  it('says nothing at all when every cell saved', async () => {
    const t = tracker()
    const onRefused = vi.fn()
    const w = new SheetWriter({ tracker: t as never, getApi: () => null, commit: async () => ({ ok: true, version: 3 }), onRefused })
    w.set('r1', 'name', 'Nuovo')
    await w.flush()
    expect(t.get('r1', 'name')?.state).toBe('saved')
    expect(onRefused).not.toHaveBeenCalled()
    w.destroy()
  })
})

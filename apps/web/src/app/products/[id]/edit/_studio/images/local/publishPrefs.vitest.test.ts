import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_SNAPSHOTS, clearSnapshots, diffSnapshot, isEmptyDiff, queueApproval, readApproval,
  layerRows, readAutoPublish, readSnapshots, resolveApproval, saveSnapshot, setAutoPublish, snapshotWarning,
  type Snapshot, type SnapshotRow,
} from './publishPrefs'

function installStore() {
  const map = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v) },
      removeItem: (k: string) => { map.delete(k) },
    },
  })
  return map
}

let store: Map<string, string>
beforeEach(() => { store = installStore() })
afterEach(() => { vi.unstubAllGlobals() })

const P = 'prod1'

describe('auto-publish', () => {
  it('round-trips per channel without disturbing the others', () => {
    setAutoPublish(P, 'AMAZON', true)
    setAutoPublish(P, 'EBAY', false)
    expect(readAutoPublish(P)).toEqual({ AMAZON: true, EBAY: false })
  })

  it('is off for a product with nothing stored', () => {
    expect(readAutoPublish('unknown')).toEqual({})
  })

  it('drops a channel stored as a non-boolean rather than reading it as on', () => {
    store.set('nexus.studio.images.v1:autoPublish:prod1', JSON.stringify({ AMAZON: 'yes', EBAY: true }))
    expect(readAutoPublish(P)).toEqual({ EBAY: true })
  })

  it('survives a stored array where an object belongs', () => {
    store.set('nexus.studio.images.v1:autoPublish:prod1', '[1,2,3]')
    expect(readAutoPublish(P)).toEqual({})
  })
})

describe('approval gate', () => {
  const req = (id: string) => ({
    id, channel: 'AMAZON', marketplace: 'IT', requestedAt: '2026-09-01T12:00:00Z', note: null,
  })

  it('defaults to not required, with an empty queue', () => {
    expect(readApproval(P)).toEqual({ required: false, queue: [] })
  })

  it('queues and resolves', () => {
    queueApproval(P, req('a'))
    queueApproval(P, req('b'))
    expect(readApproval(P).queue.map((q) => q.id)).toEqual(['a', 'b'])
    resolveApproval(P, 'a')
    expect(readApproval(P).queue.map((q) => q.id)).toEqual(['b'])
  })

  it('is idempotent by id — re-requesting does not stack duplicates', () => {
    queueApproval(P, req('a'))
    queueApproval(P, { ...req('a'), note: 'again' })
    const queue = readApproval(P).queue
    expect(queue).toHaveLength(1)
    expect(queue[0].note).toBe('again')
  })

  it('drops queue debris missing an identifying field', () => {
    store.set('nexus.studio.images.v1:approval:prod1', JSON.stringify({
      required: true,
      queue: [req('good'), { channel: 'EBAY' }, null, 'nope'],
    }))
    const state = readApproval(P)
    expect(state.required).toBe(true)
    expect(state.queue.map((q) => q.id)).toEqual(['good'])
  })

  it('does not read a non-boolean "required" as on', () => {
    store.set('nexus.studio.images.v1:approval:prod1', JSON.stringify({ required: 'yes', queue: [] }))
    expect(readApproval(P).required).toBe(false)
  })
})

describe('rollback snapshots', () => {
  const row = (slot: string, url: string, position: number, groupValue: string | null = 'Nero'): SnapshotRow =>
    ({ slot, url, position, groupValue })
  const snap = (id: string, rows = [row('MAIN', 'a.jpg', 0)]): Snapshot =>
    ({ id, takenAt: `2026-09-01T12:00:0${id}Z`, channel: 'AMAZON', marketplace: 'IT', rows })

  it('stores newest first', () => {
    saveSnapshot(P, snap('1'))
    saveSnapshot(P, snap('2'))
    expect(readSnapshots(P, 'AMAZON', 'IT').map((s) => s.id)).toEqual(['2', '1'])
  })

  it('caps the history and drops the oldest rather than refusing the write', () => {
    for (let i = 0; i < MAX_SNAPSHOTS + 3; i++) saveSnapshot(P, snap(String(i)))
    const kept = readSnapshots(P, 'AMAZON', 'IT')
    expect(kept).toHaveLength(MAX_SNAPSHOTS)
    expect(kept[0].id).toBe(String(MAX_SNAPSHOTS + 2))
  })

  it('keeps each channel+market separate', () => {
    saveSnapshot(P, snap('1'))
    saveSnapshot(P, { ...snap('2'), marketplace: 'DE' })
    expect(readSnapshots(P, 'AMAZON', 'IT').map((s) => s.id)).toEqual(['1'])
    expect(readSnapshots(P, 'AMAZON', 'DE').map((s) => s.id)).toEqual(['2'])
  })

  it('does not offer a snapshot whose rows are all unreadable', () => {
    store.set('nexus.studio.images.v1:snapshots:prod1:AMAZON:IT', JSON.stringify([
      { id: 'x', takenAt: 'now', channel: 'AMAZON', marketplace: 'IT', rows: [{ slot: 'MAIN' }] },
    ]))
    expect(readSnapshots(P, 'AMAZON', 'IT')).toEqual([])
  })

  it('clears', () => {
    saveSnapshot(P, snap('1'))
    clearSnapshots(P, 'AMAZON', 'IT')
    expect(readSnapshots(P, 'AMAZON', 'IT')).toEqual([])
  })
})

describe('diffSnapshot', () => {
  const r = (slot: string, url: string, position: number, groupValue: string | null = 'Nero'): SnapshotRow =>
    ({ slot, url, position, groupValue })

  it('finds nothing between identical sets', () => {
    const rows = [r('MAIN', 'a.jpg', 0), r('PT01', 'b.jpg', 1)]
    const d = diffSnapshot(rows, rows)
    expect(isEmptyDiff(d)).toBe(true)
    expect(d.unchanged).toBe(2)
  })

  it('reports a reorder as a MOVE, not as a removal plus an addition', () => {
    const before = [r('MAIN', 'a.jpg', 0), r('PT01', 'b.jpg', 1)]
    const after = [r('MAIN', 'a.jpg', 1), r('PT01', 'b.jpg', 0)]
    const d = diffSnapshot(before, after)
    expect(d.added).toEqual([])
    expect(d.removed).toEqual([])
    expect(d.moved).toHaveLength(2)
    expect(d.moved[0]).toMatchObject({ from: 0, to: 1 })
  })

  it('separates additions from removals', () => {
    const d = diffSnapshot([r('MAIN', 'a.jpg', 0)], [r('MAIN', 'b.jpg', 0)])
    expect(d.added.map((x) => x.url)).toEqual(['b.jpg'])
    expect(d.removed.map((x) => x.url)).toEqual(['a.jpg'])
  })

  it('treats the same picture in two colour buckets as two different placements', () => {
    const before = [r('MAIN', 'a.jpg', 0, 'Nero')]
    const after = [r('MAIN', 'a.jpg', 0, 'Giallo')]
    const d = diffSnapshot(before, after)
    expect(d.added).toHaveLength(1)
    expect(d.removed).toHaveLength(1)
  })

  it('handles an empty side without inventing changes on the other', () => {
    expect(diffSnapshot([], []).unchanged).toBe(0)
    expect(diffSnapshot([r('MAIN', 'a.jpg', 0)], []).removed).toHaveLength(1)
    expect(diffSnapshot([], [r('MAIN', 'a.jpg', 0)]).added).toHaveLength(1)
  })
})

describe('snapshotWarning', () => {
  it('says nothing takes a restore point for you — the button does', () => {
    const w = snapshotWarning(0)
    expect(w).toMatch(/only when you press the button/)
    expect(w).toMatch(/another machine left nothing here/)
    // It must not imply publishing records one, because publishing does not.
    expect(w).not.toMatch(/taken when you publish/)
  })

  it('warns against relying on one even when some exist', () => {
    const w = snapshotWarning(3)
    expect(w).toMatch(/3 restore points/)
    expect(w).toMatch(/this browser only/)
    expect(w).toMatch(/do not rely on one being here/)
  })
})

describe('layerRows — the phantom-move regression', () => {
  const asset = (over: Record<string, unknown>) => ({
    platform: 'AMAZON', marketplace: 'IT', amazonSlot: 'PT02',
    variantGroupValue: 'Nero', url: 'a.jpg', position: 0, ...over,
  }) as Parameters<typeof layerRows>[0][number]

  it("takes each row's own position, not its index", () => {
    const rows = layerRows([
      asset({ amazonSlot: 'PT02', variantGroupValue: 'Giallo', position: 0 }),
      asset({ amazonSlot: 'PT02', variantGroupValue: 'Nero', position: 2 }),
    ], 'AMAZON', 'IT')
    expect(rows.map((r) => r.position)).toEqual([0, 2])
  })

  it('reports no move when an unrelated row is inserted ahead of the others', () => {
    // The exact shape measured on screen: adding a PT03 row shifted the array and made the
    // untouched PT02 row look like it had moved from 1 to 2.
    const before = layerRows([
      asset({ variantGroupValue: 'Giallo', position: 0 }),
      asset({ variantGroupValue: 'Nero', position: 2 }),
    ], 'AMAZON', 'IT')
    const after = layerRows([
      asset({ variantGroupValue: 'Giallo', position: 0 }),
      asset({ amazonSlot: 'PT03', url: 'new.jpg', position: 0 }),
      asset({ variantGroupValue: 'Nero', position: 2 }),
    ], 'AMAZON', 'IT')
    const d = diffSnapshot(before, after)
    expect(d.moved).toEqual([])
    expect(d.added).toHaveLength(1)
    expect(d.removed).toEqual([])
  })

  it('keeps only the requested channel and market layer', () => {
    const rows = layerRows([
      asset({}),
      asset({ marketplace: 'DE' }),
      asset({ marketplace: null }),
      asset({ platform: 'EBAY' }),
      asset({ amazonSlot: null }),
    ], 'AMAZON', 'IT')
    expect(rows).toHaveLength(1)
  })
})

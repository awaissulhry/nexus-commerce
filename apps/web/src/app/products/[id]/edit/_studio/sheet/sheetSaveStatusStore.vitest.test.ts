import { describe, expect, it, vi } from 'vitest'
import { createSheetSaveStatusStore } from './sheetSaveStatusStore'

const initial = () => ({ pending: 0, refused: 0, warned: 0, retryable: 0,
  refusedRowIds: new Set<string>(), offline: false, saving: false })

describe('sheet save status subscriptions', () => {
  it('updates the footer through a successful save without invalidating the row filter', () => {
    let source = initial()
    const store = createSheetSaveStatusStore(() => source)
    const filter = store.getRefusedSnapshot()
    const statuses: unknown[] = []
    store.subscribe(() => statuses.push(store.getSnapshot()))
    source = { ...source, pending: 1 }
    store.refreshCounts()
    expect(store.getSnapshot().pending).toBe(1)
    expect(store.getPendingWrite()).toBe(true)
    source = { ...source, saving: true }
    store.refreshCounts()
    expect(store.getSnapshot().saving).toBe(true)
    source = initial()
    store.refreshCounts()
    store.saved('2026-09-30T10:00:00.000Z')
    expect(store.getSnapshot()).toMatchObject({ pending: 0, saving: false, lastSavedAt: '2026-09-30T10:00:00.000Z' })
    expect(store.getPendingWrite()).toBe(false)
    expect(store.getRefusedSnapshot()).toBe(filter)
    expect(statuses).toHaveLength(4)
  })

  it('updates the affected rows when one refusal moves to another row with the same count', () => {
    let source = { ...initial(), refused: 1, refusedRowIds: new Set(['row-a']) }
    const store = createSheetSaveStatusStore(() => source)
    const first = store.getRefusedSnapshot()
    source = { ...source, refusedRowIds: new Set(['row-b']) }
    store.refreshCounts()
    expect(store.getRefusedSnapshot()).not.toBe(first)
    expect([...store.getRefusedSnapshot().refusedRowIds]).toEqual(['row-b'])
    source = initial()
    store.refreshCounts()
    expect(store.getRefusedSnapshot().refused).toBe(0)
    expect(store.getRefusedSnapshot().refusedRowIds.size).toBe(0)
  })

  it('keeps warnings, retry counts and connection loss live without changing the confirmed save time', () => {
    let source = initial()
    const store = createSheetSaveStatusStore(() => source)
    store.saved('2026-09-30T10:00:00.000Z')
    source = { ...source, warned: 2, retryable: 1, offline: true }
    store.refreshCounts()
    expect(store.getSnapshot()).toMatchObject({ warned: 2, retryable: 1, offline: true, lastSavedAt: '2026-09-30T10:00:00.000Z' })
  })

  it('retains equal snapshots and releases a removed subscriber', () => {
    const store = createSheetSaveStatusStore(initial)
    const snapshot = store.getSnapshot()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.refreshCounts()
    expect(store.getSnapshot()).toBe(snapshot)
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
    store.saved('2026-09-30T10:00:00.000Z')
    expect(listener).not.toHaveBeenCalled()
  })
})

/**
 * Publish on the Matrix (2026-10-13, one save line): the review starts only after the Matrix's writes, its Status writes
 * and its Base price have saved — a value set just before Publish is never missing from the review — and Publish holds
 * while one is in flight or a cell editor is open.
 */
import { describe, expect, it, vi } from 'vitest'

import { createWorkspaceSaveStore } from '../workspaceSave'
import { createInFlight, matrixPublicationBarrier, MATRIX_PUBLISH_HELD, type MatrixPublishLines } from './publishGuard'

function held() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

function lines(over: Partial<MatrixPublishLines> = {}) {
  const matrix = createInFlight()
  const status = createInFlight()
  const base = { pending: 0, flush: vi.fn(async () => {}) }
  let editing = false
  const all: MatrixPublishLines = { matrix, status, base, editing: () => editing, ...over }
  return { matrix, status, base, all, edit: (open: boolean) => { editing = open } }
}

describe('the Matrix\'s Publish barrier', () => {
  it('Publish reviews only once a price write in flight on the Matrix has landed; it holds while it is on its way', async () => {
    const store = createWorkspaceSaveStore(vi.fn())
    const l = lines()
    store.registerPublicationBarrier(matrixPublicationBarrier(l.all))
    const write = held()
    void l.matrix.track(write.promise)
    expect(store.publicationBlocker()).toBe(MATRIX_PUBLISH_HELD.saving)
    let reviewed: string | null | undefined
    const review = store.preparePublication().then((m) => { reviewed = m })
    await new Promise((r) => setTimeout(r, 5))
    expect(reviewed).toBeUndefined()
    write.release()
    await review
    expect(reviewed).toBeNull()
  })
  it('a Status chosen just before Publish (still in its fence) is waited for too', async () => {
    const store = createWorkspaceSaveStore(vi.fn())
    const l = lines()
    store.registerPublicationBarrier(matrixPublicationBarrier(l.all))
    const status = held()
    // The Status cells leave their fence on the next turn: the write starts after Publish was asked.
    setTimeout(() => { void l.status.track(status.promise) }, 0)
    let reviewed: string | null | undefined
    const review = store.preparePublication().then((m) => { reviewed = m })
    await new Promise((r) => setTimeout(r, 5))
    expect(reviewed).toBeUndefined()
    status.release()
    await review
    expect(reviewed).toBeNull()
  })
  it('the Base price is sent before the review; an open cell editor holds Publish', async () => {
    const store = createWorkspaceSaveStore(vi.fn())
    const l = lines()
    store.registerPublicationBarrier(matrixPublicationBarrier(l.all))
    l.edit(true)
    expect(await store.preparePublication()).toBe(MATRIX_PUBLISH_HELD.editing)
    expect(l.base.flush).toHaveBeenCalled()
    l.edit(false)
    expect(await store.preparePublication()).toBeNull()
  })
  it('a save that got no answer (connection lost) holds Publish, as the Information page does, until it is resolved', async () => {
    const store = createWorkspaceSaveStore(vi.fn())
    let unknown = true
    const l = lines({ unanswered: () => unknown })
    store.registerPublicationBarrier(matrixPublicationBarrier({ ...l.all, unanswered: () => unknown }))
    expect(await store.preparePublication()).toBe(MATRIX_PUBLISH_HELD.unanswered)
    unknown = false
    expect(await store.preparePublication()).toBeNull()
  })
  it('a write that fails still settles the line (Publish then reads the page\'s own refusal marks)', async () => {
    const line = createInFlight()
    const failed = line.track(Promise.reject(new Error('Connection lost')))
    await expect(failed).rejects.toThrow('Connection lost')
    await line.settled()
    expect(line.pending()).toBe(0)
  })
})

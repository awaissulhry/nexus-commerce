import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceSaveStore } from './workspaceSave'
import { reportedWrite } from './images/imageWrites'

describe('workspace save receipts across A → B → A', () => {
  it('does not let a late success clear a different account’s failure for the same subject', () => {
    const store = createWorkspaceSaveStore(vi.fn())
    const a = store.forScope('p/EBAY/a/IT/alt').reporter
    a.pending('a-write', 'gallery')
    const b = store.forScope('p/EBAY/b/IT/alt').reporter
    b.pending('b-write', 'gallery'); b.resolved('b-write', false, 'Permission denied', 'gallery')
    a.resolved('a-write', true, undefined, 'gallery')
    expect(store.forScope('p/EBAY/b/IT/alt').state).toMatchObject({ kind: 'error', failed: 1, message: 'Permission denied' })
    expect(store.forScope('p/EBAY/a/IT/alt').state).toMatchObject({ kind: 'saved', count: 1 })
  })
  it.each(['other/EBAY/a/IT/alt', 'p/AMAZON/a/IT/alt', 'p/EBAY/a/DE/alt', 'p/EBAY/a/IT/primary'])('retains a refused edit only in its product/channel/market/listing: %s', other => {
    const store = createWorkspaceSaveStore(vi.fn())
    const a = store.forScope('p/EBAY/a/IT/alt').reporter
    a.pending('a', 'cell'); a.resolved('a', false, 'Conflict', 'cell')
    expect(store.forScope(other).state.kind).toBe('idle')
    store.forScope(other).reporter.cleared(['cell'])
    expect(store.forScope('p/EBAY/a/IT/alt').state.kind).toBe('error')
    a.pending('retry', 'cell'); a.resolved('retry', true, undefined, 'cell')
    expect(store.forScope('p/EBAY/a/IT/alt').state.kind).toBe('saved')
  })
  it('settles a thrown image write as a failure in its original destination', async () => {
    const store = createWorkspaceSaveStore(vi.fn())
    let reject!: (error: Error) => void
    const pending = reportedWrite(store.forScope('a').reporter, 'image', () => new Promise((_, fail) => { reject = fail }))
    expect(store.forScope('b').state.kind).toBe('idle')
    reject(new Error('Disconnected'))
    expect(await pending).toMatchObject({ ok: false, message: 'Disconnected' })
    expect(store.forScope('a').state).toMatchObject({ kind: 'error', pending: 0 })
    expect(store.forScope('b').state.kind).toBe('idle')
  })
})

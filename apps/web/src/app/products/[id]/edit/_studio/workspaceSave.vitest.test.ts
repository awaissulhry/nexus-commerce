import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceSaveStore } from './workspaceSave'
import { reportedWrite } from './images/imageWrites'
import { reportedFormulaWrite } from './formulaWrites'

describe('workspace save receipts across A → B → A', () => {
  it('holds publication from the moment a drawer formula is queued through save, failure and retry', async () => {
    const store = createWorkspaceSaveStore(vi.fn())
    const reporter = store.forScope('a').reporter
    let finish!: (value: { ok: boolean; error?: string }) => void
    const writing = reportedFormulaWrite(reporter, 'row', 'title', () => new Promise(resolve => { finish = resolve }))
    expect(store.publicationBlocker()).toContain('saving')
    finish({ ok: false, error: 'Formula refused' }); await writing
    expect(await store.preparePublication()).toContain('Formula refused')
    await reportedFormulaWrite(reporter, 'row', 'title', async () => ({ ok: true }))
    expect(await store.preparePublication()).toBeNull()
  })
  it('drains queued edits before reviewing and checks the synchronous ledger after the drain', async () => {
    const store = createWorkspaceSaveStore(vi.fn())
    const reporter = store.forScope('a').reporter
    let finish!: () => void
    const flush = vi.fn(() => new Promise<void>(resolve => { finish = () => { reporter.resolved('write', true); resolve() }; reporter.pending('write') }))
    store.registerPublicationBarrier({ flush, blocker: () => null })
    let ready = false
    const review = store.preparePublication().then(message => { ready = message === null })
    expect(flush).toHaveBeenCalledOnce()
    expect(ready).toBe(false)
    finish(); await review
    expect(ready).toBe(true)
  })
  it('blocks unresolved edits from another destination and an open editor without committing it', async () => {
    const store = createWorkspaceSaveStore(vi.fn())
    const unregister = store.registerPublicationBarrier({ flush: async () => {}, blocker: () => 'Apply or cancel the open cell.' })
    expect(await store.preparePublication()).toBe('Apply or cancel the open cell.')
    unregister()
    const reporter = store.forScope('other-account').reporter
    reporter.pending('unknown')
    expect(await store.preparePublication()).toContain('saving')
    reporter.resolved('unknown', false, 'Conflict')
    expect(await store.preparePublication()).toContain('Conflict')
    reporter.cleared(['unknown'])
    expect(await store.preparePublication()).toBeNull()
  })
  it('checks manual editors after draining the sheet, including writes triggered by the editor guard', async () => {
    const store = createWorkspaceSaveStore(vi.fn())
    const flush = vi.fn(async () => {})
    store.registerPublicationBarrier({ flush, blocker: () => null })
    expect(await store.preparePublication(() => false)).toContain('open editor')
    expect(flush).toHaveBeenCalledOnce()
    expect(store.publicationBlocker(() => { store.forScope('a').reporter.pending('blur'); return true })).toContain('saving')
  })
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

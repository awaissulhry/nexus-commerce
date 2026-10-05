/**
 * Review 2026-10-05 (m2) — one shared read of the Status and Action values per destination: the sheet's columns, the
 * studio bar's listing picker and the toolbar mark make ONE request; an answer is reused for a few seconds unless a
 * reader asks for one read after an event; a dropped read tells every reader to read again.
 */
import { describe, expect, it } from 'vitest'
import { PUBLISH_ACTIONS_READ_TTL_MS, PublishActionsReadCache, publishActionsReadKey, type PublishActionsCacheEvent, type PublishActionsDestination, type PublishActionsRead } from './publishActionsApi'

const IT = { channel: 'EBAY', marketplace: 'IT', accountId: 'acc' }

/** A server whose answers the test releases one by one; every request is recorded with its signal. */
function server() {
  const calls: Array<{ productId: string; destination: PublishActionsDestination; signal: AbortSignal; answer(read?: Partial<PublishActionsRead>): void; fail(error: Error): void }> = []
  const reader = (productId: string, destination: PublishActionsDestination, signal: AbortSignal) => new Promise<PublishActionsRead>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    calls.push({ productId, destination, signal, answer: read => resolve({ rows: [], readAt: `read-${calls.length}`, ...read }), fail: reject })
  })
  let now = 1_000
  const cache = new PublishActionsReadCache(reader, () => now)
  return { cache, calls, tick: (ms: number) => { now += ms }, at: () => now }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('the shared publish-actions read', () => {
  it('joins a read in flight: three readers of one destination, one request, one answer', async () => {
    const s = server()
    const reads = [s.cache.read('p', IT), s.cache.read('p', { ...IT }), s.cache.read('p', { ...IT, aliasKey: undefined })]
    expect(s.calls).toHaveLength(1)
    s.calls[0].answer({ readAt: 'one' })
    const answers = await Promise.all(reads)
    expect(answers.map(a => a.readAt)).toEqual(['one', 'one', 'one'])
    // Another destination (or the main listing alone, aliasKey '') is its own read.
    void s.cache.read('p', { ...IT, aliasKey: '' }).catch(() => undefined)
    void s.cache.read('p', {}).catch(() => undefined)
    void s.cache.read('other', IT).catch(() => undefined)
    expect(s.calls).toHaveLength(4)
  })

  it('reuses an answer for the TTL, then reads again', async () => {
    const s = server()
    const first = s.cache.read('p', IT)
    s.calls[0].answer({ readAt: 'first' })
    await first
    s.tick(PUBLISH_ACTIONS_READ_TTL_MS - 1)
    expect((await s.cache.read('p', IT)).readAt).toBe('first')
    expect(s.calls).toHaveLength(1)
    s.tick(1)
    const later = s.cache.read('p', IT)
    expect(s.calls).toHaveLength(2)
    s.calls[1].answer({ readAt: 'second' })
    expect((await later).readAt).toBe('second')
  })

  it('`since`: an answer from a read started before an event is never reused; one started after it is', async () => {
    const s = server()
    const first = s.cache.read('p', IT)
    s.calls[0].answer({ readAt: 'before' })
    await first
    s.tick(100)
    const event = s.at()
    const fresh = s.cache.read('p', IT, undefined, { since: event })
    expect(s.calls).toHaveLength(2)
    // A second reader after the same event joins that newer read.
    const joined = s.cache.read('p', IT, undefined, { since: event })
    expect(s.calls).toHaveLength(2)
    s.calls[1].answer({ readAt: 'after' })
    expect([(await fresh).readAt, (await joined).readAt]).toEqual(['after', 'after'])
  })

  it('invalidate drops the product’s reads and tells its readers; other products are untouched', async () => {
    const s = server()
    const heard: PublishActionsCacheEvent[] = []
    const stop = s.cache.subscribe('p', event => heard.push(event))
    const a = s.cache.read('p', IT), b = s.cache.read('q', IT)
    s.calls[0].answer({ readAt: 'p1' }); s.calls[1].answer({ readAt: 'q1' })
    await Promise.all([a, b])
    expect(heard).toEqual([{ type: 'read', key: publishActionsReadKey('p', IT), read: { rows: [], readAt: 'p1' }, startedAt: 1_000 }])
    s.cache.invalidate('p')
    expect(heard.at(-1)).toEqual({ type: 'invalidated' })
    expect(s.cache.size).toBe(1)
    void s.cache.read('p', IT).catch(() => undefined)
    void s.cache.read('q', IT)
    expect(s.calls).toHaveLength(3)
    expect(s.calls[2].productId).toBe('p')
    stop()
    s.cache.invalidate('p')
    expect(heard.filter(e => e.type === 'invalidated')).toHaveLength(1)
  })

  it('a reader that gives up stops only its own wait; the request stops when nobody waits any more', async () => {
    const s = server()
    const one = new AbortController(), two = new AbortController()
    const first = s.cache.read('p', IT, one.signal)
    const second = s.cache.read('p', IT, two.signal)
    one.abort()
    await expect(first).rejects.toThrow()
    expect(s.calls[0].signal.aborted).toBe(false)
    two.abort()
    await expect(second).rejects.toThrow()
    expect(s.calls[0].signal.aborted).toBe(true)
    // Nothing is kept: the next reader asks again.
    void s.cache.read('p', IT).catch(() => undefined)
    expect(s.calls).toHaveLength(2)
    // A reader already cancelled never starts a request.
    const gone = new AbortController(); gone.abort()
    await expect(s.cache.read('p', { channel: 'AMAZON' }, gone.signal)).rejects.toThrow()
    expect(s.calls).toHaveLength(2)
  })

  it('never keeps a failed read', async () => {
    const s = server()
    const first = s.cache.read('p', IT)
    s.calls[0].fail(new Error('down'))
    await expect(first).rejects.toThrow('down')
    await flush()
    expect(s.cache.size).toBe(0)
    void s.cache.read('p', IT)
    expect(s.calls).toHaveLength(2)
  })

  it('names one read by its filter as the request does: blank parts are no filter, aliasKey "" is the main listing', () => {
    expect(publishActionsReadKey('p', { channel: 'EBAY', marketplace: 'IT', accountId: 'acc', aliasKey: null })).toBe(publishActionsReadKey('p', IT))
    expect(publishActionsReadKey('p', { channel: '', marketplace: null })).toBe(publishActionsReadKey('p', {}))
    expect(publishActionsReadKey('p', { ...IT, aliasKey: '' })).not.toBe(publishActionsReadKey('p', IT))
  })
})

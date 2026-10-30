import { describe, expect, it } from 'vitest'
import { createClientTracker, installErrorReporting, memorySink, offSink, sourceOf } from './tracker'

/**
 * Error tracking with redaction in the browser (PLT-218): an uncaught error becomes one redacted report (page path with
 * its ids replaced, no person, no secret, no money), the same error again within a minute is not reported twice, a page
 * reports at most 20, production keeps nothing. Made-up values only.
 */

const at = new Date('2026-10-30T10:00:00.000Z')
let id = 0
const tracker = (sink = memorySink()) => ({ sink, tracker: createClientTracker({ source: 'web', sink, now: () => at, newId: () => `r${++id}` }) })

class Target {
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()
  addEventListener(type: string, listener: (event: Event) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }
  removeEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.get(type)?.delete(listener)
  }
  fire(type: string, event: object) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as Event)
  }
}

describe('client error reports', () => {
  it('an uncaught error and an unhandled rejection become redacted reports with the page path', () => {
    const { sink, tracker: t } = tracker()
    const target = new Target()
    const stop = installErrorReporting(target, t, () => '/w/0198a3f2-1c2d-7e3f-8a4b-5c6d7e8f9a0b/sales/orders/0198a3f2-1c2d-7e3f-8a4b-5c6d7e8f9a0c', 'v1')
    target.fire('error', { error: new TypeError('Cannot read price: 12.50 of mario@example.com'), message: 'x' })
    target.fire('unhandledrejection', { reason: new Error('token=made-up-token-7 refused') })
    const reports = sink.reports()
    expect(reports).toHaveLength(2)
    expect(reports[0]).toMatchObject({ source: 'web', name: 'TypeError', context: { path: '/w/:id/sales/orders/:id', release: 'v1', component: 'window.error' } })
    expect(reports[1]).toMatchObject({ context: { component: 'unhandledrejection' } })
    const text = JSON.stringify(reports)
    for (const secret of ['12.50', 'mario@example.com', 'made-up-token-7', '0198a3f2-1c2d-7e3f-8a4b-5c6d7e8f9a0b']) expect(text, secret).not.toContain(secret)
    stop()
    target.fire('error', { error: new Error('after stop') })
    expect(sink.reports()).toHaveLength(2)
  })

  it('reports the same error once a minute and at most 20 per page', () => {
    const { sink, tracker: t } = tracker()
    t.capture(new Error('same'))
    t.capture(new Error('same'))
    expect(sink.reports()).toHaveLength(1)
    for (let n = 0; n < 40; n++) t.capture(new Error(`different ${n}`))
    expect(sink.reports()).toHaveLength(20)
  })

  it('off keeps nothing (production)', () => {
    const { tracker: t } = tracker(offSink as ReturnType<typeof memorySink>)
    expect(t.capture(new Error('x'))).toBeNull()
  })

  it('names the floor app as its own source', () => {
    expect(sourceOf('/floor')).toBe('floor')
    expect(sourceOf('/floor/sync')).toBe('floor')
    expect(sourceOf('/floorplan')).toBe('web')
    expect(sourceOf('/w/x/admin')).toBe('web')
  })
})

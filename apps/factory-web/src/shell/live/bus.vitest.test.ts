import { describe, expect, it } from 'vitest'
import { createLiveBus, parseLiveData, type LiveChange, type LiveSource } from './bus'

/** A stand-in for the browser's EventSource: the test fires its events. */
class FakeSource implements LiveSource {
  readyState = 0
  closed = false
  readonly handlers = new Map<string, Set<(event: MessageEvent<string>) => void>>()
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set())
    this.handlers.get(type)!.add(listener)
  }
  removeEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.handlers.get(type)?.delete(listener)
  }
  close() {
    this.closed = true
  }
  fire(type: string, data = '') {
    for (const listener of this.handlers.get(type) ?? []) listener({ data } as MessageEvent<string>)
  }
}

function harness() {
  const sources: FakeSource[] = []
  const timers = new Map<number, () => void>()
  let next = 1
  const bus = createLiveBus({
    open: () => {
      const source = new FakeSource()
      sources.push(source)
      return source
    },
    pollMs: 30_000,
    graceMs: 0,
    setInterval: (run) => {
      const id = next++
      timers.set(id, run)
      return id
    },
    clearInterval: (id) => timers.delete(id as number),
  })
  return { bus, sources, timers, tick: () => [...timers.values()].forEach((run) => run()) }
}

describe('one live bus per browser tab (B-W2b-05, COL-077)', () => {
  it('opens ONE connection for every listener of the tab, and closes it with the last', () => {
    const { bus, sources } = harness()
    const seenA: LiveChange[] = []
    const seenB: LiveChange[] = []
    const offA = bus.subscribe({ onChange: (change) => seenA.push(change) })
    const offB = bus.subscribe({ onChange: (change) => seenB.push(change) })
    expect(sources).toHaveLength(1)
    expect(bus.opened()).toBe(1)
    sources[0]!.fire('ready')
    expect(bus.state()).toBe('live')
    sources[0]!.fire('change', JSON.stringify({ type: 'notification.created', companyId: 'c1', siteId: null, fields: { id: 'n1' } }))
    expect(seenA).toEqual([{ type: 'notification.created', companyId: 'c1', siteId: null, fields: { id: 'n1' } }])
    expect(seenB).toEqual(seenA)
    offA()
    expect(sources[0]!.closed).toBe(false)
    offB()
    expect(sources[0]!.closed).toBe(true)
    // A new listener later opens a new connection (one at a time).
    bus.subscribe({})
    expect(sources).toHaveLength(2)
  })

  it('says its state in words and tells every listener to read again after a break (nothing is replayed)', () => {
    const { bus, sources } = harness()
    let resyncs = 0
    const states: string[] = []
    bus.watch(() => states.push(bus.state()))
    bus.subscribe({ onResync: () => (resyncs += 1) })
    expect(bus.state()).toBe('connecting')
    sources[0]!.fire('ready')
    expect(resyncs).toBe(0) // the first `ready` is the first read
    sources[0]!.fire('error')
    expect(bus.state()).toBe('offline')
    sources[0]!.fire('ready')
    expect(resyncs).toBe(1)
    expect(states).toEqual(['live', 'offline', 'live'])
  })

  it('keeps ONE fallback poll for the tab while the stream is down, and stops it when it is live again', () => {
    const { bus, sources, timers, tick } = harness()
    let resyncs = 0
    bus.subscribe({ onResync: () => (resyncs += 1) })
    bus.subscribe({ onResync: () => (resyncs += 1) })
    sources[0]!.fire('ready')
    expect(timers.size).toBe(0)
    sources[0]!.fire('error')
    expect(timers.size).toBe(1)
    tick()
    expect(resyncs).toBe(2) // one poll, each listener reads again
    sources[0]!.fire('ready')
    expect(timers.size).toBe(0)
  })

  it('keeps the connection for a moment after the last listener left, so the next page takes it over', async () => {
    const sources: FakeSource[] = []
    const bus = createLiveBus({ open: () => (sources.push(new FakeSource()), sources[sources.length - 1]!), graceMs: 20 })
    const off = bus.subscribe({})
    off()
    bus.subscribe({})
    expect(sources).toHaveLength(1)
    expect(sources[0]!.closed).toBe(false)
    const off2 = bus.subscribe({})
    off2()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(sources[0]!.closed).toBe(false) // one listener is still there
  })

  it('stays offline where there is no stream (a server render, an old browser)', () => {
    const bus = createLiveBus({ open: null })
    bus.subscribe({})
    expect(bus.state()).toBe('offline')
    expect(bus.opened()).toBe(0)
  })

  it('reads a change message; anything else is not one', () => {
    expect(parseLiveData('{"type":"x"}')).toEqual({ type: 'x', fields: {}, companyId: null, siteId: null })
    expect(parseLiveData('{"fields":{}}')).toBeNull()
    expect(parseLiveData('not json')).toBeNull()
  })
})

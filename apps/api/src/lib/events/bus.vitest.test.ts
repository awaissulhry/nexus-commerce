// EV.3 — the shared bus factory.
//
// Nine buses depend on this now, so its guarantees are asserted here rather
// than nine times over. Each test below is a property that was hand-written
// (and could drift) in every bus before.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@nexus/events'
import { InMemoryBroker } from './broker.js'
import { setBroker, closeBroker } from './index.js'
import { createCrossReplicaBus, type BusEvent } from './bus.js'

interface TestEvent extends BusEvent { type: string; productId?: string; poId?: string }

const envelope = (type: string, payload: Record<string, unknown>): EventEnvelope => ({
  id: randomUUID(), type, version: 1, occurredAt: new Date().toISOString(),
  accountId: null, subject: 's', correlationId: randomUUID(), causationId: null,
  source: 'other-replica', payload,
})

let broker: InMemoryBroker
beforeEach(async () => {
  await closeBroker()
  broker = new InMemoryBroker()
  setBroker(broker)
})

const makeBus = (over: Record<string, unknown> = {}) =>
  createCrossReplicaBus<TestEvent>({
    name: 'test-bus',
    types: ['product.updated', 'product.created'],
    ...over,
  } as never)

describe('local delivery', () => {
  it('delivers synchronously, in the publishing tick', () => {
    // Callers rely on this: a mutation's own tab must not wait on a network
    // round trip to learn about a change it just made.
    const bus = makeBus()
    const seen: TestEvent[] = []
    bus.subscribe((e) => seen.push(e))
    bus.publish({ type: 'product.updated', productId: 'p1', ts: Date.now() })
    expect(seen).toHaveLength(1)
  })

  it('one throwing listener does not silence the others', () => {
    const bus = makeBus()
    const seen: string[] = []
    bus.subscribe(() => { throw new Error('bad subscriber') })
    bus.subscribe((e) => seen.push(e.type))
    bus.publish({ type: 'product.updated', ts: Date.now() })
    expect(seen).toEqual(['product.updated'])
  })

  it('unsubscribe removes the listener', () => {
    const bus = makeBus()
    const off = bus.subscribe(() => {})
    expect(bus.listenerCount()).toBe(1)
    off()
    expect(bus.listenerCount()).toBe(0)
  })
})

describe('cross-replica intake', () => {
  it('delivers another replica\'s event to local listeners', async () => {
    const bus = makeBus()
    await bus.startIntake()
    const seen: TestEvent[] = []
    bus.subscribe((e) => seen.push(e))
    await broker.publish([envelope('product.updated', { productId: 'remote' })])
    expect(seen).toHaveLength(1)
    expect(seen[0].productId).toBe('remote')
    await bus.stopIntake()
  })

  it('does NOT deliver an event belonging to another bus', async () => {
    // Nine buses share one stream. Without this, an SSE client subscribed to
    // listings starts receiving purchase orders.
    const bus = makeBus()
    await bus.startIntake()
    const seen: TestEvent[] = []
    bus.subscribe((e) => seen.push(e))
    await broker.publish([envelope('po.created', { poId: 'po1', poNumber: 'PO-1' })])
    expect(seen).toEqual([])
    await bus.stopIntake()
  })

  it('does not deliver its OWN publish twice', async () => {
    // The local publish already reached listeners synchronously; the broker
    // echo must be suppressed or every subscriber sees each event twice.
    const bus = makeBus()
    await bus.startIntake()
    const seen: TestEvent[] = []
    bus.subscribe((e) => seen.push(e))
    bus.publish({ type: 'product.updated', productId: 'mine', ts: Date.now() })
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(1)
    await bus.stopIntake()
  })

  it('startIntake is idempotent', async () => {
    const bus = makeBus()
    await bus.startIntake()
    await bus.startIntake()
    const seen: TestEvent[] = []
    bus.subscribe((e) => seen.push(e))
    await broker.publish([envelope('product.updated', {})])
    expect(seen).toHaveLength(1)   // not 2
    await bus.stopIntake()
  })
})

describe('replay buffer', () => {
  it('returns nothing when no replay is configured', () => {
    const bus = makeBus()
    bus.publish({ type: 'product.updated', ts: Date.now() })
    expect(bus.replaySince(0)).toEqual([])
    expect(bus.bufferDepth()).toBe(0)
  })

  it('buffers published events and replays them since a timestamp', () => {
    const bus = makeBus({ replay: { max: 10, ttlMs: 60_000 } })
    const before = Date.now() - 1
    bus.publish({ type: 'product.updated', productId: 'a', ts: Date.now() })
    expect(bus.replaySince(before)).toHaveLength(1)
    expect(bus.replaySince(Date.now() + 1000)).toEqual([])
  })

  it('caps the buffer at max, dropping oldest first', () => {
    const bus = makeBus({ replay: { max: 3, ttlMs: 60_000 } })
    for (const id of ['a','b','c','d','e']) {
      bus.publish({ type: 'product.updated', productId: id, ts: Date.now() })
    }
    expect(bus.bufferDepth()).toBeLessThanOrEqual(3)
    expect(bus.replaySince(0).map((e) => e.productId)).not.toContain('a')
  })

  it('buffers a REMOTE event too, so a reconnecting tab replays what happened anywhere', async () => {
    const bus = makeBus({ replay: { max: 10, ttlMs: 60_000 } })
    await bus.startIntake()
    await broker.publish([envelope('product.updated', { productId: 'remote' })])
    expect(bus.replaySince(0).map((e) => e.productId)).toContain('remote')
    await bus.stopIntake()
  })
})

describe('onPublish hook', () => {
  it('runs on a LOCAL publish', () => {
    const onPublish = vi.fn()
    const bus = makeBus({ onPublish })
    bus.publish({ type: 'product.updated', ts: Date.now() })
    expect(onPublish).toHaveBeenCalledTimes(1)
  })

  it('does NOT run for a remote event', async () => {
    // po-events persists to PoEventLog here. Re-running it per replica would
    // duplicate every audit row once per running instance.
    const onPublish = vi.fn()
    const bus = makeBus({ onPublish })
    await bus.startIntake()
    await broker.publish([envelope('product.updated', { productId: 'remote' })])
    expect(onPublish).not.toHaveBeenCalled()
    await bus.stopIntake()
  })

  it('a throwing hook does not break delivery', () => {
    const bus = makeBus({ onPublish: () => { throw new Error('persist failed') } })
    const seen: TestEvent[] = []
    bus.subscribe((e) => seen.push(e))
    bus.publish({ type: 'product.updated', ts: Date.now() })
    expect(seen).toHaveLength(1)
  })
})

describe('ping stays local', () => {
  it('is delivered locally but never put on the broker', () => {
    // A per-connection SSE keepalive on a shared bus would be multiplied by
    // every replica, for no one.
    const bus = makeBus()
    const seen: TestEvent[] = []
    bus.subscribe((e) => seen.push(e))
    bus.publish({ type: 'ping', ts: Date.now() })
    expect(seen).toHaveLength(1)
    expect(broker.published).toHaveLength(0)
  })
})

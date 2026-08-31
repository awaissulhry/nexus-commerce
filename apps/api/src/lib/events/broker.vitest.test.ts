// EV.1 — broker contract tests.
//
// These assert the two guarantees consumers are allowed to rely on: stable
// partitioning (so per-subject ordering is real) and type-filtered, correlated
// delivery. Everything else about a driver is an implementation detail.

import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@nexus/events'
import { InMemoryBroker, NoopBroker, shardFor, streamKey, allStreamKeys } from './broker.js'
import { subscribeEvents } from './subscribe.js'
import { currentCorrelationId, currentCausationId } from './correlation.js'

function envelope(type: string, subject: string, over: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: randomUUID(),
    type,
    version: 1,
    occurredAt: new Date().toISOString(),
    accountId: null,
    subject,
    correlationId: randomUUID(),
    causationId: null,
    source: 'test',
    payload: {},
    ...over,
  }
}

describe('partitioning', () => {
  it('sends a subject to the same shard every time', () => {
    // If this drifts, two events about one product can land on different
    // streams and be handled out of order — the exact failure that makes
    // stock arithmetic wrong.
    for (const subject of ['p1', 'SUIT-48', 'order-9', '']) {
      const first = shardFor(subject, 8)
      for (let i = 0; i < 50; i++) expect(shardFor(subject, 8)).toBe(first)
    }
  })

  it('keeps every shard in range', () => {
    for (let i = 0; i < 500; i++) {
      const shard = shardFor(`subject-${i}`, 8)
      expect(shard).toBeGreaterThanOrEqual(0)
      expect(shard).toBeLessThan(8)
    }
  })

  it('collapses to a single stream at the default shard count of 1', () => {
    expect(shardFor('anything', 1)).toBe(0)
    expect(allStreamKeys(1)).toEqual(['nexus.events.v1.0'])
    expect(streamKey(3)).toBe('nexus.events.v1.3')
  })

  it('spreads subjects across shards when sharding is enabled', () => {
    // A hash that returns a constant would pass every test above while
    // silently serialising the entire platform onto one stream.
    const seen = new Set(Array.from({ length: 200 }, (_, i) => shardFor(`subject-${i}`, 8)))
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe('NoopBroker', () => {
  it('drops publishes without throwing', async () => {
    // The outbox row is already committed; throwing here would fail an
    // operator's save for something they cannot fix.
    await expect(new NoopBroker().publish([envelope('product.updated', 'p1')])).resolves.toBeUndefined()
  })
})

describe('subscribeEvents', () => {
  it('delivers matching types and filters the rest', async () => {
    const broker = new InMemoryBroker()
    const seen: string[] = []
    await subscribeEvents(broker, {
      group: 'test-filter',
      types: ['product.updated'],
      handler: (e) => { seen.push(e.type) },
    })

    await broker.publish([
      envelope('product.updated', 'p1'),
      envelope('order.created', 'o1'),
      envelope('product.updated', 'p2'),
    ])

    expect(seen).toEqual(['product.updated', 'product.updated'])
  })

  it('rejects a subscription to an unknown type at registration', async () => {
    // A typo'd type is otherwise silent — the subscriber just never fires,
    // and an absence is far harder to notice than an error.
    await expect(
      subscribeEvents(new InMemoryBroker(), {
        group: 'test-typo',
        types: ['prodcut.updated' as never],
        handler: () => {},
      }),
    ).rejects.toThrow(/unknown event type/i)
  })

  it('runs the handler inside the incoming correlation, with the event as causation', async () => {
    const broker = new InMemoryBroker()
    const correlationId = randomUUID()
    const incoming = envelope('product.updated', 'p1', { correlationId })
    let observed: { correlation: string | null; causation: string | null } | null = null

    await subscribeEvents(broker, {
      group: 'test-correlation',
      handler: () => { observed = { correlation: currentCorrelationId(), causation: currentCausationId() } },
    })
    await broker.publish([incoming])

    expect(observed).toEqual({ correlation: correlationId, causation: incoming.id })
  })

  it('reports a handler throw through onError without killing the subscription', async () => {
    const broker = new InMemoryBroker()
    const onError = vi.fn()
    const seen: string[] = []
    await subscribeEvents(broker, {
      group: 'test-errors',
      handler: (e) => {
        if (e.subject === 'boom') throw new Error('handler exploded')
        seen.push(e.subject)
      },
      onError,
    })

    await broker.publish([envelope('product.updated', 'boom'), envelope('product.updated', 'fine')])

    expect(onError).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['fine'])
  })

  it('gives every group its own copy of the stream', async () => {
    const broker = new InMemoryBroker()
    const a: string[] = []
    const b: string[] = []
    await subscribeEvents(broker, { group: 'group-a', handler: (e) => { a.push(e.subject) } })
    await subscribeEvents(broker, { group: 'group-b', handler: (e) => { b.push(e.subject) } })

    await broker.publish([envelope('product.updated', 'p1')])

    expect(a).toEqual(['p1'])
    expect(b).toEqual(['p1'])
  })
})

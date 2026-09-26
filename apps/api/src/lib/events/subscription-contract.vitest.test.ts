import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { EventEnvelope } from '@nexus/events'
import { InMemoryBroker } from './broker.js'
import { subscribeBroadcastEvents, subscribeEvents } from './subscribe.js'
import { correlationForPublish, withCorrelation } from './correlation.js'
import { runWithRequestId, runWithTraceId } from '../../utils/request-context.js'

function event(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: randomUUID(),
    type: 'product.updated',
    version: 1,
    occurredAt: '2026-09-25T12:00:00.000Z',
    accountId: null,
    subject: 'product-1',
    correlationId: 'incoming-correlation',
    causationId: null,
    source: 'test',
    payload: { productId: 'product-1' },
    ...overrides,
  }
}

describe.each(['durable', 'broadcast'] as const)('%s consumer contract boundary', (lane) => {
  async function subscriber() {
    const broker = new InMemoryBroker()
    const received: EventEnvelope[] = []
    const onError = vi.fn()
    const handler = (envelope: EventEnvelope) => { received.push(envelope) }
    // No type filter: all-events subscribers must also reject unknown contracts.
    if (lane === 'durable') {
      await subscribeEvents(broker, { group: 'contract-test', handler, onError })
    } else {
      await subscribeBroadcastEvents(broker, { name: 'contract-test', handler, onError })
    }
    return { broker, received, onError }
  }

  it.each([
    ['malformed known payload', { payload: { productId: 42 } }],
    ['unsupported version', { version: 999 }],
    ['unknown event type', { type: 'product.future_contract' }],
  ] as const)('reports %s without executing domain work or blocking the next valid event', async (_name, invalid) => {
    const { broker, received, onError } = await subscriber()
    const rejected = event(invalid)
    const accepted = event()

    await broker.publish([rejected, accepted])

    expect(received).toEqual([accepted])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.any(Error), rejected)
    await broker.close()
  })

  it('delivers a valid version-one event with its payload and incoming correlation intact', async () => {
    const broker = new InMemoryBroker()
    const incoming = event()
    let observed: { envelope: EventEnvelope; correlation: ReturnType<typeof correlationForPublish> } | undefined
    const handler = (envelope: EventEnvelope) => {
      observed = { envelope, correlation: correlationForPublish() }
    }
    if (lane === 'durable') {
      await subscribeEvents(broker, { group: 'valid-contract', handler })
    } else {
      await subscribeBroadcastEvents(broker, { name: 'valid-contract', handler })
    }

    await broker.publish([incoming])

    expect(observed).toEqual({
      envelope: incoming,
      correlation: { correlationId: incoming.correlationId, causationId: incoming.id },
    })
    await broker.close()
  })
})

describe('request context to event correlation', () => {
  it('uses the HTTP request id for every event emitted by that request', async () => {
    const observed = await runWithRequestId('http-request-1', 'http', async () => {
      const first = correlationForPublish()
      await Promise.resolve()
      return [first, correlationForPublish()]
    })

    expect(observed).toEqual([
      { correlationId: 'http-request-1', causationId: null },
      { correlationId: 'http-request-1', causationId: null },
    ])
  })

  it('prefers the change trace over the surrounding request id', () => {
    const observed = runWithRequestId('http-request-2', 'http', () =>
      runWithTraceId('change-trace-2', () => correlationForPublish()),
    )

    expect(observed).toEqual({ correlationId: 'change-trace-2', causationId: null })
  })

  it('preserves incoming event correlation and causation over request and change context', () => {
    const causationId = randomUUID()
    const observed = runWithRequestId('http-request-3', 'http', () =>
      runWithTraceId('change-trace-3', () =>
        withCorrelation({ correlationId: 'event-chain-3', causationId }, () => correlationForPublish()),
      ),
    )

    expect(observed).toEqual({ correlationId: 'event-chain-3', causationId })
  })

  it('still generates independent roots when no request or event context exists', () => {
    const first = correlationForPublish()
    const second = correlationForPublish()

    expect(first.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(second.correlationId).not.toBe(first.correlationId)
    expect(first.causationId).toBeNull()
  })
})

// EV.1 — relay ordering tests.
//
// The relay has exactly one non-obvious property and everything depends on it:
// it publishes BEFORE it stamps. Reversed, a crash between the two loses the
// event with nothing recording that it should have happened — which is the
// failure the outbox exists to prevent, reintroduced one line later.
//
// Prisma is mocked (repo convention: vi.hoisted + vi.mock('../db.js')) so the
// control flow is asserted deterministically. FOR UPDATE SKIP LOCKED and the
// attempts-based quarantine are SQL predicates, so they are proven against a
// real Postgres in the integration run, not here — asserting on query text
// would only be testing that a string still says what I typed.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { $transaction, $queryRaw, updateMany, $executeRaw } = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  updateMany: vi.fn(),
  $executeRaw: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    $transaction,
    $queryRaw,
    $executeRaw,
    eventOutbox: { updateMany, count: vi.fn(), findFirst: vi.fn() },
  },
}))

import { relayOnce, pruneOutbox } from './relay.js'
import type { EventBroker } from './broker.js'

const CONFIG = { batchSize: 10, maxAttempts: 5, retentionDays: 7 }

function row(id: string, subject: string) {
  return {
    id,
    eventId: `evt-${id}`,
    type: 'product.updated',
    version: 1,
    accountId: null,
    subject,
    correlationId: 'corr-1',
    causationId: null,
    source: 'api',
    payload: { productId: subject },
    occurredAt: new Date('2026-08-31T12:00:00.000Z'),
  }
}

/** Wires $transaction to hand the callback a tx client, recording call order. */
function wireTransaction(rows: ReturnType<typeof row>[], order: string[]) {
  $queryRaw.mockImplementation(async () => { order.push('claim'); return rows })
  updateMany.mockImplementation(async (args: unknown) => {
    const data = (args as { data: Record<string, unknown> }).data
    order.push(data.publishedAt ? 'stamp' : 'record-failure')
    return { count: rows.length }
  })
  $transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({ $queryRaw, eventOutbox: { updateMany } }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('relayOnce', () => {
  it('publishes BEFORE it stamps', async () => {
    const order: string[] = []
    wireTransaction([row('1', 'p1'), row('2', 'p2')], order)
    const broker: EventBroker = {
      name: 'test',
      publish: vi.fn(async () => { order.push('publish') }),
      subscribe: vi.fn(),
      close: vi.fn(),
    } as unknown as EventBroker

    const result = await relayOnce(broker, CONFIG)

    expect(order).toEqual(['claim', 'publish', 'stamp'])
    expect(result).toEqual({ claimed: 2, published: 2, failed: 0 })
  })

  it('hands the broker fully-formed envelopes rebuilt from the row', async () => {
    const order: string[] = []
    wireTransaction([row('1', 'p1')], order)
    const publish = vi.fn(async () => {})
    await relayOnce({ name: 'test', publish, subscribe: vi.fn(), close: vi.fn() } as unknown as EventBroker, CONFIG)

    expect(publish).toHaveBeenCalledTimes(1)
    const [envelopes] = publish.mock.calls[0] as unknown as [Array<Record<string, unknown>>]
    expect(envelopes[0]).toEqual({
      id: 'evt-1',
      type: 'product.updated',
      version: 1,
      occurredAt: '2026-08-31T12:00:00.000Z',
      accountId: null,
      subject: 'p1',
      correlationId: 'corr-1',
      causationId: null,
      source: 'api',
      payload: { productId: 'p1' },
    })
  })

  it('does not stamp when the broker throws, and counts the attempt', async () => {
    // The rows must stay pending. Stamping a failed publish is the silent
    // data-loss path.
    const order: string[] = []
    wireTransaction([row('1', 'p1')], order)
    const broker = {
      name: 'test',
      publish: vi.fn(async () => { order.push('publish'); throw new Error('redis unreachable') }),
      subscribe: vi.fn(),
      close: vi.fn(),
    } as unknown as EventBroker

    const result = await relayOnce(broker, CONFIG)

    expect(order).toEqual(['claim', 'publish', 'record-failure'])
    expect(result).toEqual({ claimed: 1, published: 0, failed: 1 })
    const args = updateMany.mock.calls[0]![0] as { data: Record<string, unknown> }
    expect(args.data.attempts).toEqual({ increment: 1 })
    expect(args.data.lastError).toContain('redis unreachable')
    expect(args.data.publishedAt).toBeUndefined()
  })

  it('truncates a huge broker error rather than storing it whole', async () => {
    const order: string[] = []
    wireTransaction([row('1', 'p1')], order)
    const broker = {
      name: 'test',
      publish: vi.fn(async () => { throw new Error('x'.repeat(5000)) }),
      subscribe: vi.fn(), close: vi.fn(),
    } as unknown as EventBroker

    await relayOnce(broker, CONFIG)
    const args = updateMany.mock.calls[0]![0] as { data: { lastError: string } }
    expect(args.data.lastError.length).toBeLessThanOrEqual(500)
  })

  it('clears a stale lastError once the row finally publishes', async () => {
    const order: string[] = []
    wireTransaction([row('1', 'p1')], order)
    await relayOnce({ name: 'test', publish: vi.fn(async () => {}), subscribe: vi.fn(), close: vi.fn() } as unknown as EventBroker, CONFIG)
    const args = updateMany.mock.calls[0]![0] as { data: Record<string, unknown> }
    expect(args.data.lastError).toBeNull()
    expect(args.data.publishedAt).toBeInstanceOf(Date)
  })

  it('touches neither the broker nor the table when nothing is pending', async () => {
    const order: string[] = []
    wireTransaction([], order)
    const publish = vi.fn(async () => {})
    const result = await relayOnce({ name: 'test', publish, subscribe: vi.fn(), close: vi.fn() } as unknown as EventBroker, CONFIG)

    expect(result).toEqual({ claimed: 0, published: 0, failed: 0 })
    expect(publish).not.toHaveBeenCalled()
    expect(updateMany).not.toHaveBeenCalled()
  })
})

describe('pruneOutbox', () => {
  it('deletes in bounded chunks and reports the count', async () => {
    // An append-only table on a hot write path is unbounded. An unbounded
    // DELETE is its own outage.
    $executeRaw.mockResolvedValue(42)
    expect(await pruneOutbox(CONFIG)).toBe(42)
    expect($executeRaw).toHaveBeenCalledTimes(1)
  })
})

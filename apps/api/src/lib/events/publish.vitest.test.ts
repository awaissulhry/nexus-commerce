// EV.1 — transactional publish tests.
//
// No database here: publishEvent's job is to validate, build a correct
// envelope, and write exactly one row through whatever client it is handed.
// The transaction guarantee itself is a property of the CALLER passing `tx`,
// which the live integration run exercises.

import { describe, it, expect, vi } from 'vitest'
import { buildEnvelope, publishEvent, publishEvents } from './publish.js'
import { withCorrelation } from './correlation.js'

function fakeDb() {
  const created: Array<Record<string, unknown>> = []
  return {
    created,
    client: {
      eventOutbox: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return data }),
        createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => { created.push(...data); return { count: data.length } }),
      },
    },
  }
}

describe('buildEnvelope', () => {
  it('derives the subject from the catalogue, not the call site', () => {
    const envelope = buildEnvelope('product.updated', { productId: 'p-42' })
    expect(envelope.subject).toBe('p-42')
    expect(envelope.type).toBe('product.updated')
    expect(envelope.version).toBe(1)
  })

  it('rejects an invalid payload at the publisher, not downstream', () => {
    // The stack trace has to point at whoever published it. A consumer three
    // services away cannot do anything about a malformed event.
    expect(() => buildEnvelope('listing.synced', { listingId: 'l1' } as never)).toThrow(/Invalid payload/)
  })

  it('rejects an unknown key rather than silently dropping it', () => {
    expect(() => buildEnvelope('product.updated', { productId: 'p1', typo: 1 } as never)).toThrow(/Invalid payload/)
  })

  it('mints a unique id per event — the idempotency key', () => {
    const ids = new Set(Array.from({ length: 100 }, () => buildEnvelope('product.updated', { productId: 'p1' }).id))
    expect(ids.size).toBe(100)
  })

  it('records domain time, and lets a caller state an earlier one', () => {
    const occurredAt = new Date('2026-08-30T10:00:00.000Z')
    expect(buildEnvelope('product.updated', { productId: 'p1' }, { occurredAt }).occurredAt).toBe(
      '2026-08-30T10:00:00.000Z',
    )
  })

  it('roots a new correlation chain outside any context', () => {
    const a = buildEnvelope('product.updated', { productId: 'p1' })
    const b = buildEnvelope('product.updated', { productId: 'p1' })
    expect(a.correlationId).not.toBe(b.correlationId)
    expect(a.causationId).toBeNull()
  })

  it('inherits the ambient correlation so one chain spans many events', () => {
    // This is the property that makes correlationId worth storing: a webhook
    // and every write it causes share one id.
    withCorrelation({ correlationId: 'corr-1', causationId: 'cause-1' }, () => {
      const first = buildEnvelope('product.updated', { productId: 'p1' })
      const second = buildEnvelope('listing.updated', { listingId: 'l1' })
      expect(first.correlationId).toBe('corr-1')
      expect(second.correlationId).toBe('corr-1')
      expect(first.causationId).toBe('cause-1')
    })
  })
})

describe('publishEvent', () => {
  it('writes exactly one outbox row carrying the full envelope', async () => {
    const db = fakeDb()
    const envelope = await publishEvent(db.client, 'product.updated', { productId: 'p1' }, { accountId: 'acct-1' })

    expect(db.client.eventOutbox.create).toHaveBeenCalledTimes(1)
    expect(db.created).toHaveLength(1)
    const row = db.created[0]!
    expect(row.eventId).toBe(envelope.id)
    expect(row.type).toBe('product.updated')
    expect(row.subject).toBe('p1')
    expect(row.accountId).toBe('acct-1')
    expect(row.payload).toEqual({ productId: 'p1' })
    expect(row.occurredAt).toBeInstanceOf(Date)
  })

  it('denormalises the owning context onto the row', () => {
    // The relay routes without loading the catalogue, so the context has to
    // travel with the row.
    const db = fakeDb()
    return publishEvent(db.client, 'sync.oversell.clamped', {
      sku: 'SUIT-48', channel: 'EBAY', requested: 5, clampedTo: 2, available: 2,
    }).then(() => {
      expect(db.created[0]!.context).toBe('observability')
    })
  })

  it('does not write a row when the payload is invalid', async () => {
    const db = fakeDb()
    await expect(publishEvent(db.client, 'product.updated', {} as never)).rejects.toThrow(/Invalid payload/)
    expect(db.client.eventOutbox.create).not.toHaveBeenCalled()
  })

  it('writes a batch in one round trip, preserving order', async () => {
    const db = fakeDb()
    const envelopes = await publishEvents(db.client, [
      { type: 'product.updated', payload: { productId: 'p1' } },
      { type: 'product.updated', payload: { productId: 'p2' } },
    ])
    expect(db.client.eventOutbox.createMany).toHaveBeenCalledTimes(1)
    expect(envelopes.map((e) => e.subject)).toEqual(['p1', 'p2'])
    expect(db.created.map((r) => r.subject)).toEqual(['p1', 'p2'])
  })

  it('writes nothing for an empty batch', async () => {
    const db = fakeDb()
    expect(await publishEvents(db.client, [])).toEqual([])
    expect(db.client.eventOutbox.createMany).not.toHaveBeenCalled()
  })
})

/**
 * Amazon sheet gaps — `announceListingValues`, the live-sync hint of the sheet and the Matrix (design-sync §1.B):
 * published only after COMMIT (nothing after a rollback or a rolled-back savepoint; after the current tick outside a
 * transaction), one read, one event per family root, a payload the catalogue accepts, and it never throws.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseEventPayload } from '@nexus/events'

const m = vi.hoisted(() => ({ findMany: vi.fn(), publish: vi.fn(), warn: vi.fn() }))
vi.mock('../db.js', () => ({ default: { channelListing: { findMany: m.findMany } } }))
vi.mock('./listing-events.service.js', () => ({ publishListingEvent: m.publish }))
vi.mock('../utils/logger.js', () => ({ logger: { warn: m.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { announceListingValues } from './listing-values-events.js'
import { inDatabaseTransaction, inSavepoint } from '../lib/database-context.js'

/** Listing rows the read answers: variants of ROOT, one standalone product, and a parent's own listing. */
const ROWS: Record<string, { id: string; productId: string; version: number; product: { parentId: string | null } }> = {
  'l-it': { id: 'l-it', productId: 'child-1', version: 4, product: { parentId: 'root' } },
  'l-de': { id: 'l-de', productId: 'child-1', version: 6, product: { parentId: 'root' } },
  'l-c2': { id: 'l-c2', productId: 'child-2', version: 2, product: { parentId: 'root' } },
  'l-root': { id: 'l-root', productId: 'root', version: 9, product: { parentId: null } },
  'l-solo': { id: 'l-solo', productId: 'solo', version: 1, product: { parentId: null } },
}

/** A transaction client stand-in: the real `inDatabaseTransaction` runs its context, effects and savepoints over it. */
const tx = { $transaction: async (work: () => Promise<unknown>) => work() }
const client = { $transaction: async (work: (t: unknown) => Promise<unknown>) => work(tx) }

/** Let the after-commit effect's `setImmediate` and the read settle. */
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)) }
const published = () => m.publish.mock.calls.map(([event]) => event)

beforeEach(() => {
  vi.clearAllMocks()
  m.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ROWS[id]).filter(Boolean))
})

describe('announceListingValues', () => {
  it('outside a transaction: nothing in the calling tick, one event after it', async () => {
    announceListingValues(['l-it'], ['quantityMode', 'quantity'], 'matrix')
    expect(m.findMany).not.toHaveBeenCalled()
    expect(m.publish).not.toHaveBeenCalled()
    await settle()
    expect(published()).toEqual([{
      type: 'listing.values_changed', productId: 'root', listings: [{ listingId: 'l-it', productId: 'child-1', version: 4 }],
      fields: ['quantityMode', 'quantity'], reason: 'matrix', ts: expect.any(Number),
    }])
  })

  it('inside a transaction: waits for COMMIT, then reads the committed versions', async () => {
    await inDatabaseTransaction(client as never, async () => {
      announceListingValues(['l-it', 'l-de'], ['stockBuffer', 'quantity'])
      await settle()
      // Still inside the transaction: the write is not committed, so nothing is read and nothing is published.
      expect(m.findMany).not.toHaveBeenCalled()
      expect(m.publish).not.toHaveBeenCalled()
    })
    await settle()
    expect(published()).toHaveLength(1)
    expect(published()[0]).toMatchObject({ productId: 'root', fields: ['stockBuffer', 'quantity'], listings: [{ listingId: 'l-it', version: 4 }, { listingId: 'l-de', version: 6 }] })
    expect(published()[0]).not.toHaveProperty('reason')
  })

  it('a rolled-back transaction publishes nothing', async () => {
    await expect(inDatabaseTransaction(client as never, async () => {
      announceListingValues(['l-it'], ['quantity'])
      throw new Error('refused')
    })).rejects.toThrow('refused')
    await settle()
    expect(m.findMany).not.toHaveBeenCalled()
    expect(m.publish).not.toHaveBeenCalled()
  })

  it('a rolled-back savepoint drops its own rows; the rows of the savepoint that saved are announced', async () => {
    await inDatabaseTransaction(client as never, async () => {
      await inSavepoint(async () => { announceListingValues(['l-it'], ['quantity']) })
      await inSavepoint(async () => { announceListingValues(['l-solo'], ['quantity']); throw new Error('row refused') })
    })
    await settle()
    expect(published().map((e) => e.listings.map((l: { listingId: string }) => l.listingId))).toEqual([['l-it']])
  })

  it('groups by family root — one read, one event per family — and every payload passes the catalogue', async () => {
    announceListingValues(['l-it', 'l-de', 'l-c2', 'l-root', 'l-solo', 'l-it', ''], ['externalListingId'], 'asin-fill')
    await settle()
    expect(m.findMany).toHaveBeenCalledTimes(1)
    expect(m.findMany.mock.calls[0][0].where.id.in).toEqual(['l-it', 'l-de', 'l-c2', 'l-root', 'l-solo'])
    const events = published()
    expect(events.map((e) => [e.productId, e.listings.map((l: { listingId: string }) => l.listingId)])).toEqual([
      ['root', ['l-it', 'l-de', 'l-c2', 'l-root']],
      ['solo', ['l-solo']],
    ])
    for (const { type, ts, ...payload } of events) {
      expect(type).toBe('listing.values_changed')
      expect(typeof ts).toBe('number')
      expect(() => parseEventPayload('listing.values_changed', payload)).not.toThrow()
    }
  })

  it('calls in one transaction with the same fields share one read and one event per family', async () => {
    await inDatabaseTransaction(client as never, async () => {
      announceListingValues(['l-it'], ['quantityMode', 'quantity'])
      announceListingValues(['l-de', 'l-it'], ['quantity', 'quantityMode'])
    })
    await settle()
    expect(m.findMany).toHaveBeenCalledTimes(1)
    expect(published()).toHaveLength(1)
    expect(published()[0].listings.map((l: { listingId: string }) => l.listingId)).toEqual(['l-it', 'l-de'])
  })

  it('a family with more than 500 listings is announced in slices the catalogue accepts', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `big-${i}`)
    m.findMany.mockResolvedValueOnce(ids.map((id) => ({ id, productId: 'v', version: 1, product: { parentId: 'big-root' } })))
    announceListingValues(ids, ['offer'])
    await settle()
    expect(published().map((e) => e.listings.length)).toEqual([500, 1])
  })

  it('never throws: a failed read, a failed publish and empty input are logged or skipped', async () => {
    expect(() => announceListingValues([], ['quantity'])).not.toThrow()
    expect(() => announceListingValues(['l-it'], [])).not.toThrow()
    await settle()
    expect(m.findMany).not.toHaveBeenCalled()

    m.findMany.mockRejectedValueOnce(new Error('database gone'))
    expect(() => announceListingValues(['l-it'], ['quantity'])).not.toThrow()
    await settle()
    expect(m.publish).not.toHaveBeenCalled()
    expect(m.warn).toHaveBeenCalledWith('listing values: change not announced', expect.objectContaining({ error: 'database gone' }))

    m.publish.mockImplementationOnce(() => { throw new Error('no business profile') })
    expect(() => announceListingValues(['l-it', 'l-solo'], ['quantity'])).not.toThrow()
    await settle()
    // The failed family is logged; the next family is still published.
    expect(m.publish).toHaveBeenCalledTimes(2)
    expect(m.warn).toHaveBeenCalledWith('listing values: change not announced', expect.objectContaining({ productId: 'root', error: 'no business profile' }))
  })
})

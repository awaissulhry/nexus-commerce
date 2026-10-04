/**
 * Amazon sheet gaps — the follow / pin / buffer primitives announce `listing.values_changed` for the rows they WROTE
 * (FOLLOW, PIN → quantityMode + quantity; BUFFER → stockBuffer + quantity), never for a row skipped as FBA or left
 * unchanged, and inside a caller's transaction only after it commits (design-sync §1.B). Every caller — the Matrix, the
 * sheet, the listings screens, Sync Control, the stock import, the engine's pin expiry — writes through these two.
 *
 * The real announce helper and the real transaction context run; the database and the bus are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = {
  id: string; productId: string; channel: string; region: string; marketplace: string; channelConnectionId: string; aliasKey: string
  quantity: number | null; quantityOverride: number | null; followMasterQuantity: boolean; stockBuffer: number | null
  externalListingId: string | null; fulfillmentMethod: string | null; platformAttributes: null; product: { sku: string; fulfillmentMethod: string | null }
}

const m = vi.hoisted(() => {
  const s = { listings: [] as Row[], publish: vi.fn(), versions: {} as Record<string, number> }
  const db: Record<string, unknown> = {
    channelListing: {
      findMany: async ({ where, select }: { where: Record<string, any>; select?: Record<string, unknown> }) => {
        // The announce read (it alone selects `version`): the committed versions and the family root.
        if (select?.version) return s.listings.filter((l) => where.id.in.includes(l.id)).map((l) => ({ id: l.id, productId: l.productId, version: s.versions[l.id] ?? 1, product: { parentId: 'root' } }))
        // The primitive's resolve read.
        if (where.productId) return s.listings
        // The per-chunk fresh buffer read.
        return s.listings.filter((l) => where.id.in.includes(l.id)).map((l) => ({ id: l.id, stockBuffer: l.stockBuffer }))
      },
      update: async () => ({}),
    },
    stockLevel: { findMany: async () => [] }, // FBA evidence: no FBA stock anywhere
  }
  db.$transaction = async (work: (tx: unknown) => Promise<unknown>) => work(db)
  return Object.assign(s, { db })
})

vi.mock('../db.js', async () => {
  const { contextualDatabase } = await vi.importActual<typeof import('../lib/database-context.js')>('../lib/database-context.js')
  return { default: contextualDatabase(m.db as never) }
})
vi.mock('./listing-events.service.js', () => ({ publishListingEvent: m.publish }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: {}, addJobSafely: async () => undefined }))
vi.mock('./sync-coalesce.js', () => ({ coalescePendingQuantityRows: async () => 0 }))
vi.mock('./outbound-rows.js', () => ({ createOutboundRowsAndReturn: async (_tx: unknown, { data }: { data: Array<{ channelListingId: string }> }) => data.map((d, i) => ({ id: `q${i}`, channelListingId: d.channelListingId })) }))
vi.mock('./stock-pool/sync-ledgers.js', () => ({ sellableAvailable: async (_tx: unknown, ids: Iterable<string>) => new Map([...ids].map((id) => [id, 10])) }))
vi.mock('./outbound-sync.service.js', () => ({ isFbaListing: (l: { fulfillmentMethod: string | null }) => l.fulfillmentMethod === 'FBA' }))

import { setFollowMasterQuantity, setStockBuffer } from './follow-master.service.js'
import { inDatabaseTransaction } from '../lib/database-context.js'

const row = (id: string, over: Partial<Row> = {}): Row => ({
  id, productId: `p-${id}`, channel: 'AMAZON', region: 'EU', marketplace: 'IT', channelConnectionId: 'acc', aliasKey: '',
  quantity: 10, quantityOverride: null, followMasterQuantity: true, stockBuffer: 0, externalListingId: null,
  fulfillmentMethod: 'FBM', platformAttributes: null, product: { sku: `SKU-${id}`, fulfillmentMethod: 'FBM' }, ...over,
})

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)) }
const announced = () => m.publish.mock.calls.map(([e]) => ({ fields: e.fields, ids: e.listings.map((l: { listingId: string }) => l.listingId) }))
const opts = { productIds: ['p-a', 'p-b', 'p-c'], channel: 'AMAZON' as const, markets: 'ALL' as const, actor: 'tester' }

beforeEach(() => {
  m.publish.mockReset()
  m.versions = {}
  // a: pinned at 5 (FOLLOW writes it); b: already following the pool of 10 (FOLLOW leaves it); c: FBA (always skipped).
  m.listings = [row('a', { quantity: 5, quantityOverride: 5, followMasterQuantity: false }), row('b'), row('c', { fulfillmentMethod: 'FBA' })]
})

describe('follow / pin / buffer announce only the rows they wrote', () => {
  it('FOLLOW: the written row only — not the unchanged one, not the FBA one', async () => {
    const r = await setFollowMasterQuantity({ ...opts, follow: true })
    expect(r.results.map((x) => [x.listingId, x.action])).toEqual([['c', 'SKIPPED_FBA'], ['a', 'FOLLOW'], ['b', 'UNCHANGED']])
    await settle()
    expect(announced()).toEqual([{ fields: ['quantityMode', 'quantity'], ids: ['a'] }])
  })

  it('PIN: the rows it pinned', async () => {
    await setFollowMasterQuantity({ ...opts, follow: false })
    await settle()
    // a is pinned at 5 already (no change); b pins its 10.
    expect(announced()).toEqual([{ fields: ['quantityMode', 'quantity'], ids: ['b'] }])
  })

  it('BUFFER: the rows whose buffer moved, with stockBuffer + quantity', async () => {
    await setStockBuffer({ ...opts, buffer: 2 })
    await settle()
    expect(announced()).toEqual([{ fields: ['stockBuffer', 'quantity'], ids: ['a', 'b'] }])
  })

  it('nothing written → nothing announced', async () => {
    m.listings = [row('b'), row('c', { fulfillmentMethod: 'FBA' })]
    await setFollowMasterQuantity({ ...opts, follow: true })
    await setStockBuffer({ ...opts, buffer: 0 })
    await settle()
    expect(m.publish).not.toHaveBeenCalled()
  })

  it("inside a caller's transaction the hint waits for its commit, and carries the committed version", async () => {
    await inDatabaseTransaction(m.db as never, async () => {
      await setFollowMasterQuantity({ ...opts, follow: true })
      await settle()
      expect(m.publish).not.toHaveBeenCalled()
      m.versions.a = 8 // the caller's own CAS bump, committed with the write
    })
    await settle()
    expect(m.publish).toHaveBeenCalledTimes(1)
    expect(m.publish.mock.calls[0][0]).toMatchObject({ type: 'listing.values_changed', productId: 'root', listings: [{ listingId: 'a', productId: 'p-a', version: 8 }] })
  })

  it("a caller's transaction that rolls back announces nothing", async () => {
    await expect(inDatabaseTransaction(m.db as never, async () => {
      await setStockBuffer({ ...opts, buffer: 3 })
      throw new Error('a later row was refused')
    })).rejects.toThrow('refused')
    await settle()
    expect(m.publish).not.toHaveBeenCalled()
  })
})

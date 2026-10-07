/**
 * Shared stock — the send-time limit ("never send more than the stock holds") must read the product's
 * ledger. For a product that sells from another business's pool, its own shelves say nothing: here the
 * business holds 50 units of its own, the pool it sells from holds 3, and the listing asks for 9. The
 * limit must cap it to the pool's 3 — the old limit, which summed this business's own warehouses,
 * would have let 9 through.
 *
 * The harness is outbound-sync.ebay-pause-gate.vitest.test.ts's: the database is faked; the pool door
 * (nexus_pool_available) answers through `$queryRaw`. The push then stops at the publish-mode gate, so
 * nothing reaches eBay; the clamped quantity is read off the queue item, which the lane updates in place.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), pooled: true }))
vi.mock('../db.js', () => ({
  default: {
    channelListing: { findUnique: (...a: unknown[]) => mocks.findUnique(...a) },
    stockLevel: {
      findMany: async () => [{ productId: 'p1', available: 50, quantity: 50, location: { type: 'WAREHOUSE', code: 'OWN-MAIN', syncRoutes: [] } }],
      aggregate: vi.fn().mockResolvedValue(null),
    },
    stockPoolLink: { findMany: async () => (mocks.pooled ? [{ productId: 'p1' }] : []) },
    // Step 2 — the loader reads the business's "Sells from" lists (none here).
    syncChannelPolicy: { findMany: async () => [] },
    // Door 1 — the pool the product sells from: one lent warehouse, 3 available.
    $queryRaw: async () => (mocks.pooled
      ? [{ product_id: 'p1', grant_id: 'g1', owner_workspace_id: 'lender', location_id: 'l1', location_code: 'IT-MAIN', quantity: 4, reserved: 1, available: 3 }]
      : []),
    offer: { findFirst: vi.fn().mockResolvedValue(null) },
    product: { findUniqueOrThrow: vi.fn() },
  },
}))
vi.mock('../lib/queue.js', () => ({ addJobSafely: async () => null, outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('./sync-control-policy.service.js', () => ({ loadChannelPolicies: async () => new Map(), policyFor: () => null }))

import { OutboundSyncService } from './outbound-sync.service.js'

const service = new OutboundSyncService() as unknown as { syncToEbay: (q: unknown) => Promise<{ status: string }> }
const item = () => ({ id: 'q1', channelListingId: 'l1', product: { id: 'p1', sku: 'SKU-1' }, payload: { quantity: 9, marketplaceId: 'EBAY_IT' } })

describe('Shared stock — the eBay send-time limit reads the pool', () => {
  beforeEach(() => {
    delete process.env.NEXUS_ENABLE_EBAY_PUBLISH
    process.env.NEXUS_SYNC_ORDERING_V2 = '1'
    mocks.findUnique.mockResolvedValue({ stockBuffer: 0, fulfillmentMethod: 'FBM', quantity: 9, marketplace: 'IT', syncPaused: false })
  })

  it('a pooled product is capped to the pool (3), not to this business\'s own 50', async () => {
    mocks.pooled = true
    const queued = item()
    await service.syncToEbay(queued)
    expect(queued.payload.quantity).toBe(3)
  })

  it('positive control: the same product with its own stock keeps the old limit (50 lets 9 through)', async () => {
    mocks.pooled = false
    const queued = item()
    await service.syncToEbay(queued)
    expect(queued.payload.quantity).toBe(9)
  })
})

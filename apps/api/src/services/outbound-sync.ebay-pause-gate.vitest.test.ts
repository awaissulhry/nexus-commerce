/**
 * MX.1 / Add 4(c) — CHARACTERISATION: the eBay pause gates hold for a CONTENT push, not only a quantity push.
 *
 * Report 28 §5.2 measured the defect by reading: `syncPaused` / `pushesPaused` sat inside
 * `if (payload.quantity !== undefined …)` in `syncToEbay`, so a content FULL_SYNC on a paused listing passed both
 * gates. The arm that would have failed was the one never run. Both arms run here, with prisma and the policy loader
 * mocked so the test reaches no database and no queue:
 *
 *   negative: paused listing + content-only payload → SKIPPED `sync-paused`, nothing else consulted;
 *   positive control: the SAME payload on an UNPAUSED listing passes the gates and reaches the publish-mode gate
 *   (`gated` in this environment — the message names NEXUS_ENABLE_EBAY_PUBLISH), proving the instrument was pointed
 *   at the right thing;
 *   and the quantity arm still holds (the behaviour that existed before), plus the policy lever on a content push.
 *
 * Also pinned here (D-MX4, dry-run ONLY — the builder is pure and no HTTP exists in this test): `buildAmazonListingPatch`
 * emits the sale as `discounted_price` INSIDE the same `purchasable_offer` instance as `our_price`, in the cached
 * Listings-Items schema shape, and emits none without both dates.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  stockFindMany: vi.fn(),
  policies: vi.fn(),
}))
vi.mock('../db.js', () => ({
  default: {
    channelListing: { findUnique: (...a: unknown[]) => mocks.findUnique(...a) },
    stockLevel: { findMany: (...a: unknown[]) => mocks.stockFindMany(...a), aggregate: vi.fn().mockResolvedValue(null) },
    offer: { findFirst: vi.fn().mockResolvedValue(null) },
    product: { findUniqueOrThrow: vi.fn() },
  },
}))
vi.mock('../lib/queue.js', () => ({ addJobSafely: async () => null, outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('./sync-control-policy.service.js', () => ({ loadChannelPolicies: (...a: unknown[]) => mocks.policies(...a), policyFor: (map: Map<string, { pushesPaused: boolean }>, ch: string, mk: string) => map.get(`${ch}:${mk}`) ?? null }))

import { OutboundSyncService, buildAmazonListingPatch } from './outbound-sync.service.js'

const service = new OutboundSyncService() as unknown as { syncToEbay: (q: unknown) => Promise<{ status: string; error?: string; message?: string }> }
const contentOnly = (listing: string) => ({ id: 'q1', channelListingId: listing, product: { id: 'p1', sku: 'SKU-1' }, payload: { title: 'A new title', description: 'copy', marketplaceId: 'EBAY_IT' } })

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.NEXUS_ENABLE_EBAY_PUBLISH
  mocks.policies.mockResolvedValue(new Map())
  mocks.stockFindMany.mockResolvedValue([{ available: 5 }])
})

describe('Add 4(c) — the eBay pause gates hold for a content push', () => {
  it('a PAUSED listing receives NO content push (the defect: this arm used to pass)', async () => {
    mocks.findUnique.mockResolvedValue({ stockBuffer: 0, fulfillmentMethod: 'FBM', quantity: 5, marketplace: 'IT', syncPaused: true })
    const r = await service.syncToEbay(contentOnly('l-paused'))
    expect(r).toMatchObject({ status: 'SKIPPED', errorCode: 'PUSH_SYNC_PAUSED' })
    expect(mocks.stockFindMany).not.toHaveBeenCalled() // the quantity branch was never entered — there is no quantity
  })
  it('positive control: the same content push on an UNPAUSED listing passes the gates and reaches the publish-mode gate', async () => {
    mocks.findUnique.mockResolvedValue({ stockBuffer: 0, fulfillmentMethod: 'FBM', quantity: 5, marketplace: 'IT', syncPaused: false })
    const r = await service.syncToEbay(contentOnly('l-live'))
    expect(r.status).toBe('FAILED')
    expect(r.error).toContain('NEXUS_ENABLE_EBAY_PUBLISH')
    expect(mocks.policies).toHaveBeenCalledTimes(1)
  })
  it('the channel-market POLICY lever holds a content push too', async () => {
    mocks.findUnique.mockResolvedValue({ stockBuffer: 0, fulfillmentMethod: 'FBM', quantity: 5, marketplace: 'IT', syncPaused: false })
    mocks.policies.mockResolvedValue(new Map([['EBAY:IT', { pushesPaused: true }]]))
    const r = await service.syncToEbay(contentOnly('l-policy'))
    expect(r).toMatchObject({ status: 'SKIPPED', error: 'sync-paused-policy' })
  })
  it('the quantity arm behaves as before: paused → skipped, unpaused → the pool cap still runs', async () => {
    mocks.findUnique.mockResolvedValue({ stockBuffer: 0, fulfillmentMethod: 'FBM', quantity: 5, marketplace: 'IT', syncPaused: true })
    expect(await service.syncToEbay({ ...contentOnly('l-paused'), payload: { quantity: 9, marketplaceId: 'EBAY_IT' } })).toMatchObject({ status: 'SKIPPED', errorCode: 'PUSH_SYNC_PAUSED' })
    mocks.findUnique.mockResolvedValue({ stockBuffer: 0, fulfillmentMethod: 'FBM', quantity: 5, marketplace: 'IT', syncPaused: false })
    const r = await service.syncToEbay({ ...contentOnly('l-live'), payload: { quantity: 9, marketplaceId: 'EBAY_IT' } })
    expect(r.status).toBe('FAILED'); expect(mocks.stockFindMany).toHaveBeenCalledTimes(1)
  })
})

describe('D-MX4 — the sale rides the same purchasable_offer instance (dry-run payload only)', () => {
  it('emits discounted_price beside our_price in ONE instance, in the cached schema shape', async () => {
    const body = await buildAmazonListingPatch({ price: 105, salePrice: 89, salePriceStart: '2026-09-12', salePriceEnd: '2026-09-30' } as never, 'IT', 'OUTERWEAR', 'FBA')
    const po = body.patches.find((p: { path: string }) => p.path === '/attributes/purchasable_offer')
    expect(po.op).toBe('replace')
    expect(po.value).toHaveLength(1)
    expect(po.value[0]).toEqual({
      currency: 'EUR', marketplace_id: 'APJ6JRA9NG5V4',
      our_price: [{ schedule: [{ value_with_tax: 105 }] }],
      discounted_price: [{ schedule: [{ start_at: '2026-09-12', end_at: '2026-09-30', value_with_tax: 89 }] }],
    })
    /* the FBA guard is untouched by the sale: no merchant quantity rides this patch */
    expect(body.patches.some((p: { path: string }) => p.path === '/attributes/fulfillment_availability')).toBe(false)
  })
  it('emits NO sale without both dates, and a price-only payload is byte-identical to before', async () => {
    const half = await buildAmazonListingPatch({ price: 105, salePrice: 89, salePriceStart: '2026-09-12' } as never, 'IT', 'OUTERWEAR')
    expect(half.patches[0].value[0]).toEqual({ currency: 'EUR', marketplace_id: 'APJ6JRA9NG5V4', our_price: [{ schedule: [{ value_with_tax: 105 }] }] })
    const plain = await buildAmazonListingPatch({ price: 19.99 }, 'IT', 'OUTERWEAR')
    expect(plain.patches[0].value[0]).toEqual({ currency: 'EUR', marketplace_id: 'APJ6JRA9NG5V4', our_price: [{ schedule: [{ value_with_tax: 19.99 }] }] })
  })
})

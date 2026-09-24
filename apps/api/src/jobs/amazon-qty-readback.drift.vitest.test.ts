import { beforeEach, expect, it, vi } from 'vitest'

/**
 * A-36 (Step 3.5a) — the Amazon read-back job, end to end with its outside calls faked:
 *   · its differences reach ChannelDrift, per listing, through the one writer;
 *   · the health-log dedupe is per product AND market — the fake log REMEMBERS what was logged, so the old per-product
 *     dedupe would swallow the second market's conflict (measured: the comment always said "per product+marketplace").
 */
const m = vi.hoisted(() => ({ listings: vi.fn(), logged: [] as Array<{ productId: string; conflictType: string; remote: any }>, record: vi.fn(), catalog: vi.fn() }))
vi.mock('../db.js', () => ({ default: {
  channelListing: { findMany: m.listings },
  syncHealthLog: {
    findFirst: vi.fn(async ({ where }: any) => m.logged.find(l => l.productId === where.productId && l.conflictType === where.conflictType
      && (!where.conflictData || l.remote?.[where.conflictData.path[1]] === where.conflictData.equals)) ?? null),
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  cronRun: { findFirst: vi.fn(async () => null) },
} }))
vi.mock('../services/sync-health.service.js', () => ({ syncHealthService: { logConflict: vi.fn(async (c: any) => { m.logged.push({ productId: c.productId, conflictType: c.conflictType, remote: c.remoteData }) }) } }))
vi.mock('../services/outbound-rows.js', () => ({ createOutboundRow: vi.fn(async () => ({})) }))
vi.mock('../services/channel-drift.service.js', () => ({ recordChannelReadback: m.record }))
vi.mock('../services/marketplaces/amazon.service.js', () => ({ AmazonService: class { fetchActiveCatalog = m.catalog } }))
vi.mock('../lib/cron/clustered.js', () => ({ default: { schedule: vi.fn() } }))

beforeEach(() => {
  vi.clearAllMocks(); m.logged.length = 0
  process.env.NEXUS_QTY_READBACK_MARKETS = 'IT,DE'
  process.env.NEXUS_QTY_READBACK_HEAL_MAX = '0'
  // The same product sells in two markets; its quantity differs in BOTH.
  m.catalog.mockImplementation(async () => [{ sku: 'SKU-1', quantity: 0, price: 20 }])
  m.listings.mockImplementation(async ({ where }: any) => [{ id: `listing-${where.marketplace}`, quantity: 4, price: 20, productId: 'p1', product: { sku: 'SKU-1' } }])
})

it('🔴 each market\'s quantity conflict is logged — the dedupe is per product AND market', async () => {
  const { runAmazonQtyReadback } = await import('./amazon-qty-readback.job.js')
  await runAmazonQtyReadback()
  expect(m.logged.filter(l => l.conflictType === 'CHANNEL_QTY_READBACK').map(l => l.remote.marketplace).sort()).toEqual(['DE', 'IT'])
})

it('🔴 each compared listing is recorded in ChannelDrift through the one writer, with our value and Amazon\'s', async () => {
  const { runAmazonQtyReadback } = await import('./amazon-qty-readback.job.js')
  const summary = await runAmazonQtyReadback()
  expect(m.record.mock.calls.map(c => c[0])).toEqual(['IT', 'DE'].map(mp => ({ channelListingId: `listing-${mp}`, channel: 'AMAZON', marketplace: mp,
    source: 'amazon-merchant-listings-report', compared: ['quantity', 'price'], differing: [{ field: 'quantity', ours: 4, theirs: 0 }] })))
  expect(summary).toContain('drift: recorded=2')
})

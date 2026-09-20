// apps/api/src/services/outbound-sync.shared-trading.vitest.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock prisma BEFORE importing the service.
vi.mock('../db.js', () => {
  const connection = { id: 'conn1' }
  return {
    default: {
      channelConnection: { findFirst: vi.fn(async () => connection) },
      sharedListingMembership: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        // Dispatch re-check (NEXUS_SYNC_ORDERING_V2): the variants' controls at send time.
        findMany: vi.fn(async () => []),
        // RT.2 debounce read — default: never pushed, no debounce
        aggregate: vi.fn(async () => ({ _max: { lastPushedAt: null } })),
        // P0.7 — the wrong-account guard reads listing ownership; no recorded owner = the pre-P0.7 behaviour this file models.
        findMany: vi.fn(async () => []),
      },
      outboundSyncQueue: { update: vi.fn(async () => ({})), findUnique: vi.fn(), findMany: vi.fn() },
      stockLevel: { findMany: vi.fn(async () => []) },
      channelListing: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
      syncChannelPolicy: { findMany: vi.fn(async () => []) },
    },
  }
})
// MAP.3 — the code under test now resolves its account through the resolver, so
// the mock moves to that seam. Mocking `channelConnection.findFirst` pinned the
// OLD query shape: the resolver reads the account set with findMany, so a
// findFirst-only stub made the code correctly take its no-connection branch and
// the test failed for a reason that had nothing to do with what it asserts.
vi.mock('./connection-resolver.service.js', () => ({
  resolveConnection: vi.fn(async () => ({ id: 'conn1' })),
  tryResolveConnection: vi.fn(async () => ({ id: 'conn1' })),
  listActiveConnections: vi.fn(async () => [{ id: 'conn1' }]),
}))

// Force the eBay publish mode to "live" and stub auth + rate/circuit so we reach the call.
vi.mock('./ebay-auth.service.js', () => ({
  ebayAuthService: { getValidToken: vi.fn(async () => 'TOKEN-XYZ') },
}))
// Stub the publish gate so circuit/rate-limit always pass
vi.mock('./ebay-publish-gate.service.js', () => ({
  getEbayPublishMode: vi.fn(() => 'live'),
  getEbayApiBaseForMode: vi.fn(() => 'https://api.ebay.com'),
  isEbayPublishEnabled: vi.fn(() => true),
  checkEbayCircuit: vi.fn(() => ({ ok: true })),
  acquireEbayPublishToken: vi.fn(async () => ({ ok: true })),
  recordEbayOutcome: vi.fn(),
}))
// Stub audit log (fire-and-forget; we don't need it to write a real DB row)
vi.mock('./channel-publish-audit.service.js', () => ({
  digestPayload: vi.fn(() => 'digest-abc'),
  writeAttemptLog: vi.fn(),
}))

// The product's ledger at send time (shared stock: its own warehouses or the pool) — 5 available.
vi.mock('./stock-pool/sync-ledgers.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./stock-pool/sync-ledgers.js')>()
  const { syncLedgerOf } = await import('./sync-control-core.js')
  return {
    ...real,
    loadSyncLedgers: vi.fn(async (_db: unknown, ids: Iterable<string>) => new Map([...ids].map((id) => [id, {
      productId: id, source: { kind: 'own' }, ledger: syncLedgerOf([{ locationCode: 'IT-MAIN', available: 5, syncRoutes: [] }]),
      quantity: 5, available: 5, uncountedIsZero: false, fbaQuantity: 0,
    }]))),
  }
})

import prisma from '../db.js'
import { OutboundSyncService, __ebayTrading } from './outbound-sync.service.js'

describe('syncToEbay TRADING branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXUS_ENABLE_EBAY_PUBLISH = 'true'
    process.env.EBAY_PUBLISH_MODE = 'live'
    process.env.NEXUS_SYNC_ORDERING_V2 = '0' // mechanics tests use enqueue-time qty
  })

  const queueItem = {
    id: 'q1',
    channelConnectionId: 'conn1', // P1.3 — every row names its account
    externalListingId: '110556677',
    product: { id: 'p1', sku: 'PARENT' },
    payload: {
      pushVia: 'TRADING', sku: 'LNR-M', itemId: '110556677',
      market: 'IT', marketplaceId: 'EBAY_IT', quantity: 7,
    },
  }

  it('calls reviseInventoryStatusBatch (RT.2) with the normalized legacy payload and reports SUCCESS', async () => {
    const spy = vi.spyOn(__ebayTrading, 'reviseInventoryStatusBatch').mockResolvedValue(undefined)
    const svc = new OutboundSyncService()
    const res = await (svc as any).syncToEbay(queueItem)
    expect(spy).toHaveBeenCalledWith(
      { itemId: '110556677', entries: [{ sku: 'LNR-M', quantity: 7 }] },
      { oauthToken: 'TOKEN-XYZ', market: 'IT', connectionId: 'conn1' },
    )
    expect(res.success).toBe(true)
    expect(res.channel).toBe('EBAY')
    // membership writeback (lastQtyPushed/lastPushedAt, lastError cleared)
    expect((prisma as any).sharedListingMembership.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { marketplace: 'IT', itemId: '110556677', sku: 'LNR-M' },
        data: expect.objectContaining({ lastQtyPushed: 7, lastError: null }),
      }),
    )
  })

  it('does NOT touch the Inventory-API path (no fetch) for TRADING rows', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any)
    vi.spyOn(__ebayTrading, 'reviseInventoryStatusBatch').mockResolvedValue(undefined)
    const svc = new OutboundSyncService()
    await (svc as any).syncToEbay(queueItem)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reports FAILED + records lastError when reviseInventoryStatus throws', async () => {
    vi.spyOn(__ebayTrading, 'reviseInventoryStatusBatch').mockRejectedValue(new Error('eBay ReviseInventoryStatus Failure: Item not found'))
    const svc = new OutboundSyncService()
    const res = await (svc as any).syncToEbay(queueItem)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Item not found/)
    expect((prisma as any).sharedListingMembership.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastError: expect.stringMatching(/Item not found/) }) }),
    )
  })

  it('is a dry-run no-op (no call) when EBAY_PUBLISH_MODE is not live', async () => {
    const { getEbayPublishMode } = await import('./ebay-publish-gate.service.js')
    vi.mocked(getEbayPublishMode).mockReturnValue('dry-run')
    const spy = vi.spyOn(__ebayTrading, 'reviseInventoryStatusBatch').mockResolvedValue(undefined)
    const svc = new OutboundSyncService()
    const res = await (svc as any).syncToEbay(queueItem)
    expect(spy).not.toHaveBeenCalled()
    expect(res.success).toBe(true) // dry-run reports success-but-dryRun
    expect(res.dryRun).toBe(true)
  })
})

// Shared stock plan step 3 — the send step re-checks each variant's controls (NEXUS_SYNC_ORDERING_V2 on).
describe('syncToEbay TRADING — dispatch re-check of a fixed shared variant', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXUS_ENABLE_EBAY_PUBLISH = 'true'
    process.env.EBAY_PUBLISH_MODE = 'live'
    delete process.env.NEXUS_SYNC_ORDERING_V2
  })
  const row = (updates: Array<{ sku: string; quantity: number }>) => ({
    id: 'q2', externalListingId: '110556677', product: { id: 'p1', sku: 'PARENT' },
    payload: { pushVia: 'TRADING', itemId: '110556677', market: 'IT', marketplaceId: 'EBAY_IT', productId: 'p1', updates },
  })
  const members = (list: Array<Record<string, unknown>>) => vi.mocked((prisma as any).sharedListingMembership.findMany).mockResolvedValue(list as never)

  it('sends a fixed variant its number and a following variant the pool, whatever the queued numbers said', async () => {
    const { getEbayPublishMode } = await import('./ebay-publish-gate.service.js')
    vi.mocked(getEbayPublishMode).mockReturnValue('live')
    members([
      { sku: 'FIXED', lastQtyPushed: 9, followPool: true, stockBuffer: 0, pinnedQuantity: 2 },
      { sku: 'FOLLOWS', lastQtyPushed: 9, followPool: true, stockBuffer: 1, pinnedQuantity: null },
    ])
    const spy = vi.spyOn(__ebayTrading, 'reviseInventoryStatusBatch').mockResolvedValue(undefined)
    const res = await (new OutboundSyncService() as any).syncToEbay(row([{ sku: 'FIXED', quantity: 9 }, { sku: 'FOLLOWS', quantity: 9 }]))
    expect(res.success).toBe(true)
    expect(spy).toHaveBeenCalledWith(
      { itemId: '110556677', entries: [{ sku: 'FIXED', quantity: 2 }, { sku: 'FOLLOWS', quantity: 4 }] }, // 5 − buffer 1
      expect.anything(),
    )
  })

  it('spends no revise when the fixed variant already shows its number; an Excluded variant is never sent', async () => {
    members([
      { sku: 'FIXED', lastQtyPushed: 2, followPool: true, stockBuffer: 0, pinnedQuantity: 2 },
      { sku: 'EXCLUDED', lastQtyPushed: 0, followPool: false, stockBuffer: 0, pinnedQuantity: 3 },
    ])
    const spy = vi.spyOn(__ebayTrading, 'reviseInventoryStatusBatch').mockResolvedValue(undefined)
    const res = await (new OutboundSyncService() as any).syncToEbay(row([{ sku: 'FIXED', quantity: 7 }, { sku: 'EXCLUDED', quantity: 7 }]))
    expect(spy).not.toHaveBeenCalled()
    expect(res).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(res.message).toMatch(/no revise spent/)
  })
})

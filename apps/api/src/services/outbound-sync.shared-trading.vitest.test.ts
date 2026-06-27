// apps/api/src/services/outbound-sync.shared-trading.vitest.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock prisma BEFORE importing the service.
vi.mock('../db.js', () => {
  const connection = { id: 'conn1' }
  return {
    default: {
      channelConnection: { findFirst: vi.fn(async () => connection) },
      sharedListingMembership: { updateMany: vi.fn(async () => ({ count: 1 })) },
      outboundSyncQueue: { update: vi.fn(async () => ({})), findUnique: vi.fn(), findMany: vi.fn() },
      stockLevel: { findMany: vi.fn(async () => []) },
      channelListing: { findUnique: vi.fn(async () => null) },
    },
  }
})
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

import prisma from '../db.js'
import { OutboundSyncService, __ebayTrading } from './outbound-sync.service.js'

describe('syncToEbay TRADING branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXUS_ENABLE_EBAY_PUBLISH = 'true'
    process.env.EBAY_PUBLISH_MODE = 'live'
  })

  const queueItem = {
    id: 'q1',
    externalListingId: '110556677',
    product: { id: 'p1', sku: 'PARENT' },
    payload: {
      pushVia: 'TRADING', sku: 'LNR-M', itemId: '110556677',
      market: 'IT', marketplaceId: 'EBAY_IT', quantity: 7,
    },
  }

  it('calls reviseInventoryStatus with itemId/sku/quantity + market and reports SUCCESS', async () => {
    const spy = vi.spyOn(__ebayTrading, 'reviseInventoryStatus').mockResolvedValue(undefined)
    const svc = new OutboundSyncService()
    const res = await (svc as any).syncToEbay(queueItem)
    expect(spy).toHaveBeenCalledWith(
      { itemId: '110556677', sku: 'LNR-M', quantity: 7 },
      { oauthToken: 'TOKEN-XYZ', market: 'IT' },
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
    vi.spyOn(__ebayTrading, 'reviseInventoryStatus').mockResolvedValue(undefined)
    const svc = new OutboundSyncService()
    await (svc as any).syncToEbay(queueItem)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reports FAILED + records lastError when reviseInventoryStatus throws', async () => {
    vi.spyOn(__ebayTrading, 'reviseInventoryStatus').mockRejectedValue(new Error('eBay ReviseInventoryStatus Failure: Item not found'))
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
    const spy = vi.spyOn(__ebayTrading, 'reviseInventoryStatus').mockResolvedValue(undefined)
    const svc = new OutboundSyncService()
    const res = await (svc as any).syncToEbay(queueItem)
    expect(spy).not.toHaveBeenCalled()
    expect(res.success).toBe(true) // dry-run reports success-but-dryRun
    expect(res.dryRun).toBe(true)
  })
})

/**
 * P0.7 — the outbound queue: a row for a listing of the second eBay account is refused
 * (FAILED, WRONG_ACCOUNT_WRITE, not retryable) before any call to eBay; the same row for a listing of
 * the account in use goes on. The eBay publish mode is `live` here so the refusal is the only gate
 * that can stop it; `fetch` is a spy that counts every outgoing call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ owner: 'conn-B' as string | null, fetches: 0 }))
vi.mock('../db.js', () => ({
  default: {
    channelListing: {
      findUnique: vi.fn(async () => ({ stockBuffer: 0, fulfillmentMethod: 'FBM', quantity: 5, marketplace: 'IT', syncPaused: false })),
      findMany: vi.fn(async ({ where }: any) => (where?.OR?.some((w: any) => w.id?.in?.includes('listing-1')) && h.owner ? [{ channelConnectionId: h.owner }] : [])),
    },
    sharedListingMembership: { findMany: vi.fn(async () => []) },
    channelConnection: { findMany: vi.fn(async () => [{ id: 'conn-A', displayName: 'Primary shop', externalAccountId: 'a' }, { id: 'conn-B', displayName: 'Second shop', externalAccountId: 'b' }]) },
    stockLevel: { findMany: vi.fn(async () => [{ available: 5 }]), aggregate: vi.fn(async () => null) },
    offer: { findFirst: vi.fn(async () => null) },
    product: { findUniqueOrThrow: vi.fn() },
    outboundApiCallLog: { create: vi.fn(async () => ({})) },
    channelPublishAttempt: { create: vi.fn(async () => ({})) },
  },
}))
vi.mock('../lib/queue.js', () => ({ addJobSafely: async () => null, outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('./sync-control-policy.service.js', () => ({ loadChannelPolicies: async () => new Map(), policyFor: () => null }))
vi.mock('./connection-resolver.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./connection-resolver.service.js')>()),
  tryResolveConnection: vi.fn(async () => ({ id: 'conn-A', channelType: 'EBAY', isPrimary: true })),
}))
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: vi.fn(async () => 'token-A') } }))

import { OutboundSyncService } from './outbound-sync.service.js'

const service = new OutboundSyncService() as unknown as { syncToEbay: (q: unknown) => Promise<{ status: string; error?: string; errorCode?: string; retryable?: boolean }> }
const row = { id: 'q1', channelListingId: 'listing-1', product: { id: 'p1', sku: 'SKU-1' }, payload: { quantity: 3, marketplaceId: 'EBAY_IT' } }

beforeEach(() => {
  vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH', 'true')
  vi.stubEnv('EBAY_PUBLISH_MODE', 'live')
  h.fetches = 0
  vi.stubGlobal('fetch', vi.fn(async () => { h.fetches++; return new Response('{}', { status: 500 }) }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('P0.7 — the eBay queue refuses a row for another account', () => {
  it('a listing of the second account: FAILED, WRONG_ACCOUNT_WRITE, not retryable, 0 calls to eBay', async () => {
    h.owner = 'conn-B'
    const r = await service.syncToEbay(row)
    expect(r).toMatchObject({ status: 'FAILED', errorCode: 'WRONG_ACCOUNT_WRITE', retryable: false })
    expect(r.error).toMatch(/Nothing was sent to eBay: .*"Second shop".*"Primary shop"/)
    expect(h.fetches).toBe(0)
  })
  it('positive control: the same row for a listing of the account in use gets past the guard and reaches eBay', async () => {
    h.owner = 'conn-A'
    const r = await service.syncToEbay(row)
    expect(r.errorCode).not.toBe('WRONG_ACCOUNT_WRITE')
    expect(h.fetches).toBeGreaterThan(0)
  })
})

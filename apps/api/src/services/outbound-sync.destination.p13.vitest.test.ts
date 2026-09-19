/**
 * P1.3 (was P0.7) — the eBay queue sends each row through ITS OWN account. Before P1.3 every row went
 * to the primary account and P0.7 refused a second-account row; now the second account's row reaches
 * eBay with the second account's token. A row that names no account and whose product two accounts
 * hold is refused, 0 calls. The ownership check stays as a consistency check. The eBay publish mode is
 * `live`; `fetch` records every outgoing call and its token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ owner: 'conn-B' as string | null, sends: [] as string[] }))
vi.mock('../db.js', () => ({
  default: {
    channelListing: {
      findUnique: vi.fn(async () => ({ stockBuffer: 0, fulfillmentMethod: 'FBM', quantity: 5, marketplace: 'IT', syncPaused: false })),
      findMany: vi.fn(async ({ where }: any) => {
        // the destination rule: the listing's own account
        if (where?.id?.in) return where.id.in.includes('listing-1') && h.owner ? [{ id: 'listing-1', channelConnectionId: h.owner }] : []
        // the destination rule for a product-only row: two accounts hold P2 in IT
        if (where?.productId?.in) return where.productId.in.includes('p2') ? [{ productId: 'p2', channel: 'EBAY', marketplace: 'IT', region: 'IT', channelConnectionId: 'conn-A' }, { productId: 'p2', channel: 'EBAY', marketplace: 'IT', region: 'IT', channelConnectionId: 'conn-B' }] : []
        // the ownership check
        return where?.OR?.some((w: any) => w.id?.in?.includes('listing-1')) && h.owner ? [{ channelConnectionId: h.owner }] : []
      }),
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
  tryResolveConnection: vi.fn(async ({ accountId }: { accountId?: string }) => (accountId ? { id: accountId, channelType: 'EBAY', isPrimary: accountId === 'conn-A' } : null)),
  listActiveConnections: vi.fn(async () => [{ id: 'conn-A', channelType: 'EBAY', isActive: true, isPrimary: true }, { id: 'conn-B', channelType: 'EBAY', isActive: true, isPrimary: false }]),
}))
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: vi.fn(async (id: string) => `token-${id}`) } }))
// P1.2 — the eBay sends go through the channel gateway; its account check and ledger are stood in.
vi.mock('./gateway/account.js', () => import('../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./gateway/ledger.js', () => import('../test-support/gateway-stubs.js').then((m) => m.ledgerModule))

import { OutboundSyncService } from './outbound-sync.service.js'

const service = new OutboundSyncService() as unknown as { syncToEbay: (q: unknown) => Promise<{ status: string; error?: string; errorCode?: string; retryable?: boolean }> }
const row = { id: 'q1', channelListingId: 'listing-1', product: { id: 'p1', sku: 'SKU-1' }, payload: { quantity: 3, marketplaceId: 'EBAY_IT' } }
const tokensSent = () => h.sends

beforeEach(() => {
  vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH', 'true')
  vi.stubEnv('EBAY_PUBLISH_MODE', 'live')
  h.sends = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    h.sends.push(String((init.headers as Record<string, string>).Authorization ?? ''))
    return new Response('{}', { status: 500 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('P1.3 — the eBay queue sends each row through its own account', () => {
  it('DONE-WHEN: a row created for the second account reaches eBay with the SECOND account\'s token', async () => {
    h.owner = 'conn-B'
    const r = await service.syncToEbay({ ...row, channelConnectionId: 'conn-B' })
    expect(r.errorCode).not.toBe('WRONG_ACCOUNT_WRITE')
    expect(tokensSent().length).toBeGreaterThan(0)
    expect(new Set(tokensSent())).toEqual(new Set(['Bearer token-conn-B']))
  })
  it('a row from before P1.3 (no account written): the listing\'s own account, the same way', async () => {
    h.owner = 'conn-B'
    await service.syncToEbay(row)
    expect(new Set(tokensSent())).toEqual(new Set(['Bearer token-conn-B']))
  })
  it('a product-only row two accounts hold in this market: refused, terminal, 0 calls — never the primary', async () => {
    const r = await service.syncToEbay({ id: 'q2', productId: 'p2', targetChannel: 'EBAY', targetRegion: 'IT', product: { id: 'p2', sku: 'SKU-2' }, payload: { quantity: 3, marketplaceId: 'EBAY_IT' } })
    expect(r).toMatchObject({ status: 'FAILED', errorCode: 'NO_DESTINATION_ACCOUNT', retryable: false })
    expect(r.error).toMatch(/more than one eBay account holds this product/)
    expect(tokensSent()).toHaveLength(0)
  })
  it('the ownership check stays: a row naming account A for a listing of account B is refused, 0 calls', async () => {
    h.owner = 'conn-B'
    const r = await service.syncToEbay({ ...row, channelConnectionId: 'conn-A' })
    expect(r).toMatchObject({ status: 'FAILED', errorCode: 'WRONG_ACCOUNT_WRITE', retryable: false })
    expect(tokensSent()).toHaveLength(0)
  })
})

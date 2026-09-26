/**
 * P1.4 — the Shopify queue sends a LINKED listing's change through the row's own account, on the
 * 2026-07 GraphQL module (services/shopify/listing-write.service.ts), never with the env credentials of
 * the old REST 2024-01 path. A row with no destination, or a row that names another shop than its
 * listing's, is refused with 0 calls. Both queue loaders load the listing (the native lane and the
 * account check read it). The Shopify publish mode is `live`; `fetch` records any direct call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  listingAccount: 'conn-B' as string | null,
  listingQuantity: 7 as number | null,
  listingStatus: 'ACTIVE' as string,
  warehouse: 50,
  sent: [] as Array<{ accountId: string; work: any }>,
  fail: null as string | null,
  queueFindUnique: vi.fn(async (_args: any) => null),
  queueFindMany: vi.fn(async (_args: any) => []),
  native: vi.fn(), queueUpdate: vi.fn(), claim: vi.fn(),
}))
vi.mock('../db.js', () => ({
  default: {
    outboundSyncQueue: { findUnique: h.queueFindUnique, findMany: h.queueFindMany, update:h.queueUpdate, updateMany:h.claim },
    channelListing: {
      findUnique: vi.fn(async () => ({ id: 'listing-1', channelConnectionId: h.listingAccount, stockBuffer: 0, fulfillmentMethod: 'FBM', quantity: h.listingQuantity, marketplace: 'GLOBAL', syncPaused: false, listingStatus: h.listingStatus })),
      findMany: vi.fn(async ({ where }: any) => {
        if (where?.id?.in) return where.id.in.includes('listing-1') && h.listingAccount ? [{ id: 'listing-1', channelConnectionId: h.listingAccount }] : []
        // two Shopify accounts hold P2
        if (where?.productId?.in) return where.productId.in.includes('p2') ? [{ productId: 'p2', channel: 'SHOPIFY', marketplace: 'GLOBAL', region: 'GLOBAL', channelConnectionId: 'conn-A' }, { productId: 'p2', channel: 'SHOPIFY', marketplace: 'GLOBAL', region: 'GLOBAL', channelConnectionId: 'conn-B' }] : []
        return []
      }),
    },
    // The dispatch reads ONE ledger (loadSyncLedgers, shared stock): warehouse rows carry their product and
    // location, and this business has no pool link, so the pool door is never asked.
    stockLevel: { findMany: vi.fn(async ({ where }: any) => ((where?.productId?.in ?? ['p1']).map((productId: string) => ({ productId, quantity: h.warehouse, available: h.warehouse, location: { type: 'WAREHOUSE', code: 'IT-MAIN', syncRoutes: [] } })))) },
    stockPoolLink: { findMany: vi.fn(async () => []) },
    channelPublishAttempt: { create: vi.fn(async () => ({})) },
    outboundApiCallLog: { create: vi.fn(async () => ({})) },
  },
}))
vi.mock('../lib/queue.js', () => ({ addJobSafely: async () => null, outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('./sync-control-policy.service.js', () => ({ loadChannelPolicies: async () => new Map(), policyFor: () => null }))
vi.mock('./connection-resolver.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./connection-resolver.service.js')>()),
  listActiveConnections: vi.fn(async () => [{ id: 'conn-A', channelType: 'SHOPIFY', isActive: true, isPrimary: true }, { id: 'conn-B', channelType: 'SHOPIFY', isActive: true, isPrimary: false }]),
}))
vi.mock('./shopify/listing-write.service.js', () => ({
  syncShopifyLinkedListing: vi.fn(async (_row: unknown, accountId: string, work: unknown) => {
    h.sent.push({ accountId, work })
    if (h.fail) throw new Error(h.fail)
    return 'Shopify stock set and read back.'
  }),
}))
vi.mock('./shopify/offer-sync.service.js', () => ({ syncNativeShopifyOffer:h.native }))

import { OutboundSyncService } from './outbound-sync.service.js'

type Result = { status: string; message?: string; error?: string; errorCode?: string; retryable?: boolean }
const service = new OutboundSyncService() as unknown as { syncToShopify: (q: unknown) => Promise<Result> }
const listing = (account: string | null = 'conn-B') => ({ id: 'listing-1', channelConnectionId: account, platformAttributes: { variantId: '11', inventoryItemId: '22', shopifyProductId: '33' } })
const row = (extra: Record<string, unknown> = {}) => ({ id: 'q1', syncType: 'QUANTITY_UPDATE', channelListingId: 'listing-1', product: { id: 'p1', sku: 'SKU-1' }, channelListing: listing(), payload: { quantity: 3 }, ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  h.native.mockResolvedValue('Native offer confirmed')
  h.claim.mockResolvedValue({count:1})
  h.queueFindMany.mockResolvedValue([])
  vi.stubEnv('NEXUS_ENABLE_SHOPIFY_PUBLISH', 'true')
  vi.stubEnv('SHOPIFY_PUBLISH_MODE', 'live')
  // The old path's env credentials are set: they must not be used.
  vi.stubEnv('SHOPIFY_SHOP_NAME', 'env-shop')
  vi.stubEnv('SHOPIFY_ACCESS_TOKEN', 'env-token')
  h.listingAccount = 'conn-B'; h.listingQuantity = 7; h.warehouse = 50; h.sent = []; h.fail = null; h.listingStatus = 'ACTIVE'
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('P1.4 — the Shopify queue: the row\'s own account, never the env credentials', () => {
  it.each(['ACCOUNT_NEEDS_SIGNIN','TOKEN_UNAVAILABLE'])('preserves native Shopify %s holds',async code=>{
    h.native.mockRejectedValue(Object.assign(new Error('Credential hold'),{code}))
    expect(await service.syncToShopify(row({channelListing:{...listing(),platformAttributes:{nexusFamilyId:'family'}}}))).toMatchObject({status:'FAILED',errorCode:code})
    expect(h.sent).toHaveLength(0)
  })
  it('resumes an auth-held native listing through its original lane',async()=>{
    const held=row({targetChannel:'SHOPIFY',syncStatus:'FAILED',retryCount:3,errorCode:'AUTH_REQUIRED',channelListing:{...listing(),platformAttributes:{nexusFamilyId:'family'}}})
    h.queueFindMany.mockImplementation(async(args:any)=>args.where.syncStatus==='FAILED' ? [{...held,channelListing:args.include.channelListing ? held.channelListing : undefined}] as any : [])
    await new OutboundSyncService().processPendingSyncs()
    expect(h.native).toHaveBeenCalledTimes(1)
    expect(h.native).toHaveBeenCalledWith(expect.objectContaining({channelListing:held.channelListing}))
    expect(h.sent).toHaveLength(0)
    expect(h.queueUpdate).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({syncStatus:'SUCCESS'})}))
  })
  it('a row for the second account is sent through the second account; no direct call with the env token', async () => {
    const r = await service.syncToShopify(row({ channelConnectionId: 'conn-B' }))
    expect(r.status).toBe('SUCCESS')
    expect(h.sent.map((s) => s.accountId)).toEqual(['conn-B'])
    expect(fetch).not.toHaveBeenCalled()
  })
  it('a row from before P1.3 (no account written): the listing\'s own account', async () => {
    await service.syncToShopify(row())
    expect(h.sent.map((s) => s.accountId)).toEqual(['conn-B'])
  })
  it('a product-only row two Shopify accounts hold: refused, terminal, 0 calls — never the primary', async () => {
    const r = await service.syncToShopify({ id: 'q2', syncType: 'QUANTITY_UPDATE', productId: 'p2', targetChannel: 'SHOPIFY', product: { id: 'p2', sku: 'SKU-2' }, channelListing: null, payload: { quantity: 3 } })
    expect(r).toMatchObject({ status: 'FAILED', errorCode: 'NO_DESTINATION_ACCOUNT', retryable: false })
    expect(h.sent).toHaveLength(0)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('a row naming account A for a listing of account B: refused, terminal, 0 calls', async () => {
    const r = await service.syncToShopify(row({ channelConnectionId: 'conn-A' }))
    expect(r).toMatchObject({ status: 'FAILED', errorCode: 'WRONG_ACCOUNT_WRITE', retryable: false })
    expect(h.sent).toHaveLength(0)
  })
  it('P1.7 — the listing is ENDED on the channel: refused by the push lock, 0 calls', async () => {
    h.listingStatus = 'ENDED'
    const r = await service.syncToShopify(row({ channelConnectionId: 'conn-B' }))
    expect(r).toMatchObject({ status: 'SKIPPED', errorCode: 'PUSH_LISTING_ENDED', retryable: false })
    expect(h.sent).toHaveLength(0)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('publish mode not live: skipped, 0 calls', async () => {
    vi.stubEnv('SHOPIFY_PUBLISH_MODE', 'dry-run')
    const r = await service.syncToShopify(row({ channelConnectionId: 'conn-B' }))
    expect(r.status).toBe('SKIPPED')
    expect(h.sent).toHaveLength(0)
  })
  it('a refusal from the Shopify module is the row\'s error sentence', async () => {
    h.fail = 'No reviewed Shopify stock location for SKU-1. Choose the location for this listing; none was chosen automatically.'
    const r = await service.syncToShopify(row({ channelConnectionId: 'conn-B' }))
    expect(r).toMatchObject({ status: 'FAILED', message: h.fail, error: h.fail })
  })
})

describe('P1.4 — what the queue asks the module to write', () => {
  it('stock: the listing\'s committed quantity at dispatch, not the stale payload (RT.4, moved unchanged)', async () => {
    await service.syncToShopify(row({ channelConnectionId: 'conn-B' }))
    expect(h.sent[0].work).toEqual({ quantity: 7 })
  })
  it('stock: clamped to the warehouse pool', async () => {
    h.warehouse = 4
    await service.syncToShopify(row({ channelConnectionId: 'conn-B' }))
    expect(h.sent[0].work).toEqual({ quantity: 4 })
  })
  it('price: the payload price, and no stock value', async () => {
    await service.syncToShopify(row({ channelConnectionId: 'conn-B', syncType: 'PRICE_UPDATE', payload: { price: 19.5 } }))
    expect(h.sent[0].work).toEqual({ price: 19.5 })
  })
  // Owner D2 (PE, 2026-09-26): content for a LINKED store product goes only through Publish, where the Owner sees the
  // exact change first. Before, a child row's title was written over the shared Shopify product. Skipped, 0 calls.
  it('content: a linked listing\'s content row is skipped — content goes only through Publish, 0 calls', async () => {
    const result = await service.syncToShopify(row({ channelConnectionId: 'conn-B', syncType: 'CONTENT_UPDATE', product: null, payload: { title: 'New', description: '<p>x</p>', quantity: 0 } }))
    expect(result).toMatchObject({ status: 'SKIPPED', retryable: false, message: expect.stringContaining('only through Publish') })
    expect(h.sent).toEqual([])
  })
})

describe('P1.4 — both queue loaders load the listing', () => {
  it('processSingle', async () => {
    await new OutboundSyncService().processSingle('q-missing')
    expect(h.queueFindUnique.mock.calls[0][0].include).toMatchObject({ product: true, channelListing: true })
  })
  it('processPendingSyncs', async () => {
    await new OutboundSyncService().processPendingSyncs()
    expect(h.queueFindMany.mock.calls[0][0].include).toMatchObject({ product: true, channelListing: true })
  })
})

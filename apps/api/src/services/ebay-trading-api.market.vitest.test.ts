import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// P1.2 — Trading calls go through the channel gateway; its account check and ledger are stood in.
vi.mock('../services/gateway/account.js', () => import('../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../services/gateway/ledger.js', () => import('../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
const m = vi.hoisted(() => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  return { fetch }
})
const trading = await import('./ebay-trading-api.service.js')
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('NEXUS_EBAY_REAL_API', 'true')
  // P0.1 — listing writes follow the publish mode; these model production (`live`).
  vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH', 'true'); vi.stubEnv('EBAY_PUBLISH_MODE', 'live')
  m.fetch.mockImplementation(async () => new Response('<Response><Ack>Success</Ack><ItemID>FAKE</ItemID><ListingStatus>Completed</ListingStatus></Response>', { status: 200 }))
})
afterEach(() => vi.unstubAllEnvs())
describe('W1.3 GB / UK fold at Trading callers (only synthetic fetch)', () => {
  it.each(['GB', 'UK', 'gb', 'uk'])('bidirectional normalisers preserve site 3 for %s', (market) => {
    expect(trading.ebaySiteMarket(market)).toBe('UK'); expect(trading.ebayListingRegion(market)).toBe('GB')
    expect(trading.siteIdForMarket(market)).toBe('3')
    expect(trading.siteIdForMarket(trading.ebayListingRegion(market))).toBe('3')
    expect(trading.siteIdForMarket('IT')).toBe('101')
    expect(() => trading.siteIdForMarket('ZZ')).toThrow('unknown eBay market')
  })
  const calls = [
    ['reviseInventoryStatus', (market: string) => trading.reviseInventoryStatus({ itemId: 'FAKE', sku: 'SKU', quantity: 0 }, { oauthToken: 'STUB', market, connectionId: 'conn-1' })],
    ['getItemListingStatus', (market: string) => trading.getItemListingStatus('FAKE', { oauthToken: 'STUB', market, connectionId: 'conn-1' })],
    ['getItemQuantities', (market: string) => trading.getItemQuantities('FAKE', { oauthToken: 'STUB', market, connectionId: 'conn-1' })],
    ['reviseInventoryStatusBatch', (market: string) => trading.reviseInventoryStatusBatch({ itemId: 'FAKE', entries: [{ sku: 'SKU', quantity: 0 }] }, { oauthToken: 'STUB', market, connectionId: 'conn-1' })],
    ['addFixedPriceItem', (market: string) => trading.addFixedPriceItem({ title: 'test', description: 'test', categoryId: '1', currency: 'GBP', country: 'GB', location: 'London', postalCode: 'TEST', variations: [], pictures: [], variationSpecificNames: [], itemSpecifics: {}, policies: {} } as any, { oauthToken: 'STUB', market, connectionId: 'conn-1' })],
  ] as const
  for (const [name, run] of calls) it.each(['GB', 'UK'])(`${name} accepts %s and sends site 3 to the stub`, async (market) => {
    await run(market)
    expect(m.fetch).toHaveBeenCalled()
    // P1.7 — addFixedPriceItem verifies with eBay before it adds, so that caller makes two calls.
    // Every call of every caller must carry site 3.
    for (const call of m.fetch.mock.calls) expect(call[1].headers['X-EBAY-API-SITEID']).toBe('3')
    if (name === 'addFixedPriceItem') {
      expect(m.fetch.mock.calls.map(call => call[1].headers['X-EBAY-API-CALL-NAME']))
        .toEqual(['VerifyAddFixedPriceItem', 'AddFixedPriceItem'])
    }
  })
})

vi.mock('./connection-resolver.service.js', () => ({ tryResolveConnection: vi.fn(async () => ({ id: 'owner', channelType: 'EBAY' })) }))
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: vi.fn(async () => 'STUB') } }))
vi.mock('./channel-delist.service.js', () => ({ dispatchChannelDelist: vi.fn(() => { throw new Error('Unexpected whole-item delist') }) }))
// P0.7 — the wrong-account guard reads listing ownership; no recorded owner = the pre-P0.7 behaviour this file models.
vi.mock('../db.js', () => ({ default: { channelListing: { findMany: async () => [] }, sharedListingMembership: { findMany: async () => [] } } }))
const { runEbayFlatFileDelete } = await import('./ebay-flat-file-delete.service.js')
it.each(['GB', 'UK'])('tryRemoveVariationFromListing through remove-listing accepts %s', async (marketplace) => {
  const db: any = { sharedListingMembership: { deleteMany: vi.fn(async () => ({ count: 1 })) } }
  db.$transaction = async (run: (tx: any) => unknown) => run(db)
  const [result] = await runEbayFlatFileDelete(db, [{ productId: 'p', sku: 'CHILD-SKU', parentSku: 'PARENT-SKU', itemId: 'FAKE', marketplace, intent: 'remove-listing', channelConnectionId: 'owner', aliasKey: '' } as any])
  expect(result.variationRemoval).toBe('removed')
  expect(m.fetch).toHaveBeenCalledOnce()
  expect(m.fetch.mock.calls[0][1].headers['X-EBAY-API-CALL-NAME']).toBe('ReviseFixedPriceItem')
  expect(m.fetch.mock.calls[0][1].headers['X-EBAY-API-SITEID']).toBe('3')
})

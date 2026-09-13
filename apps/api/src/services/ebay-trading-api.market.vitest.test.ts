import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  return { fetch }
})
const trading = await import('./ebay-trading-api.service.js')
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('NEXUS_EBAY_REAL_API', 'true')
  m.fetch.mockResolvedValue({ ok: true, text: async () => '<Response><Ack>Success</Ack><ItemID>FAKE</ItemID><ListingStatus>Completed</ListingStatus></Response>' })
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
    ['reviseInventoryStatus', (market: string) => trading.reviseInventoryStatus({ itemId: 'FAKE', sku: 'SKU', quantity: 0 }, { oauthToken: 'STUB', market })],
    ['getItemListingStatus', (market: string) => trading.getItemListingStatus('FAKE', { oauthToken: 'STUB', market })],
    ['getItemQuantities', (market: string) => trading.getItemQuantities('FAKE', { oauthToken: 'STUB', market })],
    ['reviseInventoryStatusBatch', (market: string) => trading.reviseInventoryStatusBatch({ itemId: 'FAKE', entries: [{ sku: 'SKU', quantity: 0 }] }, { oauthToken: 'STUB', market })],
    ['addFixedPriceItem', (market: string) => trading.addFixedPriceItem({ title: 'test', description: 'test', categoryId: '1', currency: 'GBP', country: 'GB', location: 'London', postalCode: 'TEST', variations: [], pictures: [], variationSpecificNames: [], itemSpecifics: {}, policies: {} } as any, { oauthToken: 'STUB', market })],
  ] as const
  for (const [name, run] of calls) it.each(['GB', 'UK'])(`${name} accepts %s and sends site 3 to the stub`, async (market) => {
    await run(market)
    expect(m.fetch).toHaveBeenCalledOnce()
    expect(m.fetch.mock.calls[0][1].headers['X-EBAY-API-SITEID']).toBe('3')
  })
})

vi.mock('./connection-resolver.service.js', () => ({ tryResolveConnection: vi.fn(async () => ({ id: 'owner', channelType: 'EBAY' })) }))
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: vi.fn(async () => 'STUB') } }))
vi.mock('./channel-delist.service.js', () => ({ dispatchChannelDelist: vi.fn(() => { throw new Error('Unexpected whole-item delist') }) }))
vi.mock('../db.js', () => ({ default: {} }))
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

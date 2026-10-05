/** Read live — reader choice, the 30-second window, shared in-flight reads, raw kept server-side (all stubbed). */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({ listings: [] as any[], inventory: vi.fn(), trading: vi.fn(), amazon: vi.fn() }))
vi.mock('../../db.js', () => ({ default: {
  product: { findMany: async () => [{ id: 'family', sku: 'FAM', parentId: null }, { id: 'm', sku: 'FAM-M', parentId: 'family' }, { id: 'l', sku: 'FAM-L', parentId: 'family' }] },
  channelListing: { findMany: async () => s.listings },
  categorySchema: { findFirst: async () => null } } }))
vi.mock('../pim/workspace-destination.js', () => ({ resolveWorkspaceDestination: async (i: any) => ({ familyId: 'family', accountId: i.accountId, aliasKey: i.aliasKey ?? null }) }))
vi.mock('../categories/marketplace-ids.js', () => ({ configuredAmazonMarketplaceId: async () => 'MKT-IT' }))
vi.mock('../pim/market-languages.js', () => ({ marketLanguages: async () => ['it'], languageTag: () => 'it_IT' }))
vi.mock('../../clients/amazon-sp-api.client.js', () => ({ AmazonSpApiClient: class { getListingsItem = vi.fn() } }))
vi.mock('../../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'seller', getAmazonRegion: async () => 'eu' }))
vi.mock('../pim/studio-publication-ebay-inventory.js', () => ({ ebayInventoryReads: () => ({ getItem: async () => ({ xml: null }) }) }))
vi.mock('./ebay-inventory.js', () => ({ readEbayInventoryListing: s.inventory }))
vi.mock('./ebay-trading.js', () => ({ readEbayTradingListing: s.trading }))
vi.mock('./amazon.js', () => ({ readAmazonListing: s.amazon }))

import { publicLiveRead, readLiveListing, resetLiveReadWindow } from './index.js'

const read = (source: string) => ({ readAt: 'now', source, destination: {}, revision: 'r', content: {}, variations: null, errors: [], raw: { secret: true } })
const ebay = { channel: 'EBAY', marketplace: 'IT', accountId: 'account' }
const row = (productId: string, extra: object = {}) => ({ productId, externalListingId: '9000000003', platformAttributes: {}, offers: [], ...extra })

beforeEach(() => {
  resetLiveReadWindow(); vi.clearAllMocks()
  s.inventory.mockResolvedValue(read('ebay-inventory-group')); s.trading.mockResolvedValue(read('ebay-trading-item')); s.amazon.mockResolvedValue(read('amazon-listings-item'))
  s.listings = [row('family'), row('m'), row('l')]
})

describe('readLiveListing', () => {
  it('an eBay listing with the Inventory marker is read as Inventory, otherwise as Trading; expected SKUs are the listed children', async () => {
    await readLiveListing('family', ebay)
    expect(s.trading).toHaveBeenCalledWith(expect.objectContaining({ itemId: '9000000003', expectedSkus: ['FAM-M', 'FAM-L'] }), expect.anything())
    resetLiveReadWindow()
    s.listings = [row('family'), row('m', { platformAttributes: { __offerIds: { EBAY_IT: 'offer' } } })]
    await readLiveListing('family', ebay)
    expect(s.inventory).toHaveBeenCalledWith(expect.objectContaining({ parentSku: 'FAM', expectedSkus: ['FAM-M'] }), expect.anything())
  })

  it('an Inventory alias is not read: the Inventory read addresses the main listing\'s group and SKUs', async () => {
    s.listings = [row('family'), row('m', { platformAttributes: { __offerIds: { EBAY_IT: 'offer' } } })]
    const result = await readLiveListing('family', { ...ebay, aliasKey: 'alias-1' })
    expect(s.inventory).not.toHaveBeenCalled()
    expect(s.trading).not.toHaveBeenCalled()
    expect(result.errors).toEqual([{ scope: 'item', reason: expect.stringMatching(/alias uses the eBay Inventory API/) }])
    // A Trading alias is read as before.
    resetLiveReadWindow()
    s.listings = [row('family'), row('m')]
    await readLiveListing('family', { ...ebay, aliasKey: 'alias-1' })
    expect(s.trading).toHaveBeenCalledOnce()
  })
  it('one read per destination per 30 s; the repeat is marked cached; after the window a new read', async () => {
    let t = 1_000
    const first = await readLiveListing('family', ebay, () => t)
    t += 29_000
    const second = await readLiveListing('family', ebay, () => t)
    t += 2_000
    await readLiveListing('family', ebay, () => t)
    expect([first.cached, second.cached]).toEqual([false, true])
    expect(s.trading).toHaveBeenCalledTimes(2)
  })

  it('concurrent requests share one channel read', async () => {
    await Promise.all([readLiveListing('family', ebay), readLiveListing('family', ebay), readLiveListing('family', ebay)])
    expect(s.trading).toHaveBeenCalledTimes(1)
  })

  it('nothing on eBay yet, or a channel whose reader comes later: an honest "could not read", no channel call', async () => {
    s.listings = [row('family', { externalListingId: null })]
    expect((await readLiveListing('family', ebay)).errors).toEqual([{ scope: 'item', reason: 'This listing is not on eBay yet.' }])
    const shopify = await readLiveListing('family', { channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: 'store' })
    expect(shopify).toMatchObject({ revision: null, content: {}, errors: [{ scope: 'item', reason: 'Reading live from Shopify comes with the Shopify publish step (P4.2).' }] })
    expect(s.trading).not.toHaveBeenCalled()
  })

  it('Amazon uses the configured marketplace, language and the single active offer SKU as the seller SKU', async () => {
    s.listings = [row('family'), row('m', { offers: [{ sku: 'SELLER-M', isActive: true }] })]
    await readLiveListing('family', { channel: 'AMAZON', marketplace: 'IT', accountId: 'account' })
    expect(s.amazon).toHaveBeenCalledWith(expect.objectContaining({ marketplaceId: 'MKT-IT', languageTag: 'it_IT', parentSku: 'FAM', expectedSkus: ['SELLER-M'] }), expect.anything())
  })

  it('S7 parity: listings without their own SKU are read under their product SKUs, as before', async () => {
    await readLiveListing('family', { channel: 'AMAZON', marketplace: 'IT', accountId: 'account' })
    expect(s.amazon).toHaveBeenCalledWith(expect.objectContaining({ parentSku: 'FAM', expectedSkus: ['FAM-M', 'FAM-L'] }), expect.anything())
  })

  it('S7: a listing\'s own SKU (confirmed, or wanted while still a draft) is the SKU read, on Amazon and on eBay', async () => {
    s.listings = [row('family'), row('m', { liveChannelSku: 'FAM-M-OWN', channelSku: 'FAM-M-NEXT' }), row('l', { listingStatus: 'DRAFT', isPublished: false, externalListingId: null, channelSku: 'FAM-L-NEW' })]
    await readLiveListing('family', { channel: 'AMAZON', marketplace: 'IT', accountId: 'account' })
    expect(s.amazon).toHaveBeenCalledWith(expect.objectContaining({ parentSku: 'FAM', expectedSkus: ['FAM-M-OWN', 'FAM-L-NEW'] }), expect.anything())
    await readLiveListing('family', ebay)
    expect(s.trading).toHaveBeenCalledWith(expect.objectContaining({ expectedSkus: ['FAM-M-OWN', 'FAM-L-NEW'] }), expect.anything())
  })

  it('🔴 S7: a listing with no single seller SKU is not read under a guess — an honest "could not read", no channel call', async () => {
    s.listings = [row('family'), row('m', { offers: [{ sku: 'SELLER-M1', isActive: true }, { sku: 'SELLER-M2', isActive: true }] })]
    const result = await readLiveListing('family', { channel: 'AMAZON', marketplace: 'IT', accountId: 'account' })
    expect(s.amazon).not.toHaveBeenCalled()
    expect(result.errors).toEqual([{ scope: 'item', reason: 'FAM-M has multiple seller SKUs. Select its offer before publishing.' }])
  })

  it('the web copy never carries the raw provider documents', async () => {
    const web = publicLiveRead(await readLiveListing('family', ebay))
    expect(web).not.toHaveProperty('raw')
    expect(web).toMatchObject({ source: 'ebay-trading-item', cached: false })
  })
})

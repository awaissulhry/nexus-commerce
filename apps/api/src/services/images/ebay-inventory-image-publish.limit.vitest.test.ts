/**
 * Wave 2 (Owner decision 5, 2026-10-05) — the photo publish of an eBay Inventory family sends each market's offers the Max
 * per buyer of THAT market's main row (the family's main listing there, the cell the sheet shows), never the family's
 * first eBay listing on another market. A blank main row (or none) passes no limit of ours: the push then keeps eBay's
 * (`ebay-variation-push.cx-review.vitest.test.ts`, "Max per buyer").
 *
 * Everything around the push is a fixture; nothing reaches eBay or a database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  push: vi.fn(), mainRows: {} as Record<string, Record<string, unknown> | null>, findFirst: vi.fn(),
}))
vi.mock('../../db.js', () => ({ default: {
  product: { findUnique: async () => ({ id: 'fam', sku: 'TEST-FAM', isParent: true, parentId: null, imageAxisPreference: null, productType: null }), findMany: async () => [] },
  channelListing: {
    findMany: async () => ['IT', 'DE'].flatMap(region => ['c1', 'c2'].map(productId => ({ region, price: 10, productId }))),
    findFirst: h.findFirst,
  },
  channelImagePublishJob: { create: async () => ({ id: 'job' }), update: async () => ({}) },
  listingImage: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
} }))
vi.mock('../ebay-publish-gate.service.js', () => ({ ebayWriteRefusal: () => null, ebayHostOf: () => 'fixture.invalid' }))
vi.mock('./media-plan-switch.js', () => ({ isOnMediaPlan: async () => false, MEDIA_PLAN_REFUSAL: 'plan' }))
vi.mock('../connection-resolver.service.js', () => ({ tryResolveConnection: async () => ({ id: 'acc', connectionMetadata: {} }) }))
vi.mock('../write-account-guard.js', () => ({ assertWriteAccount: async () => {}, isWrongAccountWriteError: () => false }))
vi.mock('../ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'synthetic-token' } }))
vi.mock('../ebay-description-theme.service.js', () => ({ renderListingDescriptionSafe: async () => ({ html: '<p>Fixture</p>', warnings: [] }), stampDescriptionPushSafe: () => {} }))
vi.mock('../gateway/ebay.js', () => ({ ebaySend: async () => { throw new Error('No live request permitted') } }))
vi.mock('./ebay-shared-image-publish.service.js', () => ({ publishEbaySharedListingImages: async () => { throw new Error('not this lane') } }))
vi.mock('../ebay-variation-push.service.js', () => ({
  MARKETS: ['IT', 'DE', 'FR', 'ES', 'UK'],
  toMarketplaceId: (mp: string) => `EBAY_${mp}`,
  axisSynonymKey: (name: string) => name.toLowerCase(),
  resolvePerMarketContent: () => ({ title: 'Fixture', description: 'Fixture', subtitle: '' }),
  // The family's rows carry the FIRST listing's value (another market's): it must never be sent.
  buildEbayFamilyRows: async () => [
    { _isParent: true, _productId: 'fam', sku: 'TEST-FAM', quantity_limit_per_buyer: 7 },
    { _isParent: false, _productId: 'c1', sku: 'TEST-FAM-S', aspect_Taglia: 'S' },
    { _isParent: false, _productId: 'c2', sku: 'TEST-FAM-M', aspect_Taglia: 'M' },
  ],
  pushVariationGroup: (...args: unknown[]) => h.push(...args),
}))

const { publishEbayImagesViaInventory } = await import('./ebay-inventory-image-publish.service.js')

beforeEach(() => {
  vi.clearAllMocks()
  h.mainRows = { IT: { quantityLimitPerBuyer: 3 }, DE: { quantityLimitPerBuyer: null } }
  h.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    where.aliasKey === '' && where.marketplace ? (h.mainRows[where.marketplace as string] === undefined ? null : { platformAttributes: h.mainRows[where.marketplace as string] }) : null)
  h.push.mockImplementation(async (_key: string, rows: Array<Record<string, unknown>>, mp: string) => rows.filter(r => !r._isParent).map(r => ({ sku: r.sku, market: mp, status: 'PUSHED', message: 'ok' })))
})

const sentLimits = () => Object.fromEntries(h.push.mock.calls.map(([, rows, mp]) => [mp, (rows as Array<Record<string, unknown>>).find(r => r._isParent)?.quantity_limit_per_buyer]))

describe('photo publish: Max per buyer is the market\'s main row\'s', () => {
  it('each market sends its own main row\'s value; a blank one sends none of ours (eBay keeps its limit)', async () => {
    const result = await publishEbayImagesViaInventory('fam')
    expect(result.success).toBe(true)
    expect(sentLimits()).toEqual({ IT: 3, DE: '' })
    // Read from this account's main listing on each market — never another alias.
    expect(h.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { productId: 'fam', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'acc', aliasKey: '' } }))
  })
  it('no main row on the market: none of ours either, never the family\'s first listing\'s 7', async () => {
    h.mainRows = { IT: undefined as never, DE: undefined as never }
    await publishEbayImagesViaInventory('fam', 'IT')
    expect(sentLimits()).toEqual({ IT: '' })
  })
  it('a value eBay cannot take reaches the push as typed; the push names it and does not send it', async () => {
    h.mainRows = { IT: { quantityLimitPerBuyer: 'abc' } }
    await publishEbayImagesViaInventory('fam', 'IT')
    expect(sentLimits()).toEqual({ IT: 'abc' })
  })
})

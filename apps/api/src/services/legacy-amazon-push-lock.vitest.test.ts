import { beforeEach, expect, it, vi } from 'vitest'
const s = vi.hoisted(() => ({ parent: {} as any, controls: [] as any[], closed: new Set<string>(), submit: vi.fn(), success: vi.fn(), failed: vi.fn() }))
vi.mock('../db.js', () => ({ default: { product: { findUnique: async () => ({ id: 'parent', sku: 'PARENT', isParent: true }) }, channelListing: { findUnique: async () => s.parent, findMany: async () => s.controls }, stockLevel: { aggregate: async () => ({ _sum: { quantity: 2 } }) } } }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'seller' }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: { submitListingPayload: s.submit } }))
vi.mock('./amazon-market-offer.service.js', () => ({ closedMarketSet: async () => s.closed }))
vi.mock('./amazon-mapper.service.js', () => ({ amazonMapperService: { buildVariationPayload: async () => ({ items: [{ sku: 'PARENT', parentage: 'parent' }], childCount: 0 }) } }))
vi.mock('./outbound-sync-phase9.service.js', () => ({ outboundSyncServicePhase9: { markSyncSuccess: s.success, markSyncFailed: s.failed } }))
vi.mock('../utils/logger.js', () => ({ logger: { info() {}, warn() {}, error() {} } }))
import { restoreFbaListings } from './fba-restore.service.js'
import { VariationSyncProcessor } from './variation-sync-processor.service.js'
const locks = [{ syncPaused: true }, { offerClosedAt: new Date() }, ...['HELD','WITHDRAWN','ENDED','DISCONTINUED','RELEASED'].map(presenceIntent => ({ presenceIntent }))]
beforeEach(() => { vi.clearAllMocks(); s.closed = new Set(); s.parent = { id: 'listing', productId: 'parent', marketplace: 'IT', channelConnectionId: 'account', aliasKey: '', variationTheme: 'COLOR', product: { id: 'parent', sku: 'PARENT', productType: 'PRODUCT' } }; s.controls = [s.parent]; s.submit.mockResolvedValue({ success: true }) })
it.each(locks)('refuses FBA restore and records the lock for %j', async lock => {
 Object.assign(s.parent, lock)
 const result = await restoreFbaListings({ dryRun: false })
 expect(result.sent).toBe(0); expect(result.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/^PUSH_/) }); expect(s.submit).not.toHaveBeenCalled()
})
it.each(locks)('refuses a held variation child before the parent submission for %j', async lock => {
 s.controls.push({ ...s.parent, id: 'child-listing', productId: 'child', ...lock })
 expect(await new VariationSyncProcessor().processVariationSync({ id: 'queue', productId: 'parent', channelListingId: 'listing' })).toBe(false)
 expect(s.submit).not.toHaveBeenCalled(); expect(s.success).not.toHaveBeenCalled(); expect(s.failed).toHaveBeenCalledWith('queue', expect.stringMatching(/^PUSH_/))
})
it('allows both unlocked Amazon writers to reach their mocked client', async () => {
 expect((await restoreFbaListings({ dryRun: false })).sent).toBe(1)
 expect(await new VariationSyncProcessor().processVariationSync({ id: 'queue', productId: 'parent', channelListingId: 'listing' })).toBe(true)
 expect(s.submit).toHaveBeenCalledTimes(2); expect(s.success).toHaveBeenCalledTimes(1)
})
it('honours the conservative closed-market belt even when the selected row is open', async () => {
 s.closed.add('parent|IT')
 expect((await restoreFbaListings({ dryRun: false })).sent).toBe(0)
 expect(await new VariationSyncProcessor().processVariationSync({ id: 'queue', productId: 'parent', channelListingId: 'listing' })).toBe(false)
 expect(s.submit).not.toHaveBeenCalled()
})

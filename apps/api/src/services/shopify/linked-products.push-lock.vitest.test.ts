import { beforeEach, expect, it, vi } from 'vitest'
const s = vi.hoisted(() => ({ rows: [] as any[], next: vi.fn(), writes: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { $transaction: (fn: any) => fn({ product: { findFirst: async () => ({ id: 'family', name: 'Fixture', children: [{ id: 'child' }] }) }, channelListing: { findMany: async () => s.rows, updateMany: s.writes } }) } }))
vi.mock('./content-workspace.service.js', () => ({ contentDestination: async () => ({ productId: 'family', familyId: 'family', accountId: 'store', marketplace: 'GLOBAL', aliasKey: '' }), object: (v: any) => v && typeof v === 'object' ? v : {}, PUBLISH_KEY: '_nexusContentPublish' }))
vi.mock('./admin-client.js', () => ({ shopifyAdmin: s.next, assertShopifyResult: vi.fn() }))
vi.mock('./linked-products-gateway.js', () => ({ linkedDigest: (v: any) => JSON.stringify(v) }))
vi.mock('../pim/channel-specs/shopify.js', () => ({ readShopifyMappingSchema: vi.fn() }))
vi.mock('./linked-shared-content.service.js', () => ({ resolveSharedContent: vi.fn() }))
vi.mock('./information-gateway.js', () => ({ readInformation: vi.fn(), readInformationNativeOwners: vi.fn(), verifyInformationPlan: vi.fn(), applyNativeEdit: vi.fn(), advanceMediaOrder: vi.fn() }))
vi.mock('./information-translations.js', () => ({ verifyTranslationEdits: vi.fn() }))
vi.mock('./channel-sheet-media.js', () => ({ readSheetGallerySources: vi.fn(), reviewSheetGalleries: vi.fn(), advanceSheetGallery: vi.fn(), verifySheetGallery: vi.fn(), SHEET_MEDIA_SYNC: '_sheetMedia' }))
import { advanceLinkedSync } from './linked-products.service.js'
const locks = [{ syncPaused: true }, { offerClosedAt: new Date() }, ...['HELD','WITHDRAWN','ENDED','DISCONTINUED','RELEASED'].map(presenceIntent => ({ presenceIntent }))]
beforeEach(() => { vi.clearAllMocks(); s.rows = [{ id: 'listing', productId: 'family', version: 1, platformAttributes: { _nexusLinkedProductsOperation: { id: 'operation', status: 'RUNNING', changes: [], verification: [], completed: 0, schemaRevision: 'schema', lease: null, leaseUntil: 0 } } }, { id: 'child-listing', productId: 'child', version: 1, platformAttributes: {} }]; s.next.mockRejectedValue(new Error('NEXT_REVIEW_REACHED')); s.writes.mockResolvedValue({ count: 1 }) })
it.each(locks)('refuses linked Information sync when a child is locked: %j', async lock => {
 Object.assign(s.rows[1], lock)
 await expect(advanceLinkedSync('family', { accountId: 'store' }, 'operation')).rejects.toMatchObject({ code: expect.stringMatching(/^PUSH_/) })
 expect(s.next).not.toHaveBeenCalled(); expect(s.writes).not.toHaveBeenCalled()
})
it('lets the unlocked control acquire a lease and reach the next Shopify review boundary', async () => {
 await expect(advanceLinkedSync('family', { accountId: 'store' }, 'operation')).rejects.toThrow('NEXT_REVIEW_REACHED')
 expect(s.next).toHaveBeenCalledTimes(1); expect(s.writes).toHaveBeenCalled()
})

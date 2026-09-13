import { beforeEach, describe, expect, it, vi } from 'vitest'
const s = vi.hoisted(() => ({ row: {} as any, remote: null as any, status: 'DRAFT', category: false, applied: [] as string[], childWrites: [] as any[], childLookups: [] as any[], tx: {} as any }))
vi.mock('../pim/publish-review-gate.js', () => ({ assertListingContentReviewed: async () => {} }))
vi.mock('../../db.js', () => ({ default: { $transaction: (fn: any) => fn(s.tx), channelListing: { findFirst: async () => s.row } } }))
vi.mock('../pim/channel-specs/shopify.js', () => ({ readShopifyMappingSchema: async () => ({ locales: [{ locale: 'en', primary: true, published: true }] }) }))
vi.mock('./linked-products-gateway.js', () => ({ readLinkedStoreSchema: async () => ({ locales: [{ locale: 'en', primary: true, published: true }] }) }))
vi.mock('./linked-state-guard.js', () => ({ shopifyInformationPublicationIssue: () => null }))
vi.mock('./listing-information-plan.js', () => ({ validateListingInformationOverrides: () => {}, listingInformationOverrideReview: () => [], listingInformationDraft: async () => ({ edits: [], nativeEdits: [...(s.category && !s.remote?.category ? [{ field: 'category', nextValue: 'gid://shopify/TaxonomyCategory/aa-8' }] : []), { field: 'status', nextValue: s.status }] }), listingInformationTranslations: async () => ({ edits: [], nativeEdits: [] }) }))
vi.mock('./linked-products.service.js', () => ({ buildLinkedPlan: async (_g: any, draft: any) => ({ changes: draft.edits, nativeEdits: draft.nativeEdits }), applyLinkedBatch: async () => {} }))
vi.mock('./information-gateway.js', () => ({ applyNativeEdit: async (_g: any, edit: any) => { s.applied.push(edit.field); s.remote[edit.field] = edit.nextValue } }))
vi.mock('./admin-client.js', () => ({ shopifyAdmin: async () => ({ domain: 'fixture.myshopify.com', graphql: async () => ({ locations: { nodes: [{ id: 'location', isActive: true }], pageInfo: { hasNextPage: false } }, shopLocales: [{ locale: 'en', primary: true, published: true }] }) }) }))
vi.mock('./content-workspace.service.js', () => ({
  CONTENT_KEY: '_nexusContent', PUBLISH_KEY: '_nexusContentPublish', object: (v: any) => v && typeof v === 'object' ? v : {}, digest: (v: any) => JSON.stringify(v) ?? 'none',
  contentDestination: async () => ({ familyId: 'family', accountId: 'store-b', marketplace: 'GLOBAL', aliasKey: 'alias-b' }),
  readContent: async () => ({ family: { id: 'family', name: 'Product', categoryAttributes: {} }, variants: [{ id: 'child', sku: 'SKU', options: {}, price: '1', stock: 0 }], listing: structuredClone(s.row), listings: [structuredClone(s.row)], revision: 'revision', storedDocumentRevision: 'none', publish: {}, draft: { defaultLocale: 'en', locales: ['en'], fields: [], metaobjects: [] }, errors: [] }),
  publicContent: (v: any) => ({ revision: v.revision, errors: v.errors, variants: v.variants }),
}))
vi.mock('@nexus/shared/shopify-content', () => ({ inspectShopifyContent: () => [], resolveShopifyContent: () => ({}) }))
vi.mock('./content-publisher.js', () => ({
  readRemoteProduct: async () => s.remote && structuredClone(s.remote),
  publishContent: async (_g: any, _input: any, checkpoint: any) => { s.remote = { id: 'gid://shopify/Product/1', status: 'DRAFT' }; await checkpoint({ productId: s.remote.id }); return { productId: s.remote.id, variantIds: { child: 'gid://shopify/ProductVariant/2' }, inventoryItemIds: { child: 'gid://shopify/InventoryItem/3' }, status: 'VERIFIED' } },
}))
import { previewContentSync, synchronizeContent } from './content-sync.service.js'
beforeEach(() => {
  s.remote = null; s.category = false; s.applied = []; s.childWrites = []; s.childLookups = []
  s.row = { id: 'listing', productId: 'family', version: 1, platformAttributes: {}, followMasterTitle: true, followMasterDescription: true }
  s.tx = { channelListing: {
    findUnique: async () => structuredClone(s.row), findUniqueOrThrow: async () => structuredClone(s.row),
    findFirst: async (query: any) => { s.childLookups.push(query); return null },
    updateMany: async ({ where, data }: any) => { if (where.version !== s.row.version) return { count: 0 }; Object.assign(s.row, data, { version: s.row.version + 1 }); return { count: 1 } },
    update: async ({ data }: any) => { Object.assign(s.row, data, { version: s.row.version + 1 }); return s.row },
    create: async ({ data }: any) => { s.childWrites.push(data); return data },
  } }
})
describe('New product synchronization records final verified native status', () => {
  it.each(['ACTIVE', 'DRAFT', 'ARCHIVED'])('records %s after Information overrides and retains exact alias/variant identity', async status => {
    s.status = status
    const scope = { accountId: 'store-b', listingId: 'alias-listing', market: 'GLOBAL' }
    const preview = await previewContentSync('family', scope, true)
    const result = await synchronizeContent('family', scope, { expectedRevision: preview.revision, expectedRemoteRevision: preview.remoteRevision, locationId: 'location', confirmActive: true })
    expect(result.success).toBe(true)
    expect(s.row.isPublished).toBe(status === 'ACTIVE')
    expect(s.row.listingStatus).toBe(status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE')
    expect(s.childWrites[0].listingStatus).toBe(s.row.listingStatus)
    expect(s.childWrites).toEqual([expect.objectContaining({ channelConnectionId: 'store-b', aliasKey: 'alias-b', aliasId: 'alias-b', productId: 'child', isPublished: status === 'ACTIVE', platformAttributes: expect.objectContaining({ variantId: '2', inventoryItemId: '3', shopifyProductId: '1' }) })])
    expect(s.childLookups).toEqual([{ where: { productId: 'child', channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: 'store-b', aliasKey: 'alias-b' } }])
  })
})

 it('initializes a new product category before planning its constrained Information fields', async () => {
    s.status = 'DRAFT'; s.category = true
    const scope = { accountId: 'store-b', market: 'GLOBAL' }
    const preview = await previewContentSync('family', scope, true)
    await synchronizeContent('family', scope, { expectedRevision: preview.revision, expectedRemoteRevision: preview.remoteRevision, locationId: 'location', confirmActive: true })
    expect(s.applied).toEqual(['category', 'status'])
    expect(s.remote.category).toBe('gid://shopify/TaxonomyCategory/aa-8')
  })

it.each([{ syncPaused: true }, { offerClosedAt: new Date() }, ...['HELD', 'WITHDRAWN', 'ENDED', 'DISCONTINUED', 'RELEASED'].map(presenceIntent => ({ presenceIntent }))])('refuses preview and synchronize before remote writes for %j', async lock => {
  Object.assign(s.row, lock)
  const scope = { accountId: 'store-b', market: 'GLOBAL' }
  await expect(previewContentSync('family', scope, true)).rejects.toMatchObject({ code: expect.stringMatching(/^PUSH_/) })
  await expect(synchronizeContent('family', scope, { confirmActive: true })).rejects.toMatchObject({ code: expect.stringMatching(/^PUSH_/) })
  expect(s.applied).toEqual([])
  expect(s.remote).toBeNull()
  expect(s.row.version).toBe(1)
})
it('names the deliberate end and its recorded date and actor even when confirmActive is true', async () => {
  Object.assign(s.row, { presenceIntent: 'ENDED', presenceIntentAt: '2026-09-13T12:00:00Z', presenceIntentBy: 'operator-123' })
  await expect(synchronizeContent('family', { accountId: 'store-b' }, { confirmActive: true })).rejects.toThrow('deliberately ended on 2026-09-13T12:00:00.000Z by operator-123')
})

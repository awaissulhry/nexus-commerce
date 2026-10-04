import { beforeEach, describe, expect, it, vi } from 'vitest'
const s = vi.hoisted(() => ({ row: {} as any, child: null as any, remote: null as any, status: 'DRAFT', category: false, applied: [] as string[], childWrites: [] as any[], childLookups: [] as any[], tx: {} as any }))
// Images rebuild P2f — not on the media plan: the older Shopify gallery paths run here.
vi.mock('../images/media-plan-switch.js', () => ({ isOnMediaPlan: async () => false, mediaPlanRevision: async () => null, mediaPlanProducts: async () => new Set() }))
vi.mock('../pim/publish-review-gate.js', () => ({ assertListingContentReviewed: async () => {} }))
vi.mock('../../db.js', () => ({ default: { $transaction: (fn: any) => fn(s.tx), channelListing: { findFirst: async () => s.row } } }))
vi.mock('../pim/channel-specs/shopify.js', () => ({ readShopifyMappingSchema: async () => ({ locales: [{ locale: 'en', primary: true, published: true }] }) }))
vi.mock('./linked-products-gateway.js', () => ({ readLinkedStoreSchema: async () => ({ locales: [{ locale: 'en', primary: true, published: true }] }) }))
vi.mock('./linked-state-guard.js', () => ({ shopifyInformationPublicationIssue: () => null }))
// S1 item 5 — no Shared values to inherit in this suite (`inherited-information.vitest.test.ts` covers them).
vi.mock('./inherited-information.js', () => ({ noInheritedInformation: () => ({ values: {}, problems: [], review: [] }), resolveInheritedInformation: async () => ({ values: {}, problems: [], review: [] }) }))
vi.mock('./listing-information-plan.js', () => ({ validateListingInformationOverrides: () => {}, listingInformationOverrideReview: () => [], listingInformationDraft: async () => ({ edits: [], nativeEdits: [...(s.category && !s.remote?.category ? [{ field: 'category', nextValue: 'gid://shopify/TaxonomyCategory/aa-8' }] : []), { field: 'status', nextValue: s.status }] }), listingInformationTranslations: async () => ({ edits: [], nativeEdits: [] }) }))
vi.mock('./linked-products.service.js', () => ({ buildLinkedPlan: async (_g: any, draft: any) => ({ changes: draft.edits, nativeEdits: draft.nativeEdits }), applyLinkedBatch: async () => {} }))
vi.mock('./information-gateway.js', () => ({ applyNativeEdit: async (_g: any, edit: any) => { s.applied.push(edit.field); s.remote[edit.field] = edit.nextValue } }))
vi.mock('./admin-client.js', () => ({ shopifyAdmin: async () => ({ domain: 'fixture.myshopify.com', graphql: async () => ({ locations: { nodes: [{ id: 'location', isActive: true }], pageInfo: { hasNextPage: false } }, shopLocales: [{ locale: 'en', primary: true, published: true }] }) }) }))
vi.mock('./content-workspace.service.js', () => ({
  CONTENT_KEY: '_nexusContent', PUBLISH_KEY: '_nexusContentPublish', object: (v: any) => v && typeof v === 'object' ? v : {}, digest: (v: any) => JSON.stringify(v) ?? 'none',
  contentDestination: async () => ({ familyId: 'family', accountId: 'store-b', marketplace: 'GLOBAL', aliasKey: 'alias-b' }),
  readContent: async () => ({ family: { id: 'family', name: 'Product', categoryAttributes: {} }, variants: [{ id: 'child', sku: 'SKU', options: {}, price: '1', stock: 0 }], listing: structuredClone(s.row), listings: [structuredClone(s.row), ...(s.child ? [structuredClone(s.child)] : [])], revision: 'revision', storedDocumentRevision: 'none', publish: {}, draft: { defaultLocale: 'en', locales: ['en'], fields: [], metaobjects: [] }, errors: [] }),
  publicContent: (v: any) => ({ revision: v.revision, errors: v.errors, variants: v.variants }),
}))
vi.mock('@nexus/shared/shopify-content', () => ({ inspectShopifyContent: () => [], resolveShopifyContent: () => ({}) }))
vi.mock('./content-publisher.js', () => ({
  readRemoteProduct: async () => s.remote && structuredClone(s.remote),
  publishContent: async (_g: any, _input: any, checkpoint: any) => { s.remote = { id: 'gid://shopify/Product/1', status: 'DRAFT' }; await checkpoint({ productId: s.remote.id }); return { productId: s.remote.id, variantIds: { child: 'gid://shopify/ProductVariant/2' }, inventoryItemIds: { child: 'gid://shopify/InventoryItem/3' }, status: 'VERIFIED' } },
}))
import { previewContentSync, synchronizeContent } from './content-sync.service.js'
beforeEach(() => {
  s.remote = null; s.category = false; s.applied = []; s.childWrites = []; s.childLookups = []; s.child = null
  s.row = { id: 'listing', productId: 'family', version: 1, platformAttributes: {}, followMasterTitle: true, followMasterDescription: true }
  s.tx = { channelListing: {
    findUnique: async () => structuredClone(s.row), findUniqueOrThrow: async () => structuredClone(s.row),
    findFirst: async (query: any) => { s.childLookups.push(query); return s.child && query.where.productId === s.child.productId ? structuredClone(s.child) : null },
    updateMany: async ({ where, data }: any) => { if (where.version !== s.row.version) return { count: 0 }; Object.assign(s.row, data, { version: s.row.version + 1 }); return { count: 1 } },
    update: async ({ where, data }: any) => { const row = s.child && where.id === s.child.id ? s.child : s.row; Object.assign(row, data, { version: row.version + 1 }); return row },
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

// New listings (Owner 2026-10-04) — Publish's Status choice for a product Shopify does not hold yet wins over the stored
// Shopify status: Active creates it ACTIVE, Inactive leaves it a Draft. The verified status is kept on the family row.
describe('New listings: the create status from Publish', () => {
  it.each([['DRAFT', 'ACTIVE', true], ['ACTIVE', 'DRAFT', false]] as const)('stored %s, chosen %s: Shopify verifies the choice', async (stored, chosen, live) => {
    s.status = stored
    const scope = { accountId: 'store-b', market: 'GLOBAL' }
    const preview = await previewContentSync('family', scope, true)
    await synchronizeContent('family', scope, { expectedRevision: preview.revision, expectedRemoteRevision: preview.remoteRevision, locationId: 'location', confirmActive: true, createStatus: chosen })
    expect(s.remote.status).toBe(chosen)
    expect(s.applied).toEqual(chosen === 'ACTIVE' ? ['status'] : [])
    expect(s.row).toMatchObject({ isPublished: live, listingStatus: live ? 'ACTIVE' : 'INACTIVE', platformAttributes: expect.objectContaining({ status: chosen }) })
  })
  it('a product Shopify already holds keeps its own status path (the choice is only for a create)', async () => {
    s.status = 'DRAFT'
    s.remote = { id: 'gid://shopify/Product/1', status: 'DRAFT' }
    const scope = { accountId: 'store-b', market: 'GLOBAL' }
    const preview = await previewContentSync('family', scope, true)
    await synchronizeContent('family', scope, { expectedRevision: preview.revision, expectedRemoteRevision: preview.remoteRevision, locationId: 'location', confirmActive: true, createStatus: 'ACTIVE' })
    expect(s.remote.status).toBe('DRAFT')
    expect(s.row.platformAttributes.status).toBeUndefined()
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

describe('Draft listing safety — Publish may send a paused still-draft, and delivery lifts its pause', () => {
  const PAUSED = 'Listing sync is paused. Resume sync before sending changes.'
  const stillDraft = { listingStatus: 'DRAFT', isPublished: false, externalListingId: null, syncPaused: true }
  const publish = async () => {
    const scope = { accountId: 'store-b', market: 'GLOBAL' }
    const preview = await previewContentSync('family', scope, true)
    return synchronizeContent('family', scope, { expectedRevision: preview.revision, expectedRemoteRevision: preview.remoteRevision, locationId: 'location', confirmActive: true })
  }
  it.each(['ACTIVE', 'DRAFT'])('sends paused still-drafts and unpauses them with the Shopify ids and the verified status (%s)', async status => {
    s.status = status
    Object.assign(s.row, stillDraft)
    s.child = { id: 'child-listing', productId: 'child', version: 1, platformAttributes: {}, ...stillDraft }
    expect((await publish()).success).toBe(true)
    expect(s.remote).not.toBeNull()
    // The family row got its Shopify id MID-delivery (checkpoint), so "was a draft" must come from before the send.
    expect(s.row).toMatchObject({ externalListingId: '1', syncPaused: false, isPublished: status === 'ACTIVE', listingStatus: status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE' })
    expect(s.child).toMatchObject({ externalListingId: '1', syncPaused: false, isPublished: status === 'ACTIVE', platformAttributes: expect.objectContaining({ variantId: '2' }) })
    expect(s.childWrites).toEqual([])
  })
  it('refuses an operator-paused LIVE row with the same sentence, before any remote write', async () => {
    Object.assign(s.row, { listingStatus: 'ACTIVE', isPublished: true, externalListingId: '1', syncPaused: true })
    await expect(previewContentSync('family', { accountId: 'store-b', market: 'GLOBAL' }, true)).rejects.toMatchObject({ code: 'PUSH_SYNC_PAUSED', message: PAUSED })
    await expect(synchronizeContent('family', { accountId: 'store-b', market: 'GLOBAL' }, { confirmActive: true })).rejects.toMatchObject({ code: 'PUSH_SYNC_PAUSED', message: PAUSED })
    expect(s.remote).toBeNull()
    expect(s.row.syncPaused).toBe(true)
  })
  it('refuses a family whose paused child is live, even when the family row is a still-draft', async () => {
    Object.assign(s.row, stillDraft)
    s.child = { id: 'child-listing', productId: 'child', version: 1, platformAttributes: {}, listingStatus: 'ACTIVE', isPublished: true, externalListingId: '1', syncPaused: true }
    await expect(publish()).rejects.toMatchObject({ code: 'PUSH_SYNC_PAUSED' })
    expect(s.remote).toBeNull()
  })
})

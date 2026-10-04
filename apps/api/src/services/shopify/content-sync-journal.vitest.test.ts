import { beforeEach, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({ row: {} as any, remote: null as any, tx: {} as any, graphql: vi.fn(), events: [] as string[] }))
// Images rebuild P2f — not on the media plan: the older Shopify gallery paths run here.
vi.mock('../images/media-plan-switch.js', () => ({ isOnMediaPlan: async () => false, mediaPlanRevision: async () => null, mediaPlanProducts: async () => new Set() }))
vi.mock('../pim/publish-review-gate.js', () => ({ assertListingContentReviewed: async () => {} }))
vi.mock('../../db.js', () => ({ default: { $transaction: (fn: any) => fn(s.tx), channelListing: { findFirst: async () => s.row } } }))
vi.mock('../pim/channel-specs/shopify.js', () => ({ readShopifyMappingSchema: async () => ({ locales: [{ locale: 'en', primary: true, published: true }] }) }))
vi.mock('./linked-products-gateway.js', () => ({ readLinkedStoreSchema: async () => ({ locales: [{ locale: 'en', primary: true, published: true }] }) }))
vi.mock('./linked-state-guard.js', () => ({ shopifyInformationPublicationIssue: () => null }))
// S1 item 5 — no Shared values to inherit in this suite (`inherited-information.vitest.test.ts` covers them).
vi.mock('./inherited-information.js', () => ({ noInheritedInformation: () => ({ values: {}, problems: [], review: [] }), resolveInheritedInformation: async () => ({ values: {}, problems: [], review: [] }) }))
vi.mock('./listing-information-plan.js', () => ({ validateListingInformationOverrides: () => {}, listingInformationOverrideReview: () => [], listingInformationDraft: async () => ({ edits: [], nativeEdits: [] }), listingInformationTranslations: async () => ({ edits: [], nativeEdits: [] }) }))
vi.mock('./linked-products.service.js', () => ({ buildLinkedPlan: async (_g: any, draft: any) => ({ changes: draft.edits, nativeEdits: draft.nativeEdits }), applyLinkedBatch: async () => {} }))
vi.mock('./information-gateway.js', () => ({ applyNativeEdit: async () => {} }))
vi.mock('./admin-client.js', () => ({ shopifyAdmin: async () => ({ domain: 'fixture.myshopify.com', graphql: s.graphql }) }))
vi.mock('./content-workspace.service.js', () => ({
  CONTENT_KEY: '_nexusContent', PUBLISH_KEY: '_nexusContentPublish', object: (v: any) => v && typeof v === 'object' ? v : {}, digest: (v: any) => JSON.stringify(v) ?? 'none',
  contentDestination: async () => ({ familyId: 'family', accountId: 'store-b', marketplace: 'GLOBAL', aliasKey: 'alias-b' }),
  readContent: async () => ({ family: { id: 'family', name: 'Product', categoryAttributes: {} }, variants: [{ id: 'child', sku: 'SKU', options: {}, price: '1', stock: 0 }], listing: structuredClone(s.row), listings: [structuredClone(s.row)], revision: 'revision', storedDocumentRevision: 'none', publish: {}, draft: { defaultLocale: 'en', locales: ['en'], fields: [], metaobjects: [] }, errors: [] }),
  publicContent: (v: any) => ({ revision: v.revision, errors: v.errors, variants: v.variants }),
}))
vi.mock('@nexus/shared/shopify-content', () => ({ inspectShopifyContent: () => [], resolveShopifyContent: () => ({}) }))
vi.mock('./content-publisher.js', () => ({
  readRemoteProduct: async () => s.remote && structuredClone(s.remote),
  publishContent: async (graphql: any, _input: any, checkpoint: any) => {
    await graphql('query ExistingProduct { shop { id } }')
    await graphql('# publication\nmutation Create($input:ProductSetInput!) { productSet(input:$input) { product { id } } }', { input: { title: 'Exact title', variants: [{ sku: 'SKU', price: '12.00' }] } })
    await graphql('mutation Media($id:ID!) { productUpdate(product:{id:$id}) { product { id } } }', { id: 'gid://shopify/Product/1' })
    s.remote = { id: 'gid://shopify/Product/1', status: 'DRAFT' }
    await checkpoint({ productId: s.remote.id })
    return { productId: s.remote.id, variantIds: { child: 'gid://shopify/ProductVariant/2' }, inventoryItemIds: { child: 'gid://shopify/InventoryItem/3' }, status: 'VERIFIED' }
  },
}))

import { previewContentSync, synchronizeContent } from './content-sync.service.js'
const scope = { accountId: 'store-b', listingId: 'alias-listing', market: 'GLOBAL' }
const previewBody = async () => { const review = await previewContentSync('family', scope, true); return { expectedRevision: review.revision, expectedRemoteRevision: review.remoteRevision, locationId: 'location', confirmActive: true } }

beforeEach(() => {
  vi.clearAllMocks(); s.remote = null; s.events = []
  s.row = { id: 'listing', productId: 'family', version: 1, platformAttributes: {}, followMasterTitle: true, followMasterDescription: true }
  s.graphql.mockImplementation(async (query: string) => {
    if (query.includes('mutation ')) s.events.push('send')
    return { locations: { nodes: [{ id: 'location', isActive: true }], pageInfo: { hasNextPage: false } }, shopLocales: [{ locale: 'en', primary: true, published: true }] }
  })
  s.tx = { channelListing: {
    findUnique: async () => structuredClone(s.row), findUniqueOrThrow: async () => structuredClone(s.row), findFirst: async () => null,
    updateMany: async ({ where, data }: any) => { if (where.version !== s.row.version) return { count: 0 }; Object.assign(s.row, data, { version: s.row.version + 1 }); return { count: 1 } },
    update: async ({ data }: any) => { Object.assign(s.row, data, { version: s.row.version + 1 }); return s.row },
    create: async ({ data }: any) => data,
  } }
})

it('awaits an exact query and variables journal before each Shopify mutation and excludes reads', async () => {
  const captured: unknown[] = []
  const record = vi.fn(async request => { captured.push(structuredClone(request)); await Promise.resolve(); s.events.push('record') })
  await synchronizeContent('family', scope, await previewBody(), record)
  const mutations = s.graphql.mock.calls.filter(([query]) => query.includes('mutation ')).map(([query, variables]) => ({ query, variables }))
  expect(captured).toEqual(mutations)
  expect(captured).toHaveLength(2)
  expect(captured[0]).toMatchObject({ variables: { input: { title: 'Exact title', variants: [{ sku: 'SKU', price: '12.00' }] } } })
  expect(s.events).toEqual(['record', 'send', 'record', 'send'])
})

it('does not issue a mutation if its durable journal fails', async () => {
  const record = vi.fn(async () => { throw new Error('Journal unavailable') })
  await expect(synchronizeContent('family', scope, await previewBody(), record)).rejects.toThrow('Journal unavailable')
  expect(record).toHaveBeenCalledOnce()
  expect(s.events).toEqual([])
})

it('retains the first exact request and stops before a later unrecorded mutation', async () => {
  const captured: unknown[] = []
  const record = vi.fn(async request => { if (captured.length) throw new Error('Second journal failed'); captured.push(structuredClone(request)); s.events.push('record') })
  await expect(synchronizeContent('family', scope, await previewBody(), record)).rejects.toThrow('Second journal failed')
  expect(captured).toHaveLength(1)
  expect(s.events).toEqual(['record', 'send'])
})

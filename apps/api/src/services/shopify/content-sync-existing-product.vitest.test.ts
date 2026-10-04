/**
 * PE P4.0 — the full product publisher (`productSet`) rewrites a Shopify product as a whole: variants and options it
 * does not name are deleted. It may only do that to a product Nexus itself created. A store product the Owner linked
 * (target "linked-product", or a listing carrying another product's id) is refused before any Shopify mutation and
 * before the publication state is claimed. A category id (gid) sitting in the free-text product type is refused by name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({ row: {} as any, remote: null as any, tx: {} as any, graphql: vi.fn(), events: [] as string[],
  content: {} as { target?: string; publish?: Record<string, unknown>; externalIds?: (string | null)[]; productType?: string },
  inherited: { values: {}, problems: [], review: [] } as { values: Record<string, Record<string, string>>; problems: string[]; review: any[] },
  inheritedInput: null as any, published: null as any, drafts: [] as any[], applied: [] as any[] }))
vi.mock('./inherited-information.js', () => ({ noInheritedInformation: () => ({ values: {}, problems: [], review: [] }),
  resolveInheritedInformation: async (input: any) => { s.inheritedInput = input; return structuredClone(s.inherited) } }))
// Images rebuild P2f — not on the media plan: the older Shopify gallery paths run here.
vi.mock('../images/media-plan-switch.js', () => ({ isOnMediaPlan: async () => false, mediaPlanRevision: async () => null, mediaPlanProducts: async () => new Set() }))
vi.mock('../pim/publish-review-gate.js', () => ({ assertListingContentReviewed: async () => {} }))
vi.mock('../../db.js', () => ({ default: { $transaction: (fn: any) => fn(s.tx), channelListing: { findFirst: async () => s.row } } }))
vi.mock('../pim/channel-specs/shopify.js', () => ({ readShopifyMappingSchema: async () => ({ locales: [{ locale: 'en', primary: true, published: true }] }) }))
vi.mock('./linked-products-gateway.js', () => ({ readLinkedStoreSchema: async () => ({ locales: [{ locale: 'en', primary: true, published: true }] }) }))
vi.mock('./linked-state-guard.js', () => ({ shopifyInformationPublicationIssue: () => null }))
vi.mock('./listing-information-plan.js', () => ({ validateListingInformationOverrides: () => {}, listingInformationOverrideReview: () => [{ productId: 'child', label: 'Cost', type: 'money', locale: 'en', value: '9.00' }],
  // Stands in for the post-create check: one edit for each inherited value (as if Shopify had not kept it).
  listingInformationDraft: async (_g: any, input: any) => { s.drafts.push(input); return { edits: [], nativeEdits: Object.entries(input.inherited ?? {}).flatMap(([id, values]: [string, any]) =>
    Object.entries(values).map(([field, nextValue]) => ({ ownerId: input.variantIds[id], field, nextValue }))) } },
  listingInformationTranslations: async () => ({ edits: [], nativeEdits: [] }) }))
vi.mock('./linked-products.service.js', () => ({ buildLinkedPlan: async (_g: any, draft: any) => ({ changes: draft.edits, nativeEdits: draft.nativeEdits }), applyLinkedBatch: async () => {} }))
vi.mock('./information-gateway.js', () => ({ applyNativeEdit: async (_g: any, edit: any) => { s.applied.push(edit) } }))
vi.mock('./admin-client.js', () => ({ shopifyAdmin: async () => ({ domain: 'fixture.myshopify.com', graphql: s.graphql }) }))
vi.mock('./content-workspace.service.js', () => ({
  CONTENT_KEY: '_nexusContent', PUBLISH_KEY: '_nexusContentPublish', object: (v: any) => v && typeof v === 'object' ? v : {}, digest: (v: any) => JSON.stringify(v) ?? 'none',
  contentDestination: async () => ({ familyId: 'family', accountId: 'store', marketplace: 'GLOBAL', aliasKey: '' }),
  readContent: async () => {
    const listing = structuredClone(s.row), ids = s.content.externalIds ?? [null]
    return { family: { id: 'family', name: 'Product', categoryAttributes: { shopify_product_type: s.content.productType ?? 'Jacket' } },
      variants: [{ id: 'child', sku: 'SKU', options: {}, price: '1', stock: 0 }], listing,
      listings: ids.map((externalListingId, index) => ({ ...structuredClone(s.row), id: `listing-${index}`, externalListingId })),
      revision: 'revision', storedDocumentRevision: 'none', publish: s.content.publish ?? {},
      draft: { defaultLocale: 'en', locales: ['en'], fields: [], metaobjects: [], ...(s.content.target ? { target: s.content.target } : {}) }, errors: [] }
  },
  publicContent: (v: any) => ({ revision: v.revision, errors: v.errors, variants: v.variants }),
}))
vi.mock('@nexus/shared/shopify-content', () => ({ inspectShopifyContent: () => [], resolveShopifyContent: () => ({}) }))
vi.mock('./content-publisher.js', () => ({
  shortId: (gid: string) => gid.split('/').at(-1)!,
  readRemoteProduct: async () => s.remote && structuredClone(s.remote),
  publishContent: async (graphql: any, input: any, checkpoint: any) => {
    s.published = input
    await graphql('mutation Create($input:ProductSetInput!) { productSet(input:$input) { product { id } } }', { input: { title: 'Product' } })
    s.remote = { id: 'gid://shopify/Product/1', status: 'DRAFT' }
    await checkpoint({ productId: 'gid://shopify/Product/1' })
    return { productId: 'gid://shopify/Product/1', variantIds: { child: 'gid://shopify/ProductVariant/2', fresh: 'gid://shopify/ProductVariant/4' }, inventoryItemIds: { child: 'gid://shopify/InventoryItem/3' }, status: 'VERIFIED' }
  },
}))

import { previewContentSync, synchronizeContent } from './content-sync.service.js'
const scope = { accountId: 'store', market: 'GLOBAL' }
const body = async () => { const review = await previewContentSync('family', scope, true); return { expectedRevision: review.revision, expectedRemoteRevision: review.remoteRevision, locationId: 'location', confirmActive: true } }
const mutations = () => s.graphql.mock.calls.filter(([query]) => String(query).includes('mutation '))
const claimed = () => Boolean(s.row.platformAttributes?._nexusContentPublish)

beforeEach(() => {
  vi.clearAllMocks(); s.remote = null; s.events = []; s.content = {}
  s.inherited = { values: {}, problems: [], review: [] }; s.inheritedInput = null; s.published = null; s.drafts = []; s.applied = []
  s.row = { id: 'listing', productId: 'family', version: 1, platformAttributes: {}, followMasterTitle: true, followMasterDescription: true }
  s.graphql.mockImplementation(async () => ({ locations: { nodes: [{ id: 'location', isActive: true }], pageInfo: { hasNextPage: false } }, shopLocales: [{ locale: 'en', primary: true, published: true }] }))
  s.tx = { channelListing: {
    findUnique: async () => structuredClone(s.row), findUniqueOrThrow: async () => structuredClone(s.row), findFirst: async () => null,
    updateMany: async ({ where, data }: any) => { if (where.version !== s.row.version) return { count: 0 }; Object.assign(s.row, data, { version: s.row.version + 1 }); return { count: 1 } },
    update: async ({ data }: any) => { Object.assign(s.row, data, { version: s.row.version + 1 }); return s.row },
    create: async ({ data }: any) => data,
  } }
})

it('refuses the whole-product publisher for an existing linked store product: no mutation, no claim', async () => {
  s.content = { target: 'linked-product', externalIds: ['555'] }
  s.remote = { id: 'gid://shopify/Product/555', status: 'ACTIVE' }
  await expect(synchronizeContent('family', scope, await body())).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('not created by Nexus') })
  expect(mutations()).toEqual([])
  expect(claimed()).toBe(false)
})

it('refuses the linked-product target even when an earlier run recorded that store product as its own', async () => {
  s.content = { target: 'linked-product', publish: { productId: 'gid://shopify/Product/555' }, externalIds: ['555'] }
  s.remote = { id: 'gid://shopify/Product/555', status: 'ACTIVE' }
  await expect(synchronizeContent('family', scope, await body())).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('not created by Nexus') })
  expect(mutations()).toEqual([])
  expect(claimed()).toBe(false)
})

it('refuses when a family listing is linked to a store product Nexus did not create, even on a new-draft target', async () => {
  s.content = { externalIds: [null, '777'] }
  await expect(synchronizeContent('family', scope, await body())).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('not created by Nexus') })
  expect(mutations()).toEqual([])
  expect(claimed()).toBe(false)
})

it('refuses a Shopify category id stored in the free-text product type, by name', async () => {
  s.content = { productType: 'gid://shopify/TaxonomyCategory/aa-1-13' }
  await expect(synchronizeContent('family', scope, await body())).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining('product type holds a Shopify category id') })
  expect(mutations()).toEqual([])
  expect(claimed()).toBe(false)
})

it('still re-publishes a product Nexus created (its own recorded product id on every listing)', async () => {
  s.content = { publish: { productId: 'gid://shopify/Product/1', status: 'VERIFIED' }, externalIds: ['1', '1'] }
  s.remote = { id: 'gid://shopify/Product/1', status: 'DRAFT' }
  await synchronizeContent('family', scope, await body())
  expect(mutations()).toHaveLength(1)
})

it('still creates a brand-new draft when nothing is linked', async () => {
  await synchronizeContent('family', scope, await body())
  expect(mutations()).toHaveLength(1)
})

/* S1 item 5 (product sheet consistency) — a new variant takes barcode, cost, country, HS code and weight from Shared. */
describe('values a new variant takes from Shared', () => {
  const weight = '{"value":1.2,"unit":"KILOGRAMS"}'
  const inherited = (values: Record<string, Record<string, string>>, problems: string[] = []) => ({ values, problems,
    review: Object.entries(values).flatMap(([productId, fields]) => Object.entries(fields).map(([label, value]) => ({ productId, label, type: 'text', locale: 'en', value, shared: true }))) })

  it('lists them after the typed values, marked Shared, and makes them part of the reviewed revision', async () => {
    const before = await previewContentSync('family', scope, true)
    s.inherited = inherited({ child: { barcode: '0001', weight } })
    const review = await previewContentSync('family', scope, true)
    expect(review.informationOverrides).toEqual([expect.objectContaining({ label: 'Cost', value: '9.00' }),
      expect.objectContaining({ productId: 'child', label: 'barcode', value: '0001', shared: true }), expect.objectContaining({ label: 'weight', value: weight, shared: true })])
    expect(review.inheritedInformation).toEqual({ child: { barcode: '0001', weight } })
    expect(review.remoteRevision).not.toBe(before.remoteRevision)
    expect(s.inheritedInput).toMatchObject({ accountId: 'store', marketplace: 'GLOBAL', variants: [expect.objectContaining({ id: 'child', sku: 'SKU' })], remoteSkus: [] })
  })
  it('holds Publish with a value Shopify would refuse (SKU + label + reason): nothing is sent or claimed', async () => {
    s.inherited = inherited({}, ['SKU: Country of origin: Choose a two-letter country code.'])
    const review = await previewContentSync('family', scope, true)
    expect(review.errors).toContain('SKU: Country of origin: Choose a two-letter country code.')
    await expect(synchronizeContent('family', scope, await body())).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining('two-letter country code') })
    expect(mutations()).toEqual([])
    expect(claimed()).toBe(false)
  })
  it('a new product sends them inside the create, then checks each one with the typed values', async () => {
    s.inherited = inherited({ child: { barcode: '0001', weight } })
    await synchronizeContent('family', scope, await body())
    expect(s.published.variantFacts).toEqual({ child: { barcode: '0001', weight } })
    // The create's own draft (no reviewed draft existed) carries the check; there is no second check.
    expect(s.drafts.filter(d => d.inherited).map(d => d.inherited)).toEqual([{ child: { barcode: '0001', weight } }])
    expect(s.applied.map(e => [e.ownerId, e.field])).toEqual([['gid://shopify/ProductVariant/2', 'barcode'], ['gid://shopify/ProductVariant/2', 'weight']])
  })
  it('an existing product checks only the variants this run created, after Shopify created them', async () => {
    s.content = { publish: { productId: 'gid://shopify/Product/1', status: 'VERIFIED' }, externalIds: ['1'] }
    s.remote = { id: 'gid://shopify/Product/1', status: 'DRAFT', variants: { nodes: [{ id: 'gid://shopify/ProductVariant/2', sku: 'SKU' }] } }
    s.inherited = inherited({ child: { barcode: 'held' }, fresh: { barcode: '0002' } })
    await synchronizeContent('family', scope, await body())
    expect(s.inheritedInput.remoteSkus).toEqual(['SKU'])
    const check = s.drafts.find(d => d.inherited)
    expect(check).toMatchObject({ listings: [], inherited: { fresh: { barcode: '0002' } } })
    expect(s.applied.map(e => [e.ownerId, e.field, e.nextValue])).toEqual([['gid://shopify/ProductVariant/4', 'barcode', '0002']])
  })
})

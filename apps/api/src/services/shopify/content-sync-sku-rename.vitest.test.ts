/**
 * S10 (per-channel SKU, docs/sheet-ids-sku-rows/PLAN.md) — Shopify renames a variant's SKU IN PLACE. A variant whose
 * listing wants another SKU than the one Shopify holds:
 *   - the review names it ("Shopify renames OLD-A to NEW-A."), and the rename is part of the reviewed remote revision
 *     (a review with no rename keeps the revision it had);
 *   - the publisher is told the SKU Shopify holds for each variant (`liveSkus`), so it finds the variant by it and sends
 *     the new SKU on that variant's id;
 *   - after the verified read-back, each VARIANT row records the SKU Shopify read back as the SKU it holds
 *     (`liveChannelSku`); the family's main row (the product's content owner) never does.
 * Everything Shopify is stubbed; every id is invented.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({ rows: new Map<string, any>(), remote: null as any, published: null as any, updates: [] as any[], creates: [] as any[], tx: {} as any,
  variants: [] as any[], publish: {} as Record<string, unknown> }))
vi.mock('./create-status.js', () => ({ readShopifyCreateChoice: async () => ({ onShopify: true, target: 'active', status: 'ACTIVE' }) }))
vi.mock('./product-facts.js', () => ({ resolveShopifyProductFacts: async () => ({ vendor: 'Xavia', productType: 'Jacket', templateSuffix: '', review: [], problems: [] }) }))
vi.mock('../images/media-plan-switch.js', () => ({ isOnMediaPlan: async () => false, mediaPlanRevision: async () => null, mediaPlanProducts: async () => new Set() }))
vi.mock('../pim/publish-review-gate.js', () => ({ assertListingContentReviewed: async () => {} }))
vi.mock('../../db.js', () => ({ default: { $transaction: (fn: any) => fn(s.tx), channelListing: { findFirst: async () => s.rows.get('listing') } } }))
vi.mock('../pim/channel-specs/shopify.js', () => ({ readShopifyMappingSchema: async () => ({ locales: [{ locale: 'en', primary: true, published: true }] }) }))
vi.mock('./linked-products-gateway.js', () => ({ readLinkedStoreSchema: async () => ({ locales: [{ locale: 'en', primary: true, published: true }] }) }))
vi.mock('./linked-state-guard.js', () => ({ shopifyInformationPublicationIssue: () => null }))
vi.mock('./inherited-information.js', () => ({ noInheritedInformation: () => ({ values: {}, problems: [], review: [] }), resolveInheritedInformation: async () => ({ values: {}, problems: [], review: [] }) }))
vi.mock('./listing-information-plan.js', () => ({ validateListingInformationOverrides: () => {}, listingInformationOverrideReview: () => [],
  listingInformationDraft: async () => ({ edits: [], nativeEdits: [] }), listingInformationTranslations: async () => ({ edits: [], nativeEdits: [] }) }))
vi.mock('./linked-products.service.js', () => ({ buildLinkedPlan: async (_g: any, draft: any) => ({ changes: draft.edits, nativeEdits: draft.nativeEdits }), applyLinkedBatch: async () => {} }))
vi.mock('./information-gateway.js', () => ({ applyNativeEdit: async () => {} }))
vi.mock('./admin-client.js', () => ({ shopifyAdmin: async () => ({ domain: 'fixture.myshopify.com', graphql: async () => ({ locations: { nodes: [{ id: 'location', isActive: true }], pageInfo: { hasNextPage: false } }, shopLocales: [{ locale: 'en', primary: true, published: true }] }) }) }))
vi.mock('./content-workspace.service.js', () => ({
  CONTENT_KEY: '_nexusContent', PUBLISH_KEY: '_nexusContentPublish', object: (v: any) => v && typeof v === 'object' ? v : {}, digest: (v: any) => JSON.stringify(v) ?? 'none',
  contentDestination: async () => ({ familyId: 'family', accountId: 'store', marketplace: 'GLOBAL', aliasKey: '' }),
  readContent: async () => ({ family: { id: 'family', name: 'Jacket', categoryAttributes: {} }, variants: structuredClone(s.variants), listing: structuredClone(s.rows.get('listing')),
    listings: [...s.rows.values()].map(row => structuredClone(row)), revision: 'revision', storedDocumentRevision: 'none', publish: structuredClone(s.publish),
    draft: { defaultLocale: 'en', locales: ['en'], fields: [], metaobjects: [] }, errors: [] }),
  publicContent: (v: any) => ({ revision: v.revision, errors: v.errors, variants: v.variants }),
}))
vi.mock('@nexus/shared/shopify-content', () => ({ inspectShopifyContent: () => [], resolveShopifyContent: () => ({}) }))
vi.mock('./content-publisher.js', () => ({
  shortId: (gid: string) => gid.split('/').at(-1)!,
  readRemoteProduct: async () => s.remote && structuredClone(s.remote),
  // Stands in for the real publisher (content.vitest.test.ts covers its matching): Shopify renames the matched variants.
  publishContent: async (_g: any, input: any, checkpoint: any) => {
    s.published = input
    s.remote = { ...s.remote, variants: { nodes: s.remote.variants.nodes.map((node: any) => ({ ...node, sku: input.variants.find((v: any) => VARIANT_OF[v.id] === node.id)?.sku ?? node.sku })), pageInfo: { hasNextPage: false } } }
    await checkpoint({ productId: s.remote.id })
    return { productId: s.remote.id, variantIds: { ...VARIANT_OF }, inventoryItemIds: { 'child-a': 'gid://shopify/InventoryItem/11', 'child-b': 'gid://shopify/InventoryItem/12' }, status: 'VERIFIED' }
  },
}))
const VARIANT_OF: Record<string, string> = { 'child-a': 'gid://shopify/ProductVariant/1', 'child-b': 'gid://shopify/ProductVariant/2' }

import { previewContentSync, synchronizeContent } from './content-sync.service.js'

const scope = { accountId: 'store', market: 'GLOBAL' }
const live = { listingStatus: 'ACTIVE', isPublished: true, externalListingId: '9', syncPaused: false, platformAttributes: {}, version: 1 }

/** Child A sells as OLD-A on Shopify and now wants NEW-A (its own SKU); child B sends its product SKU as before. */
function seed(options: { renamed?: boolean; childBRow?: boolean } = {}) {
  const renamed = options.renamed ?? true
  s.rows = new Map<string, any>([
    ['listing', { id: 'listing', productId: 'family', ...live, followMasterTitle: true, followMasterDescription: true, product: { sku: 'FAMILY' } }],
    ['row-a', { id: 'row-a', productId: 'child-a', ...live, channelSku: renamed ? 'NEW-A' : null, liveChannelSku: 'OLD-A', product: { sku: 'OLD-A' } }],
  ])
  if (options.childBRow !== false) s.rows.set('row-b', { id: 'row-b', productId: 'child-b', ...live, product: { sku: 'B' } })
  s.variants = [{ id: 'child-a', sku: renamed ? 'NEW-A' : 'OLD-A', options: {}, price: '1', stock: 0 }, { id: 'child-b', sku: 'B', options: {}, price: '1', stock: 0 }]
  s.remote = { id: 'gid://shopify/Product/9', status: 'DRAFT', variants: { nodes: [{ id: VARIANT_OF['child-a'], sku: 'OLD-A' }, { id: VARIANT_OF['child-b'], sku: 'B' }], pageInfo: { hasNextPage: false } } }
}

beforeEach(() => {
  s.updates = []; s.creates = []; s.published = null
  s.publish = { productId: 'gid://shopify/Product/9' }
  seed()
  s.tx = { channelListing: {
    findUnique: async ({ where }: any) => structuredClone(s.rows.get(where.id)),
    findUniqueOrThrow: async ({ where }: any) => structuredClone(s.rows.get(where.id)),
    findFirst: async ({ where }: any) => structuredClone([...s.rows.values()].find(row => row.productId === where.productId) ?? null),
    updateMany: async ({ where, data }: any) => {
      const row = s.rows.get(where.id)
      if (!row || (where.version !== undefined && where.version !== row.version)) return { count: 0 }
      if (where.OR && data.liveChannelSku !== undefined && row.liveChannelSku === data.liveChannelSku) return { count: 0 }
      s.updates.push({ where, data }); Object.assign(row, data, where.version !== undefined ? { version: row.version + 1 } : {}); return { count: 1 }
    },
    update: async ({ where, data }: any) => { const row = s.rows.get(where.id); s.updates.push({ where, data }); Object.assign(row, data, { version: row.version + 1 }); return row },
    create: async ({ data }: any) => { s.creates.push(data); return data },
  } }
})

describe('S10 — the review names a rename in place', () => {
  it('"Shopify renames OLD-A to NEW-A." — the variant Shopify holds under OLD-A, and only that one', async () => {
    const review = await previewContentSync('family', scope, true)
    expect(review.changes.skuRenames).toEqual([{ productId: 'child-a', from: 'OLD-A', to: 'NEW-A', sentence: 'Shopify renames OLD-A to NEW-A.' }])
    expect(review.remoteRevision).toContain('skuRenames')
  })
  it('parity: nothing renamed → no sentence, and the reviewed revision is the one it was before S10', async () => {
    seed({ renamed: false })
    const review = await previewContentSync('family', scope, true)
    expect(review.changes.skuRenames).toEqual([])
    expect(review.remoteRevision).not.toContain('skuRenames')
  })
  it('a rename that appears after the review refuses the send ("changed after the preview")', async () => {
    seed({ renamed: false })
    const review = await previewContentSync('family', scope, true)
    seed({ renamed: true })
    await expect(synchronizeContent('family', scope, { expectedRevision: review.revision, expectedRemoteRevision: review.remoteRevision, locationId: 'location', confirmActive: true }))
      .rejects.toThrow('changed after the preview')
    expect(s.published).toBeNull()
  })
})

describe('S10 — the send renames in place and records what Shopify holds', () => {
  const send = async () => {
    const review = await previewContentSync('family', scope, true)
    return synchronizeContent('family', scope, { expectedRevision: review.revision, expectedRemoteRevision: review.remoteRevision, locationId: 'location', confirmActive: true })
  }
  it('the publisher is told the SKU Shopify holds for each variant (its live SKU)', async () => {
    expect((await send()).success).toBe(true)
    expect(s.published.liveSkus).toEqual({ 'child-a': 'OLD-A', 'child-b': 'B' })
    expect(s.published.variants.map((v: any) => [v.id, v.sku])).toEqual([['child-a', 'NEW-A'], ['child-b', 'B']])
  })
  it('each variant row records the SKU Shopify read back; the family main row never does', async () => {
    await send()
    expect(s.rows.get('row-a').liveChannelSku).toBe('NEW-A')
    // Child B already held as B: recorded (idempotent) as the SKU Shopify holds.
    expect(s.rows.get('row-b').liveChannelSku).toBe('B')
    expect(s.rows.get('listing').liveChannelSku).toBeUndefined()
    expect(s.updates.filter(update => update.where.id === 'listing' && 'liveChannelSku' in update.data)).toEqual([])
  })
  it('a variant row the send creates carries the SKU Shopify read back', async () => {
    seed({ childBRow: false })
    await send()
    expect(s.creates).toEqual([expect.objectContaining({ productId: 'child-b', liveChannelSku: 'B', platformAttributes: expect.objectContaining({ variantId: '2' }) })])
  })
  it('a still-draft row holds nothing on Shopify: no live SKU is passed for it (the SKU sent finds it, as before)', async () => {
    Object.assign(s.rows.get('row-b'), { listingStatus: 'DRAFT', isPublished: false, externalListingId: null })
    await send()
    expect(s.published.liveSkus).toEqual({ 'child-a': 'OLD-A' })
  })
})

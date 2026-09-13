import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { workspacePrisma } from '@nexus/database/workspace-router'
import { withWorkspace } from '@nexus/database/workspace-context'
import { describe, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({ db: null as any, parentId: '', childId: '', listingId: '', status: 'DRAFT', remoteWrites: 0 }))
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_t, key) => s.db[key] }) }))
vi.mock('../pim/publish-review-gate.js', () => ({ assertListingContentReviewed: async () => {} }))
vi.mock('../pim/channel-specs/shopify.js', () => ({ readShopifyMappingSchema: async () => ({ locales: [{ locale: 'en', primary: true, published: true }] }) }))
vi.mock('./linked-products-gateway.js', () => ({ readLinkedStoreSchema: async () => ({ locales: [{ locale: 'en', primary: true, published: true }], publications: [{ id: 'publication', name: 'Fixture storefront' }] }) }))
vi.mock('./linked-state-guard.js', () => ({ shopifyInformationPublicationIssue: () => null }))
vi.mock('./listing-information-plan.js', () => ({ validateListingInformationOverrides: () => {}, listingInformationOverrideReview: () => [], listingInformationDraft: async () => ({ edits: [], nativeEdits: [] }), listingInformationTranslations: async () => ({ edits: [], nativeEdits: [] }) }))
vi.mock('./linked-products.service.js', () => ({ buildLinkedPlan: async () => ({ changes: [], nativeEdits: [] }), applyLinkedBatch: async () => { throw new Error('Unexpected channel write') } }))
vi.mock('./information-gateway.js', () => ({ applyNativeEdit: async () => { throw new Error('Unexpected channel write') } }))
vi.mock('./information-publications.js', () => ({ readInformationPublications: async () => [{ publicationId: 'publication', publishDate: null }] }))
vi.mock('./admin-client.js', () => ({ shopifyAdmin: async () => ({ domain: 'fixture.invalid', graphql: async (query: string) => {
  if (/^\s*mutation/.test(query)) { s.remoteWrites++; throw new Error('Channel mutation forbidden in fixture') }
  return { locations: { nodes: [{ id: 'location', isActive: true }], pageInfo: { hasNextPage: false } }, shopLocales: [{ locale: 'en', primary: true, published: true }] }
} }) }))
vi.mock('./content-workspace.service.js', () => ({
  CONTENT_KEY: '_nexusContent', PUBLISH_KEY: '_nexusContentPublish', object: (v: any) => v && typeof v === 'object' ? v : {}, digest: (v: any) => JSON.stringify(v) ?? 'none',
  contentDestination: async () => ({ familyId: s.parentId, accountId: null, marketplace: 'GLOBAL', aliasKey: null }),
  readContent: async () => {
    const listing = await s.db.channelListing.findUniqueOrThrow({ where: { id: s.listingId } })
    return { family: { id: s.parentId, name: 'Fixture', categoryAttributes: {} },
      variants: [{ id: s.childId, sku: 'FIXTURE', options: {}, price: '1', stock: 0 }], listing, listings: [listing],
      revision: 'revision', storedDocumentRevision: 'none', publish: {},
      draft: { defaultLocale: 'en', locales: ['en'], fields: [], metaobjects: [] }, errors: [] }
  },
  publicContent: (v: any) => ({ revision: v.revision, errors: v.errors, variants: v.variants }),
}))
vi.mock('@nexus/shared/shopify-content', () => ({ inspectShopifyContent: () => [], resolveShopifyContent: () => ({}) }))
vi.mock('./content-publisher.js', () => ({
  readRemoteProduct: async () => ({ id: 'gid://shopify/Product/900000001', status: s.status }),
  publishContent: async () => ({ productId: 'gid://shopify/Product/900000001', variantIds: { [s.childId]: 'gid://shopify/ProductVariant/900000002' }, inventoryItemIds: { [s.childId]: 'gid://shopify/InventoryItem/900000003' }, status: 'VERIFIED' }),
}))
import { previewContentSync, synchronizeContent } from './content-sync.service.js'

/** Every write is inside a rolled-back LOCAL transaction; no row is exposed to cron. */
describe.runIf(process.env.PR4_LOCAL_DB_TESTS === '1')('SHOP-P2 / real local PostgreSQL read model', () => {
  it('persists ACTIVE → ARCHIVED → DRAFT remote controls as ACTIVE → INACTIVE → INACTIVE on parent and child', async () => {
    const url = new URL(process.env.DATABASE_URL!)
    expect(url.hostname).toBe('127.0.0.1'); expect(url.port).toBe('55439'); expect(url.pathname).toBe('/nexus_development')
    console.log(`PR.4 fixture DB host=${url.host}${url.pathname}`)
    const pool = new Pool({ connectionString: url.href, max: 2, connectionTimeoutMillis: 5_000 })
    const db = workspacePrisma(pool)
    const marker = `PR4-SHOP-${randomUUID()}`, rollback = new Error('PR4_FIXTURE_ROLLBACK')
    await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
      try {
        const identity = await db.$queryRaw<Array<{ db: string; role: string }>>`SELECT current_database()::text AS db, current_user::text AS role`
        expect(identity[0].db).toBe('nexus_development'); console.log('server identity', identity)
        const gale = await db.product.findFirstOrThrow({ where: { id: 'cmokmy3a40078pm0p1fvnu523', sku: 'GALE-JACKET' }, select: { familyId: true } })
        const productData = { sku: marker, name: marker, status: 'DRAFT', basePrice: 1, familyId: gale.familyId }
        const productWhere = { sku: { startsWith: marker } }
        expect(await db.product.count({ where: productWhere })).toBe(0)
        // Prove rollback before rehearsing the service's writes.
        await expect(db.$transaction(async tx => { await tx.product.create({ data: productData }); throw rollback })).rejects.toThrow(rollback)
        expect(await db.product.count({ where: productWhere })).toBe(0)
        await expect(db.$transaction(async tx => {
          const parent = await tx.product.create({ data: productData })
          const child = await tx.product.create({ data: { ...productData, sku: `${marker}-CHILD`, parentId: parent.id } })
          const listing = await tx.channelListing.create({ data: { productId: parent.id, channel: 'SHOPIFY', marketplace: 'GLOBAL', region: 'GLOBAL', channelMarket: 'SHOPIFY_GLOBAL', channelConnectionId: null, aliasKey: '', listingStatus: 'DRAFT', isPublished: false } })
          s.parentId = parent.id; s.childId = child.id; s.listingId = listing.id
          s.db = new Proxy(tx, { get: (target, key) => key === '$transaction' ? (fn: any) => fn(tx) : Reflect.get(target, key) })
          const versions = new Map<string, number>([[listing.id, listing.version]])
          for (const status of ['ACTIVE', 'ARCHIVED', 'DRAFT']) {
            s.status = status
            const preview = await previewContentSync(parent.id, { market: 'GLOBAL' }, true)
            await synchronizeContent(parent.id, { market: 'GLOBAL' }, { expectedRevision: preview.revision, expectedRemoteRevision: preview.remoteRevision, locationId: 'location', confirmActive: true })
            await delay(8_000)
            const stored = await tx.channelListing.findMany({ where: { productId: { in: [parent.id, child.id] } }, orderBy: { productId: 'asc' } })
            expect(stored).toHaveLength(2)
            for (const row of stored) {
              expect(row.version).toBeGreaterThan(versions.get(row.id) ?? 0)
              versions.set(row.id, row.version)
              expect(row.isPublished).toBe(status === 'ACTIVE')
              expect(row.listingStatus).toBe(status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE')
              expect(row.externalListingId).toBe('900000001')
              if (process.env.PR4_FACT_COLUMNS === '1') {
                expect((row as any).channelFact).toBe(status === 'ACTIVE' ? 'SELLING' : 'NOT_SELLING')
                expect((row as any).channelFactAt).toBeInstanceOf(Date)
                expect((row as any).channelFactVia).toBe('write-ack')
                expect((row as any).channelFactDetail.shopifyStatus).toBe(status)
              }
            }
            console.log(JSON.stringify({ remoteStatus: status, persisted: stored.map(row => ({ productId: row.productId, listingStatus: row.listingStatus, isPublished: row.isPublished, version: row.version })) }))
          }
          expect(s.remoteWrites).toBe(0)
          throw rollback
        }, { timeout: 60_000 })).rejects.toThrow(rollback)
        expect(await db.product.count({ where: productWhere })).toBe(0)
        expect(await db.channelListing.count({ where: { externalListingId: '900000001', product: productWhere } })).toBe(0)
        console.log('PR.4 fixture rolled back; sentinel products/listings 0; channel mutation calls 0')
      } finally { await db.$disconnect(); await pool.end() }
    })
  }, 90_000)
})

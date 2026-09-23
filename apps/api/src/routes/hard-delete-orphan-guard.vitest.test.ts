/**
 * 🔴 PLAN Step 1.2 — a hard delete must never orphan a live listing.
 *
 * THE DEFECT THIS GUARDS. `/products/bulk-hard-delete` deleted the local product and asked the
 * channel AFTERWARDS. Amazon and eBay refuse `unpublish`; Shopify refuses both actions. So the
 * product row vanished, the adapter refused, and the listing kept selling with nothing left to
 * manage it. It was the DEFAULT path: the modal preselects `unpublish` whenever a live listing
 * exists (`BulkActionBar.tsx` — `data.channelListings.length === 0 ? 'none' : 'unpublish'`), and
 * `channelAction` defaults to `'none'`, which sends nothing at all.
 *
 * Every refusal arm below is paired with a POSITIVE CONTROL that must still delete. A guard that
 * has only ever been seen refusing is indistinguishable from one that refuses everything.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const fetch = vi.fn(() => { throw new Error('Outbound channel request in a local route probe') })
  vi.stubGlobal('fetch', fetch)
  return {
    fetch,
    products: vi.fn(),
    listings: vi.fn(),
    audit: vi.fn(),
    deleteProducts: vi.fn(),
    deleteCache: vi.fn(),
    enqueue: vi.fn(),
  }
})

vi.mock('../lib/queue.js', () => ({ addJobSafely: async () => null, outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('../services/content-auto-publish.service.js', () => ({ enqueueContentSyncForProduct: vi.fn(), enqueueContentSyncIfEnabled: vi.fn() }))
vi.mock('../services/amazon/flat-file.service.js', () => ({ AmazonFlatFileService: class {}, MARKETPLACE_ID_MAP: {}, flatFileExportColumns: vi.fn(), filterHiddenManifestColumns: vi.fn(), normalizeVariationTheme: vi.fn() }))
vi.mock('../services/categories/schema-sync.service.js', () => ({ CategorySchemaService: class {} }))
vi.mock('../services/marketplaces/amazon.service.js', () => ({ AmazonService: class {} }))
vi.mock('../services/sync/etsy-sync.service.js', () => ({ EstySyncService: class {} }))
vi.mock('../utils/config.js', () => ({ ConfigManager: { getConfig: () => null } }))

// The cascade is stubbed at its OWN seam so this file tests the refusal, not the enqueue.
// `whereDelistTargets` keeps its real implementation — it is the shared predicate under test.
vi.mock('../services/outbound-enqueue.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/outbound-enqueue.js')>()),
  enqueueDelistCascade: mocks.enqueue,
  dispatchCommittedDelistRows: async () => ({ channelCascadeDispatched: 0, channelCascadePartial: false }),
}))

vi.mock('../db.js', () => {
  const tx = {
    product: { findMany: mocks.products, deleteMany: mocks.deleteProducts },
    productReadCache: { findMany: async () => [], deleteMany: mocks.deleteCache },
    auditLog: { createMany: mocks.audit },
    channelListing: { findMany: mocks.listings },
    productImage: { deleteMany: async () => ({ count: 0 }) },
    marketplaceSync: { deleteMany: async () => ({ count: 0 }) },
    listing: { deleteMany: async () => ({ count: 0 }) },
    stockLog: { deleteMany: async () => ({ count: 0 }) },
    fBAShipmentItem: { deleteMany: async () => ({ count: 0 }) },
    listingWizard: { deleteMany: async () => ({ count: 0 }) },
  }
  return { default: { ...tx, $transaction: async (work: (db: unknown) => unknown) => work(tx) } }
})

const { default: productsCatalogRoutes } = await import('./products-catalog.routes.js')

let app: FastifyInstance
beforeAll(async () => {
  vi.stubEnv('NEXUS_RBAC_MODE', '')
  delete process.env.NEXUS_RBAC_MODE
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '0')
  app = Fastify()
  app.addHook('onRequest', async request => {
    request.__sessionLoaded = true
    request.authUser = { id: 'operator', email: 'operator@example.test', name: 'Operator', roleKeys: [], permissionsVersion: 1 } as NonNullable<typeof request.authUser>
    request.__rbacResolved = { isOwner: true, permissions: new Set(['products.delete']) }
  })
  await app.register(productsCatalogRoutes, { prefix: '/api' })
  await app.ready()
})
afterAll(async () => { await app?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

const BIN_PRODUCT = { id: 'p-1', sku: 'SKU-1', name: 'In the bin', deletedAt: new Date() }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.products.mockResolvedValue([BIN_PRODUCT])
  mocks.listings.mockResolvedValue([])
  mocks.audit.mockResolvedValue({ count: 1 })
  mocks.deleteProducts.mockResolvedValue({ count: 1 })
  mocks.deleteCache.mockResolvedValue({ count: 1 })
  mocks.enqueue.mockResolvedValue({ entries: [], channelCascadeEnqueued: 0, channelSkipped: [] })
})

const live = (over: Record<string, unknown> = {}) => ({
  productId: 'p-1', channel: 'AMAZON', marketplace: 'IT', region: 'IT', externalListingId: 'B0LIVE', ...over,
})

const del = (channelAction?: 'none' | 'unpublish' | 'delete') =>
  app.inject({ method: 'POST', url: '/api/products/bulk-hard-delete', payload: { productIds: ['p-1'], ...(channelAction ? { channelAction } : {}) } })

// ── Refusals ──────────────────────────────────────────────────────
it('REFUSES the default action: nothing is sent, so the listing keeps selling', async () => {
  mocks.listings.mockResolvedValue([live()])
  const body = (await del()).json()            // no channelAction → 'none'
  expect(body.purged).toBe(0)
  expect(body.refused).toBe(1)
  expect(body.outcomes).toEqual([{ productId: 'p-1', sku: 'SKU-1', outcome: 'refused', reasons: [expect.any(String)] }])
  expect(body.outcomes[0].reasons[0]).toContain('AMAZON · IT')
  expect(body.outcomes[0].reasons[0]).toContain('B0LIVE')
  expect(body.outcomes[0].reasons[0]).toContain('nothing is sent')
  expect(mocks.deleteProducts).not.toHaveBeenCalled()
})

it.each([
  ['AMAZON', 'unpublish', 'reversible unpublish'],
  ['EBAY', 'unpublish', 'eBay unpublish is unavailable'],
  ['SHOPIFY', 'delete', 'Shopify delist is unavailable'],
  ['WOOCOMMERCE', 'delete', 'no delist adapter'],
] as const)('REFUSES %s + %s, naming why it would stay live', async (channel, action, phrase) => {
  mocks.listings.mockResolvedValue([live({ channel })])
  const body = (await del(action)).json()
  expect(body.refused).toBe(1)
  expect(body.purged).toBe(0)
  expect(body.outcomes[0].reasons[0]).toContain(phrase)
  expect(mocks.deleteProducts).not.toHaveBeenCalled()
})

it('names EVERY coordinate that would stay live, not just the first', async () => {
  mocks.listings.mockResolvedValue([live(), live({ channel: 'EBAY', marketplace: 'DE', externalListingId: '1234' })])
  const body = (await del('unpublish')).json()
  expect(body.outcomes[0].reasons).toHaveLength(2)
  expect(body.outcomes[0].reasons.join(' ')).toContain('B0LIVE')
  expect(body.outcomes[0].reasons.join(' ')).toContain('1234')
})

it('a refused product keeps its bin row AND its audit trail stays honest', async () => {
  mocks.listings.mockResolvedValue([live()])
  await del()
  // Its cache row must survive, or the bin UI loses a product that still exists.
  expect(mocks.deleteCache).toHaveBeenCalledWith({ where: { id: { in: [] } } })
  // No 'hard-delete' audit row may claim a deletion that did not happen.
  expect(mocks.audit).toHaveBeenCalledWith({ data: [] })
})

it('a refused product is never enqueued for a channel delist', async () => {
  mocks.listings.mockResolvedValue([live()])
  await del('unpublish')
  expect(mocks.enqueue).not.toHaveBeenCalled()
})

// ── Positive controls: these MUST still delete ────────────────────
it('positive control — no live listing, so the delete proceeds', async () => {
  mocks.listings.mockResolvedValue([])
  const body = (await del()).json()
  expect(body.purged).toBe(1)
  expect(body.refused).toBe(0)
  expect(body.outcomes).toEqual([{ productId: 'p-1', sku: 'SKU-1', outcome: 'deleted', reasons: [] }])
  expect(mocks.deleteProducts).toHaveBeenCalledWith({ where: { id: { in: ['p-1'] } } })
})

it.each([['AMAZON'], ['EBAY']] as const)('positive control — %s + delete CAN remove it, so the delete proceeds', async channel => {
  mocks.listings.mockResolvedValue([live({ channel })])
  const body = (await del('delete')).json()
  expect(body.purged).toBe(1)
  expect(body.refused).toBe(0)
  expect(mocks.enqueue).toHaveBeenCalled()
})

it('positive control — a listing with no external id is not a live listing', async () => {
  mocks.listings.mockResolvedValue([live({ externalListingId: null })])
  expect((await del()).json().purged).toBe(1)
})

// ── 15.10: outcomes, not a throw ──────────────────────────────────
it('a mixed batch reports BOTH sides — the refusal does not lose the other rows', async () => {
  mocks.products.mockResolvedValue([
    BIN_PRODUCT,
    { id: 'p-2', sku: 'SKU-2', name: 'Clean', deletedAt: new Date() },
    { id: 'p-3', sku: 'SKU-3', name: 'Also clean', deletedAt: new Date() },
  ])
  mocks.listings.mockResolvedValue([live()])
  mocks.deleteProducts.mockResolvedValue({ count: 2 })
  const body = (await del()).json()
  expect(body.purged).toBe(2)
  expect(body.refused).toBe(1)
  expect(body.outcomes.filter((o: { outcome: string }) => o.outcome === 'deleted').map((o: { productId: string }) => o.productId)).toEqual(['p-2', 'p-3'])
  expect(body.outcomes.find((o: { outcome: string }) => o.outcome === 'refused').productId).toBe('p-1')
  // The clean rows are deleted; the refused one is not.
  expect(mocks.deleteProducts).toHaveBeenCalledWith({ where: { id: { in: ['p-2', 'p-3'] } } })
})

import Fastify, { type FastifyInstance, type HTTPMethods } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const fetch = vi.fn(() => { throw new Error('Outbound channel request in local route probe') })
  vi.stubGlobal('fetch', fetch)
  return { fetch, update: vi.fn(), audit: vi.fn(), recover: vi.fn(), preview: vi.fn(), listings: vi.fn(), remove: vi.fn() }
})
vi.mock('../lib/queue.js', () => ({ addJobSafely: async () => null, outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('../services/content-auto-publish.service.js', () => ({ enqueueContentSyncForProduct: vi.fn(), enqueueContentSyncIfEnabled: vi.fn() }))
vi.mock('../services/amazon/flat-file.service.js', () => ({ AmazonFlatFileService: class {}, MARKETPLACE_ID_MAP: {}, flatFileExportColumns: vi.fn(), filterHiddenManifestColumns: vi.fn(), normalizeVariationTheme: vi.fn() }))
vi.mock('../services/categories/schema-sync.service.js', () => ({ CategorySchemaService: class {} }))
vi.mock('../services/marketplaces/amazon.service.js', () => ({ AmazonService: class {} }))
vi.mock('../services/amazon/amazon-flat-file-remove.service.js', () => ({ removeAmazonListing: mocks.remove }))
vi.mock('../services/sync/etsy-sync.service.js', () => ({ EstySyncService: class {} }))
vi.mock('../utils/config.js', () => ({ ConfigManager: { getConfig: () => null } }))
vi.mock('../services/listings/recovery.service.js', () => ({ executeRecovery: mocks.recover, previewRecovery: mocks.preview }))
vi.mock('../db.js', () => {
  const tx = {
    product: { findMany: async () => [] },
    productReadCache: { findMany: async () => [{ id: 'ghost', sku: 'PR1-GHOST', name: 'Ghost' }], deleteMany: async () => ({ count: 1 }) },
    auditLog: { createMany: mocks.audit },
  }
  return { default: {
    ...tx, $transaction: async (work: (db: unknown) => unknown) => work(tx),
    channelListing: { update: mocks.update, findMany: mocks.listings },
    orderItem: { findMany: async () => [] },
    bundle: { findMany: async () => [] },
    bundleComponent: { findMany: async () => [] },
    fbaInventoryDetail: { findMany: async () => [] },
    listingRecoveryEvent: { findMany: async () => [] },
  } }
})

import { rbacHook } from '../lib/auth/rbac-hook.js'
import productsCatalogRoutes from './products-catalog.routes.js'
import { matrixRoutes } from './matrix.routes.js'
import { estyRoutes } from './etsy.js'
import listingRecoveryRoutes from './listing-recovery.routes.js'
import amazonFlatFileRoutes from './amazon-flat-file.routes.js'

let app: FastifyInstance
beforeAll(async () => {
  vi.stubEnv('NEXUS_RBAC_MODE', '')
  delete process.env.NEXUS_RBAC_MODE
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '0')
  app = Fastify()
  app.addHook('onRequest', async request => {
    request.__sessionLoaded = true
    if (request.headers['x-test-user']) request.authUser = {
      id: String(request.headers['x-test-user']), email: 'operator@example.test', name: 'Operator',
      roleKeys: [], permissionsVersion: 1,
    } as NonNullable<typeof request.authUser>
    request.__rbacResolved = { isOwner: false, permissions: new Set(String(request.headers['x-test-permission'] ?? '').split(',')) }
    if (request.headers['x-test-key']) request.apiKey = { id: 'key', label: 'key', scopes: ['products:write'] }
  })
  app.addHook('preHandler', rbacHook)
  await app.register(productsCatalogRoutes, { prefix: '/api' })
  await app.register(amazonFlatFileRoutes, { prefix: '/api' })
  await app.register(listingRecoveryRoutes, { prefix: '/api' })
  await app.register(matrixRoutes)
  await app.register(estyRoutes)
  await app.ready()
})
afterAll(async () => { await app?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.update.mockResolvedValue({ id: 'listing' })
  mocks.preview.mockResolvedValue({ allowed: true })
  mocks.recover.mockResolvedValue({ eventId: 'event' })
  mocks.listings.mockResolvedValue([])
  mocks.remove.mockResolvedValue({ channelListingsRemoved: 0, delisted: false })
})

const routes: Array<[HTTPMethods, string, string, number]> = [
  ['POST', '/api/amazon/flat-file/remove', 'products.delete', 200],
  ['POST', '/api/products/bulk-hard-delete', 'products.delete', 400],
  ['POST', '/api/products/operational-impact', 'products.view', 400],
  ['PUT', '/api/products/product/matrix/channel-listing/listing', 'products.edit', 200],
  ['POST', '/api/products/product/recover', 'products.delete', 400],
  ['POST', '/api/products/product/recover/preview', 'products.view', 400],
  ['GET', '/api/products/product/recover/events', 'products.view', 200],
  ['POST', '/etsy/sync/listings', 'products.edit', 400],
  ['POST', '/etsy/sync/inventory/from-etsy', 'inventory.adjust', 400],
  ['POST', '/etsy/sync/orders', 'orders.edit', 400],
  ['POST', '/etsy/orders/order/status', 'products.publish', 400],
  ['POST', '/etsy/orders/order/fulfillment', 'products.publish', 400],
]
describe('Presence W0 explicit route guards with NEXUS_RBAC_MODE unset', () => {
  it.each(routes)('%s %s refuses without %s and passes the guard with it', async (method, url, permission, status) => {
    expect(process.env.NEXUS_RBAC_MODE).toBeUndefined()
    const payload = method === 'GET' ? undefined : {}
    for (const headers of [{}, { 'x-test-user': 'session-user', 'x-test-permission': 'pages.dashboard' }]) {
      const denied = await app.inject({ method, url, payload, headers })
      expect(denied.statusCode, denied.body).toBe(403)
    }
    const allowed = await app.inject({ method, url, payload, headers: { 'x-test-user': 'session-user', 'x-test-permission': permission } })
    expect(allowed.statusCode, allowed.body).toBe(status)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['POST', '/etsy/sync/inventory/to-etsy'],
    ['POST', '/api/products/product/matrix/offer'],
    ['PUT', '/api/products/product/matrix/offer/offer'],
    ['DELETE', '/api/products/product/matrix/offer/offer'],
  ] as const)('retired %s %s is unregistered', async (method, url) => {
    const res = await app.inject({ method, url, payload: {}, headers: { 'x-test-user': 'session-user', 'x-test-permission': 'products.publish,products.edit,products.delete' } })
    expect(res.statusCode, res.body).toBe(404)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('a coarse API-key family grant cannot replace the session actor', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/products/bulk-hard-delete', payload: {}, headers: { 'x-test-key': 'yes', 'x-test-permission': 'products.delete' } })
    expect(res.statusCode).toBe(403)
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('the guarded hard-delete audit records the session user on the surviving ghost-cache row', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/products/bulk-hard-delete', payload: { productIds: ['ghost'] }, headers: { 'x-test-user': 'session-user', 'x-test-permission': 'products.delete' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ data: [expect.objectContaining({ userId: 'session-user', action: 'hard-delete-ghost-cache' })] }))
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('default-user')
  })

  it('recovery passes the session actor to its audit-writing service', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/products/product/recover', payload: { channel: 'AMAZON', marketplace: 'IT', channelConnectionId: null, aliasKey: '', action: 'REPUBLISH_IN_PLACE' }, headers: { 'x-test-user': 'session-user', 'x-test-permission': 'products.delete' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(mocks.recover).toHaveBeenCalledWith(expect.objectContaining({ initiatedBy: 'session-user', channelConnectionId: null, aliasKey: '' }))
  })

  it('recovery preview forwards an attributed account and alias without broadening', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/products/product/recover/preview', payload: {
      channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account-b', aliasKey: 'alias-b', action: 'REPUBLISH_IN_PLACE',
    }, headers: { 'x-test-user': 'session-user', 'x-test-permission': 'products.view' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(mocks.preview).toHaveBeenCalledWith(expect.objectContaining({ productId: 'product', channelConnectionId: 'account-b', aliasKey: 'alias-b' }))
  })

  it('Amazon removal preserves its explicit coordinate and overwrites a body actor with the session user', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/amazon/flat-file/remove', payload: { targets: [
      { productId: 'product', marketplace: 'IT', channelConnectionId: 'account-b', aliasKey: 'alias-b', actor: 'forged-user' },
    ] }, headers: { 'x-test-user': 'session-user', 'x-test-permission': 'products.delete' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(mocks.remove.mock.calls[0][1]).toEqual({ productId: 'product', marketplace: 'IT', channelConnectionId: 'account-b', aliasKey: 'alias-b', actor: 'session-user' })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('matrix update scopes a supplied listing id to the route product', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/products/product/matrix/channel-listing/listing', payload: { externalListingId: 'identity' }, headers: { 'x-test-user': 'session-user', 'x-test-permission': 'products.edit' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'listing', productId: 'product' } }))
  })

  it('operational-impact is a read-only POST with an actual service response', async () => {
    const headers = { 'x-test-user': 'session-user', 'x-test-permission': 'products.view' }
    const payload = { verb: 'hard-delete', targets: [{ productId: 'product' }] }
    const result = await app.inject({ method: 'POST', url: '/api/products/operational-impact', headers, payload })
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json()).toMatchObject({ targets: [{ target: { productId: 'product' }, checks: {
      channelListings: { status: 'ok', rows: [] }, openOrders: { status: 'ok' }, stockHolds: { status: 'unavailable', blocking: false }, advertising: { status: 'unavailable', blocking: false },
    } }] })
    const incomplete = await app.inject({ method: 'POST', url: '/api/products/operational-impact', headers,
      payload: { verb: 'hold', targets: [{ productId: 'product', channel: 'EBAY', marketplace: 'IT', aliasKey: '' }] } })
    expect(incomplete.statusCode, incomplete.body).toBe(400)
    expect(incomplete.json().refusal).toContain('channelConnectionId')
    expect(mocks.audit).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('preflight shares selling risk without widening the legacy database predicate', async () => {
    const held = { productId: 'product', channel: 'EBAY', marketplace: 'IT', region: 'IT', externalListingId: '257584954808', channelConnectionId: null, aliasKey: '' }
    mocks.listings.mockResolvedValue([{ ...held, externalListingId: '  ' }, held])
    const res = await app.inject({ method: 'GET', url: '/api/products/hard-delete-preflight?ids=product',
      headers: { 'x-test-user': 'session-user', 'x-test-permission': 'products.view' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(mocks.listings).toHaveBeenCalledWith(expect.objectContaining({ where: {
      productId: { in: ['product'] }, listingStatus: { in: ['ACTIVE', 'INACTIVE'] }, externalListingId: { not: null },
    } }))
    expect(res.json().channelListings).toEqual([{ productId: 'product', channel: 'EBAY', marketplace: 'IT', externalListingId: held.externalListingId }])
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})

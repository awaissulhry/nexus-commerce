import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
const s = vi.hoisted(() => ({ listings: vi.fn(async () => [{ id: 'one', channel: 'AMAZON', marketplace: 'IT' }, { id: 'two', channel: 'EBAY', marketplace: 'IT' }]) }))
vi.mock('../db.js', () => ({ default: { channelListing: { findMany: s.listings } } }))
vi.mock('../services/marketplaces/amazon.service.js', () => ({ AmazonService: class {} }))
vi.mock('../services/listing-activation-sync.service.js', () => ({ syncActivatedListings: vi.fn() }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: {}, addJobSafely: vi.fn() }))
import routes from './marketplaces.routes.js'
it('all-listings explicitly enforces products.view and preserves grouped response', async () => {
  vi.stubEnv('NEXUS_RBAC_MODE', '')
  const app = Fastify()
  app.addHook('onRequest', async req => {
    req.__sessionLoaded = true
    if (req.headers['x-test-user']) req.authUser = { id: 'user', email: 'pr3@example.test', name: 'PR3', roleKeys: [], permissionsVersion: 1 } as any
    req.__rbacResolved = { isOwner: false, permissions: new Set(String(req.headers['x-test-permission'] ?? '').split(',')) }
  })
  await app.register(routes)
  try {
    for (const headers of [{}, { 'x-test-user': 'yes', 'x-test-permission': 'products.edit' }]) {
      const r = await app.inject({ method: 'GET', url: '/products/p/all-listings', headers })
      expect(r.statusCode, r.body).toBe(403)
    }
    expect(s.listings).not.toHaveBeenCalled()
    const allowed = await app.inject({ method: 'GET', url: '/products/p/all-listings', headers: { 'x-test-user': 'yes', 'x-test-permission': 'products.view' } })
    expect(allowed.statusCode, allowed.body).toBe(200)
    expect(allowed.json()).toEqual({ AMAZON: [{ id: 'one', channel: 'AMAZON', marketplace: 'IT' }], EBAY: [{ id: 'two', channel: 'EBAY', marketplace: 'IT' }] })
  } finally { await app.close(); vi.unstubAllEnvs() }
})

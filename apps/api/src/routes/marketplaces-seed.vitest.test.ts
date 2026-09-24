import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { withWorkspace } from '../lib/workspace-context.js'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'

/**
 * A-53 — the market routes on a real PostgreSQL (PGlite), through the business's own scope, as production
 * runs them: the global workspace preHandler enters the request's business with `withWorkspace(scope, done)`
 * (`lib/workspace-hook.ts`) when profiles are ON, and the database falls back to the legacy business when OFF.
 *
 * The first arm is the REPRODUCTION and must match production (MV1's `rls.cjs`, 2026-09-24): a business with no
 * market rows gets a grouped response holding only `_meta` — the read SUCCEEDS, empty.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../services/marketplaces/amazon.service.js', () => ({ AmazonService: class { async isConfigured() { return false } } }))
vi.mock('../services/listing-activation-sync.service.js', () => ({ syncActivatedListings: vi.fn() }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: {}, addJobSafely: vi.fn() }))

const business = (id: string) => state.db.db.query(
  `INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
const count = async (workspaceId: string) => (await state.db.db.query(`SELECT count(*)::int AS n FROM "Marketplace" WHERE "workspaceId" = $1`, [workspaceId])).rows[0].n as number
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })

describe('A-53 market routes, inside the request’s business', () => {
  let app: FastifyInstance
  const call = (method: 'GET' | 'POST', url: string, workspaceId?: string, payload?: unknown) =>
    app.inject({ method, url, ...(workspaceId ? { headers: { 'x-test-business': workspaceId } } : {}), ...(payload ? { payload } : {}) })

  beforeAll(async () => {
    const { default: routes } = await import('./marketplaces.routes.js')
    app = Fastify()
    app.addHook('preHandler', (request, _reply, done) => {
      if (process.env.NEXUS_WORKSPACES_ENABLED !== '1') { done(); return }
      withWorkspace(scope(String(request.headers['x-test-business'])), done)
    })
    await app.register(routes)
    await app.ready()
    for (const id of ['EMPTY', 'PARTIAL', 'OTHER']) await business(id)
  }, 120_000)
  afterAll(async () => { await app?.close(); await state.db?.close() }, 30_000)

  it('keeps the seed behind channels.sync and the read behind listings.view', () => {
    expect(permissionForRoute('POST', '/api/marketplaces/seed')).toBe('channels.sync')
    expect(permissionForRoute('GET', '/api/marketplaces/grouped')).toBe('listings.view')
  })

  it('REPRODUCTION: a business with no market rows reads 200 with only `_meta` (Motovento, production 2026-09-24)', async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    try {
      const response = await call('GET', '/marketplaces/grouped', 'EMPTY')
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json()).toEqual({ _meta: { primaryLanguage: 'it' } })
    } finally { vi.unstubAllEnvs() }
  })

  it('seeds create-only: 20 the first time, 0 the second, and never another business', async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    try {
      const first = await call('POST', '/marketplaces/seed', 'EMPTY')
      expect(first.statusCode, first.body).toBe(200)
      expect(first.json()).toEqual({ success: true, created: 20, total: 20 })
      const again = await call('POST', '/marketplaces/seed', 'EMPTY')
      expect(again.json()).toEqual({ success: true, created: 0, total: 20 })
      expect(await count('OTHER')).toBe(0)

      const grouped = (await call('GET', '/marketplaces/grouped', 'EMPTY')).json()
      expect(Object.keys(grouped).sort()).toEqual(['AMAZON', 'EBAY', 'ETSY', 'SHOPIFY', 'WOOCOMMERCE', '_meta'])
      expect(grouped.AMAZON.map((m: { code: string }) => m.code)).not.toContain('US')
      expect(grouped.EBAY.find((m: { code: string }) => m.code === 'IT')).toMatchObject({ vatRate: '22', taxInclusive: true, languages: ['it'] })
    } finally { vi.unstubAllEnvs() }
  })

  it('never rewrites a market the business already has (the old route upserted name, ids, region and currency)', async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    try {
      await withWorkspace(scope('PARTIAL'), () => state.db.client.marketplace.create({ data: {
        channel: 'EBAY', code: 'IT', name: 'eBay Italia (own)', marketplaceId: 'EBAY_IT', region: 'EU', currency: 'EUR',
        language: 'it', languages: ['it', 'en'], domainUrl: 'ebay.it', vatRate: '10.00', taxInclusive: true,
      } }))
      const response = await call('POST', '/marketplaces/seed', 'PARTIAL')
      expect(response.json()).toEqual({ success: true, created: 19, total: 20 })
      const own = await withWorkspace(scope('PARTIAL'), () => state.db.client.marketplace.findFirst({ where: { channel: 'EBAY', code: 'IT' } }))
      expect(own).toMatchObject({ name: 'eBay Italia (own)', languages: ['it', 'en'] })
      expect(Number(own.vatRate)).toBe(10)
    } finally { vi.unstubAllEnvs() }
  })

  it('with profiles OFF, seeds the legacy business', async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '0')
    try {
      const response = await call('POST', '/marketplaces/seed')
      expect(response.json()).toMatchObject({ success: true, created: 20 })
      expect(await count('nexus_legacy_workspace')).toBe(20)
    } finally { vi.unstubAllEnvs() }
  })

  it('the publish preflight asks the business’s own market table, as the publish route does', async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    try {
      const product = await withWorkspace(scope('EMPTY'), () => state.db.client.product.create({ data: { sku: 'A53-PREFLIGHT', name: 'Preflight jacket', basePrice: 100 } }))
      const issues = async (marketplace: string) => {
        const response = await call('POST', `/products/${product.id}/publish-preflight`, 'EMPTY', { coordinates: [{ channel: 'AMAZON', marketplace }] })
        expect(response.statusCode, response.body).toBe(200)
        return response.json().coordinates[0].issues.map((i: { message: string }) => i.message) as string[]
      }
      // Amazon BE is in this business's table: mapped (the old 17-row list said "not mapped").
      expect(await issues('BE')).not.toContain('No marketplace mapping for AMAZON/BE')
      // A row with no marketplace id is not mapped, whatever a static list says (the old list said IT was).
      await withWorkspace(scope('EMPTY'), () => state.db.client.marketplace.updateMany({ where: { channel: 'AMAZON', code: 'IT' }, data: { marketplaceId: null } }))
      expect(await issues('IT')).toContain('No marketplace mapping for AMAZON/IT')
    } finally { vi.unstubAllEnvs() }
  })
})

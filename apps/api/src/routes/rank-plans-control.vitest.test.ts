/**
 * OC (2026-10-06) — the old Rank Control page is gone; the product rank plans it made keep the controls a person needs
 * over one that may still run. The Hourly Bids page's "Product rank plans" section reads the list, switches a plan on
 * or off (PATCH enabled) and puts Top-of-search back (revert). Those three routes stay and work; the plan routes
 * nothing calls any more (create, read one, delete, family, run-now, apply-across, copy-schedule) are gone.
 *
 * PGlite with the production schema and the real advertising routes. The family and the placement write are
 * recorders: what the revert route does with them is the subject, not Amazon.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: null,
  }
})
vi.mock('../services/advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))
vi.mock('../services/advertising/ads-dayparting-refresh.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProductFamily: async () => ({
    marketplace: 'IT', parentProductId: 'fam-parent', parentName: 'Family', productIds: [], asins: [], skus: [],
    campaigns: [{ id: 'fam-c1' }, { id: 'fam-c2' }, { id: 'fam-c3' }],
  }),
}))
const placements = vi.hoisted(() => ({ calls: [] as Array<[string, number]> }))
vi.mock('../services/advertising/ads-top-of-search.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyTopOfSearch: async (campaignId: string, pct: number) => { placements.calls.push([campaignId, pct]); return { ok: true } },
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
let app: FastifyInstance

const call = async (method: 'GET' | 'PATCH' | 'POST' | 'DELETE', url: string, payload?: object) => {
  const res = await app.inject({ method, url: `/api${url}`, ...(payload ? { payload } : {}) })
  return { status: res.statusCode, body: res.json() as Record<string, unknown> }
}

beforeAll(async () => {
  database = await formulaDatabase()
  const { default: advertisingRoutes } = await import('./advertising.routes.js')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
  await inside(() => database.client.productRankPlan.create({
    data: { id: 'plan-1', productId: 'fam-parent', marketplace: 'IT', enabled: true, excludeCampaignIds: ['fam-c3'] } as never,
  }))
}, 180_000)
afterAll(async () => { await app?.close(); await database?.close() })

describe('the product rank plan controls on Hourly Bids reach working routes', () => {
  it('lists the plans', async () => {
    const r = await call('GET', '/advertising/rank-plans')
    expect(r.status).toBe(200)
    expect((r.body.items as Array<{ id: string; enabled: boolean }>).map((p) => [p.id, p.enabled])).toEqual([['plan-1', true]])
  })

  it('"Switch off" stops the plan and stamps when; "Switch on" starts it again', async () => {
    const off = await call('PATCH', '/advertising/rank-plans/plan-1', { enabled: false })
    expect(off.status).toBe(200)
    expect(off.body.enabled).toBe(false)
    expect(off.body.pausedAt).toBeTruthy()
    const row = await inside(() => database.client.productRankPlan.findUnique({ where: { id: 'plan-1' } }))
    expect(row?.enabled).toBe(false)

    const on = await call('PATCH', '/advertising/rank-plans/plan-1', { enabled: true })
    expect([on.status, on.body.enabled]).toEqual([200, true])
  })

  it('a plan that is gone answers 404, which the page shows as "Nothing changed"', async () => {
    const r = await call('PATCH', '/advertising/rank-plans/no-such-plan', { enabled: false })
    expect(r.status).toBe(404)
  })

  it('"Put placement back" sets Top-of-search to the baseline on the campaigns the plan holds, not the excluded one', async () => {
    placements.calls = []
    const r = await call('POST', '/advertising/rank-plans/plan-1/revert', {})
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, reverted: 2, toPct: 0, campaigns: 2 })
    expect(placements.calls).toEqual([['fam-c1', 0], ['fam-c2', 0]])
  })

  it.each([
    ['POST', '/advertising/rank-plans'],
    ['GET', '/advertising/rank-plans/plan-1'],
    ['DELETE', '/advertising/rank-plans/plan-1'],
    ['GET', '/advertising/rank-plans/plan-1/family'],
    ['POST', '/advertising/rank-plans/plan-1/run-now'],
    ['POST', '/advertising/rank-plans/plan-1/apply-across'],
    ['POST', '/advertising/rank-plans/copy-schedule'],
  ] as const)('%s %s is gone with the old Rank Control page', async (method, url) => {
    const r = await app.inject({ method, url: `/api${url}`, ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }) })
    expect(r.statusCode).toBe(404)
  })
})

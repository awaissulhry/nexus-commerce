/**
 * Campaign manager 1f — the campaign detail and ad-group pages read every row and save the real settings.
 *
 * CM-24: the ad-group read returned the first 200 targets in no order (positives and negatives mixed) and the
 *        campaign read counted at most 100 per ad group. Now every target, positives first in a stable order, with
 *        the true total; and a per-group count of positive targets with no cap.
 * CM-12: Min/Max Bid saved from the detail page goes through `/guardrails`, which no longer writes back its own copy
 *        of `dynamicBidding` on a bounds-only call (that copy put back a Target ACoS saved at the same moment).
 * CM-21: `GET /advertising/portfolios?marketplace=` lists stored portfolios only under their own profile's market.
 *
 * On a real PostgreSQL (PGlite) with the real advertising routes. Amazon is a stub; fake ids only.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../services/advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))
// Live mode with a stub list per profile: the IT profile's live read answers, the DE profile's fails.
vi.mock('../services/advertising/ads-api-client.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  adsMode: () => 'live',
  listPortfolios: async (ctx: { profileId: string }) => {
    if (ctx.profileId === 'P-DE-TEST') throw new Error('stub: DE read failed')
    return ctx.profileId === 'P-IT-TEST' ? [{ portfolioId: '1001', name: 'Jackets IT' }] : []
  },
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const db = () => database.client as any
let app: FastifyInstance

async function adGroupWith(id: string, campaignId: string, positives: number, negatives: number) {
  await db().adGroup.create({ data: { id, campaignId, name: id, defaultBidCents: 40 } })
  const base = Date.parse('2026-01-01T00:00:00Z')
  // Negatives are written FIRST, so "positives first" in the answer is the read's order, not insertion order.
  const rows = [
    ...Array.from({ length: negatives }, (_, i) => ({ id: `${id}-n${String(i).padStart(4, '0')}`, isNegative: true, i })),
    ...Array.from({ length: positives }, (_, i) => ({ id: `${id}-p${String(i).padStart(4, '0')}`, isNegative: false, i })),
  ]
  await db().adTarget.createMany({
    data: rows.map((r) => ({
      id: r.id, adGroupId: id, kind: 'KEYWORD', expressionType: r.isNegative ? 'NEGATIVE_EXACT' : 'EXACT',
      expressionValue: `${r.id} text`, bidCents: r.isNegative ? 0 : 35, isNegative: r.isNegative,
      createdAt: new Date(base + r.i * 1000),
    })),
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  const { default: advertisingRoutes } = await import('./advertising.routes.js')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
  await withWorkspace(business, async () => {
    await db().campaign.create({
      data: {
        id: 'c-1f', name: 'Detail reads', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'),
        marketplace: 'IT', externalCampaignId: 'EXT-c-1f', dynamicBidding: { targetAcos: 0.25, bidAlgorithm: 'TARGET_ACOS', maxBidChangePct: 30 },
      },
    })
    await adGroupWith('g-big', 'c-1f', 250, 30)
    await adGroupWith('g-small', 'c-1f', 3, 1)
    await db().amazonAdsConnection.create({ data: { profileId: 'P-IT-TEST', marketplace: 'IT', region: 'EU', isActive: true } })
    await db().amazonAdsConnection.create({ data: { profileId: 'P-DE-TEST', marketplace: 'DE', region: 'EU', isActive: true } })
    await db().amazonAdsPortfolio.create({ data: { profileId: 'P-DE-TEST', externalPortfolioId: '2001', name: 'Jackets DE' } })
    await db().amazonAdsPortfolio.create({ data: { profileId: 'local-FR', externalPortfolioId: 'local-pf-local-FR-boots', name: 'Boots FR' } })
  })
}, 180_000)
afterAll(async () => { await app?.close(); await database?.close() })

describe('CM-24 — every target, in order, with the true counts', () => {
  it('the campaign read counts each group\'s positive targets with no cap, and no longer ships 100 rows a group', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/advertising/campaigns/c-1f' })
    expect(res.statusCode).toBe(200)
    const groups = (res.json() as { campaign: { adGroups: Array<Record<string, unknown>> } }).campaign.adGroups
    const byId = Object.fromEntries(groups.map((g) => [g.id as string, g]))
    expect(byId['g-big']).toMatchObject({ targetCount: 250 })
    expect(byId['g-small']).toMatchObject({ targetCount: 3 })
    expect(byId['g-big']).not.toHaveProperty('targets')
    expect(byId['g-big']).not.toHaveProperty('_count')
  })

  it('the ad-group read returns all 280 rows, positives first in creation order, and the total', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/advertising/ad-groups/g-big' })
    expect(res.statusCode).toBe(200)
    const ag = (res.json() as { adGroup: { targets: Array<{ id: string; isNegative: boolean }>; targetsTotal: number } }).adGroup
    expect(ag.targets).toHaveLength(280)
    expect(ag.targetsTotal).toBe(280)
    expect(ag.targets.slice(0, 250).every((t) => !t.isNegative)).toBe(true)
    expect(ag.targets.slice(250).every((t) => t.isNegative)).toBe(true)
    expect(ag.targets[0]!.id).toBe('g-big-p0000')
    expect(ag.targets[249]!.id).toBe('g-big-p0249')
    expect(ag.targets[250]!.id).toBe('g-big-n0000')
  })
})

describe('CM-12 — Min/Max Bid from the detail page', () => {
  it('a bounds-only save stores the bounds and leaves the campaign\'s other settings as they are', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/advertising/campaigns/c-1f/guardrails', payload: { minBidCents: 15, maxBidCents: 120 } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, minBidCents: 15, maxBidCents: 120, maxBidChangePct: 30 })
    const row = await withWorkspace(business, () => db().campaign.findUniqueOrThrow({ where: { id: 'c-1f' }, select: { minBidCents: true, maxBidCents: true, dynamicBidding: true } }))
    expect(row).toMatchObject({ minBidCents: 15, maxBidCents: 120, dynamicBidding: { targetAcos: 0.25, bidAlgorithm: 'TARGET_ACOS', maxBidChangePct: 30 } })
    // The detail read hands the page what it now loads: the bounds and the stored target.
    const detail = await app.inject({ method: 'GET', url: '/api/advertising/campaigns/c-1f' })
    expect(detail.json()).toMatchObject({ campaign: { minBidCents: 15, maxBidCents: 120, dynamicBidding: { targetAcos: 0.25 } } })
  })

  it('a change of the blob\'s own keys still writes it', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/advertising/campaigns/c-1f/guardrails', payload: { maxBidChangePct: null } })
    expect(res.statusCode).toBe(200)
    const row = await withWorkspace(business, () => db().campaign.findUniqueOrThrow({ where: { id: 'c-1f' }, select: { dynamicBidding: true } }))
    expect(row.dynamicBidding).toEqual({ targetAcos: 0.25, bidAlgorithm: 'TARGET_ACOS' })
  })
})

describe('CM-21 — stored portfolios under their own market', () => {
  it('?marketplace=IT lists the IT live portfolio and never the DE or FR stored ones', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/advertising/portfolios?marketplace=IT' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { portfolios: unknown[] }).portfolios).toEqual([{ portfolioId: '1001', name: 'Jackets IT', marketplace: 'IT' }])
  })

  it('with no market asked, each stored portfolio carries its own market (DE, FR), not "IT"', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/advertising/portfolios' })
    const rows = (res.json() as { portfolios: Array<{ portfolioId: string; marketplace: string }> }).portfolios
    expect(rows.map((p) => [p.portfolioId, p.marketplace])).toEqual([['1001', 'IT'], ['2001', 'DE'], ['local-pf-local-FR-boots', 'FR']])
  })
})

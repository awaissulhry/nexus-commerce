/**
 * W2-C — every campaign launch from the builders, through the real routes on PGlite (production schema; sandbox, so
 * nothing leaves Nexus):
 *   CC-29  a launch with no market is refused (it became Italy, silently) — SP Super Wizard and Single;
 *   CC-5   a launch with a Nexus-only portfolio (`local-pf-…`) is refused before Amazon refuses the whole campaign;
 *   CC-4   Target ACoS is stored as rules the engine runs (one per campaign, a fraction, `campaignId`, the market);
 *          Max Impressions / Max Orders / Custom create no rule (they stored an unhandled `set_bid_strategy`);
 *   CC-5   a portfolio is created only in a named market (it was created in Italy when none was given).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { seedAdsFixture } from '../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction.
vi.mock('../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
vi.mock('./ads-cache.js', () => ({ cached: async (_k: string, _t: number, work: () => Promise<unknown>) => work(), peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined }))


const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
let app: FastifyInstance

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    await database.client.product.create({ data: { sku: 'TEST-SKU-W2C', name: 'Test jacket', basePrice: '99.00' } })
    for (const [code, currency] of [['IT', 'EUR'], ['DE', 'EUR']]) {
      await database.client.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, region: 'EU', currency, language: 'en' } })
    }
  })
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
  const { default: routes } = await import('../../routes/advertising.routes.js')
  await app.register(routes)
  await app.ready()
}, 180_000)
afterAll(async () => { await app?.close(); await database?.close() }, 30_000)

const SPW = '/advertising/campaign-builder/sp-super-wizard/launch'
const SINGLE = '/advertising/campaign-builder/single/launch'
const spwCampaigns = (g: string) => [
  { id: 'w-1', name: `${g} - SP - Research`, kind: 'keyword', matchType: 'Broad', bidEur: 0.5, budgetEur: 8, keywords: ['race jacket'] },
  { id: 'w-2', name: `${g} - SP - Performance`, kind: 'keyword', matchType: 'Exact', bidEur: 0.6, budgetEur: 9, keywords: ['race jacket'] },
]
const rulesNamed = (prefix: string) => inside(() => database.client.automationRule.findMany({ where: { name: { startsWith: prefix } }, orderBy: { name: 'asc' } }))
const campaignsNamed = (prefix: string) => inside(() => database.client.campaign.findMany({ where: { name: { startsWith: prefix } } }))

describe('CC-29 — no launch without a market', () => {
  it('🔴 SP Super Wizard: no market → 400 with the reason, nothing created (it launched in Italy)', async () => {
    const res = await app.inject({ method: 'POST', url: SPW, payload: { productGroupName: 'NoMarket', products: [{ sku: 'TEST-SKU-W2C' }], campaigns: spwCampaigns('NoMarket') } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).error).toMatch(/does not guess/)
    expect(await campaignsNamed('NoMarket')).toHaveLength(0)
  })

  it('🔴 Single: no market → 400, nothing created', async () => {
    const res = await app.inject({ method: 'POST', url: SINGLE, payload: { name: 'NoMarketSingle', budgetEur: 5, defaultBidEur: 0.5, keywords: [{ text: 'gloves' }] } })
    expect(res.statusCode).toBe(400)
    expect(await campaignsNamed('NoMarketSingle')).toHaveLength(0)
  })
})

describe('CC-5 — never a Nexus-only portfolio to Amazon', () => {
  it('🔴 both routes refuse a local-pf- portfolio before creating anything', async () => {
    const spw = await app.inject({ method: 'POST', url: SPW, payload: { market: 'DE', portfolioId: 'local-pf-x-spring', productGroupName: 'LocalPf', campaigns: spwCampaigns('LocalPf') } })
    const single = await app.inject({ method: 'POST', url: SINGLE, payload: { market: 'DE', portfolioId: 'local-pf-x-spring', name: 'LocalPfSingle', budgetEur: 5, defaultBidEur: 0.5 } })
    expect([spw.statusCode, single.statusCode]).toEqual([400, 400])
    expect(JSON.parse(spw.payload).error).toMatch(/exists only in Nexus/)
    expect([...(await campaignsNamed('LocalPf'))]).toHaveLength(0)
  })

  it('a portfolio is created only in a named market (it defaulted to Italy)', async () => {
    const res = await app.inject({ method: 'POST', url: '/advertising/portfolios', payload: { name: 'Spring' } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).error).toMatch(/marketplace required/)
  })

  it('bid suggestions need the launch market (they were always Italy\'s)', async () => {
    expect((await app.inject({ method: 'GET', url: '/advertising/campaign-builder/auto-bid-suggestions' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/advertising/campaign-builder/auto-bid-suggestions?market=DE' })).statusCode).toBe(200)
  })
})

describe('CC-4 — the bid strategy becomes rules the engine runs', () => {
  it('🔴 SP Super Wizard, Target ACoS 30 %: one bid_to_target_acos rule per campaign — 0.3, its campaignId, the market', async () => {
    const res = await app.inject({ method: 'POST', url: SPW, payload: {
      market: 'DE', productGroupName: 'Acos', products: [{ sku: 'TEST-SKU-W2C' }], campaigns: spwCampaigns('Acos'),
      automationMode: 'rule', bidConfig: { strategy: 'targetAcos', targetAcos: '30', minBid: '0.2', maxBid: '' },
    } })
    expect(res.statusCode).toBe(200)
    const created = JSON.parse(res.payload).created as Array<{ campaignId: string; name: string }>
    expect(created).toHaveLength(2)
    const rules = (await rulesNamed('Acos - SP')).filter((r: { actions: unknown }) => (r.actions as Array<{ type: string }>)[0].type === 'bid_to_target_acos')
    expect(rules).toHaveLength(2)
    expect(rules.map((r: { actions: unknown; scopeMarketplace: string | null; dryRun: boolean }) => [(r.actions as unknown[])[0], r.scopeMarketplace, r.dryRun]).sort((a: unknown[], b: unknown[]) => String((a[0] as { campaignId: string }).campaignId).localeCompare(String((b[0] as { campaignId: string }).campaignId)))).toEqual(
      created.map((c) => c.campaignId).sort().map((campaignId) => [{ type: 'bid_to_target_acos', targetAcos: 0.3, minBidEur: 0.2, campaignId }, 'DE', true]),
    )
  })

  it('🔴 Max Impressions / Max Orders / Custom create no rule at all (no more set_bid_strategy)', async () => {
    for (const strategy of ['maxImpressions', 'maxOrders', 'custom']) {
      const g = `NoEngine-${strategy}`
      const res = await app.inject({ method: 'POST', url: SPW, payload: { market: 'DE', productGroupName: g, products: [{ sku: 'TEST-SKU-W2C' }], campaigns: spwCampaigns(g), automationMode: 'rule', bidConfig: { strategy, targetAcos: '30' } } })
      expect(res.statusCode, res.payload).toBe(200)
      expect(await rulesNamed(g)).toHaveLength(0)
    }
    const stray = await inside(() => database.client.automationRule.findMany({ where: { description: { contains: 'Bid strategy from' } } }))
    expect(stray.some((r: { actions: unknown }) => (r.actions as Array<{ type: string }>)[0].type === 'set_bid_strategy')).toBe(false)
  })

  it('🔴 Single, Target ACoS 25 %: one rule for its campaign — 0.25 and the campaignId', async () => {
    const res = await app.inject({ method: 'POST', url: SINGLE, payload: { market: 'IT', name: 'SingleAcos', products: [{ sku: 'TEST-SKU-W2C' }], budgetEur: 5, defaultBidEur: 0.5, keywords: [{ text: 'gloves' }], bidConfig: { strategy: 'targetAcos', targetAcos: '25' }, autoBidAdjust: true } })
    expect(res.statusCode, res.payload).toBe(200)
    const campaignId = JSON.parse(res.payload).campaignId
    const rules = await rulesNamed('SingleAcos — ')
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ actions: [{ type: 'bid_to_target_acos', targetAcos: 0.25, campaignId }], scopeMarketplace: 'IT', enabled: true, dryRun: true })
  })
})

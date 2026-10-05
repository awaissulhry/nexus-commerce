/**
 * W2-D — Sponsored Brands and Sponsored Display campaigns are created correctly, or refused before anything exists.
 *
 * - CC-10: the Guided launch (shared SPW route) refuses SB/SD campaigns — it cannot send their creative or targets, so
 *   they would be created on Amazon and never serve. Nothing is created.
 * - CC-11: the SB creative carries the type the operator chose; `sb-creatives/create` with `dryRun` checks it (and shows
 *   what would be sent) before the builder creates the campaign; a creative Amazon would refuse is refused with the
 *   reason and leaves no row and no Amazon call.
 * - CC-12: an SD target is sent in SD's dialect (nested audience with a lookback, asinSameAs) and stored by the text
 *   it names; an SD audience campaign keeps its tactic, so its ad group goes out with the same one.
 *
 * PGlite with the production schema and the real advertising routes. The gate answers "allowed" unless a test says
 * otherwise; Amazon is a recorder; nothing leaves the process.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { seedAdsFixture } from '../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import type { GateContext, GateDecision } from './ads-write-gate.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
vi.mock('../../lib/queue.js', () => {
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
vi.mock('./ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))
const gate = vi.hoisted(() => ({ seen: [] as GateContext[], refuse: null as string | null }))
vi.mock('./ads-write-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ads-write-gate.js')>()),
  checkAdsWriteGate: async (ctx: GateContext): Promise<GateDecision> => {
    gate.seen.push(ctx)
    return gate.refuse
      ? { allowed: false, deniedAt: 'automation_halted', reason: gate.refuse }
      : { allowed: true, mode: 'live', profileId: 'P-IT-TEST' }
  },
  logGateDeny: () => undefined,
  recordSuccessfulWrite: async () => undefined,
  recordCampaignLiveWrite: async () => undefined,
}))
const amazon = vi.hoisted(() => ({ calls: [] as Array<{ what: string; input: Record<string, unknown> }>, seq: 0 }))
vi.mock('./ads-api-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ads-api-client.js')>()
  const create = (what: string) => async (_ctx: unknown, input: Record<string, unknown>) => {
    amazon.calls.push({ what, input })
    return { ok: true, mode: 'live', externalId: `${7000 + ++amazon.seq}`, rawResponse: {}, error: null }
  }
  return {
    ...real,
    adsMode: () => 'live',
    createCampaign: create('sp campaign'), createAdGroup: create('sp ad group'), createKeyword: create('sp keyword'), createProductAd: create('sp product ad'),
    createTarget: create('sp target'),
    createSdCampaign: create('sd campaign'), createSdAdGroup: create('sd ad group'), createSdProductAd: create('sd product ad'), createSdTarget: create('sd target'),
    createSbCampaign: create('sb campaign'), createSbAdGroup: create('sb ad group'), createSbKeyword: create('sb keyword'), createSbAd: create('sb ad'),
    listSbAds: async () => [],
  }
})

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
let app: FastifyInstance
const svc = await import('./ads-create.service.js')

const post = async (url: string, payload: object) => {
  const res = await app.inject({ method: 'POST', url: `/api${url}`, payload })
  return { status: res.statusCode, body: res.json() as Record<string, unknown> }
}
const calls = (what: string) => amazon.calls.filter((c) => c.what === what)

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(() => seedAdsFixture(database.client))
  const { default: advertisingRoutes } = await import('../../routes/advertising.routes.js')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
}, 180_000)
afterAll(async () => { await app?.close(); await database?.close() }, 30_000)
beforeEach(() => { amazon.calls = []; gate.seen = []; gate.refuse = null })

describe('CC-10 — the Guided launch refuses Sponsored Brands / Display before anything is created', () => {
  it('an SB or SD campaign in the launch is a 400 with the reason; no campaign row and no Amazon call', async () => {
    const before = await inside(() => database.client.campaign.count())
    for (const adProduct of ['SB', 'SD'] as const) {
      const r = await post('/advertising/campaign-builder/sp-super-wizard/launch', {
        market: 'IT', products: [{ asin: 'B0TEST0001' }],
        campaigns: [{ id: 'sp-research', name: 'Guided - SP - Research', kind: 'keyword', adProduct: 'SP' }, { id: 'x', name: `Guided - ${adProduct}`, kind: 'pat', adProduct }],
      })
      expect(r.status).toBe(400)
      expect(r.body.error).toMatch(/cannot send their creative or targets.*Use the Sponsored Brands \/ Display builder/)
    }
    expect(await inside(() => database.client.campaign.count())).toBe(before)
    expect(amazon.calls).toEqual([])
  })
})

describe('CC-11 — the Sponsored Brands creative', () => {
  const creative = { marketplace: 'IT', headline: 'Ride in style', brandName: 'Acme', logoAssetId: 'LOGO-TEST', landingType: 'url', landingUrl: 'https://example.test/store' }

  it('dry run: a creative Amazon would refuse comes back with the reasons, and nothing is sent or stored', async () => {
    const before = await inside(() => database.client.adProductAd.count())
    const r = await post('/advertising/sb-creatives/create', { ...creative, dryRun: true, creativeType: 'manualCollection', asins: ['B0TEST0001', 'B0TEST0002'] })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ mode: 'dry-run', ok: false, wouldSend: null })
    expect(r.body.problems).toEqual(['A Manual collection creative needs at least 3 products; it has 2.'])
    expect(amazon.calls).toEqual([])
    expect(await inside(() => database.client.adProductAd.count())).toBe(before)
  })

  it('dry run: a good creative shows exactly what would be sent, for the chosen type', async () => {
    const r = await post('/advertising/sb-creatives/create', { ...creative, dryRun: true, creativeType: 'manualCollection', asins: ['B0TEST0001', 'B0TEST0002', 'B0TEST0003', 'B0TEST0004'] })
    expect(r.body).toMatchObject({ mode: 'dry-run', ok: true, problems: [] })
    const would = r.body.wouldSend as { path: string; body: { ads: Array<{ creative: Record<string, unknown> }> } }
    expect(would.path).toBe('/sb/v4/ads/manualCollection')
    expect(would.body.ads[0].creative).toMatchObject({ brandName: 'Acme', title: 'Ride in style', asins: ['B0TEST0001', 'B0TEST0002', 'B0TEST0003', 'B0TEST0004'] })
    expect(amazon.calls).toEqual([])
  })

  it('a create with no creative type (what the builder used to send) is a 400 that says to choose one — no Amazon call, no row', async () => {
    const before = await inside(() => database.client.adProductAd.count())
    const r = await post('/advertising/sb-creatives/create', { ...creative, adGroupId: 'g-c-sb', asins: ['B0TEST0001'] })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/^Choose a creative type \(Manual collection or Product collection\)\./)
    expect(calls('sb ad')).toEqual([])
    expect(await inside(() => database.client.adProductAd.count())).toBe(before)
  })

  it('the chosen type is sent with every ASIN chosen (no silent cut to 3), and the creative is stored with Amazon\'s id', async () => {
    const asins = ['B0TEST0001', 'B0TEST0002', 'B0TEST0003', 'B0TEST0004']
    const r = await post('/advertising/sb-creatives/create', { ...creative, adGroupId: 'g-c-sb', creativeType: 'manualCollection', asins })
    expect(r.status).toBe(200)
    expect(calls('sb ad')).toHaveLength(1)
    expect(calls('sb ad')[0].input).toMatchObject({ creativeType: 'manualCollection', asins, brandName: 'Acme', externalAdGroupId: 'EXT-g-c-sb' })
    // 1e — the builder is a person: the gate is asked as for a person's own add.
    expect(gate.seen.at(-1)?.manual).toBe(true)
    const row = await inside(() => database.client.adProductAd.findUnique({ where: { id: String(r.body.id) } }))
    expect(row).toMatchObject({ adType: 'BRAND_AD', externalAdId: String(r.body.externalAdId) })
  })

  it('a creative the gate does not let through is refused with the reason — no local-only row that would read as made', async () => {
    gate.refuse = 'ads automation is stopped (halted: test)'
    const before = await inside(() => database.client.adProductAd.count())
    const r = await post('/advertising/sb-creatives/create', { ...creative, adGroupId: 'g-c-sb', creativeType: 'productCollection', asins: ['B0TEST0001'] })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('The creative was not sent: ads automation is stopped (halted: test)')
    expect(calls('sb ad')).toEqual([])
    expect(await inside(() => database.client.adProductAd.count())).toBe(before)
  })
})

describe('CC-12 — Sponsored Display targets and ad groups in SD\'s own dialect', () => {
  let adGroupId = ''
  let sdCampaignId = ''
  beforeAll(async () => {
    // A describe's beforeAll runs before the file's beforeEach: the last CC-11 test left the gate refusing.
    gate.refuse = null
    const camp = await inside(() => svc.createCampaignLocal({ name: 'SD audiences test', type: 'SD', marketplace: 'IT', dailyBudgetEur: 5, sdTactic: 'T00030' }))
    sdCampaignId = camp.id
    const row = await inside(() => database.client.campaign.findUnique({ where: { id: camp.id }, select: { tactic: true } }))
    expect(row?.tactic).toBe('T00030')
    amazon.calls = []
    const ag = await inside(() => svc.createAdGroupLocal({ campaignId: camp.id, name: 'SD audiences test - ad group', defaultBidEur: 0.5 }))
    expect(calls('sd ad group')[0].input).toMatchObject({ tactic: 'T00030' })
    adGroupId = String(ag.id)
  })

  it('views remarketing goes out nested with its lookback, and is stored by the text it names (no duplicate on retry)', async () => {
    const add = () => inside(() => svc.createTargetLocal({ adGroupId, kind: 'AUDIENCE', audienceType: 'VIEWS_REMARKETING', value: 'exactProduct', lookbackDays: 14, bidEur: 0.5 }))
    const first = await add()
    expect(calls('sd target')).toHaveLength(1)
    expect(calls('sd target')[0].input.expression).toEqual([{ type: 'views', value: [{ type: 'exactProduct' }, { type: 'lookback', value: '14' }] }])
    const row = await inside(() => database.client.adTarget.findUnique({ where: { id: String(first.id) } }))
    expect(row).toMatchObject({ kind: 'AUDIENCE', expressionType: 'VIEWS_REMARKETING', expressionValue: 'exactProduct lookback=14', externalTargetId: first.externalTargetId })
    const again = await add()
    expect(again.id).toBe(first.id)
    expect(calls('sd target')).toHaveLength(1)
  })

  it('a product target is asinSameAs, not the SP ASIN_SAME_AS', async () => {
    await inside(() => svc.createTargetLocal({ adGroupId, kind: 'PRODUCT', value: 'B0TEST0009', bidEur: 0.4 }))
    expect(calls('sd target')[0].input.expression).toEqual([{ type: 'asinSameAs', value: 'B0TEST0009' }])
    expect(calls('sp target')).toEqual([])
  })

  it('the old builder\'s "views of one ASIN" is a 400 with the reason: no Amazon call, no row', async () => {
    const before = await inside(() => database.client.adTarget.count({ where: { adGroupId } }))
    const r = await post('/advertising/targets/create', { adGroupId, kind: 'AUDIENCE', audienceType: 'VIEWS_REMARKETING', value: 'B0TEST0001', bidEur: 0.5 })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/cannot target the views of one ASIN \(B0TEST0001\)/)
    expect(calls('sd target')).toEqual([])
    expect(await inside(() => database.client.adTarget.count({ where: { adGroupId } }))).toBe(before)
  })

  it('the repair push re-creates a missing SD / SB ad group on its own endpoint, never /sp/adGroups', async () => {
    await inside(async () => {
      await database.client.adGroup.create({ data: { id: 'g-sd-missing', campaignId: sdCampaignId, name: 'SD missing group', defaultBidCents: 40 } })
      await database.client.adGroup.create({ data: { id: 'g-sb-missing', campaignId: 'c-sb', name: 'SB missing group', defaultBidCents: 40 } })
    })
    const sd = await inside(() => svc.pushCampaignStructure(sdCampaignId))
    const sb = await inside(() => svc.pushCampaignStructure('c-sb'))
    expect([sd.adGroups, sb.adGroups]).toEqual([1, 1])
    expect(calls('sd ad group')[0].input).toMatchObject({ name: 'SD missing group', tactic: 'T00030' })
    expect(calls('sb ad group')[0].input).toMatchObject({ name: 'SB missing group' })
    expect(calls('sp ad group')).toEqual([])
  })
})

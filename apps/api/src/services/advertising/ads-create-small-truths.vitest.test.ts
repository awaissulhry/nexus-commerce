/**
 * W5-B — three small truths in the campaign creator.
 *
 * - CC-26: a Sponsored Brands / Display start date is the day in the ACCOUNT's time zone. It was the UTC day (SB) and
 *   the server's local day (SD), so from 00:00 to 02:00 Italian time Amazon was sent yesterday.
 * - CC-27: a new Sponsored Products campaign row stores the targeting type it was created with (AUTO / MANUAL); the
 *   list, the export and the receipt showed it blank until the settings sync read it back.
 * - CC-31: a product target under a Sponsored Brands campaign was sent to `/sp/targets`. Nexus has no Sponsored Brands
 *   targets path, so it is refused before anything is written or sent, with the reason.
 *
 * PGlite with the production schema and the real advertising routes. The gate answers "allowed"; Amazon is a recorder
 * (the real client for dry runs, which never call Amazon); nothing leaves the process.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { seedAdsFixture } from '../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import type { GateDecision } from './ads-write-gate.js'

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
vi.mock('./ads-write-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ads-write-gate.js')>()),
  checkAdsWriteGate: async (): Promise<GateDecision> => ({ allowed: true, mode: 'live', profileId: 'P-IT-TEST' }),
  logGateDeny: () => undefined,
  recordSuccessfulWrite: async () => undefined,
  recordCampaignLiveWrite: async () => undefined,
}))
const amazon = vi.hoisted(() => ({ calls: [] as Array<{ what: string; input: Record<string, unknown> }>, seq: 0 }))
vi.mock('./ads-api-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ads-api-client.js')>()
  const create = (what: string) => async (_ctx: unknown, input: Record<string, unknown>) => {
    amazon.calls.push({ what, input })
    return { ok: true, mode: 'live', externalId: `${8000 + ++amazon.seq}`, rawResponse: {}, error: null }
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
beforeEach(() => { amazon.calls = [] })

describe('CC-26 — SB / SD start dates are the day in the account\'s time zone', () => {
  // 23:30 UTC on 5 October is 01:30 on 6 October in Rome (CEST, UTC+2): the night window the finding names.
  const night = new Date('2026-10-05T23:30:00Z')

  it('the client sends the day in the zone it is given (SB YYYY-MM-DD, SD YYYYMMDD)', async () => {
    const real = await vi.importActual<typeof import('./ads-api-client.js')>('./ads-api-client.js')
    const ctx = { profileId: 'P-IT-TEST', region: 'EU' as const }
    const sb = await real.createSbCampaign(ctx, { name: 'x', dailyBudget: 5, brandEntityId: 'BE-1', startDate: night, timeZone: 'Europe/Rome', dryRun: true })
    const sd = await real.createSdCampaign(ctx, { name: 'x', dailyBudget: 5, startDate: night, timeZone: 'Europe/Rome', dryRun: true })
    const body = (r: unknown) => (r as { rawResponse: { wouldSend: { body: unknown } } }).rawResponse.wouldSend.body
    expect((body(sb) as { campaigns: Array<{ startDate: string }> }).campaigns[0].startDate).toBe('2026-10-06')
    expect((body(sd) as Array<{ startDate: string }>)[0].startDate).toBe('20261006')
    // Without a zone it is the UTC day — what was sent for every account before.
    const sbUtc = await real.createSbCampaign(ctx, { name: 'x', dailyBudget: 5, brandEntityId: 'BE-1', startDate: night, dryRun: true })
    expect((body(sbUtc) as { campaigns: Array<{ startDate: string }> }).campaigns[0].startDate).toBe('2026-10-05')
  })

  it('a create uses the zone Amazon reported for the account, else the market\'s own zone', async () => {
    await inside(() => svc.createCampaignLocal({ name: 'CC-26 SD market zone', type: 'SD', marketplace: 'IT', dailyBudgetEur: 5 }))
    expect(calls('sd campaign')[0].input).toMatchObject({ timeZone: 'Europe/Rome' })

    await inside(() => database.client.amazonAdsProfile.create({ data: { profileId: 'P-IT-TEST', marketplace: 'IT', currencyCode: 'EUR', timezone: 'Europe/Paris' } }))
    await inside(() => svc.createCampaignLocal({ name: 'CC-26 SB profile zone', type: 'SB', marketplace: 'IT', dailyBudgetEur: 5, brandEntityId: 'BE-TEST' }))
    expect(calls('sb campaign')[0].input).toMatchObject({ timeZone: 'Europe/Paris' })
  })
})

describe('CC-27 — a new SP campaign stores its targeting type', () => {
  it('AUTO and MANUAL as asked; MANUAL when the builder named none (what was sent to Amazon)', async () => {
    const auto = await inside(() => svc.createCampaignLocal({ name: 'CC-27 auto', type: 'SP', marketplace: 'IT', dailyBudgetEur: 5, targetingType: 'AUTO' }))
    const manual = await inside(() => svc.createCampaignLocal({ name: 'CC-27 default', type: 'SP', marketplace: 'IT', dailyBudgetEur: 5 }))
    const row = (id: string) => inside(() => database.client.campaign.findUnique({ where: { id }, select: { targetingType: true } }))
    expect(await row(auto.id)).toEqual({ targetingType: 'AUTO' })
    expect(await row(manual.id)).toEqual({ targetingType: 'MANUAL' })
    expect(calls('sp campaign').map((c) => c.input.targetingType)).toEqual(['AUTO', 'MANUAL'])
  })
})

describe('CC-31 — a product target under a Sponsored Brands campaign', () => {
  it('a person\'s add is a 403 with the reason: no row, no call to /sp/targets', async () => {
    const before = await inside(() => database.client.adTarget.count({ where: { adGroupId: 'g-c-sb' } }))
    const res = await app.inject({ method: 'POST', url: '/api/advertising/targets/create', payload: { adGroupId: 'g-c-sb', kind: 'PRODUCT', value: 'B0TEST0001', bidEur: 0.4 } })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe(svc.SB_TARGET_REFUSED)
    expect(calls('sp target')).toEqual([])
    expect(await inside(() => database.client.adTarget.count({ where: { adGroupId: 'g-c-sb' } }))).toBe(before)
  })

  it('a launch or rule gets the refusal as its reason (nothing thrown, nothing sent)', async () => {
    const r = await inside(() => svc.createTargetLocal({ adGroupId: 'g-c-sb', kind: 'PRODUCT', value: 'B0TEST0002', bidEur: 0.4, creationFlow: true }))
    expect(r).toMatchObject({ id: null, externalTargetId: null, notSent: { outcome: 'refused', reason: svc.SB_TARGET_REFUSED } })
    expect(calls('sp target')).toEqual([])
  })

  it('the repair push does not send a Nexus-only SB product target to /sp/targets either', async () => {
    await inside(() => database.client.adTarget.create({ data: { id: 't-sb-pt', adGroupId: 'g-c-sb', kind: 'PRODUCT', expressionType: 'ASIN', expressionValue: 'B0TEST0003', bidCents: 40 } }))
    const out = await inside(() => svc.pushCampaignStructure('c-sb'))
    expect(calls('sp target')).toEqual([])
    expect(out.errors).toContain(`target "B0TEST0003": ${svc.SB_TARGET_REFUSED}`)
  })
})

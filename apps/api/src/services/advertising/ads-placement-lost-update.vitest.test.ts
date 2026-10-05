/**
 * CM-6 — a placement write no longer saves back an old copy of the campaign's other settings.
 *
 * `updatePlacementBidding` reads the campaign, then spends seconds on the gate, Amazon's read and the PUT. It used to
 * write the whole `dynamicBidding` JSON back from that first read, so a Target ACoS / bid automation / bid algorithm or
 * CPC ceiling saved in those seconds was silently put back — the detail Save and the bulk modal send `/automation`
 * beside `/placements`, and rank-defend writes placements every 15 minutes.
 *
 * Here the other settings are saved WHILE the placement write is in flight (inside its Amazon read and PUT), through
 * the real `setBidAutomation` / `setCpcCeiling`. Both edits must survive. On a real PostgreSQL (PGlite, production
 * schema), so the JSON merge itself runs; the queue and the Amazon client are mocked.
 *
 * And the other direction: `setBidAutomation`, `setCpcCeiling` and `PATCH /campaigns/:id/guardrails` each read the JSON
 * first too. A placement saved between that read and their write (`race.afterCampaignRead`) must survive them.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { seedAdsFixture } from '../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
/** Runs once, right after the next `campaign.findUnique` returns: a write that lands between a writer's read and its write. */
const race = vi.hoisted(() => ({ afterCampaignRead: null as null | (() => Promise<void>) }))
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  const root = () => (wrapped ??= contextualDatabase(database.client as never))
  const campaignDelegate = (delegate: object) => new Proxy(delegate, {
    get: (target, q) => {
      const value = Reflect.get(target, q) as unknown
      if (q !== 'findUnique' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value
      return async (args: unknown) => {
        const out = await value.call(target, args)
        const hook = race.afterCampaignRead
        if (hook) { race.afterCampaignRead = null; await hook() }
        return out
      }
    },
  })
  return { default: new Proxy({}, { get: (_t, p) => {
    const value = Reflect.get(root(), p) as unknown
    return p === 'campaign' ? campaignDelegate(value as object) : value
  } }) }
})
vi.mock('./ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))
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
const amz = vi.hoisted(() => ({
  mode: 'sandbox' as 'sandbox' | 'live',
  updateCampaign: vi.fn(async () => ({ ok: true, mode: 'sandbox' })),
  listCampaignsV3: vi.fn(async () => [] as unknown[]),
}))
vi.mock('./ads-api-client.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  adsMode: () => amz.mode,
  updateCampaign: amz.updateCampaign,
  listCampaignsV3: amz.listCampaignsV3,
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const PERSON = 'user:placement-lost-update-test' as const
const TOP = 'PLACEMENT_TOP', REST = 'PLACEMENT_REST_OF_SEARCH', PP = 'PLACEMENT_PRODUCT_PAGE'

const stored = (id: string) => inside(async () =>
  (await database.client.campaign.findUniqueOrThrow({ where: { id }, select: { dynamicBidding: true, biddingStrategy: true } })))
const setStored = (id: string, dynamicBidding: unknown) => inside(() =>
  database.client.campaign.update({ where: { id }, data: { dynamicBidding: dynamicBidding as never } }))

/** The edits a person saves on the detail page or in the bulk modal while the placement write is in flight. */
async function saveOtherSettingsMeanwhile(campaignId: string) {
  const { setBidAutomation, setCpcCeiling } = await import('./campaign-settings.service.js')
  expect((await setBidAutomation(campaignId, { bidAutomation: true, targetAcos: 0.25, bidAlgorithm: 'TARGET_ACOS' })).value).toMatchObject({ ok: true })
  expect((await setCpcCeiling(campaignId, { enabled: true, multiple: 2 })).value).toMatchObject({ ok: true })
}
const OTHER_SETTINGS_SAVED = { targetAcos: 0.25, bidAutomation: true, bidAlgorithm: 'TARGET_ACOS', cpcCeiling: { enabled: true, multiple: 2 } }

let app: FastifyInstance
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
beforeEach(async () => {
  vi.clearAllMocks()
  race.afterCampaignRead = null
  amz.mode = 'sandbox'
  amz.updateCampaign.mockImplementation(async () => ({ ok: true, mode: 'sandbox' }))
  await setStored('c-it', { strategy: 'LEGACY_FOR_SALES', targetAcos: 0.3, bidAutomation: false, placementBidding: [{ placement: TOP, percentage: 50 }] })
})

describe('updatePlacementBidding writes only placementBidding, into the row as it is when it writes (CM-6)', () => {
  it('a Target ACoS / automation / algorithm / CPC ceiling saved during the placement PUT survives it', async () => {
    amz.updateCampaign.mockImplementationOnce(async () => { await saveOtherSettingsMeanwhile('c-it'); return { ok: true, mode: 'sandbox' } })
    const { updatePlacementBidding } = await import('./ads-create.service.js')

    const r = await inside(() => updatePlacementBidding({ campaignId: 'c-it', adjustments: [{ placement: TOP, percentage: 80 }], actor: PERSON }))

    expect(r).toMatchObject({ ok: true, mode: 'sandbox' })
    const { dynamicBidding } = await stored('c-it')
    expect(dynamicBidding).toMatchObject({ strategy: 'LEGACY_FOR_SALES', ...OTHER_SETTINGS_SAVED })
    expect((dynamicBidding as { placementBidding: unknown }).placementBidding).toEqual([{ placement: TOP, percentage: 80 }])
  })

  it('live: an edit saved while Amazon is read and written survives, and the merged lanes are stored', async () => {
    amz.mode = 'live'
    amz.listCampaignsV3.mockImplementationOnce(async () => {
      await saveOtherSettingsMeanwhile('c-it')
      return [{ campaignId: 'EXT-c-it', dynamicBidding: { strategy: 'LEGACY_FOR_SALES', placementBidding: [{ placement: TOP, percentage: 50 }, { placement: PP, percentage: 40 }] } }]
    })
    amz.updateCampaign.mockImplementationOnce(async () => ({ ok: true, mode: 'live' }))
    const { updatePlacementBidding } = await import('./ads-create.service.js')

    const r = await inside(() => updatePlacementBidding({ campaignId: 'c-it', adjustments: [{ placement: REST, percentage: 30 }], partial: true, actor: PERSON }))

    expect(r).toMatchObject({ ok: true, mode: 'live' })
    const { dynamicBidding } = await stored('c-it')
    expect(dynamicBidding).toMatchObject(OTHER_SETTINGS_SAVED)
    const lanes = Object.fromEntries(((dynamicBidding as { placementBidding: Array<{ placement: string; percentage: number }> }).placementBidding).map((x) => [x.placement, x.percentage]))
    expect(lanes).toEqual({ [TOP]: 50, [PP]: 40, [REST]: 30 })
  })

  it('a campaign with no settings yet gets an object holding the lanes; the bidding strategy column is written with it', async () => {
    await setStored('c-uk', null)
    const { updatePlacementBidding } = await import('./ads-create.service.js')

    await inside(() => updatePlacementBidding({ campaignId: 'c-uk', adjustments: [{ placement: TOP, percentage: 25 }], biddingStrategy: 'autoForSales', actor: PERSON }))

    const after = await stored('c-uk')
    expect(after.dynamicBidding).toEqual({ placementBidding: [{ placement: TOP, percentage: 25 }] })
    expect(after.biddingStrategy).toBe('AUTO_FOR_SALES')
  })

  it('a refused write changes nothing (no write at all)', async () => {
    const { updatePlacementBidding } = await import('./ads-create.service.js')
    // c-sb is Sponsored Brands: refused before any write
    await setStored('c-sb', { targetAcos: 0.4 })
    const r = await inside(() => updatePlacementBidding({ campaignId: 'c-sb', adjustments: [{ placement: TOP, percentage: 80 }], actor: PERSON }))
    expect(r).toMatchObject({ ok: false, mode: 'blocked' })
    expect(amz.updateCampaign).not.toHaveBeenCalled()
    expect((await stored('c-sb')).dynamicBidding).toEqual({ targetAcos: 0.4 })
  })
})

/**
 * The other direction. Each settings writer reads `dynamicBidding`, then writes. A placement saved in between (here:
 * rank-defend's kind of write, through the real `updatePlacementBidding`) must not be put back by that write — and
 * the writer's own keys, and every other key, must be as expected.
 */
describe('the settings writers write only their own keys, so a placement saved meanwhile survives (CM-6)', () => {
  const PLACEMENT_SAVED_MEANWHILE = [{ placement: TOP, percentage: 120 }]
  const savePlacementAfterNextRead = () => {
    race.afterCampaignRead = async () => {
      const { updatePlacementBidding } = await import('./ads-create.service.js')
      const r = await updatePlacementBidding({ campaignId: 'c-it', adjustments: PLACEMENT_SAVED_MEANWHILE, actor: 'automation:rank-defend-test' })
      expect(r).toMatchObject({ ok: true })
    }
  }
  const placementOf = async () => ((await stored('c-it')).dynamicBidding as { placementBidding?: unknown }).placementBidding

  it('setBidAutomation: its keys are set or cleared, the placement and the CPC ceiling are kept', async () => {
    await setStored('c-it', { strategy: 'LEGACY_FOR_SALES', targetAcos: 0.3, bidAutomation: false, cpcCeiling: { enabled: true, multiple: 2 }, placementBidding: [{ placement: TOP, percentage: 50 }] })
    savePlacementAfterNextRead()
    const { setBidAutomation } = await import('./campaign-settings.service.js')

    const r = await inside(() => setBidAutomation('c-it', { bidAutomation: true, targetAcos: null, bidAlgorithm: 'MAX_ORDERS' }))

    expect(r.value).toMatchObject({ ok: true, bidAutomation: true, targetAcos: null, bidAlgorithm: 'MAX_ORDERS' })
    expect(race.afterCampaignRead).toBeNull() // the placement really was saved between the read and the write
    expect(await placementOf()).toEqual(PLACEMENT_SAVED_MEANWHILE)
    expect((await stored('c-it')).dynamicBidding).toEqual({
      strategy: 'LEGACY_FOR_SALES', bidAutomation: true, bidAlgorithm: 'MAX_ORDERS', cpcCeiling: { enabled: true, multiple: 2 }, placementBidding: PLACEMENT_SAVED_MEANWHILE,
    })
  })

  it('setCpcCeiling: only cpcCeiling changes, the placement and the automation keys are kept', async () => {
    savePlacementAfterNextRead()
    const { setCpcCeiling } = await import('./campaign-settings.service.js')

    const r = await inside(() => setCpcCeiling('c-it', { enabled: true, multiple: 3 }))

    expect(r.value).toMatchObject({ ok: true, cpcCeiling: { enabled: true, multiple: 3 } })
    expect(race.afterCampaignRead).toBeNull()
    expect((await stored('c-it')).dynamicBidding).toEqual({
      strategy: 'LEGACY_FOR_SALES', targetAcos: 0.3, bidAutomation: false, cpcCeiling: { enabled: true, multiple: 3 }, placementBidding: PLACEMENT_SAVED_MEANWHILE,
    })
  })

  it('PATCH /campaigns/:id/guardrails: its keys are set or cleared, the columns are written, the placement is kept', async () => {
    await setStored('c-it', { targetAcos: 0.3, maxBidChangePct: 25, placementBidding: [{ placement: TOP, percentage: 50 }] })
    savePlacementAfterNextRead()

    const res = await app.inject({ method: 'PATCH', url: '/api/advertising/campaigns/c-it/guardrails', payload: { maxBidChangePct: null, maxWritesPerDay: 12, minBidCents: 10, maxBidCents: 300 }, headers: { 'x-actor-id': 'guardrails-person' } })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, maxBidChangePct: null, maxWritesPerDay: 12, minBidCents: 10, maxBidCents: 300 })
    expect(race.afterCampaignRead).toBeNull()
    expect((await stored('c-it')).dynamicBidding).toEqual({ targetAcos: 0.3, maxWritesPerDay: 12, placementBidding: PLACEMENT_SAVED_MEANWHILE })
    const bounds = await inside(() => database.client.campaign.findUniqueOrThrow({ where: { id: 'c-it' }, select: { minBidCents: true, maxBidCents: true } }))
    expect(bounds).toEqual({ minBidCents: 10, maxBidCents: 300 })
  })
})

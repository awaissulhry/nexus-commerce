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
 * schema), so the `jsonb_set` itself runs; the queue and the Amazon client are mocked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(() => seedAdsFixture(database.client))
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)
beforeEach(async () => {
  vi.clearAllMocks()
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
    amz.updateCampaign.mockImplementationOnce(async () => { throw new Error('must not be called') })
    const { updatePlacementBidding } = await import('./ads-create.service.js')
    // c-sb is Sponsored Brands: refused before any write
    await setStored('c-sb', { targetAcos: 0.4 })
    const r = await inside(() => updatePlacementBidding({ campaignId: 'c-sb', adjustments: [{ placement: TOP, percentage: 80 }], actor: PERSON }))
    expect(r).toMatchObject({ ok: false, mode: 'blocked' })
    expect((await stored('c-sb')).dynamicBidding).toEqual({ targetAcos: 0.4 })
  })
})

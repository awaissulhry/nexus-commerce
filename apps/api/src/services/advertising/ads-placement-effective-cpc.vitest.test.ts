/**
 * 6e (review G.3, Owner decision D4) — every placement write is held to the campaign's ceiling on what one click can
 * then cost, and a refused raise changes nothing: no Amazon call, no local change, no history row, and the refusal is
 * recorded where the gate records its own (AdWriteRefusal).
 *
 * The real `updatePlacementBidding` → the real write gate in LIVE mode, on PGlite (production schema) with the shared ads
 * fixture (c-it: highest live bid 50¢ — the ad group's default, and a keyword floored at 2¢ that returns to 50¢). The
 * last case runs the real rank tick: a Min-bid hour's placement raise carries the hour's CPC ceiling to the gate.
 * Amazon is a recorder; nothing leaves the process.
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
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: null,
  }
})
// 1e — the Run-now guard is proven in ads-engine-lock.vitest.test.ts.
vi.mock('./ads-engine-lock.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  guardLiveRun: async (_engine: string, fn: () => Promise<unknown>) => ({ ran: true, value: await fn() }),
}))
// Amazon: the campaign's current placements are read back from what it was last sent (G.4), and every PUT is recorded.
const amazon = vi.hoisted(() => ({
  placements: new Map<string, Array<{ placement: string; percentage: number }>>(),
  puts: [] as Array<{ externalId: string; placementBidding: Array<{ placement: string; percentage: number }> }>,
}))
vi.mock('./ads-api-client.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  adsMode: () => 'live',
  listCampaignsV3: async (_ctx: unknown, q: { campaignIds: string[] }) =>
    q.campaignIds.map((id) => ({ campaignId: id, dynamicBidding: { strategy: 'LEGACY_FOR_SALES', placementBidding: amazon.placements.get(id) ?? [] } })),
  updateCampaign: async (_ctx: unknown, externalId: string, patch: { placementBidding: Array<{ placement: string; percentage: number }> }) => {
    amazon.puts.push({ externalId, placementBidding: patch.placementBidding })
    amazon.placements.set(externalId, patch.placementBidding)
    return { ok: true, mode: 'live', rawResponse: {} }
  },
}))
vi.mock('./ads-profile-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  adsProfileFor: async (marketplace: string) => ({
    profileId: `P-${marketplace}-TEST`, region: 'EU', connectionId: null, mode: 'production', writesEnabledAt: new Date('2026-01-01T00:00:00Z'),
    lastWriteAt: null, marketplace, source: 'row',
  }),
  recordWriteForMarket: async () => undefined,
}))
vi.mock('./ads-automation-state.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAutomationState: async () => ({ autonomy: 'AUTO', halted: false, haltReason: null, effectivelyStopped: false, degraded: false }),
}))
vi.mock('./ads-automation-notify.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  notifyAutomation: async () => 0,
}))

const { updatePlacementBidding } = await import('./ads-create.service.js')
const { runRankDefendOnce } = await import('../../jobs/ad-rank-defend.job.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client as any
const RULE = 'automation:tstrule-effective-cpc'
const TOP = 'PLACEMENT_TOP', REST = 'PLACEMENT_REST_OF_SEARCH'

/** Set the campaign's placements, in Nexus and at Amazon alike. */
const placeBoth = async (campaignId: string, placementBidding: Array<{ placement: string; percentage: number }>) => {
  await inside(() => db().campaign.update({ where: { id: campaignId }, data: { dynamicBidding: { strategy: 'LEGACY_FOR_SALES', placementBidding } } }))
  amazon.placements.set(`EXT-${campaignId}`, placementBidding)
}
const localPlacements = async (campaignId: string) =>
  ((await inside(() => db().campaign.findUniqueOrThrow({ where: { id: campaignId }, select: { dynamicBidding: true } }))).dynamicBidding?.placementBidding ?? [])
const historyCount = (campaignId: string) => inside(() => db().campaignBidHistory.count({ where: { campaignId } }))
const refusalsFor = (campaignId: string) => inside(() => db().adWriteRefusal.findMany({ where: { campaignId, deniedAt: 'effective_cpc' }, orderBy: { createdAt: 'asc' } }))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    await db().campaign.update({ where: { id: 'c-it' }, data: { maxBidCents: 150 } })
    await db().adsAutomationState.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', autonomy: 'AUTO', halted: false }, update: { autonomy: 'AUTO', halted: false } })
  })
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)
beforeEach(() => { amazon.puts = [] })

describe('6e — a placement raise past the campaign\'s ceiling is refused and changes nothing', () => {
  it('Top of search 0% → 300% (50¢ × 4 = €2.00 > €1.50): not sent, Nexus unchanged, no history row, the refusal recorded', async () => {
    await placeBoth('c-it', [{ placement: TOP, percentage: 0 }, { placement: REST, percentage: 20 }])
    const history = await historyCount('c-it')

    const r = await inside(() => updatePlacementBidding({ campaignId: 'c-it', adjustments: [{ placement: TOP, percentage: 300 }, { placement: REST, percentage: 20 }], actor: RULE }))

    expect(r).toMatchObject({ ok: false, mode: 'blocked', deniedAt: 'effective_cpc' })
    expect(r.reason).toBe(
      'Raising Top of search from 0% to 300% would let one click cost up to €2.00 (highest bid €0.50 ×4.00 for the placement), '
      + 'above the €1.50 ceiling from the campaign\'s own maximum bid, so nothing was sent to Amazon. At most 200% fits under that ceiling there. '
      + 'Lowering a placement is always allowed.',
    )
    expect(amazon.puts).toEqual([])
    expect(await localPlacements('c-it')).toEqual([{ placement: TOP, percentage: 0 }, { placement: REST, percentage: 20 }])
    expect(await historyCount('c-it')).toBe(history)
    await vi.waitFor(async () => {
      const [refusal] = await refusalsFor('c-it')
      expect(refusal).toMatchObject({ deniedAt: 'effective_cpc', queueId: null, campaignId: 'c-it', entityType: 'CAMPAIGN', entityId: 'c-it', reason: r.reason })
    })
  })

  it('a raise to exactly the ceiling (50¢ × 3 = €1.50) is sent and kept', async () => {
    await placeBoth('c-it', [{ placement: TOP, percentage: 0 }])
    const r = await inside(() => updatePlacementBidding({ campaignId: 'c-it', adjustments: [{ placement: TOP, percentage: 200 }], actor: RULE }))
    expect(r).toMatchObject({ ok: true, mode: 'live' })
    expect(amazon.puts).toEqual([{ externalId: 'EXT-c-it', placementBidding: [{ placement: TOP, percentage: 200 }] }])
    expect(await localPlacements('c-it')).toEqual([{ placement: TOP, percentage: 200 }])
  })

  it('a lowering is always sent — even one that leaves the placement above the ceiling', async () => {
    await placeBoth('c-it', [{ placement: TOP, percentage: 400 }])
    const r = await inside(() => updatePlacementBidding({ campaignId: 'c-it', adjustments: [{ placement: TOP, percentage: 350 }], actor: RULE }))
    expect(r).toMatchObject({ ok: true, mode: 'live' })
    expect(amazon.puts).toHaveLength(1)
    expect(await localPlacements('c-it')).toEqual([{ placement: TOP, percentage: 350 }])
  })

  it('a bid policy is the ceiling when the campaign sets none of its own; with neither, nothing is refused (no new default)', async () => {
    await inside(() => db().campaign.update({ where: { id: 'c-it' }, data: { maxBidCents: null } }))
    await placeBoth('c-it', [{ placement: TOP, percentage: 0 }])
    const free = await inside(() => updatePlacementBidding({ campaignId: 'c-it', adjustments: [{ placement: TOP, percentage: 900 }], actor: RULE }))
    expect(free).toMatchObject({ ok: true, mode: 'live' })

    await placeBoth('c-it', [{ placement: TOP, percentage: 0 }])
    await inside(() => db().adBidPolicy.create({ data: { grain: 'MARKET', scopeId: 'IT', label: 'the IT market\'s €1.00 ceiling', maxBidCents: 100 } }))
    const r = await inside(() => updatePlacementBidding({ campaignId: 'c-it', adjustments: [{ placement: TOP, percentage: 150 }], actor: RULE }))
    expect(r).toMatchObject({ ok: false, deniedAt: 'effective_cpc' })
    expect(r.reason).toContain('above the €1.00 ceiling from the bid policy "the IT market\'s €1.00 ceiling"')
    expect(await localPlacements('c-it')).toEqual([{ placement: TOP, percentage: 0 }])
    await inside(() => db().adBidPolicy.deleteMany({ where: { grain: 'MARKET', scopeId: 'IT' } }))
  })
})

describe('6e — the rank engine hands the hour\'s CPC ceiling to the gate', () => {
  it('a Min-bid hour raising Top of search past it is refused: bids floored at 2¢ return to 40¢, 40¢ × 4 = €1.60 > €1.00', async () => {
    await inside(async () => {
      await db().rankTarget.create({ data: { key: 'minbid-capped', name: 'Min bid, Top +300%', pause: true, floorBidCents: 2, biasPct: 300, maxCpcCents: 100 } })
      await db().campaign.create({
        data: {
          id: 'c-rank', name: 'Italy rank', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-c-rank',
          dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, deliveryStatus: 'DELIVERING', deliveryReasons: [],
          dynamicBidding: { strategy: 'LEGACY_FOR_SALES', placementBidding: [] },
          // already floored by this engine at the target's floor: the tick only sets the hour's placement
          bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: 2,
        },
      })
      await db().adGroup.create({ data: { id: 'g-c-rank', campaignId: 'c-rank', name: 'rank group', defaultBidCents: 2, suppressedFromBidCents: 30 } })
      await db().adTarget.create({ data: { id: 't-rank', adGroupId: 'g-c-rank', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'rank jacket', bidCents: 2, suppressedFromBidCents: 40 } })
      await db().adSchedule.create({ data: { id: 's-rank', campaignId: 'c-rank', name: 'rank schedule', enabled: true, timezone: 'UTC', defaultTargetKey: 'minbid-capped', windows: [] } })
    })

    const run = await inside(() => runRankDefendOnce())

    expect(run.decisions.find((d) => d.campaignId === 'c-rank')).toMatchObject({ targetKey: 'minbid-capped', action: 'pause' })
    expect(amazon.puts.filter((p) => p.externalId === 'EXT-c-rank')).toEqual([])
    expect(await localPlacements('c-rank')).toEqual([])
    await vi.waitFor(async () => {
      const [refusal] = await refusalsFor('c-rank')
      expect(refusal?.reason).toBe(
        'Raising Top of search from 0% to 300% would let one click cost up to €1.60 (highest bid €0.40 ×4.00 for the placement), '
        + 'above the €1.00 ceiling from the hourly plan\'s CPC ceiling (target "minbid-capped"), so nothing was sent to Amazon. '
        + 'At most 150% fits under that ceiling there. Lowering a placement is always allowed.',
      )
    })
  })
})

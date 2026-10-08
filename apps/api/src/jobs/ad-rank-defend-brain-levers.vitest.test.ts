/**
 * ONE BRAIN AB-6 — rank-defend leaves a campaign whose placements or ad-group default bids a product's brain owns (or the
 * Owner holds at his own value): its hour writes those together with its floors, so the campaign is left whole, as a bid
 * brain campaign is (BB-6). PGlite with the production schema and the real tick; the placement write is a recorder; the
 * brain's holders a stand-in (the real resolver is proven in brain/lever-owners and the real-PG suites).
 *   held     no placement written there, the other campaign as before; the line counts the skip per lever
 *   today    nothing enrolled: both written, the line unchanged
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
vi.mock('../services/advertising/ads-engine-lock.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  guardLiveRun: async (_engine: string, fn: () => Promise<unknown>) => ({ ran: true, value: await fn() }),
}))
const rec = vi.hoisted(() => ({ placements: [] as string[] }))
vi.mock('../services/advertising/ads-create.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updatePlacementBidding: async (a: { campaignId: string; adjustments: Array<{ placement: string; percentage: number }> }) => {
    rec.placements.push(a.campaignId)
    await database.client.campaign.update({ where: { id: a.campaignId }, data: { dynamicBidding: { placementBidding: a.adjustments } } })
    return { ok: true }
  },
}))
const h = vi.hoisted(() => ({ campaignLeverOwners: vi.fn(), anyBrainEnrolled: vi.fn() }))
vi.mock('../services/advertising/brain/lever-owners.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  campaignLeverOwners: (...a: unknown[]) => h.campaignLeverOwners(...a),
  anyBrainEnrolled: (...a: unknown[]) => h.anyBrainEnrolled(...a),
}))

const { runRankDefendOnce, rankDefendSummaryLine, RANK_BRAIN_LEVERS } = await import('./ad-rank-defend.job.js')

const inside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client as any
const LOCKED = { kind: 'locked', productId: 'gale', market: 'IT', why: 'locked by the Owner\'s campaign override' }

async function seed(id: string) {
  await inside(async () => {
    await db().campaign.create({
      data: {
        id, name: id, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`,
        dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true,
        deliveryStatus: 'DELIVERING', deliveryReasons: [], dynamicBidding: { placementBidding: [] },
      },
    })
    await db().adGroup.create({ data: { id: `${id}-g`, campaignId: id, name: `${id}-g`, defaultBidCents: 40 } })
    await db().adTarget.create({ data: { id: `${id}-t0`, adGroupId: `${id}-g`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `${id} kw`, bidCents: 35 } })
    await db().adSchedule.create({ data: { id: `${id}-s`, campaignId: id, name: `${id}-s`, enabled: true, timezone: 'UTC', defaultTargetKey: 'flat50', windows: [] } })
  })
}
const resetPlacements = () => inside(() => db().campaign.updateMany({ data: { dynamicBidding: { placementBidding: [] } } }))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await db().rankTarget.create({ data: { key: 'flat50', name: 'Top +50%', biasPct: 50 } })
    await db().adsAutomationState.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', autonomy: 'AUTO', halted: false }, update: { autonomy: 'AUTO', halted: false } })
  })
  await seed('rk-gale')
  await seed('rk-misano')
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() })
beforeEach(async () => {
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  rec.placements = []
  h.anyBrainEnrolled.mockReset().mockResolvedValue(true)
  h.campaignLeverOwners.mockReset().mockResolvedValue(new Map())
  await resetPlacements()
})

describe('AB-6 — rank-defend leaves a campaign whose placements or ad-group bids a product\'s brain holds', () => {
  it('the levers it writes besides the keyword bids', () => {
    expect(RANK_BRAIN_LEVERS).toEqual(['placements', 'adGroupBids'])
  })

  it('nothing enrolled (production today): both campaigns written, the line unchanged', async () => {
    h.anyBrainEnrolled.mockResolvedValue(false)
    const r = await inside(() => runRankDefendOnce())
    expect(new Set(rec.placements)).toEqual(new Set(['rk-gale', 'rk-misano']))
    expect(r).not.toHaveProperty('leverHeld')
    expect(rankDefendSummaryLine(r)).not.toContain('brain-levers')
  })

  it('placements held by the Owner\'s lock: that campaign is left whole, the other as before; counted', async () => {
    h.campaignLeverOwners.mockImplementation(async (ids: string[]) => new Map(ids.filter((id) => id === 'rk-gale').map((id) => [id, { campaignId: id, name: id, market: 'IT', levers: { placements: LOCKED } }])))
    const r = await inside(() => runRankDefendOnce())
    expect(rec.placements).toEqual(['rk-misano'])
    expect(r.decisions.map((d) => d.campaignId)).not.toContain('rk-gale')
    expect(r.leverHeld).toEqual({ ownerLock: { placements: 1 } })
    expect(rankDefendSummaryLine(r)).toContain('brain-levers=the Owner\'s lock: placements 1 (one owner per lever)')
    expect(h.campaignLeverOwners).toHaveBeenCalledTimes(1)
  })

  it('ad-group default bids held: left whole too', async () => {
    h.campaignLeverOwners.mockImplementation(async (ids: string[]) => new Map(ids.filter((id) => id === 'rk-misano').map((id) => [id, { campaignId: id, name: id, market: 'IT', levers: { adGroupBids: LOCKED } }])))
    const r = await inside(() => runRankDefendOnce())
    expect(rec.placements).toEqual(['rk-gale'])
    expect(r.leverHeld).toEqual({ ownerLock: { adGroupBids: 1 } })
  })
})

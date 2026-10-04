/**
 * 7a (review 8.2, 8.3) — the Automations page's engine rows, on a real PostgreSQL with the production schema (PGlite).
 *
 *   8.3  Autopilot plans and budget schedules write to Amazon and had no row: their writes showed only as "observed"
 *        actor strings. They have engine rows now, and their writes count there.
 *   8.2  Each engine row carries whether it can change Amazon by itself and its plain group, so the page counts as
 *        "writing" only the engines that act — and still lists every engine.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// ads-actors.service.ts reads `prisma` from @nexus/database, the levers read ../../db.js: both are the test database.
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }) }))
vi.mock('@nexus/database', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  prisma: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../lib/queue.js', () => {
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

import { getActors } from './ads-actors.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const KEYS = ['NEXUS_ENABLE_AMAZON_ADS_CRON', 'NEXUS_AMAZON_ADS_MODE', 'NEXUS_ENABLE_RANK_DEFEND', 'NEXUS_BUDGET_ENFORCE_APPLY'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))

beforeAll(async () => {
  database = await formulaDatabase()
  Object.assign(process.env, { NEXUS_ENABLE_AMAZON_ADS_CRON: '1', NEXUS_AMAZON_ADS_MODE: 'live', NEXUS_ENABLE_RANK_DEFEND: '1', NEXUS_BUDGET_ENFORCE_APPLY: '1' })
  await inside(async () => {
    await database.client.adsAutomationState.create({ data: { id: 'singleton', autonomy: 'AUTO' } })
    for (const userId of ['automation:autopilot-plan-1', 'automation:autopilot', 'automation:budget-schedule-s1', 'automation:reconcile']) {
      await database.client.advertisingActionLog.create({ data: { userId, actionType: 'bid_down', entityType: 'CAMPAIGN', entityId: 'c1', payloadBefore: {}, payloadAfter: {} } })
    }
  })
}, 180_000)
afterAll(async () => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  await database?.close()
}, 30_000)

describe('7a — engine rows on the Automations page', () => {
  it('THE FINDING (8.3): autopilot and budget-schedule writes count on their own engine rows, not as observed strings', async () => {
    const { engines, observed } = await inside(() => getActors())
    expect(engines.find((e) => e.key === 'autopilot')).toMatchObject({ name: 'Autopilot plans', writes7d: 2, catalogId: 'A5', activity: 'acted' })
    expect(engines.find((e) => e.key === 'budget-schedules')).toMatchObject({ name: 'Budget schedules', writes7d: 1, catalogId: 'A7', activity: 'acted' })
    expect(observed.map((o) => o.actor)).not.toEqual(expect.arrayContaining(['automation:autopilot-plan-1']))
    expect(observed.map((o) => o.actor)).not.toEqual(expect.arrayContaining(['automation:budget-schedule-s1']))
    // An engine with no row of its own is still never hidden: the retry of failed changes stays an observed row.
    expect(observed).toEqual(expect.arrayContaining([expect.objectContaining({ actor: 'automation:reconcile', label: expect.stringContaining('no row of its own') })]))
  })

  it('8.2 — each row says whether it changes Amazon by itself and its group; every engine stays listed', async () => {
    const { engines } = await inside(() => getActors())
    const by = new Map(engines.map((e) => [e.key, e]))
    expect(by.get('anomaly-guard')).toMatchObject({ posture: 'AUTO', writesOnOwn: false, exposure: { group: 'never' } })
    expect(by.get('write-delivery')).toMatchObject({ posture: 'AUTO', writesOnOwn: false, exposure: { group: 'never' } })
    expect(by.get('dayparting')).toMatchObject({ posture: 'AUTO', writesOnOwn: true, exposure: { group: 'ready', label: 'Ready — nothing set up' } })
    expect(by.get('auto-bid')).toMatchObject({ posture: 'AUTO', writesOnOwn: true, exposure: { group: 'acts' } })
    expect(engines.filter((e) => e.exposure.group === 'acts').map((e) => e.key)).toEqual(['auto-bid'])
    expect(engines).toHaveLength(13)
  })
})

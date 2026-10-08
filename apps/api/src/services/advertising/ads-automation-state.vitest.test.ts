/**
 * Group 1 (1g, review findings 2.9 and 2.12) — the brakes a person moves: the account dial, halt, Resume and the
 * breaker's limits.
 *
 * Before: the routes called the setters directly. No change left an audit row; the thresholds route spread its body
 * into the upsert, so 0 or a negative limit was stored (0 € switches the spend signal off) and any other column rode
 * along; Resume cleared only the halt, which is right, but no screen could move the dial back up from OFF.
 *
 * Runs on a disposable real PostgreSQL (PGlite), inside the legacy business: the service, then the routes.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('./ads-automation-notify.service.js', () => ({ notifyAutomation: vi.fn(async () => undefined) }))
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
vi.mock('./ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))

const state = await import('./ads-automation-state.service.js')

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const PERSON = 'user:dial-person'

let app: FastifyInstance

beforeAll(async () => {
  database = await formulaDatabase()
  const { default: advertisingRoutes } = await import('../../routes/advertising.routes.js')
  app = Fastify()
  // The signed-in person, as the auth hook sets it. No x-actor-id header: the web never sends one.
  app.addHook('onRequest', async (request) => { (request as { authUser?: { id: string } }).authUser = { id: 'route-person' } })
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
}, 180_000)
afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

beforeEach(async () => {
  delete process.env.NEXUS_ADS_ENGINE_CAPS
  delete process.env.NEXUS_ADS_AUTOMATION_KILL
  await inside(async () => {
    await database.client.advertisingActionLog.deleteMany({})
    await database.client.adsAutomationState.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', autonomy: 'AUTO' },
      update: { autonomy: 'AUTO', halted: false, haltedAt: null, haltReason: null, haltedBy: null, maxActionsPerHour: null, maxHourlySpendCentsEur: null },
    })
  })
})

const row = () => inside(() => database.client.adsAutomationState.findUnique({ where: { id: 'singleton' } }))
const audit = () => inside(() => database.client.advertisingActionLog.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
const auditShape = async () => (await audit()).map((r) => ({
  userId: r.userId, actionType: r.actionType, entityType: r.entityType, entityId: r.entityId, before: r.payloadBefore, after: r.payloadAfter,
}))

describe('the dial and Resume', () => {
  it('moving the dial writes one audit row with the person and from → to; a move to where it is writes none', async () => {
    expect(await inside(() => state.changeAutonomy('SUGGEST', PERSON))).toEqual({ ok: true })
    expect(await inside(() => state.changeAutonomy('SUGGEST', PERSON))).toEqual({ ok: true })
    expect((await row())?.autonomy).toBe('SUGGEST')
    expect(await auditShape()).toEqual([
      { userId: PERSON, actionType: 'set_automation_level', entityType: 'ADS_DIAL', entityId: 'ads-dial', before: { autonomy: 'AUTO' }, after: { autonomy: 'SUGGEST' } },
    ])
  })

  it('a level that is not OFF, SUGGEST or AUTO is refused in a sentence and changes nothing', async () => {
    for (const bad of ['MANUAL', 'auto', undefined, 3]) {
      expect(await inside(() => state.changeAutonomy(bad, PERSON))).toEqual({ ok: false, error: 'The dial level must be OFF, SUGGEST or AUTO.' })
    }
    expect((await row())?.autonomy).toBe('AUTO')
    expect(await audit()).toEqual([])
  })

  it('THE REGRESSION: Resume clears a halt but not a dial at OFF; the dial is what turns it back on', async () => {
    await inside(() => state.changeAutonomy('OFF', PERSON))
    await inside(() => state.haltWithAudit('Stopped from the Control Room', PERSON))
    expect(await inside(() => state.isAutomationHalted())).toBe(true)

    await inside(() => state.resumeWithAudit(PERSON))
    expect(await row()).toMatchObject({ halted: false, autonomy: 'OFF' })
    expect(await inside(() => state.isAutomationHalted())).toBe(true) // still stopped: the dial is at OFF

    await inside(() => state.changeAutonomy('AUTO', PERSON))
    expect(await inside(() => state.isAutomationHalted())).toBe(false)

    expect((await auditShape()).map((r) => [r.actionType, r.before, r.after])).toEqual([
      ['set_automation_level', { autonomy: 'AUTO' }, { autonomy: 'OFF' }],
      ['halt_automation', { halted: false, haltReason: null }, { halted: true, haltReason: 'Stopped from the Control Room' }],
      ['resume_automation', { halted: true, haltReason: 'Stopped from the Control Room' }, { halted: false, haltReason: null }],
      ['set_automation_level', { autonomy: 'OFF' }, { autonomy: 'AUTO' }],
    ])
  })

  it('moving the dial does not lift a halt; Resume when nothing is halted writes no row', async () => {
    await inside(() => state.haltWithAudit('', PERSON)) // an empty reason gets the default
    await inside(() => state.changeAutonomy('SUGGEST', PERSON))
    await inside(() => state.changeAutonomy('AUTO', PERSON))
    expect(await row()).toMatchObject({ halted: true, haltReason: 'Operator halt', haltedBy: PERSON, autonomy: 'AUTO' })
    expect(await inside(() => state.isAutomationHalted())).toBe(true)

    await inside(() => state.resumeWithAudit(PERSON))
    await inside(() => state.resumeWithAudit(PERSON))
    expect((await audit()).filter((r) => r.actionType === 'resume_automation')).toHaveLength(1)
  })
})

describe('the breaker limits', () => {
  it('refuses 0, negatives, fractions, text, other columns and an empty body, in a sentence, with nothing stored or audited', async () => {
    const actions = 'Rule actions per hour (maxActionsPerHour) must be a whole number of at least 1, or empty to use the default.'
    const spend = 'Spend per hour in cents (maxHourlySpendCentsEur) must be a whole number of at least 1, or empty to use the default.'
    const cases: Array<[unknown, string]> = [
      [{ maxActionsPerHour: 0 }, actions],
      [{ maxActionsPerHour: -5 }, actions],
      [{ maxActionsPerHour: 2.5 }, actions],
      [{ maxActionsPerHour: '10' }, actions],
      [{ maxHourlySpendCentsEur: 0 }, spend],
      [{ maxHourlySpendCentsEur: 3_000_000_000 }, spend],
      [{ maxActionsPerHour: 10, halted: false }, 'Only maxActionsPerHour and maxHourlySpendCentsEur can be set here, not halted.'],
      [{}, 'Send maxActionsPerHour and/or maxHourlySpendCentsEur.'],
      [null, 'Send maxActionsPerHour and/or maxHourlySpendCentsEur.'],
    ]
    for (const [body, error] of cases) {
      expect(await inside(() => state.changeGuardThresholds(body, PERSON))).toEqual({ ok: false, error })
    }
    expect(await row()).toMatchObject({ maxActionsPerHour: null, maxHourlySpendCentsEur: null, halted: false })
    expect(await audit()).toEqual([])
  })

  it('a whole number of at least 1 is stored; null goes back to the default; each change leaves one row, a repeat none', async () => {
    expect(await inside(() => state.changeGuardThresholds({ maxActionsPerHour: 300, maxHourlySpendCentsEur: 20_000 }, PERSON))).toEqual({ ok: true })
    expect(await inside(() => state.changeGuardThresholds({ maxActionsPerHour: 300 }, PERSON))).toEqual({ ok: true })
    expect(await inside(() => state.changeGuardThresholds({ maxActionsPerHour: null }, PERSON))).toEqual({ ok: true })
    expect(await row()).toMatchObject({ maxActionsPerHour: null, maxHourlySpendCentsEur: 20_000 })
    expect(await auditShape()).toEqual([
      {
        userId: PERSON, actionType: 'tune_engine_setting', entityType: 'ADS_AUTOMATION_STATE', entityId: 'breaker',
        before: { maxActionsPerHour: null, maxHourlySpendCentsEur: null }, after: { maxActionsPerHour: 300, maxHourlySpendCentsEur: 20_000 },
      },
      {
        userId: PERSON, actionType: 'tune_engine_setting', entityType: 'ADS_AUTOMATION_STATE', entityId: 'breaker',
        before: { maxActionsPerHour: 300, maxHourlySpendCentsEur: 20_000 }, after: { maxActionsPerHour: null, maxHourlySpendCentsEur: 20_000 },
      },
    ])
  })

  it('each engine\'s limits come from the one caps table, env override included', () => {
    process.env.NEXUS_ADS_ENGINE_CAPS = JSON.stringify({ 'rank-defend': { breakerPerHour: 1_500 } })
    const limits = state.engineLimits()
    expect(limits.map((l) => l.key)).toEqual([
      'rank-defend', 'dayparting', 'budget-schedules', 'budget-enforce', 'budget-pools',
      'auto-bid', 'tos-defense', 'coverage-engine', 'autopilot', 'write-reconcile', 'bid-brain', 'unknown',
    ])
    expect(limits[0]).toEqual({ key: 'rank-defend', label: 'Hourly bid plans', perTick: 600, perDay: 3_000, breakerPerHour: 1_500 })
    expect(limits.at(-1)).toEqual({ key: 'unknown', label: 'Changes with no known author', perTick: null, perDay: null, breakerPerHour: 300 })
  })
})

describe('the routes', () => {
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url: `/api/advertising/automation/${url}`, payload })

  it('GET state carries each engine\'s limits', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/advertising/automation/state' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ autonomy: 'AUTO', halted: false })
    expect(r.json().engineLimits).toContainEqual({ key: 'dayparting', label: 'Classic dayparting', perTick: 300, perDay: 1_500, breakerPerHour: 600 })
  })

  it('the dial: { level } moves it with the signed-in person in the row; the old console\'s { autonomy } is a 400', async () => {
    const old = await post('autonomy', { autonomy: 'SUGGEST' })
    expect([old.statusCode, old.json()]).toEqual([400, { error: 'The dial level must be OFF, SUGGEST or AUTO.' }])
    const moved = await post('autonomy', { level: 'OFF' })
    expect(moved.statusCode).toBe(200)
    expect(moved.json()).toMatchObject({ autonomy: 'OFF', effectivelyStopped: true })
    expect((await audit()).map((r) => [r.actionType, r.userId])).toEqual([['set_automation_level', 'user:route-person']])
  })

  it('halt and Resume record who; a threshold of 0 is a 400 and is not stored', async () => {
    await post('halt', { reason: 'Stopped from the Control Room' })
    expect((await row())?.haltedBy).toBe('user:route-person')
    const resumed = await post('resume', {})
    expect(resumed.json()).toMatchObject({ halted: false })
    const zero = await post('thresholds', { maxActionsPerHour: 0, maxHourlySpendCentsEur: null })
    expect(zero.statusCode).toBe(400)
    expect(zero.json().error).toContain('must be a whole number of at least 1')
    expect((await row())?.maxActionsPerHour).toBeNull()
    expect((await audit()).map((r) => [r.actionType, r.userId])).toEqual([
      ['halt_automation', 'user:route-person'],
      ['resume_automation', 'user:route-person'],
    ])
  })
})

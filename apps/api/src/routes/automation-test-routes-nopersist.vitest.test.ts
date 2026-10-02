/**
 * R8 (MCP full control, part 06 gap 6) — the operations rules' Test / dry-run buttons are previews: they leave no run
 * row and raise no counter.
 *
 * R3 made the ads rule Test and Simulate clean. The listing, replenishment, bulk-operation and marketing rule pages had
 * the same button and still evaluated like a tick: one AutomationRuleExecution per press, evaluation / match /
 * execution counters raised, and the press spent the rule's own maxExecutionsPerDay. preview-automation (R8) runs
 * these rules the same way, so the buttons now pass `noPersist` too. A marketing run with ?mode=apply is a real run
 * and still records.
 *
 * On a real PostgreSQL (PGlite, production schema), through the routes.
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

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

let app: FastifyInstance
const ids: Record<string, string> = {}

beforeAll(async () => {
  database = await formulaDatabase()
  const [{ default: listing }, { default: fulfillment }, { default: bulk }, { default: marketing }] = await Promise.all([
    import('./listing-automation-rules.routes.js'),
    import('./fulfillment.routes.js'),
    import('./bulk-automation-rules.routes.js'),
    import('./marketing-os.routes.js'),
  ])
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  for (const plugin of [listing, fulfillment, bulk, marketing]) await app.register(plugin, { prefix: '/api' })
  await app.ready()
  await inside(async () => {
    // Enabled, matching everything, with an action that only logs: the case where a press would most surely be recorded.
    const rule = (domain: string, trigger: string) => database.client.automationRule.create({
      data: { domain, name: `TEST ${domain} rule`, trigger, enabled: true, dryRun: true, conditions: [], actions: [{ type: 'log_only' }], maxExecutionsPerDay: 50 },
    })
    ids.listings = (await rule('listings', 'listing_price_changed')).id
    ids.replenishment = (await rule('replenishment', 'recommendation_generated')).id
    ids.bulk = (await rule('bulk-operations', 'bulk_cron_tick')).id
    ids.marketing = (await rule('marketing', 'MKT_CRON_TICK')).id
  })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

const recorded = (ruleId: string) => inside(async () => ({
  runs: await database.client.automationRuleExecution.count({ where: { ruleId } }),
  rule: await database.client.automationRule.findUniqueOrThrow({ where: { id: ruleId }, select: { evaluationCount: true, matchCount: true, executionCount: true, lastEvaluatedAt: true } }),
}))
const nothing = { runs: 0, rule: { evaluationCount: 0, matchCount: 0, executionCount: 0, lastEvaluatedAt: null } }

describe('R8 — the operations rules\' test buttons leave nothing behind', () => {
  it('listing rule dry-run: evaluated and reported, no run row, no counter', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/listing-automation-rules/${ids.listings}/dry-run`, payload: { context: { product: { id: 'p1' } } } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ success: true, result: { matched: true, status: 'DRY_RUN', actionResults: [{ type: 'log_only', ok: true }] } })
    expect(await recorded(ids.listings)).toEqual(nothing)
  })

  it('replenishment rule test: evaluated and reported, no run row, no counter', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/fulfillment/replenishment/automation/rules/${ids.replenishment}/test`, payload: { context: { recommendation: { id: 'r1' } } } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ matched: true, status: 'DRY_RUN' })
    expect(await recorded(ids.replenishment)).toEqual(nothing)
  })

  it('bulk-operation rule dry-run: evaluated and reported, no run row, no counter', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/bulk-automation-rules/${ids.bulk}/dry-run`, payload: { context: {} } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ success: true, result: { matched: true, status: 'DRY_RUN' } })
    expect(await recorded(ids.bulk)).toEqual(nothing)
  })

  it('marketing rule run (a dry run by default): no run row, no counter; ?mode=apply is a real run and records (control)', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/marketing/os/rules/${ids.marketing}/run` })
    expect(res.json()).toMatchObject({ forceDryRun: true, result: { matched: true, status: 'DRY_RUN' } })
    expect(await recorded(ids.marketing)).toEqual(nothing)
    const real = await app.inject({ method: 'POST', url: `/api/marketing/os/rules/${ids.marketing}/run?mode=apply` })
    expect(real.json()).toMatchObject({ forceDryRun: false, result: { matched: true } })
    expect((await recorded(ids.marketing)).runs).toBe(1)
  })
})

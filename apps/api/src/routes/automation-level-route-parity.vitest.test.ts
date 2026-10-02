/**
 * R10 (MCP full control, part 06) — PATCH /advertising/autonomy/rules/:id (the A12 level dial) answers byte for byte as
 * before its logic moved into automation's level service (setAdsRuleLevel, ads-rule-crud.service.ts), which
 * turn-up-automation / turn-down-automation now share.
 *
 * Every outcome — a bad level, not found, above the graduation ceiling, each level — on a real PostgreSQL (PGlite).
 * The snapshot beside this file was WRITTEN BY THE ROUTE BEFORE THE MOVE and read unchanged after it. Then D-R1
 * (Owner, 2026-10-01: AUTO only after the graduation gate, also for this dial) changed exactly its two AUTO answers to
 * 409 gate_not_open, naming the checks that failed; the snapshot holds that.
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
vi.mock('../services/advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const ids = new Map<string, string>()
const normalise = (text: string) => text
  .replace(/\bc[a-z0-9]{24}\b/g, (id) => (ids.has(id) ? ids.get(id)! : (ids.set(id, `<id${ids.size + 1}>`), ids.get(id)!)))
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>')

let app: FastifyInstance
const rules: Record<string, string> = {}
beforeAll(async () => {
  database = await formulaDatabase()
  const { default: advertisingRoutes } = await import('./advertising.routes.js')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
  await withWorkspace(business, async () => {
    const rule = (name: string, actions: object[]) => database.client.automationRule.create({ data: { domain: 'advertising', name, trigger: 'KEYWORD_HIGH_ACOS', actions, conditions: [] } })
    rules.bid = (await rule('PARITY bid rule', [{ type: 'bid_down', percent: 5 }])).id
    rules.pause = (await rule('PARITY pausing rule', [{ type: 'pause_campaign' }])).id
    rules.placement = (await rule('PARITY placement rule', [{ type: 'set_placement_multiplier', placement: 'PLACEMENT_TOP', percentage: 30 }])).id
  })
}, 180_000)
afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

describe('R10 — the level route answers as before the move', () => {
  it('every outcome', async () => {
    const answers: string[] = []
    const send = async (id: string, payload: object) => {
      const res = await app.inject({ method: 'PATCH', url: `/api/advertising/autonomy/rules/${id}`, payload, headers: { 'x-actor-id': 'parity-person' } })
      answers.push(`${res.statusCode} ${normalise(res.body)}`)
    }
    await send(rules.bid, { level: 'SOMETIMES' })
    await send(rules.bid, {})
    await send('nope', { level: 'OBSERVE' })
    await send(rules.pause, { level: 'AUTO' })
    await send(rules.pause, { level: 'PROPOSE' })
    await send(rules.placement, { level: 'AUTO' })
    for (const level of ['OBSERVE', 'PROPOSE', 'AUTO', 'OFF']) await send(rules.bid, { level })
    expect(answers.join('\n')).toMatchSnapshot()
  })
})

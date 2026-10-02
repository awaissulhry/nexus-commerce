/**
 * R15 (MCP full control, part 06) — the fleet's steering routes answer byte for byte as before their logic moved into
 * fleet-steer.service.ts, which steer-fleet calls:
 *   PATCH /agent/fleet/charters/:key          → patchCharter    (enable, level ≤ the charter's cap, AUTO's gate, policy)
 *   POST  /agent/fleet/charters/:key/pause    → pauseCharter
 *   POST  /agent/fleet/charters/:key/resume   → resumeCharter
 *   POST  /agent/fleet/run/:key               → runCharterNow   (the model call is stubbed here: no AI spend)
 *
 * The answers AND the rows each request leaves (the charter, the control audit) are recorded. On a real PostgreSQL
 * (PGlite). The snapshot beside this file was WRITTEN BY THE ROUTES BEFORE THE MOVE and is read unchanged after it.
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
// The model call: never made here. The stub answers as a run would, once ok and once failed.
const executor = vi.hoisted(() => ({ executeCharter: vi.fn() }))
vi.mock('../services/agent-fleet/agent-executor.js', async (importOriginal) => ({ ...(await importOriginal<object>()), executeCharter: executor.executeCharter }))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const ids = new Map<string, string>()
const normalise = (text: string) => text
  .replace(/\bc[a-z0-9]{24}\b/g, (id) => (ids.has(id) ? ids.get(id)! : (ids.set(id, `<id${ids.size + 1}>`), ids.get(id)!)))
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>')

let app: FastifyInstance
const answers: string[] = []
const savedKill = process.env.NEXUS_AI_KILL_SWITCH

async function ask(method: 'PATCH' | 'POST', url: string, payload?: object) {
  const res = await app.inject({ method, url, ...(payload ? { payload } : {}) })
  answers.push(`${method} ${url} → ${res.statusCode} ${normalise(res.body)}`)
}

/** What a request left behind: the steered charters and every control audit row so far. */
async function state(label: string) {
  const out = await inside(async () => ({
    charters: await database.client.agentCharter.findMany({
      where: { key: { in: ['amazon-ads-director', 'amazon-bid-tuner'] } }, orderBy: { key: 'asc' },
      select: { key: true, enabled: true, autonomyLevel: true, dailyBudgetUSD: true, maxTokensPerRun: true, maxFindingsPerRun: true, toolNames: true, scopeMarketplaces: true, pausedUntil: true, pausedReason: true, modelProviderOverride: true, modelNameOverride: true },
    }),
    audit: await database.client.agentControlAudit.findMany({ orderBy: { createdAt: 'asc' }, select: { charterKey: true, action: true, fromValue: true, toValue: true, note: true, actor: true } }),
  }))
  answers.push(`  ${label}: ${normalise(JSON.stringify(out))}`)
}

beforeAll(async () => {
  database = await formulaDatabase()
  const { default: agentFleetRoutes } = await import('./agent-fleet.routes.js')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(agentFleetRoutes, { prefix: '/api' })
  await app.ready()
}, 180_000)
afterAll(async () => {
  if (savedKill === undefined) delete process.env.NEXUS_AI_KILL_SWITCH
  else process.env.NEXUS_AI_KILL_SWITCH = savedKill
  await app?.close()
  await database?.close()
}, 30_000)

describe('R15 — the fleet steering routes answer as before the move', () => {
  it('every outcome, and the rows each leaves', { timeout: 120_000 }, async () => {
    delete process.env.NEXUS_AI_KILL_SWITCH
    // ── Charter policy (before and after the seed) ──
    await ask('PATCH', '/api/agent/fleet/charters/no-such-charter', { enabled: true })
    await ask('PATCH', '/api/agent/fleet/charters/amazon-bid-tuner', { enabled: true })
    await ask('POST', '/api/agent/fleet/charters/seed')
    await ask('PATCH', '/api/agent/fleet/charters/amazon-bid-tuner', {})
    await ask('PATCH', '/api/agent/fleet/charters/amazon-bid-tuner', { dailyBudgetUSD: 0 })
    await ask('PATCH', '/api/agent/fleet/charters/amazon-bid-tuner', { toolNames: ['send-customer-message'] })
    await ask('PATCH', '/api/agent/fleet/charters/amazon-bid-tuner', { scopeMarketplaces: ['IT', 'DE'] })
    await ask('PATCH', '/api/agent/fleet/charters/amazon-bid-tuner', { autonomyLevel: 'SOMETIMES' })
    await ask('PATCH', '/api/agent/fleet/charters/amazon-bid-tuner', { autonomyLevel: 'PROPOSE' })
    await ask('PATCH', '/api/agent/fleet/charters/amazon-ads-director', { autonomyLevel: 'AUTO' })
    await ask('PATCH', '/api/agent/fleet/charters/amazon-bid-tuner', { enabled: true, autonomyLevel: 'OBSERVE' })
    await ask('PATCH', '/api/agent/fleet/charters/amazon-bid-tuner', { dailyBudgetUSD: 2, maxTokensPerRun: 9000, maxFindingsPerRun: 7, modelProvider: '', modelName: 'test-model', scopeMarketplaces: ['IT'] })
    await ask('PATCH', '/api/agent/fleet/charters/amazon-ads-director', { enabled: false })
    await state('policy')
    // ── Pause and resume ──
    await ask('POST', '/api/agent/fleet/charters/no-such-charter/pause', { until: '2999-01-01T00:00:00.000Z' })
    await ask('POST', '/api/agent/fleet/charters/amazon-bid-tuner/pause', {})
    await ask('POST', '/api/agent/fleet/charters/amazon-bid-tuner/pause', { until: '2001-01-01T00:00:00.000Z' })
    await ask('POST', '/api/agent/fleet/charters/amazon-bid-tuner/pause', { until: '2999-01-01T00:00:00.000Z', reason: '  parity pause  ' })
    await state('paused')
    await ask('POST', '/api/agent/fleet/charters/no-such-charter/resume')
    await ask('POST', '/api/agent/fleet/charters/amazon-bid-tuner/resume')
    await state('resumed')
    // ── Run now ──
    executor.executeCharter.mockResolvedValueOnce({ ok: true, runId: 'run-parity-1', findings: 2 })
    await ask('POST', '/api/agent/fleet/run/amazon-bid-tuner')
    executor.executeCharter.mockResolvedValueOnce({ ok: false, error: 'the parity run failed' })
    await ask('POST', '/api/agent/fleet/run/amazon-bid-tuner')
    executor.executeCharter.mockResolvedValueOnce({ ok: false, haltedReason: 'fleet halted' })
    await ask('POST', '/api/agent/fleet/run/amazon-bid-tuner')
    await ask('POST', '/api/agent/fleet/run/no-such-charter')
    process.env.NEXUS_AI_KILL_SWITCH = 'on'
    await ask('POST', '/api/agent/fleet/run/amazon-bid-tuner')
    delete process.env.NEXUS_AI_KILL_SWITCH
    answers.push(`  executeCharter calls: ${JSON.stringify(executor.executeCharter.mock.calls)}`)
    expect(answers.join('\n')).toMatchSnapshot()
  })
})

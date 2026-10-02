/**
 * MCP full control R18 (part 06 gap 13) — the replenishment automation routes reach replenishment rules only.
 *
 * Until R18 these routes asked for ads.automation.manage (the broad `/automation` matcher), and they accepted ANY
 * domain: a `domain` in the body or the query, and any rule id. Now they ask for replenishment.view / replenishment.run,
 * so a replenishment planner must not reach an ads, review or listing rule through them: listing, creating, editing,
 * deleting, testing, reading the runs of, or stopping a rule of another domain is refused here, as not found (an id) or
 * as the wrong route (a domain). Their own replenishment rules work as before.
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
const BASE = '/api/fulfillment/replenishment/automation'
let app: FastifyInstance
const ids: Record<string, string> = {}

beforeAll(async () => {
  database = await formulaDatabase()
  const { default: fulfillment } = await import('./fulfillment.routes.js')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(fulfillment, { prefix: '/api' })
  await app.ready()
  await inside(async () => {
    const rule = (domain: string, name: string) => database.client.automationRule.create({ data: { domain, name, trigger: 'SCHEDULE', enabled: true, actions: [{ type: 'notify' }] } })
    ids.ads = (await rule('advertising', 'TEST ads rule')).id
    ids.reviews = (await rule('reviews', 'TEST review rule')).id
    ids.repl = (await rule('replenishment', 'TEST restock rule')).id
  })
}, 180_000)
afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

const send = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) })
const rowOf = (id: string) => inside(() => database.client.automationRule.findUnique({ where: { id }, select: { name: true, enabled: true, domain: true } }))

describe('R18 — the replenishment automation routes reach replenishment rules only', () => {
  it('a rule of another domain is not found: read, edit, delete, test, runs', async () => {
    for (const id of [ids.ads, ids.reviews]) {
      expect((await send('GET', `${BASE}/rules/${id}`)).statusCode).toBe(404)
      expect((await send('PATCH', `${BASE}/rules/${id}`, { enabled: false, name: 'hijacked' })).statusCode).toBe(404)
      expect((await send('DELETE', `${BASE}/rules/${id}`)).statusCode).toBe(404)
      expect((await send('POST', `${BASE}/rules/${id}/test`, { context: {} })).statusCode).toBe(404)
      expect((await send('GET', `${BASE}/rules/${id}/executions`)).json()).toEqual({ executions: [] })
    }
    expect(await rowOf(ids.ads)).toEqual({ name: 'TEST ads rule', enabled: true, domain: 'advertising' })
    expect(await rowOf(ids.reviews)).toEqual({ name: 'TEST review rule', enabled: true, domain: 'reviews' })
  })

  it('another domain by name is refused: list, create, move by edit, stop', async () => {
    const wrong = { error: 'This route reaches replenishment rules only.' }
    expect((await send('GET', `${BASE}/rules?domain=advertising`)).json()).toEqual(wrong)
    const created = await send('POST', `${BASE}/rules`, { name: 'TEST sneaky', trigger: 'SCHEDULE', domain: 'advertising' })
    expect([created.statusCode, created.json()]).toEqual([400, wrong])
    const moved = await send('PATCH', `${BASE}/rules/${ids.repl}`, { domain: 'advertising' })
    expect([moved.statusCode, moved.json()]).toEqual([400, wrong])
    const stopAll = await send('POST', `${BASE}/emergency-disable-all`, { allDomains: true })
    expect([stopAll.statusCode, stopAll.json()]).toEqual([400, wrong])
    expect((await send('POST', `${BASE}/emergency-disable-all`, { domain: 'advertising' })).statusCode).toBe(400)
    expect(await rowOf(ids.ads)).toMatchObject({ enabled: true })
  })

  it('control: replenishment rules work as before', async () => {
    const list = (await send('GET', `${BASE}/rules`)).json() as { rules: Array<{ id: string }> }
    expect(list.rules.map((r) => r.id)).toEqual([ids.repl])
    expect((await send('GET', `${BASE}/rules?domain=replenishment`)).statusCode).toBe(200)
    expect((await send('PATCH', `${BASE}/rules/${ids.repl}`, { name: 'TEST restock rule (renamed)' })).statusCode).toBe(200)
    expect((await send('POST', `${BASE}/rules`, { name: 'TEST new restock rule', trigger: 'SCHEDULE' })).statusCode).toBe(201)
    const stopped = await send('POST', `${BASE}/emergency-disable-all`, {})
    expect(stopped.json()).toMatchObject({ ok: true, disabledCount: 1, domain: 'replenishment' })
    expect(await rowOf(ids.ads)).toMatchObject({ enabled: true })
  })
})

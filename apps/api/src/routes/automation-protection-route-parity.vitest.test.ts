/**
 * R13 (MCP full control, part 06) — POST and DELETE /advertising/keyword-protections answer byte for byte as before their logic moved into
 * addKeywordProtection / removeKeywordProtection (ads-guardrail.service.ts), which set-ad-guardrail uses for protected
 * terms: one path for both.
 *
 * On a real PostgreSQL (PGlite). The snapshot beside this file was WRITTEN BY THE ROUTE BEFORE THE MOVE and is read
 * unchanged after it — with one deliberate change since: ads fix 5c removed "Always negate", so the two BLACKLIST
 * posts (any letter case) now answer 400 instead of storing a row (the lower-case one used to store a WHITELIST).
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
const rows: Record<string, string> = {}
beforeAll(async () => {
  database = await formulaDatabase()
  const { default: advertisingRoutes } = await import('./advertising.routes.js')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
  await withWorkspace(business, async () => {
    const campaign = await database.client.campaign.create({ data: { name: 'PARITY CAMPAIGN', type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT' } })
    rows.campaign = campaign.id
  })
}, 180_000)
afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

describe('R13 — the protected-term routes answer as before the move', () => {
  it('every outcome', async () => {
    const answers: string[] = []
    const send = async (method: 'POST' | 'DELETE', url: string, payload?: object) => {
      const res = await app.inject({ method, url, ...(payload ? { payload } : {}), headers: { 'x-actor-id': 'parity-person' } })
      answers.push(`${method} ${res.statusCode} ${normalise(res.body)}`)
      return res
    }
    await send('POST', '/api/advertising/keyword-protections', { term: '   ' })
    await send('POST', '/api/advertising/keyword-protections', { term: 'gale jacket', matchType: 'FUZZY' })
    const first = await send('POST', '/api/advertising/keyword-protections', { term: '  Gale   JACKET ', reason: 'parity' })
    await send('POST', '/api/advertising/keyword-protections', { term: 'gale jacket' })
    await send('POST', '/api/advertising/keyword-protections', { term: 'gale jacket', matchType: 'contains' })
    await send('POST', '/api/advertising/keyword-protections', { term: 'gale', isPrefix: true, marketplace: 'IT', campaignId: rows.campaign })
    await send('POST', '/api/advertising/keyword-protections', { term: 'cheap', mode: 'BLACKLIST', matchType: 'CONTAINS' })
    await send('POST', '/api/advertising/keyword-protections', { term: 'cheap', mode: 'blacklist' })
    await send('DELETE', '/api/advertising/keyword-protections/nope')
    await send('DELETE', `/api/advertising/keyword-protections/${first.json().item.id}`)
    expect(answers.join('\n')).toMatchSnapshot()
  })
})

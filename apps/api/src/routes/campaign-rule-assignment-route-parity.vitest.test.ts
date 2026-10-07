/**
 * ADS AUTONOMY W4-8 — POST /advertising/campaign-rule-assignments/bulk (the Apply Rules page's one Apply) answers byte for
 * byte as before its logic moved into applyCampaignRuleAssignments (rule-campaign-binding.service.ts), which Claude's
 * assign-ad-rules uses to bind an engine-native budget rule to campaigns: one path, never a second.
 *
 * On a real PostgreSQL (PGlite). The snapshot beside this file was WRITTEN BY THE ROUTE BEFORE THE MOVE and is read
 * unchanged after it; the rows each answer leaves behind are part of it.
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
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
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
  await inside(async () => {
    const c = database.client
    const campaign = (name: string, marketplace: string) => c.campaign.create({ data: { name, type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace, externalCampaignId: `TEST-${name}`, status: 'ENABLED' } })
    rows.it = (await campaign('PARITY IT', 'IT')).id
    rows.de = (await campaign('PARITY DE', 'DE')).id
    rows.engine = (await c.automationRule.create({ data: { domain: 'advertising', name: 'PARITY engine budget rule', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', actions: [{ type: 'adjust_ad_budget', percent: 10 }] } })).id
    rows.builder = (await c.automationRule.create({ data: { domain: 'advertising', name: 'PARITY builder budget rule', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', actions: [{ type: 'budget', campaigns: [{ id: rows.it, name: 'PARITY IT' }], budgetFloor: 1, budgetCeiling: 30 }] } })).id
  })
}, 180_000)
afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

describe('W4-8 — the Apply Rules bulk route answers as before the move', () => {
  it('every outcome, and the rows each leaves', async () => {
    const answers: string[] = []
    const state = async () => inside(async () => {
      const links = await database.client.campaignRuleAssignment.findMany({ select: { campaignId: true, ruleId: true, kind: true, createdBy: true }, orderBy: [{ campaignId: 'asc' }, { ruleId: 'asc' }] })
      const builder = await database.client.automationRule.findUniqueOrThrow({ where: { id: rows.builder }, select: { actions: true } })
      return JSON.stringify({ links: links.map((l) => ({ ...l, campaignId: l.campaignId === rows.it ? 'IT' : 'DE', ruleId: l.ruleId === rows.engine ? 'engine' : 'builder' })), builder: builder.actions })
    })
    const send = async (payload: object) => {
      const res = await app.inject({ method: 'POST', url: '/api/advertising/campaign-rule-assignments/bulk', headers: { 'x-actor-id': 'parity-user' }, payload })
      answers.push(`${res.statusCode} ${normalise(res.body)}`)
      answers.push(`  rows ${normalise(await state())}`)
    }
    await send({ kind: 'budget', changes: [] })
    await send({ changes: [{ campaignId: 'nope', ruleIds: [rows.engine] }, { campaignId: rows.it, ruleIds: ['no-such-rule'] }] })
    await send({ kind: 'budget', changes: [{ campaignId: rows.it, ruleIds: [rows.engine, rows.builder] }, { campaignId: rows.de, ruleIds: [rows.builder] }] })
    await send({ kind: 'budget', changes: [{ campaignId: rows.it, ruleIds: [] }, { campaignId: 'skipped-no-rule-list' }] })
    expect(answers.join('\n')).toMatchSnapshot()
  })
})

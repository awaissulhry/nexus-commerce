/**
 * R4 (MCP full control, part 06 gap 5) — every change to an automation rule or a guardrail leaves an audit row naming
 * the person and what it was before and after.
 *
 * Before R4 only the level route wrote one (`set_rule_autonomy`). A rule could be created, edited, switched off with
 * every other rule, or deleted — and a delete takes the rule's whole run history with it — with no record of who did
 * it or what the rule had been. Spend ceilings and bid policies, the brakes every engine is bound by, could be
 * loosened or removed with no record at all, and so could an eBay rule's switch, mode and delete (its version table
 * keeps config only).
 *
 * Driven through the routes, so the same file proves the old code wrote none of these rows.
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

let app: FastifyInstance
const PERSON = 'audit-person'

beforeAll(async () => {
  database = await formulaDatabase()
  const [{ default: advertisingRoutes }, { default: advertisingIntelRoutes }, { default: ebayAdsRoutes }] = await Promise.all([
    import('./advertising.routes.js'),
    import('./advertising-intel.routes.js'),
    import('./ebay-ads.routes.js'),
  ])
  app = Fastify()
  // The signed-in person, as the auth hook sets it; the ads routes also read the x-actor-id header the web sends.
  app.addHook('onRequest', async (request) => { (request as { authUser?: { id: string } }).authUser = { id: PERSON } })
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(ebayAdsRoutes, { prefix: '/api' })
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.register(advertisingIntelRoutes, { prefix: '/api' })
  await app.ready()
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

const send = (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, ...(payload ? { payload } : {}), headers: { 'x-actor-id': PERSON } })

const adsLog = (entityId: string) => inside(() => database.client.advertisingActionLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } }))

describe('R4 — an audit row for every rule and guardrail change', () => {
  it('an ads rule: create, edit, switch every rule off, delete — each with the person, before and after', async () => {
    const created = await send('POST', '/api/advertising/automation-rules', {
      name: 'Audited rule', trigger: 'SCHEDULE', conditions: [{ field: 'campaign.acos', op: 'gt', value: 0.4 }],
      actions: [{ type: 'adjust_ad_budget', percent: -10 }], maxExecutionsPerDay: 5,
    })
    expect(created.statusCode).toBe(200)
    const id = created.json().rule.id as string
    await send('PATCH', `/api/advertising/automation-rules/${id}`, { enabled: true, maxExecutionsPerDay: 9 })
    // A refused edit changes nothing and records nothing.
    expect((await send('PATCH', `/api/advertising/automation-rules/${id}`, { priority: 0 })).statusCode).toBe(400)
    await send('POST', '/api/advertising/autonomy/pause-all')
    await send('DELETE', `/api/advertising/automation-rules/${id}`)

    const rows = await adsLog(id)
    expect(rows.map((r) => [r.actionType, r.entityType, r.userId])).toEqual([
      ['create_rule', 'RULE', `user:${PERSON}`],
      ['update_rule', 'RULE', `user:${PERSON}`],
      ['update_rule', 'RULE', `user:${PERSON}`],
      ['delete_rule', 'RULE', `user:${PERSON}`],
    ])
    const [create, edit, pauseAll, remove] = rows
    expect(create.payloadBefore).toEqual({})
    expect(create.payloadAfter).toMatchObject({ name: 'Audited rule', trigger: 'SCHEDULE', enabled: false, dryRun: true, maxExecutionsPerDay: 5, actions: [{ type: 'adjust_ad_budget', percent: -10 }] })
    expect(edit.payloadBefore).toEqual({ enabled: false, maxExecutionsPerDay: 5 })
    expect(edit.payloadAfter).toEqual({ enabled: true, maxExecutionsPerDay: 9 })
    expect([pauseAll.payloadBefore, pauseAll.payloadAfter]).toEqual([{ enabled: true }, { enabled: false }])
    // The delete took the run history; its row keeps what the rule was.
    expect(remove.payloadBefore).toMatchObject({ name: 'Audited rule', conditions: [{ field: 'campaign.acos', op: 'gt', value: 0.4 }], maxExecutionsPerDay: 9 })
    expect(remove.payloadAfter).toEqual({})
  })

  it('a spend ceiling and a bid policy: set, loosen, remove — each with the person, before and after', async () => {
    const ceiling = await send('PUT', '/api/advertising/spend-ceilings', { grain: 'MARKET', scopeId: 'IT', label: 'Italy', dailyCapCents: 5000 })
    const ceilingId = ceiling.json().ceiling.id as string
    await send('PUT', '/api/advertising/spend-ceilings', { grain: 'MARKET', scopeId: 'IT', label: 'Italy', dailyCapCents: 9000 })
    await send('DELETE', '/api/advertising/spend-ceilings?grain=MARKET&scopeId=IT')
    const policy = await send('PUT', '/api/advertising/bid-policies', { grain: 'MARKET', scopeId: 'IT', label: 'Italy', maxBidCents: 150 })
    const policyId = policy.json().policy.id as string
    await send('DELETE', '/api/advertising/bid-policies?grain=MARKET&scopeId=IT')

    const ceilingRows = await adsLog(ceilingId)
    expect(ceilingRows.map((r) => [r.actionType, r.entityType, r.userId])).toEqual([
      ['set_spend_ceiling', 'SPEND_CEILING', `user:${PERSON}`],
      ['set_spend_ceiling', 'SPEND_CEILING', `user:${PERSON}`],
      ['delete_spend_ceiling', 'SPEND_CEILING', `user:${PERSON}`],
    ])
    expect(ceilingRows[0].payloadBefore).toEqual({})
    expect(ceilingRows[1].payloadBefore).toMatchObject({ dailyCapCents: 5000 })
    expect(ceilingRows[1].payloadAfter).toMatchObject({ dailyCapCents: 9000, grain: 'MARKET', scopeId: 'IT' })
    expect(ceilingRows[2].payloadAfter).toEqual({})
    const policyRows = await adsLog(policyId)
    expect(policyRows.map((r) => [r.actionType, r.entityType])).toEqual([['set_bid_policy', 'BID_POLICY'], ['delete_bid_policy', 'BID_POLICY']])
    expect(policyRows[1].payloadBefore).toMatchObject({ maxBidCents: 150 })
  })

  it('an eBay rule: create, switch on, edit, delete — each with the person, before and after', async () => {
    const created = await send('POST', '/api/ebay-ads/automation/rules', {
      name: 'Audited eBay rule', trigger: { scope: 'CPS_AD', all: [{ metric: 'clicks', windowDays: 14, op: 'gte', threshold: 30 }] },
      action: { type: 'adjust_ad_rate', deltaPct: -10, minRatePct: 2 }, cooldownHours: 72,
    })
    expect(created.statusCode).toBe(200)
    const id = created.json().id as string
    await send('POST', `/api/ebay-ads/automation/rules/${id}`, { enabled: true })
    await send('POST', `/api/ebay-ads/automation/rules/${id}`, { cooldownHours: 48 })
    await send('DELETE', `/api/ebay-ads/automation/rules/${id}`)

    const rows = await inside(() => database.client.campaignAction.findMany({ where: { entityId: id }, orderBy: { createdAt: 'asc' } }))
    expect(rows.map((r) => [r.actionType, r.entityType, r.channel, r.userId])).toEqual([
      ['create_rule', 'RULE', 'EBAY', PERSON],
      ['update_rule', 'RULE', 'EBAY', PERSON],
      ['update_rule', 'RULE', 'EBAY', PERSON],
      ['delete_rule', 'RULE', 'EBAY', PERSON],
    ])
    expect(rows[1].payloadBefore).toEqual({ enabled: false })
    expect(rows[1].payloadAfter).toMatchObject({ enabled: true })
    expect(rows[2].payloadBefore).toEqual({ cooldownHours: 72, version: 1 })
    expect(rows[2].payloadAfter).toMatchObject({ cooldownHours: 48, version: 2 })
    expect(rows[3].payloadBefore).toMatchObject({ name: 'Audited eBay rule', enabled: true, cooldownHours: 48 })
  })
})

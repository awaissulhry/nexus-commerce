/**
 * ADS AUTONOMY W3-2 — PATCH /advertising/campaigns/:id/guardrails and PATCH /advertising/campaigns/:id/pins answer byte
 * for byte as before their logic moved into setCampaignGuardrails / setCampaignPins (campaign-guardrail.service.ts),
 * which Claude's set-ad-guardrail uses for a campaign's own bounds, largest bid change and pins: one path for both.
 * PATCH /cpc-ceiling already called setCpcCeiling (campaign-settings.service.ts); it is held here too.
 *
 * On a real PostgreSQL (PGlite). The snapshot beside this file was WRITTEN BY THE ROUTES BEFORE THE MOVE and is read
 * unchanged after it: every answer, the campaign's columns and settings after each call, and the audit rows written.
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
    const campaign = await database.client.campaign.create({
      data: { name: 'PARITY CAMPAIGN', type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', dynamicBidding: { placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 20 }] } },
    })
    rows.campaign = campaign.id
  })
}, 180_000)
afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

/** The campaign's guardrail columns and settings as stored, after a call. */
async function stored(): Promise<string> {
  const c = await withWorkspace(business, () => database.client.campaign.findUniqueOrThrow({
    where: { id: rows.campaign },
    select: {
      minBidCents: true, maxBidCents: true, minBudgetCents: true, maxBudgetCents: true, budgetBaselineCents: true,
      pinBids: true, pinBudget: true, pinPlacement: true, pinNote: true, pinnedBy: true, dynamicBidding: true,
    },
  }))
  return JSON.stringify(c)
}

describe('W3-2 — the campaign guardrail and pin routes answer as before the move', () => {
  it('every outcome', async () => {
    const answers: string[] = []
    const send = async (url: string, payload: object) => {
      const res = await app.inject({ method: 'PATCH', url, payload, headers: { 'x-actor-id': 'parity-person' } })
      answers.push(`PATCH ${normalise(url)} ${JSON.stringify(payload)} → ${res.statusCode} ${normalise(res.body)}`)
      answers.push(`  stored ${normalise(await stored())}`)
      return res
    }
    const guard = `/api/advertising/campaigns/${rows.campaign}/guardrails`
    const pins = `/api/advertising/campaigns/${rows.campaign}/pins`
    const cpc = `/api/advertising/campaigns/${rows.campaign}/cpc-ceiling`

    await send('/api/advertising/campaigns/nope/guardrails', { maxBidChangePct: 10 })
    await send(guard, {})
    await send(guard, { minBidCents: 300, maxBidCents: 200 })
    await send(guard, { minBidCents: -1 })
    await send(guard, { maxBidCents: 100_001 })
    await send(guard, { minBidCents: 20, maxBidCents: 150 })
    await send(guard, { maxBidCents: 10 })
    await send(guard, { maxBidCents: null })
    await send(guard, { minBudgetCents: 99 })
    await send(guard, { minBudgetCents: 5000, maxBudgetCents: 2000 })
    await send(guard, { minBudgetCents: 500, maxBudgetCents: 4000, budgetBaselineCents: 1500 })
    await send(guard, { maxBudgetCents: null })
    await send(guard, { maxBidChangePct: 25 })
    await send(guard, { maxBidChangePct: 900 })
    await send(guard, { maxBidChangePct: 12.5, maxWritesPerDay: 40 })
    await send(guard, { maxBidChangePct: null, maxWritesPerDay: 0 })
    await send(guard, { maxBidChangePct: 0, minBidCents: null, budgetBaselineCents: null })

    await send('/api/advertising/campaigns/nope/pins', { pinBids: true })
    await send(pins, {})
    await send(pins, { pinBids: true, pinNote: '  held by hand  ' })
    await send(pins, { pinBudget: 1, pinPlacement: true, pinNote: 'x'.repeat(300) })
    await send(pins, { pinNote: '   ' })
    await send(pins, { pinBids: false })
    await send(pins, { pinBudget: false, pinPlacement: false, pinNote: 'stays?' })

    await send('/api/advertising/campaigns/nope/cpc-ceiling', { enabled: true })
    await send(cpc, { enabled: true, multiple: 2 })
    await send(cpc, { enabled: true, multiple: 20 })
    await send(cpc, { multiple: 0.5 })
    await send(cpc, {})

    const logs = await withWorkspace(business, () => database.client.advertisingActionLog.findMany({
      where: { entityId: rows.campaign },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { userId: true, actionType: true, entityType: true, payloadBefore: true, payloadAfter: true, amazonResponseStatus: true, evidence: true },
    }))
    for (const log of logs) answers.push(`log ${normalise(JSON.stringify(log))}`)
    expect(answers.join('\n')).toMatchSnapshot()
  })
})

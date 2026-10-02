/**
 * R14 (MCP full control, part 06) — the engine-setting routes answer byte for byte as before their logic moved into
 * services, which tune-ad-engine (and the budget-schedule switch) call:
 *   PATCH  /advertising/budget-pools/:id                  → patchBudgetPool        (ads-engine-settings.service.ts)
 *   PATCH  /advertising/rank-targets/:id                  → patchRankTarget        (ads-engine-settings.service.ts)
 *   PATCH  /advertising/budget-schedules/:id              → patchBudgetSchedule    (ads-budget-schedule.service.ts)
 *   DELETE /advertising/budget-schedules/:id              → deleteBudgetSchedule   (ads-budget-schedule.service.ts)
 *   PUT    /ebay-ads/campaigns/:id/automation-policy      → setEbayCampaignPolicy  (ebay-campaign-policy.service.ts)
 *
 * The answers AND the rows each request leaves (the row itself, the campaigns a disable gives back, the audit rows) are
 * recorded. On a real PostgreSQL (PGlite). The snapshot beside this file was WRITTEN BY THE ROUTES BEFORE THE MOVE and
 * is read unchanged after it.
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
const answers: string[] = []
const rows = { pool: '', target: '', schedule: '', scheduleGone: '', campaign: '', campaignGone: '', ebayCampaign: '' }

async function ask(method: 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) {
  const res = await app.inject({ method, url, ...(payload ? { payload } : {}), headers: { 'x-actor-id': 'parity-person' } })
  answers.push(`${method} ${normalise(url)} → ${res.statusCode} ${normalise(res.body)}`)
}

/** What a request left behind: the rows it may touch, and every audit row so far. */
async function state(label: string) {
  const db = database.client
  const out = await inside(async () => ({
    pool: await db.budgetPool.findUnique({ where: { id: rows.pool }, select: { name: true, description: true, totalDailyBudgetCents: true, strategy: true, coolDownMinutes: true, maxShiftPerRebalancePct: true, enabled: true, dryRun: true } }),
    target: await db.rankTarget.findUnique({ where: { id: rows.target } }),
    schedules: await db.budgetSchedule.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, enabled: true, windows: true, timezone: true, excludeDates: true, startDate: true, endDate: true } }),
    campaigns: await db.campaign.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, dailyBudget: true } }),
    policy: await db.ebayCampaignAutomationPolicy.findMany({ select: { campaignId: true, posture: true, protected: true, rateCapPct: true, rateFloorPct: true, bidCapCents: true, bidFloorCents: true, updatedBy: true } }),
    audit: await db.advertisingActionLog.findMany({ orderBy: { createdAt: 'asc' }, select: { userId: true, actionType: true, entityType: true, entityId: true, payloadBefore: true, payloadAfter: true, amazonResponseStatus: true } }),
    ebayAudit: await db.campaignAction.findMany({ orderBy: { createdAt: 'asc' }, select: { userId: true, channel: true, actionType: true, entityType: true, entityId: true, payloadBefore: true, payloadAfter: true, channelResponseStatus: true } }),
  }))
  answers.push(`  ${label}: ${normalise(JSON.stringify(out))}`)
}

beforeAll(async () => {
  database = await formulaDatabase()
  const [{ default: advertisingRoutes }, { default: ebayAdsRoutes }] = await Promise.all([import('./advertising.routes.js'), import('./ebay-ads.routes.js')])
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(ebayAdsRoutes, { prefix: '/api' })
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
  const db = database.client
  await inside(async () => {
    rows.pool = (await db.budgetPool.create({ data: { name: 'PARITY pool', totalDailyBudgetCents: 5000 } })).id
    rows.target = (await db.rankTarget.create({ data: { key: 'parity-target', name: 'PARITY target', placement: 'PLACEMENT_TOP', builtIn: false } as never })).id
    // Two campaigns a schedule boosted to 15 (its base is 10): a disable or a delete gives the base back.
    const campaign = await db.campaign.create({ data: { name: 'PARITY A', type: 'SP', dailyBudget: '15.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: 'TEST-CMP-1' } })
    const gone = await db.campaign.create({ data: { name: 'PARITY B', type: 'SP', dailyBudget: '15.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: 'TEST-CMP-2' } })
    rows.campaign = campaign.id
    rows.campaignGone = gone.id
    const window = [{ day: 1, start: '08:00', end: '12:00', adj: 'incPct', value: 50 }]
    rows.schedule = (await db.budgetSchedule.create({ data: { name: 'PARITY schedule', kind: 'BUDGET', type: 'CAMPAIGN_BUDGET', campaigns: [{ id: campaign.id, dailyBudget: 10 }], windows: window, enabled: true, lastApplied: { [campaign.id]: { budget: 15 } } } as never })).id
    rows.scheduleGone = (await db.budgetSchedule.create({ data: { name: 'PARITY schedule (deleted)', kind: 'BUDGET', type: 'CAMPAIGN_BUDGET', campaigns: [{ id: gone.id, dailyBudget: 10 }], windows: window, enabled: true, lastApplied: { [gone.id]: { budget: 15 } } } as never })).id
    const connection = await db.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'parity', isActive: true, externalAccountId: 'TEST-EBAY-SELLER', authStatus: 'connected', managedBy: 'oauth', region: 'IT' } as never })
    rows.ebayCampaign = (await db.ebayCampaign.create({ data: { channelConnectionId: connection.id, marketplace: 'EBAY_IT', externalCampaignId: 'TEST-EBAY-CMP-1', name: 'PARITY eBay campaign', fundingStrategy: 'STANDARD', status: 'RUNNING', startDate: new Date('2026-01-01T00:00:00Z') } as never })).id
  })
}, 180_000)
afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

describe('R14 — the engine-setting routes answer as before the move', () => {
  it('every outcome, and the rows each leaves', { timeout: 120_000 }, async () => {
    // ── Budget pools ──
    await ask('PATCH', '/api/advertising/budget-pools/nope', { totalDailyBudgetCents: 1 })
    await ask('PATCH', `/api/advertising/budget-pools/${rows.pool}`, { totalDailyBudgetCents: 7000, strategy: 'PROFIT_WEIGHTED', coolDownMinutes: 120, maxShiftPerRebalancePct: 10, description: null })
    await ask('PATCH', `/api/advertising/budget-pools/${rows.pool}`, { enabled: true, dryRun: true })
    await state('pool')
    // ── Rank targets ──
    await ask('PATCH', '/api/advertising/rank-targets/nope', { maxCpcCents: 90 })
    await ask('PATCH', `/api/advertising/rank-targets/${rows.target}`, { maxCpcCents: 90, acosCapPct: 35, targetISPct: 20, stepUpPct: 5, keepClimbing: true, ignored: 1 })
    await ask('PATCH', `/api/advertising/rank-targets/${rows.target}`, { lanes: 'not a list', maxBiasPct: null })
    await state('target')
    // ── Budget schedules ──
    await ask('PATCH', '/api/advertising/budget-schedules/nope', { name: 'x' })
    await ask('PATCH', `/api/advertising/budget-schedules/${rows.schedule}`, { name: 'PARITY schedule (renamed)', windows: [{ day: 2, start: '09:00', end: '11:00', adj: 'decPct', value: 20 }], excludeDates: 'no', startDate: '2026-02-01', endDate: null, autoRefill: true })
    await state('schedule edited')
    // Disabled while it holds a boost: the base budget comes back, and the answer says so.
    await ask('PATCH', `/api/advertising/budget-schedules/${rows.schedule}`, { enabled: false })
    await state('schedule disabled')
    await ask('PATCH', `/api/advertising/budget-schedules/${rows.schedule}`, { enabled: true })
    await ask('DELETE', '/api/advertising/budget-schedules/nope')
    await ask('DELETE', `/api/advertising/budget-schedules/${rows.scheduleGone}`)
    await state('schedule deleted')
    // ── eBay campaign automation policy ──
    await ask('PUT', '/api/ebay-ads/campaigns/nope/automation-policy', { posture: 'OFF' })
    await ask('PUT', `/api/ebay-ads/campaigns/${rows.ebayCampaign}/automation-policy`, { posture: 'NOPE' })
    await ask('PUT', `/api/ebay-ads/campaigns/${rows.ebayCampaign}/automation-policy`, { rateCapPct: 120 })
    await ask('PUT', `/api/ebay-ads/campaigns/${rows.ebayCampaign}/automation-policy`, { rateCapPct: 5, rateFloorPct: 8 })
    await ask('PUT', `/api/ebay-ads/campaigns/${rows.ebayCampaign}/automation-policy`, { posture: 'SUGGEST', rateCapPct: 9.5, rateFloorPct: 2, bidCapCents: 80, bidFloorCents: null })
    await ask('PUT', `/api/ebay-ads/campaigns/${rows.ebayCampaign}/automation-policy`, { protected: true })
    await state('eBay policy')
    expect(answers.join('\n')).toMatchSnapshot()
  })
})

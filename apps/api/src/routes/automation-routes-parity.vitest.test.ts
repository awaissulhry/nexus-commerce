/**
 * R4 (MCP full control, part 06) — the automation routes answer byte for byte as they did before their logic moved
 * into services.
 *
 * R4 moved route-only logic into services so a Claude tool can reuse it: ads rule create / edit / delete / test /
 * gate status / graduate / pause-all (ads-rule-crud.service.ts), the rule board and its activity
 * (ads-rule-list.service.ts), suggestion apply / dismiss / restore / bulk (ads-suggestion-decide.service.ts), spend
 * ceilings and bid policies (ads-guardrail.service.ts) and eBay rule create / edit / delete
 * (ebay-ads-rule-crud.service.ts).
 *
 * The proof: ONE scripted sequence of requests — every outcome each route has (refusals, not found, conflicts,
 * successes) — against a real PostgreSQL (PGlite, production schema), each answer recorded as status + body text.
 * The snapshot beside this file was WRITTEN BY THE ROUTES BEFORE THE MOVE (the commit before R4) and is read
 * unchanged after it. Only what differs between two runs is normalised: generated ids (numbered in order of first
 * appearance), timestamps and timings.
 *
 * The audit rows R4 adds are new behaviour and are proven in the services' own tests, not here: they never reach a
 * route's answer.
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

/** Normalised answers, in order. */
const answers: string[] = []
const ids = new Map<string, string>()

/** What differs between two runs of the same sequence: ids (numbered by first appearance), timestamps, timings. */
function normalise(text: string): string {
  return text
    .replace(/\bc[a-z0-9]{24}\b/g, (id) => {
      if (!ids.has(id)) ids.set(id, `<id${ids.size + 1}>`)
      return ids.get(id)!
    })
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>')
    .replace(/"durationMs":\d+/g, '"durationMs":"<ms>"')
}

let app: FastifyInstance
async function ask(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}), headers: { 'x-actor-id': 'parity-person', ...headers } })
  answers.push(`${method} ${normalise(url)} → ${res.statusCode} ${normalise(res.body)}`)
  return res
}

const seeded = { campaignId: '', ruleBoard: '', rulePause: '', ruleGate: '', sugOk: '', sugRefuse: '', sugNoHandler: '', sugDone: '', sugBulk1: '', sugBulk2: '', sugDismissed: '' }

beforeAll(async () => {
  database = await formulaDatabase()
  const { ACTION_HANDLERS } = await import('../services/automation-rule.service.js')
  // Two handlers only this file uses, so applying a suggestion exercises the decide path and nothing of Amazon's.
  ACTION_HANDLERS.parity_ok = (async (action: { type: string }) => ({ type: action.type, ok: true, output: { applied: 'parity' } })) as never
  ACTION_HANDLERS.parity_refuse = (async (action: { type: string }) => ({ type: action.type, ok: false, error: 'refused at the parity gate' })) as never

  const [{ default: advertisingRoutes }, { default: advertisingIntelRoutes }, { default: ebayAdsRoutes }] = await Promise.all([
    import('./advertising.routes.js'),
    import('./advertising-intel.routes.js'),
    import('./ebay-ads.routes.js'),
  ])
  app = Fastify()
  // Every request runs inside the business, as the global workspace preHandler does in production.
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(ebayAdsRoutes, { prefix: '/api' })
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.register(advertisingIntelRoutes, { prefix: '/api' })
  await app.ready()

  const db = database.client
  await inside(async () => {
    const campaign = await db.campaign.create({
      data: { name: 'PARITY CAMPAIGN', type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: 'TEST-CMP-1' },
    })
    seeded.campaignId = campaign.id
    const rule = (data: Record<string, unknown>) => db.automationRule.create({ data: { domain: 'advertising', trigger: 'SCHEDULE', ...data } as never })
    seeded.ruleBoard = (await rule({
      name: 'Board rule', enabled: true, dryRun: true, autonomyLevel: 'PROPOSE',
      conditions: [{ field: 'campaign.acos', op: 'gt', value: 0.4 }],
      actions: [{ type: 'adjust_ad_budget', percent: -10 }, { type: 'notify' }],
      scopeCampaignId: campaign.id, maxExecutionsPerDay: 20, maxWritesPerDay: 5, maxValueCentsEur: 500,
    })).id
    seeded.rulePause = (await rule({ name: 'Pausing rule', enabled: false, actions: [{ type: 'pause_campaign' }] })).id
    seeded.ruleGate = (await rule({ name: 'Gate rule', enabled: true, dryRun: true, actions: [{ type: 'log_only' }], evaluationCount: 3, matchCount: 1 })).id
    const sug = (key: string, type: string, status = 'pending') => db.adsRuleSuggestion.create({
      data: { ruleId: seeded.ruleBoard, ruleName: 'Board rule', trigger: 'SCHEDULE', marketplace: 'IT', entityType: 'CAMPAIGN', entityId: campaign.id, proposedAction: { type, campaignId: campaign.id, value: 3 }, proposedKey: key, status },
    })
    seeded.sugOk = (await sug('k-ok', 'parity_ok')).id
    seeded.sugRefuse = (await sug('k-refuse', 'parity_refuse')).id
    seeded.sugNoHandler = (await sug('k-none', 'no_such_handler')).id
    seeded.sugDone = (await sug('k-done', 'parity_ok', 'applied')).id
    seeded.sugBulk1 = (await sug('k-b1', 'parity_ok')).id
    seeded.sugBulk2 = (await sug('k-b2', 'parity_refuse')).id
    seeded.sugDismissed = (await sug('k-dis', 'parity_ok', 'dismissed')).id
  })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

describe('R4 — the automation routes answer as before the move', () => {
  it('runs the scripted sequence', async () => {
    // ── Ads rules: create ──
    await ask('POST', '/api/advertising/automation-rules', {})
    await ask('POST', '/api/advertising/automation-rules', { name: 'Bad trigger', trigger: 'NOPE' })
    // 4b — the builder block carries its THEN value (a blank one is now refused before the metric is looked at).
    await ask('POST', '/api/advertising/automation-rules', {
      name: 'Untranslatable', trigger: 'SCHEDULE',
      actions: [{ type: 'budget', campaigns: [] }], conditions: [{ conditions: [{ metric: 'Moon Phase', op: '>=', value: 1 }], action: { op: 'set', value: 5 } }],
    })
    // 4c — a rule scoped to IT needs a market an active Amazon Ads connection serves, or its save is refused. The row
    // lives only for this create: gate status reads the connection too, and its answers below were recorded without one.
    const itConnection = await inside(() => database.client.amazonAdsConnection.create({ data: { profileId: 'TEST-PROFILE-IT', marketplace: 'IT', isActive: true } }))
    const created = await ask('POST', '/api/advertising/automation-rules', {
      name: 'Created rule', description: 'made by the parity test', trigger: 'KEYWORD_HIGH_ACOS',
      conditions: [{ field: 'adTarget.acos', op: 'gt', value: 0.5 }], actions: [{ type: 'bid_down', target: 'ad_target', percent: 10 }],
      maxExecutionsPerDay: 7, maxWritesPerDay: 3, scopeMarketplace: 'IT',
    })
    await inside(() => database.client.amazonAdsConnection.delete({ where: { id: itConnection.id } }))
    const createdId = created.json().rule.id as string
    await ask('POST', '/api/advertising/automation-rules', { name: 'Defaults rule', trigger: 'SCHEDULE' })

    // ── Ads rules: edit ──
    await ask('PATCH', '/api/advertising/automation-rules/nope', { name: 'x' })
    await ask('PATCH', `/api/advertising/automation-rules/${createdId}`, { priority: 0 })
    await ask('PATCH', `/api/advertising/automation-rules/${createdId}`, { priority: 'first' })
    await ask('PATCH', `/api/advertising/automation-rules/${createdId}`, {
      actions: [{ type: 'budget', campaigns: [] }], conditions: [{ conditions: [{ metric: 'Moon Phase', op: '>=', value: 1 }], action: { op: 'set', value: 5 } }],
    })
    await ask('PATCH', `/api/advertising/automation-rules/${createdId}`, {
      name: 'Created rule (edited)', description: null, enabled: true, dryRun: true, priority: 42.4,
      maxExecutionsPerDay: 9, maxValueCentsEur: 250, maxDailyAdSpendCentsEur: 5000, maxWritesPerDay: null, scopeMarketplace: null,
    })
    // An engine-native rule edited with the builder's nested groups keeps its flat shape.
    await ask('PATCH', `/api/advertising/automation-rules/${createdId}`, { conditions: [{ conditions: [{ metric: 'ACOS', op: '>=', value: 40 }] }] })
    await ask('PATCH', `/api/advertising/automation-rules/${createdId}`, { conditions: [{ conditions: [{ metric: 'Moon Phase', op: '>=', value: 1 }] }] })
    await ask('PATCH', `/api/advertising/automation-rules/${createdId}`, { actions: [{ type: 'bid_down', target: 'ad_target', percent: 15 }] })

    // ── Ads rules: test (a preview), gate status, graduate ──
    await ask('POST', `/api/advertising/automation-rules/${createdId}/test`, {})
    await ask('POST', '/api/advertising/automation-rules/nope/test', { context: {} })
    await ask('POST', `/api/advertising/automation-rules/${seeded.ruleGate}/test`, { context: { marketplace: 'IT' } })
    await ask('GET', '/api/advertising/automation-rules/nope/gate-status')
    await ask('GET', `/api/advertising/automation-rules/${seeded.ruleGate}/gate-status`)
    await ask('GET', `/api/advertising/automation-rules/${seeded.rulePause}/gate-status`)
    await ask('POST', '/api/advertising/automation-rules/nope/graduate')
    await ask('POST', `/api/advertising/automation-rules/${seeded.rulePause}/graduate`)
    await ask('POST', `/api/advertising/automation-rules/${seeded.ruleGate}/graduate`)

    // ── The rule board and its activity ──
    await ask('GET', '/api/advertising/autonomy/rules')
    await ask('GET', '/api/advertising/automation-rules/activity')

    // ── Suggestions: apply, dismiss, restore, bulk ──
    await ask('POST', '/api/advertising/suggestions/nope/apply', {})
    await ask('POST', `/api/advertising/suggestions/${seeded.sugDone}/apply`, {})
    await ask('POST', `/api/advertising/suggestions/${seeded.sugNoHandler}/apply`, {})
    await ask('POST', `/api/advertising/suggestions/${seeded.sugRefuse}/apply`, {})
    await ask('POST', `/api/advertising/suggestions/${seeded.sugOk}/apply`, { value: 5 })
    await ask('POST', '/api/advertising/suggestions/nope/dismiss')
    await ask('POST', `/api/advertising/suggestions/${seeded.sugOk}/dismiss`)
    await ask('POST', `/api/advertising/suggestions/${seeded.sugRefuse}/dismiss`)
    await ask('POST', `/api/advertising/suggestions/${seeded.sugRefuse}/restore`)
    await ask('POST', `/api/advertising/suggestions/${seeded.sugDismissed}/restore`)
    await ask('POST', '/api/advertising/suggestions/nope/restore')
    await ask('POST', '/api/advertising/suggestions/bulk', {})
    await ask('POST', '/api/advertising/suggestions/bulk', {
      ops: [{ id: seeded.sugBulk1, kind: 'apply', resultBudgetEur: 12 }, { id: seeded.sugBulk2, kind: 'apply' }, { id: seeded.sugBulk2, kind: 'dismiss' }, { id: 'nope', kind: 'dismiss' }, { id: 'x', kind: 'explode' }],
    })
    await ask('POST', '/api/advertising/suggestions/bulk', { ids: [seeded.sugBulk2, seeded.sugBulk2, 7], kind: 'dismiss' })
    // While automation is halted an apply is refused (423); a dismiss is not.
    const { haltAutomation, resumeAutomation } = await import('../services/advertising/ads-automation-state.service.js')
    await inside(() => haltAutomation('parity halt', 'user:parity-person'))
    await ask('POST', `/api/advertising/suggestions/${seeded.sugDismissed}/apply`, {})
    await ask('POST', '/api/advertising/suggestions/bulk', { ids: [seeded.sugDismissed], kind: 'apply' })
    await ask('POST', '/api/advertising/suggestions/bulk', { ids: [seeded.sugDismissed], kind: 'dismiss' })
    await inside(() => resumeAutomation('user:parity-person'))

    // ── Ads rules: pause-all, delete ──
    await ask('POST', '/api/advertising/autonomy/pause-all')
    await ask('POST', '/api/advertising/autonomy/pause-all')
    await ask('DELETE', '/api/advertising/automation-rules/nope')
    await ask('DELETE', `/api/advertising/automation-rules/${createdId}`)

    // ── Guardrails: spend ceilings and bid policies ──
    await ask('GET', '/api/advertising/spend-ceilings')
    await ask('PUT', '/api/advertising/spend-ceilings', { grain: 'PLANET', scopeId: 'x', label: 'x' })
    await ask('PUT', '/api/advertising/spend-ceilings', { grain: 'MARKET', scopeId: 'IT', label: 'Italy', dailyCapCents: -1 })
    await ask('PUT', '/api/advertising/spend-ceilings', { grain: 'MARKET', scopeId: 'IT', label: '  Italy  ', dailyCapCents: 5000, note: 'parity' })
    await ask('PUT', '/api/advertising/spend-ceilings', { grain: 'MARKET', scopeId: 'IT', label: 'Italy', dailyCapCents: null, enabled: false })
    await ask('PUT', '/api/advertising/spend-ceilings', { grain: 'CAMPAIGN', scopeId: seeded.campaignId, label: 'One campaign', dailyCapCents: 900 })
    await ask('GET', '/api/advertising/spend-ceilings')
    await ask('DELETE', '/api/advertising/spend-ceilings?grain=MARKET')
    await ask('DELETE', '/api/advertising/spend-ceilings?grain=MARKET&scopeId=DE')
    await ask('DELETE', '/api/advertising/spend-ceilings?grain=MARKET&scopeId=IT')
    await ask('GET', '/api/advertising/bid-policies')
    await ask('PUT', '/api/advertising/bid-policies', { grain: 'CAMPAIGN', scopeId: 'x', label: 'x' })
    await ask('PUT', '/api/advertising/bid-policies', { grain: 'MARKET', scopeId: 'IT', label: 'Italy', minBidCents: 1 })
    await ask('PUT', '/api/advertising/bid-policies', { grain: 'MARKET', scopeId: 'IT', label: 'Italy', minBidCents: 90, maxBidCents: 30 })
    await ask('PUT', '/api/advertising/bid-policies', { grain: 'MARKET', scopeId: 'IT', label: 'Italy', minBidCents: 5, maxBidCents: 150, note: 'parity' })
    await ask('PUT', '/api/advertising/bid-policies', { grain: 'MARKET', scopeId: 'IT', label: 'Italy', maxBidCents: 120, enabled: false })
    await ask('GET', '/api/advertising/bid-policies')
    await ask('DELETE', '/api/advertising/bid-policies?scopeId=IT')
    await ask('DELETE', '/api/advertising/bid-policies?grain=MARKET&scopeId=FR')
    await ask('DELETE', '/api/advertising/bid-policies?grain=MARKET&scopeId=IT')

    // ── eBay rules: create, edit, delete ──
    const ebayRule = {
      name: 'Parity fee creep', trigger: { scope: 'CPS_AD', all: [{ metric: 'fee_pct_of_sales', windowDays: 14, op: 'gt', threshold: 20 }] },
      action: { type: 'adjust_ad_rate', deltaPct: -10, minRatePct: 2 }, cooldownHours: 72, marketplace: 'EBAY_IT',
    }
    await ask('POST', '/api/ebay-ads/automation/rules', { name: '' })
    const ebay = await ask('POST', '/api/ebay-ads/automation/rules', ebayRule)
    const ebayId = ebay.json().id as string
    await ask('POST', '/api/ebay-ads/automation/rules/nope', { enabled: true })
    await ask('POST', `/api/ebay-ads/automation/rules/${ebayId}`, { cooldownHours: 0 })
    await ask('POST', `/api/ebay-ads/automation/rules/${ebayId}`, { enabled: true, mode: 'AUTOPILOT' })
    await ask('POST', `/api/ebay-ads/automation/rules/${ebayId}`, { name: 'Parity fee creep' })
    await ask('POST', `/api/ebay-ads/automation/rules/${ebayId}`, { name: '  Parity fee creep (v2)  ', cooldownHours: 48, enabled: false })
    await ask('GET', `/api/ebay-ads/automation/rules/${ebayId}/versions`)
    await ask('DELETE', '/api/ebay-ads/automation/rules/nope')
    await ask('DELETE', `/api/ebay-ads/automation/rules/${ebayId}`)
    await ask('GET', '/api/ebay-ads/automation/rules')

    expect(answers.length).toBe(76)
  }, 120_000)

  it('every answer is the one the routes gave before the move', () => {
    expect(answers.join('\n')).toMatchSnapshot()
  })
})

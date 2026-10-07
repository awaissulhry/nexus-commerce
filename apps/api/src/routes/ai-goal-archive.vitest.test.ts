/**
 * ADS AUTONOMY W4-12b — archiving an AI goal switches its AutopilotPlan off (and the plan's rules), on the screen and on
 * Claude's path alike: one service, archiveProductGoal (ai-product-goal.service.ts).
 *
 * The AI Advertising screen's "Archive N" (POST /advertising/ai-goals/:id/archive) set only the goal's status, so the
 * goal's plan went on proposing (or acting, at AUTO) for an archived goal. create-ai-goal-campaigns' undo already
 * switched them off (retireProductGoal); it now goes through the same service.
 *
 * On a real PostgreSQL (PGlite). Made-up names and ids; nothing reaches Amazon.
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
beforeAll(async () => {
  database = await formulaDatabase()
  const { default: advertisingRoutes } = await import('./advertising.routes.js')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
}, 180_000)
afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

/** A launched goal whose plan is switched on (AUTO) with its two rules on, as a person may have left them. */
async function runningGoal(name: string, syncedEnabled = true) {
  return inside(async () => {
    const db = database.client
    const rule = (module: string) => db.automationRule.create({ data: { domain: 'advertising', name: `[AI] ${name} — ${module}`, trigger: 'SCHEDULE', enabled: true, dryRun: true, actions: [{ type: 'keyword-harvesting', control: 'manual', campaignIds: [] }] } as never })
    const [harvest, negate] = [await rule('Harvest'), await rule('Negate')]
    const plan = await db.autopilotPlan.create({ data: {
      name: `${name} plan`, marketplace: 'IT', autonomy: 'AUTO', enabled: true,
      linkedRuleIds: [{ ruleId: harvest.id, module: 'harvest', syncedEnabled }, { ruleId: negate.id, module: 'negate', syncedEnabled }],
    } as never })
    const goal = await db.adProductGoal.create({ data: {
      name, aiTarget: 'SALES', budgetMode: 'STRICT', marketplace: 'IT', products: [{ sku: 'TEST-SKU-1', asin: 'B0TESTGOAL' }] as never,
      planId: plan.id, materializedAt: new Date(),
    } })
    return { goalId: goal.id, planId: plan.id, ruleIds: [harvest.id, negate.id] }
  })
}
const state = (g: { goalId: string; planId: string; ruleIds: string[] }) => inside(async () => {
  const db = database.client
  const [goal, plan, rules] = await Promise.all([
    db.adProductGoal.findUniqueOrThrow({ where: { id: g.goalId }, select: { status: true } }),
    db.autopilotPlan.findUniqueOrThrow({ where: { id: g.planId }, select: { enabled: true } }),
    db.automationRule.findMany({ where: { id: { in: g.ruleIds } }, select: { enabled: true } }),
  ])
  return { goal: goal.status, plan: plan.enabled, rules: [...new Set(rules.map((r) => r.enabled))] }
})

/**
 * The plan switched on again after the archive (its next sync, autopilot/coordination.ts): its rules stay off — a person
 * switches them on in Rules — and its feed says the archive did it, not "switched off in Rules".
 */
async function planSwitchedOnAgain(g: { planId: string; ruleIds: string[] }) {
  const { syncLinkedRules } = await import('../services/advertising/autopilot/coordination.js')
  const plan = await inside(() => database.client.autopilotPlan.findUniqueOrThrow({ where: { id: g.planId } }))
  const links = await inside(() => syncLinkedRules({ ...plan, enabled: true }))
  expect(links.every((l) => (l as { personOff?: boolean }).personOff === true)).toBe(true)
  const rules = await inside(() => database.client.automationRule.findMany({ where: { id: { in: g.ruleIds } }, select: { enabled: true } }))
  expect(rules.every((r) => !r.enabled)).toBe(true)
  const notes = await inside(() => database.client.autopilotDecision.findMany({ where: { planId: g.planId, action: 'NOOP' }, select: { reason: true } }))
  expect(notes.map((n) => n.reason)).toEqual([
    expect.stringMatching(/was switched off when this plan's AI goal was archived\. The plan leaves it off; switch it on in Rules/),
    expect.stringMatching(/was switched off when this plan's AI goal was archived/),
  ])
  expect(notes.some((n) => /switched off in Rules\./.test(n.reason ?? ''))).toBe(false)
}

describe('W4-12b — an archived AI goal leaves nothing running', () => {
  it('the screen\'s Archive: the goal archived, its plan switched off and its rules off; the answer as before', async () => {
    const g = await runningGoal('Screen archive goal')
    expect(await state(g)).toEqual({ goal: 'ACTIVE', plan: true, rules: [true] })
    const res = await app.inject({ method: 'POST', url: `/api/advertising/ai-goals/${g.goalId}/archive` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, goal: { id: g.goalId, status: 'ARCHIVED', planId: g.planId } })
    // Before W4-12b: { goal: 'ARCHIVED', plan: true, rules: [true] } — the plan went on running for an archived goal.
    expect(await state(g)).toEqual({ goal: 'ARCHIVED', plan: false, rules: [false] })
    await planSwitchedOnAgain(g)
  })

  it('Claude\'s path (create-ai-goal-campaigns\' undo) goes through the same archive', async () => {
    // A goal Claude made: its plan's links say the sync left the rules off (the plan was born off).
    const g = await runningGoal('Claude archive goal', false)
    const { getTool } = await import('../services/agents/tool-registry.js')
    await inside(() => getTool('create-ai-goal-campaigns')!.undo!.undone!({ before: null, after: { goalId: g.goalId }, id: 'test-change' } as never))
    expect(await state(g)).toEqual({ goal: 'ARCHIVED', plan: false, rules: [false] })
    await planSwitchedOnAgain(g)
  })

  it('a goal never launched (no plan), or whose plan is gone, is archived without an error', async () => {
    const bare = await inside(() => database.client.adProductGoal.create({ data: { name: 'Bare goal', aiTarget: 'SALES', budgetMode: 'STRICT', marketplace: 'IT', products: [] as never } }))
    expect((await app.inject({ method: 'POST', url: `/api/advertising/ai-goals/${bare.id}/archive` })).json()).toMatchObject({ ok: true, goal: { status: 'ARCHIVED' } })
    const gone = await inside(() => database.client.adProductGoal.create({ data: { name: 'Orphan goal', aiTarget: 'SALES', budgetMode: 'STRICT', marketplace: 'IT', products: [] as never, planId: 'no-such-plan' } }))
    expect((await app.inject({ method: 'POST', url: `/api/advertising/ai-goals/${gone.id}/archive` })).json()).toMatchObject({ ok: true, goal: { status: 'ARCHIVED' } })
  })
})

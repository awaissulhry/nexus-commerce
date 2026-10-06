/**
 * ADS AUTONOMY AA-W2-3 — a strategy-bound change the business's rule scheduled is judged again, at commit, on the FRESH
 * dry run the staleness check makes: the ads strategy's facts and today's counts as they are when it runs, not as they
 * were when Claude asked. Outside its limits or the strategy then, it goes back to a person as `rule_refused` (which
 * never counts towards the automatic pause), alone or as a step of a plan. A tool that is not strategy-bound is judged
 * on its stored preview, exactly as before.
 *
 * Through Claude's own door (runToolForClaude → the gate → the sweep's commit → the plan worker) on PGlite with the
 * production schema and business policies, business profiles ON. No real tool is strategy-bound yet (the W2 tool PRs
 * make them so), so a test tool stands in: its dry run stores the kit's limit facts (ads-autonomy-kit.ts) — today's
 * real ledger of runs by rule, and the strategy's daily limit from `strategy` — and it is judged by the kit's own daily
 * check. A plan's ad steps count TOGETHER against the daily limits: when the rule decides it, at its commit, and when
 * each step runs (the steps of the plan that ran before it count). Values are made up (public repo).
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import type { AgentTool, ToolContext } from './tool-types.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// As db.ts wraps it: inside a transaction, `prisma.x` is that transaction's client.
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true, workersOff: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    readinessQueue: queue, agentPlanQueue: null, queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})

/** The ads strategy's daily limit of changes by rule in IT, as the test tool's dry run reads it NOW. */
const strategy = { maxChangesPerDay: 10 }
const executed: Array<{ args: Record<string, unknown>; ctx: ToolContext }> = []
const NONE = { changes: 0, writes: 0, raises: 0, budgetIncreaseCents: 0 }
/** The kit's facts of `writes` lowering writes in IT (only what the daily check reads is not empty). */
function kitFacts(writes: number, today: { changes: number; writes: number; raises: number; budgetIncreaseCents: number }): LimitFacts {
  return {
    v: LIMIT_FACTS_VERSION, tool: 'set-example-bid', action: null, scopes: {}, entityScopes: {}, labels: {},
    markets: { IT: { strategy: { version: 'test' }, currency: 'EUR', maxActionsPerRun: null, maxChangesPerDay: strategy.maxChangesPerDay, maxRaisesPerDay: null, maxBudgetIncreasePerDayCents: null, sources: {} } },
    this: {
      markets: ['IT'], items: writes, writes, raises: 0, cuts: writes, largestRaisePct: 0, largestCutPct: 0, largestRaisePoints: 0, largestCutPoints: 0,
      highestNewBidCents: null, budgetIncreaseCents: 0, byMarket: { IT: { items: writes, changes: writes, writes, raises: 0, budgetIncreaseCents: 0, addedDailyCents: 0 } },
      entities: [], rowsOutsideStrategy: 0, firstOutside: null,
    },
    today: { IT: today }, perEntityToday: { maxChangesByRule: 0, entity: null }, unplaced: [], engineOwned: [], protectedHit: [],
  }
}
/** A strategy-bound ad tool, as a W2 tool PR makes one: its preview carries `limitFacts`, its limits judge them. */
const BOUND: AgentTool = {
  name: 'set-example-bid',
  title: 'Example bid',
  category: 'advertising',
  description: 'Test tool. A person approves it in Nexus, unless the business lets it run by its rule inside its limits.',
  riskTier: 'medium',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  requires: [F.adsBidsEdit],
  input: z.object({ writes: z.number().int().positive().max(50).describe('how many bids it lowers') }),
  limits: z.object({ maxItems: z.number().int().min(0).default(50).describe('the most items one request may change by rule') }),
  withinLimits(preview) {
    const facts = limitFactsOf(preview)
    return facts ? dailyRefusal(facts) : 'its preview carries no limit facts'
  },
  async handler(args, ctx) {
    const writes = Number(args.writes)
    // As a strategy-bound tool's dry run does: today's ledger, without the request it re-checks (ctx.approvalId).
    const ledger = await ruleRunLedger({ excludeApprovalId: ctx.approvalId })
    return { ok: true, preview: { summary: `${writes} bids lowered.`, writes, limitFacts: kitFacts(writes, ledger.byMarket.IT ?? NONE) } }
  },
  async execute(args, ctx) {
    executed.push({ args, ctx })
    return { ok: true, data: { bidCents: args.bidCents } }
  },
}
// The registry with the test tool in it. The real one is loaded in beforeAll (vi.importActual), after this mock exists:
// its tool files import modules that import the registry, and those must get this one.
const registry = vi.hoisted(() => ({ real: undefined as undefined | { getTool(name: string): AgentTool | undefined; listTools(): AgentTool[] } }))
vi.mock('./tool-registry.js', () => ({
  getTool: (name: string) => (name === BOUND.name ? BOUND : registry.real?.getTool(name)),
  listTools: () => [...(registry.real?.listTools() ?? []), BOUND],
}))

import { commitScheduledApproval, MATERIAL_PREVIEW_FIELDS } from '../agent-fleet/approval-inbox.service.js'
import { __claudeStrategyTest } from '../advertising/ads-strategy/claude.js'
import type { McpPrincipal } from '../mcp/mcp-auth.js'
import { runToolForClaude } from '../mcp/mcp-tool-call.js'
import { runPlan } from './change-plan.service.js'
import { AUTO_PAUSE_FAILURES, autoFreshRefusal, autonomyOf, inNexusEnding, planDailyRefusal } from './claude-trust.service.js'
import { getTool } from './tool-registry.js'
import { dailyRefusal, LIMIT_FACTS_VERSION, limitFactsOf, ruleRunLedger, type LimitFacts } from './tools/ads-autonomy-kit.js'

const A = LEGACY_WORKSPACE_ID
const TIMEOUT = 30_000
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids = { person: '' }
let nameA = ''

function claude(): McpPrincipal {
  return {
    kind: 'user', userId: ids.person, label: 'Rita Recheck', permissions: { isOwner: false, permissions: EVERYTHING },
    workspace: business, business: { id: A, name: nameA }, via: 'claude', oauthGrantId: 'grant-recheck', scopes: ['nexus.read', 'nexus.write', 'nexus.run'],
  } as McpPrincipal
}
type Answer = Record<string, any>
async function call(tool: string, args: Record<string, unknown>): Promise<Answer> {
  const who = claude()
  const result = await inside(() => runToolForClaude(who, getTool(tool)!, { ...args, business: nameA }))
  return JSON.parse((result.content as Array<{ text: string }>).map((b) => b.text).join(''))
}
/** The undo window closes now: the sweep's commit may take it. */
const windowClosed = (approvalId: string) =>
  inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
const approvalOf = (id: string) => inside(() => db().agentApproval.findUniqueOrThrow({ where: { id } }))
/** The kit's daily check, in a person's words (ending as the kit ends it). */
const OVER = (ran: number, adds: number, max: number) => `IT: ${ran} change${ran === 1 ? '' : 's'} ran by rule in the last 24 hours and this adds ${adds} change${adds === 1 ? '' : 's'}, more than the ${max} a day the ads strategy allows (most changes Claude may run by rule a day); a person decides`
/** …and as Claude's door says it: one ending, where the person decides. */
const IN_NEXUS = (sentence: string) => sentence.replace(/; a person decides$/, '; a person approves it in Nexus')
const FRESH = `not run — judged again on a fresh dry run: it is no longer inside the business's limits: ${IN_NEXUS(OVER(0, 2, 1))}`

beforeAll(async () => {
  registry.real = await vi.importActual<typeof import('./tool-registry.js')>('./tool-registry.js')
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  MATERIAL_PREVIEW_FIELDS[BOUND.name] = ['writes']
  const client = database.client
  const role = await client.role.create({
    data: { key: `W2_RECHECK_${randomUUID().slice(0, 8)}`, name: 'Recheck tester', description: 'test', isSystem: false, permissions: [...EVERYTHING] },
  })
  const person = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Rita Recheck' } })
  ids.person = person.id
  await client.userRole.create({ data: { userId: person.id, roleId: role.id } })
  const membership = await client.workspaceMembership.create({ data: { workspaceId: A, userId: person.id, status: 'active' } })
  await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  nameA = (await client.workspace.findUniqueOrThrow({ where: { id: A } })).name
}, 180_000)

beforeEach(async () => {
  strategy.maxChangesPerDay = 10
  executed.length = 0
  BOUND.strategyBound = 'amazon-ads'
  __claudeStrategyTest.reset()
  await inside(async () => {
    await db().adsStrategy.deleteMany({})
    await db().agentTool.deleteMany({})
    await db().agentAutonomy.deleteMany({})
    await db().agentApproval.updateMany({ where: { status: { in: ['pending', 'scheduled'] } }, data: { status: 'rejected', decisionVia: null } })
    // What ran by rule in an earlier test leaves today's window.
    await db().agentApproval.updateMany({ where: { decisionVia: 'auto' }, data: { decidedAt: new Date(Date.now() - 48 * 3600_000) } })
    // The business lets Claude run the test tool by its rule, inside the default limits.
    await db().agentTool.create({ data: { name: BOUND.name, riskTier: 'high', requiresApproval: true, claudeTrust: 'auto' } })
  })
})
afterEach(() => __claudeStrategyTest.reset())
afterAll(async () => {
  delete MATERIAL_PREVIEW_FIELDS[BOUND.name]
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('AA-W2-3 — a strategy-bound rule-run is judged again on the fresh dry run at commit', { timeout: TIMEOUT }, () => {
  it('still inside when it runs: it runs, and execute is told the rule decided it', async () => {
    const asked = await call(BOUND.name, { writes: 2 })
    expect(asked).toMatchObject({ status: 'runs_by_rule' })
    await windowClosed(asked.approvalId)
    expect(await inside(() => commitScheduledApproval(asked.approvalId))).toMatchObject({ ok: true, status: 'executed' })
    expect(executed).toHaveLength(1)
    expect(executed[0]!.ctx).toMatchObject({ decidedVia: 'auto', approvalId: asked.approvalId })
    expect(executed[0]!.ctx.approvedByPerson).toBeUndefined()
  })

  it('the strategy tightened inside the window (no material field moved): back to a person as rule_refused, with the reason', async () => {
    const asked = await call(BOUND.name, { writes: 2 })
    expect(asked).toMatchObject({ status: 'runs_by_rule' })
    strategy.maxChangesPerDay = 1
    await windowClosed(asked.approvalId)
    const out = await inside(() => commitScheduledApproval(asked.approvalId))
    expect(out).toEqual({ ok: false, error: FRESH })
    expect(executed).toEqual([])
    expect(await approvalOf(asked.approvalId)).toMatchObject({ status: 'pending', decisionVia: null, decidedBy: null, reason: FRESH })
    const audit = await inside(() => db().agentControlAudit.findFirst({ where: { action: 'rule_refused', toValue: { path: ['approvalId'], equals: asked.approvalId } } }))
    expect(audit).toMatchObject({ charterKey: 'claude', note: expect.stringContaining('judged again on a fresh dry run'), toValue: { decisionVia: 'auto' } })
  })

  it(`never counts towards the automatic pause, even ${AUTO_PAUSE_FAILURES + 1} times in an hour`, async () => {
    for (let i = 0; i < AUTO_PAUSE_FAILURES + 1; i++) {
      strategy.maxChangesPerDay = 10
      const asked = await call(BOUND.name, { writes: 2 })
      expect(asked).toMatchObject({ status: 'runs_by_rule' })
      strategy.maxChangesPerDay = 1
      await windowClosed(asked.approvalId)
      expect(await inside(() => commitScheduledApproval(asked.approvalId))).toMatchObject({ ok: false, error: expect.stringContaining(FRESH) })
    }
    expect(await inside(() => autonomyOf())).toMatchObject({ paused: false })
    expect(executed).toEqual([])
  })

  it('a tool that is not strategy-bound is judged on its stored preview, as before: the same move runs', async () => {
    BOUND.strategyBound = undefined
    const asked = await call(BOUND.name, { writes: 2 })
    expect(asked).toMatchObject({ status: 'runs_by_rule' })
    strategy.maxChangesPerDay = 1
    await windowClosed(asked.approvalId)
    expect(await inside(() => commitScheduledApproval(asked.approvalId))).toMatchObject({ ok: true, status: 'executed' })
    expect(executed).toHaveLength(1)
  })

  it('the W1-8 narrowing is judged on the fresh dry run too: the strategy row that now says ask is named', async () => {
    __claudeStrategyTest.treatAs(BOUND.name, 'bid')
    await inside(() => db().adsStrategy.create({ data: { market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', claudeAutonomy: { bid: 'ask' }, updatedBy: 'user:test' } }))
    const fresh = { writes: 2, limitFacts: kitFacts(2, NONE) }
    expect(await inside(() => autoFreshRefusal(BOUND.name, fresh, { writes: 2 })))
      .toMatch(/^judged again on a fresh dry run: the ads strategy lets Claude only ask for bid changes here \(IT: market "Test market \(IT\)"/)
    // Not strategy-bound: nothing to judge again (the stored preview was judged before the staleness check).
    BOUND.strategyBound = undefined
    expect(await inside(() => autoFreshRefusal(BOUND.name, fresh, { writes: 2 }))).toBeNull()
  })
})

describe('AA-W2-3 — a plan’s ad steps count together against the strategy’s daily limits', { timeout: TIMEOUT }, () => {
  const plan = (title: string, writes: number[]) => call('submit-change-plan', { title, steps: writes.map((w) => ({ tool: BOUND.name, args: { writes: w } })) })
  const stepsOf = (approvalId: string) => inside(() => db().agentPlanStep.findMany({ where: { approvalId }, orderBy: { position: 'asc' } }))

  it('when the rule decides it: each step inside alone, together over the limit — a person decides, and Claude is told why', async () => {
    const asked = await plan('Together over', [6, 6])
    expect(asked).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'auto', why: `the plan's ad steps together — ${IN_NEXUS(OVER(0, 12, 10))}` } })
    expect(await plan('Together inside', [4, 4])).toMatchObject({ status: 'runs_by_rule' })
  })

  it('at its commit: what ran by rule since it was asked for, plus all its steps, against the limit — the whole plan goes back to a person', async () => {
    const asked = await plan('Commit together', [4, 4])
    expect(asked).toMatchObject({ status: 'runs_by_rule' })
    // A change ran by rule meanwhile (5 writes in IT).
    await inside(async () => {
      const run = await db().agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'done' } })
      await db().agentApproval.create({ data: { agentRunId: run.id, toolName: BOUND.name, riskTier: 'high', args: {}, status: 'executed', decisionVia: 'auto', decidedAt: new Date(), preview: { limitFacts: kitFacts(5, NONE) } as never } })
    })
    await windowClosed(asked.approvalId)
    const out = await inside(() => commitScheduledApproval(asked.approvalId))
    const why = `it is no longer inside the business's limits: the plan's ad steps together — ${IN_NEXUS(OVER(5, 8, 10))}`
    expect(out).toMatchObject({ ok: false, error: `not run — ${why}` })
    expect(await approvalOf(asked.approvalId)).toMatchObject({ status: 'pending', decisionVia: null, reason: `not run — ${why}` })
    expect((await stepsOf(asked.approvalId)).map((step) => step.status)).toEqual(['pending', 'pending'])
    expect(executed).toEqual([])
  })

  it('when each step runs: the steps of the plan that ran before it count; the one that no longer fits is skipped as rule_refused', async () => {
    const asked = await plan('Steps in turn', [4, 4])
    expect(asked).toMatchObject({ status: 'runs_by_rule' })
    strategy.maxChangesPerDay = 6 // the strategy tightened inside the window: the commit judged the plan on its stored limits
    await windowClosed(asked.approvalId)
    expect(await inside(() => commitScheduledApproval(asked.approvalId))).toMatchObject({ ok: true })
    await inside(() => runPlan(asked.approvalId))
    const [first, second] = await stepsOf(asked.approvalId)
    expect(first).toMatchObject({ status: 'done' })
    const why = `judged again on a fresh dry run: it is no longer inside the business's limits: ${IN_NEXUS(OVER(4, 4, 6))}`
    expect(second).toMatchObject({ status: 'skipped', reason: `not run — ${why}` })
    expect(executed.map((run) => run.args.writes)).toEqual([4])
    expect(await inside(() => db().agentControlAudit.findFirst({ where: { action: 'rule_refused', toValue: { path: ['approvalId'], equals: asked.approvalId } } })))
      .toMatchObject({ toValue: { step: 2, tool: BOUND.name, decisionVia: 'auto' } })
    expect(await inside(() => autonomyOf())).toMatchObject({ paused: false })
  })

  it('one clear ending: a sentence that already says a person decides says it once, in Nexus', () => {
    expect(inNexusEnding(OVER(1, 2, 2))).toBe(IN_NEXUS(OVER(1, 2, 2)))
    expect(inNexusEnding('turning a brake down can raise spend (a test rule): a person decides')).toBe('turning a brake down can raise spend (a test rule); a person approves it in Nexus')
    expect(inNexusEnding('the master price moves 14 %, more than the 10 % allowed')).toBe('the master price moves 14 %, more than the 10 % allowed; a person approves it in Nexus')
    for (const sentence of [FRESH, IN_NEXUS(OVER(0, 12, 10))]) expect(sentence.match(/a person (decides|approves)/g)).toHaveLength(1)
  })

  it('planDailyRefusal: only strategy-bound steps count, under the tightest daily limit any of them carries; pure', () => {
    const bound = { strategyBound: 'amazon-ads' as const }
    const step = (writes: number, max: number, tool: { strategyBound?: 'amazon-ads' } | null = bound) => {
      strategy.maxChangesPerDay = max
      return { tool, preview: { limitFacts: kitFacts(writes, NONE) } }
    }
    const ledger = { byMarket: { IT: { changes: 3, writes: 3, raises: 0, budgetIncreaseCents: 0 } }, byEntity: {}, runs: 1 }
    expect(planDailyRefusal([step(4, 10), step(3, 10)], ledger)).toBeNull()
    expect(planDailyRefusal([step(4, 10), step(4, 10)], ledger)).toBe(`the plan's ad steps together — ${OVER(3, 8, 10)}`)
    // The tighter limit (6) binds, not the first step's (10): 3 + 2 + 1 fits, 3 + 2 + 2 does not.
    expect(planDailyRefusal([step(2, 10), step(1, 6)], ledger)).toBeNull()
    expect(planDailyRefusal([step(2, 10), step(2, 6)], ledger)).toBe(`the plan's ad steps together — ${OVER(3, 4, 6)}`)
    expect(planDailyRefusal([step(4, 10), step(9, 10, null), step(9, 10, {})], ledger)).toBeNull()
    expect(planDailyRefusal([{ tool: bound, preview: { summary: 'no facts' } }], ledger)).toBeNull()
  })
})

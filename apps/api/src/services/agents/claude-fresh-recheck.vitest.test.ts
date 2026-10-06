/**
 * ADS AUTONOMY AA-W2-3 — a strategy-bound change the business's rule scheduled is judged again, at commit, on the FRESH
 * dry run the staleness check makes: the ads strategy's facts and today's counts as they are when it runs, not as they
 * were when Claude asked. Outside its limits or the strategy then, it goes back to a person as `rule_refused` (which
 * never counts towards the automatic pause), alone or as a step of a plan. A tool that is not strategy-bound is judged
 * on its stored preview, exactly as before.
 *
 * Through Claude's own door (runToolForClaude → the gate → the sweep's commit → the plan worker) on PGlite with the
 * production schema and business policies, business profiles ON. No real tool is strategy-bound yet (the W2 tool PRs
 * make them so), so a test tool stands in: its dry run reads `world`, as a real one reads the strategy and today's
 * ledger. Values are made up (public repo).
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

/** What the test tool's dry run reads: the strategy's facts and today's by-rule writes, as they are NOW. */
const world = { writesToday: 0 }
const executed: Array<{ args: Record<string, unknown>; ctx: ToolContext }> = []
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
  input: z.object({ bidCents: z.number().int().positive().describe('the new bid, in cents') }),
  limits: z.object({ maxWritesToday: z.number().int().min(0).default(10).describe('the most writes by rule in a day') }),
  withinLimits(preview, limits) {
    const facts = (preview as { limitFacts?: { writesToday?: number } } | null)?.limitFacts
    if (typeof facts?.writesToday !== 'number') return 'its preview carries no limit facts'
    const max = Number(limits.maxWritesToday)
    return facts.writesToday + 1 > max ? `it would be write ${facts.writesToday + 1} by rule today, more than the ${max} allowed` : null
  },
  async handler(args) {
    return { ok: true, preview: { summary: `Bid → ${args.bidCents} cents.`, bidCents: args.bidCents, limitFacts: { writesToday: world.writesToday } } }
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
import { AUTO_PAUSE_FAILURES, autoFreshRefusal, autonomyOf } from './claude-trust.service.js'
import { getTool } from './tool-registry.js'

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
const FRESH = /^not run — judged again on a fresh dry run: it is no longer inside the business's limits: it would be write 11 by rule today, more than the 10 allowed/

beforeAll(async () => {
  registry.real = await vi.importActual<typeof import('./tool-registry.js')>('./tool-registry.js')
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  MATERIAL_PREVIEW_FIELDS[BOUND.name] = ['bidCents']
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
  world.writesToday = 0
  executed.length = 0
  BOUND.strategyBound = 'amazon-ads'
  __claudeStrategyTest.reset()
  await inside(async () => {
    await db().adsStrategy.deleteMany({})
    await db().agentTool.deleteMany({})
    await db().agentAutonomy.deleteMany({})
    await db().agentApproval.updateMany({ where: { status: { in: ['pending', 'scheduled'] } }, data: { status: 'rejected', decisionVia: null } })
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
    const asked = await call(BOUND.name, { bidCents: 50 })
    expect(asked).toMatchObject({ status: 'runs_by_rule' })
    await windowClosed(asked.approvalId)
    expect(await inside(() => commitScheduledApproval(asked.approvalId))).toMatchObject({ ok: true, status: 'executed' })
    expect(executed).toHaveLength(1)
    expect(executed[0]!.ctx).toMatchObject({ decidedVia: 'auto', approvalId: asked.approvalId })
    expect(executed[0]!.ctx.approvedByPerson).toBeUndefined()
  })

  it('the facts moved inside the window (not a material field): back to a person as rule_refused, with the reason', async () => {
    const asked = await call(BOUND.name, { bidCents: 50 })
    expect(asked).toMatchObject({ status: 'runs_by_rule' })
    world.writesToday = 10 // the market's by-rule writes reached the limit meanwhile
    await windowClosed(asked.approvalId)
    const out = await inside(() => commitScheduledApproval(asked.approvalId))
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(FRESH) })
    expect(executed).toEqual([])
    expect(await approvalOf(asked.approvalId)).toMatchObject({ status: 'pending', decisionVia: null, decidedBy: null, reason: expect.stringMatching(FRESH) })
    const audit = await inside(() => db().agentControlAudit.findMany({ where: { action: 'rule_refused', note: { contains: 'fresh dry run' } } }))
    expect(audit.length).toBeGreaterThanOrEqual(1)
    expect(audit.at(-1)).toMatchObject({ charterKey: 'claude', toValue: { approvalId: asked.approvalId, decisionVia: 'auto' } })
  })

  it(`never counts towards the automatic pause, even ${AUTO_PAUSE_FAILURES + 1} times in an hour`, async () => {
    for (let i = 0; i < AUTO_PAUSE_FAILURES + 1; i++) {
      world.writesToday = 0
      const asked = await call(BOUND.name, { bidCents: 60 + i })
      expect(asked).toMatchObject({ status: 'runs_by_rule' })
      world.writesToday = 10
      await windowClosed(asked.approvalId)
      expect(await inside(() => commitScheduledApproval(asked.approvalId))).toMatchObject({ ok: false, error: expect.stringMatching(FRESH) })
    }
    expect(await inside(() => autonomyOf())).toMatchObject({ paused: false })
    expect(executed).toEqual([])
  })

  it('a tool that is not strategy-bound is judged on its stored preview, as before: the same move runs', async () => {
    BOUND.strategyBound = undefined
    const asked = await call(BOUND.name, { bidCents: 70 })
    expect(asked).toMatchObject({ status: 'runs_by_rule' })
    world.writesToday = 10
    await windowClosed(asked.approvalId)
    expect(await inside(() => commitScheduledApproval(asked.approvalId))).toMatchObject({ ok: true, status: 'executed' })
    expect(executed).toHaveLength(1)
  })

  it('a step of a plan run by rule: skipped as rule_refused with the reason; the plan does not run it', async () => {
    const asked = await call('submit-change-plan', { title: 'Recheck plan', steps: [{ tool: BOUND.name, args: { bidCents: 80 } }] })
    expect(asked).toMatchObject({ status: 'runs_by_rule' })
    world.writesToday = 10
    await windowClosed(asked.approvalId)
    expect(await inside(() => commitScheduledApproval(asked.approvalId))).toMatchObject({ ok: true })
    await inside(() => runPlan(asked.approvalId))
    const [step] = await inside(() => db().agentPlanStep.findMany({ where: { approvalId: asked.approvalId } }))
    expect(step).toMatchObject({ status: 'skipped', reason: expect.stringMatching(FRESH) })
    expect(executed).toEqual([])
    expect(await inside(() => db().agentControlAudit.findFirst({ where: { action: 'rule_refused', toValue: { path: ['approvalId'], equals: asked.approvalId } } })))
      .toMatchObject({ toValue: { step: 1, tool: BOUND.name, decisionVia: 'auto' } })
  })

  it('the W1-8 narrowing is judged on the fresh dry run too: the strategy row that now says ask is named', async () => {
    __claudeStrategyTest.treatAs(BOUND.name, 'bid')
    await inside(() => db().adsStrategy.create({ data: { market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', claudeAutonomy: { bid: 'ask' }, updatedBy: 'user:test' } }))
    const fresh = { bidCents: 90, limitFacts: { writesToday: 0 } }
    expect(await inside(() => autoFreshRefusal(BOUND.name, fresh, { bidCents: 90 })))
      .toMatch(/^judged again on a fresh dry run: the ads strategy lets Claude only ask for bid changes here \(IT: market "Test market \(IT\)"/)
    // Not strategy-bound: nothing to judge again (the stored preview was judged before the staleness check).
    BOUND.strategyBound = undefined
    expect(await inside(() => autoFreshRefusal(BOUND.name, fresh, { bidCents: 90 }))).toBeNull()
  })
})

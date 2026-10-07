/**
 * ADS AUTONOMY W4-1 — the Owner's hourly plans are his: a change of a plan a person made or last changed never runs by
 * the business's rule unless the business allowed it (allowPeoplesPlans), even at level auto with every other limit
 * open. Through Claude's own door (runToolForClaude → the gate → the sweep's commit) on PGlite with the production
 * schema, business profiles ON; the job queue a stub. Values are made up (public repo).
 *
 *   person    a rename of a person's plan at level auto waits for a person, the reason named
 *   allowed   with allowPeoplesPlans the same request runs by rule, and the version row names the person it runs as;
 *             the plan stays a person's (one Claude change never makes it Claude's), so the next request waits again
 *   claude's  a plan Claude made runs by rule (inside the limits) until anyone else saves it — then it is a person's
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../../../lib/queue.js', () => {
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
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))

import { commitScheduledApproval } from '../../agent-fleet/approval-inbox.service.js'
import { __claudeStrategyTest } from '../../advertising/ads-strategy/claude.js'
import type { McpPrincipal } from '../../mcp/mcp-auth.js'
import { runToolForClaude } from '../../mcp/mcp-tool-call.js'
import { getTool } from '../tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const TIMEOUT = 30_000
const TOOL = 'set-hourly-bid-plan'
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client as any
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids = { person: '', plan: '' }
let nameA = ''

function claude(): McpPrincipal {
  return {
    kind: 'user', userId: ids.person, label: 'Hana Hours', permissions: { isOwner: false, permissions: EVERYTHING },
    workspace: business, business: { id: A, name: nameA }, via: 'claude', oauthGrantId: 'grant-hours', scopes: ['nexus.read', 'nexus.write', 'nexus.run'],
  } as McpPrincipal
}
type Answer = Record<string, any>
async function call(args: Record<string, unknown>): Promise<Answer> {
  const result = await inside(() => runToolForClaude(claude(), getTool(TOOL)!, { ...args, business: nameA }))
  return JSON.parse((result.content as Array<{ text: string }>).map((b) => b.text).join(''))
}
/** Every limit open but one: the business lets Claude run this tool by its rule. */
const OPEN = { maxItems: 5, markets: ['IT'], campaignIds: ['c-it'], allowRaise: true, maxPlacementPct: 900, maxBaseBidCents: 10_000, allowEngineOwned: true, allowDelete: true }
const atAuto = (claudeLimits: Record<string, unknown>) =>
  inside(() => db().agentTool.create({ data: { name: TOOL, riskTier: 'high', requiresApproval: true, claudeTrust: 'auto', claudeLimits } }))
const windowClosed = (approvalId: string) => inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const client = database.client as any
  const role = await client.role.create({ data: { key: `W41_${randomUUID().slice(0, 8)}`, name: 'Hours tester', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  const person = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Hana Hours' } })
  ids.person = person.id
  await client.userRole.create({ data: { userId: person.id, roleId: role.id } })
  const membership = await client.workspaceMembership.create({ data: { workspaceId: A, userId: person.id, status: 'active' } })
  await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  nameA = (await client.workspace.findUniqueOrThrow({ where: { id: A } })).name
  await inside(async () => {
    await seedAdsFixture(client)
    await client.rankTarget.create({ data: { key: 'test-top', name: 'Test top', biasPct: 0 } })
    // A person's plan (made on the Hourly Bids page), switched off, over c-it.
    const plan = await client.rankScheduleGroup.create({ data: { name: 'Test owner plan', marketplace: 'IT', windows: [], defaultTargetKey: 'test-top', enabled: false } })
    ids.plan = plan.id
    await client.adSchedule.create({ data: { campaignId: 'c-it', name: 'Test owner plan member', windows: [], defaultTargetKey: 'test-top', enabled: false, groupId: plan.id } })
    await client.rankScheduleVersion.create({ data: { groupId: plan.id, name: plan.name, windows: [], defaultTargetKey: 'test-top', campaignCount: 1, enabled: false, changedBy: 'user:anonymous' } })
  })
}, 180_000)

beforeEach(async () => {
  vi.unstubAllEnvs()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  __claudeStrategyTest.reset()
  await inside(async () => {
    await db().adsStrategy.deleteMany({})
    await db().agentTool.deleteMany({})
    await db().agentApproval.updateMany({ where: { status: { in: ['pending', 'scheduled'] } }, data: { status: 'rejected', decisionVia: null } })
    await db().agentApproval.updateMany({ where: { decisionVia: 'auto' }, data: { decidedAt: new Date(Date.now() - 48 * 3600_000) } })
    // IT: Claude may change hourly plans alone; at most 10 changes and 10 raises by rule a day.
    await db().adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', claudeAutonomy: { hourly: 'auto' }, claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 10, version: 1, updatedBy: 'user:test' } })
  })
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('W4-1 — a person\'s hourly plan never changes by rule unless the business allowed it', { timeout: TIMEOUT }, () => {
  it('at auto with every other limit open, a rename of a person\'s plan waits for a person, the reason named', async () => {
    await atAuto(OPEN)
    const asked = await call({ op: 'rename', planId: ids.plan, name: 'Test owner plan (renamed)', why: 'a test' })
    expect(asked).toMatchObject({
      status: 'waiting_for_approval',
      trust: { level: 'auto', why: expect.stringMatching(/"Test owner plan", made or last changed by a person: a person's hourly plan changes only with a person's approval \(allowPeoplesPlans is off\)/) },
    })
    expect((await inside(() => db().rankScheduleGroup.findUnique({ where: { id: ids.plan } }))).name).toBe('Test owner plan')
  })

  it('with allowPeoplesPlans the same request runs by rule; the version names the person it ran as; it stays a person\'s plan', async () => {
    await atAuto({ ...OPEN, allowPeoplesPlans: true })
    const asked = await call({ op: 'rename', planId: ids.plan, name: 'Test owner plan (renamed)', why: 'a test' })
    expect(asked).toMatchObject({ status: 'runs_by_rule' })
    await windowClosed(asked.approvalId)
    expect(await inside(() => commitScheduledApproval(asked.approvalId))).toMatchObject({ ok: true, status: 'executed' })
    expect((await inside(() => db().rankScheduleGroup.findUnique({ where: { id: ids.plan } }))).name).toBe('Test owner plan (renamed)')
    const [version] = await inside(() => db().rankScheduleVersion.findMany({ where: { groupId: ids.plan }, orderBy: { createdAt: 'desc' }, take: 1 }))
    expect(version).toMatchObject({ name: 'Test owner plan (renamed)', changedBy: `user:${ids.person}` })
    // One approved Claude change never makes a person's plan Claude's: with allowPeoplesPlans off again, the next
    // request (and the undo of this one) waits for a person.
    await inside(() => db().agentTool.updateMany({ where: { name: TOOL }, data: { claudeLimits: OPEN } }))
    const next = await call({ op: 'rename', planId: ids.plan, name: 'Test owner plan (again)' })
    expect(next).toMatchObject({ status: 'waiting_for_approval', trust: { why: expect.stringMatching(/made or last changed by a person/) } })
    expect((await inside(() => db().agentApproval.findUnique({ where: { id: next.approvalId } }))).preview).toMatchObject({ owner: { by: 'person' }, peoplesPlans: ['Test owner plan (renamed)'] })
  })

  it('a plan Claude made is Claude\'s until anyone else saves it: one screen edit makes it a person\'s for good', async () => {
    await atAuto({ ...OPEN, campaignIds: ['c-it', 'c-off'], maxChangesPerEntityPerDay: 5 })
    const asked = await call({ op: 'create', name: 'Test claude made', market: 'IT', campaignIds: ['c-off'], defaultTargetKey: 'test-top' })
    expect(asked, JSON.stringify(asked.trust)).toMatchObject({ status: 'runs_by_rule' })
    await windowClosed(asked.approvalId)
    expect(await inside(() => commitScheduledApproval(asked.approvalId))).toMatchObject({ ok: true, status: 'executed' })
    const made = await inside(() => db().rankScheduleGroup.findFirst({ where: { name: 'Test claude made' } }))
    const renamed = await call({ op: 'rename', planId: made.id, name: 'Test claude made 2' })
    expect(renamed, JSON.stringify(renamed.trust)).toMatchObject({ status: 'runs_by_rule' })
    await windowClosed(renamed.approvalId)
    expect(await inside(() => commitScheduledApproval(renamed.approvalId))).toMatchObject({ ok: true, status: 'executed' })
    // A person renames it on the Hourly Bids page (the lightweight PATCH), then a Claude request puts the name back.
    const { patchRankScheduleGroup } = await import('../../advertising/rank-schedule-group.service.js')
    await inside(() => patchRankScheduleGroup(made.id, { name: 'Test claude made (screen)' }, 'user:screen-person'))
    const after = await call({ op: 'rename', planId: made.id, name: 'Test claude made 3' })
    expect(after).toMatchObject({ status: 'waiting_for_approval', trust: { why: expect.stringMatching(/made or last changed by a person/) } })
  })
})

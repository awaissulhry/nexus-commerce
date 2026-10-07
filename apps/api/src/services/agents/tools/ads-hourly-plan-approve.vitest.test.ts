/**
 * ADS AUTONOMY W4-1 (review) — set-hourly-bid-plan through the REAL approve path: the Approvals inbox's own approve
 * (decideFleetApproval, the route's call) with and without the approver's authenticator code, then the commit after the
 * undo window; a change plan carrying the step's code and words; and a run by the business's rule judged again in
 * `execute`. PGlite, production schema; the job queue a stub. Made-up ids and values.
 *
 *   switch on      needs the code: without it mfa_required, nothing changes; with it, it runs
 *   switch off     a plan that is on with Min-bid hours asks for the code even when nothing is floored now (lead decision A)
 *   change plan    a step that raises makes the plan need the code (mergedStepUp); the step keeps its warnings
 *   by rule        execute refuses a person's plan run by rule unless the business's limits allow it now
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecret, generateSync } from 'otplib'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
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

import { callTool, type UserPrincipal } from '../call-tool.js'
import { runOrQueueTool } from '../approval-gate.service.js'
import { commitScheduledApproval, decideFleetApproval } from '../../agent-fleet/approval-inbox.service.js'
import { getTool } from '../tool-registry.js'
import { __stepUpTest } from '../../../lib/auth/step-up.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client as any
const TOOL = 'set-hourly-bid-plan'
const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
const people = { asker: '', approver: '', secret: '' }
const principal = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId.slice(0, 6)}`, via, workspace: business, permissions: { isOwner: false, permissions: EVERYTHING },
})
type Row = Record<string, any>
const WEEK = [{ days: [1, 2, 3, 4, 5], startHour: 0, endHour: 6, targetKey: 'test-floor' }]
const ids = { off: '', person: '' }

async function ask(args: Record<string, unknown>, tool = TOOL): Promise<Row> {
  return inside(async () => {
    const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: people.asker } })
    return runOrQueueTool(tool, args, principal(people.asker, 'claude'), run.id, { forceAsk: true })
  }) as Promise<Row>
}
/** The Approvals inbox's approve, as the route calls it: the approver, and their code when given. */
const approve = (id: string, code?: string) => inside(() => decideFleetApproval({ id, decision: 'approve', actor: principal(people.approver, 'app'), ...(code ? { code } : {}) })) as Promise<Row>
async function commit(id: string): Promise<Row> {
  await inside(() => db().agentApproval.update({ where: { id }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(id)) as Promise<Row>
}
const plan = (id: string) => inside(() => db().rankScheduleGroup.findUnique({ where: { id } })) as Promise<Row>
const code = () => { __stepUpTest.reset(); return generateSync({ secret: people.secret }) }

beforeAll(async () => {
  database = await formulaDatabase()
  const c = database.client as any
  people.secret = generateSecret()
  people.asker = (await c.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Test Asker' } })).id
  people.approver = (await c.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Test Approver', twoFactorEnabledAt: new Date(), twoFactorSecret: people.secret } })).id
  // The approver holds every permission in this business (the commit checks the decider's access again).
  const role = await c.role.create({ data: { key: `W41A_${randomUUID().slice(0, 8)}`, name: 'Hours approver', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  await c.userRole.create({ data: { userId: people.approver, roleId: role.id } })
  const membership = await c.workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId: people.approver, status: 'active' } })
  await c.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  await inside(async () => {
    await seedAdsFixture(c)
    await c.rankTarget.create({ data: { key: 'test-floor', name: 'Test min bid', pause: true } })
    await c.rankTarget.create({ data: { key: 'test-top', name: 'Test top', biasPct: 50 } })
    // A plan that is off (over c-it), and a person's plan that is on with Min-bid hours (over c-off), nothing floored.
    const off = await c.rankScheduleGroup.create({ data: { name: 'Test off plan', marketplace: 'IT', windows: WEEK, defaultTargetKey: 'test-top', enabled: false } })
    ids.off = off.id
    await c.adSchedule.create({ data: { campaignId: 'c-it', name: 'Test off member', windows: WEEK, defaultTargetKey: 'test-top', enabled: false, groupId: off.id } })
    const own = await c.rankScheduleGroup.create({ data: { name: 'Test on plan', marketplace: 'IT', windows: WEEK, defaultTargetKey: 'test-top', enabled: true } })
    ids.person = own.id
    await c.adSchedule.create({ data: { campaignId: 'c-off', name: 'Test on member', windows: WEEK, defaultTargetKey: 'test-top', enabled: true, groupId: own.id } })
  })
}, 180_000)
beforeEach(() => __stepUpTest.reset())
afterAll(async () => { await database?.close() }, 30_000)

describe('W4-1 — set-hourly-bid-plan through the Approvals inbox', () => {
  it('a switch on needs the approver\'s code: without it mfa_required and nothing changes; with it, it runs', async () => {
    const asked = await ask({ op: 'switch', planId: ids.off, on: true })
    expect(asked).toMatchObject({ ok: true, mode: 'queued' })
    expect(await approve(asked.approvalId)).toMatchObject({ ok: false, code: 'mfa_required', raises: ['Hourly bid plans'] })
    expect((await plan(ids.off)).enabled).toBe(false)
    expect(await approve(asked.approvalId, code())).toMatchObject({ ok: true, status: 'scheduled' })
    const done = await commit(asked.approvalId)
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true, status: 'executed' })
    expect((await plan(ids.off)).enabled).toBe(true)
  })

  it('switching off a plan that is on with Min-bid hours asks for the code even with nothing floored now (lead decision A)', async () => {
    const asked = await ask({ op: 'switch', planId: ids.person, on: false })
    const stored = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: asked.approvalId } }))
    expect(stored.preview).toMatchObject({ givesBack: { restore: 0 }, stepUp: { what: 'gives back bids an hourly bid plan floored' } })
    expect(await approve(asked.approvalId)).toMatchObject({ ok: false, code: 'mfa_required' })
    expect(await approve(asked.approvalId, code())).toMatchObject({ ok: true, status: 'scheduled' })
    const done = await commit(asked.approvalId)
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true, status: 'executed' })
    expect((await plan(ids.person)).enabled).toBe(false)
  })

  it('as a step of a change plan: the plan needs the code (the step\'s stepUp) and keeps the step\'s words', async () => {
    const asked = await ask({ title: 'Switch a test plan on', steps: [{ tool: TOOL, args: { op: 'switch', planId: ids.person, on: true } }] }, 'submit-change-plan')
    expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true, mode: 'queued' })
    const stored = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: asked.approvalId } }))
    expect(stored.preview).toMatchObject({ stepUp: { what: 'switches an hourly bid plan on', raises: ['Hourly bid plans'], steps: [1] } })
    const [step] = await inside(() => db().agentPlanStep.findMany({ where: { approvalId: asked.approvalId } }))
    expect(step.preview).toMatchObject({ op: 'switch', raises: [expect.stringMatching(/^switches the plan on/)], peoplesPlans: ['Test on plan'], warnings: expect.any(Array), consequences: expect.stringMatching(/^Nexus only/) })
    expect(await approve(asked.approvalId)).toMatchObject({ ok: false, code: 'mfa_required' })
  })

  it('by rule: execute refuses a person\'s plan unless the business\'s limits allow it now (a fresh dry run, decidedVia auto)', async () => {
    const tool = getTool(TOOL)!
    const args = { op: 'rename', planId: ids.person, name: 'Test on plan (by rule)' }
    const asked = await ask(args)
    const stored = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: asked.approvalId } }))
    const ctx = { userId: people.asker, can: () => true, via: 'claude' as const, approvalId: asked.approvalId, decidedVia: 'auto' as const, approvedByPerson: false, approvedPreview: stored.preview }
    expect(await inside(() => tool.execute!(args, ctx))).toEqual({ ok: false, error: expect.stringMatching(/^Not run by the business's rule: it changes "Test on plan", made or last changed by a person: .*\(allowPeoplesPlans is off\)\.$/) })
    expect((await plan(ids.person)).name).toBe('Test on plan')
    // The same request decided by a person runs.
    expect(await inside(() => tool.execute!(args, { ...ctx, decidedVia: 'nexus' as const, approvedByPerson: true }))).toMatchObject({ ok: true })
    expect((await plan(ids.person)).name).toBe('Test on plan (by rule)')
  })

  it('a preview of the read tool is unchanged by all this (a read, no approval)', async () => {
    expect((await inside(() => callTool(principal(people.asker, 'claude'), 'ad-hourly-plans', { planId: ids.person }))).raw).toMatchObject({ ok: true, data: { plan: { planId: ids.person } } })
  })
})

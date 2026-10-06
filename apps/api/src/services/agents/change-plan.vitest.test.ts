/**
 * MCP full control C6 — change plans: one approval for up to 200 changes.
 *
 * Proven through Claude's own door (runToolForClaude → the gate), the Approvals page's functions (decideFleetApproval),
 * the sweep's commit and the plan runner the worker calls, on a real PostgreSQL with the production schema and business
 * policies (PGlite). The master price service and the content writer are real; nothing reaches a marketplace.
 *
 *   submit      every step is dry-run as the person through the same door; all must preview, or nothing is stored and
 *               Claude gets each step's refusal. One approval (a Nexus-written summary, a planHash) and one row per step.
 *   approve     needs the permissions of every step; then the normal undo window; the commit hands it to the worker.
 *   run         step by step, in order: claimed, the approver's permissions and the step's preview re-checked, then run as
 *               the approver; a stale step is skipped with its reason, the others go on; a stopped worker resumes where
 *               it stopped, and a step it left half-run is never run twice; the sweep picks up a plan nobody runs.
 *   status      approval-status shows the plan; undo of a plan is ONE plan of inverse steps, in reverse order.
 *   auto        a plan runs by the business's rule only when every step may (level, limits, scope, the daily cap).
 *   amend       unticking steps supersedes the plan with a smaller one.
 *   watch       AA-W2-4 — a plan with a watched step: the full check runs per step and for the plan and is recorded on
 *               it; it is never scheduled by the rule, and a person decides it.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecret, generateSync } from 'otplib'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
vi.mock('../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, agentPlanQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true, workersOff: true })),
}))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import { __stepUpTest } from '../../lib/auth/step-up.js'
import { commitScheduledApproval, decideFleetApproval, runApprovalMaintenance } from '../agent-fleet/approval-inbox.service.js'
import type { McpPrincipal } from '../mcp/mcp-auth.js'
import { runToolForClaude } from '../mcp/mcp-tool-call.js'
import type { UserPrincipal } from './call-tool.js'
import { amendPlan, runPlan } from './change-plan.service.js'
import { autoRunsInLastDay, setClaudeRule, setDailyAutoCap, watchedRunsInLastDay } from './claude-trust.service.js'
import { getTool } from './tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const B = 'c6_plan_bravo'
const TIMEOUT = 60_000
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const db = () => database.client

const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
/** May change prices, not content. */
const PRICES_ONLY = new Set<string>([F.aiRun, F.aiView, F.productsView, F.productsPriceEdit])
const ids: Record<string, string> = {}
let secret = ''
let nameA = ''

function claude(scopes = ['nexus.read', 'nexus.write', 'nexus.run']): McpPrincipal {
  return {
    kind: 'user', userId: ids.person, label: 'Pia Plan', permissions: { isOwner: false, permissions: EVERYTHING },
    workspace: business(A), business: { id: A, name: nameA }, via: 'claude', oauthGrantId: 'grant-plan', scopes,
  } as McpPrincipal
}
const person = (permissions = EVERYTHING): UserPrincipal => ({
  kind: 'user', userId: ids.person, label: 'Pia Plan', permissions: { isOwner: false, permissions }, workspace: business(A), via: 'app',
})
const manager = () => ({ userId: ids.person, label: 'Pia Plan', canManage: true })
async function call(tool: string, args: Record<string, unknown>, who = claude()) {
  const result = await runToolForClaude(who, getTool(tool)!, { ...args, business: nameA })
  return { isError: !!result.isError, answer: JSON.parse((result.content as Array<{ text: string }>).map((b) => b.text).join('')) }
}
const price = (key: string, value: number) => ({ tool: 'set-price', args: { productId: ids[key], price: value } })
const priceOf = async (key: string) => inside(async () => Number((await db().product.findUniqueOrThrow({ where: { id: ids[key] } })).basePrice))
const stepsOf = (approvalId: string) => inside(() => db().agentPlanStep.findMany({ where: { approvalId }, orderBy: { position: 'asc' } }))
const approvalOf = (id: string) => inside(() => db().agentApproval.findUniqueOrThrow({ where: { id } }))
/** A person approves it on the Approvals page, the window closes, and the sweep's commit hands it to the worker. */
async function approveAndCommit(approvalId: string) {
  const parked = await inside(() => decideFleetApproval({ id: approvalId, decision: 'approve', actor: person() }))
  expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId))
}
async function submit(title: string, steps: Array<{ tool: string; args: Record<string, unknown> }>, who = claude()) {
  const out = await call('submit-change-plan', { title, steps }, who)
  expect(out.isError, JSON.stringify(out.answer)).toBe(false)
  return out.answer
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  vi.stubEnv('ENABLE_QUEUE_WORKERS', '')
  const client = database.client
  secret = generateSecret()
  const role = await client.role.create({
    data: { key: `C6_PLAN_${randomUUID().slice(0, 8)}`, name: 'Plan tester', description: 'test', isSystem: false, permissions: [...EVERYTHING] },
  })
  const p = await client.userProfile.create({
    data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Pia Plan', twoFactorEnabledAt: new Date(), twoFactorSecret: secret },
  })
  ids.person = p.id
  await client.userRole.create({ data: { userId: p.id, roleId: role.id } })
  await client.workspace.create({ data: { id: B, name: 'Bravo plan business', createdByUserId: p.id, creationKey: randomUUID() } })
  nameA = (await client.workspace.findUniqueOrThrow({ where: { id: A } })).name
  for (const workspaceId of [A, B]) {
    const membership = await client.workspaceMembership.create({ data: { workspaceId, userId: p.id, status: 'active' } })
    await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  }
  await inside(async () => {
    for (const key of ['a1', 'a2', 'a3', 'b1', 'b2', 'b3', 'c1', 'c2', 'c3', 'd1', 'd2', 'e1', 'e2', 'e3', 'f1', 'f2']) {
      ids[key] = (await client.product.create({ data: { sku: `TEST-PLAN-${key.toUpperCase()}`, name: `Plan jacket ${key}`, basePrice: '100.00' } })).id
    }
  })
  await inside(async () => {
    ids.bravo = (await client.product.create({ data: { sku: 'TEST-PLAN-A1', name: 'Bravo plan jacket', basePrice: '100.00' } })).id
  }, B)
}, 180_000)

beforeEach(async () => {
  __stepUpTest.reset()
  await inside(async () => {
    await db().agentTool.deleteMany({})
    await db().agentAutonomy.deleteMany({})
  })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('C6 — submitting a plan', { timeout: TIMEOUT }, () => {
  it('every step is dry-run as the person; one approval with a summary and a hash; one row per step; nothing changes', async () => {
    const answer = await submit('Spring prices', [price('a1', 105), price('a2', 106), { tool: 'apply-content', args: { productId: ids.a3, title: 'Plan jacket a3, spring' } }])
    expect(answer).toMatchObject({
      status: 'waiting_for_approval',
      approvalId: expect.any(String),
      plan: { steps: 3, summary: expect.stringContaining('3 changes'), planHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    })
    expect(answer.preview.steps).toHaveLength(3)
    expect(answer.preview.steps[0]).toMatchObject({ step: 1, tool: 'set-price', preview: { action: 'set-price' } })
    const approval = await approvalOf(answer.approvalId)
    expect(approval).toMatchObject({ toolName: 'submit-change-plan', status: 'pending', summary: answer.plan.summary, planHash: answer.plan.planHash })
    expect(approval.summary).toMatch(/2 × Set master price/)
    expect(approval.summary).toMatch(/1 × Apply/)
    const steps = await stepsOf(answer.approvalId)
    expect(steps.map((s) => [s.position, s.toolName, s.status])).toEqual([[1, 'set-price', 'pending'], [2, 'set-price', 'pending'], [3, 'apply-content', 'pending']])
    expect(steps[0].preview).toMatchObject({ action: 'set-price', changes: { 'base price': { from: 100, to: 105 } } })
    expect(await priceOf('a1')).toBe(100)
    ids.planA = answer.approvalId
  })

  it('one step refused: nothing is stored, and Claude gets each step’s refusal', async () => {
    const pending = () => inside(() => db().agentApproval.count({ where: { toolName: 'submit-change-plan' } }))
    const start = await pending()
    const { isError, answer } = await call('submit-change-plan', {
      title: 'Mixed',
      steps: [price('b1', 101), { tool: 'set-price', args: { productId: ids.bravo, price: 101 } }, { tool: 'product-search', args: {} }, { tool: 'no-such-tool', args: {} }],
    })
    expect(isError).toBe(true)
    expect(answer.error).toMatch(/not stored: 3 of 4 steps were refused/)
    expect(answer.refusals).toEqual([
      { step: 2, tool: 'set-price', error: 'Product not found' },
      { step: 3, tool: 'product-search', error: expect.stringContaining('not a change') },
      { step: 4, tool: 'no-such-tool', error: expect.stringContaining('not a change') },
    ])
    expect(await pending()).toBe(start)
  })

  it('approving it needs the permissions of every step', async () => {
    const refused = await inside(() => decideFleetApproval({ id: ids.planA, decision: 'approve', actor: person(PRICES_ONLY) }))
    expect(refused).toMatchObject({ ok: false, code: 'forbidden', error: expect.stringContaining('apply-content') })
    expect(await approvalOf(ids.planA)).toMatchObject({ status: 'pending' })
  })
})

describe('C6 — running a plan', { timeout: TIMEOUT }, () => {
  it('after the window the commit hands it to the worker; each step runs as the approver and records its own change', async () => {
    expect(await approveAndCommit(ids.planA)).toMatchObject({ ok: true, status: 'executing' })
    expect(await priceOf('a1')).toBe(100) // the worker runs it, not the commit
    expect(await inside(() => runPlan(ids.planA))).toMatchObject({ finished: true, counts: { done: 3 } })
    expect([await priceOf('a1'), await priceOf('a2')]).toEqual([105, 106])
    expect((await inside(() => db().product.findUniqueOrThrow({ where: { id: ids.a3 } }))).name).toBe('Plan jacket a3, spring')
    const steps = await stepsOf(ids.planA)
    expect(steps.every((s) => s.status === 'done' && s.changeId)).toBe(true)
    const changes = await inside(() => db().agentChange.findMany({ where: { approvalId: ids.planA }, orderBy: { executedAt: 'asc' } }))
    expect(changes.map((c) => [c.planStepId, c.toolName, c.via, c.executedByUserId])).toEqual(steps.map((s) => [s.id, s.toolName, 'claude', ids.person]))
    expect(await approvalOf(ids.planA)).toMatchObject({ status: 'executed', reason: null })
    // Running it again does nothing.
    expect(await inside(() => runPlan(ids.planA))).toMatchObject({ ran: 0 })
  })

  it('approval-status shows the plan: its summary and each step’s fate', async () => {
    const { answer } = await call('approval-status', { approvalId: ids.planA })
    expect(answer).toMatchObject({
      status: 'executed',
      plan: { title: 'Spring prices', summary: expect.stringContaining('3 changes'), steps: 3, byStatus: { done: 3 } },
    })
    expect(answer.plan.list[2]).toMatchObject({ step: 3, tool: 'apply-content', status: 'done', changeId: expect.any(String) })
  })

  it('undo of a plan is ONE plan of the inverse steps, in reverse order; once run, everything is back', async () => {
    const { answer } = await call('undo-change', { approvalId: ids.planA })
    expect(answer).toMatchObject({ status: 'waiting_for_approval', plan: { steps: 3 } })
    const steps = await stepsOf(answer.approvalId)
    expect(steps.map((s) => s.toolName)).toEqual(['apply-content', 'set-price', 'set-price'])
    expect(steps.map((s) => (s.args as { productId: string }).productId)).toEqual([ids.a3, ids.a2, ids.a1])
    expect(await approveAndCommit(answer.approvalId)).toMatchObject({ ok: true, status: 'executing' })
    expect(await inside(() => runPlan(answer.approvalId))).toMatchObject({ finished: true, counts: { done: 3 } })
    expect([await priceOf('a1'), await priceOf('a2')]).toEqual([100, 100])
    expect((await inside(() => db().product.findUniqueOrThrow({ where: { id: ids.a3 } }))).name).toBe('Plan jacket a3')
    const originals = await inside(() => db().agentChange.findMany({ where: { approvalId: ids.planA } }))
    expect(originals.every((c) => c.undoneAt && c.undoneByApprovalId === answer.approvalId)).toBe(true)
  })

  it('a plan whose change moved since cannot be undone as a whole, and the refusal names every such step', async () => {
    const { approvalId } = await submit('Undo refused', [price('d1', 150), price('d2', 151)])
    await approveAndCommit(approvalId)
    expect(await inside(() => runPlan(approvalId))).toMatchObject({ finished: true, counts: { done: 2 } })
    await inside(() => db().product.update({ where: { id: ids.d1 }, data: { basePrice: '99.00' } }))
    await inside(() => db().product.update({ where: { id: ids.d2 }, data: { basePrice: '98.00' } }))
    const { isError, answer } = await call('undo-change', { approvalId })
    expect(isError).toBe(true)
    expect(answer.error).toMatch(/^The plan cannot be undone as a whole: steps 2 and 1 cannot be put back — /)
    expect(answer.error).toContain('step 2 (set-price)')
    expect(answer.error).toContain('step 1 (set-price)')
  })

  it('a stale step is skipped with its reason; the others run', async () => {
    const { approvalId } = await submit('Stale one', [price('b1', 110), price('b2', 111), price('b3', 112)])
    await approveAndCommit(approvalId)
    await inside(() => db().product.update({ where: { id: ids.b2 }, data: { basePrice: '200.00' } })) // someone moved it
    expect(await inside(() => runPlan(approvalId))).toMatchObject({ finished: true, counts: { done: 2, skipped: 1 } })
    expect([await priceOf('b1'), await priceOf('b2'), await priceOf('b3')]).toEqual([110, 200, 112])
    const steps = await stepsOf(approvalId)
    expect(steps[1]).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/^not run — /), changeId: null })
    expect(await approvalOf(approvalId)).toMatchObject({ status: 'executed', reason: expect.stringContaining('2 of 3 changes ran; 1 skipped') })
  })

  it('a stopped worker resumes where it stopped; a step it left half-run is not run twice', async () => {
    const { approvalId } = await submit('Restart', [price('c1', 120), price('c2', 121), price('c3', 122)])
    await approveAndCommit(approvalId)
    expect(await inside(() => runPlan(approvalId, { maxSteps: 1 }))).toMatchObject({ ran: 1, finished: false })
    // The worker died while step 2 ran: it may or may not have changed something.
    const [, second] = await stepsOf(approvalId)
    await inside(() => db().agentPlanStep.update({ where: { id: second.id }, data: { status: 'executing', startedAt: new Date(Date.now() - 30 * 60_000) } }))
    expect(await inside(() => runPlan(approvalId))).toMatchObject({ finished: true, counts: { done: 2, failed: 1 } })
    const steps = await stepsOf(approvalId)
    expect(steps.map((s) => s.status)).toEqual(['done', 'failed', 'done'])
    expect(steps[1].reason).toContain('interrupted')
    expect([await priceOf('c1'), await priceOf('c2'), await priceOf('c3')]).toEqual([120, 100, 122])
  })

  it('the sweep picks up a plan nobody runs (workers off: it runs it there)', async () => {
    const { approvalId } = await submit('Swept', [price('d1', 130), price('d2', 131)])
    await approveAndCommit(approvalId)
    await inside(() => runApprovalMaintenance())
    expect(await approvalOf(approvalId)).toMatchObject({ status: 'executed' })
    expect([await priceOf('d1'), await priceOf('d2')]).toEqual([130, 131])
  })
})

describe('C6 — a plan runs by the business’s rule only when every step may', { timeout: TIMEOUT }, () => {
  const code = () => {
    __stepUpTest.reset()
    return generateSync({ secret })
  }
  const toAuto = (tool: string) => inside(() => setClaudeRule(manager(), tool, { level: 'auto', code: code() }))

  it('every step at auto and inside its limits: scheduled by the rule; the commit hands it to the worker', async () => {
    await toAuto('set-price')
    const answer = await submit('Auto plan', [price('e1', 101), price('e2', 102)])
    expect(answer).toMatchObject({ status: 'runs_by_rule', plan: { steps: 2 } })
    expect(await approvalOf(answer.approvalId)).toMatchObject({ status: 'scheduled', decisionVia: 'auto' })
  })

  it('one step outside its limits, or at a lower level: a person decides, and Claude is told which step', async () => {
    await toAuto('set-price')
    const far = await submit('Too far', [price('e3', 101), price('f1', 180)])
    expect(far).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'auto', why: expect.stringMatching(/^step 2 \(set-price\): the master price moves/) } })
    const mixed = await submit('Mixed levels', [price('e3', 101), { tool: 'apply-content', args: { productId: ids.f2, title: 'Mixed title' } }])
    expect(mixed).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'ask', why: expect.stringContaining('step 2 (apply-content) waits for a person') } })
  })

  it('the daily cap counts each step of a plan', async () => {
    await toAuto('set-price')
    const one = await submit('Cap probe', [price('e3', 101)])
    expect(one.status).toBe('runs_by_rule')
    const used = (await inside(() => import('./claude-trust.service.js').then((m) => m.autoRunsInLastDay())))
    expect(await inside(() => setDailyAutoCap(manager(), { dailyAutoCap: used + 1 }))).toMatchObject({ ok: true })
    const two = await submit('Over the cap', [price('f1', 101), price('f2', 101)])
    expect(two).toMatchObject({ status: 'waiting_for_approval', trust: { why: expect.stringContaining('changes run by rule in 24 hours') } })
  })
})

describe('C6 — unticking steps supersedes the plan with a smaller one', { timeout: TIMEOUT }, () => {
  it('keeps the ticked steps, re-checked as the person; the original is superseded', async () => {
    const { approvalId } = await submit('Amend me', [price('f1', 140), price('f2', 141), price('e3', 142)])
    expect(await inside(() => amendPlan(approvalId, [1, 2, 3], person()))).toMatchObject({ ok: false, error: expect.stringContaining('Untick') })
    expect(await inside(() => amendPlan(approvalId, [], person()))).toMatchObject({ ok: false })
    const amended = await inside(() => amendPlan(approvalId, [1, 3], person()))
    expect(amended).toMatchObject({ ok: true, supersededId: approvalId, approvalId: expect.any(String) })
    if (!amended.ok) return
    expect(await approvalOf(approvalId)).toMatchObject({ status: 'superseded' })
    const steps = await stepsOf(amended.approvalId)
    expect(steps.map((s) => [s.position, (s.args as { productId: string }).productId])).toEqual([[1, ids.f1], [2, ids.e3]])
    expect(await approvalOf(amended.approvalId)).toMatchObject({ status: 'pending', toolName: 'submit-change-plan', summary: expect.stringContaining('2 changes') })
  })
})

describe('AA-W2-4 — a watched plan: the full check per step, recorded on it; a person decides', { timeout: TIMEOUT }, () => {
  const code = () => {
    __stepUpTest.reset()
    return generateSync({ secret })
  }
  const setTo = async (tool: string, level: string) => {
    expect(await inside(() => setClaudeRule(manager(), tool, { level, code: code() }))).toMatchObject({ ok: true })
  }
  beforeAll(async () => {
    await inside(async () => {
      for (const key of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8']) {
        ids[key] = (await database.client.product.create({ data: { sku: `TEST-PLAN-${key.toUpperCase()}`, name: `Watched jacket ${key}`, basePrice: '100.00' } })).id
      }
    })
  })

  it('every step at watch and inside its limits: never scheduled; recorded as would-run, step by step; a person approves it', async () => {
    await setTo('set-price', 'watch')
    const answer = await submit('Watched plan', [price('w1', 101), price('w2', 102)])
    expect(answer).toMatchObject({
      status: 'waiting_for_approval',
      plan: { steps: 2 },
      trust: { level: 'watch', why: expect.stringMatching(/^watching: it would have run by rule; the person who asked types/), watch: { wouldRun: true, check: null, steps: { total: 2, wouldRun: 2 } } },
      confirm: { planHash: expect.any(String) },
    })
    const stored = await approvalOf(answer.approvalId)
    expect(stored).toMatchObject({ status: 'pending', decisionVia: null, executeAfter: null })
    expect(stored.ruleVerdict).toEqual({
      level: 'watch', wouldRun: true, check: null, why: null, checkedAt: expect.any(String), changes: 2,
      steps: [
        { step: 1, tool: 'set-price', level: 'watch', watched: true, wouldRun: true, check: null, why: null },
        { step: 2, tool: 'set-price', level: 'watch', watched: true, wouldRun: true, check: null, why: null },
      ],
    })
    expect(await approveAndCommit(answer.approvalId)).toMatchObject({ ok: true, status: 'executing' })
    expect(await inside(() => runPlan(answer.approvalId))).toMatchObject({ finished: true, counts: { done: 2 } })
    expect([await priceOf('w1'), await priceOf('w2')]).toEqual([101, 102])
  })

  it('a step outside its limits, or a step below watch: recorded per step, and the plan names the step that holds it', async () => {
    await setTo('set-price', 'watch')
    const far = await submit('Watched, too far', [price('w3', 101), price('w4', 180)])
    expect(far).toMatchObject({ trust: { level: 'watch', watch: { wouldRun: false, check: 'limits', why: expect.stringMatching(/^step 2 \(set-price\): the master price moves/), steps: { total: 2, wouldRun: 1 } } } })
    expect((await approvalOf(far.approvalId)).ruleVerdict).toMatchObject({ steps: [{ step: 1, wouldRun: true, check: null }, { step: 2, wouldRun: false, check: 'limits' }] })
    const mixed = await submit('Watched and asked', [price('w5', 101), { tool: 'apply-content', args: { productId: ids.w6, title: 'Watched title' } }])
    expect(mixed).toMatchObject({
      status: 'waiting_for_approval',
      trust: { level: 'ask', why: expect.stringContaining('step 2 (apply-content) waits for a person'), watch: { wouldRun: false, check: 'level' } },
    })
    expect((await approvalOf(mixed.approvalId)).ruleVerdict).toMatchObject({
      level: 'ask', wouldRun: false, check: 'level', why: 'a plan runs by rule only when every step may: step 2 (apply-content) waits for a person',
      steps: [
        { step: 1, tool: 'set-price', level: 'watch', watched: true, wouldRun: true, check: null },
        { step: 2, tool: 'apply-content', level: 'ask', watched: false, wouldRun: false, check: 'level', why: 'it waits for a person (ask)' },
      ],
    })
  })

  it('the cap counts every step of a watched plan, with the watched changes that would have run', async () => {
    await setTo('set-price', 'watch')
    const used = await inside(async () => (await autoRunsInLastDay()) + (await watchedRunsInLastDay()))
    expect(used).toBeGreaterThan(0) // the would-run plan above counts its 2 steps
    expect(await inside(() => setDailyAutoCap(manager(), { dailyAutoCap: used + 1 }))).toMatchObject({ ok: true })
    const two = await submit('Watched over the cap', [price('w7', 101), price('w8', 101)])
    expect(two.trust.watch).toMatchObject({ wouldRun: false, check: 'cap', why: expect.stringContaining(`(${used} already, counting the watched changes that would have run)`), steps: { total: 2, wouldRun: 0 } })
  })
})

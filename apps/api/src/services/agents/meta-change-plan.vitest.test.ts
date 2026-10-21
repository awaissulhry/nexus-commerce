/**
 * Meta ads step 44 (master EX-029) — Meta changes in ONE change plan, exactly as any other change tool (Google's too): no
 * list names them, every registered Meta change tool is a step a plan can run. Proven through Claude's own door
 * (runToolForClaude → the gate), the Approvals page's approve, the sweep's commit and the plan runner, on PGlite with the
 * production schema and policies. Meta, the chosen account and the live reads are stand-ins; nothing reaches Meta.
 * Made-up ids and names only.
 *
 *   every tool   each Meta change tool is plan-able (a change with an execute, not a read or a control tool), its preview
 *                re-checked by the approval inbox (basis, plan, reach), never a journal entry
 *   act on the winner   "pause the loser, switch on the winner" (EX-029): both steps dry-run as the person; ONE approval;
 *                the switch-on is marked SPENDS MONEY in its step's preview; approved once, each step runs as the approver,
 *                request by request, with its own record and undo; undo of the plan is ONE plan of the inverse steps
 *   refusals     a Meta step Meta would refuse refuses the whole plan before anything is stored
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property) }) }
})
vi.mock('../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, agentPlanQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true, workersOff: true })),
}))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

// Meta: the chosen ad account, its objects as Meta reads them, Meta's check and send (as the set-meta-status suite stands them in).
const h = vi.hoisted(() => ({
  live: new Map<string, Record<string, unknown>>(),
  check: vi.fn(async () => undefined),
  send: vi.fn(),
}))
vi.mock('../marketing/meta-ads/change-account.js', () => ({
  metaChangeAccount: vi.fn(async () => ({ target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' })),
}))
vi.mock('../marketing/meta-ads/live-status.js', async (importActual) => ({
  ...(await importActual<typeof import('../marketing/meta-ads/live-status.js')>()),
  liveStatusObjects: vi.fn(async (_target: unknown, items: Array<{ kind: string; id: string }>) => {
    const objects = new Map<string, unknown>()
    for (const item of items) { const o = h.live.get(`${item.kind}:${item.id}`); if (o) objects.set(`${item.kind}:${item.id}`, structuredClone(o)) }
    return { objects, problems: [] }
  }),
}))
vi.mock('../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../marketing/meta-ads/write-client.js')>()),
  metaCheckChange: h.check,
  metaSendChange: h.send,
}))
vi.mock('../marketing/meta-ads/store.js', () => ({ recordStatusReadBack: vi.fn(async () => 1) }))

import { commitScheduledApproval, decideFleetApproval, MATERIAL_PREVIEW_FIELDS } from '../agent-fleet/approval-inbox.service.js'
import type { McpPrincipal } from '../mcp/mcp-auth.js'
import { runToolForClaude } from '../mcp/mcp-tool-call.js'
import type { UserPrincipal } from './call-tool.js'
import { runPlan } from './change-plan.service.js'
import { getTool, listTools } from './tool-registry.js'
import { MetaWriteError } from '../marketing/meta-ads/write-client.js'
import { localFailure } from '../marketing/meta-ads/errors.js'
import { __metaObjectLimitsTest } from '../gateway/meta-object-limits.js'

const A = LEGACY_WORKSPACE_ID
const TIMEOUT = 60_000
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>) => withWorkspace(business(A), work)
const db = () => database.client
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids: Record<string, string> = {}
let nameA = ''

function claude(): McpPrincipal {
  return {
    kind: 'user', userId: ids.person, label: 'Mia Meta', permissions: { isOwner: false, permissions: EVERYTHING },
    workspace: business(A), business: { id: A, name: nameA }, via: 'claude', oauthGrantId: 'grant-meta-plan', scopes: ['nexus.read', 'nexus.write', 'nexus.run'],
  } as McpPrincipal
}
const person = (): UserPrincipal => ({ kind: 'user', userId: ids.person, label: 'Mia Meta', permissions: { isOwner: false, permissions: EVERYTHING }, workspace: business(A), via: 'app' })
async function call(tool: string, args: Record<string, unknown>) {
  const result = await runToolForClaude(claude(), getTool(tool)!, { ...args, business: nameA })
  return { isError: !!result.isError, answer: JSON.parse((result.content as Array<{ text: string }>).map((b) => b.text).join('')) }
}
async function approveAndCommit(approvalId: string) {
  const parked = await inside(() => decideFleetApproval({ id: approvalId, decision: 'approve', actor: person() }))
  expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId))
}

const LOSER = { kind: 'adset', id: '120000000000011', name: 'Cell A (loser)', adAccountId: '1234567890', status: 'ACTIVE', effectiveStatus: 'ACTIVE', objective: null, smartPromotionType: null, endTime: null, campaign: { id: '120000000000010', name: 'Test campaign', status: 'ACTIVE', effectiveStatus: 'ACTIVE' }, adSet: null }
const WINNER = { ...LOSER, id: '120000000000012', name: 'Cell B (winner)', status: 'PAUSED', effectiveStatus: 'PAUSED' }
/** Meta makes it and reads it back as asked; the stand-in's live state follows. */
const makes = () => h.send.mockImplementation(async (_target: unknown, change: { objectId: string; kind: string; params: { status: string } }) => {
  const key = `${change.kind}:${change.objectId}`
  h.live.set(key, { ...h.live.get(key)!, status: change.params.status, effectiveStatus: change.params.status })
  return { node: { id: change.objectId, status: change.params.status, effective_status: change.params.status }, readBack: 'same-request', waitedMs: 0 }
})
const pause = (o: typeof LOSER) => ({ tool: 'set-meta-status', args: { items: [{ kind: 'adset', id: o.id, status: 'PAUSED' }], why: 'the study found the other cell better' } })
const switchOn = (o: typeof LOSER) => ({ tool: 'set-meta-status', args: { items: [{ kind: 'adset', id: o.id, status: 'ACTIVE' }], why: 'the winning cell' } })

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  vi.stubEnv('ENABLE_QUEUE_WORKERS', '')
  const client = database.client
  const role = await client.role.create({ data: { key: `META_PLAN_${randomUUID().slice(0, 8)}`, name: 'Meta plan tester', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  const p = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Mia Meta' } })
  ids.person = p.id
  await client.userRole.create({ data: { userId: p.id, roleId: role.id } })
  nameA = (await client.workspace.findUniqueOrThrow({ where: { id: A } })).name
  const membership = await client.workspaceMembership.create({ data: { workspaceId: A, userId: p.id, status: 'active' } })
  await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
}, 180_000)

beforeEach(async () => {
  __metaObjectLimitsTest.useMemory()
  h.check.mockReset(); h.check.mockImplementation(async () => undefined)
  h.send.mockReset()
  h.live = new Map([[`adset:${LOSER.id}`, structuredClone(LOSER)], [`adset:${WINNER.id}`, structuredClone(WINNER)]])
  await inside(async () => {
    await db().agentTool.deleteMany({})
    await db().agentAutonomy.deleteMany({})
  })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('Meta step 44 — every Meta change tool is a step a change plan can run', () => {
  it('a change with an execute (not a read, a control tool or a journal), re-checked by basis, plan and reach', () => {
    const meta = listTools().filter((t) => t.category === 'advertising' && /(^|-)meta-/.test(t.name) && !t.readOnly)
    expect(meta.length).toBeGreaterThan(30)
    const problems = meta.flatMap((t) => [
      ...(!t.execute ? [`${t.name}: no execute`] : []),
      ...(t.control ? [`${t.name}: a control tool`] : []),
      ...(t.journal ? [`${t.name}: a journal tool`] : []),
      ...(JSON.stringify(MATERIAL_PREVIEW_FIELDS[t.name]) !== JSON.stringify(['basis', 'plan', 'reach']) ? [`${t.name}: not re-checked by basis, plan and reach`] : []),
    ])
    expect(problems).toEqual([])
  })
})

describe('Meta step 44 — act on the winner in ONE plan (EX-029)', { timeout: TIMEOUT }, () => {
  it('both steps dry-run as the person; one approval; the switch-on SPENDS MONEY in its own preview; nothing sent yet', async () => {
    const { isError, answer } = await call('submit-change-plan', { title: 'Keep the winning cell', steps: [pause(LOSER), switchOn(WINNER)] })
    expect(isError, JSON.stringify(answer)).toBe(false)
    expect(answer).toMatchObject({ status: 'waiting_for_approval', approvalId: expect.any(String), plan: { steps: 2, summary: expect.stringMatching(/2 changes: 2 × Pause, switch on or archive Meta ads\. All reach a marketplace or a buyer\./) } })
    expect(answer.preview.steps[0]).toMatchObject({ step: 1, tool: 'set-meta-status', preview: { spendsMoney: false } })
    expect(answer.preview.steps[1]).toMatchObject({ step: 2, tool: 'set-meta-status', preview: { spendsMoney: true, warnings: expect.arrayContaining([expect.stringMatching(/^SPENDS MONEY \(your decision\): /)]) } })
    expect(h.send).not.toHaveBeenCalled()
    ids.plan = answer.approvalId
  })

  it('approved once: each step runs as the approver, in order, with its own record; undo is ONE plan of the inverse steps in reverse order', async () => {
    makes()
    expect(await approveAndCommit(ids.plan)).toMatchObject({ ok: true, status: 'executing' })
    expect(await inside(() => runPlan(ids.plan))).toMatchObject({ finished: true, counts: { done: 2 } })
    expect(h.send.mock.calls.map((c) => [c[1].objectId, c[1].params.status])).toEqual([[LOSER.id, 'PAUSED'], [WINNER.id, 'ACTIVE']])
    const steps = await inside(() => db().agentPlanStep.findMany({ where: { approvalId: ids.plan }, orderBy: { position: 'asc' } }))
    const changes = await inside(() => db().agentChange.findMany({ where: { approvalId: ids.plan }, orderBy: { executedAt: 'asc' } }))
    expect(changes.map((c) => [c.planStepId, c.toolName, c.executedByUserId, c.outbound])).toEqual(steps.map((s) => [s.id, 'set-meta-status', ids.person, true]))
    expect(changes[1].after).toMatchObject({ items: [{ kind: 'adset', id: WINNER.id, status: 'ACTIVE' }], adAccountId: '1234567890' })

    const { isError, answer } = await call('undo-change', { approvalId: ids.plan })
    expect(isError, JSON.stringify(answer)).toBe(false)
    expect(answer).toMatchObject({ status: 'waiting_for_approval', plan: { steps: 2 } })
    const undoSteps = await inside(() => db().agentPlanStep.findMany({ where: { approvalId: answer.approvalId }, orderBy: { position: 'asc' } }))
    expect(undoSteps.map((s) => [s.toolName, (s.args as { items: Array<{ id: string; status: string }> }).items.map((i) => `${i.id}:${i.status}`)])).toEqual([
      ['set-meta-status', [`${WINNER.id}:PAUSED`]],
      ['set-meta-status', [`${LOSER.id}:ACTIVE`]],
    ])
  })

  it('a step Meta would refuse refuses the whole plan: nothing stored, the step\'s refusal comes back', async () => {
    const campaignPause = { tool: 'set-meta-status', args: { items: [{ kind: 'campaign', id: '120000000000010', status: 'PAUSED' }] } }
    h.live.set('campaign:120000000000010', { kind: 'campaign', id: '120000000000010', name: 'Test campaign', adAccountId: '1234567890', status: 'ACTIVE', effectiveStatus: 'ACTIVE', objective: 'OUTCOME_SALES', smartPromotionType: null, endTime: null, campaign: null, adSet: null })
    h.check.mockImplementationOnce(async () => { throw new MetaWriteError(localFailure('Meta refused it (100): Invalid parameter. Nothing was changed.', 'X'), 'c', 'refused') })
    const before = await inside(() => db().agentApproval.count({ where: { toolName: 'submit-change-plan' } }))
    const { isError, answer } = await call('submit-change-plan', { title: 'Stop it', steps: [pause(LOSER), campaignPause] })
    expect(isError).toBe(true)
    expect(answer.refusals).toEqual([{ step: 2, tool: 'set-meta-status', error: expect.stringMatching(/^Meta would refuse step 1 .*Invalid parameter.*Nothing was queued\.$/) }])
    expect(await inside(() => db().agentApproval.count({ where: { toolName: 'submit-change-plan' } }))).toBe(before)
  })
})

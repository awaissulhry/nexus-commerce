/**
 * THE OWNER'S CODE RULE A (2026-10-07) — which ads requests a person approves only with their authenticator code.
 *
 *   table       every door the rule names, code yes or no, pinned line by line: a change of the rule is deliberate
 *   big doors   the two this rule added through the REAL approve path (the Approvals inbox's own approve,
 *               decideFleetApproval, then the commit after the undo window): set-campaign-live-writes on, and
 *               restore-campaign of a campaign born at the floor (the builders' go-live) — without the code mfa_required
 *               and nothing changes; with it, it runs. The other big doors keep their own real-path tests
 *               (ads-ad-groups: startLive, op start, add-product-ads; ads-status: enable-ads; set-ads-strategy;
 *               set-ads-playbook; e2e-autonomy-run: apply-ads-playbook start).
 *   day-to-day  a restore after a later stop, an allowlist taken off and a negative retired: a plain approve runs them
 *               (each day-to-day tool's own file proves its raises are listed and said)
 *   flipped     a line of the table flipped (__codeRuleTest) changes the card AND the run: the allowlist without the
 *               code runs on a plain approve; a retire with the code needs it (each door's own file flips its line too)
 *   plan        a big door as a step of a change plan: the plan carries its stepUp; no code mfa_required, with it it runs
 *   confirm     a big door set to confirm in Claude: the person who asked confirms it with confirm-change and their code
 *
 * PGlite, production schema; the job queue a stub. Made-up ids, names and values (public repo).
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
import { runPlan } from '../change-plan.service.js'
import { setClaudeRule } from '../claude-trust.service.js'
import { getTool } from '../tool-registry.js'
import { runToolForClaude } from '../../mcp/mcp-tool-call.js'
import type { McpPrincipal } from '../../mcp/mcp-auth.js'
import { __stepUpTest } from '../../../lib/auth/step-up.js'
import { __codeRuleTest, CODE_RULE, needsCode, type CodeDoor } from './ads-code-rule.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client as any
const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
const people = { asker: '', approver: '', secret: '', askerSecret: '', business: '' }
const principal = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId.slice(0, 6)}`, via, workspace: business, permissions: { isOwner: false, permissions: EVERYTHING },
})
type Row = Record<string, any>

async function ask(tool: string, args: Record<string, unknown>): Promise<Row> {
  return inside(async () => {
    const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: people.asker } })
    return runOrQueueTool(tool, args, principal(people.asker, 'claude'), run.id, { forceAsk: true })
  }) as Promise<Row>
}
const preview = async (tool: string, args: Record<string, unknown>) => (await inside(() => callTool(principal(people.asker, 'claude'), tool, args))).raw as Row
/** The Approvals inbox's approve, as the route calls it: the approver, and their code when given. */
const approve = (id: string, code?: string) => inside(() => decideFleetApproval({ id, decision: 'approve', actor: principal(people.approver, 'app'), ...(code ? { code } : {}) })) as Promise<Row>
async function commit(id: string): Promise<Row> {
  await inside(() => db().agentApproval.update({ where: { id }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(id)) as Promise<Row>
}
const code = () => { __stepUpTest.reset(); return generateSync({ secret: people.secret }) }
const askerCode = () => { __stepUpTest.reset(); return generateSync({ secret: people.askerSecret }) }
/** The person who asked, through Claude's own door (as the MCP route calls it). */
const viaClaude = (): McpPrincipal => ({
  ...principal(people.asker, 'claude'), business: { id: LEGACY_WORKSPACE_ID, name: people.business }, scopes: ['nexus.read', 'nexus.write', 'nexus.run'], oauthGrantId: 'grant-code-rule',
} as McpPrincipal)
async function claudeCall(tool: string, args: Record<string, unknown>): Promise<Row> {
  const result = await inside(() => runToolForClaude(viaClaude(), getTool(tool)!, { ...args, business: people.business }))
  return JSON.parse((result.content as Array<{ text: string }>).map((b) => b.text).join(''))
}
const campaignRow = (id: string) => inside(() => db().campaign.findUniqueOrThrow({ where: { id } })) as Promise<Row>
const bidOf = async (id: string) => (await inside(() => db().adTarget.findUniqueOrThrow({ where: { id } }))).bidCents as number

/** A campaign as a builder leaves it — or, `stoppedLater`, one made two days ago and stopped with low bids today. */
async function flooredCampaign(id: string, opts: { stoppedLater?: boolean } = {}) {
  const c = database.client as any
  const madeAt = opts.stoppedLater ? new Date(Date.now() - 2 * 86_400_000) : new Date()
  await c.campaign.create({
    data: {
      id, name: `Test ${id}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: '10.00',
      startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: false, createdAt: madeAt,
      bidsSuppressedAt: new Date(), bidsSuppressedBy: `user:${people.asker}`, bidsSuppressedFloorCents: 2,
    },
  })
  await c.adGroup.create({ data: { id: `g-${id}`, campaignId: id, name: `group ${id}`, externalAdGroupId: `EXT-g-${id}`, defaultBidCents: 2, suppressedFromBidCents: 40 } })
  await c.adTarget.create({ data: { id: `t-${id}`, adGroupId: `g-${id}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `test term ${id}`, bidCents: 2, suppressedFromBidCents: 60, externalTargetId: `EXT-t-${id}` } })
  // As create-ad-campaign records it: the campaign a Claude request made.
  const run = await c.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done' } })
  const made = await c.agentApproval.create({ data: { agentRunId: run.id, toolName: 'create-ad-campaign', riskTier: 'high', args: {}, status: 'executed', decidedAt: madeAt } })
  await c.agentChange.create({ data: { approvalId: made.id, toolName: 'create-ad-campaign', via: 'claude', reversibility: 'none', executedAt: madeAt, before: { campaignId: null }, after: { campaignId: id, name: `Test ${id}`, market: 'IT' } } })
}

beforeAll(async () => {
  database = await formulaDatabase()
  const c = database.client as any
  people.secret = generateSecret()
  people.askerSecret = generateSecret()
  people.asker = (await c.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Test Asker', twoFactorEnabledAt: new Date(), twoFactorSecret: people.askerSecret } })).id
  people.approver = (await c.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Test Approver', twoFactorEnabledAt: new Date(), twoFactorSecret: people.secret } })).id
  // The approver holds every permission in this business (the commit checks the decider's access again).
  const role = await c.role.create({ data: { key: `CRA_${randomUUID().slice(0, 8)}`, name: 'Code rule approver', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  await c.userRole.create({ data: { userId: people.approver, roleId: role.id } })
  const membership = await c.workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId: people.approver, status: 'active' } })
  await c.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  // The person who asked holds every permission too (confirm-change: only they confirm, with their own code).
  await c.userRole.create({ data: { userId: people.asker, roleId: role.id } })
  const askerMembership = await c.workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId: people.asker, status: 'active' } })
  await c.workspaceMemberRole.create({ data: { membershipId: askerMembership.id, roleId: role.id } })
  people.business = (await c.workspace.findUniqueOrThrow({ where: { id: LEGACY_WORKSPACE_ID } })).name
  await inside(async () => {
    await seedAdsFixture(c)
    await flooredCampaign('c-born')
    await flooredCampaign('c-stopped', { stoppedLater: true })
    // Two more campaigns off the allowlist: one for a change plan, one confirmed in Claude.
    for (const id of ['c-door-plan', 'c-door-confirm']) {
      await c.campaign.create({ data: { id, name: `Test ${id}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: false } })
    }
    await c.adTarget.create({ data: { id: 't-neg-2', adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'test free two', bidCents: 0, isNegative: true, negativeLevel: 'AD_GROUP', externalTargetId: 'EXT-t-neg-2' } })
  })
}, 180_000)
beforeEach(() => { __stepUpTest.reset(); __codeRuleTest.reset() })
afterAll(async () => { await database?.close() }, 30_000)

describe('the Owner\'s code rule A — the table', () => {
  it('every door, code yes or no, pinned: a change of the rule is one line there and one line here', () => {
    expect(CODE_RULE).toEqual({
      // Big doors: the approver's code.
      'create-ad-group: startLive': true,
      'set-ad-group: op start': true,
      'add-product-ads': true,
      'set-campaign-live-writes: on': true,
      'restore-campaign: born at the floor': true,
      'apply-ads-playbook: start': true,
      'apply-ads-playbook: a phase switch that raises': true,
      'set-ads-playbook: adds spend': true,
      'set-ads-strategy: a raise': true,
      'enable-ads: includePeoplesPauses': true,
      // Day-to-day: listed in raises, said in the effect, warned past his own limits, a normal approval.
      'set-hourly-bid-plan': false,
      'set-portfolio': false,
      'set-campaign-settings': false,
      'add-ad-targets: at a bid': false,
      'retire-negatives': false,
      'harvest-search-term': false,
      'set-monthly-ad-budget': false,
      'set-budget-schedule': false,
      'set-budget-pool': false,
      'restore-budget-baselines': false,
      'assign-ad-rules: a rule at Auto': false,
      'set-coverage-set': false,
      'run-ad-engine-now': false,
    })
    for (const door of Object.keys(CODE_RULE) as CodeDoor[]) expect(needsCode(door), door).toBe(CODE_RULE[door])
  })
})

describe('the Owner\'s code rule A — the big doors it added, through the Approvals inbox', () => {
  it('set-campaign-live-writes on: without the code mfa_required and nothing changes; with it, it runs at commit', async () => {
    const asked = await ask('set-campaign-live-writes', { campaignId: 'c-off', enabled: true })
    expect(asked).toMatchObject({ ok: true, mode: 'queued' })
    const stored = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: asked.approvalId } }))
    expect(stored.preview).toMatchObject({ liveWrites: { from: false, to: true }, stepUp: { raises: ['Live writes'] } })
    expect(await approve(asked.approvalId)).toMatchObject({ ok: false, code: 'mfa_required', raises: ['Live writes'] })
    expect((await campaignRow('c-off')).liveBidWritesEnabled).toBe(false)
    expect(await approve(asked.approvalId, code())).toMatchObject({ ok: true, status: 'scheduled' })
    const done = await commit(asked.approvalId)
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true, status: 'executed' })
    expect((await campaignRow('c-off')).liveBidWritesEnabled).toBe(true)
  })

  it('set-campaign-live-writes off: a brake — no code, a plain approve runs it', async () => {
    const asked = await ask('set-campaign-live-writes', { campaignId: 'c-off', enabled: false })
    const stored = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: asked.approvalId } }))
    expect(stored.preview.stepUp).toBeUndefined()
    expect(await approve(asked.approvalId)).toMatchObject({ ok: true, status: 'scheduled' })
    expect(await commit(asked.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect((await campaignRow('c-off')).liveBidWritesEnabled).toBe(false)
  })

  it('restore-campaign of a campaign born at the floor (the builders\' go-live): without the code mfa_required; with it, its planned bids come back', async () => {
    const p = await preview('restore-campaign', { campaignId: 'c-born' })
    expect(p.preview).toMatchObject({
      bornAtFloor: { since: expect.any(String) },
      stepUp: { what: 'gives Test c-born, born at the floor, its planned bids (a new campaign starts spending)', raises: ['Bids', 'Spend'] },
      effect: expect.stringMatching(/It was born at the floor and has not spent at its planned bids yet: a new campaign starts spending, so approving it needs the approver's authenticator code\.$/),
    })
    const asked = await ask('restore-campaign', { campaignId: 'c-born' })
    expect(await approve(asked.approvalId)).toMatchObject({ ok: false, code: 'mfa_required', raises: ['Bids', 'Spend'] })
    expect(await bidOf('t-c-born')).toBe(2)
    expect(await approve(asked.approvalId, code())).toMatchObject({ ok: true, status: 'scheduled' })
    const done = await commit(asked.approvalId)
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true, status: 'executed' })
    expect(await bidOf('t-c-born')).toBe(60)
    expect((await campaignRow('c-born')).bidsSuppressedAt).toBeNull()
  })

  it('a request approved before the rule, without the code, is refused at execute: ask for it again', async () => {
    // As an approval stored before the rule: a plain approve recorded, and the fresh dry run now asks for the code.
    await inside(async () => {
      await db().campaign.update({ where: { id: 'c-off' }, data: { liveBidWritesEnabled: false } })
    })
    const asked = await ask('set-campaign-live-writes', { campaignId: 'c-off', enabled: true })
    const { stepUp: _before, ...older } = (await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: asked.approvalId } }))).preview as Row
    expect(_before).toBeTruthy()
    await inside(() => db().agentApproval.update({ where: { id: asked.approvalId }, data: { preview: older } }))
    const stored = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: asked.approvalId } }))
    expect(stored.preview.stepUp).toBeUndefined()
    expect(await approve(asked.approvalId)).toMatchObject({ ok: true, status: 'scheduled' })
    const refused = await commit(asked.approvalId)
    expect(refused).toMatchObject({ ok: false })
    expect(String(refused.error)).toMatch(/and that runs only when a person with settings\.security\.manage approved it with their authenticator code .*Ask for it again/)
    expect((await campaignRow('c-off')).liveBidWritesEnabled).toBe(false)
  })
})

describe('the Owner\'s code rule A — day-to-day: a plain approve', () => {
  it('a restore after a later stop (a person\'s low bids, not the birth floor): no code, a plain approve runs it', async () => {
    const p = await preview('restore-campaign', { campaignId: 'c-stopped' })
    expect(p.preview).not.toHaveProperty('stepUp')
    expect(p.preview).not.toHaveProperty('bornAtFloor')
    const asked = await ask('restore-campaign', { campaignId: 'c-stopped' })
    expect(await approve(asked.approvalId)).toMatchObject({ ok: true, status: 'scheduled' })
    expect(await commit(asked.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await bidOf('t-c-stopped')).toBe(60)
  })

  it('a negative retired at Amazon: listed in raises and said in the effect, no code; a plain approve runs it', async () => {
    await inside(() => db().adTarget.update({ where: { id: 't-neg' }, data: { externalTargetId: 'EXT-t-neg' } }))
    const p = await preview('retire-negatives', { negativeIds: ['t-neg'] })
    expect(p.preview).toMatchObject({ raises: [expect.stringMatching(/^negative exact "free"/)], noCode: expect.stringMatching(/day-to-day/), effect: expect.stringMatching(/so spend can rise \(a day-to-day change/) })
    expect(p.preview).not.toHaveProperty('stepUp')
    const asked = await ask('retire-negatives', { negativeIds: ['t-neg'] })
    expect(await approve(asked.approvalId)).toMatchObject({ ok: true, status: 'scheduled' })
    expect(await commit(asked.approvalId)).toMatchObject({ ok: true, status: 'executed' })
  })
})

describe('the Owner\'s code rule A — a flipped line changes the card and the run', () => {
  it('the allowlist with its line off: no stepUp, and a plain approve runs it', async () => {
    await inside(() => db().campaign.update({ where: { id: 'c-off' }, data: { liveBidWritesEnabled: false } }))
    __codeRuleTest.flip('set-campaign-live-writes: on')
    expect(needsCode('set-campaign-live-writes: on')).toBe(false)
    const asked = await ask('set-campaign-live-writes', { campaignId: 'c-off', enabled: true })
    const stored = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: asked.approvalId } }))
    expect(stored.preview.stepUp).toBeUndefined()
    expect(await approve(asked.approvalId)).toMatchObject({ ok: true, status: 'scheduled' })
    expect(await commit(asked.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect((await campaignRow('c-off')).liveBidWritesEnabled).toBe(true)
  })

  it('a retire with its line on: stepUp, no code mfa_required, with the code it runs', async () => {
    __codeRuleTest.flip('retire-negatives')
    const p = await preview('retire-negatives', { negativeIds: ['t-neg-2'] })
    expect(p.preview).toMatchObject({ stepUp: { raises: ['Spend'] }, effect: expect.stringMatching(/so spend can rise: approving it needs the approver's authenticator code/) })
    const asked = await ask('retire-negatives', { negativeIds: ['t-neg-2'] })
    expect(await approve(asked.approvalId)).toMatchObject({ ok: false, code: 'mfa_required' })
    expect(await approve(asked.approvalId, code())).toMatchObject({ ok: true, status: 'scheduled' })
    expect(await commit(asked.approvalId)).toMatchObject({ ok: true, status: 'executed' })
  })
})

describe('the Owner\'s code rule A — a big door in a change plan, and confirmed in Claude', () => {
  it('a change plan with the allowlist on as a step carries its stepUp: without the code mfa_required; with it the step runs', async () => {
    const asked = await ask('submit-change-plan', { title: 'Test go live', steps: [{ tool: 'set-campaign-live-writes', args: { campaignId: 'c-door-plan', enabled: true } }] })
    expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true, mode: 'queued' })
    const stored = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: asked.approvalId } }))
    expect(stored.preview).toMatchObject({ stepUp: { raises: ['Live writes'], steps: [1] } })
    expect(await approve(asked.approvalId)).toMatchObject({ ok: false, code: 'mfa_required' })
    expect((await campaignRow('c-door-plan')).liveBidWritesEnabled).toBe(false)
    expect(await approve(asked.approvalId, code())).toMatchObject({ ok: true, status: 'scheduled' })
    expect(await commit(asked.approvalId)).toMatchObject({ ok: true, status: 'executing' })
    expect(await inside(() => runPlan(asked.approvalId))).toMatchObject({ finished: true, counts: { done: 1 } })
    expect((await campaignRow('c-door-plan')).liveBidWritesEnabled).toBe(true)
  })

  it('set to confirm in Claude: the person who asked confirms the allowlist on with confirm-change and their own code', async () => {
    const asker = { userId: people.asker, label: 'Test Asker', canManage: true }
    vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
    vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
    expect(await inside(() => setClaudeRule(asker, 'set-campaign-live-writes', { level: 'confirm', code: askerCode() }))).toMatchObject({ ok: true })
    try {
      const answer = await claudeCall('set-campaign-live-writes', { campaignId: 'c-door-confirm', enabled: true })
      expect(answer, JSON.stringify(answer)).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'confirm' }, confirm: { planHash: expect.any(String) } })
      const stored = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: answer.approvalId } }))
      expect(stored.preview).toMatchObject({ stepUp: { raises: ['Live writes'] } })
      const confirmed = await claudeCall('confirm-change', { approvalId: answer.approvalId, planHash: answer.confirm.planHash, code: askerCode() })
      expect(confirmed, JSON.stringify(confirmed)).toMatchObject({ status: 'confirmed', approvalId: answer.approvalId })
      expect(await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: answer.approvalId } }))).toMatchObject({ status: 'scheduled', decisionVia: 'claude-confirm' })
      expect(await commit(answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
      expect((await campaignRow('c-door-confirm')).liveBidWritesEnabled).toBe(true)
    } finally {
      __stepUpTest.reset()
      await inside(() => setClaudeRule(asker, 'set-campaign-live-writes', { level: 'ask' }))
      vi.unstubAllEnvs()
    }
  })
})

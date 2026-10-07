/**
 * ADS AUTONOMY W1-3 — set-ads-strategy through Claude's door, the Approvals routes, change plans, the bulk approve and
 * undo, on PGlite with the production schema and policies; real TOTP codes through the existing step-up verifier.
 * Values are made up (public repo).
 *
 *   lower     waits for a person at ask; a plain approve runs it; the version says via claude, the approval, the
 *             approver, no code; the change is recorded for undo
 *   raise     approving it needs settings.security.manage and the approver's fresh code (403 mfa_required naming the
 *             raises, 400 a wrong code, 403 without the permission); with them: decisionVia nexus-step-up, it runs, and
 *             the version keeps when the code was typed. Approved any other way, `execute` refuses it.
 *   rule      at auto a lowering runs by rule; a raise never does, and Claude is told why; allowLower off sends lowerings
 *             to a person too
 *   confirm   at confirm the person who asked approves a raise with their own code in Claude (claude-confirm)
 *   plan      a step that raises makes the plan one approved with the code; it runs step by step
 *   bulk      a raise is left out of a bulk approve, with why; a lowering beside it is approved
 *   undo      the undo of a lowering is a raise: it needs the code, and puts the row back
 *   recheck   an approver who lost settings.security.manage before it ran: not run
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { __codeRuleTest } from './ads-code-rule.js'
import { strategyCodeOf } from './ads-strategy.tools.js'
import Fastify, { type FastifyInstance } from 'fastify'
import { generateSecret, generateSync } from 'otplib'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, agentPlanQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true, workersOff: true })),
}))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../../pim/readiness-index.service.js', async () => (await import('../../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import { resolvePermissions } from '../../../lib/auth/rbac.js'
import { __stepUpTest } from '../../../lib/auth/step-up.js'
import { commitScheduledApproval, scheduleApproval } from '../../agent-fleet/approval-inbox.service.js'
import { queueDetail } from '../../agent-fleet/approval-queue.service.js'
import type { McpPrincipal } from '../../mcp/mcp-auth.js'
import { runToolForClaude } from '../../mcp/mcp-tool-call.js'
import { createWorkspaceService } from '../../workspace.service.js'
import type { UserPrincipal } from '../call-tool.js'
import { runPlan } from '../change-plan.service.js'
import { undoChangeByClick } from '../change-undo.service.js'
import { setClaudeRule } from '../claude-trust.service.js'
import { getTool } from '../tool-registry.js'
import agentFleetRoutes from '../../../routes/agent-fleet.routes.js'

const A = LEGACY_WORKSPACE_ID
const TIMEOUT = 30_000
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client
const EVERYTHING = [...Object.values(F), ...Object.values(FIELDS)] as string[]
type Who = 'owner' | 'manager' | 'approver'
const people: Record<Who, { id: string; secret: string; label: string; roleId: string }> = {} as never
const ids: Record<string, string> = {}
let nameA = ''
let app: FastifyInstance
let signedIn = ''

type Json = Record<string, any>

async function person(who: Who, label: string, permissions: string[]) {
  const c = database.client
  const role = await c.role.create({ data: { key: `W13_${randomUUID().slice(0, 8)}`, name: label, description: 'test', isSystem: false, permissions } })
  const secret = generateSecret()
  const user = await c.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: label, twoFactorEnabledAt: new Date(), twoFactorSecret: secret } })
  await c.userRole.create({ data: { userId: user.id, roleId: role.id } })
  const membership = await c.workspaceMembership.create({ data: { workspaceId: A, userId: user.id, status: 'active' } })
  await c.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  people[who] = { id: user.id, secret, label, roleId: role.id }
}

const codeOf = (who: Who = 'owner') => generateSync({ secret: people[who].secret })
function claude(who: Who = 'owner', scopes = ['nexus.read', 'nexus.write', 'nexus.run']): McpPrincipal {
  return {
    kind: 'user', userId: people[who].id, label: people[who].label, permissions: { isOwner: false, permissions: new Set(EVERYTHING) },
    workspace: business, business: { id: A, name: nameA }, via: 'claude', oauthGrantId: `grant-${who}`, scopes,
  } as McpPrincipal
}
const viewer = (who: Who, permissions: string[]): UserPrincipal => ({ kind: 'user', userId: people[who].id, label: people[who].label, permissions: { isOwner: false, permissions: new Set(permissions) }, workspace: business, via: 'app' })

async function call(tool: string, args: Record<string, unknown>, who = claude()) {
  const result = await runToolForClaude(who, getTool(tool)!, { ...args, business: nameA })
  return { isError: !!result.isError, answer: JSON.parse((result.content as Array<{ text: string }>).map((b) => b.text).join('')) as Json }
}
const strategy = (values: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  call('set-ads-strategy', { channel: 'AMAZON', market: 'IT', level: 'market', values, ...extra })
const approvalOf = (id: string) => inside(() => db().agentApproval.findUniqueOrThrow({ where: { id } }))
const marketRow = () => inside(() => db().adsStrategy.findFirstOrThrow({ where: { market: 'IT', level: 'MARKET' } }))
const versionOf = (approvalId: string) => inside(() => db().adsStrategyVersion.findFirstOrThrow({ where: { approvalId } }))
const decide = (who: Who, id: string, payload: Record<string, unknown>) => {
  signedIn = people[who].id
  return app.inject({ method: 'POST', url: `/agent/fleet/approvals/${id}/decide`, payload: { decision: 'approve', ...payload } })
}
async function commit(id: string) {
  await inside(() => db().agentApproval.update({ where: { id }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(id))
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  vi.stubEnv('ENABLE_QUEUE_WORKERS', '')
  await person('owner', 'Olga Owner', EVERYTHING)
  await person('manager', 'Max Manager', EVERYTHING.filter((p) => p !== F.settingsSecurityManage))
  await person('approver', 'Ada Approver', EVERYTHING)
  nameA = (await database.client.workspace.findUniqueOrThrow({ where: { id: A } })).name
  await inside(async () => {
    const c = db()
    await c.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'IT market', maxBidCents: 150, targetKind: 'ACOS', targetPct: 30, updatedBy: 'user:test' } })
    ids.cat = (await c.category.create({ data: { slug: 'w13-tool-cat', name: { en: { name: 'Test helmets' } } } })).id
    await c.categoryClosure.create({ data: { ancestorId: ids.cat, descendantId: ids.cat, depth: 0 } })
    ids.cat2 = (await c.category.create({ data: { slug: 'w13-tool-cat2', name: { en: { name: 'Test gloves' } } } })).id
    await c.categoryClosure.create({ data: { ancestorId: ids.cat2, descendantId: ids.cat2, depth: 0 } })
  })

  const c = database.client
  const workspaces = createWorkspaceService(c as never)
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    void (async () => {
      const user = await c.userProfile.findUniqueOrThrow({
        where: { id: signedIn },
        select: { id: true, email: true, displayName: true, status: true, permissionsVersion: true, roleAssignments: { select: { role: { select: { key: true } } } } },
      })
      const authUser = { ...user, roleKeys: user.roleAssignments.map((a) => a.role.key) }
      const r = request as unknown as Record<string, unknown>
      r.__sessionLoaded = true
      r.authUser = authUser
      if (process.env.NEXUS_WORKSPACES_ENABLED === '1') {
        const access = await workspaces.membership(user.id, A)
        r.__rbacResolved = { isOwner: access.isOwner, permissions: access.permissions }
        r.workspace = access.context
      } else {
        r.__rbacResolved = await resolvePermissions(authUser as never)
      }
      withWorkspace(business, done)
    })().catch(done)
  })
  await app.register(agentFleetRoutes)
  await app.ready()
}, 120_000)

beforeEach(() => __stepUpTest.reset())

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.close()
  await database?.close()
}, 30_000)

describe('W1-3 — a lowering', { timeout: TIMEOUT }, () => {
  it('waits for a person at ask; a plain approve runs it; the version names Claude, the approval and the approver', async () => {
    const { answer } = await strategy({ maxBidCents: 140 }, { reason: 'test: tighter ceiling' })
    expect(answer).toMatchObject({
      status: 'waiting_for_approval',
      preview: { action: 'set-ads-strategy', direction: 'lower', stepUp: null, version: { from: 1, to: 2 }, reachesAmazon: false },
      consequences: { reaches: 'Nexus only', reversibility: 'full' },
    })
    expect(answer.preview.changes).toEqual([expect.objectContaining({ field: 'maxBidCents', from: 150, to: 140, direction: 'lower' })])
    const decided = await decide('owner', answer.approvalId, {})
    expect(decided.statusCode, decided.body).toBe(200)
    expect(await approvalOf(answer.approvalId)).toMatchObject({ status: 'scheduled', decisionVia: 'nexus' })
    expect(await commit(answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await marketRow()).toMatchObject({ maxBidCents: 140, version: 2, updatedBy: `claude:${answer.approvalId}` })
    expect(await versionOf(answer.approvalId)).toMatchObject({ version: 2, direction: 'lower', via: 'claude', actor: 'Olga Owner', actorUserId: people.owner.id, stepUpAt: null, reason: 'test: tighter ceiling' })
    expect(await inside(() => db().agentChange.count({ where: { approvalId: answer.approvalId } }))).toBe(1)
  })
})

describe('W1-3 — a raise needs the approver’s fresh authenticator code', { timeout: TIMEOUT }, () => {
  it('no code: 403 naming the raises; no permission: 403; a wrong code: 400; nothing scheduled — with the code it runs', async () => {
    const { answer } = await strategy({ maxBidCents: 200 })
    expect(answer.preview).toMatchObject({ direction: 'raise', raises: ['Highest bid (cents)'], stepUp: { what: 'raises the ads strategy', raises: ['Highest bid (cents)'] } })
    expect(answer.next).toContain('Approvals page')

    // The Approvals queue says so, and tells a viewer who may not approve a raise why.
    const detail = await inside(() => queueDetail(answer.approvalId, viewer('owner', EVERYTHING)))
    expect(detail).toMatchObject({ needsCode: 'It raises the ads strategy (Highest bid (cents)): approving it needs your authenticator code.', canApprove: true, bulkApprovable: false })
    const forManager = await inside(() => queueDetail(answer.approvalId, viewer('manager', EVERYTHING.filter((p) => p !== F.settingsSecurityManage))))
    expect(forManager).toMatchObject({ canApprove: false, cannotApproveWhy: expect.stringContaining('settings.security.manage') })

    const noCode = await decide('owner', answer.approvalId, {})
    expect(noCode.statusCode).toBe(403)
    expect(noCode.json()).toMatchObject({ ok: false, code: 'mfa_required', raises: ['Highest bid (cents)'], error: 'Approving a change that raises the ads strategy needs the 6-digit code from your authenticator app.' })
    const noPermission = await decide('manager', answer.approvalId, { code: codeOf('manager') })
    expect(noPermission.statusCode).toBe(403)
    expect(noPermission.json()).toMatchObject({ code: 'forbidden', error: expect.stringContaining('settings.security.manage') })
    const wrong = await decide('owner', answer.approvalId, { code: '000000' })
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json()).toMatchObject({ code: 'mfa_invalid' })
    expect(await approvalOf(answer.approvalId)).toMatchObject({ status: 'pending', decisionVia: null })
    expect((await marketRow()).maxBidCents).toBe(140)

    const typedAt = Date.now()
    const coded = await decide('owner', answer.approvalId, { code: codeOf() })
    expect(coded.statusCode, coded.body).toBe(200)
    expect(await approvalOf(answer.approvalId)).toMatchObject({ status: 'scheduled', decisionVia: 'nexus-step-up' })
    expect(await commit(answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect((await marketRow()).maxBidCents).toBe(200)
    const version = await versionOf(answer.approvalId)
    expect(version).toMatchObject({ direction: 'raise', via: 'claude', actor: 'Olga Owner' })
    // When the code was typed (the decision's audit row), not when the change ran.
    expect(version.stepUpAt!.getTime()).toBeGreaterThanOrEqual(typedAt - 1000)
    expect(version.stepUpAt!.getTime()).toBeLessThanOrEqual(version.createdAt.getTime())
  })

  it('a raise approved any other way (no code) is never run: execute refuses it, nothing changes', async () => {
    const { answer } = await strategy({ maxBidCents: 260 })
    expect(answer.preview.direction).toBe('raise')
    const owner = viewer('owner', EVERYTHING)
    expect(await inside(() => scheduleApproval({ id: answer.approvalId, actor: owner, via: 'nexus' }))).toMatchObject({ ok: true })
    const out = await commit(answer.approvalId)
    expect(out).toMatchObject({ ok: false })
    expect(out.error).toContain('it raises the ads strategy, and that runs only when a person with settings.security.manage approved it with their authenticator code')
    expect((await marketRow()).maxBidCents).toBe(200)
    expect(await approvalOf(answer.approvalId)).toMatchObject({ status: 'pending' })
  })

  it('the code table decides it (ads-code-rule.ts): flipped, a raise asks no code and a plain approve runs it — never by rule, and more for Claude alone keeps the code', async () => {
    __codeRuleTest.flip('set-ads-strategy: a raise')
    try {
      const { answer } = await strategy({ maxBidCents: 280 })
      expect(answer.preview).toMatchObject({ direction: 'raise', stepUp: null, noCode: expect.stringMatching(/day-to-day/) })
      // Never by rule, whatever the table says.
      expect(getTool('set-ads-strategy')!.withinLimits!(answer.preview, { allowLower: true })).toMatch(/^it raises Highest bid \(cents\)/)
      expect(await inside(() => scheduleApproval({ id: answer.approvalId, actor: viewer('owner', EVERYTHING), via: 'nexus' }))).toMatchObject({ ok: true })
      expect(await commit(answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
      expect((await marketRow()).maxBidCents).toBe(280)
      expect(await versionOf(answer.approvalId)).toMatchObject({ direction: 'raise', stepUpAt: null, reason: expect.stringMatching(/without the authenticator code: the Owner's code rule/) })
      // More of what Claude may do alone keeps the code, whatever the table says (the Owner's own rule).
      const { noCode: _dayToDay, ...stored } = answer.preview
      const raisedAutonomy = { ...stored, changes: [...stored.changes, { field: 'claudeAutonomy', direction: 'raise' }], stepUp: { what: 'raises the ads strategy', raises: ['What Claude may do alone'], needs: 'x', how: 'y' } }
      expect(strategyCodeOf(raisedAutonomy as never)).toMatchObject({ stepUp: { what: 'raises the ads strategy' } })
      expect(strategyCodeOf(raisedAutonomy as never)).not.toHaveProperty('noCode')
    } finally { __codeRuleTest.reset() }
    // Put back as it was for the tests after this one.
    const back = await strategy({ maxBidCents: 200 })
    expect(await inside(() => scheduleApproval({ id: back.answer.approvalId, actor: viewer('owner', EVERYTHING), via: 'nexus' }))).toMatchObject({ ok: true })
    expect(await commit(back.answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect((await marketRow()).maxBidCents).toBe(200)
  })

  it('an approver who lost settings.security.manage before it ran: not run', async () => {
    const { answer } = await strategy({ maxBidCents: 230 })
    expect((await decide('approver', answer.approvalId, { code: codeOf('approver') })).statusCode).toBe(200)
    await database.client.role.update({ where: { id: people.approver.roleId }, data: { permissions: EVERYTHING.filter((p) => p !== F.settingsSecurityManage) } })
    await database.client.userProfile.update({ where: { id: people.approver.id }, data: { permissionsVersion: { increment: 1 } } })
    try {
      const out = await commit(answer.approvalId)
      expect(out).toMatchObject({ ok: false })
      expect(out.error).toContain('no longer holds settings.security.manage')
      expect((await marketRow()).maxBidCents).toBe(200)
    } finally {
      await database.client.role.update({ where: { id: people.approver.roleId }, data: { permissions: EVERYTHING } })
      await database.client.userProfile.update({ where: { id: people.approver.id }, data: { permissionsVersion: { increment: 1 } } })
    }
  })
})

describe('W1-3 — by rule, and confirmed in Claude', { timeout: TIMEOUT }, () => {
  const owner = () => ({ userId: people.owner.id, label: 'Olga Owner', canManage: true })

  it('at auto a lowering runs by rule; a raise never does, and Claude is told why; allowLower off sends lowerings to a person', async () => {
    expect(await inside(() => setClaudeRule(owner(), 'set-ads-strategy', { level: 'auto', code: codeOf() }))).toMatchObject({ ok: true })
    try {
      const lowered = await strategy({ maxBidCents: 190 })
      expect(lowered.answer, JSON.stringify(lowered.answer)).toMatchObject({ status: 'runs_by_rule', trust: { level: 'auto' } })
      expect(await approvalOf(lowered.answer.approvalId)).toMatchObject({ status: 'scheduled', decisionVia: 'auto' })
      expect(await commit(lowered.answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
      expect(await versionOf(lowered.answer.approvalId)).toMatchObject({ direction: 'lower', via: 'claude', stepUpAt: null })

      const raised = await strategy({ maxBidCents: 210 })
      expect(raised.answer).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'auto', why: expect.stringContaining('it raises Highest bid (cents): a person with settings.security.manage decides') } })

      // Tightening a limit is a brake: no code. Then every change waits for a person.
      expect(await inside(() => setClaudeRule(owner(), 'set-ads-strategy', { limits: { allowLower: false } }))).toMatchObject({ ok: true })
      const held = await strategy({ maxBidCents: 180 })
      expect(held.answer).toMatchObject({ status: 'waiting_for_approval', trust: { why: expect.stringContaining('a person decide every change of the ads strategy') } })
    } finally {
      // Back to ask, and the default limits (allowLower again loosens: the code, used once — so a fresh verifier state).
      __stepUpTest.reset()
      expect(await inside(() => setClaudeRule(owner(), 'set-ads-strategy', { level: 'ask', limits: null, code: codeOf() }))).toMatchObject({ ok: true })
    }
  })

  it('at confirm the person who asked approves a raise with their own code in Claude', async () => {
    expect(await inside(() => setClaudeRule(owner(), 'set-ads-strategy', { level: 'confirm', code: codeOf() }))).toMatchObject({ ok: true })
    __stepUpTest.reset()
    try {
      const { answer } = await strategy({ maxBidCents: 240 })
      expect(answer).toMatchObject({ status: 'waiting_for_approval', preview: { direction: 'raise' }, confirm: { planHash: expect.any(String) } })
      const out = await call('confirm-change', { approvalId: answer.approvalId, planHash: answer.confirm.planHash, code: codeOf() })
      expect(out.isError, JSON.stringify(out.answer)).toBe(false)
      expect(await approvalOf(answer.approvalId)).toMatchObject({ status: 'scheduled', decisionVia: 'claude-confirm' })
      expect(await commit(answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
      expect((await marketRow()).maxBidCents).toBe(240)
      expect((await versionOf(answer.approvalId)).stepUpAt).toBeInstanceOf(Date)
    } finally {
      expect(await inside(() => setClaudeRule(owner(), 'set-ads-strategy', { level: 'ask' }))).toMatchObject({ ok: true })
    }
  })
})

describe('W1-3 — plans, bulk and undo', { timeout: TIMEOUT }, () => {
  it('a plan with a step that raises is approved with the code and runs step by step', async () => {
    const { answer } = await call('submit-change-plan', {
      title: 'Test strategy plan',
      steps: [
        { tool: 'set-ads-strategy', args: { channel: 'AMAZON', market: 'IT', level: 'category', categoryId: ids.cat, values: { maxBidCents: 120 } } },
        { tool: 'set-ads-strategy', args: { channel: 'AMAZON', market: 'IT', level: 'category', categoryId: ids.cat2, values: { goal: 'LAUNCH' } } },
      ],
    })
    expect(answer, JSON.stringify(answer)).toMatchObject({ status: 'waiting_for_approval', plan: { steps: 2 }, preview: { stepUp: { what: 'raises the ads strategy', raises: ['Goal'], steps: [2] } } })
    expect((await approvalOf(answer.approvalId)).preview).toMatchObject({ stepUp: { raises: ['Goal'] } })
    expect((await decide('owner', answer.approvalId, {})).json()).toMatchObject({ code: 'mfa_required', raises: ['Goal'] })
    expect((await decide('owner', answer.approvalId, { code: codeOf() })).statusCode).toBe(200)
    expect(await commit(answer.approvalId)).toMatchObject({ ok: true, status: 'executing' })
    expect(await inside(() => runPlan(answer.approvalId))).toMatchObject({ finished: true, counts: { done: 2 } })
    const raised = await inside(() => db().adsStrategyVersion.findFirstOrThrow({ where: { approvalId: answer.approvalId, scopeId: ids.cat2 } }))
    expect(raised).toMatchObject({ direction: 'raise', via: 'claude' })
    expect(raised.stepUpAt).toBeInstanceOf(Date)
  })

  it('a bulk approve leaves a raise out, with why, and approves the lowering beside it', async () => {
    const lower = (await strategy({ maxChangePct: 25 })).answer
    const raise = (await strategy({ maxBidCents: 300 })).answer
    expect(lower.preview.direction).toBe('lower')
    expect(raise.preview.direction).toBe('raise')
    signedIn = people.owner.id
    const preview = await app.inject({ method: 'POST', url: '/agent/fleet/approvals/bulk-preview', payload: { ids: [lower.approvalId, raise.approvalId], decision: 'approve' } })
    expect(preview.json()).toMatchObject({ count: 1, blockedReason: null })
    expect(preview.json().sentence).toContain('1 is left out: it raises the ads strategy (Highest bid (cents)), so it is approved on its own, with your authenticator code.')
    const out = await app.inject({ method: 'POST', url: '/agent/fleet/approvals/bulk-decide', payload: { ids: [lower.approvalId, raise.approvalId], decision: 'approve' } })
    expect(out.json()).toMatchObject({ ok: true, done: 1, of: 2, skipped: [{ id: raise.approvalId, why: 'Not approved: it raises the ads strategy (Highest bid (cents)), so it is approved on its own, with your authenticator code.' }] })
    expect(await approvalOf(raise.approvalId)).toMatchObject({ status: 'pending' })
    expect(await approvalOf(lower.approvalId)).toMatchObject({ status: 'scheduled', decisionVia: 'nexus' })
  })

  it('the undo of a lowering is a raise: it needs the code, and puts the row back', async () => {
    const { answer } = await call('set-ads-strategy', { channel: 'AMAZON', market: 'IT', level: 'category', categoryId: ids.cat, values: { maxBidCents: 90 } })
    expect(answer.preview.direction).toBe('lower')
    expect((await decide('owner', answer.approvalId, {})).statusCode).toBe(200)
    expect(await commit(answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    const change = await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId: answer.approvalId } }))
    const undo = await call('undo-change', { changeId: change.id })
    expect(undo.answer, JSON.stringify(undo.answer)).toMatchObject({ status: 'waiting_for_approval', undoes: { changeId: change.id }, preview: { direction: 'raise', stepUp: { raises: ['Highest bid (cents)'] } } })
    expect((await decide('owner', undo.answer.approvalId, {})).statusCode).toBe(403)
    expect((await decide('owner', undo.answer.approvalId, { code: codeOf() })).statusCode).toBe(200)
    expect(await commit(undo.answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await inside(() => db().adsStrategy.findFirstOrThrow({ where: { level: 'CATEGORY', scopeId: ids.cat } }))).toMatchObject({ maxBidCents: 120 })
  })

  it("the Activity page's Undo click: without the code the raise waits in Approvals; with it, it is approved", async () => {
    const lowered = async (maxBidCents: number) => {
      const { answer } = await call('set-ads-strategy', { channel: 'AMAZON', market: 'IT', level: 'category', categoryId: ids.cat2, values: { maxBidCents } })
      expect((await decide('owner', answer.approvalId, {})).statusCode).toBe(200)
      expect(await commit(answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
      return (await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId: answer.approvalId } }))).id
    }
    const owner = viewer('owner', EVERYTHING)
    const first = await lowered(80)
    const refused = await inside(() => undoChangeByClick(owner, first))
    expect(refused).toMatchObject({ ok: false, status: 403, approvalId: expect.any(String), error: expect.stringContaining('authenticator app. The undo waits in the Approvals page.') })
    expect(await approvalOf((refused as { approvalId: string }).approvalId)).toMatchObject({ status: 'pending' })
    // That undo still waits; reject it, then a new lowering is undone with the code in one click.
    expect((await decide('owner', (refused as { approvalId: string }).approvalId, { decision: 'reject' })).statusCode).toBe(200)
    const second = await lowered(70)
    const done = await inside(() => undoChangeByClick(owner, second, codeOf()))
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true, tool: 'set-ads-strategy', undoes: second })
    expect(await approvalOf((done as { approvalId: string }).approvalId)).toMatchObject({ status: 'scheduled', decisionVia: 'nexus-step-up' })
  })
})

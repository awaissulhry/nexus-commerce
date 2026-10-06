/**
 * ADS PLAYBOOK PB-3 — set-ads-playbook through Claude's door, the Approvals routes, the bulk approve and undo, on PGlite
 * with the production schema and policies; real TOTP codes through the existing step-up verifier (the W1-3 scaffold).
 * Values are made up (public repo).
 *
 *   same      a change that adds no spend waits for a person at ask; a plain approve runs it; the version says via
 *             claude, the approval and the approver, no code; the change is recorded for undo
 *   raise     enrolling with a budget: approving it needs settings.security.manage and the approver's fresh code (403
 *             mfa_required naming the raises); with it: decisionVia nexus-step-up, it runs, the version keeps the code's
 *             time. Approved any other way, `execute` refuses it.
 *   rule      at auto a change that adds no spend runs by rule; a raise never does; a template change does only with
 *             allowTemplateEdit; a market outside `markets` waits
 *   bulk      a raise is left out of a bulk approve, with why
 *   undo      the undo of a lowering is a raise: it needs the code, and puts the row back
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { generateSecret, generateSync } from 'otplib'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { templateDoc } from '../../../test-support/ads-playbook-fixtures.js'
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
  const role = await c.role.create({ data: { key: `PB3_${randomUUID().slice(0, 8)}`, name: label, description: 'test', isSystem: false, permissions } })
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
const playbook = (args: Record<string, unknown>) => call('set-ads-playbook', { channel: 'AMAZON', kind: 'playbook', market: 'IT', ...args })
const productRow = (values: Record<string, unknown>, extra: Record<string, unknown> = {}) => playbook({ level: 'product', productId: ids.product, values, ...extra })
const approvalOf = (id: string) => inside(() => db().agentApproval.findUniqueOrThrow({ where: { id } }))
const rowOf = () => inside(() => db().adsPlaybook.findFirstOrThrow({ where: { market: 'IT', level: 'PRODUCT', scopeId: ids.product } }))
const versionOf = (approvalId: string) => inside(() => db().adsPlaybookVersion.findFirstOrThrow({ where: { approvalId } }))
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
    ids.product = (await c.product.create({ data: { sku: 'TEST-PB3-TOOL', name: 'Test jacket', basePrice: '10.00' } })).id
    ids.template = (await c.adsPlaybookTemplate.create({ data: { name: 'Test funnel', doc: templateDoc() as never, updatedBy: 'user:test' } })).id
    await c.adsPlaybook.create({ data: { market: 'IT', level: 'MARKET', label: 'Amazon IT', templateId: ids.template, updatedBy: 'user:test' } })
    await c.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'IT market', targetKind: 'ACOS', targetPct: 30, updatedBy: 'user:test' } })
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

describe('PB-3 — a change that adds no spend', { timeout: TIMEOUT }, () => {
  it('waits for a person at ask; a plain approve runs it; the version names Claude, the approval and the approver', async () => {
    const { answer } = await productRow({ nameToken: 'TESTTOOL' }, { reason: 'test: name token' })
    expect(answer, JSON.stringify(answer)).toMatchObject({
      status: 'waiting_for_approval',
      preview: { action: 'set-ads-playbook', direction: 'same', stepUp: null, version: { from: 0, to: 1 }, reachesAmazon: false },
      consequences: { reaches: 'Nexus only', reversibility: 'full' },
    })
    expect((await decide('owner', answer.approvalId, {})).statusCode).toBe(200)
    expect(await approvalOf(answer.approvalId)).toMatchObject({ status: 'scheduled', decisionVia: 'nexus' })
    expect(await commit(answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await rowOf()).toMatchObject({ nameToken: 'TESTTOOL', version: 1, updatedBy: `claude:${answer.approvalId}` })
    expect(await versionOf(answer.approvalId)).toMatchObject({ version: 1, direction: 'same', via: 'claude', actor: 'Olga Owner', actorUserId: people.owner.id, stepUpAt: null, reason: 'test: name token' })
    expect(await inside(() => db().agentChange.count({ where: { approvalId: answer.approvalId } }))).toBe(1)
  })
})

describe('PB-3 — a raise needs the approver\u2019s fresh authenticator code', { timeout: TIMEOUT }, () => {
  it('enrolling with a budget: no code 403 naming the raises; with the code it runs and the version keeps when the code was typed', async () => {
    const { answer } = await productRow({ dailyBudgetCents: 2000, baseBidCents: 40 }, { op: 'enroll' })
    expect(answer.preview).toMatchObject({ direction: 'raise', stepUp: { what: 'raises what an ads playbook may spend' } })
    expect(answer.preview.raises).toEqual(expect.arrayContaining(['Enrolled', 'Daily budget', 'Base bid']))
    const detail = await inside(() => queueDetail(answer.approvalId, viewer('owner', EVERYTHING)))
    expect(detail).toMatchObject({ needsCode: expect.stringContaining('raises what an ads playbook may spend'), bulkApprovable: false })
    const noCode = await decide('owner', answer.approvalId, {})
    expect(noCode.statusCode).toBe(403)
    expect(noCode.json()).toMatchObject({ code: 'mfa_required', raises: expect.arrayContaining(['Enrolled']) })
    const noPermission = await decide('manager', answer.approvalId, { code: codeOf('manager') })
    expect(noPermission.statusCode).toBe(403)
    const typedAt = Date.now()
    expect((await decide('owner', answer.approvalId, { code: codeOf() })).statusCode).toBe(200)
    expect(await approvalOf(answer.approvalId)).toMatchObject({ status: 'scheduled', decisionVia: 'nexus-step-up' })
    expect(await commit(answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await rowOf()).toMatchObject({ enrolled: true, dailyBudgetCents: 2000, state: 'DRAFT' })
    const version = await versionOf(answer.approvalId)
    expect(version).toMatchObject({ op: 'enroll', direction: 'raise', via: 'claude' })
    expect(version.stepUpAt!.getTime()).toBeGreaterThanOrEqual(typedAt - 1000)
  })

  it('a raise approved any other way (no code) is never run', async () => {
    const { answer } = await productRow({ dailyBudgetCents: 2600 })
    expect(answer.preview.direction).toBe('raise')
    expect(await inside(() => scheduleApproval({ id: answer.approvalId, actor: viewer('owner', EVERYTHING), via: 'nexus' }))).toMatchObject({ ok: true })
    const out = await commit(answer.approvalId)
    expect(out).toMatchObject({ ok: false })
    expect(out.error).toContain('a raise runs only when a person with settings.security.manage approved it with their authenticator code')
    expect((await rowOf()).dailyBudgetCents).toBe(2000)
  })
})

describe('PB-3 — by rule', { timeout: TIMEOUT }, () => {
  const owner = () => ({ userId: people.owner.id, label: 'Olga Owner', canManage: true })

  it('at auto a change that adds no spend runs by rule; a raise never does; a template change only with allowTemplateEdit; a market outside the list waits', async () => {
    expect(await inside(() => setClaudeRule(owner(), 'set-ads-playbook', { level: 'auto', code: codeOf() }))).toMatchObject({ ok: true })
    try {
      const lowered = await productRow({ dailyBudgetCents: 1800 })
      expect(lowered.answer, JSON.stringify(lowered.answer)).toMatchObject({ status: 'runs_by_rule', trust: { level: 'auto' } })
      expect(await commit(lowered.answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
      expect(await versionOf(lowered.answer.approvalId)).toMatchObject({ direction: 'lower', via: 'claude', stepUpAt: null })

      const raised = await productRow({ dailyBudgetCents: 2400 })
      expect(raised.answer).toMatchObject({ status: 'waiting_for_approval', trust: { why: expect.stringContaining('it raises Daily budget: a person with settings.security.manage decides') } })

      const template = await call('set-ads-playbook', { channel: 'AMAZON', kind: 'template', templateId: ids.template, status: 'DRAFT' })
      expect(template.answer).toMatchObject({ status: 'waiting_for_approval', trust: { why: expect.stringContaining('a template reaches every product that follows it') } })

      __stepUpTest.reset()
      expect(await inside(() => setClaudeRule(owner(), 'set-ads-playbook', { limits: { allowTemplateEdit: false, markets: ['DE'] }, code: codeOf() }))).toMatchObject({ ok: true })
      const elsewhere = await productRow({ nameToken: 'TESTTOOL2' })
      expect(elsewhere.answer).toMatchObject({ status: 'waiting_for_approval', trust: { why: expect.stringContaining('only in DE') } })
    } finally {
      __stepUpTest.reset()
      expect(await inside(() => setClaudeRule(owner(), 'set-ads-playbook', { level: 'ask', limits: null, code: codeOf() }))).toMatchObject({ ok: true })
    }
  })
})

describe('PB-3 — bulk and undo', { timeout: TIMEOUT }, () => {
  it('a bulk approve leaves a raise out, with why', async () => {
    const same = (await productRow({ portfolioName: 'Test portfolio' })).answer
    const raise = (await productRow({ baseBidCents: 55 })).answer
    expect([same.preview.direction, raise.preview.direction]).toEqual(['same', 'raise'])
    signedIn = people.owner.id
    const out = await app.inject({ method: 'POST', url: '/agent/fleet/approvals/bulk-decide', payload: { ids: [same.approvalId, raise.approvalId], decision: 'approve' } })
    expect(out.json()).toMatchObject({ ok: true, done: 1, of: 2, skipped: [{ id: raise.approvalId, why: expect.stringContaining('so it is approved on its own, with your authenticator code') }] })
    expect(await approvalOf(raise.approvalId)).toMatchObject({ status: 'pending' })
  })

  it('the undo of a lowering is a raise: it needs the code, and puts the row back', async () => {
    const before = (await rowOf()).dailyBudgetCents
    const { answer } = await productRow({ dailyBudgetCents: 900 })
    expect(answer.preview.direction).toBe('lower')
    expect((await decide('owner', answer.approvalId, {})).statusCode).toBe(200)
    expect(await commit(answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    const change = await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId: answer.approvalId } }))
    const undo = await call('undo-change', { changeId: change.id })
    expect(undo.answer, JSON.stringify(undo.answer)).toMatchObject({ status: 'waiting_for_approval', undoes: { changeId: change.id }, preview: { direction: 'raise', stepUp: { raises: ['Daily budget'] } } })
    expect((await decide('owner', undo.answer.approvalId, {})).statusCode).toBe(403)
    expect((await decide('owner', undo.answer.approvalId, { code: codeOf() })).statusCode).toBe(200)
    expect(await commit(undo.answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect((await rowOf()).dailyBudgetCents).toBe(before)
  })
})

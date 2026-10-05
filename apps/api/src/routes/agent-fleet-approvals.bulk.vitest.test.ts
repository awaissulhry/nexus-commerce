/**
 * Approvals grid (docs/approvals-grid/PLAN.md §5, §7) — the Owner's decisions of 2026-10-05, through the real routes:
 *
 *   bulk approve   Decision 1 = A: rows of the SAME kind (and worker) may be approved together; never a kind that cannot
 *                  be undone or reaches a buyer, a supplier, spends money or removes something (bulk-approve-policy.ts),
 *                  never a change plan, at most 200 at once. Each row takes exactly the single approve's path: the claim
 *                  with the approver's permission, the 20-second stop window, then the commit, which re-checks the
 *                  facts (staleness), the approver and the rule. A row the viewer may not approve is skipped with its
 *                  reason; the call does not fail.
 *   reject         needs no reason — on a row, on a plan ("Reject the plan" failed every time), in bulk; without one the
 *                  row says who rejected it, with one it keeps the person's words.
 *   approval-status  tells Claude what became of it: rejected (and the words), expired, replaced by an edit (and by
 *                  which), handed back (and why), failed (and why).
 *
 * The real routes in a Fastify app, on a real PostgreSQL (PGlite) with the real tools; the signed-in person resolved as
 * the workspace hook resolves them.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { FEATURES as F } from '@nexus/shared/permissions'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
vi.mock('../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, agentPlanQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
// The master price writer's read cache and readiness rebuild are left out (as approval-staleness-jsonb does).
vi.mock('../services/product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../services/pim/readiness-index.service.js', async () => (await import('../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import { resolvePermissions } from '../lib/auth/rbac.js'
import { createWorkspaceService } from '../services/workspace.service.js'
import { runOrQueueTool } from '../services/agents/approval-gate.service.js'
import { callTool, type UserPrincipal } from '../services/agents/call-tool.js'
import { amendPlan } from '../services/agents/change-plan.service.js'
import { commitScheduledApproval } from '../services/agent-fleet/approval-inbox.service.js'
import { NEVER_IN_BULK } from '../services/agent-fleet/bulk-approve-policy.js'
import agentFleetRoutes from './agent-fleet.routes.js'

const A = LEGACY_WORKSPACE_ID
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const VIEW = ['ai.run', 'ai.view', F.productsView]
const EVERYTHING = [...VIEW, F.productsPriceEdit, F.productsEdit]
const TIMEOUT = 30_000

let ready = false
let app: FastifyInstance
let signedIn = ''
const people: Record<'all' | 'view', { id: string; principal: UserPrincipal }> = {} as never
const products: Record<string, string> = {}

async function person(label: string, permissions: string[]) {
  const db = database.client
  const role = await db.role.create({ data: { key: `BULK_${randomUUID().slice(0, 8)}`, name: label, description: 'test', permissions, isSystem: false } })
  const user = await db.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: label } })
  await db.userRole.create({ data: { userId: user.id, roleId: role.id } })
  const membership = await db.workspaceMembership.create({ data: { workspaceId: A, userId: user.id, status: 'active' } })
  await db.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  return {
    id: user.id,
    principal: { kind: 'user', userId: user.id, label, permissions: { isOwner: false, permissions: new Set(permissions) }, workspace: business, via: 'app' } as UserPrincipal,
  }
}

const post = (who: 'all' | 'view', url: string, payload: unknown) => {
  signedIn = people[who].id
  return app.inject({ method: 'POST', url, payload: payload as Record<string, unknown> })
}
const row = (id: string) => inside(() => database.client.agentApproval.findUniqueOrThrow({ where: { id } }))
const price = async (sku: string) => Number((await inside(() => database.client.product.findUniqueOrThrow({ where: { id: products[sku] } }))).basePrice)

/** A request Claude asked for, as Claude's door stores it: one run per call (agentKey claude), queued for a person. */
async function asked(tool: string, args: Record<string, unknown>): Promise<string> {
  return inside(async () => {
    const run = await database.client.agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'done', via: 'claude', userId: people.all.id } })
    const queued = await runOrQueueTool(tool, args, { ...people.all.principal, via: 'claude' }, run.id, { forceAsk: true })
    expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
    return queued.approvalId!
  })
}

/** A stored request of a kind this file cannot dry-run without its own fixtures (a refund): the row as the gate writes it. */
async function stored(toolName: string, extra: Record<string, unknown> = {}): Promise<string> {
  return inside(async () => {
    const run = await database.client.agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'done', via: 'claude', userId: people.all.id } })
    const ap = await database.client.agentApproval.create({
      data: { agentRunId: run.id, toolName, riskTier: 'high', args: {}, preview: { summary: `A ${toolName} request` }, status: 'pending', expiresAt: new Date(Date.now() + 24 * 3600_000), ...extra } as never,
    })
    return ap.id
  })
}

const plan = (title: string) =>
  asked('submit-change-plan', {
    title,
    steps: [
      { tool: 'set-price', args: { productId: products['B-PLAN'], price: 71 } },
      { tool: 'apply-content', args: { productId: products['B-PLAN'], title: `${title}, new title` } },
    ],
  })

beforeAll(async () => {
  database = await formulaDatabase()
  ready = true
  const db = database.client
  people.all = await person('Ana Bulk', EVERYTHING)
  people.view = await person('Vic View', VIEW)
  await inside(async () => {
    const start: Record<string, string> = { 'B-1': '50.00', 'B-2': '60.00', 'B-3': '40.00', 'B-4': '30.00', 'B-5': '20.00', 'B-6': '25.00', 'B-7': '35.00', 'B-8': '45.00', 'B-PLAN': '70.00' }
    for (const [sku, base] of Object.entries(start)) {
      products[sku] = (await db.product.create({ data: { sku, name: `${sku} jacket`, basePrice: base } })).id
    }
  })

  const workspaces = createWorkspaceService(db as never)
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    void (async () => {
      const user = await db.userProfile.findUniqueOrThrow({
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
}, 180_000)

afterAll(async () => {
  await app?.close()
  if (ready) await database.close()
}, 30_000)

describe('Decision 1 = A — a bulk approve: same kind only, each row through the single approve’s path', { timeout: TIMEOUT }, () => {
  it('same-kind rows are approved together; then each runs, or is handed back, by its own commit re-checks', async () => {
    const ids = [
      await asked('set-price', { productId: products['B-1'], price: 52 }),
      await asked('set-price', { productId: products['B-2'], price: 63 }),
      await asked('set-price', { productId: products['B-3'], price: 41 }),
    ]
    const preview = (await post('all', '/agent/fleet/approvals/bulk-preview', { ids, decision: 'approve' })).json()
    expect(preview).toMatchObject({ count: 3, homogeneous: true, blockedReason: null, euro: { amount: 600 } })
    expect(preview.sentence).toBe(
      'This approves 3 actions: 3 × set price — 3 of them high risk. It raises your prices by €6.00 in total across 3 products. All of these can be put back. You have 20 seconds to take it back.',
    )

    const bulk = await post('all', '/agent/fleet/approvals/bulk-decide', { ids, decision: 'approve' })
    expect(bulk.statusCode).toBe(200)
    expect(bulk.json()).toEqual({ ok: true, done: 3, of: 3, skipped: [], failed: [] })
    for (const id of ids) {
      // Parked, not run: the same claim as one approve, by the person, inside the stop window.
      expect(await row(id)).toMatchObject({ status: 'scheduled', decidedBy: 'Ana Bulk', decidedByUserId: people.all.id, decisionVia: 'nexus' })
      expect((await row(id)).executeAfter!.getTime()).toBeGreaterThan(Date.now())
    }
    expect(await price('B-1')).toBe(50)

    // The facts of the second move inside the window: its own commit hands it back, the others run.
    await inside(() => database.client.product.update({ where: { id: products['B-2'] }, data: { basePrice: '61.00' } }))
    const outcomes = []
    for (const id of ids) {
      await inside(() => database.client.agentApproval.update({ where: { id }, data: { executeAfter: new Date(Date.now() - 1000) } }))
      outcomes.push(await inside(() => commitScheduledApproval(id)))
    }
    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true])
    expect([(await row(ids[0])).status, (await row(ids[1])).status, (await row(ids[2])).status]).toEqual(['executed', 'pending', 'executed'])
    expect((await row(ids[1])).reason).toMatch(/^not run — /)
    expect([await price('B-1'), await price('B-2'), await price('B-3')]).toEqual([52, 61, 41])
  })

  it('a mixed set, a kind never approved together, and a change plan are refused whole; nothing is scheduled', async () => {
    const mixed = [
      await asked('set-price', { productId: products['B-4'], price: 31 }),
      await asked('apply-content', { productId: products['B-4'], title: 'B-4 better title' }),
    ]
    const refunds = [await stored('issue-refund'), await stored('issue-refund')]
    const plans = [await plan('Bulk plan one'), await plan('Bulk plan two')]
    const cases: Array<[string[], string | RegExp]> = [
      [mixed, /^These are 2 different kinds of action \(set price, apply content\)\. Approve one kind at a time/],
      [refunds, NEVER_IN_BULK['issue-refund']],
      [plans, 'A change plan is approved on its own: open it to see its steps, then approve it there.'],
    ]
    for (const [ids, why] of cases) {
      const bulk = await post('all', '/agent/fleet/approvals/bulk-decide', { ids, decision: 'approve' })
      expect(bulk.json()).toMatchObject({ ok: false, done: 0, of: 2, skipped: [], error: why })
      // The preview says the same, before anyone clicks.
      const preview = (await post('all', '/agent/fleet/approvals/bulk-preview', { ids, decision: 'approve' })).json()
      expect(preview.blockedReason).toEqual(bulk.json().error)
      for (const id of ids) expect((await row(id)).status).toBe('pending')
    }
  })

  it('a row the viewer may not approve is skipped with its reason, and so is one that expired; the rest go ahead', async () => {
    const ids = [
      await asked('set-price', { productId: products['B-5'], price: 21 }),
      await asked('set-price', { productId: products['B-6'], price: 26 }),
    ]
    const notTheirs = 'set-price needs the products.price.edit permission.'
    const preview = (await post('view', '/agent/fleet/approvals/bulk-preview', { ids, decision: 'approve' })).json()
    expect(preview).toMatchObject({ count: 0, blockedReason: null, sentence: `You may not approve any of these 2: ${notTheirs}` })
    const refused = await post('view', '/agent/fleet/approvals/bulk-decide', { ids, decision: 'approve' })
    expect(refused.json()).toEqual({ ok: true, done: 0, of: 2, skipped: ids.map((id) => ({ id, why: notTheirs })), failed: [notTheirs, notTheirs] })
    for (const id of ids) expect((await row(id)).status).toBe('pending')

    await inside(() => database.client.agentApproval.update({ where: { id: ids[1] }, data: { expiresAt: new Date(Date.now() - 1000) } }))
    const bulk = await post('all', '/agent/fleet/approvals/bulk-decide', { ids, decision: 'approve' })
    expect(bulk.json()).toMatchObject({ ok: true, done: 1, of: 2, skipped: [{ id: ids[1], why: 'This request expired before anyone approved it. Nothing changed.' }] })
    expect((await row(ids[0])).status).toBe('scheduled')
  })

  it('at most 200 at once, either verb', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `no-such-${i}`)
    const why = 'You selected 201; at most 200 can be decided at once. Decide them in smaller groups.'
    for (const decision of ['approve', 'reject']) {
      const bulk = await post('all', '/agent/fleet/approvals/bulk-decide', { ids, decision })
      expect(bulk.statusCode).toBe(400)
      expect(bulk.json()).toMatchObject({ ok: false, done: 0, of: 201, error: why })
      expect((await post('all', '/agent/fleet/approvals/bulk-preview', { ids, decision })).json()).toMatchObject({ count: 0, blockedReason: why })
    }
    // 200 is allowed (none of these exist, so each is skipped with its reason).
    const most = await post('all', '/agent/fleet/approvals/bulk-decide', { ids: ids.slice(0, 200), decision: 'reject' })
    expect(most.json()).toMatchObject({ ok: true, done: 0, of: 200 })
    expect(most.json().skipped[0]).toEqual({ id: 'no-such-0', why: 'Nexus cannot find this request in this business.' })
  })
})

describe('A reject needs no reason (Owner, 2026-10-05)', { timeout: TIMEOUT }, () => {
  it('"Reject the plan" works with no reason; the row says who rejected it; words, when given, are kept', async () => {
    const id = await plan('Plan to reject')
    const rejected = await post('all', `/agent/fleet/approvals/${id}/decide`, { decision: 'reject' })
    expect(rejected.statusCode, rejected.body).toBe(200)
    expect(rejected.json()).toMatchObject({ ok: true, status: 'rejected' })
    expect(await row(id)).toMatchObject({ status: 'rejected', reason: 'rejected by Ana Bulk', operatorNote: null, decidedBy: 'Ana Bulk' })

    const single = await asked('set-price', { productId: products['B-7'], price: 36 })
    expect((await post('all', `/agent/fleet/approvals/${single}/decide`, { decision: 'reject', reason: '  too high  ' })).statusCode).toBe(200)
    expect(await row(single)).toMatchObject({ status: 'rejected', reason: 'too high', operatorNote: 'too high' })
  })

  it('a bulk reject spans kinds and needs no reason', async () => {
    const ids = [await asked('set-price', { productId: products['B-8'], price: 46 }), await stored('issue-refund'), await plan('Plan in a bulk reject')]
    const bulk = await post('all', '/agent/fleet/approvals/bulk-decide', { ids, decision: 'reject' })
    expect(bulk.json()).toEqual({ ok: true, done: 3, of: 3, skipped: [], failed: [] })
    for (const id of ids) expect(await row(id)).toMatchObject({ status: 'rejected', reason: 'rejected by Ana Bulk', operatorNote: null })
  })

  it('approval-status tells Claude: rejected (with the words when given), expired, replaced by an edit, handed back, failed', async () => {
    const status = async (approvalId: string) =>
      (await inside(() => callTool({ ...people.all.principal, via: 'claude' }, 'approval-status', { approvalId }))).visible.data as Record<string, unknown>

    const silent = await stored('set-price')
    await post('all', `/agent/fleet/approvals/${silent}/decide`, { decision: 'reject' })
    const noWords = await status(silent)
    expect(noWords).toMatchObject({ status: 'rejected', meaning: 'Ana Bulk rejected it without giving a reason. Nothing changed.' })
    expect(noWords).not.toHaveProperty('rejectedReason')

    const said = await stored('set-price')
    await post('all', `/agent/fleet/approvals/${said}/decide`, { decision: 'reject', reason: 'wrong product' })
    expect(await status(said)).toMatchObject({ status: 'rejected', rejectedReason: 'wrong product', meaning: 'Ana Bulk rejected it, saying: "wrong product". Nothing changed.' })

    const expired = await stored('set-price', { status: 'expired' })
    expect(await status(expired)).toMatchObject({ status: 'expired', meaning: 'Nobody decided in time. Nothing changed.' })

    const original = await plan('Plan to edit')
    const edited = await inside(() => amendPlan(original, [1], people.all.principal))
    expect(edited, JSON.stringify(edited)).toMatchObject({ ok: true })
    const replaced = await status(original)
    const newId = (edited as { approvalId: string }).approvalId
    expect(replaced).toMatchObject({ status: 'superseded', replacedBy: newId })
    expect(replaced.meaning).toContain(newId)

    const back = await stored('set-price', { reason: 'not run — the master price changed since it was asked for (was €10.00, now €11.00)' })
    expect(await status(back)).toMatchObject({
      status: 'pending',
      handedBack: 'the master price changed since it was asked for (was €10.00, now €11.00)',
      meaning: expect.stringMatching(/^It was approved, but Nexus did not run it: the master price changed/),
    })
    const byRule = await stored('set-price', { reason: 'not run by rule — changes that run by rule were paused in this business before it ran' })
    expect(await status(byRule)).toMatchObject({ handedBack: 'changes that run by rule were paused in this business before it ran' })

    const failed = await stored('set-price', { reason: 'execution failed: the price is below the pricing floor' })
    expect(await status(failed)).toMatchObject({
      status: 'pending',
      failed: 'the price is below the pricing floor',
      meaning: 'It was approved and Nexus tried to run it, but it failed: the price is below the pricing floor. It waits for a person to approve it again or reject it.',
    })

    const waiting = await stored('set-price')
    const plain = await status(waiting)
    expect(plain).toMatchObject({ status: 'pending', meaning: 'Waiting for a person to approve or reject it in Nexus. Nothing has changed yet.' })
    for (const key of ['rejectedReason', 'replacedBy', 'handedBack', 'failed']) expect(plain).not.toHaveProperty(key)
  })
})

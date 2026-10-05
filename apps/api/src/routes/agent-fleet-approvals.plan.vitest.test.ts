/**
 * MCP full control C6 — a change plan on the Approvals page: the routes its card reads and writes.
 *
 *   list     the "outside the fleet" list carries a plan as one row: it can run (canExecute), its Nexus-written
 *            summary, hash and kinds of consequence, and — before anyone clicks — why THIS viewer may not approve it
 *            (a step's tool they lack the permissions of), in the approve's own words
 *   steps    GET …/:id/plan: every step's fate and preview, through the reader's money filter
 *   untick   POST …/:id/plan-amend { keep }: a smaller plan, re-checked as the person; the original superseded
 *
 * The real routes in a Fastify app, on a real PostgreSQL (PGlite); the signed-in person resolved as the workspace hook
 * resolves them.
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

import { resolvePermissions } from '../lib/auth/rbac.js'
import { createWorkspaceService } from '../services/workspace.service.js'
import { runOrQueueTool } from '../services/agents/approval-gate.service.js'
import type { UserPrincipal } from '../services/agents/call-tool.js'
import agentFleetApprovalRoutes from './agent-fleet-approvals.routes.js'

const A = LEGACY_WORKSPACE_ID
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const PRICES = ['ai.run', 'ai.view', F.productsView, F.productsPriceEdit]
const EVERYTHING = [...PRICES, F.productsEdit]

let database_ready = false
let app: FastifyInstance
let signedIn = ''
const people: Record<'all' | 'prices', { id: string; principal: UserPrincipal }> = {} as never
const ids = { p1: '', p2: '', plan: '' }

async function person(label: string, permissions: string[]) {
  const db = database.client
  const role = await db.role.create({ data: { key: `PLAN_${randomUUID().slice(0, 8)}`, name: label, description: 'test', permissions, isSystem: false } })
  const user = await db.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: label } })
  await db.userRole.create({ data: { userId: user.id, roleId: role.id } })
  const membership = await db.workspaceMembership.create({ data: { workspaceId: A, userId: user.id, status: 'active' } })
  await db.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  return {
    id: user.id,
    principal: { kind: 'user', userId: user.id, label, permissions: { isOwner: false, permissions: new Set(permissions) }, workspace: business, via: 'app' } as UserPrincipal,
  }
}

const get = (who: 'all' | 'prices', url: string) => {
  signedIn = people[who].id
  return app.inject({ method: 'GET', url })
}
const post = (who: 'all' | 'prices', url: string, payload: unknown) => {
  signedIn = people[who].id
  return app.inject({ method: 'POST', url, payload: payload as Record<string, unknown> })
}

beforeAll(async () => {
  database = await formulaDatabase()
  database_ready = true
  const db = database.client
  people.all = await person('Ana Plan', EVERYTHING)
  people.prices = await person('Pat Prices', PRICES)
  await inside(async () => {
    ids.p1 = (await db.product.create({ data: { sku: 'TEST-CARD-1', name: 'Card jacket', basePrice: '50.00', costPrice: '20.00' } })).id
    ids.p2 = (await db.product.create({ data: { sku: 'TEST-CARD-2', name: 'Card jacket two', basePrice: '60.00' } })).id
    const run = await db.agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'done', via: 'claude', oauthGrantId: 'grant-card' } })
    const queued = await runOrQueueTool('submit-change-plan', {
      title: 'Card plan',
      steps: [
        { tool: 'set-price', args: { productId: ids.p1, price: 52 } },
        { tool: 'apply-content', args: { productId: ids.p2, title: 'Card jacket two, new' } },
        { tool: 'set-price', args: { productId: ids.p2, price: 61 } },
      ],
    }, people.all.principal, run.id, { forceAsk: true })
    expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
    ids.plan = queued.approvalId!
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
  await app.register(agentFleetApprovalRoutes)
  await app.ready()
}, 120_000)

afterAll(async () => {
  await app?.close()
  if (database_ready) await database.close()
}, 30_000)

describe('C6 — a change plan on the Approvals page', { timeout: 30_000 }, () => {
  type Row = { id: string; toolName: string; canExecute: boolean; cannotApprove: string | null; plan?: { summary: string; planHash: string; steps: number; kinds: Array<{ tool: string; count: number; outbound: boolean }> } }
  const rowOf = async (who: 'all' | 'prices') =>
    ((await get(who, '/agent/fleet/approvals/outside')).json() as { approvals: Row[] }).approvals.find((a) => a.id === ids.plan)!

  it('one row: it can run, its summary, hash and kinds; whether THIS viewer may approve it, before anyone clicks', async () => {
    const row = await rowOf('all')
    expect(row).toMatchObject({
      toolName: 'submit-change-plan',
      canExecute: true,
      cannotApprove: null,
      plan: { summary: expect.stringContaining('3 changes'), planHash: expect.stringMatching(/^[0-9a-f]{64}$/), steps: 3 },
    })
    expect(row.plan!.kinds).toEqual([
      expect.objectContaining({ tool: 'set-price', count: 2, outbound: true }),
      expect.objectContaining({ tool: 'apply-content', count: 1, outbound: false }),
    ])
    expect((await rowOf('prices')).cannotApprove).toBe('Approving this plan needs what each of its steps needs: apply-content needs the products.edit permission.')
  })

  it('its steps, each through the reader’s own money filter', async () => {
    const all = (await get('all', `/agent/fleet/approvals/${ids.plan}/plan`)).json() as { title: string; steps: number; list: Array<Record<string, unknown>> }
    expect(all).toMatchObject({ title: 'Card plan', steps: 3, byStatus: { pending: 3 } })
    expect(all.list.map((s) => [s.step, s.tool, s.status, s.outbound])).toEqual([[1, 'set-price', 'pending', true], [2, 'apply-content', 'pending', false], [3, 'set-price', 'pending', true]])
    expect(all.list[0].preview).toMatchObject({ action: 'set-price', changes: { 'base price': { from: 50, to: 52 } } })
    // Approvals grid: each step also carries its change in the grid's own words (the master currency), not 50 → 52.
    expect(all.list[0]).toMatchObject({ changes: [{ label: 'Base price', from: '€50.00', to: '€52.00' }], changeCount: 1 })
    const prices = (await get('prices', `/agent/fleet/approvals/${ids.plan}/plan`)).json() as { list: Array<Record<string, unknown>> }
    expect(prices.list[1]).toMatchObject({ preview: null, previewHidden: expect.stringContaining('apply-content') })
    expect(prices.list[1].changes).toBeUndefined() // a hidden step's words stay hidden
    expect(prices.list[0].preview).toMatchObject({ action: 'set-price' })
    expect((await get('all', '/agent/fleet/approvals/no-such-plan/plan')).statusCode).toBe(404)
  })

  it('unticking steps makes a smaller plan, re-checked as the person; the original is superseded', async () => {
    const refused = await post('all', `/agent/fleet/approvals/${ids.plan}/plan-amend`, { keep: [1, 2, 3] })
    expect(refused.statusCode).toBe(400)
    const amended = await post('all', `/agent/fleet/approvals/${ids.plan}/plan-amend`, { keep: [1, 3] })
    expect(amended.statusCode, amended.body).toBe(200)
    const out = amended.json() as { approvalId: string; supersededId: string }
    expect(out.supersededId).toBe(ids.plan)
    const smaller = (await get('all', `/agent/fleet/approvals/${out.approvalId}/plan`)).json() as { steps: number; list: Array<{ tool: string }> }
    expect(smaller.steps).toBe(2)
    expect(smaller.list.map((s) => s.tool)).toEqual(['set-price', 'set-price'])
    const old = await inside(() => database.client.agentApproval.findUniqueOrThrow({ where: { id: ids.plan } }))
    expect(old).toMatchObject({ status: 'superseded', decidedBy: 'Ana Plan' })
    // A person who may not ask for every step they keep is refused by the re-check.
    const next = (await get('all', '/agent/fleet/approvals/outside')).json() as { approvals: Row[] }
    expect(next.approvals.some((a) => a.id === ids.plan)).toBe(false)
  })
})

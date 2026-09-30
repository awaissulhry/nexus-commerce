/**
 * The Approvals page never offers an Apply that can only fail.
 *
 * Both lists the page reads — the fleet queue (GET /agent/fleet/approvals) and the requests from outside the fleet
 * (GET /agent/fleet/approvals/outside) — say, per row, why the person looking may NOT approve it (`cannotApprove`, the
 * approve's own refusal) or null when they may. The card then disables Apply and writes the reason out. The case it
 * exists for: a person whose permission was taken away while their own approval waited sees it come back, and sees
 * that it is no longer theirs to approve, instead of an enabled Apply that answers 403.
 *
 * The real routes in a Fastify app, on a real PostgreSQL (PGlite). The signed-in person's permissions are resolved
 * the way the workspace hook resolves them (their membership of the business with profiles on, their login roles
 * off), so taking a role away in the database changes what the page is told.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { FEATURES as F } from '@nexus/shared/permissions'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// As db.ts wraps it: inside a transaction, `prisma.x` is that transaction's client.
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
// No Redis here.
vi.mock('../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))

import { resolvePermissions } from '../lib/auth/rbac.js'
import { createWorkspaceService } from '../services/workspace.service.js'
import { runOrQueueTool } from '../services/agents/approval-gate.service.js'
import type { UserPrincipal } from '../services/agents/call-tool.js'
import { commitScheduledApproval, decideFleetApproval } from '../services/agent-fleet/approval-inbox.service.js'
import agentFleetApprovalRoutes from './agent-fleet-approvals.routes.js'
import agentFleetRoutes from './agent-fleet.routes.js'

const A = LEGACY_WORKSPACE_ID
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

let app: FastifyInstance
/** Who the next request is signed in as. */
let signedIn = ''
let baseRoleId = ''
let publishRoleId = ''
let productId = ''

interface Person { id: string; label: string; membershipId: string; principal: UserPrincipal }

async function publisher(label: string): Promise<Person> {
  const db = database.client
  const user = await db.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: label } })
  for (const roleId of [baseRoleId, publishRoleId]) await db.userRole.create({ data: { userId: user.id, roleId } })
  const membership = await db.workspaceMembership.create({ data: { workspaceId: A, userId: user.id, status: 'active' } })
  for (const roleId of [baseRoleId, publishRoleId]) await db.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId } })
  return {
    id: user.id,
    label,
    membershipId: membership.id,
    principal: {
      kind: 'user', userId: user.id, label,
      permissions: { isOwner: false, permissions: new Set(['ai.run', F.productsView, F.listingsPublish]) },
      workspace: business, via: 'app',
    },
  }
}

async function takePublishingAway(person: Person) {
  const db = database.client
  await db.userRole.deleteMany({ where: { userId: person.id, roleId: publishRoleId } })
  await db.workspaceMemberRole.deleteMany({ where: { membershipId: person.membershipId, roleId: publishRoleId } })
  await db.userProfile.update({ where: { id: person.id }, data: { permissionsVersion: { increment: 1 } } })
}

async function queuePublish(person: Person) {
  const run = await inside(() => database.client.agentRun.create({ data: { agentKey: 'manual-action', trigger: 'manual', status: 'done' } }))
  const queued = await inside(() => runOrQueueTool('publish-listing', { productId, channel: 'AMAZON' }, person.principal, run.id))
  expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
  return queued.approvalId!
}

async function outsideRow(person: Person, approvalId: string) {
  signedIn = person.id
  const response = await app.inject({ method: 'GET', url: '/agent/fleet/approvals/outside' })
  expect(response.statusCode).toBe(200)
  return (response.json() as { approvals: Array<{ id: string; cannotApprove: string | null; reason: string | null }> }).approvals.find((a) => a.id === approvalId)!
}

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  const role = (name: string, permissions: string[]) =>
    db.role.create({ data: { key: `VIEWER_${name}_${randomUUID().slice(0, 8)}`, name, description: 'test', permissions, isSystem: false } })
  baseRoleId = (await role('BASE', ['ai.run', F.productsView])).id
  publishRoleId = (await role('PUBLISH', [F.listingsPublish])).id
  await inside(async () => {
    const account = await db.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'viewer-amazon', isActive: true, externalAccountId: 'SELLER-TEST-V' } as never })
    productId = (await db.product.create({ data: { sku: 'VIEWER-1', name: 'Viewer jacket', basePrice: '10.00' } })).id
    await db.channelListing.create({
      data: { productId, channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', channelConnectionId: account.id, title: 'Viewer jacket' } as never,
    })
  })

  // The signed-in person, resolved as the workspace hook resolves them (lib/workspace-hook.ts).
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
  await app.register(agentFleetRoutes)
  await app.ready()
}, 120_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

describe('the Approvals page is told, per request, whether the viewer may approve it', { timeout: 30_000 }, () => {
  it('a person who may: nothing to say (Apply is offered)', async () => {
    const person = await publisher('Ada Viewer')
    const id = await queuePublish(person)
    expect((await outsideRow(person, id)).cannotApprove).toBeNull()
  })

  it('a person who may not: the approve’s own refusal, before they click', async () => {
    const owner = await publisher('Ben Viewer')
    const id = await queuePublish(owner)
    const other = await publisher('Cleo Viewer')
    await takePublishingAway(other)
    expect((await outsideRow(other, id)).cannotApprove).toBe('publish-listing needs the listings.publish permission.')
    // …and it is exactly what the approve answers.
    const decided = await inside(() => decideFleetApproval({ id, decision: 'approve', actor: { ...other.principal, permissions: { isOwner: false, permissions: new Set(['ai.run', F.productsView]) } } }))
    expect(decided).toMatchObject({ ok: false, code: 'forbidden', error: 'publish-listing needs the listings.publish permission.' })
  })

  it('the approver whose permission was taken away while it waited sees it come back, and that it is no longer theirs', async () => {
    const person = await publisher('Omar Viewer')
    const id = await queuePublish(person)
    expect(await inside(() => decideFleetApproval({ id, decision: 'approve', actor: person.principal }))).toMatchObject({ ok: true, status: 'scheduled' })
    await takePublishingAway(person)
    await inside(() => database.client.agentApproval.update({ where: { id }, data: { executeAfter: new Date(Date.now() - 1000) } }))
    expect(await inside(() => commitScheduledApproval(id))).toMatchObject({ ok: false })

    const row = await outsideRow(person, id)
    expect(row.reason).toBe('not run — Omar Viewer no longer holds listings.publish, which publish listing needs')
    expect(row.cannotApprove).toBe('publish-listing needs the listings.publish permission.')
  })

  it('the fleet queue says it too: a bid change is not for a person without the ads permissions', async () => {
    const person = await publisher('Dana Viewer')
    const run = await inside(() => database.client.agentRun.create({ data: { agentKey: 'amazon-bid-tuner', trigger: 'cron', status: 'done' } }))
    const bid = await inside(() => database.client.agentApproval.create({
      data: { agentRunId: run.id, toolName: 'set-target-bid', riskTier: 'high', status: 'pending', args: { targetId: 'target-test-1', proposedBidCents: 55 }, preview: { currentBidCents: 42 } },
    }))
    signedIn = person.id
    const response = await app.inject({ method: 'GET', url: '/agent/fleet/approvals?view=waiting' })
    expect(response.statusCode).toBe(200)
    const row = (response.json() as { approvals: Array<{ id: string; cannotApprove: string | null }> }).approvals.find((a) => a.id === bid.id)!
    expect(row.cannotApprove).toBe(`set-target-bid needs the ${F.adsBidsEdit} and financials.adspend.view permissions.`)
  })
})

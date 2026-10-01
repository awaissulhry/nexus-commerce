/**
 * MCP full control #21 (plan 08, F1 + F2) — approving a purchase order needs po.approve, and the person recorded on a
 * transition is the signed-in user, never a `userId` from the request body.
 *
 * Both PO transition routes (`…/:id/transition` and `…/bulk-transition`) carry the transition in the BODY, so the
 * route manifest, which sees only the path, resolves them to po.create for every transition. Before the fix anyone
 * with po.create could approve, and the approver id was whatever the body said (or nobody).
 *
 * Real SQL (PGlite with the production schema) and the real route plugin. The signed-in user and their permissions
 * are planted the way the session and business-profile hooks leave them on the request. Every id is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Pick<Awaited<ReturnType<typeof formulaDatabase>>, 'client' | 'close'>

vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { get connection() { return null } },
  }
})

const OPERATOR = 'test-po-operator'
const CREATOR = ['po.view', 'po.create', 'po.receive'] // the FULFILLMENT role's PO permissions
const APPROVER = ['po.view', 'po.create', 'po.approve']
const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let app: FastifyInstance
let seq = 0

async function po(status: 'DRAFT' | 'REVIEW') {
  seq += 1
  return inside(() => database.client.purchaseOrder.create({ data: { poNumber: `TEST-PO-${seq}`, status }, select: { id: true } }))
}
const read = (id: string) => inside(() => database.client.purchaseOrder.findUniqueOrThrow({
  where: { id }, select: { status: true, approvedByUserId: true, reviewedByUserId: true } }))
const post = (url: string, permissions: string[], payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, headers: { 'x-test-permissions': permissions.join(',') }, payload })

describe('PO transitions — po.approve and the signed-in actor', () => {
  beforeAll(async () => {
    database = await formulaDatabase()
    app = Fastify()
    // What the session and business-profile hooks leave on the request in production.
    app.addHook('onRequest', async (request) => {
      const permissions = String(request.headers['x-test-permissions'] ?? '').split(',').filter(Boolean)
      request.__sessionLoaded = true
      request.authUser = { id: OPERATOR, roleKeys: [], permissionsVersion: 1 } as never
      request.__rbacResolved = { isOwner: false, permissions: new Set(permissions) }
    })
    app.addHook('preHandler', (_request, _reply, done) => {
      withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done)
    })
    const { default: fulfillmentRoutes } = await import('./fulfillment.routes.js')
    await app.register(fulfillmentRoutes, { prefix: '/api' })
    await app.ready()
  }, 180_000)
  afterAll(async () => {
    await app?.close()
    await database?.close()
  })

  it('approve without po.approve is refused and the PO stays in review', async () => {
    const { id } = await po('REVIEW')
    const res = await post(`/api/fulfillment/purchase-orders/${id}/transition`, CREATOR, { transition: 'approve' })
    expect(res.statusCode, res.body).toBe(403)
    expect(res.json()).toMatchObject({ required: 'po.approve' })
    expect(await read(id)).toMatchObject({ status: 'REVIEW', approvedByUserId: null })
  })

  it('approve with po.approve records the signed-in user, not the userId in the body', async () => {
    const { id } = await po('REVIEW')
    const res = await post(`/api/fulfillment/purchase-orders/${id}/transition`, APPROVER, { transition: 'approve', userId: 'forged-user' })
    expect(res.statusCode, res.body).toBe(200)
    expect(await read(id)).toMatchObject({ status: 'APPROVED', approvedByUserId: OPERATOR })
  })

  it('the other transitions stay with po.create, and record the signed-in user too', async () => {
    const { id } = await po('DRAFT')
    const res = await post(`/api/fulfillment/purchase-orders/${id}/transition`, CREATOR, { transition: 'submit-for-review', userId: 'forged-user' })
    expect(res.statusCode, res.body).toBe(200)
    // No approval rule is set, so the PO advances through review (unchanged behaviour); both stamps are the operator.
    expect(await read(id)).toMatchObject({ status: 'APPROVED', reviewedByUserId: OPERATOR, approvedByUserId: OPERATOR })
  })

  it('bulk approve without po.approve is refused for every PO', async () => {
    const a = await po('REVIEW'), b = await po('REVIEW')
    const res = await post('/api/fulfillment/purchase-orders/bulk-transition', CREATOR, { ids: [a.id, b.id], transition: 'approve' })
    expect(res.statusCode, res.body).toBe(403)
    for (const { id } of [a, b]) expect(await read(id)).toMatchObject({ status: 'REVIEW', approvedByUserId: null })
  })

  it('bulk approve with po.approve records the signed-in user, not the userId in the body', async () => {
    const a = await po('REVIEW'), b = await po('REVIEW')
    const res = await post('/api/fulfillment/purchase-orders/bulk-transition', APPROVER, { ids: [a.id, b.id], transition: 'approve', userId: 'forged-user' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().succeeded).toHaveLength(2)
    for (const { id } of [a, b]) expect(await read(id)).toMatchObject({ status: 'APPROVED', approvedByUserId: OPERATOR })
  })
})

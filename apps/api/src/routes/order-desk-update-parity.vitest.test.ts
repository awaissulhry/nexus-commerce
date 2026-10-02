/**
 * MCP full control 07 O7 — the order, customer and review writes Claude's update tools use move out of their routes
 * into services (orders/order-update.service.ts, customers/customer-update.service.ts, reviews/review-triage.service.ts)
 * with NO change to what the routes do and answer. The snapshots in __snapshots__/order-desk-update-parity.vitest.test.ts.snap
 * were written by the route code BEFORE the move: order notes (add, edit, delete), mark delivered; customer notes
 * (add, delete), tags, manual review; review triage — each with its refusals (400 / 404).
 *
 * Real SQL (PGlite with the production schema) and the real route plugins. Ids and times the database makes are masked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return {
    addJobSafely: vi.fn(async () => undefined),
    outboundSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue,
    redis: { connection: null },
  }
})

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const CLOCK = new Set(['id', 'createdAt', 'updatedAt', 'triageUpdatedAt', 'ingestedAt', 'workspaceId'])
const stable = (body: string) => JSON.stringify(JSON.parse(body), (key, value) => (CLOCK.has(key) ? '<made>' : value), 2)

describe('07 O7 — order, customer and review writes: the routes answer exactly as before the move', () => {
  let app: FastifyInstance
  const call = async (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) })
    return { status: response.statusCode, body: stable(response.body || '{}') }
  }

  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      await database.client.order.create({ data: {
        id: 'test-order-1', channel: 'EBAY', channelOrderId: 'TEST-ORDER-1', marketplace: 'IT', status: 'SHIPPED', currencyCode: 'EUR',
        totalPrice: '10.00', customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: { city: 'Testville' },
      } as never })
      await database.client.customer.create({ data: { id: 'test-customer-1', email: 'buyer@example.test', name: 'Test Buyer', tags: ['old'] } as never })
      await database.client.review.create({ data: { id: 'test-review-1', channel: 'EBAY', externalReviewId: 'TEST-REV-1', rating: 2, body: 'Too small', postedAt: new Date('2026-04-01T10:00:00Z') } as never })
    })
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
    const { ordersRoutes } = await import('./orders.routes.js')
    const { customersRoutes } = await import('./customers.routes.js')
    const { default: reviewsRoutes } = await import('./reviews.routes.js')
    await app.register(ordersRoutes)
    await app.register(customersRoutes)
    await app.register(reviewsRoutes, { prefix: '/api' })
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    await database?.close()
  })

  it('order notes: add, refuse empty and unknown order, edit, delete, refuse unknown note', async () => {
    const added = await app.inject({ method: 'POST', url: '/api/orders/test-order-1/notes', payload: { body: '  Ring before delivery  ', pinned: true, authorEmail: 'ops@example.test' } })
    const noteId = added.json().id as string
    expect([
      { status: added.statusCode, body: stable(added.body) },
      await call('POST', '/api/orders/test-order-1/notes', { body: '   ' }),
      await call('POST', '/api/orders/test-order-none/notes', { body: 'x' }),
      await call('PATCH', `/api/orders/test-order-1/notes/${noteId}`, { body: ' Edited ', pinned: false }),
      await call('DELETE', `/api/orders/test-order-1/notes/${noteId}`),
      await call('DELETE', `/api/orders/test-order-1/notes/${noteId}`),
    ]).toMatchSnapshot()
  })

  it('mark delivered: a date, a bad date, a future date, an unknown order', async () => {
    expect([
      await call('POST', '/api/orders/test-order-1/mark-delivered', { deliveredAt: '2026-04-05T10:00:00Z' }),
      await call('POST', '/api/orders/test-order-1/mark-delivered', { deliveredAt: 'not a date' }),
      await call('POST', '/api/orders/test-order-1/mark-delivered', { deliveredAt: '2999-01-01T00:00:00Z' }),
      await call('POST', '/api/orders/test-order-none/mark-delivered', { deliveredAt: '2026-04-05T10:00:00Z' }),
    ]).toMatchSnapshot()
  })

  it('customer notes, tags and manual review', async () => {
    const added = await app.inject({ method: 'POST', url: '/api/customers/test-customer-1/notes', payload: { body: ' VIP buyer ', authorEmail: 'ops@example.test' } })
    const noteId = added.json().id as string
    expect([
      { status: added.statusCode, body: stable(added.body) },
      await call('POST', '/api/customers/test-customer-1/notes', { body: '' }),
      await call('POST', '/api/customers/test-customer-none/notes', { body: 'x' }),
      await call('DELETE', `/api/customers/test-customer-1/notes/${noteId}`),
      await call('DELETE', `/api/customers/test-customer-1/notes/${noteId}`),
      await call('PATCH', '/api/customers/test-customer-1/tags', { tags: ['vip', 'wholesale'] }),
      await call('PATCH', '/api/customers/test-customer-1/tags', { tags: 'vip' }),
      await call('PATCH', '/api/customers/test-customer-1/manual-review', { state: 'APPROVED' }),
      await call('PATCH', '/api/customers/test-customer-1/manual-review', { state: 'MAYBE' }),
    ]).toMatchSnapshot()
  })

  it('review triage: status, assignee, tags and note; a bad status; an unknown review', async () => {
    expect([
      await call('PATCH', '/api/reviews/test-review-1/triage', { status: 'IN_PROGRESS', assignee: 'Ops', tags: ['sizing'], note: 'Check the size chart' }),
      await call('PATCH', '/api/reviews/test-review-1/triage', { assignee: null }),
      await call('PATCH', '/api/reviews/test-review-1/triage', { status: 'LOST' }),
      await call('PATCH', '/api/reviews/test-review-none/triage', { status: 'RESOLVED' }),
    ]).toMatchSnapshot()
  })
})

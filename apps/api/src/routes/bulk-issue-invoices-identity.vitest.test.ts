/**
 * MCP full control 07 — the Orders page's "Issue invoices" (POST /api/orders/bulk-issue-invoices) takes no fiscal number
 * for a business without its company details (lead ruling 2026-10-02; Owner: a business without them — Motovento
 * today — gets no invoices).
 *
 * RED before the fix: the bulk route numbered invoices in the business's series whatever its company settings held,
 * while the invoice itself can never be printed without the name, the full address and the P.IVA. Now it answers 400
 * with what to fill in (Settings › Company) and takes no number; with the details it numbers as before.
 *
 * Real SQL (PGlite with the production schema) and the real route plugin. Every name, town and number is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../test-support/formula-database.js'
import { withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    redis: { connection: null },
  }
})
vi.mock('../services/advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))

const SECOND = 'test_bulk_invoice_business'
const business = { workspaceId: SECOND, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

describe('bulk-issue-invoices: no company details, no invoice number', () => {
  let app: FastifyInstance
  const issue = (orderIds: string[]) => app.inject({ method: 'POST', url: '/api/orders/bulk-issue-invoices', payload: { orderIds } })
  const numbered = () => inside(() => database.client.fiscalInvoice.count())

  beforeAll(async () => {
    database = await formulaDatabase()
    await database.client.workspace.create({ data: { id: SECOND, name: 'Invoice test business', createdByUserId: 'test', creationKey: 'test-bulk-invoice' } })
    await inside(async () => {
      for (const n of [1, 2]) {
        await database.client.order.create({
          data: {
            id: `test-bulk-order-${n}`, channel: 'SHOPIFY', channelOrderId: `TEST-BULK-${n}`, marketplace: 'IT', status: 'DELIVERED', currencyCode: 'EUR', totalPrice: '30.00',
            customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: { city: 'Testville' },
          } as never,
        })
      }
    })
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
    const { ordersRoutes } = await import('./orders.routes.js')
    await app.register(ordersRoutes)
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    await database?.close()
  })

  it('a business without its P.IVA and address: 400, what to fill in, and no number taken', async () => {
    await inside(() => database.client.brandSettings.create({ data: { companyName: 'Invoice Test Srl' } as never }))
    const refused = await issue(['test-bulk-order-1', 'test-bulk-order-2'])
    expect(refused.statusCode, refused.body).toBe(400)
    expect(refused.json().error).toMatch(/^Fill in the company full address .* and P\.IVA in Settings › Company/)
    expect(await numbered()).toBe(0)
  })

  it('with the details in Settings › Company, the invoices are numbered as before', async () => {
    await inside(() => database.client.brandSettings.updateMany({ data: { piva: 'IT00000000000', addressLines: ['Via Test 1', '00100 Testborgo'] } as never }))
    const done = await issue(['test-bulk-order-1', 'test-bulk-order-2'])
    expect(done.statusCode, done.body).toBe(200)
    expect(done.json()).toMatchObject({ success: true, scanned: 2, newlyIssued: 2, alreadyIssued: 0, failed: 0 })
    expect(await numbered()).toBe(2)
  })
})

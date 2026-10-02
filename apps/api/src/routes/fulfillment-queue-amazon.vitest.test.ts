/**
 * MCP full control 07 (lead review, step 0) — the Outbound page's ship queue (GET /fulfillment/outbound/pending-orders)
 * lists only orders the business ships: never an order Amazon ships (FBA / AFN in any case, an Amazon order without
 * merchant evidence, a live Multi-Channel Fulfilment request — the fail-closed test of amazon-fulfilled-order.ts) and
 * never an order in the bin. Its counts (urgency, per channel) follow. Before, both kinds were queued, and the page
 * offered "create shipment" for them (07 O1 refuses the create; the queue should not offer it).
 *
 * Real SQL (PGlite with the production schema) and the real route plugin.
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
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'disabled' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../services/advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const hours = (h: number) => new Date(Date.now() + h * 3_600_000)

describe('the Outbound ship queue lists only orders the business ships', () => {
  let app: FastifyInstance
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      const make = async (key: string, data: Record<string, unknown>) => {
        ids[key] = (await database.client.order.create({
          data: {
            channel: 'EBAY', channelOrderId: `TEST-Q-${key}`, marketplace: 'IT', status: 'PROCESSING', currencyCode: 'EUR', totalPrice: '10.00',
            customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: { city: 'Testville' }, purchaseDate: hours(-24),
            shipByDate: hours(-1), ...data,
          } as never,
        })).id
      }
      await make('EBAY', { fulfillmentMethod: 'MFN' })
      await make('SHOPIFY', { channel: 'SHOPIFY', fulfillmentMethod: null })
      await make('AMAZON-FBM', { channel: 'AMAZON', fulfillmentMethod: 'FBM' })
      await make('EBAY-MCF-CANCELLED', {})
      await make('FBA', { channel: 'AMAZON', fulfillmentMethod: 'FBA' })
      await make('AFN-LOWER', { channel: 'AMAZON', fulfillmentMethod: 'afn' })
      await make('AMAZON-UNKNOWN', { channel: 'AMAZON', fulfillmentMethod: null })
      await make('EBAY-MCF', {})
      await make('IN-BIN', { deletedAt: new Date() })
      await database.client.mCFShipment.create({ data: { orderId: ids['EBAY-MCF'], amazonFulfillmentOrderId: 'TEST-Q-MCF-1', status: 'PROCESSING' } })
      await database.client.mCFShipment.create({ data: { orderId: ids['EBAY-MCF-CANCELLED'], amazonFulfillmentOrderId: 'TEST-Q-MCF-2', status: 'CANCELLED' } })
    })
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
    const { default: fulfillmentRoutes } = await import('./fulfillment.routes.js')
    await app.register(fulfillmentRoutes, { prefix: '/api' })
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    await database?.close()
  })

  it('the queue, its total and its counts hold the four orders the business ships, and nothing else', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/fulfillment/outbound/pending-orders?pageSize=200' })
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json() as { items: Array<{ channelOrderId: string }>; total: number; counts: { overdue: number; byChannel: Record<string, number> } }
    expect(body.items.map((o) => o.channelOrderId).sort()).toEqual(['TEST-Q-AMAZON-FBM', 'TEST-Q-EBAY', 'TEST-Q-EBAY-MCF-CANCELLED', 'TEST-Q-SHOPIFY'])
    expect(body.total).toBe(4)
    expect(body.counts.overdue).toBe(4)
    expect(body.counts.byChannel).toEqual({ AMAZON: 1, EBAY: 2, SHOPIFY: 1 })
  })

  it('with an urgency filter and a search too', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/fulfillment/outbound/pending-orders?urgency=OVERDUE&search=TEST-Q' })
    const body = response.json() as { items: Array<{ channelOrderId: string }> }
    expect(body.items.map((o) => o.channelOrderId).sort()).toEqual(['TEST-Q-AMAZON-FBM', 'TEST-Q-EBAY', 'TEST-Q-EBAY-MCF-CANCELLED', 'TEST-Q-SHOPIFY'])
  })
})

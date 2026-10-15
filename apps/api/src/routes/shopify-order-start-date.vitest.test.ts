/**
 * The Shopify receiver and the replay registry pass every order topic through Shopify order import's start date
 * (services/shopify/order-ingest-switch.ts), and a products/update webhook never renames a Nexus product.
 *
 * The receiver, the gate and the handlers are the real code; the ledger, the claim, the routing, the app secret and
 * the database are stood in, so every database call is visible. The order writer's own stock calls throw if reached:
 * an ignored or held order must never get that far. What an admitted order does to stock is proven on a real
 * PostgreSQL in services/shopify/order-start-date-postgres.vitest.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'

const SECRET = 'start-date-test-secret'
const FLAG = 'NEXUS_ENABLE_SHOPIFY_ORDER_INGEST'
const T0 = new Date('2026-10-15T10:00:00.000Z')
const m = vi.hoisted(() => ({
  dbCalls: [] as Array<{ model: string; method: string; args: any }>,
  answers: {} as Record<string, unknown>,
  finished: [] as Array<{ id: string; outcome: string }>,
}))

vi.mock('../services/cx/ingress/ledger.js', () => {
  class InboundDeferred extends Error {
    constructor(message: string, readonly delayMs: number) { super(message); this.name = 'InboundDeferred' }
  }
  return {
    InboundDeferred,
    recordInbound: vi.fn(async (rec: any) => ({ id: `row-${rec.externalId}`, duplicate: false, rec })),
    inboundNotRecorded: () => 'the inbound ledger is unavailable',
  }
})
vi.mock('../services/cx/ingress/claims.js', async () => {
  const { recordInbound } = await import('../services/cx/ingress/ledger.js')
  return {
    claimInbound: async (id: string) => {
      const rec = (recordInbound as any).mock.calls.at(-1)[0]
      return { id, token: `claim-${id}`, attempt: 1, payload: rec.payload, connectionId: rec.connectionId ?? null }
    },
    runWithInboundClaim: async (claim: any, work: any) => {
      try {
        const result = await work(claim, new AbortController().signal)
        m.finished.push({ id: claim.id, outcome: 'done' })
        return result
      } catch (error) {
        m.finished.push({ id: claim.id, outcome: (error as Error).name === 'InboundDeferred' ? 'deferred' : 'failed' })
        throw error
      }
    },
  }
})
vi.mock('../lib/workspace-ingress.js', () => ({
  legacyIngress: (work: any) => work(),
  withIngressWorkspace: (_id: string, work: any) => work(),
  verifiedChannelWorkspace: vi.fn(async () => ({ workspaceId: 'ws-1', connectionId: 'conn-1' })),
}))
vi.mock('../services/cx/apps.service.js', () => ({ getChannelApp: async () => ({ clientSecret: SECRET }) }))
vi.mock('../services/shopify/schema-sync.service.js', () => ({ registerShopifySchemaWebhook: () => {} }))
vi.mock('../services/stock-level.service.js', () => ({
  reserveOpenOrder: vi.fn(() => { throw new Error('Unexpected order reservation') }),
  consumeOpenOrder: vi.fn(() => { throw new Error('Unexpected order consumption') }),
  resolveLocationByCode: vi.fn(() => { throw new Error('Unexpected stock lookup') }),
  unitsPerProduct: vi.fn(() => { throw new Error('Unexpected stock grouping') }),
}))
vi.mock('../services/shopify-locations.service.js', () => ({ resolveByShopifyId: vi.fn(() => { throw new Error('Unexpected inventory lookup') }) }))
vi.mock('../services/shopify/content-webhook.service.js', () => ({ recordManagedContentChange: vi.fn(async () => false) }))
vi.mock('../db.js', () => ({
  default: new Proxy({}, {
    get: (_t, model: string) => new Proxy({}, {
      get: (_m, method: string) => async (args: any) => {
        m.dbCalls.push({ model, method, args })
        return m.answers[`${model}.${method}`] ?? null
      },
    }),
  }),
}))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emit: vi.fn() } }))
vi.mock('../services/listing-events.service.js', () => ({ publishListingEvent: vi.fn() }))

const Fastify = (await import('fastify')).default
const webhooks = await import('./shopify-webhooks.js')
const { inboundHandlerFor } = await import('../services/cx/ingress/handlers.js')
const { logger } = await import('../utils/logger.js')
const stock = await import('../services/stock-level.service.js')

const sign = (body: string) => crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('base64')
let delivery = 0
async function deliver(path: string, payload: Record<string, unknown>) {
  const app = Fastify()
  await app.register(webhooks.shopifyWebhookRoutes)
  const body = JSON.stringify(payload)
  try {
    return await app.inject({ method: 'POST', url: path, payload: body, headers: {
      'content-type': 'application/json', 'x-shopify-hmac-sha256': sign(body), 'x-shopify-shop-domain': 'store-a.myshopify.com',
      'x-shopify-webhook-id': `delivery-${++delivery}`,
    } })
  } finally { await app.close() }
}

const OLD_ORDER = { id: 820001, created_at: '2026-10-15T09:59:59Z', updated_at: '2026-10-16T08:00:00Z', financial_status: 'paid', fulfillment_status: null,
  total_price: '20', currency: 'EUR', line_items: [{ id: 1, sku: 'SKU-A', quantity: 2, price: '10' }] }
/** Every database call other than reading the account's start date (and, for a fulfilment or refund, its order). */
const writesOrOrderWork = () => m.dbCalls.filter((c) => !(c.model === 'shopifyOrderIngest' && c.method === 'findUnique') && !(c.model === 'order' && c.method === 'findUnique'))

beforeEach(() => {
  m.dbCalls.length = 0
  m.finished.length = 0
  for (const key of Object.keys(m.answers)) delete m.answers[key]
  vi.clearAllMocks()
  vi.stubEnv(FLAG, '1')
})
afterEach(() => vi.unstubAllEnvs())

describe('an order created before the start date is acknowledged and ignored', () => {
  beforeEach(() => { m.answers['shopifyOrderIngest.findUnique'] = { activatedAt: T0, activatedBy: 'person-1' } })

  it.each([
    ['/webhooks/shopify/orders/create', OLD_ORDER],
    // An old order merely edited after the start: before, an update for an unknown order fell through to a create.
    ['/webhooks/shopify/orders/update', { ...OLD_ORDER, fulfillment_status: 'fulfilled' }],
    ['/webhooks/shopify/orders/update', { ...OLD_ORDER, financial_status: 'voided', cancelled_at: '2026-10-16T09:00:00Z' }],
  ])('%s → 200, nothing written, one log line', async (path, payload) => {
    const response = await deliver(path, payload)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ success: true, ignored: 'before_start_date' })
    expect(writesOrOrderWork()).toEqual([])
    expect(stock.reserveOpenOrder).not.toHaveBeenCalled()
    expect(m.finished).toEqual([{ id: expect.any(String), outcome: 'done' }])
    const lines = vi.mocked(logger.info).mock.calls.filter(([message]) => String(message).includes('before the start date'))
    expect(lines).toHaveLength(1)
    expect(lines[0][1]).toMatchObject({ skip: 'before_start_date', shopifyOrderId: '820001', connectionId: 'conn-1' })
  })

  it.each([
    ['/webhooks/shopify/fulfillments/create', { id: 5, order_id: 820001, created_at: '2026-10-16T08:00:00Z' }],
    ['/webhooks/shopify/refunds/create', { id: 6, order_id: 820001, created_at: '2026-10-16T08:00:00Z', refund_line_items: [{ quantity: 1, line_item: { sku: 'SKU-A' } }] }],
  ])('%s of an order Nexus never imported → 200, nothing written', async (path, payload) => {
    const response = await deliver(path, payload)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ success: true, ignored: 'order_not_in_nexus' })
    expect(writesOrOrderWork()).toEqual([])
  })

  it('a fulfilment of a Nexus order whose purchase date is before the start date is ignored too', async () => {
    m.answers['order.findUnique'] = { purchaseDate: new Date('2026-10-01T00:00:00Z') }
    const response = await deliver('/webhooks/shopify/fulfillments/create', { id: 5, order_id: 820001 })
    expect(response.json()).toEqual({ success: true, ignored: 'before_start_date' })
    expect(writesOrOrderWork()).toEqual([])
  })
})

describe('no start date, or the switch off', () => {
  it('an account with no start date: 200, nothing written', async () => {
    const response = await deliver('/webhooks/shopify/orders/create', { ...OLD_ORDER, created_at: '2026-10-20T00:00:00Z' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ success: true, ignored: 'not_started' })
    expect(writesOrOrderWork()).toEqual([])
  })

  it('the switch off: held (attempt not spent), answered 200, and the database is not even read', async () => {
    vi.stubEnv(FLAG, '')
    const response = await deliver('/webhooks/shopify/orders/create', { ...OLD_ORDER, created_at: '2026-10-20T00:00:00Z' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ success: true, held: true })
    expect(m.finished).toEqual([{ id: expect.any(String), outcome: 'deferred' }])
    expect(m.dbCalls).toEqual([])
  })
})

describe('a replay runs the same door as the receiver', () => {
  it.each([
    ['order/create', 'ingestShopifyOrderCreate'],
    ['order/update', 'ingestShopifyOrderUpdate'],
    ['fulfillment/create', 'ingestShopifyFulfillmentCreate'],
    ['refunds/create', 'ingestShopifyRefundCreate'],
  ] as const)('%s replays through %s, never the bare writer', async (eventType, gated) => {
    expect(await inboundHandlerFor('SHOPIFY', eventType)).toBe(webhooks[gated])
  })

  it('a replayed old order is ignored, not imported', async () => {
    m.answers['shopifyOrderIngest.findUnique'] = { activatedAt: T0, activatedBy: 'person-1' }
    const handler = await inboundHandlerFor('SHOPIFY', 'order/update')
    expect(await handler!(OLD_ORDER, { connectionId: 'conn-1', eventType: 'order/update', channel: 'SHOPIFY' })).toEqual({ ignored: 'before_start_date' })
    expect(writesOrOrderWork()).toEqual([])
  })
})

describe('a stray product webhook never changes a Nexus product', () => {
  it.each([
    ['/webhooks/shopify/products/update', { id: 555, title: 'Motorcycle jacket', updated_at: '2026-10-16T08:00:00Z' }],
    ['/webhooks/shopify/products/delete', { id: 555 }],
  ])('%s, even for a product with the legacy shopifyProductId: no product read or write, no event', async (path, payload) => {
    m.answers['product.findFirst'] = { id: 'prod-1', shopifyProductId: '555', name: 'Giacca da moto', status: 'ACTIVE' }
    const response = await deliver(path, payload)
    expect(response.statusCode).toBe(200)
    expect(m.dbCalls.filter((c) => c.model === 'product')).toEqual([])
    expect(m.dbCalls.filter((c) => /^(create|update|upsert|delete)/.test(c.method))).toEqual([])
    const { productEventService } = await import('../services/product-event.service.js')
    expect(productEventService.emit).not.toHaveBeenCalled()
    expect(m.finished).toEqual([{ id: expect.any(String), outcome: 'done' }])
  })
})

/**
 * Registering Shopify's webhook topics starts Shopify order import. Until NEXUS_ENABLE_SHOPIFY_ORDER_INGEST=1, the
 * route refuses and the service registers nothing; with it on, the service registers only for an account whose order
 * import was started (it has its start date), and only the order topics, app/uninstalled and the e-mail marketing
 * consent topic: never a product or inventory topic. A subscription of another topic already on the shop is listed,
 * never deleted.
 *
 * Only the Shopify transport and the start-date read are mocked; the route and the registration service are the real
 * code, so a `webhookSubscriptionCreate` reaching the mock is a subscription Shopify would have created.
 */
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { permissionForRoute } from '../../lib/auth/permissions-manifest.js'

const mocks = vi.hoisted(() => ({ graphql: vi.fn(), destination: vi.fn(), start: vi.fn(), existing: [] as Array<{ topic: string; endpoint: { callbackUrl: string } }> }))
vi.mock('../../services/shopify/admin-client.js', () => ({ shopifyAdmin: async () => ({ graphql: mocks.graphql }) }))
vi.mock('../../services/shopify/order-ingest-switch.js', async (original) => ({ ...(await original<object>()), shopifyOrderIngestStart: mocks.start }))
vi.mock('../../services/shopify/content-workspace.service.js', () => ({ contentDestination: async (...args: unknown[]) => mocks.destination(...args) }))
import { shopifyLinkedProductsRoutes } from './shopify-linked-products.routes.js'
import { ensureShopifyWebhookSubscriptions, SHOPIFY_TOPIC_REGISTRATIONS } from '../../services/shopify/webhook-registration.service.js'

const FLAG = 'NEXUS_ENABLE_SHOPIFY_ORDER_INGEST'
const creates = () => mocks.graphql.mock.calls.filter(([query]) => String(query).includes('webhookSubscriptionCreate'))
const ORDER_TOPICS = ['ORDERS_CREATE', 'ORDERS_UPDATED', 'FULFILLMENTS_CREATE', 'REFUNDS_CREATE', 'APP_UNINSTALLED', 'CUSTOMERS_EMAIL_MARKETING_CONSENT_UPDATE']

beforeEach(() => {
  vi.clearAllMocks()
  // Everything registration needs is present, so only the switch can stop it.
  vi.stubEnv('NEXUS_PUBLIC_API_URL', 'https://api.nexus.example')
  vi.stubEnv(FLAG, '')
  mocks.destination.mockImplementation(async (_id: string, query: { accountId: string }) => ({ accountId: query.accountId }))
  mocks.start.mockResolvedValue({ since: new Date('2026-10-15T10:00:00.000Z'), by: 'person-1' })
  mocks.existing = []
  mocks.graphql.mockImplementation(async (query: string, vars: { topic?: string }) => query.includes('webhookSubscriptionCreate')
    ? { webhookSubscriptionCreate: { webhookSubscription: { id: `gid://shopify/WebhookSubscription/${vars.topic}` }, userErrors: [] } }
    : { webhookSubscriptions: { nodes: mocks.existing, pageInfo: { hasNextPage: false, endCursor: null } } })
})
afterEach(() => vi.unstubAllEnvs())

async function register() {
  const app = Fastify()
  app.addHook('preHandler', async request => { request.__rbacResolved = { isOwner: false, permissions: new Set(['products.edit']) } })
  await app.register(shopifyLinkedProductsRoutes)
  try { return await app.inject({ method: 'POST', url: '/products/product-1/shopify-linked/webhook-subscriptions?accountId=store-a&market=GLOBAL', payload: {} }) } finally { await app.close() }
}

describe('Shopify webhook registration is refused while Shopify order ingest is off', () => {
  it('keeps the products.edit permission on the route', () => {
    expect(permissionForRoute('POST', '/api/products/:productId/shopify-linked/webhook-subscriptions')).toBe('products.edit')
  })

  it('refuses the route with a 409 and a plain sentence, and asks Shopify nothing', async () => {
    const response = await register()
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ code: 'shopify_order_ingest_off', error: expect.stringContaining(FLAG) })
    expect(response.json().error).toMatch(/^Shopify webhook registration is off/)
    expect(mocks.graphql).not.toHaveBeenCalled()
    expect(mocks.destination).not.toHaveBeenCalled()
  })

  it('treats only the exact value 1 as on', async () => {
    for (const value of ['true', 'yes', 'on', ' 1', '0']) {
      vi.stubEnv(FLAG, value)
      expect((await register()).statusCode, value).toBe(409)
    }
    expect(mocks.graphql).not.toHaveBeenCalled()
  })

  it('registers nothing when the service is called directly (a job or script path)', async () => {
    const result = await ensureShopifyWebhookSubscriptions('store-a')
    expect(result).toEqual({ accountId: 'store-a', live: false, reason: expect.stringContaining(FLAG), perTopic: [] })
    expect(mocks.graphql).not.toHaveBeenCalled()
  })

  it('positive control: with the switch on and the start date recorded, the same request creates the order topics', async () => {
    vi.stubEnv(FLAG, '1')
    const response = await register()
    expect(response.statusCode).toBe(200)
    expect(creates().map(([, vars]) => vars.topic)).toEqual(ORDER_TOPICS)
    expect(response.json().perTopic.map((t: { status: string }) => t.status)).toEqual(ORDER_TOPICS.map(() => 'created'))
    expect(mocks.start).toHaveBeenCalledWith('store-a')
  })
})

describe('only the order topics, and only after the start date is recorded', () => {
  beforeEach(() => vi.stubEnv(FLAG, '1'))

  it('the table holds the order topics, app/uninstalled and the e-mail consent topic, and no product, inventory or privacy topic', () => {
    expect(SHOPIFY_TOPIC_REGISTRATIONS.map(row => row.topic)).toEqual(ORDER_TOPICS)
    expect(SHOPIFY_TOPIC_REGISTRATIONS.map(row => row.topic).filter(topic => /^(PRODUCTS|INVENTORY|SHOP)_/.test(topic))).toEqual([])
    // The one customer topic is the e-mail consent change: no customer create, update, delete or redact subscription.
    expect(SHOPIFY_TOPIC_REGISTRATIONS.map(row => row.topic).filter(topic => /^CUSTOMERS_/.test(topic))).toEqual(['CUSTOMERS_EMAIL_MARKETING_CONSENT_UPDATE'])
  })

  it('an account with no start date registers nothing and asks Shopify nothing', async () => {
    mocks.start.mockResolvedValue(null)
    const result = await ensureShopifyWebhookSubscriptions('store-a')
    expect(result).toEqual({ accountId: 'store-a', live: false, reason: expect.stringMatching(/^Shopify order import has not been started/), perTopic: [] })
    expect(mocks.graphql).not.toHaveBeenCalled()
  })

  it('a product subscription already on the shop is listed and left in place: no delete, no update', async () => {
    mocks.existing = [
      { topic: 'PRODUCTS_UPDATE', endpoint: { callbackUrl: 'https://api.nexus.example/webhooks/shopify/products/update' } },
      { topic: 'METAFIELD_DEFINITIONS_CREATE', endpoint: { callbackUrl: 'https://api.nexus.example/webhooks/shopify/schema' } },
      { topic: 'ORDERS_CREATE', endpoint: { callbackUrl: 'https://api.nexus.example/webhooks/shopify/orders/create' } },
    ]
    const result = await ensureShopifyWebhookSubscriptions('store-a')
    expect(result.perTopic.find(t => t.topic === 'ORDERS_CREATE')?.status).toBe('already_ours')
    expect(creates().map(([, vars]) => vars.topic)).toEqual(ORDER_TOPICS.filter(topic => topic !== 'ORDERS_CREATE'))
    expect(result.leftInPlace).toEqual([
      { topic: 'PRODUCTS_UPDATE', callbackUrl: 'https://api.nexus.example/webhooks/shopify/products/update', detail: expect.stringContaining('a person decides') },
      { topic: 'METAFIELD_DEFINITIONS_CREATE', callbackUrl: 'https://api.nexus.example/webhooks/shopify/schema', detail: 'Not an order topic. Left in place.' },
    ])
    // Only the read and the creates: nothing else was sent to Shopify.
    const sent = mocks.graphql.mock.calls.map(([query]) => String(query))
    expect(sent.filter(query => !query.includes('webhookSubscriptionCreate') && !query.includes('query NexusWebhookSubscriptions'))).toEqual([])
    expect(sent.some(query => /webhookSubscriptionDelete|webhookSubscriptionUpdate/.test(query))).toBe(false)
  })
})

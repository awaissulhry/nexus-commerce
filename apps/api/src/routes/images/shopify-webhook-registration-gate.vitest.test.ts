/**
 * Registering Shopify's twelve webhook topics starts Shopify order ingest: every order Shopify then sends
 * (including an old order that is merely edited) is taken from stock, with no switch and no start time (T0).
 * Until NEXUS_ENABLE_SHOPIFY_ORDER_INGEST=1, the route refuses and the service registers nothing.
 *
 * Only the Shopify transport is mocked; the route and the registration service are the real code, so a
 * `webhookSubscriptionCreate` reaching the mock is a subscription Shopify would have created.
 */
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { permissionForRoute } from '../../lib/auth/permissions-manifest.js'

const mocks = vi.hoisted(() => ({ graphql: vi.fn(), destination: vi.fn() }))
vi.mock('../../services/shopify/admin-client.js', () => ({ shopifyAdmin: async () => ({ graphql: mocks.graphql }) }))
vi.mock('../../services/shopify/content-workspace.service.js', () => ({ contentDestination: async (...args: unknown[]) => mocks.destination(...args) }))
import { shopifyLinkedProductsRoutes } from './shopify-linked-products.routes.js'
import { ensureShopifyWebhookSubscriptions, SHOPIFY_TOPIC_REGISTRATIONS } from '../../services/shopify/webhook-registration.service.js'

const FLAG = 'NEXUS_ENABLE_SHOPIFY_ORDER_INGEST'
const creates = () => mocks.graphql.mock.calls.filter(([query]) => String(query).includes('webhookSubscriptionCreate'))

beforeEach(() => {
  vi.clearAllMocks()
  // Everything registration needs is present, so only the switch can stop it.
  vi.stubEnv('NEXUS_PUBLIC_API_URL', 'https://api.nexus.example')
  vi.stubEnv(FLAG, '')
  mocks.destination.mockImplementation(async (_id: string, query: { accountId: string }) => ({ accountId: query.accountId }))
  mocks.graphql.mockImplementation(async (query: string, vars: { topic?: string }) => query.includes('webhookSubscriptionCreate')
    ? { webhookSubscriptionCreate: { webhookSubscription: { id: `gid://shopify/WebhookSubscription/${vars.topic}` }, userErrors: [] } }
    : { webhookSubscriptions: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } })
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

  it('positive control: with the switch on, the same request reaches Shopify and creates all twelve topics', async () => {
    vi.stubEnv(FLAG, '1')
    const response = await register()
    expect(response.statusCode).toBe(200)
    expect(creates().map(([, vars]) => vars.topic)).toEqual(SHOPIFY_TOPIC_REGISTRATIONS.map(row => row.topic))
    expect(SHOPIFY_TOPIC_REGISTRATIONS.map(row => row.topic)).toEqual(expect.arrayContaining(['ORDERS_CREATE', 'PRODUCTS_UPDATE']))
  })
})

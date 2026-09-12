import { createHmac } from 'node:crypto'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerRawJsonParser } from '../../utils/webhook.js'
import { withWorkspace, workspaceContext } from '../../lib/workspace-context.js'

const mocks = vi.hoisted(() => ({ graphql: vi.fn(), resolve: vi.fn(), publish: vi.fn() }))
vi.mock('./admin-client.js', () => ({ shopifyAdmin: async () => ({ graphql: mocks.graphql }) }))
vi.mock('../connection-resolver.service.js', () => ({ resolveConnection: (...args: unknown[]) => mocks.resolve(...args) }))
vi.mock('../cx/apps.service.js', () => ({ getChannelApp: async () => ({ clientSecret: 'test-secret' }) }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: (...args: unknown[]) => mocks.publish(...args) }))
import { ensureShopifySchemaSubscriptions, registerShopifySchemaWebhook } from './schema-sync.service.js'
const scope = { workspaceId: 'business_test_a', actorUserId: null, membershipId: null, roleKeys: [] }
const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_PUBLIC_API_URL', 'https://api.nexus.example')
  mocks.resolve.mockImplementation(async () => ({ id: 'store-A', channelType: 'SHOPIFY', isActive: true, region: 'store-a.myshopify.com' }))
})
afterEach(() => vi.unstubAllEnvs())

describe('Shopify attribute notifications', () => {
  it('registers each missing topic against the exact business and store, and keeps existing subscriptions', async () => {
    mocks.graphql.mockImplementation(async (query, vars) => {
      if (query.includes('query NexusSchemaSubscriptions')) return { webhookSubscriptions: page([{ topic: 'METAFIELD_DEFINITIONS_CREATE', endpoint: { callbackUrl: 'https://api.nexus.example/webhooks/shopify/attributes/business_test_a/store-A' } }]) }
      return { webhookSubscriptionCreate: { webhookSubscription: { id: vars.topic }, userErrors: [] } }
    })
    await expect(withWorkspace(scope, () => ensureShopifySchemaSubscriptions('store-A'))).resolves.toEqual({ live: true })
    const writes = mocks.graphql.mock.calls.filter(([q]) => q.startsWith('mutation'))
    expect(writes.map(([, v]) => v.topic)).toEqual(['METAFIELD_DEFINITIONS_UPDATE', 'METAFIELD_DEFINITIONS_DELETE'])
    expect(writes.every(([, v]) => v.subscription.callbackUrl.endsWith('/business_test_a/store-A'))).toBe(true)
  })
  it('does not claim live synchronization without a public HTTPS callback', async () => {
    vi.stubEnv('NEXUS_PUBLIC_API_URL', 'http://localhost:8091')
    expect(await ensureShopifySchemaSubscriptions('store-A')).toMatchObject({ live: false })
    expect(mocks.graphql).not.toHaveBeenCalled()
  })
  it('does not report success after a rejected subscription', async () => {
    mocks.graphql.mockResolvedValueOnce({ webhookSubscriptions: page([]) }).mockResolvedValueOnce({ webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ message: 'Denied' }] } })
    await expect(withWorkspace(scope, () => ensureShopifySchemaSubscriptions('store-A'))).rejects.toThrow('Denied')
  })
  it('verifies HMAC and store identity before publishing in the addressed business', async () => {
    const app = Fastify(); registerRawJsonParser(app); registerShopifySchemaWebhook(app)
    const body = JSON.stringify({ id: 'gid://shopify/MetafieldDefinition/1', owner_type: 'PRODUCT' })
    const headers = { 'content-type': 'application/json', 'x-shopify-topic': 'metafield_definitions/delete', 'x-shopify-shop-domain': 'store-a.myshopify.com', 'x-shopify-hmac-sha256': createHmac('sha256', 'test-secret').update(body).digest('base64') }
    const url = '/webhooks/shopify/attributes/business_test_a/store-A'
    mocks.publish.mockImplementation(() => expect(workspaceContext()?.workspaceId).toBe('business_test_a'))
    try {
      expect((await app.inject({ method: 'POST', url, headers, payload: body })).statusCode).toBe(200)
      expect(mocks.publish).toHaveBeenCalledWith({ type: 'shopify.schema.changed', accountId: 'store-A', ts: expect.any(Number) })
      mocks.publish.mockClear(); mocks.resolve.mockClear()
      expect((await app.inject({ method: 'POST', url, headers: { ...headers, 'x-shopify-hmac-sha256': 'bad' }, payload: body })).statusCode).toBe(401)
      expect(mocks.resolve).not.toHaveBeenCalled()
      expect((await app.inject({ method: 'POST', url, headers: { ...headers, 'x-shopify-shop-domain': 'store-b.myshopify.com' }, payload: body })).statusCode).toBe(403)
      expect(mocks.publish).not.toHaveBeenCalled()
    } finally { await app.close() }
  })
})

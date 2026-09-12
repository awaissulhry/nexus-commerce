import { runInNewContext } from 'node:vm'
import { createHmac } from 'node:crypto'
import { apiContentSecurityPolicy } from '../lib/api-content-security-policy.js'
import { verifyShopifyCallbackHmac } from '../services/cx/connectors/shopify/auth.js'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { complete, start } = vi.hoisted(() => ({ complete: vi.fn(), start: vi.fn() }))
vi.mock('../services/cx/oauth.service.js', () => ({ complete, start, OAuthFlowError: class extends Error {} }))
vi.mock('../services/cx/catalog.js', () => ({
  tryGetChannelSpec: (key: string) => key === 'EBAY'
    ? { channelType: 'EBAY', displayName: 'eBay' }
    : key === 'AMAZON_SP'
      ? { channelType: 'AMAZON', displayName: 'Amazon Seller' }
      : ['SHOPIFY', 'ETSY'].includes(key)
        ? { channelType: key, displayName: key === 'SHOPIFY' ? 'Shopify' : 'Etsy' }
      : null,
}))
vi.mock('../db.js', () => ({ default: { channelConnection: { findUniqueOrThrow: vi.fn(async () => ({ accountLabel: 'Test account', displayName: 'Test account', channelType: 'SHOPIFY' })) } } }))
vi.mock('../services/connection-resolver.service.js', () => ({ CONNECTION_PUBLIC_SELECT: {} }))
vi.mock('../services/cx/events.service.js', () => ({ recordConnectionEvent: vi.fn() }))
vi.mock('../services/cx/connectors/amazon-sp/self-authorization.js', () => ({
  importAmazonEnvironmentAuthorization: vi.fn(), AmazonSelfAuthorizationError: class extends Error {},
}))
import routes from './cx-connect.routes.js'

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('connection callback page', () => {
  it.each(['shopify', 'etsy'])('allows only nonce-bearing callback scripts/styles through the production CSP for %s', async channel => {
    complete.mockResolvedValue({ workspaceId: 'business', connectionId: `${channel}-1`, identity: { userId: 'fixture' }, placement: 'new', scopeDrift: [] })
    const app = Fastify()
    app.addHook('onSend', async (request, reply, payload) => {
      reply.header('Content-Security-Policy', apiContentSecurityPolicy(request.url, reply))
      return payload
    })
    await app.register(cookie)
    await app.register(routes, { prefix: '/api' })
    try {
      const response = await app.inject({ url: `/api/cx/callback/${channel}?state=attempt&code=fixture` })
      expect(response.statusCode).toBe(200)
      const nonce = response.body.match(/<script nonce="([^"]+)">/)?.[1]
      expect(nonce).toBeTruthy()
      expect(response.body).toContain(`<style nonce="${nonce}">`)
      expect(response.headers['content-security-policy']).toContain(`script-src 'nonce-${nonce}'`)
      expect(response.headers['content-security-policy']).toContain(`style-src 'nonce-${nonce}'`)
      expect(response.headers['content-security-policy']).not.toContain('unsafe-inline')
      const again = await app.inject({ url: `/api/cx/callback/${channel}?state=attempt&code=fixture` })
      expect(again.headers['content-security-policy']).not.toBe(response.headers['content-security-policy'])
      const other = await app.inject({ url: '/api/not-an-html-page' })
      expect(other.headers['content-security-policy']).not.toContain('script-src')
    } finally { await app.close() }
  })

  it('relays once and removes only the Nexus marker before verifying Shopify’s original signed fields', async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    const query = { code: 'fixture-code', shop: 'fixture.myshopify.com', state: 'attempt', timestamp: '1788883200' }
    const hmac = createHmac('sha256', 'fixture-secret').update(Object.entries(query).sort().map(([key, value]) => `${key}=${value}`).join('&')).digest('hex')
    const params = new URLSearchParams({ ...query, hmac })
    complete.mockImplementationOnce(async ({ query: signedQuery }) => {
      expect(signedQuery).toEqual({ ...query, hmac })
      expect(verifyShopifyCallbackHmac(signedQuery, 'fixture-secret')).toBe(true)
      return { workspaceId: 'business', connectionId: 'shopify-1', identity: { userId: 'fixture' }, placement: 'new', scopeDrift: [] }
    })
    const app = Fastify()
    await app.register(cookie)
    await app.register(routes, { prefix: '/api' })
    try {
      const relay = await app.inject({ url: `/api/cx/callback/shopify?${params}` })
      expect(relay.statusCode).toBe(302)
      const location = new URL(String(relay.headers.location))
      expect(location.pathname).toBe('/backend/api/cx/callback/shopify')
      expect(location.searchParams.get('nexus_callback_relay')).toBe('1')
      expect(complete).not.toHaveBeenCalled()
      const result = await app.inject({ url: `/api/cx/callback/shopify${location.search}`, headers: { cookie: 'nexus_oauth_attempt=fixture' } })
      expect(result.statusCode).toBe(200)
      expect(complete).toHaveBeenCalledOnce()
    } finally { await app.close() }
  })

  it('preserves the verified destination and state, escapes provider labels, and correlates acknowledgements', async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    const sellerName = '</script><script>throw new Error("injected")</script>'
    complete.mockResolvedValue({ workspaceId: 'chosen-business', connectionId: 'seller-1', identity: { username: sellerName }, placement: 'new', scopeDrift: [] })
    const app = Fastify()
    await app.register(cookie)
    await app.register(routes, { prefix: '/api' })
    try {
      const response = await app.inject({ url: '/api/cx/callback/ebay?state=attempt-1&code=fixture-code', headers: { cookie: 'nexus_oauth_attempt-1=fixture-nonce' } })
      expect(response.statusCode).toBe(200)
      expect(response.headers['cache-control']).toBe('no-store')
      const scripts = [...response.body.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)]
      expect(scripts).toHaveLength(1)
      const close = vi.fn(), notify = vi.fn()
      let onMessage: (event: unknown) => void = () => {}
      runInNewContext(scripts[0][1], {
        window: { close, opener: { postMessage: notify }, addEventListener: (_name: string, fn: typeof onMessage) => { onMessage = fn } },
        setTimeout: () => 0,
      })
      const [message, origin] = notify.mock.calls[0]
      expect(message).toMatchObject({ workspaceId: 'chosen-business', state: 'attempt-1', channelKey: 'EBAY', sellerName })
      onMessage({ origin, data: { type: 'nexus:ack', state: 'other-attempt' } })
      onMessage({ origin: 'https://foreign.example.test', data: { type: 'nexus:ack', state: 'attempt-1' } })
      expect(close).not.toHaveBeenCalled()
      onMessage({ origin, data: { type: 'nexus:ack', state: 'attempt-1' } })
      expect(close).toHaveBeenCalledOnce()
    } finally { await app.close() }
  })

  it('accepts the Seller Central callback name and keeps Amazon’s callback fields intact', async () => {
    complete.mockResolvedValue({ workspaceId: 'chosen-business', connectionId: 'amazon-1', identity: { userId: 'SELLERONE' }, placement: 'adopt', scopeDrift: [] })
    const app = Fastify()
    await app.register(cookie)
    await app.register(routes, { prefix: '/api' })
    try {
      const response = await app.inject({
        url: '/api/cx/callback/amazon_sp?state=attempt-amazon&spapi_oauth_code=code-1&selling_partner_id=SELLERONE',
        headers: { cookie: 'nexus_oauth_attempt-amazon=fixture-nonce' },
      })
      expect(response.statusCode).toBe(200)
      expect(complete).toHaveBeenLastCalledWith(expect.objectContaining({
        channelKey: 'AMAZON_SP',
        query: expect.objectContaining({ spapi_oauth_code: 'code-1', selling_partner_id: 'SELLERONE' }),
      }))
      expect(response.body).toContain('Amazon Seller connected')
    } finally { await app.close() }
  })
})

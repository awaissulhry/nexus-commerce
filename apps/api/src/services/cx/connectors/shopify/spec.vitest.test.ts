import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '../../catalog.js'
import { SHOPIFY_REQUIRED_SCOPES, shopifySpec } from './spec.js'

const handle = (region: string | null = 'xavia-shop.myshopify.com'): ConnectionHandle => ({
  id: 'shopify-connection',
  channelKey: 'SHOPIFY',
  channelType: 'SHOPIFY',
  region,
  grantedScopes: [],
  identity: null,
  token: async () => 'shopify-access-token',
})

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function shopResponse(status = 200) {
  return new Response(JSON.stringify(status === 200 ? {
    data: {
      shop: { id: 'gid://shopify/Shop/42', name: 'Xavia Shop', myshopifyDomain: 'xavia-shop.myshopify.com', primaryDomain: { host: 'shop.xavia.example' } },
      currentAppInstallation: { accessScopes: [{ handle: 'write_products' }, { handle: 'write_orders' }] },
    },
  } : { errors: [{ message: 'Unauthorized' }] }), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('Shopify connector catalogue entry', () => {
  it('requests broad commerce access while keeping restricted permissions separate', () => {
    expect(shopifySpec.available).toBe(true)
    expect(new Set(SHOPIFY_REQUIRED_SCOPES).size).toBe(SHOPIFY_REQUIRED_SCOPES.length)
    expect(SHOPIFY_REQUIRED_SCOPES).toEqual(expect.arrayContaining([
      'write_products', 'write_inventory', 'write_orders', 'write_customers', 'write_themes', 'write_validations',
      'write_fulfillments', 'write_markets', 'write_files', 'write_translations', 'read_shopify_payments_payouts',
    ]))
    expect(SHOPIFY_REQUIRED_SCOPES).not.toContain('read_all_orders')
    // Both are rejected by the Dev Dashboard for a newly registered standalone app.
    expect(SHOPIFY_REQUIRED_SCOPES).not.toContain('read_marketplace_fulfillment_orders')
    expect(SHOPIFY_REQUIRED_SCOPES).not.toContain('read_merchant_approval_signals')
    expect(shopifySpec.auth.reviewGatedScopes).toEqual(expect.arrayContaining([
      { scope: 'read_all_orders', reason: 'Shopify approval (orders older than 60 days)' },
      { scope: 'read_marketplace_fulfillment_orders', reason: 'Shopify marketplace channel app access' },
      { scope: 'read_merchant_approval_signals', reason: 'Must be enabled for this channel app by Shopify' },
    ]))
    expect(shopifySpec.auth.identityRequired).toBe(true)
    expect(shopifySpec.auth.accessTokenLifetimeSec).toBeNull()
  })

  it('builds authorization and token URLs only on the validated store host', () => {
    expect(shopifySpec.auth.authorizeUrl?.({ region: 'xavia-shop.myshopify.com', environment: 'production' }))
      .toBe('https://xavia-shop.myshopify.com/admin/oauth/authorize')
    expect(shopifySpec.auth.tokenUrl({ region: 'xavia-shop.myshopify.com', environment: 'production' }))
      .toBe('https://xavia-shop.myshopify.com/admin/oauth/access_token')
  })
})

describe('Shopify identity and heartbeat', () => {
  it.each(['partial', 'missing-scopes', 'wrong-domain', 'malformed-id'])('rejects unverified GraphQL identity data: %s', async kind => {
    const data = await shopResponse().json()
    if (kind === 'partial') data.errors = [{ message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } }]
    if (kind === 'missing-scopes') delete data.data.currentAppInstallation
    if (kind === 'wrong-domain') data.data.shop.myshopifyDomain = 'different.myshopify.com'
    if (kind === 'malformed-id') data.data.shop.id = { unexpected: true }
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(data)))
    await expect(shopifySpec.identity(handle())).resolves.toBeNull()
    await expect(shopifySpec.heartbeat(handle())).resolves.toMatchObject({ ok: false })
  })

  it('recognizes throttling carried inside HTTP 200 GraphQL errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] })))
    await expect(shopifySpec.heartbeat(handle())).resolves.toMatchObject({ ok: false, errorClass: 'rate_limited' })
  })

  it('reads the immutable shop id, friendly name, domain, and actual granted scopes', async () => {
    fetchMock.mockImplementation(async () => shopResponse())
    await expect(shopifySpec.identity(handle())).resolves.toMatchObject({
      userId: 'gid://shopify/Shop/42',
      username: 'xavia-shop.myshopify.com',
      storeName: 'Xavia Shop',
      storeUrl: 'https://shop.xavia.example',
    })
    const heartbeat = await shopifySpec.heartbeat(handle())
    expect(heartbeat).toMatchObject({ ok: true, scopes: ['write_products', 'write_orders'] })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://xavia-shop.myshopify.com/admin/api/2026-07/graphql.json')
    expect((init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shopify-access-token')
  })

  it('classifies revoked credentials and rejects an invalid stored domain before any request', async () => {
    fetchMock.mockImplementation(async () => shopResponse(401))
    await expect(shopifySpec.heartbeat(handle())).resolves.toMatchObject({ ok: false, errorClass: 'auth_revoked' })
    fetchMock.mockClear()
    await expect(shopifySpec.heartbeat(handle('xavia.myshopify.com.attacker.example'))).resolves.toMatchObject({ ok: false, errorClass: 'configuration' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

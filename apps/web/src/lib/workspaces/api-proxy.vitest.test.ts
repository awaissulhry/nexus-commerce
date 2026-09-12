import { afterEach, expect, it, vi } from 'vitest'
import { proxyBackend } from './api-proxy'
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
it('keeps verified-request inputs and strips caller-forged internal routing headers', async () => {
  vi.stubEnv('NEXUS_API_PROXY_TARGET', 'http://api.example.test')
  const fetcher = vi.fn(async () => new Response('ok', { headers: { 'set-cookie': 'oauth_nonce=test; Path=/api/cx/callback; HttpOnly', 'cache-control': 'public' } }))
  vi.stubGlobal('fetch', fetcher)
  const response = await proxyBackend(new Request('http://web.example.test/backend/api/products?sku=A', { headers: { cookie: 'nexus_session=test', 'x-nexus-csrf': 'test-csrf', 'x-nexus-workspace-id': 'business-a', 'x-nexus-page-workspace': 'forged', 'x-forwarded-host': 'attacker.example.test' } }), ['api', 'products'])
  const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit]
  expect(url.href).toBe('http://api.example.test/api/products?sku=A')
  const headers = new Headers(init.headers)
  expect(headers.get('x-nexus-workspace-id')).toBe('business-a')
  expect(headers.get('cookie')).toBe('nexus_session=test')
  expect(headers.get('x-nexus-csrf')).toBe('test-csrf')
  expect(headers.has('x-nexus-page-workspace')).toBe(false)
  expect(headers.has('x-forwarded-host')).toBe(false)
  expect(init.redirect).toBe('manual')
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('set-cookie')).toContain('Path=/backend/api/cx/callback')
})
it('refuses path traversal before making a backend request', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  for (const path of [['api', '..', 'admin'], ['api', 'orders/private'], ['admin']]) expect((await proxyBackend(new Request('http://web.example.test/backend/api'), path)).status).toBe(400)
  expect(fetcher).not.toHaveBeenCalled()
})

it.each(['shopify', 'etsy'])('preserves %s callback CSP and clears the browser’s relayed nonce path', async channel => {
  vi.stubEnv('NEXUS_API_PROXY_TARGET', 'https://api.example.test')
  const policy = "default-src 'none'; script-src 'nonce-fixture'; style-src 'nonce-fixture'"
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<script nonce="fixture"></script>', {
    headers: { 'content-security-policy': policy, 'content-type': 'text/html', 'set-cookie': 'nexus_oauth_attempt=; Path=/api/cx/callback; Max-Age=0; HttpOnly; Secure' },
  })))
  const response = await proxyBackend(new Request(`https://web.example.test/backend/api/cx/callback/${channel}?state=attempt&nexus_callback_relay=1`), ['api', 'cx', 'callback', channel])
  expect(response.headers.get('content-security-policy')).toBe(policy)
  expect(response.headers.get('set-cookie')).toContain('Path=/backend/api/cx/callback')
  expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
})

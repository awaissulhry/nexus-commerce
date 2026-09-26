import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../../apps.service.js', () => ({ getChannelApp: vi.fn(async () => ({ clientId: 'synthetic-id', clientSecret: 'synthetic-secret' })), storeSigningKey: vi.fn(), recordSigningKeyExpiry: vi.fn() }))
vi.mock('../../events.service.js', () => ({ recordConnectionEvent: vi.fn() }))
vi.mock('../../token.service.js', () => ({ getAccessToken: vi.fn() }))
import { ebayAppToken } from './client.js'
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'synthetic-app-token' })))) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('bounds the application-token request at30 seconds and refuses redirects carrying app credentials', async () => {
  const controller = new AbortController(), timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
  expect(await ebayAppToken('sandbox')).toBe('synthetic-app-token')
  expect(timeout).toHaveBeenCalledWith(30_000)
  expect(fetch).toHaveBeenCalledWith('https://api.sandbox.ebay.com/identity/v1/oauth2/token', expect.objectContaining({ signal: controller.signal, redirect: 'error' }))
})
it.each([{}, { access_token: null }, { access_token: '' }, { access_token: '   ' }, { access_token: 5 }])('refuses a malformed token response %j', async body => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(body)))
  await expect(ebayAppToken('sandbox')).rejects.toThrow(/token/i)
})
it('propagates deadline abortion while the token response body is stalled', async () => {
  const controller = new AbortController(); vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
  let release!: () => void
  vi.mocked(fetch).mockImplementationOnce(async (_url, options) => ({ ok: true, status: 200, text: () => new Promise<string>((resolve, reject) => {
    release = () => resolve('{"access_token":"late"}')
    options?.signal?.addEventListener('abort', () => reject(new DOMException('Timeout', 'TimeoutError')), { once: true })
  }) } as Response))
  const pending = ebayAppToken('sandbox').then(value => ({ value }), error => ({ error }))
  await new Promise(resolve => setImmediate(resolve)); controller.abort()
  const result = await Promise.race([pending, new Promise(resolve => setImmediate(() => resolve('still waiting')))])
  release(); await pending
  expect(result).toMatchObject({ error: { name: 'TimeoutError' } })
})

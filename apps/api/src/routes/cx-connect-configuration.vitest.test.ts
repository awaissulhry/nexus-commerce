import { randomBytes } from 'node:crypto'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  channelApp: { findUnique: vi.fn() },
  oAuthSession: { create: vi.fn() },
  connectionEvent: { create: vi.fn() },
}))
vi.mock('../db.js', () => ({ default: db }))
vi.mock('../utils/logger.js', async importOriginal => ({
  ...await importOriginal<typeof import('../utils/logger.js')>(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import '../services/cx/connectors/shopify/spec.js'
import '../services/cx/connectors/etsy/spec.js'
import { __appsTest } from '../services/cx/apps.service.js'
import { __test, encryptCredentials } from '../lib/crypto.js'
import routes from './cx-connect.routes.js'

beforeEach(() => {
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '0')
  vi.stubEnv('SHOPIFY_APP_CLIENT_ID', '')
  vi.stubEnv('SHOPIFY_APP_CLIENT_SECRET', '')
  vi.stubEnv('ETSY_API_KEY', '')
  vi.stubEnv('ETSY_SHARED_SECRET', '')
  vi.stubEnv('NEXUS_KMS_KEY_ID', '')
  vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64'))
  vi.stubEnv('NEXUS_PUBLIC_API_URL', 'https://local-tunnel.example.test')
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('NEXUS_SHOPIFY_LOCAL_OAUTH', '0')
  vi.stubEnv('COOKIE_SECURE', 'true')
  __test.resetKeyCache()
  __appsTest()
  db.channelApp.findUnique.mockResolvedValue(null)
  db.oAuthSession.create.mockResolvedValue({})
  db.connectionEvent.create.mockResolvedValue({})
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Setup checks must not contact providers') }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); __appsTest(); __test.resetKeyCache() })

async function server() {
  const app = Fastify()
  await app.register(cookie)
  await app.register(routes, { prefix: '/api' })
  return app
}
function credentials(channel: string) {
  vi.stubEnv(channel === 'shopify' ? 'SHOPIFY_APP_CLIENT_ID' : 'ETSY_API_KEY', 'fixture-client')
  vi.stubEnv(channel === 'shopify' ? 'SHOPIFY_APP_CLIENT_SECRET' : 'ETSY_SHARED_SECRET', 'fixture-secret')
}

describe('real app credential resolution through connection HTTP routes', () => {
  it.each(['shopify', 'etsy'])('%s missing configuration is visible before sign-in and start returns 503 without a session', async channel => {
    const app = await server()
    try {
      const check = await app.inject(`/api/cx/connect/${channel}/readiness`)
      expect(check.statusCode).toBe(200)
      expect(check.headers['cache-control']).toBe('no-store')
      expect(check.json()).toMatchObject({ ready: false, code: 'channel_unavailable', error: expect.stringContaining('not set up on this Nexus server') })
      const start = await app.inject({ method: 'POST', url: `/api/cx/connect/${channel}/start`, payload: { region: 'fixture.myshopify.com' } })
      expect(start.statusCode).toBe(503)
      expect(start.json()).toMatchObject({ success: false, code: 'channel_unavailable', error: check.json().error })
      expect(start.headers['set-cookie']).toBeUndefined()
      expect(start.body).not.toContain('ChannelApp')
      expect(db.oAuthSession.create).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    } finally { await app.close() }
  })

  it.each(['shopify', 'etsy'])('%s recovers after credentials are configured and builds a real consent URL', async channel => {
    const app = await server()
    try {
      expect((await app.inject(`/api/cx/connect/${channel}/readiness`)).json().ready).toBe(false)
      credentials(channel)
      const check = await app.inject(`/api/cx/connect/${channel}/readiness`)
      expect(check.json()).toEqual({ ready: true })
      expect(db.oAuthSession.create).not.toHaveBeenCalled()
      const start = await app.inject({ method: 'POST', url: `/api/cx/connect/${channel}/start`, payload: { region: channel === 'shopify' ? 'fixture.myshopify.com' : undefined } })
      expect(start.statusCode).toBe(200)
      const url = new URL(start.json().authUrl)
      expect(url.hostname).toBe(channel === 'shopify' ? 'fixture.myshopify.com' : 'www.etsy.com')
      expect(url.searchParams.get('client_id')).toBe('fixture-client')
      expect(url.searchParams.get('redirect_uri')).toBe(`https://local-tunnel.example.test/api/cx/callback/${channel}`)
      expect(start.headers['set-cookie']).toBeTruthy()
      expect(db.oAuthSession.create).toHaveBeenCalledOnce()
      expect(start.body).not.toContain('fixture-secret')
      expect(fetch).not.toHaveBeenCalled()
    } finally { await app.close() }
  })

  it.each(['shopify', 'etsy'])('%s refuses incomplete stored credentials instead of using a different env app', async channel => {
    credentials(channel)
    db.channelApp.findUnique.mockResolvedValue({ clientId: 'stored-client', clientSecretEnc: null, redirectUris: [], extra: null })
    const app = await server()
    try {
      const result = await app.inject(`/api/cx/connect/${channel}/readiness`)
      expect(result.json()).toMatchObject({ ready: false, error: expect.stringContaining('both the app key and secret') })
      expect(db.oAuthSession.create).not.toHaveBeenCalled()
    } finally { await app.close() }
  })

  it.each(['', 'http://localhost:8091', 'https://user:password@example.test', 'https://example.test/#fragment'])('refuses callback configuration %j before creating a session', async origin => {
    credentials('shopify')
    vi.stubEnv('NEXUS_PUBLIC_API_URL', origin)
    const app = await server()
    try {
      expect((await app.inject('/api/cx/connect/shopify/readiness')).json()).toMatchObject({ ready: false, error: expect.stringContaining('public HTTPS callback URL') })
      const result = await app.inject({ method: 'POST', url: '/api/cx/connect/shopify/start', payload: { region: 'fixture.myshopify.com' } })
      expect(result.statusCode).toBe(503)
      expect(db.oAuthSession.create).not.toHaveBeenCalled()
    } finally { await app.close() }
  })

  it('reads encrypted app credentials and honors the registered stored callback', async () => {
    const { blob } = await encryptCredentials({ clientSecret: 'stored-secret' })
    db.channelApp.findUnique.mockResolvedValue({ clientId: 'stored-client', clientSecretEnc: blob, redirectUris: ['https://registered.example.test/api/cx/callback/shopify'], extra: null })
    credentials('shopify')
    const app = await server()
    try {
      const check = await app.inject('/api/cx/connect/shopify/readiness')
      expect(check.json()).toEqual({ ready: true })
      expect(check.body).not.toContain('stored-')
      const start = await app.inject({ method: 'POST', url: '/api/cx/connect/shopify/start', payload: { region: 'fixture.myshopify.com' } })
      const url = new URL(start.json().authUrl)
      expect(url.searchParams.get('client_id')).toBe('stored-client')
      expect(url.searchParams.get('redirect_uri')).toBe('https://registered.example.test/api/cx/callback/shopify')
      expect(start.body).not.toContain('stored-secret')
    } finally { await app.close() }
  })

  it.each(['localhost', '127.0.0.1', '[::1]'])('supports explicit Shopify development on %s with a cookie returned by the same browser', async host => {
    credentials('shopify')
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXUS_SHOPIFY_LOCAL_OAUTH', '1')
    vi.stubEnv('NEXUS_PUBLIC_API_URL', `http://${host}:8091`)
    const app = await server()
    try {
      expect((await app.inject('/api/cx/connect/shopify/readiness')).json()).toEqual({ ready: true })
      const result = await app.inject({ method: 'POST', url: '/api/cx/connect/shopify/start', payload: { region: 'fixture.myshopify.com' } })
      expect(result.statusCode).toBe(200)
      expect(new URL(result.json().authUrl).searchParams.get('redirect_uri')).toBe(`http://${host}:8091/api/cx/callback/shopify`)
      const cookie = String(result.headers['set-cookie'])
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Lax')
      expect(cookie).toContain('Path=/api/cx/callback')
      expect(cookie).not.toContain('Secure')
    } finally { await app.close() }
  })

  it.each([
    ['production', '1', 'shopify', 'http://localhost:8091/api/cx/callback/shopify'],
    ['development', '0', 'shopify', 'http://localhost:8091/api/cx/callback/shopify'],
    ['development', '1', 'etsy', 'http://localhost:8091/api/cx/callback/etsy'],
    ['development', '1', 'shopify', 'http://192.168.1.10:8091/api/cx/callback/shopify'],
    ['development', '1', 'shopify', 'http://localhost.attacker.test/api/cx/callback/shopify'],
    ['development', '1', 'shopify', 'http://localhost:8091/another-route'],
    ['development', '1', 'shopify', 'http://localhost:8091/api/cx/callback/shopify?next=external'],
    ['development', '1', 'shopify', 'http://localhost:8091/api/cx/callback/shopify#fragment'],
    ['development', '1', 'shopify', 'http://user:password@localhost:8091/api/cx/callback/shopify'],
  ])('rejects an unsafe local callback: %s/%s/%s/%s', async (mode, flag, channel, redirect) => {
    const { blob } = await encryptCredentials({ clientSecret: 'fixture-secret' })
    db.channelApp.findUnique.mockResolvedValue({ clientId: 'fixture-client', clientSecretEnc: blob, redirectUris: [redirect], extra: null })
    vi.stubEnv('NODE_ENV', mode)
    vi.stubEnv('NEXUS_SHOPIFY_LOCAL_OAUTH', flag)
    const app = await server()
    try {
      expect((await app.inject(`/api/cx/connect/${channel}/readiness`)).json()).toMatchObject({ ready: false })
      const result = await app.inject({ method: 'POST', url: `/api/cx/connect/${channel}/start`, payload: { region: 'fixture.myshopify.com' } })
      expect(result.statusCode).toBe(503)
      expect(db.oAuthSession.create).not.toHaveBeenCalled()
    } finally { await app.close() }
  })

  it('keeps HTTPS cookies secure even when local Shopify development is enabled', async () => {
    credentials('shopify')
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXUS_SHOPIFY_LOCAL_OAUTH', '1')
    const app = await server()
    try {
      const result = await app.inject({ method: 'POST', url: '/api/cx/connect/shopify/start', payload: { region: 'fixture.myshopify.com' } })
      expect(result.statusCode).toBe(200)
      expect(result.headers['set-cookie']).toContain('Secure')
      expect(result.headers['set-cookie']).toContain('SameSite=None')
    } finally { await app.close() }
  })

  it('reports unreadable encrypted credentials as setup, without exposing key details', async () => {
    const { blob } = await encryptCredentials({ clientSecret: 'stored-secret' })
    __test.resetKeyCache()
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64'))
    db.channelApp.findUnique.mockResolvedValue({ clientId: 'stored-client', clientSecretEnc: blob, redirectUris: [], extra: null })
    const app = await server()
    try {
      const check = await app.inject('/api/cx/connect/shopify/readiness')
      expect(check.json()).toMatchObject({ ready: false, error: expect.stringContaining('server encryption configuration') })
      expect(db.oAuthSession.create).not.toHaveBeenCalled()
    } finally { await app.close() }
  })

  it('keeps unexpected database errors private for both check and start', async () => {
    db.channelApp.findUnique.mockRejectedValue(new Error('database password=private-fixture failed'))
    const app = await server()
    try {
      const check = await app.inject('/api/cx/connect/shopify/readiness')
      expect(check.statusCode).toBe(503)
      expect(check.json()).toMatchObject({ ready: false, code: 'setup_check_failed' })
      const start = await app.inject({ method: 'POST', url: '/api/cx/connect/shopify/start', payload: { region: 'fixture.myshopify.com' } })
      expect(start.statusCode).toBe(500)
      expect(check.body + start.body).not.toContain('private-fixture')
      expect(db.oAuthSession.create).not.toHaveBeenCalled()
    } finally { await app.close() }
  })
})

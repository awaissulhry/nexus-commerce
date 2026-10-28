import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { LOCAL_COOKIE_SECRET } from '../env'
import { buildApp, type AppConfig } from './app'
import { requestIdFor } from './ids'
import { defineManifest, defineRoutes, PUBLIC } from './manifest'
import { BODY_LIMIT_BYTES, SECURITY_HEADERS } from './security'

const WEB = 'http://localhost:3200'
const CONFIG: AppConfig = { environment: 'test', webOrigin: WEB, trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET }

const routes = defineRoutes(
  'probe',
  defineManifest({
    'POST /write': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
    'GET /boom': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  }),
  async (app) => {
    app.post('/write', async () => ({ written: true }))
    app.get('/boom', async () => {
      throw new Error('boom')
    })
  },
)

const apps: FastifyInstance[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})
async function boot(config: Partial<AppConfig> = {}): Promise<FastifyInstance> {
  const app = await buildApp({ ...CONFIG, ...config }, { routes: [routes] })
  apps.push(app)
  return app
}

describe('security headers', () => {
  it('are on every answer: success, error and not found', async () => {
    const app = await boot()
    for (const url of ['/health', '/boom', '/missing']) {
      const response = await app.inject({ method: 'GET', url })
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(response.headers[name], `${url} ${name}`).toBe(value)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['x-powered-by']).toBeUndefined()
      expect(response.headers.server).toBeUndefined()
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    }
  })
})

describe('request ids', () => {
  it('keeps a plain id the caller sends and replaces anything else', async () => {
    const app = await boot()
    const kept = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'web-0123456789' } })
    expect(kept.headers['x-request-id']).toBe('web-0123456789')
    const replaced = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'x\n{"level":60}' } })
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
  })

  it('makes a UUIDv7 when none is sent', () => {
    expect(requestIdFor({ headers: {} } as never)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/)
  })
})

describe('CORS: only the web origin', () => {
  it('allows the web origin with credentials, and exposes the request id', async () => {
    const app = await boot()
    const response = await app.inject({ method: 'POST', url: '/write', headers: { origin: WEB } })
    expect(response.statusCode).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBe(WEB)
    expect(response.headers['access-control-allow-credentials']).toBe('true')
    expect(response.headers['access-control-expose-headers']).toBe('x-request-id')
    expect(response.headers.vary).toBe('Origin')
  })

  it('answers a preflight from the web origin, also for a route that only has POST', async () => {
    const app = await boot()
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/write',
      headers: { origin: WEB, 'access-control-request-method': 'POST' },
    })
    expect(response.statusCode).toBe(204)
    expect(response.headers['access-control-allow-methods']).toContain('POST')
    expect(response.headers['access-control-allow-headers']).toContain('x-csrf-token')
    expect(response.headers['access-control-allow-headers']).toContain('x-factory-link')
  })

  it('refuses a preflight and a write from any other origin', async () => {
    const app = await boot()
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/write',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    })
    expect(preflight.statusCode).toBe(403)
    expect(preflight.json().error.code).toBe('origin_not_allowed')
    const write = await app.inject({ method: 'POST', url: '/write', headers: { origin: 'https://evil.example' } })
    expect(write.statusCode).toBe(403)
    expect(write.headers['access-control-allow-origin']).toBeUndefined()
    const lookalike = await app.inject({ method: 'POST', url: '/write', headers: { origin: `${WEB}.evil.example` } })
    expect(lookalike.statusCode).toBe(403)
    const opaque = await app.inject({ method: 'POST', url: '/write', headers: { origin: 'null' } })
    expect(opaque.statusCode).toBe(403)
  })

  it('answers a read from another origin without CORS headers (the browser keeps it from the page)', async () => {
    const app = await boot()
    const response = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example' } })
    expect(response.statusCode).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('allows no origin at all when none is configured', async () => {
    const app = await boot({ webOrigin: undefined })
    expect((await app.inject({ method: 'POST', url: '/write', headers: { origin: WEB } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/write' })).statusCode).toBe(200)
  })
})

describe('limits', () => {
  it('refuses a body above 1 MiB with payload_too_large', async () => {
    const app = await boot()
    const response = await app.inject({
      method: 'POST',
      url: '/write',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ blob: 'x'.repeat(BODY_LIMIT_BYTES) }),
    })
    expect(response.statusCode).toBe(413)
    expect(response.json().error.code).toBe('payload_too_large')
  })

  it('rate-limits per client address with rate_limited and Retry-After', async () => {
    const app = await boot({ rateLimit: { max: 3, timeWindowMs: 60_000 } })
    const statuses: number[] = []
    for (let attempt = 0; attempt < 4; attempt++) statuses.push((await app.inject({ method: 'GET', url: '/health' })).statusCode)
    expect(statuses).toEqual([200, 200, 200, 429])
    const limited = await app.inject({ method: 'GET', url: '/health' })
    expect(limited.json().error.code).toBe('rate_limited')
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    // Another address has its own count.
    expect((await app.inject({ method: 'GET', url: '/health', remoteAddress: '10.0.0.9' })).statusCode).toBe(200)
  })
})

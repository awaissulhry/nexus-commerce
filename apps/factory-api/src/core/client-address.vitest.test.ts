import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { TrustedProxiesError } from '@nexus/factory-domain/core/client-address'
import { LOCAL_COOKIE_SECRET, parseFactoryEnv } from '../env'
import { appConfig, buildApp, type AppConfig } from './app'
import { cameThroughProxy, clientAddressOf } from './client-address'
import { defineManifest, defineRoutes, PUBLIC } from './manifest'

/**
 * B-W2b-F57: the client address the API decides for a request (core/client-address.ts), through the real app: a trusted
 * chain, a forged header from anybody else, IPv6, several hops, the rate limit's buckets; and the rule that nothing else in
 * the API reads an address of its own. Made-up addresses (documentation ranges for clients, private ones for proxies).
 */

const WEB = '10.0.0.5'
const EDGE = '100.64.3.4'
const BROWSER_A = '198.51.100.7'
const BROWSER_B = '198.51.100.8'
const STRANGER = '203.0.113.9'
const CONFIG: AppConfig = { environment: 'test', webOrigin: 'http://localhost:3200', cookieSecret: LOCAL_COOKIE_SECRET }

const probe = defineRoutes(
  'probe',
  defineManifest({ 'GET /whoami': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' } }),
  async (app) => {
    app.get('/whoami', async (request) => ({ address: clientAddressOf(request), again: clientAddressOf(request), proxied: cameThroughProxy(request) }))
  },
)

const apps: FastifyInstance[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})
async function boot(config: Partial<AppConfig> = {}): Promise<FastifyInstance> {
  const app = await buildApp({ ...CONFIG, ...config }, { routes: [probe] })
  apps.push(app)
  return app
}
async function whoami(app: FastifyInstance, remoteAddress: string, forwardedFor?: string | string[]) {
  const response = await app.inject({ method: 'GET', url: '/whoami', remoteAddress, ...(forwardedFor === undefined ? {} : { headers: { 'x-forwarded-for': forwardedFor } }) })
  expect(response.statusCode).toBe(200)
  const body = response.json() as { address: string; again: string; proxied: boolean }
  expect(body.again).toBe(body.address)
  return body
}

describe('the client address of a request', () => {
  it('takes the browser from a trusted proxy (one hop, several hops, the right-most untrusted)', async () => {
    const app = await boot({ trustedProxies: `${WEB}, private` })
    expect(await whoami(app, WEB, BROWSER_A)).toEqual({ address: BROWSER_A, again: BROWSER_A, proxied: true })
    expect((await whoami(app, WEB, `${BROWSER_A}, ${EDGE}`)).address).toBe(BROWSER_A)
    expect((await whoami(app, WEB, `192.0.2.1, ${BROWSER_A}, ${EDGE}`)).address).toBe(BROWSER_A)
    expect((await whoami(app, WEB, ['192.0.2.1', `${BROWSER_A}, ${EDGE}`])).address).toBe(BROWSER_A)
    // No header from a proxy: the proxy itself.
    expect((await whoami(app, WEB)).address).toBe(WEB)
  })

  it('ignores a forged header from anybody who is not a trusted proxy', async () => {
    const app = await boot({ trustedProxies: WEB })
    expect(await whoami(app, STRANGER, BROWSER_A)).toEqual({ address: STRANGER, again: STRANGER, proxied: false })
    expect((await whoami(app, STRANGER, `${BROWSER_A}, ${WEB}`)).address).toBe(STRANGER)
    expect((await whoami(app, '127.0.0.1', BROWSER_A)).address).toBe('127.0.0.1')
  })

  it('trusts nobody when no proxy is configured (a test app, or none on Railway)', async () => {
    for (const app of [await boot(), await boot({ trustedProxies: 'none' })]) {
      expect(await whoami(app, '127.0.0.1', BROWSER_A)).toEqual({ address: '127.0.0.1', again: '127.0.0.1', proxied: false })
    }
  })

  it('reads IPv6 proxies and browsers, and a dual-stack socket as IPv4', async () => {
    const app = await boot({ trustedProxies: 'fd12::/16, 10.0.0.0/8' })
    expect((await whoami(app, 'fd12::5', '2001:db8::7, fd12::9')).address).toBe('2001:db8::7')
    expect((await whoami(app, 'fd12::5', '[2001:DB8::7]:51234')).address).toBe('2001:db8::7')
    expect((await whoami(app, '::ffff:10.0.0.5', BROWSER_A)).address).toBe(BROWSER_A)
    expect((await whoami(app, '::ffff:198.51.100.7', BROWSER_B)).address).toBe(BROWSER_A)
  })

  it('stops at the last trusted proxy when an entry is no address', async () => {
    const app = await boot({ trustedProxies: 'private' })
    expect((await whoami(app, WEB, `${BROWSER_A}, not-an-address`)).address).toBe(WEB)
    expect((await whoami(app, WEB, `not-an-address, ${EDGE}`)).address).toBe(EDGE)
  })

  it('refuses a list that would trust everything before the app starts', async () => {
    await expect(buildApp({ ...CONFIG, trustedProxies: '0.0.0.0/0' })).rejects.toThrow(TrustedProxiesError)
  })

  it('reads the list from the environment (local: loopback, the web beside the API)', () => {
    const local = { FACTORY_ENV: 'local', FACTORY_DATABASE_URL: 'postgresql://postgres@127.0.0.1:5442/factory_w9_01', FACTORY_REDIS_URL: 'redis://127.0.0.1:6399', FACTORY_QUEUE_PREFIX: 'w9_01' }
    expect(appConfig(parseFactoryEnv(local, undefined)).trustedProxies).toBe('loopback')
    expect(appConfig(parseFactoryEnv({ ...local, FACTORY_TRUSTED_PROXIES: 'none' }, undefined)).trustedProxies).toBe('none')
  })
})

describe('the rate limit', () => {
  it('counts each browser behind the proxy on its own, and a forged header never opens a new count', async () => {
    const app = await boot({ trustedProxies: WEB, rateLimit: { max: 3, timeWindowMs: 60_000 } })
    const statuses = async (remoteAddress: string, forwardedFor: () => string | undefined, times: number) => {
      const out: number[] = []
      for (let index = 0; index < times; index++) {
        const header = forwardedFor()
        out.push((await app.inject({ method: 'GET', url: '/health', remoteAddress, ...(header === undefined ? {} : { headers: { 'x-forwarded-for': header } }) })).statusCode)
      }
      return out
    }
    expect(await statuses(WEB, () => BROWSER_A, 4)).toEqual([200, 200, 200, 429])
    expect(await statuses(WEB, () => BROWSER_B, 3)).toEqual([200, 200, 200])
    let forged = 0
    expect(await statuses(STRANGER, () => `192.0.2.${++forged}`, 4)).toEqual([200, 200, 200, 429])
    // The proxy's own requests (no header) are the proxy's count, not a browser's.
    expect(await statuses(WEB, () => undefined, 3)).toEqual([200, 200, 200])
  })
})

describe('one place decides the address', () => {
  const SRC = fileURLToPath(new URL('..', import.meta.url))
  const OWN = 'core/client-address.ts'
  const files = (folder: string): string[] =>
    readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) return entry.name === 'testing' ? [] : files(path)
      return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : []
    })
  const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
  const READS = [/\b(?:request|req)\s*\.\s*ips?\b/, /\bremoteAddress\b/, /x-forwarded-for/i, /\btrustProxy\s*:(?!\s*false\b)/]

  it('finds a direct read in planted source', () => {
    expect(READS.some((rule) => rule.test(code('const key = request.ip')))).toBe(true)
    expect(READS.some((rule) => rule.test(code("headers['x-forwarded-for']")))).toBe(true)
    expect(READS.some((rule) => rule.test(code('Fastify({ trustProxy: 2 })')))).toBe(true)
    expect(READS.some((rule) => rule.test(code('Fastify({ trustProxy: false })')))).toBe(false)
    expect(READS.some((rule) => rule.test(code('// request.ip in a comment\nconst q = query.ip')))).toBe(false)
  })

  it('has no other reader of request.ip, the socket address or X-Forwarded-For in the API', () => {
    const offenders = files(SRC)
      .map((file) => relative(SRC, file).split(sep).join('/'))
      .filter((file) => file !== OWN)
      .flatMap((file) => {
        const source = code(readFileSync(join(SRC, file), 'utf8'))
        return READS.filter((rule) => rule.test(source)).map((rule) => `${file}: ${rule}`)
      })
    expect(offenders).toEqual([])
  })
})

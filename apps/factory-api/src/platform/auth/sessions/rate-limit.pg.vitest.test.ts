import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../../core/app'
import { LIMIT_WORDS } from '../../../core/rate-limit'
import { LOCAL_COOKIE_SECRET, LOCAL_PIN_PEPPER } from '../../../env'
import { CSRF_HEADER, SESSION_COOKIE } from './cookies'
import { AUTH_RATE_LIMITS, createOfficeAuth } from './office-auth'
import { addTenant, addUser, Browser, START, startHarness, WEB_ORIGIN, type Answer, type Harness, type TestTenant, type TestUser } from './testing/harness'

/**
 * B-W2b-GF6 (the Owner's decision of 11-15 on B-W2b-F57) on the local stack, through the real app, the real office sign-in
 * and the web's proxy in front, the counters in Redis as on Railway: two people signed in behind ONE address (an office
 * behind a NAT) each get their own budget; the address stops at its ceiling; a caller without a session keeps the address's
 * budget, and a forged session cookie opens no budget of its own nor spends a real person's; the sign-in's own limit is
 * unchanged. Small numbers (5 a person, 18 an address); made-up people and documentation-range addresses.
 */

const WEB = '10.0.0.5'
const NAT = '198.51.100.40'
const CAFE = '203.0.113.40'
const FORGER = '192.0.2.40'
const GUESSER = '192.0.2.41'
const BUDGET = 5
const CEILING = 18

let h: Harness
let tenant: TestTenant
let planner: TestUser
let warehouse: TestUser
let manager: TestUser
let app: FastifyInstance
let ns: string

/** A browser behind the web's proxy: the web sends this X-Forwarded-For (the browser's address). */
class Behind extends Browser {
  constructor(
    app: FastifyInstance,
    readonly address: string,
  ) {
    super(app)
  }

  override async send(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, options: { csrf?: boolean; headers?: Record<string, string> } = {}): Promise<Answer> {
    const headers: Record<string, string> = { 'x-forwarded-for': this.address, ...options.headers }
    if (this.cookies.size > 0) headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    if (method !== 'GET' && options.csrf !== false && this.csrfToken) headers[CSRF_HEADER] = this.csrfToken
    const response = await this.app.inject({ method, url, headers, remoteAddress: WEB, ...(body === undefined ? {} : { payload: body as object }) })
    for (const cookie of response.cookies as { name: string; value: string; maxAge?: number }[]) {
      if (cookie.maxAge === 0 || cookie.value === '') this.cookies.delete(cookie.name)
      else this.cookies.set(cookie.name, cookie.value)
    }
    let parsed: unknown
    try {
      parsed = response.json()
    } catch {
      parsed = response.body
    }
    return { status: response.statusCode, body: parsed, response }
  }
}

const count = async (key: string) => Number((await h.redis.get(`${ns}${key}`)) ?? 0)
async function statuses(browser: Browser, url: string, times: number): Promise<number[]> {
  const out: number[] = []
  for (let index = 0; index < times; index++) out.push((await browser.get(url)).status)
  return out
}
async function signedIn(who: TestUser, address: string): Promise<Behind> {
  const browser = new Behind(app, address)
  const answer = await browser.signIn(tenant.slug, who.email, who.password)
  expect(answer.body.status, JSON.stringify(answer.body)).toBe('signed_in')
  return browser
}

beforeAll(async () => {
  h = await startHarness('auth_rate_limit')
  h.clock.set(START)
  tenant = await addTenant(h, 'gf6rate')
  planner = await addUser(h, tenant, { email: 'gf6.planner@example.com', role: 'planner' })
  warehouse = await addUser(h, tenant, { email: 'gf6.warehouse@example.com', role: 'warehouse' })
  manager = await addUser(h, tenant, { email: 'gf6.manager@example.com', role: 'production_manager' })
  // The sign-in's own limits as the API runs them (AUTH_RATE_LIMITS: 10 sign-ins a minute per address).
  const auth = createOfficeAuth({ database: h.database, environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, pinPepper: LOCAL_PIN_PEPPER, webOrigin: WEB_ORIGIN, clock: h.clock, mailer: { deliver: async () => {} } })
  ns = `${h.redisPrefix}:test:rate-limit:`
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, webOrigin: WEB_ORIGIN, trustedProxies: WEB, rateLimit: { max: BUDGET, perAddressMax: CEILING, timeWindowMs: 60_000 }, queuePrefix: h.redisPrefix },
    { database: h.database, officeAuth: auth, clock: h.clock, redis: h.redis, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)) },
  )
}, 120_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
})

describe('the request limits behind one address (an office behind a NAT)', () => {
  it('gives two signed-in people their own budget each, counted on the person in Redis', async () => {
    const a = await signedIn(planner, NAT)
    const b = await signedIn(warehouse, NAT)
    expect(await statuses(a, '/auth/office/me', BUDGET)).toEqual(Array<number>(BUDGET).fill(200))
    const spent = await a.get('/auth/office/me')
    expect(spent.status).toBe(429)
    expect(spent.body.error).toMatchObject({ code: 'rate_limited', message: LIMIT_WORDS.person })
    expect(Number(spent.response.headers['retry-after'])).toBeGreaterThan(0)
    // The second person behind the same address still has all of theirs (before B-W2b-GF6: one shared count).
    expect(await statuses(b, '/auth/office/me', BUDGET)).toEqual(Array<number>(BUDGET).fill(200))
    expect(await count(`person:office:${planner.id}`)).toBe(BUDGET + 1)
    expect(await count(`person:office:${warehouse.id}`)).toBe(BUDGET)
    // The sign-in pages' CSRF reads had no session: the address's budget. Nothing is ever counted on the web's address.
    expect(await count(`anonymous:${NAT}`)).toBe(2)
    expect(await h.redis.keys(`${ns}*${WEB}*`)).toEqual([])
  })

  it('stops the address at its ceiling, whoever is signed in behind it', async () => {
    const c = await signedIn(manager, NAT)
    // 2 sign-ins of 2 requests, 6 + 5 reads, and this third sign-in: 17 of 18.
    expect(await count(`address:${NAT}`)).toBe(17)
    expect((await c.get('/auth/office/me')).status).toBe(200)
    const ceiling = await c.get('/auth/office/me')
    expect(ceiling.status).toBe(429)
    expect(ceiling.body.error).toMatchObject({ code: 'rate_limited', message: LIMIT_WORDS.ceiling })
    expect(ceiling.response.headers['x-ratelimit-limit']).toBe(String(CEILING))
    // The ceiling refused before the session was read: the manager's own budget kept its one read.
    expect(await count(`person:office:${manager.id}`)).toBe(1)
  })

  it('keeps the address budget for a caller without a session, and a forged cookie opens no budget nor spends a person', async () => {
    const stranger = new Behind(app, CAFE)
    expect(await statuses(stranger, '/health', BUDGET)).toEqual(Array<number>(BUDGET).fill(200))
    const refused = await stranger.get('/health')
    expect(refused.status).toBe(429)
    expect(refused.body.error).toMatchObject({ code: 'rate_limited', message: LIMIT_WORDS.anonymous })
    // A made-up session cookie is a request without a session: the same spent budget, not a new one.
    const forged = await stranger.get('/auth/office/me', { headers: { cookie: `${SESSION_COOKIE}=${tenant.id}.${planner.id}.not-a-real-token` } })
    expect(forged.status).toBe(429)
    // A forged cookie naming a real person, from elsewhere, is refused (401) and spends that address, never the person.
    const forger = new Behind(app, FORGER)
    const before = await count(`person:office:${warehouse.id}`)
    for (let index = 0; index < 3; index++) {
      expect((await forger.get('/auth/office/me', { headers: { cookie: `${SESSION_COOKIE}=${tenant.id}.${warehouse.id}.forged-${index}` } })).status).toBe(401)
    }
    expect(await count(`person:office:${warehouse.id}`)).toBe(before)
    expect(await count(`anonymous:${FORGER}`)).toBe(3)
  })

  it("keeps the sign-in's own limit: 10 a minute per address, apart from the budget", async () => {
    expect(AUTH_RATE_LIMITS.signIn.max).toBe(10)
    const guesser = new Behind(app, GUESSER)
    await guesser.get('/auth/csrf')
    const tries: number[] = []
    for (let index = 0; index < 11; index++) tries.push((await guesser.post('/auth/office/sign-in', { tenant: tenant.slug, email: `nobody.${index}@example.com`, password: 'not-the-password-at-all' })).status)
    expect(tries).toEqual([...Array<number>(10).fill(401), 429])
    // Counted by the route's own limit on the address; the budget holds only the CSRF read; the ceiling all 12.
    expect(await count(`POST/auth/office/sign-in-${GUESSER}`)).toBe(11)
    expect(await count(`anonymous:${GUESSER}`)).toBe(1)
    expect(await count(`address:${GUESSER}`)).toBe(12)
  })
})

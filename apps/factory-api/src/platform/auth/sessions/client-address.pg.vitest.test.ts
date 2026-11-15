import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { addressHashOf } from '../../audit/security-events/address'
import { CSRF_HEADER } from './cookies'
import { usePlaceHeaders } from './place'
import { addTenant, addUser, Browser, START, startHarness, WEB_ORIGIN, type Answer, type Harness, type TestTenant, type TestUser } from './testing/harness'

/**
 * B-W2b-F57 on the local stack, through the real app with the web's proxy in front (core/client-address.ts): two browsers
 * behind the proxy get their own rate-limit counts (in Redis, as on Railway); a forged X-Forwarded-For from anybody who is
 * not a trusted proxy changes nothing; the session, the security events, the audit search and the place of a sign-in
 * name the browser, never the proxy. Made-up people and addresses (documentation ranges; private ones for the proxies).
 */

const WEB = '10.0.0.5'
const EDGE = '100.64.3.4'
const BROWSER_A = '198.51.100.7'
const BROWSER_B = '203.0.113.50'
const STRANGER = '192.0.2.9'
// The sessions' own people (the rate-limit tests above spend the first ones' budgets).
const PERSON_A = '198.51.100.20'
const PERSON_B = '203.0.113.20'
const OUTSIDER = '192.0.2.20'
const FORGED = ['198.18.0.1', '2001:db8::66', '198.18.0.2', '198.18.0.3', '198.18.0.4', '198.18.0.5']
const LIMIT = 5

let h: Harness
let tenant: TestTenant
let user: TestUser
let app: FastifyInstance

/** A browser seen through a TCP peer (the web's proxy, or anybody) that sends this X-Forwarded-For. */
class Peered extends Browser {
  constructor(
    app: FastifyInstance,
    readonly peer: string,
    public forwardedFor: string | null,
  ) {
    super(app)
  }

  override async send(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, options: { csrf?: boolean; headers?: Record<string, string> } = {}): Promise<Answer> {
    const headers: Record<string, string> = { ...options.headers }
    if (this.forwardedFor !== null) headers['x-forwarded-for'] = this.forwardedFor
    if (this.cookies.size > 0) headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    if (method !== 'GET' && options.csrf !== false && this.csrfToken) headers[CSRF_HEADER] = this.csrfToken
    const response = await this.app.inject({ method, url, headers, remoteAddress: this.peer, ...(body === undefined ? {} : { payload: body as object }) })
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

const scope = () => ({ audience: 'office' as const, tenantId: tenant.id, actorId: user.id })
const sessionsOf = (userId: string) =>
  h.database.withScope(scope(), (client) => client.session.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { ipHash: true, ipCountry: true } }))
const eventsOf = (kind: 'SIGN_IN' | 'SIGN_IN_FAILED') =>
  h.database.withScope(scope(), (client) => client.securityEvent.findMany({ where: { kind }, orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { ipHash: true, actorId: true } }))

async function signIn(browser: Browser, who: TestUser, password = who.password): Promise<Answer> {
  await browser.get('/auth/csrf')
  return browser.post('/auth/office/sign-in', { tenant: tenant.slug, email: who.email, password })
}

beforeAll(async () => {
  h = await startHarness('auth_client_address')
  h.clock.set(START)
  tenant = await addTenant(h, 'f57addr')
  user = await addUser(h, tenant, { email: 'proxied.person@example.com', role: 'planner' })
  // The web's proxy (WEB) and Railway's edge range in front of it; a small budget per client; the counts in Redis under
  // this harness's own prefix, as the API keeps them on Railway.
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, webOrigin: WEB_ORIGIN, trustedProxies: `${WEB}, 100.64.0.0/10`, rateLimit: { max: LIMIT, timeWindowMs: 60_000 }, queuePrefix: h.redisPrefix },
    { database: h.database, officeAuth: h.auth, clock: h.clock, redis: h.redis, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)) },
  )
}, 120_000)

afterEach(() => usePlaceHeaders(undefined))

afterAll(async () => {
  await app?.close()
  await h?.close()
})

describe('the rate limit behind the web proxy', () => {
  it('gives two browsers through the proxy a count each (the proxy is not one client)', async () => {
    const a = new Peered(app, WEB, BROWSER_A)
    const b = new Peered(app, WEB, `${BROWSER_B}, ${EDGE}`)
    const statusesOf = async (browser: Browser, times: number) => {
      const out: number[] = []
      for (let index = 0; index < times; index++) out.push((await browser.get('/health')).status)
      return out
    }
    expect(await statusesOf(a, LIMIT + 1)).toEqual([...Array<number>(LIMIT).fill(200), 429])
    expect(await statusesOf(b, LIMIT)).toEqual(Array<number>(LIMIT).fill(200))
    const limited = await a.get('/health')
    expect(limited.status).toBe(429)
    expect(limited.body.error.code).toBe('rate_limited')
    // The counts are the browsers' own keys in Redis, never the proxy's address.
    const keys = await h.redis.keys(`${h.redisPrefix}:test:rate-limit:*`)
    expect(keys.map((key) => key.slice(`${h.redisPrefix}:test:rate-limit:`.length)).sort()).toEqual([BROWSER_B, BROWSER_A].sort())
  })

  it('counts a forged X-Forwarded-For from a non-proxy address as that address, whatever it names', async () => {
    const stranger = new Peered(app, STRANGER, null)
    const statuses: number[] = []
    for (const forged of FORGED) {
      stranger.forwardedFor = `${forged}, ${WEB}`
      statuses.push((await stranger.get('/health')).status)
    }
    expect(statuses).toEqual([...Array<number>(LIMIT).fill(200), 429])
    expect(await h.redis.exists(`${h.redisPrefix}:test:rate-limit:${STRANGER}`)).toBe(1)
    for (const forged of FORGED) expect(await h.redis.exists(`${h.redisPrefix}:test:rate-limit:${forged}`), forged).toBe(0)
  })
})

describe('sessions, security events and the audit name the browser', () => {
  it("records the browser's address (through the proxy) on the session and its sign-in event, never the proxy's", async () => {
    h.clock.set('2026-10-28T10:00:00.000Z')
    const browser = new Peered(app, WEB, `${PERSON_A}, ${EDGE}`)
    expect((await signIn(browser, user)).body.status).toBe('signed_in')
    await h.auth.settled()
    const [session] = await sessionsOf(user.id)
    expect(session!.ipHash).toBe(h.auth.secrets.ipHash(PERSON_A))
    expect(session!.ipHash).toBe(addressHashOf(PERSON_A, 'ip'))
    expect(session!.ipHash).not.toBe(h.auth.secrets.ipHash(WEB))
    expect((await eventsOf('SIGN_IN')).at(-1)).toEqual({ ipHash: h.auth.secrets.ipHash(PERSON_A), actorId: user.id })
  })

  it("records the browser's address on a refused sign-in (a wrong password, and an address nobody has)", async () => {
    h.clock.set('2026-10-28T10:05:00.000Z')
    const browser = new Peered(app, WEB, PERSON_B)
    expect((await signIn(browser, user, 'not-the-password-at-all')).status).toBe(401)
    await h.auth.settled()
    expect((await eventsOf('SIGN_IN_FAILED')).at(-1)).toEqual({ ipHash: h.auth.secrets.ipHash(PERSON_B), actorId: user.id })
    expect((await signIn(browser, { ...user, email: 'nobody.here@example.com' })).status).toBe(401)
    await h.auth.settled()
    expect((await eventsOf('SIGN_IN_FAILED')).at(-1)).toEqual({ ipHash: h.auth.secrets.ipHash(PERSON_B), actorId: null })
  })

  it('keeps the TCP address of a sign-in that is not from a proxy, whatever X-Forwarded-For it forges', async () => {
    h.clock.set('2026-10-28T10:10:00.000Z')
    const other = await addUser(h, tenant, { email: 'direct.person@example.com', role: 'planner' })
    const browser = new Peered(app, OUTSIDER, `${FORGED[0]}, ${WEB}`)
    expect((await signIn(browser, other)).body.status).toBe('signed_in')
    await h.auth.settled()
    const [session] = await sessionsOf(other.id)
    expect(session!.ipHash).toBe(h.auth.secrets.ipHash(OUTSIDER))
    expect(session!.ipHash).not.toBe(h.auth.secrets.ipHash(FORGED[0]))
  })

  it("finds the person's audit rows by the browser's address, and none by the proxy's", async () => {
    const auditor: SessionContext = { audience: 'office', tenantId: tenant.id, actorId: user.id, grants: [{ permissions: ['audit.read'], companies: 'all', sites: 'all', parties: 'all' }] }
    const viewer = await buildApp(
      { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
      { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator(() => auditor) },
    )
    try {
      const search = async (ip: string) => {
        const answer = await viewer.inject({ method: 'GET', url: `/audit/search?ip=${encodeURIComponent(ip)}&actorId=${user.id}` })
        expect(answer.statusCode, answer.body).toBe(200)
        return (answer.json() as { entries: { action: string }[] }).entries.map((entry) => entry.action)
      }
      expect(await search(PERSON_A)).toContain('auth.signIn')
      expect(await search(WEB)).toEqual([])
      expect(await search(EDGE)).toEqual([])
    } finally {
      await viewer.close()
    }
  })

  it("takes a sign-in's place from the edge only through a trusted proxy", async () => {
    usePlaceHeaders(true)
    h.clock.set('2026-10-28T10:20:00.000Z')
    const placed = await addUser(h, tenant, { email: 'placed.person@example.com', role: 'planner' })
    expect((await signIn(new Peered(app, WEB, PERSON_A), placed)).body.status).toBe('signed_in')
    const forged = await addUser(h, tenant, { email: 'forged.place@example.com', role: 'planner' })
    const stranger = new Peered(app, OUTSIDER, null)
    await stranger.get('/auth/csrf')
    expect((await stranger.post('/auth/office/sign-in', { tenant: tenant.slug, email: forged.email, password: forged.password }, { headers: { 'cf-ipcountry': 'DE' } })).body.status).toBe('signed_in')
    // The proxy's request carried no country in this test: send one through it too.
    const third = await addUser(h, tenant, { email: 'third.person@example.com', role: 'planner' })
    const through = new Peered(app, WEB, PERSON_A)
    await through.get('/auth/csrf')
    expect((await through.post('/auth/office/sign-in', { tenant: tenant.slug, email: third.email, password: third.password }, { headers: { 'cf-ipcountry': 'IT' } })).body.status).toBe('signed_in')
    expect((await sessionsOf(placed.id))[0]!.ipCountry).toBeNull()
    expect((await sessionsOf(forged.id))[0]!.ipCountry).toBeNull()
    expect((await sessionsOf(third.id))[0]!.ipCountry).toBe('IT')
  })
})

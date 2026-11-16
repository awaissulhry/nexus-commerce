import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { LOCAL_COOKIE_SECRET } from '../env'
import { buildApp, type AppConfig } from './app'
import { testAuthenticator, type RequestContext, type SessionContext } from './context'
import { defineManifest, defineRoutes, PUBLIC, SIGNED_IN } from './manifest'
import { budgetKey, CEILING_IN_BUDGETS, DEFAULT_REQUEST_LIMITS, LIMIT_WORDS, requestLimitsOf } from './rate-limit'

/**
 * B-W2b-GF6 (the Owner's decision on B-W2b-F57): the request limits through the real app — a budget per signed-in person
 * whatever address they come from, the same per address for a request without a session, a ceiling per address over every
 * request, and a route's own limit kept. Small numbers (3 a person, 7 an address); made-up people and documentation-range
 * addresses.
 */

const TENANT = '0190f5c2-0000-7000-8000-000000000001'
const PERSON = (n: number) => `0190f5c2-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`
const SITE = '0190f5c2-0000-7000-8000-000000000101'
const PARTY = '0190f5c2-0000-7000-8000-000000000201'
const NAT = '198.51.100.7'
const ELSEWHERE = '203.0.113.50'
const CAFE = '192.0.2.9'
const LIMITS = { max: 3, perAddressMax: 7, timeWindowMs: 60_000 }

const grant: Grant = { permissions: ['quotes.view'], companies: 'all', sites: 'all', parties: 'all' }
const office = (n: number): SessionContext => ({ audience: 'office', tenantId: TENANT, actorId: PERSON(n), grants: [grant] })
const SESSIONS: Record<string, SessionContext> = {
  planner: office(1),
  warehouse: office(2),
  buyer: office(3),
  sales: office(4),
  floor: { audience: 'floor', tenantId: TENANT, actorId: PERSON(5), siteId: SITE, deviceId: PERSON(50), grants: [grant] },
}
const sessions = testAuthenticator((request) => {
  const name = request.headers['x-test-session']
  return typeof name === 'string' ? (SESSIONS[name] ?? null) : null
})

const probe = defineRoutes(
  'probe',
  defineManifest({
    'GET /me': { audiences: ['office', 'floor'], permission: SIGNED_IN, scope: 'tenant' },
    'GET /office-only': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
    'POST /try-code': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
    'GET /open': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  }),
  async (app) => {
    app.get('/me', async () => ({ ok: true }))
    app.get('/office-only', async () => ({ ok: true }))
    // A route with its own limit (as sign-in, codes and links): per address, 2 a minute.
    app.post('/try-code', { config: { rateLimit: { max: 2, timeWindow: 60_000 } } }, async () => ({ ok: true }))
    app.get('/open', async () => ({ ok: true }))
  },
)

const apps: FastifyInstance[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})
async function boot(config: Partial<AppConfig> = {}): Promise<FastifyInstance> {
  const app = await buildApp({ environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, rateLimit: LIMITS, ...config }, { routes: [probe], authenticate: sessions })
  apps.push(app)
  return app
}

async function call(app: FastifyInstance, from: string, url: string, who?: string, method: 'GET' | 'POST' = 'GET') {
  const response = await app.inject({ method, url, remoteAddress: from, headers: who ? { 'x-test-session': who } : {} })
  return { status: response.statusCode, message: response.statusCode === 429 ? (response.json() as { error: { message: string } }).error.message : null, response }
}
async function statuses(app: FastifyInstance, from: string, url: string, who: string | undefined, times: number): Promise<number[]> {
  const out: number[] = []
  for (let index = 0; index < times; index++) out.push((await call(app, from, url, who)).status)
  return out
}

describe('whose budget a request spends (the key rule)', () => {
  const context = (session: SessionContext): RequestContext => ({ ...session, requestId: 'r' }) as RequestContext

  it("is the session's person for every audience, whatever the address", () => {
    expect(budgetKey(context(office(1)), NAT)).toBe(`person:office:${PERSON(1)}`)
    expect(budgetKey(context(office(1)), ELSEWHERE)).toBe(`person:office:${PERSON(1)}`)
    expect(budgetKey(context(SESSIONS.floor!), NAT)).toBe(`person:floor:${PERSON(5)}`)
    expect(budgetKey(context({ audience: 'partner', tenantId: TENANT, actorId: PERSON(6), partyId: PARTY, grants: [] }), NAT)).toBe(`person:partner:${PERSON(6)}`)
    expect(budgetKey(context({ audience: 'link', tenantId: TENANT, linkId: PERSON(7), partyId: PARTY, record: { type: 'Quote', id: PERSON(8) }, grants: [] }), NAT)).toBe(`person:link:${PERSON(7)}`)
    expect(budgetKey(context({ audience: 'platform', actorId: PERSON(9), grants: [] }), NAT)).toBe(`person:platform:${PERSON(9)}`)
  })

  it('is the client address without a session', () => {
    expect(budgetKey(null, NAT)).toBe(`anonymous:${NAT}`)
    expect(budgetKey(null, '2001:db8::7')).toBe('anonymous:2001:db8::7')
  })

  it("keeps the Owner's numbers, and a test's budget gets ten budgets as its ceiling unless it names one", () => {
    expect(requestLimitsOf()).toEqual({ max: 300, perAddressMax: 3000, timeWindowMs: 60_000 })
    expect(DEFAULT_REQUEST_LIMITS.perAddressMax).toBe(DEFAULT_REQUEST_LIMITS.max * CEILING_IN_BUDGETS)
    expect(requestLimitsOf({ max: 5, timeWindowMs: 1_000 })).toEqual({ max: 5, perAddressMax: 50, timeWindowMs: 1_000 })
    expect(requestLimitsOf({ max: 5, timeWindowMs: 1_000, perAddressMax: 8 })).toEqual({ max: 5, perAddressMax: 8, timeWindowMs: 1_000 })
  })
})

describe('the request limits through the app', () => {
  it('gives two people behind one address a budget each, and the address stops at its ceiling', async () => {
    const app = await boot()
    // Two signed-in people behind the NAT: 3 each (before B-W2b-GF6 they shared the address's 3).
    expect(await statuses(app, NAT, '/me', 'planner', 3)).toEqual([200, 200, 200])
    expect(await statuses(app, NAT, '/me', 'warehouse', 3)).toEqual([200, 200, 200])
    const spent = await call(app, NAT, '/me', 'planner')
    expect(spent.status).toBe(429)
    expect(spent.message).toBe(LIMIT_WORDS.person)
    expect(Number(spent.response.headers['retry-after'])).toBeGreaterThan(0)
    // The address has counted 7 (its ceiling): a third person behind it is refused with the ceiling's words.
    const ceiling = await call(app, NAT, '/me', 'buyer')
    expect(ceiling.status).toBe(429)
    expect(ceiling.message).toBe(LIMIT_WORDS.ceiling)
    expect(ceiling.response.headers['x-ratelimit-limit']).toBe('7')
    // The person's budget follows the person, not the address: the planner from elsewhere is still out; the buyer is not.
    expect((await call(app, ELSEWHERE, '/me', 'planner')).message).toBe(LIMIT_WORDS.person)
    expect(await statuses(app, ELSEWHERE, '/me', 'buyer', 3)).toEqual([200, 200, 200])
  })

  it('keeps the per-address budget for a caller without a session, apart from the people at that address', async () => {
    // A ceiling well above the 8 requests here (this case is about the budgets).
    const app = await boot({ rateLimit: { ...LIMITS, perAddressMax: 20 } })
    expect(await statuses(app, CAFE, '/open', undefined, 3)).toEqual([200, 200, 200])
    const refused = await call(app, CAFE, '/open')
    expect(refused.status).toBe(429)
    expect(refused.message).toBe(LIMIT_WORDS.anonymous)
    // A session that opens nothing is a request without one: it spends the same address budget (no new count).
    expect((await call(app, CAFE, '/me', 'nobody-at-all')).status).toBe(429)
    // A signed-in person at the same address still has their own budget.
    expect(await statuses(app, CAFE, '/me', 'sales', 3)).toEqual([200, 200, 200])
  })

  it("counts a person's refused requests on that person (a session read, another audience)", async () => {
    const app = await boot({ rateLimit: { ...LIMITS, perAddressMax: 20 } })
    expect(await statuses(app, NAT, '/office-only', 'floor', 3)).toEqual([403, 403, 403])
    expect((await call(app, NAT, '/office-only', 'floor')).message).toBe(LIMIT_WORDS.person)
    // The address's own budget is untouched: a caller without a session there still has 3.
    expect(await statuses(app, NAT, '/open', undefined, 3)).toEqual([200, 200, 200])
  })

  it("keeps a route's own limit by address instead of the budget, and the ceiling counts it", async () => {
    const app = await boot()
    const code = (who: string) => call(app, NAT, '/try-code', who, 'POST')
    expect([(await code('planner')).status, (await code('warehouse')).status, (await code('buyer')).status]).toEqual([200, 200, 429])
    // The route's own limit spent nothing of the people's budgets.
    expect(await statuses(app, NAT, '/me', 'planner', 3)).toEqual([200, 200, 200])
    // 3 code tries + 3 reads = 6 on the address: one more passes, then the ceiling.
    expect(await statuses(app, NAT, '/me', 'warehouse', 2)).toEqual([200, 429])
  })

  it('tells the budget in the answer headers, and refuses a route that does not exist on the address budget too', async () => {
    const app = await boot()
    const first = await call(app, NAT, '/me', 'planner')
    expect(first.response.headers['x-ratelimit-limit']).toBe('3')
    expect(first.response.headers['x-ratelimit-remaining']).toBe('2')
    expect(await statuses(app, ELSEWHERE, '/no-such-route', undefined, 4)).toEqual([404, 404, 404, 429])
  })

  it("runs on the Owner's numbers when the config names none (300 a person)", async () => {
    const app = await boot({ rateLimit: undefined })
    const first = await call(app, NAT, '/me', 'planner')
    expect(first.response.headers['x-ratelimit-limit']).toBe('300')
  })
})

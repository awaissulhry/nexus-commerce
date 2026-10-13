/**
 * Google Ads step 1a — the read routes of the Google Ads tab (R1–R4, S) through Fastify, on a real PostgreSQL with
 * every business policy (PGlite), business profiles ON, with the API's own financial filter as the preSerialization
 * hook. The business's Google sign-ins and the read queue are stubbed.
 *
 * Proven here: the answers keep the contract's shape; a person without `financials.adspend.view` gets every answer
 * minus exactly the money keys (spendCents, conversionValueCents, avgCpcCents, costPerConversionCents, roas,
 * dailyBudgetCents) at every depth, while a cleared person gets them; another business's campaign is 404; a bad day or
 * cursor is 400; and the permissions manifest maps each route to the ads permissions (reads ads.view; "Read now" the
 * permission eBay's and Amazon's "sync now" take). Values are made up (public repo).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../test-support/formula-database.js'
import { withWorkspace, workspaceIdForQuery } from '../lib/workspace-context.js'
import { financialFilterHook } from '../lib/auth/field-filter.js'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'

const mocks = vi.hoisted(() => ({
  accounts: {} as Record<string, unknown[]>,
  enqueue: vi.fn(async (_args: { customerId?: string; kind: string }) => ({ queued: true, reason: null as string | null })),
}))
vi.mock('../services/google/google-accounts.service.js', () => ({ listGoogleAccounts: async () => mocks.accounts[workspaceIdForQuery()] ?? [] }))
vi.mock('../services/marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: mocks.enqueue }))

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }) }))

const A = 'gads_routes_alpha'
const B = 'gads_routes_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const db = () => database.client
const day = (ymd: string) => new Date(`${ymd}T00:00:00Z`)
const ids: Record<string, string> = {}
let app: FastifyInstance

/** The money keys the Google Ads answers carry; each one the financial filter strips. */
const MONEY = ['spendCents', 'conversionValueCents', 'avgCpcCents', 'costPerConversionCents', 'roas', 'dailyBudgetCents']
const PERMS = {
  cleared: new Set([FEATURES.adsView, FIELDS.financialsAdspendView]),
  operator: new Set([FEATURES.adsView]),
}

function googleAccount(connectionId: string, customerId: string) {
  return {
    connectionId, label: 'Test Google sign-in', state: 'ok', stateText: 'Nexus reads this account once a day.', authStatus: 'connected', missingProducts: [],
    ads: { customerId, name: 'Test advertiser', currency: 'EUR', timeZone: 'Europe/Rome', isTest: false },
    manager: null, merchantCenter: null, analytics: null,
    read: { lastReadAt: null, lastDataDay: null, nextReadAt: null, lastError: null },
  }
}

/** One account read from 1 Aug through 3 days ago, one campaign with a budget and one day of numbers. */
async function seed(workspaceId: string, customerId: string, name: string) {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10)
  return withWorkspace(scope(workspaceId), async () => {
    await db().googleAdsCustomer.create({ data: { connectionId: `conn-${workspaceId}`, customerId, currencyCode: 'EUR', timeZone: 'Europe/Rome', status: 'ENABLED', metricsReadFrom: day('2026-01-01'), metricsReadThrough: day(threeDaysAgo), lastSuccessAt: new Date(), changesSyncedThrough: new Date() } })
    const campaign = await db().googleAdsCampaign.create({ data: { customerId, campaignId: '4242', name, status: 'ENABLED', channelType: 'SEARCH', budgetAmountMicros: 30_000_000n, currencyCode: 'EUR', lastSeenAt: new Date() } })
    await db().googleAdsDailyMetric.create({ data: { customerId, date: day(threeDaysAgo), entityType: 'CAMPAIGN', entityId: '4242', campaignId: '4242', impressions: 900, clicks: 30, costMicros: 15_550_000n, conversions: '2', conversionsValueMicros: 77_770_000n, currencyCode: 'EUR', pulledAt: new Date() } })
    await db().googleAdsChangeEvent.create({ data: { customerId, resourceName: `customers/${customerId}/changeEvents/1~0~0`, changedAt: new Date(), resourceType: 'CAMPAIGN', changeResourceName: `customers/${customerId}/campaigns/4242`, operation: 'UPDATE', clientType: 'GOOGLE_ADS_WEB_CLIENT', userEmail: 'test.person@example.test', changedFields: ['status'], campaignId: '4242' } })
    return { campaignId: campaign.id, yesterday }
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
  }
  mocks.accounts[A] = [googleAccount('conn-a', '1112223334')]
  mocks.accounts[B] = [googleAccount('conn-b', '5556667778')]
  ids.a = (await seed(A, '1112223334', 'Alpha test campaign')).campaignId
  ids.b = (await seed(B, '5556667778', 'Bravo test campaign')).campaignId

  const { default: routes } = await import('./google-ads-read.routes.js')
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    const who = request.headers['x-test-who'] === 'operator' ? 'operator' : 'cleared'
    request.__rbacResolved = { isOwner: false, permissions: PERMS[who] }
    withWorkspace(scope(request.headers['x-test-business'] === 'B' ? B : A), done)
  })
  app.addHook('preSerialization', financialFilterHook)
  await app.register(routes, { prefix: '/api' })
  await app.ready()
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.close()
  await database?.close()
}, 30_000)

type Row = Record<string, any>
const get = (url: string, who: 'cleared' | 'operator' = 'cleared', business: 'A' | 'B' = 'A') =>
  app.inject({ method: 'GET', url, headers: { 'x-test-who': who, 'x-test-business': business } })

function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out))
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysOf(v, out) }
  return out
}

describe('the read routes answer the contract', () => {
  it('R1 overview, R2 campaigns, R3 days, R4 changes', async () => {
    const overview = (await get('/api/google-ads/overview?from=2026-09-01&to=2099-01-01')).json() as Row
    expect(overview.account.connectionId).toBe('conn-a')
    expect(Object.keys(overview).sort()).toEqual(['account', 'accounts', 'coverage', 'currency', 'dataAsOf', 'days', 'previous', 'timeZone', 'totals', 'window'])
    expect(overview.totals).toMatchObject({ impressions: 900, clicks: 30, spendCents: 1555, conversions: 2, conversionValueCents: 7777, avgCpcCents: 52, costPerConversionCents: 778 })
    expect(overview.window.to < '2099-01-01').toBe(true)

    const campaigns = (await get('/api/google-ads/campaigns?from=2026-09-01&limit=10')).json() as Row
    expect(Object.keys(campaigns).sort()).toEqual(['coverage', 'currency', 'dataAsOf', 'items', 'nextCursor', 'total', 'window'])
    expect(campaigns.items).toEqual([expect.objectContaining({ campaignId: ids.a, externalCampaignId: '4242', name: 'Alpha test campaign', dailyBudgetCents: 3000, metrics: expect.objectContaining({ spendCents: 1555 }) })])

    const days = (await get(`/api/google-ads/campaigns/${ids.a}/days?from=2026-09-01`)).json() as Row
    expect(Object.keys(days).sort()).toEqual(['campaign', 'coverage', 'currency', 'days', 'window'])
    expect(days.campaign.campaignId).toBe(ids.a)

    const changes = await get(`/api/google-ads/campaigns/${ids.a}/changes`)
    expect(changes.statusCode).toBe(200)
    expect(changes.json()).toEqual({ coveredFrom: expect.any(String), items: [expect.objectContaining({ source: 'google_ads_web', sourceText: 'Google Ads website', changedFields: ['status'] })] })
    expect(changes.body).not.toMatch(/example\.test|@/)
  })

  it('S: POST with no body, `?account=` only when one is picked', async () => {
    mocks.enqueue.mockClear()
    const res = await app.inject({ method: 'POST', url: '/api/google-ads/sync', headers: { 'x-test-who': 'cleared' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ queued: true, reason: null })
    expect(mocks.enqueue).toHaveBeenCalledWith({ customerId: '1112223334', kind: 'MANUAL' })
    const elsewhere = await app.inject({ method: 'POST', url: '/api/google-ads/sync?account=conn-b', headers: { 'x-test-who': 'cleared' } })
    expect(elsewhere.statusCode).toBe(404)
    expect(elsewhere.json()).toEqual({ error: 'Google account not found' })
  })
})

describe('money a person may not see never leaves the server', () => {
  it('every read minus exactly the money keys, at every depth; the cleared answer carries them', async () => {
    for (const url of ['/api/google-ads/overview?from=2026-09-01', '/api/google-ads/campaigns?from=2026-09-01', `/api/google-ads/campaigns/${ids.a}/days?from=2026-09-01`]) {
      const full = (await get(url, 'cleared')).json()
      const partial = (await get(url, 'operator')).json()
      expect({ url, money: MONEY.filter((key) => keysOf(full).has(key)).length > 0 }).toEqual({ url, money: true })
      expect({ url, leaked: [...keysOf(partial)].filter((key) => MONEY.includes(key)) }).toEqual({ url, leaked: [] })
      const stripped = JSON.parse(JSON.stringify(full, (key, value) => (key && MONEY.includes(key) ? undefined : value)))
      expect({ url, answer: partial }).toEqual({ url, answer: stripped })
    }
    // The operator still reads the non-money numbers.
    expect(((await get('/api/google-ads/overview?from=2026-09-01', 'operator')).json() as Row).totals).toMatchObject({ impressions: 900, clicks: 30, conversions: 2, ctr: 30 / 900 })
  })
})

describe('refusals', () => {
  it('another business\'s campaign is 404 from here, and its own from there', async () => {
    for (const path of ['days', 'changes']) {
      const res = await get(`/api/google-ads/campaigns/${ids.b}/${path}`)
      expect({ path, status: res.statusCode, body: res.json() }).toEqual({ path, status: 404, body: { error: 'Campaign not found' } })
      expect((await get(`/api/google-ads/campaigns/${ids.b}/${path}`, 'cleared', 'B')).statusCode).toBe(200)
    }
    expect(((await get('/api/google-ads/campaigns', 'cleared', 'B')).json() as Row).items.map((c: Row) => c.name)).toEqual(['Bravo test campaign'])
    expect((await get('/api/google-ads/overview?account=conn-b')).statusCode).toBe(404)
  })

  it('a bad day, a bad status or a changed cursor is 400 with a sentence', async () => {
    expect((await get('/api/google-ads/overview?from=13-10-2026')).json()).toEqual({ error: 'from must be a day written YYYY-MM-DD.' })
    expect((await get('/api/google-ads/overview?from=13-10-2026')).statusCode).toBe(400)
    expect((await get('/api/google-ads/campaigns?status=RUNNING')).statusCode).toBe(400)
    const cursor = await get('/api/google-ads/campaigns?cursor=not-a-cursor')
    expect(cursor.statusCode).toBe(400)
    expect(cursor.json().error).toMatch(/cursor is not valid/)
  })
})

describe('the permissions manifest (the lead adds these lines; until then the routes are unmapped and refused)', () => {
  it('reads take ads.view; "Read now" takes what eBay\'s and Amazon\'s sync-now take', () => {
    expect(permissionForRoute('GET', '/api/google-ads/overview')).toBe(FEATURES.adsView)
    expect(permissionForRoute('GET', '/api/google-ads/campaigns')).toBe(FEATURES.adsView)
    expect(permissionForRoute('GET', '/api/google-ads/campaigns/:campaignId/days')).toBe(FEATURES.adsView)
    expect(permissionForRoute('GET', '/api/google-ads/campaigns/:campaignId/changes')).toBe(FEATURES.adsView)
    const syncNow = permissionForRoute('POST', '/api/ebay-ads/sync')
    expect(syncNow).toBe(FEATURES.adsCampaignsManage)
    expect(permissionForRoute('POST', '/api/advertising/cron/ads-sync/trigger')).toBe(syncNow)
    expect(permissionForRoute('POST', '/api/google-ads/sync')).toBe(syncNow)
  })
})

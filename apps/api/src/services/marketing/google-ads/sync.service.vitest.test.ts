/**
 * Google Ads step 1a — one read of one account (sync.service.ts), through the REAL read client and channel gateway (only
 * `fetch`, the token, the account state and the ledger are stand-ins) into the REAL store on PGlite (production schema and
 * policies, business profiles on), with Google's answers from the REST-shaped fixtures in test-support/google-ads.
 *
 *   the first read: 400 days of campaign numbers + Google's whole change history, 4 operations of the 5 reserved (one
 *   given back), only GoogleAdsService.Search calls (POST …:search, read), nothing for another business
 *   the daily read: 14 days, the change history from 10 minutes before where the last one stopped
 *   a manager account: one call, MANAGER, the rest of the allowance given back
 *   no allowance: no call at all (SKIPPED_BUDGET), and not a read: the last read's time stays
 *   operations spent beyond the reservation (a restart after an expired page token): counted, even over the cap
 *   the sign-in lost mid-run: the run stops, AUTH_LOST, nothing stored is deleted
 *   a refused daily query: PARTIAL, the stored days and their range untouched, the change history still read
 */
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
const h = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; method: string; query: string; pageToken: string | null; headers: Record<string, string>; at: number }>,
  override: {} as Partial<Record<'customer' | 'campaigns' | 'days' | 'changes', () => Response>>,
  published: [] as unknown[],
}))
vi.mock('../../../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, {
    get: (_t, property) => (database.client as unknown as Record<string, unknown>)[property as string],
  }),
}))
vi.mock('../../gateway/account.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../../gateway/ledger.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'google-access-token') }))
vi.mock('../../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))
vi.mock('../../marketing-events.service.js', () => ({ publishMarketingEvent: vi.fn((event: unknown) => { h.published.push(event) }) }))

import { gatewayLedger } from '../../../test-support/gateway-stubs.js'
import { __rateTest } from '../../gateway/rate.js'
import { googleKind } from '../../gateway/google.js'
import { setOpsBudgetRedisForTests, type OpsRedis } from './ops-budget.js'
import { getGoogleAdsCustomer } from './store.js'
import { RUN_OPS, dailyReadWindow, syncGoogleAdsAccount } from './sync.service.js'

const raw = (name: string) => readFileSync(new URL(`../../../test-support/google-ads/${name}`, import.meta.url), 'utf8')
const errors = JSON.parse(raw('errors.json')) as Record<string, { httpStatus: number; body: unknown }>
const ok = (name: string) => () => new Response(raw(name), { status: 200 })
const fail = (name: string) => () => new Response(JSON.stringify(errors[name].body), { status: errors[name].httpStatus })
const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 })

const A = 'gads_sync_alpha'
const B = 'gads_sync_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const db = () => database.client
const CID = '1234567890'
const TARGET = { connectionId: 'g-conn-1', customerId: CID, loginCustomerId: null }
const RUN_1 = new Date('2026-10-13T06:25:00Z') // a Tuesday; the account (Europe/Rome) is at 08:25 on 2026-10-13
const RUN_2 = new Date('2026-10-14T06:25:00Z')

/** Google, as the fixtures answer: chosen by the query each call sends. */
function answer(query: string, pageToken: string | null): Response {
  if (query.includes(' FROM customer')) return (h.override.customer ?? ok('search-customer.json'))()
  if (query.includes(' FROM campaign WHERE campaign.status')) return (h.override.campaigns ?? ok(pageToken ? 'search-campaigns-page-2.json' : 'search-campaigns-page-1.json'))()
  if (query.includes(' FROM campaign WHERE segments.date')) return (h.override.days ?? ok('search-campaign-days.json'))()
  if (query.includes(' FROM change_event')) return (h.override.changes ?? ok('search-change-events.json'))()
  throw new Error(`test: no answer for ${query.slice(0, 60)}`)
}

/** The ops allowance's Redis, in memory. */
const redisStore = new Map<string, string>()
const memoryRedis: OpsRedis = {
  status: 'ready',
  async incrby(key, n) { const v = Number(redisStore.get(key) ?? 0) + n; redisStore.set(key, String(v)); return v },
  async decrby(key, n) { const v = Number(redisStore.get(key) ?? 0) - n; redisStore.set(key, String(v)); return v },
  async expire() { return 1 },
  async mget(...keys) { return keys.map((k) => redisStore.get(k) ?? null) },
  async get(key) { return redisStore.get(key) ?? null },
  async set(key, value) { redisStore.set(key, value); return 'OK' },
}
const accountOps = () => [...redisStore.entries()].filter(([k]) => k.startsWith(`nexus:gads:ops:acct:${CID}:`)).reduce((t, [, v]) => t + Number(v), 0)
const daysStored = () => db().googleAdsDailyMetric.findMany({ orderBy: [{ date: 'asc' }, { entityId: 'asc' }] })
  .then((rows) => rows.map((r) => `${r.date.toISOString().slice(0, 10)}:${r.entityId}:${r.impressions}`))

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(
      `INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`,
      [id],
    )
  }
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; h.override = {}; h.published = []; gatewayLedger.length = 0; redisStore.clear()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('GOOGLE_ADS_DEVELOPER_TOKEN', '')
  setOpsBudgetRedisForTests(memoryRedis)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? '{}')) as { query?: string; pageToken?: string }
    h.calls.push({ url: String(url), method: String(init.method), query: body.query ?? '', pageToken: body.pageToken ?? null, headers: init.headers as Record<string, string>, at: Date.now() })
    return answer(body.query ?? '', body.pageToken ?? null)
  }))
})
afterEach(() => { vi.unstubAllGlobals(); __rateTest.reset(); setOpsBudgetRedisForTests(undefined) })

/** Every call a GoogleAdsService.Search of this account — a read, never anything else. */
function expectOnlyReads() {
  for (const call of h.calls) {
    expect(call.method).toBe('POST')
    expect(call.url).toBe(`https://googleads.googleapis.com/v25/customers/${CID}/googleAds:search`)
    expect(googleKind(call.method, call.url)).toBe('read')
    expect(call.query.startsWith('SELECT ')).toBe(true)
  }
  for (const row of gatewayLedger) expect(row).toMatchObject({ channel: 'GOOGLE', connectionId: TARGET.connectionId, outcome: 'sent' })
}

describe('dailyReadWindow', () => {
  it('14 days ending yesterday; after missed runs it reaches back to the day after the last day read, at most 400 days', () => {
    expect(dailyReadWindow('Europe/Rome', RUN_1, '2026-10-11')).toEqual({ from: '2026-09-29', to: '2026-10-12' })
    expect(dailyReadWindow('Europe/Rome', RUN_1, '2026-09-01')).toEqual({ from: '2026-09-02', to: '2026-10-12' })
    expect(dailyReadWindow('Europe/Rome', RUN_1, '2024-01-01')).toEqual({ from: '2025-09-08', to: '2026-10-12' })
    expect(dailyReadWindow('Europe/Rome', RUN_1, null)).toEqual({ from: '2026-09-29', to: '2026-10-12' })
  })
})

describe('syncGoogleAdsAccount (fixtures → gateway → PGlite)', () => {
  it('the first read: 400 days, campaigns, numbers, changes — 4 operations, only reads, in this business only', async () => {
    const result = await inA(() => syncGoogleAdsAccount(TARGET, { kind: 'BACKFILL', now: RUN_1 }))
    expect(result).toMatchObject({
      status: 'SUCCESS', mode: 'BACKFILL', error: null, ops: 4, campaigns: 3, campaignsRemoved: 0, metricRows: 3, changeEvents: 3,
      window: { from: '2025-09-08', to: '2026-10-12' },
    })
    // customer, campaigns page 1 + page 2 (free), days, changes
    expect(h.calls.map((c) => c.query.split(' FROM ')[1]?.split(' ')[0])).toEqual(['customer', 'campaign', 'campaign', 'campaign', 'change_event'])
    expect(h.calls[3].query).toContain("WHERE segments.date BETWEEN '2025-09-08' AND '2026-10-12'")
    expect(h.calls[4].query).toContain("change_event.change_date_time >= '2026-09-14 00:00:00' AND change_event.change_date_time <= '2026-10-13 08:25:00'")
    expect(h.calls.every((c) => !('login-customer-id' in c.headers) && !('developer-token' in c.headers))).toBe(true)
    expectOnlyReads()
    // 5 reserved, 1 given back.
    expect(RUN_OPS).toBe(5)
    expect(accountOps()).toBe(4)

    await inA(async () => {
      const account = await getGoogleAdsCustomer(CID)
      expect(account).toMatchObject({
        workspaceId: A, connectionId: TARGET.connectionId, descriptiveName: 'Test advertiser', currencyCode: 'EUR', timeZone: 'Europe/Rome', status: 'ENABLED',
        lastSyncStatus: 'SUCCESS', lastSyncError: null, opsUsedLastRun: 4, changesSyncedThrough: RUN_1,
        metricsReadFrom: new Date('2025-09-08T00:00:00Z'), metricsReadThrough: new Date('2026-10-12T00:00:00Z'),
      })
      expect(account?.backfillCompletedAt).toBeInstanceOf(Date)
      expect(await db().googleAdsCampaign.count()).toBe(3)
      expect(await daysStored()).toEqual(['2026-10-11:11111111111:1520', '2026-10-12:11111111111:310', '2026-10-12:44444444444:12'])
      expect(await db().googleAdsChangeEvent.count()).toBe(3)
    })
    expect(h.published).toEqual([expect.objectContaining({ type: 'campaign.metrics.refreshed', channel: 'GOOGLE', rows: 3 })])
    await withWorkspace(scope(B), async () => {
      expect(await db().googleAdsCampaign.count()).toBe(0)
      expect(await db().googleAdsDailyMetric.count()).toBe(0)
    })
  })

  it('the daily read: 14 days ending yesterday; the change history from 10 minutes before where the last read stopped', async () => {
    const result = await inA(() => syncGoogleAdsAccount(TARGET, { kind: 'DAILY', now: RUN_2 }))
    expect(result).toMatchObject({ status: 'SUCCESS', mode: 'DAILY', ops: 4, window: { from: '2026-09-30', to: '2026-10-13' } })
    expect(h.calls[3].query).toContain("BETWEEN '2026-09-30' AND '2026-10-13'")
    // RUN_1 (06:25 UTC) − 10 min = 08:15 in Rome.
    expect(h.calls[4].query).toContain("change_event.change_date_time >= '2026-10-13 08:15:00'")
    expectOnlyReads()
    await inA(async () => {
      // The change history is stored once however often it is read.
      expect(await db().googleAdsChangeEvent.count()).toBe(3)
      expect(await getGoogleAdsCustomer(CID)).toMatchObject({ metricsReadFrom: new Date('2025-09-08T00:00:00Z'), metricsReadThrough: new Date('2026-10-13T00:00:00Z') })
    })
  })

  it('a manager account: one call, MANAGER in words, the rest of the allowance given back', async () => {
    h.override.customer = json({ results: [{ customer: { id: CID, descriptiveName: 'Test manager', currencyCode: 'EUR', timeZone: 'Europe/Rome', manager: true, status: 'ENABLED' } }] })
    const result = await inA(() => syncGoogleAdsAccount(TARGET, { kind: 'MANUAL', now: RUN_2 }))
    expect(result).toMatchObject({ status: 'MANAGER', ops: 1, mode: null })
    expect(result.error).toMatch(/manager account/)
    expect(h.calls).toHaveLength(1)
    expect(accountOps()).toBe(1)
    await inA(async () => expect(await getGoogleAdsCustomer(CID)).toMatchObject({ manager: true, lastSyncStatus: 'MANAGER', opsUsedLastRun: 1 }))
    // Back to the advertiser for the next cases.
    h.override = {}
    await inA(() => syncGoogleAdsAccount(TARGET, { kind: 'DAILY', now: RUN_2 }))
  })

  it('no allowance: not a single call, SKIPPED_BUDGET in words, the last success kept', async () => {
    setOpsBudgetRedisForTests(null)
    const before = await inA(() => getGoogleAdsCustomer(CID))
    const result = await inA(() => syncGoogleAdsAccount(TARGET, { kind: 'DAILY', now: RUN_2 }))
    expect(result).toMatchObject({ status: 'SKIPPED_BUDGET', ops: 0 })
    expect(result.error).toMatch(/allowance/)
    expect(h.calls).toHaveLength(0)
    expect(gatewayLedger).toHaveLength(0)
    // Not a read: "Nexus read this account at …" (enqueue.ts) keeps naming the last run that called Google.
    expect(before?.lastSyncAt).toBeInstanceOf(Date)
    await inA(async () => expect(await getGoogleAdsCustomer(CID)).toMatchObject({ lastSyncStatus: 'SKIPPED_BUDGET', lastSuccessAt: before?.lastSuccessAt, lastSyncAt: before?.lastSyncAt }))
  })

  it('the sign-in lost mid-run: the run stops at once, AUTH_LOST, nothing stored is deleted', async () => {
    const before = await inA(daysStored)
    h.override.campaigns = fail('authRevoked')
    const result = await inA(() => syncGoogleAdsAccount(TARGET, { kind: 'DAILY', now: RUN_2 }))
    expect(result).toMatchObject({ status: 'AUTH_LOST', ops: 2, campaigns: 0, metricRows: 0, changeEvents: 0 })
    expect(result.error).toMatch(/Reconnect Google/)
    expect(h.calls).toHaveLength(2)
    expect(accountOps()).toBe(2)
    await inA(async () => {
      expect(await daysStored()).toEqual(before)
      expect(await db().googleAdsCampaign.count({ where: { removedAt: null } })).toBe(3)
      expect(await getGoogleAdsCustomer(CID)).toMatchObject({ lastSyncStatus: 'AUTH_LOST', metricsReadThrough: new Date('2026-10-13T00:00:00Z') })
    })
  })

  it('a refused daily query: PARTIAL, the stored days and their range untouched, the change history still read', async () => {
    const before = await inA(daysStored)
    h.override.days = fail('queryError')
    const result = await inA(() => syncGoogleAdsAccount(TARGET, { kind: 'DAILY', now: RUN_2 }))
    expect(result).toMatchObject({ status: 'PARTIAL', ops: 4, campaigns: 3, metricRows: 0 })
    expect(result.error).toMatch(/Google Ads refused the request/)
    expect(h.calls.map((c) => c.query.split(' FROM ')[1]?.split(' ')[0])).toEqual(['customer', 'campaign', 'campaign', 'campaign', 'change_event'])
    expect(h.published).toEqual([])
    await inA(async () => {
      expect(await daysStored()).toEqual(before)
      expect(await getGoogleAdsCustomer(CID)).toMatchObject({ lastSyncStatus: 'PARTIAL', metricsReadFrom: new Date('2025-09-08T00:00:00Z'), metricsReadThrough: new Date('2026-10-13T00:00:00Z') })
    })
  })

  it('a manager path: every call carries login-customer-id', async () => {
    await inA(() => syncGoogleAdsAccount({ ...TARGET, loginCustomerId: '9876543210' }, { kind: 'DAILY', now: RUN_2 }))
    expect(h.calls.length).toBeGreaterThan(0)
    for (const call of h.calls) expect(call.headers['login-customer-id']).toBe('9876543210')
  })

  it('a refused settings query: the numbers are still stored and the settings read time stays put (a campaign seen only in the numbers is then "not read yet", never "removed")', async () => {
    const before = await inA(() => getGoogleAdsCustomer(CID))
    h.override.campaigns = fail('queryError')
    const result = await inA(() => syncGoogleAdsAccount(TARGET, { kind: 'DAILY', now: RUN_2 }))
    expect(result).toMatchObject({ status: 'PARTIAL', campaigns: 0, campaignsRemoved: 0 })
    expect(result.metricRows).toBeGreaterThan(0)
    await inA(async () => {
      expect((await getGoogleAdsCustomer(CID))?.structureSyncedAt).toEqual(before?.structureSyncedAt)
      expect(await db().googleAdsCampaign.count({ where: { removedAt: null } })).toBe(3)
    })
    // A settings read that succeeds is stamped when Google was asked, not when its answer was stored.
    h.override = {}; h.calls = []
    await inA(() => syncGoogleAdsAccount(TARGET, { kind: 'DAILY', now: RUN_2 }))
    const asked = h.calls.find((c) => c.query.includes(' FROM campaign WHERE campaign.status'))!
    const stamped = (await inA(() => getGoogleAdsCustomer(CID)))?.structureSyncedAt
    expect(stamped).toBeInstanceOf(Date)
    expect(stamped!.getTime()).toBeLessThanOrEqual(asked.at)
  })

  it('operations spent beyond the reservation are counted, even over the account\'s cap — never refused and given back', async () => {
    // Every clock at RUN_2, so the run's own hour is the one whose allowance is full.
    vi.useFakeTimers({ now: RUN_2, toFake: ['Date'] })
    try {
      redisStore.set(`nexus:gads:ops:acct:${CID}:2026101406`, '55') // the run's 5 fit exactly under 60
      const sequence = (...answers: Array<() => Response>) => { let n = 0; return () => answers[Math.min(n++, answers.length - 1)]() }
      const dayRows = (JSON.parse(raw('search-campaign-days.json')) as { results: unknown[] }).results
      // Each query's second page has expired once: Google is asked for its first page again, one more operation each.
      h.override.campaigns = sequence(ok('search-campaigns-page-1.json'), fail('expiredPageToken'), ok('search-campaigns-page-1.json'), ok('search-campaigns-page-2.json'))
      h.override.days = sequence(json({ results: dayRows.slice(0, 2), nextPageToken: 'days-page-2' }), fail('expiredPageToken'), json({ results: dayRows.slice(0, 2), nextPageToken: 'days-page-2' }), json({ results: dayRows.slice(2) }))
      const result = await inA(() => syncGoogleAdsAccount(TARGET, { kind: 'DAILY', now: RUN_2 }))
      expect(result).toMatchObject({ status: 'SUCCESS', ops: 6 })
      expect(RUN_OPS).toBe(5)
      // 55 before, 5 reserved, 1 spent beyond: all 6 counted although the account is now over its 60.
      expect(accountOps()).toBe(61)
    } finally {
      vi.useRealTimers()
    }
  })
})

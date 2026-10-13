/**
 * Google Ads step 1a — the reads behind the Google Ads tab (R1–R4) and "Read now" (S), on a real PostgreSQL with the
 * production schema and every business policy (PGlite), business profiles ON. The business's Google sign-ins
 * (google-accounts.service.ts) and the read queue (enqueue.ts) are stubbed; every number comes from the GoogleAds*
 * tables.
 *
 * Proven here: a day counts as zero only inside the days Nexus read, any other day is "not read" with no numbers and
 * stays out of every total; ratios are Nexus's, from the sums, null over a zero; money is in minor units of the
 * account's own currency (EUR 2 decimals, JPY none), never converted; `to` is clamped to the account's yesterday in its
 * time zone; `provisionalFrom` starts the 14-day re-read; `previous` only when its window was read in full; a campaign
 * Google removed before Nexus first read it still carries its numbers; the change history never carries the person's
 * e-mail; and one business never reads another's rows or ids. Values are made up (public repo).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace, workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { InvalidCursorError } from '../../../lib/pagination/cursor.js'

const mocks = vi.hoisted(() => ({
  accounts: {} as Record<string, unknown[]>,
  enqueue: vi.fn(async (_args: { customerId?: string; kind: string }) => ({ queued: true, reason: null as string | null })),
}))
vi.mock('../../google/google-accounts.service.js', () => ({ listGoogleAccounts: async () => mocks.accounts[workspaceIdForQuery()] ?? [] }))
vi.mock('./enqueue.js', () => ({ enqueueGoogleAdsSync: mocks.enqueue }))

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }) }))

import {
  GoogleAdsReadError,
  MAX_WINDOW_DAYS,
  changeSummary,
  currencyExponent,
  googleAdsCampaigns,
  googleAdsOverview,
  googleCampaignChanges,
  googleCampaignDays,
  microsToMinor,
  removedSinceItsNumbers,
  requestGoogleAdsRead,
} from './read.service.js'

const A = 'gads_read_alpha'
const B = 'gads_read_bravo'
const NONE = 'gads_read_none'
const C = 'gads_read_charlie'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const inC = <T>(work: () => Promise<T>) => withWorkspace(scope(C), work)
const db = () => database.client
/** 08:30 in Rome on 13 Oct: the account's yesterday is 12 Oct. */
const NOW = new Date('2026-10-13T06:30:00Z')
const day = (ymd: string) => new Date(`${ymd}T00:00:00Z`)
const ids: Record<string, string> = {}

const A_CUSTOMER = '1234567890'
const B_CUSTOMER = '5550001112'
const C_CUSTOMER = '7770001113'

function googleAccount(connectionId: string, ads: { customerId: string; name: string; currency: string; timeZone: string } | null) {
  return {
    connectionId,
    label: 'Test Google sign-in',
    state: ads ? 'ok' : 'choose_account',
    stateText: ads ? 'Nexus reads this account once a day.' : 'Choose a Google Ads account for Nexus to read.',
    authStatus: 'connected',
    missingProducts: [],
    ads: ads ? { ...ads, isTest: false } : null,
    manager: null,
    merchantCenter: null,
    analytics: null,
    read: { lastReadAt: null, lastDataDay: null, nextReadAt: null, lastError: null },
  }
}

async function seedA() {
  await inA(async () => {
    await db().googleAdsCustomer.create({
      data: {
        connectionId: 'conn-a', customerId: A_CUSTOMER, descriptiveName: 'Test advertiser A', currencyCode: 'EUR', timeZone: 'Europe/Rome', status: 'ENABLED',
        metricsReadFrom: day('2026-08-01'), metricsReadThrough: day('2026-10-10'), lastSuccessAt: new Date('2026-10-11T06:30:00Z'),
        changesSyncedThrough: new Date('2026-10-13T06:00:00Z'), structureSyncedAt: new Date('2026-10-11T06:29:00Z'),
      },
    })
    const campaign = (campaignId: string, name: string, extra: Record<string, unknown>) =>
      db().googleAdsCampaign.create({ data: { customerId: A_CUSTOMER, campaignId, name, status: 'ENABLED', channelType: 'SEARCH', currencyCode: 'EUR', lastSeenAt: new Date('2026-10-11T06:29:00Z'), ...extra } as never })
    ids.c1 = (await campaign('111', 'Alpha search', { biddingStrategyType: 'MAXIMIZE_CONVERSIONS', budgetAmountMicros: 25_000_000n, startDate: day('2026-03-01') })).id
    ids.c2 = (await campaign('222', 'Bravo shopping', { status: 'PAUSED', channelType: 'SHOPPING', budgetShared: true })).id
    ids.c3 = (await campaign('333', 'Charlie max', { channelType: 'PERFORMANCE_MAX', removedAt: new Date('2026-10-11T06:29:00Z') })).id

    const metric = (campaignId: string, date: string, impressions: number, clicks: number, costMicros: bigint, conversions: string, valueMicros: bigint, label?: string) =>
      db().googleAdsDailyMetric.create({
        data: { customerId: A_CUSTOMER, date: day(date), entityType: 'CAMPAIGN', entityId: campaignId, campaignId, label: label ?? null, impressions, clicks, costMicros, conversions, conversionsValueMicros: valueMicros, currencyCode: 'EUR', pulledAt: new Date('2026-10-11T06:29:30Z') },
      })
    await metric('111', '2026-10-10', 1000, 50, 12_345_000n, '2.5', 61_725_000n)
    await metric('111', '2026-10-01', 500, 0, 0n, '0', 0n)
    await metric('222', '2026-10-05', 200, 10, 5_000_000n, '0', 0n)
    // Google removed this one before Nexus first read the account: numbers, no settings row.
    await metric('999', '2026-10-03', 100, 4, 2_000_000n, '1', 10_000_000n, 'Old removed campaign')
    // A stray row on a day outside the days read: never counted.
    await metric('111', '2026-10-11', 9999, 999, 99_000_000n, '9', 99_000_000n)
    // The window before (18 Aug – 14 Sep), read in full.
    await metric('111', '2026-09-01', 300, 6, 3_000_000n, '0', 0n)

    const change = (n: number, campaignId: string, changedAt: string, extra: Record<string, unknown>) =>
      db().googleAdsChangeEvent.create({
        data: {
          customerId: A_CUSTOMER, resourceName: `customers/${A_CUSTOMER}/changeEvents/${n}~0~0`, changedAt: new Date(changedAt), resourceType: 'CAMPAIGN',
          changeResourceName: `customers/${A_CUSTOMER}/campaigns/${campaignId}`, operation: 'UPDATE', campaignId, userEmail: 'test.person@example.test', ...extra,
        } as never,
      })
    await change(1, '111', '2026-10-12T10:00:00Z', { resourceType: 'CAMPAIGN_BUDGET', clientType: 'GOOGLE_ADS_WEB_CLIENT', changedFields: ['amount_micros'] })
    await change(2, '111', '2026-10-08T09:00:00Z', { clientType: 'GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION', changedFields: ['target_roas.target_roas', 'bidding_strategy_type'] })
    await change(3, '111', '2026-08-01T09:00:00Z', { clientType: 'GOOGLE_ADS_EDITOR', changedFields: ['status'] }) // older than 30 days
    await change(4, '222', '2026-10-09T09:00:00Z', { clientType: 'GOOGLE_ADS_API', changedFields: ['status'] }) // another campaign
    await change(5, '999', '2026-10-02T09:00:00Z', { operation: 'REMOVE', clientType: 'SOMETHING_NEW', changedFields: [] })
  })
}

async function seedB() {
  await inB(async () => {
    await db().googleAdsCustomer.create({
      data: { connectionId: 'conn-b', customerId: B_CUSTOMER, descriptiveName: 'Test advertiser B', currencyCode: 'JPY', timeZone: 'Asia/Tokyo', status: 'ENABLED', metricsReadFrom: day('2026-09-01'), metricsReadThrough: day('2026-10-12'), lastSuccessAt: new Date('2026-10-12T22:00:00Z') },
    })
    ids.b1 = (await db().googleAdsCampaign.create({ data: { customerId: B_CUSTOMER, campaignId: '777', name: 'Bravo business campaign', status: 'ENABLED', channelType: 'SEARCH', budgetAmountMicros: 5_000_000_000n, currencyCode: 'JPY', lastSeenAt: new Date('2026-10-12T22:00:00Z') } })).id
    await db().googleAdsDailyMetric.create({
      data: { customerId: B_CUSTOMER, date: day('2026-10-10'), entityType: 'CAMPAIGN', entityId: '777', campaignId: '777', impressions: 4000, clicks: 80, costMicros: 1_234_500_000n, conversions: '3', conversionsValueMicros: 9_876_400_000n, currencyCode: 'JPY', pulledAt: new Date('2026-10-12T22:00:00Z') },
    })
    await db().googleAdsChangeEvent.create({ data: { customerId: B_CUSTOMER, resourceName: `customers/${B_CUSTOMER}/changeEvents/1~0~0`, changedAt: new Date('2026-10-10T01:00:00Z'), resourceType: 'CAMPAIGN', changeResourceName: `customers/${B_CUSTOMER}/campaigns/777`, operation: 'UPDATE', campaignId: '777', changedFields: ['name'] } })
  })
}

/**
 * Business C: today's settings read failed (the last one that succeeded was yesterday at 08:29 in Rome), today's
 * numbers read worked. Two campaigns have numbers and no settings row: one whose last day with numbers ended before that
 * settings read (removed), one with numbers only after it (added since: not read yet).
 */
async function seedC() {
  await inC(async () => {
    await db().googleAdsCustomer.create({
      data: {
        connectionId: 'conn-c', customerId: C_CUSTOMER, descriptiveName: 'Test advertiser C', currencyCode: 'EUR', timeZone: 'Europe/Rome', status: 'ENABLED',
        metricsReadFrom: day('2026-10-01'), metricsReadThrough: day('2026-10-12'), lastSuccessAt: new Date('2026-10-12T06:30:00Z'),
        structureSyncedAt: new Date('2026-10-12T06:29:00Z'),
      },
    })
    await db().googleAdsCampaign.create({ data: { customerId: C_CUSTOMER, campaignId: '100', name: 'Known campaign', status: 'ENABLED', channelType: 'SEARCH', currencyCode: 'EUR', lastSeenAt: new Date('2026-10-12T06:29:00Z') } })
    const metric = (campaignId: string, date: string, label: string) => db().googleAdsDailyMetric.create({
      data: { customerId: C_CUSTOMER, date: day(date), entityType: 'CAMPAIGN', entityId: campaignId, campaignId, label, impressions: 10, clicks: 1, costMicros: 1_000_000n, conversions: '0', conversionsValueMicros: 0n, currencyCode: 'EUR', pulledAt: new Date('2026-10-13T06:29:30Z') },
    })
    await metric('100', '2026-10-12', 'Known campaign')
    await metric('300', '2026-10-05', 'Gone campaign')
    await metric('200', '2026-10-12', 'New campaign')
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B, NONE, C]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
  }
  mocks.accounts[A] = [googleAccount('conn-a', { customerId: A_CUSTOMER, name: 'Test advertiser A', currency: 'EUR', timeZone: 'Europe/Rome' })]
  mocks.accounts[B] = [googleAccount('conn-b', { customerId: B_CUSTOMER, name: 'Test advertiser B', currency: 'JPY', timeZone: 'Asia/Tokyo' })]
  mocks.accounts[C] = [googleAccount('conn-c', { customerId: C_CUSTOMER, name: 'Test advertiser C', currency: 'EUR', timeZone: 'Europe/Rome' })]
  await seedA()
  await seedB()
  await seedC()
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

type Row = Record<string, any>
const WINDOW = { from: '2026-09-15', to: '2026-10-13' }

describe('money and ratios', () => {
  it('minor units by the currency\'s own exponent; micros summed first, rounded once', () => {
    expect([currencyExponent('EUR'), currencyExponent('JPY'), currencyExponent('KWD'), currencyExponent(null), currencyExponent('not a currency')]).toEqual([2, 0, 3, 2, 2])
    expect(microsToMinor(12_345_000n, 2)).toBe(1235)
    expect(microsToMinor(12_344_999n, 2)).toBe(1234)
    expect(microsToMinor(1_234_500_000n, 0)).toBe(1235)
    expect(microsToMinor(1_234_567n, 3)).toBe(1235)
    expect(microsToMinor(0n, 2)).toBe(0)
  })
})

describe('R1 — the overview', () => {
  it('totals over the days read only; ratios from the sums; the days not read have no numbers', async () => {
    const o = await inA(() => googleAdsOverview({ ...WINDOW }, NOW))
    expect(o.account?.connectionId).toBe('conn-a')
    expect(o.accounts).toHaveLength(1)
    expect(o).toMatchObject({ currency: 'EUR', timeZone: 'Europe/Rome', dataAsOf: '2026-10-11T06:30:00.000Z' })
    // `to` (today) is clamped to the account's yesterday; the re-read starts 14 days before it.
    expect(o.window).toEqual({ from: '2026-09-15', to: '2026-10-12', provisionalFrom: '2026-09-29' })
    expect(o.coverage).toEqual({ daysInWindow: 28, daysRead: 26, missingDays: ['2026-10-11', '2026-10-12'] })
    expect(o.totals).toEqual({
      impressions: 1800, clicks: 64, spendCents: 1935, conversions: 3.5, conversionValueCents: 7173,
      ctr: 64 / 1800, avgCpcCents: 30, roas: 71_725_000 / 19_345_000, costPerConversionCents: 553,
    })
    const days = new Map(o.days.map((d) => [d.date, d as Row]))
    expect(o.days).toHaveLength(28)
    expect(days.get('2026-10-10')).toEqual({
      date: '2026-10-10', provisional: true, read: true, impressions: 1000, clicks: 50, spendCents: 1235, conversions: 2.5, conversionValueCents: 6173,
      ctr: 0.05, avgCpcCents: 25, roas: 5, costPerConversionCents: 494,
    })
    // A day read with no row is a zero day; its ratios have no denominator.
    expect(days.get('2026-10-02')).toEqual({
      date: '2026-10-02', provisional: true, read: true, impressions: 0, clicks: 0, spendCents: 0, conversions: 0, conversionValueCents: 0,
      ctr: null, avgCpcCents: null, roas: null, costPerConversionCents: null,
    })
    expect(days.get('2026-09-20')).toMatchObject({ provisional: false, read: true, spendCents: 0 })
    // Not read (the stray row on 11 Oct included): no number at all, never 0.
    expect(days.get('2026-10-11')).toEqual({
      date: '2026-10-11', provisional: true, read: false, impressions: null, clicks: null, spendCents: null, conversions: null, conversionValueCents: null,
      ctr: null, avgCpcCents: null, roas: null, costPerConversionCents: null,
    })
    // The window before (18 Aug – 14 Sep) was read in full: compared.
    expect(o.previous).toMatchObject({ from: '2026-08-18', to: '2026-09-14', impressions: 300, clicks: 6, spendCents: 300, conversions: 0, roas: 0, costPerConversionCents: null })
  })

  it('previous only when every day of it was read; a window Nexus never read has no totals', async () => {
    const early = await inA(() => googleAdsOverview({ from: '2026-08-10', to: '2026-08-20' }, NOW))
    expect(early.coverage).toEqual({ daysInWindow: 11, daysRead: 11, missingDays: [] })
    expect(early.window.provisionalFrom).toBeNull()
    expect(early.previous).toBeNull() // 30 Jul – 9 Aug starts before the first day read
    const never = await inA(() => googleAdsOverview({ from: '2026-07-01', to: '2026-07-10' }, NOW))
    expect(never.totals).toBeNull()
    expect(never.coverage.daysRead).toBe(0)
    expect(never.days.every((d) => !d.read && d.spendCents === null)).toBe(true)
  })

  it('the window: last 30 days by default, `from` after `to` shrinks to one day, at most the longest window, a bad day is refused', async () => {
    expect((await inA(() => googleAdsOverview({}, NOW))).window).toEqual({ from: '2026-09-13', to: '2026-10-12', provisionalFrom: '2026-09-29' })
    expect((await inA(() => googleAdsOverview({ from: '2026-10-13', to: '2026-10-13' }, NOW))).window).toEqual({ from: '2026-10-12', to: '2026-10-12', provisionalFrom: '2026-10-12' })
    const long = await inA(() => googleAdsOverview({ from: '2020-01-01', to: '2026-10-12' }, NOW))
    expect(long.coverage.daysInWindow).toBe(MAX_WINDOW_DAYS)
    await expect(inA(() => googleAdsOverview({ from: '2026-02-31' }, NOW))).rejects.toMatchObject({ status: 400, message: 'from must be a day written YYYY-MM-DD.' })
    await expect(inA(() => googleAdsOverview({ to: 'yesterday' }, NOW))).rejects.toBeInstanceOf(GoogleAdsReadError)
  })

  it('JPY: minor units are yen, in the account\'s own time zone (Tokyo is already on 13 Oct at 15:30)', async () => {
    const o = await inB(() => googleAdsOverview({ from: '2026-10-01', to: '2026-10-20' }, NOW))
    expect(o.window).toEqual({ from: '2026-10-01', to: '2026-10-12', provisionalFrom: '2026-10-01' })
    expect(o.totals).toMatchObject({ spendCents: 1235, conversionValueCents: 9876, avgCpcCents: 15, costPerConversionCents: 412 })
    expect(o.currency).toBe('JPY')
  })

  it('no Google, or no Google Ads account chosen: the account (or none), no numbers', async () => {
    const none = await withWorkspace(scope(NONE), () => googleAdsOverview({ ...WINDOW }, NOW))
    expect(none).toMatchObject({ accounts: [], account: null, currency: null, totals: null, previous: null, dataAsOf: null })
    expect(none.window.provisionalFrom).toBeNull()
    mocks.accounts[NONE] = [googleAccount('conn-none', null)]
    try {
      const choose = await withWorkspace(scope(NONE), () => googleAdsOverview({ ...WINDOW }, NOW))
      expect(choose.account).toMatchObject({ connectionId: 'conn-none', state: 'choose_account', ads: null })
      expect(choose.totals).toBeNull()
      expect((await withWorkspace(scope(NONE), () => googleAdsCampaigns({ ...WINDOW }, NOW))).items).toEqual([])
    } finally {
      delete mocks.accounts[NONE]
    }
  })

  it('an account the business does not hold is not found', async () => {
    await expect(inA(() => googleAdsOverview({ connectionId: 'conn-b', ...WINDOW }, NOW))).rejects.toMatchObject({ status: 404, message: 'Google account not found' })
  })
})

describe('R2 — the campaigns', () => {
  it('each campaign with its settings, its own numbers over the read days, by name; the unseen removed one too', async () => {
    const page = await inA(() => googleAdsCampaigns({ ...WINDOW }, NOW))
    expect(page).toMatchObject({ currency: 'EUR', dataAsOf: '2026-10-11T06:30:00.000Z', total: 4, nextCursor: null })
    expect(page.coverage.missingDays).toEqual(['2026-10-11', '2026-10-12'])
    expect(page.items.map((c) => c.name)).toEqual(['Alpha search', 'Bravo shopping', 'Charlie max', 'Old removed campaign'])
    const [alpha, bravo, charlie, old] = page.items
    expect(alpha).toEqual({
      campaignId: ids.c1, externalCampaignId: '111', name: 'Alpha search', status: 'ENABLED', servingStatus: null, primaryStatus: null, type: 'SEARCH',
      biddingStrategy: 'MAXIMIZE_CONVERSIONS', dailyBudgetCents: 2500, budgetShared: false, startDate: '2026-03-01', endDate: null,
      settingsReadAt: '2026-10-11T06:29:00.000Z',
      metrics: { impressions: 1500, clicks: 50, spendCents: 1235, conversions: 2.5, conversionValueCents: 6173, ctr: 50 / 1500, avgCpcCents: 25, roas: 5, costPerConversionCents: 494 },
    })
    expect(bravo).toMatchObject({ status: 'PAUSED', type: 'SHOPPING', dailyBudgetCents: null, budgetShared: true, metrics: { spendCents: 500, conversions: 0, roas: 0, costPerConversionCents: null } })
    // Read with no numbers in the window: zero, never "not read".
    expect(charlie).toMatchObject({ status: 'REMOVED', type: 'PERFORMANCE_MAX', metrics: { impressions: 0, spendCents: 0, ctr: null } })
    expect(old).toMatchObject({ campaignId: `${A_CUSTOMER}~999`, externalCampaignId: '999', status: 'REMOVED', type: 'UNKNOWN', settingsReadAt: '2026-10-11T06:29:00.000Z', metrics: { spendCents: 200, conversions: 1 } })
    // The campaigns add up to the account's totals.
    const overview = await inA(() => googleAdsOverview({ ...WINDOW }, NOW))
    expect(page.items.reduce((sum, c) => sum + c.metrics!.spendCents, 0)).toBe(overview.totals!.spendCents)
  })

  it('metrics null when Nexus read no day of the window', async () => {
    const page = await inA(() => googleAdsCampaigns({ from: '2026-07-01', to: '2026-07-10' }, NOW))
    expect(page.items.map((c) => c.metrics)).toEqual([null, null, null])
  })

  it('filters by status, type and name; pages with a cursor, no campaign twice', async () => {
    const names = async (filters: Record<string, string>) => (await inA(() => googleAdsCampaigns({ ...WINDOW, ...filters }, NOW))).items.map((c) => c.name)
    expect(await names({ status: 'removed' })).toEqual(['Charlie max', 'Old removed campaign'])
    expect(await names({ type: 'shopping' })).toEqual(['Bravo shopping'])
    expect(await names({ type: 'OTHER' })).toEqual(['Old removed campaign'])
    expect(await names({ search: 'ALPHA' })).toEqual(['Alpha search'])
    await expect(inA(() => googleAdsCampaigns({ ...WINDOW, status: 'RUNNING' }, NOW))).rejects.toMatchObject({ status: 400 })
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page = await inA(() => googleAdsCampaigns({ ...WINDOW, limit: 1, cursor }, NOW))
      expect(page.items.length).toBeLessThanOrEqual(1)
      expect(page.total).toBe(4)
      seen.push(...page.items.map((c) => c.campaignId))
      cursor = page.nextCursor
    } while (cursor)
    expect(seen).toEqual([ids.c1, ids.c2, ids.c3, `${A_CUSTOMER}~999`])
    const first = await inA(() => googleAdsCampaigns({ ...WINDOW, limit: 1 }, NOW))
    await expect(inA(() => googleAdsCampaigns({ ...WINDOW, limit: 1, status: 'ENABLED', cursor: first.nextCursor }, NOW))).rejects.toBeInstanceOf(InvalidCursorError)
    await expect(inB(() => googleAdsCampaigns({ ...WINDOW, limit: 1, cursor: first.nextCursor }, NOW))).rejects.toBeInstanceOf(InvalidCursorError)
  })
})

describe('a campaign with numbers but no settings row: removed, or not read yet', () => {
  it('REMOVED only when a settings read that succeeded came after its last day with numbers; else null (not read yet)', async () => {
    const page = await inC(() => googleAdsCampaigns({ from: '2026-10-01', to: '2026-10-12' }, NOW))
    expect(page.items.map((c) => [c.name, c.status])).toEqual([['Gone campaign', 'REMOVED'], ['Known campaign', 'ENABLED'], ['New campaign', null]])
    // Its numbers still count; it is not offered under any status filter.
    expect(page.items.find((c) => c.name === 'New campaign')).toMatchObject({ campaignId: `${C_CUSTOMER}~200`, type: 'UNKNOWN', metrics: { spendCents: 100 } })
    expect((await inC(() => googleAdsCampaigns({ from: '2026-10-01', to: '2026-10-12', status: 'REMOVED' }, NOW))).items.map((c) => c.name)).toEqual(['Gone campaign'])
    const days = await inC(() => googleCampaignDays(`${C_CUSTOMER}~200`, { from: '2026-10-12', to: '2026-10-12' }, NOW))
    expect(days.campaign).toMatchObject({ name: 'New campaign', status: null })
  })

  it('"after its last day" is after that day ENDS in the account\'s time zone', () => {
    // 12 Oct ends at 22:00 UTC in Rome (summer time), at 07:00 UTC on 13 Oct in Los Angeles.
    expect(removedSinceItsNumbers(new Date('2026-10-12T21:59:59Z'), '2026-10-12', 'Europe/Rome')).toBe(false)
    expect(removedSinceItsNumbers(new Date('2026-10-12T22:00:00Z'), '2026-10-12', 'Europe/Rome')).toBe(true)
    expect(removedSinceItsNumbers(new Date('2026-10-13T06:59:59Z'), '2026-10-12', 'America/Los_Angeles')).toBe(false)
    expect(removedSinceItsNumbers(new Date('2026-10-13T07:00:00Z'), '2026-10-12', 'America/Los_Angeles')).toBe(true)
    // An unknown time zone: the latest a day ends anywhere (UTC−12).
    expect(removedSinceItsNumbers(new Date('2026-10-13T11:59:59Z'), '2026-10-12', '')).toBe(false)
    expect(removedSinceItsNumbers(new Date('2026-10-13T12:00:00Z'), '2026-10-12', 'Not/AZone')).toBe(true)
    // No settings read yet, or no day with numbers: not known.
    expect(removedSinceItsNumbers(null, '2026-10-12', 'Europe/Rome')).toBe(false)
    expect(removedSinceItsNumbers(new Date('2026-10-13T12:00:00Z'), null, 'Europe/Rome')).toBe(false)
  })
})

describe('R3 — one campaign\'s days', () => {
  it('its days in its account\'s time zone, read or not; its totals', async () => {
    const d = await inA(() => googleCampaignDays(ids.c1, { from: '2026-10-08', to: '2026-10-12' }, NOW))
    expect(d.campaign).toMatchObject({ campaignId: ids.c1, metrics: { impressions: 1000, spendCents: 1235 } })
    expect(d).toMatchObject({ currency: 'EUR', window: { from: '2026-10-08', to: '2026-10-12', provisionalFrom: '2026-10-08' }, coverage: { daysInWindow: 5, daysRead: 3, missingDays: ['2026-10-11', '2026-10-12'] } })
    expect(d.days.map((x) => [x.date, x.read, x.spendCents])).toEqual([
      ['2026-10-08', true, 0], ['2026-10-09', true, 0], ['2026-10-10', true, 1235], ['2026-10-11', false, null], ['2026-10-12', false, null],
    ])
  })

  it('the campaign Google removed before Nexus first read the account opens by its own id', async () => {
    const d = await inA(() => googleCampaignDays(`${A_CUSTOMER}~999`, { from: '2026-10-01', to: '2026-10-05' }, NOW))
    expect(d.campaign).toMatchObject({ name: 'Old removed campaign', status: 'REMOVED', metrics: { spendCents: 200 } })
    expect(d.days.find((x) => x.date === '2026-10-03')).toMatchObject({ read: true, spendCents: 200, conversions: 1 })
  })

  it('another business\'s campaign, or an id that names nothing, is not found', async () => {
    for (const id of [ids.b1, `${B_CUSTOMER}~777`, `${A_CUSTOMER}~424242`, 'nothing', '']) {
      await expect(inA(() => googleCampaignDays(id, {}, NOW)), id).rejects.toMatchObject({ status: 404, message: 'Campaign not found' })
    }
    for (const id of [ids.c1, `${A_CUSTOMER}~999`]) {
      await expect(inB(() => googleCampaignDays(id, {}, NOW)), id).rejects.toMatchObject({ status: 404 })
      await expect(inB(() => googleCampaignChanges(id, NOW)), id).rejects.toMatchObject({ status: 404 })
    }
    const own = await inB(() => googleCampaignDays(ids.b1, { from: '2026-10-10', to: '2026-10-10' }, NOW))
    expect(own.campaign).toMatchObject({ name: 'Bravo business campaign', dailyBudgetCents: 5000, metrics: { spendCents: 1235 } })
  })
})

describe('R4 — Google\'s change history of one campaign', () => {
  it('the last 30 days, newest first, where each change was made in words, never the person', async () => {
    const changes = await inA(() => googleCampaignChanges(ids.c1, NOW))
    expect(changes.coveredFrom).toBe('2026-09-13T06:30:00.000Z')
    expect(changes.items).toEqual([
      {
        changedAt: '2026-10-12T10:00:00.000Z', resourceType: 'CAMPAIGN_BUDGET', operation: 'UPDATE', changedFields: ['amount_micros'],
        source: 'google_ads_web', sourceText: 'Google Ads website',
        summary: 'Campaign budget changed: amount. Someone made this change on the Google Ads website.',
      },
      {
        changedAt: '2026-10-08T09:00:00.000Z', resourceType: 'CAMPAIGN', operation: 'UPDATE', changedFields: ['target_roas.target_roas', 'bidding_strategy_type'],
        source: 'google_automatic', sourceText: 'Google, automatically',
        summary: 'Campaign changed: target roas, bidding strategy type. Google applied one of its recommendations automatically (auto-apply is on).',
      },
    ])
    expect(JSON.stringify(changes)).not.toMatch(/example\.test|@|test\.person/)
    const unseen = await inA(() => googleCampaignChanges(`${A_CUSTOMER}~999`, NOW))
    expect(unseen.items).toEqual([expect.objectContaining({ operation: 'REMOVE', source: 'other', sourceText: 'Other', summary: 'Campaign removed. Google did not say where this change was made.' })])
  })

  it('no change history read yet: coveredFrom is null', async () => {
    expect((await inB(() => googleCampaignChanges(ids.b1, NOW))).coveredFrom).toBeNull()
  })

  it('a summary names at most five fields, never a value', () => {
    expect(changeSummary('AD_GROUP_ASSET', 'UPDATE', ['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'Somewhere.')).toBe('Ad group asset changed: a, b, c, d, e and 2 more. Somewhere.')
    expect(changeSummary('AD_GROUP', 'CREATE', ['name', 'status'], 'Somewhere.')).toBe('Ad group added. Somewhere.')
  })
})

describe('S — read now', () => {
  it('asks the read queue for the chosen account, and passes its answer on', async () => {
    mocks.enqueue.mockClear()
    expect(await inA(() => requestGoogleAdsRead({}))).toEqual({ queued: true, reason: null })
    expect(mocks.enqueue).toHaveBeenCalledWith({ customerId: A_CUSTOMER, kind: 'MANUAL' })
    mocks.enqueue.mockResolvedValueOnce({ queued: false, reason: 'A read of this Google Ads account was asked for less than an hour ago.' })
    expect(await inA(() => requestGoogleAdsRead({ connectionId: 'conn-a' }))).toEqual({ queued: false, reason: 'A read of this Google Ads account was asked for less than an hour ago.' })
  })

  it('nothing to read: no call to the queue, the reason in words; another business\'s account is not found', async () => {
    mocks.enqueue.mockClear()
    expect(await withWorkspace(scope(NONE), () => requestGoogleAdsRead({}))).toEqual({ queued: false, reason: 'Google is not connected for this business.' })
    await expect(inA(() => requestGoogleAdsRead({ connectionId: 'conn-b' }))).rejects.toMatchObject({ status: 404 })
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })
})

/**
 * Ads wave 4b (F4) — each Amazon Ads account's currency is stored from discovery, and a report in an unknown currency
 * is skipped (said so), never counted as euro. The euro markets keep working exactly as before, even with no stored
 * row and no discovery scope.
 */
import { gzipSync } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Profile = Record<string, unknown> & { profileId: string }
const profiles: Profile[] = []
const scopes: Array<{ externalId: string; metadata: Record<string, unknown> }> = []
const conns: Array<{ profileId: string; region: string; marketplace: string; isActive: boolean }> = []
const profileWrites: Array<{ op: 'create' | 'update'; data: Record<string, unknown> }> = []
const jobUpdates: Array<Record<string, unknown>> = []
const perfUpserts: Array<{ create: Record<string, unknown> }> = []
const created: string[] = []
const createAlert = vi.fn(async () => null)
let job: Record<string, unknown> | null = null
let gapRows: Array<Record<string, unknown>> = []

const byProfile = (where: { workspace_profileId: { profileId: string } }) => where.workspace_profileId.profileId

vi.mock('../../db.js', () => ({
  default: {
    $queryRawUnsafe: vi.fn(async () => gapRows),
    amazonAdsProfile: {
      findMany: vi.fn(async ({ where }: { where: { profileId: { in: string[] } } }) => profiles.filter((p) => where.profileId.in.includes(p.profileId))),
      findUnique: vi.fn(async ({ where }: { where: { workspace_profileId: { profileId: string } } }) => profiles.find((p) => p.profileId === byProfile(where)) ?? null),
      create: vi.fn(async ({ data }: { data: Profile }) => { profileWrites.push({ op: 'create', data }); profiles.push({ ...data }); return data }),
      update: vi.fn(async ({ where, data }: { where: { workspace_profileId: { profileId: string } }; data: Record<string, unknown> }) => {
        profileWrites.push({ op: 'update', data })
        Object.assign(profiles.find((p) => p.profileId === byProfile(where))!, data)
        return data
      }),
    },
    connectionScope: {
      findFirst: vi.fn(async ({ where }: { where: { externalId: string } }) => scopes.find((s) => s.externalId === where.externalId) ?? null),
    },
    amazonAdsConnection: {
      findMany: vi.fn(async () => conns.filter((c) => c.isActive)),
      findUnique: vi.fn(async ({ where }: { where: { workspace_profileId: { profileId: string } } }) => conns.find((c) => c.profileId === byProfile(where)) ?? null),
    },
    campaign: {
      groupBy: vi.fn(async ({ by }: { by: string[] }) =>
        by.includes('adProduct')
          ? conns.map((c) => ({ marketplace: c.marketplace, adProduct: 'SPONSORED_PRODUCTS', _count: { _all: 1 } }))
          : conns.map((c) => ({ marketplace: c.marketplace, _count: { _all: 1 } }))),
      findFirst: vi.fn(async () => null),
    },
    amazonAdsDailyPerformance: {
      groupBy: vi.fn(async () => []),
      upsert: vi.fn(async (args: { create: Record<string, unknown> }) => { perfUpserts.push(args); return {} }),
    },
    amazonAdsReportJob: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'job-new' })),
      findUnique: vi.fn(async () => job),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { jobUpdates.push(data); return {} }),
    },
  },
}))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../monitoring/alert.service.js', () => ({ alertService: { createAlert }, AlertType: { SYNC_FAILURE: 'SYNC_FAILURE' } }))
vi.mock('./ads-api-client.js', () => ({
  adsMode: () => 'live',
  REPORT_V3_MIME: 'application/vnd.createasyncreportrequest.v3+json',
  liveCall: vi.fn(async (args: { profileId: string }) => { created.push(args.profileId); return { reportId: `r-${args.profileId}`, status: 'PENDING' } }),
}))

const facts = await import('./ads-profile-facts.service.js')
const reports = await import('./ads-reports.service.js')
const gapfill = await import('./ads-report-gapfill.service.js')

const scope = (externalId: string, region: string | null, metadata: Record<string, unknown>) => ({ externalId, region, metadata })

beforeEach(() => {
  profiles.length = 0
  scopes.length = 0
  conns.length = 0
  profileWrites.length = 0
  jobUpdates.length = 0
  perfUpserts.length = 0
  created.length = 0
  createAlert.mockClear()
  facts.__adsProfileFactsTest.clearAlerted()
  job = null
  gapRows = []
  vi.unstubAllGlobals()
})

describe('profileFactsOf — what discovery says, as the columns want it', () => {
  it('maps market, region, country, currency, timezone and account', () => {
    expect(facts.profileFactsOf(scope('p-uk', 'EU', {
      marketplace: 'UK', currencyCode: 'gbp', timezone: 'Europe/London', accountType: 'seller', accountId: 'ENT1', accountName: 'Shop',
    }))).toEqual({
      profileId: 'p-uk', marketplace: 'UK', region: 'EU', countryCode: 'UK', currencyCode: 'GBP', timezone: 'Europe/London',
      accountType: 'seller', accountEntityId: 'ENT1', accountName: 'Shop',
    })
  })

  it('is null without a market or a region, and a non-ISO currency is not a currency', () => {
    expect(facts.profileFactsOf(scope('p', 'EU', {}))).toBeNull()
    expect(facts.profileFactsOf(scope('p', null, { marketplace: 'IT' }))).toBeNull()
    expect(facts.profileFactsOf(scope('p', 'EU', { marketplace: 'IT', currencyCode: 'euro' }))?.currencyCode).toBeNull()
    expect(facts.profileFactsOf(scope('p', 'EU', { marketplace: 'APJ6JRA9NG5V4', currencyCode: 'EUR' }))?.countryCode).toBeNull()
  })
})

describe('fillAdsProfileFacts — additive upsert from discovery, no Amazon call', () => {
  it('creates a row per discovered profile with its own currency', async () => {
    const r = await facts.fillAdsProfileFacts([
      scope('p-it', 'EU', { marketplace: 'IT', currencyCode: 'EUR', timezone: 'Europe/Rome' }),
      scope('p-uk', 'EU', { marketplace: 'UK', currencyCode: 'GBP', timezone: 'Europe/London' }),
      scope('p-us', 'NA', { marketplace: 'US', currencyCode: 'USD', timezone: 'America/Los_Angeles' }),
    ])
    expect(r).toEqual({ filled: 3, unchanged: 0, noCurrency: [], skipped: 0 })
    expect(profiles.map((p) => [p.profileId, p.marketplace, p.region, p.currencyCode, p.timezone])).toEqual([
      ['p-it', 'IT', 'EU', 'EUR', 'Europe/Rome'],
      ['p-uk', 'UK', 'EU', 'GBP', 'Europe/London'],
      ['p-us', 'US', 'NA', 'USD', 'America/Los_Angeles'],
    ])
  })

  it('🔴 never creates a row without a currency (the column default would be the EUR guess again)', async () => {
    const r = await facts.fillAdsProfileFacts([scope('p-jp', 'FE', { marketplace: 'JP', timezone: 'Asia/Tokyo' })])
    expect(r).toEqual({ filled: 0, unchanged: 0, noCurrency: ['JP'], skipped: 0 })
    expect(profileWrites).toEqual([])
  })

  it('corrects a stored currency from discovery, writes only what changed, and never blanks a field', async () => {
    profiles.push({ profileId: 'p-se', marketplace: 'SE', region: 'EU', countryCode: 'SE', currencyCode: 'EUR', timezone: 'Europe/Stockholm', accountType: 'seller', accountEntityId: 'E', accountName: 'Shop' })
    const r = await facts.fillAdsProfileFacts([scope('p-se', 'EU', { marketplace: 'SE', currencyCode: 'SEK' })])
    expect(r.filled).toBe(1)
    expect(profileWrites).toHaveLength(1)
    expect(profileWrites[0].op).toBe('update')
    expect(profileWrites[0].data).toMatchObject({ currencyCode: 'SEK' })
    expect(Object.keys(profileWrites[0].data).sort()).toEqual(['currencyCode', 'lastProfileFetchAt'])
    expect(profiles[0]).toMatchObject({ timezone: 'Europe/Stockholm', accountName: 'Shop' })
  })

  it('writes nothing when the stored row already agrees (control)', async () => {
    profiles.push({ profileId: 'p-it', marketplace: 'IT', region: 'EU', countryCode: 'IT', currencyCode: 'EUR', timezone: 'Europe/Rome', accountType: 'seller', accountEntityId: null, accountName: null })
    const r = await facts.fillAdsProfileFacts([scope('p-it', 'EU', { marketplace: 'IT', currencyCode: 'EUR', timezone: 'Europe/Rome', accountType: 'seller' })])
    expect(r).toEqual({ filled: 0, unchanged: 1, noCurrency: [], skipped: 0 })
    expect(profileWrites).toEqual([])
  })

  it('a scope with no region or market is skipped, never guessed', async () => {
    expect(await facts.fillAdsProfileFacts([scope('p', null, { marketplace: 'IT', currencyCode: 'EUR' })])).toMatchObject({ skipped: 1, filled: 0 })
    expect(profileWrites).toEqual([])
  })
})

describe('adsProfileCurrency — stored, then discovery, then Amazon\'s checked market table', () => {
  it('reads the stored row first', async () => {
    profiles.push({ profileId: 'p-uk', currencyCode: 'GBP' })
    scopes.push({ externalId: 'p-uk', metadata: { currencyCode: 'EUR' } })
    expect(await facts.adsProfileCurrency('p-uk', 'UK')).toEqual({ currencyCode: 'GBP', source: 'profile' })
  })

  it('then the discovery scope (before the first reconcile ran)', async () => {
    scopes.push({ externalId: 'p-pl', metadata: { currencyCode: 'PLN' } })
    expect(await facts.adsProfileCurrency('p-pl', 'PL')).toEqual({ currencyCode: 'PLN', source: 'discovery' })
  })

  it('a euro market with nothing stored and no scope is still EUR — from the checked table, as before', async () => {
    for (const m of ['IT', 'DE', 'FR', 'ES']) expect(await facts.adsProfileCurrency(`p-${m}`, m)).toEqual({ currencyCode: 'EUR', source: 'market-limits' })
    // An Amazon marketplace id (HB.8 rows) is normalised first.
    expect(await facts.adsProfileCurrency('p-x', 'APJ6JRA9NG5V4')).toEqual({ currencyCode: 'EUR', source: 'market-limits' })
  })

  it('🔴 any other market with nothing known is UNKNOWN — never EUR', async () => {
    for (const m of ['UK', 'SE', 'PL', 'US', 'JP', '', null]) expect(await facts.adsProfileCurrency('p-?', m)).toBeNull()
  })
})

describe('the report paths', () => {
  it('🔴 a campaign-report cycle skips an unknown-currency account, says so once a day, and keeps the euro ones', async () => {
    conns.push(
      { profileId: 'p-it', region: 'EU', marketplace: 'IT', isActive: true },
      { profileId: 'p-us', region: 'NA', marketplace: 'US', isActive: true },
    )
    await reports.runReportCreationCycle({ startDate: '2026-10-04', endDate: '2026-10-04', adProducts: ['SPONSORED_PRODUCTS'] })
    expect(created).toEqual(['p-it'])
    await reports.runSearchTermReportCycle({ startDate: '2026-10-04', endDate: '2026-10-04', adProducts: ['SPONSORED_PRODUCTS'] })
    await reports.runPlacementReportCycle({ startDate: '2026-10-04', endDate: '2026-10-04' })
    await reports.runAdvertisedProductReportCycle({ startDate: '2026-10-04', endDate: '2026-10-04' })
    await reports.runTargetingReportCycle({ startDate: '2026-10-04', endDate: '2026-10-04' })
    expect(created).not.toContain('p-us')
    expect(created.filter((p) => p === 'p-it')).toHaveLength(5)
    // One alert for the account, not one per cycle.
    expect(createAlert).toHaveBeenCalledTimes(1)
    expect(createAlert.mock.calls[0]).toEqual(expect.arrayContaining(['SYNC_FAILURE', 'Amazon Ads US: reports skipped, currency unknown']))
  })

  it('a non-euro account with a known currency is asked like any other', async () => {
    conns.push({ profileId: 'p-uk', region: 'EU', marketplace: 'UK', isActive: true })
    scopes.push({ externalId: 'p-uk', metadata: { currencyCode: 'GBP' } })
    await reports.runReportCreationCycle({ startDate: '2026-10-04', endDate: '2026-10-04', adProducts: ['SPONSORED_PRODUCTS'] })
    expect(created).toEqual(['p-uk'])
    expect(createAlert).not.toHaveBeenCalled()
  })

  it('🔴 ingest: an unknown-currency report is not downloaded, not stored, and stays un-ingested', async () => {
    conns.push({ profileId: 'p-us', region: 'NA', marketplace: 'US', isActive: true })
    job = { id: 'j1', profileId: 'p-us', adProduct: 'SPONSORED_PRODUCTS', reportTypeId: 'spCampaigns', status: 'COMPLETED', location: 'https://reports.example.test/j1' }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await reports.ingestCompletedJob('j1')).toEqual({ jobId: 'j1', rowsIngested: 0, error: 'currency_unknown' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(perfUpserts).toEqual([])
    expect(jobUpdates).toEqual([{ errorMessage: 'currency unknown for US: not ingested (never counted as EUR)' }])
  })

  it('ingest: a euro account with nothing stored still stores EUR, exactly as before', async () => {
    conns.push({ profileId: 'p-it', region: 'EU', marketplace: 'IT', isActive: true })
    job = { id: 'j2', profileId: 'p-it', adProduct: 'SPONSORED_PRODUCTS', reportTypeId: 'spCampaigns', status: 'COMPLETED', location: 'https://reports.example.test/j2' }
    const body = gzipSync(Buffer.from(JSON.stringify([{ date: '2026-10-04', campaignId: 111, impressions: 10, clicks: 1, cost: 0.5 }])))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    expect(await reports.ingestCompletedJob('j2')).toEqual({ jobId: 'j2', rowsIngested: 1 })
    expect(perfUpserts[0].create).toMatchObject({ marketplace: 'IT', currencyCode: 'EUR', costMicros: BigInt(500_000) })
  })

  it('ingest: a pound account stores GBP, not EUR', async () => {
    conns.push({ profileId: 'p-uk', region: 'EU', marketplace: 'UK', isActive: true })
    profiles.push({ profileId: 'p-uk', marketplace: 'UK', currencyCode: 'GBP' })
    job = { id: 'j3', profileId: 'p-uk', adProduct: 'SPONSORED_PRODUCTS', reportTypeId: 'spCampaigns', status: 'COMPLETED', location: 'https://reports.example.test/j3' }
    const body = gzipSync(Buffer.from(JSON.stringify([{ date: '2026-10-04', campaignId: 222, cost: 1 }])))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    await reports.ingestCompletedJob('j3')
    expect(perfUpserts[0].create).toMatchObject({ marketplace: 'UK', currencyCode: 'GBP' })
  })

  it('🔴 gap fill: an unknown-currency gap waits (said so); a euro gap is re-requested as before', async () => {
    gapRows = [
      { profileId: 'p-it', marketplace: 'IT', region: 'EU', day: new Date('2026-10-01T00:00:00Z'), kind: 'day', unattributed: 0 },
      { profileId: 'p-us', marketplace: 'US', region: 'NA', day: new Date('2026-10-01T00:00:00Z'), kind: 'day', unattributed: 0 },
    ]
    const out = await gapfill.runGapFillCycle({ lookbackDays: 3 })
    expect(new Set(created)).toEqual(new Set(['p-it']))
    expect(out.jobsCreated).toBe(2) // the campaign and the advertised-product report for IT's day
    expect(createAlert).toHaveBeenCalledTimes(1)
  })
})

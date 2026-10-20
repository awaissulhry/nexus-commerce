/**
 * Meta ads step 2 — the daily read end to end and the reads behind Ads › Meta, on a real PostgreSQL with the production
 * schema and every business policy (PGlite), business profiles ON. Meta is stubbed at metaCall (the gateway is proven in
 * gateway/meta.vitest.test.ts); the business's Meta connections are stubbed at listMetaConnections.
 *
 * Proven here: a first read stores the account, campaigns, ad sets, ads and 180 days of numbers per grain, in pieces of
 * 30, through GET only; a day counts as zero only inside the days read and any other day is "not read" with no numbers;
 * money is in minor units of the account's currency (EUR, JPY), converted once; a campaign Meta no longer returns is
 * marked deleted; Meta asking to slow down stops the run (THROTTLED) and a dead token (190) ends it (AUTH_LOST) without
 * touching what was stored; and one business never reads another's rows. Made-up ids and names (public repo).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace, workspaceIdForQuery } from '../../../lib/workspace-context.js'

type Answer = { ok: boolean; status: number; body: unknown; verdict?: { errorClass: string; channelCode: string; channelMessage: string } }
const h = vi.hoisted(() => ({
  calls: [] as Array<{ operation: string; path: string; query: Record<string, unknown>; connectionId: string | null }>,
  override: null as null | ((req: { operation: string; path: string; query: Record<string, unknown> }) => Answer | null),
  connections: {} as Record<string, unknown[]>,
  campaigns: ['120000000000101', '120000000000102'],
  enqueue: vi.fn(async (_args: unknown) => ({ queued: true, reason: null as string | null })),
}))

const AD_ACCOUNT = '1234567890'
const B_ACCOUNT = '1234567891'
function answerFor(req: { operation: string; path: string; query: Record<string, unknown> }): Answer {
  const custom = h.override?.(req)
  if (custom) return custom
  const ok = (body: unknown): Answer => ({ ok: true, status: 200, body })
  const account = req.path.startsWith(`act_${B_ACCOUNT}`) ? B_ACCOUNT : AD_ACCOUNT
  const currency = account === B_ACCOUNT ? 'JPY' : 'EUR'
  const zone = account === B_ACCOUNT ? 'Asia/Tokyo' : 'Europe/Rome'
  if (req.operation === 'adAccount.read') return ok({ id: `act_${account}`, account_id: account, name: 'Shop A ads', currency, timezone_name: zone, account_status: 1, disable_reason: 0, business: { id: '9876543210', name: 'Shop A portfolio' } })
  if (req.operation === 'adAccount.money') return ok({ amount_spent: '123456', spend_cap: '0', balance: '0', min_daily_budget: 100, is_prepay_account: false })
  if (req.operation === 'adAccount.settings') return ok({ capabilities: [], tos_accepted: { web_custom_audience_tos: 1 }, opportunity_score: 72.5 })
  if (req.operation.startsWith('adAccount.')) return ok({ data: [] })
  if (req.operation === 'campaigns.list') return ok({ data: h.campaigns.map((id, i) => ({ id, name: `Shop A campaign ${i + 1}`, status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: account === B_ACCOUNT ? '3000' : '2500' })) })
  if (req.operation === 'adsets.list') return ok({ data: [{ id: '120000000000201', campaign_id: '120000000000101', name: 'Italy', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '1000' }] })
  if (req.operation === 'ads.list') return ok({ data: [{ id: '120000000000301', campaign_id: '120000000000101', adset_id: '120000000000201', name: 'Ad 1', status: 'ACTIVE', effective_status: 'ACTIVE', creative: { id: '120000000000401', title: 'Jacket' } }] })
  if (req.operation.startsWith('insights.')) {
    const range = req.query.time_range as { since: string; until: string }
    const level = String(req.query.level)
    const rows: Record<string, unknown>[] = []
    for (const date of ['2026-10-10', '2026-10-12']) {
      if (date < range.since || date > range.until) continue
      rows.push({
        date_start: date, date_stop: date, campaign_id: '120000000000101', campaign_name: 'Shop A campaign 1', adset_id: '120000000000201', adset_name: 'Italy',
        ad_id: '120000000000301', ad_name: 'Ad 1', impressions: '1000', clicks: '20', inline_link_clicks: '15', reach: '800', spend: level === 'campaign' ? '12.34' : '10.00',
        actions: [{ action_type: 'omni_purchase', value: '2' }], action_values: [{ action_type: 'omni_purchase', value: '99.80' }],
      })
    }
    return ok({ data: rows })
  }
  return { ok: false, status: 404, body: {}, verdict: { errorClass: 'not_found', channelCode: '100/33', channelMessage: 'unknown in the stub' } }
}

vi.mock('../../gateway/meta.js', async (importOriginal) => ({
  metaUrl: (await importOriginal<typeof import('../../gateway/meta.js')>()).metaUrl,
  metaCall: vi.fn(async (req: { operation: string; path: string; query?: Record<string, unknown>; connectionId: string | null }) => {
    h.calls.push({ operation: req.operation, path: req.path, query: req.query ?? {}, connectionId: req.connectionId })
    const a = answerFor({ operation: req.operation, path: req.path, query: req.query ?? {} })
    return { ok: a.ok, status: a.status, headers: new Headers(), verdict: a.ok ? null : a.verdict ?? null, url: req.path, json: () => a.body }
  }),
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: async () => h.connections[workspaceIdForQuery()] ?? [] }))
vi.mock('./enqueue.js', () => ({ enqueueMetaAdsSync: h.enqueue }))

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }) }))

import { syncMetaAdAccount, syncMetaAdAccountById } from './sync.service.js'
import { metaAdsAds, metaAdsAdSets, metaAdsCampaigns, metaAdsOverview, metaCampaignDays, requestMetaAdsRead } from './read.service.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaReadOnlyProblem } from '../../gateway/meta-calls.js'

const A = 'meta_read_alpha'
const B = 'meta_read_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client
/** 08:50 in Rome on 20 Oct: the account's yesterday is 19 Oct. */
const NOW = new Date('2026-10-20T06:50:00Z')
const conn: Record<string, string> = {}

const metaConnection = (connectionId: string, adAccountId: string, currency: string, timeZone: string) => ({
  connectionId, state: 'ok', stateText: 'ok', adAccount: { adAccountId, name: 'Shop A ads', currency, timeZone, businessId: '9876543210', statusText: 'Active' }, page: null, instagram: null,
})

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
  }
  for (const [ws, account] of [[A, AD_ACCOUNT], [B, B_ACCOUNT]] as const) {
    await withWorkspace(scope(ws), async () => {
      const c = await db().channelConnection.create({ data: { channelType: 'META', isActive: true, authStatus: 'connected', managedBy: 'oauth', externalAccountId: `120000000000${ws === A ? '001' : '002'}` } })
      conn[ws] = c.id
      await db().metaAccountLink.create({ data: { connectionId: c.id, product: 'AD_ACCOUNT', externalId: account, label: 'Shop A ads', selectedByUserId: 'u-1' } })
    })
  }
  h.connections[A] = [metaConnection(conn[A], AD_ACCOUNT, 'EUR', 'Europe/Rome')]
  h.connections[B] = [metaConnection(conn[B], B_ACCOUNT, 'JPY', 'Asia/Tokyo')]
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

beforeEach(() => { h.calls.length = 0; h.override = null; h.campaigns = ['120000000000101', '120000000000102'] })

describe('the first read', () => {
  it('stores the account, the structure and 180 days per grain in pieces of 30, all through GET reads', async () => {
    const result = await inA(() => syncMetaAdAccount({ connectionId: conn[A], adAccountId: AD_ACCOUNT }, { kind: 'BACKFILL', now: NOW }))
    expect(result).toMatchObject({ status: 'SUCCESS', mode: 'BACKFILL', campaigns: 2, adSets: 1, ads: 1, window: { from: '2026-04-23', to: '2026-10-19' } })
    // 3 grains × 6 pieces of 30 days.
    expect(h.calls.filter((c) => c.operation.startsWith('insights.'))).toHaveLength(18)
    expect(h.calls.every((c) => c.connectionId === conn[A])).toBe(true)
    const insights = h.calls.find((c) => c.operation === 'insights.campaignDays')!.query as Record<string, unknown>
    expect(insights).toMatchObject({ level: 'campaign', time_increment: 1 })
    // Meta ignores both since 2025-06-10 (each ad set's own attribution is used): never sent (facts F2 T1).
    expect(Object.keys(insights)).not.toContain('use_unified_attribution_setting')
    expect(Object.keys(insights)).not.toContain('action_report_time')
    // Every call the daily read made is one the real gateway lets through (its query-key allow-list, the fields rules).
    const refused = h.calls.map((c) => [c.operation, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, c.query as never), kind: 'read' })]).filter(([, problem]) => problem)
    expect(refused).toEqual([])
    await inA(async () => {
      const account = await db().metaAdAccount.findFirstOrThrow({ where: { adAccountId: AD_ACCOUNT } })
      expect(account).toMatchObject({ currencyCode: 'EUR', timeZone: 'Europe/Rome', accountStatus: 1, lastSyncStatus: 'SUCCESS', amountSpentMicros: 1_234_560_000n })
      expect(account.backfillCompletedAt).not.toBeNull()
      expect([account.metricsReadFrom?.toISOString().slice(0, 10), account.metricsReadThrough?.toISOString().slice(0, 10)]).toEqual(['2026-04-23', '2026-10-19'])
      const states = await db().metaAdsReadState.findMany({ where: { adAccountId: AD_ACCOUNT }, orderBy: { resource: 'asc' } })
      expect(states.map((s) => [s.resource, s.lastStatus])).toEqual([['ACCOUNT', 'SUCCESS'], ['ADS', 'SUCCESS'], ['ADSETS', 'SUCCESS'], ['ADSET_DAYS', 'SUCCESS'], ['AD_DAYS', 'SUCCESS'], ['CAMPAIGNS', 'SUCCESS']])
      expect(await db().metaAdsDailyMetric.count({ where: { adAccountId: AD_ACCOUNT } })).toBe(6)
    })
  })
})

describe('the reads behind Ads › Meta', () => {
  it('the overview: a day is zero only inside the days read; totals and ratios from the sums; money in cents', async () => {
    const overview = await inA(() => metaAdsOverview({ from: '2026-04-20', to: '2026-10-19' }, NOW))
    expect(overview.window).toMatchObject({ from: '2026-04-20', to: '2026-10-19', provisionalFrom: '2026-09-22' })
    expect(overview.coverage).toMatchObject({ daysRead: overview.coverage.daysInWindow - 3, missingDays: ['2026-04-20', '2026-04-21', '2026-04-22'] })
    expect(overview.totals).toMatchObject({ impressions: 2000, clicks: 40, spendCents: 2468, purchases: 4, purchaseValueCents: 19960, cpcCents: 62 })
    expect(overview.totals!.roas).toBeCloseTo(199.6 / 24.68, 6)
    const byDay = new Map(overview.days.map((d) => [d.date, d]))
    expect(byDay.get('2026-10-10')).toMatchObject({ read: true, spendCents: 1234, reach: 800, provisional: true })
    expect(byDay.get('2026-10-11')).toMatchObject({ read: true, spendCents: 0, impressions: 0 })
    expect(byDay.get('2026-04-20')).toMatchObject({ read: false, spendCents: null, impressions: null })
    expect(overview.previous).toBeNull()
    expect(overview.account).toMatchObject({ adAccountId: AD_ACCOUNT, statusText: 'Active', amountSpentCents: 123456, spendCapCents: null })
  })
  it('campaigns, ad sets, ads and one campaign\'s days, with their own grain\'s days read', async () => {
    const campaigns = await inA(() => metaAdsCampaigns({ days: 30 }, NOW))
    expect(campaigns.items.map((c) => [c.metaCampaignId, c.dailyBudgetCents, c.metrics?.spendCents])).toEqual([['120000000000101', 2500, 2468], ['120000000000102', 2500, 0]])
    const adSets = await inA(() => metaAdsAdSets({ days: 30 }, NOW))
    expect(adSets.items).toEqual([expect.objectContaining({ metaAdSetId: '120000000000201', dailyBudgetCents: 1000, metrics: expect.objectContaining({ spendCents: 2000 }) })])
    const ads = await inA(() => metaAdsAds({ days: 30 }, NOW))
    expect(ads.items).toEqual([expect.objectContaining({ metaAdId: '120000000000301', creative: expect.objectContaining({ title: 'Jacket' }) })])
    const days = await inA(() => metaCampaignDays(campaigns.items[0].campaignId, { from: '2026-10-09', to: '2026-10-12' }, NOW))
    expect(days.days.map((d) => [d.date, d.spendCents])).toEqual([['2026-10-09', 0], ['2026-10-10', 1234], ['2026-10-11', 0], ['2026-10-12', 1234]])
  })
  it('another business sees none of it, and a campaign id of another business is "not found"', async () => {
    const campaigns = await inA(() => metaAdsCampaigns({ days: 30 }, NOW))
    const other = await inB(() => metaAdsOverview({ days: 30 }, NOW))
    expect(other.totals).toBeNull()
    await expect(inB(() => metaCampaignDays(campaigns.items[0].campaignId, {}, NOW))).rejects.toMatchObject({ status: 404 })
  })
  it('a JPY account is in yen (no decimals), converted once', async () => {
    await inB(() => syncMetaAdAccount({ connectionId: conn[B], adAccountId: B_ACCOUNT }, { kind: 'BACKFILL', now: NOW }))
    const campaigns = await inB(() => metaAdsCampaigns({ days: 30 }, NOW))
    expect(campaigns.currency).toBe('JPY')
    expect(campaigns.items[0].dailyBudgetCents).toBe(3000)
    expect(campaigns.items[0].metrics?.spendCents).toBe(25)
  })
  it('"Read now" asks the queue for one manual read of the chosen account', async () => {
    await expect(inA(() => requestMetaAdsRead({}))).resolves.toEqual({ queued: true, reason: null })
    expect(h.enqueue).toHaveBeenLastCalledWith({ adAccountId: AD_ACCOUNT, kind: 'MANUAL' })
  })
})

describe('later reads', () => {
  it('a campaign Meta no longer returns is marked deleted; the daily read re-reads 28 days only', async () => {
    h.campaigns = ['120000000000101']
    const NEXT_DAY = new Date('2026-10-21T06:50:00Z')
    const result = await inA(() => syncMetaAdAccount({ connectionId: conn[A], adAccountId: AD_ACCOUNT }, { kind: 'DAILY', now: NEXT_DAY }))
    expect(result).toMatchObject({ status: 'SUCCESS', mode: 'DAILY', removed: 1, window: { from: '2026-09-23', to: '2026-10-20' } })
    const campaigns = await inA(() => metaAdsCampaigns({ days: 30 }, NEXT_DAY))
    expect(campaigns.items.map((c) => [c.metaCampaignId, c.status])).toEqual([['120000000000101', 'ACTIVE'], ['120000000000102', 'DELETED']])
  })
  it('Meta asking to slow down stops the run: THROTTLED, the days stored stay as they were', async () => {
    h.override = (req) => (req.operation === 'insights.campaignDays' ? { ok: false, status: 400, body: {}, verdict: { errorClass: 'rate_limited', channelCode: '17/2446079', channelMessage: 'User request limit reached' } } : null)
    const before = await inA(() => db().metaAdsDailyMetric.count({ where: { adAccountId: AD_ACCOUNT } }))
    const result = await inA(() => syncMetaAdAccount({ connectionId: conn[A], adAccountId: AD_ACCOUNT }, { kind: 'DAILY', now: NOW }))
    expect(result.status).toBe('THROTTLED')
    expect(result.error).toMatch(/slow down/)
    expect(h.calls.some((c) => c.operation === 'insights.adsetDays')).toBe(false)
    expect(await inA(() => db().metaAdsDailyMetric.count({ where: { adAccountId: AD_ACCOUNT } }))).toBe(before)
  })
  it('a dead token (190) ends the run at once: AUTH_LOST, in words', async () => {
    h.override = (req) => (req.operation === 'adAccount.read' ? { ok: false, status: 400, body: {}, verdict: { errorClass: 'auth_revoked', channelCode: '190', channelMessage: 'Error validating access token' } } : null)
    const result = await inA(() => syncMetaAdAccount({ connectionId: conn[A], adAccountId: AD_ACCOUNT }, { kind: 'DAILY', now: NOW }))
    expect(result.status).toBe('AUTH_LOST')
    expect(result.error).toMatch(/new token/)
    expect(h.calls).toHaveLength(1)
  })
  it('an account this business no longer reads gets no call', async () => {
    await expect(inA(() => syncMetaAdAccountById('5550001112', 'DAILY', NOW))).resolves.toMatchObject({ status: 'NOT_LINKED', calls: 0 })
    expect(h.calls).toHaveLength(0)
  })
})

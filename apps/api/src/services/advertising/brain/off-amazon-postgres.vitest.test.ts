/**
 * ONE BRAIN AB-18 — the off-Amazon lane through the `ads-brain` tool on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business profiles
 * ON), over one made-up shape on 2026-10-08: Product A's own campaigns A1 (off Amazon far above its band in both weeks of
 * the settled window) and A2 (off Amazon well inside it), a campaign shared with Product B (off Amazon with no sales) and
 * Product B's own (no off-Amazon row at all); Product A's ACoS target in the ads strategy.
 *
 *   money    the product's view (a dry run, not enrolled: decided as at the default level) — the share, the verdict
 *            "limit suggested" naming A1 only, the shared campaign listed and never summed, the line for the Owner and the
 *            "could not verify" capability; the market's view — each product's share (B: none reported, never "no spend");
 *            every amount hidden from a person without the ad-spend permission; nothing written anywhere
 *   map      the off-Amazon lever's owner says nobody in Nexus reads or writes the setting
 *   lever    enrolled: OBSERVE judges as before; OFF judges nothing; the Owner's lock at LIMIT turns the line into "check
 *            your console"; another business sees nothing
 *
 * Every value is made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
    }),
  }
})
vi.mock('../../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})

const { enrollProduct, setOverride, setLever } = await import('./enrollment.js')
const { ADS_BRAIN_TOOLS } = await import('../../agents/tools/ads-brain.tools.js')
const { visibleTo } = await import('../../agents/call-tool.js')
const { offAmazonWindow } = await import('./off-amazon-read.js')
const { OFF_AMAZON_CAPABILITY } = await import('./off-amazon.js')
const { OFF_AMAZON_OWNER } = await import('./read-map.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `ab18_off_${hex}`
const W2 = `ab18_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const id = (s: string) => `${hex}-${s}`
const C = (s: string) => id(`c-${s}`)
const A = id('prod-a'), A_S = id('prod-a-s'), B = id('prod-b'), B_L = id('prod-b-l')
const NOW = new Date('2026-10-08T12:00:00Z')
const DAY = 86_400_000
const WINDOW = offAmazonWindow(NOW)
const DAYS = Array.from({ length: 14 }, (_, i) => new Date(Date.parse(`${WINDOW.from}T00:00:00Z`) + i * DAY))

type Data = Record<string, any>
const call = (args: Record<string, unknown>, inX: <T>(work: () => Promise<T>) => Promise<T> = inW) =>
  inX(() => ADS_BRAIN_TOOLS[0].handler!(args, {} as never)) as Promise<{ ok: boolean; data?: Data; error?: string }>
const money = (args: Record<string, unknown>, inX?: <T>(work: () => Promise<T>) => Promise<T>) => call({ view: 'money', ...args }, inX)
/** Rows any write to Amazon would leave (a mutation, a queued sync, an action log) and every brain decision log. */
const written = async () => (await rows<{ n: number }>(
  'SELECT ((SELECT count(*) FROM "AdMutation" WHERE "workspaceId" = $1) + (SELECT count(*) FROM "OutboundSyncQueue" WHERE "workspaceId" = $1) + (SELECT count(*) FROM "AdvertisingActionLog" WHERE "workspaceId" = $1) + (SELECT count(*) FROM "AdsBrainBudgetDecision" WHERE "workspaceId" = $1))::int AS n', [W]))[0].n

async function seed() {
  const db = database.client
  const product = (pid: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: pid, sku, name: sku, basePrice: '80.00', totalStock: 5, ...extra } })
  await product(A, `AB18-A-${hex}`, { isParent: true, name: 'Product A' })
  await product(A_S, `AB18-A-S-${hex}`, { parentId: A, amazonAsin: `B0AB18AS${H}` })
  await product(B, `AB18-B-${hex}`, { isParent: true, name: 'Product B' })
  await product(B_L, `AB18-B-L-${hex}`, { parentId: B, amazonAsin: `B0AB18BL${H}` })
  const campaign = async (key: string, name: string, ads: Array<[string, string]>) => {
    await db.campaign.create({ data: { id: C(key), name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${C(key)}`, dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z') } })
    await db.adGroup.create({ data: { id: `g-${C(key)}`, campaignId: C(key), name: `group ${key}`, externalAdGroupId: `EXT-g-${C(key)}` } })
    await db.adTarget.create({ data: { id: `t-${C(key)}`, adGroupId: `g-${C(key)}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `keyword ${key}`, bidCents: 40, externalTargetId: `EXT-t-${C(key)}` } })
    for (const [productId, asin] of ads) await db.adProductAd.create({ data: { adGroupId: `g-${C(key)}`, productId, asin } })
  }
  const a: [string, string] = [A_S, `B0AB18AS${H}`]
  const b: [string, string] = [B_L, `B0AB18BL${H}`]
  await campaign('a1', 'Campaign A1', [a])
  await campaign('a2', 'Campaign A2', [a])
  await campaign('shared', 'Campaign AB shared', [a, b])
  await campaign('b1', 'Campaign B1', [b])
  // The placement report over the settled window (as ads-reports.service.ts stores it; the ingest is tested on its own):
  // every campaign's three on-Amazon placements; off Amazon (the assumed label, see __fixtures__/off-amazon-report.ts) on
  // A1 at 2.00 a day — no sales in week 1, 1.00 a day in week 2 —, on A2 at 0.20 a day selling 2.00, on the shared one
  // 5.00 a day with no sales; none on B1.
  const off: Record<string, (week: number) => [number, number] | null> = {
    a1: (w) => [2, w === 1 ? 0 : 1], a2: () => [0.2, 2], shared: () => [5, 0], b1: () => null,
  }
  const data: Array<Record<string, unknown>> = []
  const row = (key: string, date: Date, placement: string, cost: number, sales: number, orders: number, clicks: number) => data.push({
    profileId: 'p-it', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date, campaignId: `EXT-${C(key)}`, localCampaignId: C(key), placement,
    impressions: clicks * 40, clicks, costMicros: BigInt(Math.round(cost * 1_000_000)), currencyCode: 'EUR', sales7dCents: Math.round(sales * 100), orders7d: orders, reportRunId: 'run-test',
  })
  DAYS.forEach((date, i) => {
    for (const key of Object.keys(off)) {
      row(key, date, 'Top of Search on-Amazon', 4, 16, 2, 10)
      row(key, date, 'Other on-Amazon', 2, 8, 1, 5)
      row(key, date, 'Detail Page on-Amazon', 2, 0, 0, 5)
      const o = off[key](i < 7 ? 1 : 2)
      if (o) row(key, date, 'Off Amazon', o[0], o[1], o[1] > 0 ? 1 : 0, 4)
    }
  })
  await db.amazonAdsPlacementReport.createMany({ data: data as never })
  // The Owner's money: Product A's ACoS target, the Budget Manager's IT plan.
  await db.adsStrategy.create({ data: { channel: 'AMAZON', market: 'IT', level: 'PRODUCT', scopeId: A, label: 'Product A (IT)', version: 1, monthlySpendCapCents: 30_000, targetKind: 'ACOS', targetPct: 25, updatedBy: 'user:owner' } })
  await db.adBudgetPlan.create({ data: { marketplace: 'IT', month: '2026-10', monthlyBudgetCents: 60_000 } })
}

describe.skipIf(!concurrentDatabaseUrl())('AB-18 — the off-Amazon lane (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(seed)
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('money, one product (dry run, not enrolled): the share, "limit suggested" on A1 only, the shared campaign listed and never summed, the line for the Owner', async () => {
    const before = await written()
    const out = await money({ productId: A_S, market: 'it', now: NOW })
    expect(out.ok).toBe(true)
    const lane = out.data!.offAmazon
    expect(lane).toMatchObject({
      window: { from: WINDOW.from, to: WINDOW.to, days: 14 }, status: 'measured', verdict: 'limit_suggested',
      lever: { effective: 'NOT_ENROLLED', lockValue: null }, limit: [{ campaignId: C('a1'), name: 'Campaign A1' }], capability: OFF_AMAZON_CAPABILITY,
    })
    // A1 and A2 summed: (2.00 + 0.20) a day off Amazon of (10.00 + 8.20) placed; 35.00 of off-Amazon sales in 14 days.
    expect(lane.money).toMatchObject({ currency: 'EUR', campaigns: 2, spendCents: 25_480, offSpendCents: 3_080, offSalesCents: 3_500, sharePct: 12.09, offAcosPct: 88 })
    expect(lane.money.halves.map((h: Data) => [h.from, h.above])).toEqual([[WINDOW.from, true], [new Date(Date.parse(`${WINDOW.from}T00:00:00Z`) + 7 * DAY).toISOString().slice(0, 10), true]])
    expect(lane.money.why).toMatch(/\(not enrolled: decided as at the default level, OBSERVE\)$/)
    expect(Object.fromEntries(lane.campaigns.map((c: Data) => [c.name, [c.owner, c.summed, c.above]]))).toEqual({
      'Campaign A1': ['product', true, true], 'Campaign A2': ['product', true, false], 'Campaign AB shared': ['shared', false, true],
    })
    expect(lane.ownerLine).toBe('Off-Amazon placements of Product A (IT) stayed above the band top for 14 settled days: set "Limit off-Amazon spend" in Amazon\'s console on "Campaign A1". Nexus could not verify an Amazon Ads API setting for it, so the brain cannot ask for it or write it.')
    expect(lane.labels.map((l: Data) => l.label)).toEqual(['Detail Page on-Amazon', 'Off Amazon', 'Other on-Amazon', 'Top of Search on-Amazon'])
    expect(await written()).toBe(before)
  })

  it('money, the market: each product\'s share — B none reported, never "no spend"; every amount hidden without the ad-spend permission', async () => {
    const market = await money({ market: 'IT', now: NOW })
    expect(market.ok).toBe(true)
    const byName = Object.fromEntries(market.data!.products.map((p: Data) => [p.name, p.offAmazon]))
    expect(byName['Product A']).toEqual({ status: 'measured', money: { currency: 'EUR', spendCents: 25_480, offSpendCents: 3_080, sharePct: 12.09, offAcosPct: 88, offNoSales: false } })
    expect(byName['Product B']).toEqual({ status: 'none_reported', money: { currency: 'EUR', spendCents: 11_200, offSpendCents: 0, sharePct: 0, offAcosPct: null, offNoSales: false } })
    const product = await money({ productId: A, market: 'IT', now: NOW })
    const principal = (perms: string[]) => ({ kind: 'user' as const, userId: 'u', label: 'u', via: 'claude' as const, workspace: scope(W), permissions: { isOwner: false, permissions: new Set<string>(perms) } })
    const everything = [...Object.values(FEATURES), ...Object.values(FIELDS)]
    const noMoney = everything.filter((p) => !p.startsWith('financials.'))
    for (const answer of [product.data!.offAmazon, market.data!.products]) {
      expect(JSON.stringify(visibleTo(principal(everything) as never, ADS_BRAIN_TOOLS[0], answer))).toBe(JSON.stringify(answer))
      const text = JSON.stringify(visibleTo(principal(noMoney) as never, ADS_BRAIN_TOOLS[0], answer))
      expect(text).toBe(JSON.stringify(answer, (k, v) => (k === 'money' ? undefined : v)))
      for (const amount of ['3080', '25480', '12.09', '€']) expect(text).not.toContain(amount)
    }
    expect(JSON.stringify(visibleTo(principal(noMoney) as never, ADS_BRAIN_TOOLS[0], product.data!.offAmazon))).toContain('Limit off-Amazon spend')
  })

  it('map: the off-Amazon lever\'s owner says nobody in Nexus reads or writes the setting', async () => {
    const map = await call({ view: 'map', productId: A, market: 'IT' })
    expect(map.ok).toBe(true)
    const campaigns = map.data!.campaigns as Data[]
    expect(campaigns.length).toBeGreaterThan(0)
    for (const c of campaigns) expect(c.levers.offAmazon.owner).toBe(OFF_AMAZON_OWNER)
  })

  it('the lever: enrolled at OBSERVE judges as before; OFF judges nothing; the Owner\'s lock at LIMIT asks him to check his console; nothing written', async () => {
    const before = await written()
    expect(await inW(() => enrollProduct({ productId: A, market: 'IT', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true })
    const observed = (await money({ productId: A, market: 'IT', now: NOW })).data!.offAmazon
    expect(observed).toMatchObject({ verdict: 'limit_suggested', lever: { effective: 'OBSERVE' } })
    expect(observed.money.why).not.toMatch(/not enrolled/)
    expect(await inW(() => setLever({ productId: A, market: 'IT', by: 'user:owner', lever: 'offAmazon', level: 'OFF' }))).toMatchObject({ ok: true })
    expect((await money({ productId: A, market: 'IT', now: NOW })).data!.offAmazon).toMatchObject({ status: 'measured', verdict: 'off', ownerLine: null, limit: [], lever: { effective: 'OFF' } })
    // PROPOSE and AUTO are refused: the setting cannot be asked for or written (could not verify it in the API).
    const refused = await inW(() => setLever({ productId: A, market: 'IT', by: 'user:owner', lever: 'offAmazon', level: 'PROPOSE' }))
    expect(refused).toMatchObject({ ok: false })
    expect(JSON.stringify(refused)).toMatch(/could not verify an Amazon Ads API setting/)
    expect(await inW(() => setLever({ productId: A, market: 'IT', by: 'user:owner', lever: 'offAmazon', level: 'OBSERVE' }))).toMatchObject({ ok: true })
    expect(await inW(() => setOverride({ productId: A, market: 'IT', by: 'user:owner', reason: 'limited by hand', override: { scope: 'PRODUCT', kind: 'LOCK', key: 'offAmazon', value: 'LIMIT' } }))).toMatchObject({ ok: true })
    const locked = (await money({ productId: A, market: 'IT', now: NOW })).data!.offAmazon
    expect(locked).toMatchObject({ verdict: 'limit_suggested', lever: { effective: 'LOCKED', lockValue: 'LIMIT' } })
    expect(locked.ownerLine).toBe('Off-Amazon placements of Product A (IT) stayed above the band top for 14 settled days; your lock holds the off-Amazon setting at LIMIT: check in Amazon\'s console that "Limit off-Amazon spend" is set on "Campaign A1" (Nexus cannot read it).')
    // Reading writes nothing: no decision log, no request, nothing for Amazon (the enrolment and overrides are Nexus's own rows).
    expect(await written()).toBe(before)
  })

  it('another business sees nothing', async () => {
    expect(await money({ productId: A, market: 'IT', now: NOW }, inW2)).toMatchObject({ ok: false, error: 'Product not found' })
    const market = await money({ market: 'IT', now: NOW }, inW2)
    expect(market.ok).toBe(true)
    expect(market.data!.products).toEqual([])
  })
})

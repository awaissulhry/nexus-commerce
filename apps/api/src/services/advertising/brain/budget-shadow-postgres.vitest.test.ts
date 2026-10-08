/**
 * ONE BRAIN AB-7 — the money shadow on a real PostgreSQL (the throwaway PostgreSQL 17 of scripts/run-real-postgres-tests.mjs,
 * row-level policies on, the app as the restricted runtime login, business profiles ON), over a GALE IT shape on
 * 2026-10-08 at 10:45 Rome: ten own campaigns at €20 in the portfolio "Xavia GALE IT" (no cap) spending €12.84 a day, a
 * paused own campaign, a campaign shared with MISANO and MISANO's own; GALE's own monthly budget €400 (ads strategy
 * product row), the Budget Manager's IT plan €600; the stream's spend so far today; the bid brain's goal bids on one
 * campaign; Amazon's budget usage on another.
 *
 *   table    AdsBrainBudgetDecision: invisible to another business through Prisma and raw SQL, refused without a business,
 *            row-level security forced with the business policy and the reference guard
 *   no-op    no product enrolled: nothing planned, nothing written
 *   dry run  the ads-brain money view plans GALE before it is enrolled (NOT_ENROLLED), stores nothing
 *   shadow   enrolled (budgets OBSERVE by default): one row; a rerun writes nothing; the next budget day a snapshot; the
 *            Owner's portfolioCapPct a change; budgets OFF → not planned; nothing at Amazon, no budget or cap changed
 *   read     the plan now beside the newest logged one; the market's split; every amount hidden from a person without
 *            the ad-spend permission, and the rest unchanged
 *   prune    rows older than 30 days are deleted by a run; another business plans and sees nothing
 *
 * Values are made up (public repo), the GALE totals after the design (30 days ≈ €385 spend).
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

const { runMoneyShadowOnce, moneyShadowProducts } = await import('./budget-shadow.js')
const { enrollProduct, setOverride, setLever } = await import('./enrollment.js')
const { ADS_BRAIN_TOOLS } = await import('../../agents/tools/ads-brain.tools.js')
const { visibleTo } = await import('../../agents/call-tool.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `ab7_money_${hex}`
const W2 = `ab7_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const id = (s: string) => `${hex}-${s}`
const C = (s: string) => id(`c-${s}`)
const GALE = id('gale'), GALE_S = id('gale-s'), GALE_M = id('gale-m'), MISANO = id('misano'), MISANO_L = id('misano-l')
const NOW = new Date('2026-10-08T08:45:00Z')
const DAY = 86_400_000
const TABLE = 'AdsBrainBudgetDecision'
/** GALE's ten own campaigns and their spend a day, in cents (€12.84 in all). */
const SPEND = [310, 240, 190, 150, 120, 94, 80, 50, 30, 20]
const OWN = SPEND.map((_, i) => `g${String(i + 1).padStart(2, '0')}`)

type Data = Record<string, any>
// The tool's handler, called directly: `now` is a test seam (the tool's input schema takes no clock and drops it).
const money = (args: Record<string, unknown>, inX: <T>(work: () => Promise<T>) => Promise<T> = inW) =>
  inX(() => ADS_BRAIN_TOOLS[0].handler!({ view: 'money', ...args }, {} as never)) as Promise<{ ok: boolean; data?: Data; error?: string }>
// The day as text: a DATE read as a Date lands on this machine's local midnight.
const decisions = () => rows<Data>('SELECT *, to_char("day", \'YYYY-MM-DD\') AS "dayText" FROM "AdsBrainBudgetDecision" WHERE "workspaceId" = $1 ORDER BY "createdAt", id', [W])
const amazonRows = async () => (await rows<{ n: number }>(
  'SELECT ((SELECT count(*) FROM "AdMutation" WHERE "workspaceId" = $1) + (SELECT count(*) FROM "OutboundSyncQueue" WHERE "workspaceId" = $1) + (SELECT count(*) FROM "AdvertisingActionLog" WHERE "workspaceId" = $1))::int AS n', [W]))[0].n
const budgets = async () => (await rows<{ b: string }>('SELECT DISTINCT "dailyBudget"::text AS b FROM "Campaign" WHERE "workspaceId" = $1', [W])).map((r) => r.b)

async function seed() {
  const db = database.client
  const product = (pid: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: pid, sku, name: sku, basePrice: '99.00', totalStock: 5, ...extra } })
  await product(GALE, `AB7-GALE-${hex}`, { isParent: true, name: 'GALE jacket' })
  await product(GALE_S, `AB7-GALE-S-${hex}`, { parentId: GALE, amazonAsin: `B0AB7GLS${H}` })
  await product(GALE_M, `AB7-GALE-M-${hex}`, { parentId: GALE, amazonAsin: `B0AB7GLM${H}` })
  await product(MISANO, `AB7-MISANO-${hex}`, { isParent: true, name: 'MISANO jacket' })
  await product(MISANO_L, `AB7-MISANO-L-${hex}`, { parentId: MISANO, amazonAsin: `B0AB7MSL${H}` })
  const campaign = async (key: string, name: string, ads: Array<[string, string]>, extra: Record<string, unknown> = {}) => {
    await db.campaign.create({ data: { id: C(key), name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${C(key)}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, portfolioId: `pf-gale-${hex}`, ...extra } })
    await db.adGroup.create({ data: { id: `g-${C(key)}`, campaignId: C(key), name: `group ${key}`, externalAdGroupId: `EXT-g-${C(key)}` } })
    await db.adTarget.create({ data: { id: `t-${C(key)}`, adGroupId: `g-${C(key)}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `jacket ${key}`, bidCents: 40, externalTargetId: `EXT-t-${C(key)}` } })
    for (const [productId, asin] of ads) await db.adProductAd.create({ data: { adGroupId: `g-${C(key)}`, productId, asin } })
  }
  const gale: [string, string] = [GALE_S, `B0AB7GLS${H}`]
  const misano: [string, string] = [MISANO_L, `B0AB7MSL${H}`]
  for (const key of OWN) await campaign(key, `IT_GALE_${key}`, [gale])
  await campaign('paused', 'IT_GALE_paused', [gale], { status: 'PAUSED' })
  await campaign('shared', 'IT_Auto_Close_Gale_Misano_Moss', [gale, misano], { portfolioId: `pf-mix-${hex}` })
  await campaign('misano', 'IT_MISANO_1', [misano], { portfolioId: `pf-mix-${hex}` })
  for (const [pid, name] of [[`pf-gale-${hex}`, 'Xavia GALE IT'], [`pf-mix-${hex}`, 'Auto_FBM_Gale_Misano_Moss']]) {
    await db.amazonAdsPortfolio.create({ data: { profileId: 'p-it', externalPortfolioId: pid, name, state: 'ENABLED', budgetPolicy: 'NO_CAP' } })
  }
  // The daily report, 1 September → 7 October: GALE €12.84 a day (sales on g01: ACoS ≈ 31.6 %), MISANO €4, the shared €1.50.
  const daily: Array<Record<string, unknown>> = []
  const spendOf: Array<[string, number, number]> = [...OWN.map((k, i): [string, number, number] => [k, SPEND[i], i === 0 ? 981 : 0]), ['misano', 400, 1_000], ['shared', 150, 0]]
  for (let t = Date.parse('2026-09-01T00:00:00Z'); t <= Date.parse('2026-10-07T00:00:00Z'); t += DAY) {
    for (const [key, cents, sales] of spendOf) {
      daily.push({ profileId: 'p-it', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(t), entityType: 'CAMPAIGN', entityId: `EXT-${C(key)}`, localEntityId: C(key), costMicros: BigInt(cents) * 10_000n, sales7dCents: sales, orders7d: sales ? (Math.round(t / DAY) % 4 === 0 ? 1 : 0) : 0, currencyCode: 'EUR', reportRunId: 'run-test', reportedAt: new Date(t + DAY) })
    }
  }
  await db.amazonAdsDailyPerformance.createMany({ data: daily as never })
  // The Marketing Stream today: €4.68 on g01 by 08:45 UTC.
  for (let h = 0; h <= 8; h++) await db.amazonAdsHourlyPerformance.create({ data: { profileId: 'p-it', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date('2026-10-08T00:00:00Z'), hour: h, entityType: 'CAMPAIGN', entityId: `EXT-${C('g01')}`, localEntityId: C('g01'), costMicros: 520_000n, currencyCode: 'EUR', reportedAt: NOW } })
  // The bid brain's newest decision on g01: its goal bid 37¢ against today's 40¢.
  await db.bidBrainDecision.create({ data: { runId: 'bb-test', mode: 'SHADOW', kind: 'change', marketplace: 'IT', campaignId: C('g01'), adGroupId: `g-${C('g01')}`, targetId: `t-${C('g01')}`, action: 'write', layer: 'goal', currentCents: 40, decidedCents: 37, dataDay: new Date('2026-09-30T00:00:00Z'), why: 'goal', createdAt: new Date(NOW.getTime() - 3_600_000) } })
  // Amazon's budget usage on g02 today: 82 %.
  await db.adBudgetUsageSample.create({ data: { campaignId: C('g02'), externalCampaignId: `EXT-${C('g02')}`, profileId: 'p-it', marketplace: 'IT', percent: 82, budgetCents: 2_000, usageUpdatedAt: new Date(NOW.getTime() - 600_000), firstSeenAt: new Date(NOW.getTime() - 600_000), lastSeenAt: NOW } })
  // The Owner's money: GALE's own monthly budget €400 (ACoS 30 %), the Budget Manager's IT plan €600.
  await db.adsStrategy.create({ data: { channel: 'AMAZON', market: 'IT', level: 'PRODUCT', scopeId: GALE, label: 'GALE (IT)', version: 2, monthlySpendCapCents: 40_000, targetKind: 'ACOS', targetPct: 30, updatedBy: 'user:owner' } })
  await db.adBudgetPlan.create({ data: { marketplace: 'IT', month: '2026-10', monthlyBudgetCents: 60_000 } })
}

describe.skipIf(!concurrentDatabaseUrl())('AB-7 — the money shadow (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(seed)
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('the table: invisible to another business, refused without one, row-level security forced', async () => {
    const db = database.client
    const data = { runId: 'x', mode: 'SHADOW', kind: 'change', productId: 'x-table-test', marketplace: 'IT', day: new Date('2026-10-08T00:00:00Z'), month: '2026-10', level: 'OBSERVE', envelopeSource: 'none', spentCents: 0, projectedCents: 0, brake: 'none', planHash: 'h', plan: {}, why: 'w' }
    const row = await inW(() => db.adsBrainBudgetDecision.create({ data }))
    expect(row).toMatchObject({ workspaceId: W, productId: 'x-table-test' })
    await inW2(async () => {
      expect(await db.adsBrainBudgetDecision.findMany()).toEqual([])
      expect(await db.$queryRaw`SELECT id FROM "AdsBrainBudgetDecision"`).toEqual([])
      expect(await db.$executeRaw`UPDATE "AdsBrainBudgetDecision" SET brake = 'stop_weakest' WHERE id = ${row.id}`).toBe(0)
      await expect(db.adsBrainBudgetDecision.create({ data: { ...data, workspaceId: W } })).rejects.toMatchObject({ code: 'workspace_mismatch' })
    })
    await expect(db.adsBrainBudgetDecision.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
    expect(await rows('SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1', [TABLE])).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }])
    expect(await rows('SELECT policyname FROM pg_policies WHERE tablename = $1', [TABLE])).toEqual([{ policyname: 'nexus_workspace_isolation' }])
    expect(await rows('SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = $1 AND NOT t.tgisinternal', [TABLE])).toEqual([{ tgname: 'nexus_workspace_references' }])
    await database.pool.query('DELETE FROM "AdsBrainBudgetDecision" WHERE "productId" = \'x-table-test\'')
  })

  it('no-op: no product enrolled — nothing planned, nothing written', async () => {
    expect(await inW(() => moneyShadowProducts())).toEqual([])
    expect(await inW(() => runMoneyShadowOnce({ now: NOW }))).toMatchObject({ ran: false, products: [], pruned: 0 })
    expect(await decisions()).toEqual([])
  })

  it('dry run: the money view plans GALE before it is enrolled, and stores nothing', async () => {
    const before = await amazonRows()
    const out = await money({ productId: GALE_S, market: 'it', now: NOW })
    expect(out.ok).toBe(true)
    const d = out.data!
    expect(d).toMatchObject({ view: 'money', scope: { productId: GALE, market: 'IT' }, dryRun: true, logged: null })
    const p = d.plan
    expect(p).toMatchObject({ productId: GALE, name: 'GALE jacket', month: '2026-10', day: '2026-10-08', enrolled: false, levers: { budgets: { effective: 'NOT_ENROLLED' } } })
    expect(p.envelope).toEqual({ source: 'own', money: { envelopeCents: 40_000, why: 'its own monthly budget (ads strategy: GALE (IT) v2)' } })
    expect(p.pace.money).toMatchObject({ spentCents: 9_456, projectedCents: 39_804, pacePct: 99.51, aimCents: 36_000, allowanceCents: 1_123, runRateCents: 1_284 })
    expect(p.pace).toMatchObject({ aimPct: 90, projection: 'stream and run rate', dayCurve: 'even', hourCurve: 'even', dataThrough: '2026-10-07' })
    expect(p.brake).toMatchObject({ level: 'hold_raises', abovePct: 95, does: 'no raises: bids, budgets and hours hold' })
    expect(p.portfolioCap).toMatchObject({ on: true, source: 'envelope', pct: 115, money: { totalCents: 46_000 } })
    expect(p.portfolioCap.portfolios).toEqual([expect.objectContaining({ portfolioId: `pf-gale-${hex}`, name: 'Xavia GALE IT', campaigns: 11, action: 'set', money: expect.objectContaining({ capCents: 46_000, todayPolicy: 'NO_CAP', sharePct: 100 }) })])
    // Ten own campaigns step down from €20 to €14 (the day-move bound); the paused one holds; the shared one may only go down.
    expect(p.campaigns.map((c: Data) => [c.name, c.owner, c.action, c.money.stepCents])).toEqual([
      ['IT_Auto_Close_Gale_Misano_Moss', 'shared', 'lower', 1_400],
      ...OWN.map((k) => [`IT_GALE_${k}`, 'product', 'lower', 1_400]),
      ['IT_GALE_paused', 'product', 'hold', 2_000],
    ])
    const g01 = p.campaigns.find((c: Data) => c.name === 'IT_GALE_g01')
    // The bid brain's goal bids −7.5 % on g01: €3.10 × 0.925 = €2.87 expected, scaled into the pace, ÷ 70 %.
    expect(g01.money).toMatchObject({ expectedSpendCents: 287, targetCents: 366, band: 'in', bandFrom: 'campaign' })
    expect(p.campaigns.find((c: Data) => c.name === 'IT_GALE_g02').money).toMatchObject({ usagePct: 82, ladder: null, ladderWhy: 'no ladder: the pace brake holds raises (hold_raises)' })
    expect(p.counts).toEqual({ raise: 0, lower: 11, keep: 0, hold: 1, skip: 0, ladder: 0, exceptions: 0 })
    expect(p.why).toBe('GALE jacket (IT) 2026-10 day 8: envelope from its own monthly budget · brake hold_raises: no raises: bids, budgets and hours hold · portfolio cap envelope · 12 campaigns: 11 lower, 0 raise, 0 keep, 1 hold')
    expect(await decisions()).toEqual([])
    expect(await amazonRows()).toBe(before)
  })

  it('shadow: enrolled, GALE is planned and logged once; a rerun writes nothing; the next day a snapshot; the Owner\'s change a change; nothing at Amazon', async () => {
    const before = await amazonRows()
    expect(await inW(() => enrollProduct({ productId: GALE, market: 'IT', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true })
    expect(await inW(() => moneyShadowProducts())).toEqual([{ productId: GALE, market: 'IT', level: 'OBSERVE' }])
    const first = await inW(() => runMoneyShadowOnce({ now: NOW }))
    expect(first).toMatchObject({ ran: true, failed: [], products: [{ productId: GALE, market: 'IT', stored: 'change', brake: 'hold_raises', pacePct: 99.51 }] })
    let logged = await decisions()
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ mode: 'SHADOW', kind: 'change', productId: GALE, marketplace: 'IT', month: '2026-10', level: 'OBSERVE', envelopeCents: 40_000, envelopeSource: 'own', spentCents: 9_456, projectedCents: 39_804, pacePct: '99.51', brake: 'hold_raises', portfolioCapCents: 46_000 })
    expect(logged[0].dayText).toBe('2026-10-08')
    expect(logged[0].plan.campaigns).toHaveLength(12)
    expect(logged[0].why).toBe('GALE jacket (IT) 2026-10 day 8: envelope €400.00 (own) · projected €398.04 = 99.51 % → brake hold_raises · portfolio cap €460.00 (envelope) · 12 campaigns: 11 lower, 0 raise, 0 keep, 1 hold')
    // A rerun on the same facts writes nothing; an hour later the readings drift but the writes do not.
    expect((await inW(() => runMoneyShadowOnce({ now: NOW }))).products[0].stored).toBeNull()
    expect((await inW(() => runMoneyShadowOnce({ now: new Date(NOW.getTime() + 3_600_000) }))).products[0].stored).toBeNull()
    // The next budget day: the day's first plan is kept as a snapshot.
    const tomorrow = new Date(NOW.getTime() + DAY)
    expect((await inW(() => runMoneyShadowOnce({ now: tomorrow }))).products[0]).toMatchObject({ stored: 'snapshot' })
    // The Owner's portfolio cap at 130 %: a changed decision.
    expect(await inW(() => setOverride({ productId: GALE, market: 'IT', by: 'user:owner', reason: 'more headroom', override: { scope: 'PRODUCT', kind: 'VALUE', key: 'portfolioCapPct', value: 130 } }))).toMatchObject({ ok: true })
    expect((await inW(() => runMoneyShadowOnce({ now: new Date(tomorrow.getTime() + 3_600_000) }))).products[0]).toMatchObject({ stored: 'change' })
    logged = await decisions()
    expect(logged.map((r) => [r.kind, r.dayText, r.portfolioCapCents])).toEqual([['change', '2026-10-08', 46_000], ['snapshot', '2026-10-09', 46_000], ['change', '2026-10-09', 52_000]])
    // Nothing reached Amazon: no mutation, no queue, no action log; every budget still €20; the portfolio still has no cap.
    expect(await amazonRows()).toBe(before)
    expect(await budgets()).toEqual(['20.00'])
    expect(await rows('SELECT DISTINCT "budgetPolicy" FROM "AmazonAdsPortfolio" WHERE "workspaceId" = $1', [W])).toEqual([{ budgetPolicy: 'NO_CAP' }])
  })

  it('read: the plan now beside the newest logged one; the market\'s split; every amount hidden from a person without the ad-spend permission', async () => {
    const out = await money({ productId: GALE, market: 'IT', now: new Date(NOW.getTime() + DAY + 3_600_000) })
    expect(out.data!.logged).toMatchObject({ kind: 'change', mode: 'SHADOW', rowsKept: 3, keptDays: 30, plan: { portfolioCap: { pct: 130, money: { totalCents: 52_000 } } } })
    expect(out.data!.plan.levers.budgets.effective).toBe('OBSERVE')
    const market = await money({ market: 'IT', now: NOW })
    expect(market.data!.market.money).toMatchObject({ budgetCents: 60_000, fixedCents: 40_000, sharedCents: 14_545, reserveCents: 5_455, totalCents: 54_545 })
    expect(market.data!.products.map((p: Data) => [p.name, p.envelopeSource, p.money.envelopeCents, p.logged?.brake ?? null])).toEqual([
      ['GALE jacket', 'own', 40_000, 'hold_raises'], ['MISANO jacket', 'share', 14_545, null],
    ])
    // A person who may read ads but not their money: the same answer minus every money key, and no amount left.
    const principal = (perms: string[]) => ({ kind: 'user' as const, userId: 'u', label: 'u', via: 'claude' as const, workspace: scope(W), permissions: { isOwner: false, permissions: new Set<string>(perms) } })
    const everything = [...Object.values(FEATURES), ...Object.values(FIELDS)]
    const noMoney = everything.filter((p) => !p.startsWith('financials.'))
    for (const answer of [out.data, market.data]) {
      const full = visibleTo(principal(everything) as never, ADS_BRAIN_TOOLS[0], answer)
      const partial = visibleTo(principal(noMoney) as never, ADS_BRAIN_TOOLS[0], answer)
      expect(JSON.stringify(full)).toBe(JSON.stringify(answer))
      const text = JSON.stringify(partial)
      expect(text).not.toContain('"money":')
      for (const amount of ['40000', '46000', '52000', '39804', '9456', '14545', '€']) expect(text).not.toContain(amount)
      expect(text).toBe(JSON.stringify(answer, (k, v) => (k === 'money' ? undefined : v)))
    }
  })

  it('the budgets lever OFF: not planned; prune: rows older than 30 days go; another business plans and sees nothing', async () => {
    await inW(() => database.client.adsBrainBudgetDecision.create({ data: { runId: 'old', mode: 'SHADOW', kind: 'snapshot', productId: GALE, marketplace: 'IT', day: new Date('2026-09-01T00:00:00Z'), month: '2026-09', level: 'OBSERVE', envelopeSource: 'own', spentCents: 0, projectedCents: 0, brake: 'none', planHash: 'old', plan: {}, why: 'old', createdAt: new Date(NOW.getTime() - 31 * DAY) } }))
    expect((await inW(() => runMoneyShadowOnce({ now: new Date(NOW.getTime() + DAY + 7_200_000) })))).toMatchObject({ ran: true, pruned: 1 })
    expect(await inW(() => setLever({ productId: GALE, market: 'IT', by: 'user:owner', lever: 'budgets', level: 'OFF' }))).toMatchObject({ ok: true })
    expect(await inW(() => moneyShadowProducts())).toEqual([])
    expect(await inW(() => runMoneyShadowOnce({ now: new Date(NOW.getTime() + 2 * DAY) }))).toMatchObject({ ran: false })
    expect(await inW2(() => runMoneyShadowOnce({ now: NOW }))).toMatchObject({ ran: false })
    expect(await inW2(() => database.client.adsBrainBudgetDecision.findMany())).toEqual([])
    expect((await money({ market: 'IT', now: NOW }, inW2)).data!.products).toEqual([])
  })
})

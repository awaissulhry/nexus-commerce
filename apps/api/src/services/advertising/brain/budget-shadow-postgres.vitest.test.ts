/**
 * ONE BRAIN AB-7 — the money shadow on a real PostgreSQL (the throwaway PostgreSQL 17 of scripts/run-real-postgres-tests.mjs,
 * row-level policies on, the app as the restricted runtime login, business profiles ON), over one product's shape on
 * 2026-10-08 at 14:00 Rome: four own campaigns in "Portfolio X" (no cap) spending €10 a day in all, a paused own campaign,
 * a campaign shared with Product B and Product B's own; Product A's own monthly budget (ads strategy product row) and the
 * Budget Manager's IT plan; the stream's spend so far today; the bid brain's goal bids on one campaign; Amazon's budget
 * usage on another; a person's budget change earlier today on a third (the day's opening the gate reads).
 *
 *   table    AdsBrainBudgetDecision: invisible to another business through Prisma and raw SQL, refused without a business,
 *            row-level security forced with the business policy and the reference guard
 *   no-op    no product enrolled: nothing planned, nothing written
 *   dry run  the ads-brain money view plans Product A before it is enrolled (NOT_ENROLLED), stores nothing; the step of the
 *            campaign a person changed today is bounded around the day's logged opening
 *   shadow   enrolled (budgets OBSERVE by default): one row; a rerun writes nothing (one base move a day); the next budget
 *            day a change (that campaign's opening is its budget again), the day after a snapshot; the Owner's
 *            portfolioCapPct a change; nothing at Amazon, no budget or cap changed
 *   read     the plan now beside the newest logged one; the market's split; every amount hidden from a person without
 *            the ad-spend permission, and the rest unchanged
 *   prune    rows older than 30 days are deleted, also when no product is watched; budgets OFF → not planned; another
 *            business plans and sees nothing
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
const A = id('prod-a'), A_S = id('prod-a-s'), A_M = id('prod-a-m'), B = id('prod-b'), B_L = id('prod-b-l')
const NOW = new Date('2026-10-08T12:00:00Z')
const DAY = 86_400_000
const HOUR = 3_600_000
const TABLE = 'AdsBrainBudgetDecision'
/** Product A's four own campaigns: their spend a day (€10 in all) and today's budget, in cents. */
const OWN: Array<[string, number, string]> = [['a1', 400, '15.00'], ['a2', 300, '15.00'], ['a3', 200, '10.00'], ['a4', 100, '10.00']]

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
  await product(A, `AB7-A-${hex}`, { isParent: true, name: 'Product A' })
  await product(A_S, `AB7-A-S-${hex}`, { parentId: A, amazonAsin: `B0AB7AAS${H}` })
  await product(A_M, `AB7-A-M-${hex}`, { parentId: A, amazonAsin: `B0AB7AAM${H}` })
  await product(B, `AB7-B-${hex}`, { isParent: true, name: 'Product B' })
  await product(B_L, `AB7-B-L-${hex}`, { parentId: B, amazonAsin: `B0AB7BBL${H}` })
  const campaign = async (key: string, name: string, budget: string, ads: Array<[string, string]>, extra: Record<string, unknown> = {}) => {
    await db.campaign.create({ data: { id: C(key), name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${C(key)}`, dailyBudget: budget, startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, portfolioId: `pf-x-${hex}`, ...extra } })
    await db.adGroup.create({ data: { id: `g-${C(key)}`, campaignId: C(key), name: `group ${key}`, externalAdGroupId: `EXT-g-${C(key)}` } })
    await db.adTarget.create({ data: { id: `t-${C(key)}`, adGroupId: `g-${C(key)}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `keyword ${key}`, bidCents: 40, externalTargetId: `EXT-t-${C(key)}` } })
    for (const [productId, asin] of ads) await db.adProductAd.create({ data: { adGroupId: `g-${C(key)}`, productId, asin } })
  }
  const a: [string, string] = [A_S, `B0AB7AAS${H}`]
  const b: [string, string] = [B_L, `B0AB7BBL${H}`]
  for (const [key, , budget] of OWN) await campaign(key, `Campaign ${key.toUpperCase()}`, budget, [a])
  await campaign('paused', 'Campaign A paused', '10.00', [a], { status: 'PAUSED' })
  await campaign('shared', 'Campaign AB shared', '10.00', [a, b], { portfolioId: `pf-y-${hex}` })
  await campaign('b1', 'Campaign B1', '10.00', [b], { portfolioId: `pf-y-${hex}` })
  for (const [pid, name] of [[`pf-x-${hex}`, 'Portfolio X'], [`pf-y-${hex}`, 'Portfolio Y']]) {
    await db.amazonAdsPortfolio.create({ data: { profileId: 'p-it', externalPortfolioId: pid, name, state: 'ENABLED', budgetPolicy: 'NO_CAP' } })
  }
  // The daily report, 1 September → 7 October: Product A €10 a day (sales on A1 at ACoS 25 %), Product B €4, the shared €1.50.
  const daily: Array<Record<string, unknown>> = []
  const spendOf: Array<[string, number, number]> = [...OWN.map(([key, cents]): [string, number, number] => [key, cents, key === 'a1' ? 1_600 : 0]), ['b1', 400, 1_600], ['shared', 150, 0]]
  for (let t = Date.parse('2026-09-01T00:00:00Z'); t <= Date.parse('2026-10-07T00:00:00Z'); t += DAY) {
    for (const [key, cents, sales] of spendOf) {
      daily.push({ profileId: 'p-it', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(t), entityType: 'CAMPAIGN', entityId: `EXT-${C(key)}`, localEntityId: C(key), costMicros: BigInt(cents) * 10_000n, sales7dCents: sales, orders7d: sales ? (Math.round(t / DAY) % 4 === 0 ? 1 : 0) : 0, currencyCode: 'EUR', reportRunId: 'run-test', reportedAt: new Date(t + DAY) })
    }
  }
  await db.amazonAdsDailyPerformance.createMany({ data: daily as never })
  // The Marketing Stream today: €5 on A1 by 12:00 UTC.
  for (let h = 0; h <= 9; h++) await db.amazonAdsHourlyPerformance.create({ data: { profileId: 'p-it', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date('2026-10-08T00:00:00Z'), hour: h, entityType: 'CAMPAIGN', entityId: `EXT-${C('a1')}`, localEntityId: C('a1'), costMicros: 500_000n, currencyCode: 'EUR', reportedAt: NOW } })
  // The bid brain's newest decision on A1: its goal bid 36¢ against today's 40¢ (−10 %).
  await db.bidBrainDecision.create({ data: { runId: 'bb-test', mode: 'SHADOW', kind: 'change', marketplace: 'IT', campaignId: C('a1'), adGroupId: `g-${C('a1')}`, targetId: `t-${C('a1')}`, action: 'write', layer: 'goal', currentCents: 40, decidedCents: 36, dataDay: new Date('2026-09-30T00:00:00Z'), why: 'goal', createdAt: new Date(NOW.getTime() - HOUR) } })
  // Amazon's budget usage on A2 today: 82 %.
  await db.adBudgetUsageSample.create({ data: { campaignId: C('a2'), externalCampaignId: `EXT-${C('a2')}`, profileId: 'p-it', marketplace: 'IT', percent: 82, budgetCents: 1_500, usageUpdatedAt: new Date(NOW.getTime() - 600_000), firstSeenAt: new Date(NOW.getTime() - 600_000), lastSeenAt: NOW } })
  // A person set A3 from €12 to €10 at 09:00 UTC today: the day opened at €12 (EUROS in the payloads, as the log keeps them).
  await db.advertisingActionLog.create({ data: { userId: 'user:owner', actionType: 'AD_BUDGET_UPDATE', entityType: 'CAMPAIGN', entityId: C('a3'), payloadBefore: { dailyBudget: 12 }, payloadAfter: { dailyBudget: 10 }, amazonResponseStatus: 'SUCCESS', createdAt: new Date('2026-10-08T09:00:00Z') } })
  // The Owner's money: Product A's own monthly budget (ACoS 25 %), the Budget Manager's IT plan.
  await db.adsStrategy.create({ data: { channel: 'AMAZON', market: 'IT', level: 'PRODUCT', scopeId: A, label: 'Product A (IT)', version: 2, monthlySpendCapCents: 32_000, targetKind: 'ACOS', targetPct: 25, updatedBy: 'user:owner' } })
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

  it('dry run: the money view plans Product A before it is enrolled, and stores nothing; a step bounded around the day\'s logged opening', async () => {
    const before = await amazonRows()
    const out = await money({ productId: A_S, market: 'it', now: NOW })
    expect(out.ok).toBe(true)
    const d = out.data!
    expect(d).toMatchObject({ view: 'money', scope: { productId: A, market: 'IT' }, dryRun: true, logged: null })
    const p = d.plan
    expect(p).toMatchObject({ productId: A, name: 'Product A', month: '2026-10', day: '2026-10-08', enrolled: false, levers: { budgets: { effective: 'NOT_ENROLLED' } } })
    expect(p.envelope).toEqual({ source: 'own', money: { envelopeCents: 32_000, why: 'its own monthly budget (ads strategy: Product A (IT) v2)' } })
    expect(p.pace.money).toMatchObject({ spentCents: 7_500, projectedCents: 31_000, pacePct: 96.88, aimCents: 28_800, allowanceCents: 906, runRateCents: 1_000 })
    expect(p.pace).toMatchObject({ aimPct: 90, projection: 'stream and run rate', dayCurve: 'even', hourCurve: 'even', dataThrough: '2026-10-07' })
    expect(p.brake).toMatchObject({ level: 'hold_raises', abovePct: 95, does: 'no raises: bids, budgets and hours hold' })
    expect(p.portfolioCap).toMatchObject({ on: true, source: 'envelope', pct: 115, money: { totalCents: 36_800 } })
    expect(p.portfolioCap.portfolios).toEqual([expect.objectContaining({ portfolioId: `pf-x-${hex}`, name: 'Portfolio X', campaigns: 5, action: 'set', money: expect.objectContaining({ capCents: 36_800, todayPolicy: 'NO_CAP', sharePct: 100 }) })])
    // Each own campaign steps down 30 % from its day's opening; the paused one holds; the shared one may only go down.
    expect(Object.fromEntries(p.campaigns.map((c: Data) => [c.name, [c.owner, c.action, c.money.stepCents]]))).toEqual({
      'Campaign A1': ['product', 'lower', 1_050], 'Campaign A2': ['product', 'lower', 1_050], 'Campaign A3': ['product', 'lower', 840], 'Campaign A4': ['product', 'lower', 700],
      'Campaign A paused': ['product', 'hold', 1_000], 'Campaign AB shared': ['shared', 'lower', 700],
    })
    const byName = (name: string) => p.campaigns.find((c: Data) => c.name === name).money
    // A3: a person set €12 → €10 today; the day opened at €12, so the bound is measured from there.
    expect(byName('Campaign A3').dayMove).toEqual({ floorCents: 840, ceilCents: 2_200, bounded: true })
    // A1: the bid brain's goal bids −10 %, scaled into the pace, ÷ 70 %.
    expect(byName('Campaign A1')).toMatchObject({ expectedSpendCents: 360, targetCents: 486, band: 'in', bandFrom: 'campaign' })
    expect(byName('Campaign A2')).toMatchObject({ usagePct: 82, ladder: null, ladderWhy: 'no ladder: the pace brake holds raises (hold_raises)' })
    expect(p.counts).toEqual({ raise: 0, lower: 5, keep: 0, hold: 1, skip: 0, ladder: 0, exceptions: 0 })
    expect(p.why).toBe('Product A (IT) 2026-10 day 8: envelope from its own monthly budget · brake hold_raises: no raises: bids, budgets and hours hold · portfolio cap envelope · 6 campaigns: 5 lower, 0 raise, 0 keep, 1 hold')
    expect(await decisions()).toEqual([])
    expect(await amazonRows()).toBe(before)
  })

  it('shadow: enrolled, planned and logged once; one base move a day; the next day a change, the day after a snapshot; the Owner\'s change a change; nothing at Amazon', async () => {
    const before = await amazonRows()
    expect(await inW(() => enrollProduct({ productId: A, market: 'IT', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true })
    // AB-8 follow-up — at OBSERVE (budgets and portfolioCap) a full slot reads no Amazon usage of the caps.
    expect(await inW(() => moneyShadowProducts())).toEqual([{ productId: A, market: 'IT', level: 'OBSERVE', readsUsage: false }])
    const first = await inW(() => runMoneyShadowOnce({ now: NOW }))
    expect(first).toMatchObject({ ran: true, failed: [], products: [{ productId: A, market: 'IT', stored: 'change', brake: 'hold_raises', pacePct: 96.88 }] })
    let logged = await decisions()
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ mode: 'SHADOW', kind: 'change', productId: A, marketplace: 'IT', month: '2026-10', dayText: '2026-10-08', level: 'OBSERVE', envelopeCents: 32_000, envelopeSource: 'own', spentCents: 7_500, projectedCents: 31_000, pacePct: '96.88', brake: 'hold_raises', portfolioCapCents: 36_800 })
    expect(logged[0].plan.campaigns).toHaveLength(6)
    expect(logged[0].why).toBe('Product A (IT) 2026-10 day 8: envelope €320.00 (own) · projected €310.00 = 96.88 % → brake hold_raises · portfolio cap €368.00 (envelope) · 6 campaigns: 5 lower, 0 raise, 0 keep, 1 hold')
    // A rerun on the same facts writes nothing; an hour later the readings drift but the day's base moves stand.
    expect((await inW(() => runMoneyShadowOnce({ now: NOW }))).products[0].stored).toBeNull()
    expect((await inW(() => runMoneyShadowOnce({ now: new Date(NOW.getTime() + HOUR) }))).products[0].stored).toBeNull()
    // The next budget day: A3 opens at its budget again (the person's change was yesterday) — a change.
    const day2 = new Date('2026-10-09T01:00:00Z')
    expect((await inW(() => runMoneyShadowOnce({ now: day2 }))).products[0]).toMatchObject({ stored: 'change', brake: 'hold_raises' })
    expect((await decisions())[1].plan.campaigns.find((c: Data) => c.name === 'Campaign A3').stepCents).toBe(700)
    // The day after, nothing changed: the day's first plan is kept as a snapshot.
    const day3 = new Date('2026-10-10T01:00:00Z')
    expect((await inW(() => runMoneyShadowOnce({ now: day3 }))).products[0]).toMatchObject({ stored: 'snapshot' })
    // The Owner's portfolio cap at 130 %: a changed decision.
    expect(await inW(() => setOverride({ productId: A, market: 'IT', by: 'user:owner', reason: 'more headroom', override: { scope: 'PRODUCT', kind: 'VALUE', key: 'portfolioCapPct', value: 130 } }))).toMatchObject({ ok: true })
    expect((await inW(() => runMoneyShadowOnce({ now: new Date(day3.getTime() + HOUR) }))).products[0]).toMatchObject({ stored: 'change' })
    logged = await decisions()
    expect(logged.map((r) => [r.kind, r.dayText, r.portfolioCapCents])).toEqual([['change', '2026-10-08', 36_800], ['change', '2026-10-09', 36_800], ['snapshot', '2026-10-10', 36_800], ['change', '2026-10-10', 41_600]])
    // Nothing reached Amazon: no mutation, no queue, no action log; every budget as it was; the portfolio still has no cap.
    expect(await amazonRows()).toBe(before)
    expect((await budgets()).sort()).toEqual(['10.00', '15.00'])
    expect(await rows('SELECT DISTINCT "budgetPolicy" FROM "AmazonAdsPortfolio" WHERE "workspaceId" = $1', [W])).toEqual([{ budgetPolicy: 'NO_CAP' }])
  })

  it('read: the plan now beside the newest logged one; the market\'s split; every amount hidden from a person without the ad-spend permission', async () => {
    const out = await money({ productId: A, market: 'IT', now: new Date('2026-10-10T03:00:00Z') })
    expect(out.data!.logged).toMatchObject({ kind: 'change', mode: 'SHADOW', rowsKept: 4, keptDays: 30, plan: { portfolioCap: { pct: 130, money: { totalCents: 41_600 } } } })
    expect(out.data!.plan.levers.budgets.effective).toBe('OBSERVE')
    const market = await money({ market: 'IT', now: NOW })
    expect(market.data!.market.money).toMatchObject({ budgetCents: 60_000, fixedCents: 32_000, sharedCents: 20_364, reserveCents: 7_636, totalCents: 52_364 })
    expect(market.data!.products.map((p: Data) => [p.name, p.envelopeSource, p.money.envelopeCents, p.logged?.brake ?? null])).toEqual([
      ['Product A', 'own', 32_000, 'hold_raises'], ['Product B', 'share', 20_364, null],
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
      for (const amount of ['32000', '36800', '41600', '31000', '20364', '€']) expect(text).not.toContain(amount)
      expect(text).toBe(JSON.stringify(answer, (k, v) => (k === 'money' ? undefined : v)))
    }
  })

  it('prune: rows older than 30 days go, also when no product is watched; budgets OFF → not planned; another business plans and sees nothing', async () => {
    const old = () => inW(() => database.client.adsBrainBudgetDecision.create({ data: { runId: 'old', mode: 'SHADOW', kind: 'snapshot', productId: A, marketplace: 'IT', day: new Date('2026-09-01T00:00:00Z'), month: '2026-09', level: 'OBSERVE', envelopeSource: 'own', spentCents: 0, projectedCents: 0, brake: 'none', planHash: 'old', plan: {}, why: 'old', createdAt: new Date(NOW.getTime() - 31 * DAY) } }))
    await old()
    expect(await inW(() => runMoneyShadowOnce({ now: new Date('2026-10-10T04:00:00Z') }))).toMatchObject({ ran: true, pruned: 1 })
    expect(await inW(() => setLever({ productId: A, market: 'IT', by: 'user:owner', lever: 'budgets', level: 'OFF' }))).toMatchObject({ ok: true })
    expect(await inW(() => moneyShadowProducts())).toEqual([])
    await old()
    expect(await inW(() => runMoneyShadowOnce({ now: new Date('2026-10-10T12:00:00Z') }))).toMatchObject({ ran: false, pruned: 1 })
    expect(await decisions()).toHaveLength(4)
    expect(await inW2(() => runMoneyShadowOnce({ now: NOW }))).toMatchObject({ ran: false, pruned: 0 })
    expect(await inW2(() => database.client.adsBrainBudgetDecision.findMany())).toEqual([])
    expect((await money({ market: 'IT', now: NOW }, inW2)).data!.products).toEqual([])
  })
})

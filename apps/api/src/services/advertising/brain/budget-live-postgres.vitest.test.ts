/**
 * ONE BRAIN AB-8 — the money writer on a real PostgreSQL (the throwaway PostgreSQL 17 of scripts/run-real-postgres-tests.mjs,
 * row-level policies on, the app as the restricted runtime login, business profiles ON), the server switch `live`, the
 * ads mode LIVE and the job queue a stub: every budget write below is refused by the real write gate or only queued (no
 * worker runs), and Amazon's portfolio push and read are stubs — nothing leaves the process.
 *
 * One product's shape on 2026-10-08 at 14:00 Rome: Product A's own campaigns A1 (€15, spending €10.50 a day at ACoS 25 %,
 * 82 % of its budget used today), A2 (€20, €4 a day) and A3 (€10, €2 a day) in "Portfolio X" (no cap); a campaign shared
 * with Product B; Product B's own; and Product Z's two campaigns the bid brain runs LIVE (BidBrainEnrollment) while Product
 * Z is not enrolled in the brain. Product A's own monthly budget €900 (ads strategy).
 *
 *   today     production as AB-8 ships: nothing enrolled — nothing planned, asked or written; the money writer's actor is
 *             refused by the gate on the bid brain's LIVE campaigns, whose budgets stay as they are
 *   observe   enrolled, every lever at OBSERVE: the plan logged in shadow, nothing written
 *   propose   one request a day for the campaigns' moves and one for the cap, in the approvals queue; nothing written; a
 *             rerun asks nothing
 *   auto      through the real gate: A2 and A3's base moves and A1's rung above the day-move ceiling (the intraday
 *             give-back) queued as the brain with their evidence; the cap written monthly as the brain; the shared
 *             campaign, Product B's and Product Z's untouched; a rerun writes and logs nothing; a rule's same rung refused
 *   give-back the next budget day A1's ladder goes back to its base through the real gate (the day opens at the base);
 *             Amazon's usage of the cap is read and kept in the plan
 *   owner     a lock on A2's budget: not written, and the gate refuses the brain there; the Owner's cap amount: the cap
 *             never above it; an amount below the month's spend: not written; the per-write value cap refuses a cap above it
 *   business  another business plans and writes nothing
 *
 * Every value is made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
// Amazon: the portfolio push and the budget-usage read are stubs (nothing leaves the process); the rest is the real client.
const amazon = vi.hoisted(() => ({ pushes: [] as Array<Record<string, unknown>>, reads: [] as string[], usagePct: 12.5 }))
vi.mock('../ads-api-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ads-api-client.js')>()),
  updatePortfolio: vi.fn(async (_ctx: unknown, input: Record<string, unknown>) => { amazon.pushes.push(input); return { ok: true, mode: 'live' } }),
  liveCall: vi.fn(async (opts: { path: string; body: { portfolioIds?: string[] } }) => {
    amazon.reads.push(opts.path)
    if (opts.path !== '/portfolios/budget/usage') throw new Error(`no Amazon call expected here: ${opts.path}`)
    return { success: (opts.body.portfolioIds ?? []).map((portfolioId) => ({ portfolioId, budget: 1_035, budgetUsagePercent: amazon.usagePct, usageUpdatedTimestamp: '2026-10-09T00:10:00Z' })) }
  }),
}))

const { runMoneyShadowOnce, moneyLiveProducts } = await import('./budget-shadow.js')
const { enrollProduct, setLever, setOverride } = await import('./enrollment.js')
const { forgetLeverOwners } = await import('./lever-owners.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')
const { updateCampaignWithSync } = await import('../ads-mutation.service.js')
const { checkAdsWriteGate } = await import('../ads-write-gate.js')
const { MONEY_BUDGETS_ACTOR, MONEY_PORTFOLIO_ACTOR } = await import('./budget-ladder.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `ab8_money_${hex}`
const W2 = `ab8_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const id = (s: string) => `${hex}-${s}`
const C = (s: string) => id(`c-${s}`)
const A = id('prod-a'), A_S = id('prod-a-s'), B = id('prod-b'), B_L = id('prod-b-l'), Z = id('prod-z'), Z_L = id('prod-z-l')
const PF_X = `pf-x-${hex}`, PF_Y = `pf-y-${hex}`
const NOW = new Date('2026-10-08T12:00:00Z')
const DAY2 = new Date('2026-10-09T00:20:00Z')
const DAY3 = new Date('2026-10-10T07:00:00Z')
const DAY = 86_400_000

type Data = Record<string, any>
/** Every queued Amazon write and every ads audit row of the business. */
const traces = async () => (await rows<{ q: number; l: number }>(
  'SELECT (SELECT count(*)::int FROM "OutboundSyncQueue" WHERE "workspaceId" = $1) q, (SELECT count(*)::int FROM "AdvertisingActionLog" WHERE "workspaceId" = $1) l', [W]))[0]
const budgetsOf = async () => Object.fromEntries((await rows<{ id: string; b: string }>('SELECT id, "dailyBudget"::text AS b FROM "Campaign" WHERE "workspaceId" = $1', [W])).map((r) => [r.id.slice(hex.length + 3), r.b]))
const decisions = () => rows<Data>('SELECT *, to_char("day", \'YYYY-MM-DD\') AS "dayText" FROM "AdsBrainBudgetDecision" WHERE "workspaceId" = $1 ORDER BY "createdAt", id', [W])
const brainLog = () => rows<Data>(`SELECT "entityId", "userId", "payloadBefore", "payloadAfter", evidence, "amazonResponseStatus", "outboundQueueId" FROM "AdvertisingActionLog" WHERE "workspaceId" = $1 AND "userId" IN ($2, $3) ORDER BY "createdAt", id`, [W, MONEY_BUDGETS_ACTOR, MONEY_PORTFOLIO_ACTOR])
const approvals = () => rows<Data>('SELECT "toolName", status, args FROM "AgentApproval" WHERE "workspaceId" = $1 ORDER BY "requestedAt", id', [W])
const portfolio = async (pid: string) => (await rows<Data>('SELECT "budgetPolicy", "budgetAmount"::text AS amount FROM "AmazonAdsPortfolio" WHERE "workspaceId" = $1 AND "externalPortfolioId" = $2', [W, pid]))[0]
/**
 * One money run on the scenario's clock: the code's own clock (the gate reads `new Date()`) is set to `now`, and the rows
 * the run wrote are stamped at `now` (the database stamps its own time) — the days pass as they would, on any real date.
 */
async function run(now: Date) {
  vi.setSystemTime(now)
  const [{ t }] = await rows<{ t: string }>('SELECT to_char(clock_timestamp() AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.US\') AS t')
  const out = await inW(() => runMoneyShadowOnce({ now }))
  for (const table of ['AdvertisingActionLog', 'OutboundSyncQueue']) {
    await database.pool.query(`UPDATE "${table}" SET "createdAt" = ($1::timestamptz AT TIME ZONE 'UTC') WHERE "workspaceId" = $2 AND "createdAt" >= $3::timestamp`, [now.toISOString(), W, t])
  }
  return out
}

async function seed() {
  const db = database.client
  const product = (pid: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: pid, sku, name: sku, basePrice: '99.00', totalStock: 5, ...extra } })
  await product(A, `AB8-A-${hex}`, { isParent: true, name: 'Product A' })
  await product(A_S, `AB8-A-S-${hex}`, { parentId: A, amazonAsin: `B0AB8AAS${H}` })
  await product(B, `AB8-B-${hex}`, { isParent: true, name: 'Product B' })
  await product(B_L, `AB8-B-L-${hex}`, { parentId: B, amazonAsin: `B0AB8BBL${H}` })
  await product(Z, `AB8-Z-${hex}`, { isParent: true, name: 'Product Z' })
  await product(Z_L, `AB8-Z-L-${hex}`, { parentId: Z, amazonAsin: `B0AB8ZZL${H}` })
  const campaign = async (key: string, name: string, budget: string, ads: Array<[string, string]>, portfolioId: string | null) => {
    await db.campaign.create({ data: { id: C(key), name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${C(key)}`, dailyBudget: budget, startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, portfolioId } })
    await db.adGroup.create({ data: { id: `g-${C(key)}`, campaignId: C(key), name: `group ${key}`, externalAdGroupId: `EXT-g-${C(key)}` } })
    await db.adTarget.create({ data: { id: `t-${C(key)}`, adGroupId: `g-${C(key)}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `keyword ${key}`, bidCents: 40, externalTargetId: `EXT-t-${C(key)}` } })
    for (const [productId, asin] of ads) await db.adProductAd.create({ data: { adGroupId: `g-${C(key)}`, productId, asin } })
  }
  const a: [string, string] = [A_S, `B0AB8AAS${H}`]
  const b: [string, string] = [B_L, `B0AB8BBL${H}`]
  const z: [string, string] = [Z_L, `B0AB8ZZL${H}`]
  await campaign('a1', 'Campaign A1', '15.00', [a], PF_X)
  await campaign('a2', 'Campaign A2', '20.00', [a], PF_X)
  await campaign('a3', 'Campaign A3', '10.00', [a], PF_X)
  await campaign('shared', 'Campaign AB shared', '10.00', [a, b], PF_Y)
  await campaign('b1', 'Campaign B1', '10.00', [b], PF_Y)
  await campaign('z1', 'Campaign Z1', '12.00', [z], null)
  await campaign('z2', 'Campaign Z2', '12.00', [z], null)
  for (const [pid, name] of [[PF_X, 'Portfolio X'], [PF_Y, 'Portfolio Y']]) {
    await db.amazonAdsPortfolio.create({ data: { profileId: 'p-it', externalPortfolioId: pid, name, state: 'ENABLED', budgetPolicy: 'NO_CAP' } })
  }
  await db.amazonAdsConnection.create({ data: { profileId: 'p-it', marketplace: 'IT', region: 'EU', mode: 'production', writesEnabledAt: new Date('2026-01-01T00:00:00Z'), isActive: true } })
  // Product Z's campaigns: the bid brain runs them LIVE; Product Z is not enrolled in the brain (its money is no brain's).
  for (const key of ['z1', 'z2']) await db.bidBrainEnrollment.create({ data: { campaignId: C(key), marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:owner' } })
  // The daily report, 1 September → 7 October: A1 €10.50 a day at ACoS 25 % (an order every other day), A2 €4, A3 €2.
  const daily: Array<Record<string, unknown>> = []
  const spendOf: Array<[string, number, number]> = [['a1', 1_050, 4_200], ['a2', 400, 0], ['a3', 200, 0], ['shared', 150, 0], ['b1', 400, 1_600], ['z1', 200, 800], ['z2', 200, 800]]
  for (let t = Date.parse('2026-09-01T00:00:00Z'); t <= Date.parse('2026-10-07T00:00:00Z'); t += DAY) {
    for (const [key, cents, sales] of spendOf) {
      daily.push({ profileId: 'p-it', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(t), entityType: 'CAMPAIGN', entityId: `EXT-${C(key)}`, localEntityId: C(key), costMicros: BigInt(cents) * 10_000n, sales7dCents: sales, orders7d: sales ? (Math.round(t / DAY) % 2 === 0 ? 1 : 0) : 0, currencyCode: 'EUR', reportRunId: 'run-test', reportedAt: new Date(t + DAY) })
    }
  }
  await db.amazonAdsDailyPerformance.createMany({ data: daily as never })
  // Amazon's budget usage on A1 today: 82 %.
  await db.adBudgetUsageSample.create({ data: { campaignId: C('a1'), externalCampaignId: `EXT-${C('a1')}`, profileId: 'p-it', marketplace: 'IT', percent: 82, budgetCents: 1_500, usageUpdatedAt: new Date(NOW.getTime() - 600_000), firstSeenAt: new Date(NOW.getTime() - 600_000), lastSeenAt: NOW } })
  // Product A's own monthly budget (ACoS 25 %).
  await db.adsStrategy.create({ data: { channel: 'AMAZON', market: 'IT', level: 'PRODUCT', scopeId: A, label: 'Product A (IT)', version: 1, monthlySpendCapCents: 90_000, targetKind: 'ACOS', targetPct: 25, updatedBy: 'user:owner' } })
}

describe.skipIf(!concurrentDatabaseUrl())('AB-8 — the money writer through the real write gate (real PostgreSQL)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    // A monthly cap is a month's money: above the €500 default per-write value cap. The last test runs with the default.
    vi.stubEnv('NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS', '500000')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(async () => { await seed(); await setAutonomy('AUTO', 'test') })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  }, 240_000)
  afterAll(async () => { vi.useRealTimers(); await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('today: nothing enrolled — nothing planned, asked or written; the bid brain\'s LIVE campaigns keep their budgets and refuse the money writer', async () => {
    forgetLeverOwners()
    expect(await inW(() => moneyLiveProducts())).toEqual([])
    expect(await run(NOW)).toMatchObject({ ran: false, products: [] })
    expect([await decisions(), await approvals(), await traces()]).toEqual([[], [], { q: 0, l: 0 }])
    // The money writer's actor on Product Z's campaign (the bid brain's, LIVE): no brain owns its budget — refused, nothing left.
    const r = await inW(() => updateCampaignWithSync({ campaignId: C('z1'), patch: { dailyBudget: 9 }, actor: MONEY_BUDGETS_ACTOR as never, askGate: true }))
    expect(r).toMatchObject({ ok: false, outboundQueueId: null })
    expect(r.error).toMatch(/writes only a lever the brain owns: the daily budget of campaign "Campaign Z1" .* is not the brain's — no enrolled product's brain holds it/)
    expect(await traces()).toEqual({ q: 0, l: 0 })
    expect(await budgetsOf()).toMatchObject({ z1: '12.00', z2: '12.00' })
  })

  it('observe: enrolled with every lever at OBSERVE — the plan is logged in shadow, nothing is asked or written', async () => {
    expect(await inW(() => enrollProduct({ productId: A, market: 'IT', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true })
    const out = await run(NOW)
    expect(out.products).toEqual([expect.objectContaining({ productId: A, stored: 'change', mode: 'SHADOW', brake: 'none', actions: '' })])
    const logged = await decisions()
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ mode: 'SHADOW', level: 'OBSERVE' })
    expect(logged[0].plan.actions).toBeUndefined()
    expect(Object.fromEntries(logged[0].plan.campaigns.map((c: Data) => [c.name, [c.action, c.stepCents, c.ladder?.pct ?? null]]))).toEqual({
      'Campaign A1': ['keep', 1_500, 75], 'Campaign A2': ['lower', 1_400, null], 'Campaign A3': ['lower', 700, null], 'Campaign AB shared': ['lower', 700, null],
    })
    expect([await approvals(), await traces()]).toEqual([[], { q: 0, l: 0 }])
  })

  it('propose: one request for the day\'s campaign moves and one for the cap, waiting for a person; nothing written; a rerun asks nothing', async () => {
    for (const lever of ['budgets', 'portfolioCap'] as const) expect(await inW(() => setLever({ productId: A, market: 'IT', by: 'user:owner', lever, level: 'PROPOSE' }))).toMatchObject({ ok: true })
    const out = await run(new Date(NOW.getTime() + 60_000))
    expect(out.products[0]).toMatchObject({ mode: 'PROPOSE', actions: expect.stringContaining('asked=2') })
    const asked = await approvals()
    expect(asked.map((a) => [a.toolName, a.status])).toEqual([['set-campaign-budget', 'pending'], ['set-portfolio', 'pending']])
    expect(asked[0].args.campaigns).toEqual([{ campaignId: C('a2'), dailyBudgetCents: 1_400 }, { campaignId: C('a3'), dailyBudgetCents: 700 }])
    expect(asked[0].args.why).toMatch(/^ads brain — Product A \(IT\) 2026-10-08: the day's budget moves inside the pace \(no brake\); Campaign A2 €20.00 → €14.00, Campaign A3 €10.00 → €7.00/)
    expect(asked[1].args).toMatchObject({ op: 'update', portfolioId: PF_X, cap: { amountCents: 103_500, policy: 'monthly' } })
    expect(await traces()).toEqual({ q: 0, l: 0 })
    expect((await decisions()).at(-1)).toMatchObject({ mode: 'PROPOSE' })
    // The next run: asked already (whatever becomes of the requests) — none again.
    expect((await run(new Date(NOW.getTime() + 120_000))).products[0].actions).not.toContain('asked=')
    expect(await approvals()).toHaveLength(2)
  })

  it('auto: through the real gate — the base moves and the rung above the ceiling queued as the brain, the cap written monthly; others untouched; a rerun writes and logs nothing', async () => {
    for (const lever of ['budgets', 'portfolioCap'] as const) expect(await inW(() => setLever({ productId: A, market: 'IT', by: 'user:owner', lever, level: 'AUTO' }))).toMatchObject({ ok: true })
    forgetLeverOwners()
    expect(await inW(() => moneyLiveProducts())).toEqual([{ productId: A, market: 'IT', level: 'AUTO' }])
    const at = new Date(NOW.getTime() + 180_000)
    const out = await run(at)
    expect(out.failed).toEqual([])
    expect(out.products[0]).toMatchObject({ mode: 'LIVE', actions: 'queued=3 caps=1 held=1' })
    // A2 and A3 step down 30 %; A1 keeps its base and climbs +75 % (€26.25: past the €25.00 ceiling — the give-back exception).
    expect(await budgetsOf()).toMatchObject({ a1: '26.25', a2: '14.00', a3: '7.00', shared: '10.00', b1: '10.00', z1: '12.00', z2: '12.00' })
    const log = await brainLog()
    expect(log.map((r) => [r.entityId.slice(hex.length + 3) || r.entityId, r.payloadBefore.dailyBudget ?? r.payloadBefore.budgetAmount, r.payloadAfter.dailyBudget ?? r.payloadAfter.budgetAmount, r.evidence.brain.layer, r.amazonResponseStatus])).toEqual([
      ['a1', 15, 26.25, 'ladder', 'PENDING'], ['a2', 20, 14, 'base', 'PENDING'], ['a3', 10, 7, 'base', 'PENDING'], [expect.any(String), null, 1035, 'cap', 'SUCCESS'],
    ])
    expect(log[0]).toMatchObject({ userId: MONEY_BUDGETS_ACTOR, outboundQueueId: expect.any(String), evidence: { metric: 'dailyBudget', source: { kind: 'ads-brain' }, brain: { dataDay: '2026-10-07', goalBidCents: null } } })
    expect(log[3]).toMatchObject({ userId: MONEY_PORTFOLIO_ACTOR, evidence: { metric: 'portfolioBudgetCap', brain: { layer: 'cap' } } })
    expect(await rows('SELECT payload->>\'entityId\' AS "entityId", "syncType", "syncStatus" FROM "OutboundSyncQueue" WHERE "workspaceId" = $1 ORDER BY payload->>\'entityId\'', [W])).toEqual([C('a1'), C('a2'), C('a3')].sort().map((entityId) => ({ entityId, syncType: 'AD_BUDGET_UPDATE', syncStatus: 'PENDING' })))
    expect(await portfolio(PF_X)).toEqual({ budgetPolicy: 'MONTHLY_RECURRING', amount: '1035.00' })
    expect(amazon.pushes).toEqual([{ portfolioId: PF_X, budget: { amount: 1_035, currencyCode: 'EUR', policy: 'monthlyRecurring' } }])
    // The shared campaign is no brain's (D2): held with its reason.
    const actions = (await decisions()).at(-1)!.plan.actions
    expect(actions.campaigns.find((c: Data) => c.name === 'Campaign AB shared')).toMatchObject({ sent: 'held', why: expect.stringMatching(/^a shared campaign/) })
    // A rerun on the same facts: nothing queued, nothing logged — the moves landed, the rung was given.
    const before = { traces: await traces(), decisions: (await decisions()).length }
    expect((await run(new Date(at.getTime() + 60_000))).products[0]).toMatchObject({ stored: null, actions: 'held=1' })
    expect({ traces: await traces(), decisions: (await decisions()).length }).toEqual(before)
    // The same rung from a rule on Product B's campaign: the day-move limit is not loosened for anyone else.
    expect(await inW(() => checkAdsWriteGate({ marketplace: 'IT', campaignId: C('b1'), payloadValueCents: 2_625, field: 'dailyBudget', fields: ['dailyBudget'], intendedValueCents: 2_625, previousValueCents: 1_000, actor: 'automation:rule-x' }))).toMatchObject({ allowed: false, deniedAt: 'budget_day_move' })
  })

  it('give-back: the next budget day A1 goes back to its base through the real gate; Amazon\'s usage of the cap is read into the plan', async () => {
    const before = await traces()
    const out = await run(DAY2)
    expect(out.failed).toEqual([])
    // A1 back at its base; A2 and A3 take the new day's base move (another −30 % toward their targets).
    expect(await budgetsOf()).toMatchObject({ a1: '15.00', a2: '9.80', a3: '4.90' })
    const giveBack = (await brainLog()).filter((r) => r.entityId === C('a1')).at(-1)!
    expect(giveBack).toMatchObject({ payloadBefore: { dailyBudget: 26.25 }, payloadAfter: { dailyBudget: 15 }, evidence: { brain: { layer: 'base' } }, amazonResponseStatus: 'PENDING' })
    expect((await traces()).q).toBe(before.q + 3)
    expect(amazon.reads).toContain('/portfolios/budget/usage')
    const plan = (await decisions()).at(-1)!.plan
    expect(plan.portfolioCap.portfolios[0]).toMatchObject({ portfolioId: PF_X, action: 'keep', todaySetBy: 'brain', usagePct: 12.5 })
    expect(plan.campaigns.find((c: Data) => c.name === 'Campaign A1').why).toContain('it still stands on the brain\'s ladder of an earlier day (€26.25): given back to its base €15.00 first')
  })

  it('owner: his lock on A2 — not written, the gate refuses the brain there; his cap amount bounds the cap; one below the month\'s spend is not written; the value cap refuses a cap above it', async () => {
    expect(await inW(() => setOverride({ productId: A, market: 'IT', by: 'user:owner', reason: 'my own budget', override: { scope: 'CAMPAIGN', campaignId: C('a2'), kind: 'LOCK', key: 'budgets', value: { dailyBudgetCents: 2_200 } } }))).toMatchObject({ ok: true })
    expect(await inW(() => setOverride({ productId: A, market: 'IT', by: 'user:owner', reason: 'a tighter backstop', override: { scope: 'PRODUCT', kind: 'VALUE', key: 'portfolioCapCents', value: 60_000 } }))).toMatchObject({ ok: true })
    forgetLeverOwners()
    const out = await run(DAY3)
    expect(out.failed).toEqual([])
    expect(await budgetsOf()).toMatchObject({ a2: '9.80' })
    const plan = (await decisions()).at(-1)!.plan
    expect(plan.campaigns.find((c: Data) => c.name === 'Campaign A2')).toMatchObject({ action: 'hold', targetCents: 2_200 })
    // The cap: the Owner's own amount, never above it.
    expect(await portfolio(PF_X)).toEqual({ budgetPolicy: 'MONTHLY_RECURRING', amount: '600.00' })
    const refused = await inW(() => updateCampaignWithSync({ campaignId: C('a2'), patch: { dailyBudget: 12 }, actor: MONEY_BUDGETS_ACTOR as never, askGate: true }))
    expect(refused).toMatchObject({ ok: false })
    expect(refused.error).toMatch(/the Owner holds the daily budget of campaign "Campaign A2"/)
    // An amount below this month's spend in the portfolio would stop every campaign in it at once: not written.
    expect(await inW(() => setOverride({ productId: A, market: 'IT', by: 'user:owner', reason: 'test', override: { scope: 'PRODUCT', kind: 'VALUE', key: 'portfolioCapCents', value: 5_000 } }))).toMatchObject({ ok: true })
    await run(new Date(DAY3.getTime() + 3_600_000))
    expect(await portfolio(PF_X)).toEqual({ budgetPolicy: 'MONTHLY_RECURRING', amount: '600.00' })
    expect((await decisions()).at(-1)!.plan.actions.portfolios[0]).toMatchObject({ sent: 'held', why: expect.stringMatching(/is not above this month's spend in it plus one day/) })
    // The per-write value cap at its default (€500): a cap above it is refused by the gate, nothing changes.
    vi.stubEnv('NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS', '')
    expect(await inW(() => setOverride({ productId: A, market: 'IT', by: 'user:owner', reason: 'test', override: { scope: 'PRODUCT', kind: 'VALUE', key: 'portfolioCapCents', value: 70_000 } }))).toMatchObject({ ok: true })
    await run(new Date(DAY3.getTime() + 2 * 3_600_000))
    expect(await portfolio(PF_X)).toEqual({ budgetPolicy: 'MONTHLY_RECURRING', amount: '600.00' })
    expect((await decisions()).at(-1)!.plan.actions.portfolios[0]).toMatchObject({ sent: 'refused', reason: expect.stringMatching(/exceeds cap 50000¢/) })
    vi.stubEnv('NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS', '500000')
    // Product Z's campaigns (the bid brain's) never moved.
    expect(await budgetsOf()).toMatchObject({ z1: '12.00', z2: '12.00', b1: '10.00', shared: '10.00' })
  })

  it('business: another business with nothing enrolled plans and writes nothing', async () => {
    expect(await inW2(() => runMoneyShadowOnce({ now: NOW }))).toMatchObject({ ran: false })
    expect(await rows('SELECT count(*)::int AS n FROM "OutboundSyncQueue" WHERE "workspaceId" = $1', [W2])).toEqual([{ n: 0 }])
  })
})

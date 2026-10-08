/**
 * ONE BRAIN AB-20 — retiring a product's duplicate writers, giving them back, and the A/B proof, on a real PostgreSQL (the
 * throwaway PostgreSQL 17 of scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime
 * login, business profiles ON), through the REAL approval path: Claude asks (runOrQueueTool), a person approves
 * (decideApproval), the tool runs as the approver. The job queue is a stub; nothing here writes to Amazon.
 *
 *   today      nothing enrolled (production as AB-20 ships): nothing is ready, the tool refuses, every writer stays on, the
 *              tick reads nothing; the proof has no brain product in a market without one, and finds the product whose
 *              campaigns the bid brain runs LIVE
 *   ready      the jacket enrolled, every lever AUTO or the Owner's own level, the bid brain running its two campaigns LIVE:
 *              exactly the rows wholly its own and held are listed per writer type — an assigned budget rule, a rule of
 *              its portfolio, a budget schedule, a budget pool, a classic dayparting schedule, a coverage set, an autopilot
 *              plan — and the rest stay, each with why (the whole business, a bid directive, a notify, another product's
 *              campaign, a lever the Owner keeps OFF); the hourly plan's schedule is never a candidate
 *   proof      six weeks before and since the bid brain went live against the matched glove: ad profit, ACoS, TACoS and
 *              orders measured by difference-in-differences, with the margin from the cost price said
 *   retire     a request approved after a row changed does not run; approved again, exactly those rows are switched off with
 *              their records, nothing else; a rerun has nothing to retire; the view shows each with its give-back
 *   give back  a lever back from AUTO (set-ads-brain, approved) gives back at once the rows that write it, the rest stay;
 *              a row a person changed since is LEFT; leaving the brain gives back the rest; the tick gives back when the
 *              server switch leaves live; op give-back un-retires one row on a person's word; a kill switch gives back its
 *              lever's rows at once
 *   business   another business sees none of it
 *
 * Values are made up (public repo).
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

const { enrollProduct, setLever } = await import('./enrollment.js')
const { forgetLeverOwners } = await import('./lever-owners.js')
const { forgetKills } = await import('./kill-switch.js')
const { loadRetireFacts, runRetirement, runRetireTick } = await import('./retire-run.js')
const { readProof, proofLine } = await import('./proof-read.js')
const { decideApproval, runOrQueueTool } = await import('../../agents/approval-gate.service.js')
const { ADS_BRAIN_RETIRE_TOOLS } = await import('../../agents/tools/ads-brain-retire.tools.js')
const { ADS_BRAIN_TOOLS } = await import('../../agents/tools/ads-brain.tools.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `ab20_retire_${hex}`
const W2 = `ab20_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const id = (s: string) => `${hex}-${s}`
const P = id('p'), P1 = id('p1'), Q = id('q'), Q1 = id('q1')
const C = (s: string) => id(`c-${s}`)
const PF_J = id('pf-j'), PF_M = id('pf-m')
const tool = ADS_BRAIN_RETIRE_TOOLS[0]
const NOW = new Date('2026-10-08T12:00:00Z')

type Data = Record<string, any>
const person = (userId: string, via: 'claude' | 'app', workspaceId = W) => ({
  kind: 'user' as const, userId, label: `Person ${userId}`, via, workspace: scope(workspaceId),
  permissions: { isOwner: false, permissions: new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
})
async function ask(toolName: string, args: Record<string, unknown>): Promise<{ approvalId: string; preview: Data }> {
  return inW(async () => {
    const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: 'u-asker' } })
    const asked = await runOrQueueTool(toolName, args, person('u-asker', 'claude'), run.id)
    expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true, mode: 'queued' })
    const [row] = await rows<{ preview: Data }>('SELECT preview FROM "AgentApproval" WHERE id = $1', [asked.approvalId])
    return { approvalId: asked.approvalId!, preview: row.preview }
  })
}
const approve = (approvalId: string) => inW(() => decideApproval(approvalId, 'approve', person('u-approver', 'app') as never)) as Promise<{ ok: boolean; status?: string; error?: string; result?: Data }>
const executed = async (approvalId: string) => (await rows<{ status: string; reason: string | null }>('SELECT status, reason FROM "AgentApproval" WHERE id = $1', [approvalId]))[0]
const resultOf = async (approvalId: string) => (await rows<{ after: Data }>('SELECT after FROM "AgentChange" WHERE "approvalId" = $1', [approvalId]))[0]?.after ?? null

/** Each writer row's switch, by its test name. */
const writerIds: Record<string, { table: string; id: string }> = {}
async function enabledOf(): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {}
  for (const [name, w] of Object.entries(writerIds)) out[name] = (await rows<{ enabled: boolean }>(`SELECT enabled FROM "${w.table}" WHERE id = $1`, [w.id]))[0]?.enabled
  return out
}
const nameOf = (rowId: string) => Object.entries(writerIds).find(([, w]) => w.id === rowId)?.[0] ?? rowId
const records = async () => (await rows<{ targetId: string; status: string; approvalId: string | null; givenBackBy: string | null }>('SELECT "targetId", status, "approvalId", "givenBackBy" FROM "AdsBrainRetirement" WHERE "workspaceId" = $1 ORDER BY "createdAt", id', [W]))
  .map((r) => ({ ...r, name: nameOf(r.targetId) }))
const openRecords = async () => (await records()).filter((r) => r.status === 'RETIRED').map((r) => r.name).sort()
const amazonQueue = async () => (await rows<{ n: number }>('SELECT ((SELECT count(*) FROM "AdMutation" WHERE "workspaceId" = $1) + (SELECT count(*) FROM "OutboundSyncQueue" WHERE "workspaceId" = $1))::int AS n', [W]))[0].n

const RETIRABLE = ['autopilot budgets', 'coverage jacket', 'dayparting own1', 'pool own2', 'rule budget own1', 'rule negatives portfolio', 'schedule own']
const BUDGET_ROWS = ['autopilot budgets', 'pool own2', 'rule budget own1', 'schedule own']

async function seed(prefix = '') {
  const db = database.client
  const pid = (s: string) => `${prefix}${s}`
  const product = (productId: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: pid(productId), sku: `${prefix}${sku}`, name: sku, basePrice: '80.00', costPrice: '40.00', totalStock: 5, ...extra } })
  await product(P, `AB20-JACKET-${hex}`, { isParent: true, name: `Test jacket ${hex}` })
  await product(P1, `AB20-JACKET-M-${hex}`, { parentId: pid(P), amazonAsin: `B0AB20JM${H}` })
  await product(Q, `AB20-GLOVE-${hex}`, { isParent: true, name: `Test glove ${hex}` })
  await product(Q1, `AB20-GLOVE-L-${hex}`, { parentId: pid(Q), amazonAsin: `B0AB20GL${H}` })
  const jacket = { productId: pid(P1), asin: `B0AB20JM${H}` }
  const glove = { productId: pid(Q1), asin: `B0AB20GL${H}` }
  const campaign = async (key: string, ads: Array<{ productId: string; asin: string }>, portfolioId: string) => {
    await db.campaign.create({ data: { id: pid(C(key)), name: `${prefix}Test ${key}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${pid(C(key))}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, portfolioId: pid(portfolioId) } })
    await db.adGroup.create({ data: { id: `g-${pid(C(key))}`, campaignId: pid(C(key)), name: `group ${key}`, externalAdGroupId: `EXT-g-${pid(C(key))}` } })
    for (const ad of ads) await db.adProductAd.create({ data: { adGroupId: `g-${pid(C(key))}`, productId: ad.productId, asin: ad.asin } })
  }
  await campaign('own1', [jacket], PF_J)
  await campaign('own2', [jacket], PF_J)
  await campaign('glove', [glove], PF_M)
  await campaign('shared', [jacket, glove], PF_M)
  // The bid brain runs the jacket's two campaigns LIVE since 2026-08-01 (put LIVE one by one before the product was enrolled).
  for (const key of ['own1', 'own2']) {
    await db.bidBrainEnrollment.create({ data: { campaignId: pid(C(key)), marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:owner-test', snapshot: { takenAt: '2026-08-01T10:00:00.000Z', adGroups: [], targets: [], placements: [] } } })
  }
  const rule = async (name: string, actions: unknown[], extra: Record<string, unknown> = {}) =>
    db.automationRule.create({ data: { name: `${prefix}${name}`, domain: 'advertising', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', actions: actions as never, enabled: true, dryRun: false, autonomyLevel: 'AUTO', ...extra } })
  const out: Record<string, { table: string; id: string }> = {}
  // An engine budget rule is bound to its assignments (ads-rule-scope-resolver.ts): assigned to own1 alone.
  const r1 = await rule('rule budget own1', [{ type: 'adjust_ad_budget', percent: 10 }])
  await db.campaignRuleAssignment.create({ data: { campaignId: pid(C('own1')), ruleId: r1.id, kind: 'budget' } })
  out['rule budget own1'] = { table: 'AutomationRule', id: r1.id }
  out['rule whole business'] = { table: 'AutomationRule', id: (await rule('rule whole business', [{ type: 'set_daily_budget', amount: 20 }])).id }
  out['rule bid cap'] = { table: 'AutomationRule', id: (await rule('rule bid cap', [{ type: 'bid_down', percent: 10 }], { scopeCampaignId: pid(C('own1')) })).id }
  out['rule pause notify'] = { table: 'AutomationRule', id: (await rule('rule pause notify', [{ type: 'pause_target' }, { type: 'notify', target: 'operator', message: 'paused' }], { scopeCampaignId: pid(C('own2')) })).id }
  out['rule negatives portfolio'] = { table: 'AutomationRule', id: (await rule('rule negatives portfolio', [{ type: 'add_negative_exact' }], { scopePortfolioId: pid(PF_J), scopeMarketplace: 'IT' })).id }
  out['schedule own'] = { table: 'BudgetSchedule', id: (await db.budgetSchedule.create({ data: { name: `${prefix}schedule own`, campaigns: [{ id: pid(C('own1')) }, { id: pid(C('own2')) }], windows: [] } })).id }
  out['schedule mixed'] = { table: 'BudgetSchedule', id: (await db.budgetSchedule.create({ data: { name: `${prefix}schedule mixed`, campaigns: [{ id: pid(C('own1')) }, { id: pid(C('glove')) }], windows: [] } })).id }
  const pool = async (name: string, campaigns: string[]) => {
    const p = await db.budgetPool.create({ data: { name: `${prefix}${name}`, totalDailyBudgetCents: 4000, enabled: true } })
    for (const c of campaigns) await db.budgetPoolAllocation.create({ data: { budgetPoolId: p.id, marketplace: 'IT', campaignId: pid(C(c)) } })
    return p.id
  }
  out['pool own2'] = { table: 'BudgetPool', id: await pool('pool own2', ['own2']) }
  out['pool mixed'] = { table: 'BudgetPool', id: await pool('pool mixed', ['own1', 'glove']) }
  out['dayparting own1'] = { table: 'AdSchedule', id: (await db.adSchedule.create({ data: { campaignId: pid(C('own1')), name: `${prefix}dayparting own1`, windows: [{ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18, bidMultiplierPct: 20 }] } })).id }
  // An hourly bid plan's own schedule (goal mode) is the brain's input: never a candidate.
  out['hourly plan own2'] = { table: 'AdSchedule', id: (await db.adSchedule.create({ data: { campaignId: pid(C('own2')), name: `${prefix}hourly plan own2`, windows: [], defaultTargetKey: 'own-top' } })).id }
  out['coverage jacket'] = { table: 'KeywordCoverageSet', id: (await db.keywordCoverageSet.create({ data: { portfolioId: pid(PF_J), marketplace: 'IT', name: `${prefix}coverage jacket`, enabled: true } })).id }
  out['autopilot budgets'] = { table: 'AutopilotPlan', id: (await db.autopilotPlan.create({ data: { name: `${prefix}autopilot budgets`, marketplace: 'IT', campaignIds: [pid(C('own2'))], autonomy: 'SUGGEST', modules: { budget: { on: true } } } })).id }
  out['autopilot placements'] = { table: 'AutopilotPlan', id: (await db.autopilotPlan.create({ data: { name: `${prefix}autopilot placements`, marketplace: 'IT', campaignIds: [pid(C('own1'))], autonomy: 'SUGGEST', modules: { placement: { on: true } } } })).id }
  return out
}

/** Six weeks before and six since the bid brain went live (2026-08-01): the jacket and the glove, made-up round numbers. */
async function seedDays() {
  const db = database.client
  const start = Date.parse('2026-08-01T00:00:00Z')
  const ads: Array<Record<string, unknown>> = []
  const profit: Array<Record<string, unknown>> = []
  for (let d = -42; d < 42; d++) {
    const date = new Date(start + d * 86_400_000)
    const after = d >= 0
    const ad = (key: string, spendCents: number, salesCents: number, orders: number) => ads.push({
      profileId: 'prof-it', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date, entityType: 'CAMPAIGN', entityId: `EXT-${C(key)}`, localEntityId: C(key),
      impressions: 100, clicks: 10, costMicros: BigInt(spendCents * 10_000), currencyCode: 'EUR', sales7dCents: salesCents, orders7d: orders, reportRunId: 'test-run', reportedAt: date,
    })
    // Jacket: 20 € a day across its two campaigns; ad sales 80 € a day before, 100 € since; 2 orders a day before, 3 since.
    ad('own1', 1000, after ? 5000 : 4000, after ? 2 : 1)
    ad('own2', 1000, after ? 5000 : 4000, 1)
    // Glove: 20 € a day; ad sales 80 € before, 88 € since; 2 orders a day.
    ad('glove', 2000, after ? 8800 : 8000, 2)
    profit.push({ productId: P1, marketplace: 'IT', date, unitsSold: 2, grossRevenueCents: after ? 20_000 : 16_000 })
    profit.push({ productId: Q1, marketplace: 'IT', date, unitsSold: 2, grossRevenueCents: after ? 17_600 : 16_000 })
  }
  await db.amazonAdsDailyPerformance.createMany({ data: ads as never })
  await db.productProfitDaily.createMany({ data: profit as never })
}

describe.skipIf(!concurrentDatabaseUrl())('AB-20 — retiring a product\'s duplicate writers, the give-back and the proof (real PostgreSQL)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    Object.assign(writerIds, await inW(() => seed()))
    await inW(seedDays)
    await inW2(() => seed('w2-'))
  }, 240_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('today: nothing enrolled — nothing is ready, the tool refuses, every writer stays on, the tick reads nothing; the proof finds the bid brain\'s product only', async () => {
    const facts = await inW(() => loadRetireFacts(P1, 'IT'))
    if ('refusal' in facts) throw new Error(facts.refusal)
    expect(facts).toMatchObject({ productId: P, enrolled: false, readiness: { ready: false } })
    expect(facts.plan.retire).toEqual([])
    const refused = await inW(() => tool.handler!({ op: 'retire', productId: P1, market: 'IT' }, {} as never))
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/^Not queued: the writers of "Test jacket .*" \(.*\) in IT cannot retire yet — the product is not enrolled in the brain/) })
    expect(await inW(() => runRetireTick({ scan: true }))).toEqual({ checked: 0, gaveBack: [], asked: [], wouldAsk: [], failed: [] })
    expect(Object.values(await enabledOf()).every(Boolean)).toBe(true)
    expect(await inW(() => readProof({ market: 'DE', newestDay: '2026-09-11' }))).toMatchObject({ status: 'NO_BRAIN_PRODUCT', products: [] })
    // The bid brain runs the jacket's campaigns LIVE before it is enrolled: the jacket is a brain product for the proof already.
    expect((await inW(() => readProof({ market: 'IT', newestDay: '2026-09-11' })) as { products: Array<{ productId: string }> }).products.map((p) => p.productId)).toEqual([P])
  })

  it('ready: every lever AUTO or the Owner\'s own level — exactly the rows wholly its own and held are listed, per writer type; the rest stay, each with why', async () => {
    expect(await inW(() => enrollProduct({ productId: P1, market: 'IT', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true, productId: P, bids: 'AUTO' })
    const levels: Array<[string, string]> = [['adGroupBids', 'OFF'], ['hours', 'PROPOSE'], ['placements', 'OFF'], ['state', 'AUTO'], ['budgets', 'AUTO'], ['portfolioCap', 'AUTO'],
      ['negatives', 'AUTO'], ['harvest', 'AUTO'], ['structure', 'PROPOSE'], ['biddingStrategy', 'OFF'], ['offAmazon', 'OFF']]
    for (const [lever, level] of levels) {
      expect(await inW(() => setLever({ productId: P, market: 'IT', lever: lever as never, level: level as never, by: 'user:owner', now: NOW })), `${lever} ${level}`).toMatchObject({ ok: true })
    }
    forgetLeverOwners()
    const facts = await inW(() => loadRetireFacts(P, 'IT'))
    if ('refusal' in facts) throw new Error(facts.refusal)
    expect(facts.readiness).toMatchObject({ ready: true, blockers: [] })
    expect(facts.plan.retire.map((r) => nameOf(r.id)).sort()).toEqual(RETIRABLE)
    expect(Object.fromEntries(facts.plan.retire.map((r) => [nameOf(r.id), r.levers]))).toEqual({
      'autopilot budgets': ['budgets'], 'dayparting own1': ['bids', 'hours'], 'coverage jacket': ['bids'], 'pool own2': ['budgets'],
      'rule budget own1': ['budgets'], 'rule negatives portfolio': ['negatives'], 'schedule own': ['budgets'],
    })
    const stays = Object.fromEntries(facts.plan.keep.map((k) => [nameOf(k.id), k.why]))
    expect(Object.keys(stays).sort()).toEqual(['autopilot placements', 'pool mixed', 'rule bid cap', 'rule pause notify', 'rule whole business', 'schedule mixed'])
    expect(stays['rule whole business']).toMatch(/it reaches every campaign of the business/)
    expect(stays['rule bid cap']).toMatch(/its bid_down action is an input the bid brain reads on these campaigns \(BB-9/)
    expect(stays['rule pause notify']).toMatch(/it also does notify, which no lever of the brain does/)
    expect(stays['schedule mixed']).toMatch(new RegExp(`it also reaches 1 campaign that is not this product's own \\(${C('glove')}\\)`))
    expect(stays['pool mixed']).toMatch(/not this product's own/)
    expect(stays['autopilot placements']).toMatch(/it writes the placements lever of "Test own1" .* which the brain does not hold there \(OFF by the Owner's product override/)
    expect(facts.plan.keep.concat(facts.plan.retire).some((r) => r.id === writerIds['hourly plan own2'].id)).toBe(false)
    expect(facts.shared.map((s) => s.campaignId)).toEqual([C('shared')])
  })

  it('proof: six weeks before and since against the matched glove — ad profit, ACoS, TACoS and orders measured, the margin from the cost price said', async () => {
    const r = await inW(() => readProof({ market: 'IT', productId: P1, newestDay: '2026-09-11' }))
    if ('refusal' in r) throw new Error(r.refusal)
    const p = r.products[0]
    expect(p).toMatchObject({ productId: P, status: 'MEASURED', start: { day: '2026-08-01', how: expect.stringMatching(/the bid brain took campaign .* live/) }, comparison: { productId: Q } })
    expect(p.matchWhy).toMatch(/^the nearest of 1 product without the brain that fit \(same market, price within ×1.5, ad spend before within ×2, ads running since\); the brain product has no category: any category$/)
    expect(p.margin.source).toBe('cost-price')
    expect(p.window).toEqual({ since: ['2026-08-01', '2026-09-11'], before: ['2026-06-20', '2026-07-31'] })
    const m = p.result!.measures
    // A week: the jacket's ad profit 7·(100·0.5 − 20) € since against 7·(80·0.5 − 20) € before; the glove's 7·(88·0.5 − 20) against 7·(80·0.5 − 20).
    expect(m.adProfit.estimate).toBe(4200)
    expect(m.orders.estimate).toBe(7)
    expect(m.acos.estimate).toBeCloseTo((0.2 - 0.25) - (2000 / 8800 - 0.25), 10)
    expect(m.tacos.estimate).toBeCloseTo((0.1 - 0.125) - (2000 / 17_600 - 0.125), 10)
    expect(p.result!.orders).toEqual({ brainSince: 126, brainBefore: 84, comparisonSince: 84, comparisonBefore: 84 })
    expect(proofLine(p)).toBe(`Proof (A/B, ad profit, difference-in-differences, 6 weeks against Test glove ${hex}): ad profit better with the brain; ACoS better with the brain; TACoS better with the brain; ad orders better with the brain (95 % intervals).`)
    const view = await inW(() => ADS_BRAIN_TOOLS[0].handler!({ view: 'proof', market: 'IT', productId: P1, since: '2026-08-01' }, {} as never)) as { ok: boolean; data: Data }
    expect(view.ok).toBe(true)
    expect(view.data.products[0]).toMatchObject({ status: 'MEASURED', start: { day: '2026-08-01', how: 'the day you named' }, result: { design: 'did', verdicts: { adProfit: 'better', acos: 'better', tacos: 'better', orders: 'better' } } })
  })

  it('retire: approved after a row changed it does not run; approved again exactly those rows are switched off with their records; a rerun has nothing to retire', async () => {
    const stale = await ask('retire-ads-writers', { op: 'retire', productId: P1, market: 'IT', why: 'test retire' })
    expect(stale.preview.switchesOff.map((r: Data) => nameOf(r.id)).sort()).toEqual(RETIRABLE)
    await rows('UPDATE "AutomationRule" SET name = $2 WHERE id = $1', [writerIds['rule negatives portfolio'].id, 'rule negatives portfolio (edited)'])
    const out = await approve(stale.approvalId)
    expect(out.status).not.toBe('executed')
    expect(Object.values(await enabledOf()).every(Boolean)).toBe(true)
    expect(await records()).toEqual([])

    const asked = await ask('retire-ads-writers', { op: 'retire', productId: P1, market: 'IT', why: 'test retire' })
    expect(asked.preview).toMatchObject({ action: 'retire-ads-writers', op: 'retire', product: { productId: P, market: 'IT' }, summary: expect.stringMatching(/^Retire 7 duplicate writers of "Test jacket/) })
    expect(asked.preview.staysOn).toHaveLength(6)
    expect(asked.preview.noRowOfTheirOwn).toHaveLength(4)
    expect(await approve(asked.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    const on = await enabledOf()
    expect(Object.entries(on).filter(([, v]) => !v).map(([k]) => k).sort()).toEqual(RETIRABLE)
    expect(on['rule whole business'] && on['schedule mixed'] && on['pool mixed'] && on['hourly plan own2'] && on['autopilot placements']).toBe(true)
    const recs = await records()
    expect(recs).toHaveLength(7)
    expect(recs.every((r) => r.status === 'RETIRED' && r.approvalId === asked.approvalId)).toBe(true)
    expect(await resultOf(asked.approvalId)).toMatchObject({ op: 'retire', productId: P, market: 'IT', retirementIds: expect.arrayContaining([expect.any(String)]) })
    expect(await amazonQueue()).toBe(0)
    expect(await inW(() => tool.handler!({ op: 'retire', productId: P1, market: 'IT' }, {} as never))).toMatchObject({ ok: false, error: expect.stringMatching(/^Not queued: nothing to retire for/) })
    const view = await inW(() => ADS_BRAIN_TOOLS[0].handler!({ view: 'retire', market: 'IT', productId: P1 }, {} as never)) as { ok: boolean; data: Data }
    expect(view.data).toMatchObject({ ready: true, switchesOff: [] })
    expect(view.data.retiredNow.map((r: Data) => [nameOf(r.id), r.giveBackWould.act]).sort()).toEqual(RETIRABLE.map((n) => [n, 'switchOn']))
  })

  it('give back: a lever back from AUTO (set-ads-brain, approved) gives back at once the rows that write it; the rest stay retired', async () => {
    const asked = await ask('set-ads-brain', { op: 'set-level', productId: P, market: 'IT', lever: 'budgets', level: 'OBSERVE', why: 'test budgets back to shadow' })
    expect(await approve(asked.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    const on = await enabledOf()
    for (const n of BUDGET_ROWS) expect(on[n], n).toBe(true)
    expect(await openRecords()).toEqual(['coverage jacket', 'dayparting own1', 'rule negatives portfolio'])
    const back = (await records()).filter((r) => r.status === 'GIVEN_BACK')
    expect(back.map((r) => r.name).sort()).toEqual(BUDGET_ROWS)
    expect(back.every((r) => r.givenBackBy?.startsWith('claude:') || r.givenBackBy?.startsWith('user:'))).toBe(true)
  })

  it('a person\'s edit wins: a retired row changed since is LEFT; leaving the brain (approved) gives back the rest', async () => {
    await rows('UPDATE "KeywordCoverageSet" SET name = $2 WHERE id = $1', [writerIds['coverage jacket'].id, 'coverage jacket (edited)'])
    const asked = await ask('set-ads-brain', { op: 'leave', productId: P, market: 'IT', bids: 'shadow', pauses: 'keep', why: 'test leave' })
    expect(await approve(asked.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    const on = await enabledOf()
    expect(on['rule negatives portfolio']).toBe(true)
    expect(on['dayparting own1']).toBe(true)
    expect(on['coverage jacket']).toBe(false)
    expect(await openRecords()).toEqual([])
    const left = (await records()).filter((r) => r.status === 'LEFT')
    expect(left.map((r) => r.name)).toEqual(['coverage jacket'])
    expect((await rows<{ why: string }>('SELECT "givenBackWhy" why FROM "AdsBrainRetirement" WHERE "targetId" = $1', [writerIds['coverage jacket'].id]))[0].why).toMatch(/a person changed it after it was retired .*: left as they made it/)
  })

  it('the tick gives back by itself when the server switch leaves live; op give-back un-retires one row on a person\'s word; a kill switch gives back its lever\'s rows', async () => {
    // Back in the brain, the bid brain running both campaigns again, every lever settled; the coverage set switched on by a person.
    await rows('UPDATE "KeywordCoverageSet" SET enabled = true WHERE id = $1', [writerIds['coverage jacket'].id])
    await rows('UPDATE "BidBrainEnrollment" SET mode = \'LIVE\' WHERE "workspaceId" = $1', [W])
    expect(await inW(() => enrollProduct({ productId: P1, market: 'IT', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true, bids: 'AUTO' })
    for (const [lever, level] of [['adGroupBids', 'OFF'], ['hours', 'PROPOSE'], ['placements', 'OFF'], ['state', 'AUTO'], ['budgets', 'AUTO'], ['portfolioCap', 'AUTO'], ['negatives', 'AUTO'], ['harvest', 'AUTO'], ['structure', 'PROPOSE'], ['biddingStrategy', 'OFF'], ['offAmazon', 'OFF']]) {
      expect(await inW(() => setLever({ productId: P, market: 'IT', lever: lever as never, level: level as never, by: 'user:owner', now: NOW }))).toMatchObject({ ok: true })
    }
    forgetLeverOwners()
    const again = await inW(() => runRetirement({ productId: P, market: 'IT', by: 'user:test', approvalId: null }))
    if ('refusal' in again) throw new Error(again.refusal)
    expect(again.retired).toHaveLength(7)

    // The server switch leaves live: the brain only plans, so every retired row comes back at the next tick.
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    const tick = await inW(() => runRetireTick())
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    expect(tick.checked).toBe(1)
    expect(tick.gaveBack[0].rows.map((r) => [nameOf(r.targetId), r.act]).sort()).toEqual(RETIRABLE.map((n) => [n, 'switchOn']))
    expect(await openRecords()).toEqual([])
    expect(Object.values(await enabledOf()).every(Boolean)).toBe(true)

    // Retired again; a person gives one back with the tool.
    const third = await inW(() => runRetirement({ productId: P, market: 'IT', by: 'user:test', approvalId: null }))
    if ('refusal' in third) throw new Error(third.refusal)
    const one = third.retired.find((r) => r.targetId === writerIds['dayparting own1'].id)!
    const asked = await ask('retire-ads-writers', { op: 'give-back', productId: P, market: 'IT', retirementIds: [one.recordId], why: 'test give one back' })
    expect(asked.preview.givesBack).toEqual([expect.objectContaining({ retirementId: one.recordId, does: 'switchOn' })])
    expect(await approve(asked.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect((await enabledOf())['dayparting own1']).toBe(true)
    expect(await openRecords()).toEqual(RETIRABLE.filter((n) => n !== 'dayparting own1'))

    // A kill switch on the budgets lever: its rows come back at once.
    const kill = await ask('set-brain-kill-switch', { op: 'kill', lever: 'budgets', productId: P, market: 'IT', why: 'test stop budgets' })
    expect(await approve(kill.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    forgetKills()
    expect(await openRecords()).toEqual(['coverage jacket', 'rule negatives portfolio'])
    expect((await executed(kill.approvalId)).status).toBe('executed')
  })

  it('another business sees none of it: the product is not found there and its tick checks nothing', async () => {
    expect(await inW2(() => loadRetireFacts(P1, 'IT'))).toEqual({ refusal: 'Product not found' })
    expect(await inW2(() => runRetireTick({ scan: true }))).toEqual({ checked: 0, gaveBack: [], asked: [], wouldAsk: [], failed: [] })
    expect((await rows<{ n: number }>('SELECT count(*)::int n FROM "AdsBrainRetirement" WHERE "workspaceId" = $1', [W2]))[0].n).toBe(0)
    expect(await inW2(() => database.client.adsBrainRetirement.count())).toBe(0)
  })
})

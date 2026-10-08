/**
 * ONE BRAIN AB-16 — the structure lever on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business profiles
 * ON), the job queue a stub, Amazon never called (nothing here writes there). A jacket in IT with a multi-keyword exact
 * campaign (one term brings most of its orders), an auto campaign, a campaign it shares with a glove and one it shares
 * with boots (not listed on Amazon: its copy cannot be built); a portfolio that holds the jacket alone and one it shares
 * with the glove. The Owner allows the jacket 4 new campaigns a week (his own number wins over the default 2).
 *
 *   table     AdsBrainStructure: one row per market × key, row-level security forced, another business sees none
 *   no-op     nothing enrolled: the tick decides nothing, writes nothing, records no run
 *   shadow    enrolled at OBSERVE on the weekly day: the term with most of the orders gets its single-keyword campaign
 *             (create-ad-campaign), the shared campaign its split (one copy per product, the jacket's copy leaving out the
 *             term its own campaign buys), the exact campaign its move into the jacket's portfolio — each SHADOW, nothing
 *             asked; a term without an exact home is the harvest's; a rerun only stamps; another weekday decides nothing
 *   propose   PROPOSE under the live ceiling: the builder's own request through the normal approval gate as the brain —
 *             create-ad-campaign for the single-keyword campaign, set-campaign-settings for the move, the split as ONE change
 *             plan of replicate-ad-structure steps; a builder that refuses (the boots are not listed) leaves the proposal
 *             HELD with its words
 *   go-live   the build approved (its change names the campaign, born at the floor, off the allowlist): BUILT, then its
 *             go-live asked as ONE change plan (allowlist + restore) with no authenticator code — inside the caps (D1 = B);
 *             a budget above the first-budget cap: the code; live → LIVE; a declined request → DECLINED, not asked again
 *   caps      what the structure proposed counts in the harvest's caps too (one cap for both)
 *   read      the ads-brain structure view, every amount hidden without the ad-spend permission; another business nothing
 *
 * Every value is made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
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
    agentPlanQueue: null, queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})

const { runStructureOnce } = await import('./structure-run.js')
const { structureDue, loadStructureFacts } = await import('./structure-load.js')
const { decideStructure } = await import('./structure.js')
const { structureGoLive } = await import('./structure-golive.js')
const { runBrainStructureTick, BRAIN_STRUCTURE_JOB } = await import('../../../jobs/ads-brain-structure.job.js')
const { enrollProduct, setLever, setOverride } = await import('./enrollment.js')
const { forgetLeverOwners } = await import('./lever-owners.js')
const { loadHarvestMarket, harvestDue } = await import('./harvest-load.js')
const { ADS_BRAIN_TOOLS } = await import('../../agents/tools/ads-brain.tools.js')
const { visibleTo } = await import('../../agents/call-tool.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `ab16_structure_${hex}`
const W2 = `ab16_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const id = (s: string) => `${hex}-${s}`
const C = (s: string) => id(`c-${s}`)
const G = (s: string) => `g-${C(s)}`
const JACKET = id('jacket'), JACKET_M = id('jacket-m'), GLOVE = id('glove'), GLOVE_L = id('glove-l'), BOOTS = id('boots'), BOOTS_M = id('boots-m')
const PF_JACKET = `PF-JK-${hex}`, PF_MIXED = `PF-MIX-${hex}`
/** A Monday (the weekly day in Rome), and the Tuesday after. */
const MONDAY = new Date('2026-10-12T05:40:00Z')
const TUESDAY = new Date('2026-10-13T05:40:00Z')
const OWNER = 'user:owner'

type Data = Record<string, any>
/** The rows by name: SKC, PORTFOLIO, SPLIT (the glove's shared campaign) and SPLIT_BOOTS. */
const structures = async () => Object.fromEntries((await inW(() => database.client.adsBrainStructure.findMany({ orderBy: { key: 'asc' } }))).map((r) => [r.key === `split:${C('shared-boots')}` ? 'SPLIT_BOOTS' : r.kind, r as Data]))
const approvals = async (toolName: string) => inW(() => database.client.agentApproval.findMany({ where: { toolName }, orderBy: { requestedAt: 'asc' } })) as Promise<Data[]>

/** One search-term row: clicks, orders, spend and sales in cents. */
const st = (campaign: string, query: string, clicks: number, orders: number, spendCents: number, salesCents: number) => ({
  profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date('2026-09-28T00:00:00Z'), campaignId: `EXT-${C(campaign)}`, adGroupId: `EXT-${G(campaign)}`,
  query, impressions: clicks * 7, clicks, costMicros: BigInt(spendCents) * 10_000n, currencyCode: 'EUR', sales7dCents: salesCents, orders7d: orders,
})

async function seed() {
  const db = database.client
  await seedAdsFixture(db)
  const product = (pid: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: pid, sku, name: sku, basePrice: '80.00', totalStock: 5, ...extra } })
  await product(JACKET, `AB16-JACKET-${hex}`, { isParent: true, name: 'Jacket' })
  await product(JACKET_M, `AB16-JACKET-M-${hex}`, { parentId: JACKET, amazonAsin: `B0AB16JM${H}` })
  await product(GLOVE, `AB16-GLOVE-${hex}`, { isParent: true, name: 'Glove', basePrice: '30.00' })
  await product(GLOVE_L, `AB16-GLOVE-L-${hex}`, { parentId: GLOVE, amazonAsin: `B0AB16GL${H}`, basePrice: '30.00' })
  await product(BOOTS, `AB16-BOOTS-${hex}`, { isParent: true, name: 'Boots' })
  await product(BOOTS_M, `AB16-BOOTS-M-${hex}`, { parentId: BOOTS, amazonAsin: `B0AB16BM${H}` })
  // The jacket and the glove are listed on Amazon in IT; the boots are not.
  for (const pid of [JACKET_M, GLOVE_L]) await db.channelListing.create({ data: { productId: pid, channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', listingStatus: 'ACTIVE' } })
  const jacket: [string, string, string] = [JACKET_M, `B0AB16JM${H}`, `AB16-JACKET-M-${hex}`]
  const glove: [string, string, string] = [GLOVE_L, `B0AB16GL${H}`, `AB16-GLOVE-L-${hex}`]
  const boots: [string, string, string] = [BOOTS_M, `B0AB16BM${H}`, `AB16-BOOTS-M-${hex}`]
  const campaign = async (key: string, ads: Array<[string, string, string]>, extra: Record<string, unknown> = {}) => {
    await db.campaign.create({ data: { id: C(key), name: `${key} ${hex}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${C(key)}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra } })
    await db.adGroup.create({ data: { id: G(key), campaignId: C(key), name: `${key} group`, externalAdGroupId: `EXT-${G(key)}` } })
    for (const [i, ad] of ads.entries()) await db.adProductAd.create({ data: { id: id(`ad-${key}-${i}`), adGroupId: G(key), productId: ad[0], asin: ad[1], sku: ad[2] } })
  }
  const kw = (key: string, tid: string, text: string, expressionType: string, bidCents: number, extra: Record<string, unknown> = {}) =>
    db.adTarget.create({ data: { id: id(tid), adGroupId: G(key), kind: 'KEYWORD', expressionType, expressionValue: text, bidCents, externalTargetId: `EXT-${id(tid)}`, ...extra } })
  await campaign('jk-exact', [jacket], { targetingType: 'MANUAL', portfolioId: PF_MIXED })
  await campaign('jk-auto', [jacket], { targetingType: 'AUTO', portfolioId: PF_JACKET })
  await campaign('gl-auto', [glove], { targetingType: 'AUTO', portfolioId: PF_MIXED })
  await campaign('shared', [jacket, glove], { targetingType: 'MANUAL' })
  await campaign('shared-boots', [jacket, boots], { targetingType: 'MANUAL' })
  await kw('jk-exact', 't-racing', 'racing jacket', 'EXACT', 60)
  await kw('jk-exact', 't-touring', 'touring jacket', 'EXACT', 50)
  await kw('jk-exact', 't-winter', 'winter jacket', 'EXACT', 40)
  await kw('shared', 't-sh-gear', 'motorbike gear', 'BROAD', 40)
  await kw('shared', 't-sh-racing', 'racing jacket', 'PHRASE', 45)
  await kw('shared', 't-sh-neg', 'cheap', 'NEGATIVE_EXACT', 0, { isNegative: true, negativeLevel: 'AD_GROUP' })
  await kw('shared-boots', 't-shb-gear', 'riding boots', 'BROAD', 40)
  for (const [pid, name] of [[PF_JACKET, 'Jacket IT'], [PF_MIXED, 'Mixed IT']]) await db.amazonAdsPortfolio.create({ data: { profileId: 'P-IT-TEST', externalPortfolioId: pid, name, state: 'ENABLED' } })
  await db.amazonAdsSearchTerm.createMany({
    data: [
      st('jk-exact', 'racing jacket', 300, 6, 6000, 48_000),
      st('jk-exact', 'touring jacket', 100, 1, 2000, 8000),
      st('jk-auto', 'sport jacket', 100, 3, 2000, 24_000),
    ],
  })
  // The product-ad report of the shared campaign: the jacket's ad spent three times the glove's.
  for (const [i, cents] of [[0, 3000], [1, 1000]] as const) {
    await db.amazonAdsDailyPerformance.create({ data: { profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date('2026-09-28T00:00:00Z'), entityType: 'PRODUCT_AD', entityId: `EXT-ad-${i}-${hex}`, localEntityId: id(`ad-shared-${i}`), costMicros: BigInt(cents) * 10_000n, currencyCode: 'EUR', reportedAt: new Date('2026-09-29T00:00:00Z') } })
  }
  await db.adsStrategy.create({ data: { channel: 'AMAZON', market: 'IT', level: 'MARKET', scopeId: '*', label: 'IT', targetKind: 'ACOS', targetPct: 25, targetHiPct: 30, updatedBy: OWNER } })
  await db.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon Italy', region: 'EU', currency: 'EUR', language: 'it' } })
  await db.adSpendCeiling.create({ data: { grain: 'MARKET', scopeId: 'IT', label: 'IT', dailyCapCents: 10_000 } })
}

describe.skipIf(!concurrentDatabaseUrl())('AB-16 — the structure lever (real PostgreSQL)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    vi.stubEnv('NEXUS_ADS_BRAIN_STRUCTURE_MODE', 'shadow')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(seed)
  }, 240_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('the table: one row per market × key, row-level security forced, another business sees none', async () => {
    const db = database.client
    const base = { productId: 'x-table', kind: 'SKC', status: 'SHADOW', level: 'OBSERVE', plan: {}, evidence: {}, why: 't', digest: 'd', runId: 'r', decidedAt: MONDAY, checkedAt: MONDAY, changedAt: MONDAY }
    const row = await inW(() => db.adsBrainStructure.create({ data: { marketplace: 'IT', key: 'skc:x-table:x', ...base } }))
    expect(row.workspaceId).toBe(W)
    await expect(inW(() => db.adsBrainStructure.create({ data: { marketplace: 'IT', key: 'skc:x-table:x', ...base } }))).rejects.toMatchObject({ code: 'P2002' })
    await inW2(async () => {
      expect(await db.adsBrainStructure.findMany()).toEqual([])
      expect(await db.$executeRaw`UPDATE "AdsBrainStructure" SET status = 'DONE' WHERE id = ${row.id}`).toBe(0)
    })
    expect(await rows('SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1', ['AdsBrainStructure'])).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }])
    expect(await rows('SELECT policyname FROM pg_policies WHERE tablename = $1', ['AdsBrainStructure'])).toEqual([{ policyname: 'nexus_workspace_isolation' }])
    await database.pool.query('DELETE FROM "AdsBrainStructure" WHERE "productId" = \'x-table\'')
  })

  it('no-op: nothing enrolled — the tick decides nothing, writes nothing and records no run', async () => {
    expect(await inW(() => structureDue())).toMatchObject({ due: false })
    expect(await inW(() => runBrainStructureTick(MONDAY))).toMatchObject({ ran: false })
    expect(await rows('SELECT count(*)::int AS n FROM "AdsBrainStructure" WHERE "workspaceId" = $1', [W])).toEqual([{ n: 0 }])
    expect(await rows('SELECT count(*)::int AS n FROM "CronRun" WHERE "jobName" = $1', [BRAIN_STRUCTURE_JOB])).toEqual([{ n: 0 }])
  })

  it('shadow: OBSERVE on the weekly day logs the single-keyword campaign, the split and the move — nothing asked; a rerun only stamps; Tuesday decides nothing', async () => {
    expect(await inW(() => enrollProduct({ productId: JACKET_M, market: 'IT', by: OWNER, now: MONDAY }))).toMatchObject({ ok: true })
    // The Owner's own number of new campaigns a week wins over the default (two splits and the single-keyword campaign).
    expect(await inW(() => setOverride({ productId: JACKET, market: 'IT', by: OWNER, reason: 'room for the splits', now: MONDAY, override: { scope: 'PRODUCT', kind: 'VALUE', key: 'newCampaignsPerWeek', value: 4 } }))).toMatchObject({ ok: true })
    const run = await inW(() => runBrainStructureTick(MONDAY))
    expect(run).toMatchObject({ ran: true, products: 1, decided: { skc: 1, split: 2, portfolio: 1, held: 0 }, acted: { logged: 4, proposed: 0 }, failed: [] })
    const s = await structures()
    expect(Object.keys(s).sort()).toEqual(['PORTFOLIO', 'SKC', 'SPLIT', 'SPLIT_BOOTS'])
    // The single-keyword campaign: the term with 6 of the product's 10 orders (60 %), through create-ad-campaign.
    expect(s.SKC).toMatchObject({ key: `skc:${JACKET}:racing jacket`, status: 'SHADOW', level: 'OBSERVE', builder: 'create-ad-campaign', term: 'racing jacket', approvalId: null })
    expect(s.SKC.plan.reasons).toEqual(['orders'])
    expect(s.SKC.plan.request).toMatchObject({ tool: 'create-ad-campaign', args: { market: 'IT', name: 'Jacket | IT | SKC | racing jacket', skus: [`AB16-JACKET-M-${hex}`], keywords: [{ text: 'racing jacket', matchType: 'EXACT', bidCents: 60 }], defaultBidCents: 60, biddingStrategy: 'down' } })
    expect(s.SKC.evidence).toMatchObject({ orders: 6, productOrders: 10, sharePct: 60 })
    expect(s.SKC.plan.owners.term).toMatch(/keeps running where it runs now/)
    // The split: one copy per product, each advertising its own SKU; the jacket's copy leaves out the term its own campaign buys.
    expect(s.SPLIT).toMatchObject({ key: `split:${C('shared')}`, status: 'SHADOW', builder: 'replicate-ad-structure', campaignId: C('shared') })
    const steps = s.SPLIT.plan.request.plan.steps as Data[]
    expect(steps.map((x) => [x.args.skus, x.args.skipTerms ?? null, x.args.acceptTerms])).toEqual([
      [[`AB16-GLOVE-L-${hex}`], null, ['motorbike gear', 'racing jacket']],
      [[`AB16-JACKET-M-${hex}`], ['racing jacket'], ['motorbike gear']],
    ])
    // Budgets: the glove's quarter of the shared budget; the jacket's three quarters held to its first-budget cap (no money plan: Amazon's lowest).
    expect(steps.map((x) => x.args.budgetPolicy)).toEqual([{ mode: 'fixed', value: 500 }, { mode: 'fixed', value: 100 }])
    expect(s.SPLIT.plan.migration.join(' ')).toMatch(/History: Amazon cannot move/)
    expect(s.SPLIT.plan.campaigns).toBe(2)
    // The move: the exact campaign out of the portfolio it shares with the glove, into the jacket's own.
    expect(s.PORTFOLIO).toMatchObject({ key: `portfolio:${JACKET}`, status: 'SHADOW', builder: 'set-campaign-settings' })
    expect(s.PORTFOLIO.plan.request).toEqual({ tool: 'set-campaign-settings', args: { campaigns: [{ campaignId: C('jk-exact'), portfolioId: PF_JACKET }], why: expect.any(String) } })
    // Nothing asked; the cron recorded its run.
    expect((await approvals('create-ad-campaign')).length + (await approvals('set-campaign-settings')).length + (await approvals('submit-change-plan')).length).toBe(0)
    expect(await rows('SELECT count(*)::int AS n FROM "CronRun" WHERE "jobName" = $1', [BRAIN_STRUCTURE_JOB])).toEqual([{ n: 1 }])
    // A rerun on the same facts only stamps; Tuesday is not the weekly day.
    const again = await inW(() => runStructureOnce({ now: new Date(MONDAY.getTime() + 60_000) }))
    expect(again.acted.logged).toBe(0)
    expect((await structures()).SKC.changedAt.getTime()).toBe(s.SKC.changedAt.getTime())
    expect(await inW(() => runStructureOnce({ now: TUESDAY }))).toMatchObject({ notDue: 1, decided: { skc: 0, split: 0, portfolio: 0 } })
    // Without the Owner's number, the default 2 a week: the two splits take them and the single-keyword campaign waits.
    const facts = await inW(async () => loadStructureFacts((await structureDue()).products[0], MONDAY))
    if ('skipped' in facts) throw new Error(facts.skipped)
    const d = decideStructure({ ...facts, settings: { ...facts.settings, newCampaignsPerWeek: 2 }, records: new Map() }, MONDAY)
    expect(d.filter((x) => x.kind === 'SKC').map((x) => [x.act, x.heldBy])).toEqual([['none', expect.stringMatching(/past this week's cap of 2 new campaigns/)]])
  })

  it('propose: PROPOSE under the live ceiling asks each builder as the brain — create-ad-campaign, set-campaign-settings; a refusing builder holds the proposal with its words', async () => {
    vi.stubEnv('NEXUS_ADS_BRAIN_STRUCTURE_MODE', 'live')
    expect(await inW(() => setLever({ productId: JACKET, market: 'IT', lever: 'structure', level: 'PROPOSE', by: OWNER, now: MONDAY }))).toMatchObject({ ok: true })
    forgetLeverOwners()
    const run = await inW(() => runStructureOnce({ now: MONDAY }))
    expect(run.failed).toEqual([])
    const s = await structures()
    const [build] = await approvals('create-ad-campaign')
    expect(build).toMatchObject({ status: 'pending', args: { market: 'IT', name: 'Jacket | IT | SKC | racing jacket', keywords: [{ text: 'racing jacket', matchType: 'EXACT', bidCents: 60 }] } })
    expect(s.SKC).toMatchObject({ status: 'PROPOSED', level: 'PROPOSE', approvalId: build.id })
    const [move] = await approvals('set-campaign-settings')
    expect(move).toMatchObject({ status: 'pending', args: { campaigns: [{ campaignId: C('jk-exact'), portfolioId: PF_JACKET }] } })
    expect(s.PORTFOLIO).toMatchObject({ status: 'PROPOSED', approvalId: move.id })
    // The split: ONE change plan, a replicate-ad-structure step per product (each previewed by the builder itself).
    const [plan] = await approvals('submit-change-plan')
    expect(s.SPLIT).toMatchObject({ status: 'PROPOSED', approvalId: plan.id })
    const steps = await rows<{ toolName: string; position: number; args: Data }>('SELECT "toolName", position, args FROM "AgentPlanStep" WHERE "approvalId" = $1 ORDER BY position', [plan.id])
    expect(steps.map((x) => [x.toolName, x.position, x.args.skus])).toEqual([['replicate-ad-structure', 1, [`AB16-GLOVE-L-${hex}`]], ['replicate-ad-structure', 2, [`AB16-JACKET-M-${hex}`]]])
    // The boots are not listed: the builder refused, nothing was asked — held with its own words.
    expect(s.SPLIT_BOOTS).toMatchObject({ status: 'HELD', approvalId: null, heldBy: expect.stringMatching(/^replicate-ad-structure refused the request, nothing was asked: .*AB16-BOOTS-M-.* is not listed on Amazon in IT/) })
    expect(run.acted.proposed).toBe(3)
  })

  it('go-live: the build approved → BUILT → ONE change plan (allowlist + restore) with no code, inside the caps (D1 = B); live → LIVE', async () => {
    const db = database.client
    const s0 = await structures()
    // As the approved create-ad-campaign leaves it: born at the floor, off the allowlist, its change naming the campaign.
    const madeAt = new Date()
    await inW(async () => {
      await db.campaign.create({ data: { id: C('skc'), name: 'Jacket | IT | SKC | racing jacket', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${C('skc')}`, dailyBudget: '1.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: false, createdAt: madeAt, bidsSuppressedAt: madeAt, bidsSuppressedBy: OWNER, bidsSuppressedFloorCents: 2 } })
      await db.adGroup.create({ data: { id: G('skc'), campaignId: C('skc'), name: 'skc group', externalAdGroupId: `EXT-${G('skc')}`, defaultBidCents: 2, suppressedFromBidCents: 60 } })
      await db.adProductAd.create({ data: { adGroupId: G('skc'), productId: JACKET_M, asin: `B0AB16JM${H}`, sku: `AB16-JACKET-M-${hex}` } })
      await db.adTarget.create({ data: { id: id('t-skc'), adGroupId: G('skc'), kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'racing jacket', bidCents: 2, suppressedFromBidCents: 60, externalTargetId: `EXT-${id('t-skc')}` } })
      await db.agentApproval.update({ where: { id: s0.SKC.approvalId }, data: { status: 'executed', decidedAt: madeAt } })
      await db.agentChange.create({ data: { approvalId: s0.SKC.approvalId, toolName: 'create-ad-campaign', via: 'nexus', reversibility: 'none', executedAt: madeAt, before: { campaignId: null }, after: { campaignId: C('skc'), name: 'Jacket | IT | SKC | racing jacket', market: 'IT' } } })
    })
    const run = await inW(() => runStructureOnce({ now: TUESDAY }))
    expect(run.pending).toMatchObject({ built: 1, liveAsked: 1 })
    const s = await structures()
    expect(s.SKC).toMatchObject({ status: 'LIVE_PROPOSED', builtCampaignIds: [C('skc')] })
    // The go-live: one change plan, the allowlist then the restore, and no authenticator code (inside the caps).
    const plan = (await approvals('submit-change-plan')).find((a) => a.id === s.SKC.liveApprovalId)!
    expect(plan).toMatchObject({ status: 'pending' })
    expect(plan.preview.stepUp).toBeUndefined()
    const steps = await rows<{ toolName: string; preview: Data }>('SELECT "toolName", preview FROM "AgentPlanStep" WHERE "approvalId" = $1 ORDER BY position', [plan.id])
    expect(steps.map((x) => x.toolName)).toEqual(['set-campaign-live-writes', 'restore-campaign'])
    for (const step of steps) expect(step.preview, step.toolName).toMatchObject({ brainStructure: { inside: true } })
    expect(steps.every((x) => !x.preview.stepUp)).toBe(true)
    expect(await inW(() => structureGoLive([C('skc')]))).toMatchObject({ inside: true })
    // A first budget above the cap is outside: the code, as before.
    await inW(() => db.campaign.update({ where: { id: C('skc') }, data: { dailyBudget: '10.00' } }))
    expect(await inW(() => structureGoLive([C('skc')]))).toMatchObject({ inside: false, why: expect.stringMatching(/above the first-budget cap/) })
    await inW(() => db.campaign.update({ where: { id: C('skc') }, data: { dailyBudget: '1.00' } }))
    // The structure's env ceiling back to shadow: outside, the code again.
    vi.stubEnv('NEXUS_ADS_BRAIN_STRUCTURE_MODE', 'shadow')
    expect(await inW(() => structureGoLive([C('skc')]))).toMatchObject({ inside: false, why: expect.stringMatching(/NEXUS_ADS_BRAIN_STRUCTURE_MODE is shadow/) })
    vi.stubEnv('NEXUS_ADS_BRAIN_STRUCTURE_MODE', 'live')
    // Live (as the approved plan leaves it): LIVE — its bids are the bid brain's from here.
    await inW(() => db.campaign.update({ where: { id: C('skc') }, data: { liveBidWritesEnabled: true, bidsSuppressedAt: null } }))
    expect((await inW(() => runStructureOnce({ now: TUESDAY }))).pending.live).toBe(1)
    expect((await structures()).SKC).toMatchObject({ status: 'LIVE' })
    // A brain campaign that is live already is no longer a go-live: the doors' own lines.
    expect(await inW(() => structureGoLive([C('skc')]))).toBeNull()
  })

  it('a declined move is DECLINED and not asked again for 30 days', async () => {
    const s0 = await structures()
    await inW(() => database.client.agentApproval.update({ where: { id: s0.PORTFOLIO.approvalId }, data: { status: 'rejected', decidedAt: new Date() } }))
    expect((await inW(() => runStructureOnce({ now: TUESDAY }))).pending.declined).toBe(1)
    expect((await structures()).PORTFOLIO).toMatchObject({ status: 'DECLINED', why: expect.stringMatching(/not asked again for 30 days/) })
    // The next weekly day: still declined (the cooldown), nothing asked again.
    const before = (await approvals('set-campaign-settings')).length
    await inW(() => runStructureOnce({ now: new Date(MONDAY.getTime() + 7 * 86_400_000) }))
    expect((await structures()).PORTFOLIO.status).toBe('DECLINED')
    expect((await approvals('set-campaign-settings')).length).toBe(before)
  })

  it('caps: the structure\'s new campaigns this week count in the harvest\'s caps too (one cap for both)', async () => {
    const due = await inW(() => harvestDue())
    expect(due.due).toBe(true)
    const m = await inW(() => loadHarvestMarket('IT', due.products, MONDAY))
    const facts = m.products.get(JACKET)!.facts
    // The single-keyword campaign (LIVE) stands; the build was proposed this week.
    expect(facts.used.skcs).toBeGreaterThanOrEqual(1)
    expect(facts.used.campaignsThisWeek).toBeGreaterThanOrEqual(1)
  })

  it('the Owner keeps a campaign out: excluded, it is never moved; read: the structure view, money hidden; another business nothing', async () => {
    expect(await inW(() => setOverride({ productId: JACKET, market: 'IT', by: OWNER, reason: 'mine', now: MONDAY, override: { scope: 'CAMPAIGN', campaignId: C('jk-exact'), kind: 'EXCLUDE', key: '*' } }))).toMatchObject({ ok: true })
    const tool = ADS_BRAIN_TOOLS[0]
    const out = await inW(() => tool.handler!({ view: 'structure', market: 'IT', productId: JACKET_M }, {} as never)) as Data
    expect(out.ok).toBe(true)
    expect(out.data).toMatchObject({ view: 'structure', productId: JACKET, market: 'IT', structureLever: { level: 'PROPOSE' } })
    expect(out.data.stored.map((r: Data) => [r.kind, r.status])).toEqual(expect.arrayContaining([['SKC', 'LIVE'], ['PORTFOLIO', 'DECLINED']]))
    // Decided now: the excluded campaign is left, so nothing to move.
    expect(out.data.decidedNow.find((d: Data) => d.kind === 'PORTFOLIO')).toBeUndefined()
    const skc = out.data.stored.find((r: Data) => r.kind === 'SKC')
    expect(skc.request.args.money).toMatchObject({ dailyBudgetCents: expect.any(Number), defaultBidCents: 60 })
    const principal = { kind: 'user', userId: 'u-nomoney', label: 'No money', via: 'claude', permissions: { isOwner: false, permissions: new Set<string>([FEATURES.adsView]) } }
    const hidden = visibleTo(principal as never, tool, out.data) as Data
    expect(JSON.stringify(hidden)).not.toMatch(/"(money|dailyBudgetCents)"/)
    expect(hidden.stored.find((r: Data) => r.kind === 'SKC').request.args).not.toHaveProperty('money')
    const withMoney = visibleTo({ ...principal, permissions: { isOwner: false, permissions: new Set<string>([FEATURES.adsView, FIELDS.financialsAdspendView]) } } as never, tool, out.data) as Data
    expect(withMoney.stored.find((r: Data) => r.kind === 'SKC').request.args.money).toBeTruthy()
    const other = await inW2(() => tool.handler!({ view: 'structure', market: 'IT' }, {} as never)) as Data
    expect(other.data.products).toEqual([])
  })
})

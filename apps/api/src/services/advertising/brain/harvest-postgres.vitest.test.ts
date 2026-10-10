/**
 * ONE BRAIN AB-11 — the harvest module on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business profiles
 * ON), the brain's ceiling live, the ads mode LIVE with Amazon's create calls stubbed at the client (nothing leaves the
 * process) and the job queue a stub. A jacket in IT: an auto campaign, a phrase campaign, a second auto campaign, a broad
 * campaign the Owner excluded, a broad campaign off the live-write allowlist, and one exact campaign (the destination);
 * a glove with an auto campaign only (no destination: a new campaign).
 *
 *   table     AdsBrainHarvest: one row per product × market × term, row-level security forced, another business sees none
 *   no-op     nothing enrolled: the tick decides nothing, writes nothing, records no run
 *   shadow    enrolled at OBSERVE (and a shadow ceiling): one SHADOW row per harvest candidate — the destination (the
 *             product's exact ad group), the start bid, every source with its negative (the excluded campaign left with
 *             why), the glove's new campaign; nothing at Amazon, no request; a rerun only stamps
 *   propose   PROPOSE under the live ceiling: the pair asked of a person (apply-brain-harvest), the glove's new campaign
 *             asked through create-ad-campaign (a Nexus builder) — nothing at Amazon until a person approves
 *   approve   the person approves the pair: the keyword in the exact ad group and the negative exact in both sources, one
 *             change set (the approval on every row), the excluded campaign untouched; DONE, judged after 7 days + 72 h
 *   auto      AUTO: the brain writes a pair itself through the real write gate; a source off the allowlist refuses the
 *             negative at the gate, so NEITHER half is written; a negative that fails leaves the pair HALF_DONE and the
 *             next run sends it again
 *   judge     a harvest past its window with 0 orders in the clicks that make it a 95 % call is WORSE: its undo is asked of
 *             a person, and once approved the keyword is paused and the source negatives retired
 *   read      the ads-brain harvest view, every amount hidden without the ad-spend permission; another business nothing
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
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
// Amazon's create calls, stubbed at the client: what reaches them is what the real services and the real gate let through.
const amz = vi.hoisted(() => ({
  keywords: [] as Array<Record<string, unknown>>,
  negatives: [] as Array<Record<string, unknown>>,
  failNegativeFor: null as string | null,
  n: 0,
}))
vi.mock('../ads-api-client.js', async (original) => ({
  ...(await original<object>()),
  createKeyword: vi.fn(async (_ctx: unknown, input: Record<string, unknown>) => { amz.keywords.push(input); return { ok: true, mode: 'live', externalId: `AMZ-K-${++amz.n}`, rawResponse: {}, error: null } }),
  createTarget: vi.fn(async (_ctx: unknown, input: Record<string, unknown>) => { amz.keywords.push(input); return { ok: true, mode: 'live', externalId: `AMZ-T-${++amz.n}`, rawResponse: {}, error: null } }),
  createNegativeKeyword: vi.fn(async (_ctx: unknown, input: Record<string, unknown>) => {
    if (amz.failNegativeFor && input.externalAdGroupId === amz.failNegativeFor) return { ok: true, mode: 'live', externalId: null, rawResponse: { negativeKeywords: { error: [{ code: 'SERVER_IS_BUSY' }] } } }
    amz.negatives.push(input)
    return { ok: true, mode: 'live', externalId: `AMZ-N-${++amz.n}`, rawResponse: {} }
  }),
  createNegativeProductTarget: vi.fn(async (_ctx: unknown, input: Record<string, unknown>) => { amz.negatives.push(input); return { ok: true, mode: 'live', externalId: `AMZ-NT-${++amz.n}`, rawResponse: {} } }),
  listNegativeKeywords: vi.fn(async () => []),
}))

const { runHarvestOnce } = await import('./harvest-run.js')
const { harvestDue } = await import('./harvest-load.js')
const { runBrainHarvestTick, BRAIN_HARVEST_JOB } = await import('../../../jobs/ads-brain-harvest.job.js')
const { enrollProduct, setLever, setOverride, endOverride } = await import('./enrollment.js')
const { forgetLeverOwners } = await import('./lever-owners.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')
const { getTool } = await import('../../agents/tool-registry.js')
const { ADS_BRAIN_TOOLS } = await import('../../agents/tools/ads-brain.tools.js')
const { visibleTo } = await import('../../agents/call-tool.js')
const { HARVEST_ACTOR } = await import('./harvest.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `ab11_harvest_${hex}`
const W2 = `ab11_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const id = (s: string) => `${hex}-${s}`
const C = (s: string) => id(`c-${s}`)
const G = (s: string) => `g-${C(s)}`
const JACKET = id('jacket'), JACKET_M = id('jacket-m'), GLOVE = id('glove'), GLOVE_L = id('glove-l')
const NOW = new Date('2026-10-09T05:25:00Z')
const DAY = 86_400_000
const OWNER = 'user:owner'

type Data = Record<string, any>
const harvests = async (productId = JACKET) => Object.fromEntries((await inW(() => database.client.adsBrainHarvest.findMany({ where: { productId } }))).map((r) => [r.term, r as Data]))
const approvals = async (toolName: string) => inW(() => database.client.agentApproval.findMany({ where: { toolName }, orderBy: { requestedAt: 'asc' } })) as Promise<Data[]>
const created = async () => (await rows<{ n: number }>('SELECT count(*)::int AS n FROM "AdTarget" WHERE "workspaceId" = $1 AND id NOT LIKE $2', [W, `${hex}%`]))[0].n
const sourceNegatives = async (term: string) => rows<{ adGroupId: string; externalTargetId: string | null }>('SELECT "adGroupId", "externalTargetId" FROM "AdTarget" WHERE "workspaceId" = $1 AND "isNegative" AND lower("expressionValue") = $2 ORDER BY "adGroupId"', [W, term])

/** One search-term row: clicks, orders, spend and sales in cents, on one day. */
const st = (campaign: string, query: string, clicks: number, orders: number, spendCents: number, salesCents: number, date = '2026-09-20') => ({
  profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(`${date}T00:00:00Z`), campaignId: `EXT-${C(campaign)}`, adGroupId: `EXT-${G(campaign)}`,
  query, impressions: clicks * 7, clicks, costMicros: BigInt(spendCents) * 10_000n, currencyCode: 'EUR', sales7dCents: salesCents, orders7d: orders,
})

async function seed() {
  const db = database.client
  await seedAdsFixture(db)
  const product = (pid: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: pid, sku, name: sku, basePrice: '80.00', totalStock: 5, ...extra } })
  await product(JACKET, `AB11-JACKET-${hex}`, { isParent: true, name: 'Jacket' })
  await product(JACKET_M, `AB11-JACKET-M-${hex}`, { parentId: JACKET, amazonAsin: `B0AB11JM${H}` })
  await product(GLOVE, `AB11-GLOVE-${hex}`, { isParent: true, name: 'Glove', basePrice: '30.00' })
  await product(GLOVE_L, `AB11-GLOVE-L-${hex}`, { parentId: GLOVE, amazonAsin: `B0AB11GL${H}`, basePrice: '30.00' })
  const campaign = async (key: string, groupName: string, ad: [string, string, string], extra: Record<string, unknown> = {}) => {
    await db.campaign.create({ data: { id: C(key), name: `${key} ${hex}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${C(key)}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra } })
    await db.adGroup.create({ data: { id: G(key), campaignId: C(key), name: groupName, externalAdGroupId: `EXT-${G(key)}` } })
    await db.adProductAd.create({ data: { adGroupId: G(key), productId: ad[0], asin: ad[1], sku: ad[2] } })
  }
  const kw = (key: string, tid: string, text: string, expressionType: string, bidCents: number) =>
    db.adTarget.create({ data: { id: id(tid), adGroupId: G(key), kind: 'KEYWORD', expressionType, expressionValue: text, bidCents, externalTargetId: `EXT-${id(tid)}` } })
  const jacket: [string, string, string] = [JACKET_M, `B0AB11JM${H}`, `AB11-JACKET-M-${hex}`]
  const glove: [string, string, string] = [GLOVE_L, `B0AB11GL${H}`, `AB11-GLOVE-L-${hex}`]
  await campaign('jk-auto', 'Auto', jacket, { targetingType: 'AUTO' })
  await campaign('jk-auto2', 'Auto close', jacket, { targetingType: 'AUTO' })
  await campaign('jk-phrase', 'Phrase', jacket, { targetingType: 'MANUAL' })
  await campaign('jk-broad', 'Broad', jacket, { targetingType: 'MANUAL' })
  await campaign('jk-off', 'Broad off', jacket, { targetingType: 'MANUAL', liveBidWritesEnabled: false })
  await campaign('jk-exact', 'Exact', jacket, { targetingType: 'MANUAL' })
  await campaign('gl-auto', 'Auto', glove, { targetingType: 'AUTO' })
  await kw('jk-phrase', 't-phrase', 'jacket', 'PHRASE', 40)
  await kw('jk-broad', 't-broad', 'motorbike jacket', 'BROAD', 40)
  await kw('jk-off', 't-off', 'sports jacket', 'BROAD', 40)
  await kw('jk-exact', 't-racing', 'racing jacket', 'EXACT', 60)
  await db.amazonAdsSearchTerm.createMany({
    data: [
      st('jk-auto', 'touring jacket', 120, 4, 2400, 32_000),
      st('jk-phrase', 'touring jacket', 30, 1, 600, 8000),
      st('jk-broad', 'touring jacket', 10, 0, 200, 0),
      st('jk-auto2', 'sport jacket', 100, 3, 2000, 24_000),
      st('jk-off', 'track jacket', 100, 3, 2000, 24_000),
      st('jk-exact', 'racing jacket', 600, 18, 12_000, 144_000),
      st('gl-auto', 'glove liner', 100, 3, 1000, 9000),
    ],
  })
  await db.adsStrategy.create({ data: { channel: 'AMAZON', market: 'IT', level: 'MARKET', scopeId: '*', label: 'IT', targetKind: 'ACOS', targetPct: 25, targetHiPct: 30, updatedBy: 'user:owner' } })
  await db.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon Italy', region: 'EU', currency: 'EUR', language: 'it' } })
  await db.adSpendCeiling.create({ data: { grain: 'MARKET', scopeId: 'IT', label: 'IT', dailyCapCents: 10_000 } })
}

/** A person approves a request: the tool runs as he does (the approval worker's context). */
async function approve(ap: Data) {
  const tool = getTool(ap.toolName)!
  return inW(() => tool.execute!(ap.args as never, { userId: 'owner', approvalId: ap.id, approvedPreview: ap.preview, approvedByPerson: true, via: 'nexus', decidedVia: 'nexus', can: () => true } as never))
}

describe.skipIf(!concurrentDatabaseUrl())('AB-11 — the harvest module (real PostgreSQL)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    vi.stubEnv('NEXUS_ADS_BRAIN_HARVEST_MODE', 'shadow')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(async () => { await seed(); await setAutonomy('AUTO', 'test') })
  }, 240_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('the table: one row per product × market × term, row-level security forced, another business sees none', async () => {
    const db = database.client
    const base = { status: 'SHADOW', level: 'OBSERVE', destinationKind: 'NONE', sources: [], why: 't', evidence: {}, digest: 'd', runId: 'r', decidedAt: NOW, checkedAt: NOW, changedAt: NOW }
    const row = await inW(() => db.adsBrainHarvest.create({ data: { productId: 'x-table', marketplace: 'IT', term: 'x term', ...base } }))
    expect(row.workspaceId).toBe(W)
    await expect(inW(() => db.adsBrainHarvest.create({ data: { productId: 'x-table', marketplace: 'IT', term: 'x term', ...base } }))).rejects.toMatchObject({ code: 'P2002' })
    await inW2(async () => {
      expect(await db.adsBrainHarvest.findMany()).toEqual([])
      expect(await db.$executeRaw`UPDATE "AdsBrainHarvest" SET status = 'DONE' WHERE id = ${row.id}`).toBe(0)
    })
    expect(await rows('SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1', ['AdsBrainHarvest'])).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }])
    expect(await rows('SELECT policyname FROM pg_policies WHERE tablename = $1', ['AdsBrainHarvest'])).toEqual([{ policyname: 'nexus_workspace_isolation' }])
    await database.pool.query('DELETE FROM "AdsBrainHarvest" WHERE "productId" = \'x-table\'')
  })

  it('no-op: nothing enrolled — the tick decides nothing, writes nothing and records no run', async () => {
    expect(await inW(() => harvestDue())).toMatchObject({ due: false })
    expect(await inW(() => runBrainHarvestTick(NOW))).toMatchObject({ ran: false })
    expect(await rows('SELECT count(*)::int AS n FROM "AdsBrainHarvest" WHERE "workspaceId" = $1', [W])).toEqual([{ n: 0 }])
    expect(await rows('SELECT count(*)::int AS n FROM "CronRun" WHERE "jobName" = $1', [BRAIN_HARVEST_JOB])).toEqual([{ n: 0 }])
  })

  it('shadow: OBSERVE logs one harvest per candidate — destination, start bid, sources (the excluded campaign left), the glove\'s new campaign — and nothing at Amazon', async () => {
    for (const p of [JACKET_M, GLOVE_L]) expect(await inW(() => enrollProduct({ productId: p, market: 'IT', by: OWNER, now: NOW }))).toMatchObject({ ok: true })
    expect(await inW(() => setOverride({ productId: JACKET, market: 'IT', by: OWNER, reason: 'mine', now: NOW, override: { scope: 'CAMPAIGN', campaignId: C('jk-broad'), kind: 'EXCLUDE', key: '*' } }))).toMatchObject({ ok: true })
    const before = await created()
    const run = await inW(() => runBrainHarvestTick(NOW))
    expect(run).toMatchObject({ ran: true, products: 2, decided: { pairs: 3, newCampaigns: 1 }, acted: { logged: 4, proposed: 0, written: 0, campaignsProposed: 0 } })
    const h = await harvests()
    expect(Object.fromEntries(Object.entries(h).map(([t, r]) => [t, [r.status, r.level, r.destinationKind, r.destAdGroupId]]))).toEqual({
      'touring jacket': ['SHADOW', 'OBSERVE', 'EXISTING', G('jk-exact')],
      'sport jacket': ['SHADOW', 'OBSERVE', 'EXISTING', G('jk-exact')],
      'track jacket': ['SHADOW', 'OBSERVE', 'EXISTING', G('jk-exact')],
    })
    const touring = h['touring jacket']
    expect(touring.destHow).toBe('own')
    expect(touring.bidCents).toBeGreaterThan(4)
    expect(touring.sources.map((s: Data) => [s.adGroupId, s.action])).toEqual([[G('jk-auto'), 'negate'], [G('jk-phrase'), 'negate'], [G('jk-broad'), 'skipped']])
    expect(touring.sources[2].why).toMatch(/excluded from the brain by the Owner/)
    // OBSERVE logs it: nothing holds it, it only waits for its level.
    expect(touring).toMatchObject({ heldBy: null, why: expect.stringMatching(/^graduate it to exact in the product's exact ad group "Exact"/) })
    const glove = (await harvests(GLOVE))['glove liner']
    expect(glove).toMatchObject({ status: 'SHADOW', destinationKind: 'NEW_CAMPAIGN', destHow: 'new' })
    expect(glove.evidence.campaignPlan).toMatchObject({ skus: [`AB11-GLOVE-L-${hex}`], keywords: [{ text: 'glove liner', matchType: 'EXACT' }] })
    // Nothing at Amazon, no request, no keyword or negative.
    expect([amz.keywords.length, amz.negatives.length, await created(), (await approvals('apply-brain-harvest')).length]).toEqual([0, 0, before, 0])
    // A rerun on the same facts only stamps.
    const again = await inW(() => runHarvestOnce({ now: new Date(NOW.getTime() + 60_000) }))
    expect(again.acted.logged).toBe(0)
    expect((await harvests())['touring jacket'].changedAt.getTime()).toBe(touring.changedAt.getTime())
  })

  it('propose: under the live ceiling the pair is asked of a person, the glove\'s new campaign through create-ad-campaign — nothing at Amazon yet', async () => {
    vi.stubEnv('NEXUS_ADS_BRAIN_HARVEST_MODE', 'live')
    for (const p of [JACKET, GLOVE]) expect(await inW(() => setLever({ productId: p, market: 'IT', lever: 'harvest', level: 'PROPOSE', by: OWNER, now: NOW }))).toMatchObject({ ok: true })
    // The second auto campaign and the off-allowlist one stay in shadow for now (the Owner's campaign levels win).
    for (const key of ['jk-auto2', 'jk-off']) {
      expect(await inW(() => setOverride({ productId: JACKET, market: 'IT', by: OWNER, now: NOW, override: { scope: 'CAMPAIGN', campaignId: C(key), kind: 'LEVEL', key: 'harvest', value: 'OBSERVE' } }))).toMatchObject({ ok: true })
    }
    forgetLeverOwners()
    const run = await inW(() => runHarvestOnce({ now: NOW }))
    expect(run.acted).toMatchObject({ proposed: 1, campaignsProposed: 1, written: 0 })
    const h = await harvests()
    expect([h['touring jacket'].status, h['sport jacket'].status, h['track jacket'].status]).toEqual(['PROPOSED', 'SHADOW', 'SHADOW'])
    const [ask] = await approvals('apply-brain-harvest')
    expect(ask).toMatchObject({ status: 'pending', id: h['touring jacket'].approvalId, args: { op: 'harvest', harvestId: h['touring jacket'].id } })
    expect(ask.preview).toMatchObject({ op: 'harvest', term: 'touring jacket', destinationAdGroup: { id: G('jk-exact') }, reach: { reach: 'live' } })
    expect(ask.preview.changes).toHaveLength(3)
    const [build] = await approvals('create-ad-campaign')
    expect(build).toMatchObject({ status: 'pending', args: { market: 'IT', skus: [`AB11-GLOVE-L-${hex}`], keywords: [{ text: 'glove liner', matchType: 'EXACT' }] } })
    expect((await harvests(GLOVE))['glove liner']).toMatchObject({ status: 'CAMPAIGN_PROPOSED', approvalId: build.id })
    expect([amz.keywords.length, amz.negatives.length]).toEqual([0, 0])
  })

  it('approve: the keyword and the negative exact in both sources as one change set; the excluded campaign untouched; DONE, judged after the window', async () => {
    const [ask] = await approvals('apply-brain-harvest')
    const ran = await approve(ask)
    expect(ran).toMatchObject({ ok: true, data: { status: 'DONE', changeSetId: ask.id } })
    expect(amz.keywords).toEqual([expect.objectContaining({ keywordText: 'touring jacket', matchType: 'EXACT', externalAdGroupId: `EXT-${G('jk-exact')}` })])
    expect(amz.negatives.map((n) => [n.externalAdGroupId, n.keywordText, n.matchType])).toEqual([[`EXT-${G('jk-auto')}`, 'touring jacket', 'EXACT'], [`EXT-${G('jk-phrase')}`, 'touring jacket', 'EXACT']])
    expect((await sourceNegatives('touring jacket')).map((r) => r.adGroupId)).toEqual([G('jk-auto'), G('jk-phrase')].sort())
    const t = (await harvests())['touring jacket']
    expect(t).toMatchObject({ status: 'DONE', verdict: 'WAITING', approvalId: ask.id })
    expect(t.judgeAfter.getTime() - t.landedAt.getTime()).toBe(10 * DAY)
    expect(t.sources.map((s: Data) => s.result ?? null)).toEqual(['landed', 'landed', null])
    // Every write carries the approval as its change set.
    expect(await rows('SELECT DISTINCT "executionId" FROM "AdvertisingActionLog" WHERE "workspaceId" = $1 AND "actionType" IN (\'create_keyword\', \'create_negative_keyword\')', [W])).toEqual([{ executionId: ask.id }])
    // Asked again, it is no longer waiting: refused, nothing sent twice.
    expect(await approve(ask)).toMatchObject({ ok: false })
    expect(amz.keywords).toHaveLength(1)
  })

  it('auto: the brain writes the pair through the real gate; a source off the allowlist refuses its negative, so neither half is written; a failed negative leaves it HALF_DONE and the next run sends it', async () => {
    expect(await inW(() => setLever({ productId: JACKET, market: 'IT', lever: 'harvest', level: 'AUTO', by: OWNER, now: NOW }))).toMatchObject({ ok: true })
    for (const key of ['jk-auto2', 'jk-off']) expect(await inW(() => endOverride({ productId: JACKET, market: 'IT', by: OWNER, now: NOW, override: { scope: 'CAMPAIGN', campaignId: C(key), kind: 'LEVEL', key: 'harvest' } }))).toMatchObject({ ok: true })
    forgetLeverOwners()
    amz.failNegativeFor = `EXT-${G('jk-auto2')}`
    const run = await inW(() => runHarvestOnce({ now: NOW }))
    expect(run.acted.written).toBe(2)
    let h = await harvests()
    // The off-allowlist source: the gate refuses the negative at the pre-flight — nothing written, the keyword neither.
    expect(h['track jacket']).toMatchObject({ status: 'REFUSED', keywordTargetId: null, why: expect.stringMatching(/nothing was written — the write gate refuses the source negative \(campaign_allowlist/) })
    expect(amz.keywords.map((k) => k.keywordText)).toEqual(['touring jacket', 'sport jacket'])
    // The second auto campaign's negative failed at Amazon: the keyword stands, the pair is half done.
    expect(h['sport jacket']).toMatchObject({ status: 'HALF_DONE', level: 'AUTO' })
    expect(h['sport jacket'].sources[0]).toMatchObject({ adGroupId: G('jk-auto2'), result: 'failed' })
    // The brain's writes are the brain's actor, through the real create service and the gate.
    expect(await rows('SELECT "userId" FROM "AdvertisingActionLog" WHERE "workspaceId" = $1 AND "actionType" = \'create_keyword\' AND "payloadAfter"->>\'keywordText\' = \'sport jacket\'', [W])).toEqual([{ userId: HARVEST_ACTOR }])
    // The next run sends the failed negative again: whole.
    amz.failNegativeFor = null
    const next = await inW(() => runHarvestOnce({ now: new Date(NOW.getTime() + 60_000) }))
    expect(next.pending.retried).toBe(1)
    h = await harvests()
    expect(h['sport jacket']).toMatchObject({ status: 'DONE' })
    expect(amz.keywords).toHaveLength(2)
    expect((await sourceNegatives('sport jacket')).map((r) => r.adGroupId)).toEqual([G('jk-auto2')])
    expect(await sourceNegatives('track jacket')).toEqual([])
  })

  it('judge: past the window + 72 h with 0 orders in the clicks that make it a 95 % call — WORSE, the undo asked of a person; approved, the keyword paused and the source negatives retired', async () => {
    const landed = new Date(NOW.getTime() - 20 * DAY)
    await inW(() => database.client.adsBrainHarvest.updateMany({ where: { productId: JACKET, term: 'touring jacket' }, data: { landedAt: landed, judgeAfter: new Date(landed.getTime() + 10 * DAY) } }))
    await inW(() => database.client.amazonAdsSearchTerm.createMany({ data: [st('jk-exact', 'touring jacket', 900, 0, 9000, 0, '2026-09-25')] }))
    const run = await inW(() => runHarvestOnce({ now: new Date(NOW.getTime() + 120_000) }))
    expect(run.pending).toMatchObject({ judged: expect.any(Number), undoProposed: 1 })
    const t = (await harvests())['touring jacket']
    expect(t).toMatchObject({ status: 'UNDO_PROPOSED', verdict: 'WORSE' })
    expect(t.judgement.why).toMatch(/stopped converting/)
    const undo = (await approvals('apply-brain-harvest')).find((a) => a.args.op === 'undo')!
    expect(undo).toMatchObject({ status: 'pending', id: t.undoApprovalId, args: { harvestId: t.id } })
    expect(await approve(undo)).toMatchObject({ ok: true, data: { paused: true, retired: 2 } })
    expect((await harvests())['touring jacket']).toMatchObject({ status: 'UNDONE' })
    expect(await rows('SELECT status FROM "AdTarget" WHERE id = $1', [t.keywordTargetId])).toEqual([{ status: 'PAUSED' }])
  })

  it('read: the harvest view — each harvest with its destination, sources, request and judgement; every amount hidden without the ad-spend permission; another business nothing', async () => {
    const out = await inW(() => ADS_BRAIN_TOOLS[0].handler!({ view: 'harvest', market: 'IT', productId: JACKET_M }, {} as never)) as { ok: boolean; data: Data }
    expect(out.ok).toBe(true)
    const d = out.data
    expect(d.scope).toEqual({ productId: JACKET, market: 'IT' })
    expect(d.source.kind).toBe('stored')
    expect(d.product.levers.harvest.effective).toBe('AUTO')
    expect(d.counts).toMatchObject({ UNDONE: 1, DONE: 1, REFUSED: 1 })
    expect(d.harvests.find((x: Data) => x.term === 'sport jacket')).toMatchObject({ status: 'DONE', destination: { kind: 'EXISTING', how: 'own', adGroupId: G('jk-exact') }, money: { bidCents: expect.any(Number) } })
    // Harvest fix B11 — every stored row names the harvestId apply-brain-harvest takes.
    const stored = await harvests()
    expect(d.harvests.find((x: Data) => x.term === 'sport jacket').harvestId).toBe(stored['sport jacket'].id)
    expect(d.harvests.every((x: Data) => typeof x.harvestId === 'string')).toBe(true)
    expect(d.gaps.waitingToJudge.map((x: Data) => x.term)).toEqual(['sport jacket'])
    const market = await inW(() => ADS_BRAIN_TOOLS[0].handler!({ view: 'harvest', market: 'IT' }, {} as never)) as { data: Data }
    expect(market.data.products.map((p: Data) => p.productId).sort()).toEqual([JACKET, GLOVE].sort())
    const principal = (perms: string[]) => ({ kind: 'user' as const, userId: 'u', label: 'u', via: 'claude' as const, workspace: scope(W), permissions: { isOwner: false, permissions: new Set<string>(perms) } })
    const everything = [...Object.values(FEATURES), ...Object.values(FIELDS)]
    const partial = visibleTo(principal(everything.filter((p) => !p.startsWith('financials.'))) as never, ADS_BRAIN_TOOLS[0], d)
    const text = JSON.stringify(partial)
    expect(text).not.toContain('"money":')
    expect(text).toBe(JSON.stringify(d, (k, v) => (k === 'money' ? undefined : v)))
    expect(await inW2(() => runHarvestOnce({ now: NOW }))).toMatchObject({ ran: false })
    const other = await inW2(() => ADS_BRAIN_TOOLS[0].handler!({ view: 'harvest', market: 'IT' }, {} as never)) as { data: Data }
    expect(other.data.products).toEqual([])
  })
})

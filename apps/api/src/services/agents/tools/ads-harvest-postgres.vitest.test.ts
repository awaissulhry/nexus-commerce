/**
 * Keyword Harvest page rebuild (lane HMCP) — Claude's harvest tools on the ONE harvest engine, on a real PostgreSQL (the
 * throwaway PostgreSQL 17 of scripts/run-real-postgres-tests.mjs: row-level policies on, business profiles ON), the ads
 * mode LIVE with Amazon's create calls stubbed at the client (nothing leaves the process) and the job queue a stub.
 * A jacket in IT with an automatic, a phrase, a broad and an exact campaign; a glove with an automatic campaign only.
 *
 *   reads       harvest-candidates (the page's rows, idsOnly), harvest-destinations (the suggested place), on the engine
 *   alias       harvest-search-term by where the term ran: the SAME change set as apply-harvest (same planHash, same
 *               steps); run as the approver — the keyword, both sources and the funnel block, one record (CLAUDE);
 *               its undo asks apply-harvest op undo, which lifts the blocks and pauses the keyword
 *   graduate    graduate-keyword by Amazon's ids: the same change set, the card the fleet reads; a campaign of no
 *               product is refused by name
 *   skip        skip-harvest-terms: previewed, run, the term SKIPPED; an already skipped term is left; undo = unskip
 *   history     harvest-history: every harvest with its actor, filtered by actor
 *   legacy      a harvest-search-term change made before the engine is put back the engine's way (its negative
 *               retired, its keyword paused) through harvest-search-term op undo
 *   round 2     the Sources view (read, pause / resume, assign / detach with their undos) and the Rules view (list with
 *               the brain first, preview, history, archive and its undo)
 *   business    another business sees no candidate
 *
 * Every value is made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
const amz = vi.hoisted(() => ({ keywords: [] as Array<Record<string, unknown>>, negatives: [] as Array<Record<string, unknown>>, n: 0 }))
vi.mock('../../advertising/ads-api-client.js', async (original) => ({
  ...(await original<object>()),
  createKeyword: vi.fn(async (_ctx: unknown, input: Record<string, unknown>) => { amz.keywords.push(input); return { ok: true, mode: 'live', externalId: `AMZ-K-${++amz.n}`, rawResponse: {}, error: null } }),
  createNegativeKeyword: vi.fn(async (_ctx: unknown, input: Record<string, unknown>) => { amz.negatives.push(input); return { ok: true, mode: 'live', externalId: `AMZ-N-${++amz.n}`, rawResponse: {} } }),
  listNegativeKeywords: vi.fn(async () => []),
}))

const { ADS_HARVEST_TOOLS, SKIP_UNDO } = await import('./ads-harvest.tools.js')
const { ADS_HARVEST_RULE_TOOLS, RULES_UNDO, SOURCES_UNDO } = await import('./ads-harvest-rules.tools.js')
const { ADS_TARGET_TOOLS, HARVEST_UNDO } = await import('./ads-targets.tools.js')
const { ADS_PROPOSE_TOOLS } = await import('./ads-propose.tools.js')
const { applyHarvestTool } = await import('../../advertising/harvest/tool.js')
const { previewChangeSet } = await import('../../advertising/harvest/preview.js')
const { setAutonomy } = await import('../../advertising/ads-automation-state.service.js')
const { requestApproval, decideApproval } = await import('../approval-gate.service.js')
const { commitScheduledApproval, decideFleetApproval, expirePreEngineHarvestRequests, PRE_ENGINE_HARVEST_REASON, PRE_ENGINE_UNDO_REASON } = await import('../../agent-fleet/approval-inbox.service.js')
const { FEATURES, FIELDS } = await import('@nexus/shared/permissions')

const tool = (name: string) => [...ADS_HARVEST_TOOLS, ...ADS_HARVEST_RULE_TOOLS, ...ADS_TARGET_TOOLS, ...ADS_PROPOSE_TOOLS].find((t) => t.name === name)!

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `hv_mcp_${hex}`
const W2 = `hv_mcp_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const id = (s: string) => `${hex}-${s}`
const C = (s: string) => id(`c-${s}`)
const G = (s: string) => `g-${C(s)}`
const JACKET = id('jacket'), JACKET_M = id('jacket-m'), GLOVE = id('glove'), GLOVE_L = id('glove-l')
const PF = `pf-${hex}`
const DAY = 86_400_000
const dayOf = (daysAgo: number) => { const d = new Date(Date.now() - daysAgo * DAY); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) }
const cid = (productId: string, term: string) => `IT|${productId}|${term}`

const st = (campaign: string, query: string, clicks: number, orders: number, spendCents: number, salesCents: number, daysAgo = 15) => ({
  profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: dayOf(daysAgo), campaignId: `EXT-${C(campaign)}`, adGroupId: `EXT-${G(campaign)}`,
  query, impressions: clicks * 7, clicks, costMicros: BigInt(spendCents) * 10_000n, currencyCode: 'EUR', sales7dCents: salesCents, orders7d: orders,
})

async function seed() {
  const db = database.client
  await seedAdsFixture(db)
  const product = (pid: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: pid, sku, name: sku, basePrice: '80.00', totalStock: 5, ...extra } })
  await product(JACKET, `HM-JACKET-${hex}`, { isParent: true, name: 'Jacket' })
  await product(JACKET_M, `HM-JACKET-M-${hex}`, { parentId: JACKET, amazonAsin: `B0HMJK0M${H}` })
  await product(GLOVE, `HM-GLOVE-${hex}`, { isParent: true, name: 'Glove', basePrice: '30.00' })
  await product(GLOVE_L, `HM-GLOVE-L-${hex}`, { parentId: GLOVE, amazonAsin: `B0HMGL0L${H}`, basePrice: '30.00' })
  await db.amazonAdsPortfolio.create({ data: { profileId: 'P-IT-TEST', externalPortfolioId: PF, name: `Jacket IT ${hex}` } })
  const campaign = async (key: string, groupName: string, ads: Array<[string, string, string]>, extra: Record<string, unknown> = {}) => {
    await db.campaign.create({ data: { id: C(key), name: `${key} ${hex}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${C(key)}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra } })
    await db.adGroup.create({ data: { id: G(key), campaignId: C(key), name: groupName, externalAdGroupId: `EXT-${G(key)}` } })
    for (const ad of ads) await db.adProductAd.create({ data: { adGroupId: G(key), productId: ad[0], asin: ad[1], sku: ad[2] } })
  }
  const target = (key: string, tid: string, text: string, expressionType: string, bidCents: number, extra: Record<string, unknown> = {}) =>
    db.adTarget.create({ data: { id: id(tid), adGroupId: G(key), kind: 'KEYWORD', expressionType, expressionValue: text, bidCents, externalTargetId: `EXT-${id(tid)}`, ...extra } })
  const jacket: [string, string, string] = [JACKET_M, `B0HMJK0M${H}`, `HM-JACKET-M-${hex}`]
  const glove: [string, string, string] = [GLOVE_L, `B0HMGL0L${H}`, `HM-GLOVE-L-${hex}`]
  await campaign('jk-auto', 'Auto', [jacket], { targetingType: 'AUTO', portfolioId: PF })
  await campaign('jk-phrase', 'Phrase', [jacket], { targetingType: 'MANUAL', portfolioId: PF })
  await campaign('jk-broad', 'Broad', [jacket], { targetingType: 'MANUAL', portfolioId: PF })
  await campaign('jk-exact', 'Exact', [jacket], { targetingType: 'MANUAL', portfolioId: PF })
  await campaign('gl-auto', 'Auto', [glove], { targetingType: 'AUTO' })
  // A campaign that advertises both products: no product's (shared).
  await campaign('shared', 'Mixed', [jacket, glove], { targetingType: 'AUTO' })
  await target('jk-phrase', 't-phrase', 'jacket', 'PHRASE', 40)
  await target('jk-broad', 't-broad', 'motorbike jacket', 'BROAD', 40)
  await target('jk-exact', 't-racing', 'racing jacket', 'EXACT', 60)
  // An older harvest (before the engine): its exact keyword and its source negative.
  await target('jk-exact', 't-old-kw', 'rain jacket', 'EXACT', 50)
  await target('jk-auto', 't-old-neg', 'rain jacket', 'NEGATIVE_EXACT', 0, { isNegative: true, negativeLevel: 'AD_GROUP' })
  await db.amazonAdsSearchTerm.createMany({
    data: [
      st('jk-auto', 'touring jacket', 120, 4, 2400, 32_000),
      st('jk-phrase', 'touring jacket', 30, 1, 600, 8000),
      st('jk-auto', 'summer jacket', 100, 3, 2000, 24_000),
      st('jk-auto', 'city jacket', 100, 3, 2000, 24_000),
      st('jk-auto', 'storm jacket', 100, 3, 2000, 24_000),
      st('jk-exact', 'racing jacket', 600, 18, 12_000, 144_000),
      st('gl-auto', 'glove liner', 100, 3, 1000, 9000),
      st('shared', 'mixed term', 100, 3, 1000, 9000),
    ],
  })
  await db.adsStrategy.create({ data: { channel: 'AMAZON', market: 'IT', level: 'MARKET', scopeId: '*', label: 'IT', targetKind: 'ACOS', targetPct: 25, targetHiPct: 30, updatedBy: 'user:owner' } })
  await db.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon Italy', region: 'EU', currency: 'EUR', language: 'it' } })
  await db.adSpendCeiling.create({ data: { grain: 'MARKET', scopeId: 'IT', label: 'IT', dailyCapCents: 10_000 } })
  // A builder harvest rule (round 2: the Rules and Sources views), reading no ad group yet.
  await db.automationRule.create({ data: { id: id('rule-builder'), domain: 'advertising', name: `Harvest builder ${hex}`, trigger: 'SCHEDULE', enabled: false, dryRun: true, actions: [{ type: 'keyword-harvesting', mappings: [{ groups: [] }] }], conditions: [{ match: 'all', conditions: [{ metric: 'Orders', op: 'gte', value: '2' }] }] } as never })
  // The older harvest's request and its recorded change (harvest-search-term, before the engine).
  const run = await db.agentRun.create({ data: { agentKey: 'claude', trigger: 'manual' } })
  const ap = await db.agentApproval.create({ data: { id: id('ap-old'), agentRunId: run.id, toolName: 'harvest-search-term', riskTier: 'high', args: {}, status: 'executed' } })
  await db.agentChange.create({
    data: {
      approvalId: ap.id, toolName: 'harvest-search-term', via: 'claude', reversibility: 'partial',
      before: { changeSetId: ap.id, op: 'harvest', keyword: null, negative: null },
      after: { op: 'harvest', keyword: { targetId: id('t-old-kw'), bidCents: 50 }, negative: { targetId: id('t-old-neg'), standing: true } },
    },
  })
}

const askCtx = { userId: 'owner', via: 'claude', can: () => true } as never
const approvedCtx = (preview: unknown, approvalId: string) => ({ userId: 'owner', approvalId, approvedPreview: preview, approvedByPerson: true, via: 'claude', decidedVia: 'nexus', can: () => true }) as never
const rows = async (args: Record<string, unknown> = {}) => {
  const got = await inW(() => tool('harvest-candidates').handler({ market: 'IT', ...args }, askCtx))
  if (!got.ok) throw new Error(got.error)
  return (got.data as { rows: Array<Record<string, unknown> & { term: string }> }).rows
}
const rowOf = async (term: string, state?: string) => (await rows(state ? { state: [state] } : {})).find((r) => r.term === term) ?? null

describe.skipIf(!concurrentDatabaseUrl())('HMCP — Claude\'s harvest tools on the one harvest engine (real PostgreSQL)', { timeout: 240_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(async () => { await seed(); await setAutonomy('AUTO', 'test') })
  }, 240_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('reads: harvest-candidates lists the page\'s rows (and every id that matches); harvest-destinations the suggested place', async () => {
    expect(await rowOf('touring jacket')).toMatchObject({ id: cid(JACKET, 'touring jacket'), state: 'READY', destination: { kind: 'existing', adGroup: { id: G('jk-exact') } } })
    expect(await rowOf('glove liner')).toMatchObject({ state: 'NEEDS_CAMPAIGN' })
    const ids = await inW(() => tool('harvest-candidates').handler({ market: 'IT', idsOnly: true }, askCtx))
    expect(ids).toMatchObject({ ok: true, data: { ids: expect.arrayContaining([cid(JACKET, 'touring jacket'), cid(GLOVE, 'glove liner')]) } })
    // L5 — ids a page at a time.
    expect(await inW(() => tool('harvest-candidates').handler({ market: 'IT', idsOnly: true, pageSize: 1 }, askCtx))).toMatchObject({ ok: true, data: { ids: [expect.any(String)], page: 1, pageSize: 1, nextPage: 2 } })
    const paged = await inW(() => tool('harvest-candidates').handler({ market: 'IT', pageSize: 1, sort: 'term' }, askCtx))
    expect(paged).toMatchObject({ ok: true, data: { pageSize: 1, nextPage: 2, rows: [expect.anything()] } })
    const dest = await inW(() => tool('harvest-destinations').handler({ candidateId: cid(JACKET, 'touring jacket') }, askCtx))
    expect(dest).toMatchObject({ ok: true, data: { suggested: { kind: 'existing', adGroupId: G('jk-exact') } } })
    expect(await inW(() => tool('harvest-destinations').handler({}, askCtx))).toMatchObject({ ok: false, error: expect.stringMatching(/candidateId/) })
  })

  it('harvest-search-term asks for the same change set as apply-harvest, runs it as the approver, and its undo is the engine\'s', async () => {
    const who = { actor: 'user:owner', manual: true, confirmOwnLimits: true, changeSetId: null, reason: 'preview' }
    const engine = await inW(() => previewChangeSet({ items: [{ candidateId: cid(JACKET, 'touring jacket') }] }, { actor: 'CLAUDE', who }))
    if ('error' in engine) throw new Error(engine.error)
    const args = { query: 'Touring  Jacket', sourceAdGroupId: G('jk-auto') }
    const asked = await inW(() => tool('harvest-search-term').handler(args, askCtx))
    expect(asked).toMatchObject({
      ok: true,
      preview: { action: 'harvest-search-term', engine: 'apply-harvest', planHash: engine.data.planHash, basis: engine.data.planHash, totals: { keywords: 1, sourceNegatives: 2, funnelNegatives: 1 }, asked: { candidateId: cid(JACKET, 'touring jacket') } },
    })
    expect((asked.preview as { steps: unknown[] }).steps).toEqual(engine.data.steps)
    const ran = await inW(() => tool('harvest-search-term').execute!(args, approvedCtx(asked.preview, id('ap-hst'))))
    expect(ran).toMatchObject({ ok: true, data: { harvested: 1 }, change: { after: { op: 'harvest', harvestIds: [expect.any(String)] } } })
    expect(amz.keywords).toEqual([expect.objectContaining({ keywordText: 'touring jacket', matchType: 'EXACT', externalAdGroupId: `EXT-${G('jk-exact')}` })])
    expect(amz.negatives.map((n) => n.externalAdGroupId).sort()).toEqual([`EXT-${G('jk-auto')}`, `EXT-${G('jk-broad')}`, `EXT-${G('jk-phrase')}`].sort())
    const rec = await inW(() => database.client.adsBrainHarvest.findFirst({ where: { productId: JACKET, term: 'touring jacket' } }))
    expect(rec).toMatchObject({ actorKind: 'CLAUDE', actorId: 'owner', changeSetId: id('ap-hst'), status: 'DONE' })
    // Its undo asks the engine's request: apply-harvest op undo of its harvests.
    const undo = HARVEST_UNDO.request(ran.change!)
    expect(undo).toEqual({ tool: 'apply-harvest', args: expect.objectContaining({ op: 'undo', harvestIds: [rec!.id] }) })
    expect(await inW(() => HARVEST_UNDO.current(ran.change!))).toEqual(ran.change!.after)
    const undoArgs = (undo as { args: Record<string, unknown> }).args
    const undoAsked = await inW(() => applyHarvestTool.handler(undoArgs, askCtx))
    const undone = await inW(() => applyHarvestTool.execute!(undoArgs, approvedCtx(undoAsked.preview, id('ap-hst-undo'))))
    expect(undone).toMatchObject({ ok: true, data: { op: 'undo', results: [{ paused: true, lifted: 3, complete: true }] } })
    expect(await inW(() => database.client.adsBrainHarvest.findUnique({ where: { id: rec!.id } }))).toMatchObject({ status: 'UNDONE' })
    // L3 — harvest-search-term's own op undo is for harvests made before the engine: an engine harvest is apply-harvest op undo.
    expect(await inW(() => tool('harvest-search-term').handler({ op: 'undo', changeSetId: id('ap-hst'), keywordId: rec!.keywordTargetId }, askCtx))).toMatchObject({ ok: false, error: expect.stringMatching(/apply-harvest op undo/) })
    expect(tool('harvest-search-term').input.shape).not.toHaveProperty('harvestIds')
  })

  it('graduate-keyword by Amazon\'s ids: the same change set, the card the fleet reads; a shared campaign is refused by name', async () => {
    const args = { query: 'summer jacket', sourceExternalCampaignId: `EXT-${C('jk-auto')}`, sourceExternalAdGroupId: `EXT-${G('jk-auto')}`, bidCents: 40 }
    const asked = await inW(() => tool('graduate-keyword').handler(args, askCtx))
    expect(asked).toMatchObject({
      ok: true,
      preview: {
        action: 'graduate-keyword', engine: 'apply-harvest', query: 'summer jacket', suggestedBidCents: 40, alreadyExact: false,
        destination: { id: C('jk-exact'), marketplace: 'IT' }, destinationAdGroup: { id: G('jk-exact') }, totals: { keywords: 1, sourceNegatives: 1, funnelNegatives: 2 },
      },
    })
    // Stored as the request it is, it shows on the page as WAITING (waiting.ts reads the engine preview it stored), and it
    // runs past its own wait.
    await inW(async () => {
      const r = await database.client.agentRun.create({ data: { agentKey: 'claude', trigger: 'manual' } })
      await database.client.agentApproval.create({ data: { id: id('ap-grad'), agentRunId: r.id, toolName: 'graduate-keyword', riskTier: 'high', args, preview: asked.preview as never, status: 'approved' } })
    })
    expect(await rowOf('summer jacket')).toMatchObject({ state: 'WAITING', waiting: { approvalId: id('ap-grad') } })
    const ran = await inW(() => tool('graduate-keyword').execute!(args, approvedCtx(asked.preview, id('ap-grad'))))
    expect(ran).toMatchObject({ ok: true, data: { harvested: 1 }, change: { after: { op: 'harvest', harvestIds: [expect.any(String)] } } })
    expect(amz.keywords.at(-1)).toMatchObject({ keywordText: 'summer jacket', matchType: 'EXACT', externalAdGroupId: `EXT-${G('jk-exact')}` })
    const shared = await inW(() => tool('graduate-keyword').handler({ query: 'mixed term', sourceExternalCampaignId: `EXT-${C('shared')}` }, askCtx))
    expect(shared).toMatchObject({ ok: false, error: expect.stringMatching(/advertises several products/) })
    const named = await inW(() => tool('harvest-search-term').handler({ candidateId: cid(GLOVE, 'glove liner') }, askCtx))
    expect(named).toMatchObject({ ok: false, error: expect.stringMatching(/Not queued/) })
  })

  it('skip-harvest-terms: previewed, run, the term SKIPPED; an already skipped term is left; undo shows it again', async () => {
    const args = { ids: [cid(JACKET, 'city jacket')], period: '30d' }
    const asked = await inW(() => tool('skip-harvest-terms').handler(args, askCtx))
    expect(asked).toMatchObject({ ok: true, preview: { op: 'skip', period: '30d', ids: [cid(JACKET, 'city jacket')], totals: { changing: 1 } } })
    expect(await inW(() => tool('skip-harvest-terms').handler({ ids: args.ids }, askCtx))).toMatchObject({ ok: false, error: expect.stringMatching(/period/) })
    const ran = await inW(() => tool('skip-harvest-terms').execute!(args, approvedCtx(asked.preview, id('ap-skip'))))
    expect(ran).toMatchObject({ ok: true, data: { changed: 1, forGood: false } })
    expect(await rowOf('city jacket')).toBeNull()
    expect(await rowOf('city jacket', 'SKIPPED')).toMatchObject({ state: 'SKIPPED' })
    expect(await inW(() => tool('skip-harvest-terms').handler(args, askCtx))).toMatchObject({ ok: false, error: expect.stringMatching(/already skipped/) })
    expect(await inW(() => SKIP_UNDO.current(ran.change!))).toEqual(ran.change!.after)
    const undo = SKIP_UNDO.request(ran.change!)
    expect(undo).toEqual({ tool: 'skip-harvest-terms', args: expect.objectContaining({ op: 'unskip', ids: [cid(JACKET, 'city jacket')] }) })
    const undoArgs = (undo as { args: Record<string, unknown> }).args
    const undoAsked = await inW(() => tool('skip-harvest-terms').handler(undoArgs, askCtx))
    expect(await inW(() => tool('skip-harvest-terms').execute!(undoArgs, approvedCtx(undoAsked.preview, id('ap-unskip'))))).toMatchObject({ ok: true, data: { changed: 1 } })
    expect(await rowOf('city jacket')).toMatchObject({ state: 'READY' })
  })

  it('harvest-history: every harvest with its actor, filtered by actor', async () => {
    const all = await inW(() => tool('harvest-history').handler({ market: 'IT' }, askCtx))
    expect(all).toMatchObject({ ok: true, data: { total: 2 } })
    expect((all.data as { rows: Array<{ term: string; by: { kind: string } }> }).rows.map((r) => [r.term, r.by.kind]).sort()).toEqual([['summer jacket', 'CLAUDE'], ['touring jacket', 'CLAUDE']])
    const person = await inW(() => tool('harvest-history').handler({ market: 'IT', actor: 'PERSON' }, askCtx))
    expect(person).toMatchObject({ ok: true, data: { total: 0 } })
  })

  it('a harvest made before the engine is put back the engine\'s way: its negative retired, then its keyword paused', async () => {
    const legacyChange = { before: { changeSetId: id('ap-old'), op: 'harvest', keyword: null, negative: null }, after: { op: 'harvest', keyword: { targetId: id('t-old-kw'), bidCents: 50 }, negative: { targetId: id('t-old-neg'), standing: true } } }
    const undo = HARVEST_UNDO.request(legacyChange)
    expect(undo).toEqual({ tool: 'harvest-search-term', args: expect.objectContaining({ op: 'undo', changeSetId: id('ap-old'), keywordId: id('t-old-kw'), negativeId: id('t-old-neg') }) })
    const undoArgs = (undo as { args: Record<string, unknown> }).args
    const asked = await inW(() => tool('harvest-search-term').handler(undoArgs, askCtx))
    expect(asked).toMatchObject({ ok: true, preview: { op: 'undo', legacy: true, changes: [{ fromLabel: 'Standing', toLabel: 'Retired' }, { fromLabel: 'Enabled', toLabel: 'Paused' }] } })
    const ran = await inW(() => tool('harvest-search-term').execute!(undoArgs, approvedCtx(asked.preview, id('ap-old-undo'))))
    expect(ran).toMatchObject({ ok: true, data: { paused: true, lifted: 1 } })
    const targets = await inW(() => database.client.adTarget.findMany({ where: { id: { in: [id('t-old-kw'), id('t-old-neg')] } }, select: { id: true, status: true } }))
    expect(Object.fromEntries(targets.map((t) => [t.id, String(t.status)]))).toEqual({ [id('t-old-kw')]: 'PAUSED', [id('t-old-neg')]: 'ARCHIVED' })
    expect(await inW(() => tool('harvest-search-term').handler(undoArgs, askCtx))).toMatchObject({ ok: false, error: expect.stringMatching(/undone already/) })
  })

  it('L8 — harvest-search-term through the real approval gate: stored, approved by a person, run as the engine\'s change set', async () => {
    const person = { kind: 'user' as const, userId: 'owner', label: 'Owner', via: 'app' as const, workspace: scope(W), permissions: { isOwner: false, permissions: new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)]) } }
    const asked = await inW(() => requestApproval('harvest-search-term', { query: 'city jacket', sourceAdGroupId: G('jk-auto') }, person as never))
    expect(asked).toMatchObject({ ok: true, mode: 'queued', approvalId: expect.any(String) })
    expect(await rowOf('city jacket')).toMatchObject({ state: 'WAITING', waiting: { approvalId: asked.approvalId } })
    const ran = await inW(() => decideApproval(asked.approvalId!, 'approve', person as never))
    expect(ran).toMatchObject({ ok: true, status: 'executed', result: { harvested: 1 } })
    expect(await inW(() => database.client.adsBrainHarvest.findFirst({ where: { productId: JACKET, term: 'city jacket' } }))).toMatchObject({ changeSetId: asked.approvalId, status: 'DONE' })
  })

  it('a harvest-search-term request through the sweep\'s commit: the staleness re-check (a fresh dry run as the system) passes, and it runs as the approver', async () => {
    const PERMS = [...Object.values(FEATURES), ...Object.values(FIELDS)]
    const approver = await inW(async () => {
      const db = database.client
      const role = await db.role.create({ data: { key: `HMCP_${hex}`, name: 'Test approver', description: 'test', isSystem: false, permissions: PERMS } })
      const user = await db.userProfile.create({ data: { email: `hmcp-${hex}@example.test`, status: 'active', displayName: 'Test approver' } })
      await db.userRole.create({ data: { userId: user.id, roleId: role.id } })
      const membership = await db.workspaceMembership.create({ data: { workspaceId: W, userId: user.id, status: 'active' } })
      await db.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
      return { kind: 'user' as const, userId: user.id, label: 'Test approver', via: 'app' as const, workspace: scope(W), permissions: { isOwner: false, permissions: new Set<string>(PERMS) } }
    })
    const asked = await inW(() => requestApproval('harvest-search-term', { query: 'storm jacket', sourceAdGroupId: G('jk-auto') }, approver as never))
    expect(asked).toMatchObject({ ok: true, mode: 'queued' })
    expect(await inW(() => decideFleetApproval({ id: asked.approvalId!, decision: 'approve', actor: approver as never }))).toMatchObject({ ok: true, status: 'scheduled' })
    await inW(() => database.client.agentApproval.update({ where: { id: asked.approvalId! }, data: { executeAfter: new Date(Date.now() - 1000) } }))
    const committed = await inW(() => commitScheduledApproval(asked.approvalId!))
    expect(committed, JSON.stringify(committed)).toMatchObject({ ok: true })
    expect(await inW(() => database.client.agentApproval.findUnique({ where: { id: asked.approvalId! } }))).toMatchObject({ status: 'executed' })
    expect(await inW(() => database.client.adsBrainHarvest.findFirst({ where: { productId: JACKET, term: 'storm jacket' } }))).toMatchObject({ changeSetId: asked.approvalId, status: 'DONE', actorId: approver.userId })
  })

  it('L1 — a harvest asked before the engine is closed once, with its reason, never handed back on a new clock', async () => {
    const old = { action: 'harvest-search-term', op: 'harvest', query: 'old term', basis: 'old-basis', reach: { reach: 'sandbox' } }
    const fixed = new Date(Date.now() + 5 * 3600_000)
    const row = (key: string, status: string, preview: unknown, extra: Record<string, unknown> = {}) => inW(async () => {
      const r = await database.client.agentRun.create({ data: { agentKey: 'claude', trigger: 'manual' } })
      return database.client.agentApproval.create({ data: { id: id(key), agentRunId: r.id, toolName: 'harvest-search-term', riskTier: 'high', args: { query: 'old term', sourceAdGroupId: G('jk-auto') }, preview: preview as never, status, expiresAt: fixed, ...extra } as never })
    })
    // Approved by a person before the sweep: its commit closes it.
    await row('ap-old-scheduled', 'scheduled', old, { executeAfter: new Date(Date.now() - 60_000), decidedBy: 'Owner', decisionVia: 'nexus' })
    expect(await inW(() => commitScheduledApproval(id('ap-old-scheduled')))).toEqual({ ok: false, error: PRE_ENGINE_HARVEST_REASON })
    expect(await inW(() => database.client.agentApproval.findUnique({ where: { id: id('ap-old-scheduled') } }))).toMatchObject({ status: 'expired', reason: PRE_ENGINE_HARVEST_REASON, expiresAt: fixed, executeAfter: null, decidedBy: null, decisionVia: null })
    // A control-history row says it was closed, and who had approved it.
    const audit = await inW(() => database.client.agentControlAudit.findMany({ where: { action: 'stale_refused' } }))
    expect(audit.find((r) => JSON.stringify(r.toValue).includes(id('ap-old-scheduled')))).toMatchObject({ actor: 'Owner', note: PRE_ENGINE_HARVEST_REASON })
    // An undo asked before the engine is asked again as an undo.
    await row('ap-old-undo', 'scheduled', { action: 'harvest-search-term', op: 'undo', basis: 'old-undo', reach: { reach: 'sandbox' } }, { args: { op: 'undo', changeSetId: id('ap-old'), keywordId: id('t-old-kw') }, executeAfter: new Date(Date.now() - 60_000), decidedBy: 'Owner', decisionVia: 'nexus' })
    expect(await inW(() => commitScheduledApproval(id('ap-old-undo')))).toEqual({ ok: false, error: PRE_ENGINE_UNDO_REASON })
    // Still waiting: the sweep closes it; a request of today's engine waits on.
    await row('ap-old-pending', 'pending', old)
    await row('ap-new-pending', 'pending', { ...old, engine: 'apply-harvest' })
    expect(await inW(() => expirePreEngineHarvestRequests())).toBe(1)
    expect((await inW(() => database.client.agentControlAudit.findMany({ where: { action: 'stale_refused', actor: 'system:approval-sweep' } }))).some((r) => JSON.stringify(r.toValue).includes(id('ap-old-pending')))).toBe(true)
    const after = await inW(() => database.client.agentApproval.findMany({ where: { id: { in: [id('ap-old-pending'), id('ap-new-pending')] } }, select: { id: true, status: true, reason: true } }))
    expect(Object.fromEntries(after.map((a) => [a.id, a.status]))).toEqual({ [id('ap-old-pending')]: 'expired', [id('ap-new-pending')]: 'pending' })
    await inW(() => database.client.agentApproval.update({ where: { id: id('ap-new-pending') }, data: { status: 'rejected' } }))
    // Run anyway (an approved preview that is not the engine's): refused, nothing planned.
    expect(await inW(() => tool('harvest-search-term').execute!({ query: 'old term', sourceAdGroupId: G('jk-auto') }, approvedCtx(old, id('ap-old-run'))))).toMatchObject({ ok: false, error: expect.stringMatching(/before the harvest engine/) })
  })

  it('round 2 — the Sources view: read; pause and assign as one person\'s request each, each undone by the opposite op', async () => {
    const run = async (name: string, args: Record<string, unknown>, ap: string) => {
      const asked = await inW(() => tool(name).handler(args, askCtx))
      expect(asked.ok, asked.error).toBe(true)
      return inW(() => tool(name).execute!(args, approvedCtx(asked.preview, id(ap))))
    }
    const source = async () => {
      const got = await inW(() => tool('harvest-sources').handler({ market: 'IT' }, askCtx))
      return (got.data as { rows: Array<{ id: string; rules: Array<{ id: string }>; paused: unknown }> }).rows.find((r) => r.id === G('jk-auto'))!
    }
    expect(await source()).toMatchObject({ id: G('jk-auto'), paused: null })
    expect(await inW(() => tool('harvest-sources').handler({ market: 'IT', pageSize: 1 }, askCtx))).toMatchObject({ ok: true, data: { rows: [expect.anything()], pageSize: 1, nextPage: 2 } })
    const paused = await run('set-harvest-sources', { op: 'pause', market: 'IT', adGroupIds: [G('jk-auto')], reason: 'a test pause' }, 'ap-src-pause')
    expect(paused).toMatchObject({ ok: true, change: { after: { op: 'pause', ids: [G('jk-auto')], state: { [G('jk-auto')]: { paused: true } } } } })
    expect((await source()).paused).not.toBeNull()
    expect(await inW(() => tool('set-harvest-sources').handler({ op: 'pause', market: 'IT', adGroupIds: [G('jk-auto')] }, askCtx))).toMatchObject({ ok: false, error: expect.stringMatching(/paused already/) })
    expect(await inW(() => SOURCES_UNDO.current(paused.change!))).toEqual(paused.change!.after)
    const resume = SOURCES_UNDO.request(paused.change!) as { tool: string; args: Record<string, unknown> }
    expect(resume).toMatchObject({ tool: 'set-harvest-sources', args: { op: 'resume', adGroupIds: [G('jk-auto')] } })
    expect(await run('set-harvest-sources', resume.args, 'ap-src-resume')).toMatchObject({ ok: true })
    expect((await source()).paused).toBeNull()
    expect(await inW(() => tool('set-harvest-sources').handler({ op: 'assign', market: 'IT', adGroupIds: [G('jk-auto')] }, askCtx))).toMatchObject({ ok: false, error: expect.stringMatching(/^ruleId/) })
    const assigned = await run('set-harvest-sources', { op: 'assign', market: 'IT', adGroupIds: [G('jk-auto')], ruleId: id('rule-builder') }, 'ap-src-assign')
    expect(assigned).toMatchObject({ ok: true })
    expect((await source()).rules.map((r) => r.id)).toContain(id('rule-builder'))
    const detach = SOURCES_UNDO.request(assigned.change!) as { tool: string; args: Record<string, unknown> }
    expect(detach).toMatchObject({ args: { op: 'detach', ruleId: id('rule-builder'), adGroupIds: [G('jk-auto')] } })
    expect(await run('set-harvest-sources', detach.args, 'ap-src-detach')).toMatchObject({ ok: true })
    expect((await source()).rules.map((r) => r.id)).not.toContain(id('rule-builder'))
  })

  it('round 2 — the Rules view: list (the brain first), a preview and a history; archive and its undo', async () => {
    const list = await inW(() => tool('harvest-rules').handler({ view: 'list' }, askCtx))
    const rules = (list.data as { rules: Array<{ id: string; archived: boolean }> }).rules
    expect(rules[0].id).toBe('brain')
    expect(rules.find((r) => r.id === id('rule-builder'))).toMatchObject({ archived: false })
    expect(await inW(() => tool('harvest-rules').handler({ view: 'preview', ruleId: id('rule-builder') }, askCtx))).toMatchObject({ ok: true, data: { wouldHarvest: expect.any(Number) } })
    expect(await inW(() => tool('harvest-rules').handler({ view: 'history', id: id('rule-builder') }, askCtx))).toMatchObject({ ok: true, data: { harvests: [] } })
    const set = async (args: Record<string, unknown>, ap: string) => {
      const asked = await inW(() => tool('set-harvest-rules').handler(args, askCtx))
      expect(asked.ok, asked.error).toBe(true)
      return { asked, ran: await inW(() => tool('set-harvest-rules').execute!(args, approvedCtx(asked.preview, id(ap)))) }
    }
    const control = async () => ((await inW(() => database.client.automationRule.findUnique({ where: { id: id('rule-builder') }, select: { actions: true } })))!.actions as Array<{ control?: string }>)[0].control
    // M1 — the Rules view's own mode service: Watch sets the builder rule's Automate setting with the level (it watches,
    // never asks); Ask me sets Manual. Its undo puts the mode it had back.
    const watch = await set({ op: 'mode', ids: [id('rule-builder'), 'brain'], mode: 'WATCH' }, 'ap-mode-watch')
    expect(watch.asked.preview).toMatchObject({ rules: [{ id: id('rule-builder'), mode: 'WATCH' }], left: [{ id: 'brain' }] })
    expect(watch.ran, JSON.stringify(watch.ran)).toMatchObject({ ok: true, change: { before: { rules: [{ id: id('rule-builder'), mode: 'OFF' }] }, after: { rules: [{ id: id('rule-builder'), mode: 'WATCH' }] } } })
    expect(await control()).toBe('automate')
    const ask = await set({ op: 'mode', ids: [id('rule-builder')], mode: 'ASK' }, 'ap-mode-ask')
    expect(ask.ran).toMatchObject({ ok: true })
    expect(await control()).toBe('manual')
    expect(await inW(() => RULES_UNDO.current(ask.ran.change!))).toEqual(ask.ran.change!.after)
    const back = RULES_UNDO.request(ask.ran.change!) as { tool: string; args: Record<string, unknown> }
    expect(back).toMatchObject({ tool: 'set-harvest-rules', args: { op: 'mode', rules: [{ id: id('rule-builder'), mode: 'WATCH' }] } })
    expect((await set(back.args, 'ap-mode-back')).ran).toMatchObject({ ok: true })
    expect(await control()).toBe('automate')
    // Archive, and its undo.
    const archived = await set({ op: 'archive', ids: [id('rule-builder')] }, 'ap-archive')
    expect(archived.ran).toMatchObject({ ok: true, change: { after: { rules: [{ id: id('rule-builder'), archived: true }] } } })
    expect(await inW(() => tool('set-harvest-rules').handler({ op: 'mode', ids: [id('rule-builder')], mode: 'WATCH' }, askCtx))).toMatchObject({ ok: false, error: expect.stringMatching(/archived: unarchive it first/) })
    const unarchive = RULES_UNDO.request(archived.ran.change!) as { tool: string; args: Record<string, unknown> }
    expect(unarchive).toMatchObject({ tool: 'set-harvest-rules', args: { op: 'unarchive', ids: [id('rule-builder')] } })
    expect((await set(unarchive.args, 'ap-unarchive')).ran).toMatchObject({ ok: true })
    // L4 — a Nexus-only change runs only as an approved request, and only on the preview it was approved on.
    const a2 = { op: 'mode', ids: [id('rule-builder')], mode: 'ASK' }
    const p2 = await inW(() => tool('set-harvest-rules').handler(a2, askCtx))
    expect(await inW(() => tool('set-harvest-rules').execute!(a2, { userId: 'owner', via: 'claude', can: () => true } as never))).toMatchObject({ ok: false, error: expect.stringMatching(/moved since/) })
    expect(await inW(() => tool('set-harvest-rules').execute!(a2, { userId: 'owner', via: 'claude', approvedPreview: p2.preview, can: () => true } as never))).toMatchObject({ ok: false, error: expect.stringMatching(/approved request/) })
  })

  it('another business sees no candidate', async () => {
    const got = await inW2(() => tool('harvest-candidates').handler({ market: 'IT', state: ['all'] }, askCtx))
    expect(got).toMatchObject({ ok: true, data: { rows: [] } })
  })
})

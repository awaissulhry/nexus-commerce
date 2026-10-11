/**
 * HARVEST ENGINE on a real PostgreSQL (the throwaway PostgreSQL 17 of scripts/run-real-postgres-tests.mjs: row-level
 * policies on, the app as the restricted runtime login, business profiles ON), the ads mode LIVE with Amazon's create calls
 * stubbed at the client (nothing leaves the process) and the job queue a stub. A jacket in IT: an automatic, a phrase, a
 * broad and an exact campaign in its portfolio; a glove with an automatic campaign only. Nothing is enrolled in the brain.
 *
 *   candidates  one row per term × product: the jacket's touring term READY into its exact ad group, both sources blocked
 *               exact, the broad ad group's funnel block, the goal bid; a term whose exact ad group holds a negative of it
 *               NEEDS_DESTINATION (B10); the glove's term NEEDS_CAMPAIGN with its funnel campaign's name and the product's
 *               portfolio; the term the product already has AT_HOME only when asked; the bar is the brain's test
 *   skip        hidden for 7 days (SKIPPED when asked), back with unskip
 *   change set  the preview's steps and planHash; the apply-harvest request run as the approving person: the keyword, its
 *               two source blocks and its funnel block through the real write gate, one record (PERSON, the change set,
 *               DONE, judged after window + 72 h); a moved plan is refused; the candidate is HARVESTED, history lists it
 *   judge       past its window with 0 orders in the clicks that make it a 95 % call: worse
 *   undo        the apply-harvest undo: its three blocks lifted, then the keyword paused; UNDONE
 *   round 3     a builder rule bound by its mapping is on its mapped ad groups only (sources, rules scope, preview); the
 *               mode route sets the builder rule's own Manual/Automate; history offers Undo only when the undo would put
 *               something back; a request through an older name (harvest-search-term) is WAITING with its destination
 *   re-review   N1 completing a HALF_DONE harvest keeps the first set's keyword, landing and keywordBefore (Undo pauses
 *               it); a completion that does not land stays HALF_DONE with Undo offered · N3 own-limit warnings (M2)
 *   polish      M4 a rule ask with no candidate row is a WAITING row (its card's plan), decided on the page; M5 a request's
 *               row shows the request's own place, bid and blocks; M3 lastHarvest undo / keyword state / judge words;
 *               S7 the keyword's own numbers since it landed; M6 rule totals without the brain; S9 one window; S10 Rome
 *               time; S11 the brain's scope is its products and their sources; S12 the brain's terms one line
 *   own         a rule's preview: the rule's own numbers only narrow the bar, never loosen it
 *   release     R1 a new campaign is built in one market (an item of another refused); R9 its holds by level; RS4 a mode
 *               change says what it was, and its undo puts it back
 *   safety      a harvest rule acts alone on Auto only after Auto was picked on the harvest path (its mark): a rule saved
 *               at Auto before asks and says "Pick Auto again"; Ask me → Auto → Ask me → Auto keeps the mark right
 *   business    another business sees no candidate and no record
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
vi.mock('../ads-api-client.js', async (original) => ({
  ...(await original<object>()),
  createKeyword: vi.fn(async (_ctx: unknown, input: Record<string, unknown>) => { amz.keywords.push(input); return { ok: true, mode: 'live', externalId: `AMZ-K-${++amz.n}`, rawResponse: {}, error: null } }),
  createNegativeKeyword: vi.fn(async (_ctx: unknown, input: Record<string, unknown>) => { amz.negatives.push(input); return { ok: true, mode: 'live', externalId: `AMZ-N-${++amz.n}`, rawResponse: {} } }),
  listNegativeKeywords: vi.fn(async () => []),
}))

const { harvestCandidates, harvestDestinations, harvestHistory, skipCandidates, unskipCandidates, previewChangeSet, judgeDueHarvests, applyHarvestTool, runRuleHarvest, harvestSources, listHarvestRules, setHarvestRulesMode, setHarvestRuleArchived, executeChangeSet, decideHarvestRequests, previewHarvestRule } = await import('./index.js')
const { brainScheduleWords } = await import('./rules.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')
const { requestApproval, decideApproval } = await import('../../agents/approval-gate.service.js')
const { harvestUndo } = await import('../brain/harvest-undo.js')
const { runHarvestOnce } = await import('../brain/harvest-run.js')
const { enrollProduct, setLever } = await import('../brain/enrollment.js')
const { FEATURES, FIELDS } = await import('@nexus/shared/permissions')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `hv_engine_${hex}`
const W2 = `hv_other_${hex}`
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
  await product(JACKET, `HV-JACKET-${hex}`, { isParent: true, name: 'Jacket' })
  await product(JACKET_M, `HV-JACKET-M-${hex}`, { parentId: JACKET, amazonAsin: `B0HVJK0M${H}` })
  await product(GLOVE, `HV-GLOVE-${hex}`, { isParent: true, name: 'Glove', basePrice: '30.00' })
  await product(GLOVE_L, `HV-GLOVE-L-${hex}`, { parentId: GLOVE, amazonAsin: `B0HVGL0L${H}`, basePrice: '30.00' })
  await db.amazonAdsPortfolio.create({ data: { profileId: 'P-IT-TEST', externalPortfolioId: PF, name: `Jacket IT ${hex}` } })
  const campaign = async (key: string, groupName: string, ad: [string, string, string], extra: Record<string, unknown> = {}) => {
    await db.campaign.create({ data: { id: C(key), name: `${key} ${hex}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${C(key)}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra } })
    await db.adGroup.create({ data: { id: G(key), campaignId: C(key), name: groupName, externalAdGroupId: `EXT-${G(key)}` } })
    await db.adProductAd.create({ data: { adGroupId: G(key), productId: ad[0], asin: ad[1], sku: ad[2] } })
  }
  const target = (key: string, tid: string, text: string, expressionType: string, bidCents: number, extra: Record<string, unknown> = {}) =>
    db.adTarget.create({ data: { id: id(tid), adGroupId: G(key), kind: 'KEYWORD', expressionType, expressionValue: text, bidCents, externalTargetId: `EXT-${id(tid)}`, ...extra } })
  const jacket: [string, string, string] = [JACKET_M, `B0HVJK0M${H}`, `HV-JACKET-M-${hex}`]
  const glove: [string, string, string] = [GLOVE_L, `B0HVGL0L${H}`, `HV-GLOVE-L-${hex}`]
  await campaign('jk-auto', 'Auto', jacket, { targetingType: 'AUTO', portfolioId: PF })
  await campaign('jk-phrase', 'Phrase', jacket, { targetingType: 'MANUAL', portfolioId: PF })
  await campaign('jk-broad', 'Broad', jacket, { targetingType: 'MANUAL', portfolioId: PF })
  await campaign('jk-exact', 'Exact', jacket, { targetingType: 'MANUAL', portfolioId: PF })
  await campaign('gl-auto', 'Auto', glove, { targetingType: 'AUTO' })
  await target('jk-phrase', 't-phrase', 'jacket', 'PHRASE', 40)
  await target('jk-broad', 't-broad', 'motorbike jacket', 'BROAD', 40)
  await target('jk-exact', 't-racing', 'racing jacket', 'EXACT', 60)
  // An old block of the winter term in the exact ad group (B10: the exact keyword would never serve there).
  await target('jk-exact', 't-winter-neg', 'winter jacket', 'NEGATIVE_EXACT', 0, { isNegative: true, negativeLevel: 'AD_GROUP' })
  await db.amazonAdsSearchTerm.createMany({
    data: [
      st('jk-auto', 'touring jacket', 120, 4, 2400, 32_000),
      st('jk-phrase', 'touring jacket', 30, 1, 600, 8000),
      st('jk-auto', 'winter jacket', 100, 3, 2000, 24_000),
      st('jk-auto', 'summer jacket', 100, 3, 2000, 24_000),
      st('jk-exact', 'racing jacket', 600, 18, 12_000, 144_000),
      st('gl-auto', 'glove liner', 100, 3, 1000, 9000),
      // D2 — two terms a rule harvests on Auto, inside its caps.
      st('jk-auto', 'rain jacket', 100, 3, 2000, 24_000),
      st('jk-auto', 'mesh jacket', 100, 3, 2000, 24_000),
    ],
  })
  await db.adsStrategy.create({ data: { channel: 'AMAZON', market: 'IT', level: 'MARKET', scopeId: '*', label: 'IT', targetKind: 'ACOS', targetPct: 25, targetHiPct: 30, updatedBy: 'user:owner' } })
  await db.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon Italy', region: 'EU', currency: 'EUR', language: 'it' } })
  await db.adSpendCeiling.create({ data: { grain: 'MARKET', scopeId: 'IT', label: 'IT', dailyCapCents: 10_000 } })
}

/** The signed-in person on the page (every permission of the harvest tool), in the business. */
const person = () => ({
  kind: 'user' as const, userId: 'owner', label: 'Owner', via: 'app' as const, workspace: scope(W),
  permissions: { isOwner: false, permissions: new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
})
const approvedCtx = (preview: unknown, approvalId: string) => ({ userId: 'owner', approvalId, approvedPreview: preview, approvedByPerson: true, via: 'nexus', decidedVia: 'nexus', can: () => true }) as never
const rowOf = async (term: string, state?: string) => {
  const got = await inW(() => harvestCandidates({ market: 'IT', ...(state ? { state: [state] } : {}) }))
  if ('error' in got) throw new Error(got.error)
  return got.data.rows.find((r) => r.term === term) ?? null
}

describe.skipIf(!concurrentDatabaseUrl())('HARVEST ENGINE — one engine for every actor (real PostgreSQL)', { timeout: 240_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(async () => { await seed(); await setAutonomy('AUTO', 'test') })
  }, 240_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('candidates: READY with every source and the funnel block, NEEDS_DESTINATION (B10), NEEDS_CAMPAIGN, AT_HOME only when asked', async () => {
    const touring = await rowOf('touring jacket')
    expect(touring).toMatchObject({
      id: cid(JACKET, 'touring jacket'), state: 'READY', kind: 'keyword', product: { id: JACKET }, owner: { kind: 'NONE' }, bar: { by: 'brain' },
      destination: { kind: 'existing', adGroup: { id: G('jk-exact') }, portfolio: { id: PF }, status: 'will-create', match: 'EXACT' },
      metrics: { orders: 5, clicks: 150 },
    })
    expect(touring!.sources.map((s) => [s.adGroup.id, s.action])).toEqual([[G('jk-auto'), 'negate'], [G('jk-phrase'), 'negate']])
    expect(touring!.funnel.map((f) => [f.adGroup.id, f.match])).toEqual([[G('jk-broad'), 'EXACT']])
    expect(touring!.startBidCents).toBeGreaterThan(0)
    expect(await rowOf('winter jacket')).toMatchObject({ state: 'NEEDS_DESTINATION', heldBy: { kind: 'destination', reason: expect.stringMatching(/negative/) } })
    expect(await rowOf('glove liner')).toMatchObject({ state: 'NEEDS_CAMPAIGN', destination: { kind: 'new', plan: { name: `HV-GLOVE-${hex}-SP-Keyword-Exact-Harvest`, portfolio: null } } })
    expect(await rowOf('racing jacket')).toBeNull()
    expect(await rowOf('racing jacket', 'AT_HOME')).toMatchObject({ state: 'AT_HOME' })
    const ids = await inW(() => import('./index.js').then((m) => m.harvestCandidateIds({ market: 'IT' })))
    expect('data' in ids && ids.data.ids).toEqual(expect.arrayContaining([cid(JACKET, 'touring jacket'), cid(GLOVE, 'glove liner')]))
    const dest = await inW(() => harvestDestinations({ market: 'IT', candidateId: cid(JACKET, 'touring jacket') }))
    expect('data' in dest && dest.data).toMatchObject({ suggested: { kind: 'existing', adGroupId: G('jk-exact') }, portfolios: [{ id: PF }] })
    const groups = 'data' in dest ? dest.data.portfolios[0].campaigns.flatMap((c) => c.adGroups) : []
    expect(groups.find((g) => g.id === G('jk-auto'))?.held).toMatchObject({ label: 'Auto group' })
  })

  it('skip: hidden for 7 days (SKIPPED when asked), back with unskip', async () => {
    const out = await inW(() => skipCandidates([cid(JACKET, 'summer jacket')], 7, 'user:owner'))
    expect(out).toMatchObject({ changed: 1, forGood: false })
    expect(await rowOf('summer jacket')).toBeNull()
    expect(await rowOf('summer jacket', 'SKIPPED')).toMatchObject({ state: 'SKIPPED', skipped: { until: expect.any(String), by: 'user:owner' } })
    expect(await inW(() => unskipCandidates([cid(JACKET, 'summer jacket')]))).toMatchObject({ changed: 1 })
    expect(await rowOf('summer jacket')).toMatchObject({ state: 'READY' })
    // M8 — another business's (or an unknown) product: 404, nothing written.
    expect(await inW(() => skipCandidates([cid('other-biz-product', 'foo')], 7, 'user:owner'))).toMatchObject({ status: 404 })
    expect(await inW(() => database.client.adsBrainHarvest.count({ where: { productId: 'other-biz-product' } }))).toBe(0)
  })

  it('a change set: the preview\'s steps; the request run as the approving person writes the keyword, its sources and its funnel block, one record', async () => {
    const who = { actor: 'user:owner', manual: true, confirmOwnLimits: true, changeSetId: null, reason: 'preview' }
    const pv = await inW(() => previewChangeSet({ items: [{ candidateId: cid(JACKET, 'touring jacket') }, { candidateId: cid(JACKET, 'winter jacket') }] }, { actor: 'PERSON', who }))
    if ('error' in pv) throw new Error(pv.error)
    expect(pv.data.steps.map((s) => [s.kind, s.adGroup?.id])).toEqual([['keyword', G('jk-exact')], ['sourceNegative', G('jk-auto')], ['sourceNegative', G('jk-phrase')], ['funnelNegative', G('jk-broad')]])
    expect(pv.data.blocked).toEqual([{ candidateId: cid(JACKET, 'winter jacket'), term: 'winter jacket', reason: expect.stringMatching(/negative/) }])
    const args = { items: [{ candidateId: cid(JACKET, 'touring jacket') }], planHash: pv.data.planHash }
    const asked = await inW(() => applyHarvestTool.handler(args, { userId: 'owner', via: 'app', can: () => true } as never))
    expect(asked).toMatchObject({ ok: true, preview: { planHash: pv.data.planHash, totals: { keywords: 1, sourceNegatives: 2, funnelNegatives: 1 } } })
    expect(await inW(() => applyHarvestTool.handler({ ...args, planHash: 'moved-0000000000' }, { userId: 'owner', via: 'app', can: () => true } as never))).toMatchObject({ ok: false, error: expect.stringMatching(/moved since your review/) })
    // H1 (HCORE review) — through the approval gate for real: the request is stored, a person approves it, it runs while it
    // is itself `executing` (the row is there) — and it is never "waiting" for its own items.
    const asked2 = await inW(() => requestApproval('apply-harvest', args, person() as never))
    expect(asked2).toMatchObject({ ok: true, mode: 'queued', approvalId: expect.any(String) })
    const approvalId = asked2.approvalId!
    const ran = await inW(() => decideApproval(approvalId, 'approve', person() as never))
    expect(ran).toMatchObject({ ok: true, status: 'executed', result: { harvested: 1, harvestIds: [expect.any(String)] } })
    expect(await inW(() => database.client.agentApproval.findUnique({ where: { id: approvalId } }))).toMatchObject({ status: 'executed' })
    expect(amz.keywords).toEqual([expect.objectContaining({ keywordText: 'touring jacket', matchType: 'EXACT', externalAdGroupId: `EXT-${G('jk-exact')}` })])
    expect(amz.negatives.map((n) => n.externalAdGroupId).sort()).toEqual([`EXT-${G('jk-auto')}`, `EXT-${G('jk-broad')}`, `EXT-${G('jk-phrase')}`].sort())
    const rec = await inW(() => database.client.adsBrainHarvest.findFirst({ where: { productId: JACKET, term: 'touring jacket' } }))
    expect(rec).toMatchObject({ actorKind: 'PERSON', actorId: 'owner', changeSetId: approvalId, match: 'EXACT', status: 'DONE', verdict: 'WAITING', destAdGroupId: G('jk-exact') })
    expect(rec!.landedAt).not.toBeNull()
    expect(await rowOf('touring jacket')).toMatchObject({ state: 'HARVESTED', lastHarvest: { by: { kind: 'PERSON' }, status: 'DONE', verdict: 'too-early' } })
    const hist = await inW(() => harvestHistory({ market: 'IT' }))
    expect('data' in hist && hist.data.rows).toEqual([expect.objectContaining({ term: 'touring jacket', by: expect.objectContaining({ kind: 'PERSON' }), changeSetId: approvalId, undo: { available: true, why: null } })])
  })

  it('M3 + M2 — a new campaign is a big door: the preview says the code (step and approvals); approved without it, nothing runs', async () => {
    const who = { actor: 'user:owner', manual: true, confirmOwnLimits: true, changeSetId: null, reason: 'preview' }
    const body = { items: [{ candidateId: cid(GLOVE, 'glove liner'), to: { newCampaign: 'g1' } }], newCampaigns: [{ key: 'g1', productId: GLOVE }] }
    const pv = await inW(() => previewChangeSet(body, { actor: 'PERSON', who }))
    if ('error' in pv) throw new Error(pv.error)
    expect(pv.data).toMatchObject({ approvals: { count: 1, codes: 1 }, stepUp: { raises: expect.arrayContaining(['New campaign']) }, totals: { campaigns: 1, keywords: 1, sourceNegatives: 1 } })
    expect(pv.data.steps.find((x) => x.kind === 'campaign')).toMatchObject({ needsCode: true, to: expect.stringMatching(/live at once/) })
    // Inside caps: a budget above the market's spend ceiling is refused, named.
    const big = await inW(() => previewChangeSet({ ...body, newCampaigns: [{ key: 'g1', productId: GLOVE, dailyBudgetCents: 50_000 }] }, { actor: 'PERSON', who }))
    expect('data' in big && big.data.blocked).toEqual([expect.objectContaining({ reason: expect.stringMatching(/spend ceiling/) })])
    const asked = await inW(() => requestApproval('apply-harvest', { ...body, planHash: pv.data.planHash }, person() as never))
    expect(asked).toMatchObject({ ok: true, mode: 'queued', preview: { stepUp: expect.anything() } })
    const ran = await inW(() => decideApproval(asked.approvalId!, 'approve', person() as never))
    expect(ran.ok).toBe(false)
    expect(String(ran.error)).toMatch(/code/i)
    expect(await inW(() => database.client.campaign.count({ where: { name: { contains: '-SP-Keyword-Exact-Harvest' } } }))).toBe(0)
    await inW(() => decideApproval(asked.approvalId!, 'reject', person() as never))
  })

  it('judge: past its window with 0 orders in enough clicks, a person\'s harvest is worse', async () => {
    await inW(() => database.client.adsBrainHarvest.updateMany({ where: { productId: JACKET, term: 'touring jacket' }, data: { landedAt: dayOf(25), judgeAfter: dayOf(14) } }))
    await inW(() => database.client.amazonAdsSearchTerm.createMany({ data: [st('jk-exact', 'touring jacket', 300, 0, 6000, 0, 12)] }))
    expect(await inW(() => judgeDueHarvests(new Date()))).toMatchObject({ judged: 1, worse: 1 })
    const hist = await inW(() => harvestHistory({ market: 'IT', verdict: 'worse' }))
    expect('data' in hist && hist.data.rows.map((r) => r.term)).toEqual(['touring jacket'])
  })

  it('D2 (H3 + M7) — a rule on Auto harvests on the engine inside its caps: the day\'s keywords, one record per term, a shared source held', async () => {
    // Nine keywords this rule created today already: one is left under the cap of 10.
    await inW(() => database.client.advertisingActionLog.createMany({ data: Array.from({ length: 9 }, (_, i) => ({ userId: 'automation:rule-d2', actionType: 'create_keyword', entityType: 'AD_TARGET', entityId: `old-${i}`, payloadBefore: {}, payloadAfter: {}, amazonResponseStatus: 'SUCCESS' })) }))
    const before = amz.keywords.length
    const out = await inW(() => runRuleHarvest({ ruleId: 'rule-d2', terms: [{ query: 'rain jacket', externalAdGroupId: `EXT-${G('jk-auto')}` }, { query: 'mesh jacket', externalAdGroupId: `EXT-${G('jk-auto')}` }, { query: 'some term', externalAdGroupId: 'EXT-UNKNOWN' }] }))
    expect(out).toMatchObject({ harvested: 1, capped: 1 })
    expect(out.held.map((x) => x.why)).toEqual(expect.arrayContaining([expect.stringMatching(/not in Nexus/), expect.stringMatching(/keywords for today/)]))
    expect(amz.keywords.length).toBe(before + 1)
    const recs = await inW(() => database.client.adsBrainHarvest.findMany({ where: { productId: JACKET, actorKind: 'RULE' } }))
    expect(recs).toEqual([expect.objectContaining({ term: 'rain jacket', actorId: 'rule-d2', status: 'DONE', destAdGroupId: G('jk-exact') })])
    // Every source and the funnel, as the page's: the auto source and the broad and phrase looser groups.
    expect((recs[0].sources as Array<{ action: string; result?: string }>).every((x) => x.action !== 'negate' || x.result === 'landed')).toBe(true)
  })

  it('H4 — automation never acts on a person\'s harvest: auto-undo does not list it, the brain does not retry, re-judge or undo it', async () => {
    const rec = await inW(() => database.client.adsBrainHarvest.findFirst({ where: { productId: JACKET, term: 'touring jacket' } }))
    expect(rec).toMatchObject({ actorKind: 'PERSON', verdict: 'WORSE' })
    expect((await inW(() => harvestUndo.judged(new Date(0)))).map((x) => x.id)).not.toContain(rec!.id)
    expect(await inW(() => harvestUndo.undo(rec!.id, { actor: 'automation:auto-undo', reason: 'test' } as never))).toMatchObject({ ok: false, reason: expect.stringMatching(/only a person/) })
    // The brain runs the jacket at AUTO under a live ceiling: a person's HALF_DONE record with a failed block stays untouched.
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    vi.stubEnv('NEXUS_ADS_BRAIN_HARVEST_MODE', 'live')
    expect(await inW(() => enrollProduct({ productId: JACKET_M, market: 'IT', by: 'user:owner' }))).toMatchObject({ ok: true })
    expect(await inW(() => setLever({ productId: JACKET, market: 'IT', by: 'user:owner', reason: 'test', lever: 'harvest', level: 'AUTO' }))).toMatchObject({ ok: true })
    const sources = (rec!.sources as Array<Record<string, unknown>>).map((x, i) => (i === 0 ? { ...x, result: 'failed', error: 'x' } : x))
    await inW(() => database.client.adsBrainHarvest.update({ where: { id: rec!.id }, data: { status: 'HALF_DONE', sources: sources as never, attempts: 1 } }))
    const before = await inW(() => database.client.adsBrainHarvest.findUnique({ where: { id: rec!.id } }))
    await inW(() => runHarvestOnce({ now: new Date() }))
    const after = await inW(() => database.client.adsBrainHarvest.findUnique({ where: { id: rec!.id } }))
    expect(after).toMatchObject({ status: 'HALF_DONE', attempts: 1, actorKind: 'PERSON', verdict: 'WORSE', changedAt: before!.changedAt })
    expect(await inW(() => database.client.agentApproval.count({ where: { toolName: 'apply-brain-harvest', args: { path: ['harvestId'], equals: rec!.id } } }))).toBe(0)
    vi.stubEnv('NEXUS_ADS_BRAIN_HARVEST_MODE', 'shadow')
    await inW(() => database.client.adsBrainHarvest.update({ where: { id: rec!.id }, data: { status: 'DONE', sources: rec!.sources as never } }))
  })

  it('undo: one request lifts its three blocks, then pauses the keyword; UNDONE', async () => {
    const rec = await inW(() => database.client.adsBrainHarvest.findFirst({ where: { productId: JACKET, term: 'touring jacket' } }))
    const args = { op: 'undo', harvestIds: [rec!.id] }
    const asked = await inW(() => applyHarvestTool.handler(args, { userId: 'owner', via: 'app', can: () => true } as never))
    expect(asked).toMatchObject({ ok: true, preview: { op: 'undo', rows: [{ ok: true, lift: [expect.anything(), expect.anything(), expect.anything()], pause: expect.anything() }] } })
    const ran = await inW(() => applyHarvestTool.execute!(args, approvedCtx(asked.preview, 'ap-hv-undo')))
    expect(ran).toMatchObject({ ok: true, data: { op: 'undo', results: [{ harvestId: rec!.id, paused: true, lifted: 3, complete: true }] } })
    expect(await inW(() => database.client.adsBrainHarvest.findUnique({ where: { id: rec!.id } }))).toMatchObject({ status: 'UNDONE', undoApprovalId: 'ap-hv-undo' })
  })

  it('M1 — an undo whose blocks cannot all be listed is refused: a negative of the term stands in a source the record does not name', async () => {
    const db = database.client
    const k = await inW(() => db.adTarget.create({ data: { adGroupId: G('jk-exact'), kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'stray jacket', bidCents: 40, externalTargetId: `EXT-stray-${hex}`, status: 'ENABLED' } }))
    await inW(() => db.adTarget.create({ data: { adGroupId: G('jk-auto'), kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'stray jacket', bidCents: 0, isNegative: true, negativeLevel: 'AD_GROUP', externalTargetId: `EXT-strayneg-${hex}` } }))
    const r = await inW(() => db.adsBrainHarvest.create({ data: {
      productId: JACKET, marketplace: 'IT', term: 'stray jacket', status: 'DONE', level: 'AUTO', destinationKind: 'EXISTING', destAdGroupId: G('jk-exact'), destCampaignId: C('jk-exact'),
      keywordTargetId: k.id, sources: [{ adGroupId: G('jk-auto'), campaignId: C('jk-auto'), role: null, action: 'kept', why: 'kept until proven' }], why: 'a rule harvested it', evidence: {}, digest: '', runId: 'r',
      decidedAt: new Date(), checkedAt: new Date(), changedAt: new Date(), actorKind: 'RULE', actorId: 'rule-d2',
    } }))
    expect(await inW(() => applyHarvestTool.handler({ op: 'undo', harvestIds: [r.id] }, { userId: 'owner', via: 'app', can: () => true } as never))).toMatchObject({ ok: false, error: expect.stringMatching(/did not record/) })
  })

  it('M1 / lead 4 — history offers Undo only when the undo itself would put something back (its own preview answers)', async () => {
    const db = database.client
    const stray = await inW(() => db.adsBrainHarvest.findFirst({ where: { productId: JACKET, term: 'stray jacket' } }))
    // A keyword that stood before the harvest is never paused, and it lifted nothing: nothing to put back.
    const k = await inW(() => db.adTarget.create({ data: { adGroupId: G('jk-exact'), kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'stood jacket', bidCents: 40, externalTargetId: `EXT-stood-${hex}`, status: 'ENABLED' } }))
    const stood = await inW(() => db.adsBrainHarvest.create({ data: {
      productId: JACKET, marketplace: 'IT', term: 'stood jacket', status: 'DONE', level: 'AUTO', destinationKind: 'EXISTING', destAdGroupId: G('jk-exact'), destCampaignId: C('jk-exact'),
      keywordTargetId: k.id, sources: [{ adGroupId: G('jk-auto'), campaignId: C('jk-auto'), role: null, action: 'standing', why: 'blocked before' }], why: 'test', evidence: { keywordBefore: 'stood' }, digest: '', runId: 'r',
      decidedAt: new Date(), checkedAt: new Date(), changedAt: new Date(), actorKind: 'PERSON', actorId: 'owner',
    } }))
    const hist = await inW(() => harvestHistory({ market: 'IT', ids: [stray!.id, stood.id] }))
    if ('error' in hist) throw new Error(hist.error)
    const of = (hid: string) => hist.data.rows.find((r) => r.harvestId === hid)!.undo
    expect(of(stood.id)).toEqual({ available: false, why: expect.stringMatching(/Nothing of it is left to put back/) })
    expect(of(stray!.id)).toEqual({ available: false, why: expect.stringMatching(/did not record/) })
    // The same answer the undo gives.
    expect(await inW(() => applyHarvestTool.handler({ op: 'undo', harvestIds: [stood.id] }, { userId: 'owner', via: 'app', can: () => true } as never))).toMatchObject({ ok: false })
  })

  it('lead 2 + 3 — a builder rule bound by its mapping: on its mapped ad groups only (sources, scope, preview); the mode route sets its Manual/Automate', async () => {
    const db = database.client
    const rule = await inW(() => db.automationRule.create({ data: {
      name: `Mapped harvest ${hex}`, domain: 'advertising', trigger: 'SEARCH_TERM_CONVERTING', enabled: true, dryRun: true, autonomyLevel: 'PROPOSE', scopeMarketplace: 'IT',
      conditions: [{ match: 'all', conditions: [{ metric: 'Orders', op: 'gte', value: '2' }] }],
      actions: [{ type: 'keyword-harvesting', control: 'automate', mappings: [{ groups: [{ id: G('jk-auto'), look: true }, { id: G('jk-exact'), look: false, types: { E: true } }] }] }],
    } }))
    const sources = await inW(() => harvestSources({ market: 'IT' }))
    if ('error' in sources) throw new Error(sources.error)
    const on = (gid: string) => sources.data.rows.find((r) => r.id === gid)?.rules.map((r) => r.id) ?? []
    expect(on(G('jk-auto'))).toContain(rule.id)
    for (const g of [G('jk-phrase'), G('jk-broad'), G('gl-auto')]) expect(on(g)).not.toContain(rule.id)
    const list = await inW(() => listHarvestRules({ market: 'IT' }))
    const row = list.rules.find((r) => r.id === rule.id)!
    expect(row.scope).toMatchObject({ all: false, counts: { campaigns: 2, adGroups: 2 } })
    expect(row.scope.campaigns.map((c) => c.id).sort()).toEqual([C('jk-auto'), C('jk-exact')].sort())
    // Ask me: the level first, then its own setting Manual (else it would still act alone at Watch / Auto).
    expect(await inW(() => setHarvestRulesMode([rule.id], 'ASK', 'user:owner'))).toEqual({ results: [{ id: rule.id, ok: true, mode: 'ASK', belt: 'manual', marked: false, before: { mode: 'ASK', belt: 'automate', marked: false } }] })
    const asked = await inW(() => db.automationRule.findUnique({ where: { id: rule.id } }))
    expect(asked).toMatchObject({ autonomyLevel: 'PROPOSE', actions: [expect.objectContaining({ control: 'manual', type: 'keyword-harvesting' })] })
    expect(await inW(() => setHarvestRulesMode([rule.id], 'WATCH', 'user:owner'))).toEqual({ results: [{ id: rule.id, ok: true, mode: 'WATCH', belt: 'automate', marked: false, before: { mode: 'ASK', belt: 'manual', marked: false } }] })
    expect(await inW(() => db.automationRule.findUnique({ where: { id: rule.id } }))).toMatchObject({ autonomyLevel: 'OBSERVE', actions: [expect.objectContaining({ control: 'automate' })] })
    // Off keeps its setting; the rule is out of the next tests.
    expect(await inW(() => setHarvestRulesMode([rule.id], 'OFF', 'user:owner'))).toEqual({ results: [{ id: rule.id, ok: true, mode: 'OFF', belt: 'automate', marked: false, before: { mode: 'WATCH', belt: 'automate', marked: false } }] })
  })

  it('lead 4 + HMCP — a request through an older name (harvest-search-term) is WAITING, with the destination and bid its preview names', async () => {
    const db = database.client
    const run = await inW(() => db.agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'awaiting_approval' } }))
    const item = { candidateId: cid(JACKET, 'mesh jacket'), ok: true, match: 'EXACT', bidCents: 55, destination: { kind: 'existing', how: 'suggested', status: 'will-create', adGroup: { id: G('jk-exact'), name: 'Exact' }, campaign: { id: C('jk-exact'), name: `jk-exact ${hex}` }, portfolio: { id: PF, name: 'Jacket IT' } } }
    const ap = await inW(() => db.agentApproval.create({ data: {
      agentRunId: run.id, toolName: 'harvest-search-term', riskTier: 'write', status: 'pending', args: { campaignId: C('jk-auto'), query: 'mesh jacket' },
      preview: { action: 'harvest-search-term', engine: 'apply-harvest', op: 'harvest', items: [item], steps: [] },
    } }))
    expect(await rowOf('mesh jacket', 'WAITING')).toMatchObject({
      state: 'WAITING', waiting: { approvalId: ap.id }, startBidCents: 55,
      destination: { kind: 'existing', adGroup: { id: G('jk-exact') }, campaign: { id: C('jk-exact') }, portfolio: { id: PF }, match: 'EXACT', status: 'will-create' },
    })
    await inW(() => db.agentApproval.update({ where: { id: ap.id }, data: { status: 'rejected' } }))
    expect(await rowOf('mesh jacket', 'WAITING')).toBeNull()
  })

  it('N1 — completing a HALF_DONE harvest keeps its keyword, landing and keywordBefore; a completion that does not land stays HALF_DONE', async () => {
    const db = database.client
    await inW(() => db.amazonAdsSearchTerm.createMany({ data: [st('jk-auto', 'owed jacket', 100, 3, 2000, 24_000)] }))
    const k = await inW(() => db.adTarget.create({ data: { adGroupId: G('jk-exact'), kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'owed jacket', bidCents: 40, externalTargetId: `EXT-owed-${hex}`, status: 'ENABLED' } }))
    const n = await inW(() => db.adTarget.create({ data: { adGroupId: G('jk-auto'), kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'owed jacket', bidCents: 0, isNegative: true, negativeLevel: 'AD_GROUP', externalTargetId: `EXT-owedneg-${hex}` } }))
    const landedAt = dayOf(2)
    // The first set created the keyword, its source block landed, its funnel block failed: HALF_DONE.
    const r = await inW(() => db.adsBrainHarvest.create({ data: {
      productId: JACKET, marketplace: 'IT', term: 'owed jacket', status: 'HALF_DONE', level: 'PROPOSE', destinationKind: 'EXISTING', destAdGroupId: G('jk-exact'), destCampaignId: C('jk-exact'),
      keywordTargetId: k.id, landedAt, judgeAfter: new Date(landedAt.getTime() + 10 * DAY), verdict: 'WAITING',
      sources: [{ adGroupId: G('jk-auto'), campaignId: C('jk-auto'), role: 'AUTO', action: 'negate', negMatch: 'EXACT', why: 'source', result: 'landed', negativeTargetId: n.id }],
      funnel: [{ adGroupId: G('jk-broad'), campaignId: C('jk-broad'), role: 'BROAD', action: 'negate', negMatch: 'EXACT', why: 'funnel', result: 'failed', error: 'Amazon timed out' }],
      why: 'test', evidence: { keywordBefore: 'none' }, digest: '', runId: 'r', decidedAt: new Date(), checkedAt: new Date(), changedAt: new Date(), actorKind: 'PERSON', actorId: 'owner', changeSetId: 'cs-first',
    } }))
    const who = { actor: 'user:owner', manual: true, confirmOwnLimits: true, changeSetId: 'cs-n1', reason: 'complete it' }
    const plan = async () => {
      const pv = await inW(() => previewChangeSet({ items: [{ candidateId: cid(JACKET, 'owed jacket') }] }, { actor: 'PERSON', who }))
      if ('error' in pv) throw new Error(pv.error)
      expect(pv.data.totals.ok).toBe(1)
      return pv.plan
    }
    const status = (await inW(() => db.campaign.findUniqueOrThrow({ where: { id: C('jk-exact') }, select: { status: true } }))).status
    // 1. While the request waited, the destination's campaign was paused: the write's own guard holds it.
    const first = await plan()
    await inW(() => db.campaign.update({ where: { id: C('jk-exact') }, data: { status: 'PAUSED' } }))
    try {
      const held = await inW(() => executeChangeSet(first, { actor: 'PERSON', actorId: 'owner', who }))
      expect(held.items[0]).toMatchObject({ harvestId: r.id, status: 'HELD' })
    } finally { await inW(() => db.campaign.update({ where: { id: C('jk-exact') }, data: { status } })) }
    expect(await inW(() => db.adsBrainHarvest.findUnique({ where: { id: r.id } }))).toMatchObject({ status: 'HALF_DONE', keywordTargetId: k.id, landedAt, evidence: expect.objectContaining({ keywordBefore: 'none' }), why: expect.stringMatching(/did not land/) })
    const hist = await inW(() => harvestHistory({ market: 'IT', ids: [r.id] }))
    expect('data' in hist && hist.data.rows[0].undo).toEqual({ available: true, why: null })
    // 2. It serves again: the completion lands — still the first set's keyword, landing and "nothing before": Undo pauses it.
    const done = await inW(async () => executeChangeSet(await plan(), { actor: 'PERSON', actorId: 'owner', who }))
    expect(done.items[0]).toMatchObject({ harvestId: r.id, status: 'DONE' })
    expect(await inW(() => db.adsBrainHarvest.findUnique({ where: { id: r.id } }))).toMatchObject({ status: 'DONE', keywordTargetId: k.id, landedAt, evidence: expect.objectContaining({ keywordBefore: 'none' }) })
    const undo = await inW(() => applyHarvestTool.handler({ op: 'undo', harvestIds: [r.id] }, { userId: 'owner', via: 'app', can: () => true } as never))
    expect(undo).toMatchObject({ ok: true, preview: { rows: [{ ok: true, pause: { keyword: { id: k.id } } }] } })
    expect((undo.preview as { rows: Array<{ lift: Array<{ negativeTargetId: string }> }> }).rows[0].lift.map((l) => l.negativeTargetId)).toContain(n.id)
  })

  it('N3 (M2) — a person going past his own bid limit is warned on the item, its keyword step and the answer, never hidden', async () => {
    const db = database.client
    await inW(() => db.amazonAdsSearchTerm.createMany({ data: [st('jk-auto', 'vent jacket', 100, 3, 2000, 24_000)] }))
    await inW(() => db.campaign.update({ where: { id: C('jk-exact') }, data: { maxBidCents: 5 } }))
    try {
      // The suggested start bid keeps inside the limit by itself; the person asks for more than it allows.
      const who = { actor: 'user:owner', manual: true, confirmOwnLimits: true, changeSetId: null, reason: 'preview' }
      const own = await inW(() => previewChangeSet({ items: [{ candidateId: cid(JACKET, 'vent jacket') }] }, { actor: 'PERSON', who }))
      expect('data' in own && own.data).toMatchObject({ items: [{ ok: true, bidCents: 5, warnings: [] }], pastOwnLimits: [] })
      const pv = await inW(() => previewChangeSet({ items: [{ candidateId: cid(JACKET, 'vent jacket'), bidCents: 60 }] }, { actor: 'PERSON', who }))
      if ('error' in pv) throw new Error(pv.error)
      expect(pv.data.items[0].refusal).toBeNull()
      expect(pv.data.items[0]).toMatchObject({ ok: true, warnings: [expect.objectContaining({ half: 'keyword', adGroupId: G('jk-exact'), limit: 'entity_bounds', reason: expect.stringMatching(/ceiling/) })] })
      expect(pv.data.steps.find((x) => x.kind === 'keyword')).toMatchObject({ pastOwnLimits: [expect.objectContaining({ limit: 'entity_bounds' })] })
      expect(pv.data.pastOwnLimits).toEqual([expect.objectContaining({ limit: 'entity_bounds' })])
      // The request carries them to the approver's card.
      const asked = await inW(() => applyHarvestTool.handler({ items: [{ candidateId: cid(JACKET, 'vent jacket'), bidCents: 60 }], planHash: pv.data.planHash }, { userId: 'owner', via: 'app', can: () => true } as never))
      expect(asked).toMatchObject({ ok: true, preview: { pastOwnLimits: [expect.objectContaining({ limit: 'entity_bounds' })] } })
    } finally { await inW(() => db.campaign.update({ where: { id: C('jk-exact') }, data: { maxBidCents: null } })) }
  })

  it('polish M4 + M5 — every waiting request is a row with the plan it writes; a rule ask is decided on the page', async () => {
    const db = database.client
    // A harvest rule's ask whose term has no candidate row (no search-term numbers in Nexus).
    const rule = await inW(() => db.automationRule.create({ data: { name: `Exact harvest ${hex}`, domain: 'advertising', trigger: 'SEARCH_TERM_CONVERTING', enabled: true, dryRun: true, autonomyLevel: 'PROPOSE', scopeMarketplace: 'IT', actions: [{ type: 'promote_to_exact' }] } }))
    const ask = await inW(() => db.adsRuleSuggestion.create({ data: {
      ruleId: rule.id, ruleName: rule.name, marketplace: 'IT', entityType: 'SEARCH_TERM', entityId: `EXT-${C('jk-auto')}:ask jacket`, entityName: 'ask jacket', proposedKey: 'promote_to_exact',
      proposedAction: { type: 'promote_to_exact', query: 'ask jacket', dryRun: true, sourceAdGroupId: G('jk-auto'), outcomes: [{ adGroupId: G('jk-exact'), matchType: 'EXACT', bidEur: 0.45, wouldCreate: true }] },
    } }))
    const row = await rowOf('ask jacket', 'WAITING')
    expect(row).toMatchObject({
      id: cid(JACKET, 'ask jacket'), state: 'WAITING', metrics: { orders: 0, clicks: 0 }, startBidCents: 45,
      waiting: { approvalId: ask.id, kind: 'rule-ask', by: { kind: 'RULE', id: rule.id, name: rule.name }, terms: 1 },
      destination: { kind: 'existing', adGroup: { id: G('jk-exact') }, campaign: { id: C('jk-exact') }, portfolio: { id: PF }, match: 'EXACT' },
      sources: [expect.objectContaining({ adGroup: expect.objectContaining({ id: G('jk-auto') }), action: 'kept' })], funnel: [],
    })
    // An engine request: the row shows the REQUEST's place, bid and blocks (what it writes), one request counted once.
    await inW(() => db.amazonAdsSearchTerm.createMany({ data: [st('jk-auto', 'plan jacket', 100, 3, 2000, 24_000)] }))
    const asked = await inW(() => requestApproval('apply-harvest', { items: [{ candidateId: cid(JACKET, 'plan jacket'), bidCents: 33 }] }, person() as never))
    expect(asked).toMatchObject({ ok: true, mode: 'queued' })
    const stored = (await inW(() => db.agentApproval.findUniqueOrThrow({ where: { id: asked.approvalId! } }))).preview as { items: Array<{ sources: Array<{ adGroup: { id: string }; action: string }>; funnel: Array<{ adGroup: { id: string }; action: string }> }> }
    const planRow = await rowOf('plan jacket', 'WAITING')
    expect(planRow).toMatchObject({ state: 'WAITING', startBidCents: 33, waiting: { approvalId: asked.approvalId, kind: 'request', terms: 1 }, destination: { adGroup: { id: G('jk-exact') } } })
    expect(planRow!.sources.map((x) => [x.adGroup.id, x.action])).toEqual(stored.items[0].sources.map((x) => [x.adGroup.id, x.action]))
    expect(planRow!.funnel.map((x) => x.adGroup.id)).toEqual(stored.items[0].funnel.filter((x) => x.action === 'negate').map((x) => x.adGroup.id))
    const all = await inW(() => harvestCandidates({ market: 'IT', state: ['WAITING'] }))
    if ('error' in all) throw new Error(all.error)
    expect(all.data.totals.waitingRequests).toBe(new Set(all.data.rows.map((r) => r.waiting!.approvalId)).size)
    expect(row!.waiting!.stale).toBeNull()
    // Its rule edited after it proposed: the row says so up front (Approve would be refused), Reject still works.
    await inW(() => db.adsRuleSuggestion.update({ where: { id: ask.id }, data: { lastSeenAt: new Date(Date.now() - 60_000) } }))
    await inW(async () => { const { updateAdsRule } = await import('../ads-rule-crud.service.js'); await updateAdsRule(rule.id, { actions: [{ type: 'promote_to_exact', reason: 'edited' }] }, 'user:owner') })
    expect(await rowOf('ask jacket', 'WAITING')).toMatchObject({ waiting: { approvalId: ask.id, stale: { why: 'The rule changed after it asked.' } } })
    // Counted apart: the requests that can be approved now, and those out of date.
    const counted = await inW(() => harvestCandidates({ market: 'IT', state: ['WAITING'] }))
    if ('error' in counted) throw new Error(counted.error)
    expect(counted.data.totals).toMatchObject({ waitingStale: 1, waitingRequests: new Set(counted.data.rows.filter((r) => !r.waiting!.stale).map((r) => r.waiting!.approvalId)).size })
    expect((await inW(() => decideHarvestRequests([{ approvalId: ask.id, decide: 'approve' }], person() as never))).results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/was edited/) })
    // Decided on the page: the rule's ask dismissed, the request rejected; both rows go.
    const decided = await inW(() => decideHarvestRequests([{ approvalId: ask.id, decide: 'reject' }, { approvalId: asked.approvalId!, decide: 'reject' }], person() as never, 'test'))
    expect(decided.results).toEqual([expect.objectContaining({ approvalId: ask.id, ok: true, status: 'dismissed' }), expect.objectContaining({ approvalId: asked.approvalId, ok: true })])
    expect(await rowOf('ask jacket', 'WAITING')).toBeNull()
    expect(await rowOf('plan jacket', 'WAITING')).toBeNull()
  })

  it('polish M3 + S7 — a harvested row: the undo\'s own answer, its keyword\'s state, the judge\'s words, the keyword\'s numbers since it landed', async () => {
    const db = database.client
    const rec = await inW(() => db.adsBrainHarvest.findFirstOrThrow({ where: { productId: JACKET, term: 'owed jacket' } }))
    await inW(() => db.adsBrainHarvest.update({ where: { id: rec.id }, data: { landedAt: dayOf(20), judgement: { why: 'its ACoS went up' } } }))
    await inW(() => db.amazonAdsSearchTerm.createMany({ data: [st('jk-exact', 'owed jacket', 50, 2, 1000, 16_000, 10), st('jk-exact', 'owed jacket', 9, 0, 300, 0, 25)] }))
    const row = await rowOf('owed jacket', 'HARVESTED')
    expect(row).toMatchObject({
      state: 'HARVESTED',
      lastHarvest: { harvestId: rec.id, undo: { available: true, why: null }, keyword: { id: rec.keywordTargetId, state: 'ENABLED' }, judge: { why: 'its ACoS went up' } },
      // Only the days after it landed (the row 25 days back is before it), in its destination.
      sinceHarvest: { clicks: 50, orders: 2, spendCents: 1000, salesCents: 16_000, acosPct: 6.3 },
    })
    expect(row!.sinceHarvest!.days).toBeGreaterThanOrEqual(10)
    // The undo's own answer, the same as the history's.
    const hist = await inW(() => harvestHistory({ market: 'IT', ids: [rec.id] }))
    expect('data' in hist && hist.data.rows[0].undo).toEqual(row!.lastHarvest!.undo)
    // Re-audit — "N blocked" counts only the blocks that still stand; an undone harvest's are lifted.
    expect('data' in hist && hist.data.rows[0].blocks).toBeGreaterThan(0)
    const undone = await inW(() => db.adsBrainHarvest.findFirstOrThrow({ where: { productId: JACKET, term: 'touring jacket' } }))
    const was = await inW(() => harvestHistory({ market: 'IT', ids: [undone.id] }))
    if ('error' in was) throw new Error(was.error)
    expect(was.data.rows[0]).toMatchObject({ status: 'UNDONE', blocks: 0 })
    expect([...was.data.rows[0].sources, ...was.data.rows[0].funnel].filter((b) => b.action === 'negate').map((b) => b.result)).toEqual(['lifted', 'lifted', 'lifted'])
  })

  it('polish M6 + S9–S12 — rule totals without the brain; one window; Rome time; the brain\'s products and sources; its terms one line', async () => {
    const list = await inW(() => listHarvestRules({ market: 'IT' }))
    const rules = list.rules.filter((r) => r.kind !== 'brain' && !r.archived)
    expect(list.totals).toMatchObject({ rules: rules.length, waiting: rules.reduce((n, r) => n + r.waiting, 0), brain: { set: expect.any(String), acts: expect.any(String), waiting: expect.any(Number) } })
    const brain = list.rules[0]
    expect(brain).toMatchObject({ id: 'brain', schedule: expect.stringMatching(/^Daily · \d\d:\d\d$/) })
    expect((brain.scope as { products?: Array<{ id: string; name: string }> }).products).toEqual(expect.arrayContaining([expect.objectContaining({ id: JACKET, name: 'Jacket' })]))
    expect(brain.scope.adGroups.map((g) => g.id)).toEqual(expect.arrayContaining([G('jk-auto')]))
    expect(brain.scope.adGroups.map((g) => g.id)).not.toContain(G('jk-exact'))
    expect(brainScheduleWords(new Date('2026-10-12T05:25:00Z'))).toBe('Daily · 07:25')
    expect(brainScheduleWords(new Date('2026-12-01T05:25:00Z'))).toBe('Daily · 06:25')
    const src = await inW(() => harvestSources({ market: 'IT' }))
    if ('error' in src) throw new Error(src.error)
    const auto = src.data.rows.find((r) => r.id === G('jk-auto'))!
    expect(src.data.windowDays).toBe(60)
    expect(auto).toMatchObject({ terms: expect.any(Number), sellingTerms: expect.any(Number), harvested: expect.any(Number) })
    expect(auto).not.toHaveProperty('terms30d')
    expect(auto.sellingTerms).toBeGreaterThan(0)
    expect(src.data.totals.sellingGroups).toBe(src.data.rows.filter((r) => r.sellingTerms > 0).length)
    // The jacket's terms belong to the brain (enrolled, harvest lever on): one line, no sample rows of them.
    const mapped = list.rules.find((r) => r.name === `Mapped harvest ${hex}`)!
    const pv = await inW(() => previewHarvestRule({ ruleId: mapped.id }))
    if ('error' in pv) throw new Error(pv.error)
    expect(pv.data.brainOwned).toMatchObject({ terms: expect.any(Number), words: expect.stringMatching(/belongs? to the brain \(/) })
    expect(pv.data.brainOwned!.terms).toBeGreaterThan(0)
    expect(pv.data.sample.filter((x) => x.heldBy?.label === 'Brain decides')).toEqual([])
  })

  it('a rule\'s preview: only terms it reaches; its own numbers only narrow the bar, never loosen it', async () => {
    const db = database.client
    // The brain leaves the jacket for this test, so a rule may harvest its terms (it is put back after).
    expect(await inW(() => setLever({ productId: JACKET, market: 'IT', by: 'user:owner', reason: 'test', lever: 'harvest', level: 'OFF' }))).toMatchObject({ ok: true })
    try {
      const rule = await inW(() => db.automationRule.create({ data: {
        name: `Scoped harvest ${hex}`, domain: 'advertising', trigger: 'SCHEDULE', enabled: false, dryRun: true, autonomyLevel: 'OFF', scopeMarketplace: 'IT',
        actions: [{ type: 'harvest_and_negate', mode: 'harvest' }],
      } }))
      const pv = async (actions: unknown[]) => {
        const got = await inW(() => previewHarvestRule({ ruleId: rule.id, actions, limit: 100 }))
        if ('error' in got) throw new Error(got.error)
        return got.data
      }
      const stored = rule.actions as Array<Record<string, unknown>>
      const bar = await pv(stored)
      expect(bar.own).toBeNull()
      expect(bar.wouldHarvest).toBeGreaterThan(0)
      const strict = await pv([{ ...stored[0], minOrders: 4, windowDays: 60 }])
      expect(strict.own).toMatchObject({ minOrders: 4, windowDays: 60 })
      expect(strict.wouldHarvest).toBeLessThan(bar.wouldHarvest)
      expect(strict.own!.belowOwn).toBeGreaterThan(0)
      const same = await pv([{ ...stored[0], minOrders: 3, windowDays: 60 }])
      expect(same.wouldHarvest).toBe(bar.wouldHarvest)
      // A rule over its whole market says so (scope.all), never a count of every campaign.
      expect((await inW(() => listHarvestRules({ market: 'IT' }))).rules.find((r) => r.id === rule.id)!.scope.all).toBe(true)
    } finally {
      await inW(() => setLever({ productId: JACKET, market: 'IT', by: 'user:owner', reason: 'test', lever: 'harvest', level: 'AUTO' }))
    }
  })

  it('release review — R1 one market per new campaign, R9 holds by level, RS4 an exact undo of a mode', async () => {
    const db = database.client
    const who = { actor: 'user:owner', manual: true, confirmOwnLimits: true, changeSetId: null, reason: 'preview' }
    // R1 — a new campaign named for another market than its item: the item is refused, nothing is built for it.
    const other = await inW(() => previewChangeSet({ items: [{ candidateId: cid(GLOVE, 'glove liner'), to: { newCampaign: 'g1' } }], newCampaigns: [{ key: 'g1', productId: GLOVE, market: 'DE' }] }, { actor: 'PERSON', who }))
    if ('error' in other) throw new Error(other.error)
    expect(other.data.totals.ok).toBe(0)
    expect(other.data.blocked).toEqual([expect.objectContaining({ reason: expect.stringMatching(/no item of this change set is in DE/) })])
    // R9 — its holds by level: a budget above the ceiling is the person's choice; no ceiling at all is the market's.
    const big = await inW(() => previewChangeSet({ items: [{ candidateId: cid(GLOVE, 'glove liner'), to: { newCampaign: 'g1' } }], newCampaigns: [{ key: 'g1', productId: GLOVE, dailyBudgetCents: 50_000 }] }, { actor: 'PERSON', who }))
    expect('data' in big && big.data.newCampaigns).toEqual([{ key: 'g1', market: 'IT', holds: [expect.objectContaining({ level: 'choice', reason: expect.stringMatching(/spend ceiling/) })] }])
    const ceiling = await inW(() => db.adSpendCeiling.findFirstOrThrow({ where: { grain: 'MARKET', scopeId: 'IT' } }))
    await inW(() => db.adSpendCeiling.update({ where: { id: ceiling.id }, data: { enabled: false } }))
    try {
      const none = await inW(() => previewChangeSet({ items: [{ candidateId: cid(GLOVE, 'glove liner'), to: { newCampaign: 'g1' } }], newCampaigns: [{ key: 'g1', productId: GLOVE }] }, { actor: 'PERSON', who }))
      expect('data' in none && none.data.newCampaigns[0].holds).toEqual([expect.objectContaining({ level: 'market', reason: expect.stringMatching(/no daily spend ceiling/) })])
      expect('data' in none && none.data.blocked[0].reason).toMatch(/no daily spend ceiling/)
    } finally { await inW(() => db.adSpendCeiling.update({ where: { id: ceiling.id }, data: { enabled: true } })) }
    // RS4 — each result says what the rule was; the undo (with its belt) puts exactly that back.
    const mapped = (await inW(() => listHarvestRules({ market: 'IT' }))).rules.find((r) => r.name === `Mapped harvest ${hex}`)!
    const up = await inW(() => setHarvestRulesMode([mapped.id], 'ASK', 'user:owner'))
    expect(up.results[0]).toMatchObject({ ok: true, mode: 'ASK', belt: 'manual', before: { mode: 'OFF', belt: 'automate' } })
    const back = await inW(() => setHarvestRulesMode([mapped.id], up.results[0].before!.mode as 'OFF', 'user:owner', { belt: up.results[0].before!.belt }))
    expect(back.results[0]).toMatchObject({ ok: true, mode: 'OFF', belt: 'automate' })
    expect(await inW(() => db.automationRule.findUniqueOrThrow({ where: { id: mapped.id } }))).toMatchObject({ autonomyLevel: 'OFF', actions: [expect.objectContaining({ control: 'automate' })] })
    // A rule that held no Manual/Automate of its own: the undo takes the key away again.
    expect((await inW(() => setHarvestRulesMode([mapped.id], 'OFF', 'user:owner', { belt: null }))).results[0]).toMatchObject({ ok: true, belt: null })
    expect(((await inW(() => db.automationRule.findUniqueOrThrow({ where: { id: mapped.id } }))).actions as Array<Record<string, unknown>>)[0]).not.toHaveProperty('control')
  })

  it('release safety — Auto counts only when picked on the harvest path: a rule saved at Auto before asks; Ask me → Auto → Ask me → Auto', async () => {
    const db = database.client
    await inW(() => db.adKeywordProtection.create({ data: { mode: 'WHITELIST', term: `brand ${hex}` } }))
    const old = new Date(Date.now() - 30 * DAY)
    const rule = await inW(() => db.automationRule.create({ data: {
      name: `Auto harvest ${hex}`, domain: 'advertising', trigger: 'SCHEDULE', enabled: true, dryRun: true, autonomyLevel: 'PROPOSE', scopeMarketplace: 'IT',
      actions: [{ type: 'harvest_and_negate', mode: 'harvest' }], evaluationCount: 50, matchCount: 5, createdAt: old,
    } }))
    const row = async () => (await inW(() => listHarvestRules({ market: 'IT' }))).rules.find((r) => r.id === rule.id)!
    const mark = async () => ((await inW(() => db.automationRule.findUniqueOrThrow({ where: { id: rule.id } }))).actions as Array<Record<string, unknown>>)[0].harvestAuto ?? null
    // A rule saved at Auto any other way (every rule before this release): it asks, and says how to let it act.
    await inW(() => db.automationRule.update({ where: { id: rule.id }, data: { autonomyLevel: 'AUTO', dryRun: false } }))
    expect((await row()).mode).toMatchObject({ set: 'AUTO', acts: 'ASK', heldBy: { label: 'Pick Auto again', reason: expect.stringMatching(/Pick Auto again to let it act/) } })
    await inW(() => db.automationRule.update({ where: { id: rule.id }, data: { autonomyLevel: 'PROPOSE', dryRun: true } }))
    // Picked on the harvest path: the mark, and the row no longer held by it.
    const auto = await inW(() => setHarvestRulesMode([rule.id], 'AUTO', 'user:owner'))
    expect(auto.results[0]).toMatchObject({ ok: true, mode: 'AUTO' })
    expect(await mark()).toEqual({ confirmedAt: expect.any(String), by: 'user:owner' })
    expect((await row()).mode.heldBy?.label).not.toBe('Pick Auto again')
    expect(await inW(() => db.advertisingActionLog.count({ where: { entityId: rule.id, actionType: 'confirm_harvest_auto' } }))).toBe(1)
    // Ask me takes the mark away; Auto again puts it back.
    expect((await inW(() => setHarvestRulesMode([rule.id], 'ASK', 'user:owner'))).results[0]).toMatchObject({ ok: true })
    expect(await mark()).toBeNull()
    expect((await inW(() => setHarvestRulesMode([rule.id], 'AUTO', 'user:owner'))).results[0]).toMatchObject({ ok: true })
    expect(await mark()).toEqual({ confirmedAt: expect.any(String), by: 'user:owner' })
    // Functional walk (MUST) — a rule saved at Auto before: picking Auto again IS the pick (the mark, audited), not "no change".
    await inW(() => db.automationRule.update({ where: { id: rule.id }, data: { actions: [{ type: 'harvest_and_negate', mode: 'harvest' }], autonomyLevel: 'AUTO', dryRun: false } }))
    expect((await row()).mode.heldBy).toMatchObject({ label: 'Pick Auto again' })
    expect((await inW(() => setHarvestRulesMode([rule.id], 'AUTO', 'user:owner'))).results[0]).toMatchObject({ ok: true, mode: 'AUTO', before: { mode: 'AUTO' } })
    expect(await mark()).toEqual({ confirmedAt: expect.any(String), by: 'user:owner' })
    expect((await row()).mode.heldBy?.label).not.toBe('Pick Auto again')
    expect(await inW(() => db.advertisingActionLog.count({ where: { entityId: rule.id, actionType: 'confirm_harvest_auto' } }))).toBe(3)
    // Plain words, never a server variable: Amazon in test mode holds Auto up front and in a refused pick.
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'sandbox')
    try {
      await inW(() => db.automationRule.update({ where: { id: rule.id }, data: { actions: [{ type: 'harvest_and_negate', mode: 'harvest' }] } }))
      expect((await row()).mode.heldBy).toEqual({ kind: 'gate', label: 'Amazon test mode', reason: 'Auto is off while Amazon runs in test mode.' })
      const refused = await inW(() => setHarvestRulesMode([rule.id], 'AUTO', 'user:owner'))
      expect(refused.results[0]).toMatchObject({ ok: false, error: 'Auto is off while Amazon runs in test mode.' })
      expect(await mark()).toBeNull()
      await inW(() => setHarvestRulesMode([rule.id], 'ASK', 'user:owner'))
      expect((await row()).mode.autoLocked).toEqual({ kind: 'gate', label: 'Amazon test mode', reason: 'Auto is off while Amazon runs in test mode.' })
      const fresh = await inW(() => setHarvestRulesMode([rule.id], 'AUTO', 'user:owner'))
      expect(fresh.results[0]).toMatchObject({ ok: false, error: 'Auto is off while Amazon runs in test mode.' })
      expect(JSON.stringify(fresh)).not.toMatch(/NEXUS_|Railway/)
    } finally { vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live') }
    // From Off, Auto that cannot be picked is said before the click.
    await inW(() => setHarvestRulesMode([rule.id], 'OFF', 'user:owner'))
    expect((await row()).mode).toMatchObject({ set: 'OFF', autoLocked: { label: 'Turn on first' } })
    // Delta review D1 — an Undo puts the level AND the mark back exactly: a rule saved at Auto before (no mark) → Ask me →
    // Undo is Auto WITHOUT the mark (it still asks); a fresh Auto pick → Ask me → Undo is Auto WITH it.
    await inW(() => db.automationRule.update({ where: { id: rule.id }, data: { actions: [{ type: 'harvest_and_negate', mode: 'harvest' }], autonomyLevel: 'AUTO', enabled: true, dryRun: false } }))
    const toAsk = (await inW(() => setHarvestRulesMode([rule.id], 'ASK', 'user:owner'))).results[0]
    expect(toAsk).toMatchObject({ ok: true, before: { mode: 'AUTO', belt: null, marked: false } })
    const undo = (await inW(() => setHarvestRulesMode([rule.id], toAsk.before!.mode as 'AUTO', 'user:owner', { belt: toAsk.before!.belt, marked: toAsk.before!.marked }))).results[0]
    expect(undo).toMatchObject({ ok: true, mode: 'AUTO', marked: false })
    expect(await mark()).toBeNull()
    expect((await row()).mode).toMatchObject({ set: 'AUTO', acts: 'ASK', heldBy: { label: 'Pick Auto again' } })
    expect((await inW(() => setHarvestRulesMode([rule.id], 'AUTO', 'user:owner'))).results[0]).toMatchObject({ ok: true, marked: true })
    const toAsk2 = (await inW(() => setHarvestRulesMode([rule.id], 'ASK', 'user:owner'))).results[0]
    expect(toAsk2.before).toEqual({ mode: 'AUTO', belt: null, marked: true })
    await inW(() => setHarvestRulesMode([rule.id], 'AUTO', 'user:owner', { belt: toAsk2.before!.belt, marked: toAsk2.before!.marked }))
    expect(await mark()).toEqual({ confirmedAt: expect.any(String), by: 'user:owner' })
    // Archive answers what it was too: its undo (unarchive, then the mode with that `before`) never adds a mark.
    await inW(() => db.automationRule.update({ where: { id: rule.id }, data: { actions: [{ type: 'harvest_and_negate', mode: 'harvest' }] } }))
    const archived = await inW(() => setHarvestRuleArchived(rule.id, true, 'user:owner'))
    expect('data' in archived && archived.data.before).toEqual({ mode: 'AUTO', belt: null, marked: false })
    await inW(() => setHarvestRuleArchived(rule.id, false, 'user:owner'))
    const was = 'data' in archived ? archived.data.before : null
    // (From Off the level dial wants it on first — the gate's own words; either way no mark is ever added.)
    const back = (await inW(() => setHarvestRulesMode([rule.id], was!.mode as 'AUTO', 'user:owner', { belt: was!.belt, marked: was!.marked }))).results[0]
    expect(back.ok ? back.marked : back.error).toBe(back.ok ? false : 'Auto is for a rule that runs: pick Watch or Ask me first.')
    expect(await mark()).toBeNull()
    await inW(() => setHarvestRulesMode([rule.id], 'OFF', 'user:owner'))
  })

  it('another business sees no candidate and no record', async () => {
    // It reads no Amazon Ads account in IT: the market is said (L3), and nothing of the first business shows.
    const got = await inW2(() => harvestCandidates({ market: 'IT', state: ['all'] }))
    expect('error' in got ? got.status : got.data.rows).toEqual('error' in got ? 400 : [])
    expect(await inW2(() => database.client.adsBrainHarvest.findMany())).toEqual([])
  })
})

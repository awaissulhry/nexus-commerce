/**
 * Negative Targeting page — the stop-waste rules on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business profiles
 * ON), the ads mode LIVE, the job queue a stub: nothing leaves the process. One made-up jacket in IT — an exact, a broad
 * and an auto campaign — and a campaign it shares with a glove; the IT strategy's 25 % target, a protected term.
 *
 *   contexts   late-order safe and stock-out days left out: a keyword whose order came yesterday is saved, clicks of the
 *              last 3 days do not count, clicks on days the product was out of stock do not count; only rows that pass
 *              the test (0 orders, clicks ≥ max(20, 3 ÷ the campaign's conversion), spend ≥ 2 × the target cost per order)
 *   D1 run     a keyword-pause rule on Auto through the evaluator's real pass: 10 pauses for the jacket today (one was made
 *              earlier), the rest ask with the cap's words; the never-list asks (young keyword, protected term, shared
 *              campaign); every change through the real pause handler and status path, as the rule
 *   negatives  the search-term test and the never-list for negatives (protected term, our own keyword there)
 *   scope      a rule saved on ONE ad group: stored with its campaign, born at Watch; the evaluator's pass and Simulate
 *              act on that ad group only; a mismatched campaign or a missing ad group refused
 *   reads      the rules list (the brain and Harvest first, read only; kind, test, ad-group grain, "Auto inside caps"),
 *              a rule's history with its undo handles, the preview of an unsaved body; another business sees nothing
 *   writes     the mode through the level dial (Auto refused before the gate opens; the pseudo-rows refused); archive and
 *              restore; Claude's save of a keyword-pause rule (D4) — born OBSERVE, scoped to an ad group, never by rule
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
vi.mock('../ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined,
}))

await import('../automation-action-handlers.js')
const { buildStopWasteContexts } = await import('./contexts.js')
const { applyMarketplaceScope, simulateOneRule, buildTargetPerformanceContexts } = await import('../../../jobs/advertising-rule-evaluator.job.js')
const { saveWasteRule, setWasteRulesMode, setWasteRuleArchived } = await import('./write.js')
const { listWasteRules, wasteRuleHistory } = await import('./read.js')
const { previewWasteRule } = await import('./preview.js')
const { openStopWasteGate, stopWasteParamsOf, NOT_PAGE_SHAPE } = await import('../ads-graduation-stopwaste.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')
const { planAdRuleSave, applyAdRuleSave } = await import('../../automation/ad-rule-save.service.js')
const { AUTOMATION_CHANGE_TOOLS } = await import('../../agents/tools/automation-change.tools.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `nr_waste_${hex}`
const W2 = `nr_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const id = (s: string) => `${hex}-${s}`
const C = (s: string) => id(`c-${s}`)
const G = (s: string) => `g-${C(s)}`
const T = (s: string) => id(`t-${s}`)
const JACKET = id('jacket'), JACKET_M = id('jacket-m'), GLOVE = id('glove'), GLOVE_L = id('glove-l')
const DAY = 86_400_000
const daysAgo = (n: number) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return new Date(d.getTime() - n * DAY) }
const OLD = daysAgo(120)
const ACTOR = 'user:owner' as never
const WASTE = Array.from({ length: 12 }, (_, i) => `w${String(i + 1).padStart(2, '0')}`)
type Data = Record<string, any>

async function seed() {
  const db = database.client as any
  const product = (pid: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: pid, sku, name: sku, basePrice: '80.00', totalStock: 5, ...extra } })
  await product(JACKET, `NR-JACKET-${hex}`, { isParent: true })
  await product(JACKET_M, `NR-JACKET-M-${hex}`, { parentId: JACKET, amazonAsin: `B0NRJK${H}00` })
  await product(GLOVE, `NR-GLOVE-${hex}`, { isParent: true, basePrice: '30.00' })
  await product(GLOVE_L, `NR-GLOVE-L-${hex}`, { parentId: GLOVE, amazonAsin: `B0NRGL${H}00`, basePrice: '30.00' })
  const jacket: [string, string] = [JACKET_M, `B0NRJK${H}00`]
  const glove: [string, string] = [GLOVE_L, `B0NRGL${H}00`]
  const campaign = async (key: string, ads: Array<[string, string]>, targeting = 'MANUAL', marketplace = 'IT') => {
    await db.campaign.create({ data: { id: C(key), name: `NR ${key}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace, externalCampaignId: `EXT-${C(key)}`, dailyBudget: '20.00', startDate: OLD, createdAt: OLD, liveBidWritesEnabled: true, targetingType: targeting } })
    await db.adGroup.create({ data: { id: G(key), campaignId: C(key), name: `NR ${key} group`, externalAdGroupId: `EXT-${G(key)}`, createdAt: OLD } })
    for (const [productId, asin] of ads) await db.adProductAd.create({ data: { adGroupId: G(key), productId, asin } })
  }
  const kw = (key: string, t: string, text: string, createdAt = OLD, match = 'EXACT') =>
    db.adTarget.create({ data: { id: T(t), adGroupId: G(key), kind: 'KEYWORD', expressionType: match, expressionValue: text, bidCents: 50, externalTargetId: `EXT-${T(t)}`, createdAt } })
  const perfRow = (entityType: string, localEntityId: string, ago: number, m: { clicks: number; orders?: number; costCents?: number; salesCents?: number }) =>
    db.amazonAdsDailyPerformance.create({
      data: {
        profileId: 'P-IT', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: daysAgo(ago), entityType, entityId: `EXT-${localEntityId}`, localEntityId,
        currencyCode: 'EUR', reportedAt: new Date(), clicks: m.clicks, impressions: m.clicks * 20, costMicros: BigInt((m.costCents ?? 0) * 10_000),
        sales7dCents: m.salesCents ?? 0, orders7d: m.orders ?? 0,
      },
    })
  const waste = (t: string) => perfRow('AD_TARGET', T(t), 10, { clicks: 80, costCents: 5000 })
  await campaign('jk-exact', [jacket])
  await campaign('jk-broad', [jacket])
  await campaign('jk-auto', [jacket], 'AUTO')
  await campaign('shared', [jacket, glove])
  // An ad Nexus cannot tie to any product: no single product owns this campaign (review M2).
  await campaign('orphan', [[null as unknown as string, `B0NRZZ${H}00`]])
  // The jacket in Germany too (no data): a rule on the jacket reaches two markets.
  await campaign('jk-de', [jacket], 'MANUAL', 'DE')
  for (const [i, w] of WASTE.entries()) { await kw('jk-exact', w, `waste keyword ${i + 1}`); await waste(w) }
  await kw('jk-exact', 'young', 'young keyword', daysAgo(5)); await waste('young')
  await kw('jk-exact', 'acme', 'acme jacket'); await waste('acme')
  await kw('jk-broad', 'broad', 'broad waste'); await waste('broad')
  await kw('shared', 'shared', 'shared waste'); await waste('shared')
  await kw('orphan', 'orphan', 'orphan waste'); await waste('orphan')
  // Late-order safe: an order that came yesterday saves it (the settled window would have stopped it).
  await kw('jk-exact', 'sold', 'late order keyword'); await waste('sold'); await perfRow('AD_TARGET', T('sold'), 1, { clicks: 0, orders: 1, salesCents: 8000 })
  // Clicks of the last 3 days do not count yet: 40 counted, 40 recent ones not — under the clicks bar.
  await kw('jk-exact', 'recent', 'recent clicks keyword'); await perfRow('AD_TARGET', T('recent'), 10, { clicks: 40, costCents: 4500 }); await perfRow('AD_TARGET', T('recent'), 1, { clicks: 40, costCents: 500 })
  // Days out of stock are left out: 30 of its clicks came while the jacket was out of stock.
  await kw('jk-exact', 'stock', 'stock out keyword'); await perfRow('AD_TARGET', T('stock'), 10, { clicks: 50, costCents: 4500 }); await perfRow('AD_TARGET', T('stock'), 22, { clicks: 30, costCents: 2000 })
  await kw('jk-exact', 'winner', 'winner keyword'); await perfRow('AD_TARGET', T('winner'), 10, { clicks: 100, orders: 10, costCents: 5000, salesCents: 80_000 })
  await db.stockoutEvent.create({ data: { productId: JACKET_M, sku: `NR-JACKET-M-${hex}`, startedAt: daysAgo(24), endedAt: daysAgo(20), detectedBy: 'cron', velocityAtStart: '1.00' } })
  // Search terms of the auto campaign (Amazon's ids). Our broad keyword there has a term's words.
  await kw('jk-auto', 'own', 'auto own term', OLD, 'BROAD')
  const term = (query: string, ago: number, clicks: number, orders: number, costCents: number) => ({
    profileId: 'P-IT', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: daysAgo(ago), campaignId: `EXT-${C('jk-auto')}`, adGroupId: `EXT-${G('jk-auto')}`,
    query, impressions: clicks * 7, clicks, costMicros: BigInt(costCents) * 10_000n, currencyCode: 'EUR', sales7dCents: orders * 8000, orders7d: orders,
  })
  await db.amazonAdsSearchTerm.createMany({
    data: [
      term('cheap jacket', 10, 80, 0, 5000), term('giacca acme', 10, 80, 0, 5000), term('auto own term', 10, 80, 0, 5000),
      term('storm jacket', 10, 80, 0, 5000), term('storm jacket', 1, 0, 1, 0),
      term('jacket', 10, 300, 30, 9000),
    ],
  })
  await db.adsStrategy.create({ data: { channel: 'AMAZON', market: 'IT', level: 'MARKET', scopeId: '*', label: 'IT', targetKind: 'ACOS', targetPct: 25, targetHiPct: 30, updatedBy: 'user:owner' } })
  await db.adKeywordProtection.create({ data: { mode: 'WHITELIST', term: 'acme', matchType: 'CONTAINS', marketplace: 'IT', reason: 'brand' } })
  // S9 — a person skipped one wasting keyword for 7 days. S10 — Harvest's source negative of another one's text stands in
  // another of the jacket's ad groups (that keyword is Harvest's home for the search).
  await db.adsWasteSkip.create({ data: { rowKey: `kw:${T('w12')}`, until: new Date(Date.now() + 7 * DAY), by: 'user:owner' } })
  await db.adTarget.create({ data: { id: T('harvest-neg'), adGroupId: G('jk-broad'), kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'waste keyword 11', bidCents: 0, isNegative: true, negativeLevel: 'AD_GROUP', negativeOrigin: 'HARVEST', externalTargetId: `EXT-${T('harvest-neg')}`, createdAt: OLD } })
  await db.amazonAdsConnection.create({ data: { profileId: `P-IT-${hex}`, marketplace: 'IT', region: 'EU', mode: 'production', writesEnabledAt: new Date(), isActive: true } })
  await setAutonomy('AUTO', 'test')
}

const PAUSE_PARAMS = { kind: 'PAUSE_KEYWORD' as const, windowDays: 60, minClicks: 20, cpaMultiple: 2, spendFloorCents: 3000 }
const NEGATE_PARAMS = { kind: 'NEGATE_TERM' as const, windowDays: 60, minClicks: 20, cpaMultiple: 1.5, spendFloorCents: 1500 }
const textOf = (c: Data) => String(c.adTarget?.expressionValue ?? c.searchTerm?.query)

describe.skipIf(!concurrentDatabaseUrl())('Negative Targeting — stop-waste rules (real PostgreSQL)', { timeout: 240_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(seed)
  }, 240_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('contexts: the page\'s one test — late-order safe, stock-out days left out, only rows whose verdict is met', async () => {
    const ctx = await inW(() => buildStopWasteContexts(PAUSE_PARAMS)) as Data[]
    expect(ctx.map(textOf).sort()).toEqual([
      'acme jacket', 'broad waste', 'orphan waste', 'shared waste', ...WASTE.map((_, i) => `waste keyword ${i + 1}`), 'young keyword',
    ].sort())
    const one = ctx.find((c) => c.adTarget.id === T('w01'))!
    // The jacket's pooled order value × the IT strategy's 25 % is its target cost per order; a keyword's bar is two of them.
    expect(one.stopWaste).toMatchObject({ kind: 'PAUSE_KEYWORD', windowDays: 60, clicks: 80, orders: 0, spendCents: 5000, stockOutDays: 5, xCpaBar: 2, source: 'rule' })
    expect(one.stopWaste.spendBarCents).toBe(2 * one.stopWaste.targetCpaCents)
    // Three expected orders at the jacket's pooled conversion: more than the 50 clicks the stock-out keyword kept, at most 80.
    expect(one.stopWaste.clicksNeeded).toBeGreaterThan(50)
    expect(one.stopWaste.clicksNeeded).toBeLessThanOrEqual(80)
    expect(one.stopWaste.sentence).toMatch(/^Wastes: 0 orders, 80 clicks of \d+, spend past the bar in 60 days; 5 days out of stock left out\. Bar: the rule "Stop waste": 0 orders, \d+ clicks or more \(at the product's pooled/)
    expect(one).toMatchObject({ trigger: 'TARGET_PERFORMANCE', marketplace: 'IT', campaign: { id: C('jk-exact') }, adGroup: { id: G('jk-exact') }, adTarget: { orders: 0, clicks: 80, spendCents: 5000 } })
    expect(one.adTarget.acos).toBeUndefined()
    const terms = await inW(() => buildStopWasteContexts(NEGATE_PARAMS)) as Data[]
    expect(terms.map(textOf).sort()).toEqual(['auto own term', 'cheap jacket', 'giacca acme'])
    const cheap = terms.find((c) => textOf(c) === 'cheap jacket')!
    expect(cheap).toMatchObject({ trigger: 'SEARCH_TERM_WASTING', searchTerm: { externalAdGroupId: `EXT-${G('jk-auto')}`, orders: 0, clicks: 80 }, stopWaste: { xCpaBar: 1.5, source: 'rule' } })
    expect(cheap.stopWaste.spendBarCents).toBe(Math.round(1.5 * cheap.stopWaste.targetCpaCents))
  })

  let scoped: Data
  it('scope: a rule on ONE ad group is stored with its campaign and born at Watch; mismatches refused', async () => {
    const out = await inW(() => saveWasteRule({ body: { kind: 'PAUSE_KEYWORD', name: 'NR broad only', scope: { adGroupId: G('jk-broad') } } }, ACTOR))
    expect('data' in out).toBe(true)
    scoped = (out as { data: Data }).data
    // N4 — a scope inside one market stores that market, so every reader (the tab counts too) shows it there only.
    expect(scoped).toMatchObject({ created: true, level: 'OBSERVE', scope: { adGroupId: G('jk-broad'), campaignId: C('jk-broad'), marketplace: 'IT' } })
    const [rule] = await rows<Data>('SELECT trigger, "scopeMarketplace", "scopeAdGroupId", "scopeCampaignId", "autonomyLevel", enabled, "dryRun" FROM "AutomationRule" WHERE id = $1', [scoped.id])
    expect(rule).toEqual({ trigger: 'TARGET_PERFORMANCE', scopeMarketplace: 'IT', scopeAdGroupId: G('jk-broad'), scopeCampaignId: C('jk-broad'), autonomyLevel: 'OBSERVE', enabled: true, dryRun: true })
    // A rule on the jacket reaches IT and DE: it keeps no market of its own and is counted in each.
    const both = await inW(() => saveWasteRule({ body: { kind: 'NEGATE_TERM', name: 'NR jacket everywhere', scope: { productId: JACKET } } }, ACTOR)) as { data: Data }
    expect((await rows<Data>('SELECT "scopeMarketplace" FROM "AutomationRule" WHERE id = $1', [both.data.id]))[0].scopeMarketplace).toBeNull()
    for (const m of ['IT', 'DE']) expect((await inW(() => listWasteRules({ market: m }))).rules.map((r) => r.id)).toContain(both.data.id)
    expect((await inW(() => listWasteRules({ market: 'DE' }))).rules.map((r) => r.id)).not.toContain(scoped.id)
    await inW(() => setWasteRuleArchived(both.data.id, true, ACTOR))
    expect((await rows<Data>('SELECT "actionType" FROM "AdvertisingActionLog" WHERE "entityId" = $1 ORDER BY "createdAt"', [scoped.id])).map((r) => r.actionType)).toEqual(['create_rule', 'update_rule'])
    expect(await inW(() => saveWasteRule({ body: { kind: 'PAUSE_KEYWORD', scope: { adGroupId: G('jk-broad'), campaignId: C('jk-exact') } } }, ACTOR))).toMatchObject({ status: 400, error: expect.stringMatching(/belongs to campaign/) })
    expect(await inW(() => saveWasteRule({ body: { kind: 'PAUSE_KEYWORD', scope: { adGroupId: 'nope' } } }, ACTOR))).toMatchObject({ status: 400, error: expect.stringMatching(/not found/) })

    // The evaluator's pass and Simulate act on that ad group only.
    const ctx = await inW(() => buildStopWasteContexts(PAUSE_PARAMS))
    const pass = await inW(() => applyMarketplaceScope('TARGET_PERFORMANCE', ctx, false, (r) => r.id === scoped.id))
    expect(pass.evaluations).toBe(1)
    const runs = await rows<Data>('SELECT "triggerData", "dryRun" FROM "AutomationRuleExecution" WHERE "ruleId" = $1', [scoped.id])
    expect(runs.map((r) => r.triggerData.adGroup.id)).toEqual([G('jk-broad')])
    expect(runs[0].dryRun).toBe(true)
    expect(await inW(() => simulateOneRule(scoped.id))).toMatchObject({ ok: true, contextsInScope: 1, matched: 1 })
  })

  let auto: Data
  it('M1: an older Auto rule with only a pause and no stop-waste test acts on nothing alone — every change asks', async () => {
    const old = await inW(() => (database.client as any).automationRule.create({ data: {
      name: 'NR old pause rule', domain: 'advertising', trigger: 'TARGET_PERFORMANCE', enabled: true, dryRun: false, autonomyLevel: 'AUTO',
      conditions: [{ field: 'adTarget.orders', op: 'eq', value: 0 }, { field: 'adTarget.clicks', op: 'gte', value: 20 }],
      actions: [{ type: 'pause_target' }], maxExecutionsPerDay: 500, createdBy: 'user',
    } }))
    const ctx = await inW(() => buildTargetPerformanceContexts())
    const pass = await inW(() => applyMarketplaceScope('TARGET_PERFORMANCE', ctx, false, (r) => r.id === old.id))
    expect(pass.evaluations).toBeGreaterThan(10)
    expect(await rows('SELECT id FROM "AdvertisingActionLog" WHERE "userId" = $1', [`automation:${old.id}`])).toEqual([])
    const runs = await rows<Data>('SELECT "dryRun", "triggerData" FROM "AutomationRuleExecution" WHERE "ruleId" = $1', [old.id])
    // One run per matched context (a keyword with orders does not match its conditions and leaves no run).
    expect(runs.length).toBe(pass.matches)
    expect(runs.length).toBeGreaterThan(10)
    expect(runs.every((r) => r.dryRun && r.triggerData.stopWaste.asks === NOT_PAGE_SHAPE)).toBe(true)
    await database.pool.query('UPDATE "AutomationRule" SET enabled = false, "autonomyLevel" = \'OFF\' WHERE id = $1', [old.id])
  })

  it('D1: the page\'s Auto keyword-pause rule acts alone up to 10 pauses for the jacket today, then asks; the never-list asks', async () => {
    const out = await inW(() => saveWasteRule({ body: { kind: 'PAUSE_KEYWORD', name: 'NR stop waste IT', scope: { marketplace: 'IT' } } }, ACTOR))
    auto = (out as { data: Data }).data
    // On Auto (the dial's gate is the Owner's click after 14 days; set here directly), and one pause made earlier today.
    await database.pool.query('UPDATE "AutomationRule" SET "autonomyLevel" = \'AUTO\', "dryRun" = false WHERE id = $1', [auto.id])
    await inW(() => (database.client as any).automationRuleExecution.create({ data: {
      ruleId: auto.id, dryRun: false, status: 'SUCCESS', startedAt: new Date(),
      triggerData: { marketplace: 'IT', adGroup: { id: G('jk-exact') }, adTarget: { id: T('winner') } },
      actionResults: [{ type: 'pause_target', ok: true, output: { adTargetId: T('winner'), status: 'PAUSED', from: 'ENABLED' } }],
    } }))
    const ctx = await inW(() => buildStopWasteContexts(PAUSE_PARAMS))
    const pass = await inW(() => applyMarketplaceScope('TARGET_PERFORMANCE', ctx, false, (r) => r.id === auto.id))
    expect(pass.evaluations).toBe(17)
    const paused = await rows<Data>('SELECT "entityId" FROM "AdvertisingActionLog" WHERE "userId" = $1 AND "actionType" = \'AD_ENTITY_STATE_UPDATE\'', [`automation:${auto.id}`])
    // The cap is reserved with each change (S11): 1 earlier + 9 now = 10, never more.
    expect(paused).toHaveLength(9)
    expect(paused.every((p) => [...WASTE.slice(0, 10).map(T), T('broad')].includes(p.entityId))).toBe(true)
    const asked = await rows<Data>('SELECT "triggerData" FROM "AutomationRuleExecution" WHERE "ruleId" = $1 AND "triggerData" -> \'stopWaste\' ? \'asks\'', [auto.id])
    const why = asked.map((a) => `${a.triggerData.adTarget.expressionValue}: ${a.triggerData.stopWaste.asks}`).sort()
    expect(why.filter((w) => /reached its 10 keyword pauses for today/.test(w))).toHaveLength(2)
    expect(why.find((w) => w.startsWith('young keyword'))).toMatch(/5 days old: a keyword gets 30 days/)
    expect(why.find((w) => w.startsWith('acme jacket'))).toMatch(/protected term "acme"/)
    expect(why.find((w) => w.startsWith('shared waste'))).toMatch(/Several products share this campaign/)
    expect(why.find((w) => w.startsWith('orphan waste'))).toMatch(/No single product owns this campaign/)
    expect(why.find((w) => w.startsWith('waste keyword 12'))).toMatch(/^waste keyword 12: Skipped by you until/)
    expect(why.find((w) => w.startsWith('waste keyword 11'))).toMatch(/Harvest made this keyword/)
    expect(asked).toHaveLength(8)
    // Each ask ran as Ask me (a dry run that proposes; its card is written after the run, outside this test's business
    // scope); nothing it asked was paused.
    expect((await rows<Data>('SELECT count(*)::int AS n FROM "AutomationRuleExecution" WHERE "ruleId" = $1 AND "dryRun" AND "triggerData" -> \'stopWaste\' ? \'asks\'', [auto.id]))[0].n).toBe(8)
    expect((await rows<Data>('SELECT status::text FROM "AdTarget" WHERE id = $1', [T('acme')]))[0].status).toBe('ENABLED')
  })

  it('negatives: the never-list holds a protected term and a term that is our own keyword there', async () => {
    const gate = await inW(() => openStopWasteGate([{ id: 'neg', actions: [{ type: 'add_negative_exact', stopWaste: NEGATE_PARAMS }] }], { asIfAuto: true }))
    const ctx = await inW(() => buildStopWasteContexts(NEGATE_PARAMS)) as Data[]
    const verdict = Object.fromEntries(await inW(async () => Promise.all(ctx.map(async (c) => [textOf(c), (await gate!.split(['neg'], c)).ask[0]?.why ?? 'alone'] as const))))
    expect(verdict).toEqual({
      'cheap jacket': 'alone',
      'giacca acme': expect.stringMatching(/protected term "acme"/),
      'auto own term': expect.stringMatching(/keyword of ours where the negative would land/),
    })
  })

  it('preview: an unsaved body says what it would stop, what would ask and why — no amount in words, nothing written', async () => {
    const before = await rows<Data>('SELECT (SELECT count(*)::int FROM "AutomationRuleExecution") e, (SELECT count(*)::int FROM "AdvertisingActionLog") l, (SELECT count(*)::int FROM "AutomationRule") r')
    const out = await inW(() => previewWasteRule({ rule: { kind: 'PAUSE_KEYWORD', scope: { marketplace: 'IT' } } })) as { data: Data }
    // The 9 keywords the Auto rule paused are no longer offered: 2 jacket keywords act alone; the skipped, Harvest's, the
    // young, protected, shared and unowned ones ask.
    expect(out.data).toMatchObject({ saved: false, engine: 'stop-waste', windowDays: 60, wouldChange: 8, wouldAsk: 6 })
    expect(out.data.sample[0]).toMatchObject({ action: 'PAUSE', alone: true, asks: null, adGroup: { id: expect.any(String) }, campaign: { id: expect.any(String) } })
    // No amount in words (a conversion rate in % is not money).
    expect(out.data.sample.every((s: Data) => !/€|\d+[.,]\d{2}(?!\d*\s*%)/.test(`${s.why} ${s.asks ?? ''}`))).toBe(true)
    const one = await inW(() => previewWasteRule({ rule: { kind: 'NEGATE_TERM', scope: { adGroupId: G('jk-auto') } } })) as { data: Data }
    expect(one.data.sample.map((s: Data) => [s.row.name, s.action, s.alone])).toEqual(expect.arrayContaining([['cheap jacket', 'NEGATE_EXACT', true], ['giacca acme', 'NEGATE_EXACT', false]]))
    // A campaign-wide negative is saved, but never acts alone (S1): every row asks.
    const wide = await inW(() => previewWasteRule({ rule: { kind: 'NEGATE_TERM', level: 'CAMPAIGN', scope: { adGroupId: G('jk-auto') } } })) as { data: Data }
    expect(wide.data.sample.every((s: Data) => !s.alone && s.asks === NOT_PAGE_SHAPE)).toBe(true)
    expect(await rows('SELECT (SELECT count(*)::int FROM "AutomationRuleExecution") e, (SELECT count(*)::int FROM "AdvertisingActionLog") l, (SELECT count(*)::int FROM "AutomationRule") r')).toEqual(before)
    expect(await inW(() => previewWasteRule({ ruleId: 'brain' }))).toMatchObject({ status: 400 })
  })

  it('reads: the list (pseudo-rows first, read only), a rule\'s history with undo handles; another business sees nothing', async () => {
    const list = await inW(() => listWasteRules({ market: 'IT' }))
    expect(list.rules.slice(0, 2).map((r) => [r.id, r.source, r.readOnly])).toEqual([['brain', 'brain', true], ['harvest', 'harvest', true]])
    // Plain words (audit M8): no "enrolled", "funnel", "isolation", "live-change", "refused" in what the rows say.
    expect(list.rules[0].sentence).toBe('The Brain\'s negatives for its products — kept by the Brain')
    const said = JSON.stringify(list.rules.map((r) => [r.sentence, r.mode]))
    expect(said).not.toMatch(/enrolled|funnel|isolation|live-change|refused|never-list|Always asks/)
    const a = list.rules.find((r) => r.id === auto.id)!
    expect(a).toMatchObject({ kind: 'PAUSE_KEYWORD', source: 'rule', test: PAUSE_PARAMS, mode: { set: 'AUTO', acts: 'AUTO' }, changed7d: { paused: 9, negated: 0 } })
    expect(a.mode.also.map((h) => h.label)).toContain('Auto inside caps')
    expect(a.last7d.askedByCaps).toBe(8)
    const s = list.rules.find((r) => r.id === scoped.id)!
    expect(s).toMatchObject({ mode: { set: 'WATCH' }, scope: { all: false, adGroup: { id: G('jk-broad'), name: 'NR jk-broad group' } } })
    // S13 — a rule on one IT ad group (no market of its own) is an IT rule: it reads IT and never shows in another market.
    expect(s.market).toBe('IT')
    const de = await inW(() => listWasteRules({ market: 'DE' }))
    expect(de.rules.map((r) => r.id)).not.toContain(scoped.id)
    expect(de.rules.map((r) => r.id)).not.toContain(auto.id)
    expect(de.totals.otherMarkets).toBeGreaterThanOrEqual(2)
    expect(s.mode.autoLocked).toMatchObject({ label: expect.stringMatching(/^Auto from /) })
    const history = await inW(() => wasteRuleHistory(auto.id, { days: 7 })) as { data: Data }
    expect(history.data.changes).toHaveLength(9)
    expect(history.data.changes[0]).toMatchObject({ action: 'paused', to: 'PAUSED', who: { kind: 'rule', id: auto.id }, changeId: expect.any(String), undoBlocked: null })
    const other = await inW2(() => listWasteRules({ market: 'IT' }))
    expect(other.rules.map((r) => r.id)).toEqual(['brain', 'harvest'])
    expect(await inW2(() => wasteRuleHistory(auto.id, {}))).toMatchObject({ status: 404 })
  })

  it('writes: the mode through the dial (Auto waits for its gate; the pseudo-rows refused), edits drop Auto to Ask me, archive and restore', async () => {
    const mode = await inW(() => setWasteRulesMode([scoped.id, 'brain'], 'AUTO', ACTOR))
    expect(mode.data.results).toEqual([
      { id: scoped.id, ok: false, error: expect.stringMatching(/graduation gate/) },
      { id: 'brain', ok: false, error: expect.stringMatching(/never changed here/) },
    ])
    expect((await inW(() => setWasteRulesMode([scoped.id], 'ASK', ACTOR))).data.results).toEqual([{ id: scoped.id, ok: true, level: 'PROPOSE' }])
    const edit = await inW(() => saveWasteRule({ id: auto.id, body: { minClicks: 25 } }, ACTOR)) as { data: Data }
    expect(edit.data).toMatchObject({ created: false, level: 'PROPOSE' })
    expect(stopWasteParamsOf((await rows<Data>('SELECT actions FROM "AutomationRule" WHERE id = $1', [auto.id]))[0].actions)).toMatchObject({ minClicks: 25 })
    const archived = await inW(() => setWasteRuleArchived(auto.id, true, ACTOR)) as { data: Data }
    expect(archived.data).toMatchObject({ id: auto.id, archived: true, already: false, level: 'OFF', expiredAsks: expect.any(Number) })
    expect((await rows<Data>('SELECT count(*)::int AS n FROM "AdsRuleSuggestion" WHERE "ruleId" = $1 AND status = \'pending\'', [auto.id]))[0].n).toBe(0)
    expect((await inW(() => listWasteRules({ market: 'IT' }))).rules.find((r) => r.id === auto.id)).toMatchObject({ archived: true, mode: { set: 'OFF' } })
    expect(await inW(() => setWasteRulesMode([auto.id], 'WATCH', ACTOR))).toMatchObject({ data: { results: [{ ok: false, error: expect.stringMatching(/archived/) }] } })
    expect(await inW(() => setWasteRuleArchived(auto.id, false, ACTOR))).toMatchObject({ data: { archived: false, level: 'OFF' } })
  })

  it('D4: Claude may save a keyword-pause rule — born OBSERVE, on one ad group, and never saved by the business\'s rule', async () => {
    const input = {
      kind: 'amazon-ads' as const, name: 'NR Claude pause', trigger: 'TARGET_PERFORMANCE',
      conditions: [{ field: 'adTarget.orders', op: 'eq', value: 0 }, { field: 'adTarget.clicks', op: 'gte', value: 20 }],
      actions: [{ type: 'pause_target', keepPaused: true, stopWaste: PAUSE_PARAMS }],
      scope: { adGroupId: G('jk-exact') }, caps: { maxExecutionsPerDay: 100, maxWritesPerDay: 10, maxValueCentsEur: 1000 },
    }
    const plan = await inW(() => planAdRuleSave(input))
    expect(plan).toMatchObject({ ok: true, plan: { pausesKeywords: true, level: { to: 'OBSERVE' }, scope: { adGroupId: G('jk-exact'), campaignId: C('jk-exact'), marketplace: 'IT' }, effect: expect.stringMatching(/always waits for a person/) } })
    const tool = AUTOMATION_CHANGE_TOOLS.find((t) => t.name === 'save-ad-rule')!
    expect(tool.withinLimits!({ pausesKeywords: true }, {})).toMatch(/a person approves its save/)
    const saved = await inW(() => applyAdRuleSave(input, 'owner'))
    expect(saved).toMatchObject({ ok: true, level: 'OBSERVE', after: { scope: { adGroupId: G('jk-exact'), campaignId: C('jk-exact') } } })
    const [rule] = await rows<Data>('SELECT "scopeMarketplace", "scopeAdGroupId", "autonomyLevel" FROM "AutomationRule" WHERE id = $1', [(saved as Data).ruleId])
    expect(rule).toEqual({ scopeMarketplace: 'IT', scopeAdGroupId: G('jk-exact'), autonomyLevel: 'OBSERVE' })
    // Unpausing stays refused for Claude's rules.
    expect(await inW(() => planAdRuleSave({ ...input, actions: [{ type: 'enable_target' }] }))).toMatchObject({ ok: false, error: expect.stringMatching(/enable_target: refused/) })
  })
})

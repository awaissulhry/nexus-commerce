/**
 * ADS AUTONOMY W2 (AA-W2-2) — the kit's reads on PGlite with the production schema and every business policy, business
 * profiles ON (ads-autonomy-kit.ts, ads-strategy/autonomy.ts). Values and names are made up (public repo).
 *
 *   ledger     what ran by rule in the last 24 hours: single requests and the steps of plans whose decision was the
 *              business's rule; not a person's decision, not a handed-back request, not an older one, not a skipped
 *              step, not another business's (row-level security), not the request being re-checked
 *   facts      a change end to end: where it lands, the strategy there (the safer number of a mixed ad group, each with
 *              its row), this change counted, today per market and per entity, the engines, protection, the month
 *              (report spend through its last day + every enabled budget for the days not reported; the lower cap)
 *   refusals   the common checks on those facts: not placed, no strategy, the strategy's level, a protected product or
 *              term, a row outside the band, an engine, the month
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { adKitLimits, buildLimitFacts, commonRefusal, LIMIT_FACTS_VERSION, ruleRunLedger, type KitItem } from './ads-autonomy-kit.js'

const A = 'aa_w2_kit_alpha'
const B = 'aa_w2_kit_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client

const NOW = new Date('2026-10-06T12:00:00Z')
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3600_000)
const ids = { p1: '', p2: '', thisRequest: '', plan: '' }
const LIMITS = adKitLimits({ maxItems: 50 }).parse({}) as Record<string, unknown>

/** A stored preview of an earlier request, as a strategy-bound tool stores it (only the parts the ledger reads). */
const stored = (byMarket: Record<string, { writes: number; raises: number; budgetIncreaseCents: number }>, entities: string[]) =>
  ({ action: 'test', limitFacts: { v: LIMIT_FACTS_VERSION, markets: {}, this: { byMarket, entities } } })

const facts = (items: KitItem[], opts: { tool?: string; approvalId?: string } = {}) =>
  inA(() => buildLimitFacts({ tool: opts.tool ?? 'set-target-bid', items, approvalId: opts.approvalId, now: NOW }))
const bid = (targetId: string, fromCents: number, toCents: number): KitItem => ({ entity: { kind: 'target', id: targetId }, change: { field: 'bid', fromCents, toCents } })

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
  }
  await inA(async () => {
    const c = db()
    // IT: c-it, c-off, c-sb and c-pin are enabled at EUR 20.00 a day each; c-uk is in the UK (no strategy there).
    await seedAdsFixture(c)
    ids.p1 = (await c.product.create({ data: { sku: 'TEST-AK-P1', name: 'Test helmet', basePrice: '10.00' } })).id
    ids.p2 = (await c.product.create({ data: { sku: 'TEST-AK-P2', name: 'Test gloves', basePrice: '10.00' } })).id
    // c-it's ad group advertises both products (a mixed ad group); c-off's advertises P2 only.
    await c.adProductAd.create({ data: { adGroupId: 'g-c-it', productId: ids.p1, asin: 'B0TESTAK01' } })
    await c.adProductAd.create({ data: { adGroupId: 'g-c-it', productId: ids.p2, asin: 'B0TESTAK02' } })
    await c.adProductAd.create({ data: { adGroupId: 'g-c-off', productId: ids.p2, asin: 'B0TESTAK03' } })
    await c.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', maxActionsPerRun: 40, monthlySpendCapCents: 300_000, maxChangePct: 20, claudeAutonomy: { bid: 'auto', budget: 'auto' }, updatedBy: 'user:test' } })
    await c.adsStrategy.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: ids.p1, label: 'TEST-AK-P1 (IT)', maxBidCents: 150, claudeAutonomy: { bid: 'ask' }, version: 3, updatedBy: 'user:test' } })
    await c.adsStrategy.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: ids.p2, label: 'TEST-AK-P2 (IT)', maxBidCents: 90, protect: true, version: 2, updatedBy: 'user:test' } })
    await c.adKeywordProtection.create({ data: { mode: 'WHITELIST', term: 'testbrand', matchType: 'CONTAINS', marketplace: 'IT' } })
    // An hourly bid plan moves c-it on its own.
    await c.adSchedule.create({ data: { campaignId: 'c-it', name: 'Test evening plan', windows: [] } })
    // This month's report spend in IT: 60.00 through the 4th. Left out: September, a stream duplicate, another market.
    const perf = (date: string, euros: number, extra: Record<string, unknown> = {}) => c.amazonAdsDailyPerformance.create({
      data: { profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(`${date}T00:00:00Z`), entityType: 'CAMPAIGN', entityId: 'EXT-c-it', localEntityId: 'c-it', costMicros: BigInt(euros * 1_000_000), currencyCode: 'EUR', reportedAt: new Date(`${date}T06:00:00Z`), reportRunId: `run-${date}`, ...extra },
    })
    await perf('2026-10-01', 10)
    await perf('2026-10-02', 20)
    await perf('2026-10-04', 30)
    await perf('2026-09-30', 999)
    await perf('2026-10-03', 500, { reportRunId: 'ams-stream' })
    await perf('2026-10-03', 700, { marketplace: 'DE', profileId: 'P-DE-TEST' })
    // This month's budget plan for IT: 2,500.00, lower than the strategy's 3,000.00 cap.
    await c.adBudgetPlan.create({ data: { marketplace: 'IT', month: '2026-10', monthlyBudgetCents: 250_000 } })

    // What ran by rule (and what did not) in the last 24 hours.
    const run = await c.agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'awaiting_approval' } })
    const approval = (data: Record<string, unknown>) => c.agentApproval.create({ data: { agentRunId: run.id, toolName: 'set-target-bid', riskTier: 'high', args: {}, ...data } })
    await approval({ status: 'executed', decisionVia: 'auto', decidedAt: ago(1), preview: stored({ IT: { writes: 3, raises: 1, budgetIncreaseCents: 0 } }, ['target:t-it']) })
    await approval({ status: 'executed', decisionVia: 'auto', decidedAt: ago(30), preview: stored({ IT: { writes: 40, raises: 40, budgetIncreaseCents: 0 } }, ['target:t-it']) })
    await approval({ status: 'executed', decisionVia: 'nexus', decidedAt: ago(1), preview: stored({ IT: { writes: 20, raises: 20, budgetIncreaseCents: 0 } }, ['target:t-it']) })
    await approval({ status: 'pending', decisionVia: null, decidedAt: null, preview: stored({ IT: { writes: 30, raises: 30, budgetIncreaseCents: 0 } }, ['target:t-it']) })
    await approval({ status: 'executed', decisionVia: 'auto', decidedAt: ago(1), toolName: 'set-price', preview: { priceCents: 1000 } }) // another tool: no facts
    ids.thisRequest = (await approval({ status: 'scheduled', decisionVia: 'auto', decidedAt: ago(0.1), toolName: 'set-campaign-budget', preview: stored({ IT: { writes: 7, raises: 2, budgetIncreaseCents: 500 } }, ['campaign:c-off']) })).id
    const plan = await approval({ status: 'executed', decisionVia: 'auto', decidedAt: ago(2), toolName: 'submit-change-plan', preview: { steps: 2 } })
    ids.plan = plan.id
    await c.agentPlanStep.create({ data: { approvalId: plan.id, position: 0, toolName: 'set-target-bid', args: {}, status: 'done', preview: stored({ IT: { writes: 2, raises: 0, budgetIncreaseCents: 0 } }, ['target:t-it']) } })
    await c.agentPlanStep.create({ data: { approvalId: plan.id, position: 1, toolName: 'set-target-bid', args: {}, status: 'skipped', preview: stored({ IT: { writes: 50, raises: 50, budgetIncreaseCents: 0 } }, ['target:t-low']) } })
  })
  // Another business's rule-runs never count here.
  await inB(async () => {
    const run = await db().agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'awaiting_approval' } })
    await db().agentApproval.create({ data: { agentRunId: run.id, toolName: 'set-target-bid', riskTier: 'high', args: {}, status: 'executed', decisionVia: 'auto', decidedAt: ago(1), preview: stored({ IT: { writes: 100, raises: 100, budgetIncreaseCents: 0 } }, ['target:t-it']) } })
  })
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('today\'s ledger — what ran by rule in the last 24 hours', () => {
  it('counts single requests and the steps of plans the rule decided; not a person\'s, a handed-back, an older one, a skipped step or another business\'s', async () => {
    const ledger = await inA(() => ruleRunLedger({ now: NOW }))
    expect(ledger.byMarket).toEqual({ IT: { writes: 3 + 7 + 2, raises: 1 + 2, budgetIncreaseCents: 500 } })
    expect(ledger.byEntity).toEqual({ 'target:t-it': 2, 'campaign:c-off': 1 })
    expect(ledger.runs).toBe(3)
    expect((await inB(() => ruleRunLedger({ now: NOW }))).byMarket).toEqual({ IT: { writes: 100, raises: 100, budgetIncreaseCents: 0 } })
  })

  it('leaves out the request a dry run re-checks (its own run, or its plan\'s steps)', async () => {
    expect((await inA(() => ruleRunLedger({ now: NOW, excludeApprovalId: ids.thisRequest }))).byMarket.IT).toEqual({ writes: 5, raises: 1, budgetIncreaseCents: 0 })
    expect((await inA(() => ruleRunLedger({ now: NOW, excludeApprovalId: ids.plan }))).byEntity).toEqual({ 'target:t-it': 1, 'campaign:c-off': 1 })
  })

  it('the window is 24 hours back from now', async () => {
    // 23.5 hours later only the request decided 6 minutes before NOW is still inside it.
    expect((await inA(() => ruleRunLedger({ now: new Date(NOW.getTime() + 23.5 * 3600_000) }))).byMarket.IT).toEqual({ writes: 7, raises: 2, budgetIncreaseCents: 500 })
  })
})

describe('the facts of one change, end to end', () => {
  it('a bid raise in a mixed ad group: the safer number per limit with its row, today per market and per entity, the engine on its campaign', async () => {
    const f = await facts([bid('t-it', 45, 50)])
    expect(f).toMatchObject({ v: LIMIT_FACTS_VERSION, tool: 'set-target-bid', action: 'bid', unplaced: [], protectedHit: [] })
    expect(f.markets.IT).toMatchObject({ currency: 'EUR', maxActionsPerRun: 40, maxRaisesPerDay: null, sources: { maxActionsPerRun: { level: 'market', label: 'Test market (IT)' } } })
    expect(f.markets.IT.strategy?.version).toMatch(/^[0-9a-f]{12}$/)
    expect(f.entityScopes).toEqual({ 'target:t-it': 'IT|adGroup:g-c-it' })
    const s = f.scopes['IT|adGroup:g-c-it']
    expect(s.label).toBe('the ad group of target "race jacket" (IT)')
    expect(s.limits).toMatchObject({ maxBidCents: 90, maxChangePct: 20, protect: true, claudeLevel: 'ask' })
    expect(s.sources.maxBidCents).toMatchObject({ level: 'product', label: 'TEST-AK-P2 (IT)', version: 2, product: 'TEST-AK-P2' })
    expect(s.sources.claudeLevel).toMatchObject({ level: 'product', label: 'TEST-AK-P1 (IT)', version: 3, product: 'TEST-AK-P1' })
    expect(f.this).toMatchObject({ markets: ['IT'], items: 1, writes: 1, raises: 1, largestRaisePct: 11.11, highestNewBidCents: 50, entities: ['target:t-it'], rowsOutsideStrategy: 0 })
    expect(f.today).toEqual({ IT: { writes: 12, raises: 3, budgetIncreaseCents: 500 } })
    expect(f.perEntityToday).toEqual({ maxChangesByRule: 2, entity: 'target:t-it' })
    expect(f.engineOwned).toEqual([{ campaignId: 'c-it', label: 'the campaign of target "race jacket"', by: ['schedule "Test evening plan"'] }])
    expect(f.monthProjection).toBeUndefined()
    // The strategy holds bids at ask where it lands: a person decides.
    expect(commonRefusal({ limitFacts: f }, LIMITS)).toBe('the ads strategy lets Claude only ask for bid changes at the ad group of target "race jacket" (IT) (ads strategy: TEST-AK-P1 (IT), product, v3, from TEST-AK-P1); a person decides')
  })

  it('a cut of a protected product\'s bid, a bid above its band, a protected term negated: each named', async () => {
    const cut = await facts([bid('t-it', 45, 40)])
    expect(cut.protectedHit).toEqual([{ entity: 'target:t-it', why: 'target "race jacket": the ads strategy protects a product it advertises (ads strategy: TEST-AK-P2 (IT), product, v2, from TEST-AK-P2), so lowering its bid waits for a person' }])
    const high = await facts([bid('t-it', 80, 95)])
    expect(high.this.rowsOutsideStrategy).toBe(1)
    expect(high.this.firstOutside?.why).toBe('target "race jacket": the new bid EUR 0.95 is above the highest bid EUR 0.90 (ads strategy: TEST-AK-P2 (IT), product, v2, from TEST-AK-P2)')
    const negative = await facts([{ entity: { kind: 'searchTerm', query: 'testbrand jacket', externalCampaignId: 'EXT-c-it', externalAdGroupId: 'EXT-g-c-it' }, change: { field: 'negative', term: 'testbrand jacket', matchType: 'NEGATIVE_EXACT' } }], { tool: 'create-negative-keyword' })
    expect(negative.entityScopes).toEqual({ 'searchTerm:EXT-c-it:EXT-g-c-it:testbrand jacket': 'IT|adGroup:g-c-it' })
    expect(negative.protectedHit[0].why).toMatch(/testbrand/)
    expect(commonRefusal({ limitFacts: negative }, LIMITS)).toMatch(/testbrand.*; a person decides$/)
  })

  it('a budget raise: the month as an upper bound against the lower cap, and the request re-checked left out of today', async () => {
    const f = await facts([{ entity: { kind: 'campaign', id: 'c-off' }, change: { field: 'dailyBudget', fromCents: 2000, toCents: 2500 } }], { tool: 'set-campaign-budget', approvalId: ids.thisRequest })
    expect(f.action).toBe('budget')
    expect(f.entityScopes).toEqual({ 'campaign:c-off': 'IT|campaign:c-off' })
    expect(f.today.IT).toEqual({ writes: 5, raises: 1, budgetIncreaseCents: 0 })
    expect(f.this).toMatchObject({ raises: 1, largestRaisePct: 25, budgetIncreaseCents: 500, byMarket: { IT: { addedDailyCents: 500, budgetIncreaseCents: 500 } } })
    // 60.00 reported through the 4th + 4 enabled IT budgets of 20.00 for the 27 days not reported + 5.00 a day for the 26 days left.
    expect(f.monthProjection?.IT).toEqual({
      month: '2026-10', currency: 'EUR', spentCents: 6_000, spendThrough: '2026-10-04', uncoveredDays: 27, daysLeft: 26, budgetsCents: 8_000,
      projectedCents: 6_000 + 8_000 * 27, addedDailyCents: 500, afterCents: 6_000 + 8_000 * 27 + 500 * 26, capCents: 250_000, capFrom: 'the budget plan 2026-10',
    })
    const over = await facts([{ entity: { kind: 'campaign', id: 'c-off' }, change: { field: 'dailyBudget', fromCents: 2000, toCents: 3400 } }], { tool: 'set-campaign-budget' })
    expect(over.monthProjection?.IT.afterCents).toBe(6_000 + 8_000 * 27 + 1_400 * 26)
    expect(commonRefusal({ limitFacts: { ...over, protectedHit: [], engineOwned: [], markets: { IT: { ...over.markets.IT, maxRaisesPerDay: 10, maxBudgetIncreasePerDayCents: 10_000 } } } }, { ...LIMITS, maxChangesPerEntityPerDay: 5 }))
      .toMatch(/^IT: this month could reach EUR 2584\.00 with this change — .* above the monthly cap EUR 2500\.00 \(the budget plan 2026-10\); a person decides$/)
  })

  it('an entity Nexus cannot find, and a market without a strategy: never inside', async () => {
    const missing = await facts([bid('no-such-target', 40, 45)])
    expect(missing.unplaced).toEqual([{ entity: 'target:no-such-target', why: 'target no-such-target was not found in this business' }])
    expect(commonRefusal({ limitFacts: missing }, LIMITS)).toMatch(/^target no-such-target was not found in this business: Nexus cannot tell/)
    const uk = await facts([bid('t-uk', 60, 55)])
    expect(uk.markets.UK).toMatchObject({ strategy: null, currency: 'GBP' })
    expect(commonRefusal({ limitFacts: uk }, LIMITS)).toBe('there is no ads strategy for UK: nothing runs alone there; a person decides')
  })

  it('another business sees none of this one\'s strategy, ledger or entities', async () => {
    const f = await inB(() => buildLimitFacts({ tool: 'set-target-bid', items: [bid('t-it', 45, 50)], now: NOW }))
    expect(f.unplaced).toHaveLength(1)
    expect(f.scopes).toEqual({})
  })
})

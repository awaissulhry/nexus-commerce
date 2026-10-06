/**
 * ADS AUTONOMY B-2 — create-ai-goal-campaigns, run for real through the door and the approval gate (PGlite, production
 * schema; the job queue a stub; the ads write gate the real one, sandbox unless a test goes live).
 *
 * Proven: the preview is the AI Goal builder's own plan, Strict Control only (one campaign set per product), with where
 * it lands and what the seed keywords already do elsewhere (another product's: listed; the same product's: a warning that
 * keeps it from running by rule); refused and not queued without a market spend ceiling, above it, on a taken name, an
 * unknown SKU, a term both seeded and excluded; approved, the goal and its campaigns are created by the builder's launch
 * ENABLED (never paused), OFF the live-write allowlist and born suppressed — every bid at the 2-cent floor, the planned
 * bid remembered, `bidsSuppressedBy` the person who asked — with its rules and AutopilotPlan switched off, every ad write
 * in the approval's change set; the bids are the ones the person approved even when the evidence moved; the undo archives
 * its campaigns; the screen's own launch (no options) is unchanged.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
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
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction; an ads
// row names no listing account anyway (the ads worker resolves its Amazon Ads profile).
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
vi.mock('../../advertising/ads-cache.js', () => ({ cached: async (_k: string, _t: number, work: () => Promise<unknown>) => work(), peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined }))

import { callTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { undoRequestFor } from '../change-record.service.js'
import { getTool } from '../tool-registry.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId}`, via, workspace: business,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
})
const claude = person('u-asker', 'claude')
const approver = person('u-approver', 'app')
const TOOL = 'create-ai-goal-campaigns'

type Row = Record<string, any>
const preview = async (args: Record<string, unknown>) => (await inside(() => callTool(claude, TOOL, args))).raw
async function ask(args: Record<string, unknown>) {
  return inside(async () => {
    const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool(TOOL, args, claude, run.id, { forceAsk: true })
  })
}
const approve = (approvalId: string) => inside(() => decideApproval(approvalId, 'approve', approver))
const sql = <T = Row>(text: string, params: unknown[] = []) => inside(async () => (await database.client.$queryRawUnsafe(text, ...params)) as T[])
const status = async (approvalId: string) => (await inside(() => callTool(claude, 'approval-status', { approvalId }))).visible.data as Row

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    await seedAdsFixture(db)
    for (const [sku, asin] of [['TEST-GOAL-1', 'B0GOALTST1'], ['TEST-GOAL-2', 'B0GOALTST2'], ['TEST-OTHER-1', 'B0OTHERTS1']]) {
      await db.product.create({ data: { sku, name: `Test ${sku}`, basePrice: '99.00', amazonAsin: asin } })
    }
    for (const [code, currency] of [['IT', 'EUR'], ['UK', 'GBP'], ['DE', 'EUR'], ['ES', 'EUR']]) {
      await db.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, region: 'EU', currency, language: 'en' } })
    }
    for (const [market, cap] of [['IT', 5000], ['ES', 5000]] as const) {
      await db.adSpendCeiling.create({ data: { grain: 'MARKET', scopeId: market, label: `the ${market} market`, dailyCapCents: cap } })
    }
    // Another product already buys "winter jacket" (c-off): allowed, only listed.
    await db.adProductAd.create({ data: { adGroupId: 'g-c-off', asin: 'B0OTHERTS1', sku: 'TEST-OTHER-1', externalAdId: 'EXT-pa-other' } })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(() => { vi.unstubAllEnvs() })

const goal = (extra: Record<string, unknown> = {}) => ({
  market: 'IT', name: 'Test goal', aiTarget: 'SALES',
  goalProducts: [{ sku: 'TEST-GOAL-1', dailyBudgetCents: 1000 }, { sku: 'TEST-GOAL-2', dailyBudgetCents: 600 }],
  seedKeywords: ['winter jacket', 'thermal liner'], excludeKeywords: ['used'],
  ...extra,
})

describe('B-2 — create-ai-goal-campaigns: the plan, and what refuses it', () => {
  it('previews the builder\'s own plan, one set per product, born at the floor, off the allowlist, its automation off', async () => {
    const r = await preview(goal())
    expect(r.ok).toBe(true)
    const p = r.preview as Row
    expect(p).toMatchObject({
      action: TOOL, market: 'IT', currency: 'EUR', dailyBudgetCents: 1600,
      plan: { mode: 'STRICT', aiTarget: 'SALES', products: [{ sku: 'TEST-GOAL-1', asin: 'B0GOALTST1', dailyBudgetCents: 1000 }, { sku: 'TEST-GOAL-2', asin: 'B0GOALTST2', dailyBudgetCents: 600 }] },
      totals: { products: 2, campaigns: 6, keywords: 8, autoGroups: 8, productTargets: 0, negatives: 8, rules: 4 },
      startsSuppressed: { floorCents: 2, by: 'the person who asked' }, liveWrites: false, ceiling: { label: 'the IT market', dailyCapCents: 5000 },
      isolation: { mode: 'STRICT', note: expect.stringMatching(/another product of this business is never blocked on a keyword\. Shared Budget is not offered/) },
      automation: { rules: '4 rules (Harvest & Negate, Negative Targeting per product), created switched off, as dry runs' },
      reach: { reach: 'sandbox' },
      effect: expect.stringMatching(/^Creates the AI goal "Test goal" in IT with the AI Goal builder's own launch: 6 Sponsored Products campaigns \(Auto, Research, Performance for each of 2 products\), EUR 16\.00 of daily budget in all/),
    })
    expect(p.plan.campaigns.map((c: Row) => [c.product, c.role, c.name, c.dailyBudgetCents])).toEqual([
      ['TEST-GOAL-1', 'AUTO', '[AI] Test goal - B0GOALTST1 - Auto', 300], ['TEST-GOAL-1', 'RESEARCH', '[AI] Test goal - B0GOALTST1 - Research', 300], ['TEST-GOAL-1', 'PERF', '[AI] Test goal - B0GOALTST1 - Performance', 400],
      ['TEST-GOAL-2', 'AUTO', '[AI] Test goal - B0GOALTST2 - Auto', 180], ['TEST-GOAL-2', 'RESEARCH', '[AI] Test goal - B0GOALTST2 - Research', 180], ['TEST-GOAL-2', 'PERF', '[AI] Test goal - B0GOALTST2 - Performance', 240],
    ])
    // Each product's negatives stay in its own Auto and Research campaigns (rule 3).
    expect(p.plan.campaigns.filter((c: Row) => c.negativeKeywords.length).map((c: Row) => c.name)).toEqual([
      '[AI] Test goal - B0GOALTST1 - Auto', '[AI] Test goal - B0GOALTST1 - Research', '[AI] Test goal - B0GOALTST2 - Auto', '[AI] Test goal - B0GOALTST2 - Research',
    ])
    // Another product already buys a seed keyword: listed, allowed — no warning, and not held from a run by rule.
    expect(p.sameKeyword).toEqual({ ownProduct: [], otherProducts: [{ keyword: 'winter jacket', campaigns: 1 }], note: expect.stringMatching(/allowed \(isolation is per product\), never blocked/) })
    expect(p.warnings.join(' ')).not.toMatch(/same product/)
    expect(getTool(TOOL)).toMatchObject({
      alwaysAsk: true, maxClaudeTrust: 'auto', strategyBound: 'amazon-ads', reversibility: 'partial', openWorld: true, readOnly: false,
    })
  })

  it('refuses, and queues nothing: no spend ceiling, above it, a taken name, an unknown SKU, a term seeded and excluded, no currency', async () => {
    const error = async (extra: Record<string, unknown>) => (await preview(goal(extra))).error
    expect(await error({ market: 'DE' })).toMatch(/^Set a spend ceiling for this market first: DE has no daily spend ceiling/)
    expect(await error({ goalProducts: [{ sku: 'TEST-GOAL-1', dailyBudgetCents: 5100 }] })).toBe('The goal\'s daily budgets add up to EUR 51.00, above the IT market\'s spend ceiling of EUR 50.00 a day.')
    expect(await error({ goalProducts: [{ sku: 'TEST-GOAL-1', dailyBudgetCents: 1000 }, { sku: 'NOT-OURS-9', dailyBudgetCents: 1000 }] })).toBe('SKU not found: NOT-OURS-9.')
    expect(await error({ goalProducts: [{ sku: 'TEST-GOAL-1', dailyBudgetCents: 1000 }, { sku: 'test-goal-1', dailyBudgetCents: 1000 }] })).toBe('Listed twice: test-goal-1.')
    expect(await error({ excludeKeywords: ['Winter Jacket'] })).toMatch(/^Both a seed keyword and an excluded keyword: winter jacket/)
    expect(await error({ bidMinCents: 50, bidMaxCents: 40 })).toBe('bidMaxCents must be above bidMinCents.')
    expect(await error({ market: 'FR' })).toMatch(/No currency is configured for AMAZON\/FR/)
    await inside(() => database.client.campaign.create({ data: { id: 'c-taken', name: '[AI] Taken - B0GOALTST1 - Auto', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', dailyBudget: '5.00', startDate: new Date() } }))
    expect(await error({ name: 'Taken' })).toMatch(/^Not queued: IT already has a campaign named "\[AI\] Taken - B0GOALTST1 - Auto"/)
    expect((await sql<{ n: number }>('SELECT count(*)::int AS n FROM "AgentApproval"'))[0].n).toBe(0)
  })

  it('live: where it lands at Amazon, or refused and not queued where the gate refuses', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    expect((await preview(goal())).preview).toMatchObject({ reach: { reach: 'live', profileId: 'P-IT-TEST' }, reachNote: expect.stringMatching(/^live: after approval it is sent to Amazon/) })
    expect((await preview(goal({ market: 'ES' }))).error).toMatch(/^Not queued: Amazon's write gate refuses it — no active Amazon Ads profile for marketplace=ES/)
  })

  it('the same product already buying a seed keyword is a warning (a person decides)', async () => {
    await inside(() => database.client.adProductAd.create({ data: { id: 'pa-own', adGroupId: 'g-c-it', asin: 'B0GOALTST1', sku: 'TEST-GOAL-1', externalAdId: 'EXT-pa-own' } }))
    try {
      const p = (await preview(goal({ name: 'Own clash', seedKeywords: ['race jacket'] }))).preview as Row
      expect(p.sameKeyword.ownProduct).toEqual([{ keyword: 'race jacket', campaignId: 'c-it', campaign: 'Italy exact' }])
      expect(p.warnings).toContain(p.sameKeyword.note)
      expect(p.sameKeyword.note).toMatch(/would bid against it\. A person decides/)
    } finally {
      await inside(() => database.client.adProductAd.delete({ where: { id: 'pa-own' } }))
    }
  })
})

describe('B-2 — approved, the builder\'s launch makes it born safe', () => {
  it('creates the goal and its campaigns ENABLED, off the allowlist, at the floor for the person who asked, rules and plan off; undo archives them', async () => {
    const asked = await ask(goal({ why: 'an AI goal for the winter range' }))
    expect(asked).toMatchObject({ ok: true, mode: 'queued' })
    const done = await approve(asked.approvalId!) as Row
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { created: { campaigns: 6, adGroups: 6, productAds: 6 }, plan: { enabled: false }, currency: 'EUR' } })
    const goalId = done.result.goalId as string
    const ids = (done.result.campaigns as Row[]).map((c) => c.campaignId as string)
    expect(done.result.campaigns.every((c: Row) => c.status === 'ENABLED' && c.liveWrites === false && c.suppressed?.by === 'user:u-asker' && c.suppressed.floorCents === 2)).toBe(true)
    expect(done.result.rules).toHaveLength(4)

    // The goal row the screen would have saved, Strict Control, launched.
    expect((await sql('SELECT "budgetMode" AS mode, status, marketplace, "materializedAt" IS NOT NULL AS launched, "seedKeywords" AS seeds FROM "AdProductGoal" WHERE id = $1', [goalId]))[0])
      .toEqual({ mode: 'STRICT', status: 'ACTIVE', marketplace: 'IT', launched: true, seeds: ['winter jacket', 'thermal liner'] })
    // Every campaign: ENABLED, off the allowlist, suppressed by the asker at 2 cents.
    expect(await sql('SELECT DISTINCT status, "liveBidWritesEnabled" AS live, "bidsSuppressedBy" AS by, "bidsSuppressedFloorCents" AS floor FROM "Campaign" WHERE id = ANY($1)', [ids]))
      .toEqual([{ status: 'ENABLED', live: false, by: 'user:u-asker', floor: 2 }])
    // Ad group defaults at the floor, 75 remembered; keywords at the floor with the evidence bid remembered; the
    // negatives (exact and phrase "used") in each product's own Auto and Research ad groups.
    expect(await sql('SELECT DISTINCT g."defaultBidCents" AS bid, g."suppressedFromBidCents" AS kept FROM "AdGroup" g WHERE g."campaignId" = ANY($1)', [ids])).toEqual([{ bid: 2, kept: 75 }])
    expect(await sql(`SELECT t."expressionType" AS type, t."bidCents" AS bid, t."suppressedFromBidCents" AS kept, count(*)::int AS n FROM "AdTarget" t JOIN "AdGroup" g ON g.id = t."adGroupId"
      WHERE g."campaignId" = ANY($1) AND t.kind = 'KEYWORD' AND NOT t."isNegative" GROUP BY 1, 2, 3 ORDER BY 1`, [ids])).toEqual([
      { type: 'BROAD', bid: 2, kept: 50, n: 4 }, { type: 'EXACT', bid: 2, kept: 50, n: 4 },
    ])
    expect(await sql(`SELECT t."expressionValue" AS key, t."suppressedFromBidCents" AS kept FROM "AdTarget" t JOIN "AdGroup" g ON g.id = t."adGroupId"
      WHERE g."campaignId" = $1 AND t.kind = 'AUTO' ORDER BY 1`, [ids[0]])).toEqual([
      { key: 'CLOSE_MATCH', kept: 75 }, { key: 'COMPLEMENTS', kept: 45 }, { key: 'LOOSE_MATCH', kept: 49 }, { key: 'SUBSTITUTES', kept: 83 },
    ])
    expect((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM "AdTarget" t JOIN "AdGroup" g ON g.id = t."adGroupId" JOIN "Campaign" c ON c.id = g."campaignId"
      WHERE c.id = ANY($1) AND t."isNegative" AND t."expressionValue" = 'used' AND (c.name LIKE '%- Auto' OR c.name LIKE '%- Research')`, [ids]))[0].n).toBe(8)
    // The rules: off, still dry runs; the plan: disabled, its links say the plan left them off (not a person).
    expect(await sql(`SELECT DISTINCT enabled, "dryRun" AS dry FROM "AutomationRule" WHERE name LIKE '[AI] Test goal%'`)).toEqual([{ enabled: false, dry: true }])
    const plan = (await sql('SELECT id, enabled, autonomy, "linkedRuleIds" AS links FROM "AutopilotPlan" WHERE id = $1', [done.result.planId]))[0]
    expect(plan).toMatchObject({ enabled: false, autonomy: 'SUGGEST' })
    expect((plan.links as Row[]).every((l) => l.syncedEnabled === false)).toBe(true)
    // Every ad write is in the approval's change set, as the approver.
    expect(await sql(`SELECT DISTINCT "userId" AS who FROM "AdvertisingActionLog" WHERE "actionType" LIKE 'create_%' AND "executionId" = $1`, [asked.approvalId]))
      .toEqual([{ who: 'user:u-approver' }])
    expect((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM "AdvertisingActionLog" WHERE "actionType" = 'create_campaign' AND "executionId" = $1`, [asked.approvalId]))[0].n).toBe(6)

    const s = await status(asked.approvalId!)
    expect(s).toMatchObject({ status: 'executed', ads: { reach: 'sandbox', created: { atAmazon: 0 } } })
    expect(s.ads.created.total).toBeGreaterThan(6)
    expect(s.change).toMatchObject({ reversibility: 'partial' })
    // Undo archives its campaigns (a new request a person approves, permanent at Amazon).
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'archive-ads', args: { campaignIds: ids } } })
    // Asking again for the same goal is refused: its names are taken now.
    expect((await preview(goal())).error).toMatch(/already has a campaign named "\[AI\] Test goal - B0GOALTST1 - Auto"/)

    // Its planned bids come back with restore-campaign (the asker's suppression), a request a person approves.
    const r = await inside(() => callTool(claude, 'restore-campaign', { campaignId: ids[2] }))
    expect(r.raw.preview).toMatchObject({ suppressedBy: 'user:u-asker' })

    // Switching the goal's plan on hands it its rules (still proposing): the plan's own off, not a person's.
    const { syncLinkedRules } = await import('../../advertising/autopilot/coordination.js')
    const row = await inside(() => database.client.autopilotPlan.findUniqueOrThrow({ where: { id: done.result.planId } }))
    const links = await inside(() => syncLinkedRules({ ...row, enabled: true }))
    expect(links.every((l) => l.syncedEnabled === true && !l.personOff)).toBe(true)
    expect(await sql(`SELECT DISTINCT enabled, "dryRun" AS dry FROM "AutomationRule" WHERE name LIKE '[AI] Test goal%'`)).toEqual([{ enabled: true, dry: true }])
  })

  it('a ceiling that moved after approval is not run, and nothing is created — not even the goal', async () => {
    const asked = await ask(goal({ name: 'Moved ceiling' }))
    await sql('UPDATE "AdSpendCeiling" SET "dailyCapCents" = 4000 WHERE grain = $1 AND "scopeId" = $2 RETURNING id', ['MARKET', 'IT'])
    try {
      expect(await approve(asked.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/ceiling changed/) })
    } finally {
      await sql('UPDATE "AdSpendCeiling" SET "dailyCapCents" = 5000 WHERE grain = $1 AND "scopeId" = $2 RETURNING id', ['MARKET', 'IT'])
    }
    expect(await sql('SELECT name FROM "Campaign" WHERE name LIKE $1', ['[AI] Moved ceiling%'])).toEqual([])
    expect(await sql('SELECT name FROM "AdProductGoal" WHERE name = $1', ['Moved ceiling'])).toEqual([])
  })

  it('the bid evidence moved after approval: it builds the bids the person approved', async () => {
    const asked = await ask(goal({ name: 'Frozen bids', goalProducts: [{ sku: 'TEST-GOAL-2', dailyBudgetCents: 600 }], seedKeywords: ['heated vest'] }))
    // The market's own CPCs move: the evidence would now say 90 cents for every keyword and Auto group.
    await inside(() => database.client.adTarget.create({ data: { id: 't-cpc', adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'cpc mover', bidCents: 90, clicks: 10, spendCents: 900, externalTargetId: 'EXT-t-cpc' } }))
    try {
      expect((await preview(goal({ name: 'Frozen bids now', goalProducts: [{ sku: 'TEST-GOAL-2', dailyBudgetCents: 600 }], seedKeywords: ['heated vest'] }))).preview)
        .toMatchObject({ bidEvidence: { autoBaseCents: 90, bidCentsByKeyword: { 'heated vest': 90 } } })
      const done = await approve(asked.approvalId!) as Row
      expect(done).toMatchObject({ ok: true, status: 'executed' })
      const ids = (done.result.campaigns as Row[]).map((c) => c.campaignId as string)
      expect(await sql(`SELECT DISTINCT t."suppressedFromBidCents" AS kept FROM "AdTarget" t JOIN "AdGroup" g ON g.id = t."adGroupId"
        WHERE g."campaignId" = ANY($1) AND t.kind = 'KEYWORD' AND NOT t."isNegative"`, [ids])).toEqual([{ kept: 50 }])
    } finally {
      await inside(() => database.client.adTarget.delete({ where: { id: 't-cpc' } }))
    }
  })
})

describe('B-2 — by rule: inside the strategy and its limits only', () => {
  const judge = (p: unknown, limits: Record<string, unknown> = {}) => {
    const t = getTool(TOOL)!
    return t.withinLimits!(p, t.limits!.parse(limits) as Record<string, unknown>)
  }

  it('no strategy, the default limits (0), a new market, a bid above the band: a person decides', async () => {
    const roomy = { maxCampaigns: 10, maxDailyBudgetCents: 5000, maxBidCents: 200 }
    // Seeds no campaign of these products buys yet (the goal approved above buys its own).
    const name = 'Rule goal'
    const rule = (extra: Record<string, unknown> = {}) => goal({ name, seedKeywords: ['rain cover'], ...extra })
    const p = (await preview(rule())).preview as Row
    expect(p).toMatchObject({ highestPlannedBidCents: 83, limitFacts: { tool: TOOL, action: 'create' }, undoNote: expect.stringMatching(/^Undo archives every campaign it made at Amazon \(archive-ads\)/) })
    expect(p.newMarket).toBeUndefined()
    expect(judge(p, roomy)).toMatch(/there is no ads strategy for IT/)
    const row = await inside(() => database.client.adsStrategy.create({ data: {
      market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', updatedBy: 'user:test',
      claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 10, claudeMaxBudgetIncreasePerDayCents: 5000, maxBidCents: 100,
    } }))
    try {
      const allowed = (await preview(rule())).preview
      expect(judge(allowed)).toMatch(/it creates 6 campaigns, more than the 0 this tool's limits let a goal create by rule \(0: every goal waits for a person\)/)
      expect(judge(allowed, { ...roomy, maxDailyBudgetCents: 1500 })).toMatch(/its daily budgets add up to EUR 16\.00, more than the EUR 15\.00/)
      expect(judge(allowed, { ...roomy, maxBidCents: 80 })).toMatch(/its highest planned bid EUR 0\.83 is above the EUR 0\.80 this tool's limits allow/)
      expect(judge(allowed, { ...roomy, markets: ['DE'] })).toMatch(/only in DE/)
      expect(judge(allowed, roomy)).toBeNull()
      // The same product already buying a seed keyword: never by rule, whatever the limits.
      await inside(() => database.client.adProductAd.create({ data: { id: 'pa-own-2', adGroupId: 'g-c-it', asin: 'B0GOALTST1', sku: 'TEST-GOAL-1', externalAdId: 'EXT-pa-own-2' } }))
      try {
        expect(judge((await preview(rule({ seedKeywords: ['race jacket'] }))).preview, roomy)).toMatch(/a seed keyword already runs in a campaign of the same product/)
      } finally {
        await inside(() => database.client.adProductAd.delete({ where: { id: 'pa-own-2' } }))
      }
      await inside(() => database.client.adsStrategy.update({ where: { id: row.id }, data: { maxBidCents: 80, version: 2 } }))
      expect(judge((await preview(rule())).preview, roomy)).toMatch(/its highest planned bid EUR 0\.83 is above the highest bid EUR 0\.80 \(ads strategy: Test market \(IT\)/)
    } finally {
      await inside(() => database.client.adsStrategy.delete({ where: { id: row.id } }))
    }
    // ES has a spend ceiling and no campaign yet: the first campaigns of a market are a person's.
    expect((await preview(goal({ market: 'ES', name: 'Spain first' }))).preview).toMatchObject({ newMarket: true, newMarketNote: 'NEW MARKET: the first campaigns in ES.' })
  })
})

describe('B-2 — the screen\'s own launch is unchanged (no options)', () => {
  it('allowlists at birth, plans its bids live, and creates its rules and plan on', async () => {
    const g = await inside(() => database.client.adProductGoal.create({ data: {
      name: 'Screen goal', aiTarget: 'SALES', budgetMode: 'SHARED', totalBudgetCents: 2000, marketplace: 'IT',
      products: [{ asin: 'B0GOALTST1', sku: 'TEST-GOAL-1' }] as never,
    } }))
    const { materializeProductGoal } = await import('../../advertising/ai-goal-materialize.service.js')
    const out = await inside(() => materializeProductGoal(g.id, 'user:u-screen'))
    const ids = out.campaigns.map((c) => c.id)
    expect(await sql('SELECT DISTINCT "liveBidWritesEnabled" AS live, "bidsSuppressedAt" IS NULL AS free FROM "Campaign" WHERE id = ANY($1)', [ids])).toEqual([{ live: true, free: true }])
    expect(await sql('SELECT DISTINCT g."defaultBidCents" AS bid, g."suppressedFromBidCents" AS kept FROM "AdGroup" g WHERE g."campaignId" = ANY($1)', [ids])).toEqual([{ bid: 75, kept: null }])
    expect(await sql(`SELECT DISTINCT enabled, "dryRun" AS dry FROM "AutomationRule" WHERE name LIKE '[AI] Screen goal%'`)).toEqual([{ enabled: true, dry: true }])
    expect((await sql('SELECT enabled, "linkedRuleIds" AS links FROM "AutopilotPlan" WHERE id = $1', [out.planId]))[0]).toMatchObject({ enabled: true })
    expect(out.rules.every((r) => !('syncedEnabled' in r))).toBe(true)
  })
})

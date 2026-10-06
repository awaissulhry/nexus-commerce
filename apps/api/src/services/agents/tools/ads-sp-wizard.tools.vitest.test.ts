/**
 * B-3 — build-sp-wizard-campaigns, run for real through the door and the approval gate: the SP Super Wizard's own
 * launch, the real create services and the real write gate in LIVE mode, on PGlite (production schema). Amazon is a
 * recorder that answers every create with a fresh id; the launch's read-back and portfolio repair are stand-ins
 * (ads-sp-wizard-launch.vitest.test.ts proves them). Values are made up.
 *
 *   preview    the wizard's own campaigns (Advanced: 11; a keyword type with no keywords left out, said), where it lands,
 *              born at the floor and off the allowlist, no rule, placements kept back; a keyword this product already
 *              buys elsewhere is not queued until skip or accept (the blueprint gate's conflict), another product's is
 *              listed (rule 3: never blocked); refused and not queued on an unknown SKU, SKUs of two products, no spend
 *              ceiling, a budget above it, a taken name, a bid above the budget, a negative that stops the set's own
 *              keyword, an unknown override or portfolio, arguments of another structure
 *   approved   the approval answers at once with its run (the change recorded); the run, detached: every campaign
 *              ENABLED, off the allowlist, every bid sent at 2¢ with the planned bid remembered, flagged suppressed by the
 *              person who asked; the funnel negatives only in the set's own ad groups; no placement and no rule written
 *              (placementsToAsk kept on the run); every audit row carries the approval as change set; approval-status
 *              and ads-playbook view build follow it; Replicate refuses it; undo archives every campaign it made
 *   killed     a run a deploy killed (RUNNING, no progress for 30 minutes, nothing recorded on the row) is said by
 *              approval-status; its undo still names what it made (its change set's audit rows) and marks it FAILED
 *   moved      a basis that moved after approval is not run
 *   by rule    the defaults refuse (no market, maxCampaigns 0); an accepted same-product keyword is a person's; inside
 *              the strategy and the limits it may run
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
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
vi.mock('../../advertising/ads-cache.js', () => ({ cached: async (_k: string, _t: number, work: () => Promise<unknown>) => work(), peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined }))
/** The launch's read-back and portfolio repair, as stand-ins (the launch's own tests prove them). */
vi.mock('../../advertising/ads-launch-verify.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyLaunch: async () => ({ ok: true, problems: [] }),
}))
vi.mock('../../advertising/ads-create.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  settleLaunchPortfolios: async () => null,
}))

type Clause = { targetId: string; adGroupId: string; expressionType: string; state: string; bid?: number; expression: Array<{ type: string }> }
/** Amazon, as a recorder: every create gets a fresh id; each ad group lists its four auto groups. */
const amz = vi.hoisted(() => ({ calls: [] as string[], n: 0, bids: [] as Array<{ resource: string; bid: unknown }>, autoGroups: new Map<string, Clause[]>() }))
vi.mock('../../advertising/ads-api-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../advertising/ads-api-client.js')>()
  const create = (resource: string, idField: string) => async (_ctx: unknown, args: { bid?: unknown; defaultBid?: unknown }) => {
    amz.calls.push(resource)
    if (args && ('bid' in args || 'defaultBid' in args)) amz.bids.push({ resource, bid: args.bid ?? args.defaultBid })
    const raw = { [resource]: { success: [{ index: 0, [idField]: `AMZ-${++amz.n}` }], error: [] } }
    const made = real.v3CreateResult(raw, resource, idField)
    return { ok: true, mode: 'live', externalId: made.externalId, rawResponse: raw, error: null }
  }
  const autoOf = (adGroupId: string): Clause[] => {
    if (!amz.autoGroups.has(adGroupId)) {
      amz.autoGroups.set(adGroupId, ['QUERY_HIGH_REL_MATCHES', 'QUERY_BROAD_REL_MATCHES', 'ASIN_SUBSTITUTE_RELATED', 'ASIN_ACCESSORY_RELATED']
        .map((type) => ({ targetId: `AUTO-${adGroupId}-${type}`, adGroupId, expressionType: 'AUTO', state: 'ENABLED', expression: [{ type }] })))
    }
    return amz.autoGroups.get(adGroupId)!
  }
  return {
    ...real,
    createCampaign: create('campaigns', 'campaignId'),
    createAdGroup: create('adGroups', 'adGroupId'),
    createKeyword: create('keywords', 'keywordId'),
    createTarget: create('targetingClauses', 'targetId'),
    createProductAd: create('productAds', 'adId'),
    createNegativeKeyword: async () => { amz.calls.push('negativeKeywords'); return { ok: true, mode: 'live', externalId: `AMZ-NK-${++amz.n}`, rawResponse: {} } },
    createNegativeProductTarget: async () => { amz.calls.push('negativeTargets'); return { ok: true, mode: 'live', externalId: `AMZ-NT-${++amz.n}`, rawResponse: {} } },
    listTargets: async (_ctx: unknown, opts: { adGroupIds?: string[] }) => (opts.adGroupIds?.length ? opts.adGroupIds.flatMap(autoOf) : []),
    updateTarget: async (_ctx: unknown, _externalId: string, patch: Record<string, unknown>) => {
      amz.calls.push('targets/update')
      if (patch.bid != null) amz.bids.push({ resource: 'autoGroup', bid: patch.bid })
      return { ok: true, mode: 'live', rawResponse: {}, error: null }
    },
    updateCampaign: async () => { amz.calls.push('campaigns/update'); return { ok: true, mode: 'live', rawResponse: {}, error: null } },
  }
})

import { callTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { undoRequestFor } from '../change-record.service.js'
import { getTool } from '../tool-registry.js'
import { raiseApplicationBids, rollbackApplication, WIZARD_RUN } from '../../advertising/ads-blueprint-apply.service.js'

const TOOL = 'build-sp-wizard-campaigns'
const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId}`, via, workspace: business,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
})
const claude = person('u-asker', 'claude')
const approver = person('u-approver', 'app')
type Row = Record<string, any>
const db = () => database.client
const preview = async (args: Record<string, unknown>, tool = TOOL) => (await inside(() => callTool(claude, tool, args))).raw
async function ask(args: Record<string, unknown>, tool = TOOL) {
  return inside(async () => {
    const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool(tool, args, claude, run.id, { forceAsk: true })
  })
}
const approve = (approvalId: string) => inside(() => decideApproval(approvalId, 'approve', approver))
const finished = async (applicationId: string) => {
  await vi.waitFor(async () => {
    const row = await inside(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: applicationId }, select: { status: true } }))
    if (row.status === 'RUNNING') throw new Error('still running')
  }, { timeout: 20_000, interval: 50 })
  return inside(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: applicationId } }))
}
const judge = (p: unknown, limits: Record<string, unknown> = {}) => {
  const t = getTool(TOOL)!
  return t.withinLimits!(p, t.limits!.parse(limits) as Record<string, unknown>)
}

/**
 * An Advanced set of one product (two variations): brand and category keywords, no competitor ones (left out), one
 * product target, 60¢ bids, €5 budgets; "moto jacket", which this product buys already, accepted.
 */
const set = (extra: Record<string, unknown> = {}) => ({
  market: 'IT', productGroupName: 'Test Jacket', skus: ['TEST-WIZ-1', 'TEST-WIZ-2'], structure: 'advanced',
  keywords: { brand: ['testbrand jacket'], category: ['moto jacket', 'race jacket'] }, productTargets: ['B0TESTRIV1'],
  dailyBudgetCents: 500, defaultBidCents: 60, sameProductTerms: 'accept',
  ...extra,
})

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(db())
    const parent = await db().product.create({ data: { sku: 'TEST-WIZ', name: 'Test jacket', basePrice: '99.00', isParent: true } })
    for (const [sku, asin] of [['TEST-WIZ-1', 'B0TESTWZ01'], ['TEST-WIZ-2', 'B0TESTWZ02']]) await db().product.create({ data: { sku, name: `Test ${sku}`, basePrice: '99.00', amazonAsin: asin, parentId: parent.id } })
    await db().product.create({ data: { sku: 'TEST-OTHER-1', name: 'Test gloves', basePrice: '29.00', amazonAsin: 'B0TESTOT01' } })
    for (const code of ['IT', 'DE']) await db().marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, region: 'EU', currency: 'EUR', language: 'en' } })
    await db().adSpendCeiling.create({ data: { grain: 'MARKET', scopeId: 'IT', label: 'the IT market', dailyCapCents: 5000 } })
    await db().amazonAdsPortfolio.create({ data: { profileId: 'P-IT-TEST', externalPortfolioId: 'PF-TEST-1', name: 'Test portfolio' } })
    // This product's own older campaign buys "moto jacket" (the blueprint gate's conflict); the fixture's "Italy exact"
    // buys "race jacket" and advertises no product of this family (another product's: listed, allowed).
    await db().campaign.create({ data: { id: 'c-own', name: 'Old jacket campaign', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-c-own', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z') } })
    await db().adGroup.create({ data: { id: 'g-c-own', campaignId: 'c-own', name: 'old group', externalAdGroupId: 'EXT-g-c-own' } })
    await db().adProductAd.create({ data: { adGroupId: 'g-c-own', asin: 'B0TESTWZ01', sku: 'TEST-WIZ-1', externalAdId: 'EXT-ad-own' } })
    await db().adTarget.create({ data: { id: 't-own', adGroupId: 'g-c-own', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'moto jacket', bidCents: 50, externalTargetId: 'EXT-t-own' } })
    await db().campaign.create({ data: { name: 'Taken-SP-Auto', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-taken', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z') } })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(() => {
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  amz.calls = []; amz.bids = []
})

describe('the preview, and what refuses it', () => {
  it('the wizard\'s own campaigns, born at the floor and off the allowlist, no rule, where it lands; rule 3', async () => {
    const r = await preview(set())
    expect(r.ok).toBe(true)
    const p = r.preview as Row
    expect(p.campaigns.map((c: Row) => c.name)).toEqual([
      'Test Jacket-SP-Auto',
      'Test Jacket-SP-Keyword-Brand-Broad', 'Test Jacket-SP-Keyword-Category-Broad',
      'Test Jacket-SP-Keyword-Brand-Phrase', 'Test Jacket-SP-Keyword-Category-Phrase',
      'Test Jacket-SP-Keyword-Brand-Exact', 'Test Jacket-SP-Keyword-Category-Exact',
      'Test Jacket-SP-PAT',
    ])
    expect(p.leftOut.map((l: Row) => l.name)).toEqual(['Test Jacket-SP-Keyword-Competitor-Broad', 'Test Jacket-SP-Keyword-Competitor-Phrase', 'Test Jacket-SP-Keyword-Competitor-Exact'])
    expect(p).toMatchObject({
      action: TOOL, structure: 'advanced', market: 'IT', currency: 'EUR', dailyBudgetCents: 4000, highestPlannedBidCents: 66,
      products: [{ sku: 'TEST-WIZ-1', asin: 'B0TESTWZ01' }, { sku: 'TEST-WIZ-2', asin: 'B0TESTWZ02' }],
      totals: { campaigns: 8, keywords: 9, productTargets: 1, autoGroups: 4, productAds: 16 },
      startsSuppressed: { floorCents: 2 }, liveWrites: false, placements: 'none', rules: expect.stringMatching(/^none: it creates no harvest/),
      reach: { reach: 'live', profileId: 'P-IT-TEST' }, ceiling: { label: 'the IT market', dailyCapCents: 5000 },
      limitFacts: { tool: TOOL, action: 'create' },
      sameProductClashes: [{ term: 'moto jacket', existing: [{ campaignId: 'c-own', campaignName: 'Old jacket campaign' }] }],
      sharedWithOtherProducts: [{ term: 'race jacket', existing: [{ campaignId: 'c-it', campaignName: 'Italy exact' }] }],
      effect: expect.stringMatching(/^Builds the SP Super Wizard's Advanced set "Test Jacket" in IT through its own launch: 8 Sponsored Products campaigns \(Auto, 6 keyword campaigns, product targeting\), EUR 40\.00 of daily budget in all, advertising 2 SKUs of one product\. Each is born ENABLED with every bid at the 2-cent floor/),
      undoNote: expect.stringMatching(/^Undo archives every campaign it made \(archive-ads buildRunId\)/),
    })
    // The funnel, inside the set: Auto negates the 3 keywords, Broad its type's as exact and phrase, Phrase as exact.
    expect(p.campaigns.map((c: Row) => c.negatives.funnel)).toEqual([3, 2, 4, 1, 2, 0, 0, 0])
    expect(p.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Accepted: 1 keyword this product already buys in other campaigns is bought by this set too \("moto jacket"\): both bid for it\./),
      expect.stringMatching(/^1 keyword is also bought by your other products' campaigns: allowed/),
    ]))
    expect(getTool(TOOL)).toMatchObject({
      alwaysAsk: true, maxClaudeTrust: 'auto', strategyBound: 'amazon-ads', reversibility: 'partial', openWorld: true, readOnly: false,
      requires: ['ads.campaigns.manage', 'ads.budgets.edit', FIELDS.financialsAdspendView],
    })
  })

  it('a keyword this product already buys elsewhere: not queued until skip or accept; skip leaves it where it runs', async () => {
    expect((await preview(set({ sameProductTerms: undefined }))).error)
      .toMatch(/^1 keyword of this set is already bought for this product in other campaigns \("moto jacket" in "Old jacket campaign"\): the set would bid against them\. Ask again with sameProductTerms skip/)
    const skipped = (await preview(set({ sameProductTerms: 'skip' }))).preview as Row
    expect(skipped).toMatchObject({ sameProductClashes: [], skippedSameProduct: [{ term: 'moto jacket' }], totals: { keywords: 6 } })
    expect(skipped.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^Skipped: 1 keyword this product already buys in other campaigns stays where it runs, not in this set\./)]))
    // Another product's keyword alone never stops it.
    expect((await preview(set({ sameProductTerms: undefined, keywords: { category: ['race jacket'] } }))).ok).toBe(true)
  })

  it('Custom, a Quick-like shape: Auto, a broad Research and an exact Performance campaign, named by the screen\'s tokens', async () => {
    const quick = (await preview(set({ structure: 'custom', keywords: undefined, productTargets: undefined, customKeywordTypes: [{ name: 'Research', matchTypes: ['BROAD'], keywords: ['race jacket'] }, { name: 'Performance', matchTypes: ['EXACT'], keywords: ['race jacket'] }] }))).preview as Row
    expect(quick.campaigns.map((c: Row) => c.name)).toEqual(['Test Jacket-SP-Auto', 'Test Jacket-SP-Keyword-Broad-Research', 'Test Jacket-SP-Keyword-Exact-Performance'])
    expect(quick.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^Listed under more than one keyword type, so more than one campaign of the set buys it: "race jacket"/)]))
  })

  it('refuses, and queues nothing', async () => {
    const error = async (extra: Record<string, unknown>) => (await preview(set(extra))).error
    expect(await error({ skus: ['TEST-WIZ-1', 'NOT-OURS-9'] })).toBe('SKU not found: NOT-OURS-9.')
    expect(await error({ skus: ['TEST-WIZ-1', 'TEST-OTHER-1'] })).toMatch(/^These SKUs are 2 different products: a set is built for ONE product/)
    expect(await error({ market: 'DE' })).toMatch(/^Set a spend ceiling for this market first: DE has no daily spend ceiling/)
    expect(await error({ dailyBudgetCents: 5001 })).toBe('A daily budget of EUR 50.01 is above the IT market\'s spend ceiling of EUR 50.00 a day.')
    expect(await error({ productGroupName: 'Taken' })).toMatch(/^Not queued: the SP Super Wizard refuses it — IT already has a campaign named "Taken-SP-Auto"/)
    expect(await error({ defaultBidCents: 600 })).toMatch(/^Not queued: the SP Super Wizard refuses it — .*a bid of €6\.60 is above the daily budget of €5\.00/)
    expect(await error({ negativeKeywords: [{ text: 'jacket', matchType: 'PHRASE' }] })).toMatch(/^The negative phrase "jacket" would stop the set's own keyword "testbrand jacket" \(broad\) in "Test Jacket-SP-Keyword-Brand-Broad"/)
    expect(await error({ overrides: [{ name: 'Nope-SP-Auto', dailyBudgetCents: 900 }] })).toMatch(/^No campaign of this set is named "Nope-SP-Auto"\. Its campaigns: "Test Jacket-SP-Auto"/)
    expect(await error({ portfolioId: 'PF-NOT-HERE' })).toMatch(/^Portfolio PF-NOT-HERE not found in IT's Amazon ads profile/)
    expect(await error({ structure: 'custom' })).toBe('keywords is for standard and advanced; a custom set names its keywords in customKeywordTypes.')
    expect(await error({ customTargeting: ['auto'] })).toBe('customKeywordTypes and customTargeting are for a custom set, not advanced.')
    expect(await error({ structure: 'custom', keywords: undefined, customTargeting: ['product'], productTargets: undefined })).toMatch(/^Nothing to build: every campaign of this custom set would have nothing to target/)
    expect(await inside(() => db().agentApproval.count())).toBe(0)
  })
})

describe('by rule: inside the strategy and its limits only', () => {
  it('the defaults refuse; an accepted same-product keyword is a person\'s; inside the strategy and the limits it may run', async () => {
    const accepted = (await preview(set({ productGroupName: 'Rule Jacket' }))).preview as Row
    expect(judge(accepted, { markets: ['IT'], maxCampaigns: 8, maxDailyBudgetCents: 4000, maxBidCents: 100 })).toMatch(/it buys 1 keyword this product already buys in other campaigns \(accepted\)/)
    const p = (await preview(set({ productGroupName: 'Rule Jacket', sameProductTerms: 'skip' }))).preview as Row
    expect(p.newMarket).toBeUndefined()
    expect(judge(p)).toMatch(/names no market where an SP Super Wizard build may run by rule/)
    expect(judge(p, { markets: ['DE'] })).toMatch(/only in DE/)
    expect(judge(p, { markets: ['IT'] })).toMatch(/there is no ads strategy for IT/)
    const row = await inside(() => db().adsStrategy.create({ data: {
      market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', updatedBy: 'user:test',
      claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 10, claudeMaxBudgetIncreasePerDayCents: 10_000, maxBidCents: 100,
    } }))
    try {
      const within = (await preview(set({ productGroupName: 'Rule Jacket', sameProductTerms: 'skip' }))).preview
      expect(judge(within, { markets: ['IT'] })).toMatch(/it creates 8 campaigns, more than the 0 this tool's limits let a build create by rule \(0: every build waits for a person\)/)
      expect(judge(within, { markets: ['IT'], maxCampaigns: 8 })).toMatch(/its daily budgets add up to EUR 40\.00, more than the EUR 0\.00/)
      expect(judge(within, { markets: ['IT'], maxCampaigns: 8, maxDailyBudgetCents: 4000 })).toMatch(/its highest planned bid EUR 0\.66 is above the EUR 0\.00/)
      expect(judge(within, { markets: ['IT'], maxCampaigns: 8, maxDailyBudgetCents: 4000, maxBidCents: 100 })).toBeNull()
      await inside(() => db().adsStrategy.update({ where: { id: row.id }, data: { maxBidCents: 65, version: 2 } }))
      expect(judge((await preview(set({ productGroupName: 'Rule Jacket', sameProductTerms: 'skip' }))).preview, { markets: ['IT'], maxCampaigns: 8, maxDailyBudgetCents: 4000, maxBidCents: 100 }))
        .toMatch(/its highest planned bid EUR 0\.66 is above the highest bid EUR 0\.65 \(ads strategy: Test market \(IT\)/)
    } finally {
      await inside(() => db().adsStrategy.delete({ where: { id: row.id } }))
    }
  })
})

describe('approved, it runs on its own and is born safe', () => {
  it('the approval answers with its run at once; the run builds the set at the floor, off the allowlist, no placement, no rule, the funnel inside the set', async () => {
    const rulesBefore = await inside(() => db().automationRule.count())
    const asked = await ask(set({
      keywords: { brand: ['testbrand jacket'], competitor: ['otherbrand jacket'], category: ['moto jacket', 'race jacket'] },
      negativeKeywords: [{ text: 'cheap', matchType: 'PHRASE' }], placements: { topOfSearchPct: 30 }, portfolioId: 'PF-TEST-1',
      overrides: [{ name: 'Test Jacket-SP-Keyword-Category-Exact', dailyBudgetCents: 900, defaultBidCents: 80 }],
      why: 'launch the jacket in Italy',
    }))
    expect(asked).toMatchObject({ ok: true, mode: 'queued' })
    const done = await approve(asked.approvalId!) as Row
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { status: 'RUNNING', changeSetId: asked.approvalId, suppressed: { by: 'user:u-asker', floorCents: 2 }, reach: { reach: 'live', profileId: 'P-IT-TEST' } } })
    const applicationId = done.result.applicationId as string
    // The change is recorded at once: its undo names the run, whatever the run does next.
    expect(await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId: asked.approvalId! }, select: { after: true } }))).toMatchObject({ after: { applicationId } })

    const row = await finished(applicationId)
    expect(row).toMatchObject({ status: 'APPLIED', marketplace: 'IT', productToken: 'Test Jacket', blueprintId: null, playbookId: null, launchMode: 'floor', options: { source: 'sp-wizard', changeSetId: asked.approvalId } })
    const ids = row.createdCampaignIds
    expect(ids).toHaveLength(11)
    expect((row.options as Row).placementsToAsk).toHaveLength(11)
    expect((row.options as Row).placementsToAsk[0]).toEqual({ campaignId: ids[0], topOfSearchPct: 30 })

    // Every campaign ENABLED, off the allowlist, in the portfolio, flagged suppressed by the person who asked.
    const campaigns = await inside(() => db().campaign.findMany({ where: { id: { in: ids } }, select: { status: true, liveBidWritesEnabled: true, bidsSuppressedBy: true, bidsSuppressedFloorCents: true, portfolioId: true, externalCampaignId: true } }))
    expect(campaigns).toHaveLength(11)
    expect(campaigns.every((c) => String(c.status) === 'ENABLED' && !c.liveBidWritesEnabled && c.bidsSuppressedBy === 'user:u-asker' && c.bidsSuppressedFloorCents === 2 && c.portfolioId === 'PF-TEST-1' && c.externalCampaignId)).toBe(true)
    // Every bid sent to Amazon is the floor; the planned ones are remembered (an override's too, and the Auto multipliers).
    expect(amz.bids.length).toBeGreaterThan(20)
    expect(amz.bids.filter((b) => Number(b.bid) !== 0.02)).toEqual([])
    const remembered = async (campaign: string, where: Record<string, unknown> = {}) => inside(() => db().adTarget.findMany({
      where: { adGroup: { campaign: { name: campaign } }, isNegative: false, ...where }, orderBy: { expressionValue: 'asc' }, select: { expressionValue: true, bidCents: true, suppressedFromBidCents: true },
    }))
    expect(await remembered('Test Jacket-SP-Keyword-Category-Exact')).toEqual([
      { expressionValue: 'moto jacket', bidCents: 2, suppressedFromBidCents: 80 }, { expressionValue: 'race jacket', bidCents: 2, suppressedFromBidCents: 80 },
    ])
    expect(await remembered('Test Jacket-SP-Auto', { expressionValue: { in: ['CLOSE_MATCH', 'LOOSE_MATCH'] } })).toEqual([
      { expressionValue: 'CLOSE_MATCH', bidCents: 2, suppressedFromBidCents: 60 }, { expressionValue: 'LOOSE_MATCH', bidCents: 2, suppressedFromBidCents: 39 },
    ])
    const exactCampaign = await inside(() => db().campaign.findFirstOrThrow({ where: { name: 'Test Jacket-SP-Keyword-Category-Exact' }, select: { dailyBudget: true } }))
    expect(Number(exactCampaign.dailyBudget)).toBe(9)

    // The funnel's negatives and yours: only in the set's own ad groups; no other campaign got one.
    const negatives = await inside(() => db().adTarget.findMany({ where: { isNegative: true, adGroup: { campaign: { name: 'Test Jacket-SP-Keyword-Category-Broad' } } }, orderBy: [{ expressionType: 'asc' }, { expressionValue: 'asc' }], select: { expressionType: true, expressionValue: true } }))
    expect(negatives.map((n) => `${n.expressionType} ${n.expressionValue}`)).toEqual([
      'NEGATIVE_EXACT moto jacket', 'NEGATIVE_EXACT race jacket', 'NEGATIVE_PHRASE cheap', 'NEGATIVE_PHRASE moto jacket', 'NEGATIVE_PHRASE race jacket',
    ])
    expect(await inside(() => db().adTarget.count({ where: { isNegative: true, adGroup: { campaignId: { in: ['c-it', 'c-own', 'c-off', 'c-uk'] } } } }))).toBe(1)
    // No placement written (it waits for the allowlist), no rule created.
    expect(amz.calls).not.toContain('campaigns/update')
    expect(await inside(() => db().automationRule.count())).toBe(rulesBefore)

    // Every create it wrote carries the approval as change set, written as the approver.
    const logs = await inside(() => db().advertisingActionLog.findMany({ where: { actionType: { startsWith: 'create_' }, OR: [{ entityId: { in: ids } }, { executionId: asked.approvalId }] }, select: { executionId: true, userId: true } }))
    expect(logs.length).toBeGreaterThan(50)
    expect(new Set(logs.map((l) => `${l.executionId} ${l.userId}`))).toEqual(new Set([`${asked.approvalId} user:u-approver`]))

    // approval-status and ads-playbook view build follow the run; Replicate's raise and rollback refuse it.
    const s = (await inside(() => callTool(claude, 'approval-status', { approvalId: asked.approvalId! }))).visible.data as Row
    expect(s).toMatchObject({ status: 'executed', ads: { reach: 'live', build: { applicationId, status: 'APPLIED', campaigns: 11 } } })
    expect(s.ads.build.stopped).toBeUndefined()
    expect(s.ads.created.atAmazon).toBeGreaterThan(50)
    expect(s.change).toMatchObject({ reversibility: 'partial' })
    const view = (await preview({ view: 'build', applicationId }, 'ads-playbook')).data as Row
    expect(view).toMatchObject({ view: 'build', run: { applicationId, status: 'APPLIED', placementsToAsk: expect.any(Array) }, note: expect.stringMatching(/^A one-off SP Super Wizard set Claude asked for/) })
    expect(view.run.created).toHaveLength(11)
    await expect(inside(() => raiseApplicationBids(applicationId))).rejects.toThrow(WIZARD_RUN)
    await expect(inside(() => rollbackApplication(applicationId))).rejects.toThrow(WIZARD_RUN)

    // Undo archives every campaign its run made.
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'archive-ads', args: { buildRunId: applicationId } } })
    expect(((await preview({ buildRunId: applicationId }, 'archive-ads')).preview as Row).totals).toMatchObject({ changing: 11 })
    // Asking again for the same set is refused: its names are taken now.
    expect((await preview(set())).error).toMatch(/IT already has a campaign named "Test Jacket-SP-Auto"/)
  })

  it('a run a deploy killed (no progress for 30 minutes, nothing on its row) is said, and its undo still names and archives what it made', async () => {
    const asked = await ask(set({ productGroupName: 'Killed', structure: 'standard' }))
    const done = await approve(asked.approvalId!) as Row
    const applicationId = done.result.applicationId as string
    const made = (await finished(applicationId)).createdCampaignIds
    expect(made).toHaveLength(4)
    // As a deploy leaves it: still RUNNING, its last progress 31 minutes ago, before it recorded what it made.
    await inside(() => db().adBlueprintApplication.update({ where: { id: applicationId }, data: { status: 'RUNNING', createdCampaignIds: [], progress: { done: 2, total: 4, campaign: 'Killed-SP-Keyword-Category', created: 2, at: new Date(Date.now() - 31 * 60_000).toISOString() } } }))
    const s = (await inside(() => callTool(claude, 'approval-status', { approvalId: asked.approvalId! }))).visible.data as Row
    expect(s.ads.build).toMatchObject({ applicationId, status: 'RUNNING', stopped: true })
    const undo = await inside(() => undoRequestFor({ approvalId: asked.approvalId! })) as Row
    expect(undo).toMatchObject({ request: { tool: 'archive-ads', args: { buildRunId: applicationId } } })
    // The archive names every campaign its change set's audit rows say it made, and marks the run FAILED when it runs.
    const archive = await ask(undo.request.args, 'archive-ads')
    expect(archive).toMatchObject({ ok: true, mode: 'queued' })
    expect(await approve(archive.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    const row = await inside(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: applicationId } }))
    expect(row.status).toBe('FAILED')
    expect([...row.createdCampaignIds].sort()).toEqual([...made].sort())
    expect(row.errors.join(' ')).toMatch(/stopped without finishing at "Killed-SP-Keyword-Category"/)
  })

  it('a set whose basis moved after approval is not run, and nothing is created', async () => {
    const asked = await ask(set({ productGroupName: 'Moved', structure: 'standard' }))
    await inside(() => db().product.update({ where: { sku: 'TEST-WIZ-2' }, data: { amazonAsin: 'B0MOVEDWZ2' } }))
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/basis changed/) })
    expect(await inside(() => db().campaign.count({ where: { name: { startsWith: 'Moved' } } }))).toBe(0)
    expect(await inside(() => db().adBlueprintApplication.count({ where: { productToken: 'Moved' } }))).toBe(0)
    expect(amz.calls).toEqual([])
  })
})

/**
 * ADS AUTONOMY B-1 — replicate-ad-structure, run for real through the door and the approval gate (PGlite, production
 * schema; the job queue a stub; the ads write gate the real one, sandbox). The Replicate Structure run is the real one
 * (`startBlueprintRun` → `applyBlueprint`, every create service real); only the placement write, the portfolio read-back
 * and the launch read-back are stand-ins (they would read Amazon). Values are made up.
 *
 *   preview   the copy (each campaign from its source, counts, budget and highest planned bid, the placements it leaves
 *             for later), born at the floor and off the allowlist, where it lands, the strategy's facts; rule 3: a keyword
 *             another product buys is listed, one the product's own campaigns buy refuses it until skipped or accepted
 *   refused   and not queued: a source campaign not found or of another market, an unknown or unlisted SKU, no spend
 *             ceiling, another currency without fixed bids and budgets
 *   by rule   the default limits refuse it (maxCampaigns 0); inside the strategy and limits it may run; an accepted
 *             clash never runs by rule
 *   approved  RUNNING at once, detached; the campaigns ENABLED, OFF the allowlist, every bid at the 2-cent floor with the
 *             planned bid remembered, suppressed by the person who asked, no placements (kept on the run), every create
 *             on the approval's change set, written as the approver; approval-status follows the run; undo is
 *             archive-ads buildRunId; restore-campaign may give the bids back; Replicate's raise refuses it
 *   screen    the screen's run is unchanged: allowlisted at birth, placements written, no change set
 *   stopped   a run of Claude's a deploy killed is found by its change set and marked FAILED; a screen run is untouched
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
/** The placement write (a recorder) and the portfolio read-back: both would reach Amazon. */
const placements = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('../../advertising/ads-create.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  updatePlacementBidding: async (input: { campaignId: string; adjustments: unknown[] }) => {
    placements.calls.push(input.campaignId)
    return { ok: true, adjustments: input.adjustments, mode: 'sandbox' }
  },
  settleLaunchPortfolios: async () => null,
}))
vi.mock('../../advertising/ads-launch-verify.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyLaunch: async () => ({ ok: true, problems: [], entities: [] }),
}))

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
type Row = Record<string, any>
const db = () => database.client
const preview = async (args: Record<string, unknown>, tool = 'replicate-ad-structure') => (await inside(() => callTool(claude, tool, args))).raw
async function ask(args: Record<string, unknown>) {
  return inside(async () => {
    const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool('replicate-ad-structure', args, claude, run.id, { forceAsk: true })
  })
}
const approve = (approvalId: string) => inside(() => decideApproval(approvalId, 'approve', approver))
const sql = <T = Row>(text: string, params: unknown[] = []) => inside(async () => (await db().$queryRawUnsafe(text, ...params)) as T[])
const finished = async (applicationId: string) => {
  await vi.waitFor(async () => {
    const row = await inside(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: applicationId }, select: { status: true } }))
    if (row.status === 'RUNNING') throw new Error('still running')
  }, { timeout: 20_000, interval: 50 })
}
const judge = (p: unknown, limits: Record<string, unknown> = {}) => {
  const t = getTool('replicate-ad-structure')!
  return t.withinLimits!(p, t.limits!.parse(limits) as Record<string, unknown>)
}

/** The source: one manual campaign of the TESTSRC product in IT (a brand keyword, two category keywords, a negative, a placement). */
const copy = (extra: Record<string, unknown> = {}) => ({
  sourceMarket: 'IT', campaignIds: ['c-src'], sourceProductToken: 'TESTSRC', market: 'IT', productToken: 'TESTNEW',
  skus: ['TEST-NEW-1', 'TEST-NEW-2'], skipTerms: ['winter boots'], ...extra,
})

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(db())
    for (const [code, currency] of [['IT', 'EUR'], ['UK', 'GBP'], ['DE', 'EUR']]) {
      await db().marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, region: 'EU', currency, language: 'en' } })
    }
    await db().adSpendCeiling.create({ data: { grain: 'MARKET', scopeId: 'IT', label: 'the IT market', dailyCapCents: 5000 } })
    const product = async (sku: string, asin: string | null, markets: string[], extra: Record<string, unknown> = {}) => {
      const p = await db().product.create({ data: { sku, name: `Test ${sku}`, basePrice: '99.00', amazonAsin: asin, ...extra } })
      for (const market of markets) await db().channelListing.create({ data: { productId: p.id, channel: 'AMAZON', marketplace: market, region: market, channelMarket: `AMAZON_${market}`, listingStatus: 'ACTIVE' } })
      return p
    }
    await product('TEST-NEW-1', 'B0NEWASN01', ['IT', 'UK'])
    await product('TEST-NEW-2', 'B0NEWASN02', ['IT'])
    await product('TEST-UNLISTED', 'B0NEWASN03', [])
    await product('TEST-SCR-1', 'B0SCRASN01', ['IT'])
    await db().campaign.create({ data: {
      id: 'c-src', name: 'TESTSRC Exact IT', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-c-src',
      dailyBudget: '12.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, biddingStrategy: 'LEGACY_FOR_SALES', targetingType: 'MANUAL',
      dynamicBidding: { placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 50 }] },
    } })
    await db().adGroup.create({ data: { id: 'g-src', campaignId: 'c-src', name: 'TESTSRC exact group', defaultBidCents: 40, externalAdGroupId: 'EXT-g-src' } })
    const target = (text: string, type: string, bidCents: number, extra: Record<string, unknown> = {}) =>
      db().adTarget.create({ data: { adGroupId: 'g-src', kind: 'KEYWORD', expressionType: type, expressionValue: text, bidCents, externalTargetId: `EXT-${text}`, ...extra } })
    await target('testsrc jacket', 'EXACT', 60)
    await target('race jacket', 'PHRASE', 45)
    await target('winter boots', 'BROAD', 30)
    await target('cheap', 'EXACT', 0, { isNegative: true, negativeLevel: 'AD_GROUP' })
    await db().adProductAd.create({ data: { adGroupId: 'g-src', asin: 'B0SRCASN01', externalAdId: 'EXT-pa-src' } })
    // The new product's own older campaign already buys "winter boots" (rule 3: a clash of its own).
    await db().campaign.create({ data: { id: 'c-own', name: 'TESTNEW own boots', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-c-own', dailyBudget: '5.00', startDate: new Date('2026-01-01T00:00:00Z') } })
    await db().adGroup.create({ data: { id: 'g-own', campaignId: 'c-own', name: 'own boots group', externalAdGroupId: 'EXT-g-own' } })
    await db().adTarget.create({ data: { adGroupId: 'g-own', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'winter boots', bidCents: 25, externalTargetId: 'EXT-own-boots' } })
    await db().adProductAd.create({ data: { adGroupId: 'g-own', asin: 'B0NEWASN01', externalAdId: 'EXT-pa-own' } })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)

describe('B-1 — the copy, and what refuses it', () => {
  it('previews each campaign from its source, born at the floor and off the allowlist, its placements left for once it is live', async () => {
    const r = await preview(copy())
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      action: 'replicate-ad-structure', builder: 'Replicate Structure', market: 'IT', currency: 'EUR', productToken: 'TESTNEW',
      source: { market: 'IT', campaigns: [{ campaignId: 'c-src', name: 'TESTSRC Exact IT' }], productToken: 'TESTSRC' },
      products: [{ sku: 'TEST-NEW-1', asin: 'B0NEWASN01' }, { sku: 'TEST-NEW-2', asin: 'B0NEWASN02' }],
      campaigns: [{ name: 'TESTNEW Exact IT', from: 'TESTSRC Exact IT', targeting: 'MANUAL', adGroups: 1, dailyBudgetCents: 1200, startBidCents: 60, keywords: 2, negatives: 1, placementsOnceLive: [{ placement: 'PLACEMENT_TOP', percentage: 50 }] }],
      totals: { campaigns: 1, adGroups: 1, positives: 2, negatives: 1, productAds: 2 },
      dailyBudgetCents: 1200, highestPlannedBidCents: 60,
      // Rule 3 — other products' campaigns buy "race jacket" (the source product's own among them): listed, allowed, never negated.
      sharedWithOtherProducts: [{ expression: 'race jacket', existing: [{ campaignName: 'Italy exact', campaignId: 'c-it' }, { campaignName: 'TESTSRC Exact IT', campaignId: 'c-src' }] }],
      startsSuppressed: { floorCents: 2, by: 'the person who asked' }, liveWrites: false, rules: expect.stringMatching(/^none/),
      ceiling: { label: 'the IT market', dailyCapCents: 5000 }, reach: { reach: 'sandbox' },
      limitFacts: { tool: 'replicate-ad-structure', action: 'create' },
      effect: expect.stringMatching(/born ENABLED with every bid at the 2-cent floor .* off the live-write allowlist, without its placements .* and with no rules/),
      undoNote: expect.stringMatching(/archive-ads buildRunId/),
    })
    expect(r.preview.acceptedTerms).toBeUndefined()
    expect(getTool('replicate-ad-structure')).toMatchObject({
      alwaysAsk: true, maxClaudeTrust: 'auto', strategyBound: 'amazon-ads', reversibility: 'partial', openWorld: true, readOnly: false,
      requires: ['ads.campaigns.manage', 'ads.budgets.edit', FIELDS.financialsAdspendView],
    })
  })

  it("refuses a keyword the product's own campaigns buy until it is skipped or accepted by name", async () => {
    const r = await preview(copy({ skipTerms: undefined }))
    expect(r.error).toMatch(/^Not queued: Replicate's gate refuses this copy — 1 keyword\(s\) would make TESTNEW bid against campaigns you already run for it \("winter boots"\)/)
    expect(r.error).toMatch(/already buy "winter boots" \("TESTNEW own boots"\): name each in skipTerms .* or acceptTerms/)
    const accepted = (await preview(copy({ skipTerms: undefined, acceptTerms: ['winter boots'] }))).preview as Row
    expect(accepted).toMatchObject({ acceptedTerms: ['winter boots'], totals: { positives: 3 } })
    // An accepted clash never runs by rule, whatever the limits.
    expect(judge(accepted, { maxCampaigns: 5, maxDailyBudgetCents: 100_000, maxBidCents: 1000 })).toMatch(/^it creates 1 keyword the product's own campaigns already buy \(accepted\): the product would bid against itself/)
  })

  it('refuses, and queues nothing: a source not found or of another market, an unknown or unlisted SKU, no ceiling, another currency', async () => {
    const error = async (extra: Record<string, unknown>) => (await preview(copy(extra))).error
    expect(await error({ campaignIds: ['c-nope'] })).toBe('Source campaign not found in this business: c-nope.')
    expect(await error({ campaignIds: ['c-src', 'c-uk'] })).toMatch(/^Not queued: "UK exact \(UK\)" does not run in IT \(sourceMarket\)/)
    expect(await error({ campaignIds: ['c-sb'] })).toMatch(/Sponsored Products campaigns only/)
    expect(await error({ adGroupIds: ['g-c-it'] })).toBe('Ad group not found in the source campaigns: g-c-it.')
    expect(await error({ skus: ['TEST-NEW-1', 'NOT-OURS-9'] })).toBe('SKU not found: NOT-OURS-9.')
    expect(await error({ skus: ['TEST-UNLISTED'] })).toBe('Not queued: the copy of "TESTSRC Exact IT" would have nothing to advertise for one product — TEST-UNLISTED is not listed on Amazon in IT.')
    expect(await error({ market: 'DE', skus: ['TEST-NEW-1'] })).toMatch(/TEST-NEW-1 is not listed on Amazon in DE/)
    expect(await error({ market: 'UK', skus: ['TEST-NEW-1'] })).toMatch(/^Not queued: the source campaigns are in EUR \(IT\) and the copy would be in GBP \(UK\): bids and budgets are never converted/)
    expect(await error({ market: 'UK', skus: ['TEST-NEW-1'], bidPolicy: { mode: 'fixed', value: 50 }, budgetPolicy: { mode: 'fixed', value: 1000 } })).toMatch(/^Set a spend ceiling for this market first: UK/)
    expect(await error({ budgetPolicy: { mode: 'fixed', value: 6000 } })).toBe("Its daily budgets add up to EUR 60.00, above the IT market's spend ceiling of EUR 50.00 a day.")
    expect(await error({ bidPolicy: { mode: 'scale' } })).toBe('bidPolicy scale needs a value.')
    expect((await sql<{ n: number }>('SELECT count(*)::int AS n FROM "AgentApproval"'))[0].n).toBe(0)
  })
})

describe('B-1 — by rule: inside the strategy and its limits only', () => {
  it('the default limits refuse it (maxCampaigns 0); inside the strategy and limits it may run; above them a person decides', async () => {
    const p = (await preview(copy())).preview as Row
    expect(judge(null)).toMatch(/no preview of this copy/)
    expect(judge(p, { maxCampaigns: 5, maxDailyBudgetCents: 5000, maxBidCents: 100 })).toMatch(/there is no ads strategy for IT/)
    const row = await inside(() => db().adsStrategy.create({ data: {
      market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', updatedBy: 'user:test',
      claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 10, claudeMaxBudgetIncreasePerDayCents: 5000, maxBidCents: 100,
    } }))
    try {
      const allowed = (await preview(copy())).preview
      expect(judge(allowed)).toMatch(/it creates 1 campaign, more than the 0 this tool's limits let a copy create by rule \(0: every copy waits for a person\)/)
      expect(judge(allowed, { maxCampaigns: 1 })).toMatch(/daily budgets add up to EUR 12\.00, more than the EUR 0\.00/)
      expect(judge(allowed, { maxCampaigns: 1, maxDailyBudgetCents: 1200 })).toMatch(/highest planned bid EUR 0\.60 is above the EUR 0\.00/)
      expect(judge(allowed, { maxCampaigns: 1, maxDailyBudgetCents: 1200, maxBidCents: 60 })).toBeNull()
      expect(judge(allowed, { maxCampaigns: 1, maxDailyBudgetCents: 1200, maxBidCents: 60, markets: ['DE'] })).toMatch(/only in DE/)
      await inside(() => db().adsStrategy.update({ where: { id: row.id }, data: { maxBidCents: 50, version: 2 } }))
      expect(judge((await preview(copy())).preview, { maxCampaigns: 1, maxDailyBudgetCents: 1200, maxBidCents: 60 }))
        .toMatch(/its highest planned bid EUR 0\.60 is above the highest bid EUR 0\.50 \(ads strategy: Test market \(IT\)/)
    } finally {
      await inside(() => db().adsStrategy.delete({ where: { id: row.id } }))
    }
  })
})

describe('B-1 — approved, it is born safe', () => {
  let applicationId = ''
  let campaignId = ''
  let approvalId = ''

  it('runs detached; ENABLED, off the allowlist, at the floor with the planned bids remembered for the person who asked, no placements', async () => {
    placements.calls.length = 0
    const asked = await ask(copy({ why: 'copy the jacket structure onto the new jacket' }))
    expect(asked).toMatchObject({ ok: true, mode: 'queued' })
    approvalId = asked.approvalId!
    const done = await approve(approvalId)
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { status: 'RUNNING', reach: { reach: 'sandbox' }, changeSetId: approvalId } })
    applicationId = (done as Row).result.applicationId
    await finished(applicationId)

    const [made] = await sql('SELECT id, status, "liveBidWritesEnabled" AS live, "bidsSuppressedBy" AS by, "bidsSuppressedFloorCents" AS floor, "bidsSuppressedAt" IS NOT NULL AS suppressed, "dailyBudget"::text AS budget FROM "Campaign" WHERE name = $1', ['TESTNEW Exact IT'])
    campaignId = made.id
    expect(made).toMatchObject({ status: 'ENABLED', live: false, by: 'user:u-asker', floor: 2, suppressed: true, budget: '12.00' })
    expect(await sql('SELECT "defaultBidCents" AS bid, "suppressedFromBidCents" AS kept, name FROM "AdGroup" WHERE "campaignId" = $1', [campaignId])).toEqual([{ bid: 2, kept: 40, name: 'TESTNEW exact group' }])
    const targets = await sql('SELECT t."expressionValue" AS text, t."isNegative" AS neg, t."bidCents" AS bid, t."suppressedFromBidCents" AS kept FROM "AdTarget" t JOIN "AdGroup" g ON g.id = t."adGroupId" WHERE g."campaignId" = $1 ORDER BY lower(t."expressionValue")', [campaignId])
    // The negative is made too (part of the creation, though the campaign is off the allowlist); "winter boots" was skipped.
    expect(targets).toEqual([
      { text: 'cheap', neg: true, bid: 0, kept: null },
      { text: 'race jacket', neg: false, bid: 2, kept: 45 },
      { text: 'TESTNEW jacket', neg: false, bid: 2, kept: 60 },
    ])
    expect(await sql('SELECT a.asin FROM "AdProductAd" a JOIN "AdGroup" g ON g.id = a."adGroupId" WHERE g."campaignId" = $1 ORDER BY a.asin', [campaignId])).toEqual([{ asin: 'B0NEWASN01' }, { asin: 'B0NEWASN02' }])
    // No placement written: they are kept on the run for once it is live.
    expect(placements.calls).toEqual([])
    const run = await inside(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: applicationId } }))
    expect(run).toMatchObject({ launchMode: 'floor', playbookId: null, actor: 'user:u-approver', createdCampaignIds: [campaignId] })
    expect(['APPLIED', 'PARTIAL']).toContain(run.status)
    expect(run.options).toMatchObject({ source: 'claude', changeSetId: approvalId, requester: 'user:u-asker', deferredPlacements: [{ campaignId, campaign: 'TESTNEW Exact IT', placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 50 }] }] })
    // Every create on the approval's change set, written as the approver (never as Claude).
    expect(await sql('SELECT "entityId" AS id FROM "AdvertisingActionLog" WHERE "executionId" = $1 AND "actionType" = $2', [approvalId, 'create_campaign'])).toEqual([{ id: campaignId }])
    expect(await sql('SELECT DISTINCT "userId" AS who FROM "AdvertisingActionLog" WHERE "executionId" = $1', [approvalId])).toEqual([{ who: 'user:u-approver' }])
    expect((await sql<{ n: number }>('SELECT count(*)::int AS n FROM "AdvertisingActionLog" WHERE "executionId" = $1', [approvalId]))[0].n).toBeGreaterThanOrEqual(5)
  })

  it('approval-status follows the run; undo is archive-ads of what it made; restore-campaign may give the bids back; Replicate\'s raise refuses it', async () => {
    const s = (await inside(() => callTool(claude, 'approval-status', { approvalId }))).visible.data as Row
    expect(s).toMatchObject({ status: 'executed', ads: { reach: 'sandbox', build: { applicationId, campaigns: 1 } } })
    expect(s.ads.created.total).toBeGreaterThan(0)
    expect(await inside(() => undoRequestFor({ approvalId }))).toMatchObject({ request: { tool: 'archive-ads', args: { buildRunId: applicationId } } })
    expect((await preview({ buildRunId: applicationId }, 'archive-ads')).preview).toMatchObject({ permanent: expect.stringMatching(/^PERMANENT/) })
    // The person who asked holds the floor: restore-campaign (its own request) may put the planned bids back.
    expect((await preview({ campaignId }, 'restore-campaign')).preview).toMatchObject({ suppressedBy: 'user:u-asker', restores: { targets: 2, adGroups: 1 } })
    const { raiseApplicationBids, CLAUDE_RUN } = await import('../../advertising/ads-blueprint-apply.service.js')
    await expect(inside(() => raiseApplicationBids(applicationId, 'user:u-screen'))).rejects.toThrow(CLAUDE_RUN)
    // Asked again, the names are taken now: refused, not queued.
    expect((await preview(copy())).error).toMatch(/already exist in this marketplace|already has a campaign named/)
  })
})

describe('B-1 — the screen\'s run is unchanged', () => {
  it('allowlisted at birth, its placements written, no change set, no suppression holder', async () => {
    placements.calls.length = 0
    const { applyBlueprint } = await import('../../advertising/ads-blueprint-apply.service.js')
    const out = await inside(() => applyBlueprint({
      source: { campaignIds: ['c-src'], marketplace: 'IT' }, sourceProductToken: 'TESTSRC', target: { productToken: 'TESTSCR', asins: ['B0SCRASN01'] },
      marketplace: 'IT', options: { skipSharedTargets: ['winter boots'] }, launchMode: 'floor', dryRun: false, actor: 'user:u-screen',
    }))
    expect(out.created.campaigns).toBe(1)
    const [made] = await sql('SELECT id, "liveBidWritesEnabled" AS live, "bidsSuppressedBy" AS by, "bidsSuppressedAt" IS NOT NULL AS suppressed FROM "Campaign" WHERE name = $1', ['TESTSCR Exact IT'])
    expect(made).toMatchObject({ live: true, by: null, suppressed: true })
    expect(placements.calls).toEqual([made.id])
    const run = await inside(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: out.applicationId } }))
    expect(run.options).toEqual({})
    expect((await sql<{ n: number }>('SELECT count(*)::int AS n FROM "AdvertisingActionLog" WHERE "entityId" = $1 AND "executionId" IS NOT NULL', [made.id]))[0].n).toBe(0)
  })
})

describe('B-1 — a run of Claude\'s that a deploy killed', () => {
  it('is found by its change set and marked FAILED (archive-ads then names what it made); a screen run is untouched', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    const ids = await inside(async () => {
      const camp = await db().campaign.create({ data: { name: 'TESTSTALE half made', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-stale', dailyBudget: '5.00', startDate: new Date() } })
      await db().advertisingActionLog.create({ data: { executionId: 'cs-stale', userId: 'user:u-approver', actionType: 'create_campaign', entityType: 'CAMPAIGN', entityId: camp.id, payloadBefore: {}, payloadAfter: {} } })
      const base = { productToken: 'TESTSTALE', marketplace: 'IT', asins: ['B0STALE001'], status: 'RUNNING', plan: {}, startedAt: old, createdAt: old }
      const claudeRun = await db().adBlueprintApplication.create({ data: { ...base, options: { source: 'claude', changeSetId: 'cs-stale', requester: 'user:u-asker' }, progress: { done: 0, total: 2, campaign: 'TESTSTALE half made', at: old.toISOString() } } })
      const screenRun = await db().adBlueprintApplication.create({ data: { ...base, progress: { done: 0, total: 2, campaign: null } } })
      return { camp: camp.id, claudeRun: claudeRun.id, screenRun: screenRun.id }
    })
    const svc = await import('../../advertising/ads-blueprint-apply.service.js')
    expect(await inside(() => svc.replicateRunCampaigns(ids.claudeRun))).toEqual({ campaignIds: [ids.camp], status: 'FAILED', stopped: true })
    expect(await inside(() => svc.replicateRunCampaigns(ids.screenRun))).toMatchObject({ refusal: expect.stringMatching(/still running/) })
    expect((await preview({ buildRunId: ids.claudeRun }, 'archive-ads')).ok).toBe(true)
    expect(await inside(() => svc.settleStoppedReplicates({ market: 'IT', productToken: 'TESTSTALE' }))).toBe(1)
    const rows = await inside(() => db().adBlueprintApplication.findMany({ where: { id: { in: [ids.claudeRun, ids.screenRun] } }, select: { id: true, status: true, createdCampaignIds: true, errors: true } }))
    expect(rows.find((r) => r.id === ids.claudeRun)).toMatchObject({ status: 'FAILED', createdCampaignIds: [ids.camp], errors: [expect.stringMatching(/stopped without finishing at "TESTSTALE half made".*archive-ads buildRunId/)] })
    expect(rows.find((r) => r.id === ids.screenRun)).toMatchObject({ status: 'RUNNING', createdCampaignIds: [] })
  })
})

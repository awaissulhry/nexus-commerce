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
 *   W4-10     into another market: every keyword and negative translated or kept (each listed from → to), the market's
 *             checked limits, its production connection with writes and the product ACTIVE there required, category
 *             targets refused, rule 3 judged on the translated text there, the currency stated; approved, the run builds
 *             the translations (and refuses a term it has none for); through a change plan too
 */
import { randomUUID } from 'node:crypto'
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
/** W4-10 — Amazon's checked limits: `uk` stands a GBP row in for UK (none is checked today), so the currency rules are reached. */
const limits = vi.hoisted(() => ({ uk: false }))
vi.mock('@nexus/shared/ads-market-limits', async (importOriginal) => {
  const real = await importOriginal<typeof import('@nexus/shared/ads-market-limits')>()
  const uk = { market: 'UK', currency: 'GBP', adProducts: { SPONSORED_PRODUCTS: { bid: { min: 2, max: 100_000 }, dailyBudget: { min: 100, max: 100_000_000 } } }, source: 'test' }
  return { ...real, marketLimitsOf: (m: string | null | undefined) => (limits.uk && (m ?? '').trim().toUpperCase() === 'UK' ? uk : real.marketLimitsOf(m)) }
})
/** The placement write (a recorder) and the end-of-run portfolio read-back (a recorder of how it was asked). */
const placements = vi.hoisted(() => ({ calls: [] as string[], portfolio: [] as Array<{ ids: string[]; opts: unknown }> }))
vi.mock('../../advertising/ads-create.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  updatePlacementBidding: async (input: { campaignId: string; adjustments: unknown[] }) => {
    placements.calls.push(input.campaignId)
    return { ok: true, adjustments: input.adjustments, mode: 'sandbox' }
  },
  settleLaunchPortfolios: async (ids: string[], opts: unknown = {}) => { placements.portfolio.push({ ids, opts }); return null },
}))
/** The launch read-back; `stopMidRun` marks the named run FAILED as it reads back (a settle while the run was slow). */
const verify = vi.hoisted(() => ({ stopMidRun: null as null | string }))
vi.mock('../../advertising/ads-launch-verify.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyLaunch: async () => {
    if (verify.stopMidRun) await database.client.adBlueprintApplication.updateMany({ where: { productToken: verify.stopMidRun, status: 'RUNNING' }, data: { status: 'FAILED', errors: ['the run stopped without finishing (test)'] } })
    return { ok: true, problems: [], entities: [] }
  },
}))
/** Amazon, where a live test reaches it: an archive (Amazon's delete), a campaign read and a campaign update, recorded. */
const amazon = vi.hoisted(() => ({ archived: [] as string[], updates: [] as Array<{ externalId: string; patch: Record<string, unknown> }>, campaignsV3: [] as Array<Record<string, unknown>> }))
vi.mock('../../advertising/ads-api-client.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  archiveSpEntity: async (_ctx: unknown, _entity: unknown, externalId: string) => { amazon.archived.push(externalId); return { ok: true, mode: 'live', rawResponse: {}, error: null } },
  listCampaignsV3: async () => amazon.campaignsV3,
  updateCampaign: async (_ctx: unknown, externalId: string, patch: Record<string, unknown>) => { amazon.updates.push({ externalId, patch }); return { ok: true, mode: 'live', rawResponse: {}, error: null } },
}))

import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { commitScheduledApproval, decideFleetApproval } from '../../agent-fleet/approval-inbox.service.js'
import { resolveRequest } from '../../agent-fleet/approval-target.js'
import { runPlan } from '../change-plan.service.js'
import { claudeGateRule } from '../../mcp/mcp-tool-call.js'
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
/** A person who belongs to the business (a change plan's commit checks that the approver still does). */
const member = { userId: '' }
type Row = Record<string, any>
const db = () => database.client
const preview = async (args: Record<string, unknown>, tool = 'replicate-ad-structure') => (await inside(() => callTool(claude, tool, args))).raw
async function ask(args: Record<string, unknown>, tool = 'replicate-ad-structure') {
  return inside(async () => {
    const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool(tool, args, claude, run.id, { forceAsk: true })
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
  const role = await db().role.create({
    data: { key: `W410_${randomUUID().slice(0, 8)}`, name: 'Copy tester', description: 'test', isSystem: false, permissions: [...Object.values(FEATURES), ...Object.values(FIELDS)] },
  })
  const profile = await db().userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Test approver' } })
  member.userId = profile.id
  await db().userRole.create({ data: { userId: profile.id, roleId: role.id } })
  const membership = await db().workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId: profile.id, status: 'active' } })
  await db().workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  await inside(async () => {
    await seedAdsFixture(db())
    for (const [code, currency] of [['IT', 'EUR'], ['UK', 'GBP'], ['DE', 'EUR'], ['FR', 'EUR']]) {
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
    // An archived keyword serves nothing: the tool's copy leaves it out.
    await target('old jacket', 'EXACT', 70, { status: 'ARCHIVED' })
    await db().campaign.create({ data: { id: 'c-old', name: 'TESTSRC Old IT', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-c-old', dailyBudget: '3.00', startDate: new Date('2025-01-01T00:00:00Z'), status: 'ARCHIVED' } })
    await db().adProductAd.create({ data: { adGroupId: 'g-src', asin: 'B0SRCASN01', externalAdId: 'EXT-pa-src' } })
    // The new product's own older campaign already buys "winter boots" (rule 3: a clash of its own).
    await db().campaign.create({ data: { id: 'c-own', name: 'TESTNEW own boots', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-c-own', dailyBudget: '5.00', startDate: new Date('2026-01-01T00:00:00Z') } })
    await db().adGroup.create({ data: { id: 'g-own', campaignId: 'c-own', name: 'own boots group', externalAdGroupId: 'EXT-g-own' } })
    await db().adTarget.create({ data: { adGroupId: 'g-own', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'winter boots', bidCents: 25, externalTargetId: 'EXT-own-boots' } })
    await db().adProductAd.create({ data: { adGroupId: 'g-own', asin: 'B0NEWASN01', externalAdId: 'EXT-pa-own' } })

    // W4-10 — the markets a copy goes to: DE (production, writes on, a spend ceiling), FR (sandbox: no writes).
    await db().amazonAdsConnection.create({ data: { profileId: 'P-DE-TEST', marketplace: 'DE', region: 'EU', mode: 'production', writesEnabledAt: new Date(), isActive: true } })
    await db().amazonAdsConnection.create({ data: { profileId: 'P-FR-TEST', marketplace: 'FR', region: 'EU', mode: 'sandbox', isActive: true } })
    await db().adSpendCeiling.create({ data: { grain: 'MARKET', scopeId: 'DE', label: 'the DE market', dailyCapCents: 5000 } })
    await product('TEST-DE-1', 'B0DEASN001', ['IT', 'DE', 'FR'])
    await product('TEST-DE-3', 'B0DEASN003', ['DE'])
    const pending = await product('TEST-DE-2', 'B0DEASN002', [])
    await db().channelListing.create({ data: { productId: pending.id, channel: 'AMAZON', marketplace: 'DE', region: 'DE', channelMarket: 'AMAZON_DE', listingStatus: 'PENDING' } })
    // In DE: TEST-DE-1's own older campaign buys "rennjacke"; another product's buys "winterstiefel" (rule 3, there).
    const deCampaign = async (key: string, keyword: string, asin: string) => {
      await db().campaign.create({ data: { id: `c-${key}`, name: `Fixture ${key} DE`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'DE', externalCampaignId: `EXT-c-${key}`, dailyBudget: '5.00', startDate: new Date('2026-01-01T00:00:00Z') } })
      await db().adGroup.create({ data: { id: `g-${key}`, campaignId: `c-${key}`, name: `${key} group`, externalAdGroupId: `EXT-g-${key}` } })
      await db().adTarget.create({ data: { adGroupId: `g-${key}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: keyword, bidCents: 25, externalTargetId: `EXT-${key}-kw` } })
      await db().adProductAd.create({ data: { adGroupId: `g-${key}`, asin, externalAdId: `EXT-pa-${key}` } })
    }
    await deCampaign('de-own', 'rennjacke', 'B0DEASN001')
    await deCampaign('de-other', 'winterstiefel', 'B0OTHERDE1')
    // A source in IT with a category target (Amazon's category ids are its own in each market).
    await db().campaign.create({ data: { id: 'c-cat', name: 'TESTCAT Category IT', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-c-cat', dailyBudget: '6.00', startDate: new Date('2026-01-01T00:00:00Z'), targetingType: 'MANUAL' } })
    await db().adGroup.create({ data: { id: 'g-cat', campaignId: 'c-cat', name: 'TESTCAT group', defaultBidCents: 30, externalAdGroupId: 'EXT-g-cat' } })
    await db().adTarget.create({ data: { adGroupId: 'g-cat', kind: 'CATEGORY', expressionType: 'ASIN_CATEGORY_SAME_AS', expressionValue: '1234567890', bidCents: 30, externalTargetId: 'EXT-cat-1' } })
    await db().adTarget.create({ data: { adGroupId: 'g-cat', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'track pants', bidCents: 30, externalTargetId: 'EXT-cat-kw' } })
    await db().adProductAd.create({ data: { adGroupId: 'g-cat', asin: 'B0CATASN01', externalAdId: 'EXT-pa-cat' } })
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
    // W4-10 — a market without Amazon limits Nexus has checked takes no copy (UK has none today).
    expect(await error({ market: 'UK', skus: ['TEST-NEW-1'] })).toMatch(/^Not queued: "TESTSRC Exact IT" cannot be copied into UK: Nexus has no checked Amazon limits there .*Markets with checked limits: IT, DE, FR, ES\.$/)
    limits.uk = true
    try {
      expect(await error({ market: 'UK', skus: ['TEST-NEW-1'] })).toMatch(/^Not queued: the source campaigns are in EUR \(IT\) and the copy would be in GBP \(UK\): bids and budgets are never converted/)
      expect(await error({ market: 'UK', skus: ['TEST-NEW-1'], bidPolicy: { mode: 'fixed', value: 50 }, budgetPolicy: { mode: 'fixed', value: 1000 } })).toMatch(/^Set a spend ceiling for this market first: UK/)
      expect(await error({ market: 'UK', skus: ['TEST-NEW-1'], copy: { bids: false }, budgetPolicy: { mode: 'fixed', value: 1000 } })).toMatch(/never converted/)
    } finally { limits.uk = false }
    expect(await error({ budgetPolicy: { mode: 'fixed', value: 6000 } })).toBe("Its daily budgets add up to EUR 60.00, above the IT market's spend ceiling of EUR 50.00 a day.")
    expect(await error({ bidPolicy: { mode: 'scale' } })).toBe('bidPolicy scale needs a value.')
    // A policy Replicate would silently ignore is refused, never half-applied.
    expect(await error({ copy: { bids: false }, bidPolicy: { mode: 'fixed', value: 30 } })).toMatch(/^Not queued: copy\.bids false keeps each ad group's default bid as the source has it and applies no bidPolicy/)
    expect(await error({ copy: { budgets: false } })).toMatch(/^Not queued: copy\.budgets false needs budgetPolicy fixed/)
    // An archived source: left out (said); only archived ones: refused.
    expect(await error({ campaignIds: ['c-old'] })).toMatch(/^Not queued: "TESTSRC Old IT" is archived: name campaigns that run/)
    const mixed = (await preview(copy({ campaignIds: ['c-src', 'c-old'] }))).preview as Row
    expect(mixed).toMatchObject({ source: { campaigns: [{ campaignId: 'c-src' }] }, totals: { campaigns: 1 }, warnings: expect.arrayContaining(['"TESTSRC Old IT" is archived: left out of the copy.']) })
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
    expect(s).toMatchObject({ status: 'executed', ads: { reach: 'sandbox', build: { applicationId, campaigns: 1, status: 'APPLIED' } } })
    expect(s.ads.created.total).toBeGreaterThan(0)
    // The meaning says where the run is, not only that it was approved.
    expect(s.meaning).toMatch(/^Approved\. The run finished: 1 campaign made\. In Nexus: \d+ created\. Sandbox: /)
    expect(await inside(() => undoRequestFor({ approvalId }))).toMatchObject({ request: { tool: 'archive-ads', args: { buildRunId: applicationId } } })
    expect((await preview({ buildRunId: applicationId }, 'archive-ads')).preview).toMatchObject({ permanent: expect.stringMatching(/^PERMANENT/) })
    // The person who asked holds the floor: restore-campaign (its own request) may put the planned bids back.
    expect((await preview({ campaignId }, 'restore-campaign')).preview).toMatchObject({ suppressedBy: 'user:u-asker', restores: { targets: 2, adGroups: 1 } })
    // The Owner's code rule A: the copy is born at the floor, so that restore is its go-live — the approver's code.
    expect((await preview({ campaignId }, 'restore-campaign')).preview).toMatchObject({ bornAtFloor: { since: expect.any(String) }, stepUp: { raises: ['Bids', 'Spend'] } })
    const { raiseApplicationBids, rollbackApplication, CLAUDE_RUN, claudeRunRollback } = await import('../../advertising/ads-blueprint-apply.service.js')
    await expect(inside(() => raiseApplicationBids(applicationId, 'user:u-screen'))).rejects.toThrow(CLAUDE_RUN)
    // Replicate's rollback would queue an automation's archives the allowlist refuses: it names archive-ads instead.
    await expect(inside(() => rollbackApplication(applicationId, 'user:u-screen'))).rejects.toThrow(claudeRunRollback(applicationId))
    expect((await inside(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: applicationId } }))).status).not.toBe('ROLLED_BACK')
    // The end-of-run portfolio repair was asked as part of the creation (off the allowlist it is not refused).
    expect(placements.portfolio.at(-1)).toEqual({ ids: [campaignId], opts: { creationFlow: true } })
    // Asked again, the names are taken now: refused, not queued.
    expect((await preview(copy())).error).toMatch(/already exist in this marketplace|already has a campaign named/)
  })

  it('its undo, archive-ads buildRunId, reaches Amazon for these off-allowlist campaigns: the approver\'s own change passes the allowlist', async () => {
    const asked = await inside(async () => {
      const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
      return runOrQueueTool('archive-ads', { buildRunId: applicationId, why: 'undo of the copy' }, claude, run.id, { forceAsk: true })
    })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { archived: 1 } })
    const { checkAdsWriteGate } = await import('../../advertising/ads-write-gate.js')
    const { drainAdsSyncOnce } = await import('../../../workers/ads-sync.worker.js')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    try {
      // The control: an automation's archive (no person's own change: Replicate's rollback) is refused off the allowlist.
      expect(await inside(() => checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 0, campaignId, isSuppression: true })))
        .toMatchObject({ allowed: false, deniedAt: 'campaign_allowlist' })
      // The cancel window is waited out here, then the worker sends it.
      await sql('UPDATE "OutboundSyncQueue" SET "holdUntil" = NULL WHERE "syncStatus" = $1 RETURNING id', ['PENDING'])
      await inside(() => drainAdsSyncOnce())
    } finally { vi.unstubAllEnvs() }
    const [ext] = await sql('SELECT "externalCampaignId" AS ext, status FROM "Campaign" WHERE id = $1', [campaignId])
    expect(amazon.archived).toContain(ext.ext)
    expect(ext.status).toBe('ARCHIVED')
    const rows = await sql('SELECT q."syncStatus" AS status FROM "OutboundSyncQueue" q JOIN "AdvertisingActionLog" l ON l."outboundQueueId" = q.id WHERE l."executionId" = $1', [asked.approvalId])
    expect(rows).toEqual([{ status: 'SUCCESS' }])
  })
})

describe('B-1 — the basis a person approves', () => {
  it('does not move when the rows come back in another order; it moves when a bid does', async () => {
    const { planBasis } = await import('./ads-replicate.tools.js')
    const t = (id: string, expression: string, bidCents: number, isNegative = false) => ({ id, expression, expressionType: isNegative ? 'NEGATIVE_EXACT' : 'EXACT', kind: 'KEYWORD', bidCents, isNegative, negativeLevel: isNegative ? 'AD_GROUP' : null })
    const plan = {
      campaigns: [
        { id: 'c0', role: 'Keyword-Exact', name: 'TESTA Exact', dailyBudget: 12, biddingStrategy: 'LEGACY_FOR_SALES', targetingType: 'MANUAL' as const, placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 50 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 10 }],
          adGroups: [
            { id: 'c0.g0', name: 'group one', defaultBidCents: 40, asins: ['B0TESTA001', 'B0TESTA002'], targets: [t('c0.g0.t0', 'alpha', 60), t('c0.g0.t1', 'beta', 45), t('c0.g0.t2', 'cheap', 0, true)] },
            { id: 'c0.g1', name: 'group two', defaultBidCents: 30, asins: ['B0TESTA001'], targets: [t('c0.g1.t0', 'gamma', 35)] },
          ] },
        { id: 'c1', role: 'Keyword-Phrase', name: 'TESTA Phrase', dailyBudget: 8, biddingStrategy: 'LEGACY_FOR_SALES', targetingType: 'MANUAL' as const, placementBidding: [],
          adGroups: [{ id: 'c1.g0', name: 'group three', defaultBidCents: 25, asins: ['B0TESTA001'], targets: [t('c1.g0.t0', 'delta', 20)] }] },
      ],
      conflicts: [{ expression: 'beta', resolution: 'ACCEPTED' as const, existing: [{ campaignName: 'A', campaignId: 'x1' }, { campaignName: 'B', campaignId: 'x2' }] }],
    }
    // The same plan read from rows in another order: campaigns, ad groups, targets, ASINs, placements and clashes reversed,
    // and every positional id renumbered as the read would.
    const shuffled = {
      campaigns: [...plan.campaigns].reverse().map((c, ci) => ({
        ...c, id: `c${ci}`, placementBidding: [...c.placementBidding].reverse(),
        adGroups: [...c.adGroups].reverse().map((g, gi) => ({ ...g, id: `c${ci}.g${gi}`, asins: [...g.asins].reverse(), targets: [...g.targets].reverse().map((x, ti) => ({ ...x, id: `c${ci}.g${gi}.t${ti}` })) })),
      })),
      conflicts: plan.conflicts.map((c) => ({ ...c, existing: [...c.existing].reverse() })),
    }
    const base = { campaignIds: ['c-a', 'c-b'], adGroupIds: [], asins: ['B0TESTA001', 'B0TESTA002'], portfolioId: null, currency: 'EUR' }
    const basis = planBasis({ ...base, plan: plan as never })
    expect(planBasis({ ...base, campaignIds: ['c-b', 'c-a'], asins: ['B0TESTA002', 'B0TESTA001'], plan: shuffled as never })).toBe(basis)
    const raised = structuredClone(plan)
    raised.campaigns[0].adGroups[0].targets[1].bidCents = 46
    expect(planBasis({ ...base, plan: raised as never })).not.toBe(basis)
  })
})

describe('B-1 — the portfolio repair of a run born off the allowlist', () => {
  it('is refused as an automation\'s write, and passes as part of the creation (creationFlow)', async () => {
    const id = await inside(async () => (await db().campaign.create({ data: {
      name: 'TESTPF copy', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-pf-1', portfolioId: 'PF-TEST-1', dailyBudget: '5.00', startDate: new Date(), liveBidWritesEnabled: false,
    } })).id)
    amazon.campaignsV3 = [{ campaignId: 'EXT-pf-1', portfolioId: null }]
    const { verifyCampaignPortfolios } = await import('../../advertising/ads-create.service.js')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    try {
      expect(await inside(() => verifyCampaignPortfolios({ campaignIds: [id], dryRun: false }))).toMatchObject({ missingOnAmazon: 1, repaired: 0, repairFailed: 1 })
      expect(amazon.updates).toEqual([])
      expect(await inside(() => verifyCampaignPortfolios({ campaignIds: [id], dryRun: false, creationFlow: true }))).toMatchObject({ missingOnAmazon: 1, repaired: 1, repairFailed: 0 })
      expect(amazon.updates).toEqual([{ externalId: 'EXT-pf-1', patch: { portfolioId: 'PF-TEST-1' } }])
    } finally { vi.unstubAllEnvs(); amazon.campaignsV3 = [] }
  })
})

describe('B-1 — a run marked stopped while it was only slow', () => {
  it('keeps the FAILED verdict and records that it finished, with what it made', async () => {
    verify.stopMidRun = 'TESTMID'
    try {
      const { applyBlueprint } = await import('../../advertising/ads-blueprint-apply.service.js')
      const out = await inside(() => applyBlueprint({
        source: { campaignIds: ['c-src'], marketplace: 'IT' }, sourceProductToken: 'TESTSRC', target: { productToken: 'TESTMID', asins: ['B0MIDASN01'] },
        marketplace: 'IT', options: { skipSharedTargets: ['winter boots'] }, launchMode: 'floor', dryRun: false, actor: 'user:u-approver',
        bornSafe: { by: 'user:u-asker', changeSetId: 'cs-mid' },
      }))
      const row = await inside(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: out.applicationId } }))
      expect(row.status).toBe('FAILED')
      expect(row.createdCampaignIds).toHaveLength(1)
      expect(row.errors).toEqual(expect.arrayContaining([expect.stringMatching(/^it finished after it was marked stopped: (applied|partial), 1 campaign\(s\) made$/)]))
    } finally { verify.stopMidRun = null }
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
    expect(placements.portfolio.at(-1)).toEqual({ ids: [made.id], opts: {} })
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
      // A campaign Amazon never took (no Amazon id): archived in Nexus when the run is settled, so its name is free.
      const local = await db().campaign.create({ data: { name: 'TESTSTALE never at Amazon', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', dailyBudget: '5.00', startDate: new Date() } })
      await db().advertisingActionLog.create({ data: { executionId: 'cs-stale', userId: 'user:u-approver', actionType: 'create_campaign', entityType: 'CAMPAIGN', entityId: local.id, payloadBefore: {}, payloadAfter: {} } })
      const base = { productToken: 'TESTSTALE', marketplace: 'IT', asins: ['B0STALE001'], status: 'RUNNING', plan: {}, startedAt: old, createdAt: old }
      const claudeRun = await db().adBlueprintApplication.create({ data: { ...base, options: { source: 'claude', changeSetId: 'cs-stale', requester: 'user:u-asker' }, progress: { done: 0, total: 2, campaign: 'TESTSTALE half made', at: old.toISOString() } } })
      const screenRun = await db().adBlueprintApplication.create({ data: { ...base, progress: { done: 0, total: 2, campaign: null } } })
      return { camp: camp.id, local: local.id, claudeRun: claudeRun.id, screenRun: screenRun.id }
    })
    const svc = await import('../../advertising/ads-blueprint-apply.service.js')
    // approval-status reads it as stopped, not as a run still going.
    expect(await inside(() => svc.replicateRunDelivery(ids.claudeRun))).toMatchObject({ status: 'FAILED', stopped: true, total: 2 })
    expect(await inside(() => svc.replicateRunDelivery(ids.screenRun))).toMatchObject({ status: 'RUNNING' })
    // Only what Amazon holds is archived at Amazon: the record it never took is archived in Nexus by the settle.
    expect(await inside(() => svc.replicateRunCampaigns(ids.claudeRun))).toEqual({ campaignIds: [ids.camp], status: 'FAILED', stopped: true })
    expect(await inside(() => svc.replicateRunCampaigns(ids.screenRun))).toMatchObject({ refusal: expect.stringMatching(/still running/) })
    expect((await preview({ buildRunId: ids.claudeRun }, 'archive-ads')).ok).toBe(true)
    expect(await inside(() => svc.settleStoppedReplicates({ market: 'IT', productToken: 'TESTSTALE' }))).toBe(1)
    const rows = await inside(() => db().adBlueprintApplication.findMany({ where: { id: { in: [ids.claudeRun, ids.screenRun] } }, select: { id: true, status: true, createdCampaignIds: true, errors: true } }))
    expect(rows.find((r) => r.id === ids.claudeRun)).toMatchObject({ status: 'FAILED', errors: [expect.stringMatching(/stopped without finishing at "TESTSTALE half made".*archive-ads buildRunId.* 1 campaign record\(s\) Amazon never took were archived in Nexus\.$/)] })
    expect([...rows.find((r) => r.id === ids.claudeRun)!.createdCampaignIds].sort()).toEqual([ids.camp, ids.local].sort())
    expect((await sql('SELECT status FROM "Campaign" WHERE id = $1', [ids.local]))[0].status).toBe('ARCHIVED')
    expect(rows.find((r) => r.id === ids.screenRun)).toMatchObject({ status: 'RUNNING', createdCampaignIds: [] })
  })
})

/** W4-10 — the IT source copied into DE for TEST-DE-1, every term translated (made-up German). */
const WORDS = [
  { from: 'testsrc jacket', to: 'testsrc jacke' },
  { from: 'race jacket', to: 'renn jacke' },
  { from: 'winter boots', to: 'winterstiefel' },
]
const deCopy = (extra: Record<string, unknown> = {}) => ({
  sourceMarket: 'IT', campaignIds: ['c-src'], sourceProductToken: 'TESTSRC', market: 'DE', productToken: 'TESTDE', skus: ['TEST-DE-1'],
  naming: { replacements: [{ from: ' IT', to: ' DE' }] },
  translations: WORDS, negativeTranslations: [{ from: 'cheap', to: 'billig' }], ...extra,
})
const approvals = async () => (await sql<{ n: number }>('SELECT count(*)::int AS n FROM "AgentApproval"'))[0].n

describe('W4-10 — a copy into another market, translated by Claude', () => {
  it('previews each term from → to (the product swapped in), rule 3 judged in DE on the translated text, the currency stated', async () => {
    const r = await preview(deCopy())
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      action: 'replicate-ad-structure', market: 'DE', currency: 'EUR', productToken: 'TESTDE',
      currencyNote: "Every bid and budget is in EUR, the currency of DE: the source's EUR amounts carry over as numbers (as bidPolicy and budgetPolicy say), never converted.",
      source: { market: 'IT', campaigns: [{ campaignId: 'c-src', name: 'TESTSRC Exact IT' }] },
      products: [{ sku: 'TEST-DE-1', asin: 'B0DEASN001' }],
      campaigns: [{ name: 'TESTDE Exact DE', from: 'TESTSRC Exact IT', keywords: 3, negatives: 1, startBidCents: 60 }],
      translation: {
        from: 'IT', to: 'DE', counts: { keywords: { translated: 3, kept: 0 }, negatives: { translated: 1, kept: 0 } },
        keywords: [{ from: 'race jacket', to: 'renn jacke' }, { from: 'testsrc jacket', to: 'TESTDE jacke' }, { from: 'winter boots', to: 'winterstiefel' }],
        negatives: [{ from: 'cheap', to: 'billig' }],
        note: expect.stringMatching(/Every keyword of the copy, translated or kept, brand terms too, was checked against what the product's own campaigns in DE already buy\. A copy into another market never runs by rule/),
      },
      // Rule 3 in DE: another product's campaign buys "winterstiefel": listed, allowed, never negated.
      sharedWithOtherProducts: [{ expression: 'winterstiefel', existing: [{ campaignName: 'Fixture de-other DE', campaignId: 'c-de-other' }] }],
      ceiling: { label: 'the DE market', dailyCapCents: 5000 }, reach: { reach: 'sandbox' }, liveWrites: false,
      limitFacts: { tool: 'replicate-ad-structure', action: 'create' },
      effect: expect.stringMatching(/^Copies the structure of "TESTSRC Exact IT" \(IT\) onto TESTDE in DE with Replicate Structure's own run, every keyword and negative keyword in DE's language as you translated it \(3 keywords translated; 1 negative keyword translated\): .*born ENABLED with every bid at the 2-cent floor/),
    })
    expect(r.preview.warnings.join(' ')).not.toMatch(/still says IT/)
    // The approval card: the market it moves to beside the budget (a plan's step shows the first three), then the words.
    const card = resolveRequest('replicate-ad-structure', deCopy(), r.preview, { masterCurrency: 'EUR' })
    expect(card.changes.map((c) => [c.label, c.from, c.to])).toEqual([
      ['Copies', null, '1 campaign for TESTDE, at the 2-cent floor, off the allowlist'],
      ['Market', 'IT', 'DE'],
      ['Daily budget', null, expect.stringMatching(/12\.00/)],
      ['Keywords', null, '3 translated, 0 kept as they are'],
      ['Negative keywords', null, '1 translated, 0 kept as they are'],
    ])
    // A brand term kept as it is: the product swapped in, as in a term copied as it is.
    const kept = (await preview(deCopy({ translations: [{ from: 'TESTSRC JACKET', keep: true }, ...WORDS.slice(1)] }))).preview as Row
    expect(kept.translation).toMatchObject({ counts: { keywords: { translated: 2, kept: 1 } }, keywords: expect.arrayContaining([{ from: 'TESTSRC JACKET', to: 'TESTDE JACKET', kept: true }]) })
    // Lead decision B: into another market never by rule, whatever the limits (the markets they name included).
    expect(judge(r.preview, { maxCampaigns: 5, maxDailyBudgetCents: 100_000, maxBidCents: 1000, markets: ['DE'] }))
      .toBe("it copies into another market (IT → DE) with Claude's translations: a person always reads them, so it never runs by rule")
  })

  it("rule 3 on the translated text: a keyword the product's own campaigns in DE buy refuses it until skipped or accepted", async () => {
    const own = deCopy({ translations: [WORDS[0], { from: 'race jacket', to: 'rennjacke' }, WORDS[2]] })
    expect((await preview(own)).error).toMatch(/^Not queued: Replicate's gate refuses this copy — 1 keyword\(s\) would make TESTDE bid against campaigns you already run for it \("rennjacke"\).*already buy "rennjacke" \("Fixture de-own DE"\): name each in skipTerms/)
    expect((await preview({ ...own, skipTerms: ['rennjacke'] })).preview).toMatchObject({ totals: { positives: 2, negatives: 1 } })
    expect((await preview({ ...own, acceptTerms: ['rennjacke'] })).preview).toMatchObject({ acceptedTerms: ['rennjacke'] })
  })

  it('rule 3 for a brand term too: the product already running in DE with the term it is copied to is a clash (translated or kept)', async () => {
    // TEST-DE-1's own DE campaign buying the brand term the copy makes ("TESTDE jacke").
    await inside(async () => {
      await db().campaign.create({ data: { id: 'c-de-brand', name: 'Fixture de-brand DE', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'DE', externalCampaignId: 'EXT-c-de-brand', dailyBudget: '5.00', startDate: new Date('2026-01-01T00:00:00Z') } })
      await db().adGroup.create({ data: { id: 'g-de-brand', campaignId: 'c-de-brand', name: 'de-brand group', externalAdGroupId: 'EXT-g-de-brand' } })
      await db().adTarget.create({ data: { adGroupId: 'g-de-brand', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'TESTDE jacke', bidCents: 25, externalTargetId: 'EXT-de-brand-kw' } })
      await db().adTarget.create({ data: { adGroupId: 'g-de-brand', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'TESTDE jacket', bidCents: 25, externalTargetId: 'EXT-de-brand-kw2' } })
      await db().adProductAd.create({ data: { adGroupId: 'g-de-brand', asin: 'B0DEASN001', externalAdId: 'EXT-pa-de-brand' } })
    })
    try {
      expect((await preview(deCopy())).error).toMatch(/would make TESTDE bid against campaigns you already run for it \("TESTDE jacke"\).*already buy "TESTDE jacke" \("Fixture de-brand DE"\)/)
      const kept = deCopy({ translations: [{ from: 'testsrc jacket', keep: true }, ...WORDS.slice(1)] })
      expect((await preview(kept)).error).toMatch(/already buy "TESTDE jacket" \("Fixture de-brand DE"\)/)
      expect((await preview({ ...deCopy(), skipTerms: ['TESTDE jacke'] })).preview).toMatchObject({ totals: { positives: 2 } })
      // Another product's campaign with the term: listed, never blocked.
      await inside(() => db().adProductAd.updateMany({ where: { adGroupId: 'g-de-brand' }, data: { asin: 'B0OTHERDE2' } }))
      expect((await preview(deCopy())).preview).toMatchObject({ sharedWithOtherProducts: expect.arrayContaining([expect.objectContaining({ expression: 'TESTDE jacke' })]) })
    } finally {
      await inside(() => db().campaign.update({ where: { id: 'c-de-brand' }, data: { status: 'ARCHIVED' } }))
    }
  })

  it('refuses, and queues nothing: a term untranslated or unknown, a term twice, translations in one market, a market without checked limits or writes, a product not ACTIVE there, category targets', async () => {
    const before = await approvals()
    const error = async (args: Record<string, unknown>) => (await preview(args)).error
    expect(await error(deCopy({ translations: undefined, negativeTranslations: undefined }))).toBe(
      "Not queued: a copy into DE needs every keyword and negative keyword in DE's language. 4 terms have neither a translation nor a keep "
      + '(keywords "race jacket", "TESTSRC jacket", "winter boots"; negative keywords "cheap"): add each to translations (keywords) or negativeTranslations, '
      + 'as { from, to } with your translation or { from, keep: true } for a brand or model name shoppers there search for unchanged.')
    // The source's archived keyword is not copied: a translation of it names a term the copy does not have.
    expect(await error(deCopy({ translations: [...WORDS, { from: 'old jacket', to: 'alte jacke' }] })))
      .toMatch(/language\. 1 translation names a term the source does not have \(keywords "old jacket"\): check each against the source's own text \(ad-targets\)\.$/)
    expect(await error(deCopy({ negativeTranslations: [{ from: 'cheap', to: 'billig' }, { from: 'Cheap', to: 'guenstig' }] })))
      .toBe('Not queued: negativeTranslations names "Cheap" more than once: give each term one translation.')
    // Neither a translation nor a keep for a term named: the door refuses the arguments.
    await expect(preview(deCopy({ translations: [{ from: 'race jacket' }] }))).rejects.toThrow(/translations\.0: give to \(the translation\) or keep: true, one of the two/)
    expect(await error(copy({ translations: [{ from: 'race jacket', to: 'giacca da corsa' }] }))).toMatch(/^Not queued: translations are for a copy into another market; in IT/)
    expect(await error(deCopy({ market: 'NL' }))).toMatch(/^Not queued: "TESTSRC Exact IT" cannot be copied into NL: Nexus has no checked Amazon limits there/)
    expect(await error(deCopy({ market: 'FR' }))).toBe('Not queued: "TESTSRC Exact IT" cannot be copied into FR: it has no production Amazon Ads connection with writes switched on, so the copy would be made in Nexus only and never reach Amazon. Connecting a profile there and switching its writes on stays with a person in Nexus (Amazon Ads connections).')
    expect(await error(deCopy({ market: 'ES' }))).toMatch(/^Not queued: "TESTSRC Exact IT" cannot be copied into ES: it has no production Amazon Ads connection with writes switched on/)
    expect(await error(deCopy({ skus: ['TEST-DE-2'] }))).toBe('Not queued: the copy of "TESTSRC Exact IT" would have nothing to advertise for one product — TEST-DE-2 is listed on Amazon in DE but not active there (pending).')
    expect(await error(deCopy({ skus: ['TEST-NEW-2'] }))).toMatch(/TEST-NEW-2 is not listed on Amazon in DE/)
    // Amazon's category ids are its own in each market: refused; left out (copy.productTargets false), the copy is made.
    const cat = deCopy({ campaignIds: ['c-cat'], sourceProductToken: 'TESTCAT', naming: undefined, translations: [{ from: 'track pants', to: 'trainingshose' }], negativeTranslations: [] })
    expect(await error(cat)).toBe("Not queued: the copy carries 1 category target, and Amazon's category ids are its own in each market: IT's mean nothing in DE. Leave product and category targets out (copy.productTargets false) and target DE's own categories once the copy runs.")
    const left = (await preview({ ...cat, copy: { productTargets: false } })).preview as Row
    expect(left).toMatchObject({ campaigns: [{ name: 'TESTDE Category IT', keywords: 1, productTargets: 0 }], excluded: { productTargets: 1 }, translation: { keywords: [{ from: 'track pants', to: 'trainingshose' }] } })
    expect(left.warnings).toEqual(expect.arrayContaining(['"TESTDE Category IT" still says IT in its name: naming (prefix, suffix or replacements) renames it if it should say DE.']))
    expect(await approvals()).toBe(before)
  })

  it('approved: the run builds the translations in DE, born safe, and records them; undo archives what it made', async () => {
    const asked = await ask(deCopy({ why: 'the jacket structure for the German market' }))
    expect(asked).toMatchObject({ ok: true, mode: 'queued' })
    const done = await approve(asked.approvalId!)
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { status: 'RUNNING', changeSetId: asked.approvalId } })
    const applicationId = (done as Row).result.applicationId
    await finished(applicationId)
    const [made] = await sql('SELECT id, marketplace, status, "liveBidWritesEnabled" AS live, "bidsSuppressedBy" AS by FROM "Campaign" WHERE name = $1', ['TESTDE Exact DE'])
    expect(made).toMatchObject({ marketplace: 'DE', status: 'ENABLED', live: false, by: 'user:u-asker' })
    const targets = await sql('SELECT t."expressionValue" AS text, t."isNegative" AS neg, t."bidCents" AS bid, t."suppressedFromBidCents" AS kept FROM "AdTarget" t JOIN "AdGroup" g ON g.id = t."adGroupId" WHERE g."campaignId" = $1 ORDER BY lower(t."expressionValue")', [made.id])
    expect(targets).toEqual([
      { text: 'billig', neg: true, bid: 0, kept: null },
      { text: 'renn jacke', neg: false, bid: 2, kept: 45 },
      { text: 'TESTDE jacke', neg: false, bid: 2, kept: 60 },
      { text: 'winterstiefel', neg: false, bid: 2, kept: 30 },
    ])
    expect(await sql('SELECT a.asin FROM "AdProductAd" a JOIN "AdGroup" g ON g.id = a."adGroupId" WHERE g."campaignId" = $1', [made.id])).toEqual([{ asin: 'B0DEASN001' }])
    const run = await inside(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: applicationId } }))
    expect(run).toMatchObject({ marketplace: 'DE', productToken: 'TESTDE', options: { source: 'claude', changeSetId: asked.approvalId, translations: { keywords: WORDS, negatives: [{ from: 'cheap', to: 'billig' }] } } })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'archive-ads', args: { buildRunId: applicationId } } })
    // Asked again, the name is taken in DE now: refused, not queued.
    expect((await preview(deCopy())).error).toMatch(/already exist in this marketplace|already has a campaign named/)
  })

  it('the run plans the translations again: a term it has none for refuses the run, and nothing is made', async () => {
    const { applyBlueprint } = await import('../../advertising/ads-blueprint-apply.service.js')
    await expect(inside(() => applyBlueprint({
      source: { campaignIds: ['c-src'], marketplace: 'IT', excludeArchivedTargets: true }, sourceProductToken: 'TESTSRC', target: { productToken: 'TESTRUN', asins: ['B0DEASN003'] },
      marketplace: 'DE', options: { translations: { keywords: [{ from: 'race jacket', to: 'renn jacke' }], negatives: [] } }, launchMode: 'floor', dryRun: false, actor: 'user:u-approver',
      bornSafe: { by: 'user:u-asker', changeSetId: 'cs-run-words' },
    }))).rejects.toThrow(/^refused: .*3 term\(s\) of the source have no translation: keyword\(s\) "TESTSRC jacket", "winter boots"; negative keyword\(s\) "cheap"/)
    expect((await sql<{ n: number }>('SELECT count(*)::int AS n FROM "Campaign" WHERE name LIKE $1', ['TESTRUN%']))[0].n).toBe(0)
  })

  it('as a step of a change plan: the step keeps the translations it shows, and the plan builds them', async () => {
    const args = deCopy({ productToken: 'TESTPLAN', skus: ['TEST-DE-3'] })
    const asked = await ask({ title: 'A copy into DE as a plan', steps: [{ tool: 'replicate-ad-structure', args }] }, 'submit-change-plan')
    expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true, mode: 'queued' })
    const step = await inside(() => db().agentPlanStep.findFirstOrThrow({ where: { approvalId: asked.approvalId! } }))
    expect(step.preview).toMatchObject({ market: 'DE', translation: { counts: { keywords: { translated: 3 }, negatives: { translated: 1 } }, keywords: [{ from: 'race jacket', to: 'renn jacke' }, { from: 'testsrc jacket', to: 'TESTPLAN jacke' }, { from: 'winter boots', to: 'winterstiefel' }] } })
    const parked = await inside(() => decideFleetApproval({ id: asked.approvalId!, decision: 'approve', actor: person(member.userId, 'app') }))
    expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
    await inside(() => db().agentApproval.update({ where: { id: asked.approvalId! }, data: { executeAfter: new Date(Date.now() - 1000) } }))
    expect(await inside(() => commitScheduledApproval(asked.approvalId!))).toMatchObject({ ok: true, status: 'executing' })
    expect(await inside(() => runPlan(asked.approvalId!))).toMatchObject({ finished: true, counts: { done: 1 } })
    const change = await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId: asked.approvalId!, toolName: 'replicate-ad-structure' } }))
    await finished((change.after as Row).applicationId)
    const texts = await sql('SELECT t."expressionValue" AS text FROM "AdTarget" t JOIN "AdGroup" g ON g.id = t."adGroupId" JOIN "Campaign" c ON c.id = g."campaignId" WHERE c.name = $1 ORDER BY lower(t."expressionValue")', ['TESTPLAN Exact DE'])
    expect(texts.map((t) => t.text)).toEqual(['billig', 'renn jacke', 'TESTPLAN jacke', 'winterstiefel'])
  })
})

describe('W4-10 — a copy into another market never runs by rule (lead decision B)', () => {
  /** Claude through its own door (the MCP rule), as a member who may run by rule. */
  const mcp = () => ({ ...person(member.userId, 'claude'), business: { id: LEGACY_WORKSPACE_ID, name: 'Test business' }, scopes: ['nexus.read', 'nexus.write', 'nexus.run'], oauthGrantId: 'grant-w410' }) as never
  const byDoor = (args: Record<string, unknown>, tool = 'replicate-ad-structure') => inside(async () => {
    const principal = mcp()
    const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: member.userId } })
    return runOrQueueTool(tool, args, principal, run.id, { forceAsk: true, rule: claudeGateRule(principal) }) as Promise<Row>
  })
  const rule = { maxCampaigns: 5, maxDailyBudgetCents: 100_000, maxBidCents: 1000 }
  const strategies: string[] = []
  const rulePerson = () => person(member.userId, 'app')
  /** A person approves it; then it is made to look decided by the business's rule, and the window's commit runs. */
  const ruleCommit = async (approvalId: string) => {
    const parked = await inside(() => decideFleetApproval({ id: approvalId, decision: 'approve', actor: rulePerson() }))
    expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
    await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { decisionVia: 'auto', executeAfter: new Date(Date.now() - 1000) } }))
    return inside(() => commitScheduledApproval(approvalId))
  }

  beforeAll(async () => {
    await inside(async () => {
      // The business lets the tool run by rule, with room in its limits, inside the ads strategy of IT and DE.
      await db().agentTool.upsert({
        where: { name: 'replicate-ad-structure' },
        create: { name: 'replicate-ad-structure', riskTier: 'high', requiresApproval: true, claudeTrust: 'auto', claudeLimits: rule },
        update: { claudeTrust: 'auto', claudeLimits: rule },
      })
      for (const market of ['IT', 'DE']) {
        strategies.push((await db().adsStrategy.create({ data: {
          market, level: 'MARKET', scopeId: '*', label: `Test market (${market})`, updatedBy: 'user:test',
          claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 10, claudeMaxBudgetIncreasePerDayCents: 50_000, maxBidCents: 100,
        } })).id)
      }
      const p = await db().product.create({ data: { sku: 'TEST-RULE-1', name: 'Test TEST-RULE-1', basePrice: '99.00', amazonAsin: 'B0RULEASN1' } })
      for (const market of ['IT', 'DE']) await db().channelListing.create({ data: { productId: p.id, channel: 'AMAZON', marketplace: market, region: market, channelMarket: `AMAZON_${market}`, listingStatus: 'ACTIVE' } })
    })
  })
  afterAll(async () => {
    await inside(async () => {
      await db().adsStrategy.deleteMany({ where: { id: { in: strategies } } })
      await db().agentTool.update({ where: { name: 'replicate-ad-structure' }, data: { claudeTrust: 'ask', claudeLimits: {} as never } })
    })
  })

  let intoDe = ''
  it('the door: at auto with room in its limits, a copy inside IT runs by rule; the same copy into DE waits for a person', async () => {
    const same = await byDoor(copy({ productToken: 'TESTRULE', skus: ['TEST-RULE-1'] }))
    expect(same, JSON.stringify(same)).toMatchObject({ ok: true, mode: 'queued', rule: { by: 'rule', level: 'auto' } })
    const other = await byDoor(deCopy({ productToken: 'TESTRULE', skus: ['TEST-RULE-1'] }))
    expect(other, JSON.stringify(other)).toMatchObject({
      ok: true, mode: 'queued', rule: { by: 'person', why: "it copies into another market (IT → DE) with Claude's translations: a person always reads them, so it never runs by rule; a person approves it in Nexus" },
    })
    intoDe = other.approvalId
  })

  it("the commit: a rule's decision is handed back to a person, and nothing is made", async () => {
    await ruleCommit(intoDe)
    const ap = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: intoDe } }))
    expect(ap).toMatchObject({ status: 'pending', decisionVia: null, reason: expect.stringMatching(/^not run — .*it copies into another market \(IT → DE\) .*never runs by rule/) })
    expect((await sql<{ n: number }>('SELECT count(*)::int AS n FROM "Campaign" WHERE name LIKE $1', ['TESTRULE%DE']))[0].n).toBe(0)
  })

  it("execute itself refuses a rule's decision, whatever the limits and the strategy say", async () => {
    const ap = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: intoDe } }))
    const { raw } = await inside(() => executeTool(rulePerson(), 'replicate-ad-structure', ap.args as Record<string, unknown>, { approvalId: intoDe, approvedPreview: ap.preview ?? undefined, decidedVia: 'auto' }))
    expect(raw).toMatchObject({ ok: false, error: "Not run: a copy into another market carries Claude's translations, and a person always reads them: it never runs by rule. Ask for it again; a person approves it." })
    expect((await sql<{ n: number }>('SELECT count(*)::int AS n FROM "Campaign" WHERE name LIKE $1', ['TESTRULE%DE']))[0].n).toBe(0)
  })

  it('a change plan with such a step waits for a person, and a rule deciding the plan is handed back', async () => {
    const plan = await byDoor({ title: 'A copy into DE as a plan', steps: [{ tool: 'replicate-ad-structure', args: deCopy({ productToken: 'TESTRULE', skus: ['TEST-RULE-1'] }) }] }, 'submit-change-plan')
    expect(plan, JSON.stringify(plan)).toMatchObject({ ok: true, mode: 'queued', rule: { by: 'person', why: expect.stringMatching(/never runs by rule/) } })
    await ruleCommit(plan.approvalId)
    const ap = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: plan.approvalId } }))
    expect(ap).toMatchObject({ status: 'pending', decisionVia: null, reason: expect.stringMatching(/^not run — .*it copies into another market \(IT → DE\) .*never runs by rule/) })
    expect((await sql<{ n: number }>('SELECT count(*)::int AS n FROM "Campaign" WHERE name LIKE $1', ['TESTRULE%DE']))[0].n).toBe(0)
  })
})

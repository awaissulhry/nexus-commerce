/**
 * R8 (MCP full control, part 06) — preview-automation: a draft and a saved row per kind, through the tool, writing
 * nothing; "no preview" for every kind without one; a pausing rule previews and says it would be refused when saved.
 *
 * On a real PostgreSQL (PGlite, production schema). "Nothing written" is measured, not assumed: every table a preview
 * could touch is counted before and after ALL the previews, and the rules' counters are compared.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
// Hoisted: the notify module is now loaded while the mocks are set up (ads-manager-run.service.ts imports a constant of it).
const notify = vi.hoisted(() => vi.fn(async () => ({ created: 1, deduped: false, wouldHaveReached: 1 })))
vi.mock('../advertising/ads-automation-notify.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../advertising/ads-automation-notify.service.js')>()),
  notifyAutomationDetailed: notify, notifyAutomation: vi.fn(async () => 1),
}))
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})

import { callTool, type UserPrincipal } from '../agents/call-tool.js'
import { listAdapters } from './automation-catalog.service.js'

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_r8_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const everything: UserPrincipal = {
  kind: 'user', userId: 'u-r8', label: 'R8 test', permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: business(A), via: 'claude',
}

type Answer = { ok: boolean; error?: string; data?: Record<string, any> }
const preview = async (args: Record<string, unknown>): Promise<Answer> => (await callTool(everything, 'preview-automation', args)).visible as Answer

const ids: Record<string, string> = {}

/** Every table a preview could write, and the counters and clocks of what it previews. */
async function footprint() {
  return inside(async () => {
    const db = database.client
    const counts = await Promise.all([
      db.automationRuleExecution.count(), db.adsRuleSuggestion.count(), db.advertisingActionLog.count(), db.automationRefusalDaily.count(),
      db.outboundSyncQueue.count(), db.repricingDecision.count(), db.budgetPoolRebalance.count(), db.cronRun.count(), db.campaignAction.count(),
      db.ebayAdsProposal.count(), db.ebayAdsRuleExecution.count(), db.auditLog.count(), db.notification.count(), db.agentRun.count(),
      db.bulkActionJob.count(), db.purchaseOrder.count(), db.autopilotDecision.count(), db.adWriteRefusal.count(),
    ])
    const rules = await db.automationRule.findMany({ select: { id: true, evaluationCount: true, matchCount: true, executionCount: true, lastEvaluatedAt: true, updatedAt: true }, orderBy: { id: 'asc' } })
    const others = await Promise.all([
      db.ebayAdsRule.findMany({ select: { id: true, lastEvaluatedAt: true, updatedAt: true }, orderBy: { id: 'asc' } }),
      db.repricingRule.findMany({ select: { id: true, lastEvaluatedAt: true, updatedAt: true }, orderBy: { id: 'asc' } }),
      db.budgetPool.findMany({ select: { id: true, lastRebalancedAt: true, updatedAt: true }, orderBy: { id: 'asc' } }),
      db.replenishmentRecommendation.findMany({ select: { id: true, status: true, actedAt: true }, orderBy: { id: 'asc' } }),
    ])
    return JSON.stringify({ counts, rules, others })
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`, [OTHER])
  await import('../advertising/automation-action-handlers.js')
  await inside(async () => {
    await db.amazonAdsConnection.create({ data: { profileId: 'TEST-PROFILE-1', marketplace: 'IT', isActive: true } as never })
    const rule = (domain: string, name: string, trigger: string, actions: object[], extra: Record<string, unknown> = {}) =>
      db.automationRule.create({ data: { domain, name, trigger, enabled: true, autonomyLevel: 'AUTO', dryRun: false, conditions: [], actions, ...extra } as never })
    ids.adsRule = (await rule('advertising', 'TEST alert rule', 'SCHEDULE', [{ type: 'log_only' }, { type: 'notify', title: 'TEST alert' }])).id
    ids.adsPausing = (await rule('advertising', 'TEST pausing rule', 'SCHEDULE', [{ type: 'pause_campaign' }], { enabled: false })).id
    ids.marketing = (await rule('marketing', 'TEST marketing tick rule', 'MKT_CRON_TICK', [{ type: 'log_only' }])).id
    ids.replenishment = (await rule('replenishment', 'TEST restock rule', 'recommendation_generated', [{ type: 'log_only' }])).id
    ids.listing = (await rule('listings', 'TEST listing rule', 'listing_price_changed', [{ type: 'log_only' }])).id
    ids.bulk = (await rule('bulk-operations', 'TEST bulk tick rule', 'bulk_cron_tick', [{ type: 'log_only' }])).id
    const product = await db.product.create({ data: { sku: 'TEST-SKU-1', name: 'Test product', basePrice: '20.00', totalStock: 3 } })
    await db.replenishmentRecommendation.create({
      data: { productId: product.id, sku: 'TEST-SKU-1', velocity: '0.5', velocitySource: 'test', leadTimeDays: 10, leadTimeSource: 'test', safetyDays: 3, totalAvailable: 3, inboundWithinLeadTime: 0, effectiveStock: 3, reorderPoint: 9, reorderQuantity: 20, urgency: 'HIGH', needsReorder: true },
    })
    await db.channelListing.create({ data: { productId: product.id, channelMarket: 'AMAZON_IT', channel: 'AMAZON', region: 'IT', marketplace: 'IT', price: '20.00', quantity: 3, listingStatus: 'ACTIVE' } })
    await db.buyBoxHistory.create({ data: { productId: product.id, channel: 'AMAZON', marketplace: 'IT', buyBoxPrice: '19.00', lowestCompetitorPrice: '18.50' } })
    ids.repricing = (await db.repricingRule.create({ data: { productId: product.id, channel: 'AMAZON', marketplace: 'IT', minPrice: '15.00', maxPrice: '25.00', strategy: 'match_buy_box' } })).id
    ids.pool = (await db.budgetPool.create({ data: { name: 'TEST pool', totalDailyBudgetCents: 5000, enabled: true, dryRun: true } })).id
    ids.coverage = (await db.keywordCoverageSet.create({ data: { name: 'TEST coverage', portfolioId: 'TEST-PORTFOLIO-1', marketplace: 'IT', enabled: false } })).id
    ids.plan = (await db.autopilotPlan.create({ data: { name: 'TEST plan', marketplace: 'IT', campaignIds: [], goal: 'BALANCED' } })).id
    const ebay = (name: string, action: object) => db.ebayAdsRule.create({
      data: { name, enabled: false, mode: 'PROPOSE', trigger: { scope: 'CPS_AD', all: [{ metric: 'clicks', windowDays: 30, op: 'gte', threshold: 30 }] }, action },
    })
    ids.ebay = (await ebay('TEST eBay rate rule', { type: 'adjust_ad_rate', deltaPct: -10, minRatePct: 2 })).id
    ids.ebayPausing = (await ebay('TEST eBay remove-ad rule', { type: 'pause_ad' })).id
  })
  await inside(() => db.automationRule.create({ data: { id: 'tst-r8-other', domain: 'advertising', name: 'TEST other business rule', trigger: 'SCHEDULE' } }), OTHER)
}, 180_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

describe('R8 — preview-automation', () => {
  let before = ''
  it('records the footprint before any preview', async () => {
    before = await footprint()
  })

  it('every kind with a preview has one to run, and every kind without one says why', async () => {
    for (const adapter of listAdapters()) {
      expect(!!adapter.runPreview, adapter.id).toBe(adapter.preview !== 'none')
      if (adapter.preview !== 'none') continue
      const out = await preview({ automation: adapter.id })
      expect(out, adapter.id).toEqual({ ok: true, data: { automation: { id: adapter.id, key: adapter.key, name: adapter.name }, preview: null, says: `No preview for ${adapter.name}: ${adapter.previewNote}` } })
    }
  })

  it('A1 saved: the rule against what its next tick would see — and its notify action notifies nobody', async () => {
    const out = await preview({ automation: 'A1', rowId: ids.adsRule })
    expect(out.ok).toBe(true)
    expect(out.data).toMatchObject({ kind: 'saved', row: { id: ids.adsRule, name: 'TEST alert rule' }, preview: { ok: true, ruleName: 'TEST alert rule', contextsInScope: 1, matched: 1 } })
    expect(out.data!.preview.results[0].actions.map((a: { type: string }) => a.type)).toEqual(['log_only', 'notify'])
    expect(out.data!.preview.results[0].actions[1].output).toMatchObject({ preview: true, notified: 0 })
    expect(out.data!.wouldBeRefusedWhenSaved).toBeUndefined()
    expect(notify).not.toHaveBeenCalled()
  })

  it('never pause: a pausing rule previews as it would run and says Claude could not save it, with the substitute', async () => {
    const saved = await preview({ automation: 'A1', rowId: ids.adsPausing })
    expect(saved.data!.wouldBeRefusedWhenSaved).toMatchObject({ refusedWhenSaved: true, actions: [{ type: 'pause_campaign', instead: expect.stringContaining('lower_bid_to_floor') }] })
    expect(saved.data!.wouldBeRefusedWhenSaved.says).toContain('never pause')
    const draft = await preview({ automation: 'A1', draft: { actions: [{ type: 'pause_campaign' }], conditions: [] } })
    expect(draft.data).toMatchObject({ kind: 'draft', wouldBeRefusedWhenSaved: { actions: [{ type: 'pause_campaign' }] } })
    const ebay = await preview({ automation: 'E1', rowId: ids.ebayPausing })
    expect(ebay.data).toMatchObject({ kind: 'saved', wouldBeRefusedWhenSaved: { actions: [{ type: 'pause_ad' }] } })
  })

  it("A1 draft: a budget rule in the builder's shape runs through the builder's own preview", async () => {
    const out = await preview({ automation: 'A1', draft: { actions: [{ type: 'budget', campaigns: [] }], conditions: [] } })
    expect(out.ok).toBe(true)
    expect(out.data).toMatchObject({ kind: 'draft', row: null })
    expect(out.data!.preview).toHaveProperty('ok')
  })

  it('E1: a draft and a saved eBay rule; an invalid draft is refused with its problems', async () => {
    const draft = await preview({ automation: 'E1', draft: { name: 'TEST draft', trigger: { scope: 'CPS_AD', all: [{ metric: 'clicks', windowDays: 14, op: 'gte', threshold: 10 }] }, action: { type: 'adjust_ad_rate', deltaPct: -5 } } })
    expect(draft.data).toMatchObject({ kind: 'draft', preview: { evaluated: 0, matched: 0, samples: [] } })
    const saved = await preview({ automation: 'ebay-ads-rules', rowId: ids.ebay })
    expect(saved.data).toMatchObject({ kind: 'saved', row: { id: ids.ebay, name: 'TEST eBay rate rule' }, preview: { matched: 0 } })
    const bad = await preview({ automation: 'E1', draft: { name: '' } })
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('trigger.scope')
  })

  it('operations rules through the preview path: marketing (its tick context), replenishment (open recommendations), listing (a context given), bulk (a cron tick)', async () => {
    const marketing = await preview({ automation: 'E2', rowId: ids.marketing })
    expect(marketing.data!.preview).toMatchObject({ contexts: 1, evaluated: 1, matched: 1, results: [{ status: 'DRY_RUN', actions: [{ type: 'log_only', ok: true }] }] })
    const restock = await preview({ automation: 'N6', rowId: ids.replenishment })
    expect(restock.data!.preview).toMatchObject({ contextSource: 'built from current data, as its next run would', contexts: 1, matched: 1 })
    const listingWithout = await preview({ automation: 'N5', rowId: ids.listing })
    expect(listingWithout.data).toMatchObject({ preview: { contexts: 0 }, notes: [expect.stringContaining('give a context')] })
    const listing = await preview({ automation: 'N5', rowId: ids.listing, context: { product: { id: 'p1', price: 21 } } })
    expect(listing.data!.preview).toMatchObject({ contextSource: 'the context given', matched: 1 })
    const bulk = await preview({ automation: 'N9', rowId: ids.bulk })
    expect(bulk.data!.preview).toMatchObject({ contexts: 1, matched: 1 })
    // A draft of a kind that previews saved rules only is refused, and saying why.
    expect((await preview({ automation: 'N6', draft: { actions: [] } })).error).toContain('cannot preview a draft')
  })

  it("N1: the price a repricing rule would pick now, from its listing and the buy box; never applied", async () => {
    const out = await preview({ automation: 'N1', rowId: ids.repricing })
    expect(out.data).toMatchObject({
      kind: 'saved', row: { name: 'TEST-SKU-1 on AMAZON IT (match_buy_box)' },
      preview: { market: { currentPrice: 20, buyBoxPrice: 19, lowestCompPrice: 18.5 }, recentObservation: true, decision: { price: 19, changed: true } },
    })
  })

  it('the engines: auto-bid, budget enforcement, a pool, rank-defend, top-of-search, a coverage set and an autopilot backtest all preview', async () => {
    for (const args of [
      { automation: 'A4' }, { automation: 'A8' }, { automation: 'A9', rowId: ids.pool }, { automation: 'A10' },
      { automation: 'A11' }, { automation: 'A12', rowId: ids.coverage }, { automation: 'A5', rowId: ids.plan },
    ]) {
      const out = await preview(args)
      expect(out.ok, `${args.automation}: ${out.error}`).toBe(true)
      expect(out.data!.preview, args.automation).toBeTruthy()
    }
    expect((await preview({ automation: 'A9' })).error).toContain('Name the pool')
  })

  it('per kind: an ads preview needs financials.adspend.view; a replenishment preview needs only its own view', async () => {
    const restocker: UserPrincipal = { ...everything, permissions: { isOwner: false, permissions: new Set([FEATURES.aiRun, FEATURES.aiView, FEATURES.adsView, FEATURES.replenishmentView]) } }
    const asRestocker = async (args: Record<string, unknown>) => (await callTool(restocker, 'preview-automation', args)).visible as Answer
    expect(await asRestocker({ automation: 'A1', rowId: ids.adsRule })).toEqual({ ok: false, error: 'Previewing Amazon ads rules shows bids, budgets and spend: it needs the financials.adspend.view permission.' })
    const restock = await asRestocker({ automation: 'N6', rowId: ids.replenishment })
    expect(restock.ok).toBe(true)
    expect(restock.data!.preview).toMatchObject({ contexts: 1, matched: 1 })
  })

  it("another business's row is not found", async () => {
    expect(await preview({ automation: 'A1', rowId: 'tst-r8-other' })).toEqual({ ok: false, error: 'Amazon ads rules has no row tst-r8-other in this business (not found).' })
  })

  it('wrote nothing: every table a preview could touch, and every counter and clock, is as it was; nobody was notified', async () => {
    expect(await footprint()).toEqual(before)
    expect(notify).not.toHaveBeenCalled()
  })
})

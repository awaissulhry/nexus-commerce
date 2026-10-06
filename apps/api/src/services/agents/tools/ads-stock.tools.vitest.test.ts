/**
 * ADS AUTONOMY W3-3 — stock-aware bids, run for real through the door and the approval gate (PGlite, production schema;
 * the job queue a stub; the ads write gate the real one, sandbox). Made-up ids, SKUs and numbers (public repo).
 *
 * Proven: the read gives each advertised product's units (Amazon's FBA number apart, read only), pace, cover and its own
 * lines, and each ad group's verdict; an ad group whose every product is out of stock goes to its floor, a short one one
 * step down (the largest bid change per action), never paused; a mixed ad group, a campaign already floored and an
 * engine's floor are left alone; approved, it writes as the approver in one change set and remembers every bid, and the
 * memory survives a second lowering; the give-back waits until cover is back above the restart line (or is an undo),
 * lifts only a person's floor, and puts back exactly what was; undo asks the other tool; the limits let a lowering run
 * by rule inside the strategy and keep every give-back with a person by default; no stock write anywhere.
 */
import { readFileSync } from 'node:fs'
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
// As in the pause tests: an ads queue row names no listing account (the ads worker resolves its Amazon Ads profile).
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))

import { callTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { undoRequestFor } from '../change-record.service.js'
import { getTool } from '../tool-registry.js'
import { ruleFrom } from '../claude-trust.service.js'
import { adGroupStockRisk, chainStepBack, productStockRisk, stockSteppedCents, stockStepOf } from '../../advertising/ads-stock-risk.service.js'
import { restoreCampaignBids, suppressAdGroupBids, suppressCampaignBids, restoreAdGroupBids } from '../../advertising/ads-bid-suppression.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId}`, via, workspace: business,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
})
const claude = person('u-asker', 'claude')
const approver = person('u-approver', 'app')

type Row = Record<string, any>
const call = async (tool: string, args: Record<string, unknown>) => (await inside(() => callTool(claude, tool, args))).raw
async function ask(tool: string, args: Record<string, unknown>) {
  return inside(async () => {
    const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool(tool, args, claude, run.id, { forceAsk: true })
  })
}
const approve = (approvalId: string) => inside(() => decideApproval(approvalId, 'approve', approver))
const sql = <T = Row>(text: string, params: unknown[] = []) => inside(async () => (await database.client.$queryRawUnsafe(text, ...params)) as T[])
const halt = (halted: boolean) => inside(() => database.client.adsAutomationState.upsert({
  where: { id: 'singleton' }, create: { id: 'singleton', autonomy: 'AUTO', halted, haltReason: halted ? 'test halt' : null }, update: { halted, haltReason: halted ? 'test halt' : null },
}))
const judge = (tool: string, p: unknown, limits: Record<string, unknown> = {}) => {
  const t = getTool(tool)!
  return t.withinLimits!(p, t.limits!.parse(limits) as Record<string, unknown>)
}

/** Every bid of an ad group and its memory: { name: [bid, remembered] }, plus the ad group's own floor owner. */
async function bids(adGroupId: string) {
  return inside(async () => {
    const g = await database.client.adGroup.findUnique({ where: { id: adGroupId }, select: { defaultBidCents: true, suppressedFromBidCents: true, bidsSuppressedBy: true } })
    const t = await database.client.adTarget.findMany({ where: { adGroupId }, select: { id: true, bidCents: true, suppressedFromBidCents: true }, orderBy: { id: 'asc' } })
    return { group: [g!.defaultBidCents, g!.suppressedFromBidCents], owner: g!.bidsSuppressedBy, targets: Object.fromEntries(t.map((x) => [x.id, [x.bidCents, x.suppressedFromBidCents]])) }
  })
}

const product: Record<string, string> = {}
/** A product with `totalStock` units and (unless pace is null) a replenishment suggestion: units a day, lead time 10, safety 5. */
async function seedProduct(key: string, totalStock: number, unitsPerDay: number | null) {
  const db = database.client
  const p = await db.product.create({ data: { sku: `TEST-SKU-${key}`, name: `Test ${key}`, basePrice: '10.00', totalStock } })
  product[key] = p.id
  if (unitsPerDay != null) {
    await db.replenishmentRecommendation.create({
      data: {
        productId: p.id, sku: p.sku, velocity: String(unitsPerDay), velocitySource: 'TRAILING_VELOCITY', leadTimeDays: 10, leadTimeSource: 'SUPPLIER_DEFAULT', safetyDays: 5,
        totalAvailable: totalStock, inboundWithinLeadTime: 0, effectiveStock: totalStock, reorderPoint: 15, reorderQuantity: 20, urgency: 'HIGH', needsReorder: true,
      },
    })
  }
}

/** One SP campaign in IT (allowlisted), one ad group with its default bid, its targets and the products it advertises. */
async function campaign(id: string, group: { defaultBidCents: number; targets: Array<[string, number]>; products: string[] }, extra: Record<string, unknown> = {}) {
  const db = database.client
  await db.campaign.create({ data: { id, name: `Test ${id}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: '12.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra } })
  await db.adGroup.create({ data: { id: `g-${id}`, campaignId: id, name: `group ${id}`, externalAdGroupId: `EXT-g-${id}`, defaultBidCents: group.defaultBidCents } })
  for (const [key, bidCents] of group.targets) {
    await db.adTarget.create({ data: { id: `t-${id}-${key}`, adGroupId: `g-${id}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `term ${id} ${key}`, bidCents, externalTargetId: `EXT-t-${id}-${key}` } })
  }
  for (const [i, key] of group.products.entries()) {
    await db.adProductAd.create({ data: { id: `pa-${id}-${i}`, adGroupId: `g-${id}`, productId: product[key], sku: `TEST-SKU-${key}`, externalAdId: `EXT-pa-${id}-${i}` } })
  }
}

let fbaLevel = ''
beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    await seedAdsFixture(db)
    await seedProduct('OUT', 0, 2)
    await seedProduct('OK', 100, 1)
    await seedProduct('RT', 0, 1)
    // A product whose only units sit at Amazon FBA: 4 units, 1 a day — 4 days of cover, below its 10-day lead time.
    await seedProduct('LOW', 0, 1)
    const fba = await db.stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'TEST-FBA', name: 'Test FBA' } })
    fbaLevel = (await db.stockLevel.create({ data: { productId: product.LOW, locationId: fba.id, quantity: 4, reserved: 0, available: 4 } })).id
    await seedProduct('LOW2', 3, 1)
    await seedProduct('LOW3', 3, 1)
    await campaign('c-out', { defaultBidCents: 40, targets: [['a', 60], ['b', 30]], products: ['OUT'] })
    await campaign('c-low', { defaultBidCents: 50, targets: [['a', 80]], products: ['LOW'] }, { dynamicBidding: { maxBidChangePct: 20 } })
    await campaign('c-mix', { defaultBidCents: 40, targets: [['a', 50]], products: ['OUT', 'OK'] })
    await campaign('c-ok', { defaultBidCents: 40, targets: [['a', 50]], products: ['OK'] })
    await campaign('c-nostep', { defaultBidCents: 40, targets: [['a', 50]], products: ['LOW2'] })
    await campaign('c-rt', { defaultBidCents: 40, targets: [['a', 70]], products: ['RT'] })
    // Short, with a 20 % guardrail: a stepped ad group every existing stop must still floor.
    await campaign('c-step2', { defaultBidCents: 50, targets: [['a', 80], ['b', 60]], products: ['LOW3'] }, { dynamicBidding: { maxBidChangePct: 20 } })
    // The retail guard already stopped this campaign; the budget engine floored this ad group on its own.
    await campaign('c-guard', { defaultBidCents: 2, targets: [['a', 2]], products: ['OUT'] }, { bidsSuppressedAt: new Date(), bidsSuppressedBy: 'automation:retail-guard', bidsSuppressedFloorCents: 2 })
    await campaign('c-eng', { defaultBidCents: 2, targets: [['a', 2]], products: ['OUT'] })
    await db.adGroup.update({ where: { id: 'g-c-eng' }, data: { suppressedFromBidCents: 40, bidsSuppressedAt: new Date(), bidsSuppressedBy: 'automation:budget-manager-cron', bidsSuppressedFloorCents: 2 } })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)

describe('the rules, pure', () => {
  it('a product: out of stock, short below its line, recovered at its restart line (or when nothing says it is short)', () => {
    expect(productStockRisk({ units: 0, unitsPerDay: 2, lowBelowDays: 10, restoreAtDays: 15 })).toEqual({ risk: 'out-of-stock', daysOfCover: 0, recovered: false })
    expect(productStockRisk({ units: 4, unitsPerDay: 1, lowBelowDays: 10, restoreAtDays: 15 })).toEqual({ risk: 'low-stock', daysOfCover: 4, recovered: false })
    // Between the lines: no longer short, not yet back (the gap keeps a restore from flipping straight back).
    expect(productStockRisk({ units: 12, unitsPerDay: 1, lowBelowDays: 10, restoreAtDays: 15 })).toEqual({ risk: 'ok', daysOfCover: 12, recovered: false })
    expect(productStockRisk({ units: 15, unitsPerDay: 1, lowBelowDays: 10, restoreAtDays: 15 })).toMatchObject({ risk: 'ok', recovered: true })
    expect(productStockRisk({ units: 3, unitsPerDay: null, lowBelowDays: null, restoreAtDays: null })).toEqual({ risk: 'ok', daysOfCover: null, recovered: true })
    expect(productStockRisk({ units: 10, unitsPerDay: 3, lowBelowDays: 10, restoreAtDays: 15 }).daysOfCover).toBe(3.3)
    // Shared stock: the other business's sales are not in the pace — judged only when the pool is out.
    expect(productStockRisk({ units: 4, unitsPerDay: 1, lowBelowDays: 10, restoreAtDays: 15, pooled: true })).toEqual({ risk: 'shared', daysOfCover: null, recovered: true })
    expect(productStockRisk({ units: 0, unitsPerDay: 1, lowBelowDays: 10, restoreAtDays: 15, pooled: true }).risk).toBe('out-of-stock')
  })

  it('an ad group: lowered as a whole only when every product is short', () => {
    const r = (...risks: Array<'out-of-stock' | 'low-stock' | 'shared' | 'ok'>) => risks.map((risk) => ({ risk }))
    expect(adGroupStockRisk(r('out-of-stock', 'out-of-stock'), 0)).toBe('out-of-stock')
    expect(adGroupStockRisk(r('out-of-stock', 'low-stock'), 0)).toBe('low-stock')
    expect(adGroupStockRisk(r('out-of-stock', 'ok'), 0)).toBe('mixed')
    expect(adGroupStockRisk(r('out-of-stock'), 1)).toBe('unknown')
    expect(adGroupStockRisk(r('ok'), 1)).toBe('ok')
    expect(adGroupStockRisk([], 0)).toBe('none')
    expect(adGroupStockRisk(r('low-stock', 'shared'), 0)).toBe('shared')
    expect(adGroupStockRisk(r('shared'), 0)).toBe('shared')
  })

  it('a bid: one step down never below the lowest it may set; never up; back through the steps only while it still equals one', () => {
    expect(stockSteppedCents(50, 5, 20)).toBe(40)
    expect(stockSteppedCents(6, 5, 50)).toBe(5)
    expect(stockSteppedCents(4, 5, 20)).toBe(4)
    const step = (approvalId: string, from: number, to: number) => ({ approvalId, bids: new Map([['target:t1', { fromCents: from, toCents: to }]]) })
    // Two steps (50 → 40 → 32), newest first: back to 50 from 32, to 50 from 40; a bid moved since is left.
    expect(chainStepBack('target:t1', 32, [step('ap2', 40, 32), step('ap1', 50, 40)])).toEqual({ cents: 50, moved: false })
    expect(chainStepBack('target:t1', 40, [step('ap1', 50, 40)])).toEqual({ cents: 50, moved: false })
    expect(chainStepBack('target:t1', 45, [step('ap1', 50, 40)])).toEqual({ cents: null, moved: true })
    expect(chainStepBack('target:t2', 45, [step('ap1', 50, 40)])).toEqual({ cents: null, moved: false })
    expect(stockStepOf({ maxBidChangePct: 20 }, 25)).toEqual({ pct: 20, by: 'campaign' })
    expect(stockStepOf({ maxBidChangePct: 30 }, 25)).toEqual({ pct: 25, by: 'strategy' })
    expect(stockStepOf(null, null)).toEqual({ pct: null, by: null })
  })
})

describe('the tools as the contract holds them', () => {
  it('both change tools: strategy-bound, ceiling auto, fully undoable, offered at ask; the give-back adds spend (alwaysAsk)', () => {
    const lower = getTool('lower-ad-bids-for-stock')!
    const restore = getTool('restore-ad-bids-after-stock')!
    expect(lower).toMatchObject({ strategyBound: 'amazon-ads', maxClaudeTrust: 'auto', reversibility: 'full', openWorld: true, requires: ['ads.bids.edit', 'financials.adspend.view'] })
    expect(lower.alwaysAsk).toBeUndefined()
    expect(restore).toMatchObject({ alwaysAsk: true, strategyBound: 'amazon-ads', maxClaudeTrust: 'auto', reversibility: 'full', openWorld: true })
    for (const tool of [lower, restore]) expect(ruleFrom(tool, null).level, tool.name).toBe('ask')
    expect(lower.limits!.parse({})).toMatchObject({ maxItems: 50, maxDaysOfCover: 365, maxChangesPerEntityPerDay: 1, allowEngineOwned: false })
    expect(restore.limits!.parse({})).toMatchObject({ maxItems: 50, maxRestoredBidCents: 0, minDaysOfCoverToRestore: 0 })
    expect(getTool('ad-stock-risk')!.readOnly).toBe(true)
  })

  it('no stock write anywhere in W3-3: the tools and the risk read import no stock writer and write no stock row', () => {
    for (const file of ['ads-stock.tools.ts', '../../advertising/ads-stock-risk.service.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(source, file).not.toMatch(/from '[^']*(stock-movement|stock-lock|stock\.tools|stock-sync|listing-stock|amazon-inventory|fba-inbound|eu-quantity|channel-stock|available-to-publish|stock-pool\/(?!sync-ledgers))[^']*'/)
      expect(source, file).not.toMatch(/\.(stockLevel|stockMovement|stockReservation|fbaInventoryDetail)\.(create|update|upsert|delete)/)
      expect(source, file).not.toMatch(/totalStock\s*:/)
    }
  })
})

describe('ad-stock-risk', () => {
  it('per product: units (FBA apart, read only), pace, cover and its own lines; per ad group: the verdict and the next tool', async () => {
    const r = await call('ad-stock-risk', { market: 'IT' })
    expect(r.ok, r.error).toBe(true)
    const d = r.data as Row
    expect(d.stockNote).toMatch(/Amazon's FBA number is Amazon's, and Nexus only reads it/)
    const group = (id: string) => d.adGroups.find((g: Row) => g.adGroupId === id)
    expect(group('g-c-out')).toMatchObject({ risk: 'out-of-stock', suggestedTool: 'lower-ad-bids-for-stock', why: 'TEST-SKU-OUT is out of stock' })
    expect(group('g-c-low')).toMatchObject({ risk: 'low-stock', suggestedTool: 'lower-ad-bids-for-stock', why: 'TEST-SKU-LOW has 4 days of cover, below its line of 10 days' })
    expect(group('g-c-mix')).toMatchObject({ risk: 'mixed', suggestedTool: null, why: expect.stringMatching(/^mixed — it also advertises TEST-SKU-OK with enough stock/) })
    expect(group('g-c-guard')).toMatchObject({ suggestedTool: null, why: 'its campaign is already stopped with low bids (by automation:retail-guard)' })
    // A whole market lists the ad groups at risk; one named is shown whatever its verdict.
    expect(group('g-c-ok')).toBeUndefined()
    expect(((await call('ad-stock-risk', { campaignIds: ['c-ok'] })).data as Row).adGroups[0]).toMatchObject({ adGroupId: 'g-c-ok', risk: 'ok', suggestedTool: null })
    const low = d.products.find((p: Row) => p.sku === 'TEST-SKU-LOW')
    expect(low).toMatchObject({ risk: 'low-stock', units: 4, amazonFbaUnits: 4, unitsInOwnOrPoolStock: 0, unitsPerDay: 1, daysOfCover: 4, shortBelowDays: 10, backAtDays: 15, leadTimeDays: 10, safetyDays: 5, adGroupIds: ['g-c-low'] })
    // A what-if line: short below 3 days instead of the lead time.
    const whatIf = (await call('ad-stock-risk', { campaignIds: ['c-low'], lowBelowDays: 3, show: 'all' })).data as Row
    expect(whatIf.adGroups[0].risk).toBe('ok')
    expect(whatIf.lines).toMatch(/^Asked with its own line: a product is short below 3 days/)
  })
})

describe('lower-ad-bids-for-stock', () => {
  it('out of stock: every bid to the floor, never paused; the preview names each ad group, its bids and where it lands', async () => {
    const r = await call('lower-ad-bids-for-stock', { adGroupIds: ['g-c-out'] })
    expect(r.ok, r.error).toBe(true)
    const p = r.preview as Row
    expect(p).toMatchObject({
      action: 'lower-ad-bids-for-stock', totals: { adGroups: 1, outOfStock: 1, short: 0, bids: 3, left: 0 }, reach: { reach: 'sandbox' },
      campaign: { id: 'c-out' }, cover: { highestDaysOfCover: 0 },
      limitFacts: { tool: 'lower-ad-bids-for-stock', action: 'stop', this: { items: 1, cuts: 1, raises: 0 } },
    })
    expect(p.changes).toEqual([{ label: 'ad group "group c-out" (campaign "Test c-out") · 3 bids, the highest', fromCents: 60, toCents: 2, currency: 'EUR', marketplace: 'IT' }])
    expect(p.adGroups[0]).toMatchObject({ how: 'floor', floorCents: 2, floor: 'the 2-cent floor (the ads strategy sets no stop bid here)', why: 'TEST-SKU-OUT is out of stock' })
    expect(p.effect).toMatch(/never pausing them/)
    expect(p.effect).toMatch(/Nothing here changes a stock quantity/)
  })

  it('leaves what it may not lower — mixed, a floored campaign, an engine\'s floor, enough stock — and refuses when nothing is left to lower', async () => {
    expect((await call('lower-ad-bids-for-stock', {})).error).toMatch(/^Name the ad groups/)
    expect((await call('lower-ad-bids-for-stock', { adGroupIds: ['nope'] })).error).toBe('Not queued: ad group nope was not found in this business.')
    expect((await call('lower-ad-bids-for-stock', { adGroupIds: ['g-c-mix'] })).error).toMatch(/^Nothing to lower: ad group "group c-mix" .*mixed — it also advertises TEST-SKU-OK with enough stock, so it is never lowered as a whole/)
    expect((await call('lower-ad-bids-for-stock', { adGroupIds: ['g-c-guard'] })).error).toMatch(/its campaign is already stopped with low bids \(by automation:retail-guard\)/)
    expect((await call('lower-ad-bids-for-stock', { adGroupIds: ['g-c-eng'] })).error).toMatch(/it is already floored by automation:budget-manager-cron/)
    expect((await call('lower-ad-bids-for-stock', { adGroupIds: ['g-c-ok'] })).error).toMatch(/every product it advertises has enough stock/)
    expect((await call('lower-ad-bids-for-stock', { adGroupIds: ['g-c-sb'] })).error).toMatch(/not a Sponsored Products campaign/)
    // By campaign: what is short is lowered, the rest is left and listed.
    const p = (await call('lower-ad-bids-for-stock', { campaignIds: ['c-out', 'c-mix'] })).preview as Row
    expect(p.totals).toMatchObject({ adGroups: 1, left: 1 })
    expect(p.left).toEqual([expect.objectContaining({ adGroupId: 'g-c-mix', risk: 'mixed' })])
  })

  it('short (not out): one step down by the largest bid change; without one, only when asked for the floor', async () => {
    const p = (await call('lower-ad-bids-for-stock', { adGroupIds: ['g-c-low'] })).preview as Row
    expect(p.adGroups[0]).toMatchObject({ how: 'step', step: '20 % (the campaign\'s max-change guardrail)', bids: [
      { kind: 'adGroup', id: 'g-c-low', fromCents: 50, toCents: 40 },
      { kind: 'target', id: 't-c-low-a', fromCents: 80, toCents: 64 },
    ] })
    expect(p.cover).toEqual({ highestDaysOfCover: 4 })
    // A plain step: judged as a step (not a forced stop), said honestly — auto-bid holds it, a bound rule or plan may not.
    expect(p).toMatchObject({ totals: { stepped: 1, floored: 0 }, limitFacts: { this: { cuts: 1, largestCutPct: 20 } }, stepNote: expect.stringMatching(/auto-bid leaves these keyword and target bids alone for 60 days/) })
    expect((await call('lower-ad-bids-for-stock', { adGroupIds: ['g-c-nostep'] })).error).toMatch(/no largest bid change is set to step by .*ask with lowerTo "floor"/)
    expect(((await call('lower-ad-bids-for-stock', { adGroupIds: ['g-c-nostep'], lowerTo: 'floor' })).preview as Row).adGroups[0]).toMatchObject({ how: 'floor', floorCents: 2 })
  })

  it('approved: a step is a plain lowering as the approver (no floor markers); out of stock later, the existing floor remembers the stepped bid', async () => {
    const asked = await ask('lower-ad-bids-for-stock', { adGroupIds: ['g-c-low'], why: 'stock running out' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { lowered: 1, stepped: 1, floored: 0, bidsMoved: 2, failed: 0, reach: { reach: 'sandbox' } } })
    // Nothing remembered on the rows, no owner: the request's change record keeps from → to.
    expect(await bids('g-c-low')).toEqual({ group: [40, null], owner: null, targets: { 't-c-low-a': [64, null] } })
    const logs = await sql('SELECT "userId", "executionId", "entityType" FROM "AdvertisingActionLog" WHERE "executionId" = $1 ORDER BY "entityType"', [asked.approvalId])
    expect(logs).toEqual([
      { userId: 'user:u-approver', executionId: asked.approvalId, entityType: 'AD_GROUP' },
      { userId: 'user:u-approver', executionId: asked.approvalId, entityType: 'AD_TARGET' },
    ])
    const [queued] = await sql<{ payload: Row }>(`SELECT payload FROM "OutboundSyncQueue" WHERE payload->>'entityId' = $1 ORDER BY "createdAt" DESC LIMIT 1`, ['t-c-low-a'])
    expect(queued.payload).toMatchObject({ manual: true, fieldChanges: [{ field: 'bid', oldValue: '80', newValue: '64' }] })
    expect(queued.payload.force).not.toBe(true)
    const [record] = await sql<{ before: Row }>('SELECT before FROM "AgentChange" WHERE "approvalId" = $1', [asked.approvalId])
    expect(record.before.steps).toEqual([
      { adGroupId: 'g-c-low', kind: 'adGroup', id: 'g-c-low', fromCents: 50, toCents: 40 },
      { adGroupId: 'g-c-low', kind: 'target', id: 't-c-low-a', fromCents: 80, toCents: 64 },
    ])
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({
      request: { tool: 'restore-ad-bids-after-stock', args: { adGroupIds: ['g-c-low'], evenIfStillShort: true } },
    })
    // Its last units sell: out of stock now, so the existing floor — which remembers the stepped bids.
    await inside(() => database.client.stockLevel.update({ where: { id: fbaLevel }, data: { quantity: 0, available: 0 } }))
    const again = await ask('lower-ad-bids-for-stock', { adGroupIds: ['g-c-low'] })
    expect(await approve(again.approvalId!)).toMatchObject({ ok: true, result: { lowered: 1, floored: 1, stepped: 0, bidsMoved: 2 } })
    expect(await bids('g-c-low')).toEqual({ group: [2, 40], owner: 'user:u-approver', targets: { 't-c-low-a': [2, 64] } })
  })

  it('every existing stop still floors a stepped ad group, and gives it back to its stepped bids', async () => {
    const asked = await ask('lower-ad-bids-for-stock', { adGroupIds: ['g-c-step2'] })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, result: { stepped: 1, bidsMoved: 3 } })
    const stepped = { group: [40, null], owner: null, targets: { 't-c-step2-a': [64, null], 't-c-step2-b': [48, null] } }
    expect(await bids('g-c-step2')).toEqual(stepped)
    // A campaign stop (the retail guard; a monthly cap, a night or Min-bid window and suppress-campaign floor the same way).
    await inside(() => suppressCampaignBids('c-step2', { actor: 'automation:retail-guard' }))
    expect(await bids('g-c-step2')).toEqual({ group: [2, 40], owner: null, targets: { 't-c-step2-a': [2, 64], 't-c-step2-b': [2, 48] } })
    await inside(() => restoreCampaignBids('c-step2', { actor: 'automation:retail-guard' }))
    expect(await bids('g-c-step2')).toEqual(stepped)
    // The budget engine's own ad-group floor (a product over its monthly cap).
    await inside(() => suppressAdGroupBids('g-c-step2', { actor: 'automation:budget-manager-cron' }))
    expect(await bids('g-c-step2')).toEqual({ group: [2, 40], owner: 'automation:budget-manager-cron', targets: { 't-c-step2-a': [2, 64], 't-c-step2-b': [2, 48] } })
    await inside(() => restoreAdGroupBids('g-c-step2', { actor: 'automation:budget-manager-cron' }))
    expect(await bids('g-c-step2')).toEqual(stepped)
  })

  it('a bid or the stock that moved after the person approved stops the run', async () => {
    const asked = await ask('lower-ad-bids-for-stock', { adGroupIds: ['g-c-nostep'], lowerTo: 'floor' })
    await inside(() => database.client.adTarget.update({ where: { id: 't-c-nostep-a' }, data: { bidCents: 55 } }))
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false })
    expect((await bids('g-c-nostep')).owner).toBeNull()
  })
})

describe('restore-ad-bids-after-stock', () => {
  it('waits while stock is short; once cover is back above the restart line it puts back exactly what was', async () => {
    expect((await call('restore-ad-bids-after-stock', { adGroupIds: ['g-c-low'] })).error).toMatch(/^Nothing to give back: .*still out of stock: TEST-SKU-LOW/)
    // 12 units at 1 a day: no longer short (10), not yet back (15).
    await inside(() => database.client.stockLevel.update({ where: { id: fbaLevel }, data: { quantity: 12, available: 12 } }))
    expect((await call('restore-ad-bids-after-stock', { adGroupIds: ['g-c-low'] })).error).toMatch(/still short of stock: TEST-SKU-LOW has 12 days of cover, below its restart line of 15 days/)
    await inside(() => database.client.stockLevel.update({ where: { id: fbaLevel }, data: { quantity: 40, available: 40 } }))
    const r = await call('restore-ad-bids-after-stock', { adGroupIds: ['g-c-low'] })
    expect(r.ok, r.error).toBe(true)
    const p = r.preview as Row
    expect(p).toMatchObject({
      action: 'restore-ad-bids-after-stock', totals: { adGroups: 1, bids: 2 }, highestRestoredBidCents: 80, cover: { lowestDaysOfCover: 40, unknown: 0 },
      limitFacts: { tool: 'restore-ad-bids-after-stock', action: 'restore', this: { raises: 1 } },
    })
    expect(p.changes).toEqual([
      { label: 'ad group "group c-low" (campaign "Test c-low") · default bid', fromCents: 2, toCents: 50, currency: 'EUR', marketplace: 'IT' },
      { label: 'ad group "group c-low" (campaign "Test c-low") · “term c-low a”', fromCents: 2, toCents: 80, currency: 'EUR', marketplace: 'IT' },
    ])
    expect(p.effect).toMatch(/their stock back above every restart line\. Spend resumes/)
    const asked = await ask('restore-ad-bids-after-stock', { adGroupIds: ['g-c-low'] })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { gaveBack: 1, bidsRestored: 2 } })
    // The floor's memory (the stepped bids) and then the step: back to the bids before the stock problem.
    expect(await bids('g-c-low')).toEqual({ group: [50, null], owner: null, targets: { 't-c-low-a': [80, null] } })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'lower-ad-bids-for-stock', args: { adGroupIds: ['g-c-low'] } } })
  })

  it('a step gives back only the bids still at their stepped value; one an engine moved is left and named', async () => {
    // Stock is back for the stepped ad group; an engine moved one of its keywords since the step.
    await inside(() => database.client.product.update({ where: { id: product.LOW3 }, data: { totalStock: 100 } }))
    await inside(() => database.client.adTarget.update({ where: { id: 't-c-step2-b' }, data: { bidCents: 55 } }))
    const read = (await call('ad-stock-risk', { adGroupIds: ['g-c-step2'] })).data as Row
    expect(read.adGroups[0]).toMatchObject({ risk: 'ok', stockStepsOnRecord: 1, suggestedTool: 'restore-ad-bids-after-stock' })
    const p = (await call('restore-ad-bids-after-stock', { adGroupIds: ['g-c-step2'] })).preview as Row
    expect(p).toMatchObject({ totals: { adGroups: 1, bids: 2, notGivenBack: 1 }, notGivenBack: [{ id: 't-c-step2-b', nowCents: 55 }], limitFacts: { this: { raises: 1, budgetIncreaseCents: 0 } } })
    expect(p.changes.map((c: Row) => [c.fromCents, c.toCents])).toEqual([[40, 50], [64, 80]])
    const asked = await ask('restore-ad-bids-after-stock', { adGroupIds: ['g-c-step2'] })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, result: { bidsRestored: 2 } })
    expect(await bids('g-c-step2')).toEqual({ group: [50, null], owner: null, targets: { 't-c-step2-a': [80, null], 't-c-step2-b': [55, null] } })
    // Given back once: nothing is left to give back.
    expect((await call('restore-ad-bids-after-stock', { adGroupIds: ['g-c-step2'] })).error).toMatch(/every bid a stock step lowered was moved since|its bids are back already/)
  })

  it('never an engine\'s floor nor under a campaign floor; an undo gives back even while short, and never by rule', async () => {
    expect((await call('restore-ad-bids-after-stock', { adGroupIds: ['g-c-eng'] })).error).toMatch(/it was floored by automation:budget-manager-cron: only a floor a person set .* is given back here/)
    expect((await call('restore-ad-bids-after-stock', { adGroupIds: ['g-c-ok'] })).error).toMatch(/it was not lowered for stock: no floor of its own and no stock step on record/)
    expect((await call('restore-ad-bids-after-stock', { adGroupIds: ['g-c-guard'] })).error).toMatch(/its bids cannot serve until that floor is lifted, and the campaign's own restore leaves an ad group's own floor and its stock steps alone/)
    const lowered = await ask('lower-ad-bids-for-stock', { adGroupIds: ['g-c-out'] })
    await approve(lowered.approvalId!)
    expect((await call('restore-ad-bids-after-stock', { adGroupIds: ['g-c-out'] })).error).toMatch(/still out of stock: TEST-SKU-OUT/)
    const undo = (await call('restore-ad-bids-after-stock', { adGroupIds: ['g-c-out'], evenIfStillShort: true })).preview as Row
    expect(undo).toMatchObject({ evenIfStillShort: true, warning: expect.stringMatching(/still short/), totals: { adGroups: 1, bids: 3 } })
  })
})

describe('the limits: a lowering may run by rule inside the strategy; a give-back waits for a person by default', () => {
  it('without a strategy for the market a person decides; with one that allows it, a lowering runs at the default limits', async () => {
    const p = (await call('lower-ad-bids-for-stock', { adGroupIds: ['g-c-nostep'], lowerTo: 'floor' })).preview
    expect(judge('lower-ad-bids-for-stock', p)).toMatch(/there is no ads strategy for IT/)
    expect(judge('lower-ad-bids-for-stock', { summary: 'no facts' })).toMatch(/no limit facts/)
    const row = await inside(() => database.client.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', updatedBy: 'user:test', claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 10, claudeMaxBudgetIncreasePerDayCents: 100_000, stopMethod: 'LOW_BIDS', stopBidCents: 3 } }))
    try {
      const inside3 = (await call('lower-ad-bids-for-stock', { adGroupIds: ['g-c-nostep'], lowerTo: 'floor' })).preview as Row
      // The strategy's stop bid is the floor now.
      expect(inside3.adGroups[0]).toMatchObject({ floorCents: 3, floor: expect.stringMatching(/^the stop bid EUR 0.03 \(ads strategy: Test market \(IT\)/) })
      expect(judge('lower-ad-bids-for-stock', inside3)).toBeNull()
      // A lower cover limit keeps a short (not out) lowering with a person; out of stock (0 days) still runs.
      expect(judge('lower-ad-bids-for-stock', inside3, { maxDaysOfCover: 2 })).toMatch(/a product with 3 days of cover, more than the 2/)
      expect(judge('lower-ad-bids-for-stock', (await call('lower-ad-bids-for-stock', { adGroupIds: ['g-c-rt'] })).preview, { maxDaysOfCover: 0 })).toBeNull()
      // The strategy narrows the kind: stop held at ask for the market.
      await inside(() => database.client.adsStrategy.update({ where: { id: row.id }, data: { claudeAutonomy: { stop: 'ask' }, version: 2 } }))
      expect(judge('lower-ad-bids-for-stock', (await call('lower-ad-bids-for-stock', { adGroupIds: ['g-c-nostep'], lowerTo: 'floor' })).preview)).toMatch(/lets Claude only ask for stopping ads with low bids/)
      await inside(() => database.client.adsStrategy.update({ where: { id: row.id }, data: { claudeAutonomy: null, version: 3 } }))

      // A give-back: by default a person decides (0); inside a highest bid and the cover it needs, it may run by rule.
      const lowered = await ask('lower-ad-bids-for-stock', { adGroupIds: ['g-c-rt'] })
      expect(await approve(lowered.approvalId!)).toMatchObject({ ok: true })
      await inside(() => database.client.product.update({ where: { id: product.RT }, data: { totalStock: 50 } }))
      const back = (await call('restore-ad-bids-after-stock', { adGroupIds: ['g-c-rt'] })).preview as Row
      expect(back).toMatchObject({ highestRestoredBidCents: 70, cover: { lowestDaysOfCover: 50, unknown: 0 } })
      expect(judge('restore-ad-bids-after-stock', back)).toMatch(/its highest bid given back is EUR 0.70, more than the EUR 0.00 .* \(0: every give-back waits for a person\)/)
      expect(judge('restore-ad-bids-after-stock', back, { maxRestoredBidCents: 100 })).toBeNull()
      expect(judge('restore-ad-bids-after-stock', back, { maxRestoredBidCents: 100, minDaysOfCoverToRestore: 60 })).toMatch(/50 days of cover, fewer than the 60/)
      // The month and the daily budget: a give-back restarts its campaign's budget, counted once.
      expect(back.limitFacts.this).toMatchObject({ raises: 1, budgetIncreaseCents: 1200 })
      // A halt: a give-back adds spend, so the halt refuses it by rule up front (a person's approval still passes, as his
      // own click); a floor lets go, so a halt does not refuse it.
      vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
      await halt(true)
      try {
        const halted = (await call('restore-ad-bids-after-stock', { adGroupIds: ['g-c-rt'] })).preview as Row
        expect(halted.reach).toMatchObject({ reach: 'live' })
        expect(halted.ruleGate).toMatch(/refuses it as a run by rule — ads automation is stopped/)
        expect(judge('restore-ad-bids-after-stock', halted, { maxRestoredBidCents: 100 })).toMatch(/ads automation is stopped/)
        expect(((await call('lower-ad-bids-for-stock', { adGroupIds: ['g-c-nostep'], lowerTo: 'floor' })).preview as Row).ruleGate).toBeNull()
      } finally {
        await halt(false)
        vi.unstubAllEnvs()
      }
      // An undo while stock is still short never runs by rule, whatever the limits.
      const undo = (await call('restore-ad-bids-after-stock', { adGroupIds: ['g-c-out'], evenIfStillShort: true })).preview
      expect(judge('restore-ad-bids-after-stock', undo, { maxRestoredBidCents: 10_000 })).toBe('it gives bids back while stock is still short (an undo); a person decides')
    } finally {
      await inside(() => database.client.adsStrategy.delete({ where: { id: row.id } }))
    }
  })
})

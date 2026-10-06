/**
 * ADS AUTONOMY W1-5 — the strategy steers and binds the BID engines, on a real PostgreSQL with the production schema and
 * every business policy (PGlite), business profiles ON, two businesses. Values are made up (public repo).
 *
 *   target     the optimiser per ad group: the caller's own → the campaign's own (it wins, Owner decision) → the
 *              strategy (product → parent → deepest primary category → market; the lowest across the ad group's
 *              products) → the account default → flat; the same chain for the `bid_apply` target-ACoS ops
 *   band       the optimiser clamps inside the band and its proposal passes the write gate; the same bid outside it is
 *              refused by the gate with the strategy row named; another business's strategy holds nothing here
 *   step       the largest change is the lower of the campaign's and the strategy's, in the write and in Claude's preview;
 *              a step never stops a move into the band
 *   person     the band is one of his own limits (PR #401, 3A): a person's own edit past it asks for his confirmation,
 *              then goes and says so; past the largest change it is sent with a warning (never rewritten, CM-19)
 *   restore    a restore after a stop goes back to min(remembered, effective max) and says so, for the strategy and the
 *              campaign's own column alike, whoever restores
 *   hourly     the base-bid directive is held inside the band and the run's hold log names it
 *   evidence   the write keeps which level supplied each number
 *   no rows    a market without a strategy row proposes exactly as before
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

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

// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction.
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))

const { previewBidOptimization, holdToStrategy } = await import('../ads-bid-optimizer.service.js')
const { entityBoundsDenial } = await import('../ads-write-gate.js')
const { updateAdTargetWithSync } = await import('../ads-mutation.service.js')
const { restoreCampaignBids, applyBaseBidDelta } = await import('../ads-bid-suppression.service.js')
const { changeClampedBid } = await import('../../agents/tools/ads-change-kit.js')
const { ACTION_HANDLERS } = await import('../../automation-rule.service.js')
await import('../automation-action-handlers.js')
const { bidLimitsFor, clampBid, clampToStrategy, holdNote, newHoldLog, stepClamp, NO_LIMITS } = await import('./bids.js')
const { bidGuardrails } = await import('../autopilot/conductor.js')
const { DEFAULT_GUARDRAILS } = await import('../autopilot/presets.js')

const A = 'w1_bids_alpha'
const B = 'w1_bids_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client
const ids: Record<string, string> = {}
type Proposal = Awaited<ReturnType<typeof previewBidOptimization>>['proposals'][number]
const proposals = async (opts: Parameters<typeof previewBidOptimization>[0] = {}) => (await inA(() => previewBidOptimization(opts))).proposals
const of = (list: Proposal[], key: string) => list.find((p) => p.targetId === ids[key])!
const source = (level: string, label: string, value: number) => expect.objectContaining({ level, label, version: 1, value })

/** One SP campaign with one ad group advertising `products` and one keyword that spent (ACoS 50 %). */
async function campaign(key: string, market: string, products: string[], bidCents: number, extra: Record<string, unknown> = {}) {
  const c = db()
  ids[`c-${key}`] = (await c.campaign.create({ data: {
    name: `Test ${key}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: market, dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'),
    externalCampaignId: `EXT-${key}`, liveBidWritesEnabled: true, ...extra,
  } as never })).id
  ids[`g-${key}`] = (await c.adGroup.create({ data: { campaignId: ids[`c-${key}`], name: `Test group ${key}`, externalAdGroupId: `EXT-G-${key}`, defaultBidCents: bidCents } })).id
  for (const [i, p] of products.entries()) await c.adProductAd.create({ data: { adGroupId: ids[`g-${key}`], productId: ids[p], asin: `B0TEST${key.toUpperCase()}${i}` } })
  ids[`t-${key}`] = (await c.adTarget.create({ data: {
    adGroupId: ids[`g-${key}`], kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `test term ${key}`, bidCents, externalTargetId: `EXT-T-${key}`,
    clicks: 20, spendCents: 1000, salesCents: 2000, ordersCount: 2,
  } })).id
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
  }
  await inA(async () => {
    const c = db()
    ids.cat = (await c.category.create({ data: { slug: 'w15-leaf', name: { en: { name: 'Test leaf' } } } })).id
    await c.categoryClosure.create({ data: { ancestorId: ids.cat, descendantId: ids.cat, depth: 0 } })
    ids.parent = (await c.product.create({ data: { sku: 'TEST-W15-PARENT', name: 'Test parent', basePrice: '10.00', isParent: true } })).id
    ids.p1 = (await c.product.create({ data: { sku: 'TEST-W15-P1', name: 'Test variation', basePrice: '10.00', parentId: ids.parent } })).id
    ids.p2 = (await c.product.create({ data: { sku: 'TEST-W15-P2', name: 'Test standalone', basePrice: '10.00' } })).id
    await c.productCategory.create({ data: { productId: ids.parent, categoryId: ids.cat, isPrimary: true } })

    const row = (level: string, scopeId: string, label: string, set: object) =>
      c.adsStrategy.create({ data: { market: 'IT', level, scopeId, label, updatedBy: 'user:test', ...set } })
    // Market: a 35 % target, a 10¢ lowest bid, a 30 % largest change. Category (P1's family): 20 % and an 80¢ highest
    // bid. Product P2: a 50¢ highest bid and a 10 % largest change.
    await row('MARKET', '*', 'Test market (IT)', { targetKind: 'ACOS', targetPct: 35, minBidCents: 10, maxChangePct: 30 })
    await row('CATEGORY', ids.cat, 'Test leaf (IT)', { targetKind: 'ACOS', targetPct: 20, maxBidCents: 80 })
    await row('PRODUCT', ids.p2, 'TEST-W15-P2 (IT)', { maxBidCents: 50, maxChangePct: 10 })
    await c.adsAutomationState.create({ data: { defaultTargetAcosPct: 45 } })

    await campaign('own', 'IT', ['p1'], 60, { dynamicBidding: { targetAcos: 0.4 } }) // the campaign's own target
    await campaign('strat', 'IT', ['p1'], 60) // no own target: the strategy's (category, 20 %)
    await campaign('mix', 'IT', ['p1', 'p2'], 60) // two products: the safer value per field
    await campaign('high', 'IT', ['p2'], 80) // above P2's 50¢ highest bid already
    await campaign('de', 'DE', ['p1'], 60) // a market without a strategy
    await campaign('rest', 'IT', ['p1'], 2, { bidsSuppressedAt: new Date(), bidsSuppressedBy: 'automation:rank-defend-test' })
    await c.adTarget.update({ where: { id: ids['t-rest'] }, data: { suppressedFromBidCents: 120 } })
    await c.adGroup.update({ where: { id: ids['g-rest'] }, data: { suppressedFromBidCents: 70 } })
    await campaign('restde', 'DE', ['p1'], 2, { bidsSuppressedAt: new Date(), bidsSuppressedBy: 'automation:rank-defend-test', maxBidCents: 100 })
    await c.adTarget.update({ where: { id: ids['t-restde'] }, data: { suppressedFromBidCents: 150 } })
    await campaign('delta', 'IT', ['p1'], 60)
  })
  // Another business, same market, a far lower highest bid: it holds nothing in business A.
  await inB(() => db().adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'BRAVO market (IT)', maxBidCents: 3, targetKind: 'ACOS', targetPct: 5, updatedBy: 'user:bravo' } }))
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

beforeEach(() => { delete process.env.NEXUS_BID_OPTIMIZER_SOURCE })

describe('the target chain in the optimiser, per ad group', () => {
  it("the campaign's own target wins over the strategy; the strategy over the account default; each named, with its sources", async () => {
    const list = await proposals()
    // Own target 40 %: ratio max(1 − 30 % step, 40/50) = 0.8 → 48¢. Band 10–80¢ (market floor, category ceiling).
    expect(of(list, 't-own')).toMatchObject({
      proposedBidCents: 48, targetAcosUsed: 0.4, targetSource: 'campaign', reason: 'ACOS 50% > target 40% (campaign target) — lower',
      sources: {
        targetAcosPct: { level: 'campaign', value: 40 },
        minBidCents: source('market', 'Test market (IT)', 10),
        maxBidCents: source('category', 'Test leaf (IT)', 80),
        maxChangePct: source('market', 'Test market (IT)', 30),
      },
    })
    // No own target: the category's 20 % (P1 → its parent's primary category) — ratio max(0.7, 0.4) = 0.7 → 42¢.
    expect(of(list, 't-strat')).toMatchObject({
      proposedBidCents: 42, targetAcosUsed: 0.2, targetSource: 'strategy',
      reason: 'ACOS 50% > target 20% (ads strategy: Test leaf (IT), category, v1) — lower',
      sources: { targetAcosPct: source('category', 'Test leaf (IT)', 20) },
    })
    // A market without a strategy: the account default 45 %, no strategy source, as W0 (ratio 0.9 → 54¢).
    expect(of(list, 't-de')).toMatchObject({ proposedBidCents: 54, targetAcosUsed: 0.45, targetSource: 'account' })
    expect(of(list, 't-de').sources).toEqual({ targetAcosPct: { level: 'account', value: 45 } })
  })

  it("a shared ad group takes the safer value per field (lower target, highest bid and step) and names the product; the bid is held to the band", async () => {
    const p = of(await proposals(), 't-mix')
    // Target 20 % (P1's category, lower than P2's market 35 %); step 10 % (P2) → max(0.9, 0.4) = 0.9 → 54¢ → held to P2's 50¢.
    expect(p).toMatchObject({ targetAcosUsed: 0.2, targetSource: 'strategy', proposedBidCents: 50 })
    expect(p.reason).toContain('(held to the highest bid 50¢ (ads strategy: TEST-W15-P2 (IT), product, v1, from TEST-W15-P2))')
    expect(p.sources.maxChangePct).toMatchObject({ level: 'product', value: 10, product: 'TEST-W15-P2' })
  })

  it("a caller's own target still wins; without the account default the strategy-less market falls to the flat 30 %", async () => {
    expect(of(await proposals({ targetAcos: 0.25, targetAcosFrom: "this rule's target" }), 't-strat')).toMatchObject({ targetAcosUsed: 0.25, targetSource: 'explicit' })
    await inA(() => db().adsAutomationState.updateMany({ data: { defaultTargetAcosPct: null } }))
    try {
      expect(of(await proposals(), 't-de')).toMatchObject({ targetAcosUsed: 0.3, targetSource: 'flat', proposedBidCents: 36 })
    } finally {
      await inA(() => db().adsAutomationState.updateMany({ data: { defaultTargetAcosPct: 45 } }))
    }
  })

  it("another business's strategy holds nothing here", async () => {
    const list = await proposals()
    expect(of(list, 't-own').proposedBidCents).toBe(48) // not B's 3¢ ceiling, not its 5 % target
    expect(await inB(() => previewBidOptimization())).toMatchObject({ proposals: [] })
  })

  it('a rule\'s own Min bid above the strategy\'s highest bid: the stricter (lower) wins (holdToStrategy)', async () => {
    const p = of(await proposals(), 't-mix')
    const [held] = holdToStrategy([{ ...p, proposedBidCents: 70, deltaCents: 10 }])
    expect(held).toMatchObject({ proposedBidCents: 50 })
  })
})

describe('the band at the write gate agrees with the engines\' clamp', () => {
  const campaignRow = async (key: string) => inA(() => db().campaign.findUniqueOrThrow({
    where: { id: ids[`c-${key}`] }, select: { minBidCents: true, maxBidCents: true, minBudgetCents: true, maxBudgetCents: true, portfolioId: true, marketplace: true },
  }))
  const deny = async (key: string, cents: number, extra: Record<string, unknown> = {}) => inA(async () => entityBoundsDenial({
    campaignId: ids[`c-${key}`], campaign: await campaignRow(key), field: 'bid', intendedValueCents: cents, adGroupId: ids[`g-${key}`], ...extra,
  }))

  it("the optimiser's proposal passes; the same bid above the band is refused, the strategy row named", async () => {
    expect(await deny('mix', 50)).toBeNull()
    expect(await deny('mix', 70)).toMatchObject({ deniedAt: 'entity_bounds', reason: 'bid 70¢ exceeds the 50¢ ceiling (ads strategy: TEST-W15-P2 (IT), product, v1, from TEST-W15-P2)' })
    // The ad group's band, not the campaign-wide one: P1 alone holds 80¢.
    expect(await deny('strat', 70)).toBeNull()
    // Without an ad group: the campaign's (all its products, the safer value).
    expect(await inA(async () => entityBoundsDenial({ campaignId: ids['c-mix'], campaign: await campaignRow('mix'), field: 'bid', intendedValueCents: 70 }))).toMatchObject({ deniedAt: 'entity_bounds' })
  })

  it('the lowest bid refuses an engine\'s cut below it, but never a stop (suppression)', async () => {
    expect(await deny('strat', 5)).toMatchObject({ reason: 'bid 5¢ is below the 10¢ floor (ads strategy: Test market (IT), market, v1)' })
    expect(await deny('strat', 2, { isSuppression: true })).toBeNull()
  })

  it('the band is the same for every writer at this check; a person\'s write past it is turned into a confirmation by 3A', async () => {
    // entityBoundsDenial answers the same for everyone (entity_bounds); the gate and the mutation layer turn it into
    // "needs your confirmation" for a person (see the step-clamp section below).
    expect(await deny('mix', 70)).toMatchObject({ deniedAt: 'entity_bounds' })
  })

  it('a market without a bid field set costs one read and adds nothing', async () => {
    expect(await inA(() => bidLimitsFor({ marketplace: 'DE', adGroupId: ids['g-de'] }))).toEqual(NO_LIMITS)
    expect(await deny('de', 5000)).toBeNull()
  })
})

describe('the step clamp: the lower of the campaign\'s and the strategy\'s largest change', () => {
  const actionLog = (id: string) => inA(() => db().advertisingActionLog.findUniqueOrThrow({ where: { id }, select: { evidence: true, payloadAfter: true } }))

  it('an engine write moves at most the strategy\'s 30 % and the action log names it', async () => {
    const out = await inA(() => updateAdTargetWithSync({ adTargetId: ids['t-strat'], patch: { bidCents: 30 }, actor: 'automation:test-engine', reason: 'test' }))
    expect(out).toMatchObject({ ok: true })
    expect(await inA(() => db().adTarget.findUniqueOrThrow({ where: { id: ids['t-strat'] }, select: { bidCents: true } }))).toEqual({ bidCents: 42 })
    expect((await actionLog(out.actionLogId!)).evidence).toEqual({ sources: { maxChangePct: expect.objectContaining({ level: 'market', value: 30, label: 'Test market (IT)' }) } })
  })

  it("the campaign's own lower guardrail binds instead; Claude's preview shows the same number", async () => {
    await inA(() => db().campaign.update({ where: { id: ids['c-delta'] }, data: { dynamicBidding: { maxBidChangePct: 10 } } }))
    const limits = await inA(() => bidLimitsFor({ marketplace: 'IT', adGroupId: ids['g-delta'] }))
    expect(changeClampedBid(60, 30, { maxBidChangePct: 10 }, limits)).toBe(54)
    expect(changeClampedBid(60, 30, { maxBidChangePct: 50 }, limits)).toBe(42) // the strategy's 30 % is lower
    const out = await inA(() => updateAdTargetWithSync({ adTargetId: ids['t-delta'], patch: { bidCents: 30 }, actor: 'automation:test-engine' }))
    expect(out.ok).toBe(true)
    expect(await inA(() => db().adTarget.findUniqueOrThrow({ where: { id: ids['t-delta'] }, select: { bidCents: true } }))).toEqual({ bidCents: 54 })
    expect((await actionLog(out.actionLogId!)).evidence).toBeNull() // the campaign's own guardrail: nothing of the strategy's
  })

  it('a step never stops a move into the band: 80¢ → the 50¢ highest bid in one write, not 72¢', async () => {
    const out = await inA(() => updateAdTargetWithSync({ adTargetId: ids['t-high'], patch: { bidCents: 50 }, actor: 'automation:test-engine' }))
    expect(out.ok).toBe(true)
    expect(await inA(() => db().adTarget.findUniqueOrThrow({ where: { id: ids['t-high'] }, select: { bidCents: true } }))).toEqual({ bidCents: 50 })
    expect((await actionLog(out.actionLogId!)).evidence).toMatchObject({ sources: { maxBidCents: { level: 'product', value: 50 } } })
  })

  it("an engine's bid outside the band is refused before anything is written; a person's asks for his confirmation, then goes and says so", async () => {
    const bid = async () => (await inA(() => db().adTarget.findUniqueOrThrow({ where: { id: ids['t-mix'] }, select: { bidCents: true } }))).bidCents
    const engine = await inA(() => updateAdTargetWithSync({ adTargetId: ids['t-mix'], patch: { bidCents: 66 }, actor: 'automation:test-engine' }))
    expect(engine).toMatchObject({ ok: false, error: expect.stringContaining('ceiling (ads strategy: TEST-W15-P2 (IT), product, v1') })
    // His own limit (3A): nothing written until he sends it anyway.
    const asked = await inA(() => updateAdTargetWithSync({ adTargetId: ids['t-mix'], patch: { bidCents: 70 }, actor: 'user:test-person', manual: true }))
    expect(asked).toMatchObject({ ok: false, needsConfirmation: { limits: [{ limit: 'entity_bounds', reason: expect.stringContaining('ads strategy: TEST-W15-P2 (IT), product, v1') }] } })
    expect(await bid()).toBe(60)
    const sent = await inA(() => updateAdTargetWithSync({ adTargetId: ids['t-mix'], patch: { bidCents: 70 }, actor: 'user:test-person', manual: true, confirmOwnLimits: true }))
    // The step is never rewritten for a person (CM-19): past the strategy's 10 %, it is sent with a warning.
    expect(sent).toMatchObject({ ok: true, warnings: [expect.stringContaining('more than the largest bid change 10 % (ads strategy: TEST-W15-P2 (IT), product, v1')] })
    expect(await bid()).toBe(70)
    expect((await actionLog(sent.actionLogId!)).evidence).toMatchObject({
      sentPastOwnLimits: expect.stringContaining('ads strategy: TEST-W15-P2 (IT), product, v1'),
      strategyWarning: expect.stringContaining('sent, because it is your own edit'),
    })
  })
})

describe('restore after a stop: never a silent stop', () => {
  it('goes back to min(remembered, the strategy\'s highest bid), says so in the reason and the run line', async () => {
    const holds = newHoldLog()
    const n = await inA(() => restoreCampaignBids(ids['c-rest'], { actor: 'automation:rank-defend-test', reason: 'test restore', holds }))
    expect(n).toBe(2)
    const t = await inA(() => db().adTarget.findUniqueOrThrow({ where: { id: ids['t-rest'] }, select: { bidCents: true, suppressedFromBidCents: true } }))
    expect(t).toEqual({ bidCents: 80, suppressedFromBidCents: null })
    // The ad group's remembered 70¢ is inside the band: back exactly.
    expect(await inA(() => db().adGroup.findUniqueOrThrow({ where: { id: ids['g-rest'] }, select: { defaultBidCents: true } }))).toEqual({ defaultBidCents: 70 })
    expect(await inA(() => db().campaign.findUniqueOrThrow({ where: { id: ids['c-rest'] }, select: { bidsSuppressedAt: true } }))).toEqual({ bidsSuppressedAt: null })
    const history = await inA(() => db().campaignBidHistory.findFirstOrThrow({ where: { entityId: ids['t-rest'] }, orderBy: { changedAt: 'desc' }, select: { reason: true } }))
    expect(history.reason).toBe('test restore — put back at 80¢, not the remembered 120¢: the highest bid (ads strategy: Test leaf (IT), category, v1)')
    expect(holdNote(holds)).toBe(' held=1 (1× restore: put back at the highest bid, not the remembered bid — ads strategy: Test leaf (IT), category, v1)')
  })

  it("the campaign's own highest bid too (it refused the restore before: the bid stayed at 2¢)", async () => {
    await inA(() => restoreCampaignBids(ids['c-restde'], { actor: 'automation:rank-defend-test', reason: 'test restore' }))
    expect(await inA(() => db().adTarget.findUniqueOrThrow({ where: { id: ids['t-restde'] }, select: { bidCents: true } }))).toEqual({ bidCents: 100 })
  })

  it("a person's Restore is held the same way: it puts back what was, inside the limits in force", async () => {
    await inA(async () => {
      await db().campaign.update({ where: { id: ids['c-rest'] }, data: { bidsSuppressedAt: new Date() } })
      await db().adTarget.update({ where: { id: ids['t-rest'] }, data: { bidCents: 2, suppressedFromBidCents: 120 } })
    })
    expect(await inA(() => restoreCampaignBids(ids['c-rest'], { actor: 'user:test-person', manual: true, reason: 'person restore' }))).toBe(1)
    expect(await inA(() => db().adTarget.findUniqueOrThrow({ where: { id: ids['t-rest'] }, select: { bidCents: true, suppressedFromBidCents: true } }))).toEqual({ bidCents: 80, suppressedFromBidCents: null })
  })
})

describe('the hourly base-bid directive', () => {
  it('a +50 % base bid is held at the highest bid, named in the reason and the hold log', async () => {
    const holds = newHoldLog()
    await inA(() => db().campaign.update({ where: { id: ids['c-delta'] }, data: { dynamicBidding: {} } }))
    await inA(() => applyBaseBidDelta(ids['c-delta'], 50, { actor: 'automation:rank-defend-test', holds }))
    // Ad group 60¢ → 90¢ → held at 80¢; the keyword (54¢ after the test above) → 81¢ → held at 80¢.
    expect(await inA(() => db().adGroup.findUniqueOrThrow({ where: { id: ids['g-delta'] }, select: { defaultBidCents: true } }))).toEqual({ defaultBidCents: 80 })
    expect(await inA(() => db().adTarget.findUniqueOrThrow({ where: { id: ids['t-delta'] }, select: { bidCents: true } }))).toEqual({ bidCents: 80 })
    expect(holds.holds.map((h) => [h.kind, h.side, h.writtenCents])).toEqual([['base', 'max', 80], ['base', 'max', 80]])
    expect(holdNote(holds)).toBe(' held=2 (2× base: at the highest bid — ads strategy: Test leaf (IT), category, v1)')
  })
})

describe('bid_apply rules: the same chain and band', () => {
  const run = (action: Record<string, unknown>, dryRun = true) => inA(() => ACTION_HANDLERS.bid_apply!({ type: 'bid_apply', ...action } as never, {}, { dryRun, ruleId: 'rule-test' } as never))
  beforeAll(async () => {
    // 10 clicks, €6.00 spend, €12.00 sales over the rule's window: CPC 60¢, ACoS 50 %.
    const day = new Date(Date.now() - 15 * 86_400_000)
    await inA(async () => {
      for (const key of ['own', 'strat']) {
        await db().amazonAdsDailyPerformance.create({ data: {
          profileId: 'P-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: day, entityType: 'AD_TARGET', entityId: `EXT-T-${key}`,
          localEntityId: ids[`t-${key}`], clicks: 10, costMicros: 6_000_000n, currencyCode: 'EUR', sales7dCents: 1200, reportedAt: new Date(),
        } })
      }
    })
  })

  it("target ACoS: the rule's own, else the campaign's, else the strategy's", async () => {
    // Own 30 %: 60¢ × 0.6 = 36¢. None: campaign 40 % → 48¢; strategy 20 % → 24¢.
    expect(await run({ adTargetId: ids['t-strat'], op: 'targetAcos', value: 30, windowDays: 30 })).toMatchObject({ ok: true, output: { wouldChange: '42¢ → 36¢' } })
    expect(await run({ adTargetId: ids['t-own'], op: 'targetAcos', windowDays: 30 })).toMatchObject({ ok: true, output: { wouldChange: '60¢ → 48¢' } })
    expect(await run({ adTargetId: ids['t-strat'], op: 'targetAcos', windowDays: 30 })).toMatchObject({ ok: true, output: { wouldChange: '42¢ → 24¢' } })
  })

  it("the band: the strategy's highest bid holds a rule's raise and is named; a rule's own lower ceiling stays its own", async () => {
    // t-mix is at 70¢ (a person's edit above): set €2.00 → held to 50¢.
    expect(await run({ adTargetId: ids['t-mix'], op: 'set', value: 2, maxEur: 1.5 })).toMatchObject({
      ok: true, output: { wouldChange: '70¢ → 50¢', heldTo: 'the highest bid 50¢ (ads strategy: TEST-W15-P2 (IT), product, v1, from TEST-W15-P2)' },
    })
    const own = await run({ adTargetId: ids['t-mix'], op: 'set', value: 2, maxEur: 0.3 })
    expect(own).toMatchObject({ ok: true, output: { wouldChange: '70¢ → 30¢' } })
    expect((own.output as Record<string, unknown>).heldTo).toBeUndefined()
  })

  it('a live write keeps which level supplied the target and the limits; the step clamp still paces it', async () => {
    const out = await run({ adTargetId: ids['t-strat'], op: 'targetAcos', windowDays: 30 }, false)
    expect(out).toMatchObject({ ok: true, output: { newBidCents: 24 } })
    // 42¢ → 24¢ asked; the strategy's 30 % largest change lands it at 29¢.
    expect(await inA(() => db().adTarget.findUniqueOrThrow({ where: { id: ids['t-strat'] }, select: { bidCents: true } }))).toEqual({ bidCents: 29 })
    const log = await inA(() => db().advertisingActionLog.findFirstOrThrow({ where: { entityId: ids['t-strat'], userId: 'automation:rule-test' }, select: { evidence: true } }))
    expect(log.evidence).toEqual({ sources: {
      targetAcosPct: source('category', 'Test leaf (IT)', 20),
      minBidCents: source('market', 'Test market (IT)', 10),
      maxBidCents: source('category', 'Test leaf (IT)', 80),
      maxChangePct: source('market', 'Test market (IT)', 30),
    } })
  })
})

describe('pure: the clamps', () => {
  const lim = (v: number) => ({ value: v, source: { level: 'market' as const, strategyId: 's', scopeId: '*', label: 'Test (IT)', version: 1 } })

  it('the highest bid always binds; the lowest bid binds every write but a forced lowering; crossing sides: the highest wins', () => {
    const band = { ...NO_LIMITS, minBidCents: lim(20), maxBidCents: lim(80) }
    expect(clampToStrategy(90, band)).toMatchObject({ cents: 80, held: { side: 'max' } })
    expect(clampToStrategy(10, band, { currentCents: 30 })).toMatchObject({ cents: 20, held: { side: 'min' } })
    expect(clampToStrategy(2, band, { currentCents: 30, forced: true })).toEqual({ cents: 2, held: null })
    expect(clampToStrategy(10, band, { currentCents: 5, forced: true })).toMatchObject({ cents: 20 }) // a forced RAISE is bound
    expect(clampBid(10, { max: { value: 15 }, min: { value: 30 } })).toEqual({ cents: 10, held: null })
    expect(clampBid(40, { max: { value: 15 }, min: { value: 30 } })).toMatchObject({ cents: 15, held: { side: 'max' } })
  })

  it('stepClamp: the lower largest change, its owner, and the band edge over the step', () => {
    const strategy = { ...NO_LIMITS, maxChangePct: lim(20), maxBidCents: lim(50) }
    expect(stepClamp(100, 50, { maxBidChangePct: 40 }, { ...NO_LIMITS, maxChangePct: lim(20) })).toEqual({ cents: 80, pct: 20, by: 'strategy', bandHeld: null })
    expect(stepClamp(100, 150, { maxBidChangePct: 10 }, { ...NO_LIMITS, maxChangePct: lim(20) })).toMatchObject({ cents: 110, pct: 10, by: 'campaign' })
    expect(stepClamp(100, 150, null, NO_LIMITS)).toEqual({ cents: 150, pct: null, by: null, bandHeld: null })
    // Inside the band asked for: the step stops at 80, the band edge wins.
    expect(stepClamp(100, 50, null, strategy)).toMatchObject({ cents: 50 })
    expect(stepClamp(200, 50, null, strategy)).toMatchObject({ cents: 50, bandHeld: { side: 'max' } })
    // Asked for OUTSIDE the band: not moved into it (the gate refuses it).
    expect(stepClamp(100, 70, null, strategy)).toMatchObject({ cents: 80, bandHeld: null })
  })

  it("autopilot: the plan's bid band and ramp narrowed by the strategy; budgets keep the plan's ramp", () => {
    const g = { ...DEFAULT_GUARDRAILS, bidMinCents: 5, bidMaxCents: 300, rampPct: 25 }
    expect(bidGuardrails(g, undefined)).toBe(g)
    expect(bidGuardrails(g, { ...NO_LIMITS, minBidCents: lim(20), maxBidCents: lim(80), maxChangePct: lim(10) })).toMatchObject({ bidMinCents: 20, bidMaxCents: 80, rampPct: 10 })
    expect(bidGuardrails(g, { ...NO_LIMITS, minBidCents: lim(400) })).toMatchObject({ bidMinCents: 300, bidMaxCents: 300 })
  })
})

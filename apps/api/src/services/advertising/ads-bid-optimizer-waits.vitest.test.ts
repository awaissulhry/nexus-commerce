/**
 * Bid optimiser review 2026-10-08 — the two live defects, through the real reads (PGlite with the production schema, the
 * `daily` source auto-bid runs on). Made-up values only; the shapes are the review's.
 *
 * A — the goal is a CPC and Amazon charges less than the bid. On 2026-10-07/08 auto-bid cut a product-substitutes target
 *     of "normal slider auto" 58 → 44 → 33¢ toward a 34¢ CPC goal; at r̂ 0.62 the bid that buys that CPC is about 55¢.
 * B — the window's edge moves one day at 00:00 UTC; on sparse data that moved one goal across the bid and the target went
 *     8 → 10 → 8¢ in 6 hours. Now a move against its own last move waits 3 data days, and a target moves once a data day.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { seedAdsFixture } from '../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../../lib/queue.js', () => {
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

const { previewBidOptimization, currentDataDay } = await import('./ads-bid-optimizer.service.js')
const { AUTO_BID_OPTIMIZER_OPTIONS } = await import('./ads-auto-bid.service.js')
const { ACTION_HANDLERS } = await import('../automation-rule.service.js')
await import('./automation-action-handlers.js')
const { setBidAutomation } = await import('./campaign-settings.service.js')
const { settledBounds } = await import('./ads-settled-window.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client as any
const DAY = 86_400_000
const before = (n: number) => new Date(settledBounds(30).until.getTime() - n * DAY)
/** The data day `n` days before today's (the window's newest day then). */
const dataDayAgo = (n: number) => currentDataDay(new Date(Date.now() - n * DAY))

/** A keyword in c-it's ad group whose settled days are written as the daily report writes them. */
async function keyword(id: string, bidCents: number, days: Array<{ ago: number; clicks: number; costCents: number; salesCents?: number; orders?: number }>) {
  await inside(() => db().adTarget.create({ data: { id, adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `test ${id}`, bidCents, externalTargetId: `EXT-${id}` } }))
  for (const d of days) {
    await inside(() => db().amazonAdsDailyPerformance.create({
      data: {
        profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: before(d.ago), entityType: 'AD_TARGET',
        entityId: `EXT-${id}`, localEntityId: id, currencyCode: 'EUR', reportedAt: new Date(),
        clicks: d.clicks, impressions: d.clicks * 30, costMicros: BigInt(d.costCents * 10_000), sales7dCents: d.salesCents ?? 0, orders7d: d.orders ?? 0,
      },
    }))
  }
}
/** A bid write as the mutation path leaves it: its bid history row and its action log row (with the evidence it carried). */
async function wrote(id: string, from: number, to: number, when: Date, by: string, evidence: Record<string, unknown> | null = null) {
  await inside(() => db().campaignBidHistory.create({ data: { entityType: 'AD_TARGET', entityId: id, campaignId: 'c-it', field: 'bid', oldValue: String(from), newValue: String(to), changedAt: when, changedBy: by } }))
  await inside(() => db().advertisingActionLog.create({
    data: { userId: by, actionType: 'AD_BID_UPDATE', entityType: 'AD_TARGET', entityId: id, payloadBefore: { bidCents: from }, payloadAfter: { bidCents: to }, createdAt: when, ...(evidence ? { evidence } : {}) },
  }))
  await inside(() => db().adTarget.update({ where: { id }, data: { bidCents: to } }))
}
const run = (opts: Parameters<typeof previewBidOptimization>[0]) => inside(() => previewBidOptimization({ source: 'daily', ...opts }))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(() => seedAdsFixture(database.client))
  // The IT market target the review's targets steered to: 35 % (here the campaign's own target ACoS).
  await inside(() => setBidAutomation('c-it', { targetAcos: 0.35 }))
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)
beforeEach(async () => {
  await inside(() => db().advertisingActionLog.deleteMany({}))
  await inside(() => db().campaignBidHistory.deleteMany({}))
})

describe('A — the goal CPC is bought by the bid CPC ÷ r̂', () => {
  it('product substitutes (CR 3.94 %, AOV €24.71, r̂ 0.62, aim 35 %) at 44¢ is raised toward 55¢, not cut toward 33¢', async () => {
    // 254 clicks over the window at a 44¢ bid that paid 62 % of it (27.28¢ a click); 10 orders of €24.71.
    await keyword('k-subst', 44, [
      { ago: 3, clicks: 127, costCents: 3465, salesCents: 12355, orders: 5 },
      { ago: 15, clicks: 127, costCents: 3464, salesCents: 12355, orders: 5 },
    ])
    const p = (await run(AUTO_BID_OPTIMIZER_OPTIONS)).proposals.find((x) => x.targetId === 'k-subst')!
    // The CPC the 35 % aim affords is 0.35 × 3.94 % × €24.71 ≈ 34¢ — the old goal BID, a cut 44 → 34¢. As a bid: ÷ 0.62 ≈ 55¢.
    expect(p.proposedBidCents).toBeGreaterThan(44)
    expect(p).toMatchObject({ currentBidCents: 44, proposedBidCents: 55, targetSource: 'campaign', dataDay: currentDataDay() })
    expect(p.reason).toMatch(/raise toward 55¢ \(Bayesian CR 3\.9% · \d+% data-confidence · r̂ 0\.62 \(paid CPC ÷ bid: its own, 254 clicks\)\)$/)
  })

  it("r̂ is measured against the bids that served the window, not today's bid", async () => {
    // 20 days at 50¢ paying 30¢ (r̂ 0.6), then cut to 25¢ — today's 25¢ would read the same CPC as r̂ 1.0.
    await keyword('k-served', 25, [
      { ago: 20, clicks: 100, costCents: 3000, salesCents: 30000, orders: 6 },
    ])
    await wrote('k-served', 50, 25, new Date(Date.now() - 2 * DAY), 'user:someone')
    const p = (await run({ targetAcos: 0.3 })).proposals.find((x) => x.targetId === 'k-served')!
    // €3.00 a click at 30 % affords a 90¢ CPC; at r̂ 0.6 the bid is 150¢ — one +25 % step from 25¢ is 31¢.
    expect(p).toMatchObject({ currentBidCents: 25, proposedBidCents: 31 })
    expect(p.reason).toContain('toward 150¢')
    expect(p.reason).toContain('r̂ 0.60 (paid CPC ÷ bid: its own, 100 clicks, at the bids that served them)')
  })
})

describe('B — a move waits for evidence', () => {
  // 35 clicks for €2.80 (8¢ a click), one €7.70 order: at 35 % it may pay 7.7¢ a click — the window after an order left
  // it. Bought at 8¢ (r̂ 1.0), the goal bid is 7.7¢, and a step lands on 8¢.
  const sparse = (id: string, bid: number) => keyword(id, bid, [{ ago: 4, clicks: 20, costCents: 160, salesCents: 770, orders: 1 }, { ago: 12, clicks: 15, costCents: 120 }])

  it('8 → 10¢ on yesterday\'s data day, then 10 → 8¢ when the window moves: the reversal waits (the review\'s flip)', async () => {
    await sparse('k-flip', 8)
    await wrote('k-flip', 8, 10, new Date(Date.now() - DAY), 'automation:auto-bid', { dataDay: dataDayAgo(1) })
    const out = await run({})
    expect(out.proposals.find((x) => x.targetId === 'k-flip')).toBeUndefined()
    expect(out.waiting.find((x) => x.targetId === 'k-flip')).toMatchObject({
      currentBidCents: 10, wouldBeCents: 8,
      why: `would reverse its own raise 8 → 10¢ of data day ${dataDayAgo(1)} — a reversal waits 3 data days (2 to go)`,
    })
  })

  it('three data days on, the same evidence still says 8¢: the cut goes ahead', async () => {
    await wrote('k-flip', 8, 10, new Date(Date.now() - 3 * DAY), 'automation:auto-bid', { dataDay: dataDayAgo(3) })
    const p = (await run({})).proposals.find((x) => x.targetId === 'k-flip')
    expect(p).toMatchObject({ currentBidCents: 10, proposedBidCents: 8, dataDay: currentDataDay() })
  })

  it('once a data day: a rule moved the bid on this data day, so the optimiser leaves it until the next', async () => {
    await sparse('k-today', 14)
    await wrote('k-today', 12, 14, new Date(), 'automation:rule-cut')
    // Without the wait: 7.7¢ a click bought at r̂ 0.67 (it paid 8¢ at the 12¢ that served the window) — a cut to 12¢.
    const out = await run({})
    expect(out.proposals.find((x) => x.targetId === 'k-today')).toBeUndefined()
    expect(out.waiting.find((x) => x.targetId === 'k-today')?.why).toBe(`already moved on data day ${currentDataDay()} (12 → 14¢ by automation:rule-cut) — one move per data day`)
  })

  it("a person's own bid today, or a rule's move yesterday, does not hold the next data day's move", async () => {
    await sparse('k-free', 14)
    await wrote('k-free', 12, 13, new Date(Date.now() - DAY), 'automation:rule-cut')
    await wrote('k-free', 13, 14, new Date(), 'user:owner')
    const p = (await run({})).proposals.find((x) => x.targetId === 'k-free')
    expect(p).toMatchObject({ currentBidCents: 14, proposedBidCents: 12 })
  })

  it('a move in the same direction as its own last one goes on the next data day', async () => {
    await sparse('k-on', 16)
    await wrote('k-on', 20, 16, new Date(Date.now() - DAY), 'automation:auto-bid', { dataDay: dataDayAgo(1) })
    // It paid 8¢ at the 20¢ that served the window (r̂ 0.4, held to 0.6): the goal is 12.8¢, a further cut.
    expect((await run({})).proposals.find((x) => x.targetId === 'k-on')).toMatchObject({ currentBidCents: 16, proposedBidCents: 13 })
  })

  it('a rolled-back move is no move', async () => {
    await sparse('k-undone', 10)
    await wrote('k-undone', 8, 10, new Date(Date.now() - DAY), 'automation:auto-bid', { dataDay: dataDayAgo(1) })
    await inside(() => db().advertisingActionLog.updateMany({ where: { entityId: 'k-undone' }, data: { rolledBackAt: new Date() } }))
    expect((await run({})).proposals.find((x) => x.targetId === 'k-undone')).toMatchObject({ currentBidCents: 10, proposedBidCents: 8 })
  })

  it('the bid_to_target_acos rule says how many moves wait', async () => {
    await sparse('k-rule', 10)
    await wrote('k-rule', 8, 10, new Date(Date.now() - DAY), 'automation:auto-bid', { dataDay: dataDayAgo(1) })
    // A rule reads the source auto-bid runs on in production (NEXUS_BID_OPTIMIZER_SOURCE=daily).
    process.env.NEXUS_BID_OPTIMIZER_SOURCE = 'daily'
    const r = await inside(() => ACTION_HANDLERS.bid_to_target_acos({ type: 'bid_to_target_acos', campaignId: 'c-it' }, {} as never, { dryRun: true, ruleId: 'r-test' } as never))
      .finally(() => { delete process.env.NEXUS_BID_OPTIMIZER_SOURCE })
    expect(r.ok).toBe(true)
    expect(r.output).toMatchObject({ waiting: expect.any(Number), waitingSample: expect.arrayContaining([expect.objectContaining({ targetId: 'k-rule' })]) })
  })
})

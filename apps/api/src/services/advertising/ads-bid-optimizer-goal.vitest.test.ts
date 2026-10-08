/**
 * C3 (2026-10-07) — a bid steered by window evidence converges to a goal; it does not fall to the floor.
 *
 * Before: every proposal was `current bid × target / ACoS` on a 30-day window that barely moves between two runs, so
 * each run multiplied the bid the last run had left by the same ratio again — on 2026-10-07 one target went
 * 33 → 25 → 19 → 14¢ in 6 hours (two runs 7 minutes apart). Now the evidence sets a goal (target × sales per click;
 * Bayesian: target × shrunk CR × AOV), a run moves toward it by one step at most and never past it, and a bid within
 * the dead zone of it proposes nothing. The zero-sales cut has no goal, so it waits for clicks at the bid it would cut.
 *
 * Review 2026-10-08 — the goal is a CPC, bought by the bid CPC ÷ r̂ (paid CPC ÷ the bid that served the window), and the
 * dead zone is 10 % or 2¢. The once-a-data-day and no-quick-reversal waits read the action log, which these runs do not
 * write: each run here stands for the next data day on the same evidence (ads-bid-optimizer-waits covers the waits).
 *
 * PGlite with the production schema; each "run" applies its own proposal to the stored bid and leaves its bid history
 * row, as auto-bid's write does. Made-up values only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { seedAdsFixture } from '../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { GOAL_MIN_MOVE_CENTS, GOAL_TOLERANCE, stepTowardGoal, withinGoal } from './ads-bid-goal.js'

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

const { previewBidOptimization } = await import('./ads-bid-optimizer.service.js')
const { settledBounds } = await import('./ads-settled-window.js')
const { ACTION_HANDLERS } = await import('../automation-rule.service.js')
await import('./automation-action-handlers.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client as any
type Opts = Parameters<typeof previewBidOptimization>[0]
const DAY = 86_400_000
/** The settled window's newest day (Sponsored Products), and a day `n` days before it. */
const until = () => settledBounds(30).until
const before = (n: number) => new Date(until().getTime() - n * DAY)

/** A keyword in c-it's ad group with the given 30-day evidence on its AdTarget columns (the `legacy` source). */
const keyword = (id: string, bidCents: number, m: { clicks: number; spendCents: number; salesCents?: number; ordersCount?: number }) =>
  inside(() => db().adTarget.create({
    data: { id, adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `test ${id}`, bidCents, externalTargetId: `EXT-${id}`, salesCents: 0, ordersCount: 0, ...m },
  }))
const bidOf = async (id: string) => (await inside(() => db().adTarget.findUniqueOrThrow({ where: { id } }))).bidCents as number
const proposalFor = async (id: string, opts: Opts) => (await inside(() => previewBidOptimization(opts))).proposals.find((p) => p.targetId === id)

/** Runs until the target proposes nothing (at most 10 runs), applying each proposal; the bids it set, in order. */
async function runUntilQuiet(id: string, opts: Opts): Promise<{ bids: number[]; reasons: string[] }> {
  const bids: number[] = []
  const reasons: string[] = []
  for (let i = 0; i < 10; i++) {
    const p = await proposalFor(id, opts)
    if (!p) return { bids, reasons }
    bids.push(p.proposedBidCents)
    reasons.push(p.reason)
    await inside(() => db().adTarget.update({ where: { id }, data: { bidCents: p.proposedBidCents } }))
    // The bid history row every write leaves: today's move served none of the settled window's clicks, so r̂ keeps
    // dividing the window's CPC by the bid that served it, not by the bid the run just set.
    await inside(() => db().campaignBidHistory.create({
      data: { entityType: 'AD_TARGET', entityId: id, campaignId: 'c-it', field: 'bid', oldValue: String(p.currentBidCents), newValue: String(p.proposedBidCents), changedAt: new Date(), changedBy: 'automation:auto-bid' },
    }))
  }
  throw new Error(`${id} still proposing after 10 runs: ${bids.join(' → ')}`)
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(() => seedAdsFixture(database.client))
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)

describe('stepTowardGoal — one step toward the goal, never past it', () => {
  const step = { down: 0.5, up: 0.25 }
  it('lowers by one step at most, and lands ON the goal when a step reaches it', () => {
    expect(stepTowardGoal(33, 12, step)).toBe(17) // 33 × 0.5 = 16.5: one step short of 12
    expect(stepTowardGoal(17, 12, step)).toBe(12) // a full step would be 8.5: stops at the goal
  })
  it('raises by one step at most, never past the goal', () => {
    expect(stepTowardGoal(10, 40, step)).toBe(13)
    expect(stepTowardGoal(35, 40, step)).toBe(40)
  })
  it(`within ${GOAL_TOLERANCE * 100} % of the goal: nothing`, () => {
    expect(GOAL_TOLERANCE).toBe(0.1)
    expect(stepTowardGoal(12, 12, step)).toBeNull()
    expect(stepTowardGoal(44, 40, step)).toBeNull()
    expect(stepTowardGoal(36, 40, step)).toBeNull()
    expect(stepTowardGoal(45, 40, step)).toBe(40)
    expect(withinGoal(10, 0)).toBe(true) // no goal: nothing to move toward
  })
  it(`less than ${GOAL_MIN_MOVE_CENTS}¢ from the goal: nothing, whatever the share (an 8¢ bid and a 9.5¢ goal)`, () => {
    expect(stepTowardGoal(8, 9.5, step)).toBeNull()
    expect(stepTowardGoal(10, 8.5, step)).toBeNull()
    expect(stepTowardGoal(8, 10, step)).toBe(10)
  })
  it('never under the floor', () => {
    expect(stepTowardGoal(8, 2, step)).toBe(5)
    expect(stepTowardGoal(5, 2, step)).toBe(5) // equal to the bid: the optimiser drops it
  })
})

describe('the flat path — the same evidence moves the bid to one goal and stops there', () => {
  it('33¢ at 50 % ACoS toward a 20 % target: 17¢, then the 13¢ goal, then nothing (before: 17 → 8 → 5¢, the floor)', async () => {
    // 100 clicks, €30 spent, €60 sales: ACoS 50 %, €0.60 sales a click → the 20 % goal is a 12¢ CPC (= 30¢ × 20/50). It
    // paid 30¢ a click at a 33¢ bid (r̂ 0.91), so the bid that buys a 12¢ CPC is 13¢.
    await keyword('k-slide', 33, { clicks: 100, spendCents: 3000, salesCents: 6000, ordersCount: 2 })
    const out = await runUntilQuiet('k-slide', { targetAcos: 0.2 })
    expect(out.bids).toEqual([17, 13])
    expect(out.reasons[1]).toBe('ACOS 50% > target 20% (the target asked for) — lower toward 13¢ (20% of €0.60 sales a click ÷ r̂ 0.91 (paid CPC ÷ bid: its own, 100 clicks, bids weighted by time — no daily clicks))')
    // The same evidence once more: nothing (the old ratio would have cut 13 → 5¢).
    expect(await proposalFor('k-slide', { targetAcos: 0.2 })).toBeUndefined()
    expect(await bidOf('k-slide')).toBe(13)
  })

  it('a bid already cut below its goal is raised back to it, one step at a time, and stops there', async () => {
    // The same evidence, but the bid already slid to 6¢: the goal is still 12¢.
    await keyword('k-raise', 6, { clicks: 100, spendCents: 3000, salesCents: 6000, ordersCount: 2 })
    const out = await runUntilQuiet('k-raise', { targetAcos: 0.2 })
    expect(out.bids).toEqual([8, 10, 12])
    // It paid 30¢ a click at a 6¢ bid (dynamic bidding, placements): r̂ is held to 1.0, never above the bid.
    expect(out.reasons[0]).toBe('ACOS 50% > target 20% (the target asked for) — raise toward 12¢ (20% of €0.60 sales a click ÷ r̂ 1.00 (paid CPC ÷ bid: its own, 100 clicks))')
  })

  it('ACoS under target: raised toward its goal and no further (before: +25 % every run, up to the highest bid)', async () => {
    // €2.00 sales a click at a 30 % target: it may pay 60¢ a click. It paid 20¢ at a 40¢ bid (r̂ 0.5, held to 0.6), so the
    // bid that buys a 60¢ CPC is 100¢; the raise stops within 2¢ of it.
    await keyword('k-good', 40, { clicks: 50, spendCents: 1000, salesCents: 10000, ordersCount: 4 })
    const out = await runUntilQuiet('k-good', { targetAcos: 0.3 })
    expect(out.bids).toEqual([50, 63, 79, 99])
    expect(out.reasons.every((r) => r.includes('raise toward 100¢') && r.includes('r̂ 0.60'))).toBe(true)
  })
})

describe('the Bayesian path — the expected-ACoS goal, the same way', () => {
  it('converges to one goal on the same evidence and never passes it', async () => {
    // 40 clicks, 2 orders of €80, CPC €1.00: the expected ACoS sits above 20 %, and the goal is the bid where it is 20 %.
    await keyword('k-bayes', 200, { clicks: 40, spendCents: 4000, salesCents: 16000, ordersCount: 2 })
    const out = await runUntilQuiet('k-bayes', { targetAcos: 0.2, bayesian: true })
    const goal = Number(/toward (\d+)¢/.exec(out.reasons[0])![1])
    expect(goal).toBeGreaterThan(5)
    // Every run moves toward the SAME goal, each bid lower than the last, the last one on it — not past it.
    expect(out.reasons.every((r) => r.includes(`toward ${goal}¢ (Bayesian CR`))).toBe(true)
    for (let i = 1; i < out.bids.length; i++) expect(out.bids[i]).toBeLessThan(out.bids[i - 1])
    expect(out.bids.at(-1)).toBe(goal)
    expect(out.bids.length).toBeLessThanOrEqual(3)
    expect(await proposalFor('k-bayes', { targetAcos: 0.2, bayesian: true })).toBeUndefined()
  })
})

describe('the zero-sales cut — once per evidence at the bid it cuts', () => {
  /** Settled days with clicks and no sale (the `daily` source), `ago` days before the window's newest day. */
  const day = (id: string, ago: number, clicks: number) => inside(() => db().amazonAdsDailyPerformance.create({
    data: {
      profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: before(ago), entityType: 'AD_TARGET',
      entityId: `EXT-${id}`, localEntityId: id, currencyCode: 'EUR', reportedAt: new Date(),
      clicks, impressions: clicks * 30, costMicros: BigInt(clicks * 40 * 10_000), sales7dCents: 0, orders7d: 0,
    },
  }))
  const moved = (id: string, from: number, to: number, at: Date) => inside(() => db().campaignBidHistory.create({
    data: { entityType: 'AD_TARGET', entityId: id, campaignId: 'c-it', field: 'bid', oldValue: String(from), newValue: String(to), changedAt: at, changedBy: 'automation:auto-bid' },
  }))
  const daily = { targetAcos: 0.2, source: 'daily' } as const

  it('cuts once; the same evidence again cuts nothing; clicks at the cut bid cut again', async () => {
    await inside(() => db().adTarget.create({ data: { id: 'k-zero', adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'test zero', bidCents: 40, externalTargetId: 'EXT-k-zero' } }))
    await day('k-zero', 20, 4)
    await day('k-zero', 10, 4)
    await day('k-zero', 2, 4)
    // Run 1: 12 clicks, no sale, the bid never moved — cut 50 %.
    const first = await proposalFor('k-zero', daily)
    expect(first).toMatchObject({ currentBidCents: 40, proposedBidCents: 20, reason: '12 clicks, 0 sales — cut 50%' })
    // The cut is written (its bid history row, as every write leaves one).
    await inside(() => db().adTarget.update({ where: { id: 'k-zero' }, data: { bidCents: 20 } }))
    await moved('k-zero', 40, 20, new Date())
    // Run 2, on the same settled days: no click at 20¢ yet, so no second cut (before: 20 → 10 → 5¢ in 12 hours).
    expect(await proposalFor('k-zero', daily)).toBeUndefined()
  })

  it('a cut 15 days before the window ends has 8 clicks at its bid since: one more cut; 5 days before, 4 clicks: none', async () => {
    await inside(() => db().campaignBidHistory.updateMany({ where: { entityId: 'k-zero' }, data: { changedAt: before(15) } }))
    expect(await proposalFor('k-zero', daily)).toMatchObject({ currentBidCents: 20, proposedBidCents: 10, reason: '8 clicks at this bid (12 in the window), 0 sales — cut 50%' })
    await inside(() => db().campaignBidHistory.updateMany({ where: { entityId: 'k-zero' }, data: { changedAt: before(5) } }))
    expect(await proposalFor('k-zero', daily)).toBeUndefined()
  })

  it('a suppression floor and its restore are not a move of the serving bid', async () => {
    await inside(() => db().campaignBidHistory.updateMany({ where: { entityId: 'k-zero' }, data: { changedAt: before(15) } }))
    // Floored to 2¢ for a Min-bid hour and given back since: the bid that serves is still the 20¢ of 15 days before.
    await moved('k-zero', 20, 2, new Date(Date.now() - 3_600_000))
    await moved('k-zero', 2, 20, new Date())
    expect(await proposalFor('k-zero', daily)).toMatchObject({ proposedBidCents: 10 })
  })
})

describe('the `curBidTargetAcos` rule op — the current bid by the ratio, never past the goal', () => {
  it('steps toward CPC × target / ACoS and then holds, on the same evidence', async () => {
    // 10 clicks for €3.00 (CPC 30¢) and €6.00 of sales: ACoS 50 %. At a 20 % target the goal is 12¢.
    await inside(() => db().adTarget.create({ data: { id: 'k-rule', adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'test rule', bidCents: 33, externalTargetId: 'EXT-k-rule' } }))
    await inside(() => db().amazonAdsDailyPerformance.create({
      data: {
        profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: before(3), entityType: 'AD_TARGET', entityId: 'EXT-k-rule', localEntityId: 'k-rule',
        currencyCode: 'EUR', reportedAt: new Date(), clicks: 10, impressions: 300, costMicros: 3_000_000n, sales7dCents: 600, orders7d: 1,
      },
    }))
    const fire = async () => {
      const r = await inside(() => ACTION_HANDLERS.bid_apply({ type: 'bid_apply', op: 'curBidTargetAcos', value: 20 }, { adTarget: { id: 'k-rule' }, trigger: 'SCHEDULE' } as never, { dryRun: true, ruleId: 'r-test' } as never))
      const [from, to] = String((r.output as { wouldChange: string }).wouldChange).split(' → ').map((x) => parseInt(x, 10))
      await inside(() => db().adTarget.update({ where: { id: 'k-rule' }, data: { bidCents: to } }))
      return { from, to }
    }
    // 33¢ × 20/50 = 13¢ (above the 12¢ goal), then it holds: 1¢ from the goal is inside the dead zone (2¢) — before
    // the goal: 13 → 5 → 5¢ (the floor).
    expect(await fire()).toEqual({ from: 33, to: 13 })
    expect(await fire()).toEqual({ from: 13, to: 13 })
  })
})

/**
 * Auto-bid, Owner targets only (Owner decision 2026-10-06, A) — on a real PostgreSQL (PGlite, production schema).
 *
 * Before: auto-bid moved every bid the optimiser proposed, in every market, toward whatever target the resolver gave —
 * a profit-derived or flat 30 % one the Owner never chose included — and nothing skipped a bid another owner holds, so
 * auto-bid and an hourly bid plan could undo each other every run. Proven here, through the real reads:
 *   · a bid moves only toward a target he set (campaign, ads strategy, account default); profit and flat are left alone;
 *   · a bid an hourly plan, a product plan, a running autopilot plan or a pin holds is left alone, counted per reason;
 *     a campaign whose only "owner" is its own target ACoS (the Bid page's "Goal") is moved toward it;
 *   · a bid a person set (his own edit, or a Claude request he approved) is left alone per keyword, on any campaign —
 *     its own-target campaign included — while the campaign's other keywords move; an engine's write is not a person's;
 *   · the A4 preview is the run: the same bids, the same counts;
 *   · the run's summary line, its notification and the A4 catalog entry say the rule and the counts in words.
 * The optimiser's maths, the dial, the guard and the holders' reads are the real ones; profit data is a stand-in, the
 * bid write is a recorder (nothing leaves the process). Made-up values only.
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
// Profit data is a stand-in: which target it answers for is what is under test.
const profit = vi.hoisted(() => ({ byAdGroup: {} as Record<string, number> }))
vi.mock('./ads-target-acos.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  computeAdGroupTargetAcos: async (adGroupId: string) => ({ targetAcos: profit.byAdGroup[adGroupId] ?? null, products: 1 }),
}))
// The bid write is a recorder: what auto-bid hands it is what is under test.
const writes = vi.hoisted(() => ({ entries: [] as Array<{ adTargetId: string; bidCents: number }> }))
vi.mock('./ads-mutation.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  bulkUpdateAdTargetBids: async (args: { entries: Array<{ adTargetId: string; bidCents: number }> }) => {
    writes.entries.push(...args.entries)
    return { applied: args.entries.length, skipped: 0, failed: 0, chunks: 1, outcomes: args.entries.map((_e, i) => ({ actionLogId: `log-${i}` })) }
  },
}))
const notices = vi.hoisted(() => ({ sent: [] as Array<{ title: string; body: string }> }))
vi.mock('./ads-automation-notify.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  notifyAutomation: async (n: { title: string; body: string }) => { notices.sent.push(n); return 1 },
}))

const { runAutoBidOnce, autoBidSummaryLine, ownerMoves, AUTO_BID_SCOPE_WORDS } = await import('./ads-auto-bid.service.js')
const { automationAdapter } = await import('../automation/automation-catalog.service.js')
const { previewAutomation } = await import('../automation/automation-preview.service.js')
const { setBidAutomation } = await import('./campaign-settings.service.js')
const { setAutonomy, setDefaultTargetAcosPct } = await import('./ads-automation-state.service.js')
const { claudeActor } = await import('../agents/tools/ads-tool-guards.js')

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client as any

/** Every keyword that spent: 20 clicks, 2 orders, ACoS 50 % (read from the AdTarget columns, the `legacy` source). */
const SPENT = { clicks: 20, spendCents: 1000, salesCents: 2000, ordersCount: 2 }
/** The campaigns beside the fixture's, each with keywords at 50¢, and who holds its bids. */
const HELD = ['c-hourly', 'c-plan', 'c-auto', 'c-person', 'c-goal'] as const
/** The extra keywords: c-person's and c-goal's that no person touched, and c-goal's one a Claude request changed. */
const MORE: Array<[string, string]> = [['t-person2', 'c-person'], ['t-goal2', 'c-goal'], ['t-goal-claude', 'c-goal']]
const bidLog = (entityId: string, userId: string) =>
  db().advertisingActionLog.create({ data: { userId, actionType: 'AD_BID_UPDATE', entityType: 'AD_TARGET', entityId, payloadBefore: { bidCents: 55 }, payloadAfter: { bidCents: 50 } } })

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    for (const key of HELD) {
      await db().campaign.create({
        data: { id: key, name: `Test ${key}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${key}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true },
      })
      await db().adGroup.create({ data: { id: `g-${key}`, campaignId: key, name: `group ${key}`, externalAdGroupId: `EXT-g-${key}` } })
      await db().adTarget.create({ data: { id: `t-${key.slice(2)}`, adGroupId: `g-${key}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `test ${key}`, bidCents: 50, externalTargetId: `EXT-t-${key}`, ...SPENT } })
    }
    for (const [id, key] of MORE) {
      await db().adTarget.create({ data: { id, adGroupId: `g-${key}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `test ${id}`, bidCents: 50, externalTargetId: `EXT-${id}`, ...SPENT } })
    }
    for (const id of ['t-it', 't-uk', 't-pin']) await db().adTarget.update({ where: { id }, data: SPENT })
    // C3 — t-pin's 40¢ is already its goal (40 % of €1.00 sales a click), which proposes nothing: 50¢, so the pin holds a move.
    await db().adTarget.update({ where: { id: 't-pin' }, data: { bidCents: 50 } })
    // An hourly bid plan (an enabled goal-mode schedule) holds c-hourly.
    await db().adSchedule.create({ data: { campaignId: 'c-hourly', name: 'Test hourly plan', windows: [], defaultTargetKey: 'own-top', enabled: true } })
    // A product plan's last run resolved its family to c-plan.
    await db().productRankPlan.create({ data: { productId: 'p-test', marketplace: 'IT', enabled: true, lastSummary: { decisions: [{ campaignId: 'c-plan' }] } } })
    // A running autopilot plan (a goal plan) names c-auto.
    await db().autopilotPlan.create({ data: { name: 'Test goal plan', marketplace: 'IT', campaignIds: ['c-auto'], goal: 'PROFIT', autonomy: 'SUGGEST', enabled: true } })
    // A person changed one bid by hand in c-person, and one in c-goal — which carries its own target ACoS (the Bid page's
    // "Goal"). A Claude request a person approved changed another c-goal bid: it writes as him. An engine changed t-goal2.
    await bidLog('t-person', 'user:u-test')
    await bidLog('t-goal', 'user:u-test')
    await bidLog('t-goal-claude', claudeActor('u-approver'))
    await bidLog('t-goal2', 'automation:auto-bid')
    await setBidAutomation('c-goal', { targetAcos: 0.4 })
  })
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)
beforeEach(async () => {
  delete process.env.NEXUS_BID_OPTIMIZER_SOURCE
  profit.byAdGroup = {}
  writes.entries = []
  notices.sent = []
  await inside(() => setAutonomy('AUTO', 'test'))
  await inside(() => setDefaultTargetAcosPct(40, 'test'))
})

const previewA4 = async () => {
  const out = await inside(() => previewAutomation(automationAdapter('A4')!, {}))
  expect(out.ok).toBe(true)
  return (out as { data: { preview: { proposals: Array<{ targetId: string; proposedBidCents: number; targetSource: string }>; total: number; leftAlone: Record<string, number>; leftAloneNote: string } } }).data.preview
}

describe('Owner targets only — which bids auto-bid moves', () => {
  it('moves only toward a target he set, and leaves every bid another owner holds, counted per reason', async () => {
    const r = await inside(() => runAutoBidOnce())
    // c-it and c-uk toward the account default; c-goal toward its own target. A bid a person set stays, per keyword:
    // t-person and t-goal (his edits) and t-goal-claude (a Claude request he approved); their campaigns' other keywords
    // move — t-goal2 too, which only an engine changed.
    expect(writes.entries.map((e) => e.adTargetId).sort()).toEqual(['t-goal2', 't-it', 't-person2', 't-uk'])
    expect(r).toMatchObject({ proposed: 4, applied: 4, dryRun: false, leftAlone: { noTargetSetByYou: 0, hourlyPlan: 2, goalPlan: 1, person: 3, pinned: 1 } })
  })

  it('a profit-derived or flat target is not one he set: left alone, and counted there first', async () => {
    await inside(() => setDefaultTargetAcosPct(null, 'test'))
    profit.byAdGroup = { 'g-c-it': 0.25 } // c-it: profit-derived; every other campaign without a target of its own: flat 30 %
    const r = await inside(() => runAutoBidOnce())
    // Only c-goal has a target he set: of its keywords, the two a person set stay.
    expect(writes.entries.map((e) => e.adTargetId)).toEqual(['t-goal2'])
    expect(r).toMatchObject({ proposed: 1, applied: 1, leftAlone: { noTargetSetByYou: 8, hourlyPlan: 0, goalPlan: 0, person: 2, pinned: 0 } })
  })

  it('ownerMoves: each source, each holder, and a person per keyword', () => {
    const p = (targetId: string, targetSource: string) => ({ targetId, targetSource }) as never
    const campaignOf = new Map([['t-a', 'c-a'], ['t-b', 'c-b'], ['t-c', 'c-c'], ['t-d', 'c-d'], ['t-e', 'c-e'], ['t-f', 'c-f'], ['t-g', 'c-b'], ['t-h', 'c-h']])
    const holders = new Map([['c-e', 'hourlyPlan'], ['c-f', 'goalPlan'], ['c-h', 'pinned']] as const)
    const out = ownerMoves([
      p('t-a', 'explicit'), p('t-b', 'campaign'), p('t-c', 'strategy'), p('t-d', 'account'),
      p('t-e', 'campaign'), p('t-f', 'strategy'), p('t-g', 'campaign'), p('t-h', 'campaign'),
      p('t-x', 'profit'), p('t-y', 'flat'), p('t-h', 'flat'),
    ], campaignOf, holders, new Set(['t-g']))
    // t-g, a person's bid, stays; t-b, in the same campaign, moves.
    expect(out.moves.map((m: { targetId: string }) => m.targetId)).toEqual(['t-a', 't-b', 't-c', 't-d'])
    // A bid with no target he set counts there first, whoever holds it.
    expect(out.leftAlone).toEqual({ noTargetSetByYou: 3, notRunning: 0, notOnAllowlist: 0, hourlyPlan: 1, goalPlan: 1, person: 1, pinned: 1 })
  })

  it('an autopilot plan switched OFF and a disabled schedule hold nothing', async () => {
    await inside(async () => {
      await db().autopilotPlan.updateMany({ data: { autonomy: 'OFF' } })
      await db().adSchedule.updateMany({ data: { enabled: false } })
    })
    const r = await inside(() => runAutoBidOnce())
    expect(writes.entries.map((e) => e.adTargetId).sort()).toEqual(['t-auto', 't-goal2', 't-hourly', 't-it', 't-person2', 't-uk'])
    expect(r.leftAlone).toEqual({ noTargetSetByYou: 0, notRunning: 0, notOnAllowlist: 0, hourlyPlan: 1, goalPlan: 0, person: 3, pinned: 1 })
    await inside(async () => {
      await db().autopilotPlan.updateMany({ data: { autonomy: 'SUGGEST' } })
      await db().adSchedule.updateMany({ data: { enabled: true } })
    })
  })
})

describe('Owner targets only — the preview is the run, and every surface says the rule', () => {
  it('the A4 preview shows exactly the bids a run sets, with the same counts', async () => {
    const preview = await previewA4()
    const r = await inside(() => runAutoBidOnce())
    expect(preview.proposals.map((p) => [p.targetId, p.proposedBidCents]).sort()).toEqual(writes.entries.map((e) => [e.adTargetId, e.bidCents]).sort())
    expect(preview.total).toBe(r.proposed)
    expect(preview.leftAlone).toEqual(r.leftAlone)
    expect(preview.leftAloneNote).toBe(`7 left alone (2 an hourly plan holds, 1 a goal plan holds, 3 a person holds, 1 a pin holds): ${AUTO_BID_SCOPE_WORDS}.`)
    // The same under SUGGEST: the preview does not depend on the dial, the run only counts.
    await inside(() => setAutonomy('SUGGEST', 'test'))
    writes.entries = []
    const dry = await inside(() => runAutoBidOnce())
    expect(writes.entries).toEqual([])
    expect(dry).toMatchObject({ proposed: preview.total, applied: 0, dryRun: true, leftAlone: preview.leftAlone })
  })

  it("the run's summary line and its notification name the rule and what it left alone", async () => {
    const r = await inside(() => runAutoBidOnce())
    expect(autoBidSummaryLine(r)).toBe(`proposed=4 applied=4 dryRun=false left-alone=7 (2 an hourly plan holds, 1 a goal plan holds, 3 a person holds, 1 a pin holds: ${AUTO_BID_SCOPE_WORDS})`)
    expect(notices.sent).toHaveLength(1)
    expect(notices.sent[0]).toMatchObject({ title: 'Auto-bid: 4 bid changes queued for Amazon' })
    expect(notices.sent[0].body).toBe(`Target-ACoS optimization: ${AUTO_BID_SCOPE_WORDS} (4 to move; left alone: 2 an hourly plan holds, 1 a goal plan holds, 3 a person holds, 1 a pin holds). Writes gated per-campaign allowlist + caps.`)
    // A run that left nothing alone keeps its old line.
    expect(autoBidSummaryLine({ proposed: 2, applied: 2, dryRun: false, leftAlone: { noTargetSetByYou: 0, notRunning: 0, notOnAllowlist: 0, hourlyPlan: 0, goalPlan: 0, person: 0, pinned: 0 } })).toBe('proposed=2 applied=2 dryRun=false')
  })

  it('the A4 catalog entry (list-automations) says the rule in the same words', () => {
    expect(AUTO_BID_SCOPE_WORDS).toBe('it moves only bids where you set a target ACoS (campaign, ads strategy or account default), in running campaigns on the live-write allowlist, and leaves bids an hourly plan, a goal plan, a person or a pin holds')
    expect(automationAdapter('A4')!.what).toContain(`It ${AUTO_BID_SCOPE_WORDS.slice(3)}.`)
  })
})

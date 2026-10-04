/**
 * 3e — no budget write that skips the gate and the audit (review 6.9, the two hidden budget writers).
 *
 *   · `reroute_marketplace_budget` without a pool cut one campaign and raised others with direct
 *     `prisma.campaign.update` calls: no action-log row, no queue row, so the write gate never judged it, Undo
 *     could not put it back and Amazon never received it. It is now refused, live and in a dry run, with a
 *     plain sentence; with a pool it still hands the move to the pool (control).
 *   · `set_daily_budget` had no €1 floor, hid the mutation's refusal (`ok:false` with no `error`) and wrote
 *     behind two `as never` casts. It now refuses below Amazon's €1 minimum, says the same in a dry run as live,
 *     and writes through updateCampaignWithSync: one action-log row and one queue row (where the gate runs).
 *
 * On a real PostgreSQL (PGlite, production schema) through the real mutation path; only the queue is mocked, and
 * updateCampaignWithSync can be made to refuse for the one test that needs a refusal the database cannot cause.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { seedAdsFixture } from '../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

const h = vi.hoisted(() => ({ refuse: null as null | { ok: false; outboundQueueId: null; bidHistoryIds: string[]; actionLogId: null; error: string } }))

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
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction; an ads
// row names no listing account anyway (the ads worker resolves its Amazon Ads profile).
vi.mock('../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
vi.mock('./ads-mutation.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ads-mutation.service.js')>()
  return {
    ...actual,
    updateCampaignWithSync: (args: Parameters<typeof actual.updateCampaignWithSync>[0]) =>
      h.refuse ? Promise.resolve(h.refuse) : actual.updateCampaignWithSync(args),
  }
})

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

const RULE = 'tstrule-ba'
const RULE_ACTOR = `automation:${RULE}`

const run = async (type: string, action: Record<string, unknown>, context: Record<string, unknown>, dryRun = false) => {
  const { ACTION_HANDLERS } = await import('../automation-rule.service.js')
  return inside(() => ACTION_HANDLERS[type]({ type, ...action }, context, { dryRun, ruleId: RULE }))
}
const budgets = async () => Object.fromEntries((await inside(() => database.client.campaign.findMany({ select: { id: true, dailyBudget: true } })))
  .map((c: { id: string; dailyBudget: unknown }) => [c.id, Number(c.dailyBudget)]))
const writes = async () => ({
  actionLog: await inside(() => database.client.advertisingActionLog.count()),
  queue: await inside(() => database.client.outboundSyncQueue.count()),
})

beforeAll(async () => {
  database = await formulaDatabase()
  await import('./automation-action-handlers.js')
  await inside(() => seedAdsFixture(database.client))
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)
beforeEach(() => { h.refuse = null })

const REROUTE_REFUSAL = 'Refused: moving budget between marketplaces is done by a budget pool. Choose a budget pool for this action; it no longer changes budgets by itself.'

describe('reroute_marketplace_budget without a pool is refused and writes nothing', () => {
  it('from IT to UK: refused live AND in a dry run, and no budget, action-log row or queue row changes', async () => {
    const beforeBudgets = await budgets()
    const beforeWrites = await writes()
    for (const dryRun of [false, true]) {
      const out = await run('reroute_marketplace_budget', { fromMarketplace: 'IT', toMarketplace: 'UK', percent: 25 }, { marketplace: 'IT' }, dryRun)
      expect(out.ok).toBe(false)
      expect(out.error).toBe(REROUTE_REFUSAL)
      expect(out.output).toMatchObject({ refusedBy: 'budget-pool-only', fromMarketplace: 'IT', toMarketplace: 'UK' })
      expect(out.estimatedValueCentsEur ?? 0).toBe(0)
    }
    expect(await budgets()).toEqual(beforeBudgets)
    expect(await writes()).toEqual(beforeWrites)
  })

  it('with no settings at all (the "Reroute budget to best marketplace" template) it says the same sentence', async () => {
    const out = await run('reroute_marketplace_budget', {}, { marketplace: 'IT' })
    expect(out).toMatchObject({ ok: false, error: REROUTE_REFUSAL })
  })

  // Control: the refusal is about the direct writes, not the action. A named pool still gets the move.
  it('with a budget pool it still hands the move to the pool', async () => {
    const out = await run('reroute_marketplace_budget', { budgetPoolId: 'no-such-pool', fromMarketplace: 'IT', toMarketplace: 'UK' }, { marketplace: 'IT' })
    expect(out).toMatchObject({ ok: false, error: 'pool skipped: pool_not_found' })
  })
})

describe('set_daily_budget', () => {
  it('below Amazon’s €1 minimum: refused live AND in a dry run, and nothing is written', async () => {
    const beforeWrites = await writes()
    for (const dryRun of [false, true]) {
      const out = await run('set_daily_budget', { budgetEur: 0.5 }, { campaign: { id: 'c-it' } }, dryRun)
      expect(out.ok).toBe(false)
      expect(out.error).toBe('Refused: €0.50 is below Amazon\'s minimum daily budget of €1.00.')
    }
    expect((await budgets())['c-it']).toBe(20)
    expect(await writes()).toEqual(beforeWrites)
  })

  it('a dry run at exactly €1 says what it would change and writes nothing', async () => {
    const beforeWrites = await writes()
    const out = await run('set_daily_budget', { budgetEur: 1 }, { campaign: { id: 'c-pin' } }, true)
    expect(out).toMatchObject({ ok: true, output: { dryRun: true, campaignId: 'c-pin', budgetEur: 1, wouldChange: '€20.00 → €1.00' } })
    expect((await budgets())['c-pin']).toBe(20)
    expect(await writes()).toEqual(beforeWrites)
  })

  it('live at exactly €1: writes through the mutation path — one action-log row and one queue row for the gate', async () => {
    const beforeWrites = await writes()
    const out = await run('set_daily_budget', { budgetEur: 1 }, { campaign: { id: 'c-it' } })
    expect(out.ok).toBe(true)
    expect(out.error).toBeUndefined()
    const queueId = (out.output as { outboundQueueId: string | null }).outboundQueueId
    expect(queueId).toBeTruthy()
    expect((await budgets())['c-it']).toBe(1)
    expect(await writes()).toEqual({ actionLog: beforeWrites.actionLog + 1, queue: beforeWrites.queue + 1 })
    const log = await inside(() => database.client.advertisingActionLog.findFirstOrThrow({
      where: { entityId: 'c-it', actionType: 'AD_BUDGET_UPDATE' },
      select: { userId: true, payloadBefore: true, payloadAfter: true, outboundQueueId: true },
    }))
    expect(log).toMatchObject({ userId: RULE_ACTOR, payloadBefore: { dailyBudget: 20 }, payloadAfter: { dailyBudget: 1 }, outboundQueueId: queueId })
    const row = await inside(() => database.client.outboundSyncQueue.findUnique({ where: { id: queueId as string }, select: { id: true } }))
    expect(row).not.toBeNull()
  })

  it('at the budget it already has: no change, live AND in a dry run, and nothing is written', async () => {
    const beforeWrites = await writes()
    for (const dryRun of [false, true]) {
      const out = await run('set_daily_budget', { budgetEur: 15 }, { campaign: { id: 'c-uk' } }, dryRun)
      expect(out).toMatchObject({ ok: true, output: { campaignId: 'c-uk', noChange: true } })
    }
    expect(await writes()).toEqual(beforeWrites)
  })

  it('a campaign that does not exist: the same refusal live AND in a dry run', async () => {
    for (const dryRun of [false, true]) {
      const out = await run('set_daily_budget', { budgetEur: 30 }, { campaign: { id: 'c-gone' } }, dryRun)
      expect(out).toMatchObject({ ok: false, error: 'Campaign not found' })
    }
  })

  // The campaign removed between the handler's read and the write: the mutation refuses, and the rule's result now
  // says why instead of a bare ok:false.
  it('a refusal from the mutation path reaches the result', async () => {
    h.refuse = { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'not_found' }
    const out = await run('set_daily_budget', { budgetEur: 30 }, { campaign: { id: 'c-off' } })
    expect(out).toMatchObject({ ok: false, error: 'not_found' })
  })
})

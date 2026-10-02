/**
 * MCP full control part 06, fix (lead review of R7) — every write a rule makes is written under the rule's OWN actor,
 * `automation:<ruleId>`, the string its daily write cap (`maxWritesPerDay`) counts.
 *
 * Two rule actions wrote under another name, so their writes never counted toward the cap — a cap bypass:
 *   · the placement actions (`set_placement_multiplier`, `placement_apply`) wrote `automation:rule-<ruleId>`;
 *   · `defend_top_of_search` wrote `automation:tos-optimizer`, the top-of-search cron's own actor.
 * The cron keeps its actor (control).
 *
 * Every placement write goes through `updatePlacementBidding` (ads-create.service.ts); the test reads the actor it is
 * handed. On a real PostgreSQL (PGlite) for the campaign and the top-of-search report the defence reads.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
const updatePlacementBidding = vi.fn(async () => ({ ok: true, mode: 'test' }))
vi.mock('./ads-create.service.js', () => ({ updatePlacementBidding }))
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

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

const RULE = 'tstrule1'
let campaignId = ''
const actors = () => (updatePlacementBidding.mock.calls as unknown as Array<[{ actor?: string }]>).map(([args]) => args.actor)

beforeAll(async () => {
  database = await formulaDatabase()
  await import('./automation-action-handlers.js')
  await import('./ads-top-of-search.service.js')
  await inside(async () => {
    const campaign = await database.client.campaign.create({
      data: { name: 'TEST CAMPAIGN', type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: 'TEST-CMP-1', liveBidWritesEnabled: true, dynamicBidding: { placementBidding: [] } },
    })
    campaignId = campaign.id
    // Top of search at 1 % ACOS: well under a 25 % target, so the defence raises the top-of-search percentage.
    await database.client.amazonAdsPlacementReport.create({
      data: { profileId: 'TEST-PROFILE-1', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(), campaignId: 'TEST-CMP-1', placement: 'Top of Search on-Amazon', impressions: 1000, clicks: 50, costMicros: 1_000_000n, sales7dCents: 10_000, orders7d: 5, currencyCode: 'EUR' },
    })
  })
}, 180_000)
beforeEach(() => updatePlacementBidding.mockClear())
afterAll(async () => {
  await database?.close()
}, 30_000)

const run = async (type: string, action: Record<string, unknown>) => {
  const { ACTION_HANDLERS } = await import('../automation-rule.service.js')
  return inside(() => ACTION_HANDLERS[type]({ type, ...action }, { campaign: { id: campaignId } }, { dryRun: false, ruleId: RULE }))
}

describe("a rule's placement and top-of-search writes carry the rule's own actor", () => {
  it('set_placement_multiplier writes as automation:<ruleId>', async () => {
    await run('set_placement_multiplier', { campaignId, placement: 'PLACEMENT_TOP', percentage: 30 })
    expect(actors()).toEqual([`automation:${RULE}`])
  })

  it('placement_apply writes as automation:<ruleId>', async () => {
    await run('placement_apply', { campaignId, placement: 'PLACEMENT_TOP', op: 'set', value: 40 })
    expect(actors()).toEqual([`automation:${RULE}`])
  })

  it('defend_top_of_search, run by a rule, writes as automation:<ruleId>', async () => {
    const out = await run('defend_top_of_search', { targetAcos: 0.25 })
    expect(out).toMatchObject({ ok: true, output: { applied: 1 } })
    expect(actors()).toEqual([`automation:${RULE}`])
  })

  it('control: the top-of-search cron keeps its own actor', async () => {
    const { defendTopOfSearch } = await import('./ads-top-of-search.service.js')
    await inside(() => defendTopOfSearch({ targetAcos: 0.25, allowlistedOnly: true }))
    expect(actors()).toEqual(['automation:tos-optimizer'])
  })
})

/**
 * C4 (2026-10-10) — the "Top-of-Search rank defender" template is retired, and this proves it could never work.
 *
 * It said "when impression share drops … raises all bids 25 %". Its trigger is KEYWORD_ZERO_IMPRESSIONS, whose context
 * (the evaluator's real builder, run here by `simulateOneRule` on PGlite with the production schema) carries a keyword
 * and no campaign; both write actions need a campaign and refuse on every match. The Owner's rule: a removal is fine
 * only when the thing could not work anyway — this is that proof. Made-up numbers only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
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

const { ADVERTISING_TEMPLATES, RETIRED_ADVERTISING_TEMPLATES } = await import('./automation-templates.js')
const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const RETIRED = RETIRED_ADVERTISING_TEMPLATES.find((t) => t.name === 'Top-of-Search rank defender')!
let ruleId = ''

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const campaign = await database.client.campaign.create({
      data: { name: 'TEST CAMPAIGN', type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: 'TEST-CMP-1', liveBidWritesEnabled: true },
    })
    const group = await database.client.adGroup.create({ data: { campaignId: campaign.id, name: 'TEST GROUP', externalAdGroupId: 'TEST-AG-1', defaultBidCents: 40 } })
    const target = await database.client.adTarget.create({
      data: { adGroupId: group.id, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'test keyword', bidCents: 40, externalTargetId: 'TEST-T-1' },
    })
    // A keyword that spent €1 and got no impressions, 10 days ago: inside the trigger's settled window.
    await database.client.amazonAdsDailyPerformance.create({
      data: { profileId: 'TEST-PROFILE-1', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(Date.now() - 10 * 86_400_000), entityType: 'AD_TARGET', entityId: 'TEST-T-1', localEntityId: target.id, impressions: 0, costMicros: 1_000_000n, currencyCode: 'EUR', reportedAt: new Date() },
    })
    const rule = await database.client.automationRule.create({
      data: { name: RETIRED.name, description: RETIRED.description, domain: 'advertising', trigger: RETIRED.trigger, conditions: RETIRED.conditions as object, actions: RETIRED.actions as object, enabled: false, dryRun: true, maxExecutionsPerDay: RETIRED.maxExecutionsPerDay ?? 10, createdBy: 'test' },
    })
    ruleId = rule.id
  })
}, 180_000)
afterAll(async () => {
  await database?.close()
}, 30_000)

describe('C4 — the Top-of-Search rank defender is retired, because it could not work', () => {
  it('is no longer seeded, and says why', () => {
    expect(ADVERTISING_TEMPLATES.map((t) => t.name)).not.toContain('Top-of-Search rank defender')
    expect(RETIRED.why).toContain('No campaign.id')
    for (const t of ADVERTISING_TEMPLATES) expect(`${t.name} ${t.description}`).not.toMatch(/rank defender/i)
  })

  it('🔴 proof: on a real zero-impression match both write actions refuse — the context carries no campaign', async () => {
    const { simulateOneRule } = await import('../../jobs/advertising-rule-evaluator.job.js')
    const r = await inside(() => simulateOneRule(ruleId))
    expect(r).toMatchObject({ ok: true, trigger: 'KEYWORD_ZERO_IMPRESSIONS', contextsBuilt: 1, matched: 1 })
    const actions = r.results![0].actions
    expect(actions.find((a) => a.type === 'raise_bids_for_rank_defense')).toMatchObject({ ok: false, error: 'No campaign.id' })
    expect(actions.find((a) => a.type === 'set_placement_multiplier')).toMatchObject({ ok: false, error: 'No campaign.id in context' })
  }, 120_000)
})

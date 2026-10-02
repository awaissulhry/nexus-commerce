/**
 * R8 (MCP full control, part 06) — a rule PREVIEW notifies nobody.
 *
 * R3 made a preview (`evaluateRule({ noPersist })`: the rule-builder's Test, Simulate, and now Claude's
 * preview-automation) leave no run row and raise no counter, and left one known gap: the `notify` and
 * `alert_operator` actions fan out to every operator's bell in a dry run, by design for the 15-minute tick (an alert
 * is not an Amazon write). In a preview that is wrong: asking "what would this rule do" rang the bell as if it had
 * done it, once per press and once per context.
 *
 * A preview now reports who it WOULD notify and sends nothing. A tick's dry run still notifies (control).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
const notify = vi.fn(async () => ({ created: 2, deduped: false, wouldHaveReached: 2 }))
vi.mock('./ads-automation-notify.service.js', () => ({
  notifyAutomationDetailed: notify,
  notifyAutomation: vi.fn(async () => 2),
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

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

let ruleId = ''
beforeAll(async () => {
  database = await formulaDatabase()
  await import('./automation-action-handlers.js') // the real notify and alert_operator handlers
  // An active Amazon ads connection, so Simulate builds a SCHEDULE context to evaluate (one per active market).
  await inside(() => database.client.amazonAdsConnection.create({ data: { profileId: 'TEST-PROFILE-1', marketplace: 'IT', isActive: true } as never }))
  ruleId = (await inside(() => database.client.automationRule.create({
    data: {
      domain: 'advertising', name: 'TEST alert rule', trigger: 'SCHEDULE', enabled: false, conditions: [],
      actions: [{ type: 'notify', title: 'TEST spend alert' }, { type: 'alert_operator', severity: 'warning', message: 'TEST operator alert' }],
    },
  }))).id
}, 180_000)
beforeEach(() => notify.mockClear())
afterAll(async () => {
  await database?.close()
}, 30_000)

describe('R8 — a preview notifies nobody', () => {
  it("evaluateRule({ noPersist }) runs notify and alert_operator as previews: nothing sent, who it would reach said", async () => {
    const { evaluateRule } = await import('../automation-rule.service.js')
    const result = await inside(() => evaluateRule({ ruleId, context: { marketplace: 'IT' }, forceDryRun: true, isTestRun: true, ignoreEnabled: true, noPersist: true }))
    expect(result.matched).toBe(true)
    expect(notify).not.toHaveBeenCalled()
    expect(result.actionResults).toEqual([
      { type: 'notify', ok: true, output: expect.objectContaining({ preview: true, notified: 0, wouldNotify: 'every operator', title: 'TEST spend alert' }) },
      { type: 'alert_operator', ok: true, output: expect.objectContaining({ preview: true, notified: 0, wouldNotify: 'every operator', message: 'TEST operator alert' }) },
    ])
  })

  it("Simulate (simulateOneRule, what preview-automation runs for a saved rule) notifies nobody", async () => {
    const { simulateOneRule } = await import('../../jobs/advertising-rule-evaluator.job.js')
    const out = await inside(() => simulateOneRule(ruleId))
    expect(out.ok).toBe(true)
    // It really evaluated the rule (not a vacuous pass): one context, matched, both actions reported.
    expect(out).toMatchObject({ contextsInScope: 1, matched: 1 })
    expect(out.results![0].actions.map((a) => a.type)).toEqual(['notify', 'alert_operator'])
    expect(notify).not.toHaveBeenCalled()
  })

  it("control: a tick's dry run still notifies, by design (an alert is not an Amazon write)", async () => {
    await inside(() => database.client.automationRule.update({ where: { id: ruleId }, data: { enabled: true } }))
    const { evaluateRule } = await import('../automation-rule.service.js')
    await inside(() => evaluateRule({ ruleId, context: { marketplace: 'IT' }, forceDryRun: true }))
    expect(notify).toHaveBeenCalledTimes(2)
  })
})

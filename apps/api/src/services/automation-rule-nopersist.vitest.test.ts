/**
 * R3 (MCP full control, part 06 gap 6) — a rule PREVIEW leaves nothing behind.
 *
 * The rule-builder's Test button (`POST /advertising/automation-rules/:id/test`) and Simulate
 * (`POST /advertising/automation-rules/:id/simulate` → `simulateOneRule`) ran `evaluateRule` like a real tick: one
 * `AutomationRuleExecution` row per context, and `evaluationCount` / `matchCount` / `executionCount` raised on the rule.
 * The graduation gate (gate-status, graduate) reads exactly those counters — "10 evaluations", "1 match" — so pressing
 * Test ten times could open the road to Auto for a rule that never ran on a tick. The rows also counted toward the
 * rule's `maxExecutionsPerDay`, so a preview spent the rule's own daily cap.
 *
 * `evaluateRule({ noPersist: true })` evaluates and reports, and writes no execution row, raises no counter, records
 * no refusal, queues no suggestion and announces no "rule fired". It is always a dry run. Test and Simulate use it.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const execCreate = vi.fn(async () => ({ id: 'exec-new' }))
const execCount = vi.fn(async () => 0)
const ruleUpdate = vi.fn(async () => ({}))
const ruleFindUnique = vi.fn(async (): Promise<Record<string, unknown> | null> => RULE)
const actionLogCount = vi.fn(async () => 0)

vi.mock('../db.js', () => ({
  default: {
    automationRuleExecution: { get count() { return execCount }, get create() { return execCreate } },
    automationRule: { get update() { return ruleUpdate }, get findUnique() { return ruleFindUnique } },
    advertisingActionLog: { get count() { return actionLogCount } },
    // simulateOneRule's SCHEDULE contexts: one per active marketplace, with month-to-date spend.
    amazonAdsConnection: { findMany: vi.fn(async () => [{ marketplace: 'IT' }, { marketplace: 'DE' }]) },
    amazonAdsDailyPerformance: { groupBy: vi.fn(async () => []) },
  },
}))
const genSuggestions = vi.fn(async () => 1)
vi.mock('./advertising/ads-suggestions.service.js', () => ({ generateSuggestionsFromExecution: genSuggestions }))
vi.mock('./advertising/ads-rule-adapter.service.js', () => ({ maybeTranslateAdsRule: vi.fn(() => null) }))
const publish = vi.fn()
vi.mock('./ads-execution-events.service.js', () => ({ publishAdsExecution: publish }))
const refusal = vi.fn(async () => undefined)
vi.mock('./automation-refusals.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordAutomationRefusal: refusal,
}))
// The ads handlers register as an import side effect; this file registers its own spy handler instead.
vi.mock('./advertising/automation-action-handlers.js', () => ({}))
vi.mock('../lib/queue.js', () => {
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
vi.mock('./advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))

const flush = () => new Promise((r) => setTimeout(r, 0))

/** An AUTO rule that matches everything: the case where a preview could most easily act or be counted. */
const RULE = {
  id: 'rule-1', name: 'Preview me', domain: 'advertising', trigger: 'SCHEDULE',
  conditions: [], actions: [{ type: 'preview_spy' }],
  enabled: true, dryRun: false, autonomyLevel: 'AUTO',
  maxExecutionsPerDay: 50, maxWritesPerDay: 5, maxValueCentsEur: null, maxDailyAdSpendCentsEur: null,
  scopeMarketplace: null, scopePortfolioId: null, scopeCampaignId: null, scopeProductId: null,
}

const { evaluateRule, ACTION_HANDLERS } = await import('./automation-rule.service.js')
const spy = vi.fn(async (action: { type: string }, _ctx: unknown, meta: { dryRun: boolean }) => ({ type: action.type, ok: true, output: { dryRun: meta.dryRun } }))
ACTION_HANDLERS.preview_spy = spy as never
const { simulateOneRule } = await import('../jobs/advertising-rule-evaluator.job.js')

/** Nothing a tick leaves behind: no run row, no counter, no refusal record, no suggestion, no "fired" event. */
async function expectNothingWritten() {
  await flush()
  expect(execCreate).not.toHaveBeenCalled()
  expect(ruleUpdate).not.toHaveBeenCalled()
  expect(refusal).not.toHaveBeenCalled()
  expect(genSuggestions).not.toHaveBeenCalled()
  expect(publish).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  ruleFindUnique.mockResolvedValue(RULE)
  execCount.mockResolvedValue(0)
  actionLogCount.mockResolvedValue(0)
})

describe('evaluateRule({ noPersist }) — evaluate and report, write nothing', () => {
  const context = { trigger: 'SCHEDULE', marketplace: 'IT', campaign: { id: 'camp-1', name: 'TEST-CAMPAIGN' } }

  it('a match: the result is reported, as a dry run, and no row or counter is written', async () => {
    const r = await evaluateRule({ ruleId: 'rule-1', context, noPersist: true })
    expect(r).toMatchObject({ ruleId: 'rule-1', matched: true, status: 'DRY_RUN', actionResults: [{ type: 'preview_spy', ok: true, output: { dryRun: true } }] })
    expect(r.executionId).toBeUndefined()
    // An AUTO rule previewed never acts: noPersist is always a dry run.
    expect(spy).toHaveBeenCalledWith(expect.anything(), context, { dryRun: true, ruleId: 'rule-1', preview: true }) // R8 — and told it is a preview (no notification)
    await expectNothingWritten()
  })

  it('no match: evaluationCount is not raised', async () => {
    ruleFindUnique.mockResolvedValue({ ...RULE, conditions: [{ field: 'marketplace', op: 'eq', value: 'FR' }] })
    const r = await evaluateRule({ ruleId: 'rule-1', context, noPersist: true })
    expect(r).toMatchObject({ matched: false, status: 'NO_MATCH' })
    await expectNothingWritten()
  })

  it('a rule at its daily cap: reported as capped, and no refusal is recorded for a preview', async () => {
    execCount.mockResolvedValue(50)
    const r = await evaluateRule({ ruleId: 'rule-1', context, noPersist: true })
    expect(r.status).toBe('CAP_EXCEEDED')
    expect(spy).not.toHaveBeenCalled()
    await expectNothingWritten()
  })

  it('an untranslatable builder rule: no match, and the counter is not raised', async () => {
    const { maybeTranslateAdsRule } = await import('./advertising/ads-rule-adapter.service.js')
    vi.mocked(maybeTranslateAdsRule).mockReturnValueOnce({ untranslatable: ['x'] } as never)
    const r = await evaluateRule({ ruleId: 'rule-1', context, noPersist: true })
    expect(r.status).toBe('NO_MATCH')
    await expectNothingWritten()
  })

  it('control: the same evaluation WITHOUT noPersist writes the row and raises the counters', async () => {
    await evaluateRule({ ruleId: 'rule-1', context, forceDryRun: true, isTestRun: true })
    expect(execCreate).toHaveBeenCalledTimes(1)
    expect(ruleUpdate.mock.calls.map((c) => Object.keys((c as unknown as [{ data: object }])[0].data)).flat())
      .toEqual(expect.arrayContaining(['evaluationCount', 'matchCount', 'executionCount']))
  })
})

describe('Simulate and Test use it', () => {
  it('simulateOneRule: every context evaluated, nothing written', async () => {
    const out = await simulateOneRule('rule-1')
    expect(out).toMatchObject({ ok: true, contextsBuilt: 2, contextsInScope: 2, matched: 2 })
    expect(spy).toHaveBeenCalledTimes(2)
    await expectNothingWritten()
  })

  let app: FastifyInstance
  beforeAll(async () => {
    const [{ default: advertisingRoutes }, { default: advertisingIntelRoutes }] = await Promise.all([
      import('../routes/advertising.routes.js'), import('../routes/advertising-intel.routes.js'),
    ])
    app = Fastify()
    await app.register(advertisingRoutes, { prefix: '/api' })
    await app.register(advertisingIntelRoutes, { prefix: '/api' })
    await app.ready()
  }, 60_000)

  it('POST /advertising/automation-rules/:id/test — nothing written', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/advertising/automation-rules/rule-1/test', payload: { context: { trigger: 'SCHEDULE', marketplace: 'IT' } } })
    expect(res.statusCode).toBe(200)
    expect(res.json().result).toMatchObject({ matched: true, status: 'DRY_RUN' })
    await expectNothingWritten()
  })

  it('POST /advertising/automation-rules/:id/simulate — nothing written, and it says so', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/advertising/automation-rules/rule-1/simulate' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, matched: 2, reachedAmazon: false, wroteAuditRows: 0 })
    await expectNothingWritten()
  })
})

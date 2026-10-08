/**
 * ONE BRAIN AB-6 — every engine leaves a lever a product's brain owns BEFORE it asks, on a real PostgreSQL (the throwaway
 * PostgreSQL 17 of scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login,
 * business profiles ON), the server switch `live`, the ads mode LIVE and the job queue a stub: nothing leaves the process;
 * a write that is not left is only queued. The real brain reader (brain/lever-owners.ts over brain/settings.ts) answers.
 *
 *   today      nothing enrolled in the business (production as AB-6 ships): a rule's budget action, a budget schedule and
 *              a pool's rebalance write exactly as before, and nothing is recorded as left
 *   owned      GALE enrolled in IT with its budgets lever at AUTO (the levels a lever takes are widened here, as each
 *              lever's own PR will): the rule's action on GALE's campaign is a named skip (no action log, no queue row),
 *              counted LEVER_HELD:budgets in the rule's refusal record; on MISANO's campaign it writes; the schedule
 *              enters its window on MISANO's campaign only and says so in its line; the pool keeps GALE's budget and
 *              shares the rest
 *   lock       the Owner's lock of GALE's budgets: the same skip, in the lock's words
 *   business   another business with the same shapes and nothing enrolled writes as before
 *
 * Values are made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
    }),
  }
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
// Each lever's own PR widens the levels it takes (levers.ts LEVER_LEVELS_NOW); the engines must leave them right already.
vi.mock('./levers.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./levers.js')>()), levelRefusal: () => null }))

const { evaluateRule } = await import('../../automation-rule.service.js')
await import('../automation-action-handlers.js')
const { enrollProduct, setLever, setOverride, endOverride } = await import('./enrollment.js')
const { forgetLeverOwners } = await import('./lever-owners.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')
const { runBudgetScheduleOnce, budgetScheduleSummaryLine } = await import('../../../jobs/ad-budget-schedule.job.js')
const { rebalanceAndAudit, BUDGET_POOL_CRON_ACTOR } = await import('../budget-pool-rebalancer.service.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `ab6_engines_${hex}`
const W2 = `ab6_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const P = `${hex}-gale`, P1 = `${hex}-gale-m`, Q = `${hex}-misano`, Q1 = `${hex}-misano-m`
const NOW = new Date('2026-10-08T12:00:00Z')

/** The budget writes Nexus recorded for a campaign (each is also a queue row): a left write records none. */
const budgetWrites = async (workspaceId: string, campaignId: string) =>
  (await rows<{ n: number }>('SELECT count(*)::int n FROM "AdvertisingActionLog" WHERE "workspaceId" = $1 AND "entityId" = $2 AND "actionType" = \'AD_BUDGET_UPDATE\'', [workspaceId, campaignId]))[0].n
const leverHeld = async (ruleId: string) =>
  rows<{ reason: string; count: number; lastReason: string }>('SELECT reason, count, "lastReason" FROM "AutomationRefusalDaily" WHERE "workspaceId" = $1 AND "actorId" = $2 AND reason LIKE \'LEVER_HELD:%\'', [W, ruleId])

async function seed(prefix = '') {
  const db = database.client
  await seedAdsFixture(db, { prefix })
  const product = (id: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: `${prefix}${id}`, sku: `${prefix}${sku}`, name: sku, basePrice: '99.00', totalStock: 5, ...extra } })
  await product(P, `AB6-GALE-${hex}`, { isParent: true })
  await product(P1, `AB6-GALE-M-${hex}`, { parentId: `${prefix}${P}`, amazonAsin: `B0AB6GLM${H}` })
  await product(Q, `AB6-MISANO-${hex}`, { isParent: true })
  await product(Q1, `AB6-MISANO-M-${hex}`, { parentId: `${prefix}${Q}`, amazonAsin: `B0AB6MSM${H}` })
  // c-it advertises GALE only (its brain's own campaign); c-off advertises MISANO.
  await db.adProductAd.create({ data: { adGroupId: `${prefix}g-c-it`, productId: `${prefix}${P1}`, asin: `B0AB6GLM${H}` } })
  await db.adProductAd.create({ data: { adGroupId: `${prefix}g-c-off`, productId: `${prefix}${Q1}`, asin: `B0AB6MSM${H}` } })
}

/** An AUTO budget rule (+10 % of the campaign's budget) and one run of it on a campaign. */
async function budgetRule(name: string) {
  return database.client.automationRule.create({
    data: { name, domain: 'advertising', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', actions: [{ type: 'adjust_ad_budget', percent: 10 }], enabled: true, dryRun: false, autonomyLevel: 'AUTO' },
  })
}
const runRule = (ruleId: string, campaignId: string) =>
  evaluateRule({ ruleId, context: { trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', marketplace: 'IT', campaign: { id: campaignId, name: campaignId } } })

describe.skipIf(!concurrentDatabaseUrl())('AB-6 — engines leave a lever a product\'s brain owns before they ask (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(async () => { await seed(); await setAutonomy('AUTO', 'test') })
    await inW2(async () => { await seed('w2-'); await setAutonomy('AUTO', 'test') })
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('today: nothing enrolled — a rule\'s budget action writes as before and nothing is recorded as left', async () => {
    forgetLeverOwners()
    const rule = await inW(() => budgetRule('AB6 today'))
    const r = await inW(() => runRule(rule.id, 'c-it'))
    expect(r.actionResults).toEqual([expect.objectContaining({ type: 'adjust_ad_budget', ok: true, output: expect.objectContaining({ campaignId: 'c-it', newDailyBudget: 22 }) })])
    expect(await budgetWrites(W, 'c-it')).toBe(1)
    expect(await leverHeld(rule.id)).toEqual([])
  })

  it('owned: the rule leaves GALE\'s budget (named, counted, nothing written) and writes MISANO\'s', async () => {
    expect(await inW(() => enrollProduct({ productId: P1, market: 'IT', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true, productId: P })
    expect(await inW(() => setLever({ productId: P, market: 'IT', lever: 'budgets', level: 'AUTO', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true })
    const rule = await inW(() => budgetRule('AB6 owned'))
    const before = await budgetWrites(W, 'c-it')
    const left = await inW(() => runRule(rule.id, 'c-it'))
    expect(left.status).toBe('SUCCESS')
    expect(left.actionResults).toEqual([expect.objectContaining({
      type: 'adjust_ad_budget', ok: true,
      output: expect.objectContaining({ skipped: 'brain-lever', brainSkip: expect.objectContaining({ lever: 'budgets', kind: 'owned', campaignId: 'c-it', productId: P, market: 'IT' }) }),
    })])
    expect(String((left.actionResults[0].output as { why: string }).why)).toBe(`left alone: a product's brain runs the daily budget of campaign "Italy exact" (c-it) — product ${P} in IT (one owner per lever); a person's own edit still passes`)
    expect(await budgetWrites(W, 'c-it')).toBe(before)
    expect(await leverHeld(rule.id)).toEqual([expect.objectContaining({ reason: 'LEVER_HELD:budgets', count: 1 })])

    const free = await inW(() => runRule(rule.id, 'c-off'))
    expect(free.actionResults[0]).toMatchObject({ ok: true, output: { campaignId: 'c-off' } })
    expect(await budgetWrites(W, 'c-off')).toBe(1)
  })

  it('owned: a budget schedule enters its window on MISANO\'s campaign only, and its line says what it left', async () => {
    const now = new Date()
    await inW(() => database.client.budgetSchedule.create({
      data: { name: 'AB6 boost', windows: [{ day: now.getUTCDay(), adj: 'incPct', value: 50 }], campaigns: [{ id: 'c-it' }, { id: 'c-off' }], timezone: 'UTC' },
    }))
    const before = { it: await budgetWrites(W, 'c-it'), off: await budgetWrites(W, 'c-off') }
    const tick = await inW(() => runBudgetScheduleOnce(now))
    expect(await budgetWrites(W, 'c-it')).toBe(before.it)
    expect(await budgetWrites(W, 'c-off')).toBe(before.off + 1)
    expect(tick).toMatchObject({ changed: 1, leverHeld: { budgets: 1 } })
    expect(budgetScheduleSummaryLine(tick)).toContain('brain-levers=budgets:1')
  })

  it('owned: a live pool keeps GALE\'s budget and shares the rest of its total', async () => {
    const pool = await inW(() => database.client.budgetPool.create({
      data: {
        name: 'AB6 pool', totalDailyBudgetCents: 6_000, enabled: true, dryRun: false, maxShiftPerRebalancePct: 100, coolDownMinutes: 0,
        allocations: { create: [{ marketplace: 'IT', campaignId: 'c-it', targetSharePct: 50 }, { marketplace: 'IT', campaignId: 'c-off', targetSharePct: 50 }] },
      },
    }))
    const itBudget = Math.round(Number((await rows<{ b: string }>('SELECT "dailyBudget" b FROM "Campaign" WHERE id = \'c-it\''))[0].b) * 100)
    const before = { it: await budgetWrites(W, 'c-it'), off: await budgetWrites(W, 'c-off') }
    const out = await inW(() => rebalanceAndAudit({ poolId: pool.id, triggeredBy: 'cron', actor: BUDGET_POOL_CRON_ACTOR }))
    const it = out.proposed.find((p) => p.campaignId === 'c-it')!
    const off = out.proposed.find((p) => p.campaignId === 'c-off')!
    expect(it).toMatchObject({ shiftCents: 0, proposedBudgetCents: itBudget, heldBy: expect.stringContaining('a product\'s brain runs the daily budget of campaign "Italy exact" (c-it)') })
    expect(off.proposedBudgetCents).toBe(6_000 - itBudget)
    expect(out.leverHeld).toEqual({ counts: { budgets: 1 } })
    expect(await budgetWrites(W, 'c-it')).toBe(before.it)
    expect(await budgetWrites(W, 'c-off')).toBe(before.off + 1)
  })

  it('lock: the Owner holds GALE\'s budgets at his own value — the same skip, in the lock\'s words', async () => {
    expect(await inW(() => setLever({ productId: P, market: 'IT', lever: 'budgets', level: 'OBSERVE', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true })
    expect(await inW(() => setOverride({ productId: P, market: 'IT', by: 'user:owner', reason: 'my own budget', now: NOW, override: { scope: 'PRODUCT', kind: 'LOCK', key: 'budgets' } }))).toMatchObject({ ok: true })
    const rule = await inW(() => budgetRule('AB6 lock'))
    const left = await inW(() => runRule(rule.id, 'c-it'))
    expect(left.actionResults[0]).toMatchObject({ output: { skipped: 'brain-lever', brainSkip: { lever: 'budgets', kind: 'locked' } } })
    expect(String((left.actionResults[0].output as { why: string }).why)).toContain('the Owner holds the daily budget of campaign "Italy exact" (c-it) at his own value')
    // Ending the lock (the lever at OBSERVE) lets the rule write again.
    expect(await inW(() => endOverride({ productId: P, market: 'IT', by: 'user:owner', now: NOW, override: { scope: 'PRODUCT', kind: 'LOCK', key: 'budgets' } }))).toMatchObject({ ok: true })
    const free = await inW(() => runRule(rule.id, 'c-it'))
    expect(free.actionResults[0]).toMatchObject({ ok: true, output: { campaignId: 'c-it' } })
  })

  it('another business: the same shapes, nothing enrolled there — written as before', async () => {
    const rule = await inW2(() => budgetRule('AB6 other business'))
    const r = await inW2(() => runRule(rule.id, 'w2-c-it'))
    expect(r.actionResults[0]).toMatchObject({ ok: true, output: { campaignId: 'w2-c-it' } })
    expect(await budgetWrites(W2, 'w2-c-it')).toBe(1)
  })
})

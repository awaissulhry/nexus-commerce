/**
 * Group 1 (1b, review finding 2.1) — the anomaly breaker sees the engines.
 *
 * Before: it counted AutomationRuleExecution rows only. One rank-defend tick wrote 514 changes and the breaker
 * reported `actions/h=0`; a runaway engine could never trip it. And its spend signal read the CURRENT UTC hour,
 * which is partial (hourly data lands 1–4 h late), so it compared a fraction of an hour to a full hour's limit.
 *
 * Runs on a disposable real PostgreSQL (PGlite), inside the legacy business.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
// Side work the guard rides or triggers; nothing here is under test.
vi.mock('./ads-sync-integrity.service.js', () => ({ runSyncIntegrityCheck: vi.fn(async () => undefined) }))
vi.mock('./ads-automation-notify.service.js', () => ({ notifyAutomation: vi.fn(async () => undefined) }))

const { runAnomalyGuardOnce, anomalyGuardSummary } = await import('./ads-anomaly-guard.service.js')

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const HOUR = 3_600_000

beforeAll(async () => {
  database = await formulaDatabase()
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)

beforeEach(async () => {
  delete process.env.NEXUS_ADS_ENGINE_CAPS
  await inside(async () => {
    await database.client.advertisingActionLog.deleteMany({})
    await database.client.amazonAdsHourlyPerformance.deleteMany({})
    await database.client.automationRule.deleteMany({})
    await database.client.adsAutomationState.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', autonomy: 'AUTO' },
      update: { autonomy: 'AUTO', halted: false, haltReason: null, haltedBy: null, maxActionsPerHour: null, maxHourlySpendCentsEur: null },
    })
  })
})

/** `n` action-log rows by one actor, `minutesAgo` before `now`. */
async function writes(userId: string | null, n: number, opts: { minutesAgo?: number; actionType?: string; now?: Date } = {}) {
  const at = new Date((opts.now ?? new Date()).getTime() - (opts.minutesAgo ?? 5) * 60_000)
  await inside(() => database.client.advertisingActionLog.createMany({
    data: Array.from({ length: n }, (_, i) => ({
      userId, actionType: opts.actionType ?? 'AD_BID_UPDATE', entityType: 'AD_TARGET', entityId: `t-${i}`,
      payloadBefore: {}, payloadAfter: {}, createdAt: at,
    })),
  }))
}

const run = (now?: Date) => inside(() => runAnomalyGuardOnce(now ? { now } : {}))
const state = () => inside(() => database.client.adsAutomationState.findUnique({ where: { id: 'singleton' } }))
const engine = (r: Awaited<ReturnType<typeof run>>, key: string) => r.engineWritesLastHour.find((e) => e.engine === key)!

describe('the breaker counts engine writes per engine', () => {
  it('THE REGRESSION: rank-defend past its hourly limit trips the account, and the reason names it with the count', async () => {
    await writes('automation:rank-defend-s1', 900)
    await writes('automation:rank-plan-p1', 301)
    const r = await run()
    expect(r.tripped).toBe(true)
    expect(r.reason).toBe('Rank & Dayparting made 1,201 ad changes in the last hour (limit 1,200 an hour).')
    expect(engine(r, 'rank-defend')).toMatchObject({ writes: 1_201, limit: 1_200 })
    const s = await state()
    expect(s).toMatchObject({ halted: true, haltedBy: 'auto:anomaly-guard', haltReason: r.reason })
    expect(anomalyGuardSummary(r)).toContain('busiest-engine/h=rank-defend:1201/1200')
  })

  it("the 514-change morning tick does not trip, and the rule signal stays rule-only", async () => {
    await writes('automation:rank-defend-s1', 514)
    const r = await run()
    expect(r.tripped).toBe(false)
    expect(r.actionsLastHour).toBe(0) // engine writes are never added to the rule-action count
    expect(engine(r, 'rank-defend').writes).toBe(514)
    expect((await state())!.halted).toBe(false)
  })

  it('only the last 60 minutes count', async () => {
    await writes('automation:rank-defend-s1', 1_000, { minutesAgo: 70 })
    await writes('automation:rank-defend-s1', 300, { minutesAgo: 10 })
    const r = await run()
    expect(r.tripped).toBe(false)
    expect(engine(r, 'rank-defend').writes).toBe(300)
  })

  it('each engine has its own limit: 101 pool changes trip, 1,000 rank changes do not', async () => {
    await writes('automation:rank-defend-s1', 1_000)
    await writes('automation:budget-pool-rebalance', 101)
    const r = await run()
    expect(r.tripped).toBe(true)
    expect(r.reason).toBe('Budget pools made 101 ad changes in the last hour (limit 100 an hour).')
  })

  it('the env override sets an engine limit', async () => {
    process.env.NEXUS_ADS_ENGINE_CAPS = JSON.stringify({ 'rank-defend': { breakerPerHour: 400 } })
    await writes('automation:rank-defend-s1', 401)
    const r = await run()
    expect(r.tripped).toBe(true)
    expect(r.reason).toContain('(limit 400 an hour)')
  })
})

describe('writes no engine or rule claims count as unknown', () => {
  it('no author, "system" and an unclaimed automation actor add up under unknown and trip at its limit', async () => {
    await writes(null, 150)
    await writes('system', 100)
    await writes('automation:something-new', 51)
    const r = await run()
    expect(engine(r, 'unknown').writes).toBe(301)
    expect(r.tripped).toBe(true)
    expect(r.reason).toBe('301 ad changes in the last hour came from no known automation (limit 300 an hour).')
  })

  it('not counted: rules (own brakes), people, person-started one-shots, and rows that record no change', async () => {
    const rule = await inside(() => database.client.automationRule.create({
      data: { name: 'TEST rule', domain: 'advertising', trigger: 'SCHEDULE', conditions: [], actions: [] },
    }))
    await writes(`automation:${rule.id}`, 400)
    await writes('user:u1', 2_000)
    await writes('automation:resync-bids', 2_000)
    await writes('automation:dayparting-delete', 50)
    await writes(null, 500, { actionType: 'coverage_engine_observe' })
    await writes(null, 10, { actionType: 'reconcile_verification' })
    const r = await run()
    expect(r.tripped).toBe(false)
    expect(r.engineWritesLastHour.every((e) => e.writes === 0)).toBe(true)
    expect(r.actionsLastHour).toBe(0)
  })
})

describe('the spend signal reads the latest COMPLETE hour with data', () => {
  // Pinned to 10:30 UTC so the hour arithmetic never straddles a boundary mid-test.
  const now = new Date()
  now.setUTCHours(10, 30, 0, 0)
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const spend = (hour: number, euros: number) => inside(() => database.client.amazonAdsHourlyPerformance.create({
    data: {
      profileId: 'p1', marketplace: 'IT', adProduct: 'SP', date: day, hour, entityType: 'CAMPAIGN', entityId: `c-${hour}`,
      costMicros: BigInt(Math.round(euros * 1_000_000)), currencyCode: 'EUR', reportedAt: now,
    },
  }))

  it('ignores the partial current hour and trips on the last ended hour, naming it', async () => {
    await spend(10, 9_000) // the current hour: partial, never read
    await spend(9, 600)
    const r = await run(now)
    expect(r.spendLastHourCents).toBe(60_000)
    expect(r.spendHour).toBe(new Date(day.getTime() + 9 * HOUR).toISOString())
    expect(r.tripped).toBe(true)
    expect(r.reason).toBe('Ad spend was €600 in the hour from 09:00 UTC (limit €500 an hour).')
  })

  it('when the last hours have no data yet, it reads the newest ended hour that does', async () => {
    await spend(7, 120)
    await spend(6, 900) // older than the newest hour with data: not read
    const r = await run(now)
    expect(r.spendHour).toBe(new Date(day.getTime() + 7 * HOUR).toISOString())
    expect(r.spendLastHourCents).toBe(12_000)
    expect(r.tripped).toBe(false)
  })

  it('data older than the look-back reads as no data, not as this hour', async () => {
    await spend(2, 5_000)
    const r = await run(now)
    expect(r.spendHour).toBeNull()
    expect(r.spendLastHourCents).toBe(0)
    expect(r.tripped).toBe(false)
  })
})

describe('already stopped', () => {
  it('reports the counts and trips nothing', async () => {
    await inside(() => database.client.adsAutomationState.update({ where: { id: 'singleton' }, data: { halted: true, haltReason: 'TEST' } }))
    await writes('automation:rank-defend-s1', 2_000)
    const r = await run()
    expect(r).toMatchObject({ tripped: false, alreadyStopped: true })
    expect(engine(r, 'rank-defend').writes).toBe(2_000)
    expect((await state())!.haltReason).toBe('TEST')
  })
})

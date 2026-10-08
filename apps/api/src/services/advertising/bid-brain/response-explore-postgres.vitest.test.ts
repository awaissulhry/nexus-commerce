/**
 * BID BRAIN BB-19 — the bid response on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business profiles
 * ON). Its reads — the clean moves found with LAG / LEAD over the bid history, the matched clicks, the move days of the
 * ad group, the top-of-search share joined through the campaign, the budget-capped days — run as production runs them.
 *
 *   off       NEXUS_BID_BRAIN_RESPONSE=off reads nothing and says nothing
 *   shadow    every decision is the off run's, byte for byte (action, layer, bids, goal bid, step); the stored why of each
 *             goal decision gains " · profit-best …" with ε and the marginal ACoS, `evidence.response` the numbers, the
 *             run's line the count; the one clean move is read (the nightly floor toggles are not), the campaign's
 *             top-of-search share leans ε, its capped days say "budget capped"
 *   business  another business reads none of it
 *
 * Values are made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => Reflect.get(database.client, key) }) }))
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

const { runShadowOnce, shadowSummaryLine } = await import('./shadow.js')
const { loadMoveEvents, loadCampaignSignals } = await import('./response-explore.js')

const W = `bb19_resp_${randomBytes(4).toString('hex')}`
const OTHER = `bb19_other_${randomBytes(4).toString('hex')}`
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, w = W) => withWorkspace(business(w), work)
const NOW = new Date('2026-10-07T12:50:00Z')
const DAY = 86_400_000
const HOUR = 3_600_000
const midnight = (t: number) => new Date(Math.floor(t / DAY) * DAY)
/** The settled window's newest day for NOW (7 days settled). */
const DATA_DAY = '2026-09-30'
const MOVE_DAY = Date.UTC(2026, 8, 10)

interface Row { targetId: string; action: string; layer: string; currentCents: number; decidedCents: number; goalBidCents: number | null; why: string; dataDay: string; step: unknown; response: Record<string, unknown> | null }
const decisions = () => inside(async () => (await database.client.bidBrainDecision.findMany({ orderBy: { targetId: 'asc' } })).map((d) => {
  const e = (d.evidence ?? {}) as { step?: unknown; response?: Record<string, unknown> }
  return {
    targetId: d.targetId, action: d.action, layer: d.layer, currentCents: d.currentCents, decidedCents: d.decidedCents, goalBidCents: d.goalBidCents,
    why: d.why, dataDay: d.dataDay.toISOString().slice(0, 10), step: e.step ?? null, response: e.response ?? null,
  }
}) as Row[])
const clearDecisions = () => inside(() => database.client.bidBrainDecision.deleteMany({}))
const core = (r: Row) => ({ targetId: r.targetId, action: r.action, layer: r.layer, currentCents: r.currentCents, decidedCents: r.decidedCents, goalBidCents: r.goalBidCents, dataDay: r.dataDay, step: r.step })

/** Two more keywords in the Italian ad group: one that moved once, one that never moved (the control). */
async function seedKeywords() {
  await database.client.adTarget.create({ data: { id: 't-mv', adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'touring jacket', bidCents: 25, externalTargetId: 'EXT-t-mv' } })
  await database.client.adTarget.create({ data: { id: 't-ctl', adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'summer jacket', bidCents: 30, externalTargetId: 'EXT-t-ctl' } })
}

/** 60 settled days of the keywords; t-mv's clicks rise from 10 to 13 a day after its 20 → 25¢ move on 09-10. */
async function seedDays() {
  const data = []
  const row = (target: string, date: Date, clicks: number, orders: number) => data.push({
    profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date, entityType: 'AD_TARGET', entityId: `EXT-${target}`, localEntityId: target,
    impressions: clicks * 40, clicks, costMicros: BigInt(clicks * 200_000), currencyCode: 'EUR', orders7d: orders, sales7dCents: orders * 8000,
    reportedAt: new Date(date.getTime() + 8 * DAY + 2 * HOUR),
  })
  for (let i = 7; i <= 66; i++) {
    const date = midnight(NOW.getTime() - i * DAY)
    row('t-it', date, 8, i % 5 === 0 ? 1 : 0)
    row('t-ctl', date, 20, i % 10 === 0 ? 1 : 0)
    row('t-mv', date, date.getTime() > MOVE_DAY ? 13 : 10, i % 9 === 0 ? 1 : 0)
  }
  await database.client.amazonAdsDailyPerformance.createMany({ data })
  // The campaign: its budget reached on 4 of the last 7 settled days.
  const days = []
  for (let i = 0; i < 7; i++) {
    const date = new Date(Date.parse(`${DATA_DAY}T00:00:00Z`) - i * DAY)
    days.push({
      profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date, entityType: 'CAMPAIGN', entityId: 'EXT-c-it', localEntityId: 'c-it',
      clicks: 40, costMicros: BigInt((i < 4 ? 1990 : 1000) * 10_000), currencyCode: 'EUR', campaignBudgetCents: 2000, reportedAt: new Date(date.getTime() + 8 * DAY),
    })
  }
  await database.client.amazonAdsDailyPerformance.createMany({ data: days })
  // Top of search: 62 % of the campaign's eligible impressions over the last 14 settled days (the placement report's TOP row).
  const tos = []
  for (let i = 0; i < 14; i++) {
    tos.push({ profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(Date.parse(`${DATA_DAY}T00:00:00Z`) - i * DAY), campaignId: 'EXT-c-it', placement: 'Top of Search on-Amazon', impressions: 500, clicks: 10, costMicros: BigInt(2_000_000), currencyCode: 'EUR', topOfSearchIS: 0.62 })
  }
  await database.client.amazonAdsPlacementReport.createMany({ data: tos })
}

/** The bid history: t-mv's one clean move, and t-it's nightly floor toggles (sub-floor: never a move). */
async function seedHistory() {
  const rows = [{ entityType: 'AD_TARGET', entityId: 't-mv', field: 'bid', oldValue: '20', newValue: '25', changedAt: new Date(MOVE_DAY + 10 * HOUR), changedBy: 'user:test' }]
  for (let i = 8; i <= 40; i++) {
    const night = midnight(NOW.getTime() - i * DAY).getTime()
    rows.push({ entityType: 'AD_TARGET', entityId: 't-it', field: 'bid', oldValue: '45', newValue: '3', changedAt: new Date(night + 22 * HOUR), changedBy: 'automation:rank-defend-x' })
    rows.push({ entityType: 'AD_TARGET', entityId: 't-it', field: 'bid', oldValue: '3', newValue: '45', changedAt: new Date(night + 30 * HOUR), changedBy: 'automation:rank-defend-x' })
  }
  await database.client.campaignBidHistory.createMany({ data: rows })
}

describe.skipIf(!concurrentDatabaseUrl())('BB-19 — the bid response (real PostgreSQL)', { timeout: 120_000 }, () => {
  let offRows: Row[] = []

  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_NOWCAST', 'off')
    vi.stubEnv('NEXUS_BID_BRAIN_EXPLORE', 'off')
    database = await concurrentDatabase()
    for (const id of [W, OTHER]) {
      await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [id])
    }
    await inside(async () => {
      await seedAdsFixture(database.client)
      await seedKeywords()
      await seedDays()
      await seedHistory()
      // GROW needs no break-even: its profit-best bid is the highest whose marginal ACoS stays at the band top.
      await database.client.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', targetKind: 'ACOS', targetPct: 20, targetLoPct: 18, targetHiPct: 28, maxBidCents: 80, maxChangePct: 25, goal: 'GROW', updatedBy: 'user:test' } })
    })
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('the loaders read the one clean move with its matched days and control, the top-of-search share and the capped days', async () => {
    const events = await inside(async () => {
      const targets = await database.client.adTarget.findMany({ where: { adGroupId: 'g-c-it', isNegative: false }, select: { id: true, adGroupId: true, kind: true, expressionType: true, expressionValue: true, bidCents: true, suppressedFromBidCents: true } })
      return loadMoveEvents({ dataDay: DATA_DAY, targets, adGroups: new Map([['g-c-it', { id: 'g-c-it', campaignId: 'c-it', status: 'ENABLED', bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null, families: [] }]]) })
    })
    // t-it's floor toggles (45 ↔ 3¢) are no serving move, and its every-night moves keep it out of the control.
    expect(events).toEqual([{ targetId: 't-mv', productKey: null, beforeCents: 20, afterCents: 25, days: 7, clicksBefore: 70, clicksAfter: 91, control: { before: 140, after: 140 } }])
    const signals = await inside(() => loadCampaignSignals(['c-it', 'c-pin'], DATA_DAY))
    expect(signals.get('c-it')).toEqual({ tosShare: 0.62, tosDays: 14, cappedDays: 4 })
    expect(signals.has('c-pin')).toBe(false)
  })

  it('off reads nothing and says nothing', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_RESPONSE', 'off')
    const run = await inside(() => runShadowOnce({ now: NOW, mode: 'shadow' }))
    offRows = await decisions()
    expect(run.markets.find((m) => m.market === 'IT')).toMatchObject({ decided: 6 })
    expect(run.markets.find((m) => m.market === 'IT')!.upgrades).toBeUndefined()
    expect(offRows.every((r) => r.dataDay === DATA_DAY && !r.why.includes('profit-best') && r.response == null)).toBe(true)
    expect(shadowSummaryLine(run)).not.toMatch(/profit-best/)
  })

  it('shadow keeps every decision byte for byte and logs the profit-best bid, ε and the marginal ACoS beside the goal\'s', async () => {
    await clearDecisions()
    vi.stubEnv('NEXUS_BID_BRAIN_RESPONSE', 'shadow')
    const run = await inside(() => runShadowOnce({ now: NOW, mode: 'shadow' }))
    const rows = await decisions()
    expect(rows.map(core)).toEqual(offRows.map(core))
    const it = run.markets.find((m) => m.market === 'IT')!
    expect(it.upgrades?.response).toMatchObject({ moves: 1 })
    expect(it.upgrades!.response!.compared).toBeGreaterThan(0)
    expect(shadowSummaryLine(run)).toMatch(/profit-best: \d+ compared \(\d+ higher, \d+ lower, \d+ same, \d+ none\), 1 clean move/)
    const goalRows = rows.filter((r) => ['goal', 'band', 'limit'].includes(r.layer) && r.goalBidCents != null)
    expect(goalRows.length).toBeGreaterThan(0)
    for (const r of goalRows) {
      expect(r.why, r.targetId).toMatch(/ · profit-best \d+¢ beside the goal's \d+¢ \(in band \d+¢.*ε [\d.]+ ± [\d.]+, 1 in the market; top-of-search share 62% → inelastic; budget capped; marginal ACoS [\d.]+% at \d+¢/)
      expect(r.response, r.targetId).toMatchObject({ capped: true, epsFrom: '1 in the market; top-of-search share 62% → inelastic', goalBidCents: r.goalBidCents })
      expect(typeof r.response!.bidCents).toBe('number')
      // A capped campaign's profit-best point never rises above today's bid, unless the Owner's band bottom holds it there.
      expect((r.response!.bestCents as number) <= r.currentCents || /held to the band bottom/.test(r.why), r.why).toBe(true)
    }
    // An override's decision (the stopped keyword) gets no note.
    expect(rows.find((r) => r.targetId === 't-sup')!.why).not.toMatch(/profit-best/)
  })

  it('another business reads none of it', async () => {
    const [events, signals] = await inside(async () => [
      await loadMoveEvents({ dataDay: DATA_DAY, targets: [{ id: 't-mv', adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'touring jacket', bidCents: 25, suppressedFromBidCents: null }], adGroups: new Map() }),
      await loadCampaignSignals(['c-it'], DATA_DAY),
    ] as const, OTHER)
    expect(events).toEqual([])
    expect(signals.size).toBe(0)
  })
})

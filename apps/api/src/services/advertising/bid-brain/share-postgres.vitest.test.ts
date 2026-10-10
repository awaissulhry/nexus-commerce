/**
 * LANE 5 (2026-10-10) — the target top-of-search impression share on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business profiles
 * ON), the bid brain in shadow (its default) and the job queue a stub. share-load.ts reads as production reads: the
 * Owner's tosTargetPct overrides, the keyword's AD_TARGET rows and its campaign's CAMPAIGN rows of
 * AmazonAdsDailyPerformance, and the last share move from the stored decisions (evidence.share.lastMove, jsonb).
 *
 *   off      no target anywhere: nothing more is read, and the run stores exactly what it stored before
 *   target   the campaign's 40 % over a keyword-grain reading of 20 % (4 days, 800 impressions): the keyword's decision is
 *            layer share, one step up, its evidence the reading and the move; a rerun the same day waits (no second move)
 *   keyword  the keyword's own empty value wins over the campaign's: off for that keyword; a budget-capped reading day
 *            moves nothing and the goal's why says so
 *   business another business's override on a campaign id of the same spelling is never read
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

const { runShadowOnce } = await import('./shadow.js')
const { loadMarket, loadOverrideSources } = await import('./load.js')
const { loadShare } = await import('./share-load.js')

const W = `lane5_share_${randomBytes(4).toString('hex')}`
const OTHER = `lane5_other_${randomBytes(4).toString('hex')}`
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, w = W) => withWorkspace(business(w), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const DAY = 86_400_000
const HOUR = 3_600_000
/** The newest 06:50 UTC not after the real clock (a full run's slot). */
const NOW = (() => { const real = Date.now(); const t = Math.floor(real / DAY) * DAY + 6 * HOUR + 50 * 60_000; return new Date(t > real ? t - DAY : t) })()
const TODAY = new Date(Math.floor(NOW.getTime() / DAY) * DAY)
const dayIso = (d: Date) => d.toISOString().slice(0, 10)
const daysAgo = (k: number) => new Date(TODAY.getTime() - k * DAY)

interface Row { targetId: string; action: string; layer: string; currentCents: number; decidedCents: number; why: string; share: Record<string, unknown> | null }
const decisions = (targetId = 't-it') => rows<Row>('SELECT "targetId", action, layer, "currentCents", "decidedCents", why, evidence -> \'share\' AS share FROM "BidBrainDecision" WHERE "workspaceId" = $1 AND "targetId" = $2 ORDER BY "createdAt", id', [W, targetId])
const reset = () => database.pool.query('DELETE FROM "BidBrainDecision" WHERE "workspaceId" = $1', [W])
const override = (data: Record<string, unknown>, w = W) => inside(() => database.client.adsBrainOverride.create({ data: { productId: '', marketplace: 'IT', scope: 'CAMPAIGN', campaignId: 'c-it', kind: 'VALUE', key: 'tosTargetPct', by: 'user:owner', ...data } }), w)
const endAll = () => database.pool.query('UPDATE "AdsBrainOverride" SET "endedAt" = now(), "endedBy" = \'user:owner\' WHERE "workspaceId" = $1 AND "endedAt" IS NULL', [W])

describe.skipIf(!concurrentDatabaseUrl())('Lane 5 — the target top-of-search impression share (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    vi.stubEnv('NEXUS_BID_BRAIN_NOWCAST', 'off')
    vi.stubEnv('NEXUS_BID_BRAIN_INTRADAY', 'off')
    database = await concurrentDatabase()
    for (const w of [W, OTHER]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inside(async () => {
      const db = database.client
      await seedAdsFixture(db)
      // t-it: 37 settled days of evidence; the last 4 carry Amazon's keyword-grain share, 20 % on 200 impressions each.
      const target = []
      for (let i = 1; i < 38; i++) {
        target.push({
          profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: daysAgo(i), entityType: 'AD_TARGET', entityId: 'EXT-t-it', localEntityId: 't-it',
          impressions: 200, clicks: 6, costMicros: BigInt(6 * 300_000), currencyCode: 'EUR', orders7d: 1, sales7dCents: 8000, reportedAt: new Date(NOW.getTime() - HOUR),
          ...(i <= 4 ? { topOfSearchIS: '0.2000' } : {}),
        })
      }
      // c-it's own days: a 20 € budget, 5 € spent (not capped), its campaign share beside.
      const campaign = [1, 2, 3, 4].map((i) => ({
        profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: daysAgo(i), entityType: 'CAMPAIGN', entityId: 'EXT-c-it', localEntityId: 'c-it',
        impressions: 900, clicks: 20, costMicros: BigInt(500 * 10_000), currencyCode: 'EUR', campaignBudgetCents: 2000, topOfSearchIS: '0.3500', reportedAt: new Date(NOW.getTime() - HOUR),
      }))
      await db.amazonAdsDailyPerformance.createMany({ data: [...target, ...campaign] })
      await db.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', targetKind: 'ACOS', targetPct: 20, maxBidCents: 80, maxChangePct: 25, goal: 'PROFIT', updatedBy: 'user:test' } })
    })
    await inside(() => seedAdsFixture(database.client, { prefix: 'o-' }), OTHER)
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('no target anywhere: nothing read, and every stored decision as before (no share in its evidence)', async () => {
    expect(await inside(async () => loadShare(await loadMarket('IT', { now: NOW }), NOW))).toBeUndefined()
    await inside(() => runShadowOnce({ now: NOW, mode: 'shadow' }))
    const [d] = await decisions()
    expect(d).toMatchObject({ layer: 'goal', action: 'write', currentCents: 45, share: null })
    expect(d.why).not.toMatch(/share:/)
    await reset()
  })

  it('the campaign\'s 40 % over a 20 % keyword reading: one step up as layer share, the move stored; a rerun the same day waits', async () => {
    await override({ value: 40 })
    const facts = await inside(async () => loadShare(await loadMarket('IT', { now: NOW }), NOW))
    expect(facts!.get('t-it')).toEqual({
      targetPct: 40, targetBy: expect.stringMatching(/^the Owner's campaign override \(user:owner, \d{4}-\d{2}-\d{2}\)$/),
      reading: { pct: expect.closeTo(20, 6), grain: 'keyword', days: 4, impressions: 800, from: dayIso(daysAgo(4)), to: dayIso(daysAgo(1)) },
      held: null, waiting: false, lastMove: null,
    })
    // t-low has no reading at all: it holds nothing, and says so.
    expect(facts!.get('t-low')).toMatchObject({ reading: null, waiting: false, held: expect.stringMatching(/^no top-of-search impression share reading/) })

    await inside(() => runShadowOnce({ now: NOW, mode: 'shadow' }))
    const [first] = await decisions()
    expect(first).toMatchObject({ action: 'write', layer: 'share', currentCents: 45, decidedCents: 50 })
    expect(first.why).toMatch(/^share: target top-of-search impression share 40% \(the Owner's campaign override .+\): top-of-search impression share 20% \(computed by Nexus: the impression-weighted average of Amazon's daily shares, keyword grain, 4 reading days .+, 800 impressions\) is below the target by more than 5 points → raise ≤10%: 45¢ → 50¢/)
    expect(first.why).not.toMatch(/rank|position/i)
    expect(first.share).toMatchObject({ targetPct: 40, held: null, lastMove: { moveDay: dayIso(TODAY), fromCents: 45, toCents: 50, readingTo: dayIso(daysAgo(1)) } })

    // Shadow wrote nothing at Amazon: the bid is still 45¢. A rerun an hour later reads the move back and waits.
    const later = new Date(NOW.getTime() + HOUR)
    expect((await inside(async () => loadShare(await loadMarket('IT', { now: later }), later)))!.get('t-it')).toMatchObject({ waiting: true, lastMove: { fromCents: 45, toCents: 50 } })
    await inside(() => runShadowOnce({ now: later, mode: 'shadow' }))
    const all = await decisions()
    expect(all).toHaveLength(2)
    expect(all[1]).toMatchObject({ action: 'hold', layer: 'share', decidedCents: 45, share: { waiting: true, lastMove: { moveDay: dayIso(TODAY), toCents: 50 } } })
    expect(all[1].why).toMatch(/waits for 2 reading days after its share move on .+ \(45¢ → 50¢\) \(0 so far\)/)
    await reset()
  })

  it('the keyword\'s own empty value wins (off for it); a budget-capped reading day moves nothing and the goal says why', async () => {
    const own = await override({ ref: 'target:t-it', value: null, by: 'user:owner-2' })
    await inside(() => runShadowOnce({ now: NOW, mode: 'shadow' }))
    expect((await decisions())[0]).toMatchObject({ layer: 'goal', share: null })
    await reset()
    await inside(() => database.client.adsBrainOverride.update({ where: { id: own.id }, data: { endedAt: new Date(), endedBy: 'user:owner-2' } }))

    // Yesterday the campaign spent 97.5 % of its made-up budget: the budget held the share, not the bid.
    await database.pool.query('UPDATE "AmazonAdsDailyPerformance" SET "costMicros" = 195000000 WHERE "workspaceId" = $1 AND "entityType" = \'CAMPAIGN\' AND date = $2', [W, daysAgo(1)])
    await inside(() => runShadowOnce({ now: NOW, mode: 'shadow' }))
    const [d] = await decisions()
    expect(d).toMatchObject({ layer: 'goal', action: 'write', share: { lastMove: null, held: expect.stringMatching(/spent at least 95 % of its budget on/) } })
    expect(d.why).toMatch(/ · share: target top-of-search impression share 40% .+: no share move — the campaign spent at least 95 % of its budget on \d{4}-\d{2}-\d{2}: the budget, not the bid, held the share; top-of-search impression share 20%/)
    await database.pool.query('UPDATE "AmazonAdsDailyPerformance" SET "costMicros" = 5000000 WHERE "workspaceId" = $1 AND "entityType" = \'CAMPAIGN\'', [W])
    await reset()
    await endAll()
  })

  it('review fix — a floor after a share move gives back the share\'s bid, not the bid before it', async () => {
    const base = { runId: 'run-gb', mode: 'LIVE', kind: 'bid', marketplace: 'IT', campaignId: 'c-gb', targetId: 't-gb', dataDay: daysAgo(1), why: 'test' }
    const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR)
    await inside(async () => {
      await database.client.bidBrainDecision.create({ data: { ...base, action: 'write', layer: 'goal', currentCents: 40, decidedCents: 40, createdAt: at(3) } })
      await database.client.bidBrainDecision.create({ data: { ...base, action: 'write', layer: 'share', currentCents: 40, decidedCents: 44, createdAt: at(2) } })
      await database.client.bidBrainDecision.create({ data: { ...base, action: 'write', layer: 'stop', currentCents: 44, decidedCents: 3, createdAt: at(1) } })
    })
    const previous = new Map([['t-gb', { action: 'write', layer: 'stop', currentCents: 44, decidedCents: 3, createdAt: at(1), lastStep: null }]])
    const out = await inside(() => loadOverrideSources({ adGroups: new Map(), campaigns: new Map() } as never, { campaignIds: [], groupIds: [], strategy: new Map(), previous, marketplaces: [] }))
    expect(out.lowered.get('t-gb')).toMatchObject({ layer: 'stop', heldCents: 3, beforeCents: 44, wrote: true })
    await reset()
  })

  it('another business\'s override on a campaign id spelled the same is never read', async () => {
    await override({ value: 60 }, OTHER)
    expect(await inside(async () => loadShare(await loadMarket('IT', { now: NOW }), NOW))).toBeUndefined()
    await inside(() => runShadowOnce({ now: NOW, mode: 'shadow' }))
    expect((await decisions())[0]).toMatchObject({ layer: 'goal', share: null })
    await reset()
  })
})

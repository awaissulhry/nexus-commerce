/**
 * BID BRAIN BB-10 — the auto-undo hook on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, business profiles ON), the server switch `live`, the ads
 * mode LIVE (the real write gate) and the job queue a stub.
 *
 *   event      a run that wrote publishes ONE ads.bid-brain.run-completed to the outbox: the campaign and each queued
 *              bid with the action-log row auto-undo judges; a run that wrote nothing publishes nothing
 *   hold       holdCampaigns: LIVE → HELD until a date (the later end wins, a SHADOW campaign is left out); the brain
 *              then raises nothing there; releaseHold: HELD → LIVE
 *   undo       a brain change a person's approved undo puts back (runJudgedUndo) holds its campaign for 7 days, as the
 *              approver; the brain itself never undoes
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
const { holdCampaigns, releaseHold, setEnrollment } = await import('./enrollment.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')
const { runJudgedUndo, holdBrainAfterUndo, AUTO_UNDO_ACTOR, BRAIN_HOLD_AFTER_UNDO_DAYS } = await import('../ads-auto-undo.service.js')
const { reverseJudgedWrite } = await import('../rollback.service.js')

const W = `bb10_hook_${randomBytes(4).toString('hex')}`
const business = { workspaceId: W, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const NOW = new Date()
const DAY = 86_400_000
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)
const events = () => rows<{ payload: { runId: string; mode: string; campaignIds: string[]; writes: Array<{ actionLogId: string | null; entityId: string; field: string; from: number; to: number }> } }>(
  'SELECT payload FROM "EventOutbox" WHERE "workspaceId" = $1 AND type = \'ads.bid-brain.run-completed\' ORDER BY "occurredAt"', [W])

describe.skipIf(!concurrentDatabaseUrl())('BB-10 — the bid brain\'s auto-undo hook (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    database = await concurrentDatabase()
    await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [W])
    await inside(async () => {
      const db = database.client
      await seedAdsFixture(db)
      const data = []
      for (let i = 1; i < 38; i++) {
        data.push({
          profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(NOW.getTime() - i * DAY), entityType: 'AD_TARGET',
          entityId: 'EXT-t-it', localEntityId: 't-it', clicks: 6, costMicros: BigInt(6 * 300_000), currencyCode: 'EUR', orders7d: 1, sales7dCents: 8000, reportedAt: new Date(NOW.getTime() - 3_600_000),
        })
      }
      await db.amazonAdsDailyPerformance.createMany({ data })
      await db.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', targetKind: 'ACOS', targetPct: 20, maxBidCents: 80, maxChangePct: 25, goal: 'PROFIT', updatedBy: 'user:test' } })
      await setAutonomy('AUTO', 'test')
      await setEnrollment({ campaignId: 'c-it', marketplace: 'IT', op: 'live', by: 'user:test', now: NOW })
    })
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('a run that wrote publishes one run-completed event with each bid and its action-log row; a run that wrote nothing, none', async () => {
    const r = await inside(() => runShadowOnce({ now: at(1), mode: 'live' }))
    const queued = r.markets.find((m) => m.market === 'IT')!.writes!.queued
    expect(queued).toBeGreaterThan(0)
    const [e, ...more] = await events()
    expect(more).toEqual([])
    expect(e.payload).toMatchObject({ runId: r.runId, mode: 'live', campaignIds: ['c-it'] })
    expect(e.payload.writes).toHaveLength(queued)
    const logs = await rows<{ id: string; entityId: string }>('SELECT id, "entityId" FROM "AdvertisingActionLog" WHERE "workspaceId" = $1 AND "userId" = \'automation:bid-brain\'', [W])
    expect(e.payload.writes.map((w) => [w.actionLogId, w.entityId]).sort()).toEqual(logs.map((l) => [l.id, l.entityId]).sort())
    await inside(() => runShadowOnce({ now: at(2), mode: 'live' }))
    expect(await events()).toHaveLength(1)
  })

  it('holdCampaigns and releaseHold: the later end wins, a shadow campaign is left out, a held campaign gets no raise', async () => {
    const until = new Date(NOW.getTime() + 3 * DAY)
    expect(await inside(() => holdCampaigns({ campaignIds: ['c-it', 'c-uk'], until, by: 'automation:auto-undo', reason: 'test' }))).toEqual(['c-it'])
    expect(await inside(() => holdCampaigns({ campaignIds: ['c-it'], until: new Date(NOW.getTime() + DAY), by: 'automation:other', reason: 'shorter' }))).toEqual([])
    // Read through the client: a raw pg read takes this timestamp column as the machine's local time.
    const row = (await inside(() => database.client.bidBrainEnrollment.findFirst({ where: { campaignId: 'c-it' }, select: { mode: true, heldBy: true, heldUntil: true } })))!
    expect(row).toMatchObject({ mode: 'HELD', heldBy: 'automation:auto-undo' })
    expect(row.heldUntil!.getTime()).toBe(until.getTime())
    // Held: t-it's bid is set back below the goal; the brain does not raise it.
    await database.pool.query('UPDATE "AdTarget" SET "bidCents" = 20 WHERE id = \'t-it\'')
    await inside(() => runShadowOnce({ now: at(3), mode: 'live' }))
    expect((await rows<{ b: number }>('SELECT "bidCents" b FROM "AdTarget" WHERE id = \'t-it\''))[0].b).toBe(20)
    // Review — HELD is a raise cap inside the goal path (not a freeze): the raise waits, and says why.
    const [last] = await rows<{ layer: string; action: string; why: string }>('SELECT layer, action, why FROM "BidBrainDecision" WHERE "targetId" = \'t-it\' ORDER BY "createdAt" DESC LIMIT 1')
    expect(last).toMatchObject({ layer: 'goal', action: 'hold' })
    expect(last.why).toMatch(/^goal: raise held — the campaign is held by automation:auto-undo/)
    // A hold whose end has passed is held anew: the new holder and reason.
    await inside(() => database.client.bidBrainEnrollment.updateMany({ where: { campaignId: 'c-it' }, data: { heldUntil: new Date(NOW.getTime() - DAY) } }))
    expect(await inside(() => holdCampaigns({ campaignIds: ['c-it'], until, by: 'automation:later', reason: 'again' }))).toEqual(['c-it'])
    expect((await inside(() => database.client.bidBrainEnrollment.findFirst({ where: { campaignId: 'c-it' }, select: { heldBy: true } })))?.heldBy).toBe('automation:later')
    expect(await inside(() => releaseHold({ campaignIds: ['c-it', 'c-uk'], by: 'user:test' }))).toEqual(['c-it'])
    expect(await rows('SELECT mode, "heldUntil" FROM "BidBrainEnrollment" WHERE "campaignId" = \'c-it\'')).toEqual([{ mode: 'LIVE', heldUntil: null }])
  })

  it('a brain change a person\'s approved undo puts back holds its campaign for 7 days, as the approver', async () => {
    // The brain raises t-it again (from the 20¢ the last test left), then a person approves auto-undo's request.
    await inside(() => runShadowOnce({ now: at(4), mode: 'live' }))
    const [log] = await rows<{ id: string; before: number; after: number }>(
      'SELECT id, ("payloadBefore" ->> \'bidCents\')::int AS before, ("payloadAfter" ->> \'bidCents\')::int AS after FROM "AdvertisingActionLog" WHERE "entityId" = \'t-it\' AND "userId" = \'automation:bid-brain\' ORDER BY "createdAt" DESC LIMIT 1')
    expect(log.after).toBeGreaterThan(log.before)
    const judgement = await inside(() => database.client.adsAutoUndoJudgement.create({ data: {
      actionLogId: log.id, actor: 'automation:bid-brain', origin: 'engine', originLabel: 'Bid brain', entityType: 'AD_TARGET', entityId: 't-it', marketplace: 'IT',
      lever: 'bid', direction: 'raise', fromValue: log.before, toValue: log.after, changedAt: NOW, verdict: 'worse', outcome: 'worse', action: 'proposed', level: 'PROPOSE',
    } }))
    const r = await inside(() => runJudgedUndo(judgement.id, { actor: 'user:u-approver', reason: 'approved', manual: true, changeSetId: 'apr-bb10' }))
    expect(r).toMatchObject({ ok: true })
    expect((await rows<{ b: number }>('SELECT "bidCents" b FROM "AdTarget" WHERE id = \'t-it\''))[0].b).toBe(log.before)
    const row = (await inside(() => database.client.bidBrainEnrollment.findFirst({ where: { campaignId: 'c-it' }, select: { mode: true, heldBy: true, heldUntil: true } })))!
    expect(row).toMatchObject({ mode: 'HELD', heldBy: 'user:u-approver' })
    expect(Math.round((row.heldUntil!.getTime() - Date.now()) / DAY)).toBe(BRAIN_HOLD_AFTER_UNDO_DAYS)
    // Review — and the keyword it put back is pinned for 7 days, with the judgement as its reason.
    const pins = await inside(() => database.client.bidHold.findMany({ where: { targetId: 't-it', kind: 'PIN', endedAt: null }, select: { by: true, reason: true } }))
    expect(pins).toEqual([{ by: 'user:u-approver', reason: expect.stringContaining(`judgement ${judgement.id}`) }])
  })

  it('review — an AUTO undo of a brain cut stays: the next ticks do not cut it again', async () => {
    await inside(async () => {
      const db = database.client
      await db.campaign.create({ data: { id: 'c-cut', name: 'Italy cut', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-c-cut', dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true } })
      await db.adGroup.create({ data: { id: 'g-c-cut', campaignId: 'c-cut', name: 'group c-cut', externalAdGroupId: 'EXT-g-c-cut' } })
      await db.adTarget.create({ data: { id: 't-cut', adGroupId: 'g-c-cut', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'cut jacket', bidCents: 40, externalTargetId: 'EXT-t-cut' } })
      await db.amazonAdsDailyPerformance.createMany({ data: Array.from({ length: 37 }, (_, k) => ({
        profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(NOW.getTime() - (k + 1) * DAY), entityType: 'AD_TARGET',
        entityId: 'EXT-t-cut', localEntityId: 't-cut', clicks: 6, costMicros: BigInt(6 * 300_000), currencyCode: 'EUR', orders7d: 1, sales7dCents: 8000, reportedAt: new Date(NOW.getTime() - 3_600_000),
      })) })
      // A 1 % target: the brain cuts 40¢ toward a goal far below it.
      await db.adsStrategy.updateMany({ where: { market: 'IT', level: 'MARKET' }, data: { targetPct: 1 } })
      await setEnrollment({ campaignId: 'c-cut', marketplace: 'IT', op: 'live', by: 'user:test', now: NOW })
    })
    await inside(() => runShadowOnce({ now: at(10), mode: 'live' }))
    const [cut] = await rows<{ id: string; after: number }>('SELECT id, ("payloadAfter" ->> \'bidCents\')::int AS after FROM "AdvertisingActionLog" WHERE "entityId" = \'t-cut\' AND "userId" = \'automation:bid-brain\'')
    expect(cut.after).toBeLessThan(40)
    // Auto-undo at AUTO: its two steps exactly (ads-auto-undo.service.ts undoNow, then holdBrainAfterUndo).
    expect(await inside(() => reverseJudgedWrite({ actionLogId: cut.id, actor: AUTO_UNDO_ACTOR, reason: 'Auto-undo test: clearly worse' }))).toMatchObject({ ok: true })
    await inside(() => holdBrainAfterUndo({ actor: 'automation:bid-brain', entityType: 'AD_TARGET', entityId: 't-cut', by: AUTO_UNDO_ACTOR, why: 'judgement test: clearly worse' }))
    const bid = async () => (await rows<{ b: number }>('SELECT "bidCents" b FROM "AdTarget" WHERE id = \'t-cut\''))[0].b
    // The undo raises the cut back inside auto-undo's own raise limits (the strategy's largest change: 25 %, A19).
    const restored = await bid()
    expect(restored).toBeGreaterThan(cut.after)
    // The next owned tick, and the full run after it: the bid stays where the undo put it (pinned), and says so.
    await inside(() => runShadowOnce({ now: at(11), mode: 'live', onlyOwned: true }))
    await inside(() => runShadowOnce({ now: at(12), mode: 'live' }))
    expect(await bid()).toBe(restored)
    const [last] = await rows<{ layer: string; action: string }>('SELECT layer, action FROM "BidBrainDecision" WHERE "targetId" = \'t-cut\' ORDER BY "createdAt" DESC LIMIT 1')
    expect(last).toEqual({ layer: 'pin', action: 'hold' })
  })
})

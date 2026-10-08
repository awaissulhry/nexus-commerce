/**
 * BID BRAIN BB-6 — the live brain on a real PostgreSQL (the throwaway PostgreSQL 17 of scripts/run-real-postgres-tests.mjs,
 * row-level policies on, the app as the restricted runtime login, business profiles ON), the server switch `live`, the
 * ads mode LIVE (the real write gate judges every write) and the job queue a stub (nothing leaves the process).
 *
 *   shadow     an allowlisted campaign that is not enrolled is decided and stored SHADOW: nothing is written for it
 *   owned      a campaign enrolled LIVE gets exactly the brain's writes: each moving decision queued once, as
 *              automation:bid-brain with its evidence, stored LIVE with what became of it; a rerun on the same evidence
 *              writes nothing
 *   one writer another engine's bid change on the owned campaign is refused by the gate (no local change, no queue row);
 *              a stop's forced lowering passes; a person's own bid passes and becomes a BidHold the brain then leaves
 *   engines    auto-bid's holders name the brain, and the external engine never sees the owned keywords (rules: BB-9's
 *              rule-directives tests)
 *   give-back  the enrollment tool, approved by a person, puts back the bids the campaign had when it went LIVE and
 *              returns it to shadow
 *   big door   going LIVE through the tool needs the approver's authenticator code: a plain approve runs nothing
 *
 * Values are made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
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
const { setEnrollment } = await import('./enrollment.js')
const { BRAIN_ACTOR } = await import('./live.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')
const { updateAdTargetWithSync } = await import('../ads-mutation.service.js')
const { autoBidHolders } = await import('../ads-auto-bid.service.js')
const { getBidContexts } = await import('../bidding-bridge.service.js')
const { decideApproval, runOrQueueTool } = await import('../../agents/approval-gate.service.js')

const W = `bb6_live_${randomBytes(4).toString('hex')}`
const business = { workspaceId: W, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const person = (userId: string, via: 'claude' | 'app') => ({
  kind: 'user' as const, userId, label: `Person ${userId}`, via, workspace: business,
  permissions: { isOwner: false, permissions: new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
})
const NOW = new Date()
const DAY = 86_400_000
const counts = async () => (await rows<{ m: number; q: number; l: number }>(
  'SELECT (SELECT count(*)::int FROM "AdMutation" WHERE "workspaceId" = $1) m, (SELECT count(*)::int FROM "OutboundSyncQueue" WHERE "workspaceId" = $1) q, (SELECT count(*)::int FROM "AdvertisingActionLog" WHERE "workspaceId" = $1) l', [W]))[0]
const bidOf = async (id: string) => (await rows<{ b: number }>('SELECT "bidCents" b FROM "AdTarget" WHERE id = $1', [id]))[0].b

/** 37 days of keyword data, reported an hour before NOW: c-it's keywords and the shadow campaign's one. */
async function seedEvidence() {
  const perDay: Record<string, { clicks: number; orders: number }> = { 't-it': { clicks: 6, orders: 1 }, 't-low': { clicks: 2, orders: 0 }, 't-sh': { clicks: 6, orders: 1 } }
  const data = []
  for (const [target, d] of Object.entries(perDay)) {
    for (let i = 1; i < 38; i++) {
      data.push({
        profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(NOW.getTime() - i * DAY), entityType: 'AD_TARGET',
        entityId: `EXT-${target}`, localEntityId: target, clicks: d.clicks, costMicros: BigInt(d.clicks * 300_000), currencyCode: 'EUR',
        orders7d: d.orders, sales7dCents: d.orders * 8000, reportedAt: new Date(NOW.getTime() - 3_600_000),
      })
    }
  }
  await database.client.amazonAdsDailyPerformance.createMany({ data })
}

describe.skipIf(!concurrentDatabaseUrl())('BB-6 — the live bid brain: one writer per campaign (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    database = await concurrentDatabase()
    await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [W])
    await inside(async () => {
      const db = database.client
      await seedAdsFixture(db)
      // A second allowlisted IT campaign that is never enrolled: the brain decides it in shadow only.
      await db.campaign.create({ data: { id: 'c-sh', name: 'Italy shadow', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-c-sh', dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true } })
      await db.adGroup.create({ data: { id: 'g-c-sh', campaignId: 'c-sh', name: 'group c-sh', externalAdGroupId: 'EXT-g-c-sh' } })
      await db.adTarget.create({ data: { id: 't-sh', adGroupId: 'g-c-sh', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'shadow jacket', bidCents: 45, externalTargetId: 'EXT-t-sh' } })
      await seedEvidence()
      await db.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', targetKind: 'ACOS', targetPct: 20, maxBidCents: 80, maxChangePct: 25, goal: 'PROFIT', updatedBy: 'user:test' } })
      await setAutonomy('AUTO', 'test')
      await setEnrollment({ campaignId: 'c-it', marketplace: 'IT', op: 'live', by: 'user:test', now: NOW })
    })
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('the owned campaign gets exactly the brain\'s writes; the one in shadow is decided and nothing is written for it', async () => {
    const before = await counts()
    const r = await inside(() => runShadowOnce({ now: NOW, mode: 'live' }))
    const it = r.markets.find((m) => m.market === 'IT')!
    expect(it.owned).toBe(1)
    expect(it.brakes).toEqual([])
    const decided = await rows<{ targetId: string; campaignId: string; mode: string; action: string; currentCents: number; decidedCents: number; sent: { sent?: string } | null }>(
      'SELECT "targetId", "campaignId", mode, action, "currentCents", "decidedCents", evidence -> \'sent\' AS sent FROM "BidBrainDecision" WHERE "workspaceId" = $1', [W])
    expect(decided.filter((d) => d.campaignId === 'c-it').every((d) => d.mode === 'LIVE')).toBe(true)
    expect(decided.find((d) => d.targetId === 't-sh')).toMatchObject({ mode: 'SHADOW', action: 'write' })
    expect(decided.find((d) => d.targetId === 't-sh')?.sent ?? null).toBeNull()
    const moving = decided.filter((d) => d.campaignId === 'c-it' && d.action === 'write' && d.decidedCents !== d.currentCents)
    expect(moving.map((d) => d.targetId)).toContain('t-it')
    expect(moving.every((d) => d.sent?.sent === 'queued')).toBe(true)
    // Exactly one queued write per moving keyword of the owned campaign, each as the brain with its evidence; none elsewhere.
    const logs = await rows<{ entityId: string; userId: string; evidence: { brain?: { layer?: string; dataDay?: string } } }>(
      'SELECT "entityId", "userId", evidence FROM "AdvertisingActionLog" WHERE "workspaceId" = $1 ORDER BY "entityId"', [W])
    expect(logs.map((l) => l.entityId)).toEqual(moving.map((d) => d.targetId).sort())
    expect(logs.every((l) => l.userId === BRAIN_ACTOR && !!l.evidence?.brain?.layer && !!l.evidence?.brain?.dataDay)).toBe(true)
    const after = await counts()
    expect(after.q - before.q).toBe(moving.length)
    expect(await bidOf('t-it')).toBe(moving.find((d) => d.targetId === 't-it')!.decidedCents)
    expect(await bidOf('t-sh')).toBe(45)
    expect(it.writes).toMatchObject({ queued: moving.length, refused: 0 })
  })

  it('a rerun on the same evidence writes nothing', async () => {
    const before = await counts()
    const r = await inside(() => runShadowOnce({ now: new Date(NOW.getTime() + 60_000), mode: 'live' }))
    expect(r.markets.find((m) => m.market === 'IT')?.writes?.queued ?? 0).toBe(0)
    expect(await counts()).toEqual(before)
  })

  it('one writer: another engine is refused; a stop\'s forced lowering and a person pass, and the person\'s bid is held', async () => {
    const before = await bidOf('t-it')
    const engine = await inside(() => updateAdTargetWithSync({ adTargetId: 't-it', patch: { bidCents: before + 5 }, actor: 'automation:rank-defend-bb6', reason: 'test', askGate: true }))
    expect(engine.ok).toBe(false)
    expect(engine.error).toMatch(/run by the bid brain \(one writer per campaign\): automation:rank-defend-bb6/)
    expect(engine.outboundQueueId ?? null).toBeNull()
    expect(await bidOf('t-it')).toBe(before)

    const stop = await inside(() => updateAdTargetWithSync({ adTargetId: 't-low', patch: { bidCents: 2 }, actor: 'automation:budget-manager-cron', reason: 'over the monthly cap', force: true, askGate: true }))
    expect(stop).toMatchObject({ ok: true })
    expect(await bidOf('t-low')).toBe(2)

    const own = await inside(() => updateAdTargetWithSync({ adTargetId: 't-it', patch: { bidCents: 50 }, actor: 'user:u-person', reason: 'my own bid', manual: true, askGate: true }))
    expect(own).toMatchObject({ ok: true })
    const holds = await rows<{ targetId: string; kind: string; by: string; days: number }>(
      'SELECT "targetId", kind, by, round(extract(epoch from (until - "createdAt")) / 86400)::int AS days FROM "BidHold" WHERE "workspaceId" = $1 AND "endedAt" IS NULL', [W])
    expect(holds).toEqual([{ targetId: 't-it', kind: 'PERSON', by: 'user:u-person', days: 60 }])
    // The brain leaves the person's bid: its next run holds it as a pin.
    await inside(() => runShadowOnce({ now: new Date(NOW.getTime() + 120_000), mode: 'live' }))
    const [last] = await rows<{ layer: string; action: string }>('SELECT layer, action FROM "BidBrainDecision" WHERE "targetId" = \'t-it\' ORDER BY "createdAt" DESC LIMIT 1')
    expect(last).toEqual({ layer: 'pin', action: 'hold' })
    expect(await bidOf('t-it')).toBe(50)
  })

  it('engines leave it: auto-bid\'s holders name the brain, the external engine never sees it', async () => {
    const holders = await inside(() => autoBidHolders(['c-it', 'c-sh']))
    expect(holders.get('c-it')).toBe('bidBrain')
    expect(holders.get('c-sh')).toBeUndefined()
    // The external engine reads keywords with clicks on their own row.
    await database.pool.query('UPDATE "AdTarget" SET clicks = 10 WHERE id IN (\'t-it\', \'t-sh\')')
    const contexts = await inside(() => getBidContexts({ marketplace: 'IT' }))
    const ids = contexts.map((c) => c.bridgeId)
    expect(ids).not.toContain('t-it')
    expect(ids).toContain('t-sh')
  })

  it('give-back: approved by a person, the bids it had when it went LIVE come back and the campaign returns to shadow', async () => {
    const result = await inside(async () => {
      const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: 'u-asker' } })
      const asked = await runOrQueueTool('set-bid-brain-enrollment', { campaignId: 'c-it', op: 'give-back', why: 'test give-back' }, person('u-asker', 'claude'), run.id)
      expect(asked).toMatchObject({ ok: true, mode: 'queued' })
      return decideApproval(asked.approvalId!, 'approve', person('u-approver', 'app'))
    })
    expect(result).toMatchObject({ ok: true, status: 'executed' })
    expect(await bidOf('t-it')).toBe(45)
    expect(await bidOf('t-low')).toBe(3)
    expect(await rows('SELECT mode FROM "BidBrainEnrollment" WHERE "campaignId" = \'c-it\'')).toEqual([{ mode: 'SHADOW' }])
    // Back in shadow, the engines take the campaign again.
    expect((await inside(() => autoBidHolders(['c-it']))).get('c-it')).not.toBe('bidBrain')
  })

  it('going LIVE through the tool is a big door: a plain approve runs nothing', async () => {
    const outcome = await inside(async () => {
      const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: 'u-asker' } })
      const asked = await runOrQueueTool('set-bid-brain-enrollment', { campaignId: 'c-sh', op: 'live' }, person('u-asker', 'claude'), run.id)
      expect(asked).toMatchObject({ ok: true, mode: 'queued' })
      const [approval] = await rows<{ preview: { stepUp?: { raises?: string[] } } }>('SELECT preview FROM "AgentApproval" WHERE id = $1', [asked.approvalId])
      expect(approval.preview.stepUp?.raises).toEqual(['Bid writer'])
      return decideApproval(asked.approvalId!, 'approve', person('u-approver', 'app'))
    })
    expect(outcome).not.toMatchObject({ status: 'executed' })
    expect(await rows('SELECT mode FROM "BidBrainEnrollment" WHERE "campaignId" = \'c-sh\'')).toEqual([])
  })
})

/**
 * MCP full control A7 — an approved bulk bid change and an engine's write on the SAME target, on a real PostgreSQL
 * (the throwaway PostgreSQL 17 of scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted
 * runtime login). Both are queued; when the drain claims them at the same moment (`claimEntityWrite`, an advisory lock
 * plus the in-flight rows), exactly one wins, the other is refused while the winner is in flight, and it claims once
 * the winner settles — so the two never reach Amazon at once and neither is lost. The property is Postgres locking
 * under real concurrency: a mocked or single-connection database cannot show it.
 *
 * Business profiles are ON, as production runs. The job queue is a stub (nothing leaves the process).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { seedAdsFixture } from '../../test-support/ads-fixtures.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => Reflect.get(database.client, key) }) }))
vi.mock('../../lib/queue.js', () => {
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

const { claimEntityWrite, settleAdMutations, updateAdTargetWithSync } = await import('./ads-mutation.service.js')
const { decideApproval, runOrQueueTool } = await import('../agents/approval-gate.service.js')

const W = `a7_bulk_${randomBytes(4).toString('hex')}`
const business = { workspaceId: W, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string, via: 'claude' | 'app') => ({
  kind: 'user' as const, userId, label: `Person ${userId}`, via, workspace: business,
  permissions: { isOwner: false, permissions: new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
})
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]

/** One approved bulk change of `targetId` (as the approver) and one engine write of it: their two queue rows. */
async function bothQueued(targetId: string, bulkBid: number, engineBid: number) {
  const approval = await inside(async () => {
    const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: 'u-asker' } })
    const asked = await runOrQueueTool('bulk-ad-bid-change', { bids: [{ targetId, bidCents: bulkBid }] }, person('u-asker', 'claude'), run.id, { forceAsk: true })
    expect(asked).toMatchObject({ ok: true, mode: 'queued' })
    expect(await decideApproval(asked.approvalId!, 'approve', person('u-approver', 'app'))).toMatchObject({ ok: true, status: 'executed' })
    return asked.approvalId!
  })
  const [claude] = await rows<{ q: string }>('SELECT "outboundQueueId" AS q FROM "AdvertisingActionLog" WHERE "executionId" = $1', [approval])
  const engine = await inside(() => updateAdTargetWithSync({ adTargetId: targetId, patch: { bidCents: engineBid }, actor: 'automation:rank-defend-a7sched' }))
  expect(engine.ok).toBe(true)
  return { approval, claudeQueue: claude.q, engineQueue: engine.outboundQueueId! }
}

describe.skipIf(!concurrentDatabaseUrl())('A7 — an approved bulk bid change and an engine write on one target: one claim wins (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    database = await concurrentDatabase()
    await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [W])
    await inside(() => seedAdsFixture(database.client))
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('both writes are queued for the target, each with its own actor; the approved one carries its approval as change set', async () => {
    const q = await bothQueued('t-it', 50, 55)
    const mutations = await rows<{ actor: string; state: string; q: string }>(
      'SELECT actor, state, "outboundQueueId" AS q FROM "AdMutation" WHERE "entityId" = $1 AND "workspaceId" = $2 ORDER BY "createdAt"', ['t-it', W])
    expect(mutations).toEqual([
      { actor: 'user:u-approver', state: 'PENDING', q: q.claudeQueue },
      { actor: 'automation:rank-defend-a7sched', state: 'PENDING', q: q.engineQueue },
    ])
    for (const id of [q.claudeQueue, q.engineQueue]) await settleAdMutations(id, 'SUCCESS')
  })

  it('claimed at the same moment, exactly one wins, the other waits until the winner settles — five races in a row', async () => {
    for (let round = 0; round < 5; round++) {
      const q = await bothQueued('t-uk', 61 + round, 70 + round)
      const [first, second] = await inside(() => Promise.all([
        claimEntityWrite('AD_TARGET', 't-uk', q.claudeQueue),
        claimEntityWrite('AD_TARGET', 't-uk', q.engineQueue),
      ]))
      expect([first, second].filter(Boolean)).toHaveLength(1)
      const winner = first ? q.claudeQueue : q.engineQueue
      const loser = first ? q.engineQueue : q.claudeQueue
      // While the winner is in flight the loser is refused again — deferred, not lost.
      expect(await inside(() => claimEntityWrite('AD_TARGET', 't-uk', loser))).toBe(false)
      expect((await rows<{ state: string }>('SELECT state FROM "AdMutation" WHERE "outboundQueueId" = $1', [loser]))[0].state).toBe('PENDING')
      await inside(() => settleAdMutations(winner, 'SUCCESS'))
      expect(await inside(() => claimEntityWrite('AD_TARGET', 't-uk', loser))).toBe(true)
      await inside(() => settleAdMutations(loser, 'SUCCESS'))
    }
  })
})

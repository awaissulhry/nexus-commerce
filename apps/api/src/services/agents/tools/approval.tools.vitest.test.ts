/**
 * MCP full control A9 — approval-status says what an approved ad change did at Amazon: its writes are found by their
 * change set (= the approval id) and counted by their outbound rows — waiting, sent, refused by the write gate, failed —
 * the negatives and keywords it created by whether Amazon gave them an id, a sandbox run as sandbox, and eBay ad writes
 * by theirs. Run for real through the door and the gate (PGlite; the job queue a stub).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
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
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction.
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))

import { callTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string, via: 'claude' | 'app', permissions = [...Object.values(FEATURES), ...Object.values(FIELDS)]): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId}`, via, workspace: business, permissions: { isOwner: false, permissions: new Set(permissions) },
})
const claude = person('u-asker', 'claude')
const approver = person('u-approver', 'app')
type Row = Record<string, any>
const status = async (approvalId: string, who = claude) => (await inside(() => callTool(who, 'approval-status', { approvalId }))).visible.data as Row
async function askAndRun(tool: string, args: Record<string, unknown>) {
  return inside(async () => {
    const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    const asked = await runOrQueueTool(tool, args, claude, run.id, { forceAsk: true })
    expect(await decideApproval(asked.approvalId!, 'approve', approver)).toMatchObject({ ok: true, status: 'executed' })
    return asked.approvalId!
  })
}
const queueOf = (approvalId: string) => inside(async () => (await database.client.$queryRawUnsafe(
  'SELECT "outboundQueueId" AS q FROM "AdvertisingActionLog" WHERE "executionId" = $1 ORDER BY "entityId"', approvalId)) as Array<{ q: string }>)
const setQueue = (id: string, syncStatus: string, extra: Record<string, unknown> = {}) =>
  inside(() => database.client.outboundSyncQueue.update({ where: { id }, data: { syncStatus, ...extra } as never }))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(() => seedAdsFixture(database.client))
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)

describe('A9 — approval-status follows an approved ad change to Amazon', () => {
  it('live: waiting, sent, refused by the write gate, failed — each counted by its outbound row, in one sentence', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    // 6b — two Italian targets: the write gate refuses every live write in UK (no checked Amazon limits row there).
    await inside(() => database.client.adTarget.create({ data: {
      id: 't-it2', adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'race boots', bidCents: 60, externalTargetId: 'EXT-t-it2',
    } }))
    const id = await askAndRun('bulk-ad-bid-change', { bids: [{ targetId: 't-it', bidCents: 50 }, { targetId: 't-it2', bidCents: 65 }] })
    let s = await status(id)
    expect(s.ads).toEqual({ reach: 'live', writes: 2, waiting: 2, sent: 0, refusedByGate: 0, failed: 0, notSent: 0 })
    expect(s.meaning).toBe('Approved and written in Nexus. Amazon: 2 waiting to be sent (a queued ad write waits out a 5-minute cancel window) (of 2 writes).')

    const [first, second] = await queueOf(id)
    await setQueue(first.q, 'SUCCESS')
    await setQueue(second.q, 'SKIPPED', { errorCode: 'WRITE_GATE_DENIED', errorMessage: '[ADS-WRITE-GATE-DENY] entity_bounds: bid 65 above Campaign.maxBidCents 60' })
    s = await status(id)
    expect(s.ads).toEqual({ reach: 'live', writes: 2, waiting: 0, sent: 1, refusedByGate: 1, failed: 0, notSent: 0, gateReasons: ['entity_bounds: bid 65 above Campaign.maxBidCents 60'] })
    expect(s.meaning).toBe('Approved and written in Nexus. Amazon: 1 sent, 1 refused by the write gate (of 2 writes).')
    await setQueue(second.q, 'FAILED')
    expect((await status(id)).meaning).toBe('Approved and written in Nexus. Amazon: 1 sent, 1 failed (of 2 writes).')
    // The gate's words can name an amount: a person without the ad-spend money permission does not get them.
    const noMoney = person('u-viewer', 'claude', [FEATURES.aiRun, FEATURES.aiView])
    await setQueue(second.q, 'SKIPPED', { errorCode: 'WRITE_GATE_DENIED' })
    expect((await status(id, noMoney)).ads).not.toHaveProperty('gateReasons')
  })

  it('sandbox: written in Nexus, nothing sent to Amazon — said so', async () => {
    vi.unstubAllEnvs()
    const id = await askAndRun('set-target-bid', { targetId: 't-it', proposedBidCents: 47 })
    const s = await status(id)
    expect(s.ads).toMatchObject({ reach: 'sandbox', writes: 1 })
    expect(s.meaning).toBe('Approved and written in Nexus (1 write). Sandbox: Amazon ads writes are not live, so nothing was sent to Amazon.')
  })

  it('a negative it created is counted by whether Amazon gave it an id; eBay ad writes by their own rows', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    // A created negative: the create is inline, and Amazon's answer is what gives it an id (the fixture's has one).
    const id = await inside(async () => {
      const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done' } })
      const ap = await database.client.agentApproval.create({ data: { agentRunId: run.id, toolName: 'create-negative-keyword', riskTier: 'high', args: {}, preview: { reach: { reach: 'live', profileId: 'P-IT-TEST' } }, status: 'executed', decidedAt: new Date() } })
      await database.client.agentChange.create({ data: { approvalId: ap.id, toolName: 'create-negative-keyword', via: 'claude', reversibility: 'full', before: { negatives: [] }, after: { negatives: [{ targetId: 't-neg' }] } } })
      await database.client.campaignAction.create({ data: { executionId: ap.id, channel: 'EBAY', actionType: 'set_ad_rate', entityType: 'EBAY_CAMPAIGN', entityId: 'e1', payloadBefore: {}, payloadAfter: {}, channelResponseStatus: 'SUCCESS' } as never })
      await database.client.campaignAction.create({ data: { executionId: ap.id, channel: 'EBAY', actionType: 'set_ad_rate', entityType: 'EBAY_CAMPAIGN', entityId: 'e2', payloadBefore: {}, payloadAfter: {}, channelResponseStatus: 'FAILED' } as never })
      return ap.id
    })
    const s = await status(id)
    expect(s.ads).toMatchObject({ reach: 'live', writes: 0, created: { total: 1, atAmazon: 1 } })
    expect(s.meaning).toBe('Approved and run. Created 1, 1 of them confirmed at Amazon.')
    expect(s.ebay).toEqual({ writes: 2, sent: 1, sandbox: 0, partly: 0, failed: 1, waiting: 0 })
  })

  it('a change that is not an ad change keeps its own wording', async () => {
    const id = await inside(async () => {
      const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done' } })
      return (await database.client.agentApproval.create({ data: { agentRunId: run.id, toolName: 'bulk-attribute-change', riskTier: 'high', args: {}, preview: {}, status: 'executed' } })).id
    })
    const s = await status(id)
    expect(s).not.toHaveProperty('ads')
    expect(s.meaning).toMatch(/^Approved and applied in Nexus. Nothing was sent to a marketplace/)
  })
})

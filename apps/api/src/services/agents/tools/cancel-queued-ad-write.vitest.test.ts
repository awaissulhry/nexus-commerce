/**
 * ADS AUTONOMY W3-2 — cancel-queued-ad-write, through the one door, on a real PostgreSQL (PGlite).
 *
 * Proven: the preview names exactly what it cancels (field from → to, on what, who queued it, the change set, whether
 * that is a Claude request, when the window ends) and what it cannot (window over); by the default limits only a raise
 * a Claude request queued is inside — a person's write, and any lowering (cancelling it keeps spend up), wait for a
 * person; a write queued with no grace window is cancellable while still waiting, and the preview says so; a cancel is
 * the staged tray's own
 * (the queue row and its typed rows CANCELLED, Nexus's copy put back); undo asks for the whole request again; a listing
 * push is never touched; another business's write is not found.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../../lib/queue.js', () => {
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

import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_w32_cancel_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const person: UserPrincipal = { kind: 'user', userId: 'u-w32c', label: 'W3-2 cancel test', permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) }, workspace: business(A), via: 'claude' }
type Out = { ok: boolean; error?: string; preview?: Record<string, any>; data?: Record<string, any>; change?: { before: any; after: any } }
const dry = async (args: Record<string, unknown>) => (await callTool(person, 'cancel-queued-ad-write', { why: 'test cancel', ...args })).raw as Out
const run = async (args: Record<string, unknown>) => (await executeTool(person, 'cancel-queued-ad-write', { why: 'test cancel', ...args }, { via: 'claude' })).raw as Out
const tool = () => getTool('cancel-queued-ad-write')!
const inLimits = (preview: unknown, limits: Record<string, unknown> = {}) => tool().withinLimits!(preview, tool().limits!.parse(limits))
const ids: Record<string, string> = {}
const soon = () => new Date(Date.now() + 5 * 60_000)

/** A queued ad write as the mutation layer leaves it: the queue row, its typed row per field, and its audit row. */
async function queueWrite(opts: { entityType: string; entityId: string; field: string; from: string; to: string; actor: string; changeSetId?: string | null; holdUntil?: Date }): Promise<string> {
  const c = database.client
  const holdUntil = opts.holdUntil ?? soon()
  const q = await c.outboundSyncQueue.create({
    data: {
      targetChannel: 'AMAZON', targetRegion: 'IT', syncStatus: 'PENDING', syncType: opts.field === 'bid' ? 'AD_BID_UPDATE' : 'AD_BUDGET_UPDATE', holdUntil,
      payload: { entityType: opts.entityType, entityId: opts.entityId, marketplace: 'IT', fieldChanges: [{ field: opts.field, oldValue: opts.from, newValue: opts.to }], actor: opts.actor },
    },
  })
  await c.adMutation.create({ data: { entityType: opts.entityType, entityId: opts.entityId, marketplace: 'IT', field: opts.field, previousValue: opts.from, intendedValue: opts.to, actor: opts.actor, holdUntil, outboundQueueId: q.id, idempotencyKey: `${q.id}:${opts.field}` } })
  await c.advertisingActionLog.create({ data: { executionId: opts.changeSetId ?? null, userId: opts.actor, actionType: q.syncType, entityType: opts.entityType, entityId: opts.entityId, payloadBefore: {}, payloadAfter: {}, outboundQueueId: q.id, amazonResponseStatus: 'PENDING' } })
  return q.id
}

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`, [OTHER])
  await inside(async () => {
    const c = database.client
    const campaign = await c.campaign.create({ data: { name: 'TEST W32C CAMPAIGN', type: 'SP', dailyBudget: '12.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', liveBidWritesEnabled: true } })
    ids.campaign = campaign.id
    const group = await c.adGroup.create({ data: { campaignId: campaign.id, name: 'TEST W32C GROUP', defaultBidCents: 40 } })
    // The mutation layer already wrote Nexus's copy (50 → 60) when it queued the bid.
    ids.target = (await c.adTarget.create({ data: { adGroupId: group.id, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'test keyword', bidCents: 60 } })).id
    // A Claude request (set-target-bid) whose one write still waits.
    const run = await c.agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'done', via: 'claude' } })
    ids.approval = (await c.agentApproval.create({ data: { agentRunId: run.id, toolName: 'set-target-bid', riskTier: 'high', status: 'executed', args: { targetId: ids.target, proposedBidCents: 60, why: 'test raise' } } })).id
    ids.claudeWrite = await queueWrite({ entityType: 'AD_TARGET', entityId: ids.target, field: 'bid', from: '50', to: '60', actor: 'user:u-approver', changeSetId: ids.approval })
    // A person's budget cut on the screens (no request), and a write whose window is over.
    ids.personWrite = await queueWrite({ entityType: 'CAMPAIGN', entityId: campaign.id, field: 'dailyBudget', from: '12', to: '8', actor: 'user:u-person' })
    ids.lateWrite = await queueWrite({ entityType: 'AD_TARGET', entityId: ids.target, field: 'bid', from: '60', to: '70', actor: 'automation:test-engine', holdUntil: new Date(Date.now() - 60_000) })
    // A Claude request's own bid cut, queued to go at once (no grace window).
    const cut = await c.agentApproval.create({ data: { agentRunId: run.id, toolName: 'set-target-bid', riskTier: 'high', status: 'executed', args: { targetId: ids.target, proposedBidCents: 30, why: 'test cut' } } })
    ids.cutApproval = cut.id
    ids.cutWrite = await queueWrite({ entityType: 'AD_GROUP', entityId: group.id, field: 'defaultBid', from: '40', to: '30', actor: 'user:u-approver', changeSetId: cut.id })
    await c.outboundSyncQueue.update({ where: { id: ids.cutWrite }, data: { holdUntil: null } })
    await c.adMutation.updateMany({ where: { outboundQueueId: ids.cutWrite }, data: { holdUntil: null } })
    // A listing price push: not an ad write.
    ids.listingPush = (await c.outboundSyncQueue.create({ data: { targetChannel: 'AMAZON', syncStatus: 'PENDING', syncType: 'PRICE_UPDATE', payload: { price: 9.99 }, holdUntil: soon() } })).id
  })
  await inside(async () => {
    ids.otherWrite = (await database.client.outboundSyncQueue.create({ data: { targetChannel: 'AMAZON', syncStatus: 'PENDING', syncType: 'AD_BID_UPDATE', payload: {}, holdUntil: soon() } })).id
  }, OTHER)
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)

describe('W3-2 — cancel-queued-ad-write', () => {
  it('names exactly what it cancels; a Claude request\'s own write is inside the default limits', async () => {
    const out = await dry({ changeSetId: ids.approval })
    expect(out.error).toBeUndefined()
    expect(out.preview).toMatchObject({
      action: 'cancel-queued-ad-write',
      writes: [{
        queueId: ids.claudeWrite, entityType: 'AD_TARGET', entityId: ids.target, label: 'keyword "test keyword" (campaign "TEST W32C CAMPAIGN")',
        campaignId: ids.campaign, market: 'IT', fields: [{ field: 'bid', from: '50', to: '60' }], effect: 'raise', lowers: false, queuedBy: 'user:u-approver',
        changeSetId: ids.approval, byClaude: true,
      }],
      notCancellable: [], keepsSpend: [], totals: { writes: 1, byClaude: 1, byOthers: 0 },
    })
    expect(out.preview!.summary).toBe('Cancels 1 queued Amazon ad write before it is sent: keyword "test keyword" (campaign "TEST W32C CAMPAIGN") (bid 50 → 60).')
    expect(out.preview!.effect).toContain('Nothing reaches Amazon')
    expect(inLimits(out.preview)).toBeNull()
  })

  it('a write a person queued waits for a person (allowCancelOthers off); a cancelled lowering is said, and waits too', async () => {
    const out = await dry({ outboundQueueId: ids.personWrite })
    expect(out.preview).toMatchObject({ writes: [{ label: 'campaign "TEST W32C CAMPAIGN"', effect: 'lowering', lowers: true, byClaude: false, changeSetId: null }], keepsSpend: ['campaign "TEST W32C CAMPAIGN"'] })
    expect(out.preview!.effect).toContain("cancelling keeps today's value")
    expect(inLimits(out.preview)).toBe('it cancels a write not queued by a Claude request (campaign "TEST W32C CAMPAIGN", by user:u-person): a person decides')
    expect(inLimits(out.preview, { allowCancelOthers: true })).toBe('it cancels a lowering (campaign "TEST W32C CAMPAIGN"): the bid, budget or status stays where it is, so spend stays up — a person decides')
    expect(inLimits(out.preview, { allowCancelOthers: true, allowCancelLowering: true })).toBeNull()
  })

  it('a Claude request\'s own lowering waits for a person too (allowCancelLowering off); with no grace window it says when it can be cancelled', async () => {
    const out = await dry({ changeSetId: ids.cutApproval })
    expect(out.preview).toMatchObject({ writes: [{ queueId: ids.cutWrite, label: 'ad group "TEST W32C GROUP" (campaign "TEST W32C CAMPAIGN")', effect: 'lowering', lowers: true, byClaude: true, graceEndsAt: null }] })
    expect(out.preview!.effect).toContain('queued to go at once, with no grace window: cancellable only while still waiting and no worker has taken it')
    expect(inLimits(out.preview)).toContain('it cancels a lowering')
    expect(inLimits(out.preview, { allowCancelLowering: true })).toBeNull()
    // A stored preview without the flag is never judged a raise.
    expect(inLimits({ writes: [{ label: 'x', byClaude: true }] })).toContain('it cancels a lowering')
    // Still waiting and untaken: it is cancelled.
    expect((await run({ changeSetId: ids.cutApproval })).data!.cancelled.map((c: { queueId: string }) => c.queueId)).toEqual([ids.cutWrite])
  })

  it('refuses what it cannot cancel: a window over, a listing push, another business\'s write, no id, a write of another request', async () => {
    expect((await dry({ outboundQueueId: ids.lateWrite })).error).toBe('Nothing to cancel: keyword "test keyword" (campaign "TEST W32C CAMPAIGN") — its grace window is over: the worker sends it at its next pass.')
    expect((await dry({ outboundQueueId: ids.listingPush })).error).toBe(`outboundQueueId ${ids.listingPush}: not an Amazon ad write Nexus queued.`)
    expect((await dry({ outboundQueueId: ids.otherWrite })).error).toBe(`outboundQueueId ${ids.otherWrite}: not found in this business.`)
    expect((await dry({})).error).toContain('Name the write')
    expect((await dry({ outboundQueueId: ids.personWrite, changeSetId: ids.approval })).error).toBe(`outboundQueueId ${ids.personWrite}: not found in change set ${ids.approval}.`)
    expect((await dry({ outboundQueueId: ids.claudeWrite, changeSetId: ids.approval })).preview!.writes.map((w: { queueId: string }) => w.queueId)).toEqual([ids.claudeWrite])
    expect((await dry({ changeSetId: 'no-such-request' })).error).toBe('changeSetId no-such-request: not found in this business (no queued Amazon ad write carries it).')
  })

  it('a run cancels through the staged tray\'s own cancel (Nexus put back); undo asks for the whole request again', async () => {
    const out = await run({ changeSetId: ids.approval })
    expect(out.ok, out.error).toBe(true)
    expect(out.data!.cancelled).toEqual([{ queueId: ids.claudeWrite, label: 'keyword "test keyword" (campaign "TEST W32C CAMPAIGN")', restored: ['bid'], kept: [] }])
    await inside(async () => {
      expect((await database.client.outboundSyncQueue.findUniqueOrThrow({ where: { id: ids.claudeWrite } })).syncStatus).toBe('CANCELLED')
      expect((await database.client.adMutation.findFirstOrThrow({ where: { outboundQueueId: ids.claudeWrite } })).state).toBe('CANCELLED')
      expect((await database.client.adTarget.findUniqueOrThrow({ where: { id: ids.target } })).bidCents).toBe(50)
      // The other writes are untouched, and nothing else was written.
      expect((await database.client.outboundSyncQueue.findUniqueOrThrow({ where: { id: ids.personWrite } })).syncStatus).toBe('PENDING')
      expect((await database.client.outboundSyncQueue.findUniqueOrThrow({ where: { id: ids.listingPush } })).syncStatus).toBe('PENDING')
    })
    expect(await inside(() => tool().undo!.current(out.change!))).toEqual(out.change!.after)
    expect(tool().undo!.request(out.change!)).toEqual({ tool: 'set-target-bid', args: { targetId: ids.target, proposedBidCents: 60, why: 'test raise' } })
    // Run again: nothing is left to cancel.
    expect((await run({ changeSetId: ids.approval })).error).toContain('it is cancelled already')
  })

  it('a cancel of a write that is not a whole Claude request has no request to ask for again', async () => {
    const out = await run({ outboundQueueId: ids.personWrite })
    expect(out.ok, out.error).toBe(true)
    expect(out.change!.before.request).toBeNull()
    expect(tool().undo!.request(out.change!)).toMatchObject({ refusal: expect.stringContaining('ask for each again with its own tool') })
    expect((await inside(() => database.client.campaign.findUniqueOrThrow({ where: { id: ids.campaign } }))).dailyBudget.toString()).toBe('12')
  })
})

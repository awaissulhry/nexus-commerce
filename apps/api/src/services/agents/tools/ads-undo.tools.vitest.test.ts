/**
 * MCP full control A10 — undo-ad-change on the rollback service, run for real through the door and the approval gate
 * (PGlite, production schema; the job queue a stub; the ads write gate the real one, sandbox unless a test goes live).
 *
 * Proven: an approved ad request's whole change set (changeSetId = its approval) is put back, as the approver, and its
 * recorded change is marked undone; one recorded change made in Nexus is put back by its actionLogId; a set past the
 * 24-hour window, an unknown set or change, and a restore Amazon's gate would refuse are not queued; a set already
 * undone has nothing left; the preview lists every write and the value it restores.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction; an ads
// row names no listing account anyway (the ads worker resolves its Amazon Ads profile).
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))

import { callTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { updateCampaignWithSync } from '../../advertising/ads-mutation.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId}`, via, workspace: business,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
})
const claude = person('u-asker', 'claude')
const approver = person('u-approver', 'app')

type Row = Record<string, any>
const preview = async (tool: string, args: Record<string, unknown>) => (await inside(() => callTool(claude, tool, args))).raw
async function ask(tool: string, args: Record<string, unknown>) {
  return inside(async () => {
    const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool(tool, args, claude, run.id, { forceAsk: true })
  })
}
const approve = (approvalId: string) => inside(() => decideApproval(approvalId, 'approve', approver))
const sql = <T = Row>(text: string, params: unknown[] = []) => inside(async () => (await database.client.$queryRawUnsafe(text, ...params)) as T[])
const bidOf = async (id: string) => (await sql<{ b: number }>('SELECT "bidCents" AS b FROM "AdTarget" WHERE id = $1', [id]))[0].b

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(() => seedAdsFixture(database.client))
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(() => { vi.unstubAllEnvs() })

describe('A10 — undo-ad-change puts an approved ad request back', () => {
  it('previews every write of the change set and the value it restores; approved, it restores them as the approver', async () => {
    const bid = await ask('set-target-bid', { targetId: 't-it', proposedBidCents: 52 })
    await approve(bid.approvalId!)
    expect(await bidOf('t-it')).toBe(52)

    const p = await preview('undo-ad-change', { changeSetId: bid.approvalId })
    expect(p.ok, p.error).toBe(true)
    expect(p.preview).toMatchObject({
      source: { mode: 'set', changeSetId: bid.approvalId },
      rows: [{ actionType: 'AD_BID_UPDATE', entityType: 'AD_TARGET', entityId: 't-it', wrote: { bidCents: 52 }, restores: { bidCents: 45 } }],
      negatives: [], reach: { reach: 'sandbox' }, effect: expect.stringMatching(/^Undo restores 1 recorded write to the values before them/),
    })

    const undo = await ask('undo-ad-change', { changeSetId: bid.approvalId, why: 'the bid raise did not pay' })
    expect(undo).toMatchObject({ ok: true, mode: 'queued' })
    expect(await approve(undo.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { reversed: 1, skipped: 0, failed: 0 } })
    expect(await bidOf('t-it')).toBe(45)
    const [restore] = await sql('SELECT "changedBy", reason FROM "CampaignBidHistory" WHERE "entityId" = $1 ORDER BY "changedAt" DESC LIMIT 1', ['t-it'])
    expect(restore).toEqual({ changedBy: 'user:u-approver', reason: `rollback: Claude request ${undo.approvalId}: the bid raise did not pay` })
    const [original] = await sql('SELECT "undoneAt" IS NOT NULL AS undone, "undoneByApprovalId" AS by FROM "AgentChange" WHERE "approvalId" = $1', [bid.approvalId])
    expect(original).toEqual({ undone: true, by: undo.approvalId })
    // Nothing is left: a second undo of the same set has nothing to put back.
    expect(await preview('undo-ad-change', { changeSetId: bid.approvalId })).toEqual({ ok: false, error: `Nothing of change set ${bid.approvalId} is left to undo: it was undone already.` })
  })

  it('one change made in Nexus is put back by its actionLogId', async () => {
    const made = await inside(() => updateCampaignWithSync({ campaignId: 'c-uk', patch: { dailyBudget: 18 }, actor: 'user:u-operator', reason: 'by hand' }))
    expect(made.ok).toBe(true)
    const p = await preview('undo-ad-change', { actionLogId: made.actionLogId })
    expect(p.preview).toMatchObject({ source: { mode: 'action', actionLogId: made.actionLogId }, rows: [{ entityId: 'c-uk', restores: { dailyBudget: 15 } }] })
    const undo = await ask('undo-ad-change', { actionLogId: made.actionLogId })
    expect(await approve(undo.approvalId!)).toMatchObject({ ok: true, result: { reversed: 1 } })
    expect((await sql('SELECT "dailyBudget"::text AS b FROM "Campaign" WHERE id = $1', ['c-uk']))[0]).toEqual({ b: '15.00' })
  })

  it('refuses, without queuing: an unknown set or change, a set past its window, a restore the gate would refuse', async () => {
    expect(await preview('undo-ad-change', {})).toMatchObject({ ok: false, error: expect.stringMatching(/^Name the ad change to undo/) })
    expect(await preview('undo-ad-change', { changeSetId: 'no-such-set' })).toEqual({ ok: false, error: 'Change set not found.' })
    expect(await preview('undo-ad-change', { actionLogId: 'no-such-log' })).toEqual({ ok: false, error: 'Change not found.' })

    const old = await inside(() => updateCampaignWithSync({ campaignId: 'c-it', patch: { dailyBudget: 21 }, actor: 'user:u-operator', changeSetId: 'set-old' }))
    await sql(`UPDATE "AdvertisingActionLog" SET "createdAt" = now() - interval '2 days' WHERE id = $1`, [old.actionLogId])
    expect(await preview('undo-ad-change', { changeSetId: 'set-old' })).toMatchObject({ ok: false, error: expect.stringMatching(/older than the 24-hour undo window/) })

    const off = await inside(() => updateCampaignWithSync({ campaignId: 'c-off', patch: { dailyBudget: 22 }, actor: 'user:u-operator', changeSetId: 'set-off' }))
    expect(off.ok).toBe(true)
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    expect(await preview('undo-ad-change', { changeSetId: 'set-off' })).toMatchObject({ ok: false, error: expect.stringMatching(/^Not queued: .*live-write allowlist/) })
    expect(await ask('undo-ad-change', { changeSetId: 'set-off' })).toMatchObject({ ok: false, mode: 'error' })
  })

  it('a change set that moved since it was approved is not run', async () => {
    const bid = await ask('set-target-bid', { targetId: 't-uk', proposedBidCents: 66 })
    await approve(bid.approvalId!)
    const undo = await ask('undo-ad-change', { changeSetId: bid.approvalId })
    // Another write joins the set after the undo was asked: what it restores is no longer what was approved.
    await inside(() => updateCampaignWithSync({ campaignId: 'c-uk', patch: { dailyBudget: 19 }, actor: 'user:u-operator', changeSetId: bid.approvalId }))
    expect(await approve(undo.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/^Not run: what you approved has moved since — rows changed/) })
    expect(await bidOf('t-uk')).toBe(66)
  })
})

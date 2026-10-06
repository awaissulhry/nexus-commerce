/**
 * Phase 3 T5 — set-campaign-target-acos, run for real through the door and the approval gate (PGlite, production
 * schema; the job queue a stub), as ads-change.tools.vitest.test.ts runs its siblings.
 *
 * Proven: a percent in, a fraction stored (the screen's unit trap); the campaigns named or every campaign of a market
 * (archived left out), each from → to; what reads it and that nothing reaches Amazon; what it refuses; approved, it
 * writes through the screen's service as the approver and keeps the other campaign settings, audits each campaign, and
 * undo puts each earlier target back (none included); a target that moved after approval is not run.
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

import { callTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { undoRequestFor } from '../change-record.service.js'
import { getTool } from '../tool-registry.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId}`, via, workspace: business,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
})
const claude = person('u-asker', 'claude')
const approver = person('u-approver', 'app')

type Row = Record<string, any>
const TOOL = 'set-campaign-target-acos'
const preview = async (args: Record<string, unknown>) => (await inside(() => callTool(claude, TOOL, args))).raw
async function ask(args: Record<string, unknown>) {
  return inside(async () => {
    const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool(TOOL, args, claude, run.id, { forceAsk: true })
  })
}
const approve = (approvalId: string) => inside(() => decideApproval(approvalId, 'approve', approver))
const sql = <T = Row>(text: string, params: unknown[] = []) => inside(async () => (await database.client.$queryRawUnsafe(text, ...params)) as T[])
const dynamicOf = async (id: string) => (await sql<{ d: Row | null }>('SELECT "dynamicBidding" AS d FROM "Campaign" WHERE id = $1', [id]))[0].d
const setTarget = (id: string, dynamicBidding: Row) => inside(() => database.client.campaign.update({ where: { id }, data: { dynamicBidding } }))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    // c-it keeps placements beside its target (the write must leave them); c-uk has a 30% target; one IT campaign archived.
    await database.client.campaign.update({ where: { id: 'c-it' }, data: { dynamicBidding: { placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 50 }] } } })
    await database.client.campaign.update({ where: { id: 'c-uk' }, data: { dynamicBidding: { targetAcos: 0.3 } } })
    await database.client.campaign.create({
      data: { id: 'c-arch', name: 'Italy archived', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-c-arch', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), status: 'ARCHIVED' },
    })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(() => { vi.unstubAllEnvs() })

describe('T5 — set-campaign-target-acos: the preview', () => {
  it('takes a percent, stores a fraction, lists each campaign from → to, says what reads it and that nothing reaches Amazon', async () => {
    const r = await preview({ campaignIds: ['c-uk', 'c-it'], targetAcosPct: 25 })
    expect(r.ok).toBe(true)
    expect(r.preview).toMatchObject({
      mode: 'campaigns', targetAcosPct: 25, reachesAmazon: false,
      summary: 'Sets the target ACoS of 2 Amazon campaigns in 2 markets (IT, UK) to 25% (stored as the fraction 0.25), in Nexus only: nothing is sent to Amazon.',
      campaigns: [
        { campaignId: 'c-it', name: 'Italy exact', marketplace: 'IT', fromPct: null, toPct: 25 },
        { campaignId: 'c-uk', name: 'UK exact', marketplace: 'UK', fromPct: 30, toPct: 25 },
      ],
      changes: [
        { label: 'Italy exact · target ACoS', fromLabel: 'none (Nexus uses the business default, profit data or 30%)', toLabel: '25%' },
        { label: 'UK exact · target ACoS', fromLabel: '30%', toLabel: '25%' },
      ],
      totals: { changing: 2, raised: 0, lowered: 2, firstSet: 1, cleared: 0, unchanged: 0, archivedLeftOut: 0 },
      // W0 — Nexus's own optimiser now bids toward it, ahead of the business default, profit data and a rule's target.
      readBy: expect.stringMatching(/^Nexus's bid optimiser — auto-bid, autopilot plans and the target-ACoS bid rules, when they run — moves each campaign's keyword bids toward it, unless a rule or an autopilot plan sets a target of its own, ahead of the business default/),
      // Lower than the 30 % fallback, but the campaign had no target: what it moved toward before may have been lower.
      warnings: ['1 campaign had no target ACoS: Nexus\'s bid optimiser moved its bids toward the business default or profit data (30% without either), so where that was lower, bids can still rise.'],
    })
    expect(getTool(TOOL)).toMatchObject({ openWorld: false, reversibility: 'full', maxClaudeTrust: 'confirm', riskTier: 'high', requires: ['ads.automation.manage'] })
  })

  it('a market: every campaign of it, archived ones left out; a raise warns that spend can rise', async () => {
    const r = await preview({ market: 'it', targetAcosPct: 40 })
    expect(r.preview).toMatchObject({
      mode: 'market', market: 'IT',
      summary: expect.stringMatching(/^Sets the target ACoS of 4 Amazon campaigns in IT to 40% \(stored as the fraction 0.4\)/),
      totals: { changing: 4, raised: 4, firstSet: 4, archivedLeftOut: 1 },
      warnings: [expect.stringMatching(/bid higher on 4 campaigns .* ad spend can rise/)],
    })
    expect((r.preview as Row).campaigns.map((c: Row) => c.campaignId)).toEqual(['c-it', 'c-off', 'c-pin', 'c-sb'])
    // Live ads mode: the external engine reads only the allowlisted ones.
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    expect((await preview({ market: 'IT', targetAcosPct: 40 })).preview).toMatchObject({ readBy: expect.stringContaining('live-write allowlist: 3 of these 4') })
  })

  it('refuses what it cannot read, what would not change, and a percent outside the screen\'s bounds', async () => {
    expect((await preview({ targetAcosPct: 25 })).error).toMatch(/^Name the campaigns one way/)
    expect((await preview({ campaignIds: ['c-it'], market: 'IT', targetAcosPct: 25 })).error).toMatch(/^Name the campaigns one way/)
    expect((await preview({ campaignIds: ['c-it'] })).error).toMatch(/^Give targetAcosPct/)
    expect((await preview({ campaignIds: ['c-it', 'nope'], targetAcosPct: 25 })).error).toBe('Campaign not found: nope (use campaignId from ad-campaigns).')
    expect((await preview({ market: 'SE', targetAcosPct: 25 })).error).toBe('No Amazon campaign in market SE.')
    expect((await preview({ campaignIds: ['c-uk'], targetAcosPct: 30 })).error).toBe('UK exact already has a target ACoS of 30%: nothing would change.')
    // W0 — a list may carry any stored value back (0–500); one Nexus's optimiser skips (0 %) is named, 150 % is not.
    expect((await preview({ targets: [{ campaignId: 'c-uk', targetAcosPct: 0 }] })).preview).toMatchObject({
      warnings: expect.arrayContaining(['1 campaign gets a target of 0%: Nexus\'s bid optimiser skips it and uses the business default, profit data or 30%.']),
    })
    expect(((await preview({ targets: [{ campaignId: 'c-uk', targetAcosPct: 150 }] })).preview as Row).warnings.join(' ')).not.toMatch(/skips/)
    expect((await preview({ targets: [{ campaignId: 'c-uk', targetAcosPct: 30 }], targetAcosPct: 30 })).error).toMatch(/not both/)
    await expect(inside(() => callTool(claude, TOOL, { campaignIds: ['c-it'], targetAcosPct: 101 }))).rejects.toThrow()
    await expect(inside(() => callTool(claude, TOOL, { campaignIds: ['c-it'], targetAcosPct: 0 }))).rejects.toThrow()
  })
})

describe('T5 — set-campaign-target-acos: approved, and undone', () => {
  it('writes the fraction through the screen\'s service as the approver, audits each campaign; undo puts each earlier target back', async () => {
    const asked = await ask({ campaignIds: ['c-it', 'c-uk'], targetAcosPct: 25, why: 'one target for the season' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { set: 2, failed: 0, targets: { 'c-it': 0.25, 'c-uk': 0.25 }, reachesAmazon: false } })
    // The fraction, never the percent; the placements beside it kept.
    expect(await dynamicOf('c-it')).toEqual({ placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 50 }], targetAcos: 0.25 })
    expect(await dynamicOf('c-uk')).toEqual({ targetAcos: 0.25 })
    const logs = await sql('SELECT "entityId", "userId", "actionType", "executionId", "amazonResponseStatus", "payloadBefore", "evidence" FROM "AdvertisingActionLog" WHERE "actionType" = $1 ORDER BY "entityId"', ['set_campaign_goal'])
    expect(logs).toMatchObject([
      { entityId: 'c-it', userId: 'user:u-approver', executionId: null, amazonResponseStatus: null, payloadBefore: { targetAcos: null } },
      { entityId: 'c-uk', userId: 'user:u-approver', executionId: null, amazonResponseStatus: null, payloadBefore: { targetAcos: 0.3 } },
    ])
    expect(logs[0].evidence.note).toBe(`Claude request ${asked.approvalId}: one target for the season — Nexus only: never sent to Amazon.`)

    const undo = await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))
    expect(undo).toMatchObject({ request: { tool: TOOL, args: { targets: [{ campaignId: 'c-it', targetAcosPct: null }, { campaignId: 'c-uk', targetAcosPct: 30 }] } } })
    const back = await ask((undo as { request: { args: Record<string, unknown> } }).request.args)
    expect(await approve(back.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await dynamicOf('c-it')).toEqual({ placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 50 }] })
    expect(await dynamicOf('c-uk')).toEqual({ targetAcos: 0.3 })
  })

  it('a target that moved after the person approved is not run, and nothing changes', async () => {
    const asked = await ask({ market: 'IT', targetAcosPct: 20 })
    await setTarget('c-off', { targetAcos: 0.5 })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/^Not run: what you approved has moved since/) })
    expect(await dynamicOf('c-it')).toEqual({ placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 50 }] })
    expect(await dynamicOf('c-off')).toEqual({ targetAcos: 0.5 })
  })
})

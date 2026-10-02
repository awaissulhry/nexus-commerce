/**
 * MCP full control R13 — set-ad-guardrail, through the one door, on a real PostgreSQL (PGlite).
 *
 * Proven: tightening (a new or lower ceiling, a new bid ceiling, a protected term) is inside the limits; loosening (a
 * higher cap, a bid floor, a removal) needs a person; the write gate reads the new row at its next decision; undo puts
 * the guardrail back (removing one this change created); another business's scope is not found.
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
const OTHER = 'ws_r13_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const person: UserPrincipal = { kind: 'user', userId: 'u-r13', label: 'R13 test', permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) }, workspace: business(A), via: 'claude' }
type Out = { ok: boolean; error?: string; preview?: Record<string, any>; data?: Record<string, any>; change?: { before: any; after: any } }
const dry = async (args: Record<string, unknown>) => (await callTool(person, 'set-ad-guardrail', args)).raw as Out
const run = async (args: Record<string, unknown>) => (await executeTool(person, 'set-ad-guardrail', args, { via: 'claude' })).raw as Out
const tool = () => getTool('set-ad-guardrail')!
const inLimits = (preview: unknown) => tool().withinLimits!(preview, tool().limits!.parse({}))
const ids: Record<string, string> = {}
const savedMode = process.env.NEXUS_AMAZON_ADS_MODE

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`, [OTHER])
  await inside(async () => {
    ids.campaign = (await database.client.campaign.create({ data: { name: 'TEST CAMPAIGN', type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', liveBidWritesEnabled: true } })).id
  })
  await inside(async () => { ids.otherCampaign = (await database.client.campaign.create({ data: { name: 'TEST OTHER', type: 'SP', dailyBudget: '5.00', startDate: new Date(), marketplace: 'IT' } })).id }, OTHER)
}, 180_000)
afterAll(async () => {
  if (savedMode === undefined) delete process.env.NEXUS_AMAZON_ADS_MODE
  else process.env.NEXUS_AMAZON_ADS_MODE = savedMode
  await database?.close()
}, 30_000)

describe('R13 — set-ad-guardrail', () => {
  it('a new spend ceiling tightens (inside the limits); raising it loosens (a person decides); undo sets it back', async () => {
    const first = await dry({ kind: 'spend-ceiling', op: 'set', grain: 'MARKET', scopeId: 'IT', dailyCapCents: 5000 })
    expect(first.preview).toMatchObject({ direction: 'tighten', label: 'market IT', changes: { dailyCapCents: { from: null, to: 5000 } } })
    expect(inLimits(first.preview)).toBeNull()
    const created = await run({ kind: 'spend-ceiling', op: 'set', grain: 'MARKET', scopeId: 'IT', dailyCapCents: 5000 })
    expect(created.ok).toBe(true)
    expect((await inside(() => database.client.advertisingActionLog.findMany({ where: { actionType: 'set_spend_ceiling' } }))).map((r) => r.userId)).toEqual(['user:u-r13'])
    // Undo of a creation removes it.
    expect(tool().undo!.request(created.change!)).toEqual({ tool: 'set-ad-guardrail', args: { kind: 'spend-ceiling', op: 'remove', grain: 'MARKET', scopeId: 'IT' } })

    const raise = await dry({ kind: 'spend-ceiling', op: 'set', grain: 'MARKET', scopeId: 'IT', dailyCapCents: 9000 })
    expect(raise.preview).toMatchObject({ direction: 'loosen', why: 'the daily cap rises from 5000¢ to 9000¢' })
    expect(inLimits(raise.preview)).toBe('loosening a guardrail can raise spend (the daily cap rises from 5000¢ to 9000¢): a person decides')
    const raised = await run({ kind: 'spend-ceiling', op: 'set', grain: 'MARKET', scopeId: 'IT', dailyCapCents: 9000 })
    expect(await inside(() => tool().undo!.current(raised.change!))).toEqual(raised.change!.after)
    const back = tool().undo!.request(raised.change!) as { tool: string; args: Record<string, unknown> }
    expect(back.args).toMatchObject({ op: 'set', dailyCapCents: 5000 })
    expect((await run(back.args)).ok).toBe(true)
    expect(await inside(() => database.client.adSpendCeiling.findFirstOrThrow())).toMatchObject({ dailyCapCents: 5000 })
    expect((await dry({ kind: 'spend-ceiling', op: 'remove', grain: 'MARKET', scopeId: 'IT' })).preview).toMatchObject({ direction: 'loosen' })
  })

  it('a bid ceiling tightens and the write gate refuses a bid above it at its next decision; a bid floor loosens', async () => {
    const out = await run({ kind: 'bid-policy', op: 'set', grain: 'MARKET', scopeId: 'IT', maxBidCents: 100 })
    expect(out).toMatchObject({ ok: true, data: { direction: 'tighten' } })
    process.env.NEXUS_AMAZON_ADS_MODE = 'live'
    await inside(async () => {
      await database.client.adsAutomationState.create({ data: { id: 'singleton', autonomy: 'AUTO' } })
      await database.client.amazonAdsConnection.create({ data: { profileId: 'TEST-PROFILE-1', marketplace: 'IT', isActive: true, mode: 'production', writesEnabledAt: new Date() } as never })
    })
    const { checkAdsWriteGate } = await import('../../advertising/ads-write-gate.js')
    const decision = await inside(() => checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 150, campaignId: ids.campaign, field: 'bid', intendedValueCents: 150 }))
    expect(decision).toMatchObject({ allowed: false, deniedAt: 'entity_bounds' })
    const floor = await dry({ kind: 'bid-policy', op: 'set', grain: 'MARKET', scopeId: 'IT', minBidCents: 50 })
    expect(floor.preview).toMatchObject({ direction: 'loosen', why: 'a bid floor of 50¢ forces bids up' })
  })

  it('a protected term tightens; removing it loosens; undo of the addition removes it', async () => {
    const add = await dry({ kind: 'protected-term', op: 'set', term: '  Gale Jacket ' })
    expect(add.preview).toMatchObject({ direction: 'tighten' })
    const added = await run({ kind: 'protected-term', op: 'set', term: '  Gale Jacket ' })
    expect(added.change!.after.row).toEqual({ term: 'gale jacket', matchType: null, marketplace: null, campaignId: null })
    expect(await inside(() => tool().undo!.current(added.change!))).toEqual(added.change!.after)
    expect((await dry({ kind: 'protected-term', op: 'remove', term: 'gale jacket' })).preview).toMatchObject({ direction: 'loosen' })
    const undo = tool().undo!.request(added.change!) as { args: Record<string, unknown> }
    expect(undo.args).toMatchObject({ kind: 'protected-term', op: 'remove', term: 'Gale Jacket' })
    expect((await run(undo.args)).ok).toBe(true)
    expect(await inside(() => database.client.adKeywordProtection.count())).toBe(0)
  })

  it("another business's campaign is not found; a bid policy has no campaign grain", async () => {
    expect((await dry({ kind: 'spend-ceiling', op: 'set', grain: 'CAMPAIGN', scopeId: ids.otherCampaign, dailyCapCents: 100 })).error).toBe(`CAMPAIGN ${ids.otherCampaign}: not found in this business.`)
    expect((await dry({ kind: 'bid-policy', op: 'set', grain: 'CAMPAIGN', scopeId: ids.campaign, maxBidCents: 100 })).error).toContain("a campaign's own bid bounds are its Campaign columns")
  })
})

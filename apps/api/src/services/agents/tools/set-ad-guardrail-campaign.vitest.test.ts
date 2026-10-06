/**
 * ADS AUTONOMY W3-2 — set-ad-guardrail on one campaign's own guardrails, through the one door, on a real PostgreSQL
 * (PGlite): bid bounds, budget bounds and baseline, the largest bid change, the CPC ceiling and the pins.
 *
 * Proven: each kind's direction (tighten inside the default limits, loosen — anything that can add spend — a person
 * decides); a run writes the campaign through the code its screens use, with its audit row and the approver's name; the
 * write gate refuses a bid past the new bound; the ads strategy stays the outer band (the stricter number binds, so the
 * preview names the strategy's lower highest bid and largest change); undo sets each kind back whole; the screens'
 * permission (ads.campaigns.manage) is asked; another business's campaign is not found.
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
const OTHER = 'ws_w32_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const everything = new Set([...Object.values(FEATURES), ...Object.values(FIELDS)])
const person: UserPrincipal = { kind: 'user', userId: 'u-w32', label: 'W3-2 test', permissions: { isOwner: false, permissions: everything }, workspace: business(A), via: 'claude' }
type Out = { ok: boolean; error?: string; preview?: Record<string, any>; data?: Record<string, any>; change?: { before: any; after: any } }
const dry = async (args: Record<string, unknown>, who = person) => (await callTool(who, 'set-ad-guardrail', args)).raw as Out
const run = async (args: Record<string, unknown>) => (await executeTool(person, 'set-ad-guardrail', args, { via: 'claude' })).raw as Out
const tool = () => getTool('set-ad-guardrail')!
const inLimits = (preview: unknown, limits: Record<string, unknown> = {}) => tool().withinLimits!(preview, tool().limits!.parse(limits))
const ids: Record<string, string> = {}
const campaignNow = () => inside(() => database.client.campaign.findUniqueOrThrow({ where: { id: ids.campaign } }))

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`, [OTHER])
  await inside(async () => {
    ids.campaign = (await database.client.campaign.create({ data: { name: 'TEST W32 CAMPAIGN', type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', liveBidWritesEnabled: true, dynamicBidding: { placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 20 }] } } })).id
    // The market's ads strategy: a highest bid and a largest change (made-up numbers).
    await database.client.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', updatedBy: 'user:test', maxBidCents: 120, maxChangePct: 15 } })
  })
  await inside(async () => { ids.otherCampaign = (await database.client.campaign.create({ data: { name: 'TEST W32 OTHER', type: 'SP', dailyBudget: '5.00', startDate: new Date(), marketplace: 'IT' } })).id }, OTHER)
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)

describe('W3-2 — set-ad-guardrail on a campaign\'s own guardrails', () => {
  it('each kind: tightening runs inside the default limits, loosening (it can add spend) waits for a person', async () => {
    const c = ids.campaign
    const expectDirection = async (args: Record<string, unknown>, direction: 'tighten' | 'loosen', why?: string) => {
      const out = await dry({ campaignId: c, op: 'set', ...args })
      expect(out.error, JSON.stringify(args)).toBeUndefined()
      expect(out.preview, JSON.stringify(args)).toMatchObject({ direction, ...(why ? { why } : {}) })
      expect(out.preview!.raises.length > 0, JSON.stringify(args)).toBe(direction === 'loosen')
      expect(inLimits(out.preview) === null, JSON.stringify(args)).toBe(direction === 'tighten')
      if (direction === 'loosen') expect(inLimits(out.preview, { allowLoosen: true })).toBeNull()
      return out.preview!
    }
    const set = async (args: Record<string, unknown>) => expect((await run({ campaignId: c, op: 'set', ...args })).ok, JSON.stringify(args)).toBe(true)

    // Bid bounds.
    await expectDirection({ kind: 'campaign-bid-bounds', maxBidCents: 200 }, 'tighten')
    await set({ kind: 'campaign-bid-bounds', maxBidCents: 200 })
    await expectDirection({ kind: 'campaign-bid-bounds', maxBidCents: 150 }, 'tighten')
    await expectDirection({ kind: 'campaign-bid-bounds', maxBidCents: 250 }, 'loosen', 'the highest bid rises from 200¢ to 250¢')
    await expectDirection({ kind: 'campaign-bid-bounds', maxBidCents: null }, 'loosen', 'the highest bid (200¢) is cleared')
    await expectDirection({ kind: 'campaign-bid-bounds', minBidCents: 10 }, 'loosen', 'a lowest bid of 10¢ forces bids up')
    await set({ kind: 'campaign-bid-bounds', minBidCents: 10 })
    await expectDirection({ kind: 'campaign-bid-bounds', minBidCents: 5 }, 'tighten')
    await expectDirection({ kind: 'campaign-bid-bounds', minBidCents: null }, 'tighten')

    // Budget bounds and the baseline (the campaign spends 10.00 a day: 1000 cents).
    await expectDirection({ kind: 'campaign-budget-bounds', maxBudgetCents: 3000 }, 'tighten')
    await set({ kind: 'campaign-budget-bounds', maxBudgetCents: 3000 })
    await expectDirection({ kind: 'campaign-budget-bounds', maxBudgetCents: 4000 }, 'loosen', 'the highest daily budget rises from EUR 30.00 to EUR 40.00')
    await expectDirection({ kind: 'campaign-budget-bounds', minBudgetCents: 500 }, 'loosen', 'a lowest daily budget of EUR 5.00 stops budget cuts below it')
    await expectDirection({ kind: 'campaign-budget-bounds', budgetBaselineCents: 1500 }, 'loosen', 'relative budget rules and a restore to baseline start from EUR 15.00 instead of EUR 10.00')
    await expectDirection({ kind: 'campaign-budget-bounds', budgetBaselineCents: 800 }, 'tighten')

    // The largest bid change.
    await expectDirection({ kind: 'bid-change-cap', maxBidChangePct: 30 }, 'tighten')
    await set({ kind: 'bid-change-cap', maxBidChangePct: 30 })
    await expectDirection({ kind: 'bid-change-cap', maxBidChangePct: 40 }, 'loosen', 'the largest bid change rises from 30 % to 40 %')
    await expectDirection({ kind: 'bid-change-cap', maxBidChangePct: 20 }, 'tighten')
    await expectDirection({ kind: 'bid-change-cap', maxBidChangePct: null }, 'loosen', 'the largest bid change (30 %) is cleared')

    // The CPC ceiling.
    await expectDirection({ kind: 'cpc-ceiling', cpcMultiple: 2 }, 'tighten')
    await set({ kind: 'cpc-ceiling', cpcMultiple: 2 })
    await expectDirection({ kind: 'cpc-ceiling', cpcMultiple: 3 }, 'loosen', 'the CPC ceiling rises from 2× to 3× the average cost per click')
    await expectDirection({ kind: 'cpc-ceiling', cpcMultiple: 1.5 }, 'tighten')
    await expectDirection({ kind: 'cpc-ceiling', enabled: false }, 'loosen', 'the CPC ceiling (2×) is switched off')

    // Pins.
    await expectDirection({ kind: 'pin', pinBids: true }, 'tighten')
    await set({ kind: 'pin', pinBids: true, note: 'test hold' })
    await expectDirection({ kind: 'pin', pinBids: false }, 'loosen')
    expect((await dry({ campaignId: c, op: 'remove', kind: 'pin' })).preview).toMatchObject({ direction: 'loosen', changes: { pinBids: { from: true, to: false }, note: { from: 'test hold', to: null } } })

    expect((await dry({ campaignId: c, op: 'set', kind: 'pin', pinBids: true, note: 'test hold' })).error).toBe('The pin of campaign "TEST W32 CAMPAIGN" already holds these values.')
    expect((await dry({ campaignId: c, op: 'set', kind: 'campaign-bid-bounds', minBidCents: 300 })).error).toBe('would leave "TEST W32 CAMPAIGN" with min 300¢ > max 200¢')
    expect((await dry({ campaignId: c, op: 'set', kind: 'campaign-budget-bounds', minBudgetCents: 50 })).error).toBe("minBudgetCents must be ≥ 100 cents (Amazon's own floor is €1) or null")
  })

  it('the ads strategy stays the outer band: the preview names the stricter number that binds after the change', async () => {
    // Campaign highest bid 200¢ above the strategy's 120¢: the strategy's binds.
    const loose = await dry({ campaignId: ids.campaign, op: 'set', kind: 'campaign-bid-bounds', maxBidCents: 180 })
    expect(loose.preview!.inForce.maxBidCents.value).toBe(120)
    expect(loose.preview!.inForce.maxBidCents.from).toContain('strategy')
    expect(loose.preview!.effect).toContain('the stricter number winning')
    // Below it: the campaign's own binds.
    const tight = await dry({ campaignId: ids.campaign, op: 'set', kind: 'campaign-bid-bounds', maxBidCents: 90 })
    expect(tight.preview!.inForce.maxBidCents).toEqual({ value: 90, from: `Campaign.maxBidCents on ${ids.campaign}` })
    // The largest change: the strategy's 15 % is lower than the campaign's 30 %.
    const cap = await dry({ campaignId: ids.campaign, op: 'set', kind: 'bid-change-cap', maxBidChangePct: 25 })
    expect(cap.preview!.inForce.maxBidChangePct.value).toBe(15)
    const own = await dry({ campaignId: ids.campaign, op: 'set', kind: 'bid-change-cap', maxBidChangePct: 10 })
    expect(own.preview!.inForce.maxBidChangePct).toEqual({ value: 10, from: "the campaign's own largest bid change" })
  })

  it('a run writes through the screens\' code (audit, approver), the write gate refuses past the bound, and undo sets it back', async () => {
    const out = await run({ campaignId: ids.campaign, op: 'set', kind: 'campaign-bid-bounds', maxBidCents: 100 })
    expect(out).toMatchObject({ ok: true, data: { kind: 'campaign-bid-bounds', direction: 'tighten', label: 'campaign "TEST W32 CAMPAIGN"' } })
    expect(await campaignNow()).toMatchObject({ maxBidCents: 100, minBidCents: 10 })
    const logs = await inside(() => database.client.advertisingActionLog.findMany({ where: { entityId: ids.campaign, actionType: 'set_campaign_bid_bounds' }, orderBy: { createdAt: 'desc' } }))
    expect(logs[0]).toMatchObject({ userId: 'user:u-w32', payloadAfter: { maxBidCents: 100 } })

    const { entityBoundsDenial } = await import('../../advertising/ads-write-gate.js')
    const c = await campaignNow()
    expect(await inside(() => entityBoundsDenial({ campaignId: ids.campaign, campaign: c, field: 'bid', intendedValueCents: 110 }))).toMatchObject({ allowed: false, deniedAt: 'entity_bounds' })
    expect(await inside(() => entityBoundsDenial({ campaignId: ids.campaign, campaign: c, field: 'bid', intendedValueCents: 95 }))).toBeNull()

    // Undo: the bounds as they were before this run (the 200¢ highest bid, the 10¢ lowest).
    expect(await inside(() => tool().undo!.current(out.change!))).toEqual(out.change!.after)
    const back = tool().undo!.request(out.change!) as { tool: string; args: Record<string, unknown> }
    expect(back).toEqual({ tool: 'set-ad-guardrail', args: { kind: 'campaign-bid-bounds', op: 'set', campaignId: ids.campaign, minBidCents: 10, maxBidCents: 200 } })
    expect((await run(back.args)).ok).toBe(true)
    expect(await campaignNow()).toMatchObject({ maxBidCents: 200, minBidCents: 10 })
  })

  it('undo round trip of the budget bounds, the largest change, the CPC ceiling and the pins — cleared values too', async () => {
    const cases: Array<Record<string, unknown>> = [
      { kind: 'campaign-budget-bounds', minBudgetCents: 400, budgetBaselineCents: 900 },
      { kind: 'bid-change-cap', maxBidChangePct: 12 },
      { kind: 'cpc-ceiling', enabled: false },
      { kind: 'pin', pinBudget: true, pinPlacement: true },
    ]
    for (const args of cases) {
      const before = await campaignNow()
      const out = await run({ campaignId: ids.campaign, op: 'set', ...args })
      expect(out.ok, JSON.stringify(args)).toBe(true)
      expect(await inside(() => tool().undo!.current(out.change!))).toEqual(out.change!.after)
      const back = tool().undo!.request(out.change!) as { tool: string; args: Record<string, unknown> }
      expect(tool().input.safeParse(back.args).success, JSON.stringify(back.args)).toBe(true)
      expect((await run(back.args)).ok, JSON.stringify(back.args)).toBe(true)
      const after = await campaignNow()
      for (const key of ['minBudgetCents', 'maxBudgetCents', 'budgetBaselineCents', 'pinBids', 'pinBudget', 'pinPlacement', 'pinNote'] as const) expect(after[key], `${String(args.kind)} ${key}`).toEqual(before[key])
      expect(after.dynamicBidding, String(args.kind)).toEqual(before.dynamicBidding)
    }
    // The placement adjustment another writer keeps in the same settings is untouched throughout.
    expect((await campaignNow()).dynamicBidding).toMatchObject({ placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 20 }] })
  })

  it('the screens\' permission is asked for a campaign kind (not for the others); another business\'s campaign is not found', async () => {
    const noCampaigns: UserPrincipal = { ...person, permissions: { isOwner: false, permissions: new Set([...everything].filter((p) => p !== FEATURES.adsCampaignsManage)) } }
    expect((await dry({ campaignId: ids.campaign, op: 'set', kind: 'bid-change-cap', maxBidChangePct: 5 }, noCampaigns)).error).toBe(`Setting a campaign's bid-change-cap needs the ${FEATURES.adsCampaignsManage} permission.`)
    expect((await dry({ kind: 'protected-term', op: 'set', term: 'w32 test term' }, noCampaigns)).ok).toBe(true)
    expect((await dry({ campaignId: ids.otherCampaign, op: 'set', kind: 'pin', pinBids: true })).error).toBe(`campaignId ${ids.otherCampaign}: not found in this business.`)
    expect((await dry({ op: 'set', kind: 'pin', pinBids: true })).error).toBe('campaignId: the Nexus id of the campaign (ad-campaigns lists it)')
  })
})

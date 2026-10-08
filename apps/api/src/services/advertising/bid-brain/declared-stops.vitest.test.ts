/**
 * BID BRAIN BB-8 — a campaign the brain owns is stopped and given back by DECLARING only. Real PostgreSQL with the
 * production schema (PGlite), business profiles ON. The bid writers are spies: what is proven is that no bid is written
 * and no memory kept for an owned campaign, that the marks the brain reads (who, which floor) are set and cleared, that a
 * memory left from before the campaign joined is dropped when the stop lifts — and that every other campaign, and every
 * campaign under a ceiling other than `live`, is stopped and given back exactly as before. Values are made up.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
const writes: string[] = []
vi.mock('../ads-mutation.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  updateAdGroupWithSync: vi.fn(async (a: { adGroupId: string; patch: { defaultBidCents: number } }) => {
    writes.push(`group ${a.adGroupId} → ${a.patch.defaultBidCents}`)
    await database.client.adGroup.update({ where: { id: a.adGroupId }, data: { defaultBidCents: a.patch.defaultBidCents } })
    return { ok: true }
  }),
  updateAdTargetWithSync: vi.fn(async (a: { adTargetId: string; patch: { bidCents: number } }) => {
    writes.push(`target ${a.adTargetId} → ${a.patch.bidCents}`)
    await database.client.adTarget.update({ where: { id: a.adTargetId }, data: { bidCents: a.patch.bidCents } })
    return { ok: true }
  }),
}))

import { lowerAdGroupBids, refloorCampaignBids, restoreAdGroupBids, restoreCampaignBids, suppressAdGroupBids, suppressCampaignBids } from '../ads-bid-suppression.service.js'
import { flooredNow, setEnrollment } from './enrollment.js'
import { applyRetailGuard, RETAIL_LIFT_MIN_AGE_MS } from '../ads-retail-readiness.service.js'
import { ACTION_HANDLERS } from '../../automation-rule.service.js'
import '../automation-action-handlers.js' // fills ACTION_HANDLERS, retail_guard among them

const A = 'bb8_declared_alpha'
const inA = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client
const BUDGET = 'automation:budget-manager-cron' as const
const RETAIL = 'automation:retail-guard' as const
const openHolds = (campaignId: string) => inA(() => db().bidHold.findMany({ where: { campaignId, endedAt: null }, select: { kind: true, by: true, reason: true, floorCents: true }, orderBy: { createdAt: 'asc' } }))
/** Moves a stop's start back by `ms`: its mark and its holds (the 2-hour damping reads their age). */
const age = (campaignId: string, ms: number) => inA(async () => {
  const c = await db().campaign.findUnique({ where: { id: campaignId }, select: { bidsSuppressedAt: true } })
  if (c?.bidsSuppressedAt) await db().campaign.update({ where: { id: campaignId }, data: { bidsSuppressedAt: new Date(c.bidsSuppressedAt.getTime() - ms) } })
  for (const h of await db().bidHold.findMany({ where: { campaignId }, select: { id: true, createdAt: true } })) {
    await db().bidHold.update({ where: { id: h.id }, data: { createdAt: new Date(h.createdAt.getTime() - ms) } })
  }
})
const ids = { owned: '', other: '', ownedGroup: '', otherGroup: '' }

async function state(campaignId: string) {
  return inA(async () => {
    const c = await db().campaign.findUnique({ where: { id: campaignId }, select: { bidsSuppressedAt: true, bidsSuppressedFloorCents: true, bidsSuppressedBy: true } })
    const g = await db().adGroup.findMany({ where: { campaignId }, select: { defaultBidCents: true, suppressedFromBidCents: true, bidsSuppressedBy: true, bidsSuppressedFloorCents: true } })
    const t = await db().adTarget.findMany({ where: { adGroup: { campaignId } }, select: { bidCents: true, suppressedFromBidCents: true } })
    return { marks: c!.bidsSuppressedAt ? { by: c!.bidsSuppressedBy, floor: c!.bidsSuppressedFloorCents } : null, groups: g.map((x) => [x.defaultBidCents, x.suppressedFromBidCents, x.bidsSuppressedBy, x.bidsSuppressedFloorCents]), targets: t.map((x) => [x.bidCents, x.suppressedFromBidCents]) }
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [A])
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

beforeEach(async () => {
  writes.length = 0
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  await inA(async () => {
    await db().bidBrainEnrollment.deleteMany({})
    await db().bidHold.deleteMany({})
    await db().adTarget.deleteMany({})
    await db().adGroup.deleteMany({})
    await db().campaign.deleteMany({})
    const camp = (name: string) => db().campaign.create({ data: { name, type: 'SP', marketplace: 'IT', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z') } as never })
    ids.owned = (await camp('Owned')).id
    ids.other = (await camp('Other')).id
    ids.ownedGroup = (await db().adGroup.create({ data: { campaignId: ids.owned, name: 'owned', defaultBidCents: 40 } })).id
    ids.otherGroup = (await db().adGroup.create({ data: { campaignId: ids.other, name: 'other', defaultBidCents: 30 } })).id
    await db().adTarget.create({ data: { adGroupId: ids.ownedGroup, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'owned kw', bidCents: 55 } })
    await db().adTarget.create({ data: { adGroupId: ids.otherGroup, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'other kw', bidCents: 45 } })
    await db().bidBrainEnrollment.create({ data: { campaignId: ids.owned, marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:test' } })
  })
})

describe('a campaign the brain owns', () => {
  it('a stop is declared: its marks are set, no bid written, no memory kept; a re-floor only moves the declared floor', async () => {
    expect(await inA(() => suppressCampaignBids(ids.owned, { actor: BUDGET, floorCents: 3 }))).toBe(0)
    expect(writes).toEqual([])
    expect(await state(ids.owned)).toEqual({ marks: { by: BUDGET, floor: 3 }, groups: [[40, null, null, null]], targets: [[55, null]] })
    expect(await inA(() => refloorCampaignBids(ids.owned, { actor: BUDGET, floorCents: 5 }))).toBe(0)
    expect((await state(ids.owned)).marks).toEqual({ by: BUDGET, floor: 5 })
    expect(writes).toEqual([])
  })

  it('a give-back clears the marks and drops a memory left from before it joined; nothing is written', async () => {
    await inA(() => db().adTarget.updateMany({ where: { adGroupId: ids.ownedGroup }, data: { suppressedFromBidCents: 60 } }))
    await inA(() => db().campaign.update({ where: { id: ids.owned }, data: { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: 2, bidsSuppressedBy: BUDGET } }))
    expect(await inA(() => restoreCampaignBids(ids.owned, { actor: BUDGET }))).toBe(0)
    expect(writes).toEqual([])
    expect(await state(ids.owned)).toEqual({ marks: null, groups: [[40, null, null, null]], targets: [[55, null]] })
  })

  it('an ad group’s own stop and a stock floor are declared the same way, and lifted without a write', async () => {
    expect(await inA(() => suppressAdGroupBids(ids.ownedGroup, { actor: BUDGET, floorCents: 4 }))).toBe(0)
    expect((await state(ids.owned)).groups).toEqual([[40, null, BUDGET, 4]])
    expect(await inA(() => restoreAdGroupBids(ids.ownedGroup, { actor: BUDGET }))).toBe(0)
    expect((await state(ids.owned)).groups).toEqual([[40, null, null, null]])
    expect(await inA(() => lowerAdGroupBids(ids.ownedGroup, { actor: 'user:u1', reason: 'out of stock', floorCents: 2 }))).toEqual({ moved: 0, failed: 0 })
    expect((await state(ids.owned)).groups).toEqual([[40, null, 'user:u1', 2]])
    expect(writes).toEqual([])
  })

  it('#513 review — a second owner\'s stop is a STOP hold with its own floor; the first owner\'s lift hands it the mark and keeps the saved bids', async () => {
    await inA(() => suppressCampaignBids(ids.owned, { actor: BUDGET, floorCents: 5 }))
    await inA(() => suppressCampaignBids(ids.owned, { actor: RETAIL, floorCents: 2, reason: 'unsellable' }))
    expect(await openHolds(ids.owned)).toEqual([{ kind: 'STOP', by: RETAIL, reason: 'unsellable', floorCents: 2 }])
    // The brain floored the keyword and kept its bid (shadow.ts rememberFloors), as on a live run.
    await inA(() => db().adTarget.updateMany({ where: { adGroupId: ids.ownedGroup }, data: { bidCents: 2, suppressedFromBidCents: 55 } }))
    const declared = (await inA(() => db().bidHold.findFirst({ where: { campaignId: ids.owned, kind: 'STOP' }, select: { createdAt: true } })))!.createdAt
    expect(await inA(() => restoreCampaignBids(ids.owned, { actor: BUDGET }))).toBe(0)
    expect(await state(ids.owned)).toEqual({ marks: { by: RETAIL, floor: 2 }, groups: [[40, null, null, null]], targets: [[2, 55]] })
    expect((await inA(() => db().campaign.findUnique({ where: { id: ids.owned }, select: { bidsSuppressedAt: true } })))!.bidsSuppressedAt).toEqual(declared)
    expect(await openHolds(ids.owned)).toEqual([])
    // Its owner lifts it: the marks and the memory go (the brain gives the bid back from its own record).
    await inA(() => restoreCampaignBids(ids.owned, { actor: RETAIL }))
    expect(await state(ids.owned)).toEqual({ marks: null, groups: [[40, null, null, null]], targets: [[2, null]] })
    expect(writes).toEqual([])
  })

  it('#513 review — leaving the brain (op shadow) with a stop declared and the mark free: the stop takes the mark; LIVE is refused while one is open', async () => {
    // A hold written before BidHold.floorCents: its floor is read from the head of its reason.
    await inA(() => db().bidHold.create({ data: { campaignId: ids.owned, kind: 'STOP', by: RETAIL, reason: '3¢ floor: unsellable' } }))
    expect(await inA(() => flooredNow(ids.owned))).toMatch(/held at a floor now \(by automation:retail-guard\)/)
    await inA(() => setEnrollment({ campaignId: ids.owned, marketplace: 'IT', op: 'shadow', by: 'user:test' }))
    expect((await state(ids.owned)).marks).toEqual({ by: RETAIL, floor: 3 })
    expect(await openHolds(ids.owned)).toEqual([])
  })

  it('#513 review — op give-back with a stop declared behind another owner\'s mark: it stays declared, LIVE is refused, and it takes the mark when that owner lifts (bids stay floored)', async () => {
    await inA(() => suppressCampaignBids(ids.owned, { actor: BUDGET, floorCents: 2 }))
    await inA(() => suppressCampaignBids(ids.owned, { actor: RETAIL, floorCents: 2, reason: 'unsellable' }))
    await inA(() => db().adTarget.updateMany({ where: { adGroupId: ids.ownedGroup }, data: { bidCents: 2, suppressedFromBidCents: 55 } }))
    await inA(() => setEnrollment({ campaignId: ids.owned, marketplace: 'IT', op: 'give-back', by: 'user:test' }))
    expect(await openHolds(ids.owned)).toEqual([{ kind: 'STOP', by: RETAIL, reason: 'unsellable', floorCents: 2 }])
    expect(await inA(() => flooredNow(ids.owned))).toMatch(/\(by automation:budget-manager-cron, automation:retail-guard\)/)
    // Not owned any more: today's give-back runs, and the stop still declared takes the mark instead — nothing written.
    expect(await inA(() => restoreCampaignBids(ids.owned, { actor: BUDGET }))).toBe(0)
    expect(await state(ids.owned)).toEqual({ marks: { by: RETAIL, floor: 2 }, groups: [[40, null, null, null]], targets: [[2, 55]] })
    expect(writes).toEqual([])
    // A person's restore lifts every stop and gives the bids back.
    expect(await inA(() => restoreCampaignBids(ids.owned, { actor: 'user:u1', manual: true }))).toBe(1)
    expect(await state(ids.owned)).toEqual({ marks: null, groups: [[40, null, null, null]], targets: [[55, null]] })
    expect(await openHolds(ids.owned)).toEqual([])
  })

  it('#513 follow-up — the retail guard flapping (flag, unflag, flag): a stop younger than 2 hours stays; once older it lifts', async () => {
    const guard = (flagged: string[]) => inA(() => applyRetailGuard({ campaignIds: flagged, sellable: [ids.owned].filter((id) => !flagged.includes(id)), actor: 'retail-guard' }))
    await guard([ids.owned])
    expect((await state(ids.owned)).marks).toEqual({ by: RETAIL, floor: 2 })
    // 15 minutes later it sells again: the stop is young, so it stays (no floor-and-give-back each run).
    expect(await guard([])).toMatchObject({ lifted: [], waiting: [ids.owned] })
    expect((await state(ids.owned)).marks).toEqual({ by: RETAIL, floor: 2 })
    // Flagged again: the same stop, nothing new.
    await guard([ids.owned])
    expect((await state(ids.owned)).marks).toEqual({ by: RETAIL, floor: 2 })
    // Two hours on and sellable: lifted.
    await age(ids.owned, RETAIL_LIFT_MIN_AGE_MS)
    expect(await guard([])).toMatchObject({ lifted: [ids.owned], waiting: [] })
    expect((await state(ids.owned)).marks).toBeNull()
    // Its STOP hold behind another owner's mark is damped the same way; the other owner's mark stays.
    await inA(() => suppressCampaignBids(ids.owned, { actor: BUDGET, floorCents: 3 }))
    await guard([ids.owned])
    expect(await openHolds(ids.owned)).toEqual([{ kind: 'STOP', by: RETAIL, reason: expect.any(String), floorCents: 2 }])
    expect(await guard([])).toMatchObject({ lifted: [], waiting: [ids.owned] })
    await age(ids.owned, RETAIL_LIFT_MIN_AGE_MS)
    expect(await guard([])).toMatchObject({ lifted: [ids.owned] })
    expect(await openHolds(ids.owned)).toEqual([])
    expect((await state(ids.owned)).marks).toEqual({ by: BUDGET, floor: 3 })
    expect(writes).toEqual([])
  })

  it('#513 follow-up — the retail guard rule\'s dry run lists the stops it would lift (spend rises) and the ones still damped', async () => {
    await inA(() => db().campaign.updateMany({ data: { status: 'ENABLED' } }))
    const RULE = 'automation:rule-test'
    await inA(() => suppressCampaignBids(ids.owned, { actor: RULE, floorCents: 2 }))
    const preview = () => inA(() => ACTION_HANDLERS.retail_guard({ type: 'retail_guard', marketplace: 'IT' } as never, {} as never, { dryRun: true, ruleId: 'rule-test' } as never))
    expect((await preview()).output).toMatchObject({ dryRun: true, wouldPause: 0, wouldLift: 0, liftWaiting: 1, liftWaitingNote: expect.stringMatching(/younger than 2 hours/) })
    await age(ids.owned, RETAIL_LIFT_MIN_AGE_MS)
    const out = (await preview()).output as Record<string, unknown>
    expect(out).toMatchObject({ wouldLift: 1, liftSample: [{ id: ids.owned, name: 'Owned' }], liftNote: expect.stringMatching(/spend more/) })
    expect(out.liftWaiting).toBeUndefined()
    // A preview only: the stop is still there.
    expect((await state(ids.owned)).marks).toEqual({ by: RULE, floor: 2 })
  })

  it('a HELD enrollment is still owned (no raises; the brain is still the one writer)', async () => {
    await inA(() => db().bidBrainEnrollment.updateMany({ where: { campaignId: ids.owned }, data: { mode: 'HELD', heldBy: 'auto-undo' } }))
    await inA(() => suppressCampaignBids(ids.owned, { actor: BUDGET, floorCents: 3 }))
    expect(writes).toEqual([])
  })
})

describe('every other campaign, as before', () => {
  it('a campaign not enrolled is floored and remembered, and given back', async () => {
    expect(await inA(() => suppressCampaignBids(ids.other, { actor: BUDGET, floorCents: 3 }))).toBe(2)
    expect(await state(ids.other)).toEqual({ marks: { by: BUDGET, floor: 3 }, groups: [[3, 30, null, null]], targets: [[3, 45]] })
    expect(await inA(() => restoreCampaignBids(ids.other, { actor: BUDGET }))).toBe(2)
    expect(await state(ids.other)).toEqual({ marks: null, groups: [[30, null, null, null]], targets: [[45, null]] })
  })

  it('under a ceiling other than live, an enrolled campaign is not owned: floored and remembered as before', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    expect(await inA(() => suppressCampaignBids(ids.owned, { actor: BUDGET, floorCents: 3 }))).toBe(2)
    expect(await state(ids.owned)).toEqual({ marks: { by: BUDGET, floor: 3 }, groups: [[3, 40, null, null]], targets: [[3, 55]] })
  })
})

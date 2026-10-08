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

const A = 'bb8_declared_alpha'
const inA = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client
const BUDGET = 'automation:budget-manager-cron' as const
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

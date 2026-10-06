/**
 * ADS AUTONOMY W1-6b — an ad group floored ON ITS OWN (a product over its own monthly cap) and the campaign floors of
 * every other engine never lift each other's floors. Real PostgreSQL with the production schema (PGlite), business
 * profiles ON. The two bid writers are stand-ins that write the bid as Amazon would accept it; what is proven is which
 * bids move, what each floor remembers and who owns it. Values are made up (public repo).
 *
 *   floor       the ad group's default and targets go to its stop bid, each bid remembered; a bid already lower stays;
 *               the ad group carries its owner; the campaign's other ad groups are untouched
 *   campaign    another engine's campaign floor over it: what is not yet floored is floored; its restore, re-floor and
 *               base-bid moves leave the ad group's own floor alone
 *   give back   the owner restores its own floor exactly; inside a campaign floored by anyone it only hands its memory
 *               over, and the campaign's restore then puts those bids back too
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
// The bid writers: Amazon accepts every bid (the gate, the queue and the action log are the mutation layer's own tests).
vi.mock('./ads-mutation.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  updateAdGroupWithSync: vi.fn(async (a: { adGroupId: string; patch: { defaultBidCents: number } }) => {
    await database.client.adGroup.update({ where: { id: a.adGroupId }, data: { defaultBidCents: a.patch.defaultBidCents } })
    return { ok: true }
  }),
  updateAdTargetWithSync: vi.fn(async (a: { adTargetId: string; patch: { bidCents: number } }) => {
    await database.client.adTarget.update({ where: { id: a.adTargetId }, data: { bidCents: a.patch.bidCents } })
    return { ok: true }
  }),
}))

import {
  applyBaseBidDelta, refloorCampaignBids, restoreAdGroupBids, restoreCampaignBids, revertBaseBidDelta, suppressAdGroupBids, suppressCampaignBids,
} from './ads-bid-suppression.service.js'

const A = 'w16b_floor_alpha'
const inA = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client
const BUDGET = 'automation:budget-manager-cron' as const
const RANK = 'automation:rank-defend-test' as const
const ids = { c: '', capped: '', other: '' }

/** Every bid and memory of the campaign, by name: [bid, remembered]. */
async function state() {
  return inA(async () => {
    const groups = await db().adGroup.findMany({ where: { campaignId: ids.c }, select: { name: true, defaultBidCents: true, suppressedFromBidCents: true, bidsSuppressedBy: true, bidsSuppressedFloorCents: true } })
    const targets = await db().adTarget.findMany({ where: { adGroup: { campaignId: ids.c } }, select: { expressionValue: true, bidCents: true, suppressedFromBidCents: true } })
    const campaign = await db().campaign.findUnique({ where: { id: ids.c }, select: { bidsSuppressedBy: true } })
    return {
      campaign: campaign!.bidsSuppressedBy,
      groups: Object.fromEntries(groups.map((g) => [g.name, { bid: [g.defaultBidCents, g.suppressedFromBidCents], own: g.bidsSuppressedBy, floor: g.bidsSuppressedFloorCents }])),
      targets: Object.fromEntries(targets.map((t) => [t.expressionValue, [t.bidCents, t.suppressedFromBidCents]])),
    }
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
  await inA(async () => {
    await db().adTarget.deleteMany({})
    await db().adGroup.deleteMany({})
    await db().campaign.deleteMany({})
    ids.c = (await db().campaign.create({ data: { name: 'Test campaign', type: 'SP', marketplace: 'IT', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z') } as never })).id
    ids.capped = (await db().adGroup.create({ data: { campaignId: ids.c, name: 'capped', defaultBidCents: 40 } })).id
    ids.other = (await db().adGroup.create({ data: { campaignId: ids.c, name: 'other', defaultBidCents: 30 } })).id
    for (const [adGroupId, text, bid] of [[ids.capped, 'capped high', 55], [ids.capped, 'capped low', 8], [ids.other, 'other kw', 45]] as const) {
      await db().adTarget.create({ data: { adGroupId, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: text, bidCents: bid } })
    }
  })
})

describe('an ad group floored on its own', () => {
  it('floors its default and targets to the stop bid, remembers each, stamps its owner; a lower bid and the other ad group stay', async () => {
    expect(await inA(() => suppressAdGroupBids(ids.capped, { actor: BUDGET, floorCents: 9 }))).toBe(2)
    expect(await state()).toEqual({
      campaign: null,
      groups: { capped: { bid: [9, 40], own: BUDGET, floor: 9 }, other: { bid: [30, null], own: null, floor: null } },
      targets: { 'capped high': [9, 55], 'capped low': [8, null], 'other kw': [45, null] },
    })
    // Idempotent: already floored on its own.
    expect(await inA(() => suppressAdGroupBids(ids.capped, { actor: BUDGET, floorCents: 3 }))).toBe(0)
  })

  it('another engine\'s campaign floor over it: its restore, re-floor and base-bid moves leave the ad group\'s floor alone', async () => {
    await inA(() => suppressAdGroupBids(ids.capped, { actor: BUDGET, floorCents: 9 }))
    await inA(() => suppressCampaignBids(ids.c, { actor: RANK, floorCents: 2 }))
    // What was not floored yet is (the 8¢ keyword, the other ad group); what the ad group's floor holds keeps its memory.
    expect((await state()).targets).toEqual({ 'capped high': [9, 55], 'capped low': [2, 8], 'other kw': [2, 45] })

    await inA(() => refloorCampaignBids(ids.c, { actor: RANK, floorCents: 20 }))
    expect((await state()).targets).toMatchObject({ 'capped high': [9, 55], 'capped low': [2, 8], 'other kw': [20, 45] })

    await inA(() => restoreCampaignBids(ids.c, { actor: RANK }))
    expect(await state()).toEqual({
      campaign: null,
      groups: { capped: { bid: [9, 40], own: BUDGET, floor: 9 }, other: { bid: [30, null], own: null, floor: null } },
      targets: { 'capped high': [9, 55], 'capped low': [2, 8], 'other kw': [45, null] },
    })

    await inA(() => applyBaseBidDelta(ids.c, 50, { actor: RANK }))
    expect((await state()).targets).toMatchObject({ 'capped high': [9, 55], 'capped low': [2, 8], 'other kw': [68, null] })
    await inA(() => revertBaseBidDelta(ids.c, { actor: RANK }))
    expect((await state()).targets).toMatchObject({ 'capped high': [9, 55], 'other kw': [45, null] })
  })

  it('its owner gives back exactly what it floored (and what a campaign floor floored under it since)', async () => {
    await inA(() => suppressAdGroupBids(ids.capped, { actor: BUDGET, floorCents: 9 }))
    await inA(() => suppressCampaignBids(ids.c, { actor: RANK, floorCents: 2 }))
    await inA(() => restoreCampaignBids(ids.c, { actor: RANK }))
    await inA(() => restoreAdGroupBids(ids.capped, { actor: BUDGET }))
    expect(await state()).toEqual({
      campaign: null,
      groups: { capped: { bid: [40, null], own: null, floor: null }, other: { bid: [30, null], own: null, floor: null } },
      targets: { 'capped high': [55, null], 'capped low': [8, null], 'other kw': [45, null] },
    })
  })

  it('inside a campaign another engine floored, the owner only hands its memory over; that campaign\'s restore puts every bid back', async () => {
    await inA(() => suppressAdGroupBids(ids.capped, { actor: BUDGET, floorCents: 9 }))
    await inA(() => suppressCampaignBids(ids.c, { actor: RANK, floorCents: 2 }))
    expect(await inA(() => restoreAdGroupBids(ids.capped, { actor: BUDGET }))).toBe(0)
    expect(await state()).toEqual({
      campaign: RANK, // rank's floor is not lifted by the ad group's owner
      groups: { capped: { bid: [9, 40], own: null, floor: null }, other: { bid: [2, 30], own: null, floor: null } },
      targets: { 'capped high': [9, 55], 'capped low': [2, 8], 'other kw': [2, 45] },
    })
    await inA(() => restoreCampaignBids(ids.c, { actor: RANK }))
    expect((await state()).targets).toEqual({ 'capped high': [55, null], 'capped low': [8, null], 'other kw': [45, null] })
    expect((await state()).groups.capped).toEqual({ bid: [40, null], own: null, floor: null })
  })
})

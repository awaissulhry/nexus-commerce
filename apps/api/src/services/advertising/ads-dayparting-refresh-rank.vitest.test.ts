/**
 * Group 2 (2d) — `refresh_dayparting` leaves rank (goal-mode) schedules alone (review 3.8).
 *
 * `refreshFamilySchedules` re-derives a product family's multiplier windows and wrote them over EVERY schedule on the
 * family's campaigns, goal-mode ones included: their window target keys were wiped, so the rank loop lost its windows
 * (and, with no target key left, the row turned into a classic schedule). Now a campaign held by a goal-mode schedule
 * is skipped — neither updated nor given a second, classic schedule — and the result counts it (`rankLeftAlone`).
 *
 * PGlite with the production schema; the real family resolution and order demand (no orders: one window, no multiplier).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})

const { refreshFamilySchedules } = await import('./ads-dayparting-refresh.service.js')
const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client as any

const RANK_WINDOWS = [{ days: [1, 2, 3, 4, 5], startHour: 18, endHour: 22, targetKey: 'own-top' }]
const CLASSIC_WINDOWS = [{ days: [0, 6], startHour: 9, endHour: 21, bidMultiplierPct: 25 }]

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await db().product.create({ data: { id: 'p-fam', sku: 'FAM-PARENT', name: 'Family jacket', basePrice: '99.00', totalStock: 5 } })
    await db().product.create({ data: { id: 'p-fam-m', sku: 'FAM-M', name: 'Family jacket M', basePrice: '99.00', totalStock: 5, parentId: 'p-fam', amazonAsin: 'B0FAMTEST1' } })
    for (const c of ['c-rank', 'c-classic', 'c-new']) {
      await db().campaign.create({
        data: { id: c, name: c, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${c}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z') },
      })
      await db().adGroup.create({ data: { id: `g-${c}`, campaignId: c, name: `g-${c}`, externalAdGroupId: `EXT-g-${c}` } })
      await db().adProductAd.create({ data: { adGroupId: `g-${c}`, productId: 'p-fam-m', asin: 'B0FAMTEST1', sku: 'FAM-M' } })
    }
    await db().adSchedule.create({ data: { id: 's-rank', campaignId: 'c-rank', name: 'rank', windows: RANK_WINDOWS, defaultTargetKey: 'rest-of-search', enabled: true } })
    await db().adSchedule.create({ data: { id: 's-classic', campaignId: 'c-classic', name: 'classic', windows: CLASSIC_WINDOWS, enabled: true } })
  })
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)

describe('refresh_dayparting leaves rank schedules alone', () => {
  it('a dry run counts the rank-held campaign it would leave alone and writes nothing', async () => {
    const r = await inside(() => refreshFamilySchedules({ parentProductId: 'p-fam', marketplace: 'IT', dryRun: true }))
    expect(r).toMatchObject({ campaigns: 3, updated: 0, created: 0, rankLeftAlone: 1, dryRun: true })
    expect(await inside(() => db().adSchedule.count())).toBe(2)
  })

  it('the classic schedule is refreshed, an uncovered campaign gets a switched-off one, the rank schedule is untouched', async () => {
    const r = await inside(() => refreshFamilySchedules({ parentProductId: 'p-fam', marketplace: 'IT' }))
    expect(r).toMatchObject({ campaigns: 3, updated: 1, created: 1, rankLeftAlone: 1 })
    const rows = await inside(() => db().adSchedule.findMany({ orderBy: { campaignId: 'asc' }, select: { id: true, campaignId: true, windows: true, defaultTargetKey: true, enabled: true } }))
    const of = (c: string) => rows.filter((s: { campaignId: string }) => s.campaignId === c)
    expect(of('c-rank')).toEqual([{ id: 's-rank', campaignId: 'c-rank', windows: RANK_WINDOWS, defaultTargetKey: 'rest-of-search', enabled: true }])
    expect(of('c-classic')).toHaveLength(1)
    expect(of('c-classic')[0].windows).not.toEqual(CLASSIC_WINDOWS)
    expect(of('c-new')).toMatchObject([{ enabled: false, defaultTargetKey: null }])
  })
})

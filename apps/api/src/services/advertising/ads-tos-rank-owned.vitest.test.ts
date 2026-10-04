/**
 * 4m (review 3.7) — Top of Search on a campaign Hourly Bids holds belongs to Hourly Bids.
 *
 * The rank engine sets the Top of Search placement (and the bids) of every campaign an enabled goal schedule or product
 * plan holds, every run. The Top-of-Search defense (cron, `defend_top_of_search`, autopilot) and the rule actions
 * `placement_apply` / `set_placement_multiplier` on the Top lane, and `raise_bids_for_rank_defense`, wrote the same
 * levers there, so two writers undid each other. They now leave such a campaign alone and say why; every other campaign
 * is written exactly as before.
 *
 * `rankOwnedCampaignIds` (rank-release.service.ts) is NOT mocked: it is the definition of "held" this relies on. Only
 * the database and the two write calls are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  campaignFindUnique: vi.fn(), campaignFindMany: vi.fn(), adTargetFindMany: vi.fn(), placementGroupBy: vi.fn(),
  schedules: vi.fn(), plans: vi.fn(), updatePlacementBidding: vi.fn(), bulkUpdateAdTargetBids: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    campaign: { findUnique: h.campaignFindUnique, findMany: h.campaignFindMany },
    adTarget: { findMany: h.adTargetFindMany },
    amazonAdsPlacementReport: { groupBy: h.placementGroupBy, aggregate: async () => ({ _sum: { costMicros: null } }) }, // 4d lane spend: none measured
    adSchedule: { findMany: h.schedules },
    productRankPlan: { findMany: h.plans },
    // 4e — contestedLanesByCampaign: no schedule events, no blend targets.
    rankScheduleEvent: { findMany: async () => [] },
    rankTarget: { findMany: async () => [] },
  },
}))
vi.mock('./ads-create.service.js', () => ({ updatePlacementBidding: h.updatePlacementBidding }))
vi.mock('./ads-mutation.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  bulkUpdateAdTargetBids: h.bulkUpdateAdTargetBids,
}))

import { ACTION_HANDLERS } from '../automation-rule.service.js'
import './automation-action-handlers.js'
import { defendTopOfSearch } from './ads-top-of-search.service.js'

const TOP = 'PLACEMENT_TOP'
const REST = 'PLACEMENT_REST_OF_SEARCH'
const PAGES = 'PLACEMENT_PRODUCT_PAGE'
// c-rank: an enabled goal schedule · c-plan: an enabled product plan's last run · c-free: an enabled schedule that
// names no target (classic dayparting, not Hourly Bids), so it is NOT held.
const RANK = 'c-rank', PLAN = 'c-plan', FREE = 'c-free'

type Res = { ok: boolean; error?: string; output?: Record<string, unknown> }
const run = (type: string, action: Record<string, unknown>, dryRun = false, operatorApproved = false) =>
  (ACTION_HANDLERS[type] as (a: unknown, c: unknown, m: unknown) => Promise<Res>)({ type, ...action }, {}, { dryRun, ruleId: 'rule-1', operatorApproved })

beforeEach(() => {
  vi.clearAllMocks()
  h.schedules.mockResolvedValue([
    { campaignId: RANK, windows: [], defaultTargetKey: 'own-top' },
    { campaignId: FREE, windows: [{ startHour: 8, endHour: 20 }], defaultTargetKey: null },
  ])
  h.plans.mockResolvedValue([{ lastSummary: { decisions: [{ campaignId: PLAN }] } }])
  h.campaignFindUnique.mockResolvedValue({ dynamicBidding: { placementBidding: [{ placement: TOP, percentage: 30 }] } })
  h.updatePlacementBidding.mockResolvedValue({ ok: true, mode: 'live' })
  h.adTargetFindMany.mockResolvedValue([{ id: 't1', bidCents: 50 }])
  h.bulkUpdateAdTargetBids.mockResolvedValue({ ok: true })
})

const expectHeld = (r: Res, campaignId: string, what: string) => {
  expect(r.ok).toBe(true)
  expect(r.output).toMatchObject({ skipped: 'rank-owned', campaignId })
  expect(r.output?.why).toBe(`Hourly Bids holds this campaign (an enabled schedule or product plan) and sets its ${what}, so this automation leaves it alone: two writers on the same ${what} would undo each other.`)
}

describe('placement_apply — the Top of Search lane of a held campaign is left alone', () => {
  it('🔴 skips a campaign an enabled goal schedule holds, and writes nothing', async () => {
    const r = await run('placement_apply', { campaignId: RANK, placement: TOP, op: 'set', value: 80 })
    expectHeld(r, RANK, 'Top of Search placement')
    expect(h.updatePlacementBidding).not.toHaveBeenCalled()
  })

  it('🔴 skips it in a dry run too, so a PROPOSE rule offers no suggestion (no wouldChange)', async () => {
    const r = await run('placement_apply', { campaignId: RANK, placement: TOP, op: 'set', value: 80 }, true)
    expectHeld(r, RANK, 'Top of Search placement')
    expect('wouldChange' in (r.output ?? {})).toBe(false)
  })

  it('skips a campaign an enabled product plan holds', async () => {
    const r = await run('placement_apply', { campaignId: PLAN, placement: TOP, op: 'set', value: 80 })
    expectHeld(r, PLAN, 'Top of Search placement')
    expect(h.updatePlacementBidding).not.toHaveBeenCalled()
  })

  it('still writes a campaign Hourly Bids does not hold (a schedule that names no target does not count)', async () => {
    // A person's approval: isolates 4m's rule from 4e's stricter one (4e treats any enabled schedule as contested
    // for an automated live run).
    const r = await run('placement_apply', { campaignId: FREE, placement: TOP, op: 'set', value: 80 }, false, true)
    expect(r).toMatchObject({ ok: true, output: { campaignId: FREE, placement: TOP, percentage: 80 } })
    expect(h.updatePlacementBidding).toHaveBeenCalledTimes(1)
  })

  it('still writes a lane the rank engine does not set — Product Pages without a blend', async () => {
    // Since 4e Rest of Search is contested too on a scheduled campaign (the engine zeros the other search lane).
    const r = await run('placement_apply', { campaignId: RANK, placement: PAGES, op: 'set', value: 40 })
    expect(r).toMatchObject({ ok: true, output: { placement: PAGES, percentage: 40 } })
    expect(h.updatePlacementBidding).toHaveBeenCalledTimes(1)
  })

  it('4e — Rest of Search on a scheduled campaign is left to the rank engine (automated live run)', async () => {
    const r = await run('placement_apply', { campaignId: RANK, placement: REST, op: 'set', value: 40 })
    expect(r).toMatchObject({ ok: true, output: { skipped: 'contested_by_rank_engine', placement: REST } })
    expect(h.updatePlacementBidding).not.toHaveBeenCalled()
  })
})

describe('set_placement_multiplier — the same rule', () => {
  it('skips the Top lane of a held campaign (Top is its default lane)', async () => {
    const r = await run('set_placement_multiplier', { campaignId: RANK, percentage: 50 })
    expectHeld(r, RANK, 'Top of Search placement')
    expect(h.updatePlacementBidding).not.toHaveBeenCalled()
  })

  it('writes a campaign that is not held', async () => {
    const r = await run('set_placement_multiplier', { campaignId: FREE, percentage: 50 })
    expect(r).toMatchObject({ ok: true, output: { campaignId: FREE, placement: TOP, percentage: 50 } })
    expect(h.updatePlacementBidding).toHaveBeenCalledTimes(1)
  })
})

describe('raise_bids_for_rank_defense — leaves a held campaign’s bids to Hourly Bids', () => {
  it('skips a held campaign before it reads a single target', async () => {
    const r = await run('raise_bids_for_rank_defense', { campaignId: RANK, percent: 20 })
    expectHeld(r, RANK, 'bids')
    expect(h.adTargetFindMany).not.toHaveBeenCalled()
    expect(h.bulkUpdateAdTargetBids).not.toHaveBeenCalled()
  })

  it('raises a campaign that is not held', async () => {
    const r = await run('raise_bids_for_rank_defense', { campaignId: FREE, percent: 20 })
    expect(r).toMatchObject({ ok: true, output: { raised: 1, pct: 20 } })
    expect(h.bulkUpdateAdTargetBids).toHaveBeenCalledTimes(1)
  })
})

describe('defendTopOfSearch — the cron, `defend_top_of_search` and autopilot', () => {
  beforeEach(() => {
    // Top-of-search ACoS 10 % on both, well under the 25 % target, so both would be raised.
    const row = (campaignId: string) => ({ campaignId, _sum: { impressions: 1000, clicks: 50, costMicros: 1_000_000n, sales7dCents: 1000, orders7d: 2 }, _avg: { topOfSearchIS: null } })
    h.placementGroupBy.mockResolvedValue([row('E-RANK'), row('E-FREE')])
    h.campaignFindMany.mockResolvedValue([
      { id: RANK, name: 'HELD', marketplace: 'IT', externalCampaignId: 'E-RANK', dynamicBidding: { placementBidding: [] }, status: 'ENABLED' },
      { id: FREE, name: 'FREE', marketplace: 'IT', externalCampaignId: 'E-FREE', dynamicBidding: { placementBidding: [] }, status: 'ENABLED' },
    ])
  })

  it('🔴 writes the free campaign only, and says in words why the held one was left alone', async () => {
    const r = await defendTopOfSearch({ dryRun: false })
    expect(h.updatePlacementBidding).toHaveBeenCalledTimes(1)
    expect((h.updatePlacementBidding.mock.calls[0][0] as { campaignId: string }).campaignId).toBe(FREE)
    expect(r).toMatchObject({ evaluated: 2, changed: 1, applied: 1, skippedRankOwned: 1 })
    expect(r.rankOwnedNote).toBe('Hourly Bids holds 1 campaign here (an enabled schedule or product plan) and sets its Top of Search placement, so this automation left it alone: two writers on the same Top of Search placement would undo each other.')
    expect(r.sample.map((s) => s.campaign)).toEqual(['FREE'])
  })

  it('a dry run counts the same — the held campaign is not offered', async () => {
    const r = await defendTopOfSearch({ dryRun: true })
    expect(r).toMatchObject({ changed: 1, applied: 0, skippedRankOwned: 1 })
    expect(r.sample.map((s) => s.campaign)).toEqual(['FREE'])
    expect(h.updatePlacementBidding).not.toHaveBeenCalled()
  })

  it('with nothing held, nothing is skipped and no note is written', async () => {
    h.schedules.mockResolvedValue([])
    h.plans.mockResolvedValue([])
    const r = await defendTopOfSearch({ dryRun: false })
    expect(r).toMatchObject({ changed: 2, applied: 2, skippedRankOwned: 0 })
    expect('rankOwnedNote' in r).toBe(false)
  })
})

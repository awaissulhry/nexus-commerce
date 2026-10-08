/**
 * ONE BRAIN AB-6 — the Top-of-Search defense (the cron, `defend_top_of_search`, the old autopilot) and the TOS optimizer
 * leave a campaign whose placements a product's brain owns, or the Owner holds at his own value — beside the bid brain's
 * own campaigns (BB-6), asked before the dry-run return so a preview never offers the move; counted in `brainSkips`.
 * Nothing enrolled (production today): exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  campaignFindUnique: vi.fn(), campaignFindMany: vi.fn(), placementGroupBy: vi.fn(), updatePlacementBidding: vi.fn(),
  campaignLeverOwners: vi.fn(), anyBrainEnrolled: vi.fn(),
}))
vi.mock('../../db.js', () => ({
  default: {
    campaign: { findUnique: h.campaignFindUnique, findMany: h.campaignFindMany },
    amazonAdsPlacementReport: { groupBy: h.placementGroupBy, aggregate: async () => ({ _sum: { costMicros: null } }) },
    adSchedule: { findMany: async () => [] },
    productRankPlan: { findMany: async () => [] },
    rankScheduleEvent: { findMany: async () => [] },
    rankTarget: { findMany: async () => [] },
    bidBrainEnrollment: { findMany: async () => [] }, // no bid brain campaign
  },
}))
vi.mock('./ads-create.service.js', () => ({ updatePlacementBidding: h.updatePlacementBidding }))
vi.mock('./brain/lever-owners.js', () => ({
  campaignLeverOwners: (...a: unknown[]) => h.campaignLeverOwners(...a),
  anyBrainEnrolled: (...a: unknown[]) => h.anyBrainEnrolled(...a),
}))

const { defendTopOfSearch, applyTopOfSearchRecommendations } = await import('./ads-top-of-search.service.js')

const LOCKED = { kind: 'locked', productId: 'gale', market: 'IT', why: 'locked by the Owner\'s campaign override' }
const row = (campaignId: string) => ({ campaignId, _sum: { impressions: 1000, clicks: 50, costMicros: 1_000_000n, sales7dCents: 1000, orders7d: 2 }, _avg: { topOfSearchIS: null } })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  h.anyBrainEnrolled.mockResolvedValue(true)
  h.campaignLeverOwners.mockResolvedValue(new Map())
  h.campaignFindUnique.mockResolvedValue({ dynamicBidding: { placementBidding: [] } })
  h.updatePlacementBidding.mockResolvedValue({ ok: true, mode: 'live' })
  // Top-of-search ACoS 10 % on both, well under the 25 % target: both would be raised.
  h.placementGroupBy.mockResolvedValue([row('E-GALE'), row('E-MISANO')])
  h.campaignFindMany.mockResolvedValue([
    { id: 'c-gale', name: 'GALE', marketplace: 'IT', externalCampaignId: 'E-GALE', dynamicBidding: { placementBidding: [] }, status: 'ENABLED' },
    { id: 'c-misano', name: 'MISANO', marketplace: 'IT', externalCampaignId: 'E-MISANO', dynamicBidding: { placementBidding: [] }, status: 'ENABLED' },
  ])
})
afterEach(() => vi.unstubAllEnvs())

const holdGale = () => h.campaignLeverOwners.mockImplementation(async (ids: string[]) =>
  new Map(ids.filter((id) => id === 'c-gale').map((id) => [id, { campaignId: id, name: 'GALE', market: 'IT', levers: { placements: LOCKED } }])))

describe('defendTopOfSearch', () => {
  it('a campaign whose placements are held is left; the other written; counted with why', async () => {
    holdGale()
    const r = await defendTopOfSearch({ dryRun: false })
    expect(h.updatePlacementBidding).toHaveBeenCalledTimes(1)
    expect((h.updatePlacementBidding.mock.calls[0][0] as { campaignId: string }).campaignId).toBe('c-misano')
    expect(r).toMatchObject({ changed: 1, applied: 1, brainSkips: { counts: { ownerLock: { placements: 1 } }, sample: [{ lever: 'placements', holder: 'ownerLock', campaignId: 'c-gale' }] } })
  })

  it('a dry run never offers it either', async () => {
    holdGale()
    const r = await defendTopOfSearch({ dryRun: true })
    expect(r.sample.map((s) => s.campaign)).toEqual(['MISANO'])
    expect(r.brainSkips).toMatchObject({ counts: { ownerLock: { placements: 1 } } })
  })

  it('nothing enrolled: both, as before, no brainSkips', async () => {
    h.anyBrainEnrolled.mockResolvedValue(false)
    const r = await defendTopOfSearch({ dryRun: false })
    expect(r).toMatchObject({ changed: 2, applied: 2 })
    expect(r).not.toHaveProperty('brainSkips')
  })
})

describe('applyTopOfSearchRecommendations (the TOS optimizer)', () => {
  it('leaves a held campaign, writes the other', async () => {
    holdGale()
    const r = await applyTopOfSearchRecommendations({})
    expect(r.applied).toBe(1)
    expect((h.updatePlacementBidding.mock.calls[0][0] as { campaignId: string }).campaignId).toBe('c-misano')
  })
  it('nothing enrolled: both', async () => {
    h.anyBrainEnrolled.mockResolvedValue(false)
    expect((await applyTopOfSearchRecommendations({})).applied).toBe(2)
  })
})

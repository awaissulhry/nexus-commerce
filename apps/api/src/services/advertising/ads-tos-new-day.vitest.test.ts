/**
 * A1 (2026-10-10) — the Top-of-Search defense steps a campaign once per new settled day, not on every 30-minute run.
 *
 * The cron used to step ±15 points on every run from the same once-a-day reading (up to 48 steps a day on one number).
 * Now a writer reads its own last placement write (AdvertisingActionLog, its actor, not refused) and steps only when a
 * settled day newer than the one that write rested on (`evidence.dataDay`) exists. The database and the write are
 * stand-ins; the write is recorded as the audit row the real one leaves, so the second run reads it back.
 * Made-up numbers only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  placementGroupBy: vi.fn(), placementFindMany: vi.fn(), campaignFindMany: vi.fn(), updatePlacementBidding: vi.fn(),
  log: [] as Array<{ entityId: string; createdAt: Date; dataDay: string | null; actor: string }>,
}))
vi.mock('../../db.js', () => ({
  default: {
    campaign: { findUnique: async () => ({ dynamicBidding: { placementBidding: [] } }), findMany: h.campaignFindMany },
    amazonAdsPlacementReport: { groupBy: h.placementGroupBy, findMany: h.placementFindMany },
    adSchedule: { findMany: async () => [] },
    productRankPlan: { findMany: async () => [] },
    rankScheduleEvent: { findMany: async () => [] },
    rankTarget: { findMany: async () => [] },
    bidBrainEnrollment: { findMany: async () => [] },
    // The newest write per campaign of the actor the query names (DISTINCT ON … ORDER BY createdAt DESC).
    $queryRaw: async (_sql: TemplateStringsArray, _ids: string[], actor: string) => {
      const newest = new Map<string, (typeof h.log)[number]>()
      for (const r of h.log) if (r.actor === actor && (!newest.has(r.entityId) || newest.get(r.entityId)!.createdAt < r.createdAt)) newest.set(r.entityId, r)
      return [...newest.values()].map(({ entityId, createdAt, dataDay }) => ({ entityId, createdAt, dataDay }))
    },
  },
}))
vi.mock('./ads-create.service.js', () => ({ updatePlacementBidding: h.updatePlacementBidding }))
vi.mock('./brain/lever-owners.js', () => ({ campaignLeverOwners: async () => new Map(), anyBrainEnrolled: async () => false }))

const { defendTopOfSearch, applyTopOfSearchRecommendations } = await import('./ads-top-of-search.service.js')

const DAY = 86_400_000
const dayAgo = (n: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - n * DAY)
let newestAgo = 10
// Top-of-search ACoS 10 % (€10 spend, €100 sales), well under the 25 % default target: it wants Top 0 → 15 %.
const perf = () => [{ campaignId: 'E-A', _sum: { impressions: 1000, clicks: 50, costMicros: 10_000_000n, sales7dCents: 10_000, orders7d: 2 }, _max: { date: dayAgo(newestAgo) } }]

beforeEach(() => {
  vi.clearAllMocks()
  h.log = []
  newestAgo = 10
  h.placementGroupBy.mockImplementation(async () => perf())
  h.placementFindMany.mockResolvedValue([])
  h.campaignFindMany.mockResolvedValue([{ id: 'c-a', name: 'A', marketplace: 'IT', externalCampaignId: 'E-A', dynamicBidding: { placementBidding: [] }, status: 'ENABLED' }])
  h.updatePlacementBidding.mockImplementation(async (input: { campaignId: string; actor: string; evidence?: { dataDay?: string } }) => {
    h.log.push({ entityId: input.campaignId, createdAt: new Date(), dataDay: input.evidence?.dataDay ?? null, actor: input.actor })
    return { ok: true, mode: 'live' }
  })
})

describe('defendTopOfSearch — one step per new settled day', () => {
  it('🔴 steps once, then holds on every later run of the same settled day, saying why; a newer day steps again', async () => {
    const first = await defendTopOfSearch({ dryRun: false })
    expect(first).toMatchObject({ changed: 1, applied: 1 })
    const write = h.updatePlacementBidding.mock.calls[0][0] as { actor: string; reason: string; evidence: Record<string, unknown> }
    expect(write.actor).toBe('automation:tos-optimizer')
    expect(write.evidence).toMatchObject({ dataDay: dayAgo(10).toISOString().slice(0, 10), windowDays: 30 })
    expect(write.reason).toMatch(/^ACoS only: no target IS set — top-of-search ACoS 10% well under the target 25% over the 30 settled days \d{4}-\d{2}-\d{2}…\d{4}-\d{2}-\d{2} \(newest data \d{4}-\d{2}-\d{2}\) — capture more top slots$/)

    const again = await defendTopOfSearch({ dryRun: false })
    expect(again).toMatchObject({ changed: 0, applied: 0, heldNoNewDay: 1 })
    expect(again.heldSample?.[0].reason).toMatch(/^held: its last step \(\d{4}-\d{2}-\d{2}\) already rested on settled data through \d{4}-\d{2}-\d{2}; the next step waits for a newer settled day/)
    expect(h.updatePlacementBidding).toHaveBeenCalledTimes(1)
    // a dry run (the preview) offers nothing either
    expect(await defendTopOfSearch({ dryRun: true })).toMatchObject({ changed: 0, heldNoNewDay: 1, sample: [] })

    newestAgo = 9 // the next settled day arrived
    expect(await defendTopOfSearch({ dryRun: false })).toMatchObject({ applied: 1 })
    expect(h.updatePlacementBidding).toHaveBeenCalledTimes(2)
  })

  it('each writer reads its own last step: a rule (automation:<ruleId>) is not held by the cron\'s', async () => {
    await defendTopOfSearch({ dryRun: false })
    expect(await defendTopOfSearch({ dryRun: false, actor: 'automation:rule-1' })).toMatchObject({ applied: 1 })
  })

  it('the TOS optimizer holds the same way and lists what it held', async () => {
    expect(await applyTopOfSearchRecommendations({})).toMatchObject({ applied: 1, held: [] })
    const r = await applyTopOfSearchRecommendations({})
    expect(r.applied).toBe(0)
    expect(r.held).toEqual([{ campaignId: 'c-a', reason: expect.stringMatching(/^held: its last step/) }])
  })
})

describe('defendTopOfSearch — a target IS needs Amazon\'s IS', () => {
  it('🔴 target set, no IS reported → holds (no ACoS-only fall-back), counted and said', async () => {
    const r = await defendTopOfSearch({ dryRun: false, targetIS: 0.5 })
    expect(r).toMatchObject({ changed: 0, applied: 0, heldNoUsableIS: 1 })
    expect(r.heldSample?.[0].reason).toMatch(/^held: target top-of-search IS 50% is set, but Amazon reported no top-of-search IS for this campaign in the 30 settled days/)
    expect(h.updatePlacementBidding).not.toHaveBeenCalled()
  })

  it('impression-weighted over the days with a reading: 6 days, the busy days at 20 %, the quiet ones at 80 % → 30 %, below a 50 % target → raise', async () => {
    const days = [10, 11, 12, 13, 14, 15]
    h.placementFindMany.mockResolvedValue(days.map((n, i) => ({ campaignId: 'E-A', date: dayAgo(n), impressions: i < 4 ? 900 : 300, topOfSearchIS: i < 4 ? 0.2 : 0.8 })))
    // (4 × 900 × 0.2 + 2 × 300 × 0.8) ÷ (4 × 900 + 2 × 300) = (720 + 480) ÷ 4200 ≈ 0.286; a plain mean would say 0.4.
    const r = await defendTopOfSearch({ dryRun: false, targetIS: 0.5 })
    expect(r).toMatchObject({ applied: 1 })
    const write = h.updatePlacementBidding.mock.calls[0][0] as { reason: string; evidence: Record<string, unknown> }
    expect(write.reason).toContain("the campaign's top-of-search IS (Amazon's, per day) 29%, weighted by impressions over 6 of the 30 settled days")
    expect(write.evidence).toMatchObject({ dataDay: dayAgo(10).toISOString().slice(0, 10), sampleSize: 6, sampleUnit: 'days' })
  })
})

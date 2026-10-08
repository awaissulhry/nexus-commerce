/**
 * ONE BRAIN AB-6 — classic dayparting leaves a campaign whose ad-group default bids a product's brain owns (or the Owner
 * holds): its floor and its give-back move the ad groups' default bids with the keywords', so the campaign is left whole,
 * as a bid brain campaign is (BB-6). The line counts the skip; nothing enrolled: exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ schedules: vi.fn(), suppress: vi.fn(), campaignLeverOwners: vi.fn(), anyBrainEnrolled: vi.fn() }))
vi.mock('../db.js', () => ({
  default: {
    productRankPlan: { findMany: async () => [] },
    adSchedule: { findMany: h.schedules, update: async () => ({}) },
    campaign: { findUnique: async () => ({ status: 'ENABLED', bidsSuppressedAt: null, bidsSuppressedBy: null, marketplace: 'IT' }) },
    adTarget: { findMany: async () => [] },
    bidBrainEnrollment: { findMany: async () => [] },
    $queryRaw: async () => [{ now: new Date() }],
  },
}))
vi.mock('../services/advertising/ads-engine-guard.js', () => ({
  openEngineGuard: async () => ({ permit: () => ({ forward: true }), settle: () => {}, report: () => undefined }),
  allowChange: () => true, nothingHeld: () => ({}), engineGuardNote: () => '', readEnginePosture: async () => 'auto',
}))
vi.mock('../services/advertising/ads-bid-suppression.service.js', () => ({ suppressCampaignBids: h.suppress, restoreCampaignBids: vi.fn(async () => 0) }))
vi.mock('../services/advertising/brain/lever-owners.js', () => ({
  campaignLeverOwners: (...a: unknown[]) => h.campaignLeverOwners(...a),
  anyBrainEnrolled: (...a: unknown[]) => h.anyBrainEnrolled(...a),
}))

const { runDaypartingOnce, daypartingSummaryLine } = await import('./ad-dayparting.job.js')

// A window on no day: closed now, so each schedule floors its campaign's bids (no pause).
const schedule = (id: string, campaignId: string) => ({ id, campaignId, enabled: true, timezone: 'UTC', windows: [{ days: [], startHour: 0, endHour: 24 }], defaultTargetKey: null, originalBids: null })
const LOCKED = { kind: 'locked', productId: 'gale', market: 'IT', why: 'locked by the Owner\'s campaign override' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  h.schedules.mockImplementation(async (args: { where: { enabled: boolean } }) => (args.where.enabled ? [schedule('s1', 'c-gale'), schedule('s2', 'c-misano')] : []))
  h.suppress.mockResolvedValue(3)
  h.anyBrainEnrolled.mockResolvedValue(true)
  h.campaignLeverOwners.mockResolvedValue(new Map())
})
afterEach(() => vi.unstubAllEnvs())

describe('AB-6 — classic dayparting', () => {
  it('a campaign whose ad-group default bids are held is left whole; the other floored; counted in the line', async () => {
    h.campaignLeverOwners.mockResolvedValue(new Map([['c-gale', { campaignId: 'c-gale', name: 'GALE', market: 'IT', levers: { adGroupBids: LOCKED } }]]))
    const r = await runDaypartingOnce()
    expect(h.suppress).toHaveBeenCalledTimes(1)
    expect(h.suppress.mock.calls[0][0]).toBe('c-misano')
    expect(r).toMatchObject({ evaluated: 1, leverHeld: { ownerLock: { adGroupBids: 1 } } })
    expect(daypartingSummaryLine(r)).toBe('evaluated=1 changed=1 brain-levers=the Owner\'s lock: adGroupBids 1 (one owner per lever)')
  })

  it('nothing enrolled (production today): both floored, the line unchanged', async () => {
    h.anyBrainEnrolled.mockResolvedValue(false)
    const r = await runDaypartingOnce()
    expect(h.suppress).toHaveBeenCalledTimes(2)
    expect(daypartingSummaryLine(r)).toBe('evaluated=2 changed=2')
  })
})

/**
 * 6b — the write gate holds every live write to Amazon's own limits in its market (review G.5; Owner decision S10).
 *
 * Every amount behind the gate is in euro cents, so a market with no checked row (a sandbox UK/SE/PL connection, NL, …)
 * is refused outright — even with a production connection that has writes on — and a bid or budget outside Amazon's
 * range in a euro market is refused before Amazon answers with an error. Values inside the range pass exactly as before;
 * the live campaigns' budgets (€1–€80) and bids (up to 190¢) and the 2¢ suppression bid are all inside it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const campaignFindUnique = vi.fn()
const connFindFirst = vi.fn()
let mode: 'live' | 'sandbox' = 'live'

vi.mock('../../db.js', () => ({
  default: {
    campaign: { get findUnique() { return campaignFindUnique }, findMany: vi.fn(async () => []) },
    amazonAdsConnection: { get findFirst() { return connFindFirst } },
    adKeywordProtection: { findMany: vi.fn(async () => []) },
    adSpendCeiling: { findMany: vi.fn(async () => []) },
    adBidPolicy: { findMany: vi.fn(async () => []) },
    advertisingActionLog: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    adProductAd: { findMany: vi.fn(async () => []) },
    adWriteRefusal: { create: vi.fn(async () => ({})) },
    // W1-5 — no ads strategy row sets a bid field: the gate's strategy band adds nothing.
    adsStrategy: { findFirst: vi.fn(async () => null) },
  },
}))
vi.mock('./ads-api-client.js', () => ({ adsMode: () => mode }))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
const automationState = vi.fn(async () => ({ autonomy: 'AUTO', halted: false, haltReason: null as string | null, effectivelyStopped: false, degraded: false }))
vi.mock('./ads-automation-state.service.js', () => ({ get getAutomationState() { return automationState } }))

const { checkAdsWriteGate } = await import('./ads-write-gate.js')

const LIVE_CONN = { profileId: 'p1', mode: 'production', writesEnabledAt: new Date() }
const ROW = {
  liveBidWritesEnabled: true, dynamicBidding: null, liveBidWritesToday: 0, liveBidWritesDay: null,
  minBidCents: null, maxBidCents: null, pinPlacement: false, pinBids: false, pinBudget: false, pinNote: null,
  dailyBudget: 5, portfolioId: null, marketplace: 'IT', minBudgetCents: null, maxBudgetCents: null,
  adProduct: 'SPONSORED_PRODUCTS', type: 'SP', name: 'Italy exact',
}

beforeEach(() => {
  mode = 'live'
  campaignFindUnique.mockReset()
  campaignFindUnique.mockResolvedValue(ROW)
  connFindFirst.mockReset()
  connFindFirst.mockResolvedValue(LIVE_CONN)
  automationState.mockResolvedValue({ autonomy: 'AUTO', halted: false, haltReason: null, effectivelyStopped: false, degraded: false })
})

describe('a market with no checked Amazon limits row', () => {
  it('🔴 is refused although its connection is production with writes on', async () => {
    for (const marketplace of ['SE', 'UK', 'PL', 'NL']) {
      const r = await checkAdsWriteGate({ marketplace, payloadValueCents: 50, campaignId: 'c1', field: 'bid', intendedValueCents: 50 })
      expect(r).toEqual({
        allowed: false, deniedAt: 'market_limits',
        reason: `Nexus does not change ads in ${marketplace}: Amazon's bid and budget limits for this market are not known yet, so nothing was sent to Amazon. They are known for IT, DE, FR and ES only.`,
      })
    }
  })

  it('is refused for a creation flow (no campaign) and for a suppression', async () => {
    expect(await checkAdsWriteGate({ marketplace: 'SE', payloadValueCents: 500 })).toMatchObject({ allowed: false, deniedAt: 'market_limits' })
    expect(await checkAdsWriteGate({ marketplace: 'SE', payloadValueCents: 2, campaignId: 'c1', field: 'bid', intendedValueCents: 2, isSuppression: true }))
      .toMatchObject({ allowed: false, deniedAt: 'market_limits' })
  })

  it('names the market before the allowlist would', async () => {
    campaignFindUnique.mockResolvedValue({ ...ROW, liveBidWritesEnabled: false })
    expect(await checkAdsWriteGate({ marketplace: 'SE', payloadValueCents: 50, campaignId: 'c1' })).toMatchObject({ deniedAt: 'market_limits' })
  })

  it('is not asked in sandbox, where nothing reaches Amazon', async () => {
    mode = 'sandbox'
    expect(await checkAdsWriteGate({ marketplace: 'SE', payloadValueCents: 50, campaignId: 'c1', field: 'bid', intendedValueCents: 1 })).toEqual({ allowed: true, mode: 'sandbox' })
  })
})

describe('a euro market', () => {
  it('passes the live range: €1 and €80 budgets, 80¢ and 190¢ bids, the 2¢ suppression bid', async () => {
    for (const [field, v] of [['dailyBudget', 100], ['dailyBudget', 8_000], ['bid', 80], ['defaultBid', 190], ['bid', 2]] as const) {
      // The budget already stands at the value, so the day-move bound has nothing to say.
      if (field === 'dailyBudget') campaignFindUnique.mockResolvedValue({ ...ROW, dailyBudget: v / 100 })
      const r = await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: v, campaignId: 'c1', field, intendedValueCents: v })
      expect(r).toEqual({ allowed: true, mode: 'live', profileId: 'p1' })
    }
  })

  it('reads a market stored as an Amazon marketplace id (HB.8)', async () => {
    const r = await checkAdsWriteGate({ marketplace: 'A1PA6795UKMFR9', payloadValueCents: 50, campaignId: 'c1', field: 'bid', intendedValueCents: 50 })
    expect(r).toEqual({ allowed: true, mode: 'live', profileId: 'p1' })
  })

  it('🔴 refuses a bid under Amazon’s minimum, a suppression included', async () => {
    const r = await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 1, campaignId: 'c1', field: 'bid', intendedValueCents: 1, isSuppression: true })
    expect(r).toEqual({
      allowed: false, deniedAt: 'market_limits',
      reason: "A bid of €0.01 is below Amazon's minimum of €0.02 in IT, so nothing was sent to Amazon.",
    })
  })

  it('🔴 refuses a daily budget under €1 and a bid over €1,000', async () => {
    expect(await checkAdsWriteGate({ marketplace: 'DE', payloadValueCents: 50, campaignId: 'c1', field: 'dailyBudget', intendedValueCents: 50 }))
      .toEqual({ allowed: false, deniedAt: 'market_limits', reason: "A daily budget of €0.50 is below Amazon's minimum of €1.00 in DE, so nothing was sent to Amazon." })
    expect(await checkAdsWriteGate({ marketplace: 'FR', payloadValueCents: 0, campaignId: 'c1', field: 'defaultBid', intendedValueCents: 100_001 }))
      .toMatchObject({ allowed: false, deniedAt: 'market_limits' })
  })

  it('leaves a field with no amount to the other checks', async () => {
    const r = await checkAdsWriteGate({ marketplace: 'ES', payloadValueCents: 0, campaignId: 'c1', field: 'state', intendedValueCents: null })
    expect(r).toEqual({ allowed: true, mode: 'live', profileId: 'p1' })
  })
})

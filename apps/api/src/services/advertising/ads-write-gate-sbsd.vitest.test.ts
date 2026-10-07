/**
 * W4-11 — the write gate per ad product. A Sponsored Brands or Display write passes the 6a door only when the caller
 * says what it is (`write`) and it is one Nexus sends to their own endpoints (adWriteRefusal); then it is judged on that
 * ad product's Amazon limits in the market (@nexus/shared/ads-market-limits, SB/SD rows) — an SB/SD bid on the range of
 * how its campaign pays (`costType`). A write that does not say what it is keeps today's refusal, the sentence unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AdWrite } from '@nexus/shared/ads-ad-product'

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
    adsStrategy: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
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
  dailyBudget: 5, portfolioId: null, marketplace: 'IT', minBudgetCents: null, maxBudgetCents: null, budgetJson: null,
}
const SB = { ...ROW, adProduct: 'SPONSORED_BRANDS', type: 'SB', name: 'Test brands', costType: 'CPC' }
const SD = { ...ROW, adProduct: 'SPONSORED_DISPLAY', type: 'SD', name: 'Test display', costType: 'cpc' }

const BID = (kind = 'KEYWORD'): AdWrite => ({ entity: 'AD_TARGET', fields: ['bid'], kind, isNegative: false })
const BUDGET: AdWrite = { entity: 'CAMPAIGN', fields: ['dailyBudget'] }
const bid = (row: object, cents: number, write: AdWrite | null = BID()) => {
  campaignFindUnique.mockResolvedValue(row)
  return checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: cents, campaignId: 'c-x', field: 'bid', fields: ['bid'], intendedValueCents: cents, ...(write ? { write } : {}) })
}

beforeEach(() => {
  mode = 'live'
  campaignFindUnique.mockReset()
  connFindFirst.mockReset()
  connFindFirst.mockResolvedValue(LIVE_CONN)
})

describe('the 6a door, per ad product', () => {
  it('an SB keyword bid and an SD target bid the write describes pass to Amazon', async () => {
    expect(await bid(SB, 50)).toEqual({ allowed: true, mode: 'live', profileId: 'p1' })
    expect(await bid(SD, 50, BID('PRODUCT'))).toEqual({ allowed: true, mode: 'live', profileId: 'p1' })
  })

  it('a write that does not say what it is keeps the Sponsored-Products-only refusal, word for word', async () => {
    const r = await bid(SB, 50, null)
    expect(r).toEqual({ allowed: false, deniedAt: 'ad_product_unsupported', reason: expect.stringMatching(/^Test brands is not a Sponsored Products campaign \(it is Sponsored Brands\)\. Nexus makes this change for Sponsored Products campaigns only/) })
  })

  it('a write Nexus does not send for SB/SD is refused, naming what it can change', async () => {
    campaignFindUnique.mockResolvedValue(SB)
    const r = await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 0, campaignId: 'c-x', fields: ['biddingStrategy'], write: { entity: 'CAMPAIGN', fields: ['biddingStrategy'] } })
    expect(r).toMatchObject({ allowed: false, deniedAt: 'ad_product_unsupported', reason: expect.stringMatching(/^Test brands is a Sponsored Brands campaign\. Nexus changes its daily budget and on\/off state.* — not the campaign's biddingStrategy —/) })
    expect(await bid(SD, 50, BID('KEYWORD'))).toMatchObject({ allowed: false, deniedAt: 'ad_product_unsupported', reason: expect.stringContaining('not that kind of target') })
  })

  it('before the sandbox return too: an SB negative product target is refused, an SB negative keyword passes', async () => {
    mode = 'sandbox'
    const neg = (kind: string) => checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 0, isNegation: true, keywordText: 'x', adProduct: 'SPONSORED_BRANDS', write: { entity: 'NEGATIVE_CREATE', kind, negativeLevel: 'AD_GROUP' } })
    expect(await neg('KEYWORD')).toEqual({ allowed: true, mode: 'sandbox' })
    expect(await neg('PRODUCT')).toMatchObject({ allowed: false, deniedAt: 'ad_product_unsupported' })
  })

  it('reads the campaign once, with its cost type and budget object', async () => {
    await bid(SB, 50)
    expect(campaignFindUnique).toHaveBeenCalledTimes(1)
    expect(campaignFindUnique.mock.calls[0][0].select).toMatchObject({ adProduct: true, type: true, costType: true, budgetJson: true })
  })
})

describe("Amazon's limits per ad product (market_limits)", () => {
  it('an SB CPC bid: 0.15–39 in IT (the range image and video both accept)', async () => {
    expect(await bid(SB, 15)).toMatchObject({ allowed: true })
    expect(await bid(SB, 10)).toEqual({ allowed: false, deniedAt: 'market_limits', reason: "A bid of €0.10 is below Amazon's minimum of €0.15 in IT, so nothing was sent to Amazon." })
    expect(await bid(SB, 3_901)).toMatchObject({ allowed: false, deniedAt: 'market_limits', reason: expect.stringContaining("above Amazon's maximum of €39.00") })
  })

  it('fails closed: an SB/SD bid whose cost type Nexus has not read is refused at the 6a door, in sandbox too', async () => {
    expect(await bid({ ...SB, costType: null }, 50)).toMatchObject({ allowed: false, deniedAt: 'ad_product_unsupported', reason: expect.stringMatching(/has not read from Amazon whether it pays per click \(CPC\) or per thousand viewable impressions/) })
  })

  it('a vCPM bid (SB or SD) is refused: the strategy\'s bid limits and the floors are per click; a CPC SD bid is judged on 0.02–1000', async () => {
    expect(await bid({ ...SB, costType: 'VCPM' }, 500)).toMatchObject({ allowed: false, deniedAt: 'ad_product_unsupported', reason: expect.stringContaining('pays per thousand viewable impressions (vCPM)') })
    expect(await bid({ ...SD, costType: 'vcpm' }, 150, BID('AUDIENCE'))).toMatchObject({ allowed: false, deniedAt: 'ad_product_unsupported', reason: expect.stringContaining("bid limits and Nexus's bid floors are per click") })
    expect(await bid(SD, 2, BID('PRODUCT'))).toMatchObject({ allowed: true })
    expect(await bid(SD, 1, BID('PRODUCT'))).toMatchObject({ allowed: false, deniedAt: 'market_limits' })
  })

  it('a daily budget on its ad product\'s range: SD up to €50,000 (seller and vendor)', async () => {
    campaignFindUnique.mockResolvedValue(SD)
    // A person's approved write (manual, confirmed past his own limits): the day-move bound, his own, does not hide Amazon's.
    const budget = (cents: number) => checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 0, campaignId: 'c-x', field: 'dailyBudget', fields: ['dailyBudget'], intendedValueCents: cents, write: BUDGET, manual: true, confirmOwnLimits: true })
    expect(await budget(5_000_000)).toMatchObject({ allowed: true })
    expect(await budget(5_000_001)).toMatchObject({ allowed: false, deniedAt: 'market_limits', reason: expect.stringContaining('€50,000.00') })
  })

  it('a market with no row is still refused for SB/SD, before anything else of the campaign', async () => {
    campaignFindUnique.mockResolvedValue({ ...SB, marketplace: 'SE' })
    const r = await checkAdsWriteGate({ marketplace: 'SE', payloadValueCents: 50, campaignId: 'c-x', field: 'bid', intendedValueCents: 50, write: BID() })
    expect(r).toMatchObject({ allowed: false, deniedAt: 'market_limits', reason: expect.stringMatching(/^Nexus does not change ads in SE/) })
  })

  it('an SB lifetime budget, or one whose period Nexus has not read: its budget is refused at the door, its on/off is not', async () => {
    const budget = () => checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 0, campaignId: 'c-x', field: 'dailyBudget', fields: ['dailyBudget'], intendedValueCents: 2000, write: BUDGET, manual: true, confirmOwnLimits: true })
    campaignFindUnique.mockResolvedValue({ ...SB, budgetJson: null })
    expect(await budget()).toMatchObject({ allowed: false, deniedAt: 'ad_product_unsupported', reason: expect.stringContaining('has not read from Amazon whether its budget is daily') })
    campaignFindUnique.mockResolvedValue({ ...SB, budgetJson: { budgetType: 'DAILY' } })
    expect(await budget()).toMatchObject({ allowed: true })
    campaignFindUnique.mockResolvedValue({ ...SB, budgetJson: { budgetType: 'LIFETIME' } })
    const r = await budget()
    expect(r).toMatchObject({ allowed: false, deniedAt: 'ad_product_unsupported', reason: expect.stringContaining('lifetime budget') })
    expect(await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 0, campaignId: 'c-x', fields: ['status'], write: { entity: 'CAMPAIGN', fields: ['status'], toStatus: 'PAUSED' } })).toMatchObject({ allowed: true })
  })
})

describe('everything else binds an SB/SD write as it binds an SP one', () => {
  it('the live-write allowlist refuses an engine (not a person) — the ad product is not an exemption', async () => {
    const off = { ...SB, liveBidWritesEnabled: false }
    expect(await bid(off, 50)).toMatchObject({ allowed: false, deniedAt: 'campaign_allowlist' })
    campaignFindUnique.mockResolvedValue(off)
    expect(await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 50, campaignId: 'c-x', field: 'bid', intendedValueCents: 50, write: BID(), manual: true })).toMatchObject({ allowed: true })
  })

  it("the campaign's own bid bounds", async () => {
    expect(await bid({ ...SB, maxBidCents: 40 }, 50)).toMatchObject({ allowed: false, deniedAt: 'entity_bounds' })
  })
})

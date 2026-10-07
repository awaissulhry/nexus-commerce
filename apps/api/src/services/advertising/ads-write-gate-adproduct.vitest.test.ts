/**
 * 6a — the write gate refuses Sponsored Brands and Display (Owner decision S8; review G.1).
 *
 * Every write behind this gate goes to a Sponsored Products endpoint, where an SB/SD id is unknown. Two doors:
 *   · `ctx.adProduct`, from a caller that passes no campaignId (the negative paths) — refused BEFORE the sandbox
 *     return, so a sandbox run refuses it too;
 *   · `ctx.campaignId` on the live path — the campaign's own row, refused before the allowlist.
 * Sponsored Products, and a row whose ad product is not stated, pass exactly as before.
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
}
const SP_ROW = { ...ROW, adProduct: 'SPONSORED_PRODUCTS', type: 'SP', name: 'Italy exact' }
const SB_ROW = { ...ROW, adProduct: 'SPONSORED_BRANDS', type: 'SB', name: 'Italy brands' }

beforeEach(() => {
  mode = 'live'
  campaignFindUnique.mockReset()
  connFindFirst.mockReset()
  connFindFirst.mockResolvedValue(LIVE_CONN)
  automationState.mockResolvedValue({ autonomy: 'AUTO', halted: false, haltReason: null, effectivelyStopped: false, degraded: false })
})

describe('ctx.adProduct — the negative paths, before the sandbox return', () => {
  it('refuses Sponsored Brands in SANDBOX, with the shared sentence', async () => {
    mode = 'sandbox'
    const r = await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 0, isNegation: true, keywordText: 'x', adProduct: 'SPONSORED_BRANDS' })
    expect(r).toEqual({
      allowed: false, deniedAt: 'ad_product_unsupported',
      reason: expect.stringMatching(/^This campaign is not a Sponsored Products campaign \(it is Sponsored Brands\)\. Nexus makes this change for Sponsored Products campaigns only/),
    })
  })

  it('refuses Sponsored Display live, before the connection is even read', async () => {
    const r = await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 0, adProduct: 'SPONSORED_DISPLAY' })
    expect(r).toMatchObject({ allowed: false, deniedAt: 'ad_product_unsupported' })
    expect(connFindFirst).not.toHaveBeenCalled()
  })

  it('is not exempted by a suppression — the bid would still land on an SP endpoint', async () => {
    const r = await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 0, adProduct: 'SPONSORED_BRANDS', isSuppression: true })
    expect(r).toMatchObject({ allowed: false, deniedAt: 'ad_product_unsupported' })
  })

  it('Sponsored Products, null and omitted pass exactly as before', async () => {
    mode = 'sandbox'
    for (const adProduct of ['SPONSORED_PRODUCTS', null, undefined]) {
      expect(await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 0, adProduct })).toEqual({ allowed: true, mode: 'sandbox' })
    }
    mode = 'live'
    expect(await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 0, adProduct: 'SPONSORED_PRODUCTS' })).toEqual({ allowed: true, mode: 'live', profileId: 'p1' })
  })
})

describe("ctx.campaignId — the campaign's own row on the live path", () => {
  it('refuses an SB campaign by name, even though it is allowlisted', async () => {
    campaignFindUnique.mockResolvedValue(SB_ROW)
    const r = await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 100, campaignId: 'c-sb', field: 'bid', intendedValueCents: 40 })
    expect(r).toEqual({
      allowed: false, deniedAt: 'ad_product_unsupported',
      reason: expect.stringMatching(/^Italy brands is not a Sponsored Products campaign \(it is Sponsored Brands\)/),
    })
  })

  it('names the ad product, not the allowlist, for an SD campaign that is also off the allowlist', async () => {
    campaignFindUnique.mockResolvedValue({ ...ROW, adProduct: null, type: 'SD', name: 'GALE Display', liveBidWritesEnabled: false })
    const r = await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 0, campaignId: 'c-sd' })
    expect(r).toMatchObject({ allowed: false, deniedAt: 'ad_product_unsupported', reason: expect.stringContaining('it is Sponsored Display') })
  })

  it('selects the ad product on the same read (no extra query)', async () => {
    campaignFindUnique.mockResolvedValue(SP_ROW)
    await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 0, campaignId: 'c-it' })
    expect(campaignFindUnique).toHaveBeenCalledTimes(1)
    expect(campaignFindUnique.mock.calls[0][0].select).toMatchObject({ adProduct: true, type: true })
  })

  it('an SP campaign passes; the allowlist still refuses an SP campaign off it', async () => {
    campaignFindUnique.mockResolvedValue(SP_ROW)
    expect(await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 0, campaignId: 'c-it' })).toEqual({ allowed: true, mode: 'live', profileId: 'p1' })
    campaignFindUnique.mockResolvedValue({ ...SP_ROW, liveBidWritesEnabled: false })
    expect(await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 0, campaignId: 'c-off' })).toMatchObject({ allowed: false, deniedAt: 'campaign_allowlist' })
  })

  it('a row that states no ad product is not refused here (Campaign.type is required; only a partial select lacks it)', async () => {
    campaignFindUnique.mockResolvedValue(ROW)
    expect(await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 0, campaignId: 'c-x' })).toEqual({ allowed: true, mode: 'live', profileId: 'p1' })
  })
})

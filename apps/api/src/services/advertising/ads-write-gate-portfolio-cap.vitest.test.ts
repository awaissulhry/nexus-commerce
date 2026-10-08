/**
 * OWNER DECISION 2A (2026-10-08) — an Amazon portfolio's monthly cap meets a limit of its own at the write gate, apart from
 * the €500 per-write value cap, which stays exactly as it is for every other write (brain/portfolio-cap-limit.ts):
 *
 *   person    the Portfolios page's push and an approved set-portfolio (a portfolio's own write, no actor): a €1,500 cap
 *             passes, a €2,500 cap is refused with the limit named and how to raise it
 *   brain     the money writer's cap (MONEY_PORTFOLIO_ACTOR) on a portfolio its product's brain owns (AUTO): the same
 *   others    a campaign budget, a bid and a campaign moved into a portfolio still meet the €500 per-write cap
 *   server    NEXUS_AMAZON_ADS_MAX_PORTFOLIO_CAP_CENTS moves the limit; an invalid value keeps €2,000
 *   owner     the Owner's own portfolioCapLimitCents for the one product a portfolio holds replaces it, lower or higher;
 *             a portfolio that also holds another product's (or a shared) campaign keeps the server's; no value set: one
 *             query, nothing else read
 *
 * The lever holders and the ownership resolver are mocked (their own suites test them). Every value is made up (public repo).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LeverHold } from './brain/lever-owners.js'

const overrideFindFirst = vi.fn()
const portfolioFindFirst = vi.fn()
const campaignFindMany = vi.fn()
const campaignFindUnique = vi.fn()
vi.mock('../../db.js', () => ({
  default: {
    campaign: { get findUnique() { return campaignFindUnique }, get findMany() { return campaignFindMany } },
    bidBrainEnrollment: { findMany: vi.fn(async () => []) },
    adKeywordProtection: { findMany: vi.fn(async () => []) },
    adSpendCeiling: { findMany: vi.fn(async () => []) },
    adBidPolicy: { findMany: vi.fn(async () => []) },
    advertisingActionLog: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), count: vi.fn(async () => 0) },
    adProductAd: { findMany: vi.fn(async () => []) },
    adWriteRefusal: { create: vi.fn(async () => ({})) },
    adsStrategy: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    // AB-15 — no kill switch open here (the gate reads them for the brain's own actors).
    adsBrainOverride: { get findFirst() { return overrideFindFirst }, findMany: vi.fn(async () => []) },
    amazonAdsPortfolio: { get findFirst() { return portfolioFindFirst } },
  },
}))
vi.mock('./ads-api-client.js', () => ({ adsMode: () => 'live' }))
vi.mock('./ads-profile-resolver.js', () => ({ adsProfileFor: vi.fn(async () => ({ profileId: 'p1', mode: 'production', writesEnabledAt: new Date() })) }))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('./ads-automation-state.service.js', () => ({ getAutomationState: vi.fn(async () => ({ autonomy: 'AUTO', halted: false, haltReason: null, effectivelyStopped: false, degraded: false })) }))
const portfolioCapHold = vi.fn()
vi.mock('./brain/lever-owners.js', () => ({ campaignLeverOwners: vi.fn(async () => new Map()), portfolioCapHold }))
const resolveCampaignOwnership = vi.fn()
vi.mock('./brain/ownership.js', () => ({ resolveCampaignOwnership }))

const { checkAdsWriteGate, isPortfolioOwnWrite, maxPortfolioCapCents } = await import('./ads-write-gate.js')
const { MONEY_PORTFOLIO_ACTOR } = await import('./brain/budget-ladder.js')
const { portfolioCapLimitOf } = await import('./brain/portfolio-cap-limit.js')

const ROW = {
  liveBidWritesEnabled: true, dynamicBidding: null, liveBidWritesToday: 0, liveBidWritesDay: null,
  minBidCents: null, maxBidCents: null, pinPlacement: false, pinBids: false, pinBudget: false, pinNote: null,
  dailyBudget: 40, portfolioId: null, marketplace: 'IT', minBudgetCents: null, maxBudgetCents: null,
  adProduct: 'SPONSORED_PRODUCTS', type: 'SP', name: 'Product A exact', costType: null, budgetJson: null,
}
const owned = (): LeverHold => ({ kind: 'owned', productId: 'prod-a', market: 'IT', why: 'AUTO by the Owner\'s product override (user:owner, 2026-10-08)' })
/** A portfolio's own write of its cap, as updatePortfolioById asks it (a person: no actor). */
const cap = (cents: number, extra: Record<string, unknown> = {}) =>
  checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: cents, dimension: 'portfolio', portfolioId: 'pf-1', ...extra } as never)
const ownership = (c: string, productId: string | null, market = 'IT') => [c, { campaignId: c, name: c, market, adProduct: 'SPONSORED_PRODUCTS', status: 'ENABLED', productIds: productId ? [productId] : [], unresolved: [], ambiguous: [], owner: productId ? { kind: 'product', productId } : { kind: 'shared', productIds: ['prod-a', 'prod-b'] } }] as const

beforeEach(() => {
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  overrideFindFirst.mockReset().mockResolvedValue(null)
  portfolioFindFirst.mockReset().mockResolvedValue({ externalPortfolioId: 'pf-1' })
  campaignFindMany.mockReset().mockResolvedValue([{ id: 'c1' }, { id: 'c2' }])
  campaignFindUnique.mockReset().mockResolvedValue(ROW)
  portfolioCapHold.mockReset().mockResolvedValue(null)
  resolveCampaignOwnership.mockReset().mockResolvedValue(new Map([ownership('c1', 'prod-a'), ownership('c2', 'prod-a')]))
})
afterEach(() => { vi.unstubAllEnvs() })

describe('Owner decision 2A — the portfolio cap limit at the gate', () => {
  it('a person: a €1,500 cap passes; a €2,500 cap is refused, the limit named with how to raise it', async () => {
    expect(maxPortfolioCapCents()).toBe(200_000)
    expect(await cap(150_000)).toMatchObject({ allowed: true, mode: 'live' })
    const r = await cap(250_000)
    expect(r).toMatchObject({ allowed: false, deniedAt: 'portfolio_cap_limit' })
    expect((r as { reason: string }).reason).toBe('portfolio cap 250000¢ exceeds the server\'s portfolio cap limit (NEXUS_AMAZON_ADS_MAX_PORTFOLIO_CAP_CENTS, default 200000¢ a month), 200000¢ a month — nothing was changed; raise NEXUS_AMAZON_ADS_MAX_PORTFOLIO_CAP_CENTS, or the product\'s own portfolioCapLimitCents (set-ads-brain op set-value), or set the cap in Seller Central')
    // Exactly at the limit passes.
    expect(await cap(200_000)).toMatchObject({ allowed: true })
  })

  it('the brain at AUTO on a portfolio it owns: a €1,500 cap passes, a €2,500 cap is refused the same way', async () => {
    portfolioCapHold.mockResolvedValue(owned())
    expect(await cap(150_000, { actor: MONEY_PORTFOLIO_ACTOR, field: 'budgetAmount', fields: ['budgetAmount'] })).toMatchObject({ allowed: true })
    expect(await cap(250_000, { actor: MONEY_PORTFOLIO_ACTOR, field: 'budgetAmount', fields: ['budgetAmount'] })).toMatchObject({ allowed: false, deniedAt: 'portfolio_cap_limit' })
    // A queued portfolio write (the ads worker: the portfolio named, its cap fields) is the same kind of write.
    expect(await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 150_000, portfolioId: 'pf-1', fields: ['budgetAmount'], dimension: 'portfolio' } as never)).toMatchObject({ allowed: true })
  })

  it('every other write still meets the €500 per-write cap: a campaign budget, a bid, a campaign moved into a portfolio', async () => {
    const budget = await checkAdsWriteGate({ marketplace: 'IT', campaignId: 'c1', payloadValueCents: 60_000, field: 'dailyBudget', fields: ['dailyBudget'], intendedValueCents: 4_000, previousValueCents: 4_000 } as never)
    expect(budget).toMatchObject({ allowed: false, deniedAt: 'value_cap', reason: 'payload value 60000¢ exceeds cap 50000¢ (NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS)' })
    const moved = await checkAdsWriteGate({ marketplace: 'IT', campaignId: 'c1', payloadValueCents: 60_000, dimension: 'portfolio' } as never)
    expect(moved).toMatchObject({ allowed: false, deniedAt: 'value_cap' })
    // A write with no campaign and no portfolio (a launch's pre-check) is not a cap either.
    expect(await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 60_000 } as never)).toMatchObject({ allowed: false, deniedAt: 'value_cap' })
    expect(isPortfolioOwnWrite({ campaignId: 'c1', portfolioId: null, dimension: 'portfolio' })).toBe(false)
    expect(isPortfolioOwnWrite({ campaignId: undefined, portfolioId: null, dimension: 'portfolio' })).toBe(true)
    expect(isPortfolioOwnWrite({ campaignId: undefined, portfolioId: 'pf-1', dimension: null })).toBe(true)
    expect(isPortfolioOwnWrite({ campaignId: undefined, portfolioId: null, dimension: null })).toBe(false)
  })

  it('the server\'s limit moves with its env; an invalid value keeps €2,000', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MAX_PORTFOLIO_CAP_CENTS', '100000')
    expect(await cap(150_000)).toMatchObject({ allowed: false, deniedAt: 'portfolio_cap_limit', reason: expect.stringContaining(', 100000¢ a month') })
    vi.stubEnv('NEXUS_AMAZON_ADS_MAX_PORTFOLIO_CAP_CENTS', 'lots')
    expect(maxPortfolioCapCents()).toBe(200_000)
    vi.stubEnv('NEXUS_AMAZON_ADS_MAX_PORTFOLIO_CAP_CENTS', '-5')
    expect(maxPortfolioCapCents()).toBe(200_000)
  })

  it('the Owner\'s own limit for the one product a portfolio holds wins over the server\'s, higher or lower', async () => {
    overrideFindFirst.mockResolvedValue({ id: 'ov-1', value: 300_000 })
    expect(await cap(250_000)).toMatchObject({ allowed: true })
    expect(await cap(350_000)).toMatchObject({ allowed: false, deniedAt: 'portfolio_cap_limit', reason: expect.stringMatching(/exceeds the Owner's portfolio cap limit for product prod-a in IT \(set-ads-brain portfolioCapLimitCents\), 300000¢ a month — nothing was changed; raise the product's portfolioCapLimitCents/) })
    overrideFindFirst.mockResolvedValue({ id: 'ov-1', value: 100_000 })
    expect(await cap(150_000)).toMatchObject({ allowed: false, deniedAt: 'portfolio_cap_limit' })
  })
})

describe('Owner decision 2A — which limit applies to a portfolio (portfolioCapLimitOf)', () => {
  it('no portfolio named, or no product with its own limit: the server\'s, with one query at most', async () => {
    expect(await portfolioCapLimitOf(null)).toMatchObject({ cents: 200_000, source: 'server' })
    expect(overrideFindFirst).not.toHaveBeenCalled()
    expect(await portfolioCapLimitOf('pf-1')).toMatchObject({ cents: 200_000, source: 'server' })
    expect(overrideFindFirst).toHaveBeenCalledTimes(1)
    expect(campaignFindMany).not.toHaveBeenCalled()
  })

  it('one product\'s portfolio: its Owner value; a shared, mixed or empty portfolio: the server\'s; an invalid value: the server\'s', async () => {
    overrideFindFirst.mockResolvedValue({ id: 'ov-1', value: 300_000 })
    expect(await portfolioCapLimitOf('pf-1')).toMatchObject({ cents: 300_000, source: 'owner', productId: 'prod-a', market: 'IT' })
    expect(overrideFindFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ productId: 'prod-a', marketplace: 'IT', key: 'portfolioCapLimitCents', endedAt: null }) }))
    resolveCampaignOwnership.mockResolvedValue(new Map([ownership('c1', 'prod-a'), ownership('c2', 'prod-b')]))
    expect(await portfolioCapLimitOf('pf-1')).toMatchObject({ source: 'server' })
    resolveCampaignOwnership.mockResolvedValue(new Map([ownership('c1', 'prod-a'), ownership('c2', null)]))
    expect(await portfolioCapLimitOf('pf-1')).toMatchObject({ source: 'server' })
    campaignFindMany.mockResolvedValue([])
    expect(await portfolioCapLimitOf('pf-1')).toMatchObject({ source: 'server' })
    campaignFindMany.mockResolvedValue([{ id: 'c1' }])
    resolveCampaignOwnership.mockResolvedValue(new Map([ownership('c1', 'prod-a')]))
    overrideFindFirst.mockResolvedValue({ id: 'ov-1', value: 50 })
    expect(await portfolioCapLimitOf('pf-1')).toMatchObject({ source: 'server', cents: 200_000 })
    overrideFindFirst.mockResolvedValue({ id: 'ov-1', value: null })
    expect(await portfolioCapLimitOf('pf-1')).toMatchObject({ source: 'server' })
  })

  it('a failed read is not a refusal: it goes out of the gate (the caller retries)', async () => {
    overrideFindFirst.mockRejectedValue(new Error('connection lost'))
    await expect(cap(150_000)).rejects.toThrow('connection lost')
  })
})

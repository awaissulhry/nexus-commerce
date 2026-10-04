/**
 * 6e (review G.3, Owner decision D4) — the write gate holds a placement raise to the campaign's ceiling on what one
 * click can then cost: highest live bid × (1 + placement %) × what "dynamic bids – up and down" adds.
 *
 * Before, a placement write reached the gate as value 0 and no bid bound judged it, so 900% with up and down (20× the
 * bid) passed every ceiling. Now: a raise past the ceiling is refused with a sentence naming the cost, the ceiling and
 * where it comes from; a raise to or under it passes; a lowering always passes and reads nothing; no ceiling set passes
 * (no new default); and the ceiling is the bid policy's maximum ?? the rank engine's hourly one. Click-cost limits only
 * (Owner): `Campaign.maxBidCents` bounds keyword bids and is not a click-cost ceiling, so it never refuses a placement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const campaignFindUnique = vi.fn()
const connFindFirst = vi.fn()
const bidPolicyFindMany = vi.fn(async () => [] as unknown[])
const productAdFindMany = vi.fn(async () => [] as unknown[])
const adGroupAggregate = vi.fn()
const adTargetAggregate = vi.fn()

vi.mock('../../db.js', () => ({
  default: {
    campaign: { get findUnique() { return campaignFindUnique } },
    amazonAdsConnection: { get findFirst() { return connFindFirst } },
    adBidPolicy: { get findMany() { return bidPolicyFindMany } },
    adProductAd: { get findMany() { return productAdFindMany } },
    adGroup: { get aggregate() { return adGroupAggregate } },
    adTarget: { get aggregate() { return adTargetAggregate } },
    adWriteRefusal: { create: vi.fn(async () => ({})) },
  },
}))
vi.mock('./ads-api-client.js', () => ({ adsMode: () => 'live' }))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('./ads-automation-state.service.js', () => ({
  getAutomationState: async () => ({ autonomy: 'AUTO', halted: false, haltReason: null, effectivelyStopped: false, degraded: false }),
}))

const { checkAdsWriteGate } = await import('./ads-write-gate.js')

const TOP = 'PLACEMENT_TOP', REST = 'PLACEMENT_REST_OF_SEARCH'
const OPEN_CAMPAIGN = {
  liveBidWritesEnabled: true, dynamicBidding: null, liveBidWritesToday: 0, liveBidWritesDay: null,
  minBidCents: null as number | null, maxBidCents: null as number | null,
  pinPlacement: false, pinBids: false, pinBudget: false, pinNote: null as string | null,
  dailyBudget: 5, portfolioId: null as string | null, marketplace: 'IT' as string | null,
  minBudgetCents: null, maxBudgetCents: null,
  adProduct: 'SPONSORED_PRODUCTS', type: 'SP', name: 'Italy exact',
  biddingStrategy: 'LEGACY_FOR_SALES' as string | null,
}
/** Highest live bid 50¢: the ad group default 40¢, a keyword at 2¢ suppressed from 50¢. */
const bids = (groupDefault = 40, target = 2, suppressedFrom: number | null = 50) => {
  adGroupAggregate.mockResolvedValue({ _max: { defaultBidCents: groupDefault, suppressedFromBidCents: null } })
  adTargetAggregate.mockResolvedValue({ _max: { bidCents: target, suppressedFromBidCents: suppressedFrom } })
}
const campaign = (over: Partial<typeof OPEN_CAMPAIGN>) => campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, ...over })
/** An enabled market bid policy for IT with this maximum: the click-cost ceiling. */
const policy = (maxBidCents: number) => bidPolicyFindMany.mockResolvedValue([
  { grain: 'MARKET', scopeId: 'IT', label: `the IT market's €${(maxBidCents / 100).toFixed(2)} ceiling`, minBidCents: null, maxBidCents },
])
const FROM_POLICY = (cents: number) => `ceiling from the bid policy "the IT market's €${(cents / 100).toFixed(2)} ceiling"`
const placementWrite = (prior: Array<[string, number]>, next: Array<[string, number]>, extra: Record<string, unknown> = {}) => checkAdsWriteGate({
  marketplace: 'IT', payloadValueCents: 0, campaignId: 'c1', dimension: 'placement',
  placement: {
    prior: prior.map(([placement, percentage]) => ({ placement, percentage })),
    adjustments: next.map(([placement, percentage]) => ({ placement, percentage })),
    ...extra,
  },
})

beforeEach(() => {
  vi.clearAllMocks()
  connFindFirst.mockResolvedValue({ profileId: 'p1', mode: 'production', writesEnabledAt: new Date() })
  campaign({})
  bidPolicyFindMany.mockResolvedValue([])
  productAdFindMany.mockResolvedValue([])
  bids()
})

describe('6e — a placement raise past the ceiling is refused', () => {
  it('refuses with what one click would cost, the ceiling and where it comes from', async () => {
    policy(150)
    const r = await placementWrite([[TOP, 0]], [[TOP, 300]]) // 50¢ × 4 = €2.00
    expect(r).toEqual({
      allowed: false,
      deniedAt: 'effective_cpc',
      reason: 'Raising Top of search from 0% to 300% would let one click cost up to €2.00 (highest bid €0.50 ×4.00 for the placement), '
        + 'above the €1.50 ceiling from the bid policy "the IT market\'s €1.50 ceiling", so nothing was sent to Amazon. At most 200% fits under that ceiling there. '
        + 'Lowering a placement is always allowed.',
    })
    // the highest LIVE bid: enabled keywords and targets in enabled ad groups, and those groups' default bids
    expect(adTargetAggregate).toHaveBeenCalledWith({
      where: { adGroup: { campaignId: 'c1', status: 'ENABLED' }, status: 'ENABLED', isNegative: false },
      _max: { bidCents: true, suppressedFromBidCents: true },
    })
    expect(adGroupAggregate).toHaveBeenCalledWith({ where: { campaignId: 'c1', status: 'ENABLED' }, _max: { defaultBidCents: true, suppressedFromBidCents: true } })
  })

  it('a raise to exactly the ceiling, or under it, is allowed', async () => {
    policy(150)
    expect((await placementWrite([[TOP, 0]], [[TOP, 200]])).allowed).toBe(true) // 50 × 3 = 150
    expect((await placementWrite([[TOP, 0]], [[TOP, 100]])).allowed).toBe(true)
  })

  it('a suppressed bid counts at the value it is restored to — the placement outlives the floor', async () => {
    policy(100)
    bids(10, 2, 60) // bids floored at 2¢; one returns to 60¢ → 60 × 2 = 120 at +100%
    const r = await placementWrite([[TOP, 0]], [[TOP, 100]])
    expect(r).toMatchObject({ allowed: false, deniedAt: 'effective_cpc' })
  })

  it('up and down on the campaign counts: +100% at Top of search, +50% on the other placements', async () => {
    campaign({ biddingStrategy: 'AUTO_FOR_SALES' })
    policy(150)
    expect((await placementWrite([[TOP, 0]], [[TOP, 50]])).allowed).toBe(true) // 50 × 1.5 × 2 = 150
    expect(await placementWrite([[TOP, 0]], [[TOP, 60]])).toMatchObject({ allowed: false, deniedAt: 'effective_cpc' }) // 160
    expect((await placementWrite([[REST, 0]], [[REST, 100]])).allowed).toBe(true) // 50 × 2 × 1.5 = 150
  })

  it('a write that switches the strategy to up and down is measured with it', async () => {
    policy(150)
    const r = await placementWrite([[TOP, 100]], [[TOP, 100]], { biddingStrategy: 'autoForSales' }) // 50 × 2 × 2 = 200
    expect(r).toMatchObject({ allowed: false, deniedAt: 'effective_cpc' })
    if (!r.allowed) expect(r.reason).toMatch(/^Switching to "dynamic bids – up and down" with Top of search at 100%/)
  })
})

describe('6e — what is never refused', () => {
  it('a lowering passes and reads nothing — even when the placement stays above the ceiling', async () => {
    policy(100)
    const r = await placementWrite([[TOP, 400], [REST, 100]], [[TOP, 300], [REST, 0]]) // 50 × 4 = 200 > 100, but lower
    expect(r.allowed).toBe(true)
    expect(adGroupAggregate).not.toHaveBeenCalled()
    expect(adTargetAggregate).not.toHaveBeenCalled()
    expect(bidPolicyFindMany).not.toHaveBeenCalled()
  })

  it('no ceiling anywhere passes — no new default (D4), and no bid is read', async () => {
    const r = await placementWrite([[TOP, 0]], [[TOP, 900]])
    expect(r.allowed).toBe(true)
    expect(bidPolicyFindMany).toHaveBeenCalledTimes(1)
    expect(adTargetAggregate).not.toHaveBeenCalled()
  })

  it('a campaign with no live bid cannot breach a ceiling', async () => {
    policy(100)
    adGroupAggregate.mockResolvedValue({ _max: { defaultBidCents: null, suppressedFromBidCents: null } })
    adTargetAggregate.mockResolvedValue({ _max: { bidCents: null, suppressedFromBidCents: null } })
    expect((await placementWrite([[TOP, 0]], [[TOP, 900]])).allowed).toBe(true)
  })

  it('a write that is not a placement write is not measured (bids and budgets keep their own bounds)', async () => {
    policy(100)
    const r = await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 0, campaignId: 'c1', dimension: 'placement' })
    expect(r.allowed).toBe(true)
    expect(adTargetAggregate).not.toHaveBeenCalled()
  })
})

describe('6e — which ceiling wins: the bid policy ?? the hourly plan\'s; never the campaign\'s keyword maximum bid', () => {
  const RANK = { cents: 400, source: 'the hourly plan\'s CPC ceiling (target "own-top")' }

  it('a campaign WITH a maximum bid and no policy or hourly ceiling is allowed: it bounds keyword bids, not click cost', async () => {
    campaign({ maxBidCents: 100 })
    const r = await placementWrite([[TOP, 0]], [[TOP, 900]]) // 50¢ × 10 = €5.00, far past €1.00 — and still allowed
    expect(r.allowed).toBe(true)
    expect(adTargetAggregate).not.toHaveBeenCalled()
  })

  it('the bid policy first, named by its label — even when the hourly plan says otherwise', async () => {
    campaign({ maxBidCents: 500 })
    policy(120)
    const r = await placementWrite([[TOP, 0]], [[TOP, 200]], { ceiling: RANK }) // 150 > 120
    if (r.allowed) throw new Error('expected a refusal')
    expect(r.reason).toContain(`above the €1.20 ${FROM_POLICY(120)}`)
  })

  it('then the ceiling the rank engine serves, when no bid policy sets one (the campaign\'s maximum bid is not read)', async () => {
    campaign({ maxBidCents: 100 })
    const refused = await placementWrite([[TOP, 0]], [[TOP, 900]], { ceiling: RANK }) // 500 > 400
    if (refused.allowed) throw new Error('expected a refusal')
    expect(refused.reason).toContain('above the €4.00 ceiling from the hourly plan\'s CPC ceiling (target "own-top")')
    expect((await placementWrite([[TOP, 0]], [[TOP, 700]], { ceiling: RANK })).allowed).toBe(true) // 400
  })
})

describe('6e — order: the broader refusals still come first', () => {
  it('a placement pin refuses before the ceiling is measured', async () => {
    campaign({ pinPlacement: true, pinNote: 'held by hand' })
    policy(100)
    const r = await placementWrite([[TOP, 0]], [[TOP, 900]])
    expect(r).toMatchObject({ allowed: false, deniedAt: 'authority_pin' })
    expect(adTargetAggregate).not.toHaveBeenCalled()
  })

  it('so does the live-write allowlist', async () => {
    campaign({ liveBidWritesEnabled: false })
    policy(100)
    expect(await placementWrite([[TOP, 0]], [[TOP, 900]])).toMatchObject({ allowed: false, deniedAt: 'campaign_allowlist' })
  })
})

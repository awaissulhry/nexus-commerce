/**
 * ADX A1 — the write gate's two new checks.
 *
 * Bounds live on the entity (Campaign.minBidCents / maxBidCents) rather than inside a
 * rule, so they bind every engine automatically: the gate is the single chokepoint and
 * there is no other way to Amazon. A rule can be edited, bypassed, or simply not exist
 * yet for an entity created tomorrow; a column cannot.
 *
 * Keyword protection is the same idea applied to targeting. Harvest-and-negate ran
 * enabled on prod with nothing protecting a brand term from being negated by it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const campaignFindUnique = vi.fn()
const connFindFirst = vi.fn()
const protectionFindMany = vi.fn(async () => [] as unknown[])

vi.mock('../../db.js', () => ({
  default: {
    campaign: { get findUnique() { return campaignFindUnique } },
    amazonAdsConnection: { get findFirst() { return connFindFirst } },
    adKeywordProtection: { get findMany() { return protectionFindMany } },
  },
}))
vi.mock('./ads-api-client.js', () => ({ adsMode: () => 'live' }))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

// ACR.0.7 — the gate now consults the account halt. Mock it explicitly: without this the
// state read fails, falls back to "not stopped", and every halt test would pass for the
// wrong reason.
const automationState = vi.fn(async () => ({
  autonomy: 'AUTO', halted: false, haltReason: null as string | null,
  effectivelyStopped: false, degraded: false,
}))
vi.mock('./ads-automation-state.service.js', () => ({
  get getAutomationState() { return automationState },
}))

const { checkAdsWriteGate, normaliseTerm } = await import('./ads-write-gate.js')

const LIVE_CONN = { profileId: 'p1', mode: 'production', writesEnabledAt: new Date() }
const OPEN_CAMPAIGN = {
  liveBidWritesEnabled: true, dynamicBidding: null, liveBidWritesToday: 0, liveBidWritesDay: null,
  minBidCents: null as number | null, maxBidCents: null as number | null,
}

beforeEach(() => {
  campaignFindUnique.mockReset()
  connFindFirst.mockReset()
  protectionFindMany.mockReset()
  connFindFirst.mockResolvedValue(LIVE_CONN)
  automationState.mockResolvedValue({ autonomy: 'AUTO', halted: false, haltReason: null, effectivelyStopped: false, degraded: false })
  campaignFindUnique.mockResolvedValue(OPEN_CAMPAIGN)
  protectionFindMany.mockResolvedValue([])
})

const base = { marketplace: 'IT', payloadValueCents: 100, campaignId: 'camp-1' }

describe('ADX A1 — entity bid bounds', () => {
  it('allows a bid inside the bounds', async () => {
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, minBidCents: 10, maxBidCents: 200 })
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 150 })
    expect(r.allowed).toBe(true)
  })

  it('denies a bid above maxBidCents', async () => {
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, maxBidCents: 200 })
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 201 })
    expect(r.allowed).toBe(false)
    if (r.allowed === false) expect(r.deniedAt).toBe('entity_bounds')
  })

  it('denies a bid below minBidCents', async () => {
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, minBidCents: 10 })
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 2 })
    expect(r.allowed).toBe(false)
    if (r.allowed === false) expect(r.deniedAt).toBe('entity_bounds')
  })

  it('bounds apply to defaultBid too, not just bid', async () => {
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, maxBidCents: 50 })
    const r = await checkAdsWriteGate({ ...base, field: 'defaultBid', intendedValueCents: 90 })
    expect(r.allowed).toBe(false)
  })

  it('a null bound is unbounded — every pre-existing row behaves as before', async () => {
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 99_999 })
    expect(r.allowed).toBe(true)
  })

  it('does not bound a non-bid field', async () => {
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, maxBidCents: 50 })
    // A daily budget of 900 is not a bid and must not be judged against a bid ceiling.
    const r = await checkAdsWriteGate({ ...base, field: 'dailyBudget', intendedValueCents: 900 })
    expect(r.allowed).toBe(true)
  })

  it('the allowlist still wins — bounds do not rescue a non-allowlisted campaign', async () => {
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, liveBidWritesEnabled: false, maxBidCents: 500 })
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 10 })
    expect(r.allowed).toBe(false)
    if (r.allowed === false) expect(r.deniedAt).toBe('campaign_allowlist')
  })
})

describe('ADX G1 — suppression is exempt from the MIN bound', () => {
  // suppressCampaignBids drives bids to ~2¢: it is how the retail guard, budget
  // stop-over-spend and Min-bid dayparting windows all suppress delivery under the
  // no-pause rule. A1's min bound would have silently disabled every one of them the
  // moment anyone set a min above 2¢. A floor that blocks a safety action is worse
  // than no floor.
  it('THE BUG: without the exemption, a min bound blocks suppression to 2c', async () => {
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, minBidCents: 10 })
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 2 })
    expect(r.allowed).toBe(false)
    if (r.allowed === false) expect(r.deniedAt).toBe('entity_bounds')
  })

  it('THE FIX: a forced suppression write passes the same min bound', async () => {
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, minBidCents: 10 })
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 2, isSuppression: true })
    expect(r.allowed).toBe(true)
  })

  it('the MAXIMUM still binds — a "suppression" that raises a bid is not one', async () => {
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, maxBidCents: 50 })
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 400, isSuppression: true })
    expect(r.allowed).toBe(false)
    if (r.allowed === false) expect(r.deniedAt).toBe('entity_bounds')
  })

  it('the allowlist still binds on a forced write', async () => {
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, liveBidWritesEnabled: false, minBidCents: 10 })
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 2, isSuppression: true })
    expect(r.allowed).toBe(false)
    if (r.allowed === false) expect(r.deniedAt).toBe('campaign_allowlist')
  })
})

describe('ADX A1 — keyword protection', () => {
  it('denies negating a whitelisted term', async () => {
    protectionFindMany.mockResolvedValue([{ term: 'giacca moto xavia', isPrefix: false, reason: 'brand term' }])
    const r = await checkAdsWriteGate({ ...base, isNegation: true, keywordText: 'Giacca  Moto   Xavia' })
    expect(r.allowed).toBe(false)
    if (r.allowed === false) {
      expect(r.deniedAt).toBe('keyword_protected')
      expect(r.reason).toContain('brand term')
    }
  })

  it('matches case-insensitively and collapses whitespace', async () => {
    expect(normaliseTerm('  Giacca   MOTO  ')).toBe('giacca moto')
  })

  it('honours a prefix protection', async () => {
    protectionFindMany.mockResolvedValue([{ term: 'xavia', isPrefix: true, reason: null }])
    const r = await checkAdsWriteGate({ ...base, isNegation: true, keywordText: 'xavia gale giacca' })
    expect(r.allowed).toBe(false)
  })

  it('a prefix protection does not match a term that merely contains it', async () => {
    protectionFindMany.mockResolvedValue([{ term: 'xavia', isPrefix: true, reason: null }])
    const r = await checkAdsWriteGate({ ...base, isNegation: true, keywordText: 'giacca xavia' })
    expect(r.allowed).toBe(true)
  })

  it('CONTAINS catches the brand wherever it appears — the case prefix misses', async () => {
    // Amazon returns "giacca moto xavia". Prefix would not match it; that is the whole
    // reason CONTAINS exists.
    protectionFindMany.mockResolvedValue([{ term: 'xavia', isPrefix: false, matchType: 'CONTAINS', reason: 'brand' }])
    const r = await checkAdsWriteGate({ ...base, isNegation: true, keywordText: 'giacca moto xavia' })
    expect(r.allowed).toBe(false)
  })

  it('CONTAINS still lets an unrelated term through', async () => {
    protectionFindMany.mockResolvedValue([{ term: 'xavia', isPrefix: false, matchType: 'CONTAINS', reason: null }])
    const r = await checkAdsWriteGate({ ...base, isNegation: true, keywordText: 'motorradjacke herren' })
    expect(r.allowed).toBe(true)
  })

  it('a null matchType falls back to isPrefix — pre-existing rows unchanged', async () => {
    protectionFindMany.mockResolvedValue([{ term: 'xavia', isPrefix: true, matchType: null, reason: null }])
    expect((await checkAdsWriteGate({ ...base, isNegation: true, keywordText: 'xavia gale' })).allowed).toBe(false)
    expect((await checkAdsWriteGate({ ...base, isNegation: true, keywordText: 'gale xavia' })).allowed).toBe(true)
  })

  it('allows negating an unprotected term', async () => {
    protectionFindMany.mockResolvedValue([{ term: 'xavia', isPrefix: false, reason: null }])
    const r = await checkAdsWriteGate({ ...base, isNegation: true, keywordText: 'motorradjacke herren sommer' })
    expect(r.allowed).toBe(true)
  })

  it('does not consult protections when the write is not a negation', async () => {
    await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 50 })
    expect(protectionFindMany).not.toHaveBeenCalled()
  })
})

/**
 * ACR.0.7 — the halt binds at the gate.
 *
 * Before this, `isAutomationHalted` was consulted by exactly two engines. On prod, with the
 * breaker tripped, ad-rank-defend's next tick still applied 21 bid changes and budget
 * enforcement still ran LIVE. These tests pin the property that made that impossible.
 */
describe('ACR.0.7 — account halt', () => {
  const halted = { autonomy: 'AUTO', halted: true, haltReason: 'Automation runaway: 264 actions in the last hour (limit 250).', effectivelyStopped: true, degraded: false }

  it('denies an ordinary bid write while halted', async () => {
    automationState.mockResolvedValue(halted)
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 150 })
    expect(r.allowed).toBe(false)
    if (r.allowed === false) {
      expect(r.deniedAt).toBe('automation_halted')
      // The operator must see WHY, not just that something refused.
      expect(r.reason).toContain('264 actions')
    }
  })

  it('denies a budget write while halted', async () => {
    automationState.mockResolvedValue(halted)
    expect((await checkAdsWriteGate({ ...base, field: 'dailyBudget', intendedValueCents: 5000 })).allowed).toBe(false)
  })

  it('STILL ALLOWS suppression while halted — a halt must never freeze bids high', async () => {
    automationState.mockResolvedValue(halted)
    // Suppression drives bids to ~2¢ (retail guard, budget stop-over-spend, Min-bid windows).
    // Blocking it during a halt would raise spend at the moment we most want it cut.
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 2, isSuppression: true })
    expect(r.allowed).toBe(true)
  })

  it('denies when autonomy is OFF even though nothing is "halted"', async () => {
    automationState.mockResolvedValue({ autonomy: 'OFF', halted: false, haltReason: null, effectivelyStopped: true, degraded: false })
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 150 })
    expect(r.allowed).toBe(false)
    if (r.allowed === false) expect(r.reason).toContain('autonomy is OFF')
  })

  it('allows normally when the account is running', async () => {
    expect((await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 150 })).allowed).toBe(true)
  })

  it('checks the halt BEFORE the per-campaign allowlist — the outermost gate wins', async () => {
    automationState.mockResolvedValue(halted)
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, liveBidWritesEnabled: false })
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 150 })
    // Both would deny; the reported reason must be the halt, or an operator resuming
    // automation would be told the campaign is the problem.
    if (r.allowed === false) expect(r.deniedAt).toBe('automation_halted')
  })
})

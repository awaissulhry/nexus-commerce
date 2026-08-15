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
const campaignFindMany = vi.fn(async () => [] as unknown[])
const connFindFirst = vi.fn()
const protectionFindMany = vi.fn(async () => [] as unknown[])
// AUTO.A7 — the ceiling check's reads. Empty by default so every pre-existing case is untouched.
const ceilingFindMany = vi.fn(async () => [] as unknown[])
const bidPolicyFindMany = vi.fn(async () => [] as unknown[])
const actionLogFindMany = vi.fn(async () => [] as unknown[])
const productAdFindMany = vi.fn(async () => [] as unknown[])
const refusalCreate = vi.fn(async () => ({}))

vi.mock('../../db.js', () => ({
  default: {
    campaign: { get findUnique() { return campaignFindUnique }, get findMany() { return campaignFindMany } },
    amazonAdsConnection: { get findFirst() { return connFindFirst } },
    adKeywordProtection: { get findMany() { return protectionFindMany } },
    adSpendCeiling: { get findMany() { return ceilingFindMany } },
    adBidPolicy: { get findMany() { return bidPolicyFindMany } },
    advertisingActionLog: { get findMany() { return actionLogFindMany } },
    adProductAd: { get findMany() { return productAdFindMany } },
    adWriteRefusal: { get create() { return refusalCreate } },
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
const { dimensionForField, dimensionsForWrite, pinDenial, pinnedDimensions } = await import('./ads-authority-pins.js')

const LIVE_CONN = { profileId: 'p1', mode: 'production', writesEnabledAt: new Date() }
const OPEN_CAMPAIGN = {
  liveBidWritesEnabled: true, dynamicBidding: null, liveBidWritesToday: 0, liveBidWritesDay: null,
  minBidCents: null as number | null, maxBidCents: null as number | null,
  // ACR.1.2b — unpinned is every existing row's state, so the default fixture carries it.
  pinPlacement: false, pinBids: false, pinBudget: false, pinNote: null as string | null,
  // AUTO.A7 — the ceiling check reads these off the same row.
  dailyBudget: 5, portfolioId: null as string | null, marketplace: 'IT' as string | null,
}

beforeEach(() => {
  campaignFindUnique.mockReset()
  campaignFindMany.mockReset()
  connFindFirst.mockReset()
  protectionFindMany.mockReset()
  ceilingFindMany.mockReset()
  bidPolicyFindMany.mockReset()
  actionLogFindMany.mockReset()
  productAdFindMany.mockReset()
  connFindFirst.mockResolvedValue(LIVE_CONN)
  automationState.mockResolvedValue({ autonomy: 'AUTO', halted: false, haltReason: null, effectivelyStopped: false, degraded: false })
  campaignFindUnique.mockResolvedValue(OPEN_CAMPAIGN)
  campaignFindMany.mockResolvedValue([])
  protectionFindMany.mockResolvedValue([])
  ceilingFindMany.mockResolvedValue([])
  bidPolicyFindMany.mockResolvedValue([])
  actionLogFindMany.mockResolvedValue([])
  productAdFindMany.mockResolvedValue([])
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

/**
 * ACR.1.2b — per-dimension authority pins.
 *
 * The bounds say how far automation may move a number; a pin says whether it may touch
 * that number at all. The point of testing at the GATE rather than only at the resolver
 * is that a pin enforced anywhere else is decorative — which is the defect class this
 * whole programme removes, and one this feature could very easily have shipped as.
 */
describe('ACR.1.2b — the pin resolver (pure)', () => {
  it('maps the mutation service\'s own field vocabulary', () => {
    expect(dimensionForField('bid')).toBe('bids')
    expect(dimensionForField('defaultBid')).toBe('bids')
    expect(dimensionForField('biddingStrategy')).toBe('bids')
    expect(dimensionForField('dailyBudget')).toBe('budget')
    expect(dimensionForField('PLACEMENT_TOP')).toBe('placement')
  })

  it('an UNMAPPED field belongs to no dimension — a pin is not a campaign-wide freeze', () => {
    // A pin says "hands off this dimension". Pausing, renaming and re-portfolioing a
    // campaign are governed by the allowlist; giving one concept two controls is how they
    // eventually disagree.
    expect(dimensionForField('status')).toBeNull()
    expect(dimensionForField('name')).toBeNull()
    expect(dimensionForField('portfolioId')).toBeNull()
    expect(dimensionForField(null)).toBeNull()
  })

  it('collects EVERY dimension a multi-field write touches', () => {
    const d = dimensionsForWrite({ fields: ['bid', 'dailyBudget', 'status'] })
    expect(d.sort()).toEqual(['bids', 'budget'])
  })

  it('an explicit dimension survives an empty field list — the inline placement path', () => {
    expect(dimensionsForWrite({ fields: [], dimension: 'placement' })).toEqual(['placement'])
  })

  it('reports the pinned dimensions in a stable order', () => {
    expect(pinnedDimensions({ pinPlacement: true, pinBids: false, pinBudget: true }))
      .toEqual(['placement', 'budget'])
  })

  it('carries the operator\'s note into the reason — a refusal should say whose decision it was', () => {
    const d = pinDenial(
      { pinPlacement: false, pinBids: true, pinBudget: false, pinNote: 'holding €0.40 for the GALE test' },
      { dimensions: ['bids'], campaignId: 'camp-1' },
    )
    expect(d?.reason).toContain('holding €0.40 for the GALE test')
  })
})

describe('ACR.1.2b — pins bind AT THE GATE', () => {
  it('denies a bid write on a bids-pinned campaign', async () => {
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, pinBids: true })
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 150 })
    expect(r.allowed).toBe(false)
    if (r.allowed === false) {
      expect(r.deniedAt).toBe('authority_pin')
      expect(r.reason).toContain('bids is pinned')
      // Caught by reading the live deny on prod, not by a type: one shared label produced
      // "this campaign's bids is held by hand". A refusal is exactly the sentence that has
      // to read cleanly, because it is the one an operator stops to argue with.
      expect(r.reason).toContain("campaign's bids are held by hand")
    }
  })

  it('the singular dimensions keep the singular verb', async () => {
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, pinBudget: true })
    const r = await checkAdsWriteGate({ ...base, field: 'dailyBudget', intendedValueCents: 900 })
    if (r.allowed === false) expect(r.reason).toContain("campaign's budget is held by hand")
  })

  it('denies a budget write on a budget-pinned campaign', async () => {
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, pinBudget: true })
    const r = await checkAdsWriteGate({ ...base, field: 'dailyBudget', intendedValueCents: 5000 })
    expect(r.allowed).toBe(false)
    if (r.allowed === false) expect(r.deniedAt).toBe('authority_pin')
  })

  it('denies the inline placement push on a placement-pinned campaign', async () => {
    // updatePlacementBidding has no fieldChanges to derive from, so it names its dimension.
    // Placement bias is the rank engine's primary actuator and runs to +900%; if any pin
    // had to work, it is this one.
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, pinPlacement: true })
    const r = await checkAdsWriteGate({ ...base, dimension: 'placement', payloadValueCents: 0 })
    expect(r.allowed).toBe(false)
    if (r.allowed === false) expect(r.deniedAt).toBe('authority_pin')
  })

  it('a pin binds ONE dimension — the others still write', async () => {
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, pinBudget: true })
    expect((await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 150 })).allowed).toBe(true)
    expect((await checkAdsWriteGate({ ...base, dimension: 'placement' })).allowed).toBe(true)
  })

  it('does not touch dimensionless writes — a pinned campaign can still be paused', async () => {
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, pinBids: true, pinBudget: true, pinPlacement: true })
    const r = await checkAdsWriteGate({ ...base, field: 'status', intendedValueCents: null })
    expect(r.allowed).toBe(true)
  })

  it('THE BUG A SINGLE-FIELD TEST WOULD MISS: a multi-field payload is judged on all of them', async () => {
    // The worker surfaces ONE representative field to the gate (the bid field, for the A1
    // bounds). A payload carrying a bid AND a budget change would therefore arrive with
    // `field: 'bid'` — so a budget pin checked against `field` alone would hold on every
    // single-field payload a test naturally writes, and silently pass the combined one.
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, pinBudget: true })
    const r = await checkAdsWriteGate({
      ...base, field: 'bid', intendedValueCents: 150, fields: ['bid', 'dailyBudget'],
    })
    expect(r.allowed).toBe(false)
    if (r.allowed === false) expect(r.deniedAt).toBe('authority_pin')
  })

  it('falls back to `field` when a caller supplies no list — no call site regresses', async () => {
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, pinBids: true })
    const r = await checkAdsWriteGate({ ...base, field: 'defaultBid', intendedValueCents: 60 })
    expect(r.allowed).toBe(false)
  })

  it('STILL ALLOWS suppression on a bids-pinned campaign — the ADX G1 / ACR.0.7 asymmetry', async () => {
    // Suppression drives bids to ~2¢ and is how the retail guard, budget stop-over-spend
    // and Min-bid windows stop delivery under the no-pause rule. A pin that blocked it
    // would mean "I'll manage bids myself" silently also meant "stop protecting me from
    // overspend", and would freeze bids HIGH exactly when we want them low.
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, pinBids: true })
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 2, isSuppression: true })
    expect(r.allowed).toBe(true)
  })

  it('the BUDGET pin has no suppression exemption — pacing is not a safety action', async () => {
    // Stop-over-spend suppresses BIDS. Nothing safety-critical writes dailyBudget, so the
    // exemption that rescues the bids pin must not be copied onto this one.
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, pinBudget: true })
    const r = await checkAdsWriteGate({ ...base, field: 'dailyBudget', intendedValueCents: 100, isSuppression: true })
    expect(r.allowed).toBe(false)
  })

  it('the PIN is reported before the BOUND — the broader refusal wins', async () => {
    // Both would deny. An operator who was told "bid exceeds the max" would raise the max
    // and watch nothing happen, because the real answer is that they pinned the dimension.
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, pinBids: true, maxBidCents: 100 })
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 900 })
    if (r.allowed === false) expect(r.deniedAt).toBe('authority_pin')
  })

  it('the allowlist still wins over a pin — the outer gate is reported first', async () => {
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, liveBidWritesEnabled: false, pinBids: true })
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 150 })
    if (r.allowed === false) expect(r.deniedAt).toBe('campaign_allowlist')
  })

  it('an unpinned campaign is unchanged — every existing row behaves as before', async () => {
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 150, fields: ['bid', 'dailyBudget'] })
    expect(r.allowed).toBe(true)
  })
})

// AUTO.A7 — per-scope spend ceilings, at the gate.
describe('AUTO.A7 — per-scope spend ceilings', () => {
  const budgetWrite = { ...base, field: 'dailyBudget', intendedValueCents: 2_000 } // €5 → €20

  it('no ceiling rows ⇒ untouched (today\'s account)', async () => {
    const r = await checkAdsWriteGate(budgetWrite)
    expect(r.allowed).toBe(true)
  })

  it('refuses a budget increase past a CAMPAIGN ceiling, naming it', async () => {
    ceilingFindMany.mockResolvedValue([{ grain: 'CAMPAIGN', scopeId: 'camp-1', label: 'the GALE EXACT IT campaign', dailyCapCents: 1_000 }])
    const r = await checkAdsWriteGate(budgetWrite) // +€15 vs a €10/day ceiling
    expect(r.allowed).toBe(false)
    if (r.allowed === false) {
      expect(r.deniedAt).toBe('spend_ceiling')
      expect(r.reason).toContain('the GALE EXACT IT campaign')
      expect(r.reason).toContain('€10.00')
    }
  })

  it('counts today\'s prior authorised increases against the cap', async () => {
    ceilingFindMany.mockResolvedValue([{ grain: 'CAMPAIGN', scopeId: 'camp-1', label: 'the campaign', dailyCapCents: 2_000 }])
    // €8 of increases already authorised today (payloads are EUROS)
    actionLogFindMany.mockResolvedValue([{ payloadBefore: { dailyBudget: 2 }, payloadAfter: { dailyBudget: 10 } }])
    const r = await checkAdsWriteGate(budgetWrite) // +€15 more vs €20 cap with €8 used
    expect(r.allowed).toBe(false)
  })

  it('a budget CUT never trips a spend ceiling', async () => {
    ceilingFindMany.mockResolvedValue([{ grain: 'CAMPAIGN', scopeId: 'camp-1', label: 'the campaign', dailyCapCents: 100 }])
    const r = await checkAdsWriteGate({ ...base, field: 'dailyBudget', intendedValueCents: 100 }) // €5 → €1
    expect(r.allowed).toBe(true)
  })

  it('a MARKET ceiling binds through the campaign\'s marketplace', async () => {
    ceilingFindMany.mockResolvedValue([{ grain: 'MARKET', scopeId: 'IT', label: 'the IT market', dailyCapCents: 500 }])
    campaignFindMany.mockResolvedValue([{ id: 'camp-1' }, { id: 'camp-2' }])
    const r = await checkAdsWriteGate(budgetWrite) // +€15 vs €5/day market ceiling
    expect(r.allowed).toBe(false)
    if (r.allowed === false) expect(r.reason).toContain('the IT market')
  })

  it('under every ceiling ⇒ allowed', async () => {
    ceilingFindMany.mockResolvedValue([{ grain: 'CAMPAIGN', scopeId: 'camp-1', label: 'the campaign', dailyCapCents: 10_000 }])
    const r = await checkAdsWriteGate(budgetWrite) // +€15 vs €100/day
    expect(r.allowed).toBe(true)
  })
})

// BID.S5 — bid bounds resolve at four grains, most specific first PER SIDE.
describe('BID.S5 — four-grain bid bounds', () => {
  it('a MARKET ceiling binds when the campaign column is null', async () => {
    bidPolicyFindMany.mockResolvedValue([{ grain: 'MARKET', scopeId: 'IT', label: "the IT market's €0.80 ceiling", minBidCents: null, maxBidCents: 80 }])
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 90 })
    expect(r.allowed).toBe(false)
    if (r.allowed === false) expect(r.reason).toContain("the IT market's €0.80 ceiling")
  })

  it('the campaign column WINS over any policy — pre-existing rows unchanged', async () => {
    campaignFindUnique.mockResolvedValue({ ...OPEN_CAMPAIGN, maxBidCents: 200 })
    bidPolicyFindMany.mockResolvedValue([{ grain: 'MARKET', scopeId: 'IT', label: 'market ceiling', minBidCents: null, maxBidCents: 80 }])
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 150 })
    expect(r.allowed).toBe(true) // 150 < campaign 200; the market 80 does not apply
  })

  it('sides resolve independently — a market floor composes with a line ceiling', async () => {
    bidPolicyFindMany.mockResolvedValue([
      { grain: 'MARKET', scopeId: 'IT', label: 'the IT floor', minBidCents: 10, maxBidCents: null },
      { grain: 'LINE', scopeId: 'parent-1', label: "the GALE line's ceiling", minBidCents: null, maxBidCents: 60 },
    ])
    productAdFindMany.mockResolvedValue([{ product: { parentId: 'parent-1' } }])
    const under = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 5 })
    expect(under.allowed).toBe(false)
    if (under.allowed === false) expect(under.reason).toContain('the IT floor')
    const over = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 70 })
    expect(over.allowed).toBe(false)
    if (over.allowed === false) expect(over.reason).toContain("the GALE line's ceiling")
  })

  it('a LINE row for a line this campaign does not advertise says nothing', async () => {
    bidPolicyFindMany.mockResolvedValue([{ grain: 'LINE', scopeId: 'other-parent', label: 'other line', minBidCents: null, maxBidCents: 10 }])
    productAdFindMany.mockResolvedValue([{ product: { parentId: 'parent-1' } }])
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 500 })
    expect(r.allowed).toBe(true)
  })

  it('suppression stays exempt from a POLICY floor too', async () => {
    bidPolicyFindMany.mockResolvedValue([{ grain: 'MARKET', scopeId: 'IT', label: 'the IT floor', minBidCents: 10, maxBidCents: null }])
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 2, isSuppression: true })
    expect(r.allowed).toBe(true)
  })
})

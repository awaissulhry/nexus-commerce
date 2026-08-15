/**
 * AUTO.P0 guard ④ — the daily budget MOVEMENT bound.
 *
 * The fourth and last of the §2.4 guards, and the only one keyed to the ENTITY rather than to a
 * rule. That is the whole point: `GALE EXACT IT` fell €4.42 → €1.00 in 2¾ hours with TWO writers
 * taking turns — the pacer raising it and a rule cutting it back within the same minute. Every
 * per-rule brake in the engine was within its own limit the entire time.
 *
 * A new file rather than cases appended to `ads-write-gate-bounds.vitest.test.ts`, because that
 * file is edited by several sessions at once and a merge there costs more than a duplicated mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const campaignFindUnique = vi.fn()
const campaignFindMany = vi.fn(async () => [] as unknown[])
const connFindFirst = vi.fn()
const protectionFindMany = vi.fn(async () => [] as unknown[])
const ceilingFindMany = vi.fn(async () => [] as unknown[])
const bidPolicyFindMany = vi.fn(async () => [] as unknown[])
const actionLogFindMany = vi.fn(async () => [] as unknown[])
const actionLogFindFirst = vi.fn(async () => null as unknown)
const productAdFindMany = vi.fn(async () => [] as unknown[])
const refusalCreate = vi.fn(async () => ({}))

vi.mock('../../db.js', () => ({
  default: {
    campaign: { get findUnique() { return campaignFindUnique }, get findMany() { return campaignFindMany } },
    amazonAdsConnection: { get findFirst() { return connFindFirst } },
    adKeywordProtection: { get findMany() { return protectionFindMany } },
    adSpendCeiling: { get findMany() { return ceilingFindMany } },
    adBidPolicy: { get findMany() { return bidPolicyFindMany } },
    advertisingActionLog: { get findMany() { return actionLogFindMany }, get findFirst() { return actionLogFindFirst } },
    adProductAd: { get findMany() { return productAdFindMany } },
    adWriteRefusal: { get create() { return refusalCreate } },
  },
}))
vi.mock('./ads-api-client.js', () => ({ adsMode: () => 'live' }))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
const automationState = vi.fn(async () => ({
  autonomy: 'AUTO', halted: false, haltReason: null as string | null,
  effectivelyStopped: false, degraded: false,
}))
vi.mock('./ads-automation-state.service.js', () => ({
  get getAutomationState() { return automationState },
}))

const { checkAdsWriteGate } = await import('./ads-write-gate.js')

const LIVE_CONN = { profileId: 'p1', mode: 'production', writesEnabledAt: new Date() }
/** €10.00/day, no bounds set — the shape of a healthy campaign before anyone configures anything. */
const CAMPAIGN_AT_10 = {
  liveBidWritesEnabled: true, dynamicBidding: null, liveBidWritesToday: 0, liveBidWritesDay: null,
  minBidCents: null as number | null, maxBidCents: null as number | null,
  pinPlacement: false, pinBids: false, pinBudget: false, pinNote: null as string | null,
  dailyBudget: 10, portfolioId: null as string | null, marketplace: 'IT' as string | null,
  minBudgetCents: null as number | null, maxBudgetCents: null as number | null,
}
const base = { marketplace: 'IT', payloadValueCents: 100, campaignId: 'camp-1' }
/** The day's first logged write, whose `payloadBefore` is the opening value. EUROS, not cents. */
const openedAt = (euros: number) => ({ payloadBefore: { dailyBudget: euros } })

beforeEach(() => {
  vi.clearAllMocks()
  connFindFirst.mockResolvedValue(LIVE_CONN)
  automationState.mockResolvedValue({ autonomy: 'AUTO', halted: false, haltReason: null, effectivelyStopped: false, degraded: false })
  campaignFindUnique.mockResolvedValue(CAMPAIGN_AT_10)
  campaignFindMany.mockResolvedValue([])
  protectionFindMany.mockResolvedValue([])
  ceilingFindMany.mockResolvedValue([])
  bidPolicyFindMany.mockResolvedValue([])
  actionLogFindMany.mockResolvedValue([])
  actionLogFindFirst.mockResolvedValue(null)
  productAdFindMany.mockResolvedValue([])
})

describe('AUTO.P0 guard ④ — daily budget movement', () => {
  it('allows a cut inside the day\'s allowance', async () => {
    // No write logged today ⇒ the day opened at the current €10. −20% is inside −30%.
    const r = await checkAdsWriteGate({ ...base, field: 'dailyBudget', intendedValueCents: 800 })
    expect(r.allowed).toBe(true)
  })

  it('refuses a cut past the daily drop limit', async () => {
    const r = await checkAdsWriteGate({ ...base, field: 'dailyBudget', intendedValueCents: 600 }) // −40%
    expect(r.allowed).toBe(false)
    if (r.allowed === false) {
      expect(r.deniedAt).toBe('budget_day_move')
      expect(r.reason).toContain('40% drop')
      expect(r.reason).toContain('€7.00') // the floor the day's opening implies
    }
  })

  /**
   * 🔴 The case the guard exists for, and the one no per-rule brake can catch: each individual
   * step is legal, and the day's total is not. This is the GALE EXACT IT sequence in miniature.
   */
  it('refuses the SECOND legal-looking cut once the day\'s movement is spent', async () => {
    // The day opened at €10 and something already took it to €7.50 — a legal −25% on its own.
    actionLogFindFirst.mockResolvedValue(openedAt(10))
    campaignFindUnique.mockResolvedValue({ ...CAMPAIGN_AT_10, dailyBudget: 7.5 })
    // Now a −15% cut off €7.50 → €6.38. Legal against the CURRENT value, past the day's floor.
    const r = await checkAdsWriteGate({ ...base, field: 'dailyBudget', intendedValueCents: 638 })
    expect(r.allowed).toBe(false)
    if (r.allowed === false) {
      expect(r.deniedAt).toBe('budget_day_move')
      expect(r.reason).toContain('€10.00') // it refuses against the OPENING, not the current value
    }
  })

  it('measures from the day\'s OPENING even when another writer raised it since', async () => {
    // The pacer raised €10 → €12; a rule now cuts to €8.40, which is −30% of 12 but −16% of the
    // opening. Allowed: the day's total movement is what is bounded, not any one writer's step.
    actionLogFindFirst.mockResolvedValue(openedAt(10))
    campaignFindUnique.mockResolvedValue({ ...CAMPAIGN_AT_10, dailyBudget: 12 })
    const r = await checkAdsWriteGate({ ...base, field: 'dailyBudget', intendedValueCents: 840 })
    expect(r.allowed).toBe(true)
  })

  it('refuses a rise past the daily rise limit', async () => {
    const r = await checkAdsWriteGate({ ...base, field: 'dailyBudget', intendedValueCents: 2_500 }) // €10 → €25
    expect(r.allowed).toBe(false)
    if (r.allowed === false) {
      expect(r.deniedAt).toBe('budget_day_move')
      expect(r.reason).toContain('150% rise')
    }
  })

  /**
   * Where the two rise allowances cross, pinned deliberately. Below a €20 opening the flat €10
   * is the larger number, so the effective rise limit is more generous than the operator's +50%
   * — by design, because that is the same range where a percentage stops meaning anything and is
   * what keeps an at-floor campaign repairable. Above €20 the percentage takes over and binds
   * alone. Written down because "the +50% did not bind" is otherwise a bug report waiting to
   * happen against a €12 campaign.
   */
  it('the flat allowance governs below a €20 opening, the percentage above it', async () => {
    campaignFindUnique.mockResolvedValue({ ...CAMPAIGN_AT_10, dailyBudget: 10 })
    // €10 opening: allowance is max(+€5, +€10) = €10, so €20 is exactly the ceiling.
    expect((await checkAdsWriteGate({ ...base, field: 'dailyBudget', intendedValueCents: 2_000 })).allowed).toBe(true)
    expect((await checkAdsWriteGate({ ...base, field: 'dailyBudget', intendedValueCents: 2_001 })).allowed).toBe(false)

    campaignFindUnique.mockResolvedValue({ ...CAMPAIGN_AT_10, dailyBudget: 100 })
    // €100 opening: allowance is max(+€50, +€10) = €50, so the percentage is what binds.
    expect((await checkAdsWriteGate({ ...base, field: 'dailyBudget', intendedValueCents: 15_000 })).allowed).toBe(true)
    expect((await checkAdsWriteGate({ ...base, field: 'dailyBudget', intendedValueCents: 15_001 })).allowed).toBe(false)
  })

  /**
   * 🔴 The trap this guard would otherwise BE. 58 campaigns sit at Amazon's €1 floor because the
   * ratchet put them there. A percentage-only ceiling would refuse the repair — +50% of €1 is
   * €1.50 — and the guard meant to prevent the damage would lock it in. The absolute allowance
   * exists for exactly this and nothing else.
   */
  it('lets an at-floor campaign be repaired, which a pure percentage would forbid', async () => {
    campaignFindUnique.mockResolvedValue({ ...CAMPAIGN_AT_10, dailyBudget: 1 })
    const r = await checkAdsWriteGate({ ...base, field: 'dailyBudget', intendedValueCents: 1_000 }) // €1 → €10
    expect(r.allowed).toBe(true)
  })

  it('still bounds a rise from the floor once it is past the absolute allowance', async () => {
    campaignFindUnique.mockResolvedValue({ ...CAMPAIGN_AT_10, dailyBudget: 1 })
    const r = await checkAdsWriteGate({ ...base, field: 'dailyBudget', intendedValueCents: 5_000 }) // €1 → €50
    expect(r.allowed).toBe(false)
    if (r.allowed === false) expect(r.deniedAt).toBe('budget_day_move')
  })

  it('never touches a write that is not a budget', async () => {
    const r = await checkAdsWriteGate({ ...base, field: 'bid', intendedValueCents: 1 })
    expect(r.allowed).toBe(true)
    expect(actionLogFindFirst).not.toHaveBeenCalled()
  })

  /**
   * The payload unit trap, as a test. `payloadBefore.dailyBudget` is EUROS — the one ads money
   * field that is not cents. Read as cents, a €10 opening becomes €0.10, every floor collapses to
   * near zero and the guard silently permits everything it exists to refuse. That failure is
   * invisible: the gate simply allows writes, exactly as it did before this shipped.
   */
  it('reads the logged opening as EUROS, not cents', async () => {
    actionLogFindFirst.mockResolvedValue(openedAt(10)) // €10, not 10¢
    campaignFindUnique.mockResolvedValue({ ...CAMPAIGN_AT_10, dailyBudget: 10 })
    const r = await checkAdsWriteGate({ ...base, field: 'dailyBudget', intendedValueCents: 600 })
    expect(r.allowed).toBe(false) // €6 is below €10's €7 floor. Read as cents it would be allowed.
    if (r.allowed === false) expect(r.reason).toContain('€10.00')
  })
})

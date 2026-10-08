/**
 * BID BRAIN BB-6 — one writer per campaign, at the write gate. A campaign the brain owns (the env ceiling `live` and a
 * LIVE or HELD enrollment) takes a change to its bids or placements only from the brain, a person (or a request a person
 * approved), a forced lowering, and the safety owners. Every other automatic writer is refused (`brain_owned`); a
 * campaign the brain does not own, a budget, a create and a shadow ceiling are judged exactly as before.
 * ONE BRAIN AB-2 — its bidding strategy is one lever with one automatic owner: the brain (the stop recipe's down-only
 * switch and the switch back), a person and the repairs pass; every other automatic writer, the safety owners included,
 * is refused; a campaign the brain does not own and a shadow ceiling are judged as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const campaignFindUnique = vi.fn()
const enrollmentFindMany = vi.fn()
vi.mock('../../db.js', () => ({
  default: {
    campaign: { get findUnique() { return campaignFindUnique }, findMany: vi.fn(async () => []) },
    bidBrainEnrollment: { get findMany() { return enrollmentFindMany } },
    adKeywordProtection: { findMany: vi.fn(async () => []) },
    adSpendCeiling: { findMany: vi.fn(async () => []) },
    adBidPolicy: { findMany: vi.fn(async () => []) },
    advertisingActionLog: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), count: vi.fn(async () => 0) },
    adProductAd: { findMany: vi.fn(async () => []) },
    adWriteRefusal: { create: vi.fn(async () => ({})) },
    adsStrategy: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    // ONE BRAIN AB-5 — no product is enrolled in this business (production today): the gate's lever check reads this once.
    adsBrainEnrollment: { findFirst: vi.fn(async () => null) },
  },
}))
vi.mock('./ads-api-client.js', () => ({ adsMode: () => 'live' }))
vi.mock('./ads-profile-resolver.js', () => ({ adsProfileFor: vi.fn(async () => ({ profileId: 'p1', mode: 'production', writesEnabledAt: new Date() })) }))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('./ads-automation-state.service.js', () => ({ getAutomationState: vi.fn(async () => ({ autonomy: 'AUTO', halted: false, haltReason: null, effectivelyStopped: false, degraded: false })) }))

const { checkAdsWriteGate, brainYieldsTo, brainYieldsStrategyTo, BRAIN_SAFETY_ACTOR_PREFIXES, BRAIN_STRATEGY_REPAIR_PREFIXES } = await import('./ads-write-gate.js')

const ROW = {
  liveBidWritesEnabled: true, dynamicBidding: null, liveBidWritesToday: 0, liveBidWritesDay: null,
  minBidCents: null, maxBidCents: null, pinPlacement: false, pinBids: false, pinBudget: false, pinNote: null,
  dailyBudget: 5, portfolioId: null, marketplace: 'IT', minBudgetCents: null, maxBudgetCents: null,
  adProduct: 'SPONSORED_PRODUCTS', type: 'SP', name: 'Italy exact', costType: null, budgetJson: null,
}
const bid = (actor: string | null | undefined, extra: Record<string, unknown> = {}) =>
  checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 40, campaignId: 'c1', field: 'bid', fields: ['bid'], intendedValueCents: 40, ...(actor !== undefined ? { actor } : {}), ...extra })

beforeEach(() => {
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  campaignFindUnique.mockReset().mockResolvedValue(ROW)
  enrollmentFindMany.mockReset().mockResolvedValue([{ campaignId: 'c1' }])
})
afterEach(() => vi.unstubAllEnvs())

describe('BB-6 — the gate on a campaign the brain owns', () => {
  it('refuses another engine\'s bid change, naming the writer and the way back', async () => {
    const r = await bid('automation:auto-bid')
    expect(r).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
    expect((r as { reason: string }).reason).toMatch(/run by the bid brain \(one writer per campaign\): automation:auto-bid may not change its bids or placements/)
    expect((r as { reason: string }).reason).toMatch(/set-bid-brain-enrollment gives the campaign back/)
    expect(enrollmentFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ campaignId: { in: ['c1'] } }) }))
  })

  it('refuses a rule, rank-defend, dayparting, coverage and a Claude request the business\'s rule ran', async () => {
    for (const actor of ['automation:rule-abc', 'automation:cmrule1', 'automation:rank-defend-s1', 'automation:rank-plan-p1', 'automation:dayparting-s1', 'automation:coverage-engine', 'automation:autopilot-x', 'automation:tos-optimizer', 'user:owner']) {
      expect(await bid(actor), actor).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
    }
    // An unnamed automatic change is refused too: it cannot be told apart.
    expect(await bid(null)).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
  })

  it('refuses a placement change from rank-defend (the placement dimension)', async () => {
    const r = await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 0, campaignId: 'c1', dimension: 'placement', actor: 'automation:rank-defend-s1' })
    expect(r).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
  })

  it('lets the brain, a person, an approved request, a forced lowering and every safety owner through', async () => {
    expect(await bid('automation:bid-brain')).toMatchObject({ allowed: true, mode: 'live' })
    expect(await bid('user:owner', { manual: true })).toMatchObject({ allowed: true })
    expect(await bid('automation:rank-defend-s1', { isSuppression: true })).toMatchObject({ allowed: true })
    for (const actor of ['automation:retail-guard', 'automation:retail-guard-cron', 'automation:budget-manager', 'automation:budget-manager-cron', 'automation:budget-enforce', 'automation:auto-undo', 'automation:reconcile', 'automation:ads-write-reconcile', 'automation:resync-bids']) {
      expect(await bid(actor), actor).toMatchObject({ allowed: true })
    }
  })

  it('judges a budget, a create (no actor) and a campaign the brain does not own as before', async () => {
    expect(await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 500, campaignId: 'c1', field: 'dailyBudget', fields: ['dailyBudget'], intendedValueCents: 500, actor: 'automation:budget-schedule-s1' })).toMatchObject({ allowed: true })
    expect(await bid(undefined)).toMatchObject({ allowed: true })
    enrollmentFindMany.mockResolvedValue([])
    expect(await bid('automation:auto-bid')).toMatchObject({ allowed: true })
  })

  it('reads nothing and refuses nothing while the ceiling is shadow', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    expect(await bid('automation:auto-bid')).toMatchObject({ allowed: true })
    expect(enrollmentFindMany).not.toHaveBeenCalled()
  })

  it('fails closed when the enrollment cannot be read', async () => {
    enrollmentFindMany.mockRejectedValue(new Error('db down'))
    const r = await bid('automation:auto-bid')
    expect(r).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
    expect((r as { reason: string }).reason).toMatch(/could not read whether the bid brain owns campaign c1/)
  })
})

describe('AB-2 — the bidding strategy of a campaign the brain owns: one owner per lever', () => {
  // As the campaign write hands it to the gate (updateCampaignWithSync → gateRefusedNow, and the worker at dispatch).
  const strategy = (actor: string | null | undefined, extra: Record<string, unknown> = {}) =>
    checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 0, campaignId: 'c1', field: 'biddingStrategy', fields: ['biddingStrategy'], intendedValueCents: null, ...(actor !== undefined ? { actor } : {}), ...extra })

  it('lets the brain switch it (the stop recipe), and a person or a request a person approved', async () => {
    expect(await strategy('automation:bid-brain')).toMatchObject({ allowed: true, mode: 'live' })
    expect(await strategy('user:owner', { manual: true })).toMatchObject({ allowed: true })
  })

  it('refuses every other automatic writer — the safety owners the bids check lets through included — naming the lever', async () => {
    for (const actor of ['automation:retail-guard', 'automation:budget-manager-cron', 'automation:budget-enforce', 'automation:auto-undo', 'automation:auto-bid', 'automation:rule-abc', 'automation:rank-defend-s1', 'user:owner']) {
      const r = await strategy(actor)
      expect(r, actor).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
      expect((r as { reason: string }).reason, actor).toMatch(new RegExp(`one writer per lever\\): ${actor} may not change its bidding strategy`))
    }
    // A forced write is no lowering for a strategy: the mark never opens this lever.
    expect(await strategy('automation:retail-guard', { isSuppression: true })).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
  })

  it('lets the repairs that resend Nexus\'s own value through', async () => {
    for (const actor of BRAIN_STRATEGY_REPAIR_PREFIXES) expect(await strategy(actor), actor).toMatchObject({ allowed: true })
  })

  it('judges a campaign the brain does not own, and a shadow ceiling, exactly as before', async () => {
    enrollmentFindMany.mockResolvedValue([])
    expect(await strategy('automation:retail-guard')).toMatchObject({ allowed: true })
    enrollmentFindMany.mockReset().mockResolvedValue([{ campaignId: 'c1' }])
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    expect(await strategy('automation:retail-guard')).toMatchObject({ allowed: true })
    expect(await strategy('automation:auto-bid')).toMatchObject({ allowed: true })
    expect(enrollmentFindMany).not.toHaveBeenCalled()
  })

  it('fails closed when the enrollment cannot be read', async () => {
    enrollmentFindMany.mockRejectedValue(new Error('db down'))
    const r = await strategy('automation:retail-guard')
    expect(r).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
    expect((r as { reason: string }).reason).toMatch(/an automatic change to its bidding strategy waits/)
  })

  it('brainYieldsStrategyTo (pure): the brain, a person, a repair exactly or with its suffix — never a safety owner', () => {
    expect(brainYieldsStrategyTo({ actor: 'automation:bid-brain' })).toBe(true)
    expect(brainYieldsStrategyTo({ actor: 'user:owner', manual: true })).toBe(true)
    expect(brainYieldsStrategyTo({ actor: 'automation:reconcile-sweep' })).toBe(true)
    expect(brainYieldsStrategyTo({ actor: 'automation:reconciler' })).toBe(false)
    expect(brainYieldsStrategyTo({ actor: 'automation:budget-manager' })).toBe(false)
    expect(brainYieldsStrategyTo({ actor: 'automation:bid-brain-x' })).toBe(false)
  })
})

describe('brainYieldsTo (pure)', () => {
  it('matches a safety prefix exactly or with its own suffix, never a look-alike', () => {
    expect(brainYieldsTo({ actor: 'automation:retail-guard-cron' })).toBe(true)
    expect(brainYieldsTo({ actor: 'automation:retail-guardian' })).toBe(false)
    expect(brainYieldsTo({ actor: 'automation:auto-bid' })).toBe(false)
    expect(brainYieldsTo({ actor: 'user:owner' })).toBe(false)
    expect(brainYieldsTo({ actor: 'user:owner', manual: true })).toBe(true)
    expect(BRAIN_SAFETY_ACTOR_PREFIXES.every((p) => p.startsWith('automation:'))).toBe(true)
  })
})

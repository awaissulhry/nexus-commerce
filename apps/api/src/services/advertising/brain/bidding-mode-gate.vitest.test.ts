/**
 * ONE BRAIN AB-17 — the brain's bidding-strategy writer at the write gate. BRAIN_STRATEGY_ACTOR lands only on a campaign whose
 * biddingStrategy lever a product's brain owns (brain/lever-owners.ts, mocked here: the real resolver has its own tests and
 * the real-PostgreSQL suite bidding-mode-postgres), under the live ceiling, never while a stop holds the campaign, and for
 * the strategy only; on a campaign the bid brain runs (BB-6, AB-2) it passes the strategy check as the brain. Every other
 * writer is judged exactly as before. The anomaly breaker names it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrainLever } from './levers.js'
import type { CampaignLeverOwners, LeverHold } from './lever-owners.js'

const campaignFindUnique = vi.fn()
const bidBrainFindMany = vi.fn(async () => [] as Array<{ campaignId: string }>)
vi.mock('../../../db.js', () => ({
  default: {
    campaign: { get findUnique() { return campaignFindUnique }, findMany: vi.fn(async () => []) },
    bidBrainEnrollment: { get findMany() { return bidBrainFindMany } },
    adKeywordProtection: { findMany: vi.fn(async () => []) },
    adSpendCeiling: { findMany: vi.fn(async () => []) },
    adBidPolicy: { findMany: vi.fn(async () => []) },
    advertisingActionLog: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), count: vi.fn(async () => 0) },
    adProductAd: { findMany: vi.fn(async () => []) },
    adWriteRefusal: { create: vi.fn(async () => ({})) },
    adsStrategy: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    adsBrainOverride: { findMany: vi.fn(async () => []) },
  },
}))
vi.mock('../ads-api-client.js', () => ({ adsMode: () => 'live' }))
vi.mock('../ads-profile-resolver.js', () => ({ adsProfileFor: vi.fn(async () => ({ profileId: 'p1', mode: 'production', writesEnabledAt: new Date() })) }))
vi.mock('../../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('../ads-automation-state.service.js', () => ({ getAutomationState: vi.fn(async () => ({ autonomy: 'AUTO', halted: false, haltReason: null, effectivelyStopped: false, degraded: false })) }))
const campaignLeverOwners = vi.fn()
vi.mock('./lever-owners.js', () => ({ campaignLeverOwners, portfolioCapHold: vi.fn(async () => null) }))

const { checkAdsWriteGate, brainKillLevers, brainYieldsStrategyTo, BRAIN_STRATEGY_ACTOR, leverWriterOf, PRODUCT_BRAIN_ACTOR } = await import('../ads-write-gate.js')
const { BRAIN_ACTOR } = await import('../bid-brain/live.js')
const { classifyActor, engineCaps, engineLabel } = await import('../ads-engine-actors.js')

const ROW = {
  liveBidWritesEnabled: true, dynamicBidding: null, liveBidWritesToday: 0, liveBidWritesDay: null,
  minBidCents: null, maxBidCents: null, pinPlacement: false, pinBids: false, pinBudget: false, pinNote: null,
  dailyBudget: 5, portfolioId: null, marketplace: 'IT', minBudgetCents: null, maxBudgetCents: null,
  adProduct: 'SPONSORED_PRODUCTS', type: 'SP', name: 'Jacket exact', costType: null, budgetJson: null,
  bidsSuppressedAt: null, suppressedFromBiddingStrategy: null,
}
const owned: LeverHold = { kind: 'owned', productId: 'jacket', market: 'IT', why: 'AUTO by the Owner\'s product override (user:owner, 2026-10-08)' }
const locked: LeverHold = { kind: 'locked', productId: 'jacket', market: 'IT', why: 'locked by the Owner\'s campaign override (user:owner, 2026-10-08) ("my own strategy")' }
function holds(levers: Partial<Record<BrainLever, LeverHold>>) {
  const map = new Map<string, CampaignLeverOwners>()
  if (Object.keys(levers).length) map.set('c1', { campaignId: 'c1', name: 'Jacket exact', market: 'IT', levers })
  campaignLeverOwners.mockResolvedValue(map)
}
const strategy = (actor: string, extra: Record<string, unknown> = {}) =>
  checkAdsWriteGate({ marketplace: 'IT', campaignId: 'c1', field: 'biddingStrategy', fields: ['biddingStrategy'], payloadValueCents: 0, actor, ...extra } as never)

beforeEach(() => {
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  campaignFindUnique.mockReset().mockResolvedValue(ROW)
  bidBrainFindMany.mockReset().mockResolvedValue([])
  campaignLeverOwners.mockReset()
  holds({})
})
afterEach(() => vi.unstubAllEnvs())

describe('AB-17 — the brain\'s bidding-strategy writer at the write gate', () => {
  it('is the brain\'s own actor family; the kill switch can stop it; it is the brain on the bid brain\'s strategy check', () => {
    expect(BRAIN_STRATEGY_ACTOR).toBe(`${PRODUCT_BRAIN_ACTOR}-strategy`)
    expect(brainKillLevers(['biddingStrategy'], { actor: BRAIN_STRATEGY_ACTOR })).toEqual(['biddingStrategy'])
    expect(brainYieldsStrategyTo({ actor: BRAIN_STRATEGY_ACTOR })).toBe(true)
    expect(brainYieldsStrategyTo({ actor: 'automation:rule-abc' })).toBe(false)
    // It obeys the Owner's locks itself on the AB-5 check (the strategy lever); its own backstop refuses a lock.
    expect(leverWriterOf('biddingStrategy', { actor: BRAIN_STRATEGY_ACTOR })).toBe('passes')
  })

  it('an owned biddingStrategy lever lets it through — also on a campaign the bid brain runs LIVE (the stop recipe\'s campaign)', async () => {
    holds({ biddingStrategy: owned })
    expect(await strategy(BRAIN_STRATEGY_ACTOR)).toMatchObject({ allowed: true, mode: 'live' })
    bidBrainFindMany.mockResolvedValue([{ campaignId: 'c1' }])
    expect(await strategy(BRAIN_STRATEGY_ACTOR)).toMatchObject({ allowed: true })
    // Another engine there is refused by the bid brain's strategy check, as before.
    expect(await strategy('automation:rule-abc')).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
    expect(await strategy(BRAIN_ACTOR)).toMatchObject({ allowed: true })
  })

  it('nothing holding the lever (OBSERVE, OFF, excluded, shared, nothing enrolled), another lever owned, or the Owner\'s lock: refused, nothing changed', async () => {
    for (const levers of [{}, { budgets: owned }, { state: owned }] as Array<Partial<Record<BrainLever, LeverHold>>>) {
      holds(levers)
      const r = await strategy(BRAIN_STRATEGY_ACTOR)
      expect(r, JSON.stringify(levers)).toMatchObject({ allowed: false, deniedAt: 'brain_not_owner' })
      expect((r as { reason: string }).reason).toMatch(/^automation:ads-brain-strategy writes only a lever the brain owns: the bidding strategy of campaign "Jacket exact" \(c1\) is not the brain's — no enrolled product's brain holds it at PROPOSE or AUTO there\. Nothing was changed\.$/)
    }
    holds({ biddingStrategy: locked })
    const r = await strategy(BRAIN_STRATEGY_ACTOR)
    expect(r).toMatchObject({ allowed: false, deniedAt: 'brain_not_owner' })
    expect((r as { reason: string }).reason).toMatch(/the Owner locked it \(locked by the Owner's campaign override .*"my own strategy"/)
  })

  it('a shadow ceiling refuses it', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    holds({ biddingStrategy: owned })
    const r = await strategy(BRAIN_STRATEGY_ACTOR)
    expect(r).toMatchObject({ allowed: false, deniedAt: 'brain_not_owner' })
    expect((r as { reason: string }).reason).toMatch(/NEXUS_BID_BRAIN_MODE is not live/)
  })

  it('never while a stop holds the campaign: the stop recipe\'s saved strategy, or a stop\'s floor', async () => {
    holds({ biddingStrategy: owned })
    for (const stop of [{ suppressedFromBiddingStrategy: 'AUTO_FOR_SALES' }, { bidsSuppressedAt: new Date('2026-10-08T10:00:00Z') }]) {
      campaignFindUnique.mockResolvedValue({ ...ROW, ...stop })
      const r = await strategy(BRAIN_STRATEGY_ACTOR)
      expect(r, JSON.stringify(stop)).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
      expect((r as { reason: string }).reason).toMatch(/a stop holds campaign "Jacket exact" \(c1\): its bidding strategy is the stop recipe's until the stop ends/)
    }
    // The stop recipe itself and a person still pass.
    campaignFindUnique.mockResolvedValue({ ...ROW, suppressedFromBiddingStrategy: 'AUTO_FOR_SALES' })
    expect(await strategy(BRAIN_ACTOR)).toMatchObject({ allowed: true })
    expect(await strategy('user:owner', { manual: true })).toMatchObject({ allowed: true })
  })

  it('the strategy only: a budget under its name is refused even where the budgets lever is the brain\'s', async () => {
    holds({ biddingStrategy: owned, budgets: owned })
    const r = await checkAdsWriteGate({ marketplace: 'IT', campaignId: 'c1', field: 'dailyBudget', fields: ['dailyBudget'], payloadValueCents: 600, intendedValueCents: 600, previousValueCents: 500, actor: BRAIN_STRATEGY_ACTOR } as never)
    expect(r).toMatchObject({ allowed: false, deniedAt: 'brain_not_owner' })
    expect((r as { reason: string }).reason).toMatch(/writes a campaign's bidding strategy only, not dailyBudget/)
  })

  it('every other writer as before: a rule refused on an owned lever, a person passes, the bids pin refuses it, the allowlist binds it', async () => {
    holds({ biddingStrategy: owned })
    expect(await strategy('automation:rule-abc')).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
    expect(await strategy('user:owner', { manual: true })).toMatchObject({ allowed: true })
    campaignFindUnique.mockResolvedValue({ ...ROW, pinBids: true })
    expect(await strategy(BRAIN_STRATEGY_ACTOR)).toMatchObject({ allowed: false, deniedAt: 'authority_pin' })
    campaignFindUnique.mockResolvedValue({ ...ROW, liveBidWritesEnabled: false })
    expect(await strategy(BRAIN_STRATEGY_ACTOR)).toMatchObject({ allowed: false, deniedAt: 'campaign_allowlist' })
  })
})

describe('AB-17 — the anomaly breaker names the bidding-strategy writer', () => {
  it('the engine "Brain bidding strategy" with caps of its own, never "no known author"', () => {
    expect(classifyActor(BRAIN_STRATEGY_ACTOR)).toEqual({ kind: 'engine', engine: 'brain-strategy' })
    expect(engineLabel('brain-strategy')).toBe('Brain bidding strategy')
    expect(engineCaps('brain-strategy')).toEqual({ perTick: 50, perDay: 50, breakerPerHour: 20 })
  })
})

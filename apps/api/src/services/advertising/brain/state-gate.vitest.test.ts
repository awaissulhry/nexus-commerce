/**
 * ONE BRAIN AB-12 — the brain's own pause and resume at the write gate and in the mutation layer. The brain's state
 * writer (BRAIN_STATE_ACTOR) lands only on a campaign whose state lever a product's brain owns (brain/lever-owners.ts,
 * mocked here: the real resolver has its own tests and the real-PostgreSQL suite state-postgres), under the live ceiling;
 * the Owner's lock refuses it in his words; anywhere else it is refused. Every other writer is judged exactly as AB-5
 * judged it. The mutation layer lets the brain's pause past 1f only as its state writer, asking the gate first, under the
 * live ceiling — and it asks for the status only, PAUSED or ENABLED (an archive is only ever a proposal).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrainLever } from './levers.js'
import type { CampaignLeverOwners, LeverHold } from './lever-owners.js'

const campaignFindUnique = vi.fn()
vi.mock('../../../db.js', () => ({
  default: {
    campaign: { get findUnique() { return campaignFindUnique }, findMany: vi.fn(async () => []) },
    bidBrainEnrollment: { findMany: vi.fn(async () => []) },
    adKeywordProtection: { findMany: vi.fn(async () => []) },
    adSpendCeiling: { findMany: vi.fn(async () => []) },
    adBidPolicy: { findMany: vi.fn(async () => []) },
    advertisingActionLog: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), count: vi.fn(async () => 0) },
    adProductAd: { findMany: vi.fn(async () => []) },
    adWriteRefusal: { create: vi.fn(async () => ({})) },
    adsStrategy: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    // AB-15 — the kill switches the gate reads for the brain's own actors: none open here.
    adsBrainOverride: { findMany: vi.fn(async () => []) },
  },
}))
vi.mock('../ads-api-client.js', () => ({ adsMode: () => 'live' }))
vi.mock('../ads-profile-resolver.js', () => ({ adsProfileFor: vi.fn(async () => ({ profileId: 'p1', mode: 'production', writesEnabledAt: new Date() })) }))
vi.mock('../../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('../ads-automation-state.service.js', () => ({ getAutomationState: vi.fn(async () => ({ autonomy: 'AUTO', halted: false, haltReason: null, effectivelyStopped: false, degraded: false })) }))
const campaignLeverOwners = vi.fn()
vi.mock('./lever-owners.js', () => ({ campaignLeverOwners, portfolioCapHold: vi.fn(async () => null) }))

const { checkAdsWriteGate, BRAIN_STATE_ACTOR, PRODUCT_BRAIN_ACTOR } = await import('../ads-write-gate.js')
const { isBrainStatePause, brainStatePatchRefusal, isAutomatedPause } = await import('../ads-mutation.service.js')
const { classifyActor, engineCaps, engineLabel } = await import('../ads-engine-actors.js')

const ROW = {
  liveBidWritesEnabled: true, dynamicBidding: null, liveBidWritesToday: 0, liveBidWritesDay: null,
  minBidCents: null, maxBidCents: null, pinPlacement: false, pinBids: false, pinBudget: false, pinNote: null,
  dailyBudget: 5, portfolioId: null, marketplace: 'IT', minBudgetCents: null, maxBudgetCents: null,
  adProduct: 'SPONSORED_PRODUCTS', type: 'SP', name: 'Jacket exact', costType: null, budgetJson: null,
}
const owned: LeverHold = { kind: 'owned', productId: 'jacket', market: 'IT', why: 'AUTO by the Owner\'s product override (user:owner, 2026-10-08)' }
const locked: LeverHold = { kind: 'locked', productId: 'jacket', market: 'IT', why: 'locked by the Owner\'s campaign override (user:owner, 2026-10-08) ("my own state")' }
function holds(levers: Partial<Record<BrainLever, LeverHold>>) {
  const map = new Map<string, CampaignLeverOwners>()
  if (Object.keys(levers).length) map.set('c1', { campaignId: 'c1', name: 'Jacket exact', market: 'IT', levers })
  campaignLeverOwners.mockResolvedValue(map)
}
const state = (actor: string, extra: Record<string, unknown> = {}) =>
  checkAdsWriteGate({ marketplace: 'IT', campaignId: 'c1', field: 'status', fields: ['status'], payloadValueCents: 0, actor, ...extra } as never)

beforeEach(() => {
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  campaignFindUnique.mockReset().mockResolvedValue(ROW)
  campaignLeverOwners.mockReset()
  holds({})
})
afterEach(() => vi.unstubAllEnvs())

describe('AB-12 — the brain\'s state writer at the write gate', () => {
  it('is the brain\'s own actor family', () => {
    expect(BRAIN_STATE_ACTOR).toBe(`${PRODUCT_BRAIN_ACTOR}-state`)
  })

  it('an owned state lever lets it through (enable or pause)', async () => {
    holds({ state: owned })
    expect(await state(BRAIN_STATE_ACTOR)).toMatchObject({ allowed: true, mode: 'live' })
  })

  it('the Owner\'s lock refuses it in his words — the brain included', async () => {
    holds({ state: locked })
    const r = await state(BRAIN_STATE_ACTOR)
    expect(r).toMatchObject({ allowed: false, deniedAt: 'owner_locked' })
    expect((r as { reason: string }).reason).toMatch(/the Owner holds the state \(pause, enable, archive\) of campaign "Jacket exact" \(c1\) at his own value .* — the brain included/)
  })

  it('nothing holding the state lever (OBSERVE, OFF, excluded, shared, nothing enrolled), or another lever owned: refused, nothing changed', async () => {
    for (const levers of [{}, { budgets: owned }, { negatives: locked }] as Array<Partial<Record<BrainLever, LeverHold>>>) {
      holds(levers)
      const r = await state(BRAIN_STATE_ACTOR)
      expect(r, JSON.stringify(levers)).toMatchObject({ allowed: false, deniedAt: 'brain_not_owner' })
      expect((r as { reason: string }).reason).toMatch(/^no product's brain owns the state \(pause, enable, archive\) of campaign "Jacket exact" \(c1\): the brain pauses and resumes only a campaign whose state lever it owns .* Nothing was changed\.$/)
    }
  })

  it('a shadow ceiling refuses it without reading who holds the lever', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    holds({ state: owned })
    const r = await state(BRAIN_STATE_ACTOR)
    expect(r).toMatchObject({ allowed: false, deniedAt: 'brain_not_owner' })
    expect((r as { reason: string }).reason).toMatch(/only while the brain's server switch is live \(NEXUS_BID_BRAIN_MODE=live\)/)
    expect(campaignLeverOwners).not.toHaveBeenCalled()
  })

  it('holders that cannot be read: the gate fails with the read\'s error (the worker sends the row again later), never a pass', async () => {
    campaignLeverOwners.mockRejectedValue(new Error('db down'))
    await expect(state(BRAIN_STATE_ACTOR)).rejects.toThrow('db down')
  })

  it('every other writer is judged as AB-5 judged it: a rule refused on an owned state, free on an unheld one; the bare brain actor and a person pass', async () => {
    holds({ state: owned })
    expect(await state('automation:rule-abc')).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
    expect(await state(PRODUCT_BRAIN_ACTOR)).toMatchObject({ allowed: true })
    expect(await state('user:owner', { manual: true })).toMatchObject({ allowed: true })
    holds({})
    expect(await state('automation:rule-abc')).toMatchObject({ allowed: true })
    expect(await state(PRODUCT_BRAIN_ACTOR)).toMatchObject({ allowed: true })
  })

  it('the campaign must still be on the live-write allowlist', async () => {
    holds({ state: owned })
    campaignFindUnique.mockResolvedValue({ ...ROW, liveBidWritesEnabled: false })
    expect(await state(BRAIN_STATE_ACTOR)).toMatchObject({ allowed: false, deniedAt: 'campaign_allowlist' })
  })
})

describe('AB-12 — the mutation layer: the one exception to "no automation pauses a campaign"', () => {
  it('only the brain\'s state writer, asking the gate first, under the live ceiling', () => {
    expect(isAutomatedPause(BRAIN_STATE_ACTOR, 'PAUSED')).toBe(true) // still an automation's pause: the exception is apart
    expect(isBrainStatePause({ actor: BRAIN_STATE_ACTOR, askGate: true })).toBe(true)
    expect(isBrainStatePause({ actor: BRAIN_STATE_ACTOR })).toBe(false)
    expect(isBrainStatePause({ actor: PRODUCT_BRAIN_ACTOR, askGate: true })).toBe(false)
    expect(isBrainStatePause({ actor: 'automation:rule-abc', askGate: true })).toBe(false)
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    expect(isBrainStatePause({ actor: BRAIN_STATE_ACTOR, askGate: true })).toBe(false)
  })

  it('the brain\'s state writer asks for the status only, PAUSED or ENABLED — never an archive, never another field', () => {
    expect(brainStatePatchRefusal(BRAIN_STATE_ACTOR, { status: 'PAUSED' })).toBeNull()
    expect(brainStatePatchRefusal(BRAIN_STATE_ACTOR, { status: 'ENABLED', dailyBudget: undefined })).toBeNull()
    expect(brainStatePatchRefusal(BRAIN_STATE_ACTOR, { status: 'ARCHIVED' })).toBe('brain_state_never_archives')
    expect(brainStatePatchRefusal(BRAIN_STATE_ACTOR, { status: 'PAUSED', dailyBudget: 20 })).toBe('brain_state_writes_status_only')
    expect(brainStatePatchRefusal(BRAIN_STATE_ACTOR, { biddingStrategy: 'MANUAL' })).toBe('brain_state_writes_status_only')
    expect(brainStatePatchRefusal('automation:rule-abc', { status: 'ARCHIVED' })).toBeNull()
  })
})

describe('AB-12 — the anomaly breaker names the brain\'s writers (never "no known author")', () => {
  it('the state writer is the engine "Brain pauses" with caps of its own; the money writer stays "Brain budgets"', () => {
    expect(classifyActor(BRAIN_STATE_ACTOR)).toEqual({ kind: 'engine', engine: 'brain-state' })
    expect(engineLabel('brain-state')).toBe('Brain pauses')
    expect(engineCaps('brain-state')).toEqual({ perTick: 50, perDay: 100, breakerPerHour: 50 })
    for (const actor of ['automation:ads-brain-budgets', 'automation:ads-brain-portfolio']) expect(classifyActor(actor), actor).toEqual({ kind: 'engine', engine: 'brain-money' })
  })
})

/**
 * ONE BRAIN AB-6 — an AUTO autopilot plan leaves a budget or a placement a product's brain owns (or the Owner holds):
 *   held      the decision is recorded SKIPPED with why, never asked (no write, no gate call); the campaign's other
 *             decisions run; every decision of a campaign held → the campaign is not even asked at the gate
 *   batched   the run's one read is handed in (leverHolds); without it applyPlanActions reads once itself
 *   today     nothing enrolled: every decision applied as before
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  gate: vi.fn(),
  update: vi.fn(),
  placement: vi.fn(),
  campaignLeverOwners: vi.fn(),
  anyBrainEnrolled: vi.fn(),
}))
vi.mock('../../../db.js', () => ({ default: { campaign: { findUnique: vi.fn(async () => ({ dynamicBidding: { placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 20 }] } })) } } }))
vi.mock('../ads-write-gate.js', async (importOriginal) => ({ ...(await importOriginal<object>()), checkAdsWriteGate: h.gate }))
vi.mock('../ads-mutation.service.js', () => ({ updateCampaignWithSync: h.update }))
vi.mock('../ads-top-of-search.service.js', () => ({ setSearchPlacement: h.placement }))
vi.mock('../ads-bid-optimizer.service.js', () => ({ previewBidOptimization: vi.fn(), applyBidOptimization: vi.fn(), holdToStrategy: (x: unknown) => x }))
vi.mock('../bid-brain/live.js', () => ({
  BRAIN_ACTOR: 'automation:bid-brain',
  brainLiveCeiling: () => (process.env.NEXUS_BID_BRAIN_MODE ?? '').trim().toLowerCase() === 'live',
  brainOwnedCampaignIds: vi.fn(async () => new Set()),
}))
vi.mock('../brain/lever-owners.js', () => ({
  campaignLeverOwners: (...a: unknown[]) => h.campaignLeverOwners(...a),
  anyBrainEnrolled: (...a: unknown[]) => h.anyBrainEnrolled(...a),
}))

const { applyPlanActions, autopilotActionLever } = await import('./apply.js')
const { readLeverHolds } = await import('../brain/engine-skips.js')

const OWNED = { kind: 'owned', productId: 'gale', market: 'IT', why: 'AUTO by the Owner\'s product override' }
const ACTIONS = [
  { module: 'budget', campaignId: 'c-gale', action: 'BUDGET_UP', beforeCents: 1000, afterCents: 1300, reason: 'Out of budget & ACoS ok', priority: 50 },
  { module: 'placement', campaignId: 'c-gale', action: 'PLACEMENT', before: {}, after: { raiseTosPct: 10 }, reason: 'ToS IS low', priority: 40 },
  { module: 'budget', campaignId: 'c-misano', action: 'BUDGET_UP', beforeCents: 1000, afterCents: 1300, reason: 'Out of budget & ACoS ok', priority: 50 },
]
const GUARDRAILS = { bidMinCents: 5, bidMaxCents: 300, targetAcosPct: 30 } as never
const apply = (extra: Record<string, unknown> = {}) => applyPlanActions({ planId: 'plan-1', goal: 'BALANCED' as never, marketplace: 'IT', guardrails: GUARDRAILS, actions: ACTIONS as never, signals: [], ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  h.anyBrainEnrolled.mockResolvedValue(true)
  h.campaignLeverOwners.mockResolvedValue(new Map())
  h.gate.mockResolvedValue({ allowed: true, mode: 'live' })
  h.update.mockResolvedValue({ ok: true, outboundQueueId: 'q1', actionLogId: 'l1' })
  h.placement.mockResolvedValue({})
})
afterEach(() => vi.unstubAllEnvs())

describe('autopilotActionLever (pure)', () => {
  it('a budget is the budgets lever, a Top-of-Search nudge the placements lever; bids stay BB-6\'s', () => {
    expect(autopilotActionLever('budget')).toBe('budgets')
    expect(autopilotActionLever('placement')).toBe('placements')
    expect(autopilotActionLever('bid')).toBeNull()
  })
})

describe('AB-6 — applyPlanActions', () => {
  it('a held budget is SKIPPED with why and never written; the campaign\'s placement and another campaign run', async () => {
    h.campaignLeverOwners.mockResolvedValue(new Map([['c-gale', { campaignId: 'c-gale', name: 'GALE', market: 'IT', levers: { budgets: OWNED } }]]))
    const r = await apply()
    expect(h.update).toHaveBeenCalledTimes(1)
    expect(h.update.mock.calls[0][0]).toMatchObject({ campaignId: 'c-misano' })
    expect(h.placement).toHaveBeenCalledTimes(1)
    expect(r.decisions).toContainEqual(expect.objectContaining({
      module: 'budget', campaignId: 'c-gale', status: 'SKIPPED',
      reason: 'Out of budget & ACoS ok — left alone: a product\'s brain runs the daily budget of campaign "GALE" (c-gale) — product gale in IT (one owner per lever)',
    }))
  })

  it('every decision of a campaign held: it is not even asked at the gate', async () => {
    h.campaignLeverOwners.mockResolvedValue(new Map([['c-gale', { campaignId: 'c-gale', name: 'GALE', market: 'IT', levers: { budgets: OWNED, placements: { ...OWNED, kind: 'locked' } } }]]))
    const r = await apply()
    expect(h.gate).toHaveBeenCalledTimes(1)
    expect(h.gate.mock.calls[0][0]).toMatchObject({ campaignId: 'c-misano' })
    expect(r.decisions.filter((d) => d.status === 'SKIPPED' && d.campaignId === 'c-gale')).toHaveLength(2)
  })

  it('the run\'s one read is used when handed in, and it counts the skips', async () => {
    h.campaignLeverOwners.mockResolvedValue(new Map([['c-gale', { campaignId: 'c-gale', name: 'GALE', market: 'IT', levers: { budgets: OWNED } }]]))
    const leverHolds = await readLeverHolds(['c-gale', 'c-misano'], { actor: 'automation:autopilot-plan-1' }, 'test')
    h.campaignLeverOwners.mockClear()
    await apply({ leverHolds })
    expect(h.campaignLeverOwners).not.toHaveBeenCalled()
    expect(leverHolds.counts()).toEqual({ budgets: 1 })
  })

  it('nothing enrolled (production today): every decision applied as before', async () => {
    h.anyBrainEnrolled.mockResolvedValue(false)
    const r = await apply()
    expect(h.update).toHaveBeenCalledTimes(2)
    expect(h.placement).toHaveBeenCalledTimes(1)
    expect(r.decisions.every((d) => d.status === 'APPLIED')).toBe(true)
  })
})

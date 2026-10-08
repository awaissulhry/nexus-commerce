/**
 * ONE BRAIN AB-6 — an autopilot plan under SUGGEST never proposes a budget or a placement a product's brain owns (or the
 * Owner holds); an AUTO plan records it SKIPPED (apply-brain-levers.vitest.test.ts). One read per plan; the line counts
 * the skips per lever; nothing enrolled: every proposal as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ plans: vi.fn(), created: vi.fn(), conductor: vi.fn(), campaignLeverOwners: vi.fn(), anyBrainEnrolled: vi.fn() }))
vi.mock('../db.js', () => ({
  default: {
    autopilotPlan: { findMany: h.plans, update: vi.fn(async () => ({})) },
    autopilotDecision: { deleteMany: vi.fn(async () => ({ count: 0 })), findMany: vi.fn(async () => []), createMany: h.created },
  },
}))
vi.mock('../services/advertising/autopilot/conductor.js', () => ({ runConductorCycle: h.conductor }))
vi.mock('../services/advertising/autopilot/coordination.js', () => ({ syncLinkedRules: vi.fn(async () => []), mirrorRuleDecisions: vi.fn(async () => {}) }))
vi.mock('../services/advertising/ads-suggestions.service.js', () => ({ mutedKeys: vi.fn(async () => new Set()) }))
vi.mock('../services/advertising/ads-strategy/bids.js', async (importOriginal) => ({ ...(await importOriginal<object>()), bidLimitsByCampaign: vi.fn(async () => new Map()) }))
vi.mock('../services/advertising/ads-engine-guard.js', () => ({
  openEngineGuard: async () => ({ posture: 'suggest', permit: () => ({ forward: false }), settle: () => {}, report: () => undefined }),
  allowChange: () => false, nothingHeld: () => ({}), engineGuardNote: () => '',
}))
vi.mock('../services/advertising/brain/lever-owners.js', () => ({
  campaignLeverOwners: (...a: unknown[]) => h.campaignLeverOwners(...a),
  anyBrainEnrolled: (...a: unknown[]) => h.anyBrainEnrolled(...a),
}))

const { runAutopilotOnce, autopilotSummaryLine } = await import('./ad-autopilot.job.js')

const OWNED = { kind: 'owned', productId: 'gale', market: 'IT', why: 'AUTO by the Owner\'s product override' }
const ACTIONS = [
  { module: 'budget', campaignId: 'c-gale', action: 'BUDGET_UP', beforeCents: 1000, afterCents: 1300, reason: 'Out of budget', priority: 50 },
  { module: 'bid', campaignId: 'c-gale', action: 'BID_RAISE', beforeCents: 40, afterCents: 44, reason: 'ACoS under target', priority: 60 },
  { module: 'budget', campaignId: 'c-misano', action: 'BUDGET_UP', beforeCents: 1000, afterCents: 1300, reason: 'Out of budget', priority: 50 },
]
const proposed = () => ((h.created.mock.calls[0]?.[0] as { data: Array<{ module: string; campaignId: string }> } | undefined)?.data ?? []).map((d) => `${d.module}:${d.campaignId}`)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  h.plans.mockResolvedValue([{ id: 'plan-1', goal: 'BALANCED', marketplace: 'IT', autonomy: 'SUGGEST', campaignIds: [], guardrails: {}, modules: {} }])
  h.conductor.mockReturnValue({ actions: ACTIONS })
  h.anyBrainEnrolled.mockResolvedValue(true)
  h.campaignLeverOwners.mockResolvedValue(new Map())
})
afterEach(() => vi.unstubAllEnvs())

describe('AB-6 — autopilot under SUGGEST', () => {
  it('a held budget is not proposed; the campaign\'s bid and the other campaign\'s budget are; counted in the line', async () => {
    h.campaignLeverOwners.mockResolvedValue(new Map([['c-gale', { campaignId: 'c-gale', name: 'GALE', market: 'IT', levers: { budgets: OWNED } }]]))
    const r = await runAutopilotOnce()
    expect(proposed()).toEqual(['bid:c-gale', 'budget:c-misano'])
    expect(h.campaignLeverOwners).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ decisions: 2, leverHeld: { productBrain: { budgets: 1 } } })
    expect(autopilotSummaryLine(r)).toBe('plans=1 decisions=2 brain-levers=a product\'s brain: budgets 1 (one owner per lever)')
  })

  it('nothing enrolled (production today): every proposal as before, the line unchanged', async () => {
    h.anyBrainEnrolled.mockResolvedValue(false)
    const r = await runAutopilotOnce()
    expect(proposed()).toEqual(['budget:c-gale', 'bid:c-gale', 'budget:c-misano'])
    expect(autopilotSummaryLine(r)).toBe('plans=1 decisions=3')
  })
})

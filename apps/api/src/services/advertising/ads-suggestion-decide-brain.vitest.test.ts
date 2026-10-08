/**
 * ONE BRAIN AB-6 — approving a rule's card on a lever a product's brain now owns: the approved write is the rule's (its own
 * actor), which the write gate refuses there, so it is left before it is asked. The card keeps waiting with the reason —
 * never "applied" with nothing behind it. Nothing owned: the card applies as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  suggestion: vi.fn(), suggestionUpdate: vi.fn(), handler: vi.fn(), campaignLeverOwners: vi.fn(),
  handlers: {} as Record<string, unknown>,
}))
vi.mock('../../db.js', () => ({
  default: {
    adsRuleSuggestion: { findUnique: h.suggestion, update: h.suggestionUpdate },
    automationRuleExecution: { findUnique: vi.fn(async () => ({ triggerData: { trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', campaign: { id: 'c-gale' } } })) },
    automationRule: { findUnique: vi.fn(async () => ({ id: 'rule-b', name: 'Raise budgets', domain: 'advertising', enabled: true, dryRun: true, autonomyLevel: 'PROPOSE' })) },
    advertisingActionLog: { findMany: vi.fn(async () => []) },
  },
}))
vi.mock('./ads-automation-state.service.js', () => ({ isAutomationHalted: vi.fn(async () => false) }))
vi.mock('./automation-action-handlers.js', () => ({}))
vi.mock('../automation-rule.service.js', () => ({ ACTION_HANDLERS: h.handlers }))
vi.mock('./bid-brain/rule-directives.js', () => ({
  ruleBrainInput: vi.fn(async () => null),
  directiveCampaignId: async (action: Record<string, unknown>, context: { campaign?: { id?: string } } | null) => (action.campaignId as string | undefined) ?? context?.campaign?.id ?? null,
}))
vi.mock('./brain/lever-owners.js', () => ({
  campaignLeverOwners: (...a: unknown[]) => h.campaignLeverOwners(...a),
  anyBrainEnrolled: vi.fn(async () => true),
}))

const { applySuggestion } = await import('./ads-suggestion-decide.service.js')

const OWNED = { kind: 'owned', productId: 'gale', market: 'IT', why: 'AUTO by the Owner\'s product override' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  h.handlers.adjust_ad_budget = h.handler
  h.handler.mockResolvedValue({ type: 'adjust_ad_budget', ok: true, output: { campaignId: 'c-gale', newDailyBudget: 24 } })
  h.suggestion.mockResolvedValue({ id: 's1', status: 'pending', ruleId: 'rule-b', ruleName: 'Raise budgets', lastSeenAt: new Date(), executionId: 'e1', proposedAction: { type: 'adjust_ad_budget', percent: 20 } })
  h.campaignLeverOwners.mockResolvedValue(new Map())
})
afterEach(() => vi.unstubAllEnvs())

describe('AB-6 — approving a card on a lever a product\'s brain owns', () => {
  it('nothing is written; the card keeps waiting and says why', async () => {
    h.campaignLeverOwners.mockResolvedValue(new Map([['c-gale', { campaignId: 'c-gale', name: 'GALE exact', market: 'IT', levers: { budgets: OWNED } }]]))
    const r = await applySuggestion('s1')
    expect(h.handler).not.toHaveBeenCalled()
    expect(h.suggestionUpdate).not.toHaveBeenCalled()
    expect(r).toMatchObject({ ok: false, refused: true, skipped: true })
    expect(r.error).toBe('Skipped — nothing was written, and it stays waiting: left alone: a product\'s brain runs the daily budget of campaign "GALE exact" (c-gale) — product gale in IT (one owner per lever); a person\'s own edit still passes.')
  })

  it('not owned: applied as before', async () => {
    const r = await applySuggestion('s1')
    expect(h.handler).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ ok: true })
    expect(h.suggestionUpdate).toHaveBeenCalledTimes(1)
  })
})

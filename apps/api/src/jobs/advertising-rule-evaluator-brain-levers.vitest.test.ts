/**
 * ONE BRAIN AB-6 — the rule evaluator's pass: who holds the levers of every campaign its contexts name is read once before
 * the contexts run (no N+1), and the writes the rules left to a product's brain are counted per lever for the tick's line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rules: vi.fn(), evalAll: vi.fn(), campaignLeverOwners: vi.fn(), anyBrainEnrolled: vi.fn(), campaigns: vi.fn() }))
vi.mock('../db.js', () => ({ default: { automationRule: { findMany: h.rules }, campaign: { findMany: h.campaigns } } }))
vi.mock('../services/automation-rule.service.js', async (importOriginal) => ({ ...(await importOriginal<object>()), evaluateAllRulesForTrigger: h.evalAll }))
vi.mock('../services/advertising/ads-rule-scope-resolver.js', () => ({ resolveAssignedCampaignIds: vi.fn(async () => new Map()) }))
vi.mock('../services/advertising/automation-action-handlers.js', () => ({}))
vi.mock('../services/advertising/brain/lever-owners.js', () => ({
  campaignLeverOwners: (...a: unknown[]) => h.campaignLeverOwners(...a),
  anyBrainEnrolled: (...a: unknown[]) => h.anyBrainEnrolled(...a),
}))

const { applyMarketplaceScope } = await import('./advertising-rule-evaluator.job.js')

const ctx = (id: string) => ({ trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', marketplace: 'IT', campaign: { id, name: id } })
const skip = (lever: string) => ({ type: 'adjust_ad_budget', ok: true, output: { skipped: 'brain-lever', brainSkip: { lever } } })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  h.rules.mockResolvedValue([{ id: 'rule-b', scopeMarketplace: null, scopePortfolioId: null, scopeCampaignId: null, scopeProductId: null, actions: [{ type: 'adjust_ad_budget' }], lastEvaluatedAt: null }])
  h.anyBrainEnrolled.mockResolvedValue(true)
  h.campaignLeverOwners.mockResolvedValue(new Map())
  h.campaigns.mockResolvedValue([])
})
afterEach(() => vi.unstubAllEnvs())

describe('AB-6 — applyMarketplaceScope', () => {
  it('one read of the holders for the whole pass, before its contexts run; the skips counted per lever', async () => {
    h.evalAll.mockImplementation(async (args: { context: { campaign: { id: string } } }) => [{
      ruleId: 'rule-b', matched: true, status: 'SUCCESS', durationMs: 1,
      actionResults: args.context.campaign.id === 'c-gale' ? [skip('budgets')] : [{ type: 'adjust_ad_budget', ok: true, output: { newDailyBudget: 12 } }],
    }])
    const r = await applyMarketplaceScope('CAMPAIGN_PERFORMANCE_BUDGET', [ctx('c-gale'), ctx('c-misano'), ctx('c-moss')], false)
    expect(h.campaignLeverOwners).toHaveBeenCalledTimes(1)
    expect(new Set(h.campaignLeverOwners.mock.calls[0][0] as string[])).toEqual(new Set(['c-gale', 'c-misano', 'c-moss']))
    expect(h.campaignLeverOwners.mock.invocationCallOrder[0]).toBeLessThan(h.evalAll.mock.invocationCallOrder[0])
    expect(r).toMatchObject({ evaluations: 3, matches: 3, leverHeld: { budgets: 1 } })
  })

  it('nothing enrolled (production today): no holders read, nothing counted, the result as before', async () => {
    h.anyBrainEnrolled.mockResolvedValue(false)
    h.evalAll.mockResolvedValue([{ ruleId: 'rule-b', matched: true, status: 'SUCCESS', durationMs: 1, actionResults: [] }])
    const r = await applyMarketplaceScope('CAMPAIGN_PERFORMANCE_BUDGET', [ctx('c-gale')], false)
    expect(h.campaignLeverOwners).not.toHaveBeenCalled()
    expect(r).toEqual({ evaluations: 1, matches: 1, capped: 0, failed: 0 })
  })
})

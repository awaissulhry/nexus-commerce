/**
 * 1f (review 2.7, run-time half) — the graduation ceiling binds when a rule RUNS, not only when its level is set.
 *
 * `adsRuleLevelRefusal` refuses AUTO for a rule whose actions the ceiling keeps below AUTO (pause_target, negatives,
 * anything unclassified). But a rule can reach AUTO without that check — `PATCH {enabled:true, dryRun:false}`, a row
 * written by an older deploy, actions edited after it graduated — and the engine then acted on `resolveAutonomy`
 * alone. Pinned here: such an execution is DEMOTED to PROPOSE (dry run, and it still proposes), judged on the actions
 * about to run; an AUTO rule whose actions may run unattended still acts (control); other domains are untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const execCreate = vi.fn(async () => ({ id: 'exec-new' }))
const ruleUpdate = vi.fn(async () => ({}))
const ruleFindUnique = vi.fn(async (): Promise<Record<string, unknown>> => ({}))

vi.mock('../../db.js', () => ({
  default: {
    automationRuleExecution: { count: vi.fn(async () => 0), get create() { return execCreate } },
    automationRule: { get update() { return ruleUpdate }, get findUnique() { return ruleFindUnique } },
    advertisingActionLog: { count: vi.fn(async () => 0) },
  },
}))
const genSuggestions = vi.fn(async () => 1)
vi.mock('./ads-suggestions.service.js', () => ({ generateSuggestionsFromExecution: genSuggestions }))
const translate = vi.fn((): unknown => null)
// BUILDER_SLUG_ACTIONS is read by graduationCeiling (ads-graduation.ts) to expand a stored slug.
vi.mock('./ads-rule-adapter.service.js', () => ({ maybeTranslateAdsRule: translate, BUILDER_SLUG_ACTIONS: {} }))
vi.mock('../ads-execution-events.service.js', () => ({ publishAdsExecution: vi.fn() }))
vi.mock('../automation-refusals.service.js', () => ({ recordAutomationRefusal: vi.fn(async () => {}) }))

const { evaluateRule, ACTION_HANDLERS } = await import('../automation-rule.service.js')
const seen: Array<{ type: string; dryRun: boolean }> = []
const spy = async (action: { type: string }, _ctx: unknown, meta: { dryRun: boolean }) => {
  seen.push({ type: action.type, dryRun: meta.dryRun })
  return { type: action.type, ok: true, output: { dryRun: meta.dryRun } }
}
for (const t of ['bid_apply', 'pause_target', 'add_negative_exact', 'mystery_action', 'auto_approve_recommendation']) ACTION_HANDLERS[t] = spy as never

const flush = () => new Promise((r) => setTimeout(r, 0))
const AUTO = (actions: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  id: 'rule-1', name: 'TEST ceiling rule', domain: 'advertising', trigger: 'SCHEDULE', conditions: [], actions,
  enabled: true, dryRun: false, autonomyLevel: 'AUTO',
  maxExecutionsPerDay: null, maxWritesPerDay: null, maxValueCentsEur: null, maxDailyAdSpendCentsEur: null, scopeMarketplace: null,
  ...extra,
})
const context = { trigger: 'SCHEDULE', marketplace: 'IT', campaign: { id: 'camp-1', name: 'TEST-CAMPAIGN' } }
const execData = () => (execCreate.mock.calls[0] as unknown as [{ data: { dryRun: boolean } }])[0].data

beforeEach(() => {
  vi.clearAllMocks()
  seen.length = 0
  translate.mockReturnValue(null)
})

describe('run-time AUTO ceiling', () => {
  it('an AUTO rule carrying pause_target is demoted: dry run, and it proposes instead of acting', async () => {
    ruleFindUnique.mockResolvedValueOnce(AUTO([{ type: 'pause_target' }]))
    const r = await evaluateRule({ ruleId: 'rule-1', context })
    expect(r.status).toBe('DRY_RUN')
    expect(seen).toEqual([{ type: 'pause_target', dryRun: true }])
    expect(execData().dryRun).toBe(true)
    await flush()
    expect(genSuggestions).toHaveBeenCalledTimes(1)
  })

  it('an AUTO rule that creates negatives is demoted', async () => {
    ruleFindUnique.mockResolvedValueOnce(AUTO([{ type: 'add_negative_exact' }]))
    expect((await evaluateRule({ ruleId: 'rule-1', context })).status).toBe('DRY_RUN')
    expect(seen).toEqual([{ type: 'add_negative_exact', dryRun: true }])
  })

  it('an unclassified action is demoted (default-deny, as at set time)', async () => {
    ruleFindUnique.mockResolvedValueOnce(AUTO([{ type: 'mystery_action' }]))
    expect((await evaluateRule({ ruleId: 'rule-1', context })).status).toBe('DRY_RUN')
  })

  it('one structural action demotes the whole execution — a rule is judged by its most dangerous action', async () => {
    ruleFindUnique.mockResolvedValueOnce(AUTO([{ type: 'bid_apply' }, { type: 'pause_target' }]))
    await evaluateRule({ ruleId: 'rule-1', context })
    expect(seen).toEqual([{ type: 'bid_apply', dryRun: true }, { type: 'pause_target', dryRun: true }])
  })

  // Control: without this the test above could pass with every AUTO rule silenced.
  it('an AUTO rule that only moves bids still acts', async () => {
    ruleFindUnique.mockResolvedValueOnce(AUTO([{ type: 'bid_apply' }, { type: 'notify', message: 'TEST' }]))
    const r = await evaluateRule({ ruleId: 'rule-1', context })
    expect(r.status).toBe('SUCCESS')
    expect(seen).toEqual([{ type: 'bid_apply', dryRun: false }])
    expect(execData().dryRun).toBe(false)
  })

  it('judged on the TRANSLATED actions: a builder rule whose block pauses is demoted, one that bids acts', async () => {
    translate.mockReturnValueOnce({ conditions: [], actions: [{ type: 'pause_target' }] })
    ruleFindUnique.mockResolvedValueOnce(AUTO([{ type: 'bid', control: 'auto' }]))
    expect((await evaluateRule({ ruleId: 'rule-1', context })).status).toBe('DRY_RUN')
    translate.mockReturnValueOnce({ conditions: [], actions: [{ type: 'bid_apply' }] })
    ruleFindUnique.mockResolvedValueOnce(AUTO([{ type: 'bid', control: 'auto' }]))
    expect((await evaluateRule({ ruleId: 'rule-1', context })).status).toBe('SUCCESS')
  })

  it('a PROPOSE rule is unchanged', async () => {
    ruleFindUnique.mockResolvedValueOnce(AUTO([{ type: 'bid_apply' }], { autonomyLevel: 'PROPOSE', dryRun: true }))
    expect((await evaluateRule({ ruleId: 'rule-1', context })).status).toBe('DRY_RUN')
    expect(seen).toEqual([{ type: 'bid_apply', dryRun: true }])
  })

  it('another domain is untouched: the ads ceiling does not judge a replenishment rule', async () => {
    ruleFindUnique.mockResolvedValueOnce(AUTO([{ type: 'auto_approve_recommendation' }], { domain: 'replenishment' }))
    expect((await evaluateRule({ ruleId: 'rule-1', context: {} })).status).toBe('SUCCESS')
    expect(seen).toEqual([{ type: 'auto_approve_recommendation', dryRun: false }])
  })
})

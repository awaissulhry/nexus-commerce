/**
 * 4l (review 2.7, the rest after 1f; and 2.6) — OFF means off, and an edit cannot switch writing on.
 *
 * Before: `resolveAutonomy` let an explicit OFF fall back to `dryRun`, so an OFF rule that was enabled ran at PROPOSE —
 * or at AUTO when dryRun was false — and the evaluator ran it; `PATCH {dryRun:false}` on a rule whose level was OFF or
 * unset made it AUTO with no gate; `PATCH {dryRun:true}` on an AUTO rule left it writing (an explicit AUTO ignored
 * dryRun). Pinned here: an OFF rule is not evaluated (a preview still is), the tick never loads one, a PATCH refuses
 * `dryRun:false` below AUTO with a sentence, `dryRun:true` takes AUTO down to PROPOSE, switching an Off rule on lands at
 * PROPOSE; and the edit's refusal names the one graduation gate (14 days · 10 evaluations · 1 match).
 *
 * The database is a stub: each case is decided by what is read and what would be written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  automationRule: { findUnique: vi.fn(), findMany: vi.fn(async () => []), update: vi.fn() },
  automationRuleExecution: { count: vi.fn(async () => 0), create: vi.fn(async () => ({ id: 'exec-new' })) },
  advertisingActionLog: { create: vi.fn(async () => ({})), count: vi.fn(async () => 0) },
}))
vi.mock('../../db.js', () => ({ default: db }))
vi.mock('./rule-campaign-binding.service.js', () => ({ syncRuleCampaignBinding: vi.fn(async () => undefined) }))
vi.mock('./ads-placement-autonomy.js', () => ({ checkPlacementAutoAllowed: vi.fn(async () => ({ blocked: false })) }))
vi.mock('./ads-suggestions.service.js', () => ({ generateSuggestionsFromExecution: vi.fn(async () => 0) }))
vi.mock('../ads-execution-events.service.js', () => ({ publishAdsExecution: vi.fn() }))
vi.mock('../automation-refusals.service.js', () => ({ recordAutomationRefusal: vi.fn(async () => {}) }))

const { updateAdsRule, GRADUATION_GATE } = await import('./ads-rule-crud.service.js')
const { evaluateRule, evaluateAllRulesForTrigger, ACTION_HANDLERS } = await import('../automation-rule.service.js')

const seen: Array<{ dryRun: boolean }> = []
ACTION_HANDLERS.tst_off_spy = (async (action: { type: string }, _ctx: unknown, meta: { dryRun: boolean }) => {
  seen.push({ dryRun: meta.dryRun })
  return { type: action.type, ok: true, output: {} }
}) as never

const RULE = (extra: Record<string, unknown>) => ({
  id: 'rule-1', domain: 'advertising', name: 'TEST rule', trigger: 'SCHEDULE', conditions: [], actions: [{ type: 'tst_off_spy' }],
  enabled: true, dryRun: true, autonomyLevel: 'PROPOSE',
  maxExecutionsPerDay: null, maxWritesPerDay: null, maxValueCentsEur: null, maxDailyAdSpendCentsEur: null, scopeMarketplace: null,
  ...extra,
})
const written = () => (db.automationRule.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data

beforeEach(() => {
  vi.clearAllMocks()
  seen.length = 0
  db.automationRule.update.mockImplementation(async ({ data }: { data: object }) => ({ ...RULE({}), ...data }))
})

describe('4l — an OFF rule is not evaluated', () => {
  it('🔴 OFF + enabled + dryRun=false (it ran as AUTO) is not evaluated: no action, no run row, no counter', async () => {
    db.automationRule.findUnique.mockResolvedValueOnce(RULE({ autonomyLevel: 'OFF', dryRun: false }))
    const r = await evaluateRule({ ruleId: 'rule-1', context: { marketplace: 'IT' } })
    expect(r).toMatchObject({ matched: false, status: 'FAILED', errorMessage: 'Rule is Off' })
    expect(seen).toEqual([])
    expect(db.automationRuleExecution.create).not.toHaveBeenCalled()
    expect(db.automationRule.update).not.toHaveBeenCalled()
  })

  it('OFF + enabled + dryRun=true (it ran as PROPOSE) is not evaluated either', async () => {
    db.automationRule.findUnique.mockResolvedValueOnce(RULE({ autonomyLevel: 'OFF' }))
    expect((await evaluateRule({ ruleId: 'rule-1', context: {} })).errorMessage).toBe('Rule is Off')
    expect(seen).toEqual([])
  })

  it('a preview of an OFF rule still evaluates, as a dry run (control)', async () => {
    db.automationRule.findUnique.mockResolvedValueOnce(RULE({ autonomyLevel: 'OFF', dryRun: false }))
    const r = await evaluateRule({ ruleId: 'rule-1', context: {}, forceDryRun: true, isTestRun: true, noPersist: true })
    expect(r.matched).toBe(true)
    expect(seen).toEqual([{ dryRun: true }])
  })

  it('a PROPOSE rule is evaluated (control)', async () => {
    db.automationRule.findUnique.mockResolvedValueOnce(RULE({}))
    expect((await evaluateRule({ ruleId: 'rule-1', context: {} })).status).toBe('DRY_RUN')
    expect(seen).toEqual([{ dryRun: true }])
  })

  it('the tick never loads an OFF rule', async () => {
    await evaluateAllRulesForTrigger({ domain: 'advertising', trigger: 'SCHEDULE', context: {} })
    expect(db.automationRule.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ enabled: true, autonomyLevel: { not: 'OFF' } }),
    }))
  })
})

describe('4l — a rule edit cannot switch writing on', () => {
  it('🔴 dryRun:false on an OFF rule (the old road to AUTO) is refused with the gate in a sentence; nothing is stored', async () => {
    db.automationRule.findUnique.mockResolvedValueOnce(RULE({ autonomyLevel: 'OFF', enabled: true }))
    const out = await updateAdsRule('rule-1', { enabled: true, dryRun: false }, 'user:test')
    expect(out).toEqual({
      ok: false, status: 409,
      body: {
        error: 'use_level_control',
        message: "A rule edit cannot switch writing on. Auto is set with the level control, only after the graduation gate (14 days, 10 evaluations, 1 match) and a person's click.",
      },
    })
    expect(db.automationRule.update).not.toHaveBeenCalled()
  })

  it('dryRun:false is refused on a PROPOSE rule, and on a row with no level (it fell back to the binary)', async () => {
    db.automationRule.findUnique.mockResolvedValueOnce(RULE({}))
    expect((await updateAdsRule('rule-1', { dryRun: false }, 'user:test')).ok).toBe(false)
    db.automationRule.findUnique.mockResolvedValueOnce(RULE({ autonomyLevel: null, enabled: false }))
    expect((await updateAdsRule('rule-1', { dryRun: false }, 'user:test')).ok).toBe(false)
    expect(db.automationRule.update).not.toHaveBeenCalled()
  })

  it('dryRun:false on a rule already at AUTO (it passed the gate) changes nothing about its level (control)', async () => {
    db.automationRule.findUnique.mockResolvedValueOnce(RULE({ autonomyLevel: 'AUTO', dryRun: false, enabled: false }))
    const out = await updateAdsRule('rule-1', { enabled: true, dryRun: false }, 'user:test')
    expect(out.ok).toBe(true)
    expect(written()).toEqual({ enabled: true, dryRun: false })
  })

  it('🔴 dryRun:true on an AUTO rule takes it down to PROPOSE (it used to go on writing)', async () => {
    db.automationRule.findUnique.mockResolvedValueOnce(RULE({ autonomyLevel: 'AUTO', dryRun: false }))
    await updateAdsRule('rule-1', { dryRun: true }, 'user:test')
    expect(written()).toEqual({ dryRun: true, autonomyLevel: 'PROPOSE' })
  })

  it('switching an Off rule on lands it at PROPOSE, never higher', async () => {
    db.automationRule.findUnique.mockResolvedValueOnce(RULE({ autonomyLevel: 'OFF', enabled: false, dryRun: true }))
    await updateAdsRule('rule-1', { enabled: true }, 'user:test')
    expect(written()).toEqual({ enabled: true, autonomyLevel: 'PROPOSE', dryRun: true })
  })

  it('switching a disabled PROPOSE rule on keeps its level (control)', async () => {
    db.automationRule.findUnique.mockResolvedValueOnce(RULE({ enabled: false }))
    await updateAdsRule('rule-1', { enabled: true }, 'user:test')
    expect(written()).toEqual({ enabled: true })
  })
})

describe('4l (review 2.6) — one graduation gate', () => {
  it('is the Owner ruling D-R1: 14 days · 10 evaluations · 1 match', () => {
    expect(GRADUATION_GATE).toEqual({ observationDays: 14, evaluations: 10, matches: 1 })
  })
})

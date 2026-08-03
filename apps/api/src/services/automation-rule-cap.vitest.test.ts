/**
 * ADX.1 — regression test for the self-ratcheting daily cap.
 *
 * The bug: the cap counted EVERY AutomationRuleExecution row for the day, and on
 * rejection WROTE ANOTHER ONE. Once a rule hit its cap, every subsequent tick
 * appended a CAP_EXCEEDED row that raised the number the next tick compared
 * against, so the count could never fall back within a day. Measured on prod
 * 2026-08-04: 693,503 FAILED executions and 0 SUCCESS, ever; one cap-2 rule had
 * 2 real runs and 790 self-inflicted rejections in a single day.
 *
 * These tests pin the two properties that close it:
 *   1. a cap rejection writes NO execution row;
 *   2. the cap count excludes DAILY_CAP_EXCEEDED rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const execCreate = vi.fn(async () => ({ id: 'exec-new' }))
const execCount = vi.fn(async () => 0)
const ruleUpdate = vi.fn(async () => ({}))
const ruleFindUnique = vi.fn(async () => RULE)

vi.mock('../db.js', () => ({
  default: {
    automationRuleExecution: {
      get count() { return execCount },
      get create() { return execCreate },
    },
    automationRule: {
      get update() { return ruleUpdate },
      get findUnique() { return ruleFindUnique },
    },
  },
}))

const RULE = {
  id: 'rule-1',
  name: 'Bid optimization (profit-native)',
  domain: 'advertising',
  trigger: 'SCHEDULE',
  conditions: [],
  actions: [{ type: 'log_only' }],
  enabled: true,
  dryRun: true,
  maxExecutionsPerDay: 2,
  maxValueCentsEur: null,
  maxDailyAdSpendCentsEur: null,
  scopeMarketplace: null,
}

const { evaluateRule } = await import('./automation-rule.service.js')

beforeEach(() => {
  execCreate.mockClear()
  execCount.mockClear()
  ruleUpdate.mockClear()
  ruleFindUnique.mockClear()
})

describe('daily cap — the ADX.1 ratchet', () => {
  it('at cap: returns CAP_EXCEEDED and writes NO execution row', async () => {
    execCount.mockResolvedValueOnce(2) // already at cap of 2

    const r = await evaluateRule({
      ruleId: 'rule-1',
      context: { trigger: 'SCHEDULE', marketplace: 'IT' },
    })

    expect(r.status).toBe('CAP_EXCEEDED')
    expect(r.errorMessage).toBe('DAILY_CAP_EXCEEDED')
    // THE REGRESSION: writing a row here is what fed the counter.
    expect(execCreate).not.toHaveBeenCalled()
    // …and therefore there is no execution id to hand back.
    expect(r.executionId).toBeUndefined()
  })

  it('the cap count excludes prior DAILY_CAP_EXCEEDED rows', async () => {
    execCount.mockResolvedValueOnce(0)

    await evaluateRule({
      ruleId: 'rule-1',
      context: { trigger: 'SCHEDULE', marketplace: 'IT' },
    })

    expect(execCount).toHaveBeenCalledTimes(1)
    const where = execCount.mock.calls[0]?.[0]?.where
    // Without this the ~693k historical rejection rows keep the cap tripped forever.
    expect(where?.NOT).toEqual({ errorMessage: 'DAILY_CAP_EXCEEDED' })
    expect(where?.ruleId).toBe('rule-1')
  })

  it('under cap: the rule executes and records exactly one row', async () => {
    execCount.mockResolvedValueOnce(1) // cap is 2

    const r = await evaluateRule({
      ruleId: 'rule-1',
      context: { trigger: 'SCHEDULE', marketplace: 'IT' },
    })

    expect(r.status).toBe('DRY_RUN')
    expect(execCreate).toHaveBeenCalledTimes(1)
  })

  it('repeated ticks at cap never accumulate rows — the loop cannot restart', async () => {
    execCount.mockResolvedValue(2)

    for (let i = 0; i < 25; i++) {
      const r = await evaluateRule({
        rule: RULE as never,
        context: { trigger: 'SCHEDULE', marketplace: 'IT' },
      } as never)
      expect(r.status).toBe('CAP_EXCEEDED')
    }
    // Pre-fix this produced 25 new rows, each raising the count that caused them.
    expect(execCreate).not.toHaveBeenCalled()
  })
})

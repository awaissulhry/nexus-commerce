/**
 * 7b (review 8.4, 8.2) — two numbers on the rule board that disagreed with what happened.
 *
 *  · The "capped" chip counted DAILY_CAP_EXCEEDED execution rows. The engine stopped writing those on 2026-08-04
 *    (ADX.1) and records refusals in AutomationRefusalDaily instead, so the chip read 0 for every rule while the refusal
 *    screens showed thousands. It now reads the same record, through the same reader (`refusalCountsByActor`).
 *  · A builder rule whose control is Manual runs as a dry run and proposes, whatever its level (evaluateRule). The board
 *    showed its level only, so a rule set to Auto read Auto while it never wrote. It now says what it runs as, and why;
 *    `level` stays what was set.
 */
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  rules: [] as Array<Record<string, unknown>>,
  refusals: [] as Array<{ actorId: string; reason: string; count: number; lastAt: Date; lastReason: string }>,
  // A cap row of the kind the engine no longer writes. The board must not count it.
  executionCapRows: [] as Array<{ ruleId: string; _count: { _all: number } }>,
}))
vi.mock('../../db.js', () => ({
  default: {
    automationRule: { findMany: vi.fn(async () => h.rules) },
    adKeywordProtection: { count: vi.fn(async () => 0) },
    automationRuleExecution: {
      groupBy: vi.fn(async (args: { where: { errorMessage?: unknown } }) => (args.where.errorMessage === 'DAILY_CAP_EXCEEDED' ? h.executionCapRows : [])),
    },
    automationRefusalDaily: { findMany: vi.fn(async () => h.refusals) },
  },
}))
vi.mock('./ads-rule-reach.service.js', () => ({ reachForRules: vi.fn(async () => new Map()) }))

import { listAdsRuleBoard } from './ads-rule-list.service.js'

const rule = (id: string, level: string, actions: unknown[], enabled = true) => ({
  id, name: `Rule ${id}`, trigger: 'KEYWORD_HIGH_ACOS', actions, conditions: [], enabled, dryRun: level !== 'AUTO', autonomyLevel: level,
  priority: 100, maxExecutionsPerDay: 10, maxValueCentsEur: null, maxWritesPerDay: null, maxDailyAdSpendCentsEur: null,
  scopeMarketplace: 'IT', scopePortfolioId: null, scopeCampaignId: null, scopeProductId: null,
  evaluationCount: 0, matchCount: 0, executionCount: 0, lastEvaluatedAt: null, lastMatchedAt: null, lastExecutedAt: null,
  createdAt: new Date('2026-10-01T00:00:00Z'), description: null,
})

describe('the capped chip reads the refusal record', () => {
  it('counts its daily-cap refusals from AutomationRefusalDaily, not execution rows', async () => {
    h.rules = [rule('r1', 'AUTO', [{ type: 'bid_down', percent: 10 }]), rule('r2', 'PROPOSE', [{ type: 'bid_down', percent: 10 }])]
    h.refusals = [
      { actorId: 'r1', reason: 'DAILY_CAP_EXCEEDED', count: 37, lastAt: new Date(), lastReason: 'Rule r1 reached its daily cap of 10 and was refused.' },
      // A write-cap demotion is not its cap declining to run it: the chip's sentence would be false for it.
      { actorId: 'r1', reason: 'WRITE_CAP_REACHED', count: 5, lastAt: new Date(), lastReason: 'demoted' },
    ]
    h.executionCapRows = [{ ruleId: 'r2', _count: { _all: 999 } }]
    const { items } = await listAdsRuleBoard()
    const by = Object.fromEntries(items.map((i) => [i.id, i]))
    expect(by.r1.week.capped).toBe(37)
    expect(by.r2.week.capped).toBe(0)
  })
})

describe('a Manual-control rule says the level it runs at', () => {
  it('Auto with control Manual runs as Propose, says why, and keeps Auto as its level', async () => {
    h.refusals = []
    h.rules = [
      rule('auto-manual', 'AUTO', [{ type: 'bid_down', percent: 10, control: 'manual' }]),
      rule('auto-automate', 'AUTO', [{ type: 'bid_down', percent: 10, control: 'automate' }]),
      rule('auto-none', 'AUTO', [{ type: 'bid_down', percent: 10 }]),
      rule('observe-manual', 'OBSERVE', [{ type: 'bid_down', percent: 10, control: 'manual' }]),
      rule('propose-manual', 'PROPOSE', [{ type: 'bid_down', percent: 10, control: 'manual' }]),
      rule('off-manual', 'OFF', [{ type: 'bid_down', percent: 10, control: 'manual' }], false),
    ]
    const { items } = await listAdsRuleBoard()
    const by = Object.fromEntries(items.map((i) => [i.id, i]))

    expect(by['auto-manual']).toMatchObject({ level: 'AUTO', runsAs: 'PROPOSE' })
    expect(by['auto-manual'].runsAsReason).toContain('builder control is Manual')
    expect(by['auto-manual'].runsAsReason).toContain('Suggestions')

    // The engine proposes from an Observe rule with a Manual control too (its suggestion gate reads the control).
    expect(by['observe-manual']).toMatchObject({ level: 'OBSERVE', runsAs: 'PROPOSE' })
    expect(by['observe-manual'].runsAsReason).toContain('even on Observe')

    for (const id of ['auto-automate', 'auto-none', 'propose-manual', 'off-manual']) {
      expect(by[id].runsAs).toBe(by[id].level)
      expect(by[id].runsAsReason).toBeNull()
    }
  })
})

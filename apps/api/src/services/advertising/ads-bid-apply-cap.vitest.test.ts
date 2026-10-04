/**
 * 4d (review 4.4 + 5.10, Owner decision S11) — `bid_apply` and the rule's daily spend ceiling.
 *
 * Three holes this pins, all measured on the shipped handler:
 *
 *   ① `bid_apply` never called `checkDailySpendCap`: the builder's "every rule carries a €100/day spend ceiling" bound
 *      budget actions only, so a bid rule could raise without limit.
 *   ② The ceiling summed every execution of the day, DRY RUNS included, so previewing a rule used it up — while a
 *      suggestion a person approved ran live outside any execution row and counted nothing.
 *   ③ (5.10) A dry run that would change nothing returned before the `noChange` check, so bid rules on Manual filled
 *      Suggestions with "5¢ → 5¢" cards.
 *
 * The projected extra spend of a raise is (new − old) × the target's clicks per day in the rule's window.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  targetFindUnique: vi.fn(), perfAggregate: vi.fn(),
  ruleFindUnique: vi.fn(), execFindMany: vi.fn(), sugFindMany: vi.fn(),
  updateAdTargetWithSync: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    adTarget: { findUnique: h.targetFindUnique },
    amazonAdsDailyPerformance: { aggregate: h.perfAggregate },
    automationRule: { findUnique: h.ruleFindUnique },
    automationRuleExecution: { findMany: h.execFindMany },
    adsRuleSuggestion: { findMany: h.sugFindMany },
  },
}))
vi.mock('./ads-mutation.service.js', () => ({
  updateAdTargetWithSync: h.updateAdTargetWithSync,
  updateCampaignWithSync: vi.fn(),
  updateAdGroupWithSync: vi.fn(),
}))

import { ACTION_HANDLERS } from '../automation-rule.service.js'
import './automation-action-handlers.js'

type Result = { ok: boolean; error?: string; estimatedValueCentsEur?: number; output?: Record<string, unknown> }
const CONTEXT = { trigger: 'AD_TARGET_UNDERPERFORMING', adTarget: { id: 't1' } } // a 14-day window
const run = (action: Record<string, unknown>, dryRun = false) =>
  (ACTION_HANDLERS.bid_apply as (a: unknown, c: unknown, m: unknown) => Promise<Result>)(
    { type: 'bid_apply', ...action }, CONTEXT, { dryRun, ruleId: 'rule-1' },
  )

const bid = (bidCents: number) => h.targetFindUnique.mockResolvedValue({
  bidCents, suppressedFromBidCents: null, adGroup: { campaignId: 'c1', campaign: { bidsSuppressedAt: null } },
})
const clicks = (n: number, costMicros: bigint | null = null) =>
  h.perfAggregate.mockResolvedValue({ _sum: { clicks: n, costMicros, sales7dCents: 0 } })
const ceiling = (cents: number) => h.ruleFindUnique.mockResolvedValue({ maxDailyAdSpendCentsEur: cents })
const windowDaysOf = (call: number) => {
  const { gte, lte } = h.perfAggregate.mock.calls[call][0].where.date as { gte: Date; lte: Date }
  return Math.round((lte.getTime() - gte.getTime()) / 86_400_000)
}
const RAISE = { op: 'incAbs', value: 0.05 } // 35¢ → 40¢

/** Today's rows of this rule, filtered the way the database would filter them on the helper's `where`. */
const today = {
  executions: [] as Array<{ ruleId: string; dryRun: boolean; actionResults: unknown[] }>,
  suggestions: [] as Array<{ ruleId: string; status: string; appliedResult: unknown }>,
}

beforeEach(() => {
  vi.clearAllMocks()
  h.updateAdTargetWithSync.mockResolvedValue({ ok: true, outboundQueueId: 'q1' })
  h.perfAggregate.mockResolvedValue({ _sum: { clicks: null, costMicros: null, sales7dCents: null } })
  h.ruleFindUnique.mockResolvedValue({ maxDailyAdSpendCentsEur: null })
  today.executions = []
  today.suggestions = []
  h.execFindMany.mockImplementation(async ({ where }: { where: { ruleId: string; dryRun?: boolean } }) =>
    today.executions.filter((e) => e.ruleId === where.ruleId && (where.dryRun === undefined || e.dryRun === where.dryRun)))
  h.sugFindMany.mockImplementation(async ({ where }: { where: { ruleId: string; status?: string } }) =>
    today.suggestions.filter((x) => x.ruleId === where.ruleId && (where.status === undefined || x.status === where.status)))
})

describe('the projected extra spend of a bid raise', () => {
  it('35¢ → 40¢ on 70 clicks over the 14-day window projects 25¢ a day, and a dry run reports it', async () => {
    bid(35)
    clicks(70)
    const r = await run(RAISE, true)
    expect(r.ok).toBe(true)
    expect(r.estimatedValueCentsEur).toBe(25)
    expect(r.output).toMatchObject({ wouldChange: '35¢ → 40¢', extraSpendPerDayCents: 25, spendEstimate: 'raise' })
    expect(windowDaysOf(0)).toBe(14)
    expect(h.updateAdTargetWithSync).not.toHaveBeenCalled()
  })

  it('the rule’s own lookback sets the window: 56 clicks over 28 days is 2 a day', async () => {
    bid(35)
    clicks(56)
    const r = await run({ ...RAISE, windowDays: 28 }, true)
    expect(windowDaysOf(0)).toBe(28)
    expect(r.estimatedValueCentsEur).toBe(10)
  })

  it('a computed bid reuses the performance it already measured — one read, not two', async () => {
    bid(35)
    clicks(70, 35_000_000n) // 3,500¢ over 70 clicks = a 50¢ CPC
    const r = await run({ op: 'setCpc' }, true)
    expect(r.output?.wouldChange).toBe('35¢ → 50¢')
    expect(r.estimatedValueCentsEur).toBe(75) // 15¢ × 5 clicks a day
    expect(h.perfAggregate).toHaveBeenCalledTimes(1)
  })

  it('a raise with no measured clicks projects 0 and says unmeasured', async () => {
    bid(35)
    ceiling(10_000)
    const r = await run(RAISE)
    expect(r.ok).toBe(true)
    expect(r.estimatedValueCentsEur).toBe(0)
    expect(r.output?.spendEstimate).toBe('unmeasured')
  })
})

describe('5.10 — a dry run with nothing to change says so', () => {
  it('🔴 5¢ → 5¢ (a cut held at the floor) reports noChange, so it never becomes a suggestion card', async () => {
    bid(5)
    const r = await run({ op: 'decPct', value: 20 }, true)
    expect(r.output?.noChange).toBe(true)
    expect(r.output?.wouldChange).toBe('5¢ → 5¢') // kept: the preview parses it
    expect(r.estimatedValueCentsEur).toBe(0)
    expect(h.perfAggregate).not.toHaveBeenCalled()
  })

  it('a dry run that WOULD change carries no noChange flag', async () => {
    bid(35)
    const r = await run({ op: 'decPct', value: 20 }, true)
    expect(r.output?.wouldChange).toBe('35¢ → 28¢')
    expect(r.output?.noChange).toBeUndefined()
  })
})

describe('4.4 — the daily spend ceiling binds a bid raise', () => {
  it('a live raise under the ceiling writes and reports its projected extra spend', async () => {
    bid(35)
    clicks(70)
    ceiling(10_000)
    const r = await run(RAISE)
    expect(r.ok).toBe(true)
    expect(r.estimatedValueCentsEur).toBe(25)
    expect(h.updateAdTargetWithSync).toHaveBeenCalledTimes(1)
  })

  it('🔴 a live raise past the ceiling is refused and writes nothing', async () => {
    bid(35)
    clicks(70)
    ceiling(10_000)
    today.executions = [{ ruleId: 'rule-1', dryRun: false, actionResults: [{ ok: true, estimatedValueCentsEur: 9_990 }] }]
    const r = await run(RAISE)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/DAILY_AD_SPEND_CAP_EXCEEDED/)
    expect(h.updateAdTargetWithSync).not.toHaveBeenCalled()
  })

  it('🔴 dry runs do not use up the ceiling — only live writes count', async () => {
    bid(35)
    clicks(70)
    ceiling(10_000)
    today.executions = [
      { ruleId: 'rule-1', dryRun: true, actionResults: [{ ok: true, estimatedValueCentsEur: 50_000 }] },
      // a failed live action committed nothing either
      { ruleId: 'rule-1', dryRun: false, actionResults: [{ ok: false, estimatedValueCentsEur: 50_000 }] },
    ]
    const r = await run(RAISE)
    expect(r.ok).toBe(true)
    expect(h.updateAdTargetWithSync).toHaveBeenCalledTimes(1)
  })

  it('🔴 a suggestion approved today counts against the ceiling', async () => {
    bid(35)
    clicks(70)
    ceiling(10_000)
    today.suggestions = [{ ruleId: 'rule-1', status: 'applied', appliedResult: { ok: true, estimatedValueCentsEur: 9_990 } }]
    const r = await run(RAISE)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/today=9990¢ \+ projected=25¢ > cap=10000¢/)
    expect(h.updateAdTargetWithSync).not.toHaveBeenCalled()
  })

  it('a cut never consults the ceiling, even on a day already spent past it', async () => {
    bid(35)
    ceiling(10_000)
    today.executions = [{ ruleId: 'rule-1', dryRun: false, actionResults: [{ ok: true, estimatedValueCentsEur: 20_000 }] }]
    const r = await run({ op: 'decPct', value: 20 })
    expect(r.ok).toBe(true)
    expect(r.estimatedValueCentsEur).toBe(0)
    expect(r.output?.spendEstimate).toBe('cut')
    expect(h.ruleFindUnique).not.toHaveBeenCalled()
    expect(h.updateAdTargetWithSync).toHaveBeenCalledTimes(1)
  })
})

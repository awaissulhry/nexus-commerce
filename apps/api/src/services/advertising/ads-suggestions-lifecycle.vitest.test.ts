/**
 * SG.0 — the suggestion lifecycle.
 *
 * The queue holds the engine's CURRENT opinion. Pending rows the engine has stopped
 * re-proposing expire on the rule's own window (a weekly builder rule must not false-expire
 * on day 3); decided rows the engine still proposes come back — immediately for system
 * expiry, after 7 days for an operator dismiss. And the family map is the ONE mapping the
 * type tabs, the /count endpoint and the list filter all share.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const upsert = vi.fn(async () => ({}))
const findMany = vi.fn(async (_args?: unknown) => [] as unknown[])
const updateMany = vi.fn(async (_args?: unknown) => ({ count: 0 }))
const ruleFindMany = vi.fn(async (_args?: unknown) => [] as unknown[])
const executeRaw = vi.fn(async (..._args: unknown[]) => 0)

vi.mock('../../db.js', () => ({
  default: {
    adsRuleSuggestion: {
      get upsert() { return upsert },
      get findMany() { return findMany },
      get updateMany() { return updateMany },
    },
    automationRule: { get findMany() { return ruleFindMany } },
    get $executeRaw() { return executeRaw },
  },
}))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const svc = await import('./ads-suggestions.service.js')
const { familyOf, familyOfRow, expiryWindowMs, sweepSuggestionLifecycle, DEFAULT_EXPIRE_MS, generateSuggestionsFromExecution, projectBidCents, projectBudgetEur, acosThresholdOf } = svc

const DAY = 24 * 3600 * 1000

beforeEach(() => {
  upsert.mockClear(); findMany.mockClear(); updateMany.mockClear(); ruleFindMany.mockClear(); executeRaw.mockClear()
})

describe('the family map — one mapping for tabs, counts and filters', () => {
  it('routes every producing action type to its H10 tab', () => {
    expect(familyOf('bid_apply')).toBe('bids')
    expect(familyOf('lower_bid_to_floor')).toBe('bids')
    expect(familyOf('pause_target')).toBe('bids')
    expect(familyOf('promote_to_exact')).toBe('new-keywords')
    expect(familyOf('harvest_and_negate')).toBe('new-keywords')
    expect(familyOf('add_negative_exact')).toBe('negatives')
    expect(familyOf('sync_negatives_across_campaigns')).toBe('negatives')
    expect(familyOf('budget_apply')).toBe('budget')
    expect(familyOf('adjust_ad_budget')).toBe('budget')
    expect(familyOf('placement_apply')).toBe('placement')
  })

  it('an unknown type is other, never silently dropped', () => {
    expect(familyOf('dayparting_apply')).toBe('other')
    expect(familyOf(undefined)).toBe('other')
  })

  it('familyOfRow falls back to the proposedKey head when the payload has no type', () => {
    expect(familyOfRow({ proposedAction: { type: 'budget_apply' }, proposedKey: 'x' })).toBe('budget')
    expect(familyOfRow({ proposedAction: null, proposedKey: 'bid_apply:decPct:20' })).toBe('bids')
  })
})

describe('expiryWindowMs — the rule cadence decides how long silence means "moved on"', () => {
  it('an engine rule (no schedule) gets the 3-day default', () => {
    expect(expiryWindowMs({ actions: [{ type: 'bid_down', percent: 10 }] })).toBe(DEFAULT_EXPIRE_MS)
    expect(expiryWindowMs(null)).toBe(DEFAULT_EXPIRE_MS)
  })

  it('a weekly builder rule gets 2× its interval — it must not false-expire on day 3', () => {
    expect(expiryWindowMs({ actions: [{ schedule: { frequency: 'Weekly' } }] })).toBe(14 * DAY)
  })

  it('monthly → 60d; custom every 2 weeks → 28d', () => {
    expect(expiryWindowMs({ actions: [{ schedule: { frequency: 'Monthly' } }] })).toBe(60 * DAY)
    expect(expiryWindowMs({ actions: [{ schedule: { frequency: 'Custom', everyN: 2, interval: 'Weeks' } }] })).toBe(28 * DAY)
  })

  it('hourly and daily rules floor at the default — the window never tightens below it', () => {
    expect(expiryWindowMs({ actions: [{ schedule: { frequency: 'Hourly' } }] })).toBe(DEFAULT_EXPIRE_MS)
    expect(expiryWindowMs({ actions: [{ schedule: { frequency: 'Daily' } }] })).toBe(DEFAULT_EXPIRE_MS)
  })
})

describe('sweepSuggestionLifecycle', () => {
  const NOW = new Date('2026-08-21T12:00:00Z')

  it('expires per rule-window group and re-proposes via the raw column comparison', async () => {
    findMany.mockResolvedValueOnce([{ ruleId: 'r-weekly' }, { ruleId: 'r-gone' }])
    ruleFindMany.mockResolvedValueOnce([{ id: 'r-weekly', actions: [{ schedule: { frequency: 'Weekly' } }] }])
    updateMany.mockResolvedValue({ count: 3 })
    executeRaw.mockResolvedValueOnce(2)

    const out = await sweepSuggestionLifecycle(NOW)

    // two window groups: 14d for the weekly rule, the 3d default for the deleted one
    expect(updateMany).toHaveBeenCalledTimes(2)
    const cutoffs = updateMany.mock.calls.map((c) => {
      const arg = c[0] as { where: { ruleId: { in: string[] }; lastSeenAt: { lt: Date }; status: string }; data: { status: string; decidedBy: string } }
      expect(arg.where.status).toBe('pending')
      expect(arg.data).toMatchObject({ status: 'expired', decidedBy: 'system:stale' })
      return { ids: arg.where.ruleId.in, ms: NOW.getTime() - arg.where.lastSeenAt.lt.getTime() }
    })
    expect(cutoffs).toContainEqual({ ids: ['r-weekly'], ms: 14 * DAY })
    expect(cutoffs).toContainEqual({ ids: ['r-gone'], ms: DEFAULT_EXPIRE_MS })

    expect(executeRaw).toHaveBeenCalledTimes(1)
    expect(out).toEqual({ expired: 6, reproposed: 2 })
  })

  it('an empty queue sweeps nothing and never throws', async () => {
    findMany.mockResolvedValueOnce([])
    const out = await sweepSuggestionLifecycle(NOW)
    expect(updateMany).not.toHaveBeenCalled()
    expect(out.expired).toBe(0)
  })

  it('a DB failure returns zeros — hygiene must never fail the tick it rides', async () => {
    findMany.mockRejectedValueOnce(new Error('boom'))
    const out = await sweepSuggestionLifecycle(NOW)
    expect(out).toEqual({ expired: 0, reproposed: 0 })
  })
})

describe('SG.2 — the projected value mirrors the handlers', () => {
  it('bid family: pct ops move the current bid; setValue is EUR; floor is 5¢', () => {
    expect(projectBidCents({ type: 'bid_apply', op: 'decPct', value: 20 }, 100)).toBe(80)
    expect(projectBidCents({ type: 'bid_apply', op: 'incPct', value: 50 }, 100)).toBe(150)
    expect(projectBidCents({ type: 'bid_apply', op: 'setValue', value: 0.35 }, 100)).toBe(35)
    expect(projectBidCents({ type: 'bid_down', percent: 25 }, 200)).toBe(150)
    expect(projectBidCents({ type: 'lower_bid_to_floor' }, 999)).toBe(5)
  })

  it('a pct op with NO current value projects nothing — never a guess', () => {
    expect(projectBidCents({ type: 'bid_apply', op: 'decPct', value: 20 }, null)).toBeNull()
    expect(projectBudgetEur({ type: 'budget_apply', op: 'incPct', value: 20 }, null)).toBeNull()
  })

  it('budget family: EUR ops with the €1 floor the handlers enforce', () => {
    expect(projectBudgetEur({ type: 'budget_apply', op: 'incPct', value: 20 }, 20)).toBe(24)
    expect(projectBudgetEur({ type: 'budget_apply', op: 'decPct', value: 99 }, 20)).toBe(1)
    expect(projectBudgetEur({ type: 'set_daily_budget', value: 7.5 }, 20)).toBe(7.5)
    expect(projectBudgetEur({ type: 'adjust_ad_budget', percent: -15 }, 20)).toBe(17)
  })
})

describe('SG.2d — the rule ACoS criterion behind the adaptive dot', () => {
  it('reads the engine-flat shape, normalising a stored fraction to percent', () => {
    expect(acosThresholdOf([{ field: 'campaign.acos', op: 'gt', value: 0.4 }])).toBe(40)
    expect(acosThresholdOf([{ field: 'adTarget.acos', op: 'lte', value: 0.15 }])).toBe(15)
  })

  it('a value above 1 is ALREADY a percent — the 0.3-vs-30 trap, never blind-multiplied', () => {
    expect(acosThresholdOf([{ field: 'campaign.acos', op: 'gt', value: 30 }])).toBe(30)
  })

  it('reads the builder-nested shape too — one shape read is how the grid once went blank', () => {
    expect(acosThresholdOf([{ conditions: [{ field: 'adTarget.acos', op: 'gt', value: 0.6 }] }])).toBe(60)
  })

  it('no .acos condition → null (the dot falls back to the default band)', () => {
    expect(acosThresholdOf([{ field: 'adTarget.clicks', op: 'gte', value: 25 }])).toBeNull()
    expect(acosThresholdOf(null)).toBeNull()
    expect(acosThresholdOf([])).toBeNull()
  })
})

describe('the upsert stamps lastSeenAt on every refresh', () => {
  it('the update branch carries a fresh lastSeenAt; create relies on the column default', async () => {
    await generateSuggestionsFromExecution({
      ruleId: 'r1', ruleName: 'test', trigger: 'SCHEDULE', executionId: 'e1',
      context: { marketplace: 'IT', campaign: { id: 'c1', name: 'GALE' } },
      actions: [{ type: 'adjust_ad_budget', percent: -15 }],
      actionResults: [{ type: 'adjust_ad_budget', ok: true, output: { wouldChange: '€20.00 → €17.00' } }],
    })
    expect(upsert).toHaveBeenCalledTimes(1)
    const arg = upsert.mock.calls[0][0] as unknown as { update: { lastSeenAt?: unknown } }
    expect(arg.update.lastSeenAt).toBeInstanceOf(Date)
  })
})

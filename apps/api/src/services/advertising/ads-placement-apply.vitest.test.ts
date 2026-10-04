/**
 * PLC-P4 — `placement_apply`: the merge it uses, and what it says when it is refused.
 *
 * Two defects this pins, both measured on the shipped handler:
 *
 *   ① It rebuilt the wholesale placement payload INLINE instead of calling
 *      `buildManualAdjustments`. `updatePlacementBidding` writes `placementBidding` wholesale, so a
 *      one-lane payload erases the other two — 88 of 88 two-lane campaigns would have lost one —
 *      and a second implementation of that one rule is the kind of duplication whose failure is
 *      silent and account-wide.
 *   ② A gate-blocked write returns `{ ok:false, mode:'blocked', reason, deniedAt }` (PLC.3 added
 *      those two fields for exactly this) and the handler DISCARDED both, returning a bare
 *      `ok:false` with no `error`. The suggestion stayed pending — correct — and the operator was
 *      shown "refused" with nothing after it.
 *
 * 🔴 `buildManualAdjustments` is deliberately NOT mocked: it is the thing under test on the merge
 * side. Only the database and the write call are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  findUnique: vi.fn(), updatePlacementBidding: vi.fn(),
  // 4d — the lane's measured spend and the rule's daily spend ceiling
  laneAggregate: vi.fn(), ruleFindUnique: vi.fn(), execFindMany: vi.fn(), sugFindMany: vi.fn(),
  // 4e — the rank engine's schedules, targets and events on the campaign
  schedFindMany: vi.fn(), targetFindMany: vi.fn(), eventFindMany: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    campaign: { findUnique: h.findUnique },
    amazonAdsPlacementReport: { aggregate: h.laneAggregate },
    automationRule: { findUnique: h.ruleFindUnique },
    automationRuleExecution: { findMany: h.execFindMany },
    adsRuleSuggestion: { findMany: h.sugFindMany },
    adSchedule: { findMany: h.schedFindMany },
    rankTarget: { findMany: h.targetFindMany },
    rankScheduleEvent: { findMany: h.eventFindMany },
  },
}))
vi.mock('./ads-create.service.js', () => ({ updatePlacementBidding: h.updatePlacementBidding }))

import { ACTION_HANDLERS } from '../automation-rule.service.js'
import './automation-action-handlers.js'

const TOP = 'PLACEMENT_TOP'
const REST = 'PLACEMENT_REST_OF_SEARCH'
const PDP = 'PLACEMENT_PRODUCT_PAGE'

const run = (action: Record<string, unknown>, dryRun = false, operatorApproved?: boolean) =>
  (ACTION_HANDLERS.placement_apply as (a: unknown, c: unknown, m: unknown) => Promise<{ ok: boolean; error?: string; estimatedValueCentsEur?: number; output?: Record<string, unknown> }>)(
    { campaignId: 'c1', ...action }, {}, { dryRun, ruleId: 'rule-1', ...(operatorApproved ? { operatorApproved } : {}) },
  )

const profile = (lanes: Array<{ placement: string; percentage: number }>) => {
  h.findUnique.mockResolvedValue({ dynamicBidding: { placementBidding: lanes } })
}

/** 4d — today's rows of this rule, filtered the way the database would filter them on the helper's `where`. */
const today = {
  executions: [] as Array<{ ruleId: string; dryRun: boolean; actionResults: unknown[] }>,
  suggestions: [] as Array<{ ruleId: string; status: string; appliedResult: unknown }>,
}

beforeEach(() => {
  vi.clearAllMocks()
  h.updatePlacementBidding.mockResolvedValue({ ok: true, mode: 'live', adjustments: [] })
  h.laneAggregate.mockResolvedValue({ _sum: { costMicros: null } })
  h.ruleFindUnique.mockResolvedValue({ maxDailyAdSpendCentsEur: null })
  h.schedFindMany.mockResolvedValue([])
  h.targetFindMany.mockResolvedValue([])
  h.eventFindMany.mockResolvedValue([])
  today.executions = []
  today.suggestions = []
  h.execFindMany.mockImplementation(async ({ where }: { where: { ruleId: string; dryRun?: boolean } }) =>
    today.executions.filter((e) => e.ruleId === where.ruleId && (where.dryRun === undefined || e.dryRun === where.dryRun)))
  h.sugFindMany.mockImplementation(async ({ where }: { where: { ruleId: string; status?: string } }) =>
    today.suggestions.filter((x) => x.ruleId === where.ruleId && (where.status === undefined || x.status === where.status)))
})

describe('the merge — a one-lane rule must not erase the other lanes', () => {
  it('🔴 keeps BOTH untouched lanes when it changes the third', async () => {
    profile([{ placement: TOP, percentage: 30 }, { placement: REST, percentage: 45 }, { placement: PDP, percentage: 10 }])
    await run({ placement: TOP, op: 'set', value: 50 })
    const sent = h.updatePlacementBidding.mock.calls[0][0].adjustments as Array<{ placement: string; percentage: number }>
    expect(Object.fromEntries(sent.map((a) => [a.placement, a.percentage]))).toEqual({
      [TOP]: 50, [REST]: 45, [PDP]: 10,
    })
  })

  it('preserves a NON-MANAGED placement Amazon may add later, untouched', async () => {
    profile([{ placement: TOP, percentage: 30 }, { placement: 'PLACEMENT_AMAZON_BUSINESS', percentage: 12 }])
    await run({ placement: TOP, op: 'set', value: 50 })
    const sent = h.updatePlacementBidding.mock.calls[0][0].adjustments as Array<{ placement: string; percentage: number }>
    expect(sent).toContainEqual({ placement: 'PLACEMENT_AMAZON_BUSINESS', percentage: 12 })
  })

  it('does not emit an untouched lane that is already 0 — absent and 0 are one instruction', async () => {
    profile([{ placement: TOP, percentage: 0 }, { placement: REST, percentage: 45 }])
    await run({ placement: REST, op: 'set', value: 60 })
    const sent = h.updatePlacementBidding.mock.calls[0][0].adjustments as Array<{ placement: string; percentage: number }>
    expect(sent.some((a) => a.placement === TOP)).toBe(false)
    expect(sent).toContainEqual({ placement: REST, percentage: 60 })
  })

  it('clamps to the rule’s own guardrails, and never past Amazon’s 0–900', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    await run({ placement: TOP, op: 'set', value: 5000, minPct: 0, maxPct: 900 })
    expect((h.updatePlacementBidding.mock.calls[0][0].adjustments as Array<{ percentage: number }>)[0].percentage).toBe(900)
    h.updatePlacementBidding.mockClear()
    profile([{ placement: TOP, percentage: 300 }])
    await run({ placement: TOP, op: 'set', value: 10, minPct: 100, maxPct: 900 })
    expect((h.updatePlacementBidding.mock.calls[0][0].adjustments as Array<{ percentage: number }>)[0].percentage).toBe(100)
  })

  it('🔴 REFUSES a lane this system does not manage instead of writing a payload without it', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    const r = await run({ placement: 'PLACEMENT_SOMETHING_NEW', op: 'set', value: 50 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not a placement this system manages/)
    expect(h.updatePlacementBidding).not.toHaveBeenCalled()
  })
})

describe('a refusal carries the gate’s own sentence', () => {
  it('🔴 passes `reason` through as the error, verbatim', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    h.updatePlacementBidding.mockResolvedValue({
      ok: false, mode: 'blocked', adjustments: [],
      reason: 'live bid writes are disabled for this campaign', deniedAt: 'campaign_allowlist',
    })
    const r = await run({ placement: TOP, op: 'set', value: 50 })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('live bid writes are disabled for this campaign')
    expect(r.output?.deniedAt).toBe('campaign_allowlist')
    expect(r.output?.mode).toBe('blocked')
  })

  it('names a gate that gave no sentence, rather than reporting an empty refusal', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    h.updatePlacementBidding.mockResolvedValue({ ok: false, mode: 'blocked', adjustments: [], deniedAt: 'authority_pin' })
    const r = await run({ placement: TOP, op: 'set', value: 50 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('authority_pin')
  })

  it('a successful write reports ok with no error', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    const r = await run({ placement: TOP, op: 'set', value: 50 })
    expect(r.ok).toBe(true)
    expect(r.error).toBeUndefined()
    expect(r.output?.percentage).toBe(50)
  })
})

describe('dryRun and no-change (D-PLC-3, fixed after PLC-P4 deferred it)', () => {
  it('dryRun still returns wouldChange and writes nothing', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    const r = await run({ placement: TOP, op: 'set', value: 50 }, true)
    expect(r.ok).toBe(true)
    expect(r.output?.wouldChange).toBe('30% → 50%')
    expect(h.updatePlacementBidding).not.toHaveBeenCalled()
  })

  it('an unchanged value still short-circuits as noChange, before any merge', async () => {
    profile([{ placement: TOP, percentage: 50 }])
    const r = await run({ placement: TOP, op: 'set', value: 50 })
    expect(r.ok).toBe(true)
    expect(r.output?.noChange).toBe(true)
    expect(h.updatePlacementBidding).not.toHaveBeenCalled()
  })

  /**
   * 🔴 D-PLC-3, now FIXED (operator decision 2026-08-22) — and fixed in BOTH handlers together,
   * which is why it was deferred out of P4 rather than done there.
   *
   * A dry run that would change nothing now says `noChange`, so `recordSuggestions` skips it: a
   * rule proposing a no-op no longer files a suggestion. `wouldChange` is kept ALONGSIDE it,
   * because the builder's preview parses that sentence both to render "current → proposed" and to
   * count the rows a guardrail absorbed — returning one without the other would have fixed the
   * queue and silently zeroed the preview's census.
   */
  it('🔴 a dryRun no-op reports noChange, so it never reaches the suggestion queue', async () => {
    profile([{ placement: TOP, percentage: 50 }])
    const r = await run({ placement: TOP, op: 'set', value: 50 }, true)
    expect(r.output?.noChange).toBe(true)
  })

  it('…and still reports wouldChange, because the preview counts guardrail rows from it', async () => {
    profile([{ placement: TOP, percentage: 50 }])
    const r = await run({ placement: TOP, op: 'set', value: 50 }, true)
    expect(r.output?.wouldChange).toBe('50% → 50%')
  })

  it('a dryRun that WOULD change is untouched — no noChange flag on it', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    const r = await run({ placement: TOP, op: 'set', value: 50 }, true)
    expect(r.output?.wouldChange).toBe('30% → 50%')
    expect(r.output?.noChange).toBeUndefined()
  })
})

/**
 * 4d (review 4.4, Owner decision S11) — the rule's daily spend ceiling (€100/day by default) binds a placement raise.
 *
 * `placement_apply` never called `checkDailySpendCap`, so a placement rule could raise a lane to 900% with the ceiling
 * the builder promised doing nothing. It now projects the EXTRA spend per day (lane spend/day × ((100+new)/(100+old) − 1))
 * and, on a live raise, checks it against what the rule really committed today.
 */
describe('4d — the daily spend ceiling binds a placement raise', () => {
  // 7,000¢ in the window = 1,000¢ a day over the campaign-performance window of 7 days
  const laneSpend = () => h.laneAggregate.mockResolvedValue({ _sum: { costMicros: 70_000_000n } })
  const ceiling = (cents: number) => h.ruleFindUnique.mockResolvedValue({ maxDailyAdSpendCentsEur: cents })

  it('a raise reports its projected extra spend, live and dry, so maxValueCentsEur binds it', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    laneSpend()
    const dry = await run({ placement: TOP, op: 'set', value: 50 }, true)
    expect(dry.estimatedValueCentsEur).toBe(154)
    expect(dry.output?.extraSpendPerDayCents).toBe(154)
    expect(dry.output?.spendEstimate).toBe('raise')
    const live = await run({ placement: TOP, op: 'set', value: 50 })
    expect(live.ok).toBe(true)
    expect(live.estimatedValueCentsEur).toBe(154)
  })

  it('reads the lane by Amazon’s report label on the LOCAL campaign id, never the bidding enum', async () => {
    profile([{ placement: REST, percentage: 0 }])
    await run({ placement: REST, op: 'set', value: 20 }, true)
    const where = h.laneAggregate.mock.calls[0][0].where
    expect(where.localCampaignId).toBe('c1')
    expect(where.placement).toEqual({ in: ['Other on-Amazon'] })
  })

  it('🔴 a live raise past the ceiling is refused and writes nothing', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    laneSpend()
    ceiling(10_000)
    today.executions = [{ ruleId: 'rule-1', dryRun: false, actionResults: [{ ok: true, estimatedValueCentsEur: 9_900 }] }]
    const r = await run({ placement: TOP, op: 'set', value: 50 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/DAILY_AD_SPEND_CAP_EXCEEDED/)
    expect(h.updatePlacementBidding).not.toHaveBeenCalled()
  })

  it('🔴 dry runs do not use up the ceiling — only live writes count', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    laneSpend()
    ceiling(10_000)
    today.executions = [{ ruleId: 'rule-1', dryRun: true, actionResults: [{ ok: true, estimatedValueCentsEur: 50_000 }] }]
    const r = await run({ placement: TOP, op: 'set', value: 50 })
    expect(r.ok).toBe(true)
    expect(h.updatePlacementBidding).toHaveBeenCalledTimes(1)
  })

  it('🔴 a suggestion approved today counts against the ceiling', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    laneSpend()
    ceiling(10_000)
    today.suggestions = [
      { ruleId: 'rule-1', status: 'applied', appliedResult: { ok: true, estimatedValueCentsEur: 9_900 } },
      // a pending or dismissed row spent nothing
      { ruleId: 'rule-1', status: 'pending', appliedResult: { ok: true, estimatedValueCentsEur: 50_000 } },
    ]
    const r = await run({ placement: TOP, op: 'set', value: 50 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/today=9900¢/)
    expect(h.updatePlacementBidding).not.toHaveBeenCalled()
  })

  it('a cut never consults the ceiling, even on a day already spent past it', async () => {
    profile([{ placement: TOP, percentage: 50 }])
    laneSpend()
    ceiling(10_000)
    today.executions = [{ ruleId: 'rule-1', dryRun: false, actionResults: [{ ok: true, estimatedValueCentsEur: 20_000 }] }]
    const r = await run({ placement: TOP, op: 'decPct', value: 20 })
    expect(r.ok).toBe(true)
    expect(r.estimatedValueCentsEur).toBe(0)
    expect(r.output?.spendEstimate).toBe('cut')
    expect(h.ruleFindUnique).not.toHaveBeenCalled()
    expect(h.laneAggregate).not.toHaveBeenCalled()
    expect(h.updatePlacementBidding).toHaveBeenCalledTimes(1)
  })

  it('a raise on a lane with no measured spend projects 0 and says unmeasured', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    ceiling(10_000)
    const r = await run({ placement: TOP, op: 'set', value: 50 })
    expect(r.ok).toBe(true)
    expect(r.estimatedValueCentsEur).toBe(0)
    expect(r.output?.spendEstimate).toBe('unmeasured')
  })
})

/**
 * 4e (review 5.3) — an automated run does not write a lane the rank engine holds on the campaign.
 *
 * The level dial refused AUTO on a contested rule only when the level changed; a schedule enabled later, a widened
 * picker or a blend added to the hourly plan left an AUTO rule writing a lane the engine reverted within the hour. The
 * handler now checks at write time. A change a person approved goes through.
 */
describe('4e — an automated run skips a lane the rank engine holds', () => {
  const governedBy = (target: { key: string; placement: string; lanes?: unknown }, schedule: Record<string, unknown> = {}) => {
    h.schedFindMany.mockResolvedValue([{ campaignId: 'c1', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startHour: 8, endHour: 20, targetKey: target.key }], defaultTargetKey: null, targetOverrides: {}, groupId: null, ...schedule }])
    h.targetFindMany.mockResolvedValue([{ lanes: null, ...target }])
  }
  const blend = [{ placement: TOP, biasPct: 100 }, { placement: REST, biasPct: 20 }]

  it('🔴 skips Top of Search on a campaign an enabled schedule governs, says why, and writes nothing', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    governedBy({ key: 'own-top', placement: TOP })
    const r = await run({ placement: TOP, op: 'set', value: 50 })
    expect(r.ok).toBe(true)
    expect(r.output?.skipped).toBe('contested_by_rank_engine')
    expect(r.output?.reason).toMatch(/Rank & Dayparting controls Top of Search on this campaign/)
    expect(r.output?.reason).toMatch(/Set the rule to Manual/)
    expect(h.updatePlacementBidding).not.toHaveBeenCalled()
  })

  it('🔴 a change a person approved goes through (operatorApproved)', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    governedBy({ key: 'own-top', placement: TOP })
    const r = await run({ placement: TOP, op: 'set', value: 50 }, false, true)
    expect(r.ok).toBe(true)
    expect(r.output?.skipped).toBeUndefined()
    expect(h.updatePlacementBidding).toHaveBeenCalledTimes(1)
    expect(h.schedFindMany).not.toHaveBeenCalled()
  })

  it('a dry run still proposes, so a person can approve it', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    governedBy({ key: 'own-top', placement: TOP })
    const r = await run({ placement: TOP, op: 'set', value: 50 }, true)
    expect(r.output?.wouldChange).toBe('30% → 50%')
    expect(r.output?.skipped).toBeUndefined()
  })

  it('a campaign no enabled schedule governs is written as before', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    const r = await run({ placement: TOP, op: 'set', value: 50 })
    expect(r.output?.skipped).toBeUndefined()
    expect(h.updatePlacementBidding).toHaveBeenCalledTimes(1)
    expect(h.schedFindMany.mock.calls[0][0].where).toEqual({ enabled: true, campaignId: { in: ['c1'] } })
  })

  it('Product Pages holds under a single Top of Search target — that lane is the engine’s to leave alone', async () => {
    profile([{ placement: PDP, percentage: 10 }])
    governedBy({ key: 'own-top', placement: TOP })
    const r = await run({ placement: PDP, op: 'set', value: 25 })
    expect(r.output?.skipped).toBeUndefined()
    expect(h.updatePlacementBidding).toHaveBeenCalledTimes(1)
  })

  it('🔴 Product Pages is skipped when the schedule holds a BLEND — it sets every lane it does not name to 0', async () => {
    profile([{ placement: PDP, percentage: 10 }])
    governedBy({ key: 'blend-day', placement: TOP, lanes: blend })
    const r = await run({ placement: PDP, op: 'set', value: 25 })
    expect(r.output?.skipped).toBe('contested_by_rank_engine')
    expect(r.output?.reason).toMatch(/Product Pages on this campaign/)
    expect(r.output?.reason).toMatch(/blend/)
    expect(h.updatePlacementBidding).not.toHaveBeenCalled()
  })

  it('…in ANY window it can hold, not only this hour’s — and through the baseline', async () => {
    profile([{ placement: PDP, percentage: 10 }])
    governedBy({ key: 'blend-night', placement: TOP, lanes: blend }, { windows: [], defaultTargetKey: 'blend-night' })
    const r = await run({ placement: PDP, op: 'set', value: 25 })
    expect(r.output?.skipped).toBe('contested_by_rank_engine')
  })

  it('a campaign override with an empty lane list clears the blend, so Product Pages holds again', async () => {
    profile([{ placement: PDP, percentage: 10 }])
    governedBy({ key: 'blend-day', placement: TOP, lanes: blend }, { targetOverrides: { 'blend-day': { lanes: [] } } })
    const r = await run({ placement: PDP, op: 'set', value: 25 })
    expect(r.output?.skipped).toBeUndefined()
    expect(h.updatePlacementBidding).toHaveBeenCalledTimes(1)
  })

  it('a single Product Pages target writes that lane directly, so it is contested too', async () => {
    profile([{ placement: PDP, percentage: 10 }])
    governedBy({ key: 'pdp-only', placement: PDP })
    const r = await run({ placement: PDP, op: 'set', value: 25 })
    expect(r.output?.skipped).toBe('contested_by_rank_engine')
  })

  it('an enabled event of the schedule’s group that holds a blend counts as well', async () => {
    profile([{ placement: PDP, percentage: 10 }])
    governedBy({ key: 'own-top', placement: TOP }, { groupId: 'g1' })
    h.eventFindMany.mockResolvedValue([{ groupId: 'g1', windows: [], defaultTargetKey: 'bf-blend' }])
    h.targetFindMany.mockResolvedValue([{ key: 'own-top', placement: TOP, lanes: null }, { key: 'bf-blend', placement: TOP, lanes: blend }])
    const r = await run({ placement: PDP, op: 'set', value: 25 })
    expect(r.output?.skipped).toBe('contested_by_rank_engine')
    expect(h.eventFindMany.mock.calls[0][0].where).toMatchObject({ groupId: { in: ['g1'] }, enabled: true })
  })
})

describe('4e (review 5.9) — a failed push says Amazon, not the gate', () => {
  it('🔴 a live push Amazon did not take reports Amazon’s error, never “the write gate declined”', async () => {
    profile([{ placement: TOP, percentage: 30 }])
    h.updatePlacementBidding.mockResolvedValue({ ok: false, mode: 'live', adjustments: [], error: 'HTTP 400 INVALID_ARGUMENT' })
    const r = await run({ placement: TOP, op: 'set', value: 50 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/^Amazon did not take this placement change: HTTP 400 INVALID_ARGUMENT\./)
    expect(r.error).not.toMatch(/write gate/)
  })
})

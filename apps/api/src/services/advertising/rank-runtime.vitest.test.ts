/**
 * RD.P2 — the derivation, tested where it is pure.
 *
 * This is where correctness lives: every column the two-grain grid renders is a function of this
 * module, and the whole point of the section is that the page stops disagreeing with the engine.
 * So the cases below are taken from the ENGINE's branches and from prod measurements, not from the
 * design:
 *
 *   · `allOut` makes `canChase` true while `computeStep` reads neither the IS goal nor the ACoS
 *     cap — the single mistake that would have printed "Chasing 90% IS" on 11 live campaigns;
 *   · the CPC ceiling binds LAST and can pin a campaign below its own floor (measured: 6) or
 *     rule it out entirely on the base bid alone (measured: 5);
 *   · a group's mode is a SPREAD, never an average — one row hides eleven campaigns with four
 *     different fates, which is the flaw this section exists to fix.
 */
import { describe, expect, it } from 'vitest'
import {
  classifySqpFreshness, deriveCampaignRuntime, rollUpGroup, type RdCampaignRuntimeInput,
} from './rank-runtime.js'

/** A RankTarget row as Prisma returns it, with the library's real defaults. */
const target = (over: Record<string, unknown> = {}) => ({
  key: 'own-top', placement: 'PLACEMENT_TOP', targetISPct: 70, acosCapPct: 45,
  maxCpcCents: 150, biasPct: 150, pause: false, floorBidCents: null, allOut: false,
  jumpStartPct: null, stepUpPct: null, stepDownPct: null, maxBiasPct: null,
  keepClimbing: false, lanes: null, bidMode: null, bidValueCents: null, bidDeltaPct: null,
  ...over,
})

const input = (over: Partial<RdCampaignRuntimeInput> = {}): RdCampaignRuntimeInput => ({
  scheduleId: 's1', campaignId: 'c1', groupId: 'g1',
  scheduleEnabled: true,
  windows: [], defaultTargetKey: 'own-top',
  timezoneNow: { day: 3, hour: 12 },
  event: null,
  targetByKey: new Map([['own-top', target()]]),
  targetOverrides: null,
  maxBaseBidCents: null,
  biddingStrategy: null,
  governed: false,
  achievedISPct: null,
  ...over,
})

describe('the gates before a mode is even computed', () => {
  it('a disabled schedule is not running, whatever its plan says', () => {
    const r = deriveCampaignRuntime(input({ scheduleEnabled: false }))
    expect(r.mode.kind).toBe('not-running')
    expect(r.activeTargetKey).toBeNull()
  })

  it('a schedule with no baseline and no window targets is not goal-mode', () => {
    const r = deriveCampaignRuntime(input({ defaultTargetKey: null, windows: [] }))
    expect(r.mode.kind).toBe('not-running')
  })

  it('a campaign a family plan governs is skipped — the engine never evaluates it here', () => {
    const r = deriveCampaignRuntime(input({ governed: true }))
    expect(r.mode.kind).toBe('governed-elsewhere')
  })

  it('holds nothing when the hour resolves to no target at all', () => {
    const r = deriveCampaignRuntime(input({
      defaultTargetKey: null,
      windows: [{ days: [1], startHour: 0, endHour: 4, targetKey: 'own-top' }],
      timezoneNow: { day: 3, hour: 12 },
    }))
    expect(r.mode.kind).toBe('nothing-held')
  })

  it('names a dangling target rather than pretending nothing is scheduled', () => {
    const r = deriveCampaignRuntime(input({ defaultTargetKey: 'deleted-key' }))
    expect(r.mode.kind).toBe('dangling-target')
    expect(r.activeTargetKey).toBe('deleted-key')
  })
})

describe('mode precedence — the ceiling binds last and therefore decides first', () => {
  it('pause outranks everything', () => {
    const t = target({ key: 'pause', pause: true, biasPct: 0, floorBidCents: 2 })
    const r = deriveCampaignRuntime(input({
      defaultTargetKey: 'pause', targetByKey: new Map([['pause', t]]), maxBaseBidCents: 99999,
    }))
    expect(r.mode.kind).toBe('min-bid')
    expect(r.mode.label).toContain('0.02')
  })

  it('baseAlone beats every other cap state — no multiplier can rescue it', () => {
    // measured: AIRMESH base €2.41 against own-top-allout's €2.00 ceiling
    const t = target({ key: 'own-top-allout', allOut: true, biasPct: 300, maxCpcCents: 200, targetISPct: 90 })
    const r = deriveCampaignRuntime(input({
      defaultTargetKey: 'own-top-allout', targetByKey: new Map([['own-top-allout', t]]),
      maxBaseBidCents: 241,
    }))
    expect(r.mode.kind).toBe('capped-base')
    expect(r.ceiling?.baseAlone).toBe(true)
    expect(r.mode.label).toContain('2.41')
  })

  it('a cap below the floor is the real policy, not the target', () => {
    // measured: IT-AIRMESH-SP-Category-Exact, cap 14% against a 300% floor
    const t = target({ key: 'own-top-allout', allOut: true, biasPct: 300, maxCpcCents: 200 })
    const r = deriveCampaignRuntime(input({
      defaultTargetKey: 'own-top-allout', targetByKey: new Map([['own-top-allout', t]]),
      maxBaseBidCents: 175,
    }))
    expect(r.mode.kind).toBe('capped-floor')
    expect(r.canConverge).toBe(false)
  })

  it('a cap ABOVE the floor is not binding and must not read as capped', () => {
    const t = target({ key: 'defend-top', biasPct: 75, maxCpcCents: 120 })
    const r = deriveCampaignRuntime(input({
      defaultTargetKey: 'defend-top', targetByKey: new Map([['defend-top', t]]),
      maxBaseBidCents: 35, // cap ≈ 242%, far above the 75% floor
    }))
    expect(r.mode.kind).toBe('holding')
    expect(r.ceiling?.binding).toBe(false)
  })
})

describe('🔴 all-out is not chasing', () => {
  const allOut = target({ key: 'own-top-allout', allOut: true, biasPct: 300, maxCpcCents: 200, targetISPct: 90, acosCapPct: null })

  it('gets its own mode even though canChase is true', () => {
    const r = deriveCampaignRuntime(input({
      defaultTargetKey: 'own-top-allout', targetByKey: new Map([['own-top-allout', allOut]]),
      maxBaseBidCents: 20,
    }))
    expect(r.canChase).toBe(true)          // the engine's own predicate
    expect(r.mode.kind).toBe('all-out')    // ...but NOT "chasing"
    expect(r.mode.label).not.toContain('Chasing')
    expect(r.band).toEqual({ floor: 300, ceiling: 900 })
  })

  it('reports the IS goal as dead, because computeStep never reads it under allOut', () => {
    const r = deriveCampaignRuntime(input({
      defaultTargetKey: 'own-top-allout', targetByKey: new Map([['own-top-allout', allOut]]),
      maxBaseBidCents: 20, achievedISPct: 52,
    }))
    expect(r.goal.live).toBe(false)
    expect(r.goal.targetPct).toBe(90)
    expect(r.goal.deadReason).toMatch(/all-out/i)
  })
})

describe('chasing vs holding — the only real closed loop', () => {
  it('chases only when a ceiling is raised above the floor and allOut is off', () => {
    // measured override: own-top {biasPct:100, maxBiasPct:200, targetISPct:55}
    const t = target({ biasPct: 100, maxBiasPct: 200, targetISPct: 55, maxCpcCents: 80 })
    const r = deriveCampaignRuntime(input({ targetByKey: new Map([['own-top', t]]), maxBaseBidCents: 20 }))
    expect(r.mode.kind).toBe('chasing')
    expect(r.mode.label).toBe('Chasing 55% IS')
    expect(r.goal.live).toBe(true)
    expect(r.canConverge).toBe(true)
  })

  it('holds when the ceiling equals the floor — the library default on all five targets', () => {
    const r = deriveCampaignRuntime(input({ maxBaseBidCents: 20 }))
    expect(r.mode.kind).toBe('holding')
    expect(r.mode.label).toBe('Holding 150%')
  })

  it('a goal set behind a ceiling that equals the floor CANNOT converge', () => {
    const r = deriveCampaignRuntime(input({ maxBaseBidCents: 20 }))
    expect(r.goal.targetPct).toBe(70)
    expect(r.goal.live).toBe(false)
    expect(r.canConverge).toBe(false)
    expect(r.cannotConvergeReason).toMatch(/ceiling equals/i)
  })

  it('a target with no goal at all holds without being a convergence fault', () => {
    const t = target({ targetISPct: null })
    const r = deriveCampaignRuntime(input({ targetByKey: new Map([['own-top', t]]), maxBaseBidCents: 20 }))
    expect(r.mode.kind).toBe('holding')
    expect(r.canConverge).toBe(true)
    expect(r.goal.targetPct).toBeNull()
  })
})

describe('overrides and events follow the engine, not the group', () => {
  it('applies the per-campaign override the engine reads off AdSchedule', () => {
    const r = deriveCampaignRuntime(input({
      targetOverrides: { 'own-top': { biasPct: 0, acosCapPct: 15 } },
      maxBaseBidCents: 20,
    }))
    expect(r.band).toEqual({ floor: 0, ceiling: 0 })
    expect(r.mode.label).toBe('Holding 0%')
  })

  it('an active event overrides the weekly plan, exactly as the engine does', () => {
    const t2 = target({ key: 'defend-top', biasPct: 75 })
    const r = deriveCampaignRuntime(input({
      targetByKey: new Map([['own-top', target()], ['defend-top', t2]]),
      event: { windows: [], defaultTargetKey: 'defend-top', name: 'Prime Day' },
      maxBaseBidCents: 20,
    }))
    expect(r.activeTargetKey).toBe('defend-top')
    expect(r.eventName).toBe('Prime Day')
  })
})

describe('rollUpGroup — a spread, never an average', () => {
  const mk = (kind: string, n: number) => Array.from({ length: n }, () => ({ mode: { kind, label: kind }, canConverge: kind !== 'capped-floor', goal: { live: kind === 'chasing' } }))

  it('counts every distinct fate rather than collapsing to one', () => {
    const rows = [...mk('chasing', 4), ...mk('holding', 8)] as never
    const g = rollUpGroup(rows)
    expect(g.members).toBe(12)
    expect(g.modeSummary).toBe('4 chasing · 8 holding')
  })

  it('orders the spread by severity, not by count', () => {
    const rows = [...mk('holding', 8), ...mk('capped-floor', 2)] as never
    const g = rollUpGroup(rows)
    expect(g.modeSummary.startsWith('2 capped')).toBe(true)
  })

  it('says one word when every member agrees', () => {
    const g = rollUpGroup(mk('holding', 11) as never)
    expect(g.modeSummary).toBe('Holding')
    expect(g.mixed).toBe(false)
  })

  it('counts members that cannot converge', () => {
    const g = rollUpGroup([...mk('capped-floor', 6), ...mk('holding', 5)] as never)
    expect(g.cannotConverge).toBe(6)
    expect(g.mixed).toBe(true)
  })
})

/**
 * RD.P4 — the freshness classifier.
 *
 * These cases come from the SQP programme's measurement, not from the design: 20 of 34 campaigns
 * with a share are steered by exactly one ASIN, and the feed structurally cannot be fresher than
 * ~11 days plus the week length. So a one-ASIN basis is stale at any age, and an age threshold is
 * a stall alarm rather than a quality test.
 */
describe('classifySqpFreshness — basis first, age as a stall alarm', () => {
  it('calls a one-ASIN basis stale however fresh the week is', () => {
    const f = classifySqpFreshness({ withData: 1, total: 18, ageDays: 0 })
    expect(f.freshness).toBe('stale')
    expect(f.thin).toBe(true)
    expect(f.stalled).toBe(false)
    expect(f.staleReason).toMatch(/1 of 18/)
  })

  it('calls a thin FRACTION stale even with several contributors', () => {
    // 5 of 40 = 12.5%, under the 34% floor
    expect(classifySqpFreshness({ withData: 5, total: 40, ageDays: 3 }).freshness).toBe('stale')
  })

  it('accepts a broad basis on a recent week', () => {
    const f = classifySqpFreshness({ withData: 14, total: 18, ageDays: 14 })
    expect(f.freshness).toBe('fresh')
    expect(f.staleReason).toBeNull()
  })

  it('does NOT fire the stall alarm at the age the feed structurally sits at', () => {
    // 17-24 days is the feed's normal range; a guard that fired here would null everything forever
    expect(classifySqpFreshness({ withData: 14, total: 18, ageDays: 21 }).stalled).toBe(false)
    expect(classifySqpFreshness({ withData: 14, total: 18, ageDays: 24 }).stalled).toBe(false)
  })

  it('fires the stall alarm past 28 days, and says so separately from the basis', () => {
    const f = classifySqpFreshness({ withData: 14, total: 18, ageDays: 40 })
    expect(f.stalled).toBe(true)
    expect(f.thin).toBe(false)
    expect(f.staleReason).toMatch(/has not advanced in 40 days/)
  })

  it('reports BOTH reasons when both apply, rather than picking one', () => {
    const f = classifySqpFreshness({ withData: 1, total: 20, ageDays: 40 })
    expect(f.staleReason).toMatch(/1 of 20/)
    expect(f.staleReason).toMatch(/has not advanced/)
  })

  it('treats a zero basis as thin rather than dividing by zero', () => {
    expect(classifySqpFreshness({ withData: 0, total: 0, ageDays: null }).thin).toBe(true)
  })
})

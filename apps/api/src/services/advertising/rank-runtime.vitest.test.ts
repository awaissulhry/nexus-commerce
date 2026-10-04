/**
 * RD.P2 — the derivation, tested where it is pure.
 *
 * This is where correctness lives: every column the two-grain grid renders is a function of this
 * module, and the whole point of the section is that the page stops disagreeing with the engine.
 * So the cases below are taken from the ENGINE's branches and from prod measurements, not from the
 * design:
 *
 *   · 2e (Owner D1 = A) — the loop is an hour-of-day bid plan: every serving hour HOLDS its Placement %, so
 *     there is no all-out or chasing state, no goal is ever live, and the only "cannot converge" is the CPC
 *     ceiling holding a campaign below what its hour sets;
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

describe('2e — an all-out target holds its Placement % like any other', () => {
  const allOut = target({ key: 'own-top-allout', allOut: true, biasPct: 300, maxCpcCents: 200, targetISPct: 90, acosCapPct: null })

  it('is holding, with no chase band and no all-out state', () => {
    const r = deriveCampaignRuntime(input({
      defaultTargetKey: 'own-top-allout', targetByKey: new Map([['own-top-allout', allOut]]),
      maxBaseBidCents: 20,
    }))
    expect(r.canChase).toBe(false)
    expect(r.mode.kind).toBe('holding')
    expect(r.mode.label).toBe('Holding Top 300%')
    expect(r.band).toEqual({ floor: 300, ceiling: 300 }) // before 2e: ceiling 900
  })

  it('shows no goal: the stored IS target is not read', () => {
    const r = deriveCampaignRuntime(input({
      defaultTargetKey: 'own-top-allout', targetByKey: new Map([['own-top-allout', allOut]]),
      maxBaseBidCents: 20,
    }))
    expect(r.goal).toEqual({ targetPct: null, actualPct: null, live: false, deadReason: null })
  })
})

describe('2e — no chasing: every serving hour holds what it sets', () => {
  it('a ceiling raised above the floor no longer makes a closed loop', () => {
    // measured override: own-top {biasPct:100, maxBiasPct:200, targetISPct:55}
    const t = target({ biasPct: 100, maxBiasPct: 200, targetISPct: 55, maxCpcCents: 80, keepClimbing: true })
    const r = deriveCampaignRuntime(input({ targetByKey: new Map([['own-top', t]]), maxBaseBidCents: 20 }))
    expect(r.mode.kind).toBe('holding') // before 2e: chasing 55% IS
    expect(r.mode.label).toBe('Holding Top 100%')
    expect(r.goal.live).toBe(false)
    expect(r.canConverge).toBe(true)
  })

  it('holds the library default', () => {
    const r = deriveCampaignRuntime(input({ maxBaseBidCents: 20 }))
    expect(r.mode.kind).toBe('holding')
    expect(r.mode.label).toBe('Holding Top 150%')
    expect(r.mode.detail).toMatch(/reads no rank or share signal/)
  })

  it('a stored IS goal behind a ceiling that equals the floor is no longer a convergence fault', () => {
    const r = deriveCampaignRuntime(input({ maxBaseBidCents: 20 }))
    expect(r.goal.targetPct).toBeNull()
    expect(r.canConverge).toBe(true) // before 2e: cannot converge ("ceiling equals the floor")
    expect(r.cannotConvergeReason).toBeNull()
  })

  it('a blend holds each lane at its own %, and the CPC cap binds against the highest lane', () => {
    const blend = target({ lanes: [{ placement: 'PLACEMENT_TOP', biasPct: 50, maxBiasPct: 400 }, { placement: 'PLACEMENT_REST_OF_SEARCH', biasPct: 20 }] })
    const ok = deriveCampaignRuntime(input({ targetByKey: new Map([['own-top', blend]]), maxBaseBidCents: 20 }))
    expect(ok.mode.label).toBe('Holding Top 50% · Rest 20%')
    // €1.50 ceiling over a €1.20 base → cap 25%, below the 50% Top lane
    const capped = deriveCampaignRuntime(input({ targetByKey: new Map([['own-top', blend]]), maxBaseBidCents: 120 }))
    expect(capped.mode.kind).toBe('capped-floor')
    expect(capped.mode.label).toBe('Capped 25% · plan 50%')
    expect(capped.cannotConvergeReason).toMatch(/holds this at 25%, below the 50%/)
  })
})

describe('overrides and events follow the engine, not the group', () => {
  it('applies the per-campaign override the engine reads off AdSchedule', () => {
    const r = deriveCampaignRuntime(input({
      targetOverrides: { 'own-top': { biasPct: 0, acosCapPct: 15 } },
      maxBaseBidCents: 20,
    }))
    expect(r.band).toEqual({ floor: 0, ceiling: 0 })
    expect(r.mode.label).toBe('Holding Top 0%')
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
  const mk = (kind: string, n: number) => Array.from({ length: n }, () => ({ mode: { kind, label: kind }, canConverge: kind !== 'capped-floor', goal: { live: false } }))

  it('counts every distinct fate rather than collapsing to one', () => {
    const rows = [...mk('min-bid', 4), ...mk('holding', 8)] as never
    const g = rollUpGroup(rows)
    expect(g.members).toBe(12)
    expect(g.modeSummary).toBe('4 min bid · 8 holding')
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

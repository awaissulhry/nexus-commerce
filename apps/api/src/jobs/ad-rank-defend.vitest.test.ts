import { describe, it, expect } from 'vitest'
import { effectiveSpec, applyTargetOverrides, firstKeptServingNoticeToday, firstOutOfBudgetNoticeToday, firstWriteIntent, groupReceipts, isGoalMode, pickActiveEvents, rankDefendSummaryLine, rankReleaseNote, rankWritesNote } from './ad-rank-defend.job.js'
import type { RankTargetSpec } from '../services/advertising/rank-controller.js'

// RD.5 — family guardrail target transform (pure). OOS/lost-buybox → pause (stop
// wasting spend). 2e — the family ACOS cap only ever took all-out off a target, and nothing climbs any more.
const allOut: RankTargetSpec = { key: 'own-top-allout', placement: 'PLACEMENT_TOP', targetISPct: 90, acosCapPct: null, maxCpcCents: null, biasPct: 150, pause: false, allOut: true }
const ownTop: RankTargetSpec = { key: 'own-top', placement: 'PLACEMENT_TOP', targetISPct: 70, acosCapPct: 45, maxCpcCents: null, biasPct: 100, pause: false, allOut: false }
// MB.1 — the Min-bid target as seeded: no floor and no placement, both of which the engine
// reads as "behave exactly as you did before MB.1".
const minBid: RankTargetSpec = { key: 'pause', placement: 'PLACEMENT_TOP', targetISPct: null, acosCapPct: null, maxCpcCents: null, biasPct: null, pause: true, floorBidCents: null, allOut: false }

describe('RD.5 effectiveSpec — family guardrails', () => {
  it('passes through unchanged with no flags', () => {
    expect(effectiveSpec(ownTop, {})).toEqual(ownTop)
  })
  it('OOS / lost-buybox forces pause', () => {
    expect(effectiveSpec(ownTop, { oos: true }).pause).toBe(true)
    expect(effectiveSpec(allOut, { oos: true }).pause).toBe(true)
  })
  it('2e: an all-out target passes through unchanged — the family ACOS cap has nothing left to take off', () => {
    expect(effectiveSpec(allOut, {})).toEqual(allOut)
  })
})

// RTC — per-scope override merge (pure). Effective = global ⊕ product ⊕ campaign,
// most-specific (later map) wins, only the fields the override provides.
describe('RTC applyTargetOverrides — per-scope merge', () => {
  it('passes through when no override matches the spec key', () => {
    expect(applyTargetOverrides(ownTop, { 'defend-top': { biasPct: 70 } })).toEqual(ownTop)
  })
  it('applies only the provided fields, leaving the rest', () => {
    const e = applyTargetOverrides(ownTop, { 'own-top': { biasPct: 130, maxCpcCents: 80 } })
    expect(e.biasPct).toBe(130)
    expect(e.maxCpcCents).toBe(80)
    expect(e.targetISPct).toBe(70)
  })
  it('campaign override (later map) wins over product', () => {
    expect(applyTargetOverrides(ownTop, { 'own-top': { biasPct: 120 } }, { 'own-top': { biasPct: 200 } }).biasPct).toBe(200)
  })
  it('ignores null/undefined maps and treats 0 as a real override', () => {
    expect(applyTargetOverrides(ownTop, null, undefined).biasPct).toBe(100)
    expect(applyTargetOverrides(ownTop, { 'own-top': { biasPct: 0 } }).biasPct).toBe(0)
  })
  // MB.1 — a campaign can hold a different Min-bid floor from the library default. The merge
  // must treat it like every other scalar: campaign beats product, absent means inherit.
  it('MB.1 — carries a per-scope Min-bid floor, most-specific scope winning', () => {
    expect(applyTargetOverrides(minBid, { pause: { floorBidCents: 10 } }).floorBidCents).toBe(10)
    expect(applyTargetOverrides(minBid, { pause: { floorBidCents: 10 } }, { pause: { floorBidCents: 25 } }).floorBidCents).toBe(25)
  })
  it('MB.1 — no override leaves the floor null, which the engine reads as the legacy 2¢', () => {
    expect(applyTargetOverrides(minBid, { 'own-top': { floorBidCents: 10 } }).floorBidCents).toBeNull()
  })
  it('MB.1 — a Min-bid placement is overridable per campaign like any other bias', () => {
    expect(applyTargetOverrides(minBid, { pause: { biasPct: 0 } }).biasPct).toBe(0)
  })
})

// RDX/A1 — receipt grouping. One UPDATE per distinct resolved key, so 33 live schedules cost
// ~2 statements. Mis-grouping would stamp the WRONG target key onto a schedule, which reads as
// confident and is wrong — worse than stamping nothing.
describe('RDX/A1 groupReceipts — receipt batching', () => {
  it('collapses schedules that resolved to the same target', () => {
    const g = groupReceipts(new Map([['s1', 'own-top'], ['s2', 'own-top'], ['s3', 'defend-top']]))
    expect(g.get('own-top')).toEqual(['s1', 's2'])
    expect(g.get('defend-top')).toEqual(['s3'])
    expect(g.size).toBe(2)
  })
  it('keeps null (nothing due) as its own bucket, distinct from any key', () => {
    const g = groupReceipts(new Map([['s1', null], ['s2', 'own-top'], ['s3', null]]))
    expect(g.get(null)).toEqual(['s1', 's3'])
    expect(g.get('own-top')).toEqual(['s2'])
  })
  it('never conflates the null bucket with an empty-string key', () => {
    const g = groupReceipts(new Map([['s1', null], ['s2', '']]))
    expect(g.get(null)).toEqual(['s1'])
    expect(g.get('')).toEqual(['s2'])
  })
  it('returns nothing for an empty tick', () => {
    expect(groupReceipts(new Map()).size).toBe(0)
  })
})

// ── RDX/A1 — receipts ──────────────────────────────────────────────────────────
// The engine stamps AdSchedule.lastEvaluatedAt + lastApplied so the console can answer
// "when did this last run / what is it holding". Two invariants matter:
//   1. grouping must never move a schedule id onto the wrong target key
//   2. rank-defend and dayparting must never both own the same schedule row
describe('RDX/A1 groupReceipts', () => {
  it('collapses many schedules into one update per distinct key', () => {
    const g = groupReceipts(new Map([['s1', 'own-top'], ['s2', 'own-top'], ['s3', 'rest-of-search']]))
    expect(g.size).toBe(2)
    expect(g.get('own-top')).toEqual(['s1', 's2'])
    expect(g.get('rest-of-search')).toEqual(['s3'])
  })

  it('keeps null (evaluated, nothing due) as its own bucket, distinct from a key', () => {
    const g = groupReceipts(new Map([['s1', null], ['s2', 'own-top'], ['s3', null]]))
    expect(g.get(null)).toEqual(['s1', 's3'])
    expect(g.get('own-top')).toEqual(['s2'])
    // null must NOT collapse into the string 'null' or into an empty-string key
    expect(g.has('null' as unknown as string)).toBe(false)
    expect(g.has('')).toBe(false)
  })

  it('never loses or duplicates a schedule id', () => {
    const input = new Map<string, string | null>([['a', 'k1'], ['b', null], ['c', 'k2'], ['d', 'k1'], ['e', null]])
    const out = [...groupReceipts(input).values()].flat()
    expect(out.sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(new Set(out).size).toBe(out.length)
  })

  it('is a no-op on an empty map', () => {
    expect(groupReceipts(new Map()).size).toBe(0)
  })
})

describe('RDX/A1 the two crons cannot both stamp one schedule', () => {
  // rank-defend takes isGoalMode === true; ad-dayparting takes isGoalMode === false.
  // If the predicate were ever non-total, a row could be written by both writers with
  // conflicting meanings for lastApplied (target key vs ENABLED/PAUSED).
  const cases: Array<{ windows: unknown; baseline: string | null }> = [
    { windows: [], baseline: null },
    { windows: [], baseline: 'rest-of-search' },
    { windows: [{ days: [1], startHour: 9, endHour: 17 }], baseline: null },
    { windows: [{ days: [1], startHour: 9, endHour: 17, targetKey: 'own-top' }], baseline: null },
    { windows: [{ days: [1], bidMultiplierPct: 30 }], baseline: null },
    { windows: null, baseline: null },
    { windows: 'not-an-array', baseline: null },
  ]
  it('partitions every schedule shape into exactly one owner', () => {
    for (const c of cases) {
      const goal = isGoalMode(c.windows, c.baseline)
      const dayparting = !isGoalMode(c.windows, c.baseline)
      expect(goal !== dayparting).toBe(true) // exactly one owner, never both, never neither
    }
  })
  it('classic bid-multiplier windows stay with dayparting, not rank-defend', () => {
    expect(isGoalMode([{ days: [1], startHour: 0, endHour: 8, bidMultiplierPct: -50 }], null)).toBe(false)
  })
  it('a baseline alone is enough to make it rank-defend’s', () => {
    expect(isGoalMode([], 'own-top')).toBe(true)
  })
})

// G2 — event overrides decide what the engine HOLDS, so the selection rule is pinned here. The
// no-events case matters most: it is the property that let this ship without a behaviour gate.
describe('G2 pickActiveEvents — which event governs right now', () => {
  const at = new Date('2026-11-28T12:00:00Z')
  const ev = (o: Partial<{ groupId: string; startsAt: string; endsAt: string; enabled: boolean; name: string }>) => ({
    groupId: o.groupId ?? 'g1',
    startsAt: new Date(o.startsAt ?? '2026-11-28T00:00:00Z'),
    endsAt: new Date(o.endsAt ?? '2026-11-29T00:00:00Z'),
    enabled: o.enabled ?? true,
    name: o.name ?? 'e',
  })

  it('returns nothing when there are no events — the property that makes this inert', () => {
    expect(pickActiveEvents([], at).size).toBe(0)
  })

  it('ignores events that have not started or have already ended', () => {
    expect(pickActiveEvents([ev({ startsAt: '2026-12-01T00:00:00Z', endsAt: '2026-12-02T00:00:00Z' })], at).size).toBe(0)
    expect(pickActiveEvents([ev({ startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-11-02T00:00:00Z' })], at).size).toBe(0)
  })

  it('ignores disabled events, however well they cover the moment', () => {
    expect(pickActiveEvents([ev({ enabled: false })], at).size).toBe(0)
  })

  it('treats the range as half-open, so back-to-back events never both apply', () => {
    // A lead-in ending exactly when the event begins must hand over cleanly at the boundary.
    const boundary = new Date('2026-11-28T00:00:00Z')
    const leadIn = ev({ name: 'lead-in', startsAt: '2026-11-27T00:00:00Z', endsAt: '2026-11-28T00:00:00Z' })
    const main = ev({ name: 'event', startsAt: '2026-11-28T00:00:00Z', endsAt: '2026-11-29T00:00:00Z' })
    const picked = pickActiveEvents([leadIn, main], boundary)
    expect(picked.size).toBe(1)
    expect(picked.get('g1')?.name).toBe('event')
  })

  it('resolves an overlap to the latest-STARTED, not the newest row or the longest', () => {
    const main = ev({ name: 'event', startsAt: '2026-11-27T00:00:00Z', endsAt: '2026-11-30T00:00:00Z' })
    const leadOut = ev({ name: 'lead-out', startsAt: '2026-11-28T06:00:00Z', endsAt: '2026-11-29T00:00:00Z' })
    // Order reversed on purpose: the answer must not depend on input order.
    expect(pickActiveEvents([leadOut, main], at).get('g1')?.name).toBe('lead-out')
    expect(pickActiveEvents([main, leadOut], at).get('g1')?.name).toBe('lead-out')
  })

  it('keeps groups independent — one schedule in an event never affects another', () => {
    const picked = pickActiveEvents([ev({ groupId: 'g1', name: 'bf' }), ev({ groupId: 'g2', name: 'launch' })], at)
    expect(picked.get('g1')?.name).toBe('bf')
    expect(picked.get('g2')?.name).toBe('launch')
  })
})

// 2a — what a run gave back, in its summary line. A run that gave nothing back keeps the line it always had.
describe('2a rankReleaseNote — the give-back in the summary line', () => {
  const none = { restored: 0, keptByOthers: 0, failed: 0, deferred: 0, deferredWhy: null, writes: 0, swept: 0 }
  it('adds nothing when nothing was given back — kept-by-others alone is not an action', () => {
    expect(rankReleaseNote(undefined)).toBe('')
    expect(rankReleaseNote({ ...none, keptByOthers: 3 })).toBe('')
    expect(rankDefendSummaryLine({ evaluated: 4, applied: 2, decisions: [], release: none })).toBe('evaluated=4 applied=2')
  })
  it('names what came back, what the sweep looked at, what failed and what waits, and why', () => {
    expect(rankReleaseNote({ ...none, restored: 2, writes: 6, swept: 1 })).toBe(' released=2 (6 bids back) swept=1')
    expect(rankReleaseNote({ ...none, restored: 1, writes: 1 })).toBe(' released=1 (1 bid back)')
    expect(rankReleaseNote({ ...none, failed: 1 })).toBe(' release-failed=1 (kept for the next run)')
    expect(rankReleaseNote({ ...none, deferred: 2, swept: 2, deferredWhy: 'ads automation is stopped (halted: x)' })).toBe(' swept=2 release-waiting=2 (ads automation is stopped (halted: x))')
  })
})

// 2b — an out-of-budget campaign holds its placement raise every 15-minute tick; the warning says so once a day per
// schedule (the end-to-end tick is in ad-rank-defend-budget.vitest.test.ts).
describe('2b firstOutOfBudgetNoticeToday — once per schedule per UTC day', () => {
  it('answers yes once per key per UTC day, again on the next UTC day', () => {
    const at = (iso: string) => new Date(iso)
    expect(firstOutOfBudgetNoticeToday('automation:rank-defend-s1|c1', at('2026-10-04T00:05:00Z'))).toBe(true)
    expect(firstOutOfBudgetNoticeToday('automation:rank-defend-s1|c1', at('2026-10-04T00:20:00Z'))).toBe(false)
    expect(firstOutOfBudgetNoticeToday('automation:rank-defend-s1|c1', at('2026-10-04T23:59:00Z'))).toBe(false)
    expect(firstOutOfBudgetNoticeToday('automation:rank-defend-s2|c2', at('2026-10-04T23:59:00Z'))).toBe(true) // another schedule
    expect(firstOutOfBudgetNoticeToday('automation:rank-defend-s1|c1', at('2026-10-05T00:00:00Z'))).toBe(true)
    expect(firstOutOfBudgetNoticeToday('automation:rank-defend-s1|c1', at('2026-10-05T00:15:00Z'))).toBe(false)
  })
  it('the day is the UTC one, not the local one', () => {
    // 23:30 on 2026-10-04 and 00:30 on 2026-10-05 in Rome (CEST, UTC+2) are both 2026-10-04 in UTC.
    expect(firstOutOfBudgetNoticeToday('automation:rank-plan-p1|c9', new Date('2026-10-04T21:30:00Z'))).toBe(true)
    expect(firstOutOfBudgetNoticeToday('automation:rank-plan-p1|c9', new Date('2026-10-04T22:30:00Z'))).toBe(false)
  })
})

// 2c — the order a tick writes in, read off the campaign row and the hour's spec before anything is written.
describe('2c firstWriteIntent — give-backs, then floors, then placement moves, then base bids', () => {
  const sp = (o: Record<string, unknown> = {}) => ({ key: 'k', placement: 'PLACEMENT_TOP', targetISPct: null, acosCapPct: null, maxCpcCents: null, biasPct: 50, pause: false, allOut: false, ...o })
  const camp = (o: Record<string, unknown> = {}) => ({ dynamicBidding: { placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 50 }] }, bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null, ...o })
  const ours = { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: 2, bidsSuppressedBy: 'automation:rank-defend-s1' }
  it('a floor this engine set, on a serving hour, is a give-back', () => {
    expect(firstWriteIntent(camp(ours), sp())).toBe('restore')
    expect(firstWriteIntent(camp(ours), sp({ bidMode: 'suppress' }))).toBe('none') // kept floored on purpose
  })
  it('a floor someone else set is left alone', () => {
    expect(firstWriteIntent(camp({ ...ours, bidsSuppressedBy: 'user:op' }), sp({ biasPct: 100 }))).toBe('none')
  })
  it('a Min-bid hour floors, or re-floors at a new floor, or only moves its placement', () => {
    expect(firstWriteIntent(camp(), sp({ pause: true }))).toBe('suppress')
    expect(firstWriteIntent(camp(ours), sp({ pause: true, floorBidCents: 5 }))).toBe('suppress')
    expect(firstWriteIntent(camp(ours), sp({ pause: true, floorBidCents: 2, biasPct: 0 }))).toBe('placement')
    expect(firstWriteIntent(camp(ours), sp({ pause: true, floorBidCents: 2, biasPct: null }))).toBe('none')
    expect(firstWriteIntent(camp(), sp({ bidMode: 'suppress' }))).toBe('suppress')
  })
  it('a serving hour moves its placement (Top and Rest exclude each other), else its base bid, else nothing', () => {
    expect(firstWriteIntent(camp(), sp({ biasPct: 100 }))).toBe('placement')
    expect(firstWriteIntent(camp(), sp({ placement: 'PLACEMENT_REST_OF_SEARCH', biasPct: 0 }))).toBe('placement') // Top 50 → 0
    expect(firstWriteIntent(camp(), sp({ lanes: [{ placement: 'PLACEMENT_TOP', biasPct: 50 }, { placement: 'PLACEMENT_REST_OF_SEARCH', biasPct: 20 }] }))).toBe('placement')
    expect(firstWriteIntent(camp(), sp({ bidMode: 'absolute', bidValueCents: 60 }))).toBe('base')
    expect(firstWriteIntent(camp(), sp())).toBe('none')
  })
})

describe('2c rankWritesNote — the run\'s changes by kind', () => {
  const guard = (deferredByCap = 0) => ({ engine: 'rank-defend' as const, posture: 'auto' as const, why: '', caps: { perRun: 600, perDay: 3000 }, todayBefore: 0, changes: 0, wouldApply: 0, waiting: 0, deferredByCap })
  const none = { restore: 0, suppress: 0, placement: 0, base: 0 }
  it('says nothing on a run that wrote and deferred nothing, as before', () => {
    expect(rankWritesNote({ writes: none, guard: guard() })).toBe('')
    expect(rankDefendSummaryLine({ evaluated: 33, applied: 0, decisions: [], writes: none, guard: guard() })).toBe('evaluated=33 applied=0')
  })
  it('names every kind once anything was written or deferred', () => {
    expect(rankWritesNote({ writes: { restore: 140, suppress: 0, placement: 3, base: 0 }, guard: guard() })).toBe(' restore=140 suppress=0 placement=3 base=0 deferred=0')
    expect(rankWritesNote({ writes: none, guard: guard(2) })).toBe(' restore=0 suppress=0 placement=0 base=0 deferred=2')
  })
  it('adds the anti-flap holds when there are any', () => {
    expect(rankWritesNote({ writes: none, guard: guard(), keptServing: 1 })).toBe(' kept-serving=1 (entered Min bid 2 times today already)')
  })
})

describe('2c firstKeptServingNoticeToday — once per campaign per UTC day', () => {
  it('logs the first hold of the day only, and again the next UTC day', () => {
    expect(firstKeptServingNoticeToday('c1', new Date('2026-10-04T08:00:00Z'))).toBe(true)
    expect(firstKeptServingNoticeToday('c1', new Date('2026-10-04T20:00:00Z'))).toBe(false)
    expect(firstKeptServingNoticeToday('c2', new Date('2026-10-04T20:00:00Z'))).toBe(true)
    expect(firstKeptServingNoticeToday('c1', new Date('2026-10-05T00:00:00Z'))).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import { effectiveSpec, applyTargetOverrides, groupReceipts, isGoalMode, pickActiveEvents } from './ad-rank-defend.job.js'
import type { RankTargetSpec } from '../services/advertising/rank-controller.js'

// RD.5 — family guardrail target transform (pure). OOS/lost-buybox → pause (stop
// wasting spend); family over its ACOS cap → drop all-out so a must-win window
// still respects a profit ceiling.
const allOut: RankTargetSpec = { key: 'own-top-allout', placement: 'PLACEMENT_TOP', targetISPct: 90, acosCapPct: null, maxCpcCents: null, biasPct: 150, pause: false, allOut: true }
const ownTop: RankTargetSpec = { key: 'own-top', placement: 'PLACEMENT_TOP', targetISPct: 70, acosCapPct: 45, maxCpcCents: null, biasPct: 100, pause: false, allOut: false }

describe('RD.5 effectiveSpec — family guardrails', () => {
  it('passes through unchanged with no flags', () => {
    expect(effectiveSpec(ownTop, {})).toEqual(ownTop)
  })
  it('OOS / lost-buybox forces pause', () => {
    expect(effectiveSpec(ownTop, { oos: true }).pause).toBe(true)
    expect(effectiveSpec(allOut, { oos: true }).pause).toBe(true)
  })
  it('family over ACOS drops all-out and applies the family cap when target has none', () => {
    const e = effectiveSpec(allOut, { overAcos: true, familyAcosCapPct: 30 })
    expect(e.allOut).toBe(false)
    expect(e.acosCapPct).toBe(30)
  })
  it('family over ACOS keeps the target ACOS cap if it already has one', () => {
    const withCap: RankTargetSpec = { ...allOut, acosCapPct: 50 }
    expect(effectiveSpec(withCap, { overAcos: true, familyAcosCapPct: 30 }).acosCapPct).toBe(50)
  })
  it('over ACOS leaves a non-all-out target unchanged', () => {
    expect(effectiveSpec(ownTop, { overAcos: true, familyAcosCapPct: 30 })).toEqual(ownTop)
  })
  it('OOS wins over the ACOS path', () => {
    expect(effectiveSpec(allOut, { oos: true, overAcos: true, familyAcosCapPct: 30 }).pause).toBe(true)
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

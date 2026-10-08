/**
 * BID BRAIN BB-4 — the diff's two pure counts.
 *
 *   conflicts  a keyword two DIFFERENT automatic writers changed within 24 hours (the later write's day); a person and
 *              an engine, or one engine twice, is no conflict
 *   churn      bid writes per keyword per day: the total, how many keywords, the most on one
 *   compare    a shadow decision against today's bid: agree (goal or band hold), higher, lower, hold (an override), brake
 */
import { describe, expect, it } from 'vitest'
import { compareWord, writeStats } from './read.js'

const at = (iso: string) => new Date(iso)

describe('writeStats', () => {
  it('counts a conflict when two different engines changed one keyword within 24 hours', () => {
    const stats = writeStats([
      { entityId: 'k1', userId: 'automation:auto-bid', createdAt: at('2026-10-06T00:20:00Z') },
      { entityId: 'k1', userId: 'automation:rule-abc', createdAt: at('2026-10-06T23:00:00Z') },
      { entityId: 'k2', userId: 'automation:auto-bid', createdAt: at('2026-10-06T00:20:00Z') },
      { entityId: 'k2', userId: 'automation:auto-bid', createdAt: at('2026-10-06T06:20:00Z') },
      { entityId: 'k3', userId: 'user:owner', createdAt: at('2026-10-06T08:00:00Z') },
      { entityId: 'k3', userId: 'automation:auto-bid', createdAt: at('2026-10-06T09:00:00Z') },
      { entityId: 'k4', userId: 'automation:auto-bid', createdAt: at('2026-10-05T00:00:00Z') },
      { entityId: 'k4', userId: 'automation:rule-abc', createdAt: at('2026-10-06T01:00:00Z') },
    ])
    expect(stats.get('2026-10-06')).toEqual({ conflicts: 1, writes: 7, targetsWritten: 4, maxWritesPerTarget: 2 })
    expect(stats.get('2026-10-05')).toEqual({ conflicts: 0, writes: 1, targetsWritten: 1, maxWritesPerTarget: 1 })
  })
})

describe('compareWord', () => {
  it('reads a decision against today’s bid', () => {
    expect(compareWord({ action: 'hold', layer: 'band', currentCents: 20, decidedCents: 20 })).toBe('agree')
    expect(compareWord({ action: 'hold', layer: 'goal', currentCents: 20, decidedCents: 20 })).toBe('agree')
    expect(compareWord({ action: 'hold', layer: 'pin', currentCents: 20, decidedCents: 20 })).toBe('hold')
    expect(compareWord({ action: 'write', layer: 'goal', currentCents: 20, decidedCents: 25 })).toBe('higher')
    expect(compareWord({ action: 'write', layer: 'stop', currentCents: 20, decidedCents: 2 })).toBe('lower')
    expect(compareWord({ action: 'brake', layer: 'brake', currentCents: 20, decidedCents: 20 })).toBe('brake')
  })
})

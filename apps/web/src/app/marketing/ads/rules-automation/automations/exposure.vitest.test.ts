/**
 * 7a (review 8.2) — "Writing to Amazon: 6" counted every engine on Auto. With today's live state (2026-10-04) only two
 * engines change Amazon on their own; the other engines keep their rows, each in its plain group.
 */
import { describe, expect, it } from 'vitest'
import { actsOnItsOwn, engineInTile, groupCounts, groupSummary, type ExposureFields, type ExposureGroup } from './exposure'

const engine = (posture: string, group: ExposureGroup, label: string): ExposureFields & { posture: string } => ({ posture, exposure: { group, label, start: null } })

/** The engines on Auto that "Writing to Amazon: 6" counted, as the API places them today. */
const LIVE_TODAY = [
  engine('AUTO', 'acts', 'Changes Amazon on its own'), // Hourly bid plans
  engine('AUTO', 'ready', 'Ready — nothing set up'), // Classic dayparting
  engine('AUTO', 'ready', 'Ready — nothing set up'), // Budget enforcement
  engine('AUTO', 'acts', 'Changes Amazon on its own'), // Bid optimiser
  engine('AUTO', 'never', 'Always on — never changes Amazon by itself'), // Anomaly breaker
  engine('AUTO', 'never', 'Always on — never changes Amazon by itself'), // Write delivery
  engine('OFF', 'server-off', 'Off by a server switch'), // Top-of-search defense
  engine('OBSERVE', 'server-off', 'Off by a server switch'), // Coverage engine (observe)
]

describe('7a — only an engine that acts counts as writing; every engine keeps its row', () => {
  it('THE FINDING: six engines on Auto, two change Amazon on their own', () => {
    expect(LIVE_TODAY.filter((e) => e.posture === 'AUTO')).toHaveLength(6)
    expect(LIVE_TODAY.filter(actsOnItsOwn)).toHaveLength(2)
    expect(LIVE_TODAY.filter((e) => engineInTile(e, 'writing'))).toHaveLength(2)
    expect(LIVE_TODAY.filter((e) => engineInTile(e, 'unscoped'))).toHaveLength(2)
    expect(LIVE_TODAY.filter((e) => engineInTile(e, 'off'))).toHaveLength(1)
  })

  it('says every group that has an engine, what changes Amazon first', () => {
    expect(groupCounts(LIVE_TODAY)).toEqual({ acts: 2, ready: 2, held: 0, 'server-off': 2, never: 2, unknown: 0 })
    expect(groupSummary(LIVE_TODAY)).toBe('2 change Amazon on their own · 2 ready — nothing set up · 2 off by a server switch · 2 never change Amazon by themselves')
    expect(groupSummary([engine('AUTO', 'acts', 'x'), engine('AUTO', 'never', 'y')])).toBe('1 changes Amazon on its own · 1 never changes Amazon by itself')
  })

  it('an engine row from an older API (no group) is never counted as writing', () => {
    expect(actsOnItsOwn({})).toBe(false)
    expect(engineInTile({ posture: 'AUTO' }, 'writing')).toBe(false)
    expect(groupSummary([{}])).toBe('')
  })
})

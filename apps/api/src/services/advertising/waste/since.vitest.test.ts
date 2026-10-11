/**
 * NFIX (2026-10-11) — when a standing negative was added (since.ts): never the day Nexus stored its row. Made-up times.
 */
import { describe, expect, it } from 'vitest'
import { BULK_SYNC_MIN, crowdSizes, negativeAdded } from './since.js'

const T = Date.parse('2026-10-11T05:00:00Z')
const MIN = 60_000
const DAY = 86_400_000
const at = (ms: number) => new Date(ms)

describe('crowdSizes — how many negatives one sync stored together', () => {
  it('counts the rows within the window of each, itself included', () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `bulk-${i}`, at: T + i * 1000 })),
      { id: 'alone', at: T - 3 * DAY },
      { id: 'pair-a', at: T - DAY },
      { id: 'pair-b', at: T - DAY + MIN },
    ]
    const sizes = crowdSizes(rows)
    expect(sizes.get('bulk-0')).toBe(12)
    expect(sizes.get('bulk-11')).toBe(12)
    expect(sizes.get('alone')).toBe(1)
    expect([sizes.get('pair-a'), sizes.get('pair-b')]).toEqual([2, 2])
    expect(crowdSizes([])).toEqual(new Map())
  })
})

describe('negativeAdded — the add day from the records, else first seen, else unknown', () => {
  it('a row Nexus stored again (11 Oct) keeps the day the Brain wrote it (found by place and words)', () => {
    const r = negativeAdded({ brain: at(T - 2 * DAY), firstSeen: at(T), crowd: 300 })
    expect(r).toEqual({ at: at(T - 2 * DAY), source: 'brain', why: expect.stringMatching(/Brain's write/) })
  })

  it('the earliest record wins: its own create record, the Brain\'s write, Harvest\'s landing', () => {
    expect(negativeAdded({ record: at(T - DAY), brain: at(T - 2 * DAY), harvest: at(T - 3 * DAY), firstSeen: at(T - 4 * DAY), crowd: 1 }))
      .toMatchObject({ at: at(T - DAY), source: 'record' })
    expect(negativeAdded({ record: at(T), harvest: at(T - 3 * DAY), firstSeen: at(T), crowd: 1 })).toMatchObject({ at: at(T - 3 * DAY), source: 'harvest' })
  })

  it('a Brain or Harvest write that found the negative standing is not its add: Nexus held the row well before', () => {
    expect(negativeAdded({ brain: at(T), firstSeen: at(T - 20 * DAY), crowd: 1 })).toMatchObject({ at: at(T - 20 * DAY), source: 'first-seen' })
    // A few minutes apart (the run's clock, then the write) is the same add.
    expect(negativeAdded({ brain: at(T), firstSeen: at(T - 2 * MIN), crowd: 1 })).toMatchObject({ at: at(T), source: 'brain' })
  })

  it('no record: the day Nexus first saw it, unless one sync stored a crowd at once (an import, a re-sync): unknown, with why', () => {
    expect(negativeAdded({ firstSeen: at(T - 5 * DAY), crowd: BULK_SYNC_MIN - 1 })).toEqual({ at: at(T - 5 * DAY), source: 'first-seen', why: expect.stringMatching(/first saw it/) })
    const unknown = negativeAdded({ firstSeen: at(T), crowd: 312 })
    expect(unknown).toMatchObject({ at: null, source: null })
    expect(unknown.why).toBe('Added before Nexus kept a record: Nexus first saw it on 11 Oct 2026, in one sync with 311 other negatives')
  })
})

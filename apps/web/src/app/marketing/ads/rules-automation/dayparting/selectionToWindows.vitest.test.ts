import { describe, expect, it } from 'vitest'
import { parseCellKey, selectionToWindows, selectionHourCount } from './selectionToWindows'

const cells = (...pairs: Array<[number, number]>) => pairs.map(([d, h]) => `${d}:${h}`)

describe('RDX/D1 selectionToWindows', () => {
  // endHour is EXCLUSIVE (rank-controller: hour >= start && hour < end). An off-by-one here
  // authors a schedule that pushes at the wrong hour, which is the whole point of the feature.
  it('treats endHour as exclusive', () => {
    expect(selectionToWindows(cells([1, 18]), 'own-top')).toEqual([
      { days: [1], startHour: 18, endHour: 19, targetKey: 'own-top' },
    ])
  })

  it('collapses contiguous hours in a day into one range', () => {
    expect(selectionToWindows(cells([1, 18], [1, 19], [1, 20], [1, 21]), 'own-top')).toEqual([
      { days: [1], startHour: 18, endHour: 22, targetKey: 'own-top' },
    ])
  })

  it('keeps a gap as two separate windows', () => {
    expect(selectionToWindows(cells([1, 8], [1, 9], [1, 18], [1, 19]), 'own-top')).toEqual([
      { days: [1], startHour: 8, endHour: 10, targetKey: 'own-top' },
      { days: [1], startHour: 18, endHour: 20, targetKey: 'own-top' },
    ])
  })

  it('merges days that share an identical range into one window', () => {
    const sel = [1, 2, 3, 4, 5].flatMap((d) => [18, 19, 20, 21].map((h) => `${d}:${h}`))
    expect(selectionToWindows(sel, 'defend-top')).toEqual([
      { days: [1, 2, 3, 4, 5], startHour: 18, endHour: 22, targetKey: 'defend-top' },
    ])
  })

  it('does not merge days whose ranges differ', () => {
    const sel = [...cells([1, 18], [1, 19]), ...cells([2, 18], [2, 19], [2, 20])]
    expect(selectionToWindows(sel, 'own-top')).toEqual([
      { days: [1], startHour: 18, endHour: 20, targetKey: 'own-top' },
      { days: [2], startHour: 18, endHour: 21, targetKey: 'own-top' },
    ])
  })

  it('handles a full week at full depth as one window', () => {
    const sel = [0, 1, 2, 3, 4, 5, 6].flatMap((d) => Array.from({ length: 24 }, (_, h) => `${d}:${h}`))
    expect(selectionToWindows(sel, 'pause')).toEqual([
      { days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24, targetKey: 'pause' },
    ])
  })

  it('is deterministic and order-independent', () => {
    const a = selectionToWindows(cells([2, 9], [1, 18], [1, 19], [2, 8]), 'own-top')
    const b = selectionToWindows(cells([1, 19], [2, 8], [2, 9], [1, 18]), 'own-top')
    expect(a).toEqual(b)
    expect(a[0].startHour).toBeLessThanOrEqual(a[1].startHour)
  })

  it('de-duplicates repeated cells', () => {
    expect(selectionToWindows([...cells([1, 18]), ...cells([1, 18])], 'own-top')).toEqual([
      { days: [1], startHour: 18, endHour: 19, targetKey: 'own-top' },
    ])
  })

  it('returns nothing for an empty selection', () => {
    expect(selectionToWindows([], 'own-top')).toEqual([])
  })

  it('ignores malformed or out-of-range keys rather than authoring a bad window', () => {
    expect(selectionToWindows(['x:y', '9:3', '1:99', '-1:2', ''], 'own-top')).toEqual([])
  })
})

describe('parseCellKey', () => {
  it('accepts valid cells', () => {
    expect(parseCellKey('0:0')).toEqual({ dow: 0, hour: 0 })
    expect(parseCellKey('6:23')).toEqual({ dow: 6, hour: 23 })
  })
  it('rejects out-of-range and malformed', () => {
    expect(parseCellKey('7:0')).toBeNull()
    expect(parseCellKey('0:24')).toBeNull()
    expect(parseCellKey('a:1')).toBeNull()
    expect(parseCellKey('1')).toBeNull()
  })
})

describe('selectionHourCount', () => {
  it('counts days × hours across windows', () => {
    const w = selectionToWindows([1, 2, 3, 4, 5].flatMap((d) => [18, 19, 20, 21].map((h) => `${d}:${h}`)), 'x')
    expect(selectionHourCount(w)).toBe(20) // 5 days × 4 hours
  })
  it('is zero for no windows', () => {
    expect(selectionHourCount([])).toBe(0)
  })
})

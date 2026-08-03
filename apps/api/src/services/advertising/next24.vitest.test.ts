import { describe, it, expect } from 'vitest'
import { buildNext24, type Next24Slot, type Next24Target } from './next24.js'
import { resolveActiveTargetKey, biasBand } from './rank-controller.js'

/** 24 consecutive local hours starting Monday 00:00 (dow 1). */
function slotsFrom(dow: number, hour: number, n = 24): Next24Slot[] {
  return Array.from({ length: n }, (_, i) => {
    const abs = dow * 24 + hour + i
    return { at: `T+${i}`, dow: Math.floor(abs / 24) % 7, hour: abs % 24 }
  })
}

const lib = (...t: Next24Target[]) => new Map(t.map((x) => [x.key, x]))

const OWN_TOP: Next24Target = { key: 'own-top', name: 'Own Top of Search', color: '#0a7', biasPct: 120, acosCapPct: 35, maxCpcCents: 90 }
const ALL_OUT: Next24Target = { key: 'defend', name: 'Defend', biasPct: 200, allOut: true, acosCapPct: 35 } // no maxCpc
const SUPPRESS: Next24Target = { key: 'pause', name: 'Min bid', pause: true }

describe('buildNext24', () => {
  it('marks painted hours as window and the rest as baseline', () => {
    const windows = [{ days: [1], startHour: 18, endHour: 22, targetKey: 'defend' }]
    const { hours } = buildNext24(slotsFrom(1, 0), windows, 'own-top', lib(OWN_TOP, ALL_OUT))
    expect(hours).toHaveLength(24)
    expect(hours[17]).toMatchObject({ hour: 17, source: 'baseline', targetKey: 'own-top' })
    expect(hours[18]).toMatchObject({ hour: 18, source: 'window', targetKey: 'defend' })
    expect(hours[21]).toMatchObject({ hour: 21, source: 'window', targetKey: 'defend' })
    // endHour is EXCLUSIVE — 22:00 is back on the baseline, matching the engine.
    expect(hours[22]).toMatchObject({ hour: 22, source: 'baseline', targetKey: 'own-top' })
  })

  it('agrees with the engine hour for hour', () => {
    const windows = [
      { days: [1, 2, 3], startHour: 6, endHour: 9, targetKey: 'defend' },
      { days: [2], startHour: 20, endHour: 24, targetKey: 'pause' },
    ]
    const { hours } = buildNext24(slotsFrom(1, 14), windows, 'own-top', lib(OWN_TOP, ALL_OUT, SUPPRESS))
    for (const h of hours) {
      expect(h.targetKey).toBe(resolveActiveTargetKey(windows, 'own-top', h.dow, h.hour))
    }
  })

  it('quotes the engine band, and all-out lifts the ceiling to the cap', () => {
    const { hours } = buildNext24(slotsFrom(1, 0, 1), null, 'own-top', lib(OWN_TOP))
    expect(hours[0]).toMatchObject({ floorPct: 120, ceilingPct: 120, canChase: false, acosCapPct: 35, maxCpcCents: 90 })
    expect({ floor: hours[0].floorPct, ceiling: hours[0].ceilingPct }).toEqual(biasBand(OWN_TOP))

    const out = buildNext24(slotsFrom(1, 0, 1), null, 'defend', lib(ALL_OUT))
    expect(out.hours[0]).toMatchObject({ floorPct: 200, ceilingPct: 900, canChase: true, allOut: true })
    // all-out ignores the ACOS ceiling, so reporting one would be a lie the operator could act on
    expect(out.hours[0].acosCapPct).toBeNull()
  })

  it('counts all-out-with-no-CPC-ceiling as unbounded', () => {
    const capped: Next24Target = { ...ALL_OUT, maxCpcCents: 120 }
    const a = buildNext24(slotsFrom(1, 0), null, 'defend', lib(ALL_OUT))
    expect(a.summary.hoursUnbounded).toBe(24)
    const b = buildNext24(slotsFrom(1, 0), null, 'defend', lib(capped))
    expect(b.summary.hoursUnbounded).toBe(0)
    expect(b.hours[0].unbounded).toBe(false)
  })

  it('reports a deleted target as a hole, not a comfortable row', () => {
    const windows = [{ days: [1], startHour: 0, endHour: 3, targetKey: 'ghost' }]
    const { hours, summary } = buildNext24(slotsFrom(1, 0), windows, 'own-top', lib(OWN_TOP))
    expect(hours[0]).toMatchObject({ targetKey: 'ghost', missingTarget: true, floorPct: null, targetName: null })
    expect(summary.missingTargetKeys).toEqual(['ghost'])
  })

  it('describes a Min-bid hour as suppression, never as a pause', () => {
    // NP — the engine floors bids to ~2¢ and leaves the campaign ENABLED. An operator reading
    // "paused" would believe delivery stops; and a 0%/0% band would describe a placement
    // multiplier the job never reaches. Both would be wrong in the same direction.
    const { hours, summary } = buildNext24(slotsFrom(1, 0), null, 'pause', lib(SUPPRESS))
    expect(hours[0]).toMatchObject({ suppressed: true, floorPct: null, ceilingPct: null, canChase: false, acosCapPct: null })
    expect(hours[0]).not.toHaveProperty('pause')
    expect(summary.hoursSuppressed).toBe(24)
    expect(summary.maxCeilingPct).toBeNull()
  })

  it('counts an uncovered plan as uncovered rather than inventing a baseline', () => {
    const { hours, summary } = buildNext24(slotsFrom(1, 0), [], null, lib(OWN_TOP))
    expect(summary.hoursCovered).toBe(0)
    expect(summary.hoursUncovered).toBe(24)
    expect(hours[0].source).toBe('none')
    expect(summary.targets).toEqual([])
  })

  it('counts each change of governing target — every one is a bid write', () => {
    const windows = [{ days: [1], startHour: 18, endHour: 22, targetKey: 'defend' }]
    const { summary } = buildNext24(slotsFrom(1, 0), windows, 'own-top', lib(OWN_TOP, ALL_OUT))
    expect(summary.changes).toBe(2) // into the window at 18:00, back out at 22:00
    expect(summary.targets).toEqual([
      { key: 'own-top', name: 'Own Top of Search', color: '#0a7', hours: 20 },
      { key: 'defend', name: 'Defend', color: null, hours: 4 },
    ])
    expect(summary.maxCeilingPct).toBe(900)
  })

  it('crosses midnight into the next weekday', () => {
    const windows = [{ days: [2], startHour: 0, endHour: 6, targetKey: 'defend' }]
    const { hours } = buildNext24(slotsFrom(1, 20), windows, 'own-top', lib(OWN_TOP, ALL_OUT))
    expect(hours[0]).toMatchObject({ dow: 1, hour: 20, targetKey: 'own-top' })
    expect(hours[4]).toMatchObject({ dow: 2, hour: 0, targetKey: 'defend', source: 'window' })
    expect(hours[10]).toMatchObject({ dow: 2, hour: 6, targetKey: 'own-top', source: 'baseline' })
  })
})

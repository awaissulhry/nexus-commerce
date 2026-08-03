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

  it('a dated event replaces the plan for the hours it covers — windows AND baseline', () => {
    // RDX/G2 — ad-rank-defend swaps the whole plan for an armed event. If the preview kept the
    // group's baseline while taking the event's windows it would invent a third behaviour that
    // neither the plan nor the engine has.
    const weekly = [{ days: [1], startHour: 0, endHour: 24, targetKey: 'own-top' }]
    const eventPlan = { windows: [{ days: [1], startHour: 20, endHour: 24, targetKey: 'defend' }], defaultTargetKey: 'pause', eventName: 'Black Friday' }
    const slots = slotsFrom(1, 18).map((s, i) => (i < 4 ? { ...s, plan: eventPlan } : s))
    const { hours, summary } = buildNext24(slots, weekly, 'own-top', lib(OWN_TOP, ALL_OUT, SUPPRESS))

    // 18:00 and 19:00 are inside the event but outside its windows → the EVENT's baseline governs
    expect(hours[0]).toMatchObject({ hour: 18, targetKey: 'pause', source: 'baseline', eventName: 'Black Friday' })
    expect(hours[1]).toMatchObject({ hour: 19, targetKey: 'pause', eventName: 'Black Friday' })
    // 20:00, 21:00 are inside an event window
    expect(hours[2]).toMatchObject({ hour: 20, targetKey: 'defend', source: 'window', eventName: 'Black Friday' })
    // 22:00 is past the event → back to the weekly plan, and the hand-over is visible
    expect(hours[4]).toMatchObject({ hour: 22, targetKey: 'own-top', eventName: null })
    expect(summary.events).toEqual([{ name: 'Black Friday', hours: 4 }])
  })

  it('reports no events when none are armed, and never leaks the plan into a row', () => {
    const { hours, summary } = buildNext24(slotsFrom(1, 0), null, 'own-top', lib(OWN_TOP))
    expect(summary.events).toEqual([])
    expect(hours[0].eventName).toBeNull()
    // `plan` carries a full windows array; spreading the slot would copy it into all 24 rows.
    expect(hours[0]).not.toHaveProperty('plan')
  })

  it('crosses midnight into the next weekday', () => {
    const windows = [{ days: [2], startHour: 0, endHour: 6, targetKey: 'defend' }]
    const { hours } = buildNext24(slotsFrom(1, 20), windows, 'own-top', lib(OWN_TOP, ALL_OUT))
    expect(hours[0]).toMatchObject({ dow: 1, hour: 20, targetKey: 'own-top' })
    expect(hours[4]).toMatchObject({ dow: 2, hour: 0, targetKey: 'defend', source: 'window' })
    expect(hours[10]).toMatchObject({ dow: 2, hour: 6, targetKey: 'own-top', source: 'baseline' })
  })
})

/**
 * MB.6 — the preview must quote the CPC cap the engine (MB.4) will actually apply.
 *
 * This is the exact failure this module was written to prevent, arriving from a new direction:
 * before MB.4 "up to 900%" was true, and the moment the ceiling started binding it stopped
 * being true for every all-out target with a maxCpc set — which, on this account, is all of them.
 */
describe('MB.6 buildNext24 — the CPC ceiling in the preview', () => {
  const CAPPED: Next24Target = { key: 'ao', name: 'All-Out', biasPct: 150, allOut: true, maxCpcCents: 200 }
  const slots1 = (): Next24Slot[] => [{ at: '2026-08-03T10:00:00.000Z', dow: 1, hour: 10 }]
  const libOf = (t: Next24Target) => new Map([[t.key, t]])

  it('without bid data the ceiling is the band — unchanged from before MB.6', () => {
    const { hours } = buildNext24(slots1(), [], 'ao', libOf(CAPPED))
    expect(hours[0].ceilingPct).toBe(900)
    expect(hours[0].cpcCapPct).toBeNull()
  })

  it('with bid data the ceiling becomes the CPC cap, and says that is why', () => {
    // €0.35 base, €2.00 ceiling → 471%
    const { hours } = buildNext24(slots1(), [], 'ao', libOf(CAPPED), { maxBaseBidCents: 35, strategyMultiple: 1 })
    expect(hours[0].ceilingPct).toBe(471)
    expect(hours[0].cpcCapPct).toBe(471)
    expect(hours[0].canChase).toBe(true)
  })

  it('a cap ABOVE the band does not lower it, and is not reported as capping', () => {
    const modest: Next24Target = { key: 'ao', name: 'All-Out', biasPct: 150, maxBiasPct: 300, allOut: true, maxCpcCents: 200 }
    const { hours } = buildNext24(slots1(), [], 'ao', libOf(modest), { maxBaseBidCents: 20, strategyMultiple: 1 })
    expect(hours[0].ceilingPct).toBe(300)
    expect(hours[0].cpcCapPct).toBeNull()
  })

  it('an up-and-down campaign caps lower than a legacy one on identical bids', () => {
    const legacy = buildNext24(slots1(), [], 'ao', libOf(CAPPED), { maxBaseBidCents: 35, strategyMultiple: 1 })
    const auto = buildNext24(slots1(), [], 'ao', libOf(CAPPED), { maxBaseBidCents: 35, strategyMultiple: 2 })
    expect(auto.hours[0].ceilingPct!).toBeLessThan(legacy.hours[0].ceilingPct!)
  })

  it('the cap never drops the ceiling below the floor the target holds', () => {
    // Base bid so high the cap lands under the 150% floor — the loop still holds its floor.
    const { hours } = buildNext24(slots1(), [], 'ao', libOf(CAPPED), { maxBaseBidCents: 190, strategyMultiple: 1 })
    expect(hours[0].ceilingPct).toBeGreaterThanOrEqual(hours[0].floorPct!)
  })

  it('a target with NO ceiling is still reported unbounded — the warning must survive MB.4', () => {
    const none: Next24Target = { key: 'ao', name: 'All-Out', biasPct: 150, allOut: true }
    const { hours, summary } = buildNext24(slots1(), [], 'ao', libOf(none), { maxBaseBidCents: 35, strategyMultiple: 1 })
    expect(hours[0].unbounded).toBe(true)
    expect(summary.hoursUnbounded).toBe(1)
  })

  it('a suppressed (Min bid) hour reports no cap — it never reaches the placement stage', () => {
    const minBid: Next24Target = { key: 'p', name: 'Min bid', pause: true, maxCpcCents: 200 }
    const { hours } = buildNext24(slots1(), [], 'p', libOf(minBid), { maxBaseBidCents: 35, strategyMultiple: 1 })
    expect(hours[0].suppressed).toBe(true)
    expect(hours[0].cpcCapPct).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { WO_OPTIONS, WO_OPTIONS_INTERNAL, WO_OPTIONS_NONE } from '../demo/fixtures'
import { bothWays, cellsWithoutLine, defaultMode, needsColourway, workOrderBodyOf, workOrderFacts } from './model'

/** B-W2b-284: "Make sample work order" without an order line (an internal or uncharged proto, fit or salesman round). Made-up data. */

const NAVY = WO_OPTIONS.withoutLine.colourways[0]!.id
const dialog = (over: Partial<{ mode: 'lines' | 'none'; colourwayId: string; lineIds: string[] }> = {}) => ({ mode: 'none' as const, colourwayId: '', lineIds: [] as string[], siteId: 'site-1', dueDate: '2026-11-12', ...over })

describe('the sample work order without an order line (B-W2b-284)', () => {
  it('opens on "without an order line" for an internal round, and offers the choice only when both ways are open', () => {
    expect(defaultMode(WO_OPTIONS)).toBe('none')
    expect(defaultMode(WO_OPTIONS_INTERNAL)).toBe('none')
    expect(defaultMode(WO_OPTIONS_NONE)).toBe('lines')
    expect(defaultMode({ ...WO_OPTIONS, round: { ...WO_OPTIONS.round, partyId: 'brand' } })).toBe('lines')
    expect(bothWays(WO_OPTIONS)).toBe(true)
    expect(bothWays(WO_OPTIONS_INTERNAL)).toBe(false)
    expect(bothWays(WO_OPTIONS_NONE)).toBe(false)
  })

  it("holds Make until the colourway of the sizes without one is chosen; a round that may not is said by its code", () => {
    expect(needsColourway(WO_OPTIONS_INTERNAL)).toBe(true)
    expect(workOrderFacts(WO_OPTIONS_INTERNAL, [], dialog()).blockers.map((line) => line.key)).toEqual(['wo.blocker.pickColourway'])
    expect(workOrderFacts(WO_OPTIONS_INTERNAL, [], dialog({ colourwayId: NAVY })).blockers).toEqual([])
    expect(workOrderFacts(WO_OPTIONS_NONE, [], dialog()).blockers.map((line) => line.key)).toEqual(['refusal.ORDER_LINE_NEEDED'])
    expect(workOrderFacts({ ...WO_OPTIONS_INTERNAL, sites: [] }, [], dialog({ colourwayId: NAVY })).blockers.map((line) => line.key)).toEqual(['wo.blocker.noSites'])
    expect(workOrderFacts({ ...WO_OPTIONS_INTERNAL, blockers: ['x'] }, [], dialog({ colourwayId: NAVY })).blockers).toEqual([{ key: 'wo.blocker.other', params: { count: 1 } }])
  })

  it("shows the round's cells in the colourway chosen, and sends no order line", () => {
    expect(cellsWithoutLine(WO_OPTIONS_INTERNAL, '')).toEqual([{ key: '0', colourway: null, size: 'M', quantity: 1 }])
    expect(cellsWithoutLine(WO_OPTIONS_INTERNAL, NAVY)[0]!.colourway).toBe('NVY')
    expect(workOrderBodyOf(dialog({ colourwayId: NAVY }), WO_OPTIONS_INTERNAL, 4)).toEqual({ version: 4, siteId: 'site-1', dueDate: '2026-11-12', colourwayId: NAVY })
    const line = WO_OPTIONS.lines[0]!.id
    expect(workOrderBodyOf(dialog({ mode: 'lines', lineIds: [line], colourwayId: NAVY }), WO_OPTIONS, 4)).toEqual({ version: 4, siteId: 'site-1', dueDate: '2026-11-12', lines: [{ salesOrderLineId: line }] })
    const allColoured = { ...WO_OPTIONS_INTERNAL, withoutLine: { ...WO_OPTIONS_INTERNAL.withoutLine, cells: [{ colourwayId: NAVY, colourwayCode: 'NVY', size: 'M', quantity: 1 }] } }
    expect(workOrderBodyOf(dialog({ colourwayId: NAVY }), allColoured, 4)).toEqual({ version: 4, siteId: 'site-1', dueDate: '2026-11-12' })
  })
})

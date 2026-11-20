import { describe, expect, it } from 'vitest'
import { LINE_BLK, LINE_RED, order } from '../../_demo/fixtures'
import { groupMadeToMeasure } from '../../mtm-groups'
import { CONFIRMED_READ, LINES, PRODUCTION_READ } from './fixtures'
import { lineRowsOf, lineSizesOf, lineStageOf, nothingCutYet, totalOf, walkOf } from './progress'

/**
 * F-OO-100 (order overview lane: one file per section) — "Progress by line"'s rules, moved with progress.ts out of
 * overview.vitest.test.ts unchanged (F-SA-232: "Not counted here" never 0, made to measure grouped per style × colourway, the line's
 * sizes window).
 */

describe('"Progress by line": the order’s own pieces', () => {
  it('one row per colour line; a step a site does not count is null ("Not counted here"), never 0; totals the same way', () => {
    const rows = lineRowsOf(LINES, order('IN_PRODUCTION'))
    expect(rows.map((row) => row.id)).toEqual([LINE_BLK, LINE_RED])
    expect(rows[0]!.figures).toEqual({ ordered: 8, cut: 8, sewn: 6, checked: 2, packed: 0, shipped: 0 })
    expect(rows[1]!.figures.sewn).toBeNull()
    expect(totalOf(rows)).toEqual({ ordered: 14, cut: 11, sewn: 6, checked: 2, packed: 0, shipped: 0 })
    expect(totalOf([rows[1]!]).sewn).toBeNull()
    expect(rows[0]!.stage).toBe('SEWING')
    expect(rows[1]!.stage).toBe('CUTTING')
    expect(rows[0]!.styleId).toBe(order('IN_PRODUCTION').lines[0]!.styleId)
    expect(nothingCutYet(lineRowsOf(CONFIRMED_READ.lines!, order('CONFIRMED')))).toBe(true)
    expect(lineRowsOf(CONFIRMED_READ.lines!, order('CONFIRMED')).every((row) => row.notInWorkOrders && row.stage === null)).toBe(true)
  })

  it('a line’s stage from its own counts: nothing cut → Preparing; the first step not done; a step not counted is passed over', () => {
    expect(lineStageOf({ ordered: 10, cut: 0, sewn: 0, checked: 0, packed: 0, shipped: 0 })).toBe('PREPARING')
    expect(lineStageOf({ ordered: 10, cut: 4, sewn: 0, checked: 0, packed: 0, shipped: 0 })).toBe('CUTTING')
    expect(lineStageOf({ ordered: 10, cut: 10, sewn: null, checked: 3, packed: 0, shipped: 0 })).toBe('QUALITY')
    expect(lineStageOf({ ordered: 10, cut: 10, sewn: 10, checked: 10, packed: 10, shipped: 0 })).toBe('READY')
  })

  it('made to measure: the units of one style × colourway are ONE row (R9), never one per unit', () => {
    const unit = (id: string, seq: number, colour: string) => ({ ...LINES[0]!, lineId: id, seq, kind: 'MADE_TO_MEASURE', colourway: { code: colour, name: colour }, ordered: 1, cut: 1, sewn: 0, checked: 0, packed: 0, sizes: [{ size: null, ordered: 1, cut: 1, sewn: 0, checked: 0, packed: 0, shipped: 0, madeExtra: 0, madeExtraWords: null }] })
    const lines = [unit('u1', 30, 'BLK'), unit('u2', 31, 'BLK'), unit('u3', 32, 'RED'), ...LINES]
    const rows = lineRowsOf(lines, order('IN_PRODUCTION'))
    const mtm = rows.filter((row) => row.mtm)
    expect(mtm.map((row) => [row.colourway?.code, row.mtm?.units, row.lineIds.length])).toEqual([
      ['BLK', 2, 2],
      ['RED', 1, 1],
    ])
    expect(mtm[0]!.figures).toMatchObject({ ordered: 2, cut: 2 })
    const grouped = groupMadeToMeasure(lines, (line) => line.lineId)
    expect(grouped.map((entry) => entry.kind)).toEqual(['mtm', 'mtm', 'line', 'line'])
  })

  it('the line’s sizes window: PiecesGrid per size (Checked = released by quality), shipped and the finish forecast; ‹ › walk and wrap', () => {
    const rows = lineRowsOf(LINES, order('IN_PRODUCTION'))
    const sizes = lineSizesOf(rows[0]!, LINES, PRODUCTION_READ.dates, 'DEMO-JKT-01 · Nero')
    expect(sizes.colourway.sizes[0]).toEqual({ size: '48', ordered: 2, cut: 2, sewn: 2, inspected: 1, packed: 0 })
    expect(sizes.sizes.map((size) => [size.size, size.finish])).toEqual([
      ['48', '2026-12-05'],
      ['50', '2026-12-08'],
      ['52', null],
      ['54', null],
    ])
    expect(sizes.units).toBeNull()
    expect(walkOf(rows, LINE_BLK, 1)).toBe(LINE_RED)
    expect(walkOf(rows, LINE_RED, 1)).toBe(LINE_BLK)
    expect(walkOf(rows, LINE_BLK, -1)).toBe(LINE_RED)
    expect(walkOf([], null, 1)).toBeNull()
  })
})

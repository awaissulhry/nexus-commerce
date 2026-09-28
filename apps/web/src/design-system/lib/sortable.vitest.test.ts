import { describe, expect, it } from 'vitest'
import { autoScrollDelta, listDropIndex, listShift, listStep, wrapDropIndex, type SortRect } from './sortable'

/* Four 40px rows with 8px gaps: tops 0, 48, 96, 144; midpoints 20, 68, 116, 164. */
const rows: SortRect[] = [0, 48, 96, 144].map(top => ({ top, left: 0, width: 300, height: 40 }))

describe('list drop index', () => {
  it('stays put until the centre passes a neighbour midpoint', () => {
    expect(listDropIndex(rows, 1, 68)).toBe(1)
    expect(listDropIndex(rows, 1, 30)).toBe(1)
    expect(listDropIndex(rows, 1, 110)).toBe(1)
  })
  it('moves up to the first row whose midpoint it passed', () => {
    expect(listDropIndex(rows, 2, 60)).toBe(1)
    expect(listDropIndex(rows, 3, 10)).toBe(0)
  })
  it('moves down to the last row whose midpoint it passed', () => {
    expect(listDropIndex(rows, 0, 70)).toBe(1)
    expect(listDropIndex(rows, 0, 170)).toBe(3)
  })
  it('clamps beyond the ends', () => {
    expect(listDropIndex(rows, 2, -500)).toBe(0)
    expect(listDropIndex(rows, 0, 5000)).toBe(3)
  })
})

describe('list shift and step', () => {
  it('slides the rows between the old and new place one step toward the hole', () => {
    expect([0, 1, 2, 3].map(i => listShift(i, 0, 2, 48))).toEqual([0, -48, -48, 0])
    expect([0, 1, 2, 3].map(i => listShift(i, 3, 1, 48))).toEqual([0, 48, 48, 0])
    expect([0, 1, 2, 3].map(i => listShift(i, 2, 2, 48))).toEqual([0, 0, 0, 0])
  })
  it('measures a step as the size plus the gap', () => {
    expect(listStep(rows, 0)).toBe(48)
    expect(listStep(rows, 3)).toBe(48)
    expect(listStep([rows[0]], 0)).toBe(40)
  })
})

describe('wrap drop index', () => {
  /* Two lines of chips: [A 0-60][B 68-128][C 136-196] on y 0-24, [D 0-60] on y 32-56. */
  const chips: SortRect[] = [
    { top: 0, left: 0, width: 60, height: 24 }, { top: 0, left: 68, width: 60, height: 24 },
    { top: 0, left: 136, width: 60, height: 24 }, { top: 32, left: 0, width: 60, height: 24 },
  ]
  it('targets the chip under the pointer and marks the side the item goes', () => {
    expect(wrapDropIndex(chips, 0, { x: 150, y: 10 })).toEqual({ to: 2, side: 'after' })
    expect(wrapDropIndex(chips, 3, { x: 70, y: 12 })).toEqual({ to: 1, side: 'before' })
  })
  it('targets the nearest chip when the pointer is between lines or chips', () => {
    expect(wrapDropIndex(chips, 0, { x: 30, y: 40 })).toEqual({ to: 3, side: 'after' })
    expect(wrapDropIndex(chips, 2, { x: 64, y: 12 })).toEqual({ to: 0, side: 'before' })
  })
  it('answers "no move" over itself', () => {
    expect(wrapDropIndex(chips, 1, { x: 90, y: 10 })).toEqual({ to: 1, side: null })
  })
})

describe('auto scroll', () => {
  it('scrolls up near the top, down near the bottom, never in the middle', () => {
    expect(autoScrollDelta(102, 100, 400)).toBeLessThan(0)
    expect(autoScrollDelta(398, 100, 400)).toBeGreaterThan(0)
    expect(autoScrollDelta(250, 100, 400)).toBe(0)
  })
  it('scrolls faster closer to the edge', () => {
    expect(Math.abs(autoScrollDelta(101, 100, 400))).toBeGreaterThan(Math.abs(autoScrollDelta(120, 100, 400)))
  })
})

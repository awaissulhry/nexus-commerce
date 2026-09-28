import { describe, expect, it } from 'vitest'
import { autoScrollDelta, gridDropIndex, gridShift, listDropIndex, previewIndex, listShift, listStep, wrapDropIndex, type SortRect } from './sortable'

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

// A photo grid: 3 tiles of 100 × 100 per line, 10 px apart, 5 tiles (two lines).
const grid: SortRect[] = [0, 1, 2, 3, 4].map(i => ({ left: (i % 3) * 110, top: Math.floor(i / 3) * 110, width: 100, height: 100 }))
const centre = (i: number, dx = 0, dy = 0) => ({ x: grid[i].left + 50 + dx, y: grid[i].top + 50 + dy })

describe('grid drop index', () => {
  it('stays in its own slot while its centre is inside it', () => {
    expect(gridDropIndex(grid, 1, centre(1, 45, -45))).toBe(1)
  })
  it('lands on the slot under its centre — along the line and onto the next line', () => {
    expect(gridDropIndex(grid, 0, centre(2))).toBe(2)
    expect(gridDropIndex(grid, 0, centre(4, 10, 10))).toBe(4)
    expect(gridDropIndex(grid, 4, centre(0))).toBe(0)
  })
  it('in a gap, takes the nearest slot; an exact tie goes to the lower index', () => {
    expect(gridDropIndex(grid, 0, { x: 215, y: 50 })).toBe(1)
    expect(gridDropIndex(grid, 4, { x: 105, y: 50 })).toBe(0)
    expect(gridDropIndex(grid, 0, { x: 105, y: 150 })).toBe(3)
  })
  it('beyond the last tile, the last slot', () => {
    expect(gridDropIndex(grid, 0, { x: 400, y: 400 })).toBe(4)
  })
})

describe('grid shift', () => {
  it('forward: the tiles between slide back into their neighbour\'s slot, across the line break', () => {
    expect(gridShift(grid, 1, 0, 3)).toEqual({ x: -110, y: 0 })
    expect(gridShift(grid, 3, 0, 3)).toEqual({ x: 220, y: -110 })
    expect(gridShift(grid, 4, 0, 3)).toEqual({ x: 0, y: 0 })
  })
  it('backward: the tiles between slide forward', () => {
    expect(gridShift(grid, 2, 4, 2)).toEqual({ x: -220, y: 110 })
    expect(gridShift(grid, 3, 4, 2)).toEqual({ x: 110, y: 0 })
    expect(gridShift(grid, 1, 4, 2)).toEqual({ x: 0, y: 0 })
  })
  it('the position each tile shows during the drag (the numbers under the tiles)', () => {
    expect([0, 1, 2, 3, 4].map(i => previewIndex(i, 0, 3))).toEqual([3, 0, 1, 2, 4])
    expect([0, 1, 2, 3, 4].map(i => previewIndex(i, 4, 1))).toEqual([0, 2, 3, 4, 1])
    expect([0, 1, 2].map(i => previewIndex(i, 1, 1))).toEqual([0, 1, 2])
  })
  it('the dragged tile and a drag with no move shift nothing', () => {
    expect(gridShift(grid, 0, 0, 3)).toEqual({ x: 0, y: 0 })
    expect(gridShift(grid, 2, 2, 2)).toEqual({ x: 0, y: 0 })
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

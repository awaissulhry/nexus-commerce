import { describe, expect, it } from 'vitest'
import { MIN_CODE_MM, mmOf, placedCount, placementProblems } from './placement'

// An A4 page (210 × 297 mm); made-up places.
const ask = (over: Partial<Parameters<typeof placementProblems>[0]> = {}) => ({ page: 1, xMm: 180, yMm: 10, sizeMm: 20, pageWidthMm: 210, pageHeightMm: 297, ...over })

describe('placementProblems (owb-ss2b b.1)', () => {
  it('a code of at least 20 mm, wholly inside the page', () => {
    expect(placementProblems(ask())).toEqual([])
    expect(placementProblems(ask({ sizeMm: MIN_CODE_MM - 0.5 })).map((problem) => problem.path)).toEqual(['body/sizeMm'])
    expect(placementProblems(ask({ xMm: 195 })).map((problem) => problem.path)).toEqual(['body/xMm'])
    expect(placementProblems(ask({ yMm: 290 })).map((problem) => problem.path)).toEqual(['body/yMm'])
    expect(placementProblems(ask({ xMm: -1, yMm: -1 })).map((problem) => problem.path)).toEqual(['body/xMm', 'body/yMm'])
    expect(placementProblems(ask({ xMm: 190, yMm: 277 }))).toEqual([])
  })

  it('a page from 1, sides above 0 and at most 2000 mm', () => {
    expect(placementProblems(ask({ page: 0 })).map((problem) => problem.path)).toEqual(['body/page'])
    expect(placementProblems(ask({ pageWidthMm: 0, pageHeightMm: 2001 })).map((problem) => problem.path)).toEqual(['body/pageWidthMm', 'body/pageHeightMm'])
  })

  it('kept with 2 decimals; counted, never a stop', () => {
    expect(mmOf(12.346)).toBe('12.35')
    expect(placedCount([{ placed: true }, { placed: false }, { placed: false }])).toEqual({ done: 1, of: 3 })
  })
})

import { describe, expect, it } from 'vitest'
import { defaultZeroReason, nextRatingFilter, ratingBarRows, ratingPercents, ratingTotal, type RatingCounts } from './ratingBarsModel'

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

describe('ratingPercents — whole numbers that add up to 100', () => {
  it('keeps the plain rounding when it already adds up', () => {
    expect(ratingPercents([82, 25, 8, 5, 8])).toEqual([64, 20, 6, 4, 6])
  })
  it('gives the leftover points to the largest remainders', () => {
    // 33.3 · 33.3 · 33.3 → plain rounding says 99
    const p = ratingPercents([1, 1, 1, 0, 0])
    expect(sum(p)).toBe(100)
    expect(p).toEqual([34, 33, 33, 0, 0])
  })
  it('never goes over 100', () => {
    // 16.67 × 6 would round to 102 over six; five rows with .5s
    const p = ratingPercents([1, 1, 1, 1, 4])
    expect(sum(p)).toBe(100)
  })
  it('is all zero when there are no ratings', () => {
    expect(ratingPercents([0, 0, 0, 0, 0])).toEqual([0, 0, 0, 0, 0])
    expect(ratingTotal([0, 0, 0, 0, 0])).toBe(0)
  })
  it('ignores negative and broken counts', () => {
    expect(ratingTotal([3, -1, Number.NaN, 2.4, 0] as unknown as RatingCounts)).toBe(5)
  })
})

describe('ratingBarRows', () => {
  it('runs 5 stars first and names each bar in words', () => {
    const rows = ratingBarRows([82, 25, 8, 5, 8])
    expect(rows.map(r => r.stars)).toEqual([5, 4, 3, 2, 1])
    expect(rows[0].label).toBe('5 stars: 82 ratings, 64%')
    expect(ratingBarRows([0, 0, 0, 0, 1])[4].label).toBe('1 star: 1 rating, 100%')
  })
  it('holds a bar with no ratings and says why', () => {
    const rows = ratingBarRows([41, 12, 0, 3, 9])
    expect(rows[2].heldReason).toBe('No 3-star ratings to show')
    expect(rows[0].heldReason).toBeNull()
    expect(defaultZeroReason(1)).toBe('No 1-star ratings to show')
    expect(ratingBarRows([1, 0, 0, 0, 0], s => `none at ${s}`)[1].heldReason).toBe('none at 4')
  })
})

describe('nextRatingFilter', () => {
  it('picks a bar, and clears the filter when the pressed bar is pressed again', () => {
    expect(nextRatingFilter(null, 5)).toBe(5)
    expect(nextRatingFilter(5, 1)).toBe(1)
    expect(nextRatingFilter(1, 1)).toBeNull()
  })
  it('changes nothing for a held bar', () => {
    expect(nextRatingFilter(4, 3, true)).toBe(4)
    expect(nextRatingFilter(undefined, 3, true)).toBeNull()
  })
})

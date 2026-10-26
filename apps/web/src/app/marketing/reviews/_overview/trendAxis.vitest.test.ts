import { describe, expect, it } from 'vitest'
import { ratingAxis } from './TrendCard'

describe('ratingAxis', () => {
  it('starts at 3 with half-star ticks when every average is 3 or more', () => {
    expect(ratingAxis([{ avg: 4.2 }, { avg: null }, { avg: 3.4 }])).toEqual({ domain: [3, 5], ticks: [3, 3.5, 4, 4.5, 5] })
  })
  it('goes lower when an average does, so no point is cut off', () => {
    expect(ratingAxis([{ avg: 2.4 }, { avg: 4.8 }])).toEqual({ domain: [2, 5], ticks: [2, 3, 4, 5] })
  })
  it('keeps 3–5 when there is no average yet', () => {
    expect(ratingAxis([{ avg: null }])).toEqual({ domain: [3, 5], ticks: [3, 3.5, 4, 4.5, 5] })
  })
})

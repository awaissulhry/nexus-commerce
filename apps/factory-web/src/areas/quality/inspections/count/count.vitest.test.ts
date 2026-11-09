import { describe, expect, it } from 'vitest'
import { countPercent, inlineSampleOf } from './model'

/** B-W2b-213: "38 of 50" on the office's one list. */
describe('the inspected count', () => {
  it("an in-process check's frozen sample and its units counted", () => {
    expect(inlineSampleOf({ sampleSize: 3, inspected: 2 })).toEqual({ key: 'sample.nOf', params: { done: 2, sample: 3 } })
    expect(inlineSampleOf({ sampleSize: 3, inspected: null })).toEqual({ key: 'sample.nOf', params: { done: 0, sample: 3 } })
    expect(inlineSampleOf({ sampleSize: null, inspected: null })).toEqual({ key: 'none' })
    expect(inlineSampleOf({})).toEqual({ key: 'none' })
  })

  it('a bar of the units counted', () => {
    expect(countPercent(38, 50)).toBe(76)
    expect(countPercent(60, 50)).toBe(100)
    expect(countPercent(null, 50)).toBeNull()
    expect(countPercent(3, 0)).toBeNull()
  })
})

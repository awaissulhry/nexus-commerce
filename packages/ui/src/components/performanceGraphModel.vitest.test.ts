import { describe, expect, it } from 'vitest'
import { axisScale, isolatedPoints } from './performanceGraphModel'

describe('isolatedPoints', () => {
  it('marks a value with no value on either side', () => {
    expect([...isolatedPoints([null, 4.2, null])]).toEqual([1])
    expect([...isolatedPoints([4.5, null, 4.1, 4.3, null, 3.9])]).toEqual([0, 5])
    expect([...isolatedPoints([4])]).toEqual([0])
  })
  it('leaves values a line already reaches, and empties', () => {
    expect(isolatedPoints([4.1, 4.3, 4.2]).size).toBe(0)
    expect(isolatedPoints([null, undefined, Number.NaN, '4']).size).toBe(0)
    expect(isolatedPoints([]).size).toBe(0)
  })
})

describe('axisScale', () => {
  it('fixes a 5-star axis at 0–5 with its own ticks', () => {
    expect(axisScale({ domain: [0, 5], ticks: [5, 0, 1, 2, 3, 4] })).toEqual({ domain: [0, 5], ticks: [0, 1, 2, 3, 4, 5] })
  })
  it('fits to the data when nothing is given, and ignores a broken domain or ticks outside it', () => {
    expect(axisScale({})).toEqual({})
    expect(axisScale(null)).toEqual({})
    expect(axisScale({ domain: [5, 0] })).toEqual({})
    expect(axisScale({ domain: [0, 5], ticks: [0, 2.5, 5, 8] })).toEqual({ domain: [0, 5], ticks: [0, 2.5, 5] })
    expect(axisScale({ ticks: [] })).toEqual({})
  })
})

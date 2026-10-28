import { describe, expect, it } from 'vitest'

import { sparkGeometry, sparkSummary, sparkWords } from './sparklineModel'

const box = { width: 22, height: 12, pad: 1 }

describe('sparkGeometry', () => {
  it('draws a step: the old value holds until the new one is set (never a slope)', () => {
    const g = sparkGeometry([2, 4, 4], 'step', box)
    // x: 1, 11, 21 · y: low 2 → 11, high 4 → 1
    expect(g.path).toBe('M 1 11 L 11 11 L 11 1 L 21 1')
    expect(g.last).toEqual({ x: 21, y: 1 })
    expect(g).toMatchObject({ count: 3, min: 2, max: 4, dots: [] })
  })

  it('draws a line when asked', () => {
    expect(sparkGeometry([2, 4], 'line', box).path).toBe('M 1 11 L 21 1')
  })

  it('keeps a null\'s slot and breaks the line there; a lone reading is a dot', () => {
    const g = sparkGeometry([2, null, 4, 4, null, 3], 'line', { width: 52, height: 12, pad: 1 })
    expect(g.path).toBe('M 21 1 L 31 1')
    expect(g.dots).toEqual([{ x: 1, y: 11 }, { x: 51, y: 6 }])
    expect(g.count).toBe(4)
  })

  it('a flat series sits at mid-height; one reading is a centred dot', () => {
    expect(sparkGeometry([5, 5], 'step', box).path).toBe('M 1 6 L 21 6')
    const one = sparkGeometry([5], 'step', box)
    expect(one.path).toBe('')
    expect(one.dots).toEqual([{ x: 11, y: 6 }])
    expect(one.last).toEqual({ x: 11, y: 6 })
  })

  it('a fixed axis: [0, null] draws from zero, so a small change stays small; the readings\' low and high are unchanged', () => {
    // Without an axis 10 → 11 fills the box (y 11 → 1); from zero it moves less than a pixel (y 1.9 → 1).
    expect(sparkGeometry([10, 11], 'line', box).path).toBe('M 1 11 L 21 1')
    const fromZero = sparkGeometry([10, 11], 'line', box, [0, null])
    expect(fromZero.path).toBe('M 1 1.9 L 21 1')
    expect(fromZero).toMatchObject({ min: 10, max: 11 })
    // A flat series on a fixed axis sits at its own height, not mid-box.
    expect(sparkGeometry([5, 5], 'step', box, [0, 10]).path).toBe('M 1 6 L 21 6')
    expect(sparkGeometry([10, 10], 'step', box, [0, null]).path).toBe('M 1 1 L 21 1')
  })

  it('a reading outside the axis widens it (never cut off); a non-number end is the readings\' own', () => {
    expect(sparkGeometry([2, 30], 'line', box, [0, 20]).path).toBe('M 1 10.3 L 21 1')
    expect(sparkGeometry([2, 4], 'line', box, [Number.NaN, null]).path).toBe(sparkGeometry([2, 4], 'line', box).path)
  })

  it('nothing to draw is said, not drawn as a flat value', () => {
    expect(sparkGeometry([], 'step', box)).toEqual({ path: '', dots: [], last: null, count: 0, min: null, max: null })
    expect(sparkGeometry([null, undefined, Number.NaN], 'step', box).count).toBe(0)
  })
})

describe('sparkSummary', () => {
  const eur = (n: number) => `€${n.toFixed(2)}`
  it('says low, high and now in the host\'s format', () => {
    expect(sparkSummary('Bid, 14 days', [0.4, 0.1, null, 0.3], eur)).toBe('Bid, 14 days: 3 readings, low €0.10, high €0.40, now €0.30')
  })
  it('one reading, a flat series, and nothing at all', () => {
    expect(sparkSummary('Bid', [0.2], eur)).toBe('Bid: 1 reading, €0.20')
    expect(sparkSummary('Bid', [0.2, 0.2], eur)).toBe('Bid: 2 readings, all €0.20')
    expect(sparkSummary('Bid', [])).toBe('Bid: No changes')
    expect(sparkSummary('Clicks', [null], String, 'No data')).toBe('Clicks: No data')
  })
})

describe('sparkWords', () => {
  it('is the summary without its label', () => {
    expect(sparkWords([1, 3, 2])).toBe('3 readings, low 1, high 3, now 2')
    expect(sparkWords([], String, 'No data')).toBe('No data')
  })
})

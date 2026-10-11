import { describe, expect, it } from 'vitest'

import { TAB_FADE, revealDelta, stripEdges, stripStep } from './tabsScroll'

describe('stripEdges — which edge has more tabs', () => {
  it('a strip that fits has none', () => {
    expect(stripEdges({ scrollLeft: 0, clientWidth: 800, scrollWidth: 800 })).toEqual({ start: false, end: false })
  })
  it('at the start only the end has more; in the middle both; at the end only the start', () => {
    expect(stripEdges({ scrollLeft: 0, clientWidth: 400, scrollWidth: 1000 })).toEqual({ start: false, end: true })
    expect(stripEdges({ scrollLeft: 300, clientWidth: 400, scrollWidth: 1000 })).toEqual({ start: true, end: true })
    expect(stripEdges({ scrollLeft: 600, clientWidth: 400, scrollWidth: 1000 })).toEqual({ start: true, end: false })
  })
  it('a pixel of rounding is not more', () => {
    expect(stripEdges({ scrollLeft: 0.6, clientWidth: 400, scrollWidth: 1000.5 })).toEqual({ start: false, end: true })
    expect(stripEdges({ scrollLeft: 599.5, clientWidth: 400, scrollWidth: 1000 })).toEqual({ start: true, end: false })
  })
})

describe('stripStep — one arrow press', () => {
  it('moves most of the visible strip, at least 80 px', () => {
    expect(stripStep(1000)).toBe(800)
    expect(stripStep(60)).toBe(80)
  })
})

describe('revealDelta — a focused or active tab is never left cut', () => {
  const strip = { left: 100, right: 500 }
  it('a tab already clear does not move the strip', () => {
    expect(revealDelta(strip, { left: 200, right: 280 }, { scrollLeft: 100, clientWidth: 400, scrollWidth: 1200 })).toBe(0)
  })
  it('a tab cut at the right edge comes in, clear of the fade there', () => {
    expect(revealDelta(strip, { left: 450, right: 540 }, { scrollLeft: 0, clientWidth: 400, scrollWidth: 1200 })).toBe(540 - (500 - TAB_FADE))
  })
  it('a tab cut at the left edge comes in, clear of the fade there', () => {
    expect(revealDelta(strip, { left: 80, right: 160 }, { scrollLeft: 300, clientWidth: 400, scrollWidth: 1200 })).toBe(80 - (100 + TAB_FADE))
  })
  it('at the strip\'s own end there is no fade to clear, and it never scrolls past the end', () => {
    // Scrolled to the end: the last tab only needs to be inside the strip.
    expect(revealDelta(strip, { left: 420, right: 498 }, { scrollLeft: 800, clientWidth: 400, scrollWidth: 1200 })).toBe(0)
    // The wanted move is clamped to what is left to scroll.
    expect(revealDelta(strip, { left: 450, right: 560 }, { scrollLeft: 780, clientWidth: 400, scrollWidth: 1200 })).toBe(20)
    expect(revealDelta(strip, { left: 90, right: 150 }, { scrollLeft: 5, clientWidth: 400, scrollWidth: 1200 })).toBe(-5)
  })
  it('a tab wider than the room shows its start', () => {
    expect(revealDelta(strip, { left: 300, right: 900 }, { scrollLeft: 100, clientWidth: 400, scrollWidth: 1200 })).toBe(300 - (100 + TAB_FADE))
  })
})

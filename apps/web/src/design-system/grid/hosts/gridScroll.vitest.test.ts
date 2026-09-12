import { describe, expect, it } from 'vitest'

import { clampScrollLeft, gridColumnLeft, gridColumnRight, gridScrollState, panelOverlap, scrollGridTo, type ScrollMetrics } from './gridScroll'

const metrics = (over: Partial<ScrollMetrics> = {}): ScrollMetrics => ({
  scrollLeft: 0,
  scrollWidth: 2749,
  clientWidth: 1660,
  ...over,
})

describe('gridScrollState', () => {
  it('reports what the grid can give', () => {
    expect(gridScrollState(metrics({ scrollLeft: 490 }))).toEqual({ scrollLeft: 490, maxScroll: 1089 })
  })

  it('answers null for an absent viewport — "no viewport" and "will not scroll" are one answer', () => {
    expect(gridScrollState(null)).toBeNull()
    expect(gridScrollState(undefined)).toBeNull()
  })

  it('floors maxScroll at 0 so a caller can never be handed a negative range', () => {
    // A grid narrower than its viewport reports scrollWidth < clientWidth at some zoom levels.
    expect(gridScrollState(metrics({ scrollWidth: 800, clientWidth: 1000 }))!.maxScroll).toBe(0)
  })
})

describe('clampScrollLeft', () => {
  const state = { scrollLeft: 0, maxScroll: 1089 }

  it('takes a position inside the range unchanged', () => {
    expect(clampScrollLeft(810, state)).toBe(810)
  })

  it('clamps past the end to maxScroll — the trailing-column case', () => {
    // A column within a panel-width of the end cannot be fully cleared; the grid gives what it has
    // and `revealScroll.unreachableBy` is what reports the shortfall.
    expect(clampScrollLeft(5000, state)).toBe(1089)
  })

  it('never goes negative', () => {
    expect(clampScrollLeft(-200, state)).toBe(0)
  })

  it('rounds, because the DOM stores an integer and a caller compares against what it holds', () => {
    expect(clampScrollLeft(810.4, state)).toBe(810)
    expect(clampScrollLeft(810.6, state)).toBe(811)
  })

  it('🔴 refuses a non-finite target rather than blanking the scroll position', () => {
    // NaN reaches here when an upstream measurement was missing — `Math.min(NaN, …)` is NaN, and
    // assigning NaN to `scrollLeft` silently jumps the grid to 0. Staying put is the honest answer.
    expect(clampScrollLeft(NaN, { scrollLeft: 490, maxScroll: 1089 })).toBe(490)
    expect(clampScrollLeft(Infinity, { scrollLeft: 490, maxScroll: 1089 })).toBe(490)
  })
})

describe('scrollGridTo', () => {
  it('sets the position and reports what was taken', () => {
    const el = { scrollLeft: 0, scrollWidth: 2749, clientWidth: 1660 } as unknown as HTMLElement
    expect(scrollGridTo(el, 810)).toBe(810)
    expect(el.scrollLeft).toBe(810)
  })

  it('reports the CLAMPED position, not the one asked for', () => {
    const el = { scrollLeft: 0, scrollWidth: 2749, clientWidth: 1660 } as unknown as HTMLElement
    expect(scrollGridTo(el, 9999)).toBe(1089)
    expect(el.scrollLeft).toBe(1089)
  })

  it('answers null with no viewport, and touches nothing', () => {
    expect(scrollGridTo(null, 400)).toBeNull()
    expect(scrollGridTo(undefined, 400)).toBeNull()
  })
})

/**
 * Validated against the live grid: for every RENDERED centre column the computed right edge matched
 * `getBoundingClientRect().right` to **0px** (7 of 7, GALE-JACKET at 1728). These lock the formula.
 */
describe('gridColumnRight', () => {
  // The measured shape: grid root at 67, a 389px pinned block, scrolled 165.
  const base = { hostLeft: 67, pinnedLeftWidth: 389, scrollLeft: 165 }

  it('matches the measured geometry of a rendered column', () => {
    // `name`: getLeft() 0, width 380 → 67 + 389 + (0 − 165) + 380 = 671, which is what the DOM read.
    expect(gridColumnRight({ ...base, columnLeft: 0, columnWidth: 380 })).toBe(671)
    // `status`: getLeft() 380, width 110 → 781.
    expect(gridColumnRight({ ...base, columnLeft: 380, columnWidth: 110 })).toBe(781)
    // `country_of_origin`: getLeft() 1100, width 130 → 1521.
    expect(gridColumnRight({ ...base, columnLeft: 1100, columnWidth: 130 })).toBe(1521)
  })

  it('moves LEFT as the grid scrolls right, one pixel per pixel', () => {
    const at = (scrollLeft: number) => gridColumnRight({ ...base, scrollLeft, columnLeft: 1100, columnWidth: 130 })
    expect(at(0) - at(165)).toBe(165)
    expect(at(165) - at(1089)).toBe(924)
  })

  it('works for a column that is not rendered — the whole reason it is arithmetic', () => {
    // A far-right column at scroll 0 sits well outside the viewport; there is no rect to read, and
    // the number is still exact.
    expect(gridColumnRight({ hostLeft: 67, pinnedLeftWidth: 389, scrollLeft: 0, columnLeft: 2600, columnWidth: 160 })).toBe(3216)
  })
})

/**
 * The LEFT edges, added for `revealDistance(geo, 'reveal')` (#412/#416/#428). Without them that
 * branch returns 0, so a `?cell=` deep link whose target is off-screen to the LEFT — the normal case
 * once `useGridState` restores a persisted scroll — lands nowhere, silently.
 */
/**
 * 🔴 #516 — a position the grid already holds is not a scroll. `revealColumn` refuses a distance of
 * exactly 0, but a NEGATIVE distance under `intent: 'reveal'` clamps to 0 when the grid is already
 * at 0, and that reached the DOM as a write of the value it already had (UX.1, `brand @1440`).
 */
describe('scrollGridTo — a no-op is not a write', () => {
  const el = (scrollLeft: number) => ({ scrollLeft, scrollWidth: 2000, clientWidth: 1000 })

  it('does NOT touch the DOM when the clamped target is where it already is', () => {
    const v = el(0)
    expect(scrollGridTo(v as unknown as HTMLElement, 0)).toBe(0)
    expect(v.scrollLeft).toBe(0)
  })

  it('does not write when a NEGATIVE target clamps onto the current position', () => {
    // The measured case: `revealScroll` asks to go left from 0, the clamp floors it at 0.
    const v = el(0)
    expect(scrollGridTo(v as unknown as HTMLElement, -240)).toBe(0)
    expect(v.scrollLeft).toBe(0)
  })

  it('does not write when a target beyond the maximum clamps onto the current position', () => {
    const v = el(1000) // maxScroll is 2000 - 1000 = 1000, so it is already at the end
    expect(scrollGridTo(v as unknown as HTMLElement, 9999)).toBe(1000)
    expect(v.scrollLeft).toBe(1000)
  })

  it('still writes, and still reports the landing position, when the grid must actually move', () => {
    const v = el(0)
    expect(scrollGridTo(v as unknown as HTMLElement, 243)).toBe(243)
    expect(v.scrollLeft).toBe(243)
  })
})

describe('gridColumnLeft', () => {
  const base = { hostLeft: 67, pinnedLeftWidth: 389, scrollLeft: 0 }

  it('is the column offset placed after the host edge and the pinned block', () => {
    expect(gridColumnLeft({ ...base, columnLeft: 0 })).toBe(456)
    expect(gridColumnLeft({ ...base, columnLeft: 380 })).toBe(836)
  })

  /** 🔴 The invariant PES.4's consumer relies on: the two edges differ by exactly the width. */
  it('is `gridColumnRight` minus the column width, at every scroll position', () => {
    for (const scrollLeft of [0, 93, 333, 1067, 1227]) {
      const geo = { ...base, scrollLeft, columnLeft: 1100 }
      expect(gridColumnLeft(geo)).toBe(gridColumnRight({ ...geo, columnWidth: 130 }) - 130)
    }
  })

  it('goes NEGATIVE relative to the scrollable region once scrolled past — which is the whole point', () => {
    const viewportLeft = base.hostLeft + base.pinnedLeftWidth // 456
    // At scroll 1067 a column sitting at offset 380 is 687px to the left of where the centre begins.
    expect(gridColumnLeft({ ...base, scrollLeft: 1067, columnLeft: 380 }) - viewportLeft).toBe(-687)
    // `cellLeft - viewportLeft === columnLeft - scrollLeft`, whatever the host or pinned widths are.
    for (const [hostLeft, pinnedLeftWidth] of [[0, 0], [67, 389], [200, 12]]) {
      const g = { hostLeft, pinnedLeftWidth, scrollLeft: 1067, columnLeft: 380 }
      expect(gridColumnLeft(g) - (hostLeft + pinnedLeftWidth)).toBe(380 - 1067)
    }
  })

  /**
   * 🔴 Why `viewportLeft` adds the pinned block while `viewportRight` does not (#428, and PES.4
   * reached the same rule independently). The panel OVERLAYS the right edge; the pinned block
   * OCCUPIES the left. A centre column scrolled under the pinned block is hidden, not visible — so
   * measuring the left against the host's own box would report it on screen and `'reveal'` would
   * answer "nothing to do" for exactly the case it exists to fix.
   */
  it('treats a column hidden BEHIND the pinned block as off screen, not as visible', () => {
    const g = { hostLeft: 67, pinnedLeftWidth: 389, scrollLeft: 300, columnLeft: 100 }
    const cellLeft = gridColumnLeft(g)          // 67 + 389 + (100 - 300) = 256
    expect(cellLeft).toBe(256)
    expect(cellLeft).toBeGreaterThan(g.hostLeft)                       // inside the ROOT box…
    expect(cellLeft).toBeLessThan(g.hostLeft + g.pinnedLeftWidth)      // …but behind the pinned block
  })
})

/**
 * `panelOverlap` — the number the reveal rule always needed, where `panelWidth` was a coincidence
 * that held only while the panel overlaid the sheet (#408).
 */
describe('panelOverlap', () => {
  it('is the panel width when the panel OVERLAYS the grid — the old reading, still correct', () => {
    // Grid 67..1279, panel starts at 759: the panel hides the last 520px of grid.
    expect(panelOverlap(1279, 759)).toBe(520)
  })

  it('🔴 is ZERO when the sheet is INSET beside the panel — the case that broke the rule', () => {
    // Measured 2026-09-02 at 1280: grid 67..759, panel 760..1280. It covers nothing.
    expect(panelOverlap(759, 760)).toBe(0)
    // The old reading put the "covered" threshold at 759 - 520 - 16 = 223, inside a grid
    // spanning 67..759, so nearly every cell read as covered while nothing was covered at all.
    expect(759 - panelOverlap(759, 760) - 16).toBe(743)
  })

  it('never goes negative — a panel further right than the grid still covers nothing', () => {
    expect(panelOverlap(759, 1200)).toBe(0)
  })

  it('treats "no panel open" as no coverage, and says so with null rather than a magic number', () => {
    expect(panelOverlap(1279, null)).toBe(0)
    expect(panelOverlap(1279, undefined)).toBe(0)
    expect(panelOverlap(1279, Number.NaN)).toBe(0)
  })

  it('covers the WHOLE grid when the panel starts left of it', () => {
    expect(panelOverlap(759, 0)).toBe(759)
  })
})

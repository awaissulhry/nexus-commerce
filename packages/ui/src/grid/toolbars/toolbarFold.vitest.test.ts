import { describe, expect, it } from 'vitest'

import { nextToolbarOverflowWidth } from './GridToolbarFold'

/**
 * The toolbar's monotone threshold rule, tested where it CAN be tested: `apps/web` vitest is
 * node-only, so the hooks around it (ResizeObserver, `closest('.nds-toolbar')`) belong to the screen
 * reading. What is testable here is the decision itself, and it is the part with the two arms that
 * matter — a tier that latches when it should not, and a tier that never releases.
 */
describe('nextToolbarOverflowWidth (R-LX-18 tiers 1-2, R-LX-27 tier 3)', () => {
  it('latches on an overflow it is armed for, and remembers the EXPANDED width', () => {
    expect(nextToolbarOverflowWidth(null, { scrollWidth: 1444, clientWidth: 1372 })).toBe(1444)
  })

  it('does NOT latch while unarmed — R-LX-27 tier 3 before the cheaper folds have run', () => {
    // The arm that makes "last tier" true: the same overflow the chips fold on must NOT compact the
    // status pills in the same commit.
    expect(nextToolbarOverflowWidth(null, { scrollWidth: 1444, clientWidth: 1372 }, false)).toBeNull()
    // …and once the tier above has engaged, the same reading latches.
    expect(nextToolbarOverflowWidth(null, { scrollWidth: 1444, clientWidth: 1372 }, true)).toBe(1444)
  })

  it('does not latch on a bar that fits, including the 1px sub-pixel tolerance', () => {
    expect(nextToolbarOverflowWidth(null, { scrollWidth: 1372, clientWidth: 1372 })).toBeNull()
    expect(nextToolbarOverflowWidth(null, { scrollWidth: 1373, clientWidth: 1372 })).toBeNull()
    expect(nextToolbarOverflowWidth(null, { scrollWidth: 1374, clientWidth: 1372 })).toBe(1374)
  })

  it('releases only at the width that held the bar expanded — never at the folded width', () => {
    // Latched at 1444. The fold has since made the bar NARROWER (1358): a naive "does it fit now?"
    // would release here and re-latch on the next frame, which is the oscillation this rule forbids.
    expect(nextToolbarOverflowWidth(1444, { scrollWidth: 1358, clientWidth: 1372 })).toBe(1444)
    expect(nextToolbarOverflowWidth(1444, { scrollWidth: 1358, clientWidth: 1443 })).toBe(1444)
    expect(nextToolbarOverflowWidth(1444, { scrollWidth: 1358, clientWidth: 1444 })).toBeNull()
    expect(nextToolbarOverflowWidth(1444, { scrollWidth: 1358, clientWidth: 1660 })).toBeNull()
  })

  it('releases regardless of `armed`, so a tier can never be trapped folded', () => {
    expect(nextToolbarOverflowWidth(1444, { scrollWidth: 1358, clientWidth: 1660 }, false)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { computeDropdownPosition, MIN_DROPDOWN_WIDTH } from './dropdown-position'

// Common viewport for the tests
const VP = { viewportWidth: 1280, viewportHeight: 800 }

function cellAt({ top, left = 100, width = 120, height = 28 }: { top: number; left?: number; width?: number; height?: number }) {
  return { top, bottom: top + height, left, width }
}

describe('computeDropdownPosition', () => {
  it('opens below the cell when there is room', () => {
    const cell = cellAt({ top: 100 })
    const pos = computeDropdownPosition({ cell, menuHeight: 300, ...VP })
    expect(pos.openUp).toBe(false)
    expect(pos.top).toBe(cell.bottom)
    expect(pos.left).toBe(cell.left)
  })

  it('flips above when the bottom space is insufficient and there is more room above', () => {
    const cell = cellAt({ top: 700 }) // bottom = 728, only ~64px below
    const pos = computeDropdownPosition({ cell, menuHeight: 300, ...VP })
    expect(pos.openUp).toBe(true)
    expect(pos.top).toBe(cell.top - 300) // bottom edge sits on the cell's top
  })

  it('stays below (clamped) when neither side fits but below has more room', () => {
    const cell = cellAt({ top: 100 }) // above: 92, below: 672
    const pos = computeDropdownPosition({ cell, menuHeight: 750, ...VP })
    expect(pos.openUp).toBe(false)
    // Clamped into the viewport instead of overflowing the bottom edge
    expect(pos.top).toBe(800 - 8 - 750)
    expect(pos.top).toBeGreaterThanOrEqual(8)
  })

  it('clamps a flipped menu that would overflow the top edge', () => {
    const cell = cellAt({ top: 300 }) // above: 292, below: 464
    // menu taller than below-space and above > below is false here — force the
    // flip case with a cell near the bottom instead
    const lowCell = cellAt({ top: 760 })
    const pos = computeDropdownPosition({ cell: lowCell, menuHeight: 780, ...VP })
    expect(pos.openUp).toBe(true)
    expect(pos.top).toBe(8) // pinned to the top margin, not negative
    void cell
  })

  it('is never narrower than MIN_DROPDOWN_WIDTH and never narrower than the cell', () => {
    const narrow = computeDropdownPosition({ cell: cellAt({ top: 100, width: 80 }), menuHeight: 200, ...VP })
    expect(narrow.width).toBe(MIN_DROPDOWN_WIDTH)
    const wide = computeDropdownPosition({ cell: cellAt({ top: 100, width: 400 }), menuHeight: 200, ...VP })
    expect(wide.width).toBe(400)
  })

  it('clamps horizontally so the menu stays inside the right edge', () => {
    const cell = cellAt({ top: 100, left: 1200, width: 120 })
    const pos = computeDropdownPosition({ cell, menuHeight: 200, ...VP })
    expect(pos.left).toBe(1280 - 8 - MIN_DROPDOWN_WIDTH)
  })

  it('clamps horizontally at the left margin for cells hanging off-screen', () => {
    const cell = cellAt({ top: 100, left: -40, width: 120 })
    const pos = computeDropdownPosition({ cell, menuHeight: 200, ...VP })
    expect(pos.left).toBe(8)
  })

  it('prefers below when spaces are equal (no gratuitous flip)', () => {
    // cell centred: above == below
    const cell = { top: 390, bottom: 410, left: 100, width: 120 }
    const pos = computeDropdownPosition({ cell, menuHeight: 500, viewportWidth: 1280, viewportHeight: 800 })
    expect(pos.openUp).toBe(false)
  })
})

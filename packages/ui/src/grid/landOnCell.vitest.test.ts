/**
 * landOnCell (2026-09-26) — "Go to <field>" from a progress card. The order matters: a child under a closed parent has
 * no row index until the parent opens, and a hidden column cannot take the cursor.
 */
import { describe, expect, it, vi } from 'vitest'
import { LANDING_CLASS, LANDING_DRAW_FRAMES, collapsedAncestors, focusIsFree, landOnCell, type LandingRowNode } from './landOnCell'

const tree = () => {
  const root: LandingRowNode = { id: 'root', rowIndex: null, level: -1 }
  const parent: LandingRowNode = { id: 'p', rowIndex: 0, level: 0, expanded: false, parent: root, setExpanded: vi.fn(function (this: LandingRowNode, v: boolean) { parent.expanded = v; child.rowIndex = 3 }) }
  const child: LandingRowNode = { id: 'c1', rowIndex: null, level: 1, parent }
  return { root, parent, child }
}
const fakeApi = (nodes: Record<string, LandingRowNode>, hidden = false) => ({
  getRowNode: (id: string) => nodes[id],
  ensureIndexVisible: vi.fn(), ensureColumnVisible: vi.fn(), setFocusedCell: vi.fn(),
  getColumn: () => ({ isVisible: () => !hidden }), setColumnsVisible: vi.fn(), isDestroyed: () => false,
})

describe('landOnCell', () => {
  it('lists collapsed ancestors outermost first, and none for a top-level row', () => {
    const { parent, child } = tree()
    expect(collapsedAncestors(child)).toEqual([parent])
    expect(collapsedAncestors(parent)).toEqual([])
  })
  it('opens the parent, then scrolls the row to the middle and puts the cursor in the cell', () => {
    const { parent, child } = tree()
    const api = fakeApi({ c1: child })
    const frames: Array<() => void> = []
    expect(landOnCell(api, { rowId: 'c1', colId: 'brand', schedule: fn => frames.push(fn), root: { querySelectorAll: () => [] } as never })).toBe(true)
    expect(parent.setExpanded).toHaveBeenCalledWith(true)
    expect(api.setFocusedCell).not.toHaveBeenCalled() // not before AG has re-indexed
    frames.shift()!()
    expect(api.ensureIndexVisible).toHaveBeenCalledWith(3, 'middle')
    expect(api.ensureColumnVisible).toHaveBeenCalledWith('brand', 'auto')
    expect(api.setFocusedCell).toHaveBeenCalledWith(3, 'brand')
  })
  it("uses the sheet's own reveal when given one", () => {
    const { child } = tree()
    child.rowIndex = 5
    const api = fakeApi({ c1: child })
    const reveal = vi.fn()
    const frames: Array<() => void> = []
    landOnCell(api, { rowId: 'c1', colId: 'brand', reveal, schedule: fn => frames.push(fn), root: { querySelectorAll: () => [] } as never })
    frames.shift()!()
    expect(reveal).toHaveBeenCalledWith('brand')
    expect(api.ensureColumnVisible).not.toHaveBeenCalled()
  })
  it('shows a hidden column first — the cursor cannot land on a column nobody can see', () => {
    const { child } = tree()
    const api = fakeApi({ c1: child }, true)
    landOnCell(api, { rowId: 'c1', colId: 'material', schedule: () => undefined })
    expect(api.setColumnsVisible).toHaveBeenCalledWith(['material'], true)
  })
  it('says false for a row that is not in the grid, so the caller can say so', () => {
    expect(landOnCell(fakeApi({}), { rowId: 'gone', colId: 'brand', schedule: () => undefined })).toBe(false)
  })

  // Review 2026-10-02: AG focuses only a DRAWN cell, and the landing scrolls first — so the cursor was set while the
  // cell did not exist yet, and the browser's focus stayed on <body>.
  const fakeCell = () => ({ classList: { add: vi.fn(), remove: vi.fn() }, offsetWidth: 0, contains: () => false })
  const drawnAfter = (frames: number, cell: ReturnType<typeof fakeCell>) => {
    let polls = 0
    return { querySelectorAll: () => (++polls > frames ? [cell] : []) } as never
  }

  it('waits for AG to draw the cell, then marks it and sets the cursor again so the browser focuses it', () => {
    const { child } = tree() // its parent is collapsed: opening it gives the child row index 3
    const api = fakeApi({ c1: child })
    const cell = fakeCell()
    const frames: Array<() => void> = []
    landOnCell(api, { rowId: 'c1', colId: 'brand', schedule: fn => frames.push(fn), root: drawnAfter(2, cell) })
    frames.shift()!() // scroll + first cursor
    expect(api.setFocusedCell).toHaveBeenCalledTimes(1)
    frames.shift()!(); frames.shift()!() // not drawn yet: keeps waiting
    expect(cell.classList.add).not.toHaveBeenCalled()
    frames.shift()!() // drawn
    expect(cell.classList.add).toHaveBeenCalledWith(LANDING_CLASS)
    expect(api.setFocusedCell).toHaveBeenCalledTimes(2)
    expect(api.setFocusedCell).toHaveBeenLastCalledWith(3, 'brand')
    expect(frames).toHaveLength(0)
  })

  it('stops waiting after LANDING_DRAW_FRAMES and keeps only the grid cursor', () => {
    const { child } = tree()
    const api = fakeApi({ c1: child })
    const frames: Array<() => void> = []
    landOnCell(api, { rowId: 'c1', colId: 'brand', schedule: fn => frames.push(fn), root: { querySelectorAll: () => [] } as never })
    let ran = 0
    while (frames.length && ran < 50) { frames.shift()!(); ran++ }
    expect(ran).toBe(1 + LANDING_DRAW_FRAMES)
    expect(api.setFocusedCell).toHaveBeenCalledTimes(1)
  })

  it('never takes focus the operator moved elsewhere; takes it from <body>, nothing, or another grid cell', () => {
    const cell = { contains: (el: unknown) => el === inside }
    const inside = { closest: () => ({}) }
    const gridCell = { closest: (sel: string) => (sel === '.ag-root-wrapper' ? {} : null) }
    const input = { closest: () => null }
    expect(focusIsFree([cell as never], null)).toBe(true)
    expect(focusIsFree([cell as never], gridCell as never)).toBe(true)
    expect(focusIsFree([cell as never], input as never)).toBe(false)
    expect(focusIsFree([cell as never], inside as never)).toBe(false) // already there
  })
})

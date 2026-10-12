import { describe, expect, it } from 'vitest'

import { anyEditable, interactionDefaults, isSpreadsheet, leaveGridOnTab } from './gridDefaults'

describe('the engine\'s interaction defaults', () => {
  it('a reading grid: text selection in screen order, the browser\'s own right-click menu, Tab leaves the grid', () => {
    const d = interactionDefaults({ cellSelection: undefined, getContextMenuItems: undefined, columnDefs: [{ field: 'a' }] })
    expect(d).toEqual({
      suppressContextMenu: true,
      enableCellTextSelection: true,
      ensureDomOrder: true,
      suppressDragLeaveHidesColumns: true,
      tabToNextCell: leaveGridOnTab,
    })
    expect(leaveGridOnTab()).toBe(false)
  })

  it('a spreadsheet keeps AG\'s range copy, its right-click menu and Tab from cell to cell', () => {
    const d = interactionDefaults({ cellSelection: { handle: { mode: 'fill' } }, getContextMenuItems: undefined, columnDefs: [{ field: 'a', editable: true }] })
    expect(d.suppressContextMenu).toBe(false)
    expect(d.enableCellTextSelection).toBe(false)
    expect(d.ensureDomOrder).toBe(false)
    expect(d.tabToNextCell).toBeUndefined()
    expect(d.suppressDragLeaveHidesColumns).toBe(true)
  })

  it('a page with its own right-click items keeps AG\'s menu', () => {
    expect(interactionDefaults({ cellSelection: undefined, getContextMenuItems: () => [], columnDefs: [] }).suppressContextMenu).toBe(false)
  })

  it('a grid with an editable column keeps Tab from cell to cell', () => {
    expect(interactionDefaults({ cellSelection: undefined, getContextMenuItems: undefined, columnDefs: [{ field: 'a' }, { children: [{ field: 'b', editable: () => true }] }] }).tabToNextCell).toBeUndefined()
    expect(interactionDefaults({ cellSelection: undefined, getContextMenuItems: undefined, columnDefs: [{ field: 'a' }], defaultColDef: { editable: true } }).tabToNextCell).toBeUndefined()
  })
})

describe('isSpreadsheet / anyEditable', () => {
  it('reads cell ranges as on unless absent or false', () => {
    expect(isSpreadsheet(undefined)).toBe(false)
    expect(isSpreadsheet(false)).toBe(false)
    expect(isSpreadsheet(true)).toBe(true)
    expect(isSpreadsheet({})).toBe(true)
  })
  it('finds an editable column inside groups', () => {
    expect(anyEditable([{ field: 'a' }])).toBe(false)
    expect(anyEditable([{ children: [{ field: 'b', editable: true }] }])).toBe(true)
    expect(anyEditable(undefined)).toBe(false)
  })
})

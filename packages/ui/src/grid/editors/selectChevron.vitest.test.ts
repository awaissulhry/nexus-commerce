import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { openCellEditor, SelectChevron } from './SelectCellEditor'

/** P0 (2026-09-30) — one click on a list cell's chevron opens the list. It was a picture: a click only selected the cell. */
describe('SelectChevron with onOpen', () => {
  it('is clickable and opens through onOpen; without it, it stays a picture', () => {
    const onOpen = vi.fn()
    const live = SelectChevron({ onOpen }) as ReactElement<{ className: string; onClick?: () => void }>
    expect(live.props.className).toContain('is-action')
    live.props.onClick?.()
    expect(onOpen).toHaveBeenCalledOnce()
    const still = SelectChevron() as ReactElement<{ className: string; onClick?: () => void }>
    expect(still.props.className).not.toContain('is-action')
    expect(still.props.onClick).toBeUndefined()
  })
  it('openCellEditor starts editing that cell, as a double-click would', () => {
    const api = { startEditingCell: vi.fn() }
    openCellEditor(api, { rowIndex: 4, rowPinned: null }, 'paese_di_origine')()
    expect(api.startEditingCell).toHaveBeenCalledWith({ rowIndex: 4, colKey: 'paese_di_origine', rowPinned: null })
    openCellEditor(api, { rowIndex: null }, 'paese_di_origine')()
    expect(api.startEditingCell).toHaveBeenCalledOnce()
  })
})

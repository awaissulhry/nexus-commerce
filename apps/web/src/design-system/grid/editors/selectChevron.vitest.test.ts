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

/**
 * Audit B21 (2026-09-30) — the chevron was an action on LOCKED cells too: it showed a pointer, `startEditingCell` silently
 * did nothing on a cell AG will not edit, and no reason was given. A locked cell now wears the passive glyph (no pointer,
 * a click selects the cell as on any locked cell; double-click or Enter explains why).
 */
describe('the chevron opens only a cell AG would edit', () => {
  it('no opener for a locked cell, the opener for an editable one', () => {
    const api = { startEditingCell: vi.fn() }
    const node = { rowIndex: 2, rowPinned: null }
    expect(openCellEditor(api, node, 'axis', { isCellEditable: () => false })).toBeUndefined()
    openCellEditor(api, node, 'axis', { isCellEditable: () => true })!()
    expect(api.startEditingCell).toHaveBeenCalledWith({ rowIndex: 2, colKey: 'axis', rowPinned: null })
  })
  it('both sheets hand the renderer\'s column to it', async () => {
    const { readFileSync } = await import('node:fs')
    const master = readFileSync(new URL('../../../app/products/[id]/edit/_studio/sheet/master/columns.tsx', import.meta.url), 'utf8')
    const channel = readFileSync(new URL('../../../app/products/[id]/edit/_studio/sheet/channel/CascadeCell.tsx', import.meta.url), 'utf8')
    expect(master.match(/openCellEditor\(p\.api, p\.node, col\.key, p\.column\)/g)).toHaveLength(2)
    expect(channel).toContain('openCellEditor(p.api, p.node, column.key, p.column)')
    expect(master + channel).not.toMatch(/openCellEditor\([^)]*\.key\)/)
  })
})

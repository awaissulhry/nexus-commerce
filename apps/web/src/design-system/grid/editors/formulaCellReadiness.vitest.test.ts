/**
 * P0 (2026-09-30) — the selector asks about THIS cell. It used to ask one sheet-wide question with no arguments, so a
 * single slow formula read put "Loading formulas… Retry / Close" in every editor of the sheet, select lists included.
 */
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('ag-grid-react', () => ({ useGridCellEditor: () => {} }))
vi.mock('../../primitives', () => ({ Input: () => null, Textarea: () => null, Button: () => null, ToolbarButton: () => null, TooltipPortalProvider: (p: { children: React.ReactNode }) => p.children }))
vi.mock('../../components', () => ({ ListboxPanel: () => null }))

import { formulaCellEditorSelector } from './FormulaCellEditor'

const wiring = { candidatesFor: () => [], preview: vi.fn(), functions: () => [], exprFor: () => null, colIdOfRef: (key: string) => key, retry: vi.fn() }
const select = { component: 'SelectPanelEditor', params: { options: [{ value: 'Italia', label: 'Italia' }] } }

describe('an editor waits only for its own cell’s formula state', () => {
  const unavailableReason = vi.fn((rowId: string | undefined, fieldKey: string) => rowId === 'still-loading' && fieldKey === 'paese_di_origine' ? 'Loading formulas…' : null)
  const selector = formulaCellEditorSelector({ ...wiring, unavailableReason }, { key: 'paese_di_origine', kind: 'select', formulaWritable: true }, select, (row: { id: string }) => row.id)

  it('passes the row and the column to the wiring', () => {
    selector.cellEditorSelector({ data: { id: 'known' } })
    expect(unavailableReason).toHaveBeenLastCalledWith('known', 'paese_di_origine')
  })

  it('a cell whose state is known opens its own editor (the select list) while another cell is still loading', () => {
    const known = selector.cellEditorSelector({ data: { id: 'known' } }) as { params: { fallback?: unknown; message?: string } }
    expect(known.params.message).toBeUndefined()
    expect(known.params.fallback).toEqual(select)
    const loading = selector.cellEditorSelector({ data: { id: 'still-loading' } }) as { params: { message?: string; retry?: unknown } }
    expect(loading.params.message).toBe('Loading formulas…')
    expect(loading.params.retry).toBe(wiring.retry)
  })
})

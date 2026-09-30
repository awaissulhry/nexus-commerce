import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SelectPanelEditor } from './SelectPanelEditor'
import { BOOLEAN_OPTIONS, scalarColumnDef } from './scalarValue'

const panel = vi.hoisted(() => ({ current: null as any }))
vi.mock('../../components', () => ({ ListboxPanel: (props: unknown) => { panel.current = props; return null } }))
afterEach(() => { vi.unstubAllGlobals(); panel.current = null })

function mount(value: unknown, kind = 'boolean') {
  vi.stubGlobal('window', { innerWidth: 1200 })
  const onValueChange = vi.fn()
  const stopEditing = vi.fn()
  const parser = scalarColumnDef({ kind }).valueParser as Function
  renderToStaticMarkup(React.createElement(SelectPanelEditor, {
    value, options: BOOLEAN_OPTIONS, onValueChange, stopEditing,
    column: { getActualWidth: () => 150 }, parseValue: (newValue: string) => parser({ newValue }),
  } as any))
  return { onValueChange, stopEditing }
}

describe('the mounted select editor reports the declared value type before committing', () => {
  it.each([[true, 'false', false], [false, 'true', true], [null, 'false', false]])('changes %j via %s into %j', (value, chosen, expected) => {
    const callbacks = mount(value)
    panel.current.onCommit(chosen)
    expect(callbacks.onValueChange).toHaveBeenCalledWith(expected)
    expect(callbacks.onValueChange.mock.invocationCallOrder[0]).toBeLessThan(callbacks.stopEditing.mock.invocationCallOrder[0])
  })
  it('leaves a text select code spelled false as text', () => {
    const { onValueChange } = mount('true', 'select')
    panel.current.onCommit('false')
    expect(onValueChange).toHaveBeenCalledWith('false')
  })
  it('highlights stored false and does not resave an unchanged selection', () => {
    const { onValueChange, stopEditing } = mount(false)
    expect(panel.current.value).toBe('false')
    panel.current.onCommit('false')
    expect(onValueChange).not.toHaveBeenCalled()
    expect(stopEditing).toHaveBeenCalledOnce()
  })
  it('reports a clear as null and cancellation without a value change', () => {
    const { onValueChange } = mount(true)
    panel.current.onCancel()
    expect(onValueChange).not.toHaveBeenCalled()
    panel.current.onCommit('')
    expect(onValueChange).toHaveBeenCalledWith(null)
  })
})

describe('Enter and Tab: the editor reports the choice and the grid commits and moves (P0, 2026-09-30)', () => {
  const countries = [{ value: 'Cina', label: 'Cina' }, { value: 'Italia', label: 'Italia' }]
  function mountSelect(value: unknown, extra: Record<string, unknown> = {}) {
    vi.stubGlobal('window', { innerWidth: 1200 })
    const onValueChange = vi.fn()
    const stopEditing = vi.fn()
    renderToStaticMarkup(React.createElement(SelectPanelEditor, {
      value, options: countries, onValueChange, stopEditing, column: { getActualWidth: () => 150 }, ...extra,
    } as any))
    return { onValueChange, stopEditing }
  }

  it('reports a changed choice and leaves ending the edit to AG (which then moves)', () => {
    const { onValueChange, stopEditing } = mountSelect('Italia')
    panel.current.onKeyChoice('Cina')
    expect(onValueChange).toHaveBeenCalledWith('Cina')
    expect(stopEditing).not.toHaveBeenCalled()
  })
  it('reports nothing for the stored value or for no highlight, so AG ends the edit without a write', () => {
    const { onValueChange } = mountSelect('Italia')
    panel.current.onKeyChoice('Italia')
    panel.current.onKeyChoice(null)
    expect(onValueChange).not.toHaveBeenCalled()
  })
  it('shows a stored value the list does not hold, first and selected', () => {
    mountSelect('Xavia Racing')
    expect(panel.current.options[0]).toMatchObject({ value: 'Xavia Racing', trailing: 'current · not in the list' })
    expect(panel.current.value).toBe('Xavia Racing')
  })
  it('starts the search with the key that opened the cell, and passes an open list through', () => {
    mountSelect(null, { eventKey: 'C', allowCustom: true })
    expect(panel.current.initialQuery).toBe('C')
    expect(panel.current.allowCustom).toBe(true)
    mountSelect(null, { eventKey: 'Enter' })
    expect(panel.current.initialQuery).toBe('')
  })
})

describe('the list is named after its column (audit B19)', () => {
  it('passes the column header as the listbox name', () => {
    vi.stubGlobal('window', { innerWidth: 1200 })
    renderToStaticMarkup(React.createElement(SelectPanelEditor, {
      value: null, options: [{ value: 'Nero', label: 'Nero' }], onValueChange: vi.fn(), stopEditing: vi.fn(),
      column: { getActualWidth: () => 150 }, colDef: { headerName: 'Colore' },
    } as any))
    expect(panel.current.ariaLabel).toBe('Colore')
  })
})

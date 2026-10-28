import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SelectPanelEditor } from './SelectPanelEditor'
import { BOOLEAN_OPTIONS, scalarColumnDef } from './scalarValue'

const panel = vi.hoisted(() => ({ current: null as any }))
const ag = vi.hoisted(() => ({ lifecycle: {} as { isCancelAfterEnd?: () => boolean } }))
vi.mock('../../components', () => ({ ListboxPanel: (props: unknown) => { panel.current = props; return null } }))
vi.mock('ag-grid-react', () => ({ useGridCellEditor: (callbacks: { isCancelAfterEnd?: () => boolean }) => { ag.lifecycle = callbacks } }))
afterEach(() => { vi.unstubAllGlobals(); panel.current = null; ag.lifecycle = {} })

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

describe('held options and notes (sheet publish parity, 2026-10-04)', () => {
  const statuses = [
    { value: 'active', label: 'Active', note: 'Now on the channel. Choosing it clears a waiting change.' },
    { value: 'inactive', label: 'Inactive' },
    { value: 'ended', label: 'Ended', heldReason: 'Amazon has no End.', note: 'Amazon has no End.' },
  ]
  function mountStatuses(value: unknown) {
    vi.stubGlobal('window', { innerWidth: 1200 })
    const onValueChange = vi.fn()
    const stopEditing = vi.fn()
    renderToStaticMarkup(React.createElement(SelectPanelEditor, { value, options: statuses, onValueChange, stopEditing, column: { getActualWidth: () => 200 } } as any))
    return { onValueChange, stopEditing }
  }

  it('hands a refused value to the panel HELD, with its reason and its note, so it stays reachable and announced', () => {
    mountStatuses('active')
    expect(panel.current.options).toEqual(statuses)
    expect(panel.current.options[2]).toMatchObject({ heldReason: 'Amazon has no End.', note: 'Amazon has no End.' })
  })

  it('an offered value still commits through onValueChange; the stored value that is in the list is not repeated', () => {
    const { onValueChange, stopEditing } = mountStatuses('active')
    expect(panel.current.options).toHaveLength(3)
    panel.current.onCommit('inactive')
    expect(onValueChange).toHaveBeenCalledWith('inactive')
    expect(stopEditing).toHaveBeenCalledOnce()
  })
})

describe('closing without a pick never writes (sheet publish parity, 2026-10-04)', () => {
  /** The sheet's Status column: its cell value is an OBJECT ({ state, waiting, create }), the editor opens on its STRING. */
  const statuses = [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'not_listed', label: 'Not listed' }]
  function mountOn(value: unknown) {
    vi.stubGlobal('window', { innerWidth: 1200 })
    const onValueChange = vi.fn()
    const stopEditing = vi.fn()
    renderToStaticMarkup(React.createElement(SelectPanelEditor, { value, options: statuses, onValueChange, stopEditing, column: { getActualWidth: () => 200 } } as any))
    return { onValueChange, stopEditing }
  }

  it('a click elsewhere (AG stops the edit, no cancel) cancels at the end: the opened value is never handed back', () => {
    const { onValueChange } = mountOn('active')
    // AG reads this before it compares the editor's value ('active') with the cell's object — that compare said "changed".
    expect(ag.lifecycle.isCancelAfterEnd?.()).toBe(true)
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('Enter or Tab on the value it opened on, or on no highlight, still cancels at the end', () => {
    const { onValueChange } = mountOn('active')
    panel.current.onKeyChoice('active')
    panel.current.onKeyChoice(null)
    expect(onValueChange).not.toHaveBeenCalled()
    expect(ag.lifecycle.isCancelAfterEnd?.()).toBe(true)
  })

  it('a pick of the same value cancels; Escape cancels', () => {
    const { onValueChange, stopEditing } = mountOn('active')
    panel.current.onCommit('active')
    panel.current.onCancel()
    expect(onValueChange).not.toHaveBeenCalled()
    expect(stopEditing.mock.calls).toEqual([[true], [true]])
    expect(ag.lifecycle.isCancelAfterEnd?.()).toBe(true)
  })

  it('a changed pick (click or Enter / Tab) is written: the end is no longer a cancel', () => {
    const clicked = mountOn('active')
    panel.current.onCommit('inactive')
    expect(clicked.onValueChange).toHaveBeenCalledWith('inactive')
    expect(ag.lifecycle.isCancelAfterEnd?.()).toBe(false)
    const keyed = mountOn('active')
    expect(ag.lifecycle.isCancelAfterEnd?.()).toBe(true)
    panel.current.onKeyChoice('not_listed')
    expect(keyed.onValueChange).toHaveBeenCalledWith('not_listed')
    expect(ag.lifecycle.isCancelAfterEnd?.()).toBe(false)
  })
})

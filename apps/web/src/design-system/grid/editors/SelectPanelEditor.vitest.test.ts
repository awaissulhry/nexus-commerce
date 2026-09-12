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

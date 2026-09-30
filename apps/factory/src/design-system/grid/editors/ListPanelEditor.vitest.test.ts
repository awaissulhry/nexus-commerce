import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { parseShape } from './shapeValue'

type ListControl = { value: string[]; onChange: (values: string[]) => void }
const captured = vi.hoisted(() => ({ control: null as ListControl | null, input: null as ((event: { target: { value: string } }) => void) | null }))
vi.mock('../../components', () => ({ OptionList: (props: ListControl) => { captured.control = props; return null } }))
vi.mock('../../primitives', () => ({ TagInput: (props: ListControl) => { captured.control = props; return null } }))
// Observe the real host input handler while React mounts the editor. The handler itself is not replaced.
vi.mock('react/jsx-runtime', async importOriginal => {
  const original = await importOriginal<typeof import('react/jsx-runtime')>()
  const capture = (render: typeof original.jsx): typeof original.jsx => (type, props, key) => {
    const input = (props as { onInput?: NonNullable<typeof captured.input> } | null)?.onInput
    if (type === 'div' && typeof input === 'function') captured.input = input
    return render(type, props, key)
  }
  return { ...original, jsx: capture(original.jsx), jsxs: capture(original.jsxs) }
})
vi.mock('react/jsx-dev-runtime', async importOriginal => {
  const original = await importOriginal<typeof import('react/jsx-dev-runtime')>()
  return { ...original, jsxDEV: ((...args) => {
    const input = (args[1] as { onInput?: NonNullable<typeof captured.input> } | null)?.onInput
    if (args[0] === 'div' && typeof input === 'function') captured.input = input
    return original.jsxDEV(...args)
  }) as typeof original.jsxDEV }
})

import { ListPanelEditor } from './ListPanelEditor'

afterEach(() => { vi.unstubAllGlobals(); captured.control = null; captured.input = null })

function mount(options?: Array<{ value: string; label: string }>) {
  vi.stubGlobal('window', { innerWidth: 1200 })
  const onValueChange = vi.fn()
  const parseValue = vi.fn((raw: unknown) => parseShape('list', raw, { kind: 'number' }))
  renderToStaticMarkup(React.createElement(ListPanelEditor, {
    value: [7], options, column: { getActualWidth: () => 200 }, stopEditing: vi.fn(), onValueChange, parseValue,
  }))
  return { onValueChange, parseValue }
}

it('reports numeric chip additions through the same parser as paste and set-column', () => {
  const { onValueChange, parseValue } = mount()
  expect(captured.control!.value).toEqual(['7'])
  captured.control!.onChange(['7', '8'])
  expect(parseValue).toHaveBeenCalledWith(['7', '8'])
  expect(onValueChange).toHaveBeenCalledWith([7, 8])
})

it('reports numeric checkbox selections through the column parser', () => {
  const { onValueChange } = mount([{ value: '7', label: 'Seven' }, { value: '8', label: 'Eight' }])
  captured.control!.onChange(['8'])
  expect(onValueChange).toHaveBeenCalledWith([8])
})

it.each([['8', [7, 8]], ['bad', [7, 'bad']], ['', [7]], ['=draft', [7, '=draft']]])('keeps the pending input %j in the value AG will commit', (text, expected) => {
  const { onValueChange } = mount()
  captured.input!({ target: { value: text as string } })
  expect(onValueChange).toHaveBeenCalledWith(expected)
})

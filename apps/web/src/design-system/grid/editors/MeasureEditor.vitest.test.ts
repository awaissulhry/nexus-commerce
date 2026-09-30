import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MeasureEditor } from './MeasureEditor'
import { measureFromText } from './shapeValue'
import { parseShape } from './shapeColumn'

const capture = vi.hoisted(() => ({ input: null as any, units: null as any }))
vi.mock('../../primitives', () => ({ Input: (props: unknown) => { capture.input = props; return null } }))
vi.mock('../../components', () => ({ ListboxPanel: (props: unknown) => { capture.units = props; return null } }))
afterEach(() => { vi.unstubAllGlobals(); capture.input = null; capture.units = null })

const UNITS = ['kilograms', 'grams', 'ounces', 'pounds']

function mount(value: unknown, unitOptions = UNITS) {
  vi.stubGlobal('window', { innerWidth: 1200 })
  const onValueChange = vi.fn()
  const stopEditing = vi.fn()
  const api = { stopEditing: vi.fn() }
  renderToStaticMarkup(React.createElement(MeasureEditor, {
    value, unitOptions, onValueChange, stopEditing, api, column: { getActualWidth: () => 150 },
  } as any))
  return { onValueChange, stopEditing, api }
}

/**
 * Audit B08 (2026-09-30) — the number field is text, and every string `Number()` could not read was reported as
 * `value: null`. "1.5 kg" typed into a weight cell saved an empty weight with no warning.
 */
describe('MeasureEditor — the typed text is read as a paste reads it, never as an empty value', () => {
  it.each([
    ['1.5 kg', { value: 1.5, unit: 'kilograms' }],
    ['12kg', { value: 12, unit: 'kilograms' }],
    ['9 OUNCES', { value: 9, unit: 'ounces' }],
    ['3', { value: 3, unit: 'kilograms' }],
    ['2,5', { value: 2.5, unit: 'kilograms' }],
  ])('%s reports %j', (typed, expected) => {
    const { onValueChange } = mount({ value: 1.2, unit: 'kilograms' })
    capture.input.onChange({ target: { value: typed } })
    expect(onValueChange).toHaveBeenLastCalledWith(expected)
  })

  it.each(['-', '.', 'abc'])('%s is reported as typed, so the server refuses it by name (never null)', (typed) => {
    const { onValueChange } = mount({ value: 12, unit: 'kilograms' })
    capture.input.onChange({ target: { value: typed } })
    expect(onValueChange).toHaveBeenLastCalledWith({ value: typed, unit: 'kilograms' })
  })

  it('an emptied field with no unit still clears the cell', () => {
    const { onValueChange } = mount({ value: 12, unit: null })
    capture.input.onChange({ target: { value: '' } })
    expect(onValueChange).toHaveBeenLastCalledWith(null)
  })

  it('agrees with a grid paste of the same text', () => {
    for (const typed of ['1.5 kg', '12kg', '9 OUNCES']) {
      expect(measureFromText(typed, 'grams', UNITS)).toEqual(parseShape('measure', typed, { unitOptions: UNITS }))
    }
  })
})

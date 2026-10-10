import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { Toggle } from '../../primitives/Toggle'
import { SwitchCell, suppressSwitchKeys, switchHandlerOf, switchKeyFlips } from '../renderers/SwitchCell'
import { switchColumn } from './presets'

/**
 * `switchColumn` (ads brain page D2): an on/off column that only changes a DRAFT. Space on a switch cell flips it and
 * never selects the row; the words On/Off are what sorting, filtering, the CSV and the quick filter see.
 */
interface Row { id: string; name: string; on: boolean | null; held?: boolean }
type Fn = (p: unknown) => unknown

const col = switchColumn<Row>('on', {
  header: 'Brain',
  label: (r) => `Keep ${r.name} under the brain`,
  disabledReason: (r) => (r.held ? 'Not advertised in this market' : null),
  pending: (r) => r.id === 'b',
})

const cellProps = (row: Row | undefined, context: unknown, extra: Record<string, unknown> = {}) =>
  ({ ...col.cellRendererParams, data: row, value: row?.on, context, eGridCell: undefined, ...extra }) as never
const html = (row: Row | undefined, context: unknown) => renderToStaticMarkup(createElement(SwitchCell, cellProps(row, context)))

/** The Toggle element in the tree the cell returns. */
function toggleOf(node: ReactNode): ReactElement<{ onChange?: (next: boolean) => void }> | null {
  if (!isValidElement(node)) return null
  if (node.type === Toggle) return node as ReactElement<{ onChange?: (next: boolean) => void }>
  const kids = (node.props as { children?: ReactNode }).children
  for (const k of Array.isArray(kids) ? kids : [kids]) {
    const found = toggleOf(k as ReactNode)
    if (found) return found
  }
  return null
}

describe('switchColumn — the column', () => {
  it('draws SwitchCell under its header, is not editable, and keeps Space/Enter from AG', () => {
    expect(col.headerName).toBe('Brain')
    expect(col.cellRenderer).toBe(SwitchCell)
    expect(col.editable).toBe(false)
    expect(col.field).toBe('on')
    expect(col.suppressKeyboardEvent).toBe(suppressSwitchKeys)
    expect(col.valueSetter).toBeUndefined()
  })

  it('exports, filters and quick-filters as On / Off; a missing value is Off', () => {
    expect((col.valueFormatter as Fn)({ value: true })).toBe('On')
    expect((col.valueFormatter as Fn)({ value: false })).toBe('Off')
    expect((col.valueFormatter as Fn)({ value: null })).toBe('Off')
    expect((col.getQuickFilterText as Fn)({ value: true })).toBe('On')
    expect((col.filterValueGetter as Fn)({ getValue: (f: string) => (f === 'on' ? false : 'x') })).toBe('Off')
  })

  it('takes its own words', () => {
    const locked = switchColumn<Row>('on', { header: 'Locked', label: () => 'Lock', words: { on: 'Locked', off: 'Open' } })
    expect((locked.valueFormatter as Fn)({ value: true })).toBe('Locked')
    expect((locked.valueFormatter as Fn)({ value: false })).toBe('Open')
  })

  it('sorts Off before On', () => {
    const cmp = col.comparator as (a: unknown, b: unknown) => number
    expect([true, false, null, true].sort((a, b) => cmp(a, b))).toEqual([false, null, true, true])
  })
})

describe('Space on a switch cell never selects the row', () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, ...mods })

  it('AG leaves Space and Enter to the switch; arrows, Tab, Escape and Ctrl/⌘ combinations stay AG\'s', () => {
    expect(suppressSwitchKeys({ event: key(' ') })).toBe(true)
    expect(suppressSwitchKeys({ event: key('Enter') })).toBe(true)
    expect(suppressSwitchKeys({ event: key(' ', { shiftKey: true }) })).toBe(true)
    for (const k of ['ArrowDown', 'ArrowRight', 'Tab', 'Escape', 'a']) expect(suppressSwitchKeys({ event: key(k) })).toBe(false)
    expect(suppressSwitchKeys({ event: key(' ', { ctrlKey: true }) })).toBe(false)
    expect(suppressSwitchKeys({ event: key('Enter', { metaKey: true }) })).toBe(false)
    expect(suppressSwitchKeys({ event: key(' '), editing: true })).toBe(false)
  })

  it('the cell flips only for a key pressed ON the cell, once per press — the toggle button keeps its own keys', () => {
    const cell = {}
    const button = {}
    expect(switchKeyFlips({ key: ' ', target: cell }, cell)).toBe(true)
    expect(switchKeyFlips({ key: 'Enter', target: cell }, cell)).toBe(true)
    expect(switchKeyFlips({ key: ' ', target: button }, cell)).toBe(false)
    expect(switchKeyFlips({ key: ' ', target: cell, repeat: true }, cell)).toBe(false)
    expect(switchKeyFlips({ key: 'ArrowDown', target: cell }, cell)).toBe(false)
  })
})

describe('SwitchCell — it changes a draft, never the server', () => {
  const row: Row = { id: 'a', name: 'JACKET-A', on: true }

  it('reads the handler from context.current (a ref) or a plain object', () => {
    const onSwitch = () => {}
    expect(switchHandlerOf({ current: { onSwitch } })).toBe(onSwitch)
    expect(switchHandlerOf({ onSwitch })).toBe(onSwitch)
    expect(switchHandlerOf({ current: null })).toBeUndefined()
    expect(switchHandlerOf(undefined)).toBeUndefined()
  })

  it('a flip is handed to onSwitch(row, next, field) — and nothing else is called', () => {
    const onSwitch = vi.fn()
    // The memo's inner function, rendered inside a probe so its hooks run in a render (no DOM, no effects).
    const inner = (SwitchCell as unknown as { type: (p: unknown) => ReactNode }).type
    let tree: ReactNode = null
    const Probe = () => { tree = inner(cellProps(row, { current: { onSwitch } })); return null }
    renderToStaticMarkup(createElement(Probe))
    const toggle = toggleOf(tree)
    expect(toggle).not.toBeNull()
    toggle!.props.onChange!(false)
    expect(onSwitch).toHaveBeenCalledTimes(1)
    expect(onSwitch).toHaveBeenCalledWith(row, false, 'on')
  })

  it('draws a named switch, the word, and "Not saved" while the draft holds a change', () => {
    const ctx = { current: { onSwitch: () => {} } }
    const on = html(row, ctx)
    expect(on).toContain('role="switch"')
    expect(on).toContain('aria-checked="true"')
    expect(on).toContain('aria-label="Keep JACKET-A under the brain"')
    expect(on).toContain('>On<')
    expect(on).not.toContain('Not saved')
    expect(html({ id: 'b', name: 'JACKET-B', on: false }, ctx)).toMatch(/aria-checked="false".*>Off<.*Not saved/)
  })

  it('a switch that cannot move is disabled and says why', () => {
    const out = html({ id: 'c', name: 'JACKET-C', on: false, held: true }, { current: { onSwitch: () => {} } })
    expect(out).toContain('disabled=""')
    expect(out).toContain('title="Not advertised in this market"')
    expect(out).toContain('aria-description="Not advertised in this market"')
  })

  it('without a handler (no permission) only the word; a group row draws nothing', () => {
    const out = html(row, { current: {} })
    expect(out).toBe('<span class="nds-cell-switch">On</span>')
    expect(html(undefined, { current: {} })).toBe('')
  })
})

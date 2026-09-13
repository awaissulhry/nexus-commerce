import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemDef, MenuProps } from '@/design-system/components'
import { SheetToolbar, type SheetToolbarProps } from './SheetToolbar'

// Node-only contract: inspect the declarations delivered to the real DS menu; its
// portal and keyboard behavior belong to the DS/browser checks.
const { menuInputs } = vi.hoisted(() => ({ menuInputs: [] as MenuItemDef[][] }))
vi.mock('@/design-system/components', async importOriginal => {
  const actual = await importOriginal<typeof import('@/design-system/components')>()
  return {
    ...actual,
    Menu: (props: MenuProps) => {
      menuInputs.push(props.items)
      return createElement(actual.Menu, props)
    },
  }
})

beforeEach(() => { menuInputs.length = 0 })

function render(overrides: Partial<SheetToolbarProps<unknown>> = {}) {
  renderToStaticMarkup(createElement(SheetToolbar, {
    visible: 21, total: 21, selected: 0, search: '', onSearch: vi.fn(),
    onReload: vi.fn(), ...overrides,
  }))
  return menuInputs[menuInputs.length - 1]
}

describe('SheetToolbar overflow holds', () => {
  it.each([
    [{ loading: true }, 'The sheet is still loading'],
    [{ unavailable: true }, 'This sheet could not be read'],
    [{ pendingWrite: true }, 'Wait for the pending write to finish.'],
  ] as const)('explains the %j hold in both menu reason channels', (state, reason) => {
    const action: MenuItemDef = { id: 'classification', label: 'Classification', onSelect: vi.fn() }
    const items = render({ ...state, overflow: [action] })
    const held = items.find(item => item.id === action.id)!
    expect(held.disabled).toBe(true)
    expect(held.title).toBe(reason)
    expect(renderToStaticMarkup(createElement(Fragment, null, held.description))).toBe(reason)
    expect(held.onSelect).toBe(action.onSelect)
    expect(action.disabled).toBeUndefined()
    expect(action.description).toBeUndefined()
  })

  it('keeps the existing refusal and separator while retaining recovery after a failed read', () => {
    const separator: MenuItemDef = { id: 'group', separator: true }
    const items = render({ unavailable: true, overflow: [separator, {
      id: 'held', label: 'Held action', disabled: true,
      title: 'Existing reason', description: 'Existing reason',
    }] })
    const held = items.find(item => item.id === 'held')!
    expect(items.find(item => item.id === 'group')).toBe(separator)
    expect(held.title).toBe('This sheet could not be read. Existing reason')
    expect(renderToStaticMarkup(createElement(Fragment, null, held.description)))
      .toBe('This sheet could not be read. Existing reason')
    expect(items.find(item => item.id === 'reload')?.disabled).toBeFalsy()
  })

  it('keeps the loaded rows and read controls while a write holds overflow verbs', () => {
    const markup = renderToStaticMarkup(createElement(SheetToolbar, {
      visible: 21, total: 21, selected: 2, search: '', onSearch: vi.fn(),
      pendingWrite: true, overflow: [{ id: 'held', label: 'Held action', description: 'Existing reason' }],
    }))
    expect(markup).toContain('<b>21</b> rows')
    expect(markup).toContain('<b>2</b> selected')
    expect(markup).not.toContain('Loading information')
    const held = menuInputs[menuInputs.length - 1].find(item => item.id === 'held')!
    expect(held.title).toBe('Wait for the pending write to finish.')
    expect(renderToStaticMarkup(createElement(Fragment, null, held.description)))
      .toBe('Wait for the pending write to finish. Existing reason')
  })

  it('passes an available action through unchanged once the read is ready', () => {
    const action: MenuItemDef = { id: 'classification', label: 'Classification', onSelect: vi.fn() }
    const items = render({ overflow: [action] })
    expect(items.find(item => item.id === action.id)).toBe(action)
    expect(items.find(item => item.id === 'reload')?.onSelect).toBeTypeOf('function')
  })
})


describe('SheetToolbar data contracts', () => {
  it('prints the producer quantity and keeps filter breadth in the detail', () => {
    const markup = renderToStaticMarkup(createElement(SheetToolbar, {
      visible: 21, total: 21, selected: 0, search: '', onSearch: vi.fn(),
      chips: [{ id: 'mapping-errors', label: 'Mapping errors', count: { n: 63, unit: 'cells' },
        cells: { byRow: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [String(i), ['a', 'b', 'c']])) } }],
    }))
    expect(markup).toContain('63 cells')
    expect(markup).toContain('63 affected cells across 3 columns and 21 rows')
  })

  it('never replaces a declared variant count with the number of affected columns', () => {
    const markup = renderToStaticMarkup(createElement(SheetToolbar, {
      visible: 21, total: 21, selected: 0, search: '', onSearch: vi.fn(),
      chips: [{ id: 'excluded', label: 'Excluded', count: { n: 4, unit: 'variants' }, cells: { byRow: {} } }],
    }))
    expect(markup).toContain('4 variants')
    expect(markup).not.toContain('0 columns')
  })

  it('renders declared status and keeps its danger announcement', () => {
    const markup = renderToStaticMarkup(createElement(SheetToolbar, {
      visible: 21, total: 21, selected: 0, search: '', onSearch: vi.fn(),
      status: [{ tone: 'danger', label: 'Read failed', detail: 'Reload this sheet.' }],
    }))
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Read failed')
    expect(markup).toContain('Reload this sheet.')
  })
})

// Compile-time contract: a feature cannot sneak a command through the status slot.
type ToolbarStatus = NonNullable<SheetToolbarProps<unknown>['status']>
// @ts-expect-error A React button is not status data.
const buttonStatus: ToolbarStatus = [createElement('button', null, 'Open dialog')]
// @ts-expect-error Status accepts no command callback.
const commandStatus: ToolbarStatus = [{ tone: 'info', label: 'Open dialog', onClick: () => {} }]
void buttonStatus
void commandStatus

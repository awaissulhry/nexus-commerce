import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

/**
 * The multi-value list editor, called on a minimal hook runtime (node-only vitest, as `listboxPanelKeys`): the returned
 * tree carries the real props it hands the DS `TagInput` / `OptionList`, and its mount effect runs.
 */
const runtime = vi.hoisted(() => ({ slots: [] as unknown[], at: 0, pending: [] as Array<() => void> }))
vi.mock('react', async (original) => {
  const real = await original<typeof import('react')>()
  const useState = (init: unknown) => {
    const i = runtime.at++
    if (!(i in runtime.slots)) runtime.slots[i] = typeof init === 'function' ? (init as () => unknown)() : init
    return [runtime.slots[i], (next: unknown) => { runtime.slots[i] = typeof next === 'function' ? (next as (v: unknown) => unknown)(runtime.slots[i]) : next }]
  }
  const useRef = (init: unknown) => {
    const i = runtime.at++
    if (!(i in runtime.slots)) runtime.slots[i] = { current: init }
    return runtime.slots[i]
  }
  const useEffect = (fn: () => void, deps?: unknown[]) => {
    const i = runtime.at++
    const prev = runtime.slots[i] as unknown[] | undefined
    if (!prev || !deps || deps.some((d, k) => !Object.is(d, prev[k]))) runtime.pending.push(fn)
    runtime.slots[i] = deps ?? []
  }
  const hooks = { useState, useRef, useEffect, useLayoutEffect: useEffect, useCallback: (fn: unknown) => fn }
  return { ...real, default: { ...real, ...hooks }, ...hooks }
})

import { ListPanelEditor } from './ListPanelEditor'
import { shapeEditorSpec } from './shapeColumn'
import { OptionList } from '../../components'
import { TagInput } from '../../primitives'

type El = ReactElement<Record<string, any>>
const flat = (node: unknown): El[] => {
  if (Array.isArray(node)) return node.flatMap(flat)
  if (!node || typeof node !== 'object' || !('props' in (node as object))) return []
  const el = node as El
  return [el, ...flat(el.props.children)]
}
const render = (props: Record<string, unknown>) => {
  const fn = (ListPanelEditor as unknown as { render: Function }).render
  runtime.at = 0
  let out = fn(props, null) as El
  const run = runtime.pending.splice(0)
  for (const effect of run) effect()
  if (run.length) { runtime.at = 0; out = fn(props, null) as El }
  return out
}
const mount = (extra: Record<string, unknown>) => {
  runtime.slots = []; runtime.at = 0; runtime.pending = []
  const onValueChange = vi.fn()
  const props = { column: { getActualWidth: () => 180 }, stopEditing: vi.fn(), onValueChange, label: 'Tags', ...extra }
  return { onValueChange, props, tree: render(props) }
}
const tagInput = (tree: El) => flat(tree).find((el) => el.type === TagInput)!
const optionList = (tree: El) => flat(tree).find((el) => el.type === OptionList)!

beforeEach(() => { runtime.slots = []; runtime.at = 0; runtime.pending = []; vi.stubGlobal('window', { innerWidth: 1200 }) })

/**
 * Audit B11 (2026-09-30) — a free-text list (Etsy tags and materials, eBay free-text multi-value specifics) lost the key
 * that opened it by typing: "Rosso" saved the tag "osso".
 */
describe('ListPanelEditor — the free-text list keeps the first typed key', () => {
  it('starts the draft with the typed key, and reports it so Enter saves it', () => {
    const { tree, onValueChange } = mount({ value: ['Blu'], eventKey: 'R' })
    expect(tagInput(tree).props.initialInput).toBe('R')
    expect(onValueChange).toHaveBeenLastCalledWith(['Blu', 'R'])
  })
  it('Enter, F2 or a double-click start with no draft and report nothing', () => {
    const { tree, onValueChange } = mount({ value: ['Blu'], eventKey: 'Enter' })
    expect(tagInput(tree).props.initialInput).toBe('')
    expect(onValueChange).not.toHaveBeenCalled()
  })
  it('a pasted "a | b" draft is two values, as a grid paste of the same text is', () => {
    const { tree, onValueChange } = mount({ value: [] })
    ;(tree.props.children[0].props.onInput as Function)({ target: { value: 'Rosso | Nero' } })
    expect(onValueChange).toHaveBeenLastCalledWith(['Rosso', 'Nero'])
  })
  it('a chip made from "a | b" (the "," key) is two chips', () => {
    const { tree, onValueChange } = mount({ value: [] })
    ;(tagInput(tree).props.onChange as Function)(['Rosso | Nero'])
    expect(onValueChange).toHaveBeenLastCalledWith(['Rosso', 'Nero'])
  })
})

describe('ListPanelEditor — a list with options still searches with the typed key', () => {
  it('passes the key to the search, not to a draft', () => {
    const { tree, onValueChange } = mount({ value: [], options: [{ value: 'A', label: 'Alpha' }], eventKey: 'a' })
    expect(optionList(tree).props.initialQuery).toBe('a')
    expect(onValueChange).not.toHaveBeenCalled()
  })
})

/**
 * Audit B12 (2026-09-30) — an OPEN multi-value list (an eBay MULTI FREE_TEXT aspect with suggestions, e.g. Caratteristiche)
 * could not take a typed value: `shapeEditorSpec` dropped the column's mode, the list was always closed, a search with no
 * match said "No matches" and a stored off-list value was labelled as a fault, at the bottom.
 */
describe('open multi-value lists take a typed value', () => {
  const FEATURES = [{ value: 'Impermeabile', label: 'Impermeabile' }, { value: 'Traspirante', label: 'Traspirante' }]
  const list = (props: Record<string, unknown>) => {
    runtime.slots = []; runtime.at = 0; runtime.pending = []
    let out = (OptionList as Function)(props) as El
    const run = runtime.pending.splice(0)
    for (const effect of run) effect()
    if (run.length) { runtime.at = 0; out = (OptionList as Function)(props) as El }
    return out
  }
  const addRow = (tree: El) => flat(tree).find((el) => el.type === 'label' && flat(el).some((c) => c.type === 'span' && [c.props.children].flat().join('').startsWith('Add "')))

  it('shapeEditorSpec passes the open mode to the list editor', () => {
    expect(shapeEditorSpec({ key: 'f', shape: 'list', options: ['A'], mode: 'open' })!.params.allowCustom).toBe(true)
    expect(shapeEditorSpec({ key: 'f', shape: 'list', options: ['A'], mode: 'closed' })!.params.allowCustom).toBe(false)
  })
  it('the editor hands the open mode to its option list', () => {
    expect(optionList(mount({ value: [], options: FEATURES, allowCustom: true }).tree).props.allowCustom).toBe(true)
    expect(optionList(mount({ value: [], options: FEATURES }).tree).props.allowCustom).toBeFalsy()
  })
  it('a typed value with no match is offered as Add "…", and ticking it adds it', () => {
    const onChange = vi.fn()
    const tree = list({ options: FEATURES, value: ['Traspirante'], onChange, allowCustom: true, initialQuery: 'Protezioni CE', searchable: true })
    expect(flat(tree).some((el) => el.props.className === 'nds-combo-empty')).toBe(false)
    ;(flat(addRow(tree)).find((el) => el.type === 'input')!.props.onChange as Function)()
    expect(onChange).toHaveBeenCalledWith(['Traspirante', 'Protezioni CE'])
  })
  it('with no match the typed text is the draft Enter saves; with a match it is not', () => {
    const onCustomDraft = vi.fn()
    list({ options: FEATURES, value: [], onChange() {}, allowCustom: true, initialQuery: 'Protezioni CE', searchable: true, onCustomDraft })
    expect(onCustomDraft).toHaveBeenLastCalledWith('Protezioni CE')
    list({ options: FEATURES, value: [], onChange() {}, allowCustom: true, initialQuery: 'Imper', searchable: true, onCustomDraft })
    expect(onCustomDraft).toHaveBeenLastCalledWith('')
  })
  it('a closed list offers no Add row', () => {
    expect(addRow(list({ options: FEATURES, value: [], onChange() {}, initialQuery: 'Protezioni CE', searchable: true }))).toBeUndefined()
  })
  it('the editor reports the draft with the ticked values, so Enter adds and saves', () => {
    const { tree, onValueChange } = mount({ value: ['Traspirante'], options: FEATURES, allowCustom: true })
    ;(optionList(tree).props.onCustomDraft as Function)('Protezioni CE')
    expect(onValueChange).toHaveBeenLastCalledWith(['Traspirante', 'Protezioni CE'])
  })
  it('a stored value the list does not hold comes FIRST, labelled current (open) or current · not in the list (closed)', () => {
    const open = optionList(mount({ value: ['Protezioni CE'], options: FEATURES, allowCustom: true }).tree).props.options
    expect(open[0]).toEqual({ value: 'Protezioni CE', label: 'Protezioni CE (current)' })
    const closed = optionList(mount({ value: ['Old'], options: FEATURES }).tree).props.options
    expect(closed[0]).toEqual({ value: 'Old', label: 'Old (current · not in the list)' })
  })
})

/** Audit B20 — the checkbox list walks by page and to its ends, as the single-value lists do. */
describe('ListPanelEditor — page and end keys walk the boxes', () => {
  const walk = (key: string, focusedAt: number, count = 20) => {
    const { tree } = mount({ value: [], options: Array.from({ length: count - 1 }, (_, i) => ({ value: `v${i}`, label: `v${i}` })) })
    const stops = Array.from({ length: count }, (_, i) => ({ i, focus: vi.fn() }))
    const rootRef = runtime.slots.find((s) => s && typeof s === 'object' && 'current' in (s as object)) as { current: unknown }
    rootRef.current = { querySelectorAll: () => stops }
    vi.stubGlobal('document', { activeElement: stops[focusedAt] })
    const e = { key, ctrlKey: false, metaKey: false, nativeEvent: { isComposing: false }, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    ;(tree.props.onKeyDownCapture as Function)(e)
    return stops.findIndex((s) => s.focus.mock.calls.length > 0)
  }
  it('PageDown and PageUp move 8 boxes', () => {
    expect(walk('PageDown', 2)).toBe(10)
    expect(walk('PageUp', 12)).toBe(4)
  })
  it('Home and End reach the ends from a box', () => {
    expect(walk('End', 3)).toBe(19)
    expect(walk('Home', 3)).toBe(0)
  })
  it('in the search field, Home and End stay the caret\'s', () => {
    expect(walk('End', 0)).toBe(-1)
  })
})

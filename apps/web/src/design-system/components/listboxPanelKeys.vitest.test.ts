import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

/**
 * Step 4.3 #2 (T1) — `ListboxPanel`'s Enter must commit what the operator is ON, not a hidden row 1.
 *
 * On a short list (no search field, uncontrolled) the panel's highlight is not drawn, starts at 0 and
 * moves only on ↑/↓, while its container's `onKeyDown` answers Enter with `matches[active]` and
 * `preventDefault()` — which also cancels the focused option button's own click. So:
 *   · open the list and press Enter → row 1 was committed, not the selected value;
 *   · Tab to row 3 and press Enter → row 1 was committed, not row 3.
 *
 * apps/web vitest is node-only (no DOM library), so the REAL component runs on a minimal hook runtime:
 * `useState`/`useRef` keep their slots across renders; effects run after a render when their deps
 * change (their DOM reads are null-safe without a DOM). The returned tree carries the real handlers.
 */
const runtime = vi.hoisted(() => ({ slots: [] as unknown[], at: 0, pending: [] as Array<() => void> }))

vi.mock('react', async (original) => {
  const real = await original<typeof import('react')>()
  const useState = (init: unknown) => {
    const i = runtime.at++
    if (!(i in runtime.slots)) runtime.slots[i] = typeof init === 'function' ? (init as () => unknown)() : init
    const set = (next: unknown) => { runtime.slots[i] = typeof next === 'function' ? (next as (v: unknown) => unknown)(runtime.slots[i]) : next }
    return [runtime.slots[i], set]
  }
  const useRef = (init: unknown) => {
    const i = runtime.at++
    if (!(i in runtime.slots)) runtime.slots[i] = { current: init }
    return runtime.slots[i]
  }
  // Effects run after the render, when their deps changed — as React does. Their DOM reads are null-safe here.
  const useEffect = (fn: () => void, deps?: unknown[]) => {
    const i = runtime.at++
    const prev = runtime.slots[i] as unknown[] | undefined
    if (!prev || !deps || deps.some((d, k) => !Object.is(d, prev[k]))) runtime.pending.push(fn)
    runtime.slots[i] = deps
  }
  return { ...real, default: { ...real, useState, useRef, useEffect, useLayoutEffect: useEffect }, useState, useRef, useEffect, useLayoutEffect: useEffect }
})

import { ListboxPanel, type ListboxPanelProps } from './ListboxPanel'

type El = ReactElement<Record<string, unknown>>
const flat = (node: unknown): El[] => {
  if (Array.isArray(node)) return node.flatMap(flat)
  if (!node || typeof node !== 'object' || !('props' in (node as object))) return []
  const el = node as El
  return [el, ...flat((el.props as { children?: unknown }).children)]
}
const render = (props: ListboxPanelProps) => {
  runtime.at = 0
  const el = ListboxPanel(props) as El
  const run = runtime.pending.splice(0)
  for (const fn of run) fn()
  // An effect that set state re-renders, as React would.
  if (run.length) { runtime.at = 0; return ListboxPanel(props) as El }
  return el
}
const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
  { value: 'c', label: 'Charlie' },
  { value: 'd', label: 'Delta' },
]
const enter = (root: El) => (root.props.onKeyDown as (e: unknown) => void)({ key: 'Enter', preventDefault() {} })
const optionEls = (root: El) => flat(root).filter((el) => el.props.role === 'option')

beforeEach(() => { runtime.slots = []; runtime.at = 0; runtime.pending = [] })

describe('ListboxPanel — Enter commits what the operator is on', () => {
  it('opened on a selected value, Enter keeps that value (it used to commit row 1)', () => {
    const onCommit = vi.fn()
    enter(render({ options, value: 'b', onCommit, onCancel() {} }))
    expect(onCommit).toHaveBeenCalledWith('b')
  })

  it('Tab to row 3, then Enter commits row 3 (it used to commit row 1)', () => {
    const onCommit = vi.fn()
    const props: ListboxPanelProps = { options, value: 'a', onCommit, onCancel() {} }
    const charlie = optionEls(render(props))[2]
    ;(charlie.props.onFocus as (() => void) | undefined)?.()
    enter(render(props))
    expect(onCommit).toHaveBeenCalledWith('c')
  })

  it('↓ from the selected row moves to the next one, and Enter commits it', () => {
    const onCommit = vi.fn()
    const props: ListboxPanelProps = { options, value: 'b', onCommit, onCancel() {} }
    ;(render(props).props.onKeyDown as (e: unknown) => void)({ key: 'ArrowDown', preventDefault() {} })
    enter(render(props))
    expect(onCommit).toHaveBeenCalledWith('c')
  })

  it('a HELD option is reachable and announced, and never commits (click or Enter)', () => {
    const onCommit = vi.fn()
    const props: ListboxPanelProps = { options: [...options, { value: 'e', label: 'Echo', heldReason: 'Reconnect the account first.' }], value: 'a', onCommit, onCancel() {} }
    const echo = optionEls(render(props))[4]
    expect(echo.props.disabled).toBeFalsy()
    expect(echo.props['aria-disabled']).toBe(true)
    expect(echo.props['aria-description']).toBe('Reconnect the account first.')
    ;(echo.props.onClick as () => void)()
    ;(echo.props.onFocus as () => void)()
    enter(render(props))
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('a changed search query resets the highlight to the first match (the mount does not)', () => {
    const onCommit = vi.fn()
    const base = { options, onCommit, onCancel() {} }
    render({ ...base, value: 'c', query: '' })
    enter(render({ ...base, value: 'c', query: 'a' }))
    expect(onCommit).toHaveBeenCalledWith('a')
  })

  it('a controlled highlight still decides (the formula editor owns the index) — unchanged', () => {
    const onCommit = vi.fn()
    enter(render({ options, value: 'a', onCommit, onCancel() {}, activeIndex: 3 }))
    expect(onCommit).toHaveBeenCalledWith('d')
  })
})

/**
 * P0 (2026-09-30) — Enter and Tab in a grid list. AG's popup listener runs before this panel's bubble `onKeyDown` and ends the
 * edit with the last reported value, so the panel reports the choice in the CAPTURE phase (`onKeyChoice`) and leaves the
 * commit and the move to the grid. Measured in production: Enter and Tab closed every list with its old value.
 */
describe('ListboxPanel — onKeyChoice reports Enter and Tab before the grid ends the edit', () => {
  const capture = (root: El, key: string) => (root.props.onKeyDownCapture as (e: unknown) => void)({ key, nativeEvent: { isComposing: false }, preventDefault() {} })
  const arrow = (root: El, key: 'ArrowDown' | 'ArrowUp') => (root.props.onKeyDown as (e: unknown) => void)({ key, preventDefault() {} })
  const search = (root: El) => flat(root).find((el) => el.type === 'input')
  const labels = (root: El) => optionEls(root).map((o) => [o.props.children].flat().filter((c) => typeof c === 'string').join(''))

  it.each(['Enter', 'Tab'])('↑ from the first option reaches Clear, and %s reports an empty value', (key) => {
    const onKeyChoice = vi.fn()
    const props: ListboxPanelProps = { options, value: 'a', emptyLabel: 'Clear', onCommit() {}, onCancel() {}, onKeyChoice }
    arrow(render(props), 'ArrowUp')
    capture(render(props), key)
    expect(onKeyChoice).toHaveBeenLastCalledWith('')
  })

  it('Clear stays reachable at the top and ↓ returns to the first option', () => {
    const onKeyChoice = vi.fn()
    const props: ListboxPanelProps = { options, value: 'a', emptyLabel: 'Clear', onCommit() {}, onCancel() {}, onKeyChoice }
    arrow(render(props), 'ArrowUp')
    arrow(render(props), 'ArrowUp')
    capture(render(props), 'Enter')
    expect(onKeyChoice).toHaveBeenLastCalledWith('')
    arrow(render(props), 'ArrowDown')
    capture(render(props), 'Enter')
    expect(onKeyChoice).toHaveBeenLastCalledWith('a')
  })

  it('focusing Clear makes it the choice for both the grid and standalone panel', () => {
    const onKeyChoice = vi.fn()
    const onCommit = vi.fn()
    const props: ListboxPanelProps = { options, value: 'b', emptyLabel: 'Clear', onCommit, onCancel() {} }
    ;(optionEls(render(props))[0].props.onFocus as (() => void) | undefined)?.()
    enter(render(props))
    expect(onCommit).toHaveBeenLastCalledWith('')
    capture(render({ ...props, onKeyChoice }), 'Tab')
    expect(onKeyChoice).toHaveBeenLastCalledWith('')
  })

  it('a stored value outside the list is kept until ↑ explicitly chooses Clear', () => {
    const onKeyChoice = vi.fn()
    const props: ListboxPanelProps = { options, value: 'zz', emptyLabel: 'Clear', onCommit() {}, onCancel() {}, onKeyChoice }
    capture(render(props), 'Enter')
    expect(onKeyChoice).toHaveBeenLastCalledWith(null)
    arrow(render(props), 'ArrowUp')
    capture(render(props), 'Enter')
    expect(onKeyChoice).toHaveBeenLastCalledWith('')
  })

  it('a searching list highlights Clear and reports an empty value', () => {
    const onKeyChoice = vi.fn()
    const props: ListboxPanelProps = { options, value: 'a', emptyLabel: 'Clear', searchable: true, onCommit() {}, onCancel() {}, onKeyChoice }
    arrow(render(props), 'ArrowUp')
    const root = render(props)
    expect(optionEls(root)[0].props.className).toContain('active')
    capture(root, 'Enter')
    expect(onKeyChoice).toHaveBeenLastCalledWith('')
  })

  it('Clear remains the choice when an empty list has no option below it', () => {
    const onKeyChoice = vi.fn()
    const props: ListboxPanelProps = { options: [], value: 'unavailable', emptyLabel: 'Clear', onCommit() {}, onCancel() {}, onKeyChoice }
    arrow(render(props), 'ArrowUp')
    arrow(render(props), 'ArrowDown')
    capture(render(props), 'Enter')
    expect(onKeyChoice).toHaveBeenLastCalledWith('')
  })

  it('an explicit empty option is not duplicated, and ↑ can choose it', () => {
    const onKeyChoice = vi.fn()
    const props: ListboxPanelProps = { options: [{ value: '', label: 'None' }, ...options], value: 'a', emptyLabel: 'Clear', onCommit() {}, onCancel() {}, onKeyChoice }
    expect(optionEls(render(props))).toHaveLength(options.length + 1)
    arrow(render(props), 'ArrowUp')
    capture(render(props), 'Enter')
    expect(onKeyChoice).toHaveBeenLastCalledWith('')
  })

  it('Enter reports the highlighted row, and the panel does not also commit it', () => {
    const onCommit = vi.fn()
    const onKeyChoice = vi.fn()
    const root = render({ options, value: 'b', onCommit, onCancel() {}, onKeyChoice })
    capture(root, 'Enter')
    enter(root)
    expect(onKeyChoice).toHaveBeenCalledWith('b')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('Tab reports the row ↓ moved to', () => {
    const onKeyChoice = vi.fn()
    const props: ListboxPanelProps = { options, value: 'b', onCommit() {}, onCancel() {}, onKeyChoice }
    arrow(render(props), 'ArrowDown')
    capture(render(props), 'Tab')
    expect(onKeyChoice).toHaveBeenCalledWith('c')
  })

  it('a stored value the list does not hold highlights nothing: Enter reports null, and ↓ reaches row 1', () => {
    const onKeyChoice = vi.fn()
    const props: ListboxPanelProps = { options, value: 'zz', onCommit() {}, onCancel() {}, onKeyChoice }
    capture(render(props), 'Enter')
    expect(onKeyChoice).toHaveBeenLastCalledWith(null)
    arrow(render(props), 'ArrowDown')
    capture(render(props), 'Enter')
    expect(onKeyChoice).toHaveBeenLastCalledWith('a')
  })

  it('without onKeyChoice, Enter on a value the list does not hold commits nothing (it committed row 1)', () => {
    const onCommit = vi.fn()
    enter(render({ options, value: 'zz', onCommit, onCancel() {} }))
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('initialQuery starts the search with the key that opened the cell, on the best match', () => {
    const onKeyChoice = vi.fn()
    const root = render({ options, onCommit() {}, onCancel() {}, onKeyChoice, initialQuery: 'Ch' })
    expect(search(root)?.props.value).toBe('Ch')
    capture(root, 'Enter')
    expect(onKeyChoice).toHaveBeenCalledWith('c')
  })

  it('allowCustom offers the typed text as the only row when nothing matches, and Enter takes it', () => {
    const onKeyChoice = vi.fn()
    const root = render({ options, onCommit() {}, onCancel() {}, onKeyChoice, allowCustom: true, initialQuery: 'Xavia Racing' })
    expect(labels(root)).toEqual(['Use "Xavia Racing"'])
    capture(root, 'Enter')
    expect(onKeyChoice).toHaveBeenCalledWith('Xavia Racing')
  })

  it('allowCustom shows the typed text FIRST, but Enter takes the best match and ↑ takes the typed text', () => {
    const onKeyChoice = vi.fn()
    const props: ListboxPanelProps = { options, onCommit() {}, onCancel() {}, onKeyChoice, allowCustom: true, initialQuery: 'lt' }
    const rows = labels(render(props))
    expect(rows[0]).toBe('Use "lt"')
    expect(rows.length).toBeGreaterThan(1)
    capture(render(props), 'Enter')
    expect(onKeyChoice).toHaveBeenLastCalledWith(options.find((o) => o.label === rows[1])!.value)
    arrow(render(props), 'ArrowUp')
    capture(render(props), 'Enter')
    expect(onKeyChoice).toHaveBeenLastCalledWith('lt')
  })

  it('Enter is not also a click on a focused option (the capture handler takes the default)', () => {
    const root = render({ options, value: 'b', onCommit() {}, onCancel() {}, onKeyChoice: vi.fn() })
    const preventDefault = vi.fn()
    ;(root.props.onKeyDownCapture as (e: unknown) => void)({ key: 'Enter', nativeEvent: { isComposing: false }, preventDefault })
    expect(preventDefault).toHaveBeenCalled()
  })

  it('allowCustom adds nothing for an exact match, whatever the case', () => {
    const root = render({ options, onCommit() {}, onCancel() {}, allowCustom: true, initialQuery: 'bravo' })
    expect(labels(root).some((l) => l.startsWith('Use '))).toBe(false)
  })
})

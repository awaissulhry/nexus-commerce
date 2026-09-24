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

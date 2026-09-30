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
    void tree
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

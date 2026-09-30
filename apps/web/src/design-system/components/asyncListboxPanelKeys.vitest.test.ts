import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

/**
 * P0 (2026-09-30) — the category / product-type / reference picker must never replace the stored value with a choice the
 * operator did not make. It highlighted the first loaded choice when the stored one was not on the loaded page, so opening
 * Amazon's product types (the first 50 of 1,875) on OUTERWEAR and pressing Enter saved 3D_PRINTABLE_DESIGNS.
 *
 * Same node-only hook runtime as `listboxPanelKeys.vitest.test.ts`: the real component runs, and the tree carries its handlers.
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
  const useEffect = (fn: () => void, deps?: unknown[]) => {
    const i = runtime.at++
    const prev = runtime.slots[i] as unknown[] | undefined
    if (!prev || !deps || deps.some((d, k) => !Object.is(d, prev[k]))) runtime.pending.push(fn)
    runtime.slots[i] = deps
  }
  const useId = () => 'id'
  return { ...real, default: { ...real, useState, useEffect, useId }, useState, useEffect, useId }
})

import { AsyncListboxPanel, type AsyncListboxPanelProps } from './AsyncListboxPanel'

type El = ReactElement<Record<string, unknown>>
const flat = (node: unknown): El[] => {
  if (Array.isArray(node)) return node.flatMap(flat)
  if (!node || typeof node !== 'object' || !('props' in (node as object))) return []
  const el = node as El
  return [el, ...flat((el.props as { children?: unknown }).children)]
}
const render = (props: AsyncListboxPanelProps) => {
  runtime.at = 0
  AsyncListboxPanel(props)
  for (const fn of runtime.pending.splice(0)) fn()
  runtime.at = 0
  return AsyncListboxPanel(props) as El
}
class FakeInput {}
const key = (root: El, k: string, target: unknown = new FakeInput()) => {
  const event = { key: k, target, nativeEvent: { isComposing: false }, preventDefault: vi.fn(), stopPropagation: vi.fn() }
  ;(root.props.onKeyDownCapture as (e: unknown) => void)(event)
  return event
}
const firstPage = [{ value: '3D_PRINTABLE_DESIGNS', label: '3D printable designs' }, { value: 'ABRASIVE_DISCS', label: 'Abrasive discs' }]
const base = (extra: Partial<AsyncListboxPanelProps> = {}): AsyncListboxPanelProps => ({
  label: 'Search Amazon product types', query: '', onQueryChange() {}, options: firstPage, onCommit: vi.fn(), onCancel: vi.fn(), ...extra,
})

beforeEach(() => { runtime.slots = []; runtime.at = 0; runtime.pending = []; vi.stubGlobal('HTMLInputElement', FakeInput) })

describe('AsyncListboxPanel — the stored value is kept unless the operator chooses another', () => {
  it('stored value not on the loaded page: Enter keeps it (cancel), never commits row 1', () => {
    const props = base({ value: 'OUTERWEAR' })
    key(render(props), 'Enter')
    expect(props.onCommit).not.toHaveBeenCalled()
    expect(props.onCancel).toHaveBeenCalledOnce()
  })
  it('names the stored value when the page does not show it', () => {
    const texts = flat(render(base({ value: 'OUTERWEAR', currentLabel: 'OUTERWEAR' }))).map((el) => el.props.children).flat()
    expect(texts).toContain('OUTERWEAR')
  })
  it('stored value on the page: Enter commits that value (the editor then treats it as unchanged)', () => {
    const props = base({ value: 'ABRASIVE_DISCS' })
    key(render(props), 'Enter')
    expect(props.onCommit).toHaveBeenCalledWith('ABRASIVE_DISCS')
  })
  it('a search highlights the first match, and Enter commits it', () => {
    const props = base({ value: 'OUTERWEAR', query: '3d' })
    key(render(props), 'Enter')
    expect(props.onCommit).toHaveBeenCalledWith('3D_PRINTABLE_DESIGNS')
  })
  it('↓ from nothing reaches row 1', () => {
    const props = base({ value: 'OUTERWEAR' })
    key(render(props), 'ArrowDown')
    key(render(props), 'Enter')
    expect(props.onCommit).toHaveBeenCalledWith('3D_PRINTABLE_DESIGNS')
  })
  it('Tab reports the highlighted choice to the grid and does not stop the key', () => {
    const onKeyChoice = vi.fn()
    const props = base({ value: 'OUTERWEAR', query: 'abr', onKeyChoice })
    const event = key(render(props), 'Tab')
    expect(onKeyChoice).toHaveBeenCalledWith('3D_PRINTABLE_DESIGNS')
    expect(event.stopPropagation).not.toHaveBeenCalled()
  })
})

describe('AsyncListboxPanel — a typed key that searches for nothing keeps the stored value (audit B15)', () => {
  it.each(['-', '&', '#'])('%s then Enter commits the stored value, not the first choice', (typed) => {
    const props = base({ value: 'ABRASIVE_DISCS', query: typed })
    key(render(props), 'Enter')
    expect(props.onCommit).toHaveBeenCalledWith('ABRASIVE_DISCS')
  })
})

describe('AsyncListboxPanel — Clear (audit B16)', () => {
  it('↑ from the first choice reaches Clear, and Enter commits an empty value', () => {
    const props = base({ value: 'ABRASIVE_DISCS', emptyLabel: 'Clear' })
    key(render(props), 'ArrowUp')
    key(render(props), 'ArrowUp')
    key(render(props), 'Enter')
    expect(props.onCommit).toHaveBeenCalledWith('')
  })
  it('Tab on Clear reports an empty value to the grid, and ↓ leaves it for the first choice', () => {
    const onKeyChoice = vi.fn()
    const props = base({ value: 'OUTERWEAR', emptyLabel: 'Clear', onKeyChoice })
    key(render(props), 'ArrowUp')
    key(render(props), 'Tab')
    expect(onKeyChoice).toHaveBeenLastCalledWith('')
    key(render(props), 'ArrowDown')
    key(render(props), 'Tab')
    expect(onKeyChoice).toHaveBeenLastCalledWith('3D_PRINTABLE_DESIGNS')
  })
  it('a stored value can be cleared before any choice is loaded (an eBay category before its search)', () => {
    const tree = render(base({ value: '11450', options: [], emptyLabel: 'Clear' }))
    const panel = flat(tree).find((el) => (el.props as { emptyLabel?: string }).emptyLabel === 'Clear' && 'activeIndex' in el.props)
    expect(panel).toBeDefined()
  })
  it('without emptyLabel nothing changes: ↑ from nothing stays on nothing', () => {
    const props = base({ value: 'OUTERWEAR' })
    key(render(props), 'ArrowUp')
    key(render(props), 'Enter')
    expect(props.onCommit).not.toHaveBeenCalled()
  })
})

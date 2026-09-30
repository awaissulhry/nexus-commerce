import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

/**
 * Audit B10, B14, B18 (2026-09-30) — ONE Enter for every editor kind on the product sheets, as `GridSheet` states the
 * contract: "Enter commits and moves DOWN".
 *
 * AG moves down after an edit only when the edit is ended with the Enter KeyboardEvent itself (`navigateAfterEdit`). So an
 * editor passes when its Enter either reaches the grid untouched (AG ends it and moves) or is ended by the editor with
 * `stopEditing(false, <that event>)`. Anything else — `stopEditing()` with no key, the grid API's cancel, a stopped key
 * that ends nothing — leaves the cursor on the saved cell, and the next keystroke overwrites it. Before this fix the text,
 * number, long-text, bullets, category, product-type and reference editors all stayed, while the lists moved.
 *
 * Two Enters never reach the grid: Ctrl/Cmd+Enter (AG would write the value into every selected cell, unfenced — B14; the
 * editor saves its one cell and moves down instead) and an Enter that confirms an IME composition (B18; nothing ends).
 *
 * apps/web vitest is node-only, so each editor's render function is called on a minimal hook runtime and the returned
 * tree carries its real handlers; the list panels the editors render are the REAL `ListboxPanel` / `AsyncListboxPanel`.
 */
const runtime = vi.hoisted(() => ({ slots: [] as unknown[], at: 0, pending: [] as Array<() => void>, effects: false }))

vi.mock('react', async (original) => {
  const real = await original<typeof import('react')>()
  const slot = <T,>(init: () => T): [number, T] => {
    const i = runtime.at++
    if (!(i in runtime.slots)) runtime.slots[i] = init()
    return [i, runtime.slots[i] as T]
  }
  const useState = (init: unknown) => {
    const [i, v] = slot(() => (typeof init === 'function' ? (init as () => unknown)() : init))
    return [v, (next: unknown) => { runtime.slots[i] = typeof next === 'function' ? (next as (x: unknown) => unknown)(runtime.slots[i]) : next }]
  }
  const useRef = (init: unknown) => slot(() => ({ current: init }))[1]
  const useEffect = (fn: () => void, deps?: unknown[]) => {
    const i = runtime.at++
    const prev = runtime.slots[i] as unknown[] | undefined
    if (runtime.effects && (!prev || !deps || deps.some((d, k) => !Object.is(d, prev[k])))) runtime.pending.push(fn)
    runtime.slots[i] = deps ?? []
  }
  const hooks = {
    useState, useRef, useEffect, useLayoutEffect: useEffect,
    useCallback: (fn: unknown) => fn,
    useMemo: (fn: () => unknown) => fn(),
    useId: () => 'id',
    useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  }
  return { ...real, default: { ...real, ...hooks }, ...hooks }
})
vi.mock('ag-grid-react', () => ({ useGridCellEditor: () => {} }))
vi.mock('@/lib/workspaces/Link', () => ({ default: () => null }))
vi.mock('@/app/catalog/categories/api', () => ({ categoryHref: () => '/' }))
vi.mock('@/app/products/[id]/edit/_studio/sheet/categoryOptions', () => ({ loadCategoryOptions: () => new Promise(() => {}) }))
vi.mock('@/app/products/[id]/edit/_studio/sheet/referenceOptions', () => ({ loadReferenceChoices: () => new Promise(() => {}) }))
vi.mock('@/app/products/[id]/edit/_studio/sheet/ebayPolicies', () => ({ loadEbayPolicies: () => new Promise(() => {}), policyLists: { fulfillmentPolicyId: 'fulfillment' } }))

import { ListboxPanel } from '../../components/ListboxPanel'
import { AsyncListboxPanel } from '../../components/AsyncListboxPanel'
import { SelectPanelEditor } from './SelectPanelEditor'
import { MeasureEditor } from './MeasureEditor'
import { ListPanelEditor } from './ListPanelEditor'
import { FormulaCellEditor } from './FormulaCellEditor'
import { SlotListEditor } from './SlotListEditor'
import { SLOT_LIST_EDITOR_CLASS } from './slotList'
import { ChannelCategoryEditor } from '@/app/products/[id]/edit/_studio/sheet/ChannelCategoryEditor'
import { ReferenceSelectEditor } from '@/app/products/[id]/edit/_studio/sheet/ReferenceSelectEditor'
import { EbayPolicyEditor } from '@/app/products/[id]/edit/_studio/sheet/EbayPolicyInput'

type El = ReactElement<Record<string, any>>
const flat = (node: unknown): El[] => {
  if (Array.isArray(node)) return node.flatMap(flat)
  if (!node || typeof node !== 'object' || !('props' in (node as object))) return []
  const el = node as El
  return [el, ...flat(el.props.children)]
}
/** Call a component (plain or forwardRef) on the runtime; run its effects once, as React would after a commit. */
const call = (component: unknown, props: Record<string, unknown>): El => {
  const fn = (component as { render?: Function }).render ?? (component as Function)
  runtime.at = 0
  let out = fn(props, null) as El
  const run = runtime.pending.splice(0)
  for (const effect of run) effect()
  if (run.length) { runtime.at = 0; out = fn(props, null) as El }
  return out
}
const child = (tree: El, type: unknown) => flat(tree).find((el) => el.type === type)!

class FakeInput {}
const slotField = { closest: (selector: string) => selector === `.${SLOT_LIST_EDITOR_CLASS}` ? { getAttribute: () => '1' } : selector === '[data-nds-reorder-item]' ? { parentElement: { children: [] } } : null }
type Kind = 'plain' | 'ranged' | 'composing'
const enter = (kind: Kind, target: unknown = new FakeInput()) => {
  const nativeEvent = { key: 'Enter', isComposing: kind === 'composing', shiftKey: false }
  return { key: 'Enter', ctrlKey: kind === 'ranged', metaKey: false, shiftKey: false, altKey: false, target, nativeEvent, preventDefault: vi.fn(), stopPropagation: vi.fn() }
}

/** What happens to the cursor after this Enter. */
function outcome(ev: ReturnType<typeof enter>, stopEditing: ReturnType<typeof vi.fn>, api: { stopEditing: ReturnType<typeof vi.fn> }) {
  const endedWithKey = stopEditing.mock.calls.some(([suppress, key]) => !suppress && key === ev.nativeEvent)
  if (endedWithKey) return 'the editor ends it with the key: AG moves down'
  if (!ev.stopPropagation.mock.calls.length && !stopEditing.mock.calls.length && !api.stopEditing.mock.calls.length) return 'the grid ends it: AG moves down'
  if (ev.stopPropagation.mock.calls.length && !stopEditing.mock.calls.length && !api.stopEditing.mock.calls.length) return 'kept from the grid: the edit stays open'
  return 'ended without the key: the cursor stays'
}

type Case = { name: string; press: (ev: ReturnType<typeof enter>, grid: { stopEditing: any; api: any }) => void }
const params = (grid: { stopEditing: any; api: any }, extra: Record<string, unknown>) => ({
  column: { getActualWidth: () => 180, getColId: () => 'c' }, node: { id: 'p1', rowIndex: 0 }, onValueChange: vi.fn(), ...grid, ...extra,
})
/** An editor that renders the real `ListboxPanel`: press Enter on the panel it renders. */
const viaListbox = (component: unknown, extra: Record<string, unknown>) => (ev: ReturnType<typeof enter>, grid: { stopEditing: any; api: any }) => {
  const editor = call(component, params(grid, extra))
  const panelProps = child(editor, ListboxPanel).props
  runtime.slots = []
  ;(call(ListboxPanel, panelProps as never).props.onKeyDownCapture as Function)(ev)
}
/** An editor that renders the real `AsyncListboxPanel`, its choices loaded. */
const viaAsync = (component: unknown, extra: Record<string, unknown>) => (ev: ReturnType<typeof enter>, grid: { stopEditing: any; api: any }) => {
  const editor = call(component, params(grid, extra))
  const panelProps = { ...child(editor, AsyncListboxPanel).props, loading: false, error: undefined, options: [{ value: 'A', label: 'Alpha' }, { value: 'B', label: 'Bravo' }] }
  runtime.slots = []
  runtime.effects = true
  ;(call(AsyncListboxPanel, panelProps).props.onKeyDownCapture as Function)(ev)
}
const onRoot = (component: unknown, extra: Record<string, unknown>, target?: unknown) => (ev: ReturnType<typeof enter>, grid: { stopEditing: any; api: any }) => {
  const root = call(component, params(grid, extra))
  if (target !== undefined) ev.target = target
  ;(root.props.onKeyDownCapture as Function)(ev)
}

const CASES: Case[] = [
  { name: 'select list (SelectPanelEditor)', press: viaListbox(SelectPanelEditor, { value: 'B', options: [{ value: 'A', label: 'Alpha' }, { value: 'B', label: 'Bravo' }] }) },
  { name: 'measure — number field (MeasureEditor)', press: onRoot(MeasureEditor, { value: { value: 1, unit: 'kilograms' }, unitOptions: ['kilograms', 'grams'] }) },
  { name: 'measure — unit list (MeasureEditor)', press: viaListbox(MeasureEditor, { value: { value: 1, unit: 'kilograms' }, unitOptions: ['kilograms', 'grams'] }) },
  { name: 'multi-value list with options (ListPanelEditor)', press: onRoot(ListPanelEditor, { value: ['A'], options: [{ value: 'A', label: 'A' }] }) },
  { name: 'free-text list (ListPanelEditor)', press: onRoot(ListPanelEditor, { value: ['a'] }) },
  { name: 'text, number and long text (FormulaCellEditor)', press: onRoot(FormulaCellEditor, { value: 'Xavia', candidates: [], preview: vi.fn(), formulas: false }, null) },
  { name: 'bullets (SlotListEditor)', press: onRoot(SlotListEditor, { value: ['one'], slotList: { mode: 'list', max: null, maxLength: null, itemLabel: 'Bullet', label: 'Bullet points' } }, slotField) },
  { name: 'eBay / Etsy category, Amazon product type (ChannelCategoryEditor)', press: viaAsync(ChannelCategoryEditor, { value: 'B', channel: 'AMAZON', market: 'IT' }) },
  { name: 'reference (ReferenceSelectEditor)', press: viaAsync(ReferenceSelectEditor, { value: 'B', fieldKey: 'shop_section_id', market: 'IT' }) },
  { name: 'eBay business policy (EbayPolicyEditor)', press: viaAsync(EbayPolicyEditor, { value: 'B', fieldKey: 'fulfillmentPolicyId', market: 'IT' }) },
]

beforeEach(() => {
  runtime.slots = []; runtime.at = 0; runtime.pending = []; runtime.effects = false
  vi.stubGlobal('HTMLInputElement', FakeInput)
  vi.stubGlobal('Node', Object)
  vi.stubGlobal('window', { innerWidth: 1200 })
})

describe('Enter commits and moves down, in every editor kind (B10)', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const grid = { stopEditing: vi.fn(), api: { stopEditing: vi.fn() } }
    const ev = enter('plain')
    c.press(ev, grid)
    expect(outcome(ev, grid.stopEditing, grid.api)).toMatch(/AG moves down/)
  })
})

describe('Ctrl/Cmd+Enter never reaches the grid: it saves this one cell and moves down (B14)', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const grid = { stopEditing: vi.fn(), api: { stopEditing: vi.fn() } }
    const ev = enter('ranged')
    c.press(ev, grid)
    expect(ev.stopPropagation).toHaveBeenCalled()
    expect(outcome(ev, grid.stopEditing, grid.api)).toBe('the editor ends it with the key: AG moves down')
  })
})

describe('an Enter that confirms an IME composition ends nothing (B18)', () => {
  it.each(CASES.filter((c) => !c.name.startsWith('text,') && !c.name.startsWith('bullets')).map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const grid = { stopEditing: vi.fn(), api: { stopEditing: vi.fn() } }
    const ev = enter('composing')
    c.press(ev, grid)
    expect(outcome(ev, grid.stopEditing, grid.api)).toBe('kept from the grid: the edit stays open')
  })
})

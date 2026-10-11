import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

/**
 * Keyword Harvest DS lane H1 (2026-10-10) — commands under a list ("+ New campaign…", "+ New portfolio…").
 *
 * They are BUTTONS, not options: outside the `listbox`, reached by ↓ past the last option and by Tab, run by Enter or a
 * click, held ones say why and never run. Without `actions` the panel is exactly as before (the other ListboxPanel tests).
 *
 * apps/web vitest is node-only, so the real component runs on the same minimal hook runtime as `listboxPanelKeys`.
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
  if (run.length) { runtime.at = 0; return ListboxPanel(props) as El }
  return el
}
const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
]
const key = (root: El, k: string, extra: Record<string, unknown> = {}) =>
  (root.props.onKeyDown as (e: unknown) => void)({ key: k, preventDefault() {}, ...extra })
const actionEls = (root: El) => flat(root).filter((el) => el.props['data-listbox-action'] != null)
const byRole = (root: El, role: string) => flat(root).filter((el) => el.props.role === role)

beforeEach(() => { runtime.slots = []; runtime.at = 0; runtime.pending = [] })

describe('ListboxPanel — action rows (H1)', () => {
  const make = () => {
    const newCampaign = vi.fn()
    const newPortfolio = vi.fn()
    const props: ListboxPanelProps = {
      options, value: 'a', onCommit: vi.fn(), onCancel() {}, ariaLabel: 'Destination',
      actions: [
        { id: 'campaign', label: 'New campaign…', onSelect: newCampaign },
        { id: 'portfolio', label: 'New portfolio…', onSelect: newPortfolio, heldReason: 'Pick terms of one product first.' },
      ],
    }
    return { props, newCampaign, newPortfolio }
  }

  it('renders them as buttons in their own group, OUTSIDE the listbox, which keeps only the options', () => {
    const { props } = make()
    const root = render(props)
    expect(root.props.role).toBe('dialog')
    const [list] = byRole(root, 'listbox')
    expect(list).toBeDefined()
    expect(flat(list).filter((el) => el.props.role === 'option')).toHaveLength(2)
    expect(flat(list).some((el) => el.props['data-listbox-action'] != null)).toBe(false)
    const actions = actionEls(root)
    expect(actions.map((a) => a.props.role)).toEqual([undefined, undefined])
    expect(actions.map((a) => a.type)).toEqual(['button', 'button'])
    expect(byRole(root, 'group').some((g) => g.props['aria-label'] === 'Actions')).toBe(true)
  })

  it('↓ walks from the last option into the actions; Enter runs the one it is on, and commits nothing', () => {
    const { props, newCampaign } = make()
    key(render(props), 'ArrowDown') // a → b
    key(render(props), 'ArrowDown') // b → New campaign…
    key(render(props), 'Enter')
    expect(newCampaign).toHaveBeenCalledTimes(1)
    expect(props.onCommit).not.toHaveBeenCalled()
  })

  it('↓ stops at the last action, ↑ walks back into the options', () => {
    const { props } = make()
    for (let i = 0; i < 5; i += 1) key(render(props), 'ArrowDown')
    key(render(props), 'ArrowUp') // portfolio → campaign
    key(render(props), 'ArrowUp') // campaign → b
    key(render(props), 'Enter')
    expect(props.onCommit).toHaveBeenCalledWith('b')
  })

  it('a click or a focus+Enter runs an action; Enter on a focused action button is left to its own click', () => {
    const { props, newCampaign } = make()
    const [campaign] = actionEls(render(props))
    ;(campaign.props.onClick as () => void)()
    expect(newCampaign).toHaveBeenCalledTimes(1)
    const prevent = vi.fn()
    key(render(props), 'Enter', { target: { closest: (sel: string) => (sel.includes('data-listbox-action') ? {} : null) }, preventDefault: prevent })
    expect(prevent).not.toHaveBeenCalled()
    expect(newCampaign).toHaveBeenCalledTimes(1)
  })

  it('a HELD action is reachable and says why, and never runs (click or Enter)', () => {
    const { props, newPortfolio } = make()
    const [, portfolio] = actionEls(render(props))
    expect(portfolio.props.disabled).toBeFalsy()
    expect(portfolio.props['aria-disabled']).toBe(true)
    expect(portfolio.props['aria-description']).toBe('Pick terms of one product first.')
    ;(portfolio.props.onClick as () => void)()
    ;(portfolio.props.onFocus as () => void)()
    key(render(props), 'Enter')
    expect(newPortfolio).not.toHaveBeenCalled()
  })

  it('a searching panel highlights the action it walked to, and Enter runs it from the search field', () => {
    const { props, newCampaign } = make()
    const searching = { ...props, searchable: true }
    key(render(searching), 'ArrowDown')
    key(render(searching), 'ArrowDown')
    const root = render(searching)
    expect(actionEls(root)[0].props.className).toContain('active')
    key(root, 'Enter')
    expect(newCampaign).toHaveBeenCalledTimes(1)
  })

  it('with no match, ↓ still reaches the first action', () => {
    const { props, newCampaign } = make()
    const none = { ...props, options: [], value: undefined }
    key(render(none), 'ArrowDown')
    key(render(none), 'Enter')
    expect(newCampaign).toHaveBeenCalledTimes(1)
  })

  it('without actions the panel is the listbox itself, as before', () => {
    const root = render({ options, value: 'a', onCommit() {}, onCancel() {} })
    expect(root.props.role).toBe('listbox')
    expect(actionEls(root)).toHaveLength(0)
  })
})

/**
 * Lead review (2026-10-11): the picker lives INSIDE a Modal ("Harvest to…"). Tab off the last action must not leave the
 * dialog with the list still open. The DS MultiSelect / Menu rule: leaving the panel closes it onto its trigger
 * (`onCancel` — Listbox focuses the trigger), then the browser's Tab goes on to the next control inside the Modal.
 */
describe('ListboxPanel — Tab and Esc with action rows (inside a Modal)', () => {
  /** A stand-in panel DOM: the search field and two action buttons. `root.props.ref` is the panel's callback ref (React 19). */
  const dom = () => {
    const focused: string[] = []
    const mk = (name: string) => { const el = { name, focus: () => { focused.push(name) }, contains: (n: unknown) => n === el }; return el }
    const input = mk('search')
    const campaign = mk('campaign')
    const portfolio = mk('portfolio')
    const host = {
      querySelectorAll: (sel: string) => (sel.includes('data-listbox-action') ? [campaign, portfolio] : []),
      querySelector: (sel: string) => (sel.includes('nds-combo-search') ? input : null),
    }
    return { focused, input, campaign, portfolio, host }
  }
  const setup = () => {
    const onCancel = vi.fn()
    const props: ListboxPanelProps = {
      options, value: 'a', onCommit() {}, onCancel, searchable: true,
      actions: [{ id: 'campaign', label: 'New campaign…', onSelect() {} }, { id: 'portfolio', label: 'New portfolio…', onSelect() {} }],
    }
    const d = dom()
    const root = render(props)
    ;(root.props.ref as (n: unknown) => void)(d.host)
    const tab = (target: unknown, shiftKey = false) => {
      const preventDefault = vi.fn()
      ;(root.props.onKeyDown as (e: unknown) => void)({ key: 'Tab', shiftKey, target, preventDefault, nativeEvent: { isComposing: false } })
      return preventDefault.mock.calls.length > 0
    }
    return { onCancel, d, tab, root }
  }

  it('Tab walks search → New campaign… → New portfolio…, inside the panel', () => {
    const { d, tab, onCancel } = setup()
    expect(tab(d.input)).toBe(true)
    expect(tab(d.campaign)).toBe(true)
    expect(d.focused).toEqual(['campaign', 'portfolio'])
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('Tab off the LAST action closes the panel onto its trigger and lets the Tab go on (to the next control in the Modal)', () => {
    const { d, tab, onCancel } = setup()
    expect(tab(d.portfolio)).toBe(false)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(d.focused).toEqual([])
  })

  it('Shift+Tab walks back to the search field, and off the list it closes the panel, keeping the focus on the trigger', () => {
    const { d, tab, onCancel } = setup()
    expect(tab(d.portfolio, true)).toBe(true)
    expect(tab(d.campaign, true)).toBe(true)
    expect(d.focused).toEqual(['campaign', 'search'])
    expect(onCancel).not.toHaveBeenCalled()
    expect(tab(d.input, true)).toBe(true)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('Esc closes only the panel: it is marked as used, so a Modal around it stays open', () => {
    const { root, onCancel } = setup()
    const preventDefault = vi.fn()
    ;(root.props.onKeyDown as (e: unknown) => void)({ key: 'Escape', preventDefault })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalled()
  })
})

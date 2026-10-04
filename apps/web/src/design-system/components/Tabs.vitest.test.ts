import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Exercise the bar's scroll effect in Node with React's own rule for effects: run on mount, then whenever a dependency
// is not Object.is-equal to the last render's (the previous run is cleaned up first). The strip is a stand-in 100 px
// wide whose tabs are 60 px each, laid out in order: it records every scroll it is asked for.
const harness = vi.hoisted(() => ({
  deps: [] as Array<readonly unknown[] | undefined>,
  cleanups: [] as Array<(() => void) | void>,
  at: 0,
  ref: { current: null as unknown },
  ids: [] as string[],
  width: 60,
  scrollLeft: 0,
  scrolls: [] as number[],
  observers: [] as Array<{ callback: () => void; observed: number; live: boolean }>,
}))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useRef: () => harness.ref,
  useId: () => 'tabs',
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => (() => void) | void, deps?: readonly unknown[]) => {
    const at = harness.at++
    const last = harness.deps[at]
    if (last && deps && deps.length === last.length && deps.every((dep, i) => Object.is(dep, last[i]))) return
    harness.cleanups[at]?.()
    harness.deps[at] = deps
    harness.cleanups[at] = effect()
  },
}))
vi.stubGlobal('CSS', { escape: (value: string) => value })
vi.stubGlobal('ResizeObserver', class {
  entry: { callback: () => void; observed: number; live: boolean }
  constructor(callback: () => void) { this.entry = { callback, observed: 0, live: true }; harness.observers.push(this.entry) }
  observe() { this.entry.observed += 1 }
  disconnect() { this.entry.live = false }
})
afterAll(() => vi.unstubAllGlobals())

import { Tabs, type TabItem } from './Tabs'

const tabs = (...ids: string[]): TabItem[] => ids.map(id => ({ id, label: `${id} · checking…` }))
const render = (items: TabItem[], active: string, scroll = true) => {
  harness.ids = items.map(tab => tab.id)
  harness.at = 0
  Tabs({ ariaLabel: 'Chosen markets', tabs: items, active, onChange: () => {}, ...(scroll ? { overflow: 'scroll' as const } : {}) })
}
/** A label grew: every tab is wider now, and the live observer hears it. */
const labelsGrow = (width: number) => { harness.width = width; harness.observers.filter(o => o.live).forEach(o => o.callback()) }
const tabRect = (id: string) => {
  const at = harness.ids.indexOf(id)
  const left = at * harness.width - harness.scrollLeft
  return { left, right: left + harness.width }
}

describe('Tabs keeps the active tab in view', () => {
  beforeEach(() => {
    harness.deps = []; harness.cleanups = []; harness.scrolls = []; harness.observers = []; harness.scrollLeft = 0; harness.width = 60
    harness.ref.current = {
      getBoundingClientRect: () => ({ left: 0, right: 100 }),
      get scrollLeft() { return harness.scrollLeft },
      set scrollLeft(value: number) { harness.scrollLeft = value; harness.scrolls.push(value) },
      querySelector: (selector: string) => {
        const id = /data-tab-id="([^"]*)"/.exec(selector)?.[1] ?? ''
        return harness.ids.includes(id) ? { getBoundingClientRect: () => tabRect(id) } : null
      },
      querySelectorAll: () => harness.ids.map(() => ({})),
    }
  })

  it('scrolls the strip to the active tab when the active tab changes, and not when it is already in view', () => {
    render(tabs('DE', 'IT'), 'DE')
    expect(harness.scrolls).toEqual([])
    render(tabs('DE', 'IT'), 'IT')
    expect(harness.scrolls).toEqual([20])
  })

  it('scrolls again when tabs are added before the active one (listed markets chosen after the sheet\'s own, 390 px)', () => {
    render(tabs('IT'), 'IT')
    render(tabs('DE', 'ES', 'FR', 'IT'), 'IT')
    expect(harness.scrolls).toEqual([140])
    // One removed before it moves it again (here: back).
    render(tabs('DE', 'IT'), 'IT')
    expect(harness.scrolls).toEqual([140, 60])
  })

  it('follows a label that grows after the tab was shown (the market\'s words arrive once it is checked)', () => {
    render(tabs('DE', 'IT'), 'IT')
    expect(harness.scrolls).toEqual([20])
    labelsGrow(90)
    expect(harness.scrolls).toEqual([20, 80])
    expect(harness.observers.filter(o => o.live)).toHaveLength(1)
    expect(harness.observers[0].observed).toBe(2)
  })

  it('does not scroll when only the labels\' words change at the same size, or nothing changes', () => {
    render(tabs('DE', 'IT'), 'IT')
    render(tabs('DE', 'IT').map(tab => ({ ...tab, label: `${tab.id} · 12 changes` })), 'IT')
    render(tabs('DE', 'IT'), 'IT')
    labelsGrow(60)
    expect(harness.scrolls).toEqual([20])
  })

  it('stops following the old tabs once they change (one observer at a time)', () => {
    render(tabs('IT'), 'IT')
    render(tabs('DE', 'IT'), 'IT')
    expect(harness.observers.map(o => o.live)).toEqual([false, true])
  })

  it('never scrolls a bar that does not overflow', () => {
    render(tabs('IT'), 'IT', false)
    render(tabs('DE', 'ES', 'FR', 'IT'), 'IT', false)
    labelsGrow(90)
    expect(harness.scrolls).toEqual([])
    expect(harness.observers).toEqual([])
  })
})

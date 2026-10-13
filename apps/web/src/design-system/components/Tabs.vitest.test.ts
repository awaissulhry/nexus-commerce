import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Exercise the bar's scroll effect in Node with React's own rule for effects: run on mount, then whenever a dependency
// is not Object.is-equal to the last render's (the previous run is cleaned up first). The strip is a stand-in 100 px
// wide whose tabs are 240 px each, laid out in order: it records every scroll it is asked for. (400 / 240 since polish
// round 2: the edge fade, 56 px, needs a strip wider than two fades.)
const harness = vi.hoisted(() => ({
  deps: [] as Array<readonly unknown[] | undefined>,
  cleanups: [] as Array<(() => void) | void>,
  at: 0,
  ref: { current: null as unknown },
  ids: [] as string[],
  width: 240,
  scrollLeft: 0,
  scrolls: [] as number[],
  observers: [] as Array<{ callback: () => void; observed: number; live: boolean }>,
  /** A pointer is held down inside the strip (it matches `:active`). */
  pressed: false,
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
// The overflow mark is its own hook with its own tests (`lib/horizontal-overflow.vitest.test.ts`); here it would add a
// layout effect and an observer to a harness that counts the reveal's.
const overflowMarks = vi.hoisted(() => ({ calls: 0 }))
vi.mock('./useHorizontalOverflow', () => ({ useHorizontalOverflow: () => { overflowMarks.calls += 1 } }))
// The edge marker (fade + arrows, polish round 2) is its own hook too, with its rules tested in `tabsScroll.vitest.test.ts`.
vi.mock('./useStripEdges', () => ({ useStripEdges: () => {} }))
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
const render = (items: TabItem[], active: string, scroll = true, onChange: (id: string) => void = () => {}) => {
  harness.ids = items.map(tab => tab.id)
  harness.at = 0
  return Tabs({ ariaLabel: 'Chosen markets', tabs: items, active, onChange, ...(scroll ? { overflow: 'scroll' as const } : {}) }) as unknown as El
}
/** A label grew: every tab is wider now, and the live observer hears it. */
const labelsGrow = (width: number) => { harness.width = width; harness.observers.filter(o => o.live).forEach(o => o.callback()) }
type El = { props: Record<string, unknown> & { children?: unknown } }
/** The element in the rendered tree that `test` picks (the strip, a tab). */
const find = (node: unknown, test: (el: El) => boolean): El | null => {
  if (Array.isArray(node)) { for (const child of node) { const hit = find(child, test); if (hit) return hit } return null }
  if (!node || typeof node !== 'object' || !('props' in node)) return null
  const el = node as El
  return test(el) ? el : find(el.props.children, test)
}
type Handler = (event: unknown) => void
const handler = (el: El | null, name: string) => el?.props[name] as Handler
const tabRect = (id: string) => {
  const at = harness.ids.indexOf(id)
  const left = at * harness.width - harness.scrollLeft
  return { left, right: left + harness.width }
}

describe('Tabs keeps the active tab in view', () => {
  beforeEach(() => {
    harness.deps = []; harness.cleanups = []; harness.scrolls = []; harness.observers = []; harness.scrollLeft = 0; harness.width = 240
    harness.pressed = false
    harness.ref.current = {
      getBoundingClientRect: () => ({ left: 0, right: 400 }),
      clientWidth: 400,
      get scrollWidth() { return harness.ids.length * harness.width },
      get scrollLeft() { return harness.scrollLeft },
      set scrollLeft(value: number) { harness.scrollLeft = value; harness.scrolls.push(value) },
      querySelector: (selector: string) => {
        const id = /data-tab-id="([^"]*)"/.exec(selector)?.[1] ?? ''
        return harness.ids.includes(id) ? { getBoundingClientRect: () => tabRect(id) } : null
      },
      querySelectorAll: () => harness.ids.map(() => ({})),
      contains: () => false,
      matches: (selector: string) => selector === ':active' && harness.pressed,
    }
  })

  it('scrolls the strip to the active tab when the active tab changes, and not when it is already in view', () => {
    render(tabs('DE', 'IT'), 'DE')
    expect(harness.scrolls).toEqual([])
    render(tabs('DE', 'IT'), 'IT')
    expect(harness.scrolls).toEqual([80])
  })

  it('scrolls again when tabs are added before the active one (listed markets chosen after the sheet\'s own, 390 px)', () => {
    render(tabs('IT'), 'IT')
    render(tabs('DE', 'ES', 'FR', 'IT'), 'IT')
    expect(harness.scrolls).toEqual([560])
    // One removed before it moves it again (here: back) — to the new end, clear of the fade on the side that has more.
    render(tabs('DE', 'IT'), 'IT')
    expect(harness.scrolls).toEqual([560, 80])
  })

  it('follows a label that grows after the tab was shown (the market\'s words arrive once it is checked)', () => {
    render(tabs('DE', 'IT'), 'IT')
    expect(harness.scrolls).toEqual([80])
    labelsGrow(360)
    // Wider than the room between the two edge fades, so it shows its start, clear of the start fade (56 px).
    expect(harness.scrolls).toEqual([80, 304])
    expect(harness.observers.filter(o => o.live)).toHaveLength(1)
    expect(harness.observers[0].observed).toBe(2)
  })

  it('does not scroll when only the labels\' words change at the same size, or nothing changes', () => {
    render(tabs('DE', 'IT'), 'IT')
    render(tabs('DE', 'IT').map(tab => ({ ...tab, label: `${tab.id} · 12 changes` })), 'IT')
    render(tabs('DE', 'IT'), 'IT')
    labelsGrow(240)
    expect(harness.scrolls).toEqual([80])
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

  it('every bar asks for the overflow mark — a host may scroll a strip that did not ask to (the subheader\'s tabs)', () => {
    overflowMarks.calls = 0
    render(tabs('IT'), 'IT', false)
    render(tabs('IT'), 'IT')
    expect(overflowMarks.calls).toBe(2)
  })

  // Google Ads tabs at 390 px (2026-10-13): a mouse press on a tab under the edge fade did nothing. The browser focuses
  // the pressed tab between pointerdown and pointerup; the focus scrolled the strip, the release landed on the next tab
  // and the click went there. The strip is 400 px, its tabs 240: IT (240–480) sits under the end fade (344–400).
  describe('a press activates the tab it started on', () => {
    /** The tab element the browser hands the focus and click events: `keyboard` = it matches `:focus-visible`. */
    const tabEl = (id: string, keyboard: boolean) => {
      const el = { dataset: { tabId: id }, closest: () => el, matches: (q: string) => q === ':focus-visible' && keyboard, getBoundingClientRect: () => tabRect(id) }
      return el
    }
    /** The tab under a point of the strip after any scroll since the press. */
    const tabAt = (x: number) => harness.ids[Math.floor((x + harness.scrollLeft) / harness.width)]
    const strip = (tree: El) => find(tree, el => el.props.role === 'tablist')
    const tab = (tree: El, id: string) => find(tree, el => el.props['data-tab-id'] === id)

    it('a mouse or touch press does not scroll the strip; the release lands on the pressed tab, which comes into view after its click', () => {
      const chosen: string[] = []
      const tree = render(tabs('DE', 'IT', 'FR'), 'DE', true, id => chosen.push(id))
      const pressAt = 370
      expect(tabAt(pressAt)).toBe('IT')
      // pointerdown → the browser focuses IT (no :focus-visible) → pointerup → click on the tab under the pointer now.
      harness.pressed = true
      handler(strip(tree), 'onFocus')({ target: tabEl('IT', false) })
      expect(harness.scrolls).toEqual([])
      harness.pressed = false
      const released = tabAt(pressAt)
      expect(released).toBe('IT')
      handler(tab(tree, released), 'onClick')({})
      handler(strip(tree), 'onClick')({ target: tabEl(released, false) })
      expect(chosen).toEqual(['IT'])
      // After the click: IT wholly in view, clear of the fade — and the host's re-render does not move it again.
      expect(harness.scrolls).toEqual([136])
      render(tabs('DE', 'IT', 'FR'), 'IT')
      expect(harness.scrolls).toEqual([136])
    })

    it('a keyboard focus (Tab, the arrows) still brings the tab wholly into view at once', () => {
      const tree = render(tabs('DE', 'IT', 'FR'), 'DE')
      handler(strip(tree), 'onFocus')({ target: tabEl('IT', true) })
      expect(harness.scrolls).toEqual([136])
    })

    it('the focus leaving the strip brings the active tab back — but not under a press inside the strip (Safari, Firefox on a Mac)', () => {
      const tree = render(tabs('DE', 'IT', 'FR'), 'DE')
      harness.scrollLeft = 320 // scrolled to the end with the arrow: DE is out of view
      harness.pressed = true
      handler(strip(tree), 'onBlur')({ relatedTarget: null })
      expect(harness.scrolls).toEqual([])
      harness.pressed = false
      handler(strip(tree), 'onBlur')({ relatedTarget: null })
      expect(harness.scrolls).toEqual([0])
    })
  })
})

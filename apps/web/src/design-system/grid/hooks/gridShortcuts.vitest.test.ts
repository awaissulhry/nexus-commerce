import { describe, expect, it, vi } from 'vitest'

import {
  ACTIVATES_ON_ENTER_SELECTOR, CELL_EDITOR_SELECTOR, OVERLAY_SELECTOR, TEXT_ENTRY_SELECTOR,
  gridShortcutHints, matchGridShortcut, shortcutKey, shortcutKeyLabel,
  type GridShortcut, type ShortcutElement, type ShortcutKeyEvent,
} from './gridShortcuts'

/**
 * A fake element: it answers `closest` for the selectors this filter asks, from a list of the "kinds" of ancestors
 * it has. Enough to test every refusal in node, without a DOM.
 */
type Kind = 'text' | 'editor' | 'overlay' | 'button'
const SELECTOR: Record<Kind, string> = { text: TEXT_ENTRY_SELECTOR, editor: CELL_EDITOR_SELECTOR, overlay: OVERLAY_SELECTOR, button: ACTIVATES_ON_ENTER_SELECTOR }
function el(kinds: Kind[] = [], extra: { overlayEl?: ShortcutElement; editable?: boolean } = {}): ShortcutElement {
  const self: ShortcutElement = {
    isContentEditable: extra.editable ?? false,
    closest: (selector) => {
      const kind = (Object.keys(SELECTOR) as Kind[]).find((k) => SELECTOR[k] === selector)
      if (!kind || !kinds.includes(kind)) return null
      return kind === 'overlay' ? extra.overlayEl ?? self : self
    },
  }
  return self
}
const inside = new Set<unknown>()
const container = { contains: (n: unknown) => inside.has(n) }
const inGrid = (e: ShortcutElement) => { inside.add(e); return e }

const key = (k: string, target: unknown, over: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
  key: k, ctrlKey: false, metaKey: false, altKey: false, repeat: false, isComposing: false, defaultPrevented: false, target, ...over,
})
const approve: GridShortcut = { key: 'a', label: 'Approve', run: vi.fn() }
const reject: GridShortcut = { key: 'R', label: 'Reject', run: vi.fn() }
const open: GridShortcut = { key: 'Enter', label: 'Open', run: vi.fn() }
const close: GridShortcut = { key: 'Escape', label: 'Close', run: vi.fn() }
const down: GridShortcut = { key: 'j', label: 'Next', run: vi.fn(), repeat: true }
const ALL = [approve, reject, open, close, down]

describe('matchGridShortcut (G8)', () => {
  const cell = inGrid(el())

  it('matches a single key on a focused cell, letters in either case', () => {
    expect(matchGridShortcut(key('a', cell), container, ALL)).toBe(approve)
    expect(matchGridShortcut(key('A', cell), container, ALL)).toBe(approve)
    expect(matchGridShortcut(key('r', cell), container, ALL)).toBe(reject)
    expect(matchGridShortcut(key('Enter', cell), container, ALL)).toBe(open)
    expect(matchGridShortcut(key('Esc', cell), container, ALL)).toBe(close)
    expect(matchGridShortcut(key('q', cell), container, ALL)).toBeNull()
  })

  it('never takes Ctrl, ⌘ or Alt, an IME composition, or a key someone already handled', () => {
    expect(matchGridShortcut(key('a', cell, { ctrlKey: true }), container, ALL)).toBeNull()
    expect(matchGridShortcut(key('a', cell, { metaKey: true }), container, ALL)).toBeNull()
    expect(matchGridShortcut(key('a', cell, { altKey: true }), container, ALL)).toBeNull()
    expect(matchGridShortcut(key('a', cell, { isComposing: true }), container, ALL)).toBeNull()
    expect(matchGridShortcut(key('a', cell, { defaultPrevented: true }), container, ALL)).toBeNull()
  })

  it('only inside the grid, and never while a modal the grid is not in is open', () => {
    expect(matchGridShortcut(key('a', el()), container, ALL)).toBeNull()
    expect(matchGridShortcut(key('a', cell), null, ALL)).toBeNull()
    expect(matchGridShortcut(key('a', cell), container, ALL, { modalOpen: true })).toBeNull()
    expect(matchGridShortcut(key('a', { not: 'an element' }), container, ALL)).toBeNull()
  })

  it('never while typing: a text field, a contenteditable, an open cell editor', () => {
    expect(matchGridShortcut(key('a', inGrid(el(['text']))), container, ALL)).toBeNull()
    expect(matchGridShortcut(key('a', inGrid(el([], { editable: true }))), container, ALL)).toBeNull()
    expect(matchGridShortcut(key('a', inGrid(el(['editor']))), container, ALL)).toBeNull()
  })

  it('never in a menu open inside the grid — but a dialog AROUND the grid is its host, not an obstacle', () => {
    expect(matchGridShortcut(key('a', inGrid(el(['overlay']))), container, ALL)).toBeNull()
    const hostDialog = el() // the dialog that holds the grid: an ancestor, not inside the container
    expect(matchGridShortcut(key('a', inGrid(el(['overlay'], { overlayEl: hostDialog }))), container, ALL)).toBe(approve)
  })

  it('Enter and Space belong to a focused button or link; letters still work there', () => {
    const verb = inGrid(el(['button']))
    expect(matchGridShortcut(key('Enter', verb), container, ALL)).toBeNull()
    expect(matchGridShortcut(key(' ', verb), container, [{ key: 'Space', label: 'Tick', run: () => {} }])).toBeNull()
    expect(matchGridShortcut(key('a', verb), container, ALL)).toBe(approve)
  })

  it('a held key repeats only where the shortcut asked for it — holding A never approves row after row', () => {
    expect(matchGridShortcut(key('a', cell, { repeat: true }), container, ALL)).toBeNull()
    expect(matchGridShortcut(key('j', cell, { repeat: true }), container, ALL)).toBe(down)
  })

  it('a disabled shortcut is listed but never bound', () => {
    const held: GridShortcut = { key: 'a', label: 'Approve', run: () => {}, disabled: 'Tick one row first' }
    expect(matchGridShortcut(key('a', cell), container, [held])).toBeNull()
  })
})

describe('hints', () => {
  it('prints keys as a Kbd shows them, keeps order, and carries a held reason', () => {
    expect(shortcutKey(' ')).toBe('Space')
    expect(shortcutKeyLabel('Escape')).toBe('Esc')
    expect(gridShortcutHints([approve, { key: 'x', label: 'Select', run: () => {}, disabled: 'Not here' }, open])).toEqual([
      { key: 'a', keyLabel: 'A', label: 'Approve', disabled: false },
      { key: 'x', keyLabel: 'X', label: 'Select', disabled: true, reason: 'Not here' },
      { key: 'Enter', keyLabel: 'Enter', label: 'Open', disabled: false },
    ])
  })
})

import { describe, expect, it } from 'vitest'

import { ACTIVATES_ON_ENTER_SELECTOR, OVERLAY_SELECTOR, TEXT_ENTRY_SELECTOR, type ShortcutElement, type ShortcutKeyEvent } from '../hooks/gridShortcuts'
import { rowNavAction } from './rowNavKeys'

/** A fake element that answers `closest` for the kinds of ancestors it has — enough to test every refusal in node. */
type Kind = 'text' | 'overlay' | 'button'
const SELECTOR: Record<Kind, string> = { text: TEXT_ENTRY_SELECTOR, overlay: OVERLAY_SELECTOR, button: ACTIVATES_ON_ENTER_SELECTOR }
const el = (...kinds: Kind[]): ShortcutElement => {
  const self: ShortcutElement = {
    closest: (selector) => {
      const kind = (Object.keys(SELECTOR) as Kind[]).find((k) => SELECTOR[k] === selector)
      return kind && kinds.includes(kind) ? self : null
    },
  }
  return self
}

const body = el()
const root = el()
const main = el()
const holders = new Set<unknown>([body, root, main])
const page = (node: unknown) => holders.has(node)
const inGrid = new Set<unknown>()
const grid = { contains: (node: unknown) => inGrid.has(node) }
const gridCell = el(); inGrid.add(gridCell)
const gridButton = el('button'); inGrid.add(gridButton)
const pageButton = el('button')
const searchBox = el('text')

const key = (k: string, target: unknown, over: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
  key: k, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, target, ...over,
})

describe('the ads grid row keys (keyboardNav)', () => {
  it('moves with J / K from the page or the grid, and with the arrows inside the grid', () => {
    expect(rowNavAction(key('j', body), grid, page)).toEqual({ kind: 'move', step: 1 })
    expect(rowNavAction(key('k', gridCell), grid, page)).toEqual({ kind: 'move', step: -1 })
    expect(rowNavAction(key('ArrowDown', gridCell), grid, page)).toEqual({ kind: 'move', step: 1 })
    expect(rowNavAction(key('ArrowUp', gridCell), grid, page)).toEqual({ kind: 'move', step: -1 })
  })

  it('works after a click on a plain cell put the focus on the shell’s <main>, which holds the grid', () => {
    expect(rowNavAction(key('j', main), grid, page)).toEqual({ kind: 'move', step: 1 })
    expect(rowNavAction(key('a', main), grid, page)).toEqual({ kind: 'verb', key: 'a' })
  })

  it('leaves the arrows to the page when focus is not in the grid: they scroll it', () => {
    expect(rowNavAction(key('ArrowDown', body), grid, page)).toBeNull()
    expect(rowNavAction(key('ArrowUp', root), grid, page)).toBeNull()
    expect(rowNavAction(key('ArrowDown', main), grid, page)).toBeNull()
  })

  it('opens the row with O or Enter, and hands other letters to the page’s verbs', () => {
    expect(rowNavAction(key('o', body), grid, page)).toEqual({ kind: 'open' })
    expect(rowNavAction(key('Enter', gridCell), grid, page)).toEqual({ kind: 'open' })
    expect(rowNavAction(key('a', body), grid, page)).toEqual({ kind: 'verb', key: 'a' })
    expect(rowNavAction(key('R', gridCell), grid, page)).toEqual({ kind: 'verb', key: 'r' })
  })

  it('never takes a browser shortcut: ⌘R, ⌘A, ⌘P, Ctrl and Alt combinations', () => {
    expect(rowNavAction(key('r', body, { metaKey: true }), grid, page)).toBeNull()
    expect(rowNavAction(key('a', gridCell, { metaKey: true }), grid, page)).toBeNull()
    expect(rowNavAction(key('p', body, { ctrlKey: true }), grid, page)).toBeNull()
    expect(rowNavAction(key('j', body, { altKey: true }), grid, page)).toBeNull()
  })

  it('leaves Enter and Space to a button or a link, in the grid or on the page', () => {
    expect(rowNavAction(key('Enter', pageButton), grid, page)).toBeNull()
    expect(rowNavAction(key('Enter', gridButton), grid, page)).toBeNull()
    expect(rowNavAction(key(' ', gridButton), grid, page)).toBeNull()
  })

  it('takes nothing while focus is on another control of the page, or someone is typing', () => {
    expect(rowNavAction(key('a', pageButton), grid, page)).toBeNull()
    expect(rowNavAction(key('j', searchBox), grid, page)).toBeNull()
  })

  it('takes nothing while a modal the grid is not in is open, or a menu inside the grid is', () => {
    expect(rowNavAction(key('j', body), grid, page, { modalOpen: true })).toBeNull()
    const menuItem = el('overlay'); inGrid.add(menuItem)
    expect(rowNavAction(key('a', menuItem), grid, page)).toBeNull()
  })

  it('takes nothing an earlier handler already took, or an IME is composing', () => {
    expect(rowNavAction(key('j', body, { defaultPrevented: true }), grid, page)).toBeNull()
    expect(rowNavAction(key('a', body, { isComposing: true }), grid, page)).toBeNull()
  })

  it('repeats a move while the key is held, never a verb', () => {
    expect(rowNavAction(key('j', body, { repeat: true }), grid, page)).toEqual({ kind: 'move', step: 1 })
    expect(rowNavAction(key('ArrowDown', gridCell, { repeat: true }), grid, page)).toEqual({ kind: 'move', step: 1 })
    expect(rowNavAction(key('a', body, { repeat: true }), grid, page)).toBeNull()
    expect(rowNavAction(key('Enter', body, { repeat: true }), grid, page)).toBeNull()
  })
})

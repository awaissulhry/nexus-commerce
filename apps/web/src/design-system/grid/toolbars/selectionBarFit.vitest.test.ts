/**
 * Keyword Harvest audit S1 (2026-10-11): the selection bar's labels hid below a FIXED 1320 px card — a 1312 px card
 * showed icons only with 600 px of the bar empty. Now the fullest form that fits wins: all, then without the reach
 * note, then icons. The DOM part (`fitSelectionBar`) is checked with a stand-in element.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SELECTION_BAR_FITS, fitSelectionBar, selectionBarFit } from './GridSelectionActions'

describe('selectionBarFit', () => {
  it('keeps the labels whenever they fit (the 1312 px card with room to spare)', () => {
    expect(selectionBarFit(() => false)).toBe('')
  })
  it('hides the note first, then the labels, and only when the fuller form overflows', () => {
    expect(selectionBarFit((fit) => fit === '')).toBe('no-note')
    expect(selectionBarFit((fit) => fit !== 'no-note icons')).toBe('no-note icons')
    expect(selectionBarFit(() => true)).toBe('no-note icons')
  })
  it('measures on one line, leaves the chosen form on the element and nothing else', () => {
    const attrs = new Map<string, string>()
    const widths: Record<string, number> = { '': 900, 'no-note': 760, 'no-note icons': 420 }
    const el = {
      parentElement: { scrollWidth: 800, clientWidth: 800 },
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
      get scrollWidth() { return widths[attrs.get('data-fit') ?? ''] },
      clientWidth: 780,
    }
    fitSelectionBar(el as unknown as HTMLElement)
    expect(attrs.get('data-fit')).toBe('no-note')
    expect(attrs.has('data-measure')).toBe(false)
  })
  it('the stylesheet hides by the measured form, never by a fixed card width (web and Factory)', () => {
    for (const path of ['../theme/grid.css', '../../../../../factory/src/design-system/grid/theme/grid.css']) {
      const css = readFileSync(new URL(path, import.meta.url), 'utf8')
      expect(css).not.toMatch(/@container \(max-width: 1320px\) \{ \.nds-grid-selbar-lbl/)
      expect(css).toMatch(/\.nds-grid-selbar\[data-fit~="icons"\] \.nds-grid-selbar-lbl \{ display: none; \}/)
      expect(css).toMatch(/\.nds-grid-selbar\[data-fit~="no-note"\] \.nds-grid-selbar-note \{ display: none; \}/)
    }
    expect(SELECTION_BAR_FITS[0]).toBe('')
  })
})

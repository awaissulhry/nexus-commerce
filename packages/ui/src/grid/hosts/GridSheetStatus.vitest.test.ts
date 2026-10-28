/**
 * Add rows R1 (2026-10-05) — the status strip's START slot and the unsaved-row state, as the strip draws them and as
 * `grid.css` styles them (the phone rule and the dashed bar are CSS facts, read from the stylesheet the strip ships with).
 */
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GRID_SHEET_STATUS_WIDE, GridSheetStatus, UNSAVED_ROW_CLASS } from './GridSheet'

const css = readFileSync(new URL('../theme/grid.css', import.meta.url), 'utf8')
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`)
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at) + 1)
}

describe('the status strip start slot', () => {
  it('draws the start slot bottom left, before the row count', () => {
    const start = createElement('button', { type: 'button' }, 'Add rows')
    const markup = renderToStaticMarkup(createElement(GridSheetStatus, { rows: 3, start, children: 'note' }))
    expect(markup).toContain('<div class="nds-grid-sheet-status-start"><button type="button">Add rows</button></div>')
    expect(markup.indexOf('nds-grid-sheet-status-start')).toBeLessThan(markup.indexOf('<b>3</b> rows'))
    expect(markup.indexOf('<b>3</b> rows')).toBeLessThan(markup.indexOf('note'))
  })

  it('F12 (browser check 2026-10-05): the start slot sits OUTSIDE the live region; the tallies and the note stay live', () => {
    const start = createElement('button', { type: 'button' }, 'Add rows')
    const markup = renderToStaticMarkup(createElement(GridSheetStatus, { rows: 3, pending: 1, start, children: 'note' }))
    // One live region, and it is not the strip: the strip holds the start slot and the live region side by side.
    expect(markup.match(/role="status"/g)).toHaveLength(1)
    expect(markup.match(/aria-live="polite"/g)).toHaveLength(1)
    expect(markup.startsWith('<div class="nds-grid-footstrip nds-grid-sheet-status"><div class="nds-grid-sheet-status-start"><button type="button">Add rows</button></div>'
      + '<div class="nds-grid-sheet-status-live" role="status" aria-live="polite"><span><b>3</b> rows')).toBe(true)
    const live = markup.slice(markup.indexOf('role="status"'))
    expect(live).not.toContain('Add rows')
    expect(live).toContain('1 unsaved cell')
    expect(live).toContain('note')
    // Laid out as the strip lays out its parts: a flex row with the strip's gap, taking the rest of the width.
    expect(rule('.nds-grid-sheet-status-live')).toContain('display: flex')
    expect(rule('.nds-grid-sheet-status-live')).toContain('gap: inherit')
    expect(rule('.nds-grid-sheet-status-live')).toContain('min-width: 0')
  })

  it('draws nothing extra without a start slot (every existing sheet is unchanged)', () => {
    for (const start of [undefined, null, false]) {
      const markup = renderToStaticMarkup(createElement(GridSheetStatus, { rows: 2, start }))
      expect(markup).not.toContain('nds-grid-sheet-status-start')
      expect(markup.startsWith('<div class="nds-grid-footstrip nds-grid-sheet-status" role="status" aria-live="polite"><span><b>2</b> rows')).toBe(true)
    }
  })

  it('keeps the start slot beside the live save counts', () => {
    const markup = renderToStaticMarkup(createElement(GridSheetStatus, {
      rows: 5, start: 'Add rows',
      source: { subscribe: () => () => undefined, getSnapshot: () => ({ pending: 2, saving: true }) },
    }))
    expect(markup).toContain('<div class="nds-grid-sheet-status-start">Add rows</div>')
    expect(markup).toContain('Saving 2 cells')
  })

  it('never shrinks, and lets only the wide part leave at phone width', () => {
    expect(rule('.nds-grid-sheet-status-start')).toContain('flex: none')
    const phone = css.slice(css.indexOf('@media (max-width: 760px) {\n  .nds-grid-sheet-status-start'))
    expect(phone.slice(0, phone.indexOf('}\n}') + 3)).toContain(`.nds-grid-sheet-status-start .${GRID_SHEET_STATUS_WIDE} { display: none; }`)
  })
})

describe('the unsaved row state', () => {
  it('is a dashed warning bar at the row start, never a row tint', () => {
    expect(UNSAVED_ROW_CLASS).toBe('nds-row-unsaved')
    const bar = rule(`.nds-ag-wrap .ag-row.${UNSAVED_ROW_CLASS}:not(.ag-full-width-row)::before`)
    expect(bar).toContain('width: 3px')
    expect(bar).toContain('repeating-linear-gradient(to bottom, var(--nds-warning-strong) 0 4px, transparent 4px 7px)')
    // No background on the row or its cells: the bar and the identity cell's words say it.
    expect(css).not.toMatch(new RegExp(`\\.${UNSAVED_ROW_CLASS}[^{]*\\{[^}]*background-color`))
    expect(rule(`.nds-ag-wrap .ag-row.${UNSAVED_ROW_CLASS} .ag-cell`)).toContain('color: var(--nds-grid-muted-fg)')
    expect(rule(`.nds-ag-wrap .ag-row.${UNSAVED_ROW_CLASS} .ag-cell.nds-cell-full-strength`)).toContain('color: var(--nds-grid-cell-fg)')
  })
})

// @vitest-environment node
/**
 * SHEET-VIEWS (2026-09-26) — the grid's empty-cell mode, rendered. `createElement`, not JSX: this
 * config collects only `.vitest.test.ts` and runs in node (see `CompletenessPill.vitest.test.ts`).
 *
 * What it locks:
 *   - `dash` stays the default, so every grid that does not ask keeps its dash;
 *   - `blank` draws NO glyph but keeps the words for a screen reader;
 *   - a MEASURED zero is a fact, not an absence — it keeps its dash and its reason in both modes;
 *   - the variation-theme child keeps its reason ("Set on the parent") in both modes.
 */
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ICellRendererParams } from 'ag-grid-community'
import { describe, expect, it } from 'vitest'

import { EmptyValue } from './cells'
import { BLANK_CELL_LABEL, GridEmptyCellsContext, type GridEmptyCells } from './emptyCells'
import { VARIATION_THEME_CHILD_REASON, VariationThemeValue } from './variationTheme'

const inGrid = (mode: GridEmptyCells | null, child: ReactElement) =>
  renderToStaticMarkup(mode ? createElement(GridEmptyCellsContext.Provider, { value: mode }, child) : child)

describe('EmptyValue under the grid empty-cell mode', () => {
  it('draws the dash when no grid says otherwise — the default every other grid relies on', () => {
    const html = inGrid(null, createElement(EmptyValue))
    expect(html).toContain('—')
    expect(html).toContain('aria-label="Not measured"')
    expect(html).not.toContain('nds-cell-blank')
  })

  it('draws the dash under an explicit `dash` grid too', () => {
    expect(inGrid('dash', createElement(EmptyValue))).toContain('—')
  })

  it('draws NOTHING visible in a `blank` grid, and still names the fact for a screen reader', () => {
    const html = inGrid('blank', createElement(EmptyValue))
    expect(html).not.toContain('—')
    expect(html).toContain('nds-cell-empty nds-cell-blank')
    expect(html).toContain(`<span class="nds-vh">${BLANK_CELL_LABEL}</span>`)
  })

  it('🔴 keeps a MEASURED zero as a dash with its reason, even in a `blank` grid', () => {
    const html = inGrid('blank', createElement(EmptyValue, { measuredZero: true, title: 'No sales in 7 days' }))
    expect(html).toContain('—')
    expect(html).toContain('title="No sales in 7 days"')
    expect(html).not.toContain('nds-cell-blank')
  })
})

describe('the variation-theme child cell under the grid empty-cell mode', () => {
  const child = () => createElement(VariationThemeValue, { value: null, childReason: VARIATION_THEME_CHILD_REASON } as unknown as ICellRendererParams)

  it('keeps the dash and the reason by default', () => {
    const html = inGrid(null, child())
    expect(html).toContain('—')
    expect(html).toContain(VARIATION_THEME_CHILD_REASON)
  })

  it('draws no glyph in a `blank` grid, and keeps the reason as its tooltip and its words', () => {
    const html = inGrid('blank', child())
    expect(html).not.toContain('—')
    expect(html).toContain(`title="${VARIATION_THEME_CHILD_REASON}"`)
    expect(html).toContain(`<span class="nds-vh">${VARIATION_THEME_CHILD_REASON}</span>`)
  })
})

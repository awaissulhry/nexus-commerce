import { describe, expect, it } from 'vitest'

import { HEADER_COLUMN_PARTITION, WORKSPACE_GRID_GEOMETRY, workspaceGridTheme } from './theme'

/**
 * The header chrome is the ENGINE's, not a page's. These lock the params that, when they lived
 * in per-grid options, produced a grid with no header partitions (the inventory editor, 2026-08-28).
 */
describe('header partitions are a theme guarantee', () => {
  it('draws the partition as a header column border, not as the resize handle', () => {
    expect(HEADER_COLUMN_PARTITION.headerColumnBorder).toEqual({ style: 'solid', width: 2, color: 'var(--nds-grey-150)' })
    expect(HEADER_COLUMN_PARTITION.headerColumnBorderHeight).toBe('30%')
    expect(HEADER_COLUMN_PARTITION.headerColumnResizeHandleWidth).toBe(0)
  })
  it('the built theme EMITS them (a `withParams` that drops the spread would fail here)', () => {
    // The Theming API does not keep params as data; it keeps the CSS it will inject. Read that.
    const css = (workspaceGridTheme as unknown as { _getParamsCss: () => string })._getParamsCss()
    expect(css).toMatch(/header-column-border:[^;]*solid 2px var\(--nds-grey-150\)/)
    expect(css).toMatch(/header-column-border-height:[^;]*30%/)
    expect(css).toMatch(/header-column-resize-handle-width:[^;]*0px/)
  })
  it('row and header heights stay the measured integers the lab verified', () => {
    expect(WORKSPACE_GRID_GEOMETRY).toEqual({ ROW_HEIGHT: 46, HEADER_HEIGHT: 44.5 })
  })
})

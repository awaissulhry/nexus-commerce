import { describe, expect, it } from 'vitest'

import { GRID_TOKEN_NAMES, gridGeometry } from '../../tokens/grid'
import { HEADER_COLUMN_PARTITION, workspaceGridTheme } from './theme'

const emitted = () => (workspaceGridTheme as unknown as { _getParamsCss: () => string })._getParamsCss()

describe('header partitions are a theme guarantee', () => {
  it('draws the partition as a header column border, not as the resize handle', () => {
    expect(HEADER_COLUMN_PARTITION.headerColumnBorder).toEqual({
      style: 'solid',
      width: 'var(--nds-grid-partition-w)',
      color: 'var(--nds-grid-partition)',
    })
    expect(HEADER_COLUMN_PARTITION.headerColumnBorderHeight).toContain('var(--nds-grid-header-h')
    expect(HEADER_COLUMN_PARTITION.headerColumnBorderHeight).toContain('var(--nds-grid-partition-ratio')
    expect(HEADER_COLUMN_PARTITION.headerColumnResizeHandleWidth).toBe(0)
  })
  it('the built theme EMITS them (a `withParams` that drops the spread would fail here)', () => {
    const css = emitted()
    expect(css).toMatch(/header-column-border:[^;]*solid var\(--nds-grid-partition-w\) var\(--nds-grid-partition\)/)
    expect(css).toMatch(/header-column-border-height:[^;]*calc\(var\(--nds-grid-header-h/)
    expect(css).toMatch(/header-column-resize-handle-width:[^;]*0px/)
  })
  it('carries no row or header height — those are density tiers NexusGrid passes as numbers', () => {
    const css = emitted()
    // Quartz emits its own defaults for these; what must be gone is the retired ads grid's 46 / 44.5.
    expect(css).not.toMatch(/--ag-row-height:\s*46px/)
    expect(css).not.toMatch(/--ag-header-height:\s*44\.5px/)
  })
})

describe('GDS — every colour the theme emits is a grid token, never a ramp step', () => {
  /** AG param → the grid token it must be bound to. The list IS the spec's "theme" column. */
  const BINDINGS: Array<[string, string]> = [
    ['background-color', '--nds-grid-bg'],
    ['header-background-color', '--nds-grid-header-bg'],
    ['chrome-background-color', '--nds-grid-chrome-bg'],
    ['header-text-color', '--nds-grid-header-fg'],
    ['foreground-color', '--nds-grid-cell-fg'],
    ['row-hover-color', '--nds-grid-hover-bg'],
    ['selected-row-background-color', '--nds-grid-selected-bg'],
    ['border-color', '--nds-grid-row-rule'],
    ['header-row-border', '--nds-grid-header-rule'],
    ['wrapper-border', '--nds-grid-frame'],
    ['wrapper-border-radius', '--nds-grid-frame-radius'],
    ['cell-horizontal-padding', '--nds-grid-cell-pad-x'],
    ['accent-color', '--nds-grid-accent'],
    ['border-radius', '--nds-grid-radius'],
    ['checkbox-border-radius', '--nds-grid-checkbox-radius'],
    ['pinned-row-background-color', '--nds-grid-totals-bg'],
    ['font-size', '--nds-grid-cell-size'],
    ['header-font-size', '--nds-grid-header-size'],
    ['header-font-weight', '--nds-grid-header-weight'],
    ['cell-font-weight', '--nds-grid-cell-weight'],
    ['range-selection-border-color', '--nds-grid-accent'],
  ]

  it.each(BINDINGS)('--ag-%s is bound to %s', (param, token) => {
    const css = emitted()
    const re = new RegExp(`--ag-${param}:[^;]*var\\(${token}\\)`)
    expect(css).toMatch(re)
  })

  it('binds no primitive ramp step and no hex', () => {
    const css = emitted()
    expect(css).not.toMatch(/var\(--nds-(grey|blue|green|red|amber|purple|cyan)-\d+\)/)
    expect(css).not.toMatch(/var\(--nds-white\)/)
    // A hex the theme itself wrote (Quartz's own defaults for params we do not set are allowed).
    for (const [param] of BINDINGS) expect(css).not.toMatch(new RegExp(`--ag-${param}:\\s*#`))
  })

  it('every grid token the theme references exists in tokens/grid.ts', () => {
    const css = emitted()
    const referenced = [...new Set([...css.matchAll(/var\((--nds-grid-[a-z0-9-]+)/g)].map((m) => m[1]))]
    // `--nds-grid-header-h` is stamped by NexusGrid per instance, not emitted from the token table.
    const missing = referenced.filter((n) => n !== '--nds-grid-header-h' && !GRID_TOKEN_NAMES.includes(n))
    expect(missing).toEqual([])
    expect(referenced.length).toBeGreaterThan(15)
  })

  it('the partition ratio in the theme is the geometry table’s', () => {
    expect(HEADER_COLUMN_PARTITION.headerColumnBorderHeight).toContain(String(gridGeometry.partitionRatio))
  })
})

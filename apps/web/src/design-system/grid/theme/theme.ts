/**
 * The AG Grid theme, driven from the GDS grid tokens (`tokens/grid.ts` → `--nds-grid-*`).
 *
 * WHY THE THEMING API AND NOT `ag-theme-quartz.css`
 * AG Grid still ships legacy stylesheets (`ag-grid-community/styles/ag-theme-quartz.css`). Loading
 * one would add a FIFTH global stylesheet to an app whose cascade is already decided by source
 * order, next to four DS stylesheets and ~3,000 lines of ads.css. This codebase has been bitten by
 * exactly that: a page stylesheet beating a DS primitive, and a token triplet colliding on load
 * order. The Theming API emits scoped custom properties instead, so the grid never enters that
 * fight.
 *
 * WHY EVERY PARAM IS A `var(--nds-grid-*)` AND NOT A HEX — AND NOT A RAMP STEP EITHER
 * Until GDS Phase 1 (2026-08-28) this file bound `--nds-white`, `--nds-grey-25`, `--nds-grey-150`
 * and `--nds-grey-200` directly and said they were dark-aware. They are not: `.dark` redefines the
 * SEMANTIC tier and never a ramp step, so a dark grid was dark text tokens on a white ground. The
 * grid tokens derive from semantic roles only; the theme binds the grid tokens; dark mode costs
 * nothing and cannot drift. `theme.vitest.test.ts` reads the EMITTED css and fails on any ramp.
 *
 * `browserColorScheme` is the one thing a token cannot carry — it drives native scrollbars and
 * form controls inside cells — so it is set per mode below and the wrapper stamps
 * `data-ag-theme-mode`.
 *
 * GEOMETRY IS NOT HERE
 * Row and header heights are per density tier (`tokens/grid.ts`) and `NexusGrid` passes them to AG
 * as numbers — AG virtualises off them, so they cannot be CSS. The theme carries no row height at
 * all: a grid that mounts without the wrapper gets AG's default, which is a visible bug, not a
 * silent 46px from a retired grid.
 */
import { themeQuartz } from 'ag-grid-community'

import { gridDensity, gridGeometry } from '../../tokens/grid'

/**
 * IE.2 — the header's column PARTITIONS, defined ONCE, for every grid.
 *
 * Until 2026-08-28 the thin line between header cells came from the column RESIZE HANDLE
 * (Quartz draws a 2px × 30% mark on every resizable column), so a grid whose columns were not
 * resizable — the inventory editor — had no partitions at all, and looked like a different
 * product. A partition is chrome, not a side effect of a per-column option: it is a theme
 * param here, the handle's own mark is turned off (width 0 — the handle still drags).
 *
 * The HEIGHT is 30% of the HEADER ROW, computed from `--nds-grid-header-h`, which `NexusGrid`
 * stamps on its wrapper from the header height it passes AG. Quartz's own `30%` is 30% of the
 * CELL, and a cell that spans the column-group strip (the inventory editor's selection and
 * identity columns) is 76px tall — measured: 22.8px marks beside 13.8px ones in one header.
 * `theme.vitest.test.ts` locks this object so it cannot quietly go missing.
 */
export const HEADER_COLUMN_PARTITION = {
  headerColumnBorder: { style: 'solid', width: 'var(--nds-grid-partition-w)', color: 'var(--nds-grid-partition)' },
  headerColumnBorderHeight: `calc(var(--nds-grid-header-h, ${gridDensity.spacious.header}px) * var(--nds-grid-partition-ratio, ${gridGeometry.partitionRatio}))`,
  headerColumnResizeHandleWidth: 0,
} as const

export const workspaceGridTheme = themeQuartz
  .withParams({
    ...HEADER_COLUMN_PARTITION,
    // --- type ---
    fontFamily: 'var(--nds-font-sans)',
    fontSize: 'var(--nds-grid-cell-size)',
    foregroundColor: 'var(--nds-grid-cell-fg)',
    cellFontWeight: 'var(--nds-grid-cell-weight)',

    // --- surfaces ---
    backgroundColor: 'var(--nds-grid-bg)',
    // Also the ground for the tool panels and menus, which is what `chromeBackgroundColor` covers.
    chromeBackgroundColor: 'var(--nds-grid-chrome-bg)',
    headerBackgroundColor: 'var(--nds-grid-header-bg)',

    // --- header ---
    headerTextColor: 'var(--nds-grid-header-fg)',
    headerFontSize: 'var(--nds-grid-header-size)',
    headerFontWeight: 'var(--nds-grid-header-weight)',

    // --- rows ---
    /**
     * `true`, not an object. The object form — `{ style, width, color: 'var(…)' }` — emitted NO
     * `--ag-row-border-color` at all (measured: the var is empty and cells render
     * `1px solid rgba(0, 0, 0, 0)`), so the row rule was invisible while the theme looked correct
     * in source. `true` falls through to `--ag-border-color`, bound to the row-rule token below.
     * The engine stylesheet ALSO states `--ag-row-border` on the wrapper, because AG 36.1.0's base
     * CSS reads that shorthand and emits nothing for it from this param.
     */
    rowBorder: true,
    headerRowBorder: { style: 'solid', width: 1, color: 'var(--nds-grid-header-rule)' },
    // The DS grid draws NO vertical rules and NO zebra. Quartz ships both, so both are turned off
    // explicitly — leaving them on is the single most visible way this would not read as the same
    // grid.
    columnBorder: false,
    oddRowBackgroundColor: 'transparent',
    rowHoverColor: 'var(--nds-grid-hover-bg)',
    selectedRowBackgroundColor: 'var(--nds-grid-selected-bg)',

    // --- frame (a grid inside `.nds-gridcard` drops it — see the engine stylesheet) ---
    wrapperBorder: { style: 'solid', width: 1, color: 'var(--nds-grid-frame)' },
    wrapperBorderRadius: 'var(--nds-grid-frame-radius)',
    borderColor: 'var(--nds-grid-row-rule)',

    // --- spacing ---
    cellHorizontalPadding: 'var(--nds-grid-cell-pad-x)',

    // --- controls ---
    accentColor: 'var(--nds-grid-accent)',
    borderRadius: 'var(--nds-grid-radius)',
    checkboxBorderRadius: 'var(--nds-grid-checkbox-radius)',
    rangeSelectionBorderColor: 'var(--nds-grid-accent)',

    // --- pinned / totals row ---
    pinnedRowBackgroundColor: 'var(--nds-grid-totals-bg)',
    pinnedRowFontWeight: 700,

    browserColorScheme: 'light',
  })
  /**
   * Second mode. Only `browserColorScheme` is overridden — every colour above is a grid token that
   * derives from a semantic role `.dark` already flips, so restating them here would create two
   * sources of truth and a guaranteed drift.
   */
  .withParams({ browserColorScheme: 'dark' }, 'dark')


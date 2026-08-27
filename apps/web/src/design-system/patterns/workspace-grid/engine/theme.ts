/**
 * AG.1 — the AG Grid theme, driven from DS tokens.
 *
 * WHY THE THEMING API AND NOT `ag-theme-quartz.css`
 * AG Grid still ships legacy stylesheets (`ag-grid-community/styles/ag-theme-quartz.css`). Loading
 * one would add a FIFTH global stylesheet to an app whose cascade is already decided by source
 * order, next to four DS stylesheets and ~3,000 lines of ads.css. This codebase has been bitten by
 * exactly that: a page stylesheet beating a DS primitive, and a token triplet colliding on load
 * order. The Theming API emits scoped custom properties instead, so the grid never enters that
 * fight.
 *
 * WHY EVERY COLOUR IS A `var(--nds-*)` AND NOT A HEX
 * The DS tokens are ALREADY dark-aware — `tokens.css` defines each one twice, once on `:root` and
 * once under `.dark`. Binding AG Grid's params to the token means dark mode costs nothing and,
 * more importantly, cannot drift: when a token moves, the grid moves with it. Hard-coding
 * #f7f9fb here would have produced a grid that silently stayed light.
 *
 * `browserColorScheme` is the one thing a token cannot carry — it drives native scrollbars and
 * form controls inside cells — so it is set per mode below and the wrapper stamps
 * `data-ag-theme-mode`.
 *
 * GEOMETRY IS A MEASUREMENT, NOT A PREFERENCE
 * Every number below is transcribed from `design-system/styles/workspace-grid.css`, which is the
 * grid operators use today. They are cited inline. `rowHeight`/`headerHeight` are the two that
 * CANNOT be derived — AG Grid needs a fixed row height to virtualise — so they are computed from
 * that stylesheet's padding + line box and then verified against the live DOM in
 * `/design/grid-lab`. Treat a change to either as a visual regression until re-measured.
 */
import { themeQuartz } from 'ag-grid-community'

/**
 * MEASURED in /design/grid-lab on 2026-08-28, not derived. Both numbers were previously computed
 * from `workspace-grid.css` lines 24 and 32 (`padding: 10px/11px 14px`) and came out 39 and 35.
 * Both were wrong, because **lines 186 and 189 of that same stylesheet override them with
 * `padding: 12px 14px`** — later in source order, so they win. Source order beats the reading you
 * did of the first declaration.
 *
 * That is precisely what this file's own header demands ("verified against the live DOM in
 * /design/grid-lab") and it could not happen, because the lab's AG probe selector matched nothing
 * and its legacy selector matched the pinned Total row. With both fixed, the real numbers are:
 *
 *   data row  45.95px   (12 + 12 padding + a 19.5px line box + 1px rule, plus ~1.45px of content
 *                        taller than the line box — the identity cell's dot and the checkbox)
 *   header    44.50px
 *
 * The 39/35 pair was a 6.95px and 9.5px shortfall on EVERY row of 65 ads screens — the exact
 * regression the lab exists to catch, sitting undetected because the instrument was broken.
 *
 * ROW_HEIGHT is rounded to an integer: AG Grid virtualises off a fixed row height, and a
 * fractional one accumulates rounding error down a long list. The remaining 0.05px is below the
 * threshold of anything, and the lab's comparison allows sub-pixel for that reason.
 */
const ROW_HEIGHT = 46

/** Measured, same run. AG accepts a fractional header height — it is not virtualised. */
const HEADER_HEIGHT = 44.5

export const workspaceGridTheme = themeQuartz
  .withParams({
    // --- type: `.nds-wsgrid table { font-size: 13px }` ---
    fontFamily: 'var(--nds-font-sans)',
    fontSize: 13,
    // `.nds-wsgrid tbody td { color: var(--nds-grey-800); font-weight: 500 }`
    foregroundColor: 'var(--nds-grey-800)',
    cellFontWeight: 500,

    // --- surfaces ---
    // `.nds-wsgrid { background: var(--nds-white) }`
    backgroundColor: 'var(--nds-white)',
    // `.nds-wsgrid thead th { background: var(--nds-grey-25) }` — also the ground for the
    // tool panels and menus, which is what `chromeBackgroundColor` covers.
    chromeBackgroundColor: 'var(--nds-grey-25)',
    headerBackgroundColor: 'var(--nds-grey-25)',

    // --- header: `font-size: 11.5px; font-weight: 700; color: var(--nds-wsgrid-head-fg)` ---
    headerTextColor: 'var(--nds-wsgrid-head-fg)',
    headerFontSize: 11.5,
    headerFontWeight: 700,
    headerHeight: HEADER_HEIGHT,

    // --- rows ---
    rowHeight: ROW_HEIGHT,
    /**
     * `.nds-wsgrid tbody td { border-bottom: 1px solid var(--nds-grey-150) }`.
     *
     * `true`, not an object. The object form — `{ style, width, color: 'var(--nds-grey-150)' }` —
     * emitted NO `--ag-row-border-color` at all (measured: the var is empty and cells render
     * `1px solid rgba(0, 0, 0, 0)`), so the row rule was invisible while the theme looked correct
     * in source. `true` falls through to `--ag-border-color`, which is already bound to the same
     * token below and therefore stays dark-aware. A plain colour param resolves `var()` fine; the
     * border-object form silently does not.
     */
    rowBorder: true,
    // `.nds-wsgrid thead th { border-bottom: 1px solid var(--nds-grey-200) }` — a heavier rule
    // than the row rule, deliberately.
    headerRowBorder: { style: 'solid', width: 1, color: 'var(--nds-grey-200)' },
    // The current grid draws NO vertical rules and NO zebra. Quartz ships both, so both are
    // turned off explicitly — leaving them on is the single most visible way this would not
    // read as the same grid.
    columnBorder: false,
    oddRowBackgroundColor: 'transparent',
    // `.nds-wsgrid tbody tr:hover { background: var(--nds-imgup-surface) }`
    rowHoverColor: 'var(--nds-imgup-surface)',
    // `.nds-wsgrid tbody tr.on { background: var(--nds-blue-50) }`
    selectedRowBackgroundColor: 'var(--nds-blue-50)',

    // --- frame: `.nds-wsgrid { border: 1px solid var(--nds-grey-200); border-radius: 12px }` ---
    wrapperBorder: { style: 'solid', width: 1, color: 'var(--nds-grey-200)' },
    wrapperBorderRadius: 12,
    borderColor: 'var(--nds-grey-150)',

    // --- spacing: `padding: 11px 14px` ---
    cellHorizontalPadding: 14,

    // --- accents ---
    accentColor: 'var(--nds-primary)',
    borderRadius: 'var(--nds-radius-sm)',
    // Pinned/total row — `tr.h10-am-total`.
    pinnedRowBackgroundColor: 'var(--nds-grey-25)',
    pinnedRowFontWeight: 700,

    browserColorScheme: 'light',
  })
  /**
   * Second mode. Only `browserColorScheme` is overridden — every colour above is a token that
   * already flips under `.dark`, so restating them here would create two sources of truth and a
   * guaranteed drift.
   */
  .withParams({ browserColorScheme: 'dark' }, 'dark')

export const WORKSPACE_GRID_GEOMETRY = { ROW_HEIGHT, HEADER_HEIGHT } as const

/**
 * AGD — the legacy `.nds-grid` geometry per `size`, as NUMBERS the AG engine needs.
 *
 * Every figure here is derived from `styles/components.css` (`.nds-grid tbody td` and the
 * `.sm/.xs/.lg/.xl` tiers) and checked against the browser baseline captured before the swap
 * (`scratchpad/baseline/*.json`, 2026-09-05 at 1728×906):
 *
 *   tier   td padding    font      line box (×1.5)   one-line row = padY·2 + line + 1px rule
 *   md     11px 14px     13px      19.5px            42.5   (header measured 38.25 = 10+10+17.25+1 — the same rule)
 *   sm      7px 10px     12.5px    18.75px           33.75  (measured 33.75 on /reporting, /analytics, bulk history)
 *   xs      5px  9px     11.5px    17.25px           28.25
 *   lg     14px 14px     13px      19.5px            48.5
 *   xl     19px 14px     13px      19.5px            58.5
 *
 * The line box is 1.5× the font size because the page's base stylesheet sets `line-height: 1.5`
 * and the legacy `td` inherited it (measured on every DS-grid cell in the baseline: `lineHeight:
 * 19.5px` at 13px, `18.75px` at 12.5px). The adapter restates that on the cell, because the engine
 * sheet sets `line-height: normal` on every AG cell (grid.css PN.1) and `normal` is not 1.5.
 *
 * 🔴 These are FLOORS, not fixed heights. Every column is `autoHeight`, so a cell taller than one
 * line (a two-line name, a 28px button, a `<br/>`) grows its row exactly as the `<td>` grew —
 * measured legacy rows: 51px on /portfolios (28px boxed buttons), 43px on bulk history (a 28px
 * Button), 43.5 on the control-room week table (a 20.5px chip), 60px on the guardrails grid
 * (inputs). AG needs a number for the empty case and for a row whose cells are not measured yet,
 * and that number is the one-line height. No md page in the baseline holds a pure one-line text
 * row, so 42.5 is DERIVED (the sm 33.75 and the md header 38.25 confirm the rule it comes from).
 *
 * The HEADER is the engine's (Owner's exemption): `density` picks the nearest engine tier — cozy
 * (38) for md, compact (28) for sm/xs, spacious (46) for lg/xl.
 *
 * The EMPTY state is a `tbody td` in the legacy, so `.nds-grid tbody td` (0,1,2) outranks
 * `.nds-grid-empty` (0,1,0) on padding, ink and weight: the cell is one line tall at the tier's
 * padding with body ink, centred — the 40px grey intent never shipped. Its height is the row floor.
 */
import type { CSSProperties } from 'react'

import { gridDensity, type GridDensityName } from '../../tokens/grid'

export type DataGridSize = 'xl' | 'lg' | 'md' | 'sm' | 'xs'

/** The page's inherited line-height (`line-height: 1.5`), measured on every legacy cell. */
export const LINE_HEIGHT = 1.5

/** The legacy row-rule: `border-bottom: 1px solid var(--nds-border-subtle)` on every `td`. */
export const ROW_RULE = 1

/** The legacy checkbox column: `th.ck, td.ck { width: 40px }`. */
export const CHECKBOX_COL_W = 40

/**
 * The legacy totals cell: NO padding from the DS (`tr.totals td` states none and the `tbody td`
 * tiers are tbody-scoped — audit §2.6) and the app's reset zeroes the UA's `td` padding — MEASURED
 * in the parity lab (2026-09-06): `padding: 0px`, the row 20.5px = the 13px line + the 1px top rule.
 * A page pads it (`.h10-rep-tbl td { padding: 7px 10px }` on the two `showTotals` sites). The row
 * is measured from its cells, so this is only the floor AG is told before the first measurement.
 */
export const TOTALS_PAD = 0

export interface SizeGeometry {
  /** `td` vertical padding, one side. */
  padY: number
  /** `td` horizontal padding, one side. */
  padX: number
  /** cell font size in px; the CSS binds the token, this is the number the row floor needs. */
  fontPx: number
  /** the DS token the cell font binds to. */
  fontToken: string
  /** one text line at `LINE_HEIGHT`. */
  lineBox: number
  /** a one-line data row, rule included — AG's `rowHeight` floor. */
  rowHeight: number
  /** the engine header tier nearest the legacy header height. */
  density: GridDensityName
  /** the engine's header height for that tier — the bounded-grid estimate needs the number. */
  headerHeight: number
  /** the totals row before its cells are measured: the table's 13px line + the 1px top rule (no padding). */
  totalsHeight: number
}

const line = (fontPx: number) => fontPx * LINE_HEIGHT

const tier = (padY: number, padX: number, fontPx: number, fontToken: string, density: GridDensityName): SizeGeometry => ({
  padY,
  padX,
  fontPx,
  fontToken,
  lineBox: line(fontPx),
  rowHeight: padY * 2 + line(fontPx) + ROW_RULE,
  density,
  headerHeight: gridDensity[density].header,
  // The totals cells keep the TABLE's 13px (the size tiers never reached `tfoot`), whatever the tier.
  totalsHeight: TOTALS_PAD * 2 + line(13) + ROW_RULE,
})

export const SIZE_GEOMETRY: Readonly<Record<DataGridSize, SizeGeometry>> = {
  xl: tier(19, 14, 13, '--nds-font-size-base', 'spacious'),
  lg: tier(14, 14, 13, '--nds-font-size-base', 'spacious'),
  md: tier(11, 14, 13, '--nds-font-size-base', 'cozy'),
  sm: tier(7, 10, 12.5, '--nds-font-size-sm-plus', 'compact'),
  xs: tier(5, 9, 11.5, '--nds-font-size-xs-plus', 'compact'),
}

export const DATAGRID_SIZES: readonly DataGridSize[] = ['xl', 'lg', 'md', 'sm', 'xs']

export function geometryFor(size: DataGridSize | undefined): SizeGeometry {
  return SIZE_GEOMETRY[size ?? 'md']
}

/**
 * The geometry as custom properties on the wrapper — ONE source for the numbers `datagrid.css`
 * paints (`padding: var(--nds-dg-pad-y) var(--nds-dg-pad-x)`), so a tier cannot be restated
 * differently in the sheet (the token-scale-defined-twice trap). The font binds the DS token, never
 * a pixel literal.
 */
export function geometryVars(g: SizeGeometry): CSSProperties {
  return {
    ['--nds-dg-pad-y' as string]: `${g.padY}px`,
    ['--nds-dg-pad-x' as string]: `${g.padX}px`,
    ['--nds-dg-font' as string]: `var(${g.fontToken})`,
    ['--nds-dg-line' as string]: String(LINE_HEIGHT),
    ['--nds-dg-row-h' as string]: `${g.rowHeight}px`,
  }
}

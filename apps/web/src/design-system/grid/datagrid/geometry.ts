/**
 * AGD — the DataGrid's geometry on the engine's ONE density scale (grid audit E5, 2026-10-13).
 *
 * The five `size` names of the props contract land on the three engine tiers (`tokens/grid.ts`, GRID.md §4):
 *
 *   size     tier       row   header   cell pad (y · x)   line box
 *   xs, sm   compact     28     28        3.5 · 10           20
 *   md       cozy        43     38         11 · 14           20
 *   lg, xl   spacious    49     46         14 · 14           20
 *
 * It had five tiers of its own, lifted from the legacy `.nds-grid` table (`xs` 28.25, `sm` 33.75, `md` 42.5, `lg` 48.5,
 * `xl` 58.5 — a 1.5× line box of a 11.5/12.5/13px font): two names that were no engine tier, and a fraction on every
 * row that AG then summed down the list. Now the rows are the engine's whole pixels, the text is the engine's one cell
 * size (13px, `--nds-grid-cell-size`, every tier — the 11.5/12.5px of `xs`/`sm` went) on a whole-pixel 20px line box,
 * and the vertical padding is what is left: (row − line − rule) / 2.
 *
 * 🔴 These are FLOORS, not fixed heights. Every column is `autoHeight`, so a cell taller than one line (a two-line
 * name, a 28px button, a `<br/>`) grows its row exactly as the legacy `<td>` grew; AG needs a number for the empty case
 * and for a row whose cells are not measured yet, and that number is the one-line height. A row holding a 28px control
 * is 28 + 2·padY + 1: 36 / 51 / 57.
 */
import type { CSSProperties } from 'react'

import { gridDensity, type GridDensityName } from '../../tokens/grid'

export type DataGridSize = 'xl' | 'lg' | 'md' | 'sm' | 'xs'

/** One text line: the 13px cell text on a whole-pixel line box, so a one-line row is a whole number. */
export const LINE_BOX = 20

/** The legacy row-rule: `border-bottom: 1px solid var(--nds-border-subtle)` on every `td`. */
export const ROW_RULE = 1

/** The legacy checkbox column: `th.ck, td.ck { width: 40px }`. */
export const CHECKBOX_COL_W = 40

/**
 * The totals cell has no vertical padding (the legacy `tr.totals td` stated none and the app's reset zeroes the UA's);
 * a page pads it (`.h10-rep-tbl td { padding: 7px 10px }` on the two `showTotals` sites). The row is measured from its
 * cells, so this is only the floor AG is told before the first measurement.
 */
export const TOTALS_PAD = 0

export interface SizeGeometry {
  /** the engine tier the size lands on — its rows, header and horizontal padding. */
  density: GridDensityName
  /** cell vertical padding, one side: (row − line box − rule) / 2. */
  padY: number
  /** cell horizontal padding, one side: the tier's `cellPadX`. */
  padX: number
  /** a one-line data row, rule included — AG's `rowHeight` floor; the tier's `rowText`. */
  rowHeight: number
  /** the tier's header height — the bounded-grid estimate needs the number. */
  headerHeight: number
  /** the totals row before its cells are measured: the header's height, as on every grid (the Owner's card rule, IE.4). */
  totalsHeight: number
}

const tier = (density: GridDensityName): SizeGeometry => {
  const t = gridDensity[density]
  return {
    density,
    padY: (t.rowText - LINE_BOX - ROW_RULE) / 2,
    padX: t.cellPadX,
    rowHeight: t.rowText,
    headerHeight: t.header,
    totalsHeight: Math.max(t.header, TOTALS_PAD * 2 + LINE_BOX + ROW_RULE),
  }
}

const TIER_GEOMETRY: Readonly<Record<GridDensityName, SizeGeometry>> = {
  compact: tier('compact'),
  cozy: tier('cozy'),
  spacious: tier('spacious'),
}

/** The tier each `size` name lands on. `md` (the default) is cozy. */
export const SIZE_DENSITY: Readonly<Record<DataGridSize, GridDensityName>> = {
  xs: 'compact',
  sm: 'compact',
  md: 'cozy',
  lg: 'spacious',
  xl: 'spacious',
}

export function geometryFor(size: DataGridSize | undefined): SizeGeometry {
  return TIER_GEOMETRY[SIZE_DENSITY[size ?? 'md']]
}

/**
 * The geometry as custom properties on the wrapper — ONE source for the numbers `datagrid.css` paints
 * (`padding: var(--nds-dg-pad-y) var(--nds-dg-pad-x)`), so a tier cannot be restated differently in the sheet.
 */
export function geometryVars(g: SizeGeometry): CSSProperties {
  return {
    ['--nds-dg-pad-y' as string]: `${g.padY}px`,
    ['--nds-dg-pad-x' as string]: `${g.padX}px`,
    ['--nds-dg-line' as string]: `${LINE_BOX}px`,
  }
}

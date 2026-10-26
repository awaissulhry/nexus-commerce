import { gridDensity, type GridDensityName } from '../tokens/grid'

/**
 * Four row kinds, not four densities.
 *
 * `text` is a plain one-line row. `media` is the /products/next shape — a thumbnail beside a STACK
 * (photo · title · sub-line), which is what buys the 52. `media-line` is the studio's: a thumbnail
 * on a ONE-LINE row, because the sheet's identity cell has no stack (SKU and Name are separate
 * columns). 36 = 32px thumbnail + 2 above + 2 below. `two-line` (2026-10-26, the Negative Targeting
 * grids): a text row whose cells may carry a muted second line (`.nds-cell-sub`) — 40 at compact,
 * where a text row (28) fits one line only; cozy and spacious already fit two.
 *
 * 🔴 Height driven by a row's CONTENT is a property of the row; density is an operator preference
 * applied across every grid. A fourth density tier would have given the ads console a thumbnail row
 * the moment someone picked "compact" (DS.1 + PES.2, hub #184).
 */
export type GridRowKind = 'text' | 'media' | 'media-line' | 'two-line'

/** The row height a kind gets at a density tier (`tokens/grid.ts`). PURE. */
export function rowHeightFor(kind: GridRowKind, density: GridDensityName): number {
  const tier = gridDensity[density]
  return kind === 'media' ? tier.rowMedia : kind === 'media-line' ? tier.rowMediaLine : kind === 'two-line' ? tier.rowTwoLine : tier.rowText
}

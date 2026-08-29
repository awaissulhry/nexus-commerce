/**
 * GDS — grid component tokens (tier 3, `--nds-grid-*`).
 *
 * ONE table for every number and colour the AG-Grid-based design-system grid draws. `theme.ts`
 * (the AG Theming API params) and the engine stylesheet consume the CSS custom properties emitted
 * from `gridVars`; TypeScript consumers that must hand AG a NUMBER (`rowHeight`, `headerHeight`,
 * column widths) read the same values from `gridDensity` / `gridGeometry` — so the row height a
 * page passes and the row height the spec prints can never disagree.
 *
 * Every colour DERIVES FROM A SEMANTIC TOKEN (`--nds-surface-*`, `--nds-border-*`, `--nds-text-*`,
 * `--nds-primary`, the status hues). None binds a ramp step. The previous theme bound
 * `--nds-white` / `--nds-grey-25` / `--nds-grey-150` / `--nds-grey-200` directly — measured
 * 2026-08-28, none of those flip, so a dark grid was dark text on a white ground.
 *
 * 🔴 Deriving is NOT enough on its own. A custom property whose value is `var(X)` resolves in the
 * scope where it is DECLARED: `--nds-grid-bg: var(--nds-surface)` on `:root` computes to the LIGHT
 * surface there and inherits that literal into `.dark`, where redefining `--nds-surface` never
 * reaches it. So every colour alias below is ALSO emitted into the `.dark` block (`gridVarsDark`,
 * the same `var(X)` form) — `scripts/check-dark-alias-scope.mjs` fails the push otherwise, and it
 * did, on this file's first run.
 *
 * Numbers are MEASUREMENTS, not preferences — taken off /products/next and the inventory editor at
 * baseline `2b0e43fc4` (docs/2026-08-28-grid-design-system-gds.md §4). Row heights are integers
 * because AG virtualises off a fixed row height and a fraction accumulates down a list.
 *
 * Byte-identical in apps/web and apps/factory (the fork-drift guard holds new shared files equal).
 */

export interface GridCssVar {
  section?: string
  name: string
  value: string
}

/**
 * Density tiers — the ONE vocabulary (Q3, decided 2026-08-28). `rowText` is a plain one-line row;
 * `rowMedia` is a row whose identity cell carries a thumbnail (photo · title · sub-line). Header
 * height is the same in both kinds. Spacious is the default on /products/next (Owner).
 *
 *   tier      rowText  rowMedia  header  thumb  cellPadX
 *   compact     28       52        28     32      10       (engine xs; DS grid `xs` 5/9 padding)
 *   cozy        43       68        38     40      14       (engine md)
 *   spacious    49       85        46     56      14       (engine lg)
 */
export const gridDensity = {
  compact: { rowText: 28, rowMedia: 52, header: 28, thumb: 32, cellPadX: 10 },
  cozy: { rowText: 43, rowMedia: 68, header: 38, thumb: 40, cellPadX: 14 },
  spacious: { rowText: 49, rowMedia: 85, header: 46, thumb: 56, cellPadX: 14 },
} as const

export type GridDensityName = keyof typeof gridDensity
export const GRID_DENSITIES = ['compact', 'cozy', 'spacious'] as const satisfies readonly GridDensityName[]

/** Geometry that does not vary with density. */
export const gridGeometry = {
  /** The column-group row above the header — a slim STRIP, not a second header (IE.4). */
  stripH: 30,
  /** A full-width footer row under a family's variations ("Showing 10 of 40 · View all"). */
  footerRowH: 48,
  /** The checkbox column; AG's default is 50, the DS grid measured 43. */
  selectColW: 43,
  /** Identity column base width at compact (fits a 34-char SKU); grows by the thumb delta per tier. */
  identityW: 320,
  /** Header partition: a 2px mark, 30% of the HEADER ROW's height (never of a spanning cell). */
  partitionW: 2,
  partitionRatio: 0.3,
  /** AG's checkbox, kept: it is what the Owner approved on screen and what AG keeps accessible. */
  checkboxSize: 16,
} as const

/** Type — numbers the theme states in px; weights as CSS weights. */
export const gridType = {
  headerSize: 11.5,
  headerWeight: 700,
  cellSize: 13,
  cellWeight: 500,
  stripSize: 11,
  stripWeight: 700,
  stripTracking: '0.05em',
} as const

const px = (n: number) => `${n}px`

/**
 * The emitted custom properties, in spec order. Consumed by `tokens/css-vars.ts` (spread into the
 * generated `tokens.css` / `tokens-global.css`) — never hand-written into a stylesheet.
 */
export const gridVars: ReadonlyArray<GridCssVar> = [
  // ── surfaces ──
  { section: 'Tier 3: grid (tokens/grid.ts — every colour a semantic role; each alias is re-declared in .dark)', name: '--nds-grid-bg', value: 'var(--nds-surface)' },
  { name: '--nds-grid-header-bg', value: 'var(--nds-surface-raised)' },
  { name: '--nds-grid-strip-bg', value: 'var(--nds-surface-sunken)' },
  { name: '--nds-grid-totals-bg', value: 'var(--nds-surface-raised)' },
  { name: '--nds-grid-hover-bg', value: 'var(--nds-surface-raised)' },
  { name: '--nds-grid-selected-bg', value: 'var(--nds-wash-primary)' },
  { name: '--nds-grid-child-bg', value: 'var(--nds-surface-sunken)' },
  { name: '--nds-grid-child-hover-bg', value: 'var(--nds-surface-hover)' },
  { name: '--nds-grid-child-rail', value: 'var(--nds-border)' },
  { name: '--nds-grid-chrome-bg', value: 'var(--nds-surface-raised)' },
  // ── rules ──
  { name: '--nds-grid-row-rule', value: 'var(--nds-border-subtle)' },
  { name: '--nds-grid-header-rule', value: 'var(--nds-border)' },
  { name: '--nds-grid-partition', value: 'var(--nds-border-subtle)' },
  { name: '--nds-grid-partition-w', value: px(gridGeometry.partitionW) },
  { name: '--nds-grid-partition-ratio', value: String(gridGeometry.partitionRatio) },
  { name: '--nds-grid-strip-rule', value: 'var(--nds-border-subtle)' },
  { name: '--nds-grid-frame', value: 'var(--nds-border)' },
  { name: '--nds-grid-frame-radius', value: 'var(--nds-radius-2xl)' },
  // ── type ──
  { name: '--nds-grid-header-fg', value: 'var(--nds-text-strong)' },
  { name: '--nds-grid-header-size', value: px(gridType.headerSize) },
  { name: '--nds-grid-header-weight', value: String(gridType.headerWeight) },
  { name: '--nds-grid-cell-fg', value: 'var(--nds-text)' },
  { name: '--nds-grid-cell-size', value: px(gridType.cellSize) },
  { name: '--nds-grid-cell-weight', value: String(gridType.cellWeight) },
  { name: '--nds-grid-muted-fg', value: 'var(--nds-text-muted)' },
  { name: '--nds-grid-strip-fg', value: 'var(--nds-text-2)' },
  { name: '--nds-grid-strip-size', value: px(gridType.stripSize) },
  { name: '--nds-grid-strip-weight', value: String(gridType.stripWeight) },
  { name: '--nds-grid-strip-tracking', value: gridType.stripTracking },
  { name: '--nds-grid-empty-fg', value: 'var(--nds-text-2)' },
  // ── density (compact / cozy / spacious) ──
  ...GRID_DENSITIES.map((d) => ({ name: `--nds-grid-row-text-${d}`, value: px(gridDensity[d].rowText) })),
  ...GRID_DENSITIES.map((d) => ({ name: `--nds-grid-row-media-${d}`, value: px(gridDensity[d].rowMedia) })),
  ...GRID_DENSITIES.map((d) => ({ name: `--nds-grid-header-${d}`, value: px(gridDensity[d].header) })),
  ...GRID_DENSITIES.map((d) => ({ name: `--nds-grid-thumb-${d}`, value: px(gridDensity[d].thumb) })),
  { name: '--nds-grid-cell-pad-x', value: px(gridDensity.cozy.cellPadX) },
  { name: '--nds-grid-cell-pad-x-compact', value: px(gridDensity.compact.cellPadX) },
  { name: '--nds-grid-strip-h', value: px(gridGeometry.stripH) },
  { name: '--nds-grid-footer-row-h', value: px(gridGeometry.footerRowH) },
  { name: '--nds-grid-select-col-w', value: px(gridGeometry.selectColW) },
  { name: '--nds-grid-identity-w', value: px(gridGeometry.identityW) },
  // ── controls ──
  { name: '--nds-grid-accent', value: 'var(--nds-primary)' },
  { name: '--nds-grid-focus-ring', value: 'var(--nds-focus-ring)' },
  { name: '--nds-grid-radius', value: 'var(--nds-radius-sm)' },
  { name: '--nds-grid-checkbox-size', value: px(gridGeometry.checkboxSize) },
  { name: '--nds-grid-checkbox-radius', value: 'var(--nds-radius-sm)' },
  { name: '--nds-grid-drag-handle', value: 'var(--nds-primary)' },
  { name: '--nds-grid-fill-handle', value: 'var(--nds-primary)' },
  // ── editing states ──
  { name: '--nds-grid-editable-ring', value: 'var(--nds-border)' },
  { name: '--nds-grid-editor-ring', value: 'var(--nds-primary)' },
  { name: '--nds-grid-pending-bg', value: 'color-mix(in srgb, var(--nds-warning) 14%, transparent)' },
  { name: '--nds-grid-refused-bg', value: 'color-mix(in srgb, var(--nds-danger) 10%, transparent)' },
  { name: '--nds-grid-refused-ring', value: 'var(--nds-danger)' },
  { name: '--nds-grid-saving-bg', value: 'color-mix(in srgb, var(--nds-info) 10%, transparent)' },
  { name: '--nds-grid-delta-bg', value: 'var(--nds-warning)' },
  { name: '--nds-grid-delta-neg-bg', value: 'var(--nds-danger)' },
  { name: '--nds-grid-delta-fg', value: 'var(--nds-text-inverse)' },
  { name: '--nds-grid-locked-fg', value: 'var(--nds-text-muted)' },
  // ── overlays ──
  { name: '--nds-grid-skeleton-bg', value: 'var(--nds-surface-sunken)' },
  { name: '--nds-grid-skeleton-shine', value: 'var(--nds-border-subtle)' },
  { name: '--nds-grid-loading-veil', value: 'color-mix(in srgb, var(--nds-surface) 60%, transparent)' },
  { name: '--nds-grid-pinned-shadow', value: '4px 0 6px -3px rgb(var(--nds-shadow-rgb) / 0.08)' },
]

/**
 * The `.dark` re-declarations: every entry whose value aliases a token (`var(--nds-…)`) or mixes
 * one (`color-mix(… var(--nds-…) …)`), restated verbatim so it resolves against the dark tier.
 * Dimensions, ratios and weights are theme-invariant and stay on `:root` only.
 */
export const gridVarsDark: ReadonlyArray<GridCssVar> = gridVars
  .filter((v) => /var\(--nds-(?!grid-)/.test(v.value) && !/^var\(--nds-(radius|focus-ring)/.test(v.value))
  .map(({ name, value }, i) => (i === 0 ? { section: 'Dark: grid aliases re-declared (see tokens/grid.ts)', name, value } : { name, value }))

/** Every emitted name — the theme test asserts each one is what the theme binds to. */
export const GRID_TOKEN_NAMES: ReadonlyArray<string> = gridVars.map((v) => v.name)

export const grid = { density: gridDensity, geometry: gridGeometry, type: gridType } as const

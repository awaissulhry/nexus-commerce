/**
 * GDS / PES.2 — VIEW PRESETS: the named column sets a surface ships with.
 *
 * A saved view (`useGridViews`) is the OPERATOR's — a name, on the server, per person. A preset is
 * the PRODUCT's: "Pricing", "Logistics", "Essentials". They belong in the same menu because
 * to an operator they are the same act ("show me the pricing columns"), and they are different
 * things underneath: a preset is a declaration in code that every operator gets and nobody can
 * break; a saved view is data.
 *
 * The Product Edit Studio needs these because its master scope has **102 columns** on the real
 * catalogue (measured: `market=IT`, `productTypes=OUTERWEAR`). The sheet LANDS on all of them —
 * Owner's decision 2026-09-04, `docs/2026-09-04-sheet-views-and-full-attributes-design.md` V.1 —
 * and presets are how an operator narrows by TASK without building a view by hand; the ground
 * state, "All attributes", is itself the first preset (`ALL_VIEW_ID`), so the way back is one
 * click in the same menu and never a hidden reset.
 *
 * Pure — the resolution rules are tested, and the menu that renders them is `toolbars/GridViewsMenu`.
 */

export interface GridViewPreset {
  /** Stable id — what a saved landing choice stores, so a relabelled preset still resolves. */
  id: string
  /** What the menu shows. */
  label: string
  /**
   * The columns this view shows, IN ORDER. Order is part of the view: "Pricing" puts price first,
   * and an operator who has to hunt for it across a 102-column grid has not been given a view.
   */
  columns: readonly string[]
  /** One line under the label — what the view is for. */
  description?: string
  /**
   * A row filter this view also applies (Missing required). Returning `undefined` means the view
   * changes columns only, which is the common case.
   */
  rowFilter?: string
}

/**
 * The id of the ground state every sheet ships: every column it has, in the sheet's ruled order.
 * First in the menu, never deletable, and what the sheet lands on unless the operator set an
 * explicit default view (`views/landing.ts`).
 */
export const ALL_VIEW_ID = 'all'

/** The ground-state preset, built from the live column set so its count is always right. */
export function allColumnsPreset(columns: readonly string[], label = 'All attributes'): GridViewPreset {
  return { id: ALL_VIEW_ID, label, description: 'Every column this sheet has', columns }
}

export interface PresetResolution {
  /** The columns to show, in the preset's order, restricted to what this grid actually has. */
  columns: string[]
  /**
   * Preset columns this grid does NOT have. A union sheet's column set changes with the product
   * type and the market, so a preset naming `fabric_type` is right for OUTERWEAR and meaningless
   * for a product type that has no such attribute. Reported rather than dropped silently, because
   * a preset that resolves to two columns should be able to say why.
   */
  missing: string[]
}

/**
 * Resolve a preset against the columns a grid actually has.
 *
 * Intersecting rather than trusting the preset is what keeps a view honest across product types
 * and markets: `applyColumnState` with an unknown colId is a no-op inside AG, so an unfiltered
 * preset would silently show fewer columns than it claims with nothing on screen to say so.
 *
 * `always` is prepended (identity, the tree column, completeness) — columns a view must never drop,
 * whatever it names. They are de-duplicated against the preset so naming one in both is harmless.
 */
export function resolvePreset(
  preset: Pick<GridViewPreset, 'columns'>,
  availableColumns: readonly string[],
  always: readonly string[] = [],
): PresetResolution {
  const have = new Set(availableColumns)
  const seen = new Set<string>()
  const columns: string[] = []
  for (const key of [...always, ...preset.columns]) {
    if (!have.has(key) || seen.has(key)) continue
    seen.add(key)
    columns.push(key)
  }
  const missing = preset.columns.filter((k) => !have.has(k))
  return { columns, missing }
}

/**
 * The preset a surface lands on, given what the operator last chose.
 *
 * Precedence, and the reason for each step: an operator's explicit choice wins; otherwise the
 * surface's declared default; otherwise the first preset. A stored id that no longer matches any
 * preset (a preset was renamed away, or the surface changed) falls through rather than resolving
 * to nothing — a grid must always land on SOME view.
 *
 * ⚠ The studio sheets no longer land through this — their landing is `views/landing.ts`
 * (`resolveLanding`), which lands FULL unless an explicit default view exists. This stays for a
 * surface whose presets ARE its landing choices.
 */
export function landingPreset(
  presets: readonly GridViewPreset[],
  opts: { lastUsedId?: string | null; defaultId?: string } = {},
): GridViewPreset | null {
  if (presets.length === 0) return null
  const byId = (id: string | null | undefined) => (id ? presets.find((p) => p.id === id) ?? null : null)
  return byId(opts.lastUsedId) ?? byId(opts.defaultId) ?? presets[0]
}

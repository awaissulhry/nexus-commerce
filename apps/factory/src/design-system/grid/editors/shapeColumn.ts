/**
 * GDS — what a `shape: 'list'` or `shape: 'measure'` column CARRIES on the grid, defined once
 * (AM.1 §A.3: "everything in the table is engine-owned, spread by BOTH builders").
 *
 * The editor, the formatter (copy/export/filter text), the parser (paste), the filter value and the
 * change-equality all follow the shape here; a builder spreads `shapeColumnDef(col, read)` and hands
 * `shapeEditorSpec(col)` to the formula selector as the non-formula fallback. `cellDataType: false`
 * stops AG inferring a number type from a `{ value, unit }` object and coercing it.
 */
import type { ColDef, ValueFormatterParams, ValueGetterParams, ValueParserParams } from 'ag-grid-community'

import { asList, asMeasure, formatList, formatMeasure, listLabelOf, type CellShape } from '../renderers/shapeFormat'
import { ListPanelEditor } from './ListPanelEditor'
import { MeasureEditor } from './MeasureEditor'
import { AxesPanelEditor } from './AxesPanelEditor'
import { VariationThemeValue, variationThemeText, variationThemeTooltip, variationThemeProvenanceMember, VARIATION_THEME_CHILD_REASON, type VariationThemeCell } from '../renderers/variationTheme'
import { sameValue } from './writeGate'
import { parseShape } from './shapeValue'
export { parseShape } from './shapeValue'

export interface ShapedColumnLike {
  key: string
  label?: string
  /**
   * `'axes'` (VT.2, 2026-09-13) is the variation-theme projection. It is widened HERE rather than in
   * `renderers/shapeFormat.ts`'s `CellShape` on purpose: `isShaped()`, `isEmptyShape()` and
   * `shapeValidation()` are the list/measure family's rules and an `axes` cell is none of those —
   * adding a member to that union would put a third shape inside three functions that would then
   * have to decide what to do with it. The ROUTING fact is `kind: 'variationTheme'` (contract §1),
   * and `shape` only says which family the cell belongs to.
   */
  shape?: CellShape | 'axes'
  /** The routing fact for the variation-theme column. Never the column KEY — see `variationThemeColumnDef`. */
  kind?: string
  options?: string[]
  optionLabels?: Record<string, string>
  cardinality?: { min: number; max: number | null }
  unitOptions?: string[]
}

/**
 * 🔴 ONE stable object, module-level. `cellEditorParams` identity churn re-runs AG's whole column
 * model (`reference_ag_react_inline_options_rerun_column_model`), and this editor needs nothing from
 * the column anyway: every fact it renders is on the CELL's own value (contract §1), which is what
 * lets one definition serve master, four channels and the dock without a per-scope parameter.
 */
const AXES_EDITOR_PARAMS: Record<string, unknown> = Object.freeze({})

export function shapeEditorSpec(col: ShapedColumnLike): { component: unknown; params: Record<string, unknown>; popup: true } | null {
  if (col.kind === 'variationTheme' || col.shape === 'axes') {
    return { component: AxesPanelEditor, popup: true, params: AXES_EDITOR_PARAMS }
  }
  if (col.shape === 'list') {
    return {
      component: ListPanelEditor,
      popup: true,
      params: {
        options: col.options?.length ? col.options.map((o) => ({ value: o, label: col.optionLabels?.[o] ?? o })) : undefined,
        maxItems: col.cardinality?.max ?? null,
        label: col.label,
      },
    }
  }
  if (col.shape === 'measure') {
    return { component: MeasureEditor, popup: true, params: { unitOptions: col.unitOptions ?? [], label: col.label } }
  }
  return null
}

/**
 * VT.2 — the `Variation theme` column, defined ONCE and spread by BOTH sheet builders.
 *
 * `reference_two_column_builders_drift` is the whole reason this is a function and not two blocks of
 * ColDef: master's builder and the channel's builder assembled their columns separately once before,
 * and the channel silently lacked six things master had. So everything about this column that could
 * differ between the two sheets lives here — the renderer, the editor, the popup flag, the copy /
 * export / filter text, the change equality, the editability, the fill-handle refusal and the
 * tooltip — and each builder contributes exactly one line.
 *
 * What each builder still owns: the base `def` it spreads FIRST (its own class rules, its own
 * provenance reader, its own row identity). This fragment is spread LAST so the pieces above cannot
 * be overridden by a scalar default the builder set for every other column.
 */
export function variationThemeColumnDef<T>(
  col: ShapedColumnLike & { width?: number },
  read: (row: T) => unknown,
  /**
   * 🔴 The builder's OWN composed `cellClassRules`, handed in so this fragment can EXTEND them
   * instead of replacing them — and it has to extend them, because of a mechanism measured on the
   * real sheet (Amazon·IT, clean signed-in Playwright context, its own browser build):
   *
   * the cell drew `nds-cell-prov-inherited` — the glyph — over a **transparent** background. The
   * glyph is the renderer's, read from the cell's VALUE (`source.kind`); the tint is the builder's
   * `provenanceClassRules`, read from the cell WRAPPER, which for this column says
   * `layer: 'master', pinned: false` on every scope. **A `cellClassRules` entry whose predicate is
   * false actively REMOVES the class**, so a `cellClass` string carrying `nds-cell-is-inherited`
   * was added and then taken away again in the same paint — which is why the first fix looked
   * right in a lab that had no such rule and did nothing on the sheet that did.
   *
   * So the provenance keys are overridden HERE, from `variationThemeProvenanceMember` — the same
   * function the renderer calls — and everything else the builder composed (validation, the
   * round-trip `saving`/`saved`/`refused` states, the chip hit) is spread through untouched.
   * Omitting the argument keeps the old behaviour for any caller that has none.
   */
  baseClassRules?: Record<string, (params: { data?: T }) => boolean>,
): Partial<ColDef<T>> {
  const cellOf = (row: T | undefined): VariationThemeCell | null =>
    row ? ((read(row) ?? null) as VariationThemeCell | null) : null
  const memberOf = (row: T | undefined) => {
    const cell = cellOf(row)
    return cell ? variationThemeProvenanceMember(cell) : 'own'
  }
  return {
    cellClassRules: {
      ...(baseClassRules ?? {}),
      'nds-cell-is-inherited': (p: { data?: T }) => memberOf(p.data) === 'inherited',
      'nds-cell-is-pinned': (p: { data?: T }) => memberOf(p.data) === 'pinned',
      'nds-cell-is-inherited-override': () => false,
    } as never,
    /* An object, not a scalar — AG would otherwise infer a type from it and coerce it. */
    cellDataType: false,
    /* R-VT-4: 160, the same number `variationThemeColumn()` serves. A token scale defined twice drifts
       (`reference_token_scale_defined_twice`), so this default exists only for a caller with no wire
       column and it is pinned to the producer's value by `the engine default equals the served width`. */
    width: col.width ?? 160,
    /* The base class and the editable/locked pair, because this same spread replaces whatever
       `cellClass` each builder set. The provenance TINT is NOT here — see `baseClassRules`. */
    cellClass: (p) => {
      const cell = cellOf(p.data ?? undefined)
      return `nds-ag-cell ${cell && cell.writable !== false ? 'nds-cell-is-editable' : 'nds-cell-is-locked'}`
    },
    cellRenderer: VariationThemeValue,
    cellRendererParams: { childReason: VARIATION_THEME_CHILD_REASON },
    cellEditor: AxesPanelEditor as never,
    cellEditorParams: AXES_EDITOR_PARAMS,
    cellEditorPopup: true,
    /**
     * 🔴 `cellEditorSelector` BEATS `cellEditor` in AG, so it has to be cleared or this column never
     * opens its own editor.
     *
     * Measured on the real Amazon·IT sheet: the popup opened, the cell went
     * `ag-cell-popup-editing`, no console error was raised — and the popup contained
     * `<!--AG-INPUT-TEXT-FIELD-->`, AG's plain text editor. The channel builder spreads
     * `formulaCellEditorSelector(...)`, which sets a SELECTOR; this fragment sets `cellEditor`, a
     * different key, so the spread order never came into it and the selector's fallback won on every
     * channel scope while master — whose base def has no selector — worked. An editor that opens the
     * WRONG editor silently is the same shape as one that opens nothing.
     *
     * Clearing it is correct rather than expedient: `=` is a formula on a scalar, and a projection is
     * not a scalar — there is nothing for a formula to produce here.
     */
    cellEditorSelector: undefined,
    /* 🔴 The fill handle's own `dblclick` listener swallows the open gesture AND fills the column
       down (`reference_ag_fill_handle_swallows_dblclick`, P0 2026-09-03). On a projection that is
       twenty silent writes of one family's structure onto twenty other rows, so the handle is
       refused on this column outright rather than defended against. */
    suppressFillHandle: true,
    /* Copy, export and the text filter — contract §1.4, derived by the renderer's own function so
       the clipboard and the screen cannot disagree. */
    valueFormatter: (p: ValueFormatterParams<T>) => variationThemeText((p.value ?? null) as VariationThemeCell | null),
    filterValueGetter: (p: ValueGetterParams<T>) => variationThemeText(cellOf(p.data ?? undefined)),
    comparator: (a: unknown, b: unknown) =>
      variationThemeText(a as VariationThemeCell | null).localeCompare(variationThemeText(b as VariationThemeCell | null)),
    /* 🔴 Structural equality. `sameValue` is the write gate's own comparison and it is what decides
       whether AG fires `cellValueChanged` at all — a reference compare would fire on every reported
       draft, and an unchanged edit must send NOTHING (design §3.5's first commit rule). */
    equals: (a: unknown, b: unknown) => sameValue(a, b),
    /* No `valueParser`: this column takes no pasted text. A projection pasted as a string has no
       coordinate, no CAS token and no child ids, so there is nothing honest to build from it. */
    /**
     * 🔴 The setter MUST override each builder's own, and it must MUTATE `params.data`.
     *
     * Both builders write a scalar setter for every column — master's runs
     * `parseReferenceOrScalarValue(col, newValue)` and the channel's does the same and then stamps
     * `layer: 'alias', pinned: true`. Either one applied to a `VariationThemeCell` would coerce the
     * OBJECT the editor reported (`String(value)` → `[object Object]`) and stamp a provenance the
     * server never said, which is why this fragment is spread LAST in both builders.
     *
     * AG rebuilds `newValue` by re-running the value getter against `params.data` the moment this
     * returns, so scheduling React state here hands the write path the OLD value
     * (`reference_ag_value_setter_must_mutate_params_data`). The row shape is read structurally —
     * `{ values: { [key]: { value } } }` is the intersection of `StudioRow` and `ChannelSheetRow`, so
     * one setter serves both without either builder passing a writer and drifting.
     *
     * The provenance is NOT stamped here: `source.kind` is the server's word (§1.1), the editor
     * already moved it to `override` when the operator pressed `Override`, and a client-side pin
     * would make the cell claim a layer before the write has landed.
     */
    valueSetter: (p) => {
      const row = p.data as unknown as { values?: Record<string, { value?: unknown }> } | undefined
      if (!row?.values) return false
      const previous = row.values[col.key] ?? {}
      row.values = { ...row.values, [col.key]: { ...previous, value: p.newValue } }
      return true
    },
    editable: (p) => {
      const cell = cellOf(p.data ?? undefined)
      return !!cell && cell.writable !== false
    },
    /* The cell's ONE tooltip, composed by the renderer's own function from SERVER-STATED lines only
       (§1.1). Spread LAST so it wins over the builder's generic scalar tooltip — a variation-theme
       cell has nothing to say about length caps or product-type applicability. */
    tooltipValueGetter: (p) => variationThemeTooltip(cellOf(p.data ?? undefined)),
  }
}

export function shapeColumnDef<T>(col: ShapedColumnLike, read: (row: T) => unknown): Partial<ColDef<T>> {
  if (col.kind === 'variationTheme' || col.shape === 'axes') return variationThemeColumnDef<T>(col, read)
  const spec = shapeEditorSpec(col)
  if (!spec) return {}
  const shape = col.shape as CellShape
  /* Copy, export and the filter text show LABELS for a closed list, as the scalar select does (#669). */
  const labels = (v: unknown) => formatList(asList(v).map(listLabelOf(col)))
  return {
    cellDataType: false,
    cellEditor: spec.component as never,
    cellEditorParams: spec.params,
    cellEditorPopup: true,
    valueFormatter: (p: ValueFormatterParams<T>) => (shape === 'list' ? labels(p.value) : formatMeasure(p.value)),
    valueParser: (p: ValueParserParams<T>) => parseShape(shape, p.newValue, col),
    /* The text filter reads the joined list; the number filter reads the measure's value. */
    filterValueGetter: (p: ValueGetterParams<T>) => {
      const v = p.data ? read(p.data) : null
      return shape === 'list' ? labels(v) : asMeasure(v).value
    },
    equals: (a: unknown, b: unknown) => sameValue(a, b),
    comparator: (a: unknown, b: unknown) =>
      shape === 'list' ? labels(a).localeCompare(labels(b)) : (asMeasure(a).value ?? -Infinity) - (asMeasure(b).value ?? -Infinity),
  }
}

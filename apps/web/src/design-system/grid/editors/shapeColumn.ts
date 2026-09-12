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
import { sameValue } from './writeGate'
import { parseShape } from './shapeValue'
export { parseShape } from './shapeValue'

export interface ShapedColumnLike {
  key: string
  label?: string
  shape?: CellShape
  options?: string[]
  optionLabels?: Record<string, string>
  cardinality?: { min: number; max: number | null }
  unitOptions?: string[]
}

export function shapeEditorSpec(col: ShapedColumnLike): { component: unknown; params: Record<string, unknown>; popup: true } | null {
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

export function shapeColumnDef<T>(col: ShapedColumnLike, read: (row: T) => unknown): Partial<ColDef<T>> {
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

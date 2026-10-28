/**
 * GDS — the column filter every sheet column carries, by KIND, with the inline (floating) input.
 *
 * Lifted from `master/columns.tsx` on 2026-09-04: the channel scopes defined NO filters at all, so
 * their header was 29px against master's 57px (the floating-filter row) and nothing on them could
 * be filtered. One definition; both sheets spread it. Kept apart from `editors/sheetColumn.ts`
 * because `gridFilterDef` is a `.tsx` export and that module must stay node-loadable.
 */
import { gridFilterDef } from './gridFilters'
import { BOOLEAN_OPTIONS } from '../editors/scalarValue'

export function sheetFilterFor(col: { kind: string; shape?: string; options?: string[]; optionLabels?: Record<string, string> }) {
  /* AM.1: a list filters as TEXT over its joined values, a measure as a NUMBER over its value — the
     column's `filterValueGetter` (`shapeColumnDef`) supplies both. A set filter over an array or a
     number filter over an object would compare the wrong thing. */
  if (col.shape === 'list') return gridFilterDef('text', undefined, { floating: true })
  if (col.shape === 'measure') return gridFilterDef('number', undefined, { floating: true })
  if (col.kind === 'select' || col.kind === 'boolean') {
    const options = col.kind === 'boolean' ? BOOLEAN_OPTIONS : (col.options ?? []).map((o) => ({ value: o, label: col.optionLabels?.[o] ?? o }))
    return gridFilterDef('set', { options, searchable: true }, { floating: true })
  }
  if (col.kind === 'number') return gridFilterDef('number', undefined, { floating: true })
  return gridFilterDef('text', undefined, { floating: true })
}

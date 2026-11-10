import type { CellClassParams } from '@nexus/ui/grid'
import type { CellMarks } from '../../view-model'

/**
 * A grid cell's save mark on the record's sheets (Options, Price & BOM effects, Styles; B-W2b-242): saving (a wash and
 * "Saving…"), refused (the danger tone and our words in its tooltip; the stored value shown again). Pure.
 */

type Translate = (key: string, params?: Record<string, string | number>) => string

/** The cell's classes from the page's marks (`<row id>/<field>`). */
export function cellRules<T extends { id: string }>(cells: CellMarks, field: string): Record<string, (params: CellClassParams<T>) => boolean> {
  return {
    'fw-opt-cell-saving': (params) => !!params.data && cells[`${params.data.id}/${field}`]?.state === 'saving',
    'fw-opt-cell-refused': (params) => !!params.data && cells[`${params.data.id}/${field}`]?.state === 'refused',
  }
}

/** The cell's tooltip: "Saving…", or why it was refused (a libraries' `problem.*` key or this page's own). */
export function cellTip(cells: CellMarks, rowId: string | undefined, field: string, tl: Translate, t: Translate): string | undefined {
  if (!rowId) return undefined
  const mark = cells[`${rowId}/${field}`]
  if (!mark) return undefined
  if (mark.state === 'saving') return tl('save.saving')
  return mark.problem.startsWith('problem.') ? tl(mark.problem) : t(mark.problem, mark.params)
}

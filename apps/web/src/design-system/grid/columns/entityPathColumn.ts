/**
 * entityPathColumn (Keyword Harvest DS lane H7, 2026-10-10) — where a row's thing sits: Portfolio › Campaign › Ad group,
 * each a link, cut in the middle when the column is narrow, the whole path on hover and focus (the DS `EntityPath`).
 *
 * The value at `field` is the path, top first: `EntityRef[]` (`{ id, name, href? }`; a missing step may be null). The
 * CSV, clipboard, quick filter and column filter read "A › B › C"; it sorts by that text. Keys (`entityPathKeys`): Enter
 * on the cell follows the only link or steps onto the last one; ← / → walk the links; Esc returns to the cell — in a grid
 * whose cells take focus (`suppressCellFocus={false}`). A click on a link works either way and never ticks the row.
 *
 * Its own file, not `presets.ts` (that file belongs to another lane while the Bid page is built).
 */
import type { ColDef } from 'ag-grid-community'

import { compareEntityPath, entityPathText } from '../../components/entityPathModel'
import { EntityPathCell, entityPathOf, type EntityPathCellParams } from '../renderers/EntityPathCell'
import { entityPathKeys } from '../renderers/entityPathKeys'

type Field<T> = string & { __row?: T }

export interface EntityPathColumnOptions<T> extends EntityPathCellParams<T> {
  header: string
}

export const entityPathColumn = <T,>(field: Field<T>, opts: EntityPathColumnOptions<T>): ColDef<T> => {
  const { header, ...params } = opts
  return {
    field: field as unknown as ColDef<T>['field'],
    headerName: header,
    cellClass: 'nds-ag-cell',
    cellRenderer: EntityPathCell,
    cellRendererParams: params,
    valueFormatter: (p) => entityPathText(entityPathOf(p.value)),
    getQuickFilterText: (p) => entityPathText(entityPathOf(p.value)),
    filterValueGetter: (p) => entityPathText(entityPathOf(p.getValue(field))),
    comparator: (a, b) => compareEntityPath(entityPathOf(a), entityPathOf(b)),
    suppressKeyboardEvent: entityPathKeys,
  }
}

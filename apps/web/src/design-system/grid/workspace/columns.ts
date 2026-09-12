/**
 * AGW — `GridColumn[]` + preferences → AG `ColDef[]`. Pure, so the mapping is tested.
 *
 * What a column definition carries here is STRUCTURE only: id, label, tooltip, alignment class,
 * sortability, pinning, width, visibility, order. Everything that reads a ROW — `render`,
 * `sortValue`, `total`, the edit fields — is reached at call time through the grid's context
 * (`./cells.tsx`), never baked into the definition. That split is what lets a consumer rebuild its
 * `columns` array on every render (most do) without the engine re-running its column model: the
 * definitions change only when this function's INPUTS change, and `WorkspaceGrid` keys them on a
 * structural signature.
 */
import type { CellClassParams, ColDef, SortComparatorFn, ValueGetterParams } from 'ag-grid-community'

import { compareForAgGrid } from '../sortValues'
import { FIRST_COL, GROUP_COL } from './prefs'
import type { GridColumn, GridPrefs } from './types'
import type { WsContextHolder } from './cells'

/** WG.1 — `align` first, `metric` as the legacy spelling. */
export const alignClass = <T>(c: GridColumn<T>): 'num' | 'ed' | 'ctr' =>
  c.align === 'center' ? 'ctr' : c.align === 'left' ? 'ed' : c.align === 'right' ? 'num' : c.metric === false ? 'ed' : 'num'

/** The identity column's measured box: `th.nm { width: 300; min-width: 300 }`, `td.nm { max-width: 360 }`. */
export const FIRST_COL_MIN = 300
export const FIRST_COL_MAX = 360

export interface BuildColDefsInput<T> {
  columns: readonly GridColumn<T>[]
  prefs: GridPrefs
  firstColLabel: string
  /** `firstSortValue` present — the identity header sorts only then (legacy: a sort by `''` is a no-op). */
  firstSortable: boolean
  /** server / hierarchy / chromeless: the comparators are inert so AG's stable sort keeps the given order. */
  rawOrder: boolean
  groupBy: boolean
  /** Content-driven row heights (the legacy `<td>` grew with its content): every cell measures itself.
   *  False only when the consumer fixes `rowHeight` — the Ad Manager's 50. */
  autoRows: boolean
  /** `hierarchy` mode: the identity cell is the legacy `td.nm.nds-tree-cell` (8px vertical padding). */
  tree: boolean
  defaultSort?: { key: string; dir: 'asc' | 'desc' }
  /** The renderers and the tooltip component — module-level components handed in so this stays a pure module. */
  components: {
    identity: unknown
    value: unknown
    headerTip: unknown
  }
}

const inertComparator = () => 0

/** `td.editing` — the cell whose field is open in edit mode (its padding is 7px, not 12). Read through the context. */
const editingRule = (key: string): ColDef['cellClassRules'] => ({
  editing: (p: CellClassParams) => {
    const ctx = (p.context as WsContextHolder | undefined)?.current
    return !!ctx && ctx.editing && ctx.editByKey.has(key) && p.data != null && !ctx.isSentinel(p.data) && !p.node.rowPinned
  },
})
const valueComparator: SortComparatorFn = (a, b, _nodeA, _nodeB, isDescending) => compareForAgGrid(a, b, isDescending)

/**
 * The value AG sorts on: the column's `sortValue`, read through the context so the consumer's
 * latest function is the one that runs. A pinned (totals) row, a skeleton row and a group row have
 * no sort value.
 */
const sortValueGetter = (key: string) => (p: ValueGetterParams): unknown => {
  const ctx = (p.context as WsContextHolder | undefined)?.current
  if (!ctx || p.node?.rowPinned || p.data == null || ctx.isSentinel(p.data)) return undefined
  return key === FIRST_COL ? ctx.firstSortValue?.(p.data) : ctx.columnsByKey.get(key)?.sortValue?.(p.data)
}

/**
 * Build the definitions. Order: the identity column, then the preferences' visible columns in
 * their order, then every hidden column (hidden, so `applyOrder` never interleaves them), then the
 * hidden group column when grouping.
 */
export function buildColDefs<T>(input: BuildColDefsInput<T>): ColDef[] {
  const { columns, prefs, firstColLabel, firstSortable, rawOrder, groupBy, autoRows, tree, defaultSort, components } = input
  const byKey = new Map(columns.map((c) => [c.key, c] as const))
  const visible = [...new Set([...(prefs.lockedColumns ?? []).filter((key) => !byKey.get(key)?.freezeRight), ...prefs.visible, ...(prefs.lockedColumns ?? [])])].map((k) => byKey.get(k)).filter((c): c is GridColumn<T> => !!c)
  const visibleSet = new Set(visible.map((c) => c.key))
  const hidden = columns.filter((c) => !visibleSet.has(c.key))
  // SG.2 — the pinned-right set is the VISIBLE `freezeRight` columns with a width; the leftmost one
  // carries the separator (`fzr0`). An empty set when the operator turns sticky-last off.
  const pinnedRight = visible.filter((c) => c.freezeRight && c.width != null && (prefs.lockedColumns ? prefs.lockedColumns.includes(c.key) : prefs.stickyLast))
  const fzr0 = pinnedRight[0]?.key
  const comparator = rawOrder ? inertComparator : valueComparator
  // `initialSort`, never `sort`: a definition rebuild (a Customize save) must not reset the
  // operator's header sort. No `initialSortIndex` — one sorted column shows no index badge.
  const initialSort = (key: string): Pick<ColDef, 'initialSort'> =>
    defaultSort && defaultSort.key === key ? { initialSort: defaultSort.dir } : {}
  const widthOf = (key: string): number | undefined => prefs.widths?.[key]

  const first: ColDef = {
    colId: FIRST_COL,
    headerName: firstColLabel,
    // The identity column cannot be hidden or moved; whether it STICKS is the operator's.
    pinned: prefs.stickyFirst ? 'left' : null,
    lockPinned: true,
    lockPosition: 'left',
    lockVisible: true,
    suppressMovable: true,
    initialWidth: widthOf(FIRST_COL) ?? FIRST_COL_MIN,
    minWidth: FIRST_COL_MIN,
    maxWidth: FIRST_COL_MAX,
    suppressAutoSize: widthOf(FIRST_COL) != null,
    // The legacy `th.nm { width: 300px }` took its content width and never the table's slack — the extra
    // width of a narrow grid went to the OTHER columns (measured: identity 300 on Budget Manager, 328.5 on the
    // campaign pages, whatever the box). So the stretch-to-fit leaves this column alone.
    suppressSizeToFit: true,
    sortable: firstSortable,
    comparator,
    valueGetter: sortValueGetter(FIRST_COL),
    cellRenderer: components.identity,
    autoHeight: autoRows,
    cellClass: ['nds-ws-td', 'nm', ...(prefs.stickyFirst ? ['fz'] : []), ...(tree ? ['nds-tree-cell'] : [])],
    cellClassRules: editingRule(FIRST_COL),
    headerClass: 'nds-ws-th nds-ws-th-nm',
    ...initialSort(FIRST_COL),
  }

  const toDef = (c: GridColumn<T>, hide: boolean): ColDef => {
    const align = alignClass(c)
    const pinned = pinnedRight.some((p) => p.key === c.key)
    const pinnedLeft = !pinned && !!prefs.lockedColumns?.includes(c.key)
    const fixed = c.width != null || widthOf(c.key) != null
    return {
      colId: c.key,
      headerName: c.label,
      ...(c.tip ? { headerTooltip: c.tip, tooltipComponent: components.headerTip } : {}),
      hide,
      pinned: pinned ? 'right' : pinnedLeft ? 'left' : null,
      lockPinned: true,
      suppressMovable: pinnedLeft || pinned,
      sortable: c.sortable !== false,
      comparator,
      valueGetter: sortValueGetter(c.key),
      cellRenderer: components.value,
      autoHeight: autoRows,
      cellClassRules: editingRule(c.key),
      cellClass: ['nds-ws-td', align, ...(pinnedLeft ? ['fz'] : []), ...(pinned ? ['fzr', ...(c.key === fzr0 ? ['fzr0'] : [])] : [])],
      headerClass: ['nds-ws-th', `nds-ws-th-${align}`, ...(align === 'num' ? ['nds-ag-head-num'] : []), ...(pinned ? ['fzr', ...(c.key === fzr0 ? ['fzr0'] : [])] : [])],
      ...(widthOf(c.key) != null ? { initialWidth: widthOf(c.key) } : c.width != null ? { initialWidth: c.width } : {}),
      ...(c.width != null ? { minWidth: c.width, maxWidth: c.width, resizable: false } : {}),
      suppressAutoSize: fixed,
      suppressSizeToFit: fixed,
      ...initialSort(c.key),
    }
  }

  const defs: ColDef[] = [first, ...visible.map((c) => toDef(c, false)), ...hidden.map((c) => toDef(c, true))]
  if (groupBy) {
    defs.push({
      colId: GROUP_COL,
      headerName: '',
      rowGroup: true,
      hide: true,
      lockVisible: true,
      lockPinned: true,
      suppressMovable: true,
      sortable: false,
      suppressHeaderMenuButton: true,
      valueGetter: (p: ValueGetterParams) => {
        const ctx = (p.context as WsContextHolder | undefined)?.current
        return ctx?.groupKeyOf && p.data != null && !ctx.isSentinel(p.data) ? ctx.groupKeyOf(p.data) : undefined
      },
    })
  }
  return defs
}

/**
 * The structural signature the definitions depend on. Two renders whose columns differ only in
 * function identity (the common case: `columns` rebuilt inline) produce the same string, so the
 * definitions — and AG's column model — stay put.
 */
export function columnsSignature<T>(columns: readonly GridColumn<T>[]): string {
  return JSON.stringify(columns.map((c) => [c.key, c.label, c.tip ?? null, c.align ?? null, c.metric ?? null, c.sortable ?? null, c.defaultHidden ?? null, c.freezeRight ?? null, c.width ?? null]))
}

/**
 * AGD — `Column<T>[]` (+ the legacy preferences) → AG `ColDef[]`. Pure, so the mapping is tested.
 *
 * A definition carries STRUCTURE only: id, label (when it is a string), alignment classes,
 * sortability, pinning, width, visibility, order. Everything that reads a ROW — `render`,
 * `sortValue`, `total`, `cellProps` — is reached at call time through the grid's context
 * (`./cells.tsx`). That split is what lets the 38 ads sites that build `columns` inline on every
 * render keep doing so without AG re-running its column model: the definitions change only when
 * `columnsSignature` changes.
 *
 * The SORT is the legacy's, exactly (DataGrid.tsx:455-475): first click descending, then a toggle,
 * never a clear (`SORTING_ORDER`); the comparator is `<`/`>` on whatever `sortValue` returns —
 * no locale, no blank-sinking (three ads sites rely on sentinels: `-1`, `-Infinity`, a joined
 * string), and a stable tie. AG inverts the ascending result for a descending sort, which is what
 * the legacy's `-dir` did. Below the top level (tree children) and on the pinned row the
 * comparator answers 0, so kids keep their `getSubRows` order — the legacy never sorted them.
 */
import type { CellClassParams, CellClassRules, ColDef, HeaderClassParams, IRowNode, SortDirection, ValueGetterParams } from 'ag-grid-community'

import type { Column } from '../../components/DataGrid'
import type { DgContextHolder } from './cells'
import { CHECKBOX_COL_W } from './geometry'

/** The checkbox column's id — the adapter's own column (`th.ck` / `td.ck`), never AG's selection column. */
export const CK_COL = '__ck'

/** The legacy cycle: a first click sorts DESCENDING, the next toggles; there is no third, cleared state. */
export const SORTING_ORDER: SortDirection[] = ['desc', 'asc']

/** `alignClass` (DataGrid.tsx:533), verbatim. */
export const alignClass = (a?: 'left' | 'right' | 'center'): 'r' | 'c' | '' => (a === 'right' ? 'r' : a === 'center' ? 'c' : '')

type SortValue = number | string

/** The legacy comparator body (DataGrid.tsx:464) for the ascending direction. */
export function legacyCompare(av: unknown, bv: unknown): number {
  const a = av as SortValue
  const b = bv as SortValue
  return a < b ? -1 : a > b ? 1 : 0
}

const isTopLevelData = (n: IRowNode | undefined): boolean => !!n && !n.rowPinned && (n.level ?? 0) === 0

/** AG's five-argument comparator; the direction flip is AG's, as `-dir` was the legacy's. */
export const legacyComparator = (a: unknown, b: unknown, nodeA: IRowNode, nodeB: IRowNode): number =>
  isTopLevelData(nodeA) && isTopLevelData(nodeB) ? legacyCompare(a, b) : 0

/** The value AG sorts on: the column's `sortValue`, read through the context so the consumer's latest function runs. */
const sortValueGetter = (key: string) => (p: ValueGetterParams): unknown => {
  const ctx = (p.context as DgContextHolder | undefined)?.current
  if (!ctx || p.node?.rowPinned || p.data == null || ctx.isSentinel(p.data)) return undefined
  return ctx.columnsByKey.get(key)?.sortValue?.(p.data)
}

/**
 * `first` / `last` on the first and last DATA column's cells (page rules keyed on `td:first-child`
 * / `td:last-child` move to these). Evaluated on every cell refresh, so a column move or a hidden
 * column re-labels the edges; the grid refreshes the cells when the displayed set changes.
 */
export const EDGE_CELL_RULES: CellClassRules = {
  first: (p: CellClassParams) => (p.context as DgContextHolder | undefined)?.current?.firstColId === p.column.getColId(),
  last: (p: CellClassParams) => (p.context as DgContextHolder | undefined)?.current?.lastColId === p.column.getColId(),
}

/** The same two marks on the header cells (`th:first-child` / `th:last-child` page rules). */
export const edgeHeaderClass = (p: HeaderClassParams): string[] => {
  const ctx = (p.context as DgContextHolder | undefined)?.current
  const id = p.column?.getColId()
  const out: string[] = []
  if (ctx && id && ctx.firstColId === id) out.push('first')
  if (ctx && id && ctx.lastColId === id) out.push('last')
  return out
}

export interface SplitColumns<T> {
  lockedLead: Column<T>[]
  lockedTrail: Column<T>[]
  togglableKeys: string[]
  defaultLockedKeys: string[]
  anyPinned: boolean
  prefsColumns: Array<{ key: string; label: string; locked: boolean; defaultLocked: boolean; group?: string; lockSide?: 'left' | 'right' }>
}

/** DataGrid.tsx:288-316, verbatim: what pins, what the operator may toggle, what the dialog lists. */
export function splitColumns<T>(columns: readonly Column<T>[]): SplitColumns<T> {
  const isPinned = (c: Column<T>) => !!c.sticky || !!c.stickyRight
  const togglable = columns.filter((c) => !isPinned(c))
  const lead = columns.filter((c) => c.sticky)
  const trail = columns.filter((c) => c.stickyRight && !c.sticky)
  return {
    lockedLead: lead,
    lockedTrail: trail,
    togglableKeys: togglable.map((c) => c.key),
    defaultLockedKeys: togglable.filter((c) => c.prefsLocked).map((c) => c.key),
    anyPinned: columns.some((c) => c.sticky || c.stickyRight),
    prefsColumns: [...lead, ...togglable, ...trail].map((c) => ({
      key: c.key,
      label: typeof c.label === 'string' && c.label.trim() ? c.label : c.prefsLabel ?? c.key,
      locked: isPinned(c),
      defaultLocked: !!c.prefsLocked,
      group: c.group,
      ...(c.stickyRight && !c.sticky ? { lockSide: 'right' as const } : {}),
    })),
  }
}

/** DataGrid.tsx:437-446, verbatim: the operator's order IS the render order; untouched unless `customizable`. */
export function orderColumns<T>(columns: readonly Column<T>[], visibleColumns: readonly string[], customizable: boolean, lockedLead: readonly Column<T>[], lockedTrail: readonly Column<T>[], lockedColumns: readonly string[] = []): Column<T>[] {
  if (!customizable) return [...columns]
  const byKey = new Map(columns.map((c) => [c.key, c] as const))
  const mid: Column<T>[] = []
  for (const k of new Set([...lockedColumns, ...visibleColumns])) {
    const c = byKey.get(k)
    if (c && !c.sticky && !c.stickyRight) mid.push(c)
  }
  return [...lockedLead, ...mid, ...lockedTrail]
}

export interface BuildColDefsInput<T> {
  /** The visible columns in render order (`orderColumns`). */
  visible: readonly Column<T>[]
  /** Columns the operator hid — kept in the model as `hide: true` so a header drag never interleaves them. */
  hidden: readonly Column<T>[]
  selectable: boolean
  /** The operator's sticky toggles, gating the developer's flags (DataGrid.tsx:450-453). */
  pinLeft: boolean
  pinRight: boolean
  /** The sort in force at definition time — `initialSort` on that column; later changes are applied as column state. */
  sort: { key: string; dir: 'asc' | 'desc' } | null
  /** Persisted header resizes (additive to the legacy shape). */
  widths?: Record<string, number>
  lockedColumns?: readonly string[]
  /** Module-level renderers handed in so this stays a pure module. */
  components: {
    value: unknown
    select: unknown
    selectAll: unknown
    labelHeader: unknown
  }
}

const stickyClasses = (sticky: boolean, stickyRight: boolean): string[] =>
  sticky ? ['sticky'] : stickyRight ? ['sticky-right', 'stickyRight'] : []

/**
 * Build the definitions. Order: the checkbox column (pinned left, 40px), then the visible columns
 * in render order, then every hidden column.
 */
export function buildColDefs<T>(input: BuildColDefsInput<T>): ColDef[] {
  const { visible, hidden, selectable, pinLeft, pinRight, sort, widths, lockedColumns = [], components } = input
  const defs: ColDef[] = []
  if (selectable) {
    defs.push({
      colId: CK_COL,
      headerName: '',
      width: CHECKBOX_COL_W,
      minWidth: CHECKBOX_COL_W,
      maxWidth: CHECKBOX_COL_W,
      resizable: false,
      sortable: false,
      suppressMovable: true,
      lockPosition: 'left',
      lockPinned: true,
      pinned: 'left',
      suppressHeaderMenuButton: true,
      suppressAutoSize: true,
      suppressSizeToFit: true,
      autoHeight: true,
      cellRenderer: components.select,
      headerComponent: components.selectAll,
      cellClass: ['nds-dg-td', 'ck', 'sticky'],
      headerClass: ['nds-dg-th', 'ck', 'sticky'],
    })
  }
  const toDef = (c: Column<T>, hide: boolean): ColDef => {
    const sticky = (!!c.sticky && pinLeft) || lockedColumns.includes(c.key)
    const stickyRight = !c.sticky && !!c.stickyRight && pinRight
    const align = alignClass(c.numeric ? 'right' : c.align)
    const headAlign = alignClass(c.align)
    const stringLabel = typeof c.label === 'string'
    const width = widths?.[c.key] ?? c.width
    return {
      colId: c.key,
      headerName: stringLabel ? (c.label as string) : '',
      ...(stringLabel ? {} : { headerComponentParams: { innerHeaderComponent: components.labelHeader } }),
      hide,
      sortable: !!c.sortable,
      comparator: legacyComparator,
      valueGetter: sortValueGetter(c.key),
      ...(sort && sort.key === c.key ? { initialSort: sort.dir } : {}),
      pinned: sticky ? 'left' : stickyRight ? 'right' : null,
      lockPinned: true,
      suppressMovable: sticky || stickyRight,
      autoHeight: true,
      cellRenderer: components.value,
      cellClass: ['nds-dg-td', align, c.numeric ? 'num' : '', c.className ?? '', ...stickyClasses(sticky, stickyRight)].filter(Boolean),
      cellClassRules: EDGE_CELL_RULES,
      headerClass: (p: HeaderClassParams) => ['nds-dg-th', headAlign, headAlign === 'r' ? 'nds-ag-head-num' : '', ...stickyClasses(sticky, stickyRight), ...edgeHeaderClass(p)].filter(Boolean),
      ...(width != null ? { initialWidth: width, suppressAutoSize: true } : {}),
    }
  }
  for (const c of visible) defs.push(toDef(c, false))
  for (const c of hidden) defs.push(toDef(c, true))
  return defs
}

/**
 * The structural signature the definitions depend on. Two renders whose columns differ only in
 * function identity or in a JSX label's identity (the common case: `columns` rebuilt inline)
 * produce the same string, so the definitions — and AG's column model — stay put. A JSX label is
 * read through the context by the header, a string label is the header name itself.
 */
export function columnsSignature<T>(columns: readonly Column<T>[]): string {
  return JSON.stringify(columns.map((c) => [
    c.key,
    typeof c.label === 'string' ? c.label : c.label == null || c.label === false ? '' : '#node',
    c.align ?? null,
    c.numeric ?? null,
    c.className ?? null,
    c.sortable ?? null,
    c.sticky ?? null,
    c.stickyRight ?? null,
    c.width ?? null,
    c.prefsLocked ?? null,
    c.group ?? null,
    c.prefsLabel ?? null,
  ]))
}

/**
 * AGD — the rows AG is handed, in the legacy's order. Pure, so the shape is tested.
 *
 * The legacy `<tbody>` rendered, per row: the row, then its `getSubRows` children as REAL rows
 * (only while the row's key is in `expanded`), then one full-width `tr.nds-grid-sub` when
 * `renderExpanded(row)` returns something (again only while open). AG is handed exactly that list,
 * as a TREE when either prop is present (`treeData` + `getDataPath`): the children of a parent are
 * the kids in `getSubRows` order and the sub row LAST, and the comparator returns 0 below the top
 * level so AG's stable sort keeps that order — the legacy never sorted kids. Rows AG is not handed
 * are rows the legacy did not render: a collapsed parent has no children in the tree at all, so
 * AG's own expansion state is never consulted (`isGroupOpenByDefault` answers true for everything).
 */
import type { ReactNode } from 'react'

/** The full-width detail row beneath a parent: `renderExpanded(row)`, rendered by the adapter. */
export interface SubRow<T> {
  readonly __sub: true
  readonly parentKey: string
  readonly row: T
  readonly node: ReactNode
}

/** The pinned totals row's data. `v` changes so AG re-measures it when the rows change. */
export interface TotalRow {
  readonly __total: true
  readonly v: number
}

export type DgRow<T> = T | SubRow<T>

export const isSubRow = <T = unknown>(d: unknown): d is SubRow<T> => typeof d === 'object' && d !== null && '__sub' in (d as object)
export const isTotalRow = (d: unknown): d is TotalRow => typeof d === 'object' && d !== null && '__total' in (d as object)

export const subRowId = (parentKey: string): string => `__sub:${parentKey}`

export type RowKind = 'row' | 'kid' | 'sub'

export interface RowMeta {
  id: string
  /** AG's `getDataPath` — one segment at the top, two beneath a parent. */
  path: string[]
  kind: RowKind
  parentKey: string | null
}

export interface FlattenInput<T> {
  rows: readonly T[]
  rowKey: (row: T) => string
  expanded?: ReadonlySet<string>
  getSubRows?: (row: T) => T[] | undefined
  renderExpanded?: (row: T) => ReactNode
}

export interface FlatRows<T> {
  data: DgRow<T>[]
  /** Keyed by the very object handed to AG, which is what AG hands back to `getRowId` / `getDataPath`. */
  meta: Map<DgRow<T>, RowMeta>
  /** How many rows are top-level (the legacy's `rows.length`, the count the empty state keys on). */
  topCount: number
}

export function flattenRows<T>(input: FlattenInput<T>): FlatRows<T> {
  const { rows, rowKey, expanded, getSubRows, renderExpanded } = input
  const data: DgRow<T>[] = []
  const meta = new Map<DgRow<T>, RowMeta>()
  for (const row of rows) {
    const k = rowKey(row)
    data.push(row)
    meta.set(row, { id: k, path: [k], kind: 'row', parentKey: null })
    const isOpen = !!expanded?.has(k)
    if (!isOpen) continue
    // The legacy evaluated both only while open, in this order (DataGrid.tsx:619-621).
    const sub = renderExpanded ? renderExpanded(row) : null
    const kids = getSubRows ? (getSubRows(row) ?? []) : []
    for (const kid of kids) {
      const kk = rowKey(kid)
      data.push(kid)
      meta.set(kid, { id: kk, path: [k, kk], kind: 'kid', parentKey: k })
    }
    if (sub != null) {
      const s: SubRow<T> = { __sub: true, parentKey: k, row, node: sub }
      data.push(s)
      meta.set(s, { id: subRowId(k), path: [k, subRowId(k)], kind: 'sub', parentKey: k })
    }
  }
  return { data, meta, topCount: rows.length }
}

export interface SelectableKeysInput<T> {
  rows: readonly T[]
  rowKey: (row: T) => string
  rowSelectable?: (row: T) => boolean
  subRowSelectable?: boolean
  getSubRows?: (row: T) => T[] | undefined
  expanded?: ReadonlySet<string>
}

/**
 * What select-all covers — the legacy `allKeys` (DataGrid.tsx:481-493), verbatim: the rows the
 * gate lets through, plus the VISIBLE children when `subRowSelectable`, each gated the same way.
 */
export function selectableKeys<T>(input: SelectableKeysInput<T>): string[] {
  const { rows, rowKey, rowSelectable, subRowSelectable, getSubRows, expanded } = input
  const base = rowSelectable ? rows.filter(rowSelectable) : rows
  const keys = base.map(rowKey)
  if (!subRowSelectable || !getSubRows || !expanded) return keys
  for (const r of rows) {
    if (!expanded.has(rowKey(r))) continue
    for (const kid of getSubRows(r) ?? []) {
      if (rowSelectable && !rowSelectable(kid)) continue
      keys.push(rowKey(kid))
    }
  }
  return keys
}

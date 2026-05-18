/**
 * G.0 — shared GridLens type definitions.
 *
 * GridLensColumn mirrors ColumnDef from products/_columns.ts (structurally
 * compatible — no rename needed; TypeScript structural typing handles it).
 *
 * GridLensRow is the minimal constraint on the row type that
 * VirtualizedGrid<T> needs to operate.
 */

export interface GridLensColumn {
  key: string
  label: string
  labelKey?: string
  subLabel?: string
  width: number
  locked?: boolean
}

export interface GridLensRow {
  id: string
  isParent?: boolean
  childCount?: number
  parentId?: string | null
}

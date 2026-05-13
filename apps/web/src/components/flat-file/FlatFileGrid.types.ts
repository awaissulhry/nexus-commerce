import type React from 'react'

// ── Column schema ─────────────────────────────────────────────────────────

export type FlatFileColumnKind = 'text' | 'longtext' | 'number' | 'enum' | 'boolean' | 'readonly'

export interface FlatFileColumn {
  id: string
  label: string
  description?: string
  required?: boolean
  kind: FlatFileColumnKind
  options?: string[]
  maxLength?: number
  width: number
  frozen?: boolean
  readOnly?: boolean
}

export interface FlatFileColumnGroup {
  id: string
  label: string
  color: string
  columns: FlatFileColumn[]
}

// ── Row base type ─────────────────────────────────────────────────────────

export interface BaseRow {
  _rowId: string
  _productId?: string
  _dirty?: boolean
  _isNew?: boolean
  _status?: 'idle' | 'pending' | 'pushed' | 'error'
  _feedMessage?: string
  [key: string]: unknown
}

// ── Cell renderer props ───────────────────────────────────────────────────
// CellComponent renders the full <td> element.
// Grid provides interaction state; cell forwards handlers to its <td>.

export interface CellProps {
  col: FlatFileColumn
  row: BaseRow
  value: unknown

  // Selection state
  isActive: boolean       // this cell has keyboard focus
  isSelected: boolean     // row selected via checkbox
  isInRange: boolean      // inside the drag/shift-click selection range
  isFillHandle: boolean   // show the fill-handle corner on this cell

  // Styling helpers
  cfClass?: string
  rowBandClass?: string

  // Grid-managed editing — cell auto-starts editing when editInitialChar is set
  editInitialChar: string | null
  onEditStart: () => void   // cell → grid: "I entered edit mode"
  onEditEnd: () => void     // cell → grid: "I left edit mode"

  // Pointer events — cell must forward these to its <td>
  onPointerDown: (e: React.PointerEvent) => void
  onPointerEnter: (e: React.PointerEvent) => void

  // Value change
  onChange: (v: unknown) => void
  onActivate: () => void
}

// ── Validation ────────────────────────────────────────────────────────────

export interface ValidationIssue {
  level: 'error' | 'warn'
  sku: string
  field: string
  msg: string
}

// ── Slot context types ────────────────────────────────────────────────────

export interface PushExtrasCtx {
  rows: BaseRow[]
  selectedRows: Set<string>
  dirtyCount: number
  loading: boolean
  saving: boolean
}

export interface ModalsCtx {
  rows: BaseRow[]
  setRows: React.Dispatch<React.SetStateAction<BaseRow[]>>
  pushHistory: (rows: BaseRow[]) => void
}

export interface ToolbarFetchCtx {
  rows: BaseRow[]
  selectedRows: Set<string>
  loading: boolean
  setRows: React.Dispatch<React.SetStateAction<BaseRow[]>>
  pushHistory: (rows: BaseRow[]) => void
}

export interface ToolbarImportCtx {
  loading: boolean
  setRows: React.Dispatch<React.SetStateAction<BaseRow[]>>
  pushHistory: (rows: BaseRow[]) => void
}

export interface ReplicateCtx {
  rows: BaseRow[]
  selectedRows: Set<string>
  visibleGroups: FlatFileColumnGroup[]
  pushHistory: (rows: BaseRow[]) => void
  setRows: React.Dispatch<React.SetStateAction<BaseRow[]>>
}

// ── Main grid props ───────────────────────────────────────────────────────

export interface FlatFileGridProps {
  channel: 'amazon' | 'ebay' | 'shopify'
  title: string
  titleIcon?: React.ReactNode
  marketplace: string
  familyId?: string
  storageKey: string

  columnGroups: FlatFileColumnGroup[]

  initialRows: BaseRow[]
  makeBlankRow: () => BaseRow
  minRows?: number

  CellComponent: React.ComponentType<CellProps>

  getGroupKey?: (row: BaseRow) => string

  validate?: (rows: BaseRow[]) => ValidationIssue[]

  onSave: (dirty: BaseRow[]) => Promise<{ saved: number }>
  onReload: () => Promise<BaseRow[]>
  onCellChange?: (rowId: string, colId: string, value: unknown) => void

  onReplicate?: (
    targets: string[],
    groupIds: Set<string>,
    selectedOnly: boolean,
    ctx: ReplicateCtx,
  ) => Promise<{ copied: number; skipped: number }>

  renderChannelStrip?: () => React.ReactNode
  renderPushExtras?: (ctx: PushExtrasCtx) => React.ReactNode
  renderFeedBanner?: () => React.ReactNode
  renderModals?: (ctx: ModalsCtx) => React.ReactNode
  renderToolbarFetch?: (ctx: ToolbarFetchCtx) => React.ReactNode
  renderToolbarImport?: (ctx: ToolbarImportCtx) => React.ReactNode
  renderBar3Left?: () => React.ReactNode
}

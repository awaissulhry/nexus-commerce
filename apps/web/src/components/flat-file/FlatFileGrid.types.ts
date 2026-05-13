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

// ── Cell renderer props (passed to channel CellComponent) ─────────────────

export interface CellProps {
  col: FlatFileColumn
  row: BaseRow
  value: unknown
  isActive: boolean
  isSelected: boolean
  cfClass?: string
  rowBandClass?: string
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
  // Channel identity
  channel: 'amazon' | 'ebay' | 'shopify'
  title: string
  titleIcon?: React.ReactNode
  marketplace: string
  familyId?: string
  storageKey: string          // localStorage key prefix (e.g. 'eff', 'aff')

  // Columns — reactive: eBay client updates to add category aspect columns
  columnGroups: FlatFileColumnGroup[]

  // Rows
  initialRows: BaseRow[]
  makeBlankRow: () => BaseRow
  minRows?: number             // pad to at least this many rows (default 15)

  // Cell rendering — channel-specific, bound component pattern
  CellComponent: React.ComponentType<CellProps>

  // Row grouping — defaults to (row) => row._rowId (no grouping)
  getGroupKey?: (row: BaseRow) => string

  // Validation
  validate?: (rows: BaseRow[]) => ValidationIssue[]

  // API
  onSave: (dirty: BaseRow[]) => Promise<{ saved: number }>
  onReload: () => Promise<BaseRow[]>
  onCellChange?: (rowId: string, colId: string, value: unknown) => void

  // Replication (channel-specific; hides button when absent)
  onReplicate?: (
    targets: string[],
    groupIds: Set<string>,
    selectedOnly: boolean,
    ctx: ReplicateCtx,
  ) => Promise<{ copied: number; skipped: number }>

  // Render slots
  renderChannelStrip?: () => React.ReactNode
  renderPushExtras?: (ctx: PushExtrasCtx) => React.ReactNode
  renderFeedBanner?: () => React.ReactNode
  renderModals?: (ctx: ModalsCtx) => React.ReactNode
  renderToolbarFetch?: (ctx: ToolbarFetchCtx) => React.ReactNode
  renderToolbarImport?: (ctx: ToolbarImportCtx) => React.ReactNode
  renderBar3Left?: () => React.ReactNode
}

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

// ── Cell content override ─────────────────────────────────────────────────
// Return non-null to replace the default cell display content.

export type RenderCellContent = (
  col: FlatFileColumn,
  row: BaseRow,
  value: unknown,
  displayVal: string,
) => React.ReactNode | null

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

  getGroupKey?: (row: BaseRow) => string

  validate?: (rows: BaseRow[]) => ValidationIssue[]

  onSave: (dirty: BaseRow[]) => Promise<{ saved: number }>
  onReload: () => Promise<BaseRow[]>
  onCellChange?: (rowId: string, colId: string, value: unknown) => void

  // Override display content for specific cells (return null = default rendering)
  renderCellContent?: RenderCellContent

  // Extra content rendered below row # in the row header cell
  renderRowMeta?: (row: BaseRow, rowIdx: number) => React.ReactNode

  // Return true to intercept edit (e.g. open a modal) and suppress normal cell editing
  onBeforeEditCell?: (col: FlatFileColumn, row: BaseRow) => boolean

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

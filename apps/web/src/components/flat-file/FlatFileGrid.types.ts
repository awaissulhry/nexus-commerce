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
  /** Display labels for option values — keys are option values, values are human-readable names */
  optionLabels?: Record<string, string>
  /**
   * How strictly the options list is enforced (enum columns only):
   * - 'open'   — suggestions; any typed value is valid (eBay FREE_TEXT).
   * - 'strict' — eBay only accepts listed values (SELECTION_ONLY); a typed
   *              custom value is still allowed but flagged.
   * Undefined keeps the legacy behavior (open, no flag).
   */
  enumMode?: 'open' | 'strict'
  /**
   * Enum cell holds a comma-separated LIST of values (e.g. a variation
   * theme, or a MULTI-cardinality aspect). The dropdown toggles options
   * in/out of the list and stays open. Undefined = single-value (legacy).
   */
  multiValue?: boolean
  /**
   * Which Amazon parentage levels this field applies to (undefined = all).
   * Drives the listing guidance highlight in the grid.
   */
  applicableParentage?: string[]
  /** Field usage level from the channel's schema (REQUIRED/RECOMMENDED/OPTIONAL) */
  guidance?: string
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
  _status?: 'idle' | 'pending' | 'pushed' | 'success' | 'error'
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

// ── Sort ──────────────────────────────────────────────────────────────────

/** Multi-level sort configuration entry (mirrors SortPanel.SortLevel). */
export interface SortLevel {
  id: string
  colId: string
  mode: 'asc' | 'desc' | 'custom'
  customOrder: string[]
}

// ── Conditional formatting ─────────────────────────────────────────────────

export type RuleOp =
  | 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq'
  | 'contains' | 'startsWith' | 'endsWith' | 'empty' | 'notEmpty'

export type RuleTone = 'red' | 'amber' | 'green' | 'blue' | 'slate'

/** Conditional-format rule (mirrors bulk-edit ConditionalRule). */
export interface ConditionalRule {
  id: string
  columnId: string
  op: RuleOp
  value: unknown
  tone: RuleTone
  enabled: boolean
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
  rows: BaseRow[]
  setRows: React.Dispatch<React.SetStateAction<BaseRow[]>>
  pushHistory: (rows: BaseRow[]) => void
  onReload: () => void
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
  channel: 'amazon' | 'ebay' | 'shopify' | 'all'
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

  /**
   * Return a guidance level to shade cells that are not applicable / low-priority
   * for the current row type or product category. Cell remains fully editable.
   * - 'not-applicable' → medium gray bg + tooltip (field shouldn't be filled for this row)
   * - 'optional'       → subtle gray bg (field is low-priority for this category)
   */
  getCellGuidance?: (col: FlatFileColumn, row: BaseRow) => 'not-applicable' | 'optional' | null

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
  /** A4.1 — AI assistant panel slot */
  renderAiPanel?: (ctx: AiPanelCtx) => React.ReactNode
  /** G.2 — beginner empty-state CTA (launches the editor's add flow). */
  renderEmptyAction?: () => React.ReactNode

  // ── Toolbar passthrough props (wired directly to FlatFileToolbar) ─────
  /** Open the Columns/Group modal. When provided, the Columns button appears in the toolbar. */
  onColumnsClick?: () => void
  /** Whether the Columns modal is currently open (highlights the toolbar button). */
  columnsActive?: boolean
  /** Channel-specific button(s) appended before the Columns + AI Assistant group. */
  toolbarTrailing?: React.ReactNode

  /**
   * Controlled column group state from the parent (useFlatFileCore).
   * When provided, the grid derives closedGroups and groupOrder from this
   * instead of managing them internally. The ColumnGroupModal in the parent
   * becomes the sole driver of group visibility and order.
   */
  columnGroupState?: import('@/design-system/components/ColumnGroupModal').ColumnGroupProps[]
}

// ── A4.1 — AI panel context ───────────────────────────────────────────────

export interface FlatFileAiChange {
  rowId: string
  sku: string
  field: string
  oldValue: unknown
  newValue: unknown
}

export interface AiPanelCtx {
  rows: BaseRow[]
  columns: FlatFileColumn[]
  marketplace: string
  /** Apply changes to flat file rows (updates in-memory state + marks rows dirty) */
  onApplyChanges: (changes: FlatFileAiChange[]) => void
}

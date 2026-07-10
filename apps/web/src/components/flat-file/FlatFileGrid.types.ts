import type React from 'react'
import type { GroupColorName } from './group-model'

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
  /**
   * UFX P2c — union (multi-category) sheets: the product types this column
   * applies to. When set and the row carries a `product_type` string that is
   * NOT in the list (compared uppercased), the cell automatically gets the
   * 'not-applicable' guidance overlay + tooltip — but STAYS FULLY EDITABLE
   * (eBay semantics). An explicit getCellGuidance result wins over this
   * built-in. Undefined = applies to all types (legacy columns unchanged).
   */
  applicableProductTypes?: string[]
  /**
   * UFX P2c — the product types for which this column is REQUIRED. When set,
   * the empty-cell '⚠ required' marker + required styling only show for rows
   * whose `product_type` (uppercased) is in the list. Undefined falls back to
   * the plain `required` flag (legacy columns unchanged).
   */
  requiredForProductTypes?: string[]
  /** Field usage level from the channel's schema (REQUIRED/RECOMMENDED/OPTIONAL) */
  guidance?: string
  maxLength?: number
  /** Max length in UTF-8 bytes (Amazon enforces bytes, not chars). */
  maxUtf8ByteLength?: number
  /**
   * Minimum allowed value for a number column. Bulk writes (paste/fill) that
   * land below this are clamped up to it (e.g. a stock buffer's min = 0).
   */
  min?: number
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
  /**
   * UFX P2d — a trailing blank "canvas" row (Sheets-style infinite grid).
   * Ghosts are visually normal blank rows but are excluded from dirty counts,
   * Save, validation, select-all, exports and the '⚠ required' markers; the
   * first real edit materializes one into a plain new row (_ghost:false,
   * _isNew:true, _dirty:true). Only present when the grid's `ghostRows` prop
   * is set.
   */
  _ghost?: boolean
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
  /** UFX P3 — lets consumer actions drive the checkbox selection (e.g. Amazon's
   *  "Select all Pinned"). Additive; existing consumers ignore it. */
  setSelectedRows: React.Dispatch<React.SetStateAction<Set<string>>>
}

// ── UFX P3 — consumer footer-actions slot context ─────────────────────────
// ToolbarFetchCtx plus the current keyboard-selection anchor row (or null),
// so page-level "Add row here" flows can position inserts.
export interface FooterActionsCtx extends ToolbarFetchCtx {
  anchorRow: BaseRow | null
  /** Opens the grid's Create-group popover for the current selection
   *  (only meaningful with enableCustomGroups). */
  groupFromSelection: () => void
}

// ── UFX P3 — consumer right-click context menu ────────────────────────────
// The grid owns the open/close state + the right-click selection semantics
// (right-click on the row # selects the whole row; on an unselected cell,
// selects that cell) and passes fresh clipboard ops each render, so menu
// actions never operate on a stale selection.
export interface GridContextMenuCtx {
  x: number
  y: number
  close: () => void
  hasSelection: boolean
  selRowCount: number
  /** The real (non-ghost) display rows inside the current range selection. */
  selectionRows: BaseRow[]
  anchorRow: BaseRow | null
  ops: {
    cut: () => void
    copy: () => void
    paste: () => void
    clearCells: () => void
    /** Opens the grid's Create-group popover for the current selection. */
    groupFromSelection: () => void
  }
}

// ── UFX P3 — bucket (auto-section) grouping mode ──────────────────────────
// A consumer-declared partition of the sheet into fixed sections (e.g. the
// Amazon FBA/FBM split). Adds one button to the Group-by strip; rows keep
// their family ordering and are stably partitioned into the declared buckets
// (empty buckets are hidden; sections collapse like custom groups).
export interface BucketGroupMode {
  /** Group-by strip button label, e.g. 'FBA/FBM'. */
  label: string
  buckets: Array<{ key: string; name: string; color: GroupColorName }>
  /** Section key for a row. `rows` = all real rows (for cross-row rules like
   *  "a parent follows its FBA children"). Unknown keys fall into bucket 0. */
  bucketFor: (row: BaseRow, rows: BaseRow[]) => string
}

// ── UFX P3 — minimal imperative grid API ──────────────────────────────────
export interface FlatFileGridApi {
  /** Clear search/collapse state, then select + scroll to the cell for
   *  (sku, field). Best-effort across two frames. */
  goToCell: (sku: string, field: string) => void
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
  /**
   * UFX P2d — Sheets-style "infinite canvas": keep this many trailing blank
   * ghost rows (built from makeBlankRow with `_ghost:true` and `_isNew`/`_dirty`
   * forced false) appended at the very bottom, outside family/custom groups,
   * in the default unsearched view only. Typing/paste/fill/enum-pick into a
   * ghost materializes it into a plain new row and the buffer tops back up, so
   * the grid grows forever as you type. Ghosts are excluded from dirty counts,
   * onSave(dirty), validate(), select-all, exports and the '⚠ required'
   * markers. Paste blocks that overrun the end auto-grow the pool instead of
   * being refused. When enabled the consumer no longer needs minRows padding.
   * Undefined = legacy behavior, byte-identical.
   */
  ghostRows?: number

  getGroupKey?: (row: BaseRow) => string

  /**
   * UFX P3 — opt-in auto-section grouping mode (e.g. Amazon FBA/FBM). Adds a
   * button (bucketMode.label) to the Group-by strip. Undefined = strip and
   * behavior unchanged.
   */
  bucketMode?: BucketGroupMode

  validate?: (rows: BaseRow[]) => ValidationIssue[]

  onSave: (dirty: BaseRow[]) => Promise<{ saved: number; createResult?: { errors?: unknown[] } }>
  onReload: () => Promise<BaseRow[]>
  onCellChange?: (rowId: string, colId: string, value: unknown) => void

  /**
   * UFX P3 — extra consumer patch merged into a ghost row when it materializes
   * (first real edit). Applied AFTER the built-in materialize patch and BEFORE
   * the edited cell value, so infra fields (e.g. Amazon's product_type +
   * record_action) can be stamped without overriding what the user typed.
   */
  onMaterializeRow?: (row: BaseRow) => Partial<BaseRow>

  /**
   * UFX P3 — notified whenever the user applies a new sort config (SortPanel
   * Apply, or a drag-reorder clearing the sort). Lets consumers mirror the
   * persisted `${storageKey}-sort` to other scopes (Amazon market sync).
   */
  onSortConfigChange?: (levels: SortLevel[]) => void
  /** UFX P3 — notified with the full _rowId order after a drag-reorder. */
  onRowOrderChange?: (rowIds: string[]) => void

  /**
   * UFX P3 — consumer-rendered right-click context menu. When provided, the
   * grid preventDefaults contextmenu over cells/row headers, applies the
   * Sheets-style right-click selection, and renders this with fresh ops.
   */
  renderContextMenu?: (ctx: GridContextMenuCtx) => React.ReactNode

  /**
   * UFX P3 — replaces the grid's default footer actions (Add row / Group /
   * Delete buttons) with consumer content. Needed where "delete" must be a
   * channel API call (Amazon remove-from-market), not a local row removal.
   */
  renderFooterActions?: (ctx: FooterActionsCtx) => React.ReactNode

  /** UFX P3 — receives a minimal imperative API (goToCell). */
  apiRef?: React.MutableRefObject<FlatFileGridApi | null>

  // Override display content for specific cells (return null = default rendering)
  renderCellContent?: RenderCellContent

  /**
   * Return a guidance level to shade cells that are not applicable / low-priority
   * for the current row type or product category. Cell remains fully editable.
   * - 'not-applicable' → medium gray bg + tooltip (field shouldn't be filled for this row)
   * - 'optional'       → subtle gray bg (field is low-priority for this category)
   */
  getCellGuidance?: (col: FlatFileColumn, row: BaseRow) => 'not-applicable' | 'optional' | null

  /**
   * UFX P2b — per-CELL read-only predicate (e.g. Amazon's FBA-managed quantity:
   * the column is editable for FBM rows but locked for FBA rows). When it
   * returns true for a cell:
   * - every edit entry path is blocked (double-click, typing, F2, Alt+Down)
   * - every bulk write path skips it (Delete/Backspace clear, paste, fill-down,
   *   fill-right, drag-fill, fill-to-bottom, Find&Replace, AI apply) — enforced
   *   centrally in the grid's single write path (commitCells)
   * - it renders with read-only styling (cursor-not-allowed, select-none) and
   *   an em-dash '—' when empty
   * Selection and copy still work. Unlike getCellGuidance (which shades but
   * stays editable), this HARD-blocks writes. Column-level `readOnly` /
   * kind:'readonly' behavior is unchanged.
   */
  getCellReadOnly?: (col: FlatFileColumn, row: BaseRow) => boolean

  // Extra content rendered below row # in the row header cell
  renderRowMeta?: (row: BaseRow, rowIdx: number) => React.ReactNode

  /**
   * UFX P2e — row-header thumbnail source hook (Amazon parity: ASIN → image
   * map resolved asynchronously). Only consulted while the toolbar's row-images
   * toggle is on. Return:
   * - a URL string → render that image
   * - null         → still resolving: render a skeleton pulse
   * - undefined    → fall back to the default `row.image_1` behavior
   * Data-COLUMN image cells need NO hook: `renderCellContent` already covers
   * every display path (readonly/enum/longtext/text), and while a cell is
   * being edited the raw URL is what should show anyway.
   */
  getRowImageUrl?: (row: BaseRow) => string | null | undefined

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
  /** Extra items appended to the File menu in Bar 1. Same shape as MenuDropdown items. */
  fileMenuItems?: Array<{ label: string; icon?: React.ReactNode; onClick?: () => void; disabled?: boolean; separator?: boolean }>
  /**
   * Extra items appended to the Edit menu in Bar 1. A factory (not a static array) so the
   * items can read live rows/selection — e.g. bulk Follow/Buffer that act on the selected
   * rows and disable themselves when nothing is selected. Called on every grid render.
   */
  editMenuItems?: (ctx: ToolbarFetchCtx) => Array<{ label?: string; icon?: React.ReactNode; onClick?: () => void; disabled?: boolean; separator?: boolean }>
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
  /**
   * Called when the user performs a group visibility/order action inside the grid
   * (reset order, show all, saved-view apply, column header toggle).
   * In controlled mode the parent must update columnGroupState in response.
   */
  onGroupStateChange?: (closed: Set<string>, order: string[]) => void

  /**
   * P4 — enable named custom SKU groups (create/name/assign from checkbox
   * selection, plus a Family|Custom|None "Group by" toggle). Opt-in per
   * consumer; when omitted/false the grid behaves exactly as before (family
   * grouping only). Groups persist under the `storageKey` scope.
   */
  enableCustomGroups?: boolean
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

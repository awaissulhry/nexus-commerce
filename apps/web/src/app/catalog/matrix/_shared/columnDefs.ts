/**
 * PIM C.4 — Matrix column registry.
 *
 * Defines every column that the matrix can render. Each column has
 * a stable id, a label, a CSS width, and a render(row) function that
 * returns either a plain value or a React node. Headers and cells
 * walk the same list so a new column is one entry, not three.
 *
 * Two column sources:
 *   - BUILT_IN_COLUMNS — declared statically here (SKU, Name, Brand…)
 *   - dynamic — discovered at runtime via discoverDynamicColumns()
 *     which scans loaded rows for categoryAttributes keys
 *
 * Visibility is operator-controlled via ColumnPicker and persisted to
 * localStorage. Reorder lands in C.6 (saved views) alongside server-
 * side persistence.
 */

export type CellAlign = 'left' | 'right' | 'center'

export interface ColumnDef {
  id: string
  label: string
  /** CSS grid-template-columns track value (e.g. "160px", "1fr",
   *  "minmax(200px, 1.5fr)"). */
  width: string
  align?: CellAlign
  /** When true, the column always renders in the matrix; the picker
   *  hides it. Used for the structural expand/edit cells. */
  required?: boolean
  /** Whether the column comes from categoryAttributes JSONB (dynamic).
   *  Used by the picker to group + label them differently. */
  dynamic?: boolean
  /** When true the column is editable inline (C.3 EditableCell).
   *  False = plain text rendering. Dynamic columns default false for
   *  C.4; C.4b will lift that. */
  editable?: boolean
}

/** Stable built-in column registry. Order here is the default render
 *  order; ColumnPicker reorder lands in C.6. */
export const BUILT_IN_COLUMNS: ColumnDef[] = [
  // Structural — never hidden, never reordered
  { id: '__expand', label: '', width: '36px', required: true },
  { id: 'sku', label: 'SKU', width: '160px', required: true },
  { id: 'name', label: 'Name', width: 'minmax(200px, 1.5fr)', required: true },
  // Defaults visible
  { id: 'brand', label: 'Brand', width: '140px', editable: true },
  { id: 'totalStock', label: 'Stock', width: '90px', align: 'right', editable: true },
  { id: 'basePrice', label: 'Price', width: '110px', align: 'right', editable: true },
  { id: 'status', label: 'Status', width: '100px', editable: true },
  { id: 'channelCoverage', label: 'Channels', width: 'minmax(160px, 1fr)' },
  // Structural — always last
  { id: '__actions', label: '', width: '60px', required: true, align: 'center' },
]

/** Default visibility for built-ins: every non-required column is
 *  visible. Operators toggle in the picker. */
export const DEFAULT_VISIBLE_IDS: string[] = BUILT_IN_COLUMNS.filter(
  (c) => c.required || c.id !== /* placeholder for future hidden defaults */ '',
).map((c) => c.id)

/** Width to use for dynamic categoryAttributes columns by default.
 *  Operators can adjust per-column widths via a future enhancement;
 *  for now they're uniform. */
const DYNAMIC_COLUMN_WIDTH = '140px'

interface MatrixRowLike {
  categoryAttributes?: Record<string, unknown> | null
  variants?: Array<{ categoryAttributes?: Record<string, unknown> | null }>
}

/** Walk loaded rows + their variants to surface every distinct
 *  categoryAttributes key. Returned columns are sorted alphabetically
 *  for stable picker ordering. */
export function discoverDynamicColumns(rows: MatrixRowLike[]): ColumnDef[] {
  const keys = new Set<string>()
  for (const row of rows) {
    if (row.categoryAttributes) {
      for (const k of Object.keys(row.categoryAttributes)) keys.add(k)
    }
    if (row.variants) {
      for (const v of row.variants) {
        if (v.categoryAttributes) {
          for (const k of Object.keys(v.categoryAttributes)) keys.add(k)
        }
      }
    }
  }
  return Array.from(keys)
    .sort()
    .map((key) => ({
      id: `attr:${key}`,
      label: key,
      width: DYNAMIC_COLUMN_WIDTH,
      dynamic: true,
    }))
}

/** Helper for rendering a dynamic column's value from a row's
 *  categoryAttributes blob. Returns the primitive directly so the
 *  cell can format. */
export function dynamicAttrValue(
  row: MatrixRowLike,
  columnId: string,
): unknown {
  if (!columnId.startsWith('attr:')) return null
  const key = columnId.slice('attr:'.length)
  return row.categoryAttributes?.[key] ?? null
}

/** Pretty-print an arbitrary JSONB value for display in a non-editable
 *  cell. Strings stay strings; numbers tabular; booleans as "yes"/"no";
 *  objects/arrays as compact JSON (truncated). */
export function formatDynamicValue(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  try {
    const s = JSON.stringify(v)
    return s.length > 40 ? s.slice(0, 37) + '…' : s
  } catch {
    return String(v)
  }
}

// ────────────────────────────────────────────────────────────────────
// LocalStorage persistence for visible column ids.
// ────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'catalog-matrix:columns:v1'

export function loadVisibleColumnIds(): string[] | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return null
  }
}

export function saveVisibleColumnIds(ids: string[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    /* localStorage quota or disabled — ignore */
  }
}

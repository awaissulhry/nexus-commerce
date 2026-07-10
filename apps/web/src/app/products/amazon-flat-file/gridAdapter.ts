// UFX P3 — pure adapter between the Amazon flat-file page (manifest-driven
// Column/ColumnGroup shapes + Row semantics) and the shared FlatFileGrid
// contract. Relative imports so the vitest suite (root config, no `@/` alias)
// can run this module.
import type {
  BaseRow, FlatFileColumn, FlatFileColumnGroup, ValidationIssue,
} from '../../../components/flat-file/FlatFileGrid.types'
import { isRequiredForRow } from '../../../components/flat-file/cellFlags'
import { mixedTypeFamilies, rowsMissingNode, BROWSE_NODE_KEY, PRODUCT_TYPE_KEY } from './category-model'

// Structural mirror of the page's manifest Column (kept local so this module
// stays import-cycle-free and unit-testable).
export interface AmazonColumn {
  id: string
  fieldRef: string
  labelEn: string
  labelLocal: string
  description?: string
  required: boolean
  kind: 'text' | 'longtext' | 'number' | 'enum' | 'boolean'
  options?: string[]
  selectionOnly?: boolean
  applicableParentage?: string[]
  applicableProductTypes?: string[]
  requiredForProductTypes?: string[]
  guidance?: string
  maxLength?: number
  maxUtf8ByteLength?: number
  width: number
  optionLabels?: Record<string, string>
}

export interface AmazonColumnGroup {
  id: string
  labelEn: string
  labelLocal: string
  color: string
  columns: AmazonColumn[]
}

// ── FBA-managed cells (INVARIANT — never weaken) ──────────────────────────
// FBA quantity is Amazon-managed: never written, pinned, or pushed by us.
// On FBA rows quantity + the synthetic Follow/Buffer are hard-locked
// (getCellReadOnly) and render '—' even when a value exists.

export const FBA_MANAGED_COL_IDS = new Set([
  'fulfillment_availability__quantity', 'follow', 'buffer',
])

export function isFbaRow(row: BaseRow): boolean {
  return /^(AMAZON|AFN|FBA)/.test(
    String(row.fulfillment_availability__fulfillment_channel_code ?? '').toUpperCase(),
  )
}

export function isFbaManagedCell(colId: string, row: BaseRow): boolean {
  return FBA_MANAGED_COL_IDS.has(colId) && isFbaRow(row)
}

// ── Column conversion ──────────────────────────────────────────────────────
// selectionOnly → enumMode 'strict' so the grid's central commitCells
// normalizer enforces the option list on EVERY bulk write path (paste, fill,
// fill-to-bottom, find&replace, AI) — the same guarantees the page's old
// normalizeSyntheticCell gave Follow/Buffer, now for every strict enum.
// The synthetic Buffer column additionally carries min:0 (clamp-up).

export function toGridColumn(col: AmazonColumn): FlatFileColumn {
  const localGloss = col.labelLocal && col.labelLocal !== col.labelEn ? col.labelLocal : null
  return {
    id: col.id,
    label: col.labelEn,
    description: [localGloss, col.description].filter(Boolean).join(' — ') || undefined,
    required: col.required,
    kind: col.kind,
    options: col.options,
    optionLabels: col.optionLabels,
    enumMode: col.kind === 'enum' ? (col.selectionOnly ? 'strict' : 'open') : undefined,
    applicableParentage: col.applicableParentage,
    applicableProductTypes: col.applicableProductTypes,
    requiredForProductTypes: col.requiredForProductTypes,
    guidance: col.guidance,
    maxLength: col.maxLength,
    maxUtf8ByteLength: col.maxUtf8ByteLength,
    min: col.id === 'buffer' ? 0 : undefined,
    width: col.width,
  }
}

/** BN.2.1 — the derived read-only Category column (product type + browse-node
 *  breadcrumb chip), spliced right after record_action. Read-only: excluded
 *  from every write path by the grid's isWritableCol gate. */
export const CATEGORY_GRID_COL: FlatFileColumn = {
  id: '__category',
  label: 'Category',
  description: 'Derived from the row’s product type + browse node — use "Set category" to change it',
  kind: 'readonly',
  readOnly: true,
  width: 360,
}

/**
 * Manifest groups → shared-grid column groups. Injects the synthetic Category
 * column after record_action; per-type applicability travels first-class on
 * the columns (built-in greyed-but-editable + per-row required markers).
 * `filterType` (MT.5) narrows a union sheet to one category's columns
 * (+ shared/infra columns that carry no applicableProductTypes).
 */
export function buildGridColumnGroups(
  groups: AmazonColumnGroup[],
  opts: { filterType?: string | null } = {},
): FlatFileColumnGroup[] {
  const filterType = opts.filterType?.toUpperCase() || null
  return groups
    .map((g) => {
      let cols = g.columns
      if (filterType) {
        cols = cols.filter((c) => !c.applicableProductTypes || c.applicableProductTypes.includes(filterType))
      }
      const out: FlatFileColumn[] = []
      for (const c of cols) {
        out.push(toGridColumn(c))
        if (c.id === 'record_action') out.push(CATEGORY_GRID_COL)
      }
      return { id: g.id, label: g.labelEn, color: g.color, columns: out }
    })
    .filter((g) => g.columns.length > 0)
}

// ── Validation (grid validate contract) ────────────────────────────────────
// Port of the page's old cellErrors production, mapped onto the grid's
// ValidationIssue[] (sku/field/level/msg). Covers: required-per-row (via the
// P2c requiredForProductTypes resolution, falling back to the plain flag),
// UTF-8 byte caps, char caps, enum warnings, Amazon feed _errorFields,
// ALA _issueFields (severity-mapped), orphaned children, and the BN.4.3
// advisories (mixed-type families / missing browse node) as warnings.

export function validateAmazonRows(
  rows: BaseRow[],
  gridColumns: FlatFileColumn[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const enc = new TextEncoder()
  const skuOf = (r: BaseRow) => String(r.item_sku ?? '')

  for (const row of rows) {
    if (row._ghost) continue
    // FFP.2 — a delete row sends only sku+operationType; nothing to validate.
    if (String(row.record_action ?? '').toLowerCase() === 'delete') continue
    const sku = skuOf(row)
    for (const col of gridColumns) {
      if (col.id === '__category') continue
      const rawVal = row[col.id]
      const val = rawVal != null ? String(rawVal) : ''
      if (isRequiredForRow(col, row) && !val) {
        issues.push({ level: 'error', sku, field: col.id, msg: `${col.label} is required` })
      } else if (col.maxUtf8ByteLength && val) {
        // P2.3 — Amazon enforces UTF-8 byte limits (accented chars = 2+ bytes).
        const bytes = enc.encode(val).length
        if (bytes > col.maxUtf8ByteLength) {
          issues.push({ level: 'error', sku, field: col.id, msg: `Exceeds ${col.maxUtf8ByteLength}-byte Amazon limit (${bytes} bytes; accented chars count as 2+)` })
        }
      } else if (col.maxLength && val.length > col.maxLength) {
        issues.push({ level: 'error', sku, field: col.id, msg: `Exceeds max ${col.maxLength} chars (${val.length})` })
      } else if (col.options?.length && val && !col.options.includes(val)) {
        issues.push({ level: 'warn', sku, field: col.id, msg: `"${val}" is not a valid option` })
      }
    }
  }

  // P2.1 / P3.1 — feed-error + listing-issue field highlighting.
  for (const row of rows) {
    if (row._ghost) continue
    const sku = skuOf(row)
    if (row._status === 'error' && Array.isArray(row._errorFields)) {
      const feedMsg = String(row._feedMessage ?? 'Amazon rejected this field')
      for (const fieldId of row._errorFields as string[]) {
        issues.push({ level: 'error', sku, field: fieldId, msg: feedMsg })
      }
    }
    if (Array.isArray(row._issueFields) && (row._issueFields as string[]).length) {
      const sev = row._issueSeverity ? String(row._issueSeverity) : 'WARNING'
      const level: 'error' | 'warn' = sev === 'ERROR' ? 'error' : 'warn'
      for (const fieldId of row._issueFields as string[]) {
        issues.push({ level, sku, field: fieldId, msg: `Amazon listing issue: ${sev.toLowerCase()} on this attribute` })
      }
    }
  }

  // P4.1 — orphaned child detection.
  const parentSkus = new Set<string>()
  for (const r of rows) {
    if (!r._ghost && r.parentage_level === 'parent' && r.item_sku) parentSkus.add(String(r.item_sku))
  }
  for (const row of rows) {
    if (row._ghost || row.parentage_level !== 'child') continue
    const ps = String(row.parent_sku ?? '').trim()
    if (!ps || parentSkus.has(ps)) continue
    issues.push({ level: 'error', sku: skuOf(row), field: 'parent_sku', msg: `No parent row with SKU "${ps}" found — add a parent row or fix the parent SKU` })
  }

  // BN.4.3 — advisories (never blocked submit; display-only warnings).
  for (const pSku of mixedTypeFamilies(rows as Array<Record<string, unknown>>)) {
    issues.push({ level: 'warn', sku: pSku, field: PRODUCT_TYPE_KEY, msg: 'Advisory: mixed product types in this variation family — Amazon may reject it' })
  }
  const missingIds = new Set(rowsMissingNode(rows as Array<Record<string, unknown>>))
  if (missingIds.size) {
    for (const row of rows) {
      if (missingIds.has(String(row._rowId))) {
        issues.push({ level: 'warn', sku: skuOf(row), field: BROWSE_NODE_KEY, msg: 'Advisory: no browse node — Amazon will use the category root (lower discoverability)' })
      }
    }
  }

  return issues
}

// ── Family group key (grid getGroupKey) ────────────────────────────────────
// Parent → its own SKU (children with parent_sku=that SKU join the family);
// child → parent_sku; standalone → own row id.
export function amazonGroupKey(row: BaseRow): string {
  const parentage = String(row.parentage_level ?? '').toLowerCase()
  if (parentage === 'parent') return String(row.item_sku ?? '').trim() || String(row._rowId)
  if (parentage === 'child') {
    const ps = String(row.parent_sku ?? '').trim()
    return ps || String(row._rowId)
  }
  return String(row._rowId)
}

// ── FBA/FBM bucket (grid bucketMode) ───────────────────────────────────────
// A parent follows its FBA children (any FBA child → the family sits in FBA);
// every other row buckets by its own fulfillment channel / _FBM suffix.
// The parent-has-FBA lookup is cached per rows-array identity so bucketFor
// stays O(1) per row inside the grid's display memo.

function bucketOfRow(row: BaseRow): 'FBA' | 'FBM' {
  const sku = String(row.item_sku ?? '')
  if (/_fbm$/i.test(sku)) return 'FBM'
  return isFbaRow(row) ? 'FBA' : 'FBM'
}

const parentHasFbaCache = new WeakMap<object, Set<string>>()

export function fbaBucketFor(row: BaseRow, rows: BaseRow[]): 'FBA' | 'FBM' {
  if (String(row.parentage_level ?? '') !== 'parent') return bucketOfRow(row)
  let parentHasFba = parentHasFbaCache.get(rows)
  if (!parentHasFba) {
    parentHasFba = new Set<string>()
    for (const r of rows) {
      if (String(r.parentage_level ?? '') === 'child' && bucketOfRow(r) === 'FBA') {
        parentHasFba.add(String(r.parent_sku ?? ''))
      }
    }
    parentHasFbaCache.set(rows, parentHasFba)
  }
  return parentHasFba.has(String(row.item_sku ?? '')) ? 'FBA' : 'FBM'
}

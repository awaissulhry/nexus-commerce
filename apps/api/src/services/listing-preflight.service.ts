/**
 * A5 — schema-driven pre-flight validation for Amazon flat-file rows.
 *
 * Catches the things Amazon rejects AFTER a feed round-trip — missing required
 * attributes (90220) and invalid product identifiers — BEFORE submit, as a
 * per-row checklist. Warn-only: it surfaces issues, it doesn't block a deliberate
 * submit. The required-attribute set is the live schema's (manifest `required`
 * columns), so it's accurate per market + product type, not a hardcoded guess.
 */

export type PreflightSeverity = 'error' | 'warning'
export interface PreflightIssue {
  field: string
  severity: PreflightSeverity
  message: string
}
export interface RequiredColumn {
  id: string
  label: string
}

/**
 * Validate a GTIN/UPC/EAN by its mod-10 check digit (GTIN-8/12/13/14). The
 * thing that was silently missing — a bad barcode is a top Amazon suppression
 * cause. Returns { valid, reason } so the caller can explain the failure.
 */
export function validateGtin(raw: string | null | undefined): { valid: boolean; reason?: string } {
  if (raw == null) return { valid: false, reason: 'missing' }
  const s = String(raw).trim().replace(/[\s-]/g, '')
  if (s === '') return { valid: false, reason: 'missing' }
  if (!/^\d+$/.test(s)) return { valid: false, reason: 'not numeric' }
  if (![8, 12, 13, 14].includes(s.length)) return { valid: false, reason: `length ${s.length} (must be 8, 12, 13 or 14 digits)` }
  const digits = s.split('').map(Number)
  const check = digits.pop() as number
  let sum = 0
  // Weight the remaining digits 3,1,3,1,… starting from the rightmost.
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
    sum += digits[i] * w
  }
  const expected = (10 - (sum % 10)) % 10
  return expected === check ? { valid: true } : { valid: false, reason: 'check digit mismatch' }
}

const isBlank = (v: unknown): boolean => v == null || String(v).trim() === ''

/** Required columns (from the live schema manifest) that are blank in the row. */
export function findMissingRequired(row: Record<string, any>, requiredColumns: RequiredColumn[]): RequiredColumn[] {
  return requiredColumns.filter((c) => isBlank(row[c.id]))
}

/**
 * UTF-8 byte length of a string — what Amazon's `maxUtf8ByteLength` measures.
 * An ASCII char is 1 byte; accented Latin (à, è, ñ, ü) is 2; many CJK/emoji are
 * 3–4. A title within its char limit can still blow the byte limit, which Amazon
 * rejects at submit — so byte-length is the constraint we must count.
 */
export function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/** A manifest column carrying length constraints, for pre-submit length checks. */
export interface LengthColumn {
  id: string
  label: string
  maxLength?: number
  maxUtf8ByteLength?: number
}

/**
 * Pre-submit length validation against the live schema's caps. Byte limit wins
 * when present (Amazon's real constraint); falls back to char limit otherwise.
 * Blank values are skipped (required-ness is a separate check). Pure + testable.
 */
export function checkLengthLimits(row: Record<string, any>, lengthColumns: LengthColumn[]): PreflightIssue[] {
  const issues: PreflightIssue[] = []
  for (const c of lengthColumns) {
    const raw = row[c.id]
    if (isBlank(raw)) continue
    const s = String(raw)
    if (typeof c.maxUtf8ByteLength === 'number') {
      const bytes = utf8ByteLength(s)
      if (bytes > c.maxUtf8ByteLength) {
        issues.push({
          field: c.id,
          severity: 'error',
          message: `"${c.label}" is ${bytes} bytes — exceeds Amazon's ${c.maxUtf8ByteLength}-byte limit (UTF-8; accented characters count as 2+ bytes)`,
        })
        continue // one length error per field is enough
      }
    }
    if (typeof c.maxLength === 'number' && s.length > c.maxLength) {
      issues.push({
        field: c.id,
        severity: 'error',
        message: `"${c.label}" is ${s.length} characters — exceeds the ${c.maxLength}-character limit`,
      })
    }
  }
  return issues
}

// Common flat-file columns that may carry a product identifier.
const GTIN_FIELDS = ['externally_assigned_product_identifier', 'gtin', 'ean', 'upc', 'barcode']

/**
 * Full per-row pre-flight: missing required attributes (error), invalid GTIN if
 * one is present (error), and a missing main image (warning). Pure — easy to test
 * and reuse from the /preflight endpoint and inside /submit.
 */
export function preflightRow(
  row: Record<string, any>,
  requiredColumns: RequiredColumn[],
  lengthColumns: LengthColumn[] = [],
): PreflightIssue[] {
  // FFP.2 — a DELETE feed message is `{sku, operationType: DELETE}` with NO
  // attributes, so there is nothing to validate. Requiring the full attribute
  // set to delete a listing was pure friction.
  if (String(row.record_action ?? '').toLowerCase() === 'delete') return []

  const issues: PreflightIssue[] = []

  for (const m of findMissingRequired(row, requiredColumns)) {
    issues.push({ field: m.id, severity: 'error', message: `Required attribute "${m.label}" is empty` })
  }

  // Byte/char length caps from the live schema (UTF-8 byte limit wins). Optional
  // param keeps existing callers unchanged; they simply skip length checks.
  issues.push(...checkLengthLimits(row, lengthColumns))

  for (const f of GTIN_FIELDS) {
    const val = row[f]
    if (!isBlank(val)) {
      const g = validateGtin(val)
      if (!g.valid) issues.push({ field: f, severity: 'error', message: `Invalid product identifier "${val}" (${g.reason})` })
      break // one identifier is enough
    }
  }

  if (isBlank(row.main_product_image_locator)) {
    issues.push({ field: 'main_product_image_locator', severity: 'warning', message: 'No main product image' })
  }

  // FFP.18 — GTIN-exempt guidance. A NEW listing with no product identifier
  // must carry supplier_declared_has_product_identifier_exemption=true, or
  // Amazon demands merchant_suggested_asin / externally_assigned_product_identifier
  // (90220). Warning only — the operator may know better.
  if (row._isNew === true) {
    const hasId = GTIN_FIELDS.some((f) => !isBlank(row[f]))
      || !isBlank(row.external_product_id)
      || !isBlank(row.merchant_suggested_asin)
    const exemptionRaw = String(row.supplier_declared_has_product_identifier_exemption ?? '').trim().toLowerCase()
    const hasExemption = ['true', '1', 'sì', 'si', 'yes'].includes(exemptionRaw)
    if (!hasId && !hasExemption) {
      issues.push({
        field: 'supplier_declared_has_product_identifier_exemption',
        severity: 'warning',
        message: 'New listing without a product identifier — fill external_product_id (EAN/ASIN) or set supplier_declared_has_product_identifier_exemption = Sì (GTIN exemption); otherwise Amazon requires merchant_suggested_asin / externally_assigned_product_identifier',
      })
    }
  }

  // G.1 — parent/child structural integrity (Amazon variation model). A parent
  // groups its children by an axis; a child must name its parent. Catch these
  // here so a malformed family is blocked before the feed, not rejected by Amazon.
  const parentage = String(row.parentage_level ?? '').toLowerCase()
  if (parentage === 'parent' && isBlank(row.variation_theme)) {
    issues.push({ field: 'variation_theme', severity: 'error', message: 'Parent listing needs a variation theme (e.g. SizeName, ColorName)' })
  }
  if (parentage === 'child' && isBlank(row.parent_sku)) {
    issues.push({ field: 'parent_sku', severity: 'error', message: 'Variant needs a parent_sku linking it to its parent' })
  }

  return issues
}

/**
 * G.1 — batch parent/child integrity: a child's parent_sku must point to a parent
 * present in the SAME submission. Per-row preflight can't see siblings, so this
 * runs once over the whole batch and returns issues keyed by item_sku. eBay-parity
 * with the orphan-variant check in the eBay flat file.
 */
export function validateParentChildBatch(
  rows: Array<Record<string, any>>,
): Array<{ itemSku: string; issue: PreflightIssue }> {
  const out: Array<{ itemSku: string; issue: PreflightIssue }> = []
  const parentSkus = new Set<string>()
  for (const r of rows) {
    if (String(r.parentage_level ?? '').toLowerCase() === 'parent') {
      const s = String(r.item_sku ?? '').trim()
      if (s) parentSkus.add(s)
    }
  }
  for (const r of rows) {
    if (String(r.parentage_level ?? '').toLowerCase() !== 'child') continue
    // FFP.2 — deleting a child alone is legal; the delete message carries no
    // parentage, so don't demand its parent in the same submission.
    if (String(r.record_action ?? '').toLowerCase() === 'delete') continue
    const parent = String(r.parent_sku ?? '').trim()
    if (parent && !parentSkus.has(parent)) {
      out.push({
        itemSku: String(r.item_sku ?? ''),
        issue: { field: 'parent_sku', severity: 'error', message: `Parent "${parent}" isn't in this submission — add the parent row or fix parent_sku` },
      })
    }
  }
  return out
}

/** Minimal shape of a (union) manifest column needed for per-type validation. */
interface UnionManifestLike {
  productTypes?: string[]
  groups: Array<{
    columns?: Array<{
      id: string
      labelEn?: string
      applicableProductTypes?: string[]
      requiredForProductTypes?: string[]
      maxLength?: number
      maxUtf8ByteLength?: number
    }>
  }>
}

export interface PerTypeValidation {
  /** Required columns for each product type (validate each row against its own). */
  requiredByType: Map<string, RequiredColumn[]>
  /** Column ids that APPLY to each product type (compliance fill / cell relevance). */
  applicableByType: Map<string, Set<string>>
  /** Columns with a byte/char cap for each product type (length pre-validation). */
  lengthByType: Map<string, LengthColumn[]>
}

/**
 * MT.2 — from a UNION manifest (MT.1), derive per-product-type required + applicable
 * column sets so a mixed-category sheet validates each row against ITS OWN product
 * type (a Pants row isn't flagged for a Jacket-only required field, and vice versa).
 * A column with no applicableProductTypes (legacy single-type manifest) applies to
 * every type. Pure + testable.
 */
export function buildPerTypeValidation(union: UnionManifestLike): PerTypeValidation {
  const types = union.productTypes ?? []
  const cols = union.groups.flatMap((g) => g.columns ?? [])
  const requiredByType = new Map<string, RequiredColumn[]>()
  const applicableByType = new Map<string, Set<string>>()
  const lengthByType = new Map<string, LengthColumn[]>()
  for (const t of types) {
    requiredByType.set(
      t,
      cols.filter((c) => (c.requiredForProductTypes ?? []).includes(t)).map((c) => ({ id: String(c.id), label: String(c.labelEn ?? c.id) })),
    )
    applicableByType.set(
      t,
      new Set(cols.filter((c) => !c.applicableProductTypes || c.applicableProductTypes.includes(t)).map((c) => String(c.id))),
    )
    // Length caps for columns that apply to this type AND declare a byte/char limit.
    lengthByType.set(
      t,
      cols
        .filter((c) => (!c.applicableProductTypes || c.applicableProductTypes.includes(t)) &&
          (typeof c.maxUtf8ByteLength === 'number' || typeof c.maxLength === 'number'))
        .map((c) => ({ id: String(c.id), label: String(c.labelEn ?? c.id), maxLength: c.maxLength, maxUtf8ByteLength: c.maxUtf8ByteLength })),
    )
  }
  return { requiredByType, applicableByType, lengthByType }
}

/**
 * FX.6 — pre-flight a batch of import rows before they're applied to the grid.
 * Each row is validated against the required set for ITS OWN product_type (MT.2
 * requiredByType), falling back to a shared set for a single-type sheet / a row
 * with no/unknown type. Returns only rows that have issues (missing required,
 * invalid GTIN, missing image). Pure + testable.
 */
export function validateImportRows(
  rows: Record<string, any>[],
  requiredByType: Map<string, RequiredColumn[]>,
  fallbackRequired: RequiredColumn[],
  matchKey = 'item_sku',
  lengthByType?: Map<string, LengthColumn[]>,
): Array<{ rowIndex: number; sku: string; issues: PreflightIssue[] }> {
  const out: Array<{ rowIndex: number; sku: string; issues: PreflightIssue[] }> = []
  rows.forEach((row, rowIndex) => {
    const type = String(row.product_type ?? '').toUpperCase()
    const required = requiredByType.get(type) ?? fallbackRequired
    const issues = preflightRow(row, required, lengthByType?.get(type) ?? [])
    if (issues.length) out.push({ rowIndex, sku: String(row[matchKey] ?? ''), issues })
  })
  return out
}

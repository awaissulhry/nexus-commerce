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

// Common flat-file columns that may carry a product identifier.
const GTIN_FIELDS = ['externally_assigned_product_identifier', 'gtin', 'ean', 'upc', 'barcode']

/**
 * Full per-row pre-flight: missing required attributes (error), invalid GTIN if
 * one is present (error), and a missing main image (warning). Pure — easy to test
 * and reuse from the /preflight endpoint and inside /submit.
 */
export function preflightRow(row: Record<string, any>, requiredColumns: RequiredColumn[]): PreflightIssue[] {
  const issues: PreflightIssue[] = []

  for (const m of findMissingRequired(row, requiredColumns)) {
    issues.push({ field: m.id, severity: 'error', message: `Required attribute "${m.label}" is empty` })
  }

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

  return issues
}

/** Minimal shape of a (union) manifest column needed for per-type validation. */
interface UnionManifestLike {
  productTypes?: string[]
  groups: Array<{
    columns?: Array<{ id: string; labelEn?: string; applicableProductTypes?: string[]; requiredForProductTypes?: string[] }>
  }>
}

export interface PerTypeValidation {
  /** Required columns for each product type (validate each row against its own). */
  requiredByType: Map<string, RequiredColumn[]>
  /** Column ids that APPLY to each product type (compliance fill / cell relevance). */
  applicableByType: Map<string, Set<string>>
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
  for (const t of types) {
    requiredByType.set(
      t,
      cols.filter((c) => (c.requiredForProductTypes ?? []).includes(t)).map((c) => ({ id: String(c.id), label: String(c.labelEn ?? c.id) })),
    )
    applicableByType.set(
      t,
      new Set(cols.filter((c) => !c.applicableProductTypes || c.applicableProductTypes.includes(t)).map((c) => String(c.id))),
    )
  }
  return { requiredByType, applicableByType }
}

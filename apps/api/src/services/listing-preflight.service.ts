/**
 * A5 — schema-driven pre-flight validation for Amazon flat-file rows.
 *
 * Catches the things Amazon rejects AFTER a feed round-trip — missing required
 * attributes (90220) and invalid product identifiers — BEFORE submit, as a
 * per-row checklist. Warn-only: it surfaces issues, it doesn't block a deliberate
 * submit. The required-attribute set is the live schema's (manifest `required`
 * columns), so it's accurate per market + product type, not a hardcoded guess.
 */

import { conditionalRequiredErrors } from './listing-wizard/conditional-requirements.js'

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

/** UFX P1 (MT.2b) — an enum column with its accepted value set for ONE product type. */
export interface EnumColumn {
  id: string
  label: string
  /** Accepted values: schema option labels + underlying codes (rows carry either). */
  values: string[]
  /** Closed list (Amazon SELECTION_ONLY) → out-of-set is an error; open → warning. */
  selectionOnly?: boolean
}

/** UFX P1 (P0-1a) — "required-if-present" sub-columns of one expanded attribute. */
export interface SubRequiredGroup {
  /** Base attribute id (e.g. item_package_dimensions). */
  base: string
  /** Human label for the base attribute (for the error message). */
  baseLabel: string
  /** Every sub-column id of the attribute present on the sheet. */
  memberIds: string[]
  /** Sub-columns that must be filled once ANY member of the group is filled. */
  required: RequiredColumn[]
}

/** UFX P1 — optional extra checks for preflightRow (all default off → callers unchanged). */
export interface PreflightExtras {
  /** Enum validation for this row's product type (MT.2b). */
  enumColumns?: EnumColumn[]
  /** Required-if-present enforcement for optional parents' required sub-props (P0-1a). */
  subRequiredGroups?: SubRequiredGroup[]
  /** Conditional-requirement evaluation (allOf/if/then, dependentRequired) (P0-1b). */
  conditional?: {
    /** The product type's raw JSON schema definition. */
    schema: any
    /** Expanded column id → base field path, to backfill base-attribute values. */
    expandedFields?: Record<string, string>
    /** Column id → display label for messages. */
    labelOf?: (fieldId: string) => string
  }
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

/**
 * UFX P1 (MT.2b) — validate enum cells against the schema's accepted set for
 * THIS row's product type. Rows can carry the display LABEL (grid dropdown) or
 * the underlying CODE (attrs/snapshot read-backs), so both are accepted, labels
 * case-insensitively. Closed lists (SELECTION_ONLY) error; open enums warn.
 * Pure + testable.
 */
export function checkEnumValues(row: Record<string, any>, enumColumns: EnumColumn[]): PreflightIssue[] {
  const issues: PreflightIssue[] = []
  for (const c of enumColumns) {
    const raw = row[c.id]
    if (isBlank(raw)) continue
    const s = String(raw).trim()
    const sLc = s.toLowerCase()
    const ok = c.values.some((v) => v === s || v.toLowerCase() === sLc)
    if (!ok) {
      issues.push({
        field: c.id,
        severity: c.selectionOnly ? 'error' : 'warning',
        message: `"${c.label}" value "${s}" isn't an accepted option for this product type`,
      })
    }
  }
  return issues
}

/**
 * UFX P1 (P0-1a) — "required-if-present": an OPTIONAL attribute whose schema
 * marks sub-properties required (a value+unit pair's unit, dimensions'
 * length/width/height…) demands those subs as soon as ANY of its sub-columns
 * is filled — a half-filled attribute is exactly the "grid says filled, Amazon
 * says 90220" failure. Untouched attributes stay untouched. Pure + testable.
 */
export function checkRequiredWithParent(row: Record<string, any>, groups: SubRequiredGroup[]): PreflightIssue[] {
  const issues: PreflightIssue[] = []
  for (const g of groups) {
    if (!g.memberIds.some((id) => !isBlank(row[id]))) continue
    for (const r of g.required) {
      if (isBlank(row[r.id])) {
        issues.push({
          field: r.id,
          severity: 'error',
          message: `"${r.label}" is required when any "${g.baseLabel}" value is filled`,
        })
      }
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
  extras: PreflightExtras = {},
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

  // UFX P1 (MT.2b) — enum cells validated against THIS row type's accepted set.
  if (extras.enumColumns?.length) {
    issues.push(...checkEnumValues(row, extras.enumColumns))
  }

  // UFX P1 (P0-1a) — required-if-present sub-properties of optional attributes.
  if (extras.subRequiredGroups?.length) {
    issues.push(...checkRequiredWithParent(row, extras.subRequiredGroups))
  }

  // UFX P1 (P0-1b) — conditional requireds (allOf/if/then, dependentRequired),
  // evaluated per row against the raw schema. Conservative by construction: the
  // evaluator emits nothing for a rule it can't fully evaluate from row data.
  if (extras.conditional?.schema) {
    const { schema, expandedFields = {}, labelOf } = extras.conditional
    // The schema names BASE attributes; the row carries expanded column ids
    // (bullet_point_1, apparel_size__size…). Backfill each base with its first
    // filled expansion so presence conditions see the truth.
    const values: Record<string, unknown> = { ...row }
    for (const [colId, path] of Object.entries(expandedFields)) {
      const base = path.split('.')[0]
      const v = row[colId]
      if (v != null && String(v).trim() !== '' && (values[base] == null || String(values[base]).trim() === '')) {
        values[base] = v
      }
    }
    // The grid's parent_sku column IS the schema's child_parent_sku_relationship.
    if (values['child_parent_sku_relationship'] == null || String(values['child_parent_sku_relationship']).trim() === '') {
      values['child_parent_sku_relationship'] = row.parent_sku
    }
    const flagged = new Set(issues.map((i) => i.field))
    for (const ci of conditionalRequiredErrors(schema, values, labelOf)) {
      // Report on the grid's column where the schema field has a different face.
      const field = ci.field === 'child_parent_sku_relationship' ? 'parent_sku' : ci.field
      if (flagged.has(field)) continue // already flagged (e.g. G.1 structural checks)
      flagged.add(field)
      issues.push({ ...ci, field })
    }
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
      // UFX P1 — enum + required-if-present metadata (see FlatFileColumn).
      kind?: string
      options?: string[]
      optionCodes?: string[]
      optionLabels?: Record<string, string>
      optionsByProductType?: Record<string, string[]>
      optionCodesByProductType?: Record<string, string[]>
      selectionOnly?: boolean
      requiredWithParent?: boolean
      requiredWithParentForProductTypes?: string[]
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
  /** UFX P1 (MT.2b) — enum columns + their accepted value set per product type. */
  enumByType: Map<string, EnumColumn[]>
  /** UFX P1 (P0-1a) — required-if-present sub-column groups per product type. */
  subGroupsByType: Map<string, SubRequiredGroup[]>
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
  const enumByType = new Map<string, EnumColumn[]>()
  const subGroupsByType = new Map<string, SubRequiredGroup[]>()
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
    // UFX P1 (MT.2b) — per-type enum value sets. A type's OWN option list wins
    // over the union superset (that's the whole point: valid-for-JACKET must
    // still fail on a PANTS row). Accepted values = labels + codes (+ localized
    // optionLabels), since rows carry any of those. Boolean-ish option lists
    // (true/false) are skipped — rows may carry localized truthy labels and the
    // feed builder coerces those separately. variation_theme is skipped too:
    // rows carry every historical spelling ("SizeName-ColorName", "Taglia/
    // Colore") which the feed builder normalizes to the approved enum (FFP.19),
    // so validating the raw cell would flag rows that submit fine.
    enumByType.set(
      t,
      cols
        .filter((c) => c.kind === 'enum' && c.id !== 'variation_theme' && (!c.applicableProductTypes || c.applicableProductTypes.includes(t)))
        .map((c): EnumColumn | null => {
          const labels = (c.optionsByProductType?.[t] ?? c.options ?? []).filter((o) => o !== '')
          const codes = c.optionCodesByProductType?.[t] ?? c.optionCodes ?? []
          const localized = c.optionLabels ? Object.values(c.optionLabels) : []
          const values = [...new Set([...labels, ...codes, ...localized])]
          if (values.length === 0) return null
          const nonBool = values.filter((v) => v !== 'true' && v !== 'false')
          if (nonBool.length === 0) return null // boolean-ish enum → skip
          return { id: String(c.id), label: String(c.labelEn ?? c.id), values, selectionOnly: c.selectionOnly }
        })
        .filter((c): c is EnumColumn => c !== null),
    )
    // UFX P1 (P0-1a) — required-if-present groups: sub-columns (base__sub ids)
    // grouped by base attribute; a group only exists when at least one sub is
    // flagged requiredWithParent for this type.
    const groups = new Map<string, SubRequiredGroup>()
    for (const c of cols) {
      const id = String(c.id)
      if (!id.includes('__')) continue
      if (c.applicableProductTypes && !c.applicableProductTypes.includes(t)) continue
      const base = id.split('__')[0]
      let g = groups.get(base)
      if (!g) {
        g = { base, baseLabel: base.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()), memberIds: [], required: [] }
        groups.set(base, g)
      }
      g.memberIds.push(id)
      const rwp = c.requiredWithParentForProductTypes
        ? c.requiredWithParentForProductTypes.includes(t)
        : !!c.requiredWithParent
      if (rwp) g.required.push({ id, label: String(c.labelEn ?? id) })
    }
    subGroupsByType.set(t, [...groups.values()].filter((g) => g.required.length > 0))
  }
  return { requiredByType, applicableByType, lengthByType, enumByType, subGroupsByType }
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

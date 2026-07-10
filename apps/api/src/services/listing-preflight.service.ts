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
  /** UFX P6f — GPSR/DSA product-safety warnings for EU marketplaces (warn-only). */
  gpsr?: GpsrCheckContext
  /**
   * UFX P6g — the row's product type's `requirementsEnforced` (from the
   * manifest / getDefinitionsProductType). When 'NOT_ENFORCED' and the row is
   * a PARTIAL_UPDATE (not _isNew, record_action not 'full_update'), Amazon
   * does not demand the full required-attribute set — so missing-required
   * issues are downgraded to warnings instead of errors. Absent/'ENFORCED' →
   * unchanged (conservative default for schemas cached before the capture).
   */
  requirementsEnforced?: string
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

/**
 * UFX P6b — warn when an EXISTING listing's row CHANGES an attribute the
 * schema marks `editable: false` (brand, condition_type, externally-assigned
 * identifier…): Amazon ignores or rejects the modification on a live listing.
 *
 * Change detection = diff against the last-saved flatFileSnapshot (the grid
 * autosaves to localStorage only, so the server snapshot moves on explicit
 * Save/Submit — a differing value IS an edit made since then). Deliberately
 * conservative, warnings only where a change is certain:
 *   - new rows (_isNew) are skipped — everything is settable at creation;
 *   - no snapshot → no diff possible → no warning (tag-only);
 *   - snapshot value blank → skipped (first-time fill may be accepted);
 *   - full UPDATE resubmits everything, so present-but-UNCHANGED values are
 *     normal and never flagged.
 * Pure + testable; the caller batches the snapshot fetch.
 */
export function checkNonEditableChanges(
  row: Record<string, any>,
  nonEditableColumns: RequiredColumn[],
  snapshot: Record<string, unknown> | null | undefined,
): PreflightIssue[] {
  if (row._isNew === true || !snapshot || nonEditableColumns.length === 0) return []
  if (String(row.record_action ?? '').toLowerCase() === 'delete') return []
  const issues: PreflightIssue[] = []
  for (const c of nonEditableColumns) {
    const prev = snapshot[c.id]
    const cur = row[c.id]
    if (isBlank(prev) || isBlank(cur)) continue
    if (String(prev).trim() === String(cur).trim()) continue
    issues.push({
      field: c.id,
      severity: 'warning',
      message: `"${c.label}" cannot be changed on an existing listing (Amazon locks it after creation) — the new value will likely be ignored or rejected. Revert to "${String(prev).trim()}" or request the change via Seller Support.`,
    })
  }
  return issues
}

// ── UFX P6f — GPSR product-safety warnings (EU marketplaces, warn-only) ──────
//
// GPSR enforcement is live (2024-12-13): missing manufacturer/Responsible-Person
// contact or safety documentation gets a listing SUPPRESSED on EU marketplaces.
// No operator data exists in the system yet, so every check is WARNING severity —
// nothing here may block a submit. Field spellings verified against the live
// cached IT schemas (all 72 active defs carry gpsr_safety_attestation /
// gpsr_manufacturer_reference / dsa_responsible_party_address / compliance_media).

/** The EU marketplaces where Amazon enforces GPSR. */
export const GPSR_EU_MARKETPLACES = new Set(['ES', 'FR', 'BE', 'NL', 'DE', 'IT', 'SE', 'PL'])

/** Official marketplace language(s) — compliance_media.content_language must match. */
export const GPSR_MARKETPLACE_LANGUAGES: Record<string, string[]> = {
  IT: ['it_IT'],
  DE: ['de_DE'],
  FR: ['fr_FR'],
  ES: ['es_ES'],
  NL: ['nl_NL'],
  SE: ['sv_SE'],
  PL: ['pl_PL'],
  BE: ['fr_BE', 'nl_BE'], // both official Amazon.com.be languages
}

/** Context for checkGpsrCompliance — everything schema/route-derived. */
export interface GpsrCheckContext {
  /** Target marketplace of the batch (route context). Non-EU → no checks. */
  marketplace: string
  /** Column ids applicable to this row's product type (applicableByType). A
   *  check only runs when its fields exist on the type; absent set → run all
   *  (every live schema carries the GPSR attributes). */
  applicableColumns?: Set<string>
  /** Accepted compliance_media.content_type values (the schema enum). */
  contentTypeValues?: string[]
  /** True when the submit-time compliance auto-fill can populate the GPSR
   *  contacts (Brand Settings responsible-person email) — suppresses the
   *  missing-contact warning for a row the fill will cover. */
  contactAutoFill?: boolean
}

// Schema says both contact fields accept "e-mail o URL" — accept either shape.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const URL_ISH_RE = /^(https?:\/\/|www\.)\S+$/i
const looksLikeContact = (s: string) => EMAIL_RE.test(s) || URL_ISH_RE.test(s)

const GPSR_TRUTHY = new Set(['true', '1', 'sì', 'si', 'yes'])

/**
 * UFX P6f — GPSR/DSA validation for one row, warnings only:
 *  (a) both manufacturer reference AND Responsible-Person contact blank;
 *  (b) safety attestation vs compliance media consistency (attest XOR attach);
 *  (c) compliance_media integrity: https + pdf/jpg/jpeg/png source, content_type
 *      in the schema enum, content_language matching the marketplace language;
 *      plus an email/URL format check on the contact fields.
 * Only fields the row's product type actually has are evaluated. Pure + testable.
 */
export function checkGpsrCompliance(row: Record<string, any>, ctx: GpsrCheckContext): PreflightIssue[] {
  const mk = String(ctx.marketplace || '').toUpperCase()
  if (!GPSR_EU_MARKETPLACES.has(mk)) return []
  if (String(row.record_action ?? '').toLowerCase() === 'delete') return []

  const has = (col: string) => !ctx.applicableColumns || ctx.applicableColumns.has(col)
  const val = (col: string): string => (isBlank(row[col]) ? '' : String(row[col]).trim())

  const MFG = 'gpsr_manufacturer_reference'
  const RP = 'dsa_responsible_party_address'
  const ATT = 'gpsr_safety_attestation'
  const SDS = 'safety_data_sheet_url'
  const CM_TYPE = 'compliance_media__content_type'
  const CM_SRC = 'compliance_media__source_location'
  const CM_LANG = 'compliance_media__content_language'

  const issues: PreflightIssue[] = []

  // (a) registered manufacturer / Responsible Person contact.
  if (has(MFG) || has(RP)) {
    const mfg = has(MFG) ? val(MFG) : ''
    const rp = has(RP) ? val(RP) : ''
    if (!mfg && !rp && !ctx.contactAutoFill) {
      issues.push({
        field: has(MFG) ? MFG : RP,
        severity: 'warning',
        message: 'GPSR: registered manufacturer/Responsible Person email missing — listing can be suppressed on EU marketplaces',
      })
    }
    // Email/URL shape on whichever contact fields are filled (schema accepts either).
    for (const [col, v] of [[MFG, mfg], [RP, rp]] as const) {
      if (v && !looksLikeContact(v)) {
        issues.push({
          field: col,
          severity: 'warning',
          message: `GPSR: "${v}" doesn't look like an email address or URL — Amazon expects the contact registered in Seller Central`,
        })
      }
    }
  }

  // (b) attestation XOR safety documentation.
  const attTruthy = has(ATT) && GPSR_TRUTHY.has(val(ATT).toLowerCase())
  const cmCols = [CM_TYPE, CM_SRC, CM_LANG].filter(has)
  const cmPresent = cmCols.some((c) => val(c) !== '')
  const sdsPresent = has(SDS) && val(SDS) !== ''
  if (attTruthy && cmPresent) {
    issues.push({
      field: ATT,
      severity: 'warning',
      message: 'GPSR: safety attestation says no safety documentation is needed, but compliance media is attached — mutually inconsistent; clear one of the two',
    })
  }
  if (has(ATT) && !attTruthy && !cmPresent && !sdsPresent) {
    issues.push({
      field: ATT,
      severity: 'warning',
      message: 'GPSR: no safety documentation — either set the safety attestation to Sì (product needs no warnings) or attach compliance media / a safety data sheet URL',
    })
  }

  // (c) compliance_media integrity (only when an entry is present).
  if (cmPresent) {
    const src = has(CM_SRC) ? val(CM_SRC) : ''
    if (src) {
      if (!/^https:\/\//i.test(src)) {
        issues.push({ field: CM_SRC, severity: 'warning', message: 'GPSR: compliance media URL must be a public https:// link' })
      } else if (!/\.(pdf|jpe?g|png)$/i.test(src.split(/[?#]/)[0])) {
        issues.push({ field: CM_SRC, severity: 'warning', message: 'GPSR: compliance media must be a .pdf, .jpg, .jpeg or .png file' })
      }
    }
    const ct = has(CM_TYPE) ? val(CM_TYPE) : ''
    if (ct && ctx.contentTypeValues?.length) {
      const ctLc = ct.toLowerCase()
      if (!ctx.contentTypeValues.some((v) => v === ct || v.toLowerCase() === ctLc)) {
        issues.push({ field: CM_TYPE, severity: 'warning', message: `GPSR: "${ct}" isn't an accepted compliance-media content type for this product type` })
      }
    }
    const lang = has(CM_LANG) ? val(CM_LANG) : ''
    const expected = GPSR_MARKETPLACE_LANGUAGES[mk]
    if (lang && expected && !expected.some((l) => l.toLowerCase() === lang.toLowerCase())) {
      issues.push({
        field: CM_LANG,
        severity: 'warning',
        message: `GPSR: compliance media language "${lang}" doesn't match the ${mk} marketplace language (expected ${expected.join(' or ')})`,
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
  extras: PreflightExtras = {},
): PreflightIssue[] {
  // FFP.2 — a DELETE feed message is `{sku, operationType: DELETE}` with NO
  // attributes, so there is nothing to validate. Requiring the full attribute
  // set to delete a listing was pure friction.
  if (String(row.record_action ?? '').toLowerCase() === 'delete') return []

  const issues: PreflightIssue[] = []

  // UFX P6g — a PARTIAL_UPDATE only patches the attributes it sends, and a
  // NOT_ENFORCED product type doesn't demand the full required set even then —
  // so a blank required cell can't fail THIS submit. Kept visible as a warning
  // (the listing itself may still be suppressed for it); full updates and new
  // rows (operationType UPDATE + requirements) keep the hard error.
  const isPartialUpdate = row._isNew !== true
    && String(row.record_action ?? '').toLowerCase() !== 'full_update'
  const missingRequiredDowngraded = isPartialUpdate && extras.requirementsEnforced === 'NOT_ENFORCED'

  for (const m of findMissingRequired(row, requiredColumns)) {
    issues.push(missingRequiredDowngraded
      ? { field: m.id, severity: 'warning', message: `Required attribute "${m.label}" is empty — accepted for this partial update (Amazon doesn't enforce requirements for this product type), but the live listing may still be flagged for it` }
      : { field: m.id, severity: 'error', message: `Required attribute "${m.label}" is empty` })
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

  // UFX P6f — GPSR EU product-safety warnings. Deduped per field against the
  // earlier checks (checkEnumValues also validates compliance_media__content_type
  // when the manifest carries the enum) so one bad cell yields one issue.
  if (extras.gpsr) {
    const flagged = new Set(issues.map((i) => i.field))
    for (const gi of checkGpsrCompliance(row, extras.gpsr)) {
      if (flagged.has(gi.field)) continue
      flagged.add(gi.field)
      issues.push(gi)
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
      // UFX P6a/b — meta-schema editable flag (see FlatFileColumn).
      editableForListing?: boolean
      nonEditableForProductTypes?: string[]
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
  /** UFX P6b — columns the schema marks non-editable on an existing listing,
   *  per product type (drives the change-detection warning). */
  nonEditableByType: Map<string, RequiredColumn[]>
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
  const nonEditableByType = new Map<string, RequiredColumn[]>()
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
    // UFX P6b — non-editable columns for this type: the per-type list wins when
    // present (union manifest); a plain editableForListing:false (single-type
    // manifest merged over one type) applies wherever the column is applicable.
    nonEditableByType.set(
      t,
      cols
        .filter((c) => (!c.applicableProductTypes || c.applicableProductTypes.includes(t)) &&
          (c.nonEditableForProductTypes ? c.nonEditableForProductTypes.includes(t) : c.editableForListing === false))
        .map((c) => ({ id: String(c.id), label: String(c.labelEn ?? c.id) })),
    )
  }
  return { requiredByType, applicableByType, lengthByType, enumByType, subGroupsByType, nonEditableByType }
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

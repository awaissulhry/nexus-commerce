/**
 * ALA Phase 6 — local schema-aware payload validation.
 *
 * Validates row/payload VALUES against the cached schema's type + enum
 * constraints WITHOUT an SP-API roundtrip: numeric fields must be numbers,
 * boolean fields must be true/false, and enum fields must carry a value Amazon
 * accepts (a label or its wire code). This catches the type/enum class of error
 * that Amazon's VALIDATION_PREVIEW only reports after a submit — making it the
 * fast local gate for the bulk/offline path (where per-SKU preview is
 * impractical) and a complement to it for single SKUs. Pure + testable; reuses
 * the same hints (enumCodeMap / numericFields / booleanFields) the feed builder
 * already derives from the schema.
 */

export interface SchemaPayloadHints {
  /** field id → { displayLabel → wireCode } (both are accepted values). */
  enumCodeMap: Record<string, Record<string, string>>
  numericFields: Set<string>
  booleanFields: Set<string>
  /** expanded column id → base field id (e.g. bullet_point_1 → bullet_point). */
  expandedFields?: Record<string, string>
}

export interface PayloadIssue {
  field: string
  severity: 'error'
  message: string
}

const BOOL_OK = new Set(['true', 'false', 'TRUE', 'FALSE', '1', '0', 'yes', 'no'])

/**
 * Flag values that violate the schema's type/enum constraints. Blank values are
 * skipped (required-ness is a separate check). Returns one issue per offending
 * cell. `labelOf` maps a base field id to a display label.
 */
export function validatePayloadValues(
  row: Record<string, unknown>,
  hints: SchemaPayloadHints,
  labelOf: (id: string) => string = (f) => f,
): PayloadIssue[] {
  const issues: PayloadIssue[] = []
  const expanded = hints.expandedFields ?? {}

  for (const [key, raw] of Object.entries(row)) {
    if (typeof raw !== 'string') continue
    const v = raw.trim()
    if (v === '') continue
    const base = expanded[key] ?? key

    if (hints.numericFields.has(base)) {
      if (!Number.isFinite(Number(v))) {
        issues.push({ field: key, severity: 'error', message: `"${labelOf(base)}" must be a number (got “${v}”)` })
      }
      continue
    }
    if (hints.booleanFields.has(base)) {
      if (!BOOL_OK.has(v)) {
        issues.push({ field: key, severity: 'error', message: `"${labelOf(base)}" must be true or false (got “${v}”)` })
      }
      continue
    }
    const em = hints.enumCodeMap[base]
    if (em) {
      const valid = new Set<string>([...Object.keys(em), ...Object.values(em)])
      if (valid.size > 0 && !valid.has(v)) {
        issues.push({ field: key, severity: 'error', message: `"${labelOf(base)}": “${v}” is not an allowed value` })
      }
    }
  }
  return issues
}

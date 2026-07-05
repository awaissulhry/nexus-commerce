/**
 * FF2.2 — Registry-driven import validation.
 *
 * Pure function — no DB, no side effects. Validates every cell of a
 * ParsedWorkbook against the shared field registry so that the import engine
 * and the export grid can never drift.
 *
 * Header → field resolution rules (evaluated in order):
 *   'Action'                    → validate ∈ ['', 'ADD', 'DELETE', 'IGNORE']
 *   'sku'                       → required non-blank when row Action === 'ADD'
 *   '<base>_follows_master@MKT' → boolean control: must be '', 'true', or 'false'
 *   '<base>@<MKT>'              → strip @MKT suffix → look up base in CHANNEL registry
 *   '<id>'                      → look up in MASTER registry, then CHANNEL as fallback
 *   (no match)                  → warn "unknown column"
 *
 * Per matched FieldDefinition:
 *   readonly (READONLY_SYNCED | DERIVED | SYSTEM) + non-blank → warn (then skip)
 *   value blank or '__CLEAR__'                                 → skip further checks
 *   enum + value ∉ options, strict mode                        → error
 *   enum + value ∉ options, open mode                          → warn
 *   maxLength exceeded                                         → error
 *   maxUtf8ByteLength exceeded                                 → error
 *   boolean kind + value not recognised                        → warn
 */

import type { ParsedWorkbook } from './parse.js'
import { MASTER_FIELDS } from '../registry/master-fields.js'
import { CHANNEL_SHARED_FIELDS, CHANNEL_MARKET_FIELDS } from '../registry/channel-fields.js'
import type { FieldDefinition } from '../registry/types.js'

// ── Public interfaces ──────────────────────────────────────────────────────────

export interface ValidationIssue {
  sheet: string
  rowNumber: number
  column: string
  level: 'error' | 'warn'
  message: string
}

// ── Registry lookup tables ─────────────────────────────────────────────────────

/** MASTER_FIELDS keyed by field id. */
const MASTER_BY_ID = new Map<string, FieldDefinition>()
for (const f of MASTER_FIELDS) {
  MASTER_BY_ID.set(f.id, f)
}

/**
 * CHANNEL_SHARED_FIELDS + CHANNEL_MARKET_FIELDS keyed by field id.
 * First definition wins (shared before market-scoped, matching registry order).
 */
const CHANNEL_BY_ID = new Map<string, FieldDefinition>()
for (const f of [...CHANNEL_SHARED_FIELDS, ...CHANNEL_MARKET_FIELDS]) {
  if (!CHANNEL_BY_ID.has(f.id)) CHANNEL_BY_ID.set(f.id, f)
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Field classes that are read-only on import — ignored with a warning. */
const READONLY_CLS = new Set<string>(['READONLY_SYNCED', 'DERIVED', 'SYSTEM'])

/** Valid values for the Action control column. */
const VALID_ACTIONS = new Set<string>(['', 'ADD', 'DELETE', 'IGNORE'])

/** Module-level TextEncoder — hoisted to avoid per-cell allocation. */
const TEXT_ENCODER = new TextEncoder()

/**
 * Case-insensitive accepted values for boolean fields.
 * Empty string is included so blank passes (blank = no-change sentinel).
 */
const BOOL_VALUES = new Set<string>(['true', 'false', 'yes', 'no', '1', '0', 'y', 'n', 't', 'f', ''])

// ── validateWorkbook ──────────────────────────────────────────────────────────

export function validateWorkbook(wb: ParsedWorkbook): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  for (const [sheetName, sheet] of Object.entries(wb.sheets)) {
    for (const row of sheet.rows) {
      // Determine this row's Action (used for required-field checks below)
      const actionCell = row.cells['Action']
      const action = actionCell ? actionCell.value : ''

      for (const [header, cell] of Object.entries(row.cells)) {
        const value = cell.value

        // ── Special: Action column ────────────────────────────────────────────
        if (header === 'Action') {
          if (!VALID_ACTIONS.has(value)) {
            issues.push({
              sheet: sheetName,
              rowNumber: row.rowNumber,
              column: header,
              level: 'error',
              message: `invalid Action '${value}' — must be ADD, DELETE, IGNORE or blank`,
            })
          }
          continue
        }

        // ── Special: sku column ───────────────────────────────────────────────
        // sku is the row identifier; it is required only when creating (ADD).
        // Blank on a non-ADD row means "don't change the sku" — which is fine.
        if (header === 'sku') {
          if (action === 'ADD' && !value) {
            issues.push({
              sheet: sheetName,
              rowNumber: row.rowNumber,
              column: 'sku',
              level: 'error',
              message: 'missing sku',
            })
          }
          continue
        }

        // ── Special: follows_master control columns ───────────────────────────
        // Pattern: <base>_follows_master@<MKT>
        // These are boolean governance flags that must be '', 'true', or 'false'.
        if (header.indexOf('_follows_master@') !== -1) {
          if (value !== '' && value !== 'true' && value !== 'false') {
            issues.push({
              sheet: sheetName,
              rowNumber: row.rowNumber,
              column: header,
              level: 'error',
              message: `control column '${header}' must be blank, 'true', or 'false'`,
            })
          }
          continue
        }

        // ── Resolve field from registry ───────────────────────────────────────

        // Headers with @MKT suffix → strip suffix; look up in channel registry only.
        // Headers without @MKT      → look up in master registry first, then channel.
        // This disambiguates id collisions (e.g. 'status' exists in both registries
        // with different cls values: EDITABLE in master, READONLY_SYNCED in channel).

        const atIdx = header.indexOf('@')
        let fieldId: string
        let field: FieldDefinition | undefined

        if (atIdx !== -1) {
          fieldId = header.slice(0, atIdx)
          field = CHANNEL_BY_ID.get(fieldId)
        } else {
          fieldId = header
          field = MASTER_BY_ID.get(fieldId)
          if (!field) field = CHANNEL_BY_ID.get(fieldId)
        }

        if (!field) {
          issues.push({
            sheet: sheetName,
            rowNumber: row.rowNumber,
            column: header,
            level: 'warn',
            message: `unknown column '${header}' — ignored`,
          })
          continue
        }

        // ── Readonly check ────────────────────────────────────────────────────
        // READONLY_SYNCED / DERIVED / SYSTEM fields are present for reference only.
        // Any non-blank value is ignored on import; warn the operator.
        if (READONLY_CLS.has(field.cls)) {
          if (value !== '') {
            issues.push({
              sheet: sheetName,
              rowNumber: row.rowNumber,
              column: header,
              level: 'warn',
              message: 'readonly column — ignored on import',
            })
          }
          continue  // no further validation for readonly fields
        }

        // ── Skip blank and __CLEAR__ ──────────────────────────────────────────
        // Blank means "no change" — perfectly valid. '__CLEAR__' is the explicit
        // clear sentinel — valid too. Neither triggers further content checks.
        if (value === '' || value === '__CLEAR__') continue

        // ── Enum validation ───────────────────────────────────────────────────
        if (field.kind === 'enum' && field.enumOptions && field.enumOptions.length > 0) {
          if (!field.enumOptions.includes(value)) {
            if (field.enumMode === 'strict') {
              issues.push({
                sheet: sheetName,
                rowNumber: row.rowNumber,
                column: header,
                level: 'error',
                message: `not an allowed value — must be one of: ${field.enumOptions.join(', ')}`,
              })
            } else {
              issues.push({
                sheet: sheetName,
                rowNumber: row.rowNumber,
                column: header,
                level: 'warn',
                message: `not a listed value — expected one of: ${field.enumOptions.join(', ')}`,
              })
            }
          }
        }

        // ── maxLength (character count) ───────────────────────────────────────
        if (field.maxLength !== undefined && value.length > field.maxLength) {
          issues.push({
            sheet: sheetName,
            rowNumber: row.rowNumber,
            column: header,
            level: 'error',
            message: `exceeds ${field.maxLength} character limit`,
          })
        }

        // ── maxUtf8ByteLength (encoded byte size) ─────────────────────────────
        // Accented / CJK characters are multi-byte in UTF-8. This check catches
        // strings that pass the character-count limit but blow the byte limit.
        if (field.maxUtf8ByteLength !== undefined) {
          const byteLen = TEXT_ENCODER.encode(value).length
          if (byteLen > field.maxUtf8ByteLength) {
            issues.push({
              sheet: sheetName,
              rowNumber: row.rowNumber,
              column: header,
              level: 'error',
              message: `exceeds ${field.maxUtf8ByteLength} UTF-8 bytes`,
            })
          }
        }

        // ── Boolean kind validation ───────────────────────────────────────────
        // Accepted (case-insensitive): true/false/yes/no/1/0/y/n/t/f or blank.
        // Blank is already handled above (skipped). Only non-blank values reach here.
        if (field.kind === 'boolean') {
          if (!BOOL_VALUES.has(value.toLowerCase())) {
            issues.push({
              sheet: sheetName,
              rowNumber: row.rowNumber,
              column: header,
              level: 'warn',
              message: 'boolean field — expected true/false/yes/no/1/0',
            })
          }
        }
      }
    }
  }

  return issues
}

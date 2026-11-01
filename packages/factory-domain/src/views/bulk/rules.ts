import type { Grain } from '../../auth/grains/grains'
import type { Issue } from '../../core/errors'

/**
 * Bulk edit with preview and inline edit in a list (B-W2b-13; PLT-182, PLT-166; design shell.lists pop:bulk-edit "Fields
 * to change (only fields every selected row allows), then ReviewChangesModal with old → new per row and refusals per
 * row", sec:selection-row "Bulk edit → popup bulk-edit → ReviewChangesModal (old → new per row, conflicts) → Done with
 * Undo", sec:grid "Inline edit only for one simple in-house field (planned date, priority, bin), autosaved per cell with
 * CellSaveMark and a version check; paste a range").
 *
 * A list that may be edited this way names its fields (by the web list frame's column ids) with a kind each; the API's
 * bulk target (apps/factory-api platform/views/bulk) reads the rows as they are now, previews each row (old → new, or
 * why not), then writes each row through the record's OWN command with the version the person reviewed. Undo writes
 * each changed row back to its earlier values from the version the change gave it — a row changed again since is a
 * conflict, never overwritten. One cell edited in the grid is the same write with one row and one field.
 *
 * Pure: the API checks an ask and builds the preview with these rules; the web frame shows them with its own words
 * (every refusal is a code, never the API's sentence).
 */

export const BULK_LIMITS = Object.freeze({
  /** Rows one bulk edit reaches (design sec:selection-row: "Limits are held buttons with the reason ('Edit up to 500 at once')"). */
  rows: 500,
  /** Fields one bulk edit changes at once. */
  fields: 5,
  /** The longest text a text field takes. */
  text: 2000,
})

export const BULK_FIELD_KINDS = ['date', 'integer', 'text', 'choice'] as const
export type BulkFieldKind = (typeof BULK_FIELD_KINDS)[number]

/** A field's value: a day (YYYY-MM-DD) or a text or a choice's code, a whole number, or nothing. */
export type BulkValue = string | number | null

export interface BulkFieldSpec {
  readonly kind: BulkFieldKind
  /** It may be emptied (a due date taken away). */
  readonly nullable?: boolean
  readonly min?: number
  readonly max?: number
  readonly maxLength?: number
  /** The codes a `choice` field takes. */
  readonly choices?: readonly string[]
  /** A money field: only with its grain (design: "Bulk money fields need their grain"). */
  readonly grain?: Grain
}

/** Why a row is not changed, as a code the screen says in its own words. */
export const BULK_REFUSALS = [
  /** The record's state keeps this field (a closed work order keeps its due date): `status` names the state. */
  'held',
  /** Changed by someone else since it was reviewed (its version moved): review again. */
  'stale',
  /** Not found, or not in the person's sites any more. */
  'missing',
  /** The person may not change this record. */
  'forbidden',
  /** The record's own rules refused the value (`field`). */
  'invalid',
  /** Anything else went wrong: nothing was written to this row. */
  'failed',
] as const
export type BulkRefusalCode = (typeof BULK_REFUSALS)[number]

export interface BulkRefusal {
  readonly code: BulkRefusalCode
  readonly field?: string | null
  /** The record's state code (`CLOSED`), for `held`. */
  readonly status?: string | null
  /**
   * B-W2b-51: what holds the row, as the record's own codes (a work order's release checks that block it: CERTIFICATE,
   * MATERIAL, …), for `held`; the screen says each in its own words. Absent: the code and status say it all.
   */
  readonly reasons?: readonly string[] | null
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** A real calendar day written YYYY-MM-DD. */
export function isDay(value: string): boolean {
  const match = DAY.exec(value)
  if (!match) return false
  const [, y, m, d] = match.map(Number) as [number, number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/**
 * A value as it is written: a text trimmed, an empty text or day → nothing, a number kept as typed (a numeric text read as
 * a number). Not checked here (`valueProblem` does): an unreadable value stays as it came so the problem can name it.
 */
export function normaliseValue(spec: BulkFieldSpec, value: unknown): BulkValue {
  if (value === null || value === undefined) return null
  if (spec.kind === 'integer') {
    if (typeof value === 'number') return value
    if (typeof value === 'string') {
      const text = value.trim().replace(/\s/g, '')
      if (text === '') return null
      const read = Number(text)
      return Number.isFinite(read) ? read : text
    }
    return String(value)
  }
  if (typeof value === 'number') return String(value)
  const text = String(value).trim()
  return text === '' ? null : text
}

/** Why a value cannot be written to the field, in words (the API's 400 at body/changes/<field>), or null. */
export function valueProblem(spec: BulkFieldSpec, value: BulkValue): string | null {
  if (value === null) return spec.nullable ? null : 'A value is needed.'
  switch (spec.kind) {
    case 'date':
      return typeof value === 'string' && isDay(value) ? null : 'Not a day (YYYY-MM-DD).'
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return 'A whole number is needed.'
      if (spec.min !== undefined && value < spec.min) return `At least ${spec.min}.`
      if (spec.max !== undefined && value > spec.max) return `At most ${spec.max}.`
      return null
    case 'text': {
      if (typeof value !== 'string') return 'A text is needed.'
      const max = spec.maxLength ?? BULK_LIMITS.text
      return value.length > max ? `At most ${max} characters.` : null
    }
    case 'choice':
      return typeof value === 'string' && (spec.choices ?? []).includes(value) ? null : 'Not one of the choices.'
  }
}

export const sameValue = (a: BulkValue, b: BulkValue): boolean => a === b

/** Why the person may not change a field at all (a money field without its grain), or null. */
export function fieldHeld(spec: BulkFieldSpec, grains: ReadonlySet<Grain>): string | null {
  return spec.grain && !grains.has(spec.grain) ? `Changing this field needs the ${spec.grain} right.` : null
}

/**
 * The problems of an ask before any row is read (the API's 400 in words, one per path): no row, too many rows, no field,
 * a field the list does not have, a value the field cannot take. The values are the normalised ones (`normaliseValue`).
 */
export function askProblems(fields: Readonly<Record<string, BulkFieldSpec>>, changes: Readonly<Record<string, BulkValue>>, rowCount: number, path = 'body'): Issue[] {
  const issues: Issue[] = []
  if (rowCount === 0) issues.push({ path: `${path}/ids`, message: 'Choose at least one row.' })
  if (rowCount > BULK_LIMITS.rows) issues.push({ path: `${path}/ids`, message: `Edit up to ${BULK_LIMITS.rows} rows at once.` })
  const names = Object.keys(changes)
  if (names.length === 0) issues.push({ path: `${path}/changes`, message: 'Choose a field to change.' })
  if (names.length > BULK_LIMITS.fields) issues.push({ path: `${path}/changes`, message: `Change up to ${BULK_LIMITS.fields} fields at once.` })
  for (const name of names) {
    const spec = Object.hasOwn(fields, name) ? fields[name] : undefined
    if (!spec) {
      issues.push({ path: `${path}/changes/${name}`, message: 'Not a field this list edits.' })
      continue
    }
    const problem = valueProblem(spec, changes[name] ?? null)
    if (problem) issues.push({ path: `${path}/changes/${name}`, message: problem })
  }
  return issues
}

/** One row as the list's target reads it now. */
export interface BulkRowFacts {
  readonly id: string
  /** The record's name on screen ("WO-0012"). */
  readonly label: string
  readonly version: number
  /** The field values now, by field. */
  readonly values: Readonly<Record<string, BulkValue>>
  /** Why this row may not take a field's change (by field), or the whole row (`*`). */
  readonly held: Readonly<Record<string, BulkRefusal | null>>
}

export interface BulkFieldChange {
  readonly field: string
  readonly now: BulkValue
  readonly next: BulkValue
}

export interface BulkPreviewRow {
  readonly id: string
  readonly label: string
  /** The version the person reviews: the apply sends it back (a row changed since is a conflict). */
  readonly version: number
  /** The fields that change on this row; a field already at that value is left out. */
  readonly changes: readonly BulkFieldChange[]
  /** Why this row is not changed; null: it is (or it already has those values). */
  readonly refusal: BulkRefusal | null
}

/** A row's preview: old → new per field that would change, or why the row is not changed. */
export function previewRow(facts: BulkRowFacts, changes: Readonly<Record<string, BulkValue>>): BulkPreviewRow {
  const fieldChanges = Object.entries(changes)
    .map(([field, next]) => ({ field, now: facts.values[field] ?? null, next }))
    .filter((change) => !sameValue(change.now, change.next))
  const whole = facts.held['*'] ?? null
  const held = whole ?? (fieldChanges.map((change) => facts.held[change.field] ?? null).find((refusal) => refusal !== null) ?? null)
  return { id: facts.id, label: facts.label, version: facts.version, changes: fieldChanges, refusal: fieldChanges.length === 0 && !whole ? null : held }
}

/** A row the person asked for that the target could not read (not found, not in their sites). */
export const missingRow = (id: string): BulkPreviewRow => ({ id, label: '', version: 0, changes: [], refusal: { code: 'missing' } })

export interface BulkPreviewCounts {
  /** Rows that would change. */
  readonly changing: number
  /** Rows that already hold those values. */
  readonly unchanged: number
  /** Rows refused, with their reason. */
  readonly refused: number
}

export function previewCounts(rows: readonly BulkPreviewRow[]): BulkPreviewCounts {
  let changing = 0
  let unchanged = 0
  let refused = 0
  for (const row of rows) {
    if (row.refusal) refused++
    else if (row.changes.length === 0) unchanged++
    else changing++
  }
  return { changing, unchanged, refused }
}

/** What the apply writes to one row: the version the person reviewed and the values (Undo: the row's own earlier ones). */
export interface BulkApplyRow {
  readonly id: string
  readonly version: number
  readonly changes: Readonly<Record<string, BulkValue>>
}

/** The rows a reviewed preview applies: the ones that change, each with its own reviewed version. */
export function applyRowsOf(rows: readonly BulkPreviewRow[]): BulkApplyRow[] {
  return rows
    .filter((row) => row.refusal === null && row.changes.length > 0)
    .map((row) => ({ id: row.id, version: row.version, changes: Object.fromEntries(row.changes.map((change) => [change.field, change.next])) }))
}

/** What became of one row. */
export interface BulkResult {
  readonly id: string
  readonly label: string
  readonly ok: boolean
  readonly refusal: BulkRefusal | null
  /** The field values before and after the write (the asked fields only); equal when nothing was written. */
  readonly before: Readonly<Record<string, BulkValue>>
  readonly after: Readonly<Record<string, BulkValue>>
  /** The row's version after the write (as read when it was refused). */
  readonly version: number
}

/** Undo: every row that changed, back to its earlier values, from the version the change gave it. */
export function undoRowsOf(results: readonly BulkResult[]): BulkApplyRow[] {
  return results.flatMap((result) => {
    if (!result.ok) return []
    const fields = Object.keys(result.before).filter((field) => !sameValue(result.before[field] ?? null, result.after[field] ?? null))
    return fields.length === 0 ? [] : [{ id: result.id, version: result.version, changes: Object.fromEntries(fields.map((field) => [field, result.before[field] ?? null])) }]
  })
}

/** The refusal of a write the record's own command refused, from the error's kind (DomainError names). */
export function refusalOfError(kind: string, field?: string | null, status?: string | null): BulkRefusal {
  switch (kind) {
    case 'ConflictError':
      return { code: 'stale' }
    case 'InvalidStateError':
      return { code: 'held', status: status ?? null }
    case 'NotFoundError':
      return { code: 'missing' }
    case 'ForbiddenError':
      return { code: 'forbidden' }
    case 'ValidationError':
      return { code: 'invalid', field: field ?? null }
    default:
      return { code: 'failed' }
  }
}

import type { CellContext, CellValue, RawCell } from './cells'
import { isBlank } from './cells'
import type { MappedColumn } from './headers'
import {
  keyOf,
  sameColumnValue,
  type ExistingRecord,
  type Importer,
  type RecordValues,
  type RowAction,
  type RowIssue,
  type RowValues,
} from './importer'

/**
 * The dry run, pure (feature PLT-176: "see a diff — new, changed, errors — before applying"): each data row of the
 * sheet is parsed (its mapped cells, each by its column's type, then the importer's row check), keyed, and planned
 * against the record its key finds: CREATE, UPDATE (with what changes, before and after), UNCHANGED, or ERROR (with
 * every problem of the row, so one pass shows them all). Two rows with one key: the later ones are errors (the first
 * one stands). The API reads the records in batches and stores each batch's plan; this module never touches a record.
 *
 * At apply time `applyCheck` compares the plan with the record as it is then: a row whose record changed since the
 * dry run is skipped (never applied over someone's newer change), one that already holds the planned values is
 * skipped as done; the rest are applied exactly as planned.
 */

/** One data row of a sheet: its row number as the spreadsheet shows it (the header is row 1) and its cells. */
export interface SheetRow {
  readonly rowNumber: number
  readonly cells: readonly RawCell[]
}

export interface ParsedRow {
  readonly rowNumber: number
  /** The non-blank cells, parsed. */
  readonly values: RowValues
  /** The key (JSON array of the key columns' values), or null when a key cell is missing or wrong. */
  readonly key: string | null
  readonly errors: readonly RowIssue[]
}

/** A row is blank when every cell is: it is not a data row (and not counted). */
export function isBlankRow(row: SheetRow): boolean {
  return row.cells.every((cell) => isBlank(cell))
}

export function parseRow(importer: Importer, mapping: readonly MappedColumn[], row: SheetRow, context: CellContext): ParsedRow {
  const values: Record<string, CellValue> = {}
  const errors: RowIssue[] = []
  for (const { index, column } of mapping) {
    const definition = importer.columns[column]
    if (!definition) continue
    const raw = row.cells[index]
    if (isBlank(raw)) {
      if (definition.required) errors.push({ column, message: `${definition.label} is required.` })
      continue
    }
    const result = definition.type.safeParse({ raw, context })
    if (result.success) values[column] = result.data
    else errors.push({ column, message: result.error.issues[0]?.message ?? 'Not a valid value.' })
  }
  if (errors.length === 0) {
    for (const issue of importer.validateRow(values)) errors.push(issue)
  }
  const key = errors.some((issue) => issue.column !== undefined && importer.keyColumns.includes(issue.column)) ? null : keyOf(importer, values)
  return { rowNumber: row.rowNumber, values, key, errors }
}

/** One planned row, as stored (ImportRow): values unmarked here; the API marks money before it stores them. */
export interface PlannedRow {
  readonly rowNumber: number
  readonly action: RowAction
  readonly key: string | null
  /** The record the key found (UPDATE, UNCHANGED). */
  readonly recordId: string | null
  readonly before: RecordValues | null
  readonly after: RowValues | null
  readonly errors: readonly RowIssue[]
}

export interface PlanCounts {
  readonly rows: number
  readonly create: number
  readonly update: number
  readonly unchanged: number
  readonly error: number
}

/**
 * Plans a sheet batch by batch: `plan(rows, existing)` takes parsed rows and the records their keys found (by key), and
 * remembers the keys it saw, so a key repeated in a later batch is still caught.
 */
export interface Planner {
  plan(rows: readonly ParsedRow[], existing: ReadonlyMap<string, ExistingRecord>): PlannedRow[]
  counts(): PlanCounts
}

export function planner(importer: Importer): Planner {
  const seen = new Map<string, number>()
  const counts = { rows: 0, create: 0, update: 0, unchanged: 0, error: 0 }
  const count = (row: PlannedRow): PlannedRow => {
    counts.rows += 1
    counts[row.action === 'CREATE' ? 'create' : row.action === 'UPDATE' ? 'update' : row.action === 'UNCHANGED' ? 'unchanged' : 'error'] += 1
    return row
  }
  const error = (row: ParsedRow, errors: readonly RowIssue[]): PlannedRow =>
    count({ rowNumber: row.rowNumber, action: 'ERROR', key: row.key, recordId: null, before: null, after: null, errors })

  return {
    plan(rows, existing) {
      return rows.map((row) => {
        if (row.errors.length > 0) return error(row, row.errors)
        if (row.key === null) return error(row, [{ message: 'The row has no key.' }])
        const first = seen.get(row.key)
        if (first !== undefined) return error(row, [{ message: `The same ${importer.keyColumns.map((name) => importer.columns[name]!.label).join(' and ')} as row ${first}; only the first one is imported.` }])
        seen.set(row.key, row.rowNumber)
        const record = existing.get(row.key) ?? null
        const plan = importer.plan(row.values, record)
        switch (plan.action) {
          case 'ERROR':
            return error(row, plan.errors.length > 0 ? plan.errors : [{ message: 'The row cannot be imported.' }])
          case 'CREATE':
            return count({ rowNumber: row.rowNumber, action: 'CREATE', key: row.key, recordId: null, before: null, after: plan.after, errors: [] })
          case 'UPDATE':
            return count({ rowNumber: row.rowNumber, action: 'UPDATE', key: row.key, recordId: record!.id, before: plan.before, after: plan.after, errors: [] })
          default:
            return count({ rowNumber: row.rowNumber, action: 'UNCHANGED', key: row.key, recordId: record?.id ?? null, before: null, after: null, errors: [] })
        }
      })
    },
    counts: () => ({ ...counts }),
  }
}

/** What to do with a planned CREATE or UPDATE row now: apply it, or skip it (and why). */
export type ApplyDecision = { readonly apply: true } | { readonly apply: false; readonly note: 'changed_since_dry_run' | 'already_done' }

/**
 * Checks a planned row against its record as it is at apply time (null: no record has the key now). CREATE: still no
 * record. UPDATE: the same record, still holding `before` in every column that changes. A record that already holds
 * every planned value is "already done" (someone made the change meanwhile).
 */
export function applyCheck(importer: Importer, row: Pick<PlannedRow, 'action' | 'recordId' | 'before' | 'after'>, current: ExistingRecord | null): ApplyDecision {
  const after = row.after ?? {}
  const holdsAfter = current !== null && Object.entries(after).every(([name, value]) => sameColumnValue(importer, name, value, current.values[name] ?? null))
  if (row.action === 'CREATE') {
    if (current === null) return { apply: true }
    return { apply: false, note: holdsAfter ? 'already_done' : 'changed_since_dry_run' }
  }
  if (row.action === 'UPDATE') {
    if (current === null || current.id !== row.recordId) return { apply: false, note: 'changed_since_dry_run' }
    const holdsBefore = Object.entries(row.before ?? {}).every(([name, value]) => sameColumnValue(importer, name, value, current.values[name] ?? null))
    if (holdsBefore) return { apply: true }
    return { apply: false, note: holdsAfter ? 'already_done' : 'changed_since_dry_run' }
  }
  return { apply: false, note: 'already_done' }
}

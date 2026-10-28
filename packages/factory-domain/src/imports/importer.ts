import type { z } from 'zod'
import { isGrain, type Grain } from '../auth/grains/grains'
import { isPermission } from '../core/permissions'
import { isMarkedJson, markMoney } from '../money/marked'
import { cellMetaOf, sameValue, type CellInput, type CellValue } from './cells'
import { headerLookup } from './headers'
import { IMPORT_LIMITS } from './job'

/**
 * Importers (plan A1 W0-22; feature PLT-176): what one kind of import reads and how it decides, per row, what would
 * change. The engine (header mapping, cell parsing, the dry run, the apply in batches) is shared; a module declares
 * an importer for its records:
 *
 *   export const widgetsImporter = defineImporter({
 *     key: 'product.items',                       // <module>.<name>, unique
 *     label: 'Items',
 *     columns: {
 *       code: { label: 'Code', aliases: ['codice', 'sku'], required: true, type: cell.code({ upper: true }) },
 *       name: { label: 'Name', aliases: ['nome', 'descrizione'], required: true, type: cell.text({ max: 200 }) },
 *       unitCost: { label: 'Unit cost', aliases: ['costo unitario'], type: cell.decimal({ scale: 6 }), grain: 'cost' },
 *     },
 *     keyColumns: ['code'],                       // how a row finds the record it updates (upsert matching)
 *     validateRow: (values) => [],                // checks across cells; per-cell checks are the column types
 *     plan: (row, existing) => …,                 // optional: the default compares the given cells with the record
 *   })
 *
 * and, in the API, the adapter that loads the existing records by key and writes a planned row
 * (apps/factory-api platform/imports: defineImportAdapter). Pure: no I/O here.
 *
 * Money (A1 §2.6, §3.11): a column that carries money names its grain. The dry run refuses a sheet that maps such a
 * column for a person who does not hold the grain, and the plan stores its values marked (markMoney), so a person
 * without the grain never sees them in the review either. A key column never carries money.
 *
 * Blank cells: a blank cell is "not given". It is never written: a CREATE leaves the field at its default, an UPDATE
 * leaves it as it is. A required column's blank cell is an error.
 */

/** A column's type: a `cell.*` builder (./cells), or any zod schema over the same input. */
export type ColumnType = z.ZodType<CellValue, CellInput>

export interface ImportColumn {
  /** The column's name for people (English; the screen translates). */
  readonly label: string
  /** Other headers that mean this column (Italian and English, any case or accents). */
  readonly aliases?: readonly string[]
  readonly required?: boolean
  readonly type: ColumnType
  /** The money grain of a column that carries money (price, cost, margin, wages). */
  readonly grain?: Grain
  /** One line for the template and the import screen. */
  readonly description?: string
}

/** The values a row gives, by column (only the cells that are not blank). */
export type RowValues = Readonly<Record<string, CellValue>>
/** A record's current values of the importer's columns; null for an empty field. */
export type RecordValues = Readonly<Record<string, CellValue | null>>

/** A record the key matched: its id and its current values (in the same JSON kinds the cells parse to). */
export interface ExistingRecord {
  readonly id: string
  readonly values: RecordValues
}

export const ROW_ACTIONS = ['CREATE', 'UPDATE', 'UNCHANGED', 'ERROR'] as const
export type RowAction = (typeof ROW_ACTIONS)[number]

/** A problem of one row; `column` names the importer column when it is one cell's. */
export interface RowIssue {
  readonly column?: string
  readonly message: string
}

/**
 * What one row would do. CREATE: `after` is every value the new record gets. UPDATE: `before` is what the record has
 * now in the columns that change, `after` what they become; at apply time the record must still hold `before`, or the
 * row is skipped as changed since the dry run. UNCHANGED: the record already holds every given value.
 */
export type RowPlan =
  | { readonly action: 'CREATE'; readonly after: RowValues }
  | { readonly action: 'UPDATE'; readonly before: RecordValues; readonly after: RowValues }
  | { readonly action: 'UNCHANGED' }
  | { readonly action: 'ERROR'; readonly errors: readonly RowIssue[] }

export interface ImporterSpec<Columns extends Readonly<Record<string, ImportColumn>>> {
  /** `<module>.<name>`: the job's importer key. */
  readonly key: string
  readonly label: string
  readonly description?: string
  readonly columns: Columns
  /** The columns that find the existing record (upsert matching): required, never money. */
  readonly keyColumns: readonly (keyof Columns & string)[]
  /** At most this many data rows (default and cap IMPORT_LIMITS.maxRows). */
  readonly maxRows?: number
  /** Rows per apply batch, each one transaction (default IMPORT_LIMITS.batchSize). */
  readonly batchSize?: number
  /** Checks across the cells of one row, after each cell parsed. */
  readonly validateRow?: (values: RowValues) => readonly RowIssue[]
  /** What the row would do to the record its key found (or null). Default: `diffPlan`. */
  readonly plan?: (values: RowValues, existing: ExistingRecord | null) => RowPlan
}

export interface Importer<Columns extends Readonly<Record<string, ImportColumn>> = Readonly<Record<string, ImportColumn>>> {
  readonly key: string
  readonly label: string
  readonly description: string | null
  readonly columns: Columns
  readonly keyColumns: readonly string[]
  readonly maxRows: number
  readonly batchSize: number
  readonly validateRow: (values: RowValues) => readonly RowIssue[]
  readonly plan: (values: RowValues, existing: ExistingRecord | null) => RowPlan
}

export class ImporterDefinitionError extends Error {
  override name = 'ImporterDefinitionError'
}

const COLUMN_NAME = /^[a-z][a-zA-Z0-9]{0,63}$/

/** Declares an importer. A mistake in it throws at once, so at import (boot). */
export function defineImporter<const Columns extends Readonly<Record<string, ImportColumn>>>(spec: ImporterSpec<Columns>): Importer<Columns> {
  const at = `Importer ${JSON.stringify(spec?.key)}`
  const problems: string[] = []
  if (!isPermission(spec?.key) || spec.key.split('.').length !== 2) problems.push('the key is not <module>.<name>')
  if (typeof spec?.label !== 'string' || spec.label.trim() === '') problems.push('the label is empty')
  const columns = spec?.columns ?? ({} as Columns)
  const names = Object.keys(columns)
  if (names.length === 0) problems.push('it has no column')
  if (names.length > IMPORT_LIMITS.maxColumns) problems.push(`it has more than ${IMPORT_LIMITS.maxColumns} columns`)
  for (const [name, column] of Object.entries(columns)) {
    if (!COLUMN_NAME.test(name)) problems.push(`column ${name}: the name is not camelCase`)
    if (typeof column?.label !== 'string' || column.label.trim() === '') problems.push(`column ${name}: the label is empty`)
    if (typeof (column?.type as { safeParse?: unknown } | undefined)?.safeParse !== 'function') problems.push(`column ${name}: the type is not a zod schema`)
    if (column?.grain !== undefined && !isGrain(column.grain)) problems.push(`column ${name}: ${String(column.grain)} is not a money grain`)
  }
  const keyColumns = spec?.keyColumns ?? []
  if (keyColumns.length === 0) problems.push('it has no key column')
  for (const name of keyColumns) {
    const column = columns[name]
    if (!column) problems.push(`key column ${name} is not a column`)
    else {
      if (!column.required) problems.push(`key column ${name} must be required`)
      if (column.grain !== undefined) problems.push(`key column ${name} carries money; a key never does`)
    }
  }
  if (new Set(keyColumns).size !== keyColumns.length) problems.push('a key column is listed twice')
  problems.push(...headerLookup(columns).clashes)
  const maxRows = spec?.maxRows ?? IMPORT_LIMITS.maxRows
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > IMPORT_LIMITS.maxRows) problems.push(`maxRows must be 1 to ${IMPORT_LIMITS.maxRows}`)
  const batchSize = spec?.batchSize ?? IMPORT_LIMITS.batchSize
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > IMPORT_LIMITS.maxBatchSize) problems.push(`batchSize must be 1 to ${IMPORT_LIMITS.maxBatchSize}`)
  if (problems.length > 0) throw new ImporterDefinitionError(`${at}: ${problems.join('; ')}.`)

  const importer: Importer<Columns> = {
    key: spec.key,
    label: spec.label,
    description: spec.description ?? null,
    columns,
    keyColumns: Object.freeze([...keyColumns]),
    maxRows,
    batchSize,
    validateRow: spec.validateRow ?? (() => []),
    plan: (values, existing) => checkedPlan(importer, spec.plan ? spec.plan(values, existing) : diffPlan(importer, values, existing), existing),
  }
  return Object.freeze(importer)
}

/** Refuses a custom plan that names a column the importer does not have, or an UPDATE without a record. */
function checkedPlan(importer: Importer, plan: RowPlan, existing: ExistingRecord | null): RowPlan {
  const unknown = (values: object) => Object.keys(values).filter((name) => !Object.hasOwn(importer.columns, name))
  if (plan.action === 'CREATE' || plan.action === 'UPDATE') {
    const bad = [...unknown(plan.after), ...(plan.action === 'UPDATE' ? unknown(plan.before) : [])]
    if (bad.length > 0) throw new ImporterDefinitionError(`Importer ${importer.key}: its plan names unknown columns ${bad.join(', ')}.`)
  }
  if (plan.action === 'UPDATE' && existing === null) throw new ImporterDefinitionError(`Importer ${importer.key}: its plan updates a record that does not exist.`)
  if (plan.action === 'CREATE' && existing !== null) throw new ImporterDefinitionError(`Importer ${importer.key}: its plan creates a record its key already found.`)
  return plan
}

/**
 * The default plan: no record → CREATE with every given value; a record → the given cells that differ from it
 * (decimals by value) become an UPDATE, or UNCHANGED when none differs. Key columns matched, so they never differ.
 */
export function diffPlan(importer: Importer, values: RowValues, existing: ExistingRecord | null): RowPlan {
  if (existing === null) return { action: 'CREATE', after: values }
  const before: Record<string, CellValue | null> = {}
  const after: Record<string, CellValue> = {}
  for (const [name, value] of Object.entries(values)) {
    const current = existing.values[name] ?? null
    if (!sameColumnValue(importer, name, value, current)) {
      before[name] = current
      after[name] = value
    }
  }
  return Object.keys(after).length === 0 ? { action: 'UNCHANGED' } : { action: 'UPDATE', before, after }
}

/** Two values of one column are the same (decimal columns compare by value). */
export function sameColumnValue(importer: Importer, name: string, a: unknown, b: unknown): boolean {
  const type = importer.columns[name]?.type
  return sameValue(type ? cellMetaOf(type) : undefined, a, b)
}

/** The row's key: the key columns' values as a JSON array, or null when one is missing. Never money. */
export function keyOf(importer: Importer, values: Readonly<Record<string, unknown>>): string | null {
  const parts = importer.keyColumns.map((name) => values[name])
  if (parts.some((part) => part === undefined || part === null || part === '')) return null
  return JSON.stringify(parts)
}

/** The key columns' values back from a key. */
export function keyValues(importer: Importer, key: string): Record<string, CellValue> {
  const parts = JSON.parse(key) as CellValue[]
  return Object.fromEntries(importer.keyColumns.map((name, index) => [name, parts[index]!]))
}

/** The money grains the given columns carry. */
export function grainsOf(importer: Importer, columns: Iterable<string>): Grain[] {
  const grains = new Set<Grain>()
  for (const name of columns) {
    const grain = importer.columns[name]?.grain
    if (grain) grains.add(grain)
  }
  return [...grains].sort()
}

/** Values as stored on an import row: each money column's value marked with its grain (the review filters by it). */
export function markValues(importer: Importer, values: Readonly<Record<string, CellValue | null>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => {
      const grain = importer.columns[name]?.grain
      return [name, grain ? markMoney(grain, value) : value]
    }),
  )
}

/** Stored values back as plain values (the apply writes these). */
export function unmarkValues(stored: unknown): Record<string, CellValue | null> {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return {}
  return Object.fromEntries(Object.entries(stored).map(([name, value]) => [name, (isMarkedJson(value) ? value.value : value) as CellValue | null]))
}

/** The importers of a process, by key. Two with one key are refused. */
export interface ImporterRegistry<Entry extends { readonly importer: Importer }> {
  get(key: string): Entry | undefined
  list(): readonly Entry[]
}

export function importerRegistry<Entry extends { readonly importer: Importer }>(entries: readonly Entry[]): ImporterRegistry<Entry> {
  const byKey = new Map<string, Entry>()
  for (const entry of entries) {
    if (byKey.has(entry.importer.key)) throw new ImporterDefinitionError(`Importer ${entry.importer.key} is registered twice.`)
    byKey.set(entry.importer.key, entry)
  }
  const sorted = Object.freeze([...byKey.values()].sort((a, b) => (a.importer.key < b.importer.key ? -1 : 1)))
  return Object.freeze({ get: (key: string) => byKey.get(key), list: () => sorted })
}

import type { Prisma } from '@nexus/factory-db'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { customValuesImporter, MONEY_COLUMNS, VALUE_COLUMNS } from '@nexus/factory-domain/fields/importer'
import { checkValue, decimalOfMinor, importInput, isMoneyValue, minorOfImport, type StoredValue } from '@nexus/factory-domain/fields/values'
import type { CellValue } from '@nexus/factory-domain/imports/cells'
import type { ExistingRecord, RecordValues, RowIssue } from '@nexus/factory-domain/imports/importer'
import type { CommandTools } from '../../core/command'
import { actorOf, SYSTEM_ACTOR_ID } from '../../core/context'
import { ApiError } from '../../core/errors'
// Types only: platform/imports/registry.ts lists these adapters, so a value import back from it would be a cycle.
import type { CheckRow, ImportAdapter, ImportScope, WriteRow } from '../imports/registry'
import { CUSTOM_RECORDS, recordsByKey, recordsOfModel, isCustomModel, type CustomRecord, type RecordFacts } from './records'
import { fieldsOfModel, fieldsSeen, valuesOfRecords, writeValuesInCommand, type FieldRow, type ValueRow } from './registry'

/**
 * The import of custom values, one importer per record type of platform/fields/records.ts (B-W2b-421; PLT-111; factory-domain
 * fields/importer: one row per record and field). Writing them needs the record type's own edit permission, seeing them its
 * view permission (the engine asks both over the job's company):
 *
 *   load    the record by its code or number in the job's company (tenant-wide master data too), the field by its code,
 *           and the value it has now in the importer's columns (a money value in its grain's column with its currency)
 *   check   with the person who starts and who applies: the record found and theirs to change, the field active, of the
 *           record's company and one they SEE (else "no such field": never told it exists), the value right for the
 *           field's type (a deactivated list value only where the record has it; a person by e-mail; a linked record by
 *           its code or number, of the record's company); a money field only through its grain's column
 *   write   the planned value through writeValuesInCommand (the values' one command path: audited, one event)
 *
 * A file field takes no import (a file is added on its record).
 */

type Client = Prisma.TransactionClient

interface Resolved {
  readonly record: RecordFacts | null
  readonly field: FieldRow | null
  readonly current: ValueRow | null
}

async function resolve(client: Client, record: CustomRecord, keys: readonly Readonly<Record<string, CellValue>>[], scope: ImportScope): Promise<{ fields: Map<string, FieldRow>; records: Map<string, RecordFacts>; values: Map<string, Map<string, ValueRow>> }> {
  const records = await recordsByKey(client, record, keys.map((key) => String(key.record)), scope.companyId)
  const fields = new Map((await fieldsOfModel(client, record.model)).map((field) => [field.code, field]))
  const values = await valuesOfRecords(client, record.model, [...records.values()].map((facts) => facts.id))
  return { fields, records, values }
}

const resolvedOf = (found: Awaited<ReturnType<typeof resolve>>, key: Readonly<Record<string, CellValue>>): Resolved => {
  const record = found.records.get(String(key.record)) ?? null
  const field = found.fields.get(String(key.field)) ?? null
  return { record, field, current: record && field ? (found.values.get(record.id)?.get(field.id) ?? null) : null }
}

/** A stored value in the importer's columns (what the dry run compares a row with). */
function columnsOf(field: FieldRow, value: StoredValue): RecordValues {
  const amountColumn = field.type === 'MONEY' && field.grain ? MONEY_COLUMNS[field.grain] : undefined
  if (amountColumn && isMoneyValue(value)) return { [amountColumn]: decimalOfMinor(value), currency: value.currency }
  if (field.type === 'MONEY' || isMoneyValue(value)) return {}
  if (typeof value === 'number') return { number: String(value) }
  if (Array.isArray(value)) return { value: (value as string[]).join(', ') }
  if (typeof value === 'boolean') return { value: value ? 'sì' : 'no' }
  return { value: String(value) }
}

/** The column a field's value is given in: a money field's grain column, a number's Number, else Value. */
const columnOfField = (field: FieldRow): string | null => (field.type === 'MONEY' ? (field.grain ? (MONEY_COLUMNS[field.grain] ?? null) : null) : field.type === 'NUMBER' ? 'number' : 'value')

/** The value a row asks for, checked for its field (references found in the database), or the issue. */
async function valueOfRow(client: Client, facts: RecordFacts, field: FieldRow, current: ValueRow | null, values: Readonly<Record<string, CellValue>>): Promise<{ readonly value: StoredValue } | { readonly issue: RowIssue }> {
  const column = columnOfField(field)
  if (column === null) return { issue: { column: 'field', message: `${field.code} holds piece pay: it is typed on its record, never imported.` } }
  const given = VALUE_COLUMNS.find((name) => values[name] !== undefined)
  if (given !== column) {
    const where = field.type === 'MONEY' ? `the ${column} column with its currency` : field.type === 'NUMBER' ? 'the Number column' : 'the Value column'
    return { issue: { column: given ?? column, message: `${field.code} takes its value in ${where}.` } }
  }
  let input: unknown
  if (field.type === 'MONEY') {
    const minor = minorOfImport(String(values[column]), String(values.currency ?? ''))
    if ('problem' in minor) return { issue: { column, message: minor.problem } }
    input = { amount: minor.amount, currency: String(values.currency) }
  } else if (field.type === 'NUMBER') input = Number(values.number)
  else {
    const asked = importInput(field, String(values.value))
    if ('problem' in asked) return { issue: { column, message: asked.problem } }
    if ('ref' in asked) {
      if (field.type === 'PERSON') {
        const person = await client.user.findFirst({ where: { email: asked.ref, audience: 'OFFICE' }, select: { id: true } })
        if (!person) return { issue: { column, message: `No person of the office with the e-mail ${asked.ref}.` } }
        input = person.id
      } else {
        const target = field.linkTo && isCustomModel(field.linkTo) ? recordsOfModel(field.linkTo)[0] : undefined
        const found = target ? (await recordsByKey(client, target, [asked.ref], facts.companyId)).get(asked.ref) : undefined
        if (!found) return { issue: { column, message: `No ${target?.labelEn.toLowerCase() ?? 'record'} ${asked.ref} to link to.` } }
        input = found.id
      }
    } else input = asked.input
  }
  const checked = checkValue(field, input, current?.value ?? null)
  return 'problem' in checked ? { issue: { column, message: checked.problem } } : { value: checked.value }
}

/**
 * A row's cells over the value the record has now: an update plans only the cells that change (the amount without its
 * unchanged currency), so the apply reads the rest from the record.
 */
function rowWithCurrent(resolved: Resolved, field: FieldRow, row: Pick<CheckRow, 'key' | 'values'>): Readonly<Record<string, CellValue>> {
  const current = resolved.current ? columnsOf(field, resolved.current.value) : {}
  const givesValue = VALUE_COLUMNS.some((name) => row.values[name] !== undefined)
  const merged: Record<string, CellValue> = { ...row.key }
  for (const [name, value] of Object.entries(current)) if (value !== null && (name === 'currency' || !givesValue)) merged[name] = value
  return { ...merged, ...row.values }
}

/** The issues of one row for one person (see above). */
async function rowIssues(client: Client, record: CustomRecord, resolved: Resolved, row: CheckRow, actor: Actor): Promise<RowIssue[]> {
  if (!resolved.record) return [{ column: 'record', message: `No ${record.labelEn.toLowerCase()} ${String(row.key.record)} here (or two with that code).` }]
  if (!can(actor, record.view, resolved.record) || !can(actor, record.edit, resolved.record)) return [{ column: 'record', message: `Changing ${String(row.key.record)} needs ${record.edit} over it.` }]
  const field = resolved.field
  if (!field || fieldsSeen(actor, [field], resolved.record.companyId).length === 0) return [{ column: 'field', message: `No custom field ${String(row.key.field)} on this ${record.labelEn.toLowerCase()}.` }]
  if (field.type === 'FILE') return [{ column: 'field', message: 'A file field takes no import: add the file on the record.' }]
  const value = await valueOfRow(client, resolved.record, field, resolved.current, rowWithCurrent(resolved, field, row))
  return 'issue' in value ? [value.issue] : []
}

/** The adapter of one record type's custom values (registered in platform/imports/registry.ts). */
export function customValuesImportAdapter(record: CustomRecord): ImportAdapter {
  const importer = customValuesImporter(record.importer, `${record.labelEn} custom fields`)
  return Object.freeze({
    importer,
    permission: record.edit,
    viewPermission: record.view,
    async load(client: Client, keys: readonly Readonly<Record<string, CellValue>>[], scope: ImportScope): Promise<readonly ExistingRecord[]> {
      const found = await resolve(client, record, keys, scope)
      return keys.flatMap((key) => {
        const resolved = resolvedOf(found, key)
        if (!resolved.field || !resolved.current) return []
        return [{ id: resolved.current.id, values: { record: String(key.record), field: String(key.field), ...columnsOf(resolved.field, resolved.current.value) } }]
      })
    },
    async check(client: Client, rows: readonly CheckRow[], scope: ImportScope, actor: Actor): Promise<readonly (readonly RowIssue[])[]> {
      const found = await resolve(client, record, rows.map((row) => row.key), scope)
      const answers: RowIssue[][] = []
      for (const row of rows) answers.push(await rowIssues(client, record, resolvedOf(found, row.key), row, actor))
      return answers
    },
    async write(tools: CommandTools, row: WriteRow, scope: ImportScope): Promise<{ readonly recordId: string }> {
      const found = await resolve(tools.tx, record, [row.key], scope)
      const resolved = resolvedOf(found, row.key)
      if (!resolved.record || !resolved.field) throw new ApiError('internal_error', `fields import: ${String(row.key.record)} / ${String(row.key.field)} was checked but is gone.`)
      const value = await valueOfRow(tools.tx, resolved.record, resolved.field, resolved.current, rowWithCurrent(resolved, resolved.field, row))
      if ('issue' in value) throw new ApiError('internal_error', `fields import: ${value.issue.message}`)
      const actor = actorOf(tools.context)
      await writeValuesInCommand(tools, record, resolved.record, [{ code: resolved.field.code, value: value.value, version: resolved.current?.version ?? null }], actor, 'actorId' in tools.context ? tools.context.actorId : SYSTEM_ACTOR_ID)
      return { recordId: resolved.current?.id ?? resolved.record.id }
    },
  } satisfies ImportAdapter)
}

/** One adapter per record type, in the registry's order. */
export const CUSTOM_VALUE_IMPORT_ADAPTERS: readonly ImportAdapter[] = Object.freeze(CUSTOM_RECORDS.map(customValuesImportAdapter))

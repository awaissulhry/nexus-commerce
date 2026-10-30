import type { Issue } from '../../core/errors'
import { cell, type CellValue } from '../../imports/cells'
import { defineImporter, type ExistingRecord, type RecordValues, type RowIssue, type RowPlan, type RowValues } from '../../imports/importer'
import type { LocalisedNames } from '../materials/rules'
import { changeOperation, MAX_INSTRUCTIONS, MINUTES_INPUT_SCALE, MINUTES_PRECISION, MINUTES_SCALE, newOperation, sameMinutes, WORK_CENTRE_KINDS, type OperationFields, type OperationInput, type OperationPatch, type OperationStatus } from './operations'

/**
 * The operation library's import (feature PRD-109 → PLT-176; design products.operations "Import (W2a)"): a sheet of
 * operations, one per row, keyed by the operation code. A new code makes an operation; a known one changes the cells the
 * row gives (a blank cell is "not given", never "clear it"). The dry run applies every library rule (./operations), so a
 * row that would break one is an error in the review, never a failed apply.
 *
 *   code, name, name (it), name (en)        the operation and its names per language (the floor screen shows them)
 *   department                              the kind of work centre (taglio, cucitura, montaggio … or the codes)
 *   machine type, skill, SMV, instructions  as on the operation's page; SMV per garment, rounded half up to 3 decimals
 *
 * Not by import: the company (the job's company is the operations' company: a code of another company's operation is
 * an error), archived operations (reactivate first), a code copied into routings (the key never changes anyway).
 * Routings keep their copies: an import never changes a routing step (their screens show where the minutes differ).
 *
 * The adapter (apps/factory-api modules/product/operations/importer.ts) loads each operation as `importRecordValues()`:
 * the columns' current values plus `$record`, the whole operation as JSON, which the plan needs for the rules on what
 * the sheet leaves out. Only the columns reach a stored plan row.
 */

export const OPERATIONS_IMPORTER_KEY = 'product.operations'

const DEPARTMENT_ALIASES = {
  taglio: 'CUTTING', cutting: 'CUTTING', cut: 'CUTTING',
  cucitura: 'SEWING', cucito: 'SEWING', orlatura: 'SEWING', sewing: 'SEWING',
  montaggio: 'ASSEMBLY', assemblaggio: 'ASSEMBLY', assembly: 'ASSEMBLY',
  finissaggio: 'FINISHING', rifinitura: 'FINISHING', finitura: 'FINISHING', finishing: 'FINISHING',
  controllo: 'INSPECTION', collaudo: 'INSPECTION', 'controllo qualita': 'INSPECTION', qc: 'INSPECTION', inspection: 'INSPECTION',
  imballo: 'PACKING', imballaggio: 'PACKING', confezionamento: 'PACKING', packing: 'PACKING',
  terzista: 'SUBCONTRACT', terzisti: 'SUBCONTRACT', esterno: 'SUBCONTRACT', 'lavorazione esterna': 'SUBCONTRACT', subcontract: 'SUBCONTRACT',
} as const satisfies Record<string, (typeof WORK_CENTRE_KINDS)[number]>

export const operationsImporter = defineImporter({
  key: OPERATIONS_IMPORTER_KEY,
  label: 'Operations',
  description: 'The operation library: departments, machines, skills, standard minutes per garment and instructions.',
  columns: {
    code: { label: 'Code', aliases: ['codice', 'codice operazione', 'operation code', 'operazione'], required: true, type: cell.code({ upper: true, max: 40 }) },
    name: { label: 'Name', aliases: ['nome', 'descrizione', 'description'], type: cell.text({ max: 200 }), description: 'Needed for a new operation.' },
    nameIt: { label: 'Name (it)', aliases: ['nome (it)', 'nome italiano', 'nome it'], type: cell.text({ max: 200 }) },
    nameEn: { label: 'Name (en)', aliases: ['nome (en)', 'nome inglese', 'nome en'], type: cell.text({ max: 200 }) },
    workCentreKind: { label: 'Department', aliases: ['reparto', 'centro di lavoro', 'work centre', 'kind'], type: cell.oneOf(WORK_CENTRE_KINDS, DEPARTMENT_ALIASES), description: 'Needed for a new operation.' },
    machineType: { label: 'Machine type', aliases: ['macchina', 'tipo macchina', 'machine'], type: cell.text({ max: 60 }) },
    skill: { label: 'Skill', aliases: ['abilita', 'competenza', 'qualifica'], type: cell.text({ max: 60 }) },
    standardMinutes: {
      label: 'SMV',
      aliases: ['minuti standard', 'tempo standard', 'minuti', 'standard minutes', 'smv'],
      type: cell.decimal({ precision: MINUTES_PRECISION - MINUTES_SCALE + MINUTES_INPUT_SCALE, scale: MINUTES_INPUT_SCALE, min: '0' }),
      description: 'Standard minutes per garment (rounded to 3 decimals); needed for a new operation.',
    },
    instructions: { label: 'Instructions', aliases: ['istruzioni', 'note di lavoro', 'how to'], type: cell.text({ max: MAX_INSTRUCTIONS }) },
  },
  keyColumns: ['code'],
  batchSize: 100,
  plan: (values, existing) => planOperationRow(values, existing),
})

type Column = keyof typeof operationsImporter.columns
const isColumn = (name: string): name is Column => Object.hasOwn(operationsImporter.columns, name)

// ---- the record as the adapter loads it -----------------------------------------------------------------------------

/** An operation as the import sees it. */
export interface ImportedOperation {
  readonly fields: OperationFields
  readonly status: OperationStatus
  /** Of another company than the job's (or tenant-wide for a company's job, or the reverse). */
  readonly foreign: boolean
  /** Routing steps copied it (its code no longer changes; the import never changes the code anyway). */
  readonly used: boolean
}

const RECORD = '$record'

/** The column values of an operation's fields. */
function columnsOf(fields: OperationFields): Record<Column, CellValue | null> {
  return {
    code: fields.code,
    name: fields.name,
    nameIt: fields.nameI18n?.it ?? null,
    nameEn: fields.nameI18n?.en ?? null,
    workCentreKind: fields.workCentreKind,
    machineType: fields.machineType,
    skill: fields.skill,
    standardMinutes: fields.standardMinutes,
    instructions: fields.instructions,
  }
}

/** The values the adapter's load answers for an operation: its columns and the whole record (`$record`). */
export function importRecordValues(operation: ImportedOperation): RecordValues {
  return { ...columnsOf(operation.fields), [RECORD]: JSON.stringify(operation) }
}

function recordOf(existing: ExistingRecord): ImportedOperation {
  const raw = existing.values[RECORD]
  if (typeof raw !== 'string') throw new Error('The operations import needs the record ($record) beside the columns.')
  return JSON.parse(raw) as ImportedOperation
}

// ---- the plan ---------------------------------------------------------------------------------------------------------

const rowIssues = (issues: readonly Issue[]): RowIssue[] =>
  issues.map((issue) => {
    const head = issue.path.split('/')[0] ?? ''
    const column = head === 'nameI18n' ? (issue.path.endsWith('/it') ? 'nameIt' : 'nameEn') : head
    return isColumn(column) ? { column, message: issue.message } : { message: `${issue.path}: ${issue.message}` }
  })
const refused = (errors: readonly RowIssue[]): RowPlan => ({ action: 'ERROR', errors })

/** The names per language a row gives, merged over the operation's. */
function namesOf(values: RowValues, current: LocalisedNames | null): LocalisedNames | null | undefined {
  if (values.nameIt === undefined && values.nameEn === undefined) return undefined
  return { ...(current ?? {}), ...(typeof values.nameIt === 'string' ? { it: values.nameIt } : {}), ...(typeof values.nameEn === 'string' ? { en: values.nameEn } : {}) }
}

/** The fields a row gives, as an operation patch. */
export function patchOf(values: RowValues, current: LocalisedNames | null): OperationPatch {
  const patch: Record<string, unknown> = {}
  for (const name of ['name', 'workCentreKind', 'machineType', 'skill', 'standardMinutes', 'instructions'] as const) if (values[name] !== undefined) patch[name] = values[name]
  const names = namesOf(values, current)
  if (names !== undefined) patch.nameI18n = names
  return patch as OperationPatch
}

/** A new operation from a row (name, department and SMV checked present by the plan). */
export function operationInputOf(values: RowValues): OperationInput {
  return { code: String(values.code), ...patchOf(values, null) } as OperationInput
}

/** What one row does (the importer's `plan`): see the module comment. */
export function planOperationRow(values: RowValues, existing: ExistingRecord | null): RowPlan {
  if (existing === null) {
    const missing = (['name', 'workCentreKind', 'standardMinutes'] as const).filter((name) => values[name] === undefined)
    if (missing.length > 0) return refused(missing.map((name) => ({ column: name, message: `${operationsImporter.columns[name].label} is needed for a new operation.` })))
    const outcome = newOperation(operationInputOf(values))
    return outcome.ok ? { action: 'CREATE', after: values } : refused(rowIssues(outcome.issues))
  }
  const record = recordOf(existing)
  if (record.foreign) return refused([{ column: 'code', message: "This code is another company's operation (or one for every company): import it with that company." }])
  if (record.status !== 'ACTIVE') return refused([{ message: 'This operation is archived: reactivate it on its page before importing changes.' }])
  const change = changeOperation(record.fields, patchOf(values, record.fields.nameI18n), record.used)
  if (!change.ok) return refused(rowIssues(change.issues))
  const before = columnsOf(record.fields)
  const after = columnsOf(change.operation)
  const changedBefore: Record<string, CellValue | null> = {}
  const changedAfter: Record<string, CellValue> = {}
  for (const column of Object.keys(after) as Column[]) {
    const from = before[column]
    const to = after[column]
    const same = column === 'standardMinutes' && typeof from === 'string' && typeof to === 'string' ? sameMinutes(from, to) : from === to
    if (same || to === null) continue
    changedBefore[column] = from
    changedAfter[column] = to
  }
  return Object.keys(changedAfter).length === 0 ? { action: 'UNCHANGED' } : { action: 'UPDATE', before: changedBefore, after: changedAfter }
}

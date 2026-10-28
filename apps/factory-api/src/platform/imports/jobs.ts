import type { Prisma } from '@nexus/factory-db'
import { heldGrains, type Grain } from '@nexus/factory-domain/auth/grains/grains'
import { IMPORTS_APPLY, IMPORTS_RUN, IMPORTS_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { cellMetaOf, type NumberFormat } from '@nexus/factory-domain/imports/cells'
import type { RowAction } from '@nexus/factory-domain/imports/importer'
import { importMachine, sheetTypeProblem, type CsvEncoding, type ImportMode, type RowOutcome } from '@nexus/factory-domain/imports/job'
import { command, type CommandCaller } from '../../core/command'
import { actorOf, type RequestContext } from '../../core/context'
import { ApiError } from '../../core/errors'
import { requestUpload } from '../files/files'
import type { FilesRuntime } from '../files/service'
import type { JobView, RowView } from './contract'
import { processImporters, type ImportAdapter } from './registry'

/**
 * Import jobs for the office (plan A1 W0-22; feature PLT-176): start an import with its sheet, see jobs and their plans,
 * download the error file, apply a plan, cancel. The dry run and the apply run in the worker (worker.ts). Every write
 * goes through command() with its audit row; every read checks the job's company with can() (or scopeWhere for lists)
 * and the importer's own permissions (registry.ts).
 *
 *   start    POST /imports: the importer, the company, the mode and the reading options, and the sheet announced as a
 *            file upload (files.requestUpload: the sheet is a StoredFile owned by the job, kind DOCUMENT; the caller
 *            also needs files.upload) → imports.create (UPLOADED; the caller's money grains kept on the job) → the
 *            presigned upload. The client sends the bytes and confirms with POST /files/:fileId/complete: the file's
 *            `file.available` starts the dry run. A repeated Idempotency-Key is not answered from a receipt here (the
 *            job and its file are two writes): a repeat makes a second job, harmless until a sheet is uploaded to it.
 *   apply    imports.apply: the importer's permission and the grains of every mapped money column, checked against the
 *            person who applies (the worker writes as the system) → APPLYING + import.apply_requested.
 */

const JOB_SELECT = {
  id: true,
  companyId: true,
  importerKey: true,
  fileId: true,
  sheetName: true,
  encoding: true,
  numberFormat: true,
  mapping: true,
  layout: true,
  grains: true,
  status: true,
  mode: true,
  rowCount: true,
  createCount: true,
  updateCount: true,
  unchangedCount: true,
  errorCount: true,
  appliedCount: true,
  skippedCount: true,
  issues: true,
  error: true,
  plannedAt: true,
  applyRequestedAt: true,
  appliedAt: true,
  cancelledAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
  file: { select: { originalName: true, status: true } },
} as const satisfies Prisma.ImportJobSelect

export type JobRow = Prisma.ImportJobGetPayload<{ select: typeof JOB_SELECT }>

const iso = (date: Date | null): string | null => (date === null ? null : toUtcIso(date))

/** The columns a job's layout mapped (what the dry run read). */
export interface Layout {
  readonly format: 'csv' | 'xlsx'
  readonly sheet: string | null
  readonly sheets: readonly string[]
  readonly encoding: CsvEncoding | null
  readonly delimiter: string | null
  readonly headers: readonly string[]
  readonly columns: readonly { readonly index: number; readonly header: string; readonly column: string }[]
  readonly ignored: readonly { readonly index: number; readonly header: string; readonly reason: string }[]
}

export const layoutOf = (row: { readonly layout: unknown }): Layout | null => (row.layout ?? null) as Layout | null

export function viewOf(row: JobRow): JobView {
  return {
    id: row.id,
    companyId: row.companyId,
    importerKey: row.importerKey,
    importerLabel: processImporters().get(row.importerKey)?.importer.label ?? null,
    fileId: row.fileId,
    fileName: row.file.originalName,
    fileStatus: row.file.status,
    sheetName: row.sheetName,
    encoding: row.encoding as CsvEncoding | null,
    numberFormat: row.numberFormat as NumberFormat,
    mapping: (row.mapping ?? null) as Record<string, string | null> | null,
    layout: row.layout ?? null,
    status: row.status,
    mode: row.mode,
    rowCount: row.rowCount,
    createCount: row.createCount,
    updateCount: row.updateCount,
    unchangedCount: row.unchangedCount,
    errorCount: row.errorCount,
    appliedCount: row.appliedCount,
    skippedCount: row.skippedCount,
    issues: (row.issues ?? null) as Issue[] | null,
    error: row.error,
    plannedAt: iso(row.plannedAt),
    applyRequestedAt: iso(row.applyRequestedAt),
    appliedAt: iso(row.appliedAt),
    cancelledAt: iso(row.cancelledAt),
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
    createdById: row.createdById,
  }
}

function contextOf(caller: CommandCaller): RequestContext {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return caller.factoryContext
}

const officeActor = (caller: CommandCaller): Actor => actorOf(contextOf(caller))

/** The importer, for the caller; an unknown key is a 400 at start and "not found" for a job. */
function adapterOf(key: string): ImportAdapter | undefined {
  return processImporters().get(key)
}

/** May see this job: imports.view and the importer's view permission, for its company. */
function maySee(actor: Actor, adapter: ImportAdapter | undefined, companyId: string | null): boolean {
  return adapter !== undefined && can(actor, IMPORTS_VIEW, { companyId }) && can(actor, adapter.viewPermission, { companyId })
}

/** The job as the caller may see it; anything else is not found. */
async function readVisible(caller: CommandCaller, jobId: string): Promise<{ row: JobRow; adapter: ImportAdapter }> {
  if (!isUuid(jobId)) throw new NotFoundError('Import not found.')
  const row = await caller.withClient((client) => client.importJob.findUnique({ where: { id: jobId }, select: JOB_SELECT }))
  const adapter = row ? adapterOf(row.importerKey) : undefined
  if (!row || !adapter || !maySee(officeActor(caller), adapter, row.companyId)) throw new NotFoundError('Import not found.')
  return { row, adapter }
}

/** The importer's own refusals for this person, job and mapped columns (registry.ts `authorize`); empty: none. */
export function adapterRefusals(adapter: ImportAdapter, actor: Actor, companyId: string | null, columns: readonly string[]): Issue[] {
  return adapter.authorize ? [...adapter.authorize(actor, { companyId }, [...new Set(columns)])] : []
}

/** The columns a job's layout maps (the dry run's reading of the sheet). */
export const mappedColumns = (layout: Layout | null): string[] => (layout?.columns ?? []).map((entry) => entry.column)

const NEEDS_MORE = 'This import needs more than your roles give here: see the issues.'

/** The grains a person lacks for the money columns a job maps, as issues (empty: they may). */
export function unheldGrainIssues(adapter: ImportAdapter, layout: Layout | null, held: ReadonlySet<Grain> | readonly string[]): Issue[] {
  const has = (grain: Grain) => (held instanceof Set ? held.has(grain) : (held as readonly string[]).includes(grain))
  return (layout?.columns ?? []).flatMap(({ header, column }) => {
    const grain = adapter.importer.columns[column]?.grain
    return grain && !has(grain)
      ? [{ path: `column/${column}`, message: `The column "${header}" holds ${grain} values (the ${grain} money grain), which may not be imported without that grain.` }]
      : []
  })
}

// ---- reads ------------------------------------------------------------------------------------------------------------

export function listImporters(caller: CommandCaller) {
  const actor = officeActor(caller)
  return processImporters()
    .list()
    .filter((adapter) => can(actor, adapter.viewPermission) || can(actor, adapter.permission))
    .map(({ importer }) => ({
      key: importer.key,
      label: importer.label,
      description: importer.description,
      columns: Object.entries(importer.columns).map(([name, column]) => {
        const meta = cellMetaOf(column.type)
        return {
          name,
          label: column.label,
          aliases: [...(column.aliases ?? [])],
          required: column.required === true,
          grain: column.grain ?? null,
          describe: meta?.describe ?? null,
          values: meta?.values ? [...meta.values] : null,
          description: column.description ?? null,
        }
      }),
      keyColumns: [...importer.keyColumns],
      maxRows: importer.maxRows,
    }))
}

export async function getImport(caller: CommandCaller, jobId: string): Promise<JobView> {
  return viewOf((await readVisible(caller, jobId)).row)
}

export async function listImports(
  caller: CommandCaller,
  query: { readonly status?: JobView['status'] | undefined; readonly importerKey?: string | undefined; readonly before?: string | undefined; readonly limit?: number | undefined },
): Promise<JobView[]> {
  const actor = officeActor(caller)
  const keys = processImporters()
    .list()
    .filter((adapter) => can(actor, adapter.viewPermission))
    .map((adapter) => adapter.importer.key)
  const where: Prisma.ImportJobWhereInput = {
    AND: [
      scopeWhere(actor, IMPORTS_VIEW, { company: { field: 'companyId', nullable: true } }) as Prisma.ImportJobWhereInput,
      { importerKey: { in: query.importerKey ? keys.filter((key) => key === query.importerKey) : keys } },
      ...(query.status ? [{ status: query.status }] : []),
      ...(query.before ? [{ id: { lt: query.before } }] : []),
    ],
  }
  const rows = await caller.withClient((client) => client.importJob.findMany({ where, select: JOB_SELECT, orderBy: { id: 'desc' }, take: query.limit ?? 50 }))
  return rows.filter((row) => maySee(actor, adapterOf(row.importerKey), row.companyId)).map(viewOf)
}

const ROW_SELECT = {
  rowNumber: true,
  action: true,
  key: true,
  recordId: true,
  errors: true,
  before: true,
  after: true,
  outcome: true,
  note: true,
  appliedAt: true,
} as const satisfies Prisma.ImportRowSelect

export async function listRows(
  caller: CommandCaller,
  jobId: string,
  query: { readonly action?: RowAction | undefined; readonly outcome?: RowOutcome | undefined; readonly after?: number | undefined; readonly limit?: number | undefined },
): Promise<{ rows: RowView[]; nextAfter: number | null }> {
  await readVisible(caller, jobId)
  const limit = query.limit ?? 100
  const rows = await caller.withClient((client) =>
    client.importRow.findMany({
      where: { jobId, rowNumber: { gt: query.after ?? 0 }, ...(query.action ? { action: query.action } : {}), ...(query.outcome ? { outcome: query.outcome } : {}) },
      select: ROW_SELECT,
      orderBy: { rowNumber: 'asc' },
      take: limit + 1,
    }),
  )
  const page = rows.slice(0, limit)
  return {
    rows: page.map((row) => ({
      rowNumber: row.rowNumber,
      action: row.action,
      key: row.key,
      recordId: row.recordId,
      errors: (row.errors ?? null) as RowView['errors'],
      before: row.before ?? null,
      after: row.after ?? null,
      outcome: row.outcome,
      note: row.note,
      appliedAt: iso(row.appliedAt),
    })),
    nextAfter: rows.length > limit ? page[page.length - 1]!.rowNumber : null,
  }
}

const csvCell = (value: string | number): string => {
  const text = String(value)
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** The error file (PLT-176 "download an error file"): row, column (the sheet's header), message; never a cell value. */
export async function errorsFile(caller: CommandCaller, jobId: string): Promise<{ name: string; body: string }> {
  const { row: job, adapter } = await readVisible(caller, jobId)
  const headerOf = new Map((layoutOf(job)?.columns ?? []).map((entry) => [entry.column, entry.header]))
  const rows = await caller.withClient((client) =>
    client.importRow.findMany({ where: { jobId, action: 'ERROR' }, select: { rowNumber: true, errors: true }, orderBy: { rowNumber: 'asc' } }),
  )
  const lines = [['row', 'column', 'message'].join(',')]
  for (const row of rows) {
    for (const issue of (row.errors ?? []) as { column?: string; message: string }[]) {
      const column = issue.column ? (headerOf.get(issue.column) ?? adapter.importer.columns[issue.column]?.label ?? issue.column) : ''
      lines.push([row.rowNumber, column, issue.message].map(csvCell).join(','))
    }
  }
  return { name: `import-${job.id}-errors.csv`, body: `﻿${lines.join('\r\n')}\r\n` }
}

// ---- writes -----------------------------------------------------------------------------------------------------------

export interface StartImport {
  readonly importerKey: string
  readonly companyId?: string | null | undefined
  readonly mode?: ImportMode | undefined
  readonly sheetName?: string | null | undefined
  readonly encoding?: CsvEncoding | null | undefined
  readonly numberFormat?: NumberFormat | undefined
  readonly mapping?: Readonly<Record<string, string | null>> | undefined
  readonly file: { readonly originalName: string; readonly contentType: string; readonly sizeBytes: number; readonly sha256: string }
}

export async function startImport(runtime: FilesRuntime, caller: CommandCaller, input: StartImport) {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  const adapter = adapterOf(input.importerKey)
  if (!adapter) throw new ValidationError('There is no such import.', [{ path: 'body/importerKey', message: 'Expected the key of an importer.' }])
  const companyId = input.companyId ?? null
  const mode = input.mode ?? 'DRY_RUN'
  // Running it writes nothing yet, but its plan shows the records' current values: both of the importer's permissions.
  const scope = { companyId }
  if (!can(actor, IMPORTS_RUN, scope) || !can(actor, adapter.permission, scope) || !can(actor, adapter.viewPermission, scope)) throw new ForbiddenError()
  if (mode === 'APPLY' && !can(actor, IMPORTS_APPLY, { companyId })) throw new ForbiddenError('Applying an import at once needs imports.apply.')
  const named = Object.values(input.mapping ?? {}).filter((column): column is string => column !== null && Object.hasOwn(adapter.importer.columns, column))
  const refusals = adapterRefusals(adapter, actor, companyId, named)
  if (refusals.length > 0) throw new DomainError('forbidden', NEEDS_MORE, refusals)
  const problems: Issue[] = []
  const typeProblem = sheetTypeProblem(input.file.contentType, input.file.originalName)
  if (typeProblem) problems.push({ path: 'body/file/contentType', message: typeProblem })
  for (const [header, column] of Object.entries(input.mapping ?? {})) {
    if (column !== null && !Object.hasOwn(adapter.importer.columns, column)) problems.push({ path: `body/mapping/${header}`, message: `This import has no column ${column}.` })
  }
  if (problems.length > 0) throw new ValidationError('The import cannot start.', problems)

  const jobId = newId()
  const { file, upload } = await requestUpload(runtime, caller, {
    companyId,
    recordType: 'ImportJob',
    recordId: jobId,
    kind: 'DOCUMENT',
    originalName: input.file.originalName,
    contentType: input.file.contentType,
    sizeBytes: input.file.sizeBytes,
    sha256: input.file.sha256,
  })
  const grains = [...heldGrains(actor)].sort()
  const { result } = await command(caller, { name: 'imports.create', input: { ...input, jobId, fileId: file.id } }, async ({ tx, audit, now, context: writer }) => {
    const row = await tx.importJob.create({
      data: {
        id: jobId,
        companyId,
        importerKey: adapter.importer.key,
        fileId: file.id,
        sheetName: input.sheetName ?? null,
        encoding: input.encoding ?? null,
        numberFormat: input.numberFormat ?? 'it',
        ...(input.mapping ? { mapping: input.mapping as Prisma.InputJsonValue } : {}),
        grains,
        mode,
        createdAt: now,
        updatedAt: now,
        createdById: writer.audience === 'office' ? writer.actorId : null,
      },
      select: JOB_SELECT,
    })
    audit({
      recordType: 'ImportJob',
      recordId: jobId,
      companyId,
      after: { importerKey: row.importerKey, fileId: file.id, mode, sheetName: row.sheetName, encoding: row.encoding, numberFormat: row.numberFormat, mapping: input.mapping ?? null, grains },
    })
    return viewOf(row)
  })
  return { job: result, upload }
}

export async function applyImport(caller: CommandCaller, jobId: string, input: { readonly version: number }, idempotencyKey?: string): Promise<JobView> {
  const { row: before, adapter } = await readVisible(caller, jobId)
  const context = contextOf(caller)
  const actor = actorOf(context)
  if (!can(actor, IMPORTS_APPLY, { companyId: before.companyId }) || !can(actor, adapter.permission, { companyId: before.companyId })) throw new ForbiddenError()
  const refused = unheldGrainIssues(adapter, layoutOf(before), heldGrains(actor))
  if (refused.length > 0) throw new DomainError('forbidden', 'This import writes money values you may not see; someone who holds their grain must apply it.', refused)
  const refusals = adapterRefusals(adapter, actor, before.companyId, mappedColumns(layoutOf(before)))
  if (refusals.length > 0) throw new DomainError('forbidden', NEEDS_MORE, refusals)
  const { result } = await command(
    caller,
    {
      name: 'imports.apply',
      idempotencyKey,
      input: { jobId, ...input },
      record: {
        type: 'ImportJob',
        id: jobId,
        expectedVersion: input.version,
        transition: {
          machine: importMachine,
          to: 'APPLYING',
          facts: async (tx) => ({ planned: (await tx.importJob.findUniqueOrThrow({ where: { id: jobId }, select: { plannedAt: true } })).plannedAt !== null }),
        },
      },
    },
    async ({ tx, audit, emit, now, record }) => {
      const row = await tx.importJob.update({
        where: { id: jobId },
        data: { mode: 'APPLY', applyRequestedAt: now, applyRequestedById: context.audience === 'office' ? context.actorId : null, error: null },
        select: JOB_SELECT,
      })
      audit({ recordType: 'ImportJob', recordId: jobId, companyId: row.companyId, before: { status: record!.from }, after: { status: row.status, mode: row.mode } })
      emit({ type: 'import.apply_requested', subject: jobId, companyId: row.companyId, payload: { jobId, importerKey: row.importerKey } })
      return viewOf(row)
    },
  )
  return result
}

export async function cancelImport(caller: CommandCaller, jobId: string, input: { readonly version?: number | undefined; readonly reason?: string | undefined }, idempotencyKey?: string): Promise<JobView> {
  const { row: before, adapter } = await readVisible(caller, jobId)
  const actor = officeActor(caller)
  if (!can(actor, IMPORTS_RUN, { companyId: before.companyId }) || !can(actor, adapter.permission, { companyId: before.companyId })) throw new ForbiddenError()
  const { result } = await command(
    caller,
    {
      name: 'imports.cancel',
      idempotencyKey,
      input: { jobId, ...input },
      record: { type: 'ImportJob', id: jobId, ...(input.version === undefined ? {} : { expectedVersion: input.version }), transition: { machine: importMachine, to: 'CANCELLED' } },
    },
    async ({ tx, audit, emit, now, record }) => {
      const row = await tx.importJob.update({ where: { id: jobId }, data: { cancelledAt: now }, select: JOB_SELECT })
      audit({ recordType: 'ImportJob', recordId: jobId, companyId: row.companyId, before: { status: record!.from }, after: { status: row.status }, ...(input.reason ? { reason: input.reason } : {}) })
      emit({ type: 'import.cancelled', subject: jobId, companyId: row.companyId, payload: { jobId, importerKey: row.importerKey } })
      return viewOf(row)
    },
  )
  return result
}

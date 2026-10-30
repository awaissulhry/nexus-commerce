import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ConflictError, DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { EXPORT_LIMITS, exportMachine, pickColumns, type AskedColumn, type ExportFormat, type ExportLocale, type ExportStatus } from '@nexus/factory-domain/views/exports'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import { VIEWS_EXPORT } from '@nexus/factory-domain/views/permissions'
import { viewQuery } from '@nexus/factory-domain/views/state'
import { command, type CommandCaller, type CommandTx } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'
import { ApiError } from '../../core/errors'
import { downloadFile, systemCallerOf } from '../files/files'
import { processFiles } from '../files/service'
import type { ExportJobView, RequestExportBody } from './contract'
import { exportFormatsFor, processExportSources } from './registry'
import type { AnyExportSource } from './source'

/**
 * The export jobs of the Office (B-W2a-23; PLT-179): asked by a person for the view they are looking at, run by the
 * worker (./worker.ts), seen and downloaded only by that person. What was asked is kept on the job as the server
 * applied it (ExportJob.query): the screen's address terms and the list read's query they gave, the columns with their
 * headings, the file's title and language, the saved view's name. `omittedColumns` names the columns left out by the
 * person's rights: the file says so above its header.
 *
 * ExportJob.viewId stays null: the reference to SavedView is Restrict and a job is never deleted (nor its viewId
 * changed), so a view once exported could never be removed; the view's NAME is kept in the query instead.
 */

/** What the job keeps of the request (ExportJob.query). */
export interface ExportQuery {
  readonly address: string
  readonly params: unknown
  readonly columns: readonly AskedColumn[]
  readonly title: string
  readonly locale: ExportLocale
  readonly viewName: string | null
}

export const JOB = {
  id: true,
  companyId: true,
  requestedById: true,
  listKey: true,
  format: true,
  query: true,
  omittedColumns: true,
  status: true,
  rowsDone: true,
  rowCount: true,
  fileId: true,
  startedAt: true,
  finishedAt: true,
  failureReason: true,
  expiresAt: true,
  version: true,
  createdAt: true,
  file: { select: { id: true, originalName: true, sizeBytes: true, status: true } },
} as const satisfies Prisma.ExportJobSelect
export type JobRow = Prisma.ExportJobGetPayload<{ select: typeof JOB }>

/** The job's query as stored (a row written by this module; anything else reads as empty). */
export function queryOf(row: Pick<JobRow, 'query'>): ExportQuery {
  const value = (row.query ?? {}) as Partial<ExportQuery>
  return {
    address: typeof value.address === 'string' ? value.address : '',
    params: value.params ?? {},
    columns: Array.isArray(value.columns) ? value.columns.filter((column): column is AskedColumn => typeof column?.key === 'string' && typeof column?.label === 'string') : [],
    title: typeof value.title === 'string' ? value.title : '',
    locale: value.locale === 'en' ? 'en' : 'it',
    viewName: typeof value.viewName === 'string' ? value.viewName : null,
  }
}

export function jobViewOf(row: JobRow): ExportJobView {
  const query = queryOf(row)
  const omitted = new Set(row.omittedColumns)
  return {
    id: row.id,
    listKey: row.listKey,
    format: row.format as ExportFormat,
    status: row.status as ExportStatus,
    title: query.title,
    viewName: query.viewName,
    columns: query.columns.filter((column) => !omitted.has(column.key)).map(({ key, label }) => ({ key, label })),
    omitted: query.columns.filter((column) => omitted.has(column.key)).map(({ key, label }) => ({ key, label })),
    rowsDone: row.rowsDone,
    rowCount: row.rowCount,
    failureReason: row.failureReason,
    file: row.file && row.status === 'DONE' && row.file.status === 'AVAILABLE' ? { id: row.file.id, name: row.file.originalName, sizeBytes: row.file.sizeBytes } : null,
    createdAt: toUtcIso(row.createdAt),
    startedAt: row.startedAt ? toUtcIso(row.startedAt) : null,
    finishedAt: row.finishedAt ? toUtcIso(row.finishedAt) : null,
    expiresAt: row.expiresAt ? toUtcIso(row.expiresAt) : null,
    version: row.version,
  }
}

function officeOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new ApiError('unauthenticated')
  if (context.audience !== 'office') throw new ApiError('forbidden')
  return context
}

export function sourceOf(listKey: string): AnyExportSource {
  const source = processExportSources().get(listKey)
  if (!source) throw new NotFoundError('This list has no export.')
  return source
}

/** The list's read query of an address (the source's), a bad term in the list's own words. */
export function paramsOf(source: AnyExportSource, address: string): unknown {
  try {
    return source.query(new URLSearchParams(address))
  } catch (error) {
    if (error instanceof DomainError) throw new ValidationError(error.message, [{ path: 'body/query', message: error.message }])
    throw error
  }
}

/**
 * Moves a job (inside a command whose record guard locked it: `record: { type: 'ExportJob', id }`): the move checked
 * against factory-domain's exportMachine, the state and what it needs in ONE update (the database checks each row at
 * once: RUNNING has its start, DONE its count and file, FAILED its reason). A move the job cannot make (it moved on
 * meanwhile) is an InvalidStateError. Returns the state it left.
 */
export async function moveJob(tx: CommandTx, jobId: string, to: ExportStatus, data: Prisma.ExportJobUncheckedUpdateInput = {}): Promise<ExportStatus> {
  const row = await tx.exportJob.findUniqueOrThrow({ where: { id: jobId }, select: { status: true } })
  assertTransition(exportMachine, row.status, to, undefined)
  await tx.exportJob.update({ where: { id: jobId }, data: { ...data, status: to }, select: { id: true } })
  return row.status as ExportStatus
}

/** Exports one person may run at once. */
export const ACTIVE_EXPORTS = 3

/** exports.request: the view the person is looking at, QUEUED for the worker (event export.requested). */
export async function requestExport(caller: CommandCaller, body: RequestExportBody, idempotencyKey?: string): Promise<ExportJobView> {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const companyId = context.companyId ?? null
  const source = sourceOf(body.listKey)
  if (!exportFormatsFor(body.listKey).includes(body.format)) throw new ValidationError('This list does not export to that format.', [{ path: 'body/format', message: body.format }])
  if (!can(actor, VIEWS_EXPORT, companyId ? { companyId } : {})) throw new ForbiddenError('Exporting a list needs views.export.')
  if (!can(actor, source.permission, companyId ? { companyId } : {})) throw new ForbiddenError('You may not see this list.')
  const address = viewQuery(body.query)
  const params = paramsOf(source, address)
  const picked = pickColumns(source.columns, body.columns, heldGrains(actor))
  if (picked.columns.length === 0) {
    throw new ValidationError(picked.omitted.length > 0 ? 'Every column of this view needs a right you do not hold: nothing to write.' : 'No column of this view can be written to a file.', [{ path: 'body/columns', message: 'no column' }])
  }
  const asked: AskedColumn[] = [...picked.columns, ...picked.omitted].map(({ key, label }) => ({ key, label }))
  const order = new Map(body.columns.map((column, index) => [column.key, index]))
  asked.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0))
  const query: ExportQuery = { address, params, columns: asked, title: body.title, locale: body.locale, viewName: body.viewName ?? null }
  const { result } = await command(caller, { name: 'exports.request', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    // Inside the work: a repeated Idempotency-Key answers before this check.
    const active = await tx.exportJob.count({ where: { requestedById: context.actorId, status: { in: ['QUEUED', 'RUNNING'] } } })
    if (active >= ACTIVE_EXPORTS) throw new ConflictError(`You have ${active} exports running: wait for one to finish.`)
    const id = newId()
    const row = await tx.exportJob.create({
      data: {
        id,
        companyId,
        requestedById: context.actorId,
        listKey: body.listKey,
        viewId: null,
        format: body.format,
        query: query as unknown as Prisma.InputJsonValue,
        omittedColumns: picked.omitted.map((column) => column.key),
        status: 'QUEUED',
        createdAt: now,
        updatedAt: now,
      },
      select: JOB,
    })
    tools.audit({
      recordType: 'ExportJob',
      recordId: id,
      companyId,
      after: { listKey: body.listKey, format: body.format, title: body.title, address, columns: picked.columns.map((column) => column.key), omittedColumns: picked.omitted.map((column) => column.key), viewName: body.viewName ?? null, status: 'QUEUED' },
    })
    tools.emit({ type: 'export.requested', subject: id, companyId, payload: { jobId: id, listKey: body.listKey, format: body.format, requestedById: context.actorId } })
    return jobViewOf(row)
  })
  return result
}

/** One of the person's own jobs (anyone else's is one 404). */
async function ownJob(caller: CommandCaller, exportId: string): Promise<JobRow> {
  const context = officeOf(caller)
  const row = await caller.withClient((client) => client.exportJob.findUnique({ where: { id: exportId }, select: JOB }))
  if (!row || row.requestedById !== context.actorId) throw new NotFoundError('Export not found.')
  return row
}

export async function getExport(caller: CommandCaller, exportId: string): Promise<ExportJobView> {
  return jobViewOf(await ownJob(caller, exportId))
}

/** The person's latest exports (of one list, when named), newest first. */
export async function listExports(caller: CommandCaller, listKey?: string): Promise<ExportJobView[]> {
  const context = officeOf(caller)
  const rows = await caller.withClient((client) =>
    client.exportJob.findMany({ where: { requestedById: context.actorId, ...(listKey ? { listKey } : {}) }, select: JOB, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: EXPORT_LIMITS.recent }),
  )
  return rows.map(jobViewOf)
}

/** The file of a finished job: a presigned GET (60 s, an attachment), for its owner only. */
export async function downloadExport(request: FastifyRequest, exportId: string) {
  const row = await ownJob(request, exportId)
  if (row.status === 'EXPIRED') throw new InvalidStateError(`This export's file was deleted after ${EXPORT_LIMITS.keepDays} days: export the list again.`)
  if (row.status !== 'DONE' || !row.fileId) throw new InvalidStateError('This export has no file yet.')
  return downloadFile(processFiles(), { caller: request, system: systemCallerOf(request) }, row.fileId)
}

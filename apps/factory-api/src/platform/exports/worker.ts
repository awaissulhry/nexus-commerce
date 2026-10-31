import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { ConflictError, DomainError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { EXPORT_CONTENT_TYPES, EXPORT_LIMITS, exportFileName, omittedNote, type ExportCell } from '@nexus/factory-domain/views/exports'
import { totalAfter } from '@nexus/factory-domain/views/export/progress'
import type { ReimportCell } from '@nexus/factory-domain/views/export/reimport'
import type { ImportColumn } from '@nexus/factory-domain/imports/importer'
import { VIEWS_EXPORT } from '@nexus/factory-domain/views/permissions'
import { command, type CommandCaller } from '../../core/command'
import type { OfficeContext } from '../../core/context'
import { serverClock, type Clock } from '../../core/time'
import { heldRoles } from '../auth/roles/access'
import { putGeneratedFile, recordGeneratedFile } from '../files/files'
import { KIND_RULES } from '../files/rules'
import { processFiles, type FilesRuntime } from '../files/service'
import { defineHandler, type EventHandler } from '../outbox/dispatch'
import { JOB, moveJob, queryOf, sourceOf, type JobRow } from './jobs'
import { exportMailHandler } from './mail'
import { reimportAdapterOf, reimportColumns, reimportPage, writeReimport } from './reimport'
import { rowIdOf, type AnyExportSource, type ExportReadOptions } from './source'
import { writeExport } from './writer'

/**
 * The worker's half of an export (B-W2a-23; PLT-179). Handler `exports.run`, on `export.requested`, in the job's tenant's
 * system context:
 *
 *   1. exports.start: QUEUED → RUNNING (startedAt); a retry finds it RUNNING and starts again from the first row.
 *   2. The person who asked, as their live roles make them NOW (two-factor taken as proved: the session that asked had
 *      to hold these rights; a person no longer ACTIVE has none): they must still hold views.export and the list's own
 *      permission over the job's company, and every column's grain the file was asked with.
 *   3. W2b (B-W2b-11; PLT-184): the rows are COUNTED before the run — the source's own count, else by reading the
 *      list once without writing (the first page is kept when it is the whole list) — and the total is kept on the job
 *      (exports.count: rowCount), so the screen shows "38 of 61"; a count above EXPORT_LIMITS.maxRows (or the
 *      importer's most rows, for a re-import file) refuses the export before anything is written.
 *   4. The list is read through its source (the module's own list read) as that person: an office context with their
 *      grants over the tenant's system client, page by page in the list's order, until its end or EXPORT_LIMITS.maxRows
 *      (then FAILED: narrow the view). The progress (rowsDone, the total raised when the list grew meanwhile) is
 *      written at most every few seconds. A "Full file for re-import" reads each page's records again through the
 *      list's importer (./reimport.ts) and writes the importer's layout. B-W2b-13 (Z16:02): an export of the SELECTED
 *      rows (the job's `ids`) keeps only the view's rows whose id (the source's idOf, else `id`) was selected; their
 *      number is the total (no count read); none of them left in the view → FAILED (NONE_SELECTED).
 *   5. The file (./writer.ts, ./reimport.ts) is put in the tenant's store, then ONE command exports.finish records the StoredFile of
 *      the job (recordType ExportJob) and moves RUNNING → DONE with its row count and expiry (keepDays), event
 *      export.finished.
 *
 * Any refusal in words (a DomainError: rights changed, too many rows, a file too large) → FAILED with that reason. Any
 * other failure is retried (a passing failure); after the last attempt → FAILED "The export stopped…" (the cause is in
 * the worker log, never on the job).
 *
 * Listed in background.ts HANDLERS for the worker: ...exportHandlers() (this handler and ./mail.ts's exports.mailLink,
 * which e-mails a long export's link).
 */

export const RUN_HANDLER = 'exports.run'
export const EXPORT_ATTEMPTS = 3

export interface ExportWork {
  readonly files?: FilesRuntime
  readonly lastAttempt?: boolean
  readonly causationId?: string
  readonly clock?: Clock
}

export type ExportOutcome = 'done' | 'failed' | 'settled'

/** A refusal of the export in words: the job fails with it. */
class Refused extends DomainError {
  override name = 'Refused'
  constructor(message: string) {
    super('invalid_state', message)
  }
}

const tenantOf = (caller: CommandCaller): string => {
  const context = caller.factoryContext
  if (!context || context.audience !== 'system') throw new Error('An export runs in a tenant system context.')
  return context.tenantId
}

async function readJob(caller: CommandCaller, jobId: string): Promise<JobRow | null> {
  return caller.withClient((client) => client.exportJob.findUnique({ where: { id: jobId }, select: JOB }))
}

/** exports.fail: QUEUED or RUNNING → FAILED with why. A job that moved on meanwhile is left alone. */
export async function failExport(caller: CommandCaller, job: Pick<JobRow, 'id' | 'companyId' | 'listKey' | 'requestedById'>, reason: string, causationId?: string): Promise<'failed' | 'settled'> {
  try {
    await command(caller, { name: 'exports.fail', input: { jobId: job.id, reason }, causationId, record: { type: 'ExportJob', id: job.id } }, async (tools) => {
      const from = await moveJob(tools.tx, job.id, 'FAILED', { finishedAt: tools.now, failureReason: reason.slice(0, 500) })
      tools.audit({ recordType: 'ExportJob', recordId: job.id, companyId: job.companyId, before: { status: from }, after: { status: 'FAILED', failureReason: reason } })
      tools.emit({ type: 'export.finished', subject: job.id, companyId: job.companyId, payload: { jobId: job.id, listKey: job.listKey, status: 'FAILED', rowCount: null, fileId: null, requestedById: job.requestedById } })
      return { failed: true }
    })
    return 'failed'
  } catch (error) {
    if (error instanceof InvalidStateError) return 'settled'
    throw error
  }
}

/** The person who asked, as their live roles make them now (no person, or one who left: no grants). */
async function requesterOf(caller: CommandCaller, job: JobRow, now: Date): Promise<Actor> {
  const tenantId = tenantOf(caller)
  const grants = await caller.withClient(async (client) => {
    const user = await client.user.findUnique({ where: { id: job.requestedById }, select: { requireMfa: true, status: true } })
    if (!user || user.status !== 'ACTIVE') return []
    return sessionGrants(user, await heldRoles(client, job.requestedById, now), true)
  })
  return { audience: 'office', tenantId, grants }
}

/** Reads as the person: their office context (permission checks, scopes) over the system's client (the same tenant wall). */
function readerFor(system: CommandCaller, job: JobRow, actor: Actor, requestId: string): CommandCaller {
  const context: OfficeContext = Object.freeze({
    audience: 'office',
    tenantId: actor.tenantId!,
    actorId: job.requestedById,
    ...(job.companyId ? { companyId: job.companyId } : {}),
    grants: actor.grants,
    requestId,
  })
  return { factoryContext: context, withClient: (work) => system.withClient(work) }
}

/** The rights the file was asked with, checked again now (a re-import file's columns are its importer's). */
function checkRights(source: AnyExportSource, job: JobRow, actor: Actor, importerColumns: Readonly<Record<string, ImportColumn>> | null): void {
  const scope = job.companyId ? { companyId: job.companyId } : {}
  if (!can(actor, VIEWS_EXPORT, scope) || !can(actor, source.permission, scope)) throw new Refused('You no longer have the right to see or export this list: nothing was exported.')
  const refusal = source.refusal?.(actor) ?? null
  if (refusal) throw new Refused(`${refusal} Nothing was exported.`)
  const grains = heldGrains(actor)
  const omitted = new Set(job.omittedColumns)
  for (const column of queryOf(job).columns) {
    if (omitted.has(column.key)) continue
    const grain = importerColumns ? importerColumns[column.key]?.grain : source.columns[column.key]?.grain
    if (grain && !grains.has(grain)) throw new Refused('Your rights changed since you asked: export the list again.')
  }
}

/** How many rows the view holds: the source's count, else read once without writing. `first`: the page read, when it is the whole list. */
async function countRows(source: AnyExportSource, reader: CommandCaller, params: unknown, max: number, options: ExportReadOptions): Promise<{ count: number; first: { rows: readonly unknown[]; next: string | null } | null }> {
  if (source.count) return { count: await source.count(reader, params), first: null }
  let count = 0
  let cursor: string | null = null
  let pages = 0
  let first: { rows: readonly unknown[]; next: string | null } | null = null
  do {
    const page: { rows: readonly unknown[]; next: string | null } = await source.read(reader, params, cursor, EXPORT_LIMITS.pageSize, options)
    if (pages === 0) first = page
    pages += 1
    count += page.rows.length
    if (count > max) break
    cursor = page.next
  } while (cursor !== null)
  return { count, first: pages === 1 && first?.next === null ? first : null }
}

/** exports.count: the total before the run (RUNNING, nothing written yet). */
async function keepTotal(caller: CommandCaller, job: JobRow, total: number, causationId: string | undefined): Promise<void> {
  await command(caller, { name: 'exports.count', input: { jobId: job.id, rowCount: total }, causationId, record: { type: 'ExportJob', id: job.id } }, async (tools) => {
    const row = await tools.tx.exportJob.findUniqueOrThrow({ where: { id: job.id }, select: { status: true } })
    if (row.status !== 'RUNNING') throw new InvalidStateError('The export is not running any more.')
    await tools.tx.exportJob.update({ where: { id: job.id }, data: { rowsDone: 0, rowCount: total }, select: { id: true } })
    tools.audit({ recordType: 'ExportJob', recordId: job.id, companyId: job.companyId, after: { rowCount: total } })
    return { rowCount: total }
  })
}

/** An export of the selected rows (B-W2b-13) when none of them is in the view any more. */
export const NONE_SELECTED = 'None of the selected rows is in this view any more: export the view instead.'

const tooMany = (max: number, reimport: boolean): string =>
  reimport
    ? `This view has more than ${max.toLocaleString('en-US')} rows, the most one import reads: narrow it with a filter and export it again.`
    : `This view has more than ${max.toLocaleString('en-US')} rows: narrow it with a filter and export it again.`

async function progress(caller: CommandCaller, job: JobRow, rowsDone: number, causationId: string | undefined): Promise<void> {
  await command(caller, { name: 'exports.progress', input: { jobId: job.id, rowsDone }, causationId, record: { type: 'ExportJob', id: job.id } }, async (tools) => {
    const row = await tools.tx.exportJob.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, rowCount: true } })
    if (row.status !== 'RUNNING') throw new InvalidStateError('The export is not running any more.')
    // The list grew since it was counted: the total follows the rows written (never below them).
    const rowCount = totalAfter(row.rowCount, rowsDone)
    await tools.tx.exportJob.update({ where: { id: job.id }, data: { rowsDone, ...(rowCount !== row.rowCount ? { rowCount } : {}) }, select: { id: true } })
    tools.audit({ recordType: 'ExportJob', recordId: job.id, companyId: job.companyId, after: { rowsDone, ...(rowCount !== row.rowCount ? { rowCount } : {}) } })
    return { rowsDone }
  })
}

/** Runs one export (the handler's work; tests call it too). */
export async function runExport(caller: CommandCaller, jobId: string, work: ExportWork = {}): Promise<ExportOutcome> {
  const clock = work.clock ?? serverClock
  const causationId = work.causationId
  let job = await readJob(caller, jobId)
  if (!job || (job.status !== 'QUEUED' && job.status !== 'RUNNING')) return 'settled'
  try {
    if (job.status === 'QUEUED') {
      await command(caller, { name: 'exports.start', input: { jobId }, causationId, record: { type: 'ExportJob', id: jobId } }, async (tools) => {
        await moveJob(tools.tx, jobId, 'RUNNING', { startedAt: tools.now, rowsDone: 0 })
        tools.audit({ recordType: 'ExportJob', recordId: jobId, companyId: job!.companyId, before: { status: 'QUEUED' }, after: { status: 'RUNNING' } })
        return { started: true }
      })
    } else if (job.rowsDone > 0) {
      // A worker that stopped half way: start again from the first row.
      await progress(caller, job, 0, causationId)
    }
    job = (await readJob(caller, jobId))!
    if (job.status !== 'RUNNING') return 'settled'

    const source = sourceOf(job.listKey)
    const query = queryOf(job)
    const actor = await requesterOf(caller, job, clock.now())
    const reimport = job.format === 'XLSX_REIMPORT'
    const adapter = reimport ? reimportAdapterOf(source) : null
    checkRights(source, job, actor, adapter ? (adapter.importer.columns as Readonly<Record<string, ImportColumn>>) : null)
    const reader = readerFor(caller, job, actor, causationId ?? `export-${jobId}`)
    const omitted = new Set(job.omittedColumns)
    const columns = query.columns.filter((column) => !omitted.has(column.key) && (adapter ? true : Object.hasOwn(source.columns, column.key)))
    const words = source.words?.[query.locale] ?? {}
    const say = (code: string): string => words[code] ?? code
    const params = source.query(new URLSearchParams(query.address))
    const options: ExportReadOptions = { locale: query.locale }
    // A re-import file: the importer's layout, as asked (its columns the job kept; a grain lost since was refused above).
    const kept = new Set(columns.map((column) => column.key))
    const layout = adapter ? ((full) => ({ ...full, columns: full.columns.filter((column) => kept.has(column.name)) }))(reimportColumns(adapter, heldGrains(actor)).layout) : null
    const maxRows = layout ? Math.min(EXPORT_LIMITS.maxRows, layout.maxRows) : EXPORT_LIMITS.maxRows

    // B-W2b-13 (Z16:02): the selected rows only (their count is the total; no count read).
    const selected = query.ids ? new Set(query.ids) : null
    const keep = (rows: readonly unknown[]): readonly unknown[] => (selected ? rows.filter((row) => selected.has(rowIdOf(source, row) ?? '')) : rows)
    // The count before the run (PLT-184): the total the screen shows beside the rows written.
    const counted = selected ? { count: selected.size, first: null } : await countRows(source, reader, params, maxRows, options)
    if (counted.count > maxRows) throw new Refused(tooMany(maxRows, reimport))
    await keepTotal(caller, job, counted.count, causationId)

    const rows: ExportCell[][] = []
    const reimportRows: ReimportCell[][] = []
    let cursor: string | null = null
    let wrote = clock.now().getTime()
    let pending = counted.first
    do {
      const page: { rows: readonly unknown[]; next: string | null } = pending ?? (await source.read(reader, params, cursor, EXPORT_LIMITS.pageSize, options))
      pending = null
      const wanted = keep(page.rows)
      if (adapter && layout) reimportRows.push(...(await reimportPage(reader, source, adapter, layout, wanted, job.companyId)))
      else for (const row of wanted) rows.push(columns.map((column) => source.columns[column.key]!.value(row, say)))
      const written = adapter ? reimportRows.length : rows.length
      if (written > maxRows) throw new Refused(tooMany(maxRows, reimport))
      cursor = page.next
      if (cursor !== null && clock.now().getTime() - wrote >= EXPORT_LIMITS.progressEveryMs) {
        await progress(caller, job, written, causationId)
        wrote = clock.now().getTime()
      }
    } while (cursor !== null)
    const count = adapter ? reimportRows.length : rows.length
    if (selected && count === 0) throw new Refused(NONE_SELECTED)

    const now = clock.now()
    const omittedLabels = query.columns.filter((column) => omitted.has(column.key)).map((column) => column.label)
    const body =
      adapter && layout
        ? await writeReimport({ adapter, layout, rows: reimportRows, locale: query.locale })
        : await writeExport({ format: job.format as 'CSV' | 'XLSX' | 'XLSX_REIMPORT', locale: query.locale, title: query.title, note: omittedNote(omittedLabels, query.locale), headings: columns.map((column) => column.label), rows })
    if (body.byteLength > KIND_RULES.DOCUMENT.maxBytes) throw new Refused(`The file would be larger than ${KIND_RULES.DOCUMENT.maxBytes / 1_048_576} MB: narrow the view or show fewer columns, and export it again.`)
    const files = work.files ?? processFiles()
    const prepared = await putGeneratedFile(files, caller, {
      companyId: job.companyId,
      recordType: 'ExportJob',
      recordId: job.id,
      kind: 'DOCUMENT',
      originalName: exportFileName(query.title, job.format as 'CSV', businessDate(now)),
      contentType: EXPORT_CONTENT_TYPES[job.format as 'CSV'],
      body,
    })
    const done = job
    await command(caller, { name: 'exports.finish', input: { jobId, rows: count, sha256: prepared.sha256 }, causationId, record: { type: 'ExportJob', id: jobId } }, async (tools) => {
      const file = await recordGeneratedFile(tools, prepared, { details: { exportJobId: jobId, format: done.format, rows: count } })
      const expiresAt = new Date(tools.now.getTime() + EXPORT_LIMITS.keepDays * 86_400_000)
      await moveJob(tools.tx, jobId, 'DONE', { rowsDone: count, rowCount: count, fileId: file.id, finishedAt: tools.now, expiresAt })
      tools.audit({ recordType: 'ExportJob', recordId: jobId, companyId: done.companyId, before: { status: 'RUNNING' }, after: { status: 'DONE', rowCount: count, fileId: file.id, expiresAt: expiresAt.toISOString() } })
      tools.emit({ type: 'export.finished', subject: jobId, companyId: done.companyId, payload: { jobId, listKey: done.listKey, status: 'DONE', rowCount: count, fileId: file.id, requestedById: done.requestedById } })
      return { fileId: file.id }
    })
    return 'done'
  } catch (error) {
    // The job moved on meanwhile (another attempt finished it, the sweep failed it): nothing to do.
    if (error instanceof InvalidStateError) return 'settled'
    // A clash with a write of the same job (another attempt): a passing failure, tried again.
    if (error instanceof ConflictError && !work.lastAttempt) throw error
    // A refusal in words (rights, size, a filter the list refuses): the job says it.
    if (error instanceof DomainError) return failExport(caller, job, error.message, causationId)
    if (work.lastAttempt) return failExport(caller, job, 'The export stopped before the end (the worker log says why): export the list again.', causationId)
    throw error
  }
}

export function exportHandlers(): EventHandler[] {
  return [
    exportMailHandler(),
    defineHandler({
      name: RUN_HANDLER,
      events: ['export.requested'],
      attempts: EXPORT_ATTEMPTS,
      async handle(event, { caller, attempt }) {
        const { jobId } = event.payload as { jobId: string }
        await runExport(caller, jobId, { lastAttempt: attempt >= EXPORT_ATTEMPTS, causationId: event.eventId })
      },
    }),
  ]
}

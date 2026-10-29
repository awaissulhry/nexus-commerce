import type { Prisma } from '@nexus/factory-db'
import { PRINT_DOCUMENTS, PRINT_LABELS, PRINT_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import { composeLabel, type LabelInput } from '@nexus/factory-domain/labels/model'
import { labelZpl, MAX_LABEL_COPIES } from '@nexus/factory-domain/labels/zpl'
import { tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { RelayError, type PrintRelayKind, type RelayJob } from '../../adapters/print-relay/port'
import { command, type CommandCaller } from '../../core/command'
import { actorOf, type RequestContext } from '../../core/context'
import { getFile } from '../files/files'
import { attachmentDisposition, DOWNLOAD_URL_SECONDS } from '../files/rules'
import type { FilesRuntime } from '../files/service'
import type { PrintJobView } from './contract'
import { contextOf, readPrinter, type PrinterRow } from './printers'
import { isFinalRelayError, MAX_PRINT_ATTEMPTS, printJobMachine, relayMessage, type ModuleLabelKind, type PayloadKind } from './rules'
import type { PrintRelays } from './service'

/**
 * Print jobs (plan A1 §3.9; GAP-007), the flow:
 *
 *   queue      POST /print/jobs/label (print.labels): the label is checked and worded (factory-domain composeLabel: the
 *              scannable id must be this tenant's and of the label's kind) and laid out as ZPL for the printer's stock;
 *              POST /print/jobs/document (print.documents): a PDF StoredFile the caller may see, of the printer's
 *              company. One command `print.queue`: the job QUEUED, its audit row, the event print.job_queued. A floor
 *              device queues only at its own site (row-level security, and can() pins it to its site).
 *   dispatch   the worker's print.dispatch handler (handler.ts) hands the job to its printer's relay
 *              (adapters/print-relay; FAKE records and sends nothing): SENT with the relay's id (`print.markSent`); a
 *              refusal counts a try (`print.recordAttempt`) and the handler tries again with backoff; after
 *              MAX_PRINT_ATTEMPTS tries, or a final refusal, FAILED (`print.fail`)
 *   report     the relay says the printer finished (PRINTED) or could not (FAILED): applyRelayReport (`print.relayReport`)
 *   again      POST /print/jobs/:jobId/retry: FAILED → QUEUED (`print.retry`, the permission that queued it), dispatched again
 *
 * Without a relay (plain printers, the Owner's question 5), nothing is queued: the browser prints the PDF (a file's
 * download, or POST /print/labels/pdf for a label).
 */

const COMMON = {
  id: true,
  companyId: true,
  siteId: true,
  printerId: true,
  recordType: true,
  recordId: true,
  payloadKind: true,
  labelKind: true,
  scanId: true,
  fileId: true,
  copies: true,
  status: true,
  attempts: true,
  lastError: true,
  relayJobId: true,
  sentAt: true,
  printedAt: true,
  failedAt: true,
  requestedById: true,
  deviceId: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.PrintJobSelect
const ONE = { ...COMMON, zpl: true } as const satisfies Prisma.PrintJobSelect

type JobRow = Prisma.PrintJobGetPayload<{ select: typeof COMMON }> & { zpl?: string | null }

const iso = (date: Date | null): string | null => (date === null ? null : toUtcIso(date))

export function jobView(row: JobRow): PrintJobView {
  return {
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    printerId: row.printerId,
    recordType: row.recordType,
    recordId: row.recordId,
    payloadKind: row.payloadKind,
    labelKind: row.labelKind as PrintJobView['labelKind'],
    scanId: row.scanId,
    fileId: row.fileId,
    copies: row.copies,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    relayJobId: row.relayJobId,
    sentAt: iso(row.sentAt),
    printedAt: iso(row.printedAt),
    failedAt: iso(row.failedAt),
    requestedById: row.requestedById,
    deviceId: row.deviceId,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
    ...('zpl' in row ? { zpl: row.zpl ?? null } : {}),
  }
}

const scopeOfJob = (row: { companyId: string; siteId: string }) => ({ companyId: row.companyId, siteId: row.siteId })
/** The permission that queues (and queues again) a job of this payload. */
const permissionFor = (payload: PayloadKind): Permission => (payload === 'ZPL' ? PRINT_LABELS : PRINT_DOCUMENTS)

/** The printer of a new job: visible to the caller, the permission held for its company and site, taking jobs. */
async function printerFor(caller: CommandCaller, printerId: string, permission: Permission): Promise<PrinterRow> {
  const printer = await readPrinter(caller, printerId)
  if (!can(actorOf(contextOf(caller)), permission, scopeOfJob(printer))) throw new ForbiddenError()
  if (printer.status !== 'ACTIVE') throw new InvalidStateError(`This printer is ${printer.status.toLowerCase()}; it takes no jobs now.`)
  return printer
}

/** Who asked, on the job: the office user, or the operator on a floor device with the device. */
function requesterOf(context: RequestContext): { requestedById: string | null; deviceId: string | null; createdById: string | null } {
  if (context.audience === 'office') return { requestedById: context.actorId, deviceId: null, createdById: context.actorId }
  if (context.audience === 'floor') return { requestedById: context.actorId, deviceId: context.deviceId, createdById: context.actorId }
  return { requestedById: null, deviceId: null, createdById: null }
}

interface NewJob {
  readonly printer: PrinterRow
  readonly recordType: string
  readonly recordId: string
  readonly payloadKind: PayloadKind
  readonly copies: number
  readonly labelKind?: string
  readonly scanId?: string
  readonly zpl?: string
  readonly fileId?: string
}

async function queue(caller: CommandCaller, job: NewJob, input: unknown, idempotencyKey: string | undefined): Promise<PrintJobView> {
  const { result } = await command(caller, { name: 'print.queue', idempotencyKey, input }, async ({ tx, audit, emit, now, context }) => {
    // The printer may have been paused since it was read.
    const printer = await tx.printer.findUnique({ where: { id: job.printer.id }, select: { status: true } })
    if (printer?.status !== 'ACTIVE') throw new InvalidStateError('This printer takes no jobs now.')
    const id = newId()
    const row = await tx.printJob.create({
      data: {
        id,
        companyId: job.printer.companyId,
        siteId: job.printer.siteId,
        printerId: job.printer.id,
        recordType: job.recordType,
        recordId: job.recordId,
        payloadKind: job.payloadKind,
        labelKind: job.labelKind ?? null,
        scanId: job.scanId ?? null,
        zpl: job.zpl ?? null,
        fileId: job.fileId ?? null,
        copies: job.copies,
        ...requesterOf(context),
        createdAt: now,
        updatedAt: now,
      },
      select: COMMON,
    })
    audit({
      recordType: 'PrintJob',
      recordId: id,
      companyId: row.companyId,
      siteId: row.siteId,
      after: { printerId: row.printerId, recordType: row.recordType, recordId: row.recordId, payloadKind: row.payloadKind, labelKind: row.labelKind, scanId: row.scanId, fileId: row.fileId, copies: row.copies },
    })
    emit({ type: 'print.job_queued', subject: id, companyId: row.companyId, siteId: row.siteId, payload: { jobId: id, printerId: row.printerId, payloadKind: row.payloadKind } })
    return jobView(row)
  })
  return result
}

export interface QueueLabel {
  readonly printerId: string
  readonly recordType: string
  readonly recordId: string
  readonly copies: number
  readonly label: LabelInput
}

/** print.queue of a label: ZPL for a label printer of a site the caller prints at. */
export async function queueLabel(caller: CommandCaller, input: QueueLabel, idempotencyKey?: string): Promise<PrintJobView> {
  const context = contextOf(caller)
  const printer = await printerFor(caller, input.printerId, PRINT_LABELS)
  if (printer.kind !== 'LABEL_ZPL' || printer.dpi === null || printer.labelWidthMm === null || printer.labelHeightMm === null) {
    throw new ValidationError('This printer prints PDFs.', [{ path: 'body/printerId', message: 'Pick a label printer, or print the label as a PDF (POST /print/labels/pdf).' }])
  }
  if (!Number.isSafeInteger(input.copies) || input.copies < 1 || input.copies > MAX_LABEL_COPIES) {
    throw new ValidationError('The copies are not valid.', [{ path: 'body/copies', message: `Expected 1 to ${MAX_LABEL_COPIES}.` }])
  }
  if (context.audience === 'platform') throw new ForbiddenError()
  const label = composeLabel(input.label, { tenantTag: tenantTag(context.tenantId) })
  const zpl = labelZpl(label, { dpi: printer.dpi, widthMm: printer.labelWidthMm, heightMm: printer.labelHeightMm }, input.copies)
  return queue(
    caller,
    { printer, recordType: input.recordType, recordId: input.recordId, payloadKind: 'ZPL', copies: input.copies, labelKind: label.kind, scanId: label.scanId, zpl },
    input,
    idempotencyKey,
  )
}

/**
 * A label a module lays out itself (the PPE garment label, B-W1-19/44): the module checks its own permission and
 * record, gives the kind and the id printed on it (the batch number, the serial, or SAMPLE for a test label) and makes
 * the ZPL for the printer's stock; the printer, the copies and print.labels are checked here as for any label.
 */
export interface QueueModuleLabel {
  readonly printerId: string
  readonly recordType: string
  readonly recordId: string
  readonly copies: number
  readonly labelKind: ModuleLabelKind
  readonly scanId: string
  readonly zplFor: (stock: { readonly dpi: number; readonly widthMm: number; readonly heightMm: number }) => string
}

export async function queueModuleLabel(caller: CommandCaller, input: QueueModuleLabel, idempotencyKey?: string): Promise<PrintJobView> {
  const context = contextOf(caller)
  const printer = await printerFor(caller, input.printerId, PRINT_LABELS)
  if (printer.kind !== 'LABEL_ZPL' || printer.dpi === null || printer.labelWidthMm === null || printer.labelHeightMm === null) {
    throw new ValidationError('This printer prints PDFs.', [{ path: 'body/printerId', message: 'Pick a label printer, or print the label as a PDF.' }])
  }
  if (!Number.isSafeInteger(input.copies) || input.copies < 1 || input.copies > MAX_LABEL_COPIES) {
    throw new ValidationError('The copies are not valid.', [{ path: 'body/copies', message: `Expected 1 to ${MAX_LABEL_COPIES}.` }])
  }
  if (context.audience === 'platform') throw new ForbiddenError()
  const zpl = input.zplFor({ dpi: printer.dpi, widthMm: printer.labelWidthMm, heightMm: printer.labelHeightMm })
  const { zplFor: _zplFor, ...asked } = input
  return queue(caller, { printer, recordType: input.recordType, recordId: input.recordId, payloadKind: 'ZPL', copies: input.copies, labelKind: input.labelKind, scanId: input.scanId, zpl }, asked, idempotencyKey)
}

/** print.queue of a document: a PDF file of the printer's company that the caller may see, for an A4 printer. */
export async function queueDocument(caller: CommandCaller, input: { printerId: string; fileId: string; copies: number }, idempotencyKey?: string): Promise<PrintJobView> {
  const printer = await printerFor(caller, input.printerId, PRINT_DOCUMENTS)
  if (printer.kind !== 'A4_PDF') throw new ValidationError('This printer prints labels.', [{ path: 'body/printerId', message: 'Pick a printer that prints PDFs.' }])
  // The files module's own check: the caller's audience sees the file (a floor device: shared with its site), files.read.
  const file = await getFile(caller, input.fileId)
  if (file.status !== 'AVAILABLE' || file.contentType !== 'application/pdf') {
    throw new ValidationError('Only an available PDF is printed.', [{ path: 'body/fileId', message: 'Expected an available PDF file.' }])
  }
  if (file.companyId !== null && file.companyId !== printer.companyId) {
    throw new ValidationError('The file belongs to another company.', [{ path: 'body/fileId', message: 'Print it on a printer of its company.' }])
  }
  return queue(caller, { printer, recordType: file.recordType, recordId: file.recordId, payloadKind: 'PDF', copies: input.copies, fileId: file.id }, input, idempotencyKey)
}

async function readJob(caller: CommandCaller, jobId: string, select: Prisma.PrintJobSelect = ONE): Promise<JobRow> {
  if (!isUuid(jobId)) throw new NotFoundError('Print job not found.')
  const row = (await caller.withClient((client) => client.printJob.findUnique({ where: { id: jobId }, select }))) as JobRow | null
  if (!row || !can(actorOf(contextOf(caller)), PRINT_VIEW, scopeOfJob(row))) throw new NotFoundError('Print job not found.')
  return row
}

/** One job, with its ZPL. */
export async function getJob(caller: CommandCaller, jobId: string): Promise<PrintJobView> {
  return jobView(await readJob(caller, jobId))
}

/** The newest jobs the caller may see (a printer's queue, a site's, a record's print history), at most 200. */
export async function listJobs(
  caller: CommandCaller,
  query: { printerId?: string | undefined; siteId?: string | undefined; status?: JobRow['status'] | undefined; recordType?: string | undefined; recordId?: string | undefined },
): Promise<PrintJobView[]> {
  const context = contextOf(caller)
  const where: Prisma.PrintJobWhereInput = {
    AND: [
      scopeWhere(actorOf(context), PRINT_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.PrintJobWhereInput,
      {
        ...(query.printerId ? { printerId: query.printerId } : {}),
        ...(query.siteId ? { siteId: query.siteId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.recordType ? { recordType: query.recordType } : {}),
        ...(query.recordId ? { recordId: query.recordId } : {}),
      },
    ],
  }
  const rows = (await caller.withClient((client) => client.printJob.findMany({ where, select: COMMON, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 }))) as JobRow[]
  return rows.map(jobView)
}

/** print.retry: a FAILED job queued again (its tries counted from 0), with the permission that queued it. */
export async function retryJob(caller: CommandCaller, jobId: string, input: { version: number }, idempotencyKey?: string): Promise<PrintJobView> {
  const before = await readJob(caller, jobId, COMMON)
  if (!can(actorOf(contextOf(caller)), permissionFor(before.payloadKind), scopeOfJob(before))) throw new ForbiddenError()
  await printerFor(caller, before.printerId, permissionFor(before.payloadKind))
  const { result } = await command(
    caller,
    { name: 'print.retry', idempotencyKey, input: { jobId, ...input }, record: { type: 'PrintJob', id: jobId, expectedVersion: input.version, transition: { machine: printJobMachine, to: 'QUEUED' } } },
    async ({ tx, audit, emit }) => {
      const row = await tx.printJob.update({ where: { id: jobId }, data: { attempts: 0, lastError: null, failedAt: null }, select: COMMON })
      audit({ recordType: 'PrintJob', recordId: jobId, companyId: row.companyId, siteId: row.siteId, before: { status: before.status, attempts: before.attempts, lastError: before.lastError }, after: { status: row.status, attempts: 0 } })
      emit({ type: 'print.job_queued', subject: jobId, companyId: row.companyId, siteId: row.siteId, payload: { jobId, printerId: row.printerId, payloadKind: row.payloadKind } })
      return jobView(row)
    },
  )
  return result
}

/** What the worker needs to hand a job over. */
export interface DispatchTools {
  readonly relays: PrintRelays
  /** The files runtime, for a PDF job's download (made only when the relay asks for it). */
  readonly files: () => FilesRuntime
  /** The event that queued the job (the commands' causation). */
  readonly causationId?: string
}

export type DispatchOutcome = 'sent' | 'retry' | 'failed' | 'skipped'

/** The handler's refusal that makes the queue try again later (with backoff). */
export class PrintRetryError extends Error {
  override name = 'PrintRetryError'
}

type Moved = { status: 'SENT'; relayJobId: string } | { status: 'QUEUED' | 'FAILED'; error: string }

/** One move of a dispatched job, its audit row and its event (print.markSent, print.recordAttempt, print.fail). */
async function recordDispatch(caller: CommandCaller, job: JobRow, moved: Moved, causationId?: string): Promise<void> {
  const name = moved.status === 'SENT' ? 'print.markSent' : moved.status === 'FAILED' ? 'print.fail' : 'print.recordAttempt'
  await command(
    caller,
    { name, input: { jobId: job.id, attempt: job.attempts + 1 }, ...(causationId ? { causationId } : {}), record: { type: 'PrintJob', id: job.id } },
    async ({ tx, audit, emit, now }) => {
      // The move and its time in one update (the guard trigger wants a SENT job's sentAt with it), checked on the row
      // the record guard has locked.
      const current = await tx.printJob.findUniqueOrThrow({ where: { id: job.id }, select: { status: true } })
      if (moved.status !== current.status) assertTransition(printJobMachine, current.status, moved.status)
      const data: Prisma.PrintJobUpdateInput =
        moved.status === 'SENT'
          ? { status: 'SENT', attempts: { increment: 1 }, relayJobId: moved.relayJobId, sentAt: now, lastError: null }
          : { status: moved.status, attempts: { increment: 1 }, lastError: moved.error, ...(moved.status === 'FAILED' ? { failedAt: now } : {}) }
      const row = await tx.printJob.update({ where: { id: job.id }, data, select: COMMON })
      audit({
        recordType: 'PrintJob',
        recordId: job.id,
        companyId: row.companyId,
        siteId: row.siteId,
        before: { status: job.status, attempts: job.attempts },
        after: { status: row.status, attempts: row.attempts, relayJobId: row.relayJobId, lastError: row.lastError },
      })
      emit({ type: 'print.job_changed', subject: job.id, companyId: row.companyId, siteId: row.siteId, payload: { jobId: job.id, printerId: row.printerId, status: row.status, attempts: row.attempts } })
      return { jobId: job.id, status: row.status }
    },
  )
}

/**
 * The worker's hand-over of one queued job to its printer's relay (as the tenant's system caller). Anything but a
 * QUEUED job is left alone (a repeated event). Returns what happened; throws PrintRetryError when the queue should try
 * again (a retryable refusal before the last try).
 */
export async function dispatchJob(tools: DispatchTools, caller: CommandCaller, jobId: string): Promise<DispatchOutcome> {
  const context = contextOf(caller)
  if (context.audience !== 'system' && context.audience !== 'office') throw new ForbiddenError()
  const job = (await caller.withClient((client) =>
    client.printJob.findUnique({ where: { id: jobId }, select: { ...ONE, printer: { select: { id: true, code: true, kind: true, relay: true, relayTarget: true, status: true } } } }),
  )) as (JobRow & { printer: { id: string; code: string; kind: 'LABEL_ZPL' | 'A4_PDF'; relay: PrintRelayKind; relayTarget: string; status: string } }) | null
  if (!job || job.status !== 'QUEUED') return 'skipped'

  const relay = tools.relays.relayFor(job.printer.relay)
  const fail = async (error: string): Promise<DispatchOutcome> => {
    await recordDispatch(caller, job, { status: 'FAILED', error }, tools.causationId)
    return 'failed'
  }
  if (!relay) return fail('No print relay serves this printer here.')
  try {
    if (job.printer.status !== 'ACTIVE') throw new PrintRetryError(`The printer is ${job.printer.status.toLowerCase()}.`)
    const submission = await relay.submit(await relayJobOf(tools, caller, job))
    await recordDispatch(caller, job, { status: 'SENT', relayJobId: submission.relayJobId }, tools.causationId)
    return 'sent'
  } catch (error) {
    const message = error instanceof PrintRetryError ? error.message : relayMessage(error)
    if (isFinalRelayError(error) || job.attempts + 1 >= MAX_PRINT_ATTEMPTS) return fail(message)
    await recordDispatch(caller, job, { status: 'QUEUED', error: message }, tools.causationId)
    throw new PrintRetryError(message)
  }
}

async function relayJobOf(tools: DispatchTools, caller: CommandCaller, job: JobRow & { printer: { id: string; code: string; kind: 'LABEL_ZPL' | 'A4_PDF'; relayTarget: string } }): Promise<RelayJob> {
  const context = contextOf(caller)
  const base = {
    jobId: job.id,
    tenantId: context.audience === 'platform' ? '' : context.tenantId,
    siteId: job.siteId,
    printer: { id: job.printer.id, code: job.printer.code, kind: job.printer.kind, target: job.printer.relayTarget },
    copies: job.copies,
  }
  if (job.payloadKind === 'ZPL') return { ...base, payload: { kind: 'ZPL', zpl: job.zpl ?? '' } }
  const file = await caller.withClient((client) =>
    client.storedFile.findUnique({ where: { id: job.fileId ?? '' }, select: { id: true, sha256: true, sizeBytes: true, contentType: true, originalName: true, storeAccountId: true, storageKey: true, status: true } }),
  )
  if (!file || file.status !== 'AVAILABLE') throw new PrintRetryError('The document is not available.')
  return {
    ...base,
    payload: {
      kind: 'PDF',
      fileId: file.id,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      async download() {
        const runtime = tools.files()
        return runtime.storage.presignDownload(caller, file.storeAccountId, {
          key: file.storageKey,
          contentType: file.contentType,
          disposition: attachmentDisposition(file.originalName),
          expiresInSeconds: DOWNLOAD_URL_SECONDS,
          now: runtime.clock.now(),
        })
      },
    },
  }
}

/**
 * What a relay reports about a job it has: the printer finished it (PRINTED) or could not (FAILED). A real relay's
 * report arrives through its own path (the plant relay's API, or a provider's webhook through the inbound ledger) and
 * lands here, as the tenant's system caller. A report about a job in another state is refused (409).
 */
export async function applyRelayReport(caller: CommandCaller, report: { jobId: string; outcome: 'PRINTED' | 'FAILED'; message?: string }): Promise<PrintJobView> {
  const context = contextOf(caller)
  if (context.audience !== 'system' && context.audience !== 'office') throw new ForbiddenError()
  if (!isUuid(report.jobId)) throw new NotFoundError('Print job not found.')
  const { result } = await command(caller, { name: 'print.relayReport', input: report, record: { type: 'PrintJob', id: report.jobId } }, async ({ tx, audit, emit, now }) => {
    const current = await tx.printJob.findUniqueOrThrow({ where: { id: report.jobId }, select: { status: true } })
    assertTransition(printJobMachine, current.status, report.outcome)
    const data: Prisma.PrintJobUpdateInput =
      report.outcome === 'PRINTED'
        ? { status: 'PRINTED', printedAt: now }
        : { status: 'FAILED', failedAt: now, lastError: relayMessage(new RelayError(report.message ?? 'The relay could not print it.')) }
    const row = await tx.printJob.update({ where: { id: report.jobId }, data, select: COMMON })
    audit({ recordType: 'PrintJob', recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { status: row.status, lastError: row.lastError } })
    emit({ type: 'print.job_changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { jobId: row.id, printerId: row.printerId, status: row.status, attempts: row.attempts } })
    return jobView(row)
  })
  return result
}

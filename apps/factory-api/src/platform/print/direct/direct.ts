import type { Prisma } from '@nexus/factory-db'
import { PRINT_LABELS, PRINT_MANAGE } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import type { Callers } from '../../files/files'
import type { PrinterView, PrintJobView } from '../contract'
import { jobView } from '../jobs'
import { contextOf, printerView, readPrinter } from '../printers'
import { DIRECT_PREFIX, directRelayId, modeProblem, stationFailure, type DirectOutcome, type PrinterMode } from './rules'

/**
 * Direct thermal printing (B-W2b-391; LOG-026; rules.ts). Routes (registered in platform/print/routes.ts, entries in its
 * manifest; the route loader reads no folder under one that has its own routes file):
 *
 *   PUT  /print/printers/:printerId/mode   print.manage (office): DIRECT | RELAY | PDF; DIRECT only for a label printer
 *                                          whose relay target is an address the station's browser reaches (409 in words)
 *   GET  /print/direct/jobs                print.labels: the DIRECT printers the caller prints at, their QUEUED jobs
 *   POST /print/direct/jobs/:jobId/take    print.labels: QUEUED → SENT for the station (its relay id `direct:<device or
 *                                          user>`), answering the ZPL, the copies and the printer's address
 *   POST /print/direct/jobs/:jobId/report  print.labels: the station that took it says PRINTED, or FAILED in its words
 *
 * A floor device holds no update grant on print jobs and reads no printer address: after the checks above (its own site:
 * row-level security; print.labels there: can()), its take and report run as its tenant's system caller, naming the device
 * and the worker on the job's audit row. The worker's dispatch leaves a DIRECT printer's jobs alone (jobs.ts dispatchJob).
 */

const JOB = {
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

const PRINTER = { id: true, siteId: true, code: true, name: true, kind: true, mode: true, status: true, dpi: true, labelWidthMm: true, labelHeightMm: true } as const satisfies Prisma.PrinterSelect

/** Who holds a job at the station: the device on the floor, the person in the office. */
function holderOf(caller: CommandCaller): { deviceId: string | null; actorId: string; audience: 'office' | 'floor' } {
  const context = contextOf(caller)
  if (context.audience === 'office') return { deviceId: null, actorId: context.actorId, audience: 'office' }
  if (context.audience === 'floor') return { deviceId: context.deviceId, actorId: context.actorId, audience: 'floor' }
  throw new ForbiddenError()
}

/** The caller (office) or its tenant as the system (a floor device), for the write. */
function writerOf(callers: Callers): CommandCaller {
  const context = contextOf(callers.caller)
  return context.audience === 'office' ? callers.caller : callers.system(context.audience === 'platform' ? '' : context.tenantId)
}

/** PUT /print/printers/:printerId/mode (print.manage). */
export async function setPrinterMode(caller: CommandCaller, printerId: string, body: { mode: PrinterMode; version: number }, idempotencyKey?: string): Promise<{ printer: PrinterView; mode: PrinterMode; changed: boolean }> {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const before = await readPrinter(caller, printerId)
  if (!can(actorOf(context), PRINT_MANAGE, { companyId: before.companyId, siteId: before.siteId })) throw new ForbiddenError()
  if (before.mode === body.mode) return { printer: printerView(before), mode: before.mode, changed: false }
  const problem = modeProblem({ kind: before.kind, relayTarget: before.relayTarget ?? '' }, body.mode)
  if (problem) throw new ConflictError(problem)
  if (before.status === 'ARCHIVED') throw new ConflictError('This printer is archived: it takes no jobs and keeps its mode.')
  const { result } = await command(
    caller,
    { name: 'print.setMode', idempotencyKey, input: { printerId, ...body }, record: { type: 'Printer', id: printerId, expectedVersion: body.version } },
    async ({ tx, audit }) => {
      const row = await tx.printer.update({
        where: { id: printerId },
        data: { mode: body.mode },
        select: { id: true, companyId: true, siteId: true, code: true, name: true, kind: true, relay: true, relayTarget: true, dpi: true, labelWidthMm: true, labelHeightMm: true, status: true, mode: true, version: true, createdAt: true, updatedAt: true },
      })
      audit({ recordType: 'Printer', recordId: printerId, companyId: row.companyId, siteId: row.siteId, before: { mode: before.mode }, after: { mode: row.mode } })
      return printerView(row)
    },
  )
  return { printer: result, mode: body.mode, changed: true }
}

/** GET /print/direct/jobs (print.labels): the DIRECT printers the caller prints at and their jobs waiting for a station. */
export async function listDirectJobs(caller: CommandCaller, query: { printerId?: string | undefined; siteId?: string | undefined }) {
  const context = contextOf(caller)
  holderOf(caller)
  const scope = scopeWhere(actorOf(context), PRINT_LABELS, { company: 'companyId', site: 'siteId' })
  return caller.withClient(async (client) => {
    const printers = await client.printer.findMany({
      where: { AND: [scope as Prisma.PrinterWhereInput, { mode: 'DIRECT', status: { not: 'ARCHIVED' } }, query.printerId ? { id: query.printerId } : {}, query.siteId ? { siteId: query.siteId } : {}] },
      select: PRINTER,
      orderBy: [{ siteId: 'asc' }, { code: 'asc' }],
      take: 100,
    })
    const jobs =
      printers.length === 0
        ? []
        : await client.printJob.findMany({
            where: { AND: [scope as Prisma.PrintJobWhereInput, { printerId: { in: printers.map((printer) => printer.id) }, status: 'QUEUED' }] },
            select: JOB,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: 200,
          })
    return {
      printers: printers.map((printer) => ({ id: printer.id, siteId: printer.siteId, code: printer.code, name: printer.name, dpi: printer.dpi, labelWidthMm: printer.labelWidthMm, labelHeightMm: printer.labelHeightMm, status: printer.status })),
      jobs: jobs.map((job) => jobView(job)),
    }
  })
}

/** The job and its printer as the caller sees them (404 out of its reach), with print.labels at the job's site (403). */
async function readDirect(caller: CommandCaller, jobId: string) {
  const context = contextOf(caller)
  if (!isUuid(jobId)) throw new NotFoundError('Print job not found.')
  const job = await caller.withClient((client) => client.printJob.findUnique({ where: { id: jobId }, select: { ...JOB, zpl: true, printer: { select: PRINTER } } }))
  if (!job) throw new NotFoundError('Print job not found.')
  if (!can(actorOf(context), PRINT_LABELS, { companyId: job.companyId, siteId: job.siteId })) throw new ForbiddenError()
  if (job.printer.mode !== 'DIRECT') throw new ConflictError(job.printer.mode === 'PDF' ? 'This printer prints from the browser as a PDF: no station sends it a job.' : "This printer is reached through the site's relay: the worker sends it the job, not a station.")
  return job
}

const at = (date: Date | null) => (date ? toUtcIso(date) : '')

/** POST /print/direct/jobs/:jobId/take: the station takes a QUEUED job of a DIRECT printer to send it itself. */
export async function takeDirectJob(callers: Callers, jobId: string, idempotencyKey?: string) {
  const holder = holderOf(callers.caller)
  const job = await readDirect(callers.caller, jobId)
  if (job.status !== 'QUEUED') {
    throw new ConflictError(
      job.status === 'SENT'
        ? `A station took this job at ${at(job.sentAt)}: it is being printed there.`
        : job.status === 'PRINTED'
          ? `This job was printed at ${at(job.printedAt)}: print the label again with a reason to print another.`
          : 'This job failed: send it again first (retry), then take it.',
    )
  }
  if (job.printer.status !== 'ACTIVE') throw new ConflictError(`This printer is ${job.printer.status.toLowerCase()}; it takes no jobs now.`)
  if (job.payloadKind !== 'ZPL' || job.zpl === null) throw new ConflictError('Only a label (ZPL) is sent straight to a printer.')
  const writer = writerOf(callers)
  // The printer's address: a floor device has no grant on it, so it is read here by the writer.
  const address = await writer.withClient((client) => client.printer.findUnique({ where: { id: job.printerId }, select: { relayTarget: true } }))
  if (!address) throw new NotFoundError('Printer not found.')
  const relayJobId = directRelayId(holder)
  const { result } = await command(writer, { name: 'print.directTake', idempotencyKey, input: { jobId, holder: relayJobId }, record: { type: 'PrintJob', id: jobId } }, async ({ tx, audit, emit, now }) => {
    const current = await tx.printJob.findUniqueOrThrow({ where: { id: jobId }, select: { status: true } })
    if (current.status !== 'QUEUED') throw new ConflictError('Another station took this job a moment ago: it is being printed there.')
    const row = await tx.printJob.update({ where: { id: jobId }, data: { status: 'SENT', attempts: { increment: 1 }, relayJobId, sentAt: now, lastError: null }, select: JOB })
    audit({
      recordType: 'PrintJob',
      recordId: jobId,
      companyId: row.companyId,
      siteId: row.siteId,
      before: { status: 'QUEUED' },
      after: { status: 'SENT', relayJobId, by: holder.audience, deviceId: holder.deviceId, actorId: holder.actorId },
    })
    emit({ type: 'print.job_changed', subject: jobId, companyId: row.companyId, siteId: row.siteId, payload: { jobId, printerId: row.printerId, status: row.status, attempts: row.attempts } })
    return { job: jobView(row), takenAt: toUtcIso(now) }
  })
  return {
    job: result.job,
    zpl: job.zpl,
    copies: job.copies,
    printer: { id: job.printer.id, code: job.printer.code, name: job.printer.name, address: address.relayTarget, dpi: job.printer.dpi, labelWidthMm: job.printer.labelWidthMm, labelHeightMm: job.printer.labelHeightMm },
    takenAt: result.takenAt,
  }
}

/** POST /print/direct/jobs/:jobId/report: the station that took the job says it printed, or why it could not. */
export async function reportDirectJob(callers: Callers, jobId: string, body: { outcome: DirectOutcome; message?: string | undefined }, idempotencyKey?: string): Promise<{ job: PrintJobView }> {
  const holder = holderOf(callers.caller)
  const job = await readDirect(callers.caller, jobId)
  if (job.status !== 'SENT' || !job.relayJobId?.startsWith(DIRECT_PREFIX)) {
    throw new ConflictError(job.status === 'QUEUED' ? 'No station has taken this job yet: take it first.' : `This job is ${job.status.toLowerCase()} already: nothing to report.`)
  }
  if (job.relayJobId !== directRelayId(holder)) throw new ConflictError('Another station took this job: that station reports how it went.')
  const { result } = await command(writerOf(callers), { name: 'print.directReport', idempotencyKey, input: { jobId, ...body }, record: { type: 'PrintJob', id: jobId } }, async ({ tx, audit, emit, now }) => {
    const current = await tx.printJob.findUniqueOrThrow({ where: { id: jobId }, select: { status: true } })
    if (current.status !== 'SENT') throw new ConflictError(`This job is ${current.status.toLowerCase()} already: nothing to report.`)
    const data: Prisma.PrintJobUpdateInput = body.outcome === 'PRINTED' ? { status: 'PRINTED', printedAt: now } : { status: 'FAILED', failedAt: now, lastError: stationFailure(body.message) }
    const row = await tx.printJob.update({ where: { id: jobId }, data, select: JOB })
    audit({
      recordType: 'PrintJob',
      recordId: jobId,
      companyId: row.companyId,
      siteId: row.siteId,
      before: { status: 'SENT' },
      after: { status: row.status, lastError: row.lastError, by: holder.audience, deviceId: holder.deviceId, actorId: holder.actorId },
    })
    emit({ type: 'print.job_changed', subject: jobId, companyId: row.companyId, siteId: row.siteId, payload: { jobId, printerId: row.printerId, status: row.status, attempts: row.attempts } })
    return { job: jobView(row) }
  })
  return result
}

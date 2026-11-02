import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { isDocumentLanguage, type DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { LUL_RETENTION_YEARS } from '@nexus/factory-domain/people/close/rules'
import type { StatementSummary } from '@nexus/factory-domain/people/earnings/statement'
import { MYDAY_REFUSALS, officePrinterOf, type MyDayRefusal } from '@nexus/factory-domain/people/myday/rules'
import { myStatementDocument } from '@nexus/factory-domain/people/myday/statement-document'
import { command, type CommandCaller } from '../../../core/command'
import type { FloorContext } from '../../../core/context'
import { companyLegalOf } from '../../../platform/documents/documents'
import { renderDocumentPdf } from '../../../platform/documents/pdf'
import { putGeneratedFile, recordGeneratedFile, type PreparedGeneratedFile } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { floorOf } from '../../production/labour/access'
import { fullName } from '../attendance/store'
import { systemOf } from '../clock/access'
import { monthOfPeriod, periodById } from '../earnings/store'

/**
 * My statement on paper or as a file (B-W2b-68; design floor.myday "Print sends the PDF to the office printer in your name; in
 * phone mode it opens as a PDF", new tab "My statement (PDF)"; c.c. art. 2101 c.3). floor.work with the PIN again, the signed-in
 * worker's own APPROVED statement only: anyone else's answers 404, as one that is not there. The pay tables are office only, so
 * the API reads and writes them in the tenant's system view once the session is checked.
 *
 *   PDF     a person's own phone only: a shared tablet must keep no pay document (its downloads, its tabs). No stored file.
 *   print   any tablet: one command stores the statement's PDF once (`WorkerStatement.fileId`, office only, kept as long as the
 *           LUL) and queues the job on the site's office printer, with the worker and the device on it ("in your name").
 */

class MyDayRefusedError extends ConflictError {
  override name = 'MyDayRefusedError'
  override readonly issues: readonly Issue[]
  constructor(refusal: MyDayRefusal) {
    super(refusal.message)
    this.issues = [
      { path: `refusal/${refusal.code}`, message: refusal.message },
      { path: 'fix', message: refusal.fix },
    ]
  }
}

const notFound = (): NotFoundError => new NotFoundError('Statement not found.')
const languageOf = (locale: string | null | undefined): DocumentLanguage => (isDocumentLanguage(locale) ? locale : 'it')

const STATEMENT = { id: true, companyId: true, siteId: true, payPeriodId: true, employeeId: true, revision: true, status: true, summary: true, earningsAmount: true, makeUpAmount: true, fileId: true, approvedAt: true } as const

/** The signed-in worker's own statement, approved: everything else is refused before a figure is drawn. */
async function ownApproved(system: CommandCaller, context: FloorContext, statementId: string) {
  if (!isUuid(statementId)) throw notFound()
  const found = await system.withClient(async (db) => {
    const worker = await db.worker.findUnique({ where: { id: context.actorId }, select: { employeeId: true } })
    if (!worker?.employeeId) return null
    const row = await db.workerStatement.findFirst({ where: { id: statementId, employeeId: worker.employeeId }, select: STATEMENT })
    if (!row) return null
    const person = (await db.employee.findUnique({ where: { id: row.employeeId }, select: { firstName: true, lastName: true, employeeCode: true, locale: true } }))!
    const period = (await periodById(db, row.payPeriodId))!
    return { row, person, period }
  })
  if (!found) throw notFound()
  if (found.row.status !== 'APPROVED' || !found.row.summary || !found.row.approvedAt) throw new MyDayRefusedError(MYDAY_REFUSALS.NOT_APPROVED)
  return { ...found, approvedAt: found.row.approvedAt, summary: found.row.summary as unknown as StatementSummary }
}

async function drawn(system: CommandCaller, found: Awaited<ReturnType<typeof ownApproved>>): Promise<{ readonly pdf: Buffer; readonly fileName: string }> {
  const { row, person } = found
  const composed = myStatementDocument({
    language: languageOf(person.locale),
    company: await companyLegalOf(system, row.companyId),
    person: { name: fullName(person), code: person.employeeCode },
    month: monthOfPeriod(found.period),
    revision: row.revision,
    approvedOn: businessDate(found.approvedAt),
    summary: found.summary,
    earningsAmount: row.earningsAmount ?? 0,
    makeUpAmount: row.makeUpAmount ?? 0,
  })
  return { pdf: await renderDocumentPdf(composed), fileName: `${composed.meta.title.replace(/[\\/]/g, '-')}.pdf` }
}

/** GET /people/myday/statements/:statementId/pdf. */
export async function myStatementPdf(caller: CommandCaller, statementId: string) {
  const context = floorOf(caller)
  const system = systemOf(caller)
  const device = await system.withClient((db) => db.device.findUnique({ where: { id: context.deviceId }, select: { mode: true } }))
  if (device?.mode !== 'PHONE') throw new MyDayRefusedError(MYDAY_REFUSALS.PHONE_ONLY)
  return drawn(system, await ownApproved(system, context, statementId))
}

/** POST /people/myday/statements/:statementId/print. */
export async function printMyStatement(caller: CommandCaller, statementId: string, idempotencyKey?: string) {
  const context = floorOf(caller)
  if (!idempotencyKey) throw new ValidationError('An Idempotency-Key is required for floor writes.', [{ path: 'headers/idempotency-key', message: 'Required.' }])
  const system = systemOf(caller)
  const found = await ownApproved(system, context, statementId)
  const { row } = found
  const printers = await system.withClient((db) => db.printer.findMany({ where: { siteId: context.siteId, kind: 'A4_PDF', status: 'ACTIVE' }, select: { id: true, code: true, name: true, companyId: true, siteId: true }, take: 2 }))
  const printer = officePrinterOf(printers)
  if (!printer) throw new MyDayRefusedError(MYDAY_REFUSALS.NO_PRINTER)
  const month = monthOfPeriod(found.period)
  let prepared: PreparedGeneratedFile | null = null
  if (row.fileId === null) {
    const { pdf, fileName } = await drawn(system, found)
    const retainUntil = new Date(found.approvedAt)
    retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + LUL_RETENTION_YEARS)
    prepared = await putGeneratedFile(processFiles(), system, { companyId: row.companyId, recordType: 'WorkerStatement', recordId: row.id, kind: 'DOCUMENT', originalName: fileName, contentType: 'application/pdf', body: pdf, visibility: ['OFFICE'], retainUntil })
  }
  const { result } = await command(system, { name: 'people.printMyStatement', idempotencyKey, input: { statementId, workerId: context.actorId, deviceId: context.deviceId } }, async (tools) => {
    const current = await tools.tx.printer.findUnique({ where: { id: printer.id }, select: { status: true } })
    if (current?.status !== 'ACTIVE') throw new MyDayRefusedError(MYDAY_REFUSALS.NO_PRINTER)
    const file = prepared ? await recordGeneratedFile(tools, prepared, { action: 'people.statementFile', details: { month, revision: row.revision } }) : null
    // Two first prints at once: the first file stands, the database names one only.
    if (file) await tools.tx.workerStatement.updateMany({ where: { id: row.id, fileId: null }, data: { fileId: file.id } })
    const fileId = (await tools.tx.workerStatement.findUniqueOrThrow({ where: { id: row.id }, select: { fileId: true } })).fileId!
    const id = newId()
    await tools.tx.printJob.create({
      data: { id, companyId: printer.companyId, siteId: printer.siteId, printerId: printer.id, recordType: 'WorkerStatement', recordId: row.id, payloadKind: 'PDF', fileId, copies: 1, requestedById: context.actorId, deviceId: context.deviceId, createdById: context.actorId, createdAt: tools.now, updatedAt: tools.now },
      select: { id: true },
    })
    tools.audit({ recordType: 'PrintJob', recordId: id, companyId: printer.companyId, siteId: printer.siteId, after: { printerId: printer.id, recordType: 'WorkerStatement', recordId: row.id, payloadKind: 'PDF', fileId, copies: 1, workerId: context.actorId, deviceId: context.deviceId } })
    tools.emit({ type: 'print.job_queued', subject: id, companyId: printer.companyId, siteId: printer.siteId, payload: { jobId: id, printerId: printer.id, payloadKind: 'PDF' } })
    return { job: { id, status: 'QUEUED' }, printer: { code: printer.code, name: printer.name } }
  })
  return result
}

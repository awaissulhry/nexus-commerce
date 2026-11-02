import { ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import { isDocumentLanguage, type DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { LUL_RETENTION_YEARS } from '@nexus/factory-domain/people/close/rules'
import type { StatementSummary } from '@nexus/factory-domain/people/earnings/statement'
import { workerStatementDocument } from '@nexus/factory-domain/people/earnings/statement-document'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { fullName } from '../attendance/store'
import { companyLegalOf } from '../../../platform/documents/documents'
import { renderDocumentPdf } from '../../../platform/documents/pdf'
import { putGeneratedFile, recordGeneratedFile } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { requireRight } from './access'
import { statementOf } from './statements'
import { monthOfPeriod, periodById } from './store'

/**
 * The worker statement's PDF (B-W2b-62; design people.piecerates new tab "Worker statement (PDF)"; c.c. art. 2101 c.3). Only
 * for those with the right (a lead's statement has its money dropped: a PDF without its figures is no statement). Every
 * opening is recorded, as the statement's own. Drawn from the frozen statement row, in the worker's language when it is one
 * the documents are printed in (else Italian). An APPROVED statement's PDF is stored once, as a file of the statement
 * (`WorkerStatement.fileId`, office only, read through this module: platform/files/owned.ts), kept as long as the LUL; a
 * draft or a superseded one carries a banner and is stored nowhere. The same statement gives the same bytes.
 */

export interface StatementPdf {
  readonly pdf: Buffer
  readonly fileName: string
  readonly stored: boolean
}

const languageOf = (locale: string | null | undefined): DocumentLanguage => (isDocumentLanguage(locale) ? locale : 'it')

export async function statementPdf(caller: CommandCaller, statementId: string): Promise<StatementPdf> {
  const { context, row } = await statementOf(caller, statementId)
  requireRight(context, row)
  const { person, period } = await caller.withClient(async (db) => ({
    person: (await db.employee.findUnique({ where: { id: row.employeeId }, select: { firstName: true, lastName: true, employeeCode: true, locale: true } }))!,
    period: (await periodById(db, row.payPeriodId))!,
  }))
  if (!row.summary) throw new ValidationError('This statement has nothing to print yet.', [{ path: 'statement', message: 'Run the period first.' }])
  const month = monthOfPeriod(period)
  const language = languageOf(person.locale)
  const status = row.status as 'DRAFT' | 'APPROVED' | 'SUPERSEDED'
  const on = row.approvedAt ? businessDate(row.approvedAt) : businessDate(serverClock.now())
  const composed = workerStatementDocument({
    language,
    company: await companyLegalOf(caller, row.companyId),
    person: { name: fullName(person), code: person.employeeCode },
    month,
    revision: row.revision,
    status,
    on,
    summary: row.summary as unknown as StatementSummary,
    earningsAmount: row.earningsAmount ?? 0,
    makeUpAmount: row.makeUpAmount ?? 0,
  })
  const pdf = await renderDocumentPdf(composed)
  const fileName = `${composed.meta.title.replace(/[\\/]/g, '-')}.pdf`
  const toStore = status === 'APPROVED' && row.fileId === null
  const prepared = toStore
    ? await putGeneratedFile(processFiles(), caller, {
        companyId: row.companyId,
        recordType: 'WorkerStatement',
        recordId: row.id,
        kind: 'DOCUMENT',
        originalName: fileName,
        contentType: 'application/pdf',
        body: pdf,
        visibility: ['OFFICE'],
        retainUntil: new Date(Date.UTC(row.approvedAt!.getUTCFullYear() + LUL_RETENTION_YEARS, row.approvedAt!.getUTCMonth(), row.approvedAt!.getUTCDate())),
      })
    : null
  // Every opening is a new row of the record: no key, so opening twice is recorded twice.
  await command(caller, { name: 'people.openWorkerStatement', input: { statementId, document: 'PDF', at: Date.now() } }, async (tools) => {
    tools.audit({ action: 'people.openWorkerStatement', recordType: 'WorkerStatement', recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { employeeId: row.employeeId, periodId: row.payPeriodId, revision: row.revision, as: 'HR', document: 'PDF' } })
    if (!prepared) return { statementId }
    const file = await recordGeneratedFile(tools, prepared, { action: 'people.statementFile', details: { month, revision: row.revision } })
    // Two people opening it first at once: the first file stands, the database names one only.
    const named = await tools.tx.workerStatement.updateMany({ where: { id: row.id, fileId: null }, data: { fileId: file.id } })
    if (named.count > 0) tools.audit({ action: 'people.statementFile', recordType: 'WorkerStatement', recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { fileId: file.id, sha256: prepared.sha256 } })
    return { statementId }
  })
  return { pdf, fileName, stored: status === 'APPROVED' }
}

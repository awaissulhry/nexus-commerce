import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { FILES_READ, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { legalFooter, legalLines, legalName } from '@nexus/factory-domain/documents/legal'
import type { CompanyLegal, DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import { PLANT_CHECKS_MANAGE } from '@nexus/factory-domain/plant/statutory/permissions'
import { checkReport, reportFingerprintText, type CheckReportInput, type CheckReportResult } from '@nexus/factory-domain/plant/statutory/report'
import { dayOf, type CheckIntervalUnit, type CheckOutcome } from '@nexus/factory-domain/plant/statutory/rules'
import { command, type CommandCaller } from '../../../core/command'
import { SYSTEM_ACTOR_ID, type OfficeContext, type SystemContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import { completeUpload, downloadFile, putGeneratedFile, recordGeneratedFile, requestUpload, systemCallerOf, type PreparedGeneratedFile } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { renderDiscrepancyReport } from '../../inventory/receipts/report'
import { assertMay, assertMayWrite, officeOf } from '../access'
import { readResult, reportsOf, type Reader, type ResultRow } from './store'

/**
 * A result's report (B-W2b-124; QHS-205; design plant.preventive "Record a check result: report upload", "Check register:
 * report (file)", tab "Check report (PDF) — From a result"; D.Lgs. 81/2008 art. 71: kept at least three years):
 *
 *   POST /plant/checks/results/:id/reports (+ /:fileId/complete)   the outside body's or the technician's report: a PDF
 *        (DOCUMENT) or a certificate (CERTIFICATE) of the result, category CHECK_REPORT, OFFICE only, retained until the
 *        result's keptUntil (plant.checks.manage). The result is append-only: its report is a file of it, added when it comes.
 *   GET  /plant/checks/results/:id/reports/:fileId/download        a presigned look at one report (plant.view)
 *   GET  /plant/checks/results/:id/pdf?language=                   the check report made in memory, "preview" banner
 *   POST /plant/checks/results/:id/pdf {language?}                 keeps it: a GeneratedDocument CHECK_REPORT of the result
 *        (version 1, 2 … per result; the same contents as the newest give it back unchanged), its PDF a DOCUMENT of the
 *        result retained until keptUntil (plant.checks.manage)
 *
 * The files go through platform/files (types, size, presign, the store's check, the scan) as the tenant's system caller
 * holding exactly files.upload (files.read for the look) over the result's company and site, after the module's own check:
 * the person needs plant.checks.manage, not a files right (as the machine's photos, B-W2b-96). The generic file routes
 * cannot set the category, so only this route makes a CHECK_REPORT.
 */

export const RESULT_RECORD = 'MachineCheckResult'
export const REPORT_KIND = 'CHECK_REPORT' as const

/** The tenant's system caller for one result's company and site only. */
function siteCaller(request: FastifyRequest, tenantId: string, owner: { readonly companyId: string; readonly siteId: string }, permissions: readonly Permission[]): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [...permissions], companies: [owner.companyId], sites: [owner.siteId], parties: 'all' }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

/** Retained until the result's keptUntil, when that day is still to come (the store refuses a retention in the past). */
const retentionOf = (keptUntil: Date, now: Date): Date | null => {
  const end = new Date(keptUntil.getTime() + 86_400_000)
  return end > now ? end : null
}

async function knownResult(request: FastifyRequest, resultId: string, write: boolean): Promise<{ context: OfficeContext; result: ResultRow }> {
  const context = officeOf(request)
  const result = isUuid(resultId) ? await request.withClient((client) => readResult(client, resultId)) : null
  if (!result) throw new NotFoundError('Check result not found.')
  assertMay(context, PLANT_VIEW, result, 'Check result')
  if (write) assertMayWrite(context, PLANT_CHECKS_MANAGE, result, 'Reports of check results are added by a role that keeps the statutory checks (plant.checks.manage).')
  return { context, result }
}

export interface ReportBody {
  readonly kind: 'DOCUMENT' | 'CERTIFICATE'
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

/** POST /plant/checks/results/:resultId/reports: the report announced, then the presigned PUT. */
export async function announceReport(files: FilesRuntime, request: FastifyRequest, resultId: string, body: ReportBody, idempotencyKey?: string) {
  const { context, result } = await knownResult(request, resultId, true)
  const retainUntil = retentionOf(result.keptUntil, serverClock.now())
  return requestUpload(
    files,
    siteCaller(request, context.tenantId, result, [FILES_UPLOAD]),
    {
      companyId: result.companyId,
      recordType: RESULT_RECORD,
      recordId: result.id,
      kind: body.kind,
      originalName: body.originalName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
      visibility: ['OFFICE'],
      floorSiteId: null,
      retainUntil: retainUntil ? retainUntil.toISOString() : null,
      category: REPORT_KIND,
    },
    idempotencyKey,
  )
}

/** POST /plant/checks/results/:resultId/reports/:fileId/complete. */
export async function completeReport(files: FilesRuntime, request: FastifyRequest, resultId: string, fileId: string, idempotencyKey?: string) {
  const { context, result } = await knownResult(request, resultId, true)
  const uploader = siteCaller(request, context.tenantId, result, [FILES_UPLOAD])
  const file = isUuid(fileId) ? await uploader.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: RESULT_RECORD, recordId: result.id, category: REPORT_KIND }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('File not found.')
  return { file: await completeUpload(files, uploader, fileId, idempotencyKey) }
}

/** GET /plant/checks/results/:resultId/reports/:fileId/download: a report or a kept PDF of the result. */
export async function downloadReport(files: FilesRuntime, request: FastifyRequest, resultId: string, fileId: string) {
  const { context, result } = await knownResult(request, resultId, false)
  const reader = siteCaller(request, context.tenantId, result, [FILES_READ])
  const file = isUuid(fileId) ? await reader.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: RESULT_RECORD, recordId: result.id, status: 'AVAILABLE' }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('File not found.')
  return { download: await downloadFile(files, { caller: reader, system: systemCallerOf(request) }, file.id) }
}

// ---- the check report (PDF) ---------------------------------------------------------------------------------------------------

const briefOf = (row: { id: string; performedOn: Date; outcome: string; remarks: string | null; performedBy: string; nextDueOn: Date | null; keptUntil: Date; correctionReason: string | null; outsideBody: { legalName: string } | null; corrects: { performedOn: Date } | null; correctedBy: { performedOn: Date }[] }): CheckReportResult => ({
  id: row.id,
  performedOn: dayOf(row.performedOn),
  outcome: row.outcome as CheckOutcome,
  remarks: row.remarks,
  performedBy: row.performedBy,
  outsideBody: row.outsideBody?.legalName ?? null,
  nextDueOn: row.nextDueOn ? dayOf(row.nextDueOn) : null,
  keptUntil: dayOf(row.keptUntil),
  correctsOn: row.corrects ? dayOf(row.corrects.performedOn) : null,
  correctionReason: row.correctionReason,
  correctedOn: row.correctedBy[0] ? dayOf(row.correctedBy[0].performedOn) : null,
})

const REGISTER_SELECT = {
  id: true,
  performedOn: true,
  outcome: true,
  remarks: true,
  performedBy: true,
  nextDueOn: true,
  keptUntil: true,
  correctionReason: true,
  outsideBody: { select: { legalName: true } },
  corrects: { select: { performedOn: true } },
  correctedBy: { select: { performedOn: true } },
} as const

/** What the report prints, read with the caller's client (its letterhead from the Company row, never a request). */
async function reportContents(db: Reader, result: ResultRow, company: CompanyLegal, language: DocumentLanguage): Promise<Omit<CheckReportInput, 'createdAt' | 'sample'>> {
  const machine = (await db.machine.findUnique({ where: { id: result.machineId }, select: { assetNumber: true, make: true, modelName: true, serialNumber: true } }))!
  const type = (await db.machineCheckType.findUnique({ where: { id: result.checkTypeId }, select: { code: true, labelIt: true, labelEn: true, legalBasis: true, retentionYears: true } }))!
  const plan = result.planId ? await db.machineCheckPlan.findUnique({ where: { id: result.planId }, select: { interval: true, intervalUnit: true, nextDueOn: true, status: true } }) : null
  const full = (await db.machineCheckResult.findUnique({ where: { id: result.id }, select: REGISTER_SELECT }))!
  const register = await db.machineCheckResult.findMany({ where: { machineId: result.machineId, checkTypeId: result.checkTypeId }, orderBy: [{ performedOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }], take: 60, select: REGISTER_SELECT })
  // Its reports, and those of the results it corrects (a correction keeps the body's report).
  const chain = [result.id]
  for (let next = result.correctsId; next && !chain.includes(next) && chain.length < 21; ) {
    chain.push(next)
    next = (await db.machineCheckResult.findUnique({ where: { id: next }, select: { correctsId: true } }))?.correctsId ?? null
  }
  const reports = await reportsOf(db, chain)
  return {
    language,
    company: { name: legalName(company, language), lines: legalLines(company, language), legal: legalFooter(company, language) },
    machine: { assetNumber: machine.assetNumber, make: machine.make, modelName: machine.modelName, serialNumber: machine.serialNumber, site: `${result.site.code} ${result.site.name}` },
    checkType: type,
    plan: plan ? { interval: plan.interval, intervalUnit: plan.intervalUnit as CheckIntervalUnit, nextDueOn: dayOf(plan.nextDueOn), ended: plan.status === 'ENDED' } : null,
    result: briefOf(full),
    files: chain.flatMap((id) => (reports.get(id) ?? []).map((file) => file.originalName)),
    register: register.map(briefOf),
  }
}

/** GET /plant/checks/results/:resultId/pdf: made in memory, stored nowhere, with the "preview" banner. */
export async function previewReport(request: FastifyRequest, resultId: string, query: { readonly language?: DocumentLanguage | undefined }) {
  const { result } = await knownResult(request, resultId, false)
  const company = await companyLegalOf(request, result.companyId)
  const contents = await request.withClient((client) => reportContents(client, result, company, query.language ?? 'it'))
  const report = checkReport({ ...contents, createdAt: serverClock.now().toISOString(), sample: true })
  return { pdf: await renderDiscrepancyReport(report), fileName: report.fileName }
}

/** POST /plant/checks/results/:resultId/pdf: keeps the check report as a version (see the file's comment). */
export async function keepReport(files: FilesRuntime, request: FastifyRequest, resultId: string, body: { readonly language?: DocumentLanguage | undefined }, idempotencyKey?: string) {
  const { context, result } = await knownResult(request, resultId, true)
  const language = body.language ?? 'it'
  const company = await companyLegalOf(request, result.companyId)
  const { contents, versions } = await request.withClient(async (client) => ({
    contents: await reportContents(client, result, company, language),
    versions: await client.generatedDocument.findMany({ where: { recordType: RESULT_RECORD, recordId: result.id, kind: REPORT_KIND }, orderBy: { version: 'desc' }, select: { id: true, version: true, fingerprint: true, language: true, fileId: true } }),
  }))
  const fingerprint = createHash('sha256').update(reportFingerprintText(contents)).digest('hex')
  const newest = versions[0]
  const same = (entry: { fingerprint: string; language: string }) => entry.fingerprint === fingerprint && entry.language === language
  // The newest shows exactly this already, or an earlier one does (its file is named again); else the PDF goes to the store.
  let prepared: PreparedGeneratedFile | null = null
  const earlier = newest && same(newest) ? null : (versions.find(same) ?? null)
  if (!(newest && same(newest)) && !earlier) {
    const report = checkReport({ ...contents, createdAt: serverClock.now().toISOString(), sample: false })
    prepared = await putGeneratedFile(files, siteCaller(request, context.tenantId, result, [FILES_UPLOAD]), {
      companyId: result.companyId,
      recordType: RESULT_RECORD,
      recordId: result.id,
      kind: 'DOCUMENT',
      originalName: report.fileName,
      contentType: 'application/pdf',
      body: await renderDiscrepancyReport(report),
      visibility: ['OFFICE'],
      retainUntil: retentionOf(result.keptUntil, serverClock.now()),
    })
  }
  const { result: kept, replayed } = await command(request, { name: 'plant.keepCheckReport', idempotencyKey, input: { resultId, language } }, async (tools) => {
    const { tx, now } = tools
    const scope = { companyId: result.companyId, siteId: result.siteId }
    // One version at a time per result.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.check-report', ${result.id}::uuid), 0))`
    const last = await tx.generatedDocument.findFirst({ where: { recordType: RESULT_RECORD, recordId: result.id, kind: REPORT_KIND }, orderBy: { version: 'desc' }, select: { id: true, version: true, fingerprint: true, language: true, fileId: true, createdAt: true } })
    if (last && same(last)) {
      tools.audit({ action: 'plant.keepCheckReport', recordType: RESULT_RECORD, recordId: result.id, ...scope, after: { generatedDocumentId: last.id, version: last.version, unchanged: true } })
      return { document: { id: last.id, version: last.version, language: last.language, fileId: last.fileId, createdAt: last.createdAt.toISOString() }, made: false }
    }
    const fileId = prepared ? (await recordGeneratedFile(tools, prepared, { details: { documentType: REPORT_KIND, language } })).id : earlier!.fileId
    const id = newId()
    const version = (last?.version ?? 0) + 1
    await tx.generatedDocument.create({ data: { id, ...scope, recordType: RESULT_RECORD, recordId: result.id, kind: REPORT_KIND, version, fingerprint, language, number: null, fileId, createdAt: now, createdById: context.actorId }, select: { id: true } })
    tools.audit({ action: 'plant.keepCheckReport', recordType: RESULT_RECORD, recordId: result.id, ...scope, after: { generatedDocumentId: id, version, language, fileId, fingerprint, reused: prepared === null } })
    return { document: { id, version, language, fileId, createdAt: now.toISOString() }, made: true }
  })
  return { ...kept, replayed }
}

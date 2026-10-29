import { FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { OPENING_REPORTS_RECORD } from '@nexus/factory-domain/inventory/opening/rules'
import { INVENTORY_OPENING_IMPORT } from '@nexus/factory-domain/inventory/permissions'
import { QUALITY_LOTS_TEST } from '@nexus/factory-domain/quality/lab/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { completeUpload, requestUpload } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { processLabResults } from '../../quality/lab/results-store'
import { officeContextOf } from '../ledger/access'

/**
 * The company's opening-stock reports (B-W1-35; QHS-029; REACH Annex XVII entry 47): the PDFs (or scans) of the existing
 * chromium VI test reports, uploaded BEFORE the sheet that names them by file name (column Report file). Each is a
 * CERTIFICATE file of the record `OpeningStock` whose id is the company's (module-owned: platform/files/owned.ts, so only
 * these routes add one), shared with the office only. The import's apply names it as its lots' LabResult file and keeps
 * it ten years (REACH art. 36). Uploading needs inventory.opening.import, quality.lots.test (the evidence of a result)
 * and files.upload over the company; listing inventory.opening.import.
 */

export interface ReportUpload {
  readonly companyId: string
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

/** May the caller add reports for the company (else forbidden; a company it cannot see is not found)? */
async function mayUpload(caller: CommandCaller, companyId: string): Promise<void> {
  const actor = actorOf(officeContextOf(caller))
  const company = isUuid(companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true } })) : null
  if (!company || !can(actor, INVENTORY_OPENING_IMPORT, { companyId })) throw new NotFoundError('Company not found.')
  for (const permission of [QUALITY_LOTS_TEST, FILES_UPLOAD] as const) {
    if (!can(actor, permission, { companyId })) throw new ForbiddenError(`Adding an opening-stock report needs ${permission} over the company.`)
  }
}

/** POST /inventory/opening/reports. */
export async function announceReport(caller: CommandCaller, body: ReportUpload, idempotencyKey?: string) {
  await mayUpload(caller, body.companyId)
  return requestUpload(
    processFiles(),
    caller,
    {
      companyId: body.companyId,
      recordType: OPENING_REPORTS_RECORD,
      recordId: body.companyId,
      kind: 'CERTIFICATE',
      originalName: body.originalName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
    },
    idempotencyKey,
    { viaModule: true },
  )
}

/** POST /inventory/opening/reports/:fileId/complete: the store's HEAD → AVAILABLE (or QUARANTINED with its reason). */
export async function completeReport(caller: CommandCaller, fileId: string, idempotencyKey?: string) {
  const file = isUuid(fileId)
    ? await caller.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: OPENING_REPORTS_RECORD, kind: 'CERTIFICATE' }, select: { companyId: true } }))
    : null
  if (!file?.companyId) throw new NotFoundError('Report not found.')
  await mayUpload(caller, file.companyId)
  return { file: await completeUpload(processFiles(), caller, fileId, idempotencyKey, { viaModule: true }) }
}

/** GET /inventory/opening/reports?companyId: the company's reports, newest first, with how many results rest on each. */
export async function listReports(caller: CommandCaller, companyId: string) {
  const actor = actorOf(officeContextOf(caller))
  if (!can(actor, INVENTORY_OPENING_IMPORT, { companyId })) throw new NotFoundError('Company not found.')
  return caller.withClient(async (client) => {
    const files = await client.storedFile.findMany({
      where: { recordType: OPENING_REPORTS_RECORD, recordId: companyId, companyId, kind: 'CERTIFICATE', status: { not: 'DELETED' } },
      select: { id: true, originalName: true, contentType: true, sizeBytes: true, sha256: true, status: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    })
    const reports = []
    // The lab step's results through its seam (one read per report, one after another on this client).
    for (const file of files) reports.push({ ...file, status: String(file.status), createdAt: toUtcIso(file.createdAt), results: (await processLabResults().byFile(client, file.id)).length })
    return { reports }
  })
}

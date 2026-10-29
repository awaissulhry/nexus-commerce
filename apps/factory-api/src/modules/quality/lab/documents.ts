import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { QUALITY_LOTS_DOCUMENTS } from '@nexus/factory-domain/quality/lab/permissions'
import { documentProblems, type LotDocumentKind } from '@nexus/factory-domain/quality/lab/rules'
import { command, type CommandCaller } from '../../../core/command'
import { completeUpload, requestUpload, retainFilesInCommand } from '../../../platform/files/files'
import { addYears } from '../../../platform/files/rules'
import { processFiles } from '../../../platform/files/service'
import { checklistOf, documentsOf, today } from './read'
import { processLotDocuments, type LotDocumentRow } from './documents-store'
import { lotFor, officeOf, readLot } from './store'
import type { ReportUpload } from './results'

/**
 * A lot's supplier documents (B-W1-34; QHS-030; design lt-docs, rc-docs): the PPE component's certificate or declaration,
 * the tannery's LWG certificate, a fabric test report. quality.lots.documents over the lot's company and site, and
 * files.upload. The file is a CERTIFICATE StoredFile of the Lot (module-owned); what it is goes through the documents seam.
 *
 *   announce  POST /quality/lots/:lotId/documents/upload → files.requestUpload → the presigned PUT. Not on a rejected lot.
 *   attach    POST /quality/lots/:lotId/documents {fileId, kind, validTo?, note?}: the kind and validity checked, the file
 *             confirmed (the store's HEAD), then ONE command on the Lot's row: the document (the seam), the file kept ten
 *             years, the event. A certified PPE component's lot is released only with a valid PPE_CERTIFICATE document.
 */

const RETENTION_YEARS = 10
const RETENTION_WHY = "Reg. (EU) 2016/425 art. 8(3) and REACH art. 36: a lot's supplier documents are kept ten years."

/** POST /quality/lots/:lotId/documents/upload. */
export async function announceDocument(caller: CommandCaller, lotId: string, body: ReportUpload, idempotencyKey?: string) {
  const lot = await lotFor(caller, lotId, QUALITY_LOTS_DOCUMENTS)
  if (lot.qualityStatus === 'REJECTED') throw new InvalidStateError(`Lot ${lot.code} is rejected: it takes no new document.`)
  return requestUpload(
    processFiles(),
    caller,
    { companyId: lot.companyId, recordType: 'Lot', recordId: lot.id, kind: 'CERTIFICATE', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256 },
    idempotencyKey,
    { viaModule: true },
  )
}

export interface AttachDocumentBody {
  readonly fileId: string
  readonly kind: LotDocumentKind
  readonly validTo?: string | null | undefined
  readonly note?: string | null | undefined
}

/** POST /quality/lots/:lotId/documents. */
export async function attachDocument(caller: CommandCaller, lotId: string, body: AttachDocumentBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const lot = await lotFor(caller, lotId, QUALITY_LOTS_DOCUMENTS)
  const problems = documentProblems(body, today())
  if (problems.length > 0) throw new ValidationError('The document is not valid.', problems.map((problem) => ({ path: `body/${problem.path}`, message: problem.message })))
  const file = isUuid(body.fileId)
    ? await caller.withClient((client) => client.storedFile.findFirst({ where: { id: body.fileId, recordType: 'Lot', recordId: lot.id, kind: 'CERTIFICATE', status: { not: 'DELETED' } }, select: { id: true } }))
    : null
  if (!file) throw new NotFoundError('File not found.')
  const confirmed = await completeUpload(processFiles(), caller, file.id, idempotencyKey, { viaModule: true })
  if (confirmed.status !== 'AVAILABLE') throw new ConflictError(`The document did not arrive as announced (${confirmed.quarantineReason ?? confirmed.status}): announce it again and send the file.`)

  // On the Lot's row (no version: attaching changes nothing the lot's decisions compare), FOR UPDATE: a release or a
  // result in flight waits for it, and two attaches of one file take turns.
  const { result } = await command(caller, { name: 'quality.lots.attachDocument', idempotencyKey, input: { lotId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT "id" FROM "Lot" WHERE "id" = ${lot.id}::uuid FOR UPDATE`
    const current = (await readLot(tx, lot.id))!
    if (current.qualityStatus === 'REJECTED') throw new InvalidStateError(`Lot ${current.code} is rejected: it takes no new document.`)
    const attached = await processLotDocuments().list(tx, current.id)
    if (attached.some((row) => row.fileId === file.id && row.status === 'ACTIVE')) throw new ConflictError('This file is attached to the lot already.')
    const row: LotDocumentRow = {
      id: newId(),
      lotId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      itemId: current.itemId,
      kind: body.kind,
      fileId: file.id,
      validTo: body.validTo ?? null,
      status: 'ACTIVE',
      note: body.note?.trim() || null,
      createdAt: toUtcIso(now),
      createdById: context.actorId,
    }
    await processLotDocuments().attach(tools, row)
    await retainFilesInCommand(tools, [file.id], addYears(now, RETENTION_YEARS), RETENTION_WHY)
    tools.emit({ type: 'lot.document_attached', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { lotId: current.id, code: current.code, documentId: row.id, kind: row.kind, fileId: file.id } })
    return { document: row }
  })
  // Read after the commit: the seam's row is written with the command's audit rows, at its end.
  return caller.withClient(async (client) => {
    const day = today()
    const updated = (await readLot(client, lot.id))!
    return { document: result.document, documents: await documentsOf(client, lot.id, day), checklist: await checklistOf(client, context.tenantId, updated, day, context.actorId) }
  })
}

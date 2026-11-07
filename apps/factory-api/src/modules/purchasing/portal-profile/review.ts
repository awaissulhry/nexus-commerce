import type { FactoryClient } from '@nexus/factory-db'
import { InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { dayOf } from '@nexus/factory-domain/files/expiry/rules'
import { isCurrentVersion, nextVersionNo, seriesRootOf } from '@nexus/factory-domain/files/versions/rules'
import { acceptProblems, documentStateOf, isSupplierDocumentCategory, refuseProblems, reuploadDueOf, type SupplierDocumentState } from '@nexus/factory-domain/purchasing/portal-profile/documents'
import { SUPPLIER_DOCUMENTS_REVIEW } from '@nexus/factory-domain/purchasing/portal-profile/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { closeAnsweredExpiryTasks } from '../../../platform/files/expiry/answered'
import { contextOf, prepareFileCopy, readOffice, SELECT_FOR, type OfficeRow } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { seriesOf, supersedeEarlierVersions } from '../../../platform/files/versions/supersede'
import { lockSeries } from '../../../platform/files/versions/versions'
import { closeOne, openTaskInCommand, TASK_COLUMNS } from '../../../platform/portal/tasks/store'
import { ACTIONS, iso, LOOK_BACK_DAYS, lockSupplier, partyUploads, recentUploads, uploadOfFile, type UploadRecord } from './store'
import { refusedFileOf, SUPPLIER_DOCUMENT_SOURCE, supplierDocumentSourceKey } from './task-source'

/**
 * Our check of what suppliers send in the portal (B-W2b-189; SCM-096; design portal.supplier.documents "accepted in the
 * record's files", purchasing.suppliers › Documents & qualification "review"; QHS-112):
 *
 *   GET  /purchasing/supplier-documents?partyId=&state=WAITING|ALL   the uploads of the suppliers the person may check (the
 *                                                       last year), with what the supplier said and the file's state
 *   POST /purchasing/supplier-documents/:fileId/accept {category, expiresOn, replacesFileId?, version}
 *        what it is and until when; it is then SHARED BACK with the supplier (PARTNER, its party) and counts for the
 *        required-document rules. Sent to replace an accepted document (the supplier's word, or the reviewer's), it becomes
 *        that document's NEXT VERSION: a copy of the upload (sourceFileId) born AVAILABLE in the replaced series, which
 *        supersedes the old one in the same command (B-W2b-160) — the old one is kept, the expiry reminders follow the new
 *        date, and the supplier's request for the series closes (B-W2b-177 closeAnsweredExpiryTasks).
 *   POST /purchasing/supplier-documents/:fileId/refuse {reason, version}
 *        the reason the supplier reads; the file stays unshared (kept as received); the supplier is asked to upload it
 *        again (an UPLOAD_DOCUMENT request, source SupplierDocument, due in 14 days, asked by the reviewer)
 *
 * purchasing.supplierDocuments.review over the upload's company and party (administrator, buyer, quality inspector). Each
 * decision is ONE command naming the file with the version the screen showed (two decisions never both commit), with the
 * supplier's row locked; a decision is final.
 */

const DAY_MS = 86_400_000
const dateValue = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

function viewer(caller: CommandCaller) {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new NotFoundError('File not found.')
  return { context, actor: actorOf(context) }
}

async function personName(client: Pick<FactoryClient, 'user'>, id: string): Promise<string | null> {
  return (await client.user.findUnique({ where: { id }, select: { displayName: true } }))?.displayName ?? null
}

const stateOf = (upload: UploadRecord, file: { status: string; quarantineReason: string | null } | undefined, today: BusinessDate): SupplierDocumentState =>
  documentStateOf({
    status: file?.status ?? 'DELETED',
    quarantineReason: file?.quarantineReason ?? null,
    decision: upload.decision === null ? null : upload.decision.kind === 'ACCEPTED' ? 'ACCEPTED' : 'REJECTED',
    expiresOn: upload.decision?.expiresOn ?? upload.expiresOn,
    today,
  })

/** GET /purchasing/supplier-documents. */
export async function listSupplierDocuments(caller: CommandCaller, query: { readonly partyId?: string | undefined; readonly state?: 'WAITING' | 'ALL' | undefined }, now: Date) {
  const { actor } = viewer(caller)
  const today = businessDate(now)
  if (query.partyId !== undefined && !isUuid(query.partyId)) throw new ValidationError('The supplier is not valid.', [{ path: 'querystring/partyId', message: 'A party id.' }])
  return caller.withClient(async (client) => {
    const uploads = (await recentUploads(client, new Date(now.getTime() - LOOK_BACK_DAYS * DAY_MS), query.partyId)).filter((upload) => can(actor, SUPPLIER_DOCUMENTS_REVIEW, { companyId: upload.companyId, partyId: upload.partyId }))
    const files = new Map(
      (uploads.length === 0 ? [] : await client.storedFile.findMany({ where: { id: { in: uploads.map((upload) => upload.fileId) } }, select: { id: true, status: true, quarantineReason: true, originalName: true, contentType: true, sizeBytes: true, version: true } })).map((row) => [row.id, row] as const),
    )
    const replacedIds = [...new Set(uploads.map((upload) => upload.replacesFileId).filter((id): id is string => id !== null))]
    const replaced = new Map(
      (replacedIds.length === 0 ? [] : await client.storedFile.findMany({ where: { id: { in: replacedIds } }, select: { id: true, originalName: true, expiresOn: true, status: true, supersededAt: true } })).map((row) => [row.id, row] as const),
    )
    const parties = new Map(
      (uploads.length === 0 ? [] : await client.party.findMany({ where: { id: { in: [...new Set(uploads.map((upload) => upload.partyId))] } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, row] as const),
    )
    const rows = uploads
      .map((upload) => {
        const file = files.get(upload.fileId)
        const state = stateOf(upload, file, today)
        const old = upload.replacesFileId ? replaced.get(upload.replacesFileId) : undefined
        const party = parties.get(upload.partyId)
        return {
          fileId: upload.fileId,
          party: { id: upload.partyId, code: party?.code ?? '', name: party?.legalName ?? '' },
          companyId: upload.companyId,
          record: { type: upload.recordType, id: upload.recordId, label: upload.recordLabel },
          category: upload.category,
          name: file?.originalName ?? '',
          contentType: file?.contentType ?? '',
          sizeBytes: file?.sizeBytes ?? 0,
          issuer: upload.issuer,
          number: upload.number,
          issuedOn: upload.issuedOn,
          expiresOn: upload.expiresOn,
          articles: [...upload.articles],
          lots: [...upload.lots],
          note: upload.note,
          state,
          sentAt: iso(upload.at),
          sentBy: upload.personName,
          replaces: old ? { fileId: old.id, name: old.originalName, expiresOn: old.expiresOn === null ? null : dayOf(old.expiresOn), current: isCurrentVersion(old) } : null,
          decision: upload.decision
            ? { kind: upload.decision.kind, at: iso(upload.decision.at)!, byName: upload.decision.byName, reason: upload.decision.reason, documentFileId: upload.decision.documentFileId, category: upload.decision.category, expiresOn: upload.decision.expiresOn }
            : null,
          version: file?.version ?? 0,
          mayDecide: upload.decision === null && file !== undefined && file.status !== 'PENDING_UPLOAD' && file.status !== 'DELETED',
        }
      })
      .filter((row) => (query.state === 'ALL' ? row.state !== 'NOT_RECEIVED' : row.state === 'WAITING' || row.state === 'CHECKING' || row.state === 'HELD'))
      .reverse()
    return { rows, counts: { waiting: rows.filter((row) => row.state === 'WAITING').length } }
  })
}

/** The upload and its file as the reviewer may decide them, or why not. */
async function decidable(caller: CommandCaller, fileId: string) {
  const { context, actor } = viewer(caller)
  if (!isUuid(fileId)) throw new NotFoundError('File not found.')
  const upload = await caller.withClient((client) => uploadOfFile(client, fileId))
  if (!upload || !can(actor, SUPPLIER_DOCUMENTS_REVIEW, { companyId: upload.companyId, partyId: upload.partyId })) throw new NotFoundError('File not found.')
  if (upload.decision) throw new InvalidStateError(upload.decision.kind === 'ACCEPTED' ? 'This document was accepted already.' : 'This document was refused already.')
  const file = await readOffice(caller, fileId)
  if (file.status === 'PENDING_UPLOAD' || file.status === 'DELETED') throw new InvalidStateError('This document has not arrived: nothing to check yet.')
  return { context, upload, file }
}

/** Inside a decision's command: the supplier's row locked, then the upload still undecided. */
async function stillOpen(tools: CommandTools, upload: UploadRecord): Promise<void> {
  await lockSupplier(tools.tx, upload.partyId)
  const now = (await partyUploads(tools.tx, upload.partyId)).find((entry) => entry.fileId === upload.fileId)
  if (now?.decision) throw new InvalidStateError(now.decision.kind === 'ACCEPTED' ? 'This document was accepted already.' : 'This document was refused already.')
}

export interface AcceptBody {
  readonly category: string
  readonly expiresOn: string | null
  /** Default: the document the supplier said it replaces; null: none. */
  readonly replacesFileId?: string | null | undefined
  readonly version: number
}

/** The accepted document it replaces: current, of the supplier, of a supplier kind. */
async function replacedOf(caller: CommandCaller, upload: UploadRecord, id: string): Promise<OfficeRow> {
  const old = isUuid(id) ? await readOffice(caller, id).catch(() => null) : null
  if (!old || old.partyId !== upload.partyId || !old.visibility.includes('PARTNER') || !isCurrentVersion({ status: old.status, supersededAt: old.supersededAt ?? null })) {
    throw new ValidationError('The document it replaces is not a current document of this supplier.', [{ path: 'body/replacesFileId', message: 'A current document shared with this supplier.' }])
  }
  if (old.companyId !== null && old.companyId !== upload.companyId) throw new ValidationError('The document it replaces is of another company.', [{ path: 'body/replacesFileId', message: 'A document of the same company.' }])
  return old
}

/** Inside the acceptance: the open requests to send again a refused document of this kind on this record close (DONE). */
async function closeRefusedRequests(tools: CommandTools, upload: UploadRecord, category: string): Promise<void> {
  const open = await tools.tx.partnerTask.findMany({
    where: { recordType: upload.recordType, recordId: upload.recordId, kind: 'UPLOAD_DOCUMENT', status: 'OPEN', sourceKey: { startsWith: `${SUPPLIER_DOCUMENT_SOURCE.prefix}:` } },
    select: TASK_COLUMNS,
    take: 50,
  })
  if (open.length === 0) return
  const uploads = await partyUploads(tools.tx, upload.partyId)
  for (const task of open) {
    const refused = uploads.find((entry) => entry.fileId === refusedFileOf(task.sourceKey))
    if (refused?.category === category) await closeOne(tools, task, 'DONE', upload.personId, false)
  }
}

/** POST /purchasing/supplier-documents/:fileId/accept. */
export async function acceptDocument(caller: CommandCaller, fileId: string, body: AcceptBody, now: Date, idempotencyKey?: string) {
  const { context, upload, file } = await decidable(caller, fileId)
  if (file.status !== 'AVAILABLE') throw new InvalidStateError(file.quarantineReason === 'scan_pending' ? 'The virus scan of this document has not finished: accept it once it has.' : 'This file could not be taken (it did not match what was sent, or the scan refused it): refuse it, saying why.')
  const today = businessDate(now)
  const problems = acceptProblems({ category: body.category, expiresOn: body.expiresOn }, today)
  if (problems.length > 0) throw new ValidationError('The acceptance is not valid.', problems)
  const replacesId = body.replacesFileId === undefined ? upload.replacesFileId : body.replacesFileId
  const old = replacesId ? await replacedOf(caller, upload, replacesId) : null
  // A replacement becomes the replaced document's next version: a copy of the upload, put in the store before the command.
  const prepared = old
    ? await prepareFileCopy(processFiles(), caller, file.id, {
        companyId: old.companyId,
        recordType: old.recordType,
        recordId: old.recordId,
        kind: old.kind as never,
        originalName: file.originalName,
        visibility: ['OFFICE', 'PARTNER'],
        partyId: upload.partyId,
      })
    : null
  const category = body.category
  const expiresOn = body.expiresOn
  const { result } = await command(
    caller,
    { name: 'supplierDocuments.accept', idempotencyKey, input: { fileId, ...body }, record: { type: 'StoredFile', id: fileId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now: at } = tools
      await stillOpen(tools, upload)
      const byName = await personName(tx, context.actorId)
      const expiry = expiresOn === null ? null : dateValue(expiresOn)
      let documentFileId = fileId
      let root = seriesRootOf({ id: file.id, seriesId: file.seriesId ?? null })
      let document = { recordType: file.recordType, recordId: file.recordId, companyId: file.companyId }
      if (old && prepared) {
        root = seriesRootOf({ id: old.id, seriesId: old.seriesId ?? null })
        await lockSeries(tx, root)
        const series = await seriesOf(tx, root)
        if (!series.some((entry) => entry.id === old.id && isCurrentVersion(entry))) throw new InvalidStateError('The document it replaces changed meanwhile: read it again.')
        documentFileId = newId()
        const row = await tx.storedFile.create({
          data: {
            id: documentFileId,
            companyId: prepared.companyId,
            recordType: prepared.recordType,
            recordId: prepared.recordId,
            kind: prepared.kind,
            originalName: prepared.originalName,
            contentType: prepared.contentType,
            sizeBytes: prepared.sizeBytes,
            sha256: prepared.sha256,
            storeAccountId: prepared.storeAccountId,
            storageKey: prepared.storageKey,
            status: 'AVAILABLE',
            availableAt: at,
            visibility: ['OFFICE', 'PARTNER'],
            partyId: upload.partyId,
            retainUntil: prepared.retainUntil,
            seriesId: root,
            versionNo: nextVersionNo(series),
            sourceFileId: file.id,
            category: category as never,
            expiresOn: expiry,
            createdAt: at,
            updatedAt: at,
            createdById: context.actorId,
          },
          select: SELECT_FOR.office,
        })
        document = { recordType: row.recordType, recordId: row.recordId, companyId: row.companyId }
        tools.audit({ action: 'files.requestVersion', recordType: 'StoredFile', recordId: documentFileId, companyId: row.companyId, after: { seriesId: root, versionNo: row.versionNo, sourceFileId: file.id, category, expiresOn, sharedWith: upload.partyId, bySupplier: true } })
        tools.emit({ type: 'file.available', subject: documentFileId, companyId: row.companyId, payload: { fileId: documentFileId, recordType: row.recordType, recordId: row.recordId, kind: row.kind } })
        await supersedeEarlierVersions(tools, documentFileId)
      } else {
        await tx.storedFile.update({
          where: { id: fileId },
          data: { category: category as never, expiresOn: expiry, expiryRemindedAt: null, visibility: ['OFFICE', 'PARTNER'], partyId: upload.partyId, updatedAt: at },
          select: { id: true },
        })
      }
      tools.audit({
        action: 'supplierDocuments.accept',
        recordType: 'StoredFile',
        recordId: documentFileId,
        companyId: document.companyId,
        before: { visibility: file.visibility },
        after: { category, expiresOn, visibility: ['OFFICE', 'PARTNER'], partyId: upload.partyId, uploadFileId: fileId },
      })
      tools.audit({ action: ACTIONS.accept, recordType: 'Party', recordId: upload.partyId, companyId: upload.companyId, after: { fileId, documentFileId, category, expiresOn, byName } })
      // The supplier's request for a new version of this document closes once the new date is beyond the reminders.
      await closeAnsweredExpiryTasks(tools, { root, recordType: document.recordType, recordId: document.recordId, today })
      // A request to send a refused document of this kind again, on this record, is answered too.
      await closeRefusedRequests(tools, upload, category)
      tools.emit({
        type: 'supplier_document.accepted',
        subject: fileId,
        companyId: upload.companyId,
        payload: { fileId, partyId: upload.partyId, recordType: document.recordType, recordId: document.recordId, documentFileId, category, expiresOn },
      })
      return { documentFileId }
    },
  )
  return { fileId, documentFileId: result.documentFileId, state: 'ACCEPTED' as const, category, expiresOn }
}

/** POST /purchasing/supplier-documents/:fileId/refuse. */
export async function refuseDocument(caller: CommandCaller, fileId: string, body: { readonly reason: string; readonly version: number }, now: Date, idempotencyKey?: string) {
  const { context, upload } = await decidable(caller, fileId)
  const problems = refuseProblems(body.reason)
  if (problems.length > 0) throw new ValidationError('The refusal is not valid.', problems)
  if (!isSupplierDocumentCategory(upload.category) || upload.companyId === null) throw new InvalidStateError('This upload is not a supplier document.')
  const reason = body.reason.trim()
  const companyId = upload.companyId
  const today = businessDate(now)
  const { result } = await command(
    caller,
    { name: 'supplierDocuments.refuse', idempotencyKey, input: { fileId, ...body }, record: { type: 'StoredFile', id: fileId, expectedVersion: body.version } },
    async (tools) => {
      await stillOpen(tools, upload)
      const byName = await personName(tools.tx, context.actorId)
      tools.audit({ action: ACTIONS.refuse, recordType: 'Party', recordId: upload.partyId, companyId, reason, after: { fileId, byName } })
      // The supplier is asked to upload it again, on the record the document was for.
      const { task } = await openTaskInCommand(tools, {
        companyId,
        partyId: upload.partyId,
        kind: 'UPLOAD_DOCUMENT',
        record: { type: upload.recordType, id: upload.recordId, label: upload.recordLabel || upload.recordType },
        sourceKey: supplierDocumentSourceKey(fileId),
        dueAt: dateValue(reuploadDueOf(today)),
        askedBy: { id: context.actorId, name: byName ?? 'Our office' },
      })
      tools.emit({ type: 'supplier_document.refused', subject: fileId, companyId, payload: { fileId, partyId: upload.partyId, recordType: upload.recordType, recordId: upload.recordId } })
      return { taskId: task.id }
    },
  )
  return { fileId, state: 'REJECTED' as const, reason, taskId: result.taskId }
}

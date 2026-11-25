import type { FastifyRequest } from 'fastify'
import { PORTAL_UPLOAD } from '@nexus/factory-domain/auth/partners/permissions'
import { FILES_DELETE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { OFFICE_DRAFT_WORDS } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { DRAFT_FILE_CATEGORY, DRAFT_FILE_RECORDS, DRAFT_FILES_MAX, draftFilePartOf, draftFileWords, type DraftFilePart } from '@nexus/factory-domain/sales/portal-ordering/draft-files'
import { portalFileKindOf, portalUploadWords } from '@nexus/factory-domain/threads/partner/uploads'
import type { CommandCaller } from '../../../core/command'
import { completeUpload, deleteFile, requestUpload } from '../../../platform/files/files'
import { assertOutsideUploadsOpen } from '../../../platform/files/multipart/outside'
import { normaliseContentType } from '../../../platform/files/rules'
import type { FilesRuntime } from '../../../platform/files/service'
import { commandOn } from '../../../platform/portal/tasks/clock'
import { partnerUploader } from '../../../platform/threads/partner/service'
import type { DraftWriter } from './writer' // od-s s.2: the portal's session or the office person
import { discardDraft, draftChanged, draftFileView, ownDraft, removeLine, requestView } from './requests'
import { DRAFT_FILE_COLUMNS, draftFilesWhere, readLines, type RequestRow } from './store'
import { markEdited } from './store' // B-CP-075: who saved the draft
import type { CommandTools } from '../../../core/command'

/**
 * B-CP-072 (customer page plan C5, 12 §2 parts 2–4; D14 — O7, the virus scanner's spend, is NOT approved): the files of a draft
 * order in the portal, by whoever keeps the party's drafts (portal.orderDrafts.edit, the route) and holds the upload capability
 * (portal.upload), never an office preview:
 *
 *   POST   /portal/order-requests/:requestId/files                   {part, lineId?, name, type, size, sha256}: the file announced
 *                                                                    and where to PUT its bytes (5 minutes)
 *   POST   /portal/order-requests/:requestId/files/:fileId/complete  its bytes arrived (with the scanner: held until clean)
 *   DELETE /portal/order-requests/:requestId/files/:fileId?version=  the file out of the draft (the file's version)
 *
 * The part says what it is filed as (factory-domain sales/portal-ordering/draft-files): a LOGO as ARTWORK, a REFERENCE with no
 * category, a SHEET as MEASUREMENTS (body data: in the office named and opened only with sales.measurements.view). A file sits on
 * the draft or on ONE of its lines (a line of another draft or of another customer is not found: W-CP-3). At most DRAFT_FILES_MAX
 * of the customer's files on one draft. Only while it is a DRAFT. The outside-upload gate stays EXACTLY as it is
 * (`assertOutsideUploadsOpen`: on staging and production, until ClamAV runs, a 503 that says to send the file by e-mail; the draft
 * read says the same before anything is dropped). The files module writes the row as the tenant's system with files.upload and
 * files.manage over the draft's company and the party only (the partner role writes no file), shared with the party (OFFICE,
 * PARTNER); then, in the person's own scope, the draft's audit row (who of the party added or removed it) and
 * portal_order_request.draft_changed. A discarded draft, or a line taken out, takes its files with it (personal data: sheets).
 *
 * od-s s.2 (Owner yes 1a): the office uploads onto a customer's draft through its twins under /sales/order-requests/:id/files with
 * files.upload over the draft's company and customer (instead of portal.upload); the outside-upload gate stays the same; the row is
 * the same system write over the draft's company and party.
 */

export interface DraftFileBody {
  readonly part: DraftFilePart
  readonly lineId?: string | null | undefined
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

/**
 * The draft as the person may change its files now: their party's DRAFT, not a preview, with the upload capability. od-s s.2: the
 * office person with files.upload over the draft's company and customer.
 */
async function filePlace(writer: DraftWriter, requestId: string): Promise<RequestRow> {
  if (writer.preview) throw new ForbiddenError('A preview of the portal sends no file.')
  const row = await ownDraft(writer, requestId)
  const scope = { companyId: row.companyId, partyId: row.partyId }
  if (!can(writer.actor, writer.door === 'office' ? FILES_UPLOAD : PORTAL_UPLOAD, scope)) {
    const words = writer.door === 'office' ? OFFICE_DRAFT_WORDS.NO_UPLOAD.en : portalUploadWords('NO_UPLOAD', writer.locale)
    throw new DomainError('forbidden', words, [{ path: 'refusal/NO_UPLOAD', message: words }])
  }
  return row
}

/** The files module's caller for the draft: the tenant's system over the draft's company and party only (both doors). */
const uploaderOf = (writer: DraftWriter, row: RequestRow, more: Parameters<typeof partnerUploader>[4] = []): CommandCaller => partnerUploader(writer.request, writer.tenantId, row.companyId, row.partyId, more)

/** The draft's file (its own or one of its lines', the party's), or 404 as a wrong id. */
async function draftFile(uploader: CommandCaller, row: RequestRow, fileId: string) {
  if (!isUuid(fileId)) throw new NotFoundError('File not found.')
  const lineIds = (await uploader.withClient((client) => readLines(client, [row.id]))).map((line) => line.id)
  const file = await uploader.withClient((client) => client.storedFile.findFirst({ where: { AND: [draftFilesWhere([row.id], lineIds), { id: fileId, partyId: row.partyId }] }, select: DRAFT_FILE_COLUMNS }))
  if (!file) throw new NotFoundError('File not found.')
  return { file, lineId: file.recordType === DRAFT_FILE_RECORDS.line ? file.recordId : null }
}

/**
 * The draft's audit row and its live news, in the person's own scope (the files module's rows name the system). B-CP-075: who saved
 * the draft (the draft's version stays: parallel uploads never 409 each other), and `also` what the file's move changes on the draft.
 */
async function recordOnDraft(writer: DraftWriter, row: RequestRow, name: `${string}.${string}`, idempotencyKey: string | undefined, after: Record<string, unknown>, also?: (tools: CommandTools) => Promise<Record<string, unknown>>): Promise<void> {
  const editorId = writer.userId // B-CP-075: the person who saves (a link context has no actor id); od-s s.2: or the office person
  await commandOn(writer.app, writer.request, { name, idempotencyKey: idempotencyKey ? `${idempotencyKey}:draft` : undefined, input: { requestId: row.id, ...after } }, async (tools) => {
    const more = also ? await also(tools) : {}
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, after: { ...after, ...more } })
    await markEdited(tools.tx, row.id, editorId, tools.now) // B-CP-075
    draftChanged(tools, row)
    return null
  })
}

// ---- B-CP-075: a measurement sheet taken out of the draft — the people it measured are "sending later" again (the roster stays).
async function sheetPeopleLater(tools: CommandTools, row: RequestRow, fileId: string): Promise<Record<string, unknown>> {
  const moved = await tools.tx.portalOrderRequestPerson.updateMany({ where: { requestId: row.id, measurementFileId: fileId }, data: { measureBy: 'LATER', measurementFileId: null, version: { increment: 1 } } })
  return moved.count > 0 ? { peopleNowLater: moved.count } : {}
}
// ---- end B-CP-075

/** POST /portal/order-requests/:requestId/files */
export async function announceDraftFile(files: FilesRuntime, writer: DraftWriter, requestId: string, body: DraftFileBody, idempotencyKey?: string) {
  assertOutsideUploadsOpen()
  const row = await filePlace(writer, requestId)
  const uploader = uploaderOf(writer, row)
  const lines = await uploader.withClient((client) => readLines(client, [row.id]))
  // W-CP-3: a line of this draft only (another draft's, another customer's: not found, as a wrong id).
  const lineId = body.lineId ?? null
  if (lineId !== null && !lines.some((line) => line.id === lineId)) throw new NotFoundError('Line not found.')
  const held = await uploader.withClient((client) => client.storedFile.count({ where: { AND: [draftFilesWhere([row.id], lines.map((line) => line.id)), { partyId: row.partyId }] } }))
  if (held >= DRAFT_FILES_MAX) {
    const words = draftFileWords('TOO_MANY_FILES', writer.locale)
    throw new DomainError('conflict', words, [{ path: 'refusal/TOO_MANY_FILES', message: words }])
  }
  const contentType = normaliseContentType(body.contentType)
  const category = DRAFT_FILE_CATEGORY[body.part]
  const answer = await requestUpload(
    files,
    uploader,
    {
      companyId: row.companyId,
      recordType: lineId === null ? DRAFT_FILE_RECORDS.draft : DRAFT_FILE_RECORDS.line,
      recordId: lineId ?? row.id,
      kind: portalFileKindOf(contentType),
      originalName: body.originalName,
      contentType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
      visibility: ['OFFICE', 'PARTNER'],
      partyId: row.partyId,
      // A sheet through the files module's own tick (its kind checked, never a floor); a logo filed as ARTWORK.
      ...(category === 'MEASUREMENTS' ? { measurementSheet: true } : category === 'ARTWORK' ? { category } : {}),
    },
    idempotencyKey,
  )
  const file = await uploader.withClient((client) => client.storedFile.findUniqueOrThrow({ where: { id: answer.file.id }, select: DRAFT_FILE_COLUMNS }))
  return { file: draftFileView({ ...file, lineId }), upload: answer.upload }
}

/** POST /portal/order-requests/:requestId/files/:fileId/complete */
export async function completeDraftFile(files: FilesRuntime, writer: DraftWriter, requestId: string, fileId: string, idempotencyKey?: string) {
  const row = await filePlace(writer, requestId)
  const uploader = uploaderOf(writer, row)
  const { file, lineId } = await draftFile(uploader, row, fileId)
  await completeUpload(files, uploader, fileId, idempotencyKey)
  await recordOnDraft(writer, row, 'portalOrdering.addDraftFile', idempotencyKey, { fileId, lineId, part: draftFilePartOf(file.category) })
  const done = await uploader.withClient((client) => client.storedFile.findUniqueOrThrow({ where: { id: fileId }, select: DRAFT_FILE_COLUMNS }))
  return { file: draftFileView({ ...done, lineId }) }
}

/** DELETE /portal/order-requests/:requestId/files/:fileId?version= : the file out of the draft; the draft as the customer reads it. */
export async function removeDraftFile(files: FilesRuntime, writer: DraftWriter, requestId: string, fileId: string, version: number, idempotencyKey?: string) {
  const row = await filePlace(writer, requestId)
  const remover = uploaderOf(writer, row, [FILES_DELETE])
  const { lineId } = await draftFile(remover, row, fileId)
  await deleteFile(files, remover, fileId, { version, reason: `Taken out of the draft order by ${writer.door === 'office' ? 'the factory' : 'the customer'}.` }, idempotencyKey)
  await recordOnDraft(writer, row, 'portalOrdering.removeDraftFile', idempotencyKey, { fileId, lineId, removed: true }, (tools) => sheetPeopleLater(tools, row, fileId)) // B-CP-075
  return requestView(writer, await ownDraft(writer, requestId))
}

// ---- a discarded draft and a line taken out take their files with them -------------------------------------------------------

/** The party's files on the draft (lines: these only; null: the draft's own and every line's), read before they go. */
async function filesToDrop(uploader: CommandCaller, row: RequestRow, lineIds: readonly string[] | null): Promise<string[]> {
  const lines = lineIds ?? (await uploader.withClient((client) => readLines(client, [row.id]))).map((line) => line.id)
  const where = lineIds === null ? draftFilesWhere([row.id], lines) : { status: { not: 'DELETED' as const }, recordType: DRAFT_FILE_RECORDS.line, recordId: { in: [...lines] } }
  return (await uploader.withClient((client) => client.storedFile.findMany({ where: { AND: [where, { partyId: row.partyId }] }, select: { id: true } }))).map((file) => file.id)
}

/** Each file deleted (best effort, after the draft's own command: one held by a retention stays, logged; it is no draft's any more). */
async function dropFiles(files: () => FilesRuntime, request: FastifyRequest, remover: CommandCaller, fileIds: readonly string[]): Promise<void> {
  for (const fileId of fileIds) {
    try {
      await deleteFile(files(), remover, fileId, { reason: 'Its draft order was discarded, or its line taken out.' })
    } catch (error) {
      request.log.warn({ err: error, fileId }, 'a file of a discarded draft order could not be deleted')
    }
  }
}

/** DELETE /portal/order-requests/:requestId — the draft discarded (./requests.ts), then its files (the store asked only when it had some). */
export async function discardDraftWithFiles(files: () => FilesRuntime, writer: DraftWriter, requestId: string, version: number, idempotencyKey?: string) {
  const row = await ownDraft(writer, requestId)
  const remover = uploaderOf(writer, row, [FILES_DELETE])
  const doomed = await filesToDrop(remover, row, null)
  const answer = await discardDraft(writer, requestId, version, idempotencyKey)
  await dropFiles(files, writer.request, remover, doomed)
  return answer
}

/** DELETE /portal/order-requests/:requestId/lines/:lineId — the line out (./requests.ts), then its files. */
export async function removeLineWithFiles(files: () => FilesRuntime, writer: DraftWriter, requestId: string, lineId: string, version: number, idempotencyKey?: string) {
  const row = await ownDraft(writer, requestId)
  const remover = uploaderOf(writer, row, [FILES_DELETE])
  const doomed = isUuid(lineId) ? await filesToDrop(remover, row, [lineId]) : []
  const answer = await removeLine(writer, requestId, lineId, version, idempotencyKey)
  await dropFiles(files, writer.request, remover, doomed)
  // The read after the files went (the line's files are no longer listed).
  return doomed.length > 0 ? requestView(writer, await ownDraft(writer, requestId)) : answer
}

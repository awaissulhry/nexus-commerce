import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { cancelHeld, complaintTakesPhotos, OUTCOMES_WANTED, OUTCOME_WANTED_WORDS, returnTakesPhotos, sentWords, type CaseChip } from '@nexus/factory-domain/sales/portal-returns/rules'
import type { ReturnStatus } from '@nexus/factory-domain/sales/returns/rules'
import type { ComplaintStatus } from '@nexus/factory-domain/quality/complaints/rules'
import { StaleVersionError, type CommandSpec, type CommandTools } from '../../../core/command'
import { portalOf } from '../../../platform/auth/portal/service'
import type { FilesRuntime } from '../../../platform/files/service'
import { appClock } from '../../../platform/portal/tasks/clock'
import { assertMayRequest, assertMayUpload, portalReader, type PortalReader } from './access'
import { answerByFor, createComplaintInCommand, createRequestInCommand, itemsOf, NO_SCOPE, returnableFor, type ComplaintBody, type ReturnRequestBody } from './create'
import { announcePhoto, completePhoto, instructionsPdf, presignOpen, returnPhotoTarget, sharedFile, type OpenMode, type PhotoUpload } from './files'
import { COMPLAINT_RECORD, LINE_RECORD, readComplaint, readLines, readReturn, RETURN_RECORD } from './store'
import { complaintRecord, listCases, listComplaints, returnReasons, returnRecord } from './views'

/**
 * Returns & claims in the customer's portal (B-W2b-192; SAL-334, SAL-424; design portal.customer.returns, SCR-187 is
 * B-W2b-197's screen, the "Report a problem" steps SCR-197 B-W2b-198's):
 *
 *   GET  /portal/returns?chip=&q=                 the cases (returns and complaints) with the next step for the customer
 *   GET  /portal/returns/returnable?salesOrderId=  what may come back (the items the person picks), the reasons, the outcomes
 *   POST /portal/returns                          a return request: an RMA REQUESTED (the office authorises it in Returns)
 *   GET  /portal/returns/:id                      the return: Request (as sent) and Status (where it is, the decision, the
 *                                                 parcels, the inspection, the outcome, the credit note, the replacement)
 *   GET  /portal/returns/:id/instructions         the return instructions PDF (once authorised)
 *   POST /portal/returns/:id/cancel               "Cancel this request?" before the goods leave
 *   POST /portal/returns/:id/photos (+ /:fileId/complete)  a photo of the request or of a line, while not decided
 *   POST /portal/returns/files/:fileId/open       a photo or document of the customer's case (logged)
 *   POST /portal/complaints                       a quality complaint: a Complaint NEW, channel PORTAL
 *   GET  /portal/complaints                       the complaints with their investigation (the Quality role)
 *   GET  /portal/complaints/:id                   the complaint; the investigation, the letter and the 8D for the Quality role
 *   POST /portal/complaints/:id/photos (+ /:fileId/complete)
 *
 * The reads run in the tenant's office scope as the person and name the session's company and party (store.ts); the writes
 * are ONE command each in the same scope as the person (the partner role has no grant on these tables nor on the number
 * series), audited `byPartner` with the person as actor, as B-W2b-190's order requests.
 */

/** ONE command in the tenant's office scope as the portal person (no grants: this module checked the person itself). */
function asPerson<Result>(app: FastifyInstance, request: FastifyRequest, reader: PortalReader, spec: CommandSpec, work: (tools: CommandTools) => Promise<Result>) {
  const auth = portalOf(app).auth
  return auth.command(auth.contextFor(request, reader.session.tenantId, reader.session.userId), spec, work)
}

const options = (app: FastifyInstance, reader: PortalReader) => ({ seesPrices: reader.seesPrices, readsComplaints: reader.readsComplaints, now: appClock(app).now() })

export async function portalCases(app: FastifyInstance, request: FastifyRequest, query: { readonly chip?: CaseChip | undefined; readonly q?: string | undefined }) {
  const reader = portalReader(app, request)
  const list = await reader.inTenant((db) => listCases(db, reader.place, query, options(app, reader)))
  return { ...list, mayRequest: reader.mayRequest, readsComplaints: reader.readsComplaints, seesPrices: reader.seesPrices, asOf: toUtcIso(appClock(app).now()) }
}

export async function portalReturnable(app: FastifyInstance, request: FastifyRequest, query: { readonly salesOrderId?: string | undefined }) {
  const reader = portalReader(app, request)
  const now = appClock(app).now()
  const scope = { ...NO_SCOPE, salesOrderId: query.salesOrderId && isUuid(query.salesOrderId) ? query.salesOrderId : null }
  const { rows, reasons } = await reader.inTenant(async (db) => ({ rows: await returnableFor(db, reader.place, scope, now), reasons: await returnReasons(db) }))
  return {
    items: itemsOf(rows, reader.seesPrices),
    reasons,
    outcomes: OUTCOMES_WANTED.map((code) => ({ code, words: OUTCOME_WANTED_WORDS[code] })),
    mayRequest: reader.mayRequest,
    mayUpload: reader.mayUpload,
  }
}

export async function portalRequestReturn(app: FastifyInstance, request: FastifyRequest, body: ReturnRequestBody, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  assertMayRequest(reader)
  const { result } = await asPerson(app, request, reader, { name: 'portalReturns.request', idempotencyKey, input: { ...body, sessionId: reader.session.id } }, (tools) =>
    createRequestInCommand(tools, reader.place, NO_SCOPE, body, { via: 'PORTAL', personId: reader.session.userId, linkId: null }),
  )
  const now = appClock(app).now()
  const answerBy = await reader.inTenant((db) => answerByFor(db, reader.place.companyId, now))
  return { ...(await portalReturn(app, request, result.returnId)), sent: { number: result.number, answerBy, words: sentWords('RETURN', result.number, answerBy) } }
}

async function heldReturn(reader: PortalReader, returnId: string) {
  const row = await reader.inTenant((db) => readReturn(db, reader.place, returnId))
  if (!row) throw new NotFoundError('Return not found.')
  return row
}

export async function portalReturn(app: FastifyInstance, request: FastifyRequest, returnId: string) {
  const reader = portalReader(app, request)
  const row = await heldReturn(reader, returnId)
  return { return: await reader.inTenant((db) => returnRecord(db, reader.place, row, { ...options(app, reader), mayRequest: reader.mayRequest, mayUpload: reader.mayUpload })) }
}

export async function portalInstructions(app: FastifyInstance, request: FastifyRequest, returnId: string, language: DocumentLanguage | undefined) {
  const reader = portalReader(app, request)
  const row = await heldReturn(reader, returnId)
  return instructionsPdf(request, reader.session.tenantId, row, language ?? (reader.session.person.locale === 'en' ? 'en' : 'it'), appClock(app).now())
}

/** POST /portal/returns/:id/cancel {version, reason?}: REQUESTED or AUTHORISED → CANCELLED (the goods never left them). */
export async function portalCancelReturn(app: FastifyInstance, request: FastifyRequest, returnId: string, body: { readonly version: number; readonly reason?: string | null | undefined }, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  assertMayRequest(reader)
  const seen = await heldReturn(reader, returnId)
  const held = cancelHeld(seen.status as ReturnStatus)
  if (held) throw new InvalidStateError(held.en)
  const reason = (body.reason ?? '').trim()
  await asPerson(app, request, reader, { name: 'portalReturns.cancel', idempotencyKey, input: { returnId, ...body, sessionId: reader.session.id } }, async (tools) => {
    const [locked] = await tools.tx.$queryRaw<{ version: number; status: ReturnStatus }[]>`SELECT "version", "status"::text AS "status" FROM "ReturnAuthorisation" WHERE "id" = ${seen.id}::uuid FOR UPDATE`
    if (!locked) throw new NotFoundError('Return not found.')
    const again = cancelHeld(locked.status)
    if (again) throw new InvalidStateError(again.en)
    if (locked.version !== body.version) throw new StaleVersionError(RETURN_RECORD, seen.id, locked.version, body.version)
    const statusReason = `Cancelled by the customer${reason ? `: ${reason.slice(0, 400)}` : '.'}`
    await tools.tx.returnAuthorisation.update({ where: { id: seen.id }, data: { status: 'CANCELLED', closedAt: tools.now, statusReason, updatedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'portalReturns.cancel', recordType: RETURN_RECORD, recordId: seen.id, companyId: seen.companyId, siteId: seen.siteId, before: { status: locked.status }, after: { status: 'CANCELLED', statusReason, byPartner: true } })
    tools.emit({ type: 'return.status_changed', subject: seen.id, companyId: seen.companyId, siteId: seen.siteId, payload: { returnId: seen.id, number: seen.number, from: locked.status, to: 'CANCELLED' } })
    return null
  })
  return portalReturn(app, request, returnId)
}

export async function portalReturnPhoto(files: FilesRuntime, app: FastifyInstance, request: FastifyRequest, returnId: string, body: PhotoUpload & { readonly lineId?: string | null | undefined }, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  assertMayUpload(reader)
  const row = await heldReturn(reader, returnId)
  if (!returnTakesPhotos(row.status as ReturnStatus)) throw new InvalidStateError(`Return ${row.number} is decided or closed: write to us in the messages instead.`)
  const target = await reader.inTenant((db) => returnPhotoTarget(db, row, body.lineId))
  return announcePhoto(files, request, reader.session.tenantId, reader.place, target, body, idempotencyKey)
}

export async function portalReturnPhotoDone(files: FilesRuntime, app: FastifyInstance, request: FastifyRequest, returnId: string, fileId: string, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  assertMayUpload(reader)
  const row = await heldReturn(reader, returnId)
  const lines = await reader.inTenant((db) => readLines(db, [row.id]))
  return completePhoto(files, request, reader.session.tenantId, reader.place, [{ type: RETURN_RECORD, id: row.id }, ...lines.map((line) => ({ type: LINE_RECORD, id: line.id }) as const)], fileId, idempotencyKey)
}

export async function portalReportComplaint(app: FastifyInstance, request: FastifyRequest, body: ComplaintBody, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  assertMayRequest(reader)
  const { result } = await asPerson(app, request, reader, { name: 'portalReturns.complaint', idempotencyKey, input: { ...body, sessionId: reader.session.id } }, (tools) =>
    createComplaintInCommand(tools, reader.place, NO_SCOPE, body, { via: 'PORTAL', personId: reader.session.userId, linkId: null }),
  )
  const now = appClock(app).now()
  const answerBy = await reader.inTenant((db) => answerByFor(db, reader.place.companyId, now))
  return { ...(await portalComplaint(app, request, result.complaintId)), sent: { number: result.number, answerBy, words: sentWords('COMPLAINT', result.number, answerBy) } }
}

async function heldComplaint(reader: PortalReader, complaintId: string) {
  const row = await reader.inTenant((db) => readComplaint(db, reader.place, complaintId))
  if (!row) throw new NotFoundError('Complaint not found.')
  return row
}

export async function portalComplaint(app: FastifyInstance, request: FastifyRequest, complaintId: string) {
  const reader = portalReader(app, request)
  const row = await heldComplaint(reader, complaintId)
  return { complaint: await reader.inTenant((db) => complaintRecord(db, reader.place, row, { ...options(app, reader), mayUpload: reader.mayUpload })) }
}

export async function portalComplaints(app: FastifyInstance, request: FastifyRequest) {
  const reader = portalReader(app, request)
  return { items: await reader.inTenant((db) => listComplaints(db, reader.place)), asOf: toUtcIso(appClock(app).now()) }
}

export async function portalComplaintPhoto(files: FilesRuntime, app: FastifyInstance, request: FastifyRequest, complaintId: string, body: PhotoUpload, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  assertMayUpload(reader)
  const row = await heldComplaint(reader, complaintId)
  if (!complaintTakesPhotos(row.status as ComplaintStatus)) throw new InvalidStateError(`Complaint ${row.number} is answered or closed: write to us in the messages instead.`)
  return announcePhoto(files, request, reader.session.tenantId, reader.place, { type: COMPLAINT_RECORD, id: row.id }, body, idempotencyKey)
}

export async function portalComplaintPhotoDone(files: FilesRuntime, app: FastifyInstance, request: FastifyRequest, complaintId: string, fileId: string, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  assertMayUpload(reader)
  const row = await heldComplaint(reader, complaintId)
  return completePhoto(files, request, reader.session.tenantId, reader.place, [{ type: COMPLAINT_RECORD, id: row.id }], fileId, idempotencyKey)
}

/**
 * POST /portal/returns/files/:fileId/open {mode}: a file of one of the party's cases (a photo of a return or a complaint;
 * the answer letter and the 8D copy only for the Quality role). ONE command writes who opened it, then the presigned GET.
 */
export async function portalOpenFile(files: FilesRuntime, app: FastifyInstance, request: FastifyRequest, fileId: string, body: { readonly mode: OpenMode }, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const row = await reader.inTenant(async (db) => {
    const file = isUuid(fileId) ? await db.storedFile.findUnique({ where: { id: fileId }, select: { recordType: true, recordId: true } }) : null
    if (!file) return null
    if (file.recordType === COMPLAINT_RECORD) return (await readComplaint(db, reader.place, file.recordId)) ? sharedFile(db, reader.place, [{ type: COMPLAINT_RECORD, id: file.recordId }], fileId) : null
    if (file.recordType === RETURN_RECORD) return (await readReturn(db, reader.place, file.recordId)) ? sharedFile(db, reader.place, [{ type: RETURN_RECORD, id: file.recordId }], fileId) : null
    if (file.recordType === LINE_RECORD) {
      const line = await db.returnLine.findUnique({ where: { id: file.recordId }, select: { returnId: true } })
      return line && (await readReturn(db, reader.place, line.returnId)) ? sharedFile(db, reader.place, [{ type: LINE_RECORD, id: file.recordId }], fileId) : null
    }
    return null
  })
  if (!row) throw new NotFoundError('File not found.')
  if (row.recordType === COMPLAINT_RECORD && row.kind !== 'PHOTO' && !reader.readsComplaints) throw new ForbiddenError("Your access shows your complaints' status, not our letters and reports: ask your quality contact.")
  await asPerson(app, request, reader, { name: 'portalReturns.openFile', idempotencyKey, input: { fileId, mode: body.mode, sessionId: reader.session.id } }, async (tools) => {
    tools.audit({ recordType: 'StoredFile', recordId: row.id, companyId: reader.place.companyId, after: { mode: body.mode, recordType: row.recordType, recordId: row.recordId, sha256: row.sha256, byPartner: true } })
    return null
  })
  return presignOpen(files, request, reader.session.tenantId, row, body.mode)
}

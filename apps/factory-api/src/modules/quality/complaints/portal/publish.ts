import { FILES_MANAGE } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { legalProblems } from '@nexus/factory-domain/documents/legal'
import { QUALITY_CAPA_VIEW } from '@nexus/factory-domain/quality/capa/permissions'
import { QUALITY_COMPLAINTS_MANAGE } from '@nexus/factory-domain/quality/complaints/permissions'
import { COMPLAINT_RECORD, type ComplaintStatus } from '@nexus/factory-domain/quality/complaints/rules'
import { publishHeld, shareHeld } from '@nexus/factory-domain/sales/portal-returns/rules'
import { command, type CommandCaller } from '../../../../core/command'
import { actorOf } from '../../../../core/context'
import { companyLegalOf } from '../../../../platform/documents/documents'
import { prepareFileCopy, recordGeneratedFile } from '../../../../platform/files/files'
import type { FilesRuntime } from '../../../../platform/files/service'
import { capasOf, portalOnFor } from '../../../sales/portal-returns/store'
import { officeComplaint } from '../access'
import { keepLetterInCommand, prepareLetter } from '../answer'
import { recordOf } from '../log'
import { lockComplaint, touchComplaint } from '../store'

/**
 * The office's two acts that reach the customer outside (B-W2b-192, follow-ups of B-W2b-113 and B-W2b-108):
 *
 *   POST /quality/complaints/:id/answer/publish {version}   CO5:02 — the answer letter as written (B-W2b-113's Answer tab)
 *        published to the customer: the same letter version kept (GeneratedDocument COMPLAINT_ANSWER, shared with the
 *        customer's party), the complaint ANSWERED with answeredAt, answerDocumentId, answeredById and answeredVia PORTAL in
 *        ONE update, no mail (B-W2b-113's send stays EMAIL). The portal's Quality role and the claim link that opened the
 *        complaint read it. Only for a customer whose portal is on, or a complaint that came by a claim link.
 *   POST /quality/complaints/:id/share-eight-d {capaId?}    CO5:01 — "Share with the customer" of the 8D: the newest 8D
 *        report kept on the complaint's CAPA (B-W2b-108, an OFFICE file of the Capa) is COPIED onto the complaint, shared with
 *        the customer's party for the portal and its links (sourceFileId names the CAPA's file, the bytes are the same);
 *        the CAPA's own file stays the office's. The same report shared twice is answered `made: false`.
 *
 * quality.complaints.manage over the complaint; the share also files.manage over its company (sharing a file) and
 * quality.capa.view over the CAPA. Each is ONE command(); the publish locks the complaint at the screen's version.
 */

const held = (code: string, words: string) => new DomainError('invalid_state', words, [{ path: `held/${code}`, message: words }])

export async function publishAnswer(files: FilesRuntime, caller: CommandCaller, complaintId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const { context, complaint: seen } = await officeComplaint(caller, complaintId, QUALITY_COMPLAINTS_MANAGE)
  const portalOn = await caller.withClient((db) => portalOnFor(db, seen.partyId))
  const first = publishHeld({ status: seen.status as ComplaintStatus, answerText: seen.answerText, answerLanguage: seen.answerLanguage, portalOn, channel: seen.channel })
  if (first) throw held(first.code, first.words)
  const problems: Issue[] = legalProblems(await companyLegalOf(caller, seen.companyId)).map((issue) => ({ ...issue, path: `letter/${issue.path}` }))
  if (seen.answerFileIds.length > 0) {
    const attached = await caller.withClient((db) => db.storedFile.findMany({ where: { id: { in: seen.answerFileIds } }, select: { originalName: true, visibility: true, partyId: true, status: true } }))
    for (const file of attached) if (file.status !== 'AVAILABLE' || !file.visibility.includes('PARTNER') || file.partyId !== seen.partyId) problems.push({ path: 'fileIds', message: `${file.originalName} is not shared with the customer: share it first.` })
  }
  if (problems.length > 0) throw new DomainError('conflict', problems.length === 1 ? problems[0]!.message : 'The answer letter cannot be published as it stands.', problems)
  const prepared = await prepareLetter(files, caller, context, seen)
  const { result } = await command(caller, { name: 'complaints.publishAnswer', idempotencyKey, input: { complaintId, ...body } }, async (tools) => {
    const row = await lockComplaint(tools, seen.id, body.version)
    const again = publishHeld({ status: row.status as ComplaintStatus, answerText: row.answerText, answerLanguage: row.answerLanguage, portalOn, channel: row.channel })
    if (again) throw held(again.code, again.words)
    const kept = await keepLetterInCommand(tools, row, prepared)
    const from = row.status as ComplaintStatus
    const after = await touchComplaint(tools, row, { status: 'ANSWERED', answeredAt: tools.now, answerDocumentId: kept.id, answeredById: context.actorId, answeredVia: 'PORTAL' })
    tools.audit({
      action: 'complaints.publishAnswer',
      recordType: COMPLAINT_RECORD,
      recordId: row.id,
      companyId: row.companyId,
      before: { status: from, answeredAt: row.answeredAt ? toUtcIso(row.answeredAt) : null, version: row.version },
      after: { status: 'ANSWERED', answeredAt: toUtcIso(tools.now), answerDocumentId: kept.id, version: kept.version, via: 'PORTAL', language: row.answerLanguage, files: row.answerFileIds.length, rowVersion: after.version },
    })
    tools.emit({ type: 'complaint.changed', subject: row.id, companyId: row.companyId, payload: { complaintId: row.id, number: row.number, fields: ['answer'] } })
    tools.emit({ type: 'complaint.status_changed', subject: row.id, companyId: row.companyId, payload: { complaintId: row.id, number: row.number, from, to: 'ANSWERED' } })
    tools.emit({ type: 'complaint_answer.published', subject: row.id, companyId: row.companyId, payload: { complaintId: row.id, number: row.number, partyId: row.partyId, documentId: kept.id, version: kept.version } })
    return { document: { id: kept.id, version: kept.version, fileId: kept.fileId } }
  })
  return { complaint: await recordOf(caller, seen.id), document: result.document }
}

export async function shareEightD(files: FilesRuntime, caller: CommandCaller, complaintId: string, body: { readonly capaId?: string | undefined }, idempotencyKey?: string) {
  const { context, complaint } = await officeComplaint(caller, complaintId, QUALITY_COMPLAINTS_MANAGE)
  if (!can(actorOf(context), FILES_MANAGE, { companyId: complaint.companyId })) throw new ForbiddenError('Sharing a file with the customer needs files.manage over the company.')
  const facts = await caller.withClient(async (db) => {
    const capas = await db.capaSource.findMany({ where: { recordType: COMPLAINT_RECORD, recordId: complaint.id }, select: { capaId: true } })
    const wanted = body.capaId ? capas.find((source) => source.capaId === body.capaId) : null
    if (body.capaId && (!isUuid(body.capaId) || !wanted)) return null
    const capa = wanted
      ? await db.capa.findUnique({ where: { id: wanted.capaId }, select: { id: true, number: true, type: true, companyId: true, customerId: true, status: true } })
      : await (async () => {
          const newest = (await capasOf(db, [complaint.id])).get(complaint.id)
          return newest ? db.capa.findUnique({ where: { id: newest.id }, select: { id: true, number: true, type: true, companyId: true, customerId: true, status: true } }) : null
        })()
    const report = capa ? await db.generatedDocument.findFirst({ where: { recordType: 'Capa', recordId: capa.id, kind: 'EIGHT_D' }, select: { id: true, version: true, fileId: true }, orderBy: { version: 'desc' } }) : null
    const shared = report ? await db.storedFile.findFirst({ where: { recordType: COMPLAINT_RECORD, recordId: complaint.id, sourceFileId: report.fileId, status: 'AVAILABLE' }, select: { id: true } }) : null
    return { capa, report, shared }
  })
  if (!facts) throw new NotFoundError('That CAPA was not opened from this complaint.')
  if (facts.capa && !can(actorOf(context), QUALITY_CAPA_VIEW, { companyId: facts.capa.companyId, ...(facts.capa.customerId ? { partyId: facts.capa.customerId } : {}) })) throw new NotFoundError('That CAPA was not opened from this complaint.')
  const problem = shareHeld({ capaType: facts.capa ? (facts.capa.type as 'CAPA' | 'EIGHT_D') : null, reportFileId: facts.report?.fileId ?? null })
  if (problem) throw held(problem.code, problem.words)
  const capa = facts.capa!
  const report = facts.report!
  if (facts.shared) return { complaint: await recordOf(caller, complaint.id), shared: { fileId: facts.shared.id, sourceFileId: report.fileId, capaNumber: capa.number, version: report.version, made: false } }
  const prepared = await prepareFileCopy(files, caller, report.fileId, { companyId: complaint.companyId, recordType: COMPLAINT_RECORD, recordId: complaint.id, kind: 'DOCUMENT', visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: complaint.partyId })
  const { result } = await command(caller, { name: 'complaints.shareEightD', idempotencyKey, input: { complaintId, capaId: capa.id, fileId: report.fileId } }, async (tools) => {
    const file = await recordGeneratedFile(tools, prepared, { details: { documentType: 'EIGHT_D', capaId: capa.id, number: capa.number, version: report.version, sharedWith: complaint.partyId } })
    tools.audit({ action: 'complaints.shareEightD', recordType: COMPLAINT_RECORD, recordId: complaint.id, companyId: complaint.companyId, after: { fileId: file.id, sourceFileId: report.fileId, capaId: capa.id, capaNumber: capa.number, reportVersion: report.version } })
    tools.emit({ type: 'complaint_document.shared', subject: complaint.id, companyId: complaint.companyId, payload: { complaintId: complaint.id, number: complaint.number, partyId: complaint.partyId, capaId: capa.id, fileId: file.id, sourceFileId: report.fileId } })
    return { fileId: file.id }
  })
  return { complaint: await recordOf(caller, complaint.id), shared: { fileId: result.fileId, sourceFileId: report.fileId, capaNumber: capa.number, version: report.version, made: true } }
}

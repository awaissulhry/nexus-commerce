import { createHash } from 'node:crypto'
import { DomainError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { legalFooter, legalLines, legalName, legalProblems } from '@nexus/factory-domain/documents/legal'
import { isDocumentLanguage, type CompanyLegal, type DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { QUALITY_CAPA_MANAGE } from '@nexus/factory-domain/quality/capa/permissions'
import { eightDFingerprintText, eightDReport, type EightDInput } from '@nexus/factory-domain/quality/capa/report'
import { CAPA_RECORD, type ActionKind, type ActionStatus, type CapaStatus, type CapaType } from '@nexus/factory-domain/quality/capa/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import { putGeneratedFile, recordGeneratedFile, type PreparedGeneratedFile } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { officeCapa } from './access'
import { renderEightD } from './report-pdf'
import { dayOf, lockCapa, namesOf, readActions, readCapa, readSources, teamOf, type CapaRow, type Reader } from './store'

/**
 * The 8D report (B-W2b-108; QHS-094; design quality.capa Report tab capa-8d "PdfViewer preview in the chosen language;
 * Language SegmentedControl; Print", and the new tab capa-pdf "8D report (PDF)": "sent to or uploaded for the customer"):
 * composed in Italian or English by factory-domain quality/capa/report and painted on A4 (./report-pdf.ts). Each version
 * kept is a GeneratedDocument EIGHT_D of the CAPA (version 1, 2, … per CAPA; the newest is the current one; no site: a
 * CAPA has none) with its StoredFile, a DOCUMENT of the Capa seen by the office. Sharing it with the customer (portal or
 * link) is W2b-3: nothing here reaches a customer.
 *
 *   GET  /quality/capa/:capaId/report?language=   quality.capa.view: the PDF with the "preview" banner, made in memory and
 *                                                 stored nowhere (default language: the customer's, else Italian)
 *   POST /quality/capa/:capaId/report {language?} quality.capa.manage: keeps a version (open or closed: the D8 report is
 *                                                 made after the close); the same contents as the newest give it back
 *
 * Making a version, as the claim letter (B-W2b-14): (1) the facts read and the report composed; its fingerprint = SHA-256
 * of everything it says but the date (eightDFingerprintText); (2) the same as the newest version: nothing is written; the
 * same as an earlier one: a new version naming that version's file; else the PDF put in the file store OUTSIDE any
 * transaction (putGeneratedFile); (3) ONE command under the CAPA's row lock (FOR UPDATE, no change to it): the next
 * version, the StoredFile row, the GeneratedDocument row, the audit row and capa.report_made. The company's letterhead must
 * be complete (c.c. art. 2250): refused in words otherwise.
 */

export const REPORT_KIND = 'EIGHT_D' as const

const refusal = (issues: readonly Issue[]) => new DomainError('conflict', issues.length === 1 ? issues[0]!.message : 'The 8D report cannot be made as the company stands.', [...issues])

/** The language of the report: asked, else the customer's (Italian or English), else Italian. */
async function languageOf(db: Reader, capa: CapaRow, asked: DocumentLanguage | undefined): Promise<DocumentLanguage> {
  if (asked) return asked
  if (!capa.customerId) return 'it'
  const party = await db.party.findUnique({ where: { id: capa.customerId }, select: { language: true } })
  return party && isDocumentLanguage(party.language) ? party.language : 'it'
}

/** The facts the report prints, read with the caller's client. Cancelled actions are not printed. */
async function reportInputOf(db: Reader, capa: CapaRow, company: CompanyLegal, options: { readonly language: DocumentLanguage; readonly sample: boolean }): Promise<EightDInput> {
  const { language } = options
  const sources = await readSources(db, [capa.id])
  const actions = (await readActions(db, [capa.id])).filter((action) => action.status !== 'CANCELLED')
  const team = teamOf(capa.team)
  const names = new Map((await namesOf(db, [capa.ownerId, ...team.map((member) => member.userId), ...actions.map((action) => action.ownerId)])).map((person) => [person.id, person.name]))
  const ncrIds = sources.filter((source) => source.recordType === 'Nonconformance').map((source) => source.recordId)
  const complaintIds = sources.filter((source) => source.recordType === 'Complaint').map((source) => source.recordId)
  const ncrs = ncrIds.length === 0 ? [] : await db.nonconformance.findMany({ where: { id: { in: ncrIds } }, select: { id: true, number: true, causeCodeId: true }, orderBy: [{ number: 'asc' }] })
  const complaints = complaintIds.length === 0 ? [] : await db.complaint.findMany({ where: { id: { in: complaintIds } }, select: { id: true, number: true, customerRef: true }, orderBy: [{ number: 'asc' }] })
  const containment = ncrs.length === 0 ? [] : await db.ncrContainmentAction.findMany({ where: { ncrId: { in: ncrs.map((ncr) => ncr.id) }, status: { not: 'CANCELLED' } }, select: { ncrId: true, kind: true, description: true, status: true, doneAt: true }, orderBy: [{ ncrId: 'asc' }, { seq: 'asc' }] })
  const causeIds = [...new Set(ncrs.flatMap((ncr) => (ncr.causeCodeId ? [ncr.causeCodeId] : [])))]
  const causes = causeIds.length === 0 ? [] : await db.causeCode.findMany({ where: { id: { in: causeIds } }, select: { code: true, labelIt: true, labelEn: true }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] })
  const customer = capa.customerId ? await db.party.findUnique({ where: { id: capa.customerId }, select: { legalName: true, tradeName: true } }) : null
  return {
    language,
    date: businessDate(serverClock.now()),
    company: { name: legalName(company, language), lines: legalLines(company, language), legal: legalFooter(company, language) },
    type: capa.type as CapaType,
    number: capa.number,
    title: capa.title,
    status: capa.status as CapaStatus,
    openedOn: businessDate(capa.createdAt),
    dueOn: dayOf(capa.dueOn),
    owner: names.get(capa.ownerId) ?? null,
    customer: customer ? { name: customer.legalName, reference: complaints.find((complaint) => complaint.customerRef)?.customerRef ?? null } : null,
    team: team.map((member) => ({ name: names.get(member.userId) ?? '-', role: member.role })),
    problem: { what: capa.problemWhat, where: capa.problemWhere, when: capa.problemWhen, howMany: capa.problemHowMany },
    sources: [...ncrs.map((ncr) => ({ type: 'Nonconformance' as const, number: ncr.number })), ...complaints.map((complaint) => ({ type: 'Complaint' as const, number: complaint.number }))],
    containment: ncrs
      .map((ncr) => ({ ncr: ncr.number, actions: containment.filter((action) => action.ncrId === ncr.id).map((action) => ({ kind: action.kind, description: action.description ?? '', status: action.status, doneOn: action.doneAt ? businessDate(action.doneAt) : null })) }))
      .filter((entry) => entry.actions.length > 0),
    causes: causes.map((cause) => ({ code: cause.code, label: language === 'it' ? cause.labelIt : cause.labelEn })),
    actions: actions.map((action) => ({
      seq: action.seq,
      kind: action.kind as ActionKind,
      description: action.description,
      owner: names.get(action.ownerId) ?? null,
      dueOn: dayOf(action.dueOn),
      status: action.status as ActionStatus,
      doneOn: action.doneAt ? businessDate(action.doneAt) : null,
      evidence: action.evidenceNote,
    })),
    closedOn: capa.closedAt ? businessDate(capa.closedAt) : null,
    closeNote: capa.closeNote,
    sample: options.sample,
  }
}

/** GET /quality/capa/:capaId/report: the PDF as it would be kept, with the preview banner. */
export async function previewReport(caller: CommandCaller, capaId: string, query: { readonly language?: DocumentLanguage | undefined }): Promise<{ pdf: Buffer; fileName: string }> {
  const { capa } = await officeCapa(caller, capaId)
  const company = await companyLegalOf(caller, capa.companyId)
  const legal = legalProblems(company)
  if (legal.length > 0) throw refusal(legal)
  const report = await caller.withClient(async (client) => eightDReport(await reportInputOf(client, capa, company, { language: await languageOf(client, capa, query.language), sample: true })))
  return { pdf: await renderEightD(report), fileName: report.fileName }
}

interface PreparedReport {
  readonly fingerprint: string
  readonly language: DocumentLanguage
  readonly current: { readonly id: string; readonly version: number; readonly fileId: string } | null
  readonly earlierFileId: string | null
  readonly file: PreparedGeneratedFile | null
}

/** Prepares the report OUTSIDE any transaction (the store put). */
async function prepareReport(files: FilesRuntime, caller: CommandCaller, capa: CapaRow, asked: DocumentLanguage | undefined): Promise<PreparedReport> {
  const company = await companyLegalOf(caller, capa.companyId)
  const problems = legalProblems(company)
  if (problems.length > 0) throw refusal(problems)
  const { report, versions } = await caller.withClient(async (client) => {
    const language = await languageOf(client, capa, asked)
    return {
      report: eightDReport(await reportInputOf(client, capa, company, { language, sample: false })),
      versions: await client.generatedDocument.findMany({ where: { recordType: CAPA_RECORD, recordId: capa.id, kind: REPORT_KIND }, select: { id: true, version: true, fingerprint: true, language: true, fileId: true }, orderBy: { version: 'desc' } }),
    }
  })
  const fingerprint = createHash('sha256').update(eightDFingerprintText(report)).digest('hex')
  const newest = versions[0]
  if (newest && newest.fingerprint === fingerprint && newest.language === report.language) return { fingerprint, language: report.language, current: { id: newest.id, version: newest.version, fileId: newest.fileId }, earlierFileId: null, file: null }
  const earlier = versions.find((version) => version.fingerprint === fingerprint && version.language === report.language)
  if (earlier) return { fingerprint, language: report.language, current: null, earlierFileId: earlier.fileId, file: null }
  const file = await putGeneratedFile(files, caller, {
    companyId: capa.companyId,
    recordType: CAPA_RECORD,
    recordId: capa.id,
    kind: 'DOCUMENT',
    originalName: report.fileName,
    contentType: 'application/pdf',
    body: await renderEightD(report),
    // The office's until it is shared (W2b-3: the customer's portal or a link).
    visibility: ['OFFICE'],
  })
  return { fingerprint, language: report.language, current: null, earlierFileId: null, file }
}

/** Keeps a prepared report inside the caller's command: the CAPA's row locked, the next version, the file's row, the document. */
async function keepReportInCommand(tools: CommandTools, capaId: string, prepared: PreparedReport): Promise<{ id: string; version: number; fileId: string; made: boolean }> {
  const { tx, now } = tools
  if (prepared.current) return { ...prepared.current, made: false }
  await lockCapa(tx, capaId)
  const capa = (await readCapa(tx, capaId))!
  const last = await tx.generatedDocument.findFirst({ where: { recordType: CAPA_RECORD, recordId: capaId, kind: REPORT_KIND }, select: { id: true, version: true, fingerprint: true, language: true, fileId: true }, orderBy: { version: 'desc' } })
  // Made meanwhile with the same contents: that one.
  if (last && last.fingerprint === prepared.fingerprint && last.language === prepared.language) return { id: last.id, version: last.version, fileId: last.fileId, made: false }
  const fileId = prepared.file ? (await recordGeneratedFile(tools, prepared.file, { details: { documentType: REPORT_KIND, number: capa.number, language: prepared.language } })).id : prepared.earlierFileId!
  const id = newId()
  const version = (last?.version ?? 0) + 1
  await tx.generatedDocument.create({
    data: { id, companyId: capa.companyId, siteId: null, recordType: CAPA_RECORD, recordId: capaId, kind: REPORT_KIND, version, fingerprint: prepared.fingerprint, language: prepared.language, number: capa.number, fileId, createdAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
    select: { id: true },
  })
  tools.audit({ action: 'quality.capaReport', recordType: CAPA_RECORD, recordId: capaId, companyId: capa.companyId, after: { generatedDocumentId: id, version, language: prepared.language, fileId, fingerprint: prepared.fingerprint, reused: prepared.file === null } })
  tools.emit({ type: 'capa.report_made', subject: capaId, companyId: capa.companyId, payload: { capaId, number: capa.number, documentId: id, version, language: prepared.language } })
  return { id, version, fileId, made: true }
}

/** POST /quality/capa/:capaId/report: keeps the report as a version (see the file's comment). */
export async function makeReport(files: FilesRuntime, caller: CommandCaller, capaId: string, body: { readonly language?: DocumentLanguage | undefined }, idempotencyKey?: string) {
  const { capa } = await officeCapa(caller, capaId, QUALITY_CAPA_MANAGE)
  const prepared = await prepareReport(files, caller, capa, body.language)
  const result = prepared.current ? { ...prepared.current, made: false } : (await command(caller, { name: 'quality.capaReport', idempotencyKey, input: { capaId, ...body } }, async (tools) => keepReportInCommand(tools, capaId, prepared))).result
  const row = await caller.withClient((client) => client.generatedDocument.findUniqueOrThrow({ where: { id: result.id }, select: { id: true, version: true, language: true, number: true, fileId: true, createdAt: true, createdById: true } }))
  return { report: { ...row, createdAt: toUtcIso(row.createdAt) }, made: result.made }
}

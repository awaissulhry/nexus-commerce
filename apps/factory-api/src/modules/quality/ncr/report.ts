import { createHash } from 'node:crypto'
import { DomainError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { legalFooter, legalLines, legalName, legalProblems } from '@nexus/factory-domain/documents/legal'
import { isDocumentLanguage, type CompanyLegal, type DocumentLanguage } from '@nexus/factory-domain/documents/model'
import type { DefectClass, QualityStage } from '@nexus/factory-domain/quality/defects/rules'
import { QUALITY_NCR_MANAGE } from '@nexus/factory-domain/quality/ncr/permissions'
import { ncrReport, ncrReportFingerprintText, type NcrReportInput } from '@nexus/factory-domain/quality/ncr/report'
import { decisionState, type NcrStage } from '@nexus/factory-domain/quality/ncr/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import { putGeneratedFile, recordGeneratedFile, type PreparedGeneratedFile } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { renderEightD } from '../capa/report-pdf'
import { emitChanged, visibleNcr } from './ncr'
import { linkTarget } from './sources'
import { lockNcr, NCR_RECORD, readActions, readDecisions, readNcr, type NcrRow, type Reader } from './store'

/**
 * The NCR report (B-W2b-113; design quality.ncr new tab "NCR report (PDF)": "To send to a supplier or attach to a
 * complaint"): composed in Italian or English by factory-domain quality/ncr/report and painted on A4 by the CAPA module's
 * 8D renderer (the same layout: letterhead, facts, sections, legal footer). Each version kept is a GeneratedDocument
 * NCR_REPORT of the NCR (version 1, 2, … per NCR; the newest is the current one; the NCR's site) with its StoredFile, a
 * DOCUMENT of the Nonconformance seen by the office. Sharing it with a supplier or a customer (portal or link) is W2b-3;
 * nothing here reaches anyone outside. It never prints a cost, a worker or the customer's concession.
 *
 *   GET  /quality/ncr/:ncrId/report?language=   quality.ncr.view: the PDF with the "preview" banner, made in memory, stored
 *                                               nowhere (default language: the NCR's supplier's when it names one, else Italian)
 *   POST /quality/ncr/:ncrId/report {language?} quality.ncr.manage: keeps a version (open or closed: a report is often made
 *                                               after the close); the same contents as the newest give it back
 *
 * Making a version, as the 8D (B-W2b-108): the facts read and the report composed; its fingerprint = SHA-256 of everything it
 * says but the date; the same as the newest: nothing written; the same as an earlier one: a new version naming that file;
 * else the PDF put in the file store OUTSIDE any transaction; then ONE command under the NCR's row lock (FOR UPDATE, no
 * change to it): the next version, the StoredFile row, the GeneratedDocument row, the audit, ncr.changed {fields: ['report']}.
 * The company's letterhead must be complete (c.c. art. 2250): refused in words otherwise.
 */

export const NCR_REPORT_KIND = 'NCR_REPORT' as const

const refusal = (issues: readonly Issue[]) => new DomainError('conflict', issues.length === 1 ? issues[0]!.message : 'The NCR report cannot be made as the company stands.', [...issues])

/** The report's language: asked, else the NCR's supplier's (Italian or English), else Italian. */
async function languageOf(db: Reader, row: NcrRow, asked: DocumentLanguage | undefined): Promise<DocumentLanguage> {
  if (asked) return asked
  if (!row.supplierId) return 'it'
  const party = await db.party.findUnique({ where: { id: row.supplierId }, select: { language: true } })
  return party && isDocumentLanguage(party.language) ? party.language : 'it'
}

const SOURCE_WORDS: Readonly<Record<DocumentLanguage, Readonly<Record<string, string>>>> = {
  it: { INSPECTION: 'Ispezione', BUNDLE: 'Pacco', COMPLAINT: 'Reclamo', RETURN: 'Reso', SUPPLIER: 'Fornitore', AUDIT: 'Audit', OTHER: 'Altro' },
  en: { INSPECTION: 'Inspection', BUNDLE: 'Bundle', COMPLAINT: 'Complaint', RETURN: 'Return', SUPPLIER: 'Supplier', AUDIT: 'Audit', OTHER: 'Other' },
}

/** The facts the report prints, read with the caller's client. Cancelled containment actions are not printed. */
async function reportInputOf(db: Reader, row: NcrRow, company: CompanyLegal, options: { readonly language: DocumentLanguage; readonly sample: boolean }): Promise<NcrReportInput> {
  const { language } = options
  const it = language === 'it'
  const style = row.styleId ? await db.style.findUnique({ where: { id: row.styleId }, select: { code: true, name: true } }) : null
  const colourway = row.colourwayId ? await db.colourway.findUnique({ where: { id: row.colourwayId }, select: { code: true, name: true } }) : null
  const lot = row.lotId ? await db.lot.findUnique({ where: { id: row.lotId }, select: { code: true, supplierLotRef: true } }) : null
  const supplier = row.supplierId ? await db.party.findUnique({ where: { id: row.supplierId }, select: { legalName: true } }) : null
  const workOrder = row.workOrderId ? await db.workOrder.findUnique({ where: { id: row.workOrderId }, select: { number: true } }) : null
  const defect = row.defectCodeId ? await db.defectCode.findUnique({ where: { id: row.defectCodeId }, select: { code: true, labelIt: true, labelEn: true } }) : null
  const cause = row.causeCodeId ? await db.causeCode.findUnique({ where: { id: row.causeCodeId }, select: { code: true, labelIt: true, labelEn: true } }) : null
  const capa = row.capaId ? await db.capa.findUnique({ where: { id: row.capaId }, select: { number: true } }) : null
  const owner = row.ownerId ? await db.user.findUnique({ where: { id: row.ownerId }, select: { displayName: true } }) : null
  // Where it came from: its kind in words and the record's own number (the label's last word, when it has a digit).
  const source = row.sourceType && row.sourceId ? await linkTarget(db, row.sourceType, row.sourceId) : null
  const code = source?.label.split(/\s+/).pop() ?? null
  const actions = (await readActions(db, [row.id])).filter((action) => action.status !== 'CANCELLED')
  const decisions = await readDecisions(db, [row.id])
  const codes = new Map((await db.dispositionCode.findMany({ where: { id: { in: [...new Set(decisions.map((decision) => decision.dispositionCodeId))] } }, select: { id: true, code: true, labelIt: true, labelEn: true } })).map((entry) => [entry.id, entry]))
  const of = (type: string) => decisions.flatMap((decision) => (decision.followUpType === type && decision.followUpId ? [decision.followUpId] : []))
  const followUps = new Map<string, string>()
  for (const rework of await db.reworkOrder.findMany({ where: { id: { in: of('ReworkOrder') } }, select: { id: true, workOrder: { select: { number: true } } } })) followUps.set(rework.id, `${it ? 'Rilavorazione' : 'Rework'} ${rework.workOrder.number}`)
  for (const repair of await db.repairOrder.findMany({ where: { id: { in: of('RepairOrder') } }, select: { id: true, number: true } })) followUps.set(repair.id, repair.number)
  for (const claim of await db.supplierClaim.findMany({ where: { id: { in: of('SupplierClaim') } }, select: { id: true, number: true } })) followUps.set(claim.id, claim.number)
  return {
    language,
    date: businessDate(serverClock.now()),
    company: { name: legalName(company, language), lines: legalLines(company, language), legal: legalFooter(company, language) },
    number: row.number,
    title: row.title,
    stage: row.stage as NcrStage,
    severity: row.severity as DefectClass,
    foundAt: row.foundAt as QualityStage,
    foundOn: businessDate(row.foundOn),
    source: row.sourceType ? `${SOURCE_WORDS[language][row.source] ?? row.source}${code && /\d/.test(code) ? ` ${code}` : ''}` : null,
    style: style ? `${style.code} ${style.name}` : null,
    colourway: colourway ? colourway.code : null,
    size: row.size,
    serial: row.serial,
    lot: lot ? (lot.supplierLotRef ? `${lot.code} / ${lot.supplierLotRef}` : lot.code) : null,
    supplier: supplier?.legalName ?? null,
    workOrder: workOrder?.number ?? null,
    quantityAffected: row.quantityAffected.toString(),
    quantitySuspect: row.quantitySuspect?.toString() ?? null,
    uom: row.uom,
    defect: defect ? `${it ? defect.labelIt : defect.labelEn} (${defect.code})` : null,
    zone: row.zone,
    cause: cause ? `${it ? cause.labelIt : cause.labelEn} (${cause.code})` : null,
    capa: capa?.number ?? null,
    owner: owner?.displayName ?? null,
    description: row.description,
    containment: actions.map((action) => ({ kind: action.kind, description: action.description, status: action.status, doneOn: action.doneAt ? businessDate(action.doneAt) : null })),
    decisions: decisions.map((decision) => {
      const entry = codes.get(decision.dispositionCodeId)
      return {
        seq: decision.seq,
        disposition: entry ? (it ? entry.labelIt : entry.labelEn) : '-',
        quantity: decision.quantity.toString(),
        state: decisionState({ approvalRequired: decision.approvalRequired, approved: decision.approvedAt !== null, done: decision.doneAt !== null }),
        followUp: decision.followUpId ? (followUps.get(decision.followUpId) ?? null) : null,
      }
    }),
    closedOn: row.closedAt ? businessDate(row.closedAt) : null,
    closeNote: row.closeNote,
    cancelReason: row.cancelReason,
    sample: options.sample,
  }
}

/** GET /quality/ncr/:ncrId/report: the PDF as it would be kept, with the preview banner. */
export async function previewNcrReport(caller: CommandCaller, ncrId: string, query: { readonly language?: DocumentLanguage | undefined }): Promise<{ pdf: Buffer; fileName: string }> {
  const { row } = await visibleNcr(caller, ncrId)
  const company = await companyLegalOf(caller, row.companyId)
  const legal = legalProblems(company)
  if (legal.length > 0) throw refusal(legal)
  const report = await caller.withClient(async (client) => ncrReport(await reportInputOf(client, row, company, { language: await languageOf(client, row, query.language), sample: true })))
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
async function prepareReport(files: FilesRuntime, caller: CommandCaller, row: NcrRow, asked: DocumentLanguage | undefined): Promise<PreparedReport> {
  const company = await companyLegalOf(caller, row.companyId)
  const problems = legalProblems(company)
  if (problems.length > 0) throw refusal(problems)
  const { report, versions } = await caller.withClient(async (client) => {
    const language = await languageOf(client, row, asked)
    return {
      report: ncrReport(await reportInputOf(client, row, company, { language, sample: false })),
      versions: await client.generatedDocument.findMany({ where: { recordType: NCR_RECORD, recordId: row.id, kind: NCR_REPORT_KIND }, select: { id: true, version: true, fingerprint: true, language: true, fileId: true }, orderBy: { version: 'desc' } }),
    }
  })
  const fingerprint = createHash('sha256').update(ncrReportFingerprintText(report)).digest('hex')
  const newest = versions[0]
  if (newest && newest.fingerprint === fingerprint && newest.language === report.language) return { fingerprint, language: report.language, current: { id: newest.id, version: newest.version, fileId: newest.fileId }, earlierFileId: null, file: null }
  const earlier = versions.find((version) => version.fingerprint === fingerprint && version.language === report.language)
  if (earlier) return { fingerprint, language: report.language, current: null, earlierFileId: earlier.fileId, file: null }
  const file = await putGeneratedFile(files, caller, {
    companyId: row.companyId,
    recordType: NCR_RECORD,
    recordId: row.id,
    kind: 'DOCUMENT',
    originalName: report.fileName,
    contentType: 'application/pdf',
    body: await renderEightD(report),
    // The office's until it is shared (W2b-3: the supplier's or the customer's portal, a link).
    visibility: ['OFFICE'],
  })
  return { fingerprint, language: report.language, current: null, earlierFileId: null, file }
}

/** Keeps a prepared report inside the command: the NCR's row locked, the next version, the file's row, the document. */
async function keepReportInCommand(tools: CommandTools, ncrId: string, prepared: PreparedReport): Promise<{ id: string; version: number; fileId: string; made: boolean }> {
  const { tx, now } = tools
  if (prepared.current) return { ...prepared.current, made: false }
  if (!(await lockNcr(tx, ncrId))) throw new NotFoundError('NCR not found.')
  const row = (await readNcr(tx, ncrId))!
  const last = await tx.generatedDocument.findFirst({ where: { recordType: NCR_RECORD, recordId: ncrId, kind: NCR_REPORT_KIND }, select: { id: true, version: true, fingerprint: true, language: true, fileId: true }, orderBy: { version: 'desc' } })
  // Made meanwhile with the same contents: that one.
  if (last && last.fingerprint === prepared.fingerprint && last.language === prepared.language) return { id: last.id, version: last.version, fileId: last.fileId, made: false }
  const fileId = prepared.file ? (await recordGeneratedFile(tools, prepared.file, { details: { documentType: NCR_REPORT_KIND, number: row.number, language: prepared.language } })).id : prepared.earlierFileId!
  const id = newId()
  const version = (last?.version ?? 0) + 1
  await tx.generatedDocument.create({
    data: { id, companyId: row.companyId, siteId: row.siteId, recordType: NCR_RECORD, recordId: ncrId, kind: NCR_REPORT_KIND, version, fingerprint: prepared.fingerprint, language: prepared.language, number: row.number, fileId, createdAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
    select: { id: true },
  })
  tools.audit({ action: 'quality.ncrReport', recordType: NCR_RECORD, recordId: ncrId, companyId: row.companyId, siteId: row.siteId, after: { generatedDocumentId: id, version, language: prepared.language, fileId, fingerprint: prepared.fingerprint, reused: prepared.file === null } })
  emitChanged(tools, row, ['report'])
  return { id, version, fileId, made: true }
}

/** POST /quality/ncr/:ncrId/report: keeps the report as a version (see the file's comment). */
export async function makeNcrReport(files: FilesRuntime, caller: CommandCaller, ncrId: string, body: { readonly language?: DocumentLanguage | undefined }, idempotencyKey?: string) {
  const { row } = await visibleNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  const prepared = await prepareReport(files, caller, row, body.language)
  const result = prepared.current ? { ...prepared.current, made: false } : (await command(caller, { name: 'quality.ncrReport', idempotencyKey, input: { ncrId, ...body } }, async (tools) => keepReportInCommand(tools, ncrId, prepared))).result
  const kept = await caller.withClient((client) => client.generatedDocument.findUniqueOrThrow({ where: { id: result.id }, select: { id: true, version: true, language: true, number: true, fileId: true, createdAt: true, createdById: true } }))
  return { report: { ...kept, createdAt: toUtcIso(kept.createdAt) }, made: result.made }
}

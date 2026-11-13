import type { FastifyRequest } from 'fastify'
import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Grant } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { legalFooter, legalLines, legalName, legalProblems } from '@nexus/factory-domain/documents/legal'
import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { SALES_MTM_RECORD } from '@nexus/factory-domain/sales/mtm/permissions'
import { worksheetFingerprint, worksheetNumber, worksheetReport, WORKSHEET_KIND, type WorksheetInput } from '@nexus/factory-domain/sales/mtm/worksheet'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID, type SystemContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import { downloadFile, putGeneratedFile, recordGeneratedFile, systemCallerOf, type PreparedGeneratedFile } from '../../../platform/files/files'
import { processFiles, type FilesRuntime } from '../../../platform/files/service'
import { renderEightD } from '../../quality/capa/report-pdf'
import { assertMayProfile, measurementsOf, namesOf, officeOf, PROFILE_RECORD, profileNotFound, profileOf, templateOfGarment, unitsOf, type ProfileRow, type Reader } from './store'

/**
 * The made-to-measure worksheet and order form (B-W2b-358; SAL-303; design sales.mtm row verb "Print worksheet", new tab
 * "MTM worksheet and order form (PDF)": printed and signed at the fitting). A version per profile revision (GeneratedDocument
 * MTM_WORKSHEET 1, 2, …; recordType MeasurementProfile, recordId the revision, the company whose papers it is, no site) with its
 * PDF (a StoredFile of the same record and company: an OFFICE file, body measures are never shared from here):
 *
 *   GET  /sales/mtm/profiles/:profileId/worksheets                    sales.measurements.view: the revision's versions
 *   POST /sales/mtm/profiles/:profileId/worksheets                    sales.mtm.record over the customer and the company:
 *                                                                     {companyId, language?} keeps a version of the revision as it
 *                                                                     is; the same contents as the newest give it back (made: false)
 *   POST /sales/mtm/profiles/:profileId/worksheets/:documentId/open   sales.measurements.view: the PDF for 60 seconds, the opening
 *                                                                     recorded on the profile (body data: who looked, when)
 *
 * Making a version, as the NCR report: the facts read and composed (factory-domain sales/mtm/worksheet); its fingerprint against
 * the newest; the PDF painted by the CAPA module's renderer and put in the store OUTSIDE any transaction; ONE command under the
 * profile's worksheet lock: the StoredFile row, the GeneratedDocument row, audit, mtm_worksheet.made. The company's letterhead
 * must be complete (c.c. art. 2250): refused in words otherwise. A file of a MeasurementProfile is read through this module only
 * (platform/files MODULE_READ_FILES): files.read never reaches it.
 */

const UNIT_WORDS: Record<string, { it: string; en: string }> = {
  DRAFT: { it: 'Bozza', en: 'Draft' },
  PENDING_APPROVAL: { it: 'In attesa', en: 'Waiting' },
  APPROVED: { it: 'Approvato', en: 'Approved' },
  SENT: { it: 'Inviato', en: 'Sent' },
  ACCEPTED: { it: 'Accettato', en: 'Accepted' },
  CONFIRMED: { it: 'Confermato', en: 'Confirmed' },
  IN_PRODUCTION: { it: 'In produzione', en: 'In production' },
  READY: { it: 'Pronto', en: 'Ready' },
  PARTLY_SHIPPED: { it: 'Spedito in parte', en: 'Partly shipped' },
  SHIPPED: { it: 'Spedito', en: 'Shipped' },
  CLOSED: { it: 'Chiuso', en: 'Closed' },
  CANCELLED: { it: 'Annullato', en: 'Cancelled' },
}

const VERSION_COLUMNS = { id: true, recordId: true, version: true, companyId: true, fingerprint: true, language: true, number: true, fileId: true, createdAt: true, createdById: true } as const

const refusal = (issues: readonly { path: string; message: string }[]) => new DomainError('conflict', issues.length === 1 ? issues[0]!.message : "The company's letterhead is not complete: the worksheet cannot be printed.", [...issues])

/** The worksheet's facts for a revision (read with the caller's client). */
async function worksheetInputOf(db: Reader, row: ProfileRow, company: Awaited<ReturnType<typeof companyLegalOf>>, language: DocumentLanguage, version: number, now: Date): Promise<WorksheetInput> {
  const party = await db.party.findUnique({ where: { id: row.partyId }, select: { code: true, legalName: true } })
  const template = await templateOfGarment(db, row.garmentType)
  const names = await namesOf(db, [row.measuredByUserId, row.reviewedById])
  const values = measurementsOf(row.measurements)
  const points = (template?.points ?? []).filter((point) => point.status === 'ACTIVE' || values[point.code] !== undefined)
  const plain = (value: { toString(): string } | null) => (value === null ? null : decimalText(value.toString()))
  const rows = points.map((point) => {
    const unit = point.uom.toLowerCase()
    const min = plain(point.minValue)
    const max = plain(point.maxValue)
    return { code: point.code, name: point.name, value: values[point.code]?.value ?? null, unit: values[point.code]?.unit ?? unit, range: min !== null || max !== null ? `${min ?? '…'}–${max ?? '…'} ${unit}` : null }
  })
  const extra = Object.entries(values)
    .filter(([code]) => !points.some((point) => point.code === code))
    .map(([code, entry]) => ({ code, name: code === 'height' ? (language === 'it' ? 'Altezza' : 'Height') : code === 'weight' ? (language === 'it' ? 'Peso' : 'Weight') : code, value: entry.value, unit: entry.unit, range: null }))
  const units = (await unitsOf(db, [row.id])).map((unit) => ({ document: unit.number, style: unit.style.code, colourway: unit.colourway.code, baseSize: unit.baseSize, status: UNIT_WORDS[unit.status]?.[language] ?? unit.status }))
  const garmentName = template ? ((((template.nameI18n ?? {}) as Record<string, unknown>)[language] as string | undefined) ?? template.name) : row.garmentType
  return {
    language,
    date: businessDate(now),
    version,
    company: { name: legalName(company, language), lines: legalLines(company, language), legal: legalFooter(company, language) },
    customer: party ? `${party.legalName} (${party.code})` : '',
    rider: row.riderName,
    garment: { code: row.garmentType, name: garmentName },
    revision: row.revision,
    takenOn: businessDate(row.takenAt),
    takenBy: row.takenBy,
    measuredBy: row.measuredByUserId ? (names.get(row.measuredByUserId) ?? null) : null,
    measuredPlace: row.measuredPlace,
    baseSize: row.baseSize,
    review: { status: row.reviewStatus as WorksheetInput['review']['status'], by: row.reviewedById ? (names.get(row.reviewedById) ?? null) : null, on: row.reviewedAt ? businessDate(row.reviewedAt) : null, note: row.reviewNote },
    points: [...rows, ...extra],
    fitNotes: row.fitNotes,
    units,
  }
}

const languageOf = async (db: Reader, row: ProfileRow, asked: DocumentLanguage | undefined): Promise<DocumentLanguage> => {
  if (asked) return asked
  const party = await db.party.findUnique({ where: { id: row.partyId }, select: { language: true } })
  return party?.language === 'en' ? 'en' : 'it'
}

async function versionsOf(db: Reader, profileId: string) {
  return db.generatedDocument.findMany({ where: { recordType: PROFILE_RECORD, recordId: profileId, kind: WORKSHEET_KIND }, select: VERSION_COLUMNS, orderBy: { version: 'desc' } })
}

async function viewOf(db: Reader, row: ProfileRow, versions: Awaited<ReturnType<typeof versionsOf>>) {
  const names = await namesOf(db, versions.map((version) => version.createdById))
  return versions.map((version) => ({ id: version.id, profileId: version.recordId, revision: row.revision, version: version.version, companyId: version.companyId, language: version.language, number: version.number, fileId: version.fileId, createdAt: toUtcIso(version.createdAt), createdBy: version.createdById ? (names.get(version.createdById) ?? null) : null }))
}

async function readable(caller: CommandCaller, profileId: string) {
  const context = officeOf(caller)
  const row = await caller.withClient((db) => profileOf(db, profileId))
  if (!row) throw profileNotFound()
  assertMayProfile(context, row.partyId)
  return { context, row }
}

/** GET /sales/mtm/profiles/:profileId/worksheets */
export async function listWorksheets(caller: CommandCaller, profileId: string) {
  const { row } = await readable(caller, profileId)
  return caller.withClient(async (db) => ({ worksheets: await viewOf(db, row, await versionsOf(db, row.id)) }))
}

interface Prepared {
  readonly fingerprint: string
  readonly language: DocumentLanguage
  readonly current: { readonly id: string; readonly version: number; readonly fileId: string } | null
  readonly file: PreparedGeneratedFile | null
}

async function prepare(files: FilesRuntime, caller: CommandCaller, row: ProfileRow, companyId: string, asked: DocumentLanguage | undefined): Promise<Prepared> {
  const company = await companyLegalOf(caller, companyId)
  const problems = legalProblems(company)
  if (problems.length > 0) throw refusal(problems)
  const now = serverClock.now()
  const { input, versions } = await caller.withClient(async (db) => {
    const language = await languageOf(db, row, asked)
    const rows = await versionsOf(db, row.id)
    return { versions: rows, input: await worksheetInputOf(db, row, company, language, (rows[0]?.version ?? 0) + 1, now) }
  })
  const fingerprint = worksheetFingerprint(input)
  const newest = versions[0]
  if (newest && newest.fingerprint === fingerprint && newest.language === input.language && newest.companyId === companyId) return { fingerprint, language: input.language, current: { id: newest.id, version: newest.version, fileId: newest.fileId }, file: null }
  const report = worksheetReport(input)
  const file = await putGeneratedFile(files, caller, {
    companyId,
    recordType: PROFILE_RECORD,
    recordId: row.id,
    kind: 'DOCUMENT',
    originalName: report.fileName,
    contentType: 'application/pdf',
    body: await renderEightD(report),
    // Body measures: the office's file only.
    visibility: ['OFFICE'],
  })
  return { fingerprint, language: input.language, current: null, file }
}

async function keepInCommand(tools: CommandTools, row: ProfileRow, companyId: string, prepared: Prepared) {
  const { tx } = tools
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.mtm-worksheet', ${row.id}::uuid), 0))`
  const last = await tx.generatedDocument.findFirst({ where: { recordType: PROFILE_RECORD, recordId: row.id, kind: WORKSHEET_KIND }, select: VERSION_COLUMNS, orderBy: { version: 'desc' } })
  if (last && last.fingerprint === prepared.fingerprint && last.language === prepared.language && last.companyId === companyId) {
    // Another person kept the same version meanwhile: that version is the answer (the PDF just put in the store gets no row).
    tools.audit({ action: 'mtm.worksheet', recordType: PROFILE_RECORD, recordId: row.id, companyId, after: { generatedDocumentId: last.id, version: last.version, unchanged: true } })
    return { id: last.id, version: last.version, fileId: last.fileId, made: false }
  }
  const file = await recordGeneratedFile(tools, prepared.file!)
  const id = newId()
  const version = (last?.version ?? 0) + 1
  await tx.generatedDocument.create({
    data: { id, companyId, siteId: null, recordType: PROFILE_RECORD, recordId: row.id, kind: WORKSHEET_KIND, version, fingerprint: prepared.fingerprint, language: prepared.language, layout: null, number: worksheetNumber(row.garmentType, row.revision, version), fileId: file.id, createdAt: tools.now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
    select: { id: true },
  })
  tools.audit({ action: 'mtm.worksheet', recordType: PROFILE_RECORD, recordId: row.id, companyId, after: { generatedDocumentId: id, version, language: prepared.language, fileId: file.id, fingerprint: prepared.fingerprint } })
  tools.emit({ type: 'mtm_worksheet.made', subject: row.id, companyId, payload: { profileId: row.id, partyId: row.partyId, version, generatedDocumentId: id, fileId: file.id } })
  return { id, version, fileId: file.id, made: true }
}

/** POST /sales/mtm/profiles/:profileId/worksheets */
export async function makeWorksheet(caller: CommandCaller, profileId: string, body: { readonly companyId: string; readonly language?: DocumentLanguage | undefined }, idempotencyKey?: string) {
  const { context, row } = await readable(caller, profileId)
  const company = await caller.withClient((db) => db.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))
  if (!company) throw new ValidationError('Not a company of yours.', [{ path: 'body/companyId', message: 'Not a company of yours.' }])
  assertMayProfile(context, row.partyId, SALES_MTM_RECORD)
  if (!can(actorOf(context), SALES_MTM_RECORD, { partyId: row.partyId, companyId: company.id })) throw new ValidationError('Your roles do not print for this company.', [{ path: 'body/companyId', message: 'Your roles do not print for this company.' }])
  const prepared = await prepare(processFiles(), caller, row, company.id, body.language)
  // The newest version shows the revision as it is: nothing is written, the newest is the answer.
  const result = prepared.current ? { ...prepared.current, made: false } : (await command(caller, { name: 'mtm.worksheet', idempotencyKey, input: { profileId, ...body } }, (tools) => keepInCommand(tools, row, company.id, prepared))).result
  return caller.withClient(async (db) => {
    const versions = await versionsOf(db, row.id)
    return { worksheet: { id: result.id, version: result.version, fileId: result.fileId, made: result.made }, worksheets: await viewOf(db, row, versions) }
  })
}

/** The tenant's system caller holding exactly these permissions over one company (the store reads the file as it). */
function companyReader(request: FastifyRequest, tenantId: string, companyId: string): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [FILES_READ], companies: [companyId], sites: 'all', parties: 'all' }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

/** POST /sales/mtm/profiles/:profileId/worksheets/:documentId/open */
export async function openWorksheet(request: FastifyRequest, profileId: string, documentId: string, idempotencyKey?: string) {
  const { context, row } = await readable(request, profileId)
  const sheet = isUuid(documentId) ? await request.withClient((db) => db.generatedDocument.findFirst({ where: { id: documentId, recordType: PROFILE_RECORD, recordId: row.id, kind: WORKSHEET_KIND }, select: VERSION_COLUMNS })) : null
  if (!sheet) throw new NotFoundError('Worksheet not found.')
  await command(request, { name: 'mtm.worksheetOpened', idempotencyKey, input: { profileId, documentId } }, async (tools) => {
    tools.audit({ action: 'mtm.worksheetOpened', recordType: PROFILE_RECORD, recordId: row.id, companyId: sheet.companyId, after: { generatedDocumentId: sheet.id, version: sheet.version, fileId: sheet.fileId, by: context.actorId } })
    return null
  })
  const reader = companyReader(request, context.tenantId, sheet.companyId)
  return { worksheet: { id: sheet.id, version: sheet.version, fileId: sheet.fileId }, download: await downloadFile(processFiles(), { caller: reader, system: systemCallerOf(request) }, sheet.fileId, { viaModule: true }) }
}

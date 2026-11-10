import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { namesEntry } from '@nexus/factory-domain/compliance/register-of-rules/rules'
import { TECHFILES_MANAGE, TECHFILES_SHARE, TECHFILES_SIGN, TECHFILES_VIEW } from '@nexus/factory-domain/compliance/techfiles/permissions'
import {
  ANNEX_III_POINTS,
  annexSummary,
  completeProblems,
  evidenceProblems,
  isEvidenceFileRecordType,
  ITEMS_PER_POINT_MAX,
  POINT_INFO,
  retainUntilOf,
  retentionState,
  type AnnexIIIPoint,
  type ItemState,
  type PointState,
} from '@nexus/factory-domain/compliance/techfiles/rules'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, holds, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { runCommand, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { readsThroughModule } from '../../../platform/files/owned'
import { retainFilesInCommand } from '../../../platform/files/files'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { assertMay, dateOfDay, dayOf, guarded, mayOn, namesFor, officeOf, settings, techfilesClock, todayOf, type Reader } from './common'
import { batchesOf, productionSummary } from './production'
import {
  certificateRef,
  coveringCertificates,
  evidenceOf,
  fileReach,
  FILE_SELECT,
  ITEM_SELECT,
  NOT_FOUND,
  pointsOf,
  readEvidenceFiles,
  readFile,
  readItems,
  readStyle,
  resolveRecords,
  STYLE_SELECT,
  type EvidenceView,
  type FileRow,
  type ItemRow,
  type StyleRow,
} from './store'

/**
 * Technical files (B-W2b-251; PRD-296, QHS-110; design compliance.techfiles › grid, tiles and the record's Annex III checklist;
 * PPE Reg. (EU) 2016/425 Annex III, art. 8(3)). One live file per style (the database's partial unique index), numbered from
 * its company's TECHNICAL_FILE series; each Annex III point (a) to (m) lists its evidence — a record or a file, linked, never
 * copied — and its state; OPEN while the evidence is gathered, COMPLETE once every point is reviewed or not applicable (and a
 * category II or III style names its certificate), back to OPEN with the reason when something changes, ARCHIVED with the
 * reason when the style leaves the market, then kept ten years (its evidence files too) and frozen.
 *
 *   GET    /compliance/techfiles?status&q&styleId&tile          certificates.view: rows + the tiles
 *   POST   /compliance/techfiles                                 techfiles.manage over the file's company
 *   GET    /compliance/techfiles/:fileId                         certificates.view: the record with the Annex III checklist
 *   PATCH  /compliance/techfiles/:fileId                         techfiles.manage: certificate (OPEN), keeper, note, a later keep-until (ARCHIVED)
 *   POST   /compliance/techfiles/:fileId/complete|reopen|archive techfiles.manage
 *   GET    /compliance/techfiles/:fileId/evidence-options?point  certificates.view: records and files that may be linked
 *   POST   /compliance/techfiles/:fileId/items                   techfiles.manage (OPEN): another item of a point
 *   PATCH  /compliance/techfiles/:fileId/items/:itemId           techfiles.manage (OPEN): link, unlink, review, not applicable, note
 *   DELETE /compliance/techfiles/:fileId/items/:itemId?version=  techfiles.manage (OPEN)
 *
 * Every write is ONE command (audit row, technical_file.* event, Idempotency-Key, the row's version as the edit-conflict
 * guard); a database refusal answers 409 in words (common.ts guarded).
 */

const WHAT = 'Keeping a technical file'

// ---- what a file shows -----------------------------------------------------------------------------------------------------

interface Gathered {
  readonly styles: Map<string, StyleRow>
  readonly items: Map<string, ItemRow[]>
  readonly certificates: Map<string, ReturnType<typeof certificateRef>[]>
  readonly named: Map<string, ReturnType<typeof certificateRef>>
  readonly risks: Map<string, { id: string; revision: number; status: string; signedAt: Date | null }[]>
  readonly production: Map<string, ReturnType<typeof productionSummary> & { latest: { workOrderId: string; number: string; batchNumber: string | null } | null }>
  readonly reports: Map<string, { count: number; latestOn: BusinessDate | null }>
  readonly names: (id: string | null) => { id: string; name: string } | null
  readonly lastChange: Map<string, Date>
}

async function gather(db: Reader, files: readonly FileRow[]): Promise<Gathered> {
  const styleIds = [...new Set(files.map((file) => file.styleId))]
  const fileIds = files.map((file) => file.id)
  const styles = new Map((await db.style.findMany({ where: { id: { in: styleIds } }, select: STYLE_SELECT })).map((row) => [row.id, row]))
  const itemRows = await readItems(db, fileIds)
  const items = new Map<string, ItemRow[]>()
  for (const row of itemRows) items.set(row.technicalFileId, [...(items.get(row.technicalFileId) ?? []), row])
  const covering = await coveringCertificates(db, styleIds)
  const certificates = new Map([...covering].map(([styleId, rows]) => [styleId, rows.map(certificateRef)]))
  const namedIds = files.map((file) => file.certificateId).filter((value): value is string => value !== null)
  const named = new Map(
    (await db.certificate.findMany({ where: { id: { in: namedIds } }, select: { id: true, number: true, standard: true, status: true, validFrom: true, validTo: true, notifiedBodyName: true, notifiedBodyNumber: true, companyId: true } })).map((row) => [row.id, certificateRef(row)]),
  )
  const riskRows = await db.productRiskAssessment.findMany({ where: { technicalFileId: { in: fileIds } }, select: { id: true, technicalFileId: true, revision: true, status: true, signedAt: true }, orderBy: [{ revision: 'desc' }] })
  const risks = new Map<string, { id: string; revision: number; status: string; signedAt: Date | null }[]>()
  for (const row of riskRows) risks.set(row.technicalFileId, [...(risks.get(row.technicalFileId) ?? []), row])
  const { batches, tests } = await batchesOf(db, styleIds)
  const production = new Map(
    styleIds.map((styleId) => {
      const rows = batches.get(styleId) ?? []
      const latest = rows.find((row) => row.done) ?? null
      return [styleId, { ...productionSummary(rows), latest: latest ? { workOrderId: latest.workOrder.id, number: latest.workOrder.number, batchNumber: latest.workOrder.batchNumber } : null }]
    }),
  )
  const reports = new Map(
    styleIds.map((styleId) => {
      const recorded = (tests.get(styleId) ?? []).filter((row) => row.result !== null && row.testedOn !== null)
      const latest = recorded.reduce<Date | null>((at, row) => (at === null || row.testedOn! > at ? row.testedOn! : at), null)
      return [styleId, { count: recorded.length, latestOn: dayOf(latest) }]
    }),
  )
  const lastChange = new Map<string, Date>()
  for (const file of files) {
    const own = items.get(file.id) ?? []
    lastChange.set(file.id, own.reduce((latest, row) => (row.updatedAt > latest ? row.updatedAt : latest), file.updatedAt))
  }
  const names = await namesFor(db, [...files.flatMap((file) => [file.keeperId, file.completedById, file.archivedById, file.createdById]), ...itemRows.map((row) => row.reviewedById)])
  return { styles, items, certificates, named, risks, production, reports, names, lastChange }
}

function summaryOf(file: FileRow, gathered: Gathered, actor: Actor, today: BusinessDate) {
  const style = gathered.styles.get(file.styleId)
  const items = gathered.items.get(file.id) ?? []
  const annex = annexSummary(items.map((item) => ({ point: item.point as AnnexIIIPoint, state: item.state as ItemState })))
  const risk = gathered.risks.get(file.id)?.[0] ?? null
  const covering = gathered.certificates.get(file.styleId) ?? []
  const production = gathered.production.get(file.styleId)
  const retainUntil = dayOf(file.retainUntil)
  return {
    id: file.id,
    number: file.number,
    status: file.status,
    companyId: file.companyId,
    style: style ? { id: style.id, code: style.code, name: style.name, ppeCategory: style.ppeCategory, ppeClass: style.ppeClass } : { id: file.styleId, code: '?', name: '?', ppeCategory: 'NOT_PPE', ppeClass: null },
    certificate: file.certificateId ? (gathered.named.get(file.certificateId) ?? null) : null,
    certificates: { valid: covering.filter((row) => row.status === 'VALID').length, all: covering.length },
    annex: { done: annex.done, outOf: annex.outOf, open: annex.open, missingItems: annex.missingItems },
    risk: risk ? { id: risk.id, revision: risk.revision, status: risk.status, signedAt: risk.signedAt ? toUtcIso(risk.signedAt) : null } : null,
    testReports: gathered.reports.get(file.styleId) ?? { count: 0, latestOn: null },
    production: production ? { made: production.made, withEvidence: production.withEvidence, missing: production.missing, failed: production.failed, inProgress: production.inProgress } : { made: 0, withEvidence: 0, missing: 0, failed: 0, inProgress: 0 },
    latestBatch: production?.latest ?? null,
    keeper: gathered.names(file.keeperId),
    lastChangeAt: toUtcIso(gathered.lastChange.get(file.id) ?? file.updatedAt),
    retainUntil,
    retention: retentionState(retainUntil, today),
    may: { manage: mayOn(actor, TECHFILES_MANAGE, file.companyId), sign: mayOn(actor, TECHFILES_SIGN, file.companyId), share: mayOn(actor, TECHFILES_SHARE, file.companyId) },
    version: file.version,
  }
}
export type FileSummary = ReturnType<typeof summaryOf>

export const LIST_TILES = ['COMPLETE', 'ITEMS_MISSING', 'BATCHES_WITHOUT_EVIDENCE', 'RETENTION_ENDING', 'AUTHORITY_PACKS'] as const
export type ListTile = (typeof LIST_TILES)[number]

export interface ListQuery {
  readonly status?: 'OPEN' | 'COMPLETE' | 'ARCHIVED' | undefined
  readonly q?: string | undefined
  readonly styleId?: string | undefined
  readonly tile?: ListTile | undefined
}

/** GET /compliance/techfiles: the grid's rows and the five tiles (saved filters). */
export async function listFiles(request: FastifyRequest, query: ListQuery) {
  const actor = actorOf(officeOf(request))
  const now = techfilesClock().now()
  const today = todayOf(now)
  const yearStart = `${today.slice(0, 4)}-01-01`
  return request.withClient(async (db) => {
    const where: Prisma.TechnicalFileWhereInput[] = [fileReach(actor)]
    if (query.status) where.push({ status: query.status })
    if (query.styleId) where.push({ styleId: query.styleId })
    let files = await db.technicalFile.findMany({ where: { AND: where }, select: FILE_SELECT, orderBy: [{ number: 'asc' }, { id: 'asc' }] })
    const gathered = await gather(db, files)
    if (query.q) {
      const q = query.q.toLowerCase()
      files = files.filter((file) => {
        const style = gathered.styles.get(file.styleId)
        return file.number.toLowerCase().includes(q) || (style !== undefined && (style.code.toLowerCase().includes(q) || style.name.toLowerCase().includes(q)))
      })
    }
    let rows = files.map((file) => summaryOf(file, gathered, actor, today))

    // The tiles' facts beyond the rows: the packs, the recorded tests' keeping and the files on legal hold.
    const fileIds = files.map((file) => file.id)
    const packs = await db.evidencePack.findMany({ where: { technicalFileId: { in: fileIds } }, select: { id: true, technicalFileId: true, purpose: true, status: true, builtAt: true, fileId: true, zipFileId: true, retainUntil: true } })
    const packFiles = packs.flatMap((pack) => [pack.fileId, pack.zipFileId]).filter((value): value is string => value !== null)
    const shared = new Set((await db.linkFile.findMany({ where: { fileId: { in: packFiles } }, select: { fileId: true } })).map((row) => row.fileId))
    const sentThisYear = new Set(
      packs.filter((pack) => pack.purpose === 'AUTHORITY' && pack.status === 'BUILT' && pack.builtAt !== null && toUtcIso(pack.builtAt).slice(0, 10) >= yearStart && [pack.fileId, pack.zipFileId].some((id) => id !== null && shared.has(id))),
    )
    const styleIds = [...new Set(files.map((file) => file.styleId))]
    const recordedTests = await db.productionControlTest.findMany({ where: { styleId: { in: styleIds }, result: { not: null } }, select: { id: true, styleId: true, retainUntil: true, labReportFileId: true } })
    const itemFiles = [...gathered.items.values()].flat().map((item) => item.fileId).filter((value): value is string => value !== null)
    const held = await db.storedFile.count({ where: { id: { in: [...new Set([...packFiles, ...itemFiles, ...recordedTests.map((test) => test.labReportFileId).filter((value): value is string => value !== null)])] }, legalHold: true } })
    const ending = (day: Date | null) => retentionState(dayOf(day), today) === 'ENDS_WITHIN_YEAR'
    const endingStyles = new Set([...files.filter((file) => ending(file.retainUntil)).map((file) => file.styleId), ...recordedTests.filter((test) => ending(test.retainUntil)).map((test) => test.styleId)])
    const endingFiles = new Set(packs.filter((pack) => ending(pack.retainUntil)).map((pack) => pack.technicalFileId))
    const live = rows.filter((row) => row.status !== 'ARCHIVED')
    const tiles = {
      complete: rows.filter((row) => row.status === 'COMPLETE').length,
      withItemsMissing: live.filter((row) => row.annex.missingItems > 0).length,
      itemsMissing: live.reduce((sum, row) => sum + row.annex.missingItems, 0),
      batchesWithoutEvidence: live.reduce((sum, row) => sum + row.production.missing + row.production.failed, 0),
      retentionEndingInYear:
        files.filter((file) => ending(file.retainUntil)).length + recordedTests.filter((test) => ending(test.retainUntil)).length + packs.filter((pack) => ending(pack.retainUntil)).length,
      onLegalHold: held,
      authorityPacksSentThisYear: sentThisYear.size,
    }
    if (query.tile === 'COMPLETE') rows = rows.filter((row) => row.status === 'COMPLETE')
    if (query.tile === 'ITEMS_MISSING') rows = live.filter((row) => row.annex.missingItems > 0)
    if (query.tile === 'BATCHES_WITHOUT_EVIDENCE') rows = live.filter((row) => row.production.missing + row.production.failed > 0)
    if (query.tile === 'RETENTION_ENDING') rows = rows.filter((row) => endingStyles.has(row.style.id) || endingFiles.has(row.id))
    if (query.tile === 'AUTHORITY_PACKS') rows = rows.filter((row) => [...sentThisYear].some((pack) => pack.technicalFileId === row.id))
    const mayCreate = holds(actor, TECHFILES_MANAGE)
    return { files: rows, tiles, mayCreate, asOf: toUtcIso(now) }
  })
}

function itemView(item: ItemRow, evidence: (item: ItemRow) => EvidenceView | null, names: Gathered['names']) {
  return {
    id: item.id,
    point: item.point as AnnexIIIPoint,
    seq: item.seq,
    state: item.state as ItemState,
    evidence: evidence(item),
    note: item.note,
    reviewedAt: item.reviewedAt ? toUtcIso(item.reviewedAt) : null,
    reviewedBy: names(item.reviewedById),
    version: item.version,
    updatedAt: toUtcIso(item.updatedAt),
  }
}
export type ItemView = ReturnType<typeof itemView>

async function recordOf(db: Reader, file: FileRow, actor: Actor, now: Date) {
  const today = todayOf(now)
  const gathered = await gather(db, [file])
  const items = gathered.items.get(file.id) ?? []
  const evidence = await evidenceOf(db, items)
  const summary = annexSummary(items.map((item) => ({ point: item.point as AnnexIIIPoint, state: item.state as ItemState })))
  const style = gathered.styles.get(file.styleId)
  const risks = gathered.risks.get(file.id) ?? []
  const signed = risks.find((risk) => risk.status === 'SIGNED') ?? null
  const draft = risks.find((risk) => risk.status === 'DRAFT') ?? null
  return {
    file: {
      ...summaryOf(file, gathered, actor, today),
      note: file.note,
      completedAt: file.completedAt ? toUtcIso(file.completedAt) : null,
      completedBy: gathered.names(file.completedById),
      archivedAt: file.archivedAt ? toUtcIso(file.archivedAt) : null,
      archivedBy: gathered.names(file.archivedById),
      archiveReason: file.archiveReason,
      createdAt: toUtcIso(file.createdAt),
      createdBy: gathered.names(file.createdById),
    },
    points: summary.points.map((entry) => ({
      point: entry.point,
      letter: entry.letter,
      law: POINT_INFO[entry.point].law,
      title: { en: POINT_INFO[entry.point].en, it: POINT_INFO[entry.point].it },
      state: entry.state as PointState,
      items: items.filter((item) => item.point === entry.point).map((item) => itemView(item, evidence, gathered.names)),
    })),
    risk: {
      signed: signed ? { id: signed.id, revision: signed.revision, signedAt: signed.signedAt ? toUtcIso(signed.signedAt) : null } : null,
      draft: draft ? { id: draft.id, revision: draft.revision } : null,
    },
    completeProblems: file.status === 'OPEN' ? completeProblems({ status: file.status, items: items.map((item) => ({ point: item.point as AnnexIIIPoint, state: item.state as ItemState })), ppeCategory: style?.ppeCategory ?? 'NOT_PPE', certificateId: file.certificateId }) : [],
    asOf: toUtcIso(now),
  }
}
export type FileRecord = Awaited<ReturnType<typeof recordOf>>

/** GET /compliance/techfiles/:fileId */
export async function getFile(request: FastifyRequest, fileId: string): Promise<FileRecord> {
  const actor = actorOf(officeOf(request))
  const now = techfilesClock().now()
  return request.withClient(async (db) => recordOf(db, await readFile(db, actor, fileId), actor, now))
}

/** The record as it stands after a command (read again: plain JSON out of the transaction). */
const answerOf = (caller: CommandCaller, fileId: string): Promise<FileRecord> => {
  const actor = actorOf(officeOf(caller))
  return caller.withClient(async (db) => recordOf(db, await readFile(db, actor, fileId), actor, techfilesClock().now()))
}

// ---- commands ----------------------------------------------------------------------------------------------------------------

const fileEvent = (tools: Pick<CommandTools, 'emit'>, file: Pick<FileRow, 'id' | 'number' | 'styleId' | 'status' | 'companyId'>, change: 'CREATED' | 'EDITED' | 'COMPLETED' | 'REOPENED' | 'ARCHIVED') =>
  tools.emit({ type: 'technical_file.changed', subject: file.id, companyId: file.companyId, payload: { technicalFileId: file.id, number: file.number, styleId: file.styleId, status: file.status, change } })

const itemEvent = (tools: Pick<CommandTools, 'emit'>, file: Pick<FileRow, 'id' | 'companyId'>, item: { id: string; point: string; state: string | null }, change: 'ADDED' | 'LINKED' | 'REVIEWED' | 'NOT_APPLICABLE' | 'UNLINKED' | 'EDITED' | 'REMOVED') =>
  tools.emit({ type: 'technical_file.item_changed', subject: file.id, companyId: file.companyId, payload: { technicalFileId: file.id, itemId: item.id, point: item.point as AnnexIIIPoint, state: item.state as ItemState | null, change } })

const fileAudit = (row: Pick<FileRow, 'number' | 'styleId' | 'certificateId' | 'status' | 'keeperId' | 'note' | 'retainUntil'>) => ({
  number: row.number,
  styleId: row.styleId,
  certificateId: row.certificateId,
  status: row.status,
  keeperId: row.keeperId,
  note: row.note,
  retainUntil: dayOf(row.retainUntil),
})

async function assertCovers(tx: Reader, certificateId: string, styleId: string, at = 'body/certificateId'): Promise<void> {
  const coverage = await tx.certificateCoverage.findFirst({ where: { certificateId, styleId }, select: { id: true } })
  if (!coverage) throw new ValidationError('The certificate does not cover this style.', [{ path: at, message: 'Name a certificate that covers this style (its coverage lists the style).' }])
}

async function assertKeeper(tx: Reader, keeperId: string): Promise<void> {
  const user = await tx.user.findUnique({ where: { id: keeperId }, select: { status: true } })
  if (!user || user.status !== 'ACTIVE') throw new ValidationError('The keeper is not valid.', [{ path: 'body/keeperId', message: 'Choose an active office user to keep the file up to date.' }])
}

interface SuggestedItem {
  readonly point: AnnexIIIPoint
  readonly recordType?: string
  readonly recordId?: string
  readonly fileId?: string
}

/** The evidence a new file links at once (LINKED, never reviewed by the system): the obvious record of each point. */
async function suggestionsFor(tx: CommandTx, style: StyleRow, certificateId: string | null): Promise<SuggestedItem[]> {
  const out: SuggestedItem[] = [{ point: 'A_DESCRIPTION', recordType: 'Style', recordId: style.id }]
  const revisions = await tx.styleRevision.findMany({ where: { styleId: style.id }, select: { id: true, revision: true, status: true }, orderBy: [{ revision: 'desc' }] })
  const current = revisions.find((row) => row.status === 'RELEASED') ?? revisions[0] ?? null
  if (current) {
    out.push({ point: 'D_DRAWINGS', recordType: 'StyleRevision', recordId: current.id })
    const patterns = await tx.styleRevisionFile.findMany({ where: { revisionId: current.id, kind: { in: ['PATTERN', 'CAD'] } }, select: { id: true }, orderBy: [{ createdAt: 'asc' }], take: 5 })
    for (const pattern of patterns) out.push({ point: 'D_DRAWINGS', recordType: 'StyleRevisionFile', recordId: pattern.id })
  }
  const documents = await tx.complianceDocument.findMany({ where: { styleId: style.id, origin: 'SIGNED', status: 'ISSUED' }, select: { id: true, kind: true, revision: true }, orderBy: [{ revision: 'desc' }, { language: 'asc' }] })
  for (const kind of ['DECLARATION_OF_CONFORMITY', 'USER_INFORMATION'] as const) {
    const own = documents.filter((row) => row.kind === kind)
    const newest = own[0]?.revision
    for (const document of own.filter((row) => row.revision === newest).slice(0, 5)) out.push({ point: kind === 'DECLARATION_OF_CONFORMITY' ? 'C_REQUIREMENTS' : 'K_USER_INFORMATION', recordType: 'ComplianceDocument', recordId: document.id })
  }
  const covering = (await coveringCertificates(tx, [style.id])).get(style.id) ?? []
  const certificates = certificateId ? covering.filter((row) => row.id === certificateId) : covering.filter((row) => row.status === 'VALID').slice(0, 3)
  for (const certificate of certificates) {
    out.push({ point: 'F_STANDARDS', recordType: 'Certificate', recordId: certificate.id }, { point: 'I_TEST_REPORTS', recordType: 'Certificate', recordId: certificate.id })
  }
  const typed = [style.ppeStandard, ...certificates.map((row) => row.standard)].filter((value): value is string => value !== null && value.trim() !== '')
  if (typed.length > 0) {
    const entries = await tx.regulationOrStandard.findMany({ where: { status: 'IN_FORCE' }, select: { id: true, code: true, edition: true } })
    for (const entry of entries.filter((row) => typed.some((value) => namesEntry(value, row))).slice(0, 5)) out.push({ point: 'F_STANDARDS', recordType: 'RegulationOrStandard', recordId: entry.id })
  }
  return out
}

export interface CreateBody {
  readonly styleId: string
  readonly companyId?: string | undefined
  readonly certificateId?: string | null | undefined
  readonly keeperId?: string | null | undefined
  readonly note?: string | null | undefined
  /** Link the obvious evidence at once (default true): the style, its released revision, the issued DoC and user information, the certificate and the standards. */
  readonly suggest?: boolean | undefined
}

/** POST /compliance/techfiles */
export async function createFile(caller: CommandCaller, body: CreateBody, key: string | null | undefined): Promise<FileRecord> {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const style = await caller.withClient((db) => readStyle(db, body.styleId).catch(() => null))
  if (!style || !can(actor, TECHFILES_VIEW, { companyId: style.companyId })) throw new NotFoundError('Style not found.')
  // One live file per style: said first, before anything else is asked of the person.
  const live = await caller.withClient((db) => db.technicalFile.findFirst({ where: { styleId: style.id, status: { not: 'ARCHIVED' } }, select: { number: true, status: true } }))
  if (live) throw new ConflictError(`Style ${style.code} has technical file ${live.number} (${live.status}): one live file per style. Open that one.`)
  const companyId = style.companyId ?? body.companyId ?? null
  if (companyId === null) throw new ValidationError('Say which company keeps the file.', [{ path: 'body/companyId', message: `Style ${style.code} is every company's: say which company keeps its technical file.` }])
  if (style.companyId !== null && body.companyId !== undefined && body.companyId !== style.companyId) {
    throw new ValidationError('The company is not valid.', [{ path: 'body/companyId', message: `Style ${style.code} is company ${style.companyId}'s: its file is that company's.` }])
  }
  assertMay(context, TECHFILES_MANAGE, companyId, WHAT)
  const { result } = await guarded(
    () =>
      runCommand(
        caller,
        { name: 'compliance.techfiles.create', idempotencyKey: key, input: body },
        async (tools) => {
          const { tx, now, audit } = tools
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.technical-file', ${context.tenantId}::uuid, ${style.id}::uuid), 0))`
          const live = await tx.technicalFile.findFirst({ where: { styleId: style.id, status: { not: 'ARCHIVED' } }, select: { number: true, status: true } })
          if (live) throw new ConflictError(`Style ${style.code} has technical file ${live.number} (${live.status}): one live file per style. Open that one.`)
          if (body.certificateId) await assertCovers(tx, body.certificateId, style.id)
          if (body.keeperId) await assertKeeper(tx, body.keeperId)
          const id = newId()
          const issued = await allocateNumber(tools, { companyId, kind: 'TECHNICAL_FILE' }, { type: 'TechnicalFile', id })
          const row = await tx.technicalFile.create({
            data: { id, companyId, number: issued.formatted, styleId: style.id, certificateId: body.certificateId ?? null, keeperId: body.keeperId ?? null, note: body.note ?? null, createdAt: now, updatedAt: now, createdById: context.actorId },
            select: FILE_SELECT,
          })
          const suggested = body.suggest === false ? [] : await suggestionsFor(tx, style, body.certificateId ?? null)
          const items: Prisma.TechnicalFileItemCreateManyInput[] = []
          for (const point of ANNEX_III_POINTS) {
            const own = suggested.filter((entry) => entry.point === point)
            if (own.length === 0) items.push({ id: newId(), technicalFileId: id, point, seq: 1, state: 'MISSING', createdAt: now, updatedAt: now, createdById: context.actorId })
            own.forEach((entry, index) =>
              items.push({ id: newId(), technicalFileId: id, point, seq: index + 1, state: 'LINKED', recordType: entry.recordType ?? null, recordId: entry.recordId ?? null, fileId: entry.fileId ?? null, createdAt: now, updatedAt: now, createdById: context.actorId }),
            )
          }
          await tx.technicalFileItem.createMany({ data: items })
          audit({ recordType: 'TechnicalFile', recordId: id, companyId, after: { ...fileAudit(row), items: items.length, linked: suggested.length } })
          fileEvent(tools, row, 'CREATED')
          return { id }
        },
        settings(),
      ),
    { taken: `Style ${style.code} has a live technical file already: one per style.` },
  )
  return answerOf(caller, result.id)
}

/** The file read again under its row lock, with the caller's right to keep it. */
async function lockedFile(tx: CommandTx, context: OfficeContext, fileId: string): Promise<FileRow> {
  const row = await tx.technicalFile.findUnique({ where: { id: fileId }, select: FILE_SELECT })
  if (!row || !can(actorOf(context), TECHFILES_VIEW, { companyId: row.companyId })) throw new NotFoundError(NOT_FOUND)
  assertMay(context, TECHFILES_MANAGE, row.companyId, WHAT)
  return row
}

export interface EditBody {
  readonly version: number
  readonly certificateId?: string | null | undefined
  readonly keeperId?: string | null | undefined
  readonly note?: string | null | undefined
  readonly retainUntil?: BusinessDate | undefined
}

/** PATCH /compliance/techfiles/:fileId */
export async function editFile(caller: CommandCaller, fileId: string, body: EditBody, key: string | null | undefined): Promise<FileRecord> {
  const context = officeOf(caller)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.edit', idempotencyKey: key, input: { fileId, ...body }, record: { type: 'TechnicalFile', id: fileId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const before = await lockedFile(tx, context, fileId)
        const data: Prisma.TechnicalFileUncheckedUpdateInput = { updatedAt: now }
        if (before.status === 'ARCHIVED' && (body.certificateId !== undefined || body.keeperId !== undefined)) {
          throw new ConflictError(`Technical file ${before.number} is archived: only its note and a later keep-until day change.`)
        }
        if (body.certificateId !== undefined && body.certificateId !== before.certificateId) {
          if (before.status !== 'OPEN') throw new ConflictError(`Technical file ${before.number} is ${before.status}: its certificate changes only while it is OPEN (reopen it first).`)
          if (body.certificateId !== null) await assertCovers(tx, body.certificateId, before.styleId)
          data.certificateId = body.certificateId
        }
        if (body.keeperId !== undefined) {
          if (body.keeperId !== null) await assertKeeper(tx, body.keeperId)
          data.keeperId = body.keeperId
        }
        if (body.note !== undefined) data.note = body.note
        if (body.retainUntil !== undefined) {
          if (before.status !== 'ARCHIVED') throw new ValidationError('The keep-until day is set by archiving.', [{ path: 'body/retainUntil', message: 'An open or complete file has no keep-until day yet: archive it with one.' }])
          if (before.retainUntil && body.retainUntil < dayOf(before.retainUntil)!) {
            throw new ValidationError('A keep-until day only moves later.', [{ path: 'body/retainUntil', message: `Technical file ${before.number} is kept until ${dayOf(before.retainUntil)}; give that day or a later one.` }])
          }
          data.retainUntil = dateOfDay(body.retainUntil)
        }
        const row = await tx.technicalFile.update({ where: { id: fileId }, data, select: FILE_SELECT })
        audit({ recordType: 'TechnicalFile', recordId: fileId, companyId: row.companyId, before: fileAudit(before), after: fileAudit(row) })
        fileEvent(tools, row, 'EDITED')
        return { id: fileId }
      },
      settings(),
    ),
  )
  return answerOf(caller, fileId)
}

/** POST /compliance/techfiles/:fileId/complete {version} */
export async function completeFile(caller: CommandCaller, fileId: string, body: { readonly version: number }, key: string | null | undefined): Promise<FileRecord> {
  const context = officeOf(caller)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.complete', idempotencyKey: key, input: { fileId, ...body }, record: { type: 'TechnicalFile', id: fileId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const before = await lockedFile(tx, context, fileId)
        const style = await readStyle(tx, before.styleId)
        const items = await readItems(tx, [fileId])
        const problems = completeProblems({ status: before.status, items: items.map((item) => ({ point: item.point as AnnexIIIPoint, state: item.state as ItemState })), ppeCategory: style.ppeCategory, certificateId: before.certificateId })
        if (problems.length > 0) throw new DomainError('conflict', problems.length === 1 ? problems[0]!.message : `Technical file ${before.number} is not complete yet: ${problems.length} things are open.`, problems)
        const row = await tx.technicalFile.update({ where: { id: fileId }, data: { status: 'COMPLETE', completedAt: now, completedById: context.actorId, updatedAt: now }, select: FILE_SELECT })
        audit({ recordType: 'TechnicalFile', recordId: fileId, companyId: row.companyId, before: { status: before.status }, after: { status: 'COMPLETE' } })
        fileEvent(tools, row, 'COMPLETED')
        return { id: fileId }
      },
      settings(),
    ),
  )
  return answerOf(caller, fileId)
}

/** Back to OPEN inside another command (a new signed risk assessment changes point (b)): the completion cleared. */
export async function reopenInCommand(tools: CommandTools, file: FileRow, reason: string): Promise<FileRow> {
  const row = await tools.tx.technicalFile.update({ where: { id: file.id }, data: { status: 'OPEN', completedAt: null, completedById: null, updatedAt: tools.now, version: { increment: 1 } }, select: FILE_SELECT })
  tools.audit({ action: 'compliance.techfiles.reopen', recordType: 'TechnicalFile', recordId: file.id, companyId: file.companyId, before: { status: file.status }, after: { status: 'OPEN' }, reason })
  fileEvent(tools, row, 'REOPENED')
  return row
}

/** POST /compliance/techfiles/:fileId/reopen {version, reason} */
export async function reopenFile(caller: CommandCaller, fileId: string, body: { readonly version: number; readonly reason: string }, key: string | null | undefined): Promise<FileRecord> {
  const context = officeOf(caller)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.reopen', idempotencyKey: key, input: { fileId, ...body }, record: { type: 'TechnicalFile', id: fileId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const before = await lockedFile(tx, context, fileId)
        if (before.status !== 'COMPLETE') throw new ConflictError(before.status === 'OPEN' ? `Technical file ${before.number} is open already.` : `Technical file ${before.number} is archived: it is kept as it is, never reopened.`)
        const row = await tx.technicalFile.update({ where: { id: fileId }, data: { status: 'OPEN', completedAt: null, completedById: null, updatedAt: now }, select: FILE_SELECT })
        audit({ recordType: 'TechnicalFile', recordId: fileId, companyId: row.companyId, before: { status: 'COMPLETE' }, after: { status: 'OPEN' }, reason: body.reason })
        fileEvent(tools, row, 'REOPENED')
        return { id: fileId }
      },
      settings(),
    ),
  )
  return answerOf(caller, fileId)
}

/** POST /compliance/techfiles/:fileId/archive {version, reason, retainUntil?}: kept ten years, with the files its evidence links. */
export async function archiveFile(caller: CommandCaller, fileId: string, body: { readonly version: number; readonly reason: string; readonly retainUntil?: BusinessDate | undefined }, key: string | null | undefined): Promise<FileRecord> {
  const context = officeOf(caller)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.archive', idempotencyKey: key, input: { fileId, ...body }, record: { type: 'TechnicalFile', id: fileId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const before = await lockedFile(tx, context, fileId)
        if (before.status === 'ARCHIVED') throw new ConflictError(`Technical file ${before.number} is archived already.`)
        const least = retainUntilOf(todayOf(now))
        const retainUntil = body.retainUntil ?? least
        if (retainUntil < least) throw new ValidationError('A technical file is kept ten years.', [{ path: 'body/retainUntil', message: `Keep it until ${least} or later (PPE Reg. art. 8(3)).` }])
        const row = await tx.technicalFile.update({ where: { id: fileId }, data: { status: 'ARCHIVED', archivedAt: now, archivedById: context.actorId, archiveReason: body.reason, retainUntil: dateOfDay(retainUntil), updatedAt: now }, select: FILE_SELECT })
        const evidenceFiles = (await readItems(tx, [fileId])).map((item) => item.fileId).filter((value): value is string => value !== null)
        const kept = evidenceFiles.length > 0 ? await retainFilesInCommand(tools, evidenceFiles, dateOfDay(retainUntil), `Evidence of technical file ${before.number}, archived: kept until ${retainUntil} (PPE Reg. art. 8(3)).`) : []
        audit({ recordType: 'TechnicalFile', recordId: fileId, companyId: row.companyId, before: { status: before.status }, after: { status: 'ARCHIVED', retainUntil, filesKept: kept.length }, reason: body.reason })
        fileEvent(tools, row, 'ARCHIVED')
        return { id: fileId }
      },
      settings(),
    ),
  )
  return answerOf(caller, fileId)
}

// ---- items -------------------------------------------------------------------------------------------------------------------

export interface Evidence {
  readonly recordType?: string | null | undefined
  readonly recordId?: string | null | undefined
  readonly fileId?: string | null | undefined
}

/** The evidence a person links: an evidence record of this style (and company), or an available file that may be evidence. */
async function checkEvidence(tx: Reader, file: FileRow, evidence: Evidence, at = 'body'): Promise<void> {
  const problems = evidenceProblems(evidence, at)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  if (evidence.recordType && evidence.recordId) {
    const resolved = (await resolveRecords(tx, [{ recordType: evidence.recordType, recordId: evidence.recordId }])).get(`${evidence.recordType}:${evidence.recordId}`)
    if (!resolved) throw new ValidationError('The evidence record is not there.', [{ path: `${at}/recordId`, message: `There is no such ${evidence.recordType} (or not one you can see).` }])
    if (resolved.styles !== null && !resolved.styles.includes(file.styleId)) throw new ValidationError('The evidence is of another style.', [{ path: `${at}/recordId`, message: `${resolved.label} is not this style's: link this style's own records.` }])
    if (resolved.companyId !== null && resolved.companyId !== file.companyId) throw new ValidationError('The evidence is of another company.', [{ path: `${at}/recordId`, message: `${resolved.label} is another company's.` }])
  }
  if (evidence.fileId) {
    const row = (await readEvidenceFiles(tx, [evidence.fileId])).get(evidence.fileId)
    if (!row) throw new ValidationError('The file is not there.', [{ path: `${at}/fileId`, message: 'There is no such file (or not one you can see).' }])
    if (row.status !== 'AVAILABLE') throw new ValidationError('The file is not available.', [{ path: `${at}/fileId`, message: `"${row.originalName}" is ${row.status.toLowerCase()}: only an available file is evidence.` }])
    if (row.companyId !== null && row.companyId !== file.companyId) throw new ValidationError('The file is of another company.', [{ path: `${at}/fileId`, message: `"${row.originalName}" is another company's.` }])
    if (!isEvidenceFileRecordType(row.recordType) || readsThroughModule(row.recordType)) {
      throw new ValidationError('This file is not evidence.', [{ path: `${at}/fileId`, message: `"${row.originalName}" is a file of a ${row.recordType}: link a file of the style, its revisions, certificates, documents, tests or lots, or upload one to the technical file.` }])
    }
  }
}

const OPEN_ONLY = (file: FileRow) =>
  new ConflictError(file.status === 'COMPLETE' ? `Technical file ${file.number} is complete: its evidence changes only while it is OPEN (reopen it with the reason first).` : `Technical file ${file.number} is archived: its evidence is kept as it is.`)

export interface AddItemBody extends Evidence {
  readonly point: AnnexIIIPoint
  readonly note?: string | null | undefined
}

/** POST /compliance/techfiles/:fileId/items: another piece of evidence (or an empty row) for a point. */
export async function addItem(caller: CommandCaller, fileId: string, body: AddItemBody, key: string | null | undefined): Promise<{ record: FileRecord; itemId: string }> {
  const context = officeOf(caller)
  const { result } = await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.addItem', idempotencyKey: key, input: { fileId, ...body } },
      async (tools) => {
        const { tx, now, audit } = tools
        await tx.$queryRaw`SELECT id FROM "TechnicalFile" WHERE id = ${fileId}::uuid FOR UPDATE`
        const file = await lockedFile(tx, context, fileId)
        if (file.status !== 'OPEN') throw OPEN_ONLY(file)
        const evidence = { recordType: body.recordType ?? null, recordId: body.recordId ?? null, fileId: body.fileId ?? null }
        await checkEvidence(tx, file, evidence)
        const own = await tx.technicalFileItem.findMany({ where: { technicalFileId: fileId, point: body.point }, select: { seq: true } })
        if (own.length >= ITEMS_PER_POINT_MAX) throw new ConflictError(`Point (${POINT_INFO[body.point].letter}) has ${ITEMS_PER_POINT_MAX} items, the most a point lists.`)
        const id = newId()
        const state: ItemState = evidence.recordId || evidence.fileId ? 'LINKED' : 'MISSING'
        await tx.technicalFileItem.create({
          data: { id, technicalFileId: fileId, point: body.point, seq: Math.max(0, ...own.map((row) => row.seq)) + 1, state, ...evidence, note: body.note ?? null, createdAt: now, updatedAt: now, createdById: context.actorId },
          select: { id: true },
        })
        audit({ recordType: 'TechnicalFileItem', recordId: id, companyId: file.companyId, after: { technicalFileId: fileId, point: body.point, state, ...evidence } })
        itemEvent(tools, file, { id, point: body.point, state }, state === 'LINKED' ? 'LINKED' : 'ADDED')
        return { itemId: id }
      },
      settings(),
    ),
  )
  return { record: await answerOf(caller, fileId), itemId: result.itemId }
}

export interface EditItemBody extends Evidence {
  readonly version: number
  readonly note?: string | null | undefined
  /** REVIEWED (its evidence checked: you are recorded as the reviewer), NOT_APPLICABLE (the note says why), LINKED (the review undone), MISSING (the evidence cleared). */
  readonly state?: ItemState | undefined
}

/** PATCH /compliance/techfiles/:fileId/items/:itemId */
export async function editItem(caller: CommandCaller, fileId: string, itemId: string, body: EditItemBody, key: string | null | undefined): Promise<FileRecord> {
  const context = officeOf(caller)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.editItem', idempotencyKey: key, input: { fileId, itemId, ...body }, record: { type: 'TechnicalFileItem', id: itemId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const file = await lockedFile(tx, context, fileId)
        const before = await tx.technicalFileItem.findUnique({ where: { id: itemId }, select: ITEM_SELECT })
        if (!before || before.technicalFileId !== fileId) throw new NotFoundError('Item not found.')
        if (file.status !== 'OPEN') throw OPEN_ONLY(file)
        const touched = body.recordType !== undefined || body.recordId !== undefined || body.fileId !== undefined
        let evidence = { recordType: before.recordType, recordId: before.recordId, fileId: before.fileId }
        if (touched) {
          evidence = { recordType: body.recordType ?? null, recordId: body.recordId ?? null, fileId: body.fileId ?? null }
          if (evidence.recordId || evidence.fileId) await checkEvidence(tx, file, evidence)
        }
        const has = evidence.recordId !== null || evidence.fileId !== null
        const changed = touched && (evidence.recordType !== before.recordType || evidence.recordId !== before.recordId || evidence.fileId !== before.fileId)
        const note = body.note !== undefined ? body.note : before.note
        let state: ItemState = changed ? (has ? 'LINKED' : 'MISSING') : (before.state as ItemState)
        let reviewed: { reviewedAt: Date | null; reviewedById: string | null } = changed ? { reviewedAt: null, reviewedById: null } : { reviewedAt: before.reviewedAt, reviewedById: before.reviewedById }
        if (body.state === 'REVIEWED') {
          if (!has) throw new ValidationError('Link the evidence first.', [{ path: 'body/state', message: 'Only linked evidence is reviewed: link a record or a file, or mark the point not applicable.' }])
          state = 'REVIEWED'
          reviewed = { reviewedAt: now, reviewedById: context.actorId }
        } else if (body.state === 'NOT_APPLICABLE') {
          if (note === null || note.trim().length < 3) throw new ValidationError('Say why the point does not apply.', [{ path: 'body/note', message: 'Say why it does not apply (3 to 2000 characters): "series PPE, not made to measure".' }])
          evidence = { recordType: null, recordId: null, fileId: null }
          state = 'NOT_APPLICABLE'
          reviewed = { reviewedAt: now, reviewedById: context.actorId }
        } else if (body.state === 'LINKED') {
          if (!has) throw new ValidationError('Link the evidence first.', [{ path: 'body/state', message: 'An item without evidence is MISSING.' }])
          state = 'LINKED'
          reviewed = { reviewedAt: null, reviewedById: null }
        } else if (body.state === 'MISSING') {
          evidence = { recordType: null, recordId: null, fileId: null }
          state = 'MISSING'
          reviewed = { reviewedAt: null, reviewedById: null }
        }
        const row = await tx.technicalFileItem.update({ where: { id: itemId }, data: { ...evidence, state, ...reviewed, note, updatedAt: now }, select: ITEM_SELECT })
        audit({
          recordType: 'TechnicalFileItem',
          recordId: itemId,
          companyId: file.companyId,
          before: { state: before.state, recordType: before.recordType, recordId: before.recordId, fileId: before.fileId, note: before.note },
          after: { state: row.state, recordType: row.recordType, recordId: row.recordId, fileId: row.fileId, note: row.note },
        })
        const change = row.state === 'REVIEWED' && before.state !== 'REVIEWED' ? 'REVIEWED' : row.state === 'NOT_APPLICABLE' && before.state !== 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' : changed ? (has ? 'LINKED' : 'UNLINKED') : row.state !== before.state ? (row.state === 'MISSING' ? 'UNLINKED' : 'EDITED') : 'EDITED'
        itemEvent(tools, file, { id: itemId, point: row.point, state: row.state }, change)
        return { id: itemId }
      },
      settings(),
    ),
  )
  return answerOf(caller, fileId)
}

/** DELETE /compliance/techfiles/:fileId/items/:itemId?version= */
export async function removeItem(caller: CommandCaller, fileId: string, itemId: string, version: number, key: string | null | undefined): Promise<FileRecord> {
  const context = officeOf(caller)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.removeItem', idempotencyKey: key, input: { fileId, itemId, version } },
      async (tools) => {
        const { tx, audit } = tools
        const file = await lockedFile(tx, context, fileId)
        await tx.$queryRaw`SELECT id FROM "TechnicalFileItem" WHERE id = ${itemId}::uuid FOR UPDATE`
        const row = await tx.technicalFileItem.findUnique({ where: { id: itemId }, select: ITEM_SELECT })
        if (!row || row.technicalFileId !== fileId) throw new NotFoundError('Item not found.')
        if (row.version !== version) throw new ConflictError(`This item changed since it was read (version ${version}); it is now at version ${row.version}. Reload it.`)
        if (file.status !== 'OPEN') throw OPEN_ONLY(file)
        await tx.technicalFileItem.delete({ where: { id: itemId } })
        audit({ recordType: 'TechnicalFileItem', recordId: itemId, companyId: file.companyId, before: { technicalFileId: fileId, point: row.point, state: row.state, recordType: row.recordType, recordId: row.recordId, fileId: row.fileId } })
        itemEvent(tools, file, { id: itemId, point: row.point, state: null }, 'REMOVED')
        return { id: itemId }
      },
      settings(),
    ),
  )
  return answerOf(caller, fileId)
}

// ---- the evidence picker -----------------------------------------------------------------------------------------------------

export interface EvidenceOption {
  readonly kind: 'RECORD' | 'FILE'
  readonly recordType: string
  readonly recordId: string | null
  readonly fileId: string | null
  readonly label: string
  readonly state: string
  readonly points: AnnexIIIPoint[]
  readonly linked: boolean
}

/** GET /compliance/techfiles/:fileId/evidence-options?point: the style's records and files that may be linked (the design's Combobox). */
export async function evidenceOptions(request: FastifyRequest, fileId: string, query: { readonly point?: AnnexIIIPoint | undefined }) {
  const actor = actorOf(officeOf(request))
  return request.withClient(async (db) => {
    const file = await readFile(db, actor, fileId)
    const style = await readStyle(db, file.styleId)
    const revisions = await db.styleRevision.findMany({ where: { styleId: style.id }, select: { id: true }, orderBy: [{ revision: 'desc' }], take: 10 })
    const revisionIds = revisions.map((row) => row.id)
    const covering = (await coveringCertificates(db, [style.id])).get(style.id) ?? []
    const refs: { recordType: string; recordId: string }[] = [{ recordType: 'Style', recordId: style.id }, ...revisionIds.map((id) => ({ recordType: 'StyleRevision', recordId: id }))]
    const add = (recordType: string, ids: readonly string[]) => refs.push(...ids.map((id) => ({ recordType, recordId: id })))
    add('StyleRevisionFile', (await db.styleRevisionFile.findMany({ where: { revisionId: { in: revisionIds } }, select: { id: true }, take: 50 })).map((row) => row.id))
    add('MeasurementSpec', (await db.measurementSpec.findMany({ where: { styleId: style.id }, select: { id: true }, take: 20 })).map((row) => row.id))
    add('Certificate', covering.map((row) => row.id))
    const typed = [style.ppeStandard, ...covering.map((row) => row.standard)].filter((value): value is string => value !== null && value.trim() !== '')
    if (typed.length > 0) add('RegulationOrStandard', (await db.regulationOrStandard.findMany({ select: { id: true, code: true, edition: true } })).filter((row) => typed.some((value) => namesEntry(value, row))).map((row) => row.id))
    const documents = await db.complianceDocument.findMany({ where: { styleId: style.id, origin: 'SIGNED' }, select: { id: true }, orderBy: [{ revision: 'desc' }], take: 30 })
    add('ComplianceDocument', documents.map((row) => row.id))
    add('ProductRiskAssessment', (await db.productRiskAssessment.findMany({ where: { technicalFileId: file.id, status: { not: 'DRAFT' } }, select: { id: true } })).map((row) => row.id))
    const tests = await db.productionControlTest.findMany({ where: { styleId: style.id, result: { not: null } }, select: { id: true }, orderBy: [{ testedOn: 'desc' }], take: 30 })
    add('ProductionControlTest', tests.map((row) => row.id))
    add('LabelTemplate', (await db.labelTemplate.findMany({ where: { styleId: style.id }, select: { id: true }, take: 20 })).map((row) => row.id))
    if (style.measurementTemplateId) add('MeasurementTemplate', [style.measurementTemplateId])
    const resolved = await resolveRecords(db, refs)
    const items = await readItems(db, [file.id])
    const linked = new Set(items.flatMap((item) => [item.recordType && item.recordId ? `${item.recordType}:${item.recordId}` : null, item.fileId ? `file:${item.fileId}` : null]).filter((value): value is string => value !== null))
    const options: EvidenceOption[] = []
    for (const ref of refs) {
      const found = resolved.get(`${ref.recordType}:${ref.recordId}`)
      if (!found || (found.companyId !== null && found.companyId !== file.companyId)) continue
      options.push({ kind: 'RECORD', recordType: ref.recordType, recordId: ref.recordId, fileId: null, label: found.label, state: found.state, points: [...pointsOf(ref.recordType)], linked: linked.has(`${ref.recordType}:${ref.recordId}`) })
    }
    // Files: of the technical file itself, the style, its revisions, its certificates, signed documents and recorded tests.
    const owners: Prisma.StoredFileWhereInput[] = [
      { recordType: 'TechnicalFile', recordId: file.id },
      { recordType: 'Style', recordId: style.id },
      { recordType: 'StyleRevision', recordId: { in: revisionIds } },
      { recordType: 'Certificate', recordId: { in: covering.map((row) => row.id) } },
      { recordType: 'ComplianceDocument', recordId: { in: documents.map((row) => row.id) } },
      { recordType: 'ProductionControlTest', recordId: { in: tests.map((row) => row.id) } },
    ]
    const files = await db.storedFile.findMany({
      where: { status: 'AVAILABLE', OR: owners, AND: [{ OR: [{ companyId: null }, { companyId: file.companyId }] }] },
      select: { id: true, recordType: true, originalName: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    })
    for (const row of files) options.push({ kind: 'FILE', recordType: row.recordType, recordId: null, fileId: row.id, label: row.originalName, state: 'CURRENT', points: row.recordType === 'TechnicalFile' ? [] : [...pointsOf(row.recordType)], linked: linked.has(`file:${row.id}`) })
    const point = query.point
    const ranked = point ? [...options.filter((option) => option.points.includes(point)), ...options.filter((option) => !option.points.includes(point))] : options
    return { options: ranked, point: point ?? null }
  })
}

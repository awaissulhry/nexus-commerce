import { createHash, randomUUID } from 'node:crypto'
import type { Prisma } from '@nexus/factory-db'
import { legalFooter, legalLines, legalName } from '@nexus/factory-domain/documents/legal'
import { packPaper, paperLanguageOf, type PackPaperInput } from '@nexus/factory-domain/compliance/techfiles/paper'
import {
  manifestText,
  PACK_CONTENTS,
  PACK_LIMITS,
  POINT_INFO,
  retainUntilOf,
  zipSafeName,
  type AnnexIIIPoint,
  type PackContent,
  type PackPurpose,
  type PackScope,
} from '@nexus/factory-domain/compliance/techfiles/rules'
import { DomainError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { runCommand, type CommandCaller } from '../../../core/command'
import { companyLegalOf } from '../../../platform/documents/documents'
import { putGeneratedFile, recordGeneratedFile, storeAccountOf, storeCall, tenantOf, type PreparedGeneratedFile } from '../../../platform/files/files'
import { storageKeyFor } from '../../../platform/files/rules'
import { processFiles, type FilesRuntime } from '../../../platform/files/service'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { currentFileOf, readDocumentFiles } from '../../product/compliance/read'
import { writeZip, type ZipEntry } from '../../accounting/guest/zip'
import { dateOfDay, dayOf, settings, techfilesClock, type Reader } from './common'
import { renderPackPdf } from './pdf'
import { coveringCertificates, evidenceOf, readItems, type FileRow } from './store'

/**
 * The evidence pack's build (B-W2b-251; PRD-299; design tf-pack "JobProgress while it builds; result lists every document with
 * its fingerprint"; PPE Reg. art. 8(9)). The worker's handler `compliance.techfiles.buildPack`, on technical_file.pack_requested,
 * in the pack's tenant's system context:
 *
 *   1. what was asked (its scope: the whole style's newest released batches, batch numbers, a serial range or a shipment; the
 *      contents checklist) read through: every chosen record kind as a section (its rows written out as JSON — the bytes its
 *      SHA-256 is taken of) and every chosen document as the file it is (a DoC's and a leaflet's signed PDF, a certificate's
 *      PDF, a lab report, a file linked as evidence), each file's bytes read from the store and checked against its SHA-256;
 *      never a cost, a price or a wage (no money column is read at all, and only files of evidence records);
 *   2. the manifest ("<sha256>  <title>" per document) and the pack's fingerprint (its SHA-256); the PDF (cover, contents,
 *      sections, in Italian or English) and the ZIP (the PDF, SHA256SUMS.txt = the manifest, records/*.json, documents/*);
 *      both put in the file store as files of the pack, kept ten years;
 *   3. ONE command: the pack BUILDING → BUILT with its contents, fingerprint, PDF, ZIP, build time and keep-until day, the
 *      GeneratedDocument EVIDENCE_PACK of its PDF, the audit row and technical_file.pack_changed BUILT.
 *
 * A refusal in words (a document whose bytes the store does not give or that do not match their SHA-256, too many documents,
 * a ZIP above 25 MiB) → FAILED with it. Any other failure is retried; after the last attempt → FAILED "The build stopped…".
 * Listed in background.ts (one line).
 */

export const BUILD_HANDLER = 'compliance.techfiles.buildPack'
export const BUILD_ATTEMPTS = 3

/** A refusal of the build in words: the pack fails with it. */
class Refused extends DomainError {
  override name = 'Refused'
  constructor(message: string) {
    super('invalid_state', message)
  }
}

interface Pack {
  readonly id: string
  readonly companyId: string
  readonly number: string
  readonly purpose: PackPurpose
  readonly technicalFileId: string
  readonly scope: PackScope & { readonly include: readonly PackContent[] }
  readonly language: string
  readonly recipient: string
  readonly status: string
}

/** The scope as stored ({ kind, …, include }), read back defensively. */
export function scopeOf(value: unknown): PackScope & { readonly include: readonly PackContent[] } {
  const raw = (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>
  const kinds = ['STYLE', 'BATCHES', 'SERIALS', 'SHIPMENT'] as const
  const kind = kinds.find((entry) => entry === raw.kind) ?? 'STYLE'
  const strings = (entry: unknown): string[] => (Array.isArray(entry) ? entry.filter((item): item is string => typeof item === 'string') : [])
  return {
    kind,
    ...(kind === 'BATCHES' ? { batchNumbers: strings(raw.batchNumbers) } : {}),
    ...(kind === 'SERIALS' && typeof raw.serialFrom === 'string' && typeof raw.serialTo === 'string' ? { serialFrom: raw.serialFrom, serialTo: raw.serialTo } : {}),
    ...(kind === 'SHIPMENT' && typeof raw.shipmentId === 'string' ? { shipmentId: raw.shipmentId } : {}),
    include: strings(raw.include).filter((entry): entry is PackContent => (PACK_CONTENTS as readonly string[]).includes(entry)),
  }
}

const PRODUCTION_KINDS: ('SIZE_GRID' | 'MADE_TO_MEASURE')[] = ['SIZE_GRID', 'MADE_TO_MEASURE']

/** The work orders (batches) a pack covers, and the typed batch numbers it names. */
export async function scopeOrders(db: Reader, styleId: string, scope: PackScope): Promise<{ readonly orders: { id: string; number: string; batchNumber: string | null; labelTemplateId: string | null }[]; readonly typed: readonly string[] }> {
  const select = { id: true, number: true, batchNumber: true, labelTemplateId: true } as const
  const base: Prisma.WorkOrderWhereInput = { styleId, kind: { in: [...PRODUCTION_KINDS] }, status: { notIn: ['DRAFT', 'CANCELLED'] } }
  if (scope.kind === 'BATCHES') {
    const numbers = (scope.batchNumbers ?? []).map((value) => value.trim())
    const orders = await db.workOrder.findMany({ where: { ...base, batchNumber: { in: numbers } }, select, orderBy: [{ createdAt: 'asc' }] })
    return { orders, typed: numbers.filter((number) => !orders.some((order) => order.batchNumber === number)) }
  }
  if (scope.kind === 'SERIALS') {
    const serials = await db.garmentSerial.findMany({ where: { serial: { gte: scope.serialFrom!.trim().toUpperCase(), lte: scope.serialTo!.trim().toUpperCase() } }, select: { workOrderId: true }, distinct: ['workOrderId'] })
    return { orders: await db.workOrder.findMany({ where: { ...base, id: { in: serials.map((row) => row.workOrderId) } }, select, orderBy: [{ createdAt: 'asc' }] }), typed: [] }
  }
  if (scope.kind === 'SHIPMENT') {
    const lines = await db.shipmentLine.findMany({ where: { shipmentId: scope.shipmentId! }, select: { workOrderId: true }, distinct: ['workOrderId'] })
    return { orders: await db.workOrder.findMany({ where: { ...base, id: { in: lines.map((row) => row.workOrderId) } }, select, orderBy: [{ createdAt: 'asc' }] }), typed: [] }
  }
  // The whole style: its newest released batches (done, or with garments released).
  const ofStyle = await db.workOrder.findMany({ where: base, select: { id: true } })
  const released = ofStyle.length ? await db.qualityRelease.findMany({ where: { workOrderId: { in: ofStyle.map((row) => row.id) } }, select: { workOrderId: true }, distinct: ['workOrderId'] }) : []
  const orders = await db.workOrder.findMany({
    where: { AND: [base, { OR: [{ status: { in: ['COMPLETED', 'CLOSED'] } }, { id: { in: released.map((row) => row.workOrderId) } }] }] },
    select,
    orderBy: [{ createdAt: 'desc' }],
    take: PACK_LIMITS.batches,
  })
  return { orders: orders.reverse(), typed: [] }
}

interface FileEntry {
  readonly kind: 'FILE'
  readonly title: string
  readonly name: string
  readonly sha256: string
  readonly recordType: string
  readonly recordId: string
  readonly fileId: string
  readonly storeAccountId: string
  readonly storageKey: string
  readonly sizeBytes: number
}
interface SectionEntry {
  readonly kind: 'SECTION'
  readonly title: string
  readonly name: string
  readonly sha256: string
  readonly recordType: string
  readonly recordId: string
  readonly bytes: Buffer
}
type Entry = FileEntry | SectionEntry

const FILE_COLUMNS = { id: true, recordType: true, recordId: true, originalName: true, sha256: true, sizeBytes: true, status: true, storeAccountId: true, storageKey: true, kind: true, contentType: true, availableAt: true, createdAt: true } as const

const words = (value: string): string => value.replace(/_/g, ' ').toLowerCase()
const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

/** Everything the pack holds, read in the tenant's system scope (no money column, no person but who signed). */
async function collect(db: Reader, pack: Pack, file: FileRow) {
  const include = new Set(pack.scope.include)
  const style = await db.style.findUniqueOrThrow({ where: { id: file.styleId }, select: { id: true, code: true, name: true } })
  const entries: Entry[] = []
  const seenFiles = new Set<string>()
  const paper: { -readonly [Key in keyof PackPaperInput]?: PackPaperInput[Key] } = {}
  const addFiles = async (ids: readonly string[], title: (row: { id: string; originalName: string; recordType: string }) => string) => {
    const rows = ids.length ? await db.storedFile.findMany({ where: { id: { in: [...new Set(ids)] } }, select: FILE_COLUMNS }) : []
    for (const id of ids) {
      const row = rows.find((entry) => entry.id === id)
      if (!row || seenFiles.has(id)) continue
      if (row.status !== 'AVAILABLE') throw new Refused(`"${row.originalName}" is ${row.status.toLowerCase()}: it cannot go in the pack. Link an available file, or leave its kind out.`)
      seenFiles.add(id)
      entries.push({ kind: 'FILE', title: title(row).slice(0, 300), name: row.originalName, sha256: row.sha256, recordType: row.recordType, recordId: row.recordId, fileId: row.id, storeAccountId: row.storeAccountId, storageKey: row.storageKey, sizeBytes: row.sizeBytes })
    }
  }
  const addSection = (title: string, name: string, recordType: string, recordId: string, rows: unknown) => {
    const bytes = json({ pack: pack.number, section: title, rows })
    entries.push({ kind: 'SECTION', title, name, sha256: sha(bytes), recordType, recordId, bytes })
  }
  const { orders, typed } = await scopeOrders(db, file.styleId, pack.scope)
  const orderIds = orders.map((order) => order.id)
  const certificates = (await coveringCertificates(db, [file.styleId])).get(file.styleId) ?? []
  const named = file.certificateId ? certificates.find((row) => row.id === file.certificateId) ?? null : null
  const inForce = certificates.filter((row) => row.status === 'VALID' || row.id === file.certificateId)

  if (include.has('TECHFILE_INDEX')) {
    const items = await readItems(db, [file.id])
    const evidence = await evidenceOf(db, items)
    const index = items.map((item) => {
      const view = evidence(item)
      return { point: item.point as AnnexIIIPoint, state: item.state, evidence: view ? view.label : item.note ?? '-', reviewedOn: dayOf(item.reviewedAt) }
    })
    paper.index = index
    addSection('Technical file index (Annex III)', 'technical-file-index.json', 'TechnicalFile', file.id, index.map((row) => ({ ...row, law: POINT_INFO[row.point].law })))
    await addFiles(items.map((item) => item.fileId).filter((value): value is string => value !== null), (row) => `Evidence: ${row.originalName}`)
  }
  if (include.has('RISK_ASSESSMENT')) {
    const signed = await db.productRiskAssessment.findFirst({ where: { technicalFileId: file.id, status: 'SIGNED' }, select: { id: true, revision: true, signedAt: true, signedByName: true, signedByFunction: true, classReasoning: true } })
    if (signed) {
      const rows = await db.productRiskRow.findMany({ where: { assessmentId: signed.id }, select: { seq: true, hazard: true, hazardNote: true, garmentZone: true, intendedUse: true, foreseeableMisuse: true, control: true, standardClause: true, residualRisk: true }, orderBy: [{ seq: 'asc' }] })
      paper.risk = {
        revision: signed.revision,
        signedByName: signed.signedByName ?? '',
        signedByFunction: signed.signedByFunction ?? '',
        signedOn: dayOf(signed.signedAt) ?? '',
        classReasoning: signed.classReasoning,
        rows: rows.map((row) => ({ hazard: row.hazardNote ? `${words(row.hazard)}: ${row.hazardNote}` : words(row.hazard), zone: row.garmentZone, intendedUse: row.intendedUse, misuse: row.foreseeableMisuse, control: row.control, clause: row.standardClause, residual: row.residualRisk })),
      }
      addSection(`Product risk assessment revision ${signed.revision}`, 'risk-assessment.json', 'ProductRiskAssessment', signed.id, { ...paper.risk })
    } else paper.risk = null
  }
  if (include.has('CERTIFICATES')) {
    paper.certificates = inForce.map((row) => ({ number: row.number, standard: row.standard, body: `${row.notifiedBodyName} (${row.notifiedBodyNumber})`, validFrom: dayOf(row.validFrom)!, validTo: dayOf(row.validTo)!, status: row.status }))
    addSection('Certificates', 'certificates.json', 'TechnicalFile', file.id, paper.certificates)
    const pdfs = await db.storedFile.findMany({ where: { recordType: 'Certificate', recordId: { in: inForce.map((row) => row.id) }, kind: 'CERTIFICATE', status: 'AVAILABLE' }, select: { id: true, recordId: true, availableAt: true }, orderBy: [{ availableAt: 'desc' }, { id: 'desc' }] })
    const newest = inForce.map((row) => pdfs.find((entry) => entry.recordId === row.id)?.id).filter((value): value is string => value !== undefined)
    await addFiles(newest, (row) => `Certificate: ${row.originalName}`)
  }
  for (const kind of ['DOC', 'USER_INFORMATION'] as const) {
    if (!include.has(kind)) continue
    const documents = await db.complianceDocument.findMany({ where: { styleId: file.styleId, origin: 'SIGNED', status: 'ISSUED', kind: kind === 'DOC' ? 'DECLARATION_OF_CONFORMITY' : 'USER_INFORMATION' }, select: { id: true, language: true, revision: true }, orderBy: [{ revision: 'desc' }, { language: 'asc' }] })
    const filesOf = await readDocumentFiles(db, documents.map((row) => row.id))
    const ids: string[] = []
    const titles = new Map<string, string>()
    for (const document of documents) {
      const current = currentFileOf(filesOf.filter((entry) => entry.recordId === document.id))
      if (!current) continue
      ids.push(current.id)
      titles.set(current.id, `${kind === 'DOC' ? 'Declaration of conformity' : 'User information'} ${document.language} revision ${document.revision}`)
    }
    await addFiles(ids, (row) => titles.get(row.id) ?? row.originalName)
  }
  const scopeTests = await db.productionControlTest.findMany({
    where: { styleId: file.styleId, ...(pack.scope.kind === 'STYLE' ? {} : { OR: [{ workOrderId: { in: orderIds } }, { batchNumber: { in: [...typed] } }, { workOrderId: null, batchNumber: null }] }) },
    select: { id: true, test: true, testName: true, batchNumber: true, dueOn: true, result: true, testedOn: true, testedBy: true, reportNumber: true, labReportFileId: true, workOrder: { select: { number: true, batchNumber: true } } },
    orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
  })
  if (include.has('PRODUCTION_CONTROL')) {
    paper.tests = scopeTests.map((row) => ({ test: row.testName ? `${words(row.test)} (${row.testName})` : words(row.test), batch: row.batchNumber ?? row.workOrder?.batchNumber ?? row.workOrder?.number ?? null, day: dayOf(row.testedOn ?? row.dueOn)!, result: row.result, testedBy: row.testedBy, reportNumber: row.reportNumber }))
    addSection('Production-control tests', 'production-control.json', 'TechnicalFile', file.id, paper.tests)
  }
  if (include.has('TEST_REPORTS')) {
    await addFiles(scopeTests.map((row) => row.labReportFileId).filter((value): value is string => value !== null), (row) => `Lab report: ${row.originalName}`)
    const others = await db.storedFile.findMany({ where: { recordType: 'Certificate', recordId: { in: inForce.map((row) => row.id) }, kind: { not: 'CERTIFICATE' }, status: 'AVAILABLE' }, select: { id: true }, orderBy: [{ createdAt: 'asc' }] })
    await addFiles(others.map((row) => row.id), (row) => `Type test report: ${row.originalName}`)
    const items = (await readItems(db, [file.id])).filter((item) => (item.point === 'H_CALCULATIONS' || item.point === 'I_TEST_REPORTS') && item.fileId !== null)
    await addFiles(items.map((item) => item.fileId!), (row) => `Test report: ${row.originalName}`)
  }
  if (include.has('INSPECTIONS')) {
    const inspections = orderIds.length ? await db.inspection.findMany({ where: { workOrderId: { in: orderIds }, status: { not: 'CANCELLED' } }, select: { id: true, number: true, status: true, decidedAt: true, workOrderId: true }, orderBy: [{ createdAt: 'asc' }] }) : []
    const releases = orderIds.length ? await db.qualityRelease.findMany({ where: { workOrderId: { in: orderIds } }, select: { inspectionId: true, quantity: true } }) : []
    paper.inspections = inspections.map((row) => {
      const order = orders.find((entry) => entry.id === row.workOrderId)!
      return { workOrder: order.number, batch: order.batchNumber, inspection: row.number ?? row.id.slice(0, 8), status: row.status, decidedOn: dayOf(row.decidedAt), released: releases.filter((release) => release.inspectionId === row.id).reduce((sum, release) => sum + release.quantity, 0) }
    })
    addSection('Final inspections and releases', 'inspections.json', 'TechnicalFile', file.id, paper.inspections)
  }
  if (include.has('LABELS')) {
    const prints = orderIds.length ? await db.garmentLabelPrint.findMany({ where: { workOrderId: { in: orderIds } }, select: { workOrderId: true, quantity: true } }) : []
    const templates = new Map((await db.labelTemplate.findMany({ where: { id: { in: orders.map((order) => order.labelTemplateId).filter((value): value is string => value !== null) } }, select: { id: true, code: true, revision: true } })).map((row) => [row.id, `${row.code} r${row.revision}`]))
    paper.labels = orders.map((order) => {
      const own = prints.filter((row) => row.workOrderId === order.id)
      return { workOrder: order.batchNumber ? `${order.number} (${order.batchNumber})` : order.number, template: order.labelTemplateId ? templates.get(order.labelTemplateId) ?? null : null, prints: own.length, labels: own.reduce((sum, row) => sum + row.quantity, 0) }
    })
    addSection('Labels and print records', 'labels.json', 'TechnicalFile', file.id, paper.labels)
  }
  if (include.has('CR6')) {
    const moves = orderIds.length ? await db.stockMove.findMany({ where: { workOrderId: { in: orderIds }, reason: 'ISSUE', lotId: { not: null } }, select: { lotId: true }, distinct: ['lotId'] }) : []
    const lots = moves.length ? await db.lot.findMany({ where: { id: { in: moves.map((row) => row.lotId!) } }, select: { id: true, code: true, itemId: true, crViStatus: true, crViMgKg: true, crViLimitMgKg: true, crViTestedAt: true }, orderBy: [{ code: 'asc' }] }) : []
    const items = new Map((await db.item.findMany({ where: { id: { in: lots.map((row) => row.itemId) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, `${row.code} ${row.name}`]))
    paper.lots = lots.map((row) => ({ lot: row.code, item: items.get(row.itemId) ?? '?', status: row.crViStatus, value: row.crViMgKg?.toString() ?? null, limit: row.crViLimitMgKg?.toString() ?? null, testedOn: dayOf(row.crViTestedAt) }))
    addSection('Chromium VI per lot', 'chromium-vi.json', 'TechnicalFile', file.id, paper.lots)
    const results = lots.length ? await db.labResult.findMany({ where: { lotId: { in: lots.map((row) => row.id) }, test: 'CR_VI' }, select: { fileId: true }, orderBy: [{ testedOn: 'asc' }] }) : []
    await addFiles(results.map((row) => row.fileId), (row) => `Chromium VI report: ${row.originalName}`)
  }
  if (entries.length > PACK_LIMITS.documents) throw new Refused(`The pack would list ${entries.length} documents, more than the ${PACK_LIMITS.documents} one pack holds: build it for fewer batches or leave some kinds out.`)
  if (entries.length === 0) throw new Refused('Nothing was found for the kinds chosen in this scope: choose other kinds or another scope.')
  return { style, entries, paper, named, orders, typed }
}

const scopeWords = (scope: PackScope, orders: readonly { number: string; batchNumber: string | null }[], language: 'it' | 'en'): string => {
  const batches = orders.map((order) => order.batchNumber ?? order.number).join(', ')
  if (scope.kind === 'BATCHES') return `${language === 'it' ? 'Lotti' : 'Batches'} ${(scope.batchNumbers ?? []).join(', ')}`
  if (scope.kind === 'SERIALS') return `${language === 'it' ? 'Matricole' : 'Serials'} ${scope.serialFrom} - ${scope.serialTo}${batches ? ` (${batches})` : ''}`
  if (scope.kind === 'SHIPMENT') return `${language === 'it' ? 'Spedizione' : 'Shipment'}${batches ? ` (${batches})` : ''}`
  return `${language === 'it' ? 'Tutto il modello' : 'The whole style'}${batches ? ` (${batches})` : ''}`
}

const ROME_TIME = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

/** The ZIP put in the store as a file of the pack (its kind's PDF-only rule does not fit a ZIP: the bytes are ours). */
async function putZip(files: FilesRuntime, caller: CommandCaller, pack: Pack, body: Buffer, retainUntil: Date, now: Date): Promise<PreparedGeneratedFile> {
  const sha256 = sha(body)
  const storeAccountId = await storeAccountOf(caller, pack.companyId)
  const storageKey = storageKeyFor({ tenantId: tenantOf(caller.factoryContext!), companyId: pack.companyId, kind: 'DOCUMENT', now, random: randomUUID() })
  await storeCall(() => files.storage.put(caller, storeAccountId, { key: storageKey, contentType: 'application/zip', body, sha256 }))
  return { companyId: pack.companyId, recordType: 'EvidencePack', recordId: pack.id, kind: 'DOCUMENT', originalName: `${pack.number}.zip`, contentType: 'application/zip', sizeBytes: body.length, sha256, visibility: ['OFFICE'], floorSiteId: null, partyId: null, retainUntil, storeAccountId, storageKey }
}

export interface BuildWork {
  readonly files?: FilesRuntime
  readonly lastAttempt?: boolean
  readonly causationId?: string
}

/** packFailed: BUILDING → FAILED with why. A pack that moved on meanwhile is left alone. */
async function failPack(caller: CommandCaller, pack: Pack, reason: string, causationId?: string): Promise<'failed' | 'settled'> {
  try {
    await runCommand(
      caller,
      { name: 'compliance.techfiles.packFailed', input: { packId: pack.id, reason }, causationId, record: { type: 'EvidencePack', id: pack.id } },
      async (tools) => {
        const row = await tools.tx.evidencePack.findUniqueOrThrow({ where: { id: pack.id }, select: { status: true } })
        if (row.status !== 'BUILDING') throw new InvalidStateError('The pack is not building any more.')
        await tools.tx.evidencePack.update({ where: { id: pack.id }, data: { status: 'FAILED', failureReason: reason.slice(0, 500), builtAt: tools.now, updatedAt: tools.now }, select: { id: true } })
        tools.audit({ recordType: 'EvidencePack', recordId: pack.id, companyId: pack.companyId, before: { status: 'BUILDING' }, after: { status: 'FAILED', failureReason: reason } })
        tools.emit({ type: 'technical_file.pack_changed', subject: pack.technicalFileId, companyId: pack.companyId, payload: { packId: pack.id, number: pack.number, technicalFileId: pack.technicalFileId, status: 'FAILED', change: 'FAILED', documents: null } })
        return { failed: true }
      },
      settings(),
    )
    return 'failed'
  } catch (error) {
    if (error instanceof InvalidStateError) return 'settled'
    throw error
  }
}

/** Builds one pack (the handler's work; the tests call it too). */
export async function buildPack(caller: CommandCaller, packId: string, work: BuildWork = {}): Promise<'built' | 'failed' | 'settled'> {
  const files = work.files ?? processFiles()
  const row = await caller.withClient((db) =>
    db.evidencePack.findUnique({ where: { id: packId }, select: { id: true, companyId: true, number: true, purpose: true, technicalFileId: true, scope: true, language: true, recipient: true, status: true } }),
  )
  if (!row || row.status !== 'BUILDING' || row.technicalFileId === null) return 'settled'
  const pack: Pack = { ...row, purpose: row.purpose as PackPurpose, technicalFileId: row.technicalFileId, scope: scopeOf(row.scope) }
  try {
    const now = techfilesClock().now()
    const technicalFile = await caller.withClient((db) => db.technicalFile.findUniqueOrThrow({ where: { id: pack.technicalFileId }, select: { id: true, companyId: true, number: true, styleId: true, certificateId: true, status: true, keeperId: true, completedAt: true, completedById: true, archivedAt: true, archivedById: true, archiveReason: true, retainUntil: true, note: true, version: true, createdAt: true, updatedAt: true, createdById: true } }))
    const material = await caller.withClient((db) => collect(db, pack, technicalFile))

    // The documents' bytes, each checked against the SHA-256 kept with it.
    const zipped: ZipEntry[] = []
    let total = 0
    for (const [index, entry] of material.entries.entries()) {
      const prefix = String(index + 1).padStart(3, '0')
      if (entry.kind === 'SECTION') {
        zipped.push({ path: `records/${prefix}-${entry.name}`, bytes: entry.bytes })
        total += entry.bytes.length
        continue
      }
      total += entry.sizeBytes
      if (total > PACK_LIMITS.zipBytes) throw new Refused(`The documents together are larger than ${PACK_LIMITS.zipBytes / 1024 / 1024} MiB, the most one pack's ZIP holds: build it for fewer batches or leave some kinds out.`)
      const bytes = await storeCall(() => files.storage.read(caller, entry.storeAccountId, entry.storageKey, entry.sizeBytes))
      if (!bytes || sha(bytes) !== entry.sha256) throw new Refused(`The file store did not give "${entry.name}" as it was kept (its SHA-256 differs or it is missing): nothing was built. Check the file, then build the pack again.`)
      zipped.push({ path: `documents/${prefix}-${zipSafeName(entry.name)}`, bytes })
    }
    const manifest = manifestText(pack.number, material.entries)
    const fingerprint = sha(manifest)

    const company = await companyLegalOf(caller, pack.companyId)
    const language = paperLanguageOf(pack.language)
    const paper = packPaper({
      ...material.paper,
      language: pack.language,
      number: pack.number,
      purpose: pack.purpose,
      recipient: pack.recipient,
      builtAt: toUtcIso(now),
      builtAtWords: ROME_TIME.format(now),
      company: { name: legalName(company, language), lines: legalLines(company, language), legal: legalFooter(company, language) },
      technicalFile: { number: technicalFile.number, styleCode: material.style.code, styleName: material.style.name, certificate: material.named ? material.named.number : null },
      scopeWords: scopeWords(pack.scope, material.orders, language),
      fingerprint,
      include: pack.scope.include,
      contents: material.entries.map((entry) => ({ title: entry.title, sha256: entry.sha256 })),
    })
    const pdf = await renderPackPdf(paper)
    const zip = writeZip([{ path: paper.fileName, bytes: pdf }, { path: 'SHA256SUMS.txt', bytes: Buffer.from(manifest, 'utf8') }, ...zipped], now)
    if (zip.length > PACK_LIMITS.zipBytes) throw new Refused(`The pack's ZIP would be larger than ${PACK_LIMITS.zipBytes / 1024 / 1024} MiB: build it for fewer batches or leave some kinds out.`)
    const retainDay = retainUntilOf(businessDate(now))
    const retainUntil = dateOfDay(retainDay)
    const preparedPdf = await putGeneratedFile(files, caller, { companyId: pack.companyId, recordType: 'EvidencePack', recordId: pack.id, kind: 'DOCUMENT', originalName: paper.fileName, contentType: 'application/pdf', body: pdf, visibility: ['OFFICE'], retainUntil })
    const preparedZip = await putZip(files, caller, pack, zip, retainUntil, now)
    const contents = material.entries.map((entry) => ({ title: entry.title, sha256: entry.sha256, recordType: entry.recordType, recordId: entry.recordId, ...(entry.kind === 'FILE' ? { fileId: entry.fileId } : {}) }))

    const outcome = await runCommand(
      caller,
      { name: 'compliance.techfiles.packBuilt', input: { packId, fingerprint }, causationId: work.causationId, record: { type: 'EvidencePack', id: packId } },
      async (tools) => {
        const { tx, audit, emit } = tools
        const current = await tx.evidencePack.findUniqueOrThrow({ where: { id: packId }, select: { status: true } })
        if (current.status !== 'BUILDING') throw new InvalidStateError('The pack is not building any more.')
        const pdfFile = await recordGeneratedFile(tools, preparedPdf, { details: { documentType: 'EVIDENCE_PACK', number: pack.number, language } })
        const zipFile = await recordGeneratedFile(tools, preparedZip, { details: { documentType: 'EVIDENCE_PACK_ZIP', number: pack.number } })
        await tx.evidencePack.update({ where: { id: packId }, data: { status: 'BUILT', contents, fingerprint, fileId: pdfFile.id, zipFileId: zipFile.id, builtAt: now, retainUntil, updatedAt: tools.now }, select: { id: true } })
        await tx.generatedDocument.create({ data: { id: newId(), companyId: pack.companyId, siteId: null, recordType: 'EvidencePack', recordId: packId, kind: 'EVIDENCE_PACK', version: 1, fingerprint, language, number: pack.number, fileId: pdfFile.id, createdAt: tools.now, createdById: null }, select: { id: true } })
        audit({ recordType: 'EvidencePack', recordId: packId, companyId: pack.companyId, before: { status: 'BUILDING' }, after: { status: 'BUILT', documents: contents.length, fingerprint, fileId: pdfFile.id, zipFileId: zipFile.id, retainUntil: retainDay } })
        emit({ type: 'technical_file.pack_changed', subject: pack.technicalFileId, companyId: pack.companyId, payload: { packId, number: pack.number, technicalFileId: pack.technicalFileId, status: 'BUILT', change: 'BUILT', documents: contents.length } })
        return { built: true }
      },
      settings(),
    ).catch((error: unknown) => {
      if (error instanceof InvalidStateError) return null
      throw error
    })
    return outcome === null ? 'settled' : 'built'
  } catch (error) {
    if (error instanceof Refused) return failPack(caller, pack, error.message, work.causationId)
    if (work.lastAttempt) return failPack(caller, pack, 'The build stopped before it ended: build the pack again.', work.causationId)
    throw error
  }
}

/** The worker's handler (background.ts): one build per request event. */
export function buildPackHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: BUILD_HANDLER,
      events: ['technical_file.pack_requested'],
      attempts: BUILD_ATTEMPTS,
      async handle(event, { caller, attempt }) {
        const { packId } = event.payload as { packId: string }
        await buildPack(caller, packId, { lastAttempt: attempt >= BUILD_ATTEMPTS, causationId: event.eventId })
      },
    }),
  ]
}

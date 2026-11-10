import type { Prisma } from '@nexus/factory-db'
import { standardLabel } from '@nexus/factory-domain/compliance/register-of-rules/rules'
import { EVIDENCE_RECORD_TYPES, type AnnexIIIPoint } from '@nexus/factory-domain/compliance/techfiles/rules'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import { companyReach, dayOf, seen, type Reader } from './common'

/**
 * The technical files' reads (B-W2b-251): the rows as selected, the style and certificate facts a file shows, and the
 * evidence an item names, resolved to words and to whether it is still current (the design's "a live checklist pointing at
 * real records, so it is never out of date"): a superseded DoC, an expired certificate or a later risk assessment shows as
 * such on the item that links it. Nothing here is money or a person's figure; people only by the name of who wrote,
 * reviewed or signed.
 */

export const FILE_SELECT = {
  id: true,
  companyId: true,
  number: true,
  styleId: true,
  certificateId: true,
  status: true,
  keeperId: true,
  completedAt: true,
  completedById: true,
  archivedAt: true,
  archivedById: true,
  archiveReason: true,
  retainUntil: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.TechnicalFileSelect
export type FileRow = Prisma.TechnicalFileGetPayload<{ select: typeof FILE_SELECT }>

export const ITEM_SELECT = {
  id: true,
  technicalFileId: true,
  point: true,
  seq: true,
  state: true,
  recordType: true,
  recordId: true,
  fileId: true,
  note: true,
  reviewedAt: true,
  reviewedById: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.TechnicalFileItemSelect
export type ItemRow = Prisma.TechnicalFileItemGetPayload<{ select: typeof ITEM_SELECT }>

export const STYLE_SELECT = { id: true, code: true, name: true, companyId: true, ppeCategory: true, ppeStandard: true, ppeClass: true, status: true, measurementTemplateId: true } as const satisfies Prisma.StyleSelect
export type StyleRow = Prisma.StyleGetPayload<{ select: typeof STYLE_SELECT }>

export const CERTIFICATE_SELECT = { id: true, number: true, standard: true, status: true, validFrom: true, validTo: true, notifiedBodyName: true, notifiedBodyNumber: true, companyId: true } as const satisfies Prisma.CertificateSelect
export type CertificateRow = Prisma.CertificateGetPayload<{ select: typeof CERTIFICATE_SELECT }>

export const NOT_FOUND = 'Technical file not found.'

/** The file, when the caller may see it (its company reached by the view permission), else the one 404. */
export async function readFile(db: Reader, actor: Actor, fileId: string): Promise<FileRow> {
  if (!isUuid(fileId)) throw new NotFoundError(NOT_FOUND)
  return seen(await db.technicalFile.findUnique({ where: { id: fileId }, select: FILE_SELECT }), actor, NOT_FOUND)
}

export async function readStyle(db: Reader, styleId: string): Promise<StyleRow> {
  const style = await db.style.findUnique({ where: { id: styleId }, select: STYLE_SELECT })
  if (!style) throw new NotFoundError('Style not found.')
  return style
}

export const readItems = (db: Reader, fileIds: readonly string[]): Promise<ItemRow[]> =>
  fileIds.length === 0 ? Promise.resolve([]) : db.technicalFileItem.findMany({ where: { technicalFileId: { in: [...fileIds] } }, select: ITEM_SELECT, orderBy: [{ point: 'asc' }, { seq: 'asc' }] })

/** The certificates that cover a style (ACTIVE coverage), the style's other side of the file's certificate. */
export async function coveringCertificates(db: Reader, styleIds: readonly string[]): Promise<Map<string, CertificateRow[]>> {
  const out = new Map<string, CertificateRow[]>()
  if (styleIds.length === 0) return out
  const coverage = await db.certificateCoverage.findMany({ where: { styleId: { in: [...styleIds] }, status: 'ACTIVE' }, select: { styleId: true, certificateId: true } })
  const certificates = new Map(
    (await db.certificate.findMany({ where: { id: { in: [...new Set(coverage.map((row) => row.certificateId))] } }, select: CERTIFICATE_SELECT })).map((row) => [row.id, row]),
  )
  for (const row of coverage) {
    const certificate = certificates.get(row.certificateId)
    if (!certificate || !row.styleId) continue
    const list = out.get(row.styleId) ?? []
    if (!list.some((entry) => entry.id === certificate.id)) list.push(certificate)
    out.set(row.styleId, list)
  }
  return out
}

export const certificateRef = (row: CertificateRow) => ({ id: row.id, number: row.number, standard: row.standard, status: row.status, validTo: dayOf(row.validTo)! })

/** The files of the technical files a person reaches (the list's filter). */
export const fileReach = (actor: Actor): Prisma.TechnicalFileWhereInput => companyReach(actor) as Prisma.TechnicalFileWhereInput

// ---- the evidence an item names -------------------------------------------------------------------------------------------

export const EVIDENCE_STATES = ['CURRENT', 'DRAFT', 'SUPERSEDED', 'WITHDRAWN', 'EXPIRED', 'SUSPENDED', 'GONE'] as const
export type EvidenceState = (typeof EVIDENCE_STATES)[number]

export interface Resolved {
  readonly label: string
  readonly state: EvidenceState
  readonly words: string | null
  /** The styles it belongs to (a certificate: those it covers); null: not a style's record (a standard, a lab result). */
  readonly styles: readonly string[] | null
  /** Its company, when it has one. */
  readonly companyId: string | null
}

type Resolver = (db: Reader, ids: readonly string[]) => Promise<Map<string, Resolved>>

const words = (value: string): string => value.replace(/_/g, ' ').toLowerCase()
const stateWords = (state: EvidenceState, what: string): string | null =>
  state === 'CURRENT' ? null : state === 'GONE' ? `This ${what} is not there any more.` : `This ${what} is ${words(state)}: link the one in force.`

const RESOLVERS: Readonly<Record<string, Resolver>> = {
  async Style(db, ids) {
    const rows = await db.style.findMany({ where: { id: { in: [...ids] } }, select: { id: true, code: true, name: true, status: true, companyId: true } })
    return new Map(rows.map((row) => {
      const state: EvidenceState = row.status === 'ARCHIVED' ? 'WITHDRAWN' : 'CURRENT'
      return [row.id, { label: `Style ${row.code} ${row.name}`, state, words: state === 'CURRENT' ? null : 'This style is archived.', styles: [row.id], companyId: row.companyId }]
    }))
  },
  async StyleRevision(db, ids) {
    const rows = await db.styleRevision.findMany({ where: { id: { in: [...ids] } }, select: { id: true, styleId: true, revision: true, status: true, style: { select: { code: true, companyId: true } } } })
    return new Map(rows.map((row) => {
      const state: EvidenceState = row.status === 'RELEASED' ? 'CURRENT' : row.status === 'DRAFT' ? 'DRAFT' : 'SUPERSEDED'
      return [row.id, { label: `${row.style.code} revision ${row.revision} (its BOM, routing and construction)`, state, words: stateWords(state, 'revision'), styles: [row.styleId], companyId: row.style.companyId }]
    }))
  },
  async StyleRevisionFile(db, ids) {
    const rows = await db.styleRevisionFile.findMany({ where: { id: { in: [...ids] } }, select: { id: true, styleId: true, kind: true, revision: { select: { revision: true, status: true } }, file: { select: { originalName: true, status: true, companyId: true } } } })
    return new Map(rows.map((row) => {
      const state: EvidenceState = row.file.status !== 'AVAILABLE' ? 'GONE' : row.revision.status === 'RELEASED' ? 'CURRENT' : row.revision.status === 'DRAFT' ? 'DRAFT' : 'SUPERSEDED'
      return [row.id, { label: `${row.file.originalName} (${words(row.kind)}, revision ${row.revision.revision})`, state, words: stateWords(state, 'pattern file'), styles: [row.styleId], companyId: row.file.companyId }]
    }))
  },
  async MeasurementSpec(db, ids) {
    const rows = await db.measurementSpec.findMany({ where: { id: { in: [...ids] } }, select: { id: true, styleId: true, baseSize: true, status: true, revision: { select: { revision: true } } } })
    return new Map(rows.map((row) => {
      const state: EvidenceState = row.status === 'APPROVED' ? 'CURRENT' : row.status === 'DRAFT' ? 'DRAFT' : 'SUPERSEDED'
      return [row.id, { label: `Measurement spec of revision ${row.revision.revision} (base size ${row.baseSize})`, state, words: stateWords(state, 'measurement spec'), styles: [row.styleId], companyId: null }]
    }))
  },
  async Certificate(db, ids) {
    const rows = await db.certificate.findMany({ where: { id: { in: [...ids] } }, select: { id: true, number: true, standard: true, status: true, companyId: true, coverage: { where: { status: 'ACTIVE' }, select: { styleId: true } } } })
    return new Map(rows.map((row) => {
      const state: EvidenceState = row.status === 'VALID' ? 'CURRENT' : (row.status as EvidenceState)
      return [row.id, { label: `Certificate ${row.number} (${row.standard})`, state, words: stateWords(state, 'certificate'), styles: row.coverage.map((entry) => entry.styleId).filter((value): value is string => value !== null), companyId: row.companyId }]
    }))
  },
  async RegulationOrStandard(db, ids) {
    const rows = await db.regulationOrStandard.findMany({ where: { id: { in: [...ids] } }, select: { id: true, code: true, edition: true, title: true, status: true } })
    return new Map(rows.map((row) => {
      const state: EvidenceState = row.status === 'IN_FORCE' ? 'CURRENT' : (row.status as EvidenceState)
      return [row.id, { label: `${standardLabel(row.code, row.edition)} ${row.title}`, state, words: stateWords(state, 'standard'), styles: null, companyId: null }]
    }))
  },
  async ComplianceDocument(db, ids) {
    const rows = await db.complianceDocument.findMany({ where: { id: { in: [...ids] } }, select: { id: true, styleId: true, kind: true, language: true, revision: true, number: true, status: true, origin: true, companyId: true } })
    return new Map(rows.map((row) => {
      const state: EvidenceState = row.status === 'ISSUED' ? 'CURRENT' : (row.status as EvidenceState)
      const kind = row.kind === 'DECLARATION_OF_CONFORMITY' ? 'Declaration of conformity' : 'User information'
      const note = row.origin === 'GENERATED' ? 'A generated draft: it stays a draft until the PPE consultant checked the texts (GATE-PPE-TEXTS).' : stateWords(state, 'document')
      return [row.id, { label: `${kind} ${row.language} revision ${row.revision}${row.number ? ` (${row.number})` : ''}`, state, words: note, styles: [row.styleId], companyId: row.companyId }]
    }))
  },
  async ProductRiskAssessment(db, ids) {
    const rows = await db.productRiskAssessment.findMany({ where: { id: { in: [...ids] } }, select: { id: true, revision: true, status: true, technicalFile: { select: { styleId: true, companyId: true } } } })
    return new Map(rows.map((row) => {
      const state: EvidenceState = row.status === 'SIGNED' ? 'CURRENT' : (row.status as EvidenceState)
      return [row.id, { label: `Product risk assessment revision ${row.revision}`, state, words: stateWords(state, 'risk assessment'), styles: [row.technicalFile.styleId], companyId: row.technicalFile.companyId }]
    }))
  },
  async ProductionControlTest(db, ids) {
    const rows = await db.productionControlTest.findMany({ where: { id: { in: [...ids] } }, select: { id: true, styleId: true, companyId: true, test: true, testName: true, result: true, testedOn: true, dueOn: true, batchNumber: true, reportNumber: true } })
    return new Map(rows.map((row) => {
      const state: EvidenceState = row.result === null ? 'DRAFT' : 'CURRENT'
      const what = row.testName ? `${words(row.test)} (${row.testName})` : words(row.test)
      const label = row.result === null ? `Production-control test: ${what}, due ${dayOf(row.dueOn)}` : `Production-control test: ${what}, ${row.result} on ${dayOf(row.testedOn)}${row.reportNumber ? `, report ${row.reportNumber}` : ''}`
      return [row.id, { label, state, words: row.result === null ? 'This test is not recorded yet.' : row.result === 'FAIL' ? 'This test failed.' : null, styles: [row.styleId], companyId: row.companyId }]
    }))
  },
  async LabResult(db, ids) {
    const rows = await db.labResult.findMany({ where: { id: { in: [...ids] } }, select: { id: true, test: true, verdict: true, lab: true, reportNumber: true, testedOn: true, companyId: true, supersededBy: { select: { id: true } } } })
    return new Map(rows.map((row) => {
      const state: EvidenceState = row.supersededBy.length > 0 ? 'SUPERSEDED' : 'CURRENT'
      return [row.id, { label: `Lab result ${words(row.test)} ${row.verdict} (${row.lab}${row.reportNumber ? `, ${row.reportNumber}` : ''}, ${dayOf(row.testedOn)})`, state, words: stateWords(state, 'lab result'), styles: null, companyId: row.companyId }]
    }))
  },
  async Inspection(db, ids) {
    const rows = await db.inspection.findMany({ where: { id: { in: [...ids] } }, select: { id: true, number: true, status: true, companyId: true, workOrder: { select: { number: true, styleId: true } } } })
    return new Map(rows.map((row) => {
      const state: EvidenceState = row.status === 'PASSED' || row.status === 'FAILED' ? 'CURRENT' : row.status === 'OPEN' ? 'DRAFT' : 'WITHDRAWN'
      return [row.id, { label: `Final inspection ${row.number ?? row.id.slice(0, 8)} of ${row.workOrder.number} (${words(row.status)})`, state, words: stateWords(state, 'inspection'), styles: [row.workOrder.styleId], companyId: row.companyId }]
    }))
  },
  async InspectionPlanVersion(db, ids) {
    const rows = await db.inspectionPlanVersion.findMany({ where: { id: { in: [...ids] } }, select: { id: true, number: true, status: true, companyId: true, plan: { select: { code: true, name: true } } } })
    return new Map(rows.map((row) => {
      const state: EvidenceState = row.status === 'APPROVED' ? 'CURRENT' : row.status === 'DRAFT' ? 'DRAFT' : 'SUPERSEDED'
      return [row.id, { label: `Inspection plan ${row.plan.code} v${row.number} ${row.plan.name}`, state, words: stateWords(state, 'inspection plan'), styles: null, companyId: row.companyId }]
    }))
  },
  async WorkInstructionVersion(db, ids) {
    const rows = await db.workInstructionVersion.findMany({ where: { id: { in: [...ids] } }, select: { id: true, number: true, status: true, instruction: { select: { number: true, styleId: true, companyId: true } } } })
    return new Map(rows.map((row) => {
      const state: EvidenceState = row.status === 'PUBLISHED' ? 'CURRENT' : row.status === 'DRAFT' ? 'DRAFT' : row.status === 'SUPERSEDED' ? 'SUPERSEDED' : 'WITHDRAWN'
      return [row.id, { label: `Work instruction ${row.instruction.number} v${row.number}`, state, words: stateWords(state, 'work instruction'), styles: row.instruction.styleId ? [row.instruction.styleId] : null, companyId: row.instruction.companyId }]
    }))
  },
  async LabelTemplate(db, ids) {
    const rows = await db.labelTemplate.findMany({ where: { id: { in: [...ids] } }, select: { id: true, code: true, revision: true, name: true, status: true, styleId: true, companyId: true } })
    return new Map(rows.map((row) => {
      const state: EvidenceState = row.status === 'ACTIVE' ? 'CURRENT' : row.status === 'DRAFT' ? 'DRAFT' : 'SUPERSEDED'
      return [row.id, { label: `Label ${row.code} revision ${row.revision} ${row.name}`, state, words: stateWords(state, 'label template'), styles: row.styleId ? [row.styleId] : null, companyId: row.companyId }]
    }))
  },
  async MeasurementTemplate(db, ids) {
    const rows = await db.measurementTemplate.findMany({ where: { id: { in: [...ids] } }, select: { id: true, code: true, name: true, status: true, companyId: true } })
    return new Map(rows.map((row) => {
      const state: EvidenceState = row.status === 'ACTIVE' ? 'CURRENT' : 'WITHDRAWN'
      return [row.id, { label: `Measurement template ${row.code} ${row.name}`, state, words: stateWords(state, 'measurement template'), styles: null, companyId: row.companyId }]
    }))
  },
}

const EVIDENCE_FILE_SELECT = { id: true, companyId: true, recordType: true, recordId: true, originalName: true, contentType: true, sizeBytes: true, sha256: true, status: true, legalHold: true, availableAt: true } as const satisfies Prisma.StoredFileSelect
export type EvidenceFileRow = Prisma.StoredFileGetPayload<{ select: typeof EVIDENCE_FILE_SELECT }>

export const readEvidenceFiles = async (db: Reader, ids: readonly string[]): Promise<Map<string, EvidenceFileRow>> =>
  ids.length === 0 ? new Map() : new Map((await db.storedFile.findMany({ where: { id: { in: [...new Set(ids)] } }, select: EVIDENCE_FILE_SELECT })).map((row) => [row.id, row]))

/** Each named record resolved (type → id → what it is); a type without a resolver or a row that is gone resolves to nothing. */
export async function resolveRecords(db: Reader, refs: readonly { readonly recordType: string; readonly recordId: string }[]): Promise<Map<string, Resolved>> {
  const byType = new Map<string, Set<string>>()
  for (const ref of refs) if (Object.hasOwn(RESOLVERS, ref.recordType)) byType.set(ref.recordType, (byType.get(ref.recordType) ?? new Set()).add(ref.recordId))
  const out = new Map<string, Resolved>()
  for (const [recordType, ids] of byType) {
    for (const [id, resolved] of await RESOLVERS[recordType]!(db, [...ids])) out.set(`${recordType}:${id}`, resolved)
  }
  return out
}

export interface EvidenceView {
  readonly kind: 'RECORD' | 'FILE'
  readonly recordType: string | null
  readonly recordId: string | null
  readonly fileId: string | null
  readonly label: string
  readonly state: EvidenceState
  readonly words: string | null
}

export function evidenceViewOf(item: Pick<ItemRow, 'recordType' | 'recordId' | 'fileId'>, records: ReadonlyMap<string, Resolved>, files: ReadonlyMap<string, EvidenceFileRow>): EvidenceView | null {
  if (item.recordType && item.recordId) {
    const resolved = records.get(`${item.recordType}:${item.recordId}`)
    return resolved
      ? { kind: 'RECORD', recordType: item.recordType, recordId: item.recordId, fileId: null, label: resolved.label, state: resolved.state, words: resolved.words }
      : { kind: 'RECORD', recordType: item.recordType, recordId: item.recordId, fileId: null, label: `${item.recordType} ${item.recordId.slice(0, 8)}`, state: 'GONE', words: 'This record is not there any more (or not one you can see).' }
  }
  if (item.fileId) {
    const file = files.get(item.fileId)
    if (!file) return { kind: 'FILE', recordType: null, recordId: null, fileId: item.fileId, label: 'A file', state: 'GONE', words: 'This file is not there any more (or not one you can see).' }
    const state: EvidenceState = file.status === 'AVAILABLE' ? 'CURRENT' : 'GONE'
    return { kind: 'FILE', recordType: file.recordType, recordId: file.recordId, fileId: file.id, label: file.originalName, state, words: state === 'CURRENT' ? null : `This file is ${words(file.status)}.` }
  }
  return null
}

/** The evidence of many items: their records and files resolved in a few reads. */
export async function evidenceOf(db: Reader, items: readonly Pick<ItemRow, 'recordType' | 'recordId' | 'fileId'>[]) {
  const records = await resolveRecords(db, items.filter((item) => item.recordType && item.recordId).map((item) => ({ recordType: item.recordType!, recordId: item.recordId! })))
  const files = await readEvidenceFiles(db, items.map((item) => item.fileId).filter((value): value is string => value !== null))
  return (item: Pick<ItemRow, 'recordType' | 'recordId' | 'fileId'>): EvidenceView | null => evidenceViewOf(item, records, files)
}

/** The points a record type is usually evidence of (the picker's hint). */
export const pointsOf = (recordType: string | null): readonly AnnexIIIPoint[] => (recordType && Object.hasOwn(EVIDENCE_RECORD_TYPES, recordType) ? EVIDENCE_RECORD_TYPES[recordType]! : [])

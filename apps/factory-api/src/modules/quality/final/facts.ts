import { certificateGateFor, type GateAnswer } from '../../compliance/certificates/gate'
import { ConflictError, type Issue } from '@nexus/factory-domain/core/errors'
import { classificationOf, complianceChecks, documentLanguages, documentStatus, type ComplianceCheck, type DocumentKind } from '@nexus/factory-domain/product/compliance/rules'
import { inspectionLabel } from '@nexus/factory-domain/quality/final/rules'
import {
  fourEyesInForce,
  lotHolds,
  releaseChecks,
  releaseRefusalIssues,
  secondPersonReasons,
  type FourEyesInForce,
  type FourEyesRule,
  type ReleaseCheck,
  type ReleaseFacts,
  type SecondPersonReason,
} from '@nexus/factory-domain/quality/release/rules'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { readDocuments, readLabel, STYLE_SELECT, styleFactsOf } from '../../product/compliance/read'
import { readCells, readSerials, readStyle, type CellRow, type LabelHeader } from '../../production/serials/store'
import type { Signer } from './access'
import {
  fourEyesRows,
  labelsOfCell,
  linkedWorkers,
  lotsOfWorkOrder,
  makersOf,
  releasedFrom,
  releasedPerCell,
  readWorkOrderInspections,
  userOfWorker,
  type InspectionRow,
  type Makers,
  type Reader,
} from './store'

/**
 * What the release gate knows (B-W1-45), read the same way by the release command (inside its transaction, after the
 * work order's release lock) and the screens: the cell's counts, the inspection and its lot, the serials, the garment
 * labels (B-W1-44's label log), the certificate gate on the day (B-W1-12's certificateGateFor), the DoC and the leaflet
 * of the work order's frozen style revision (B-W1-20's documents, in the compliance step's words), the material lots on
 * hold (B-W1-34's lot status), who made the garments, and the four-eyes rule (QualitySettings). The rules and words are
 * factory-domain quality/release. The office reads everything with its own client; a floor device reads the documents
 * and the user-to-worker links (columns its role may not read) through the tenant's system view, before its command.
 */

/** The people a signer is: the office user and the workers linked to them, or the worker and the user it is linked to. */
export interface Identity {
  readonly userIds: ReadonlySet<string>
  readonly workerIds: ReadonlySet<string>
}

/** The signer's identity, read with an office or system reader (Worker.userId is not the floor's). */
export async function identityOf(reader: Reader, signer: Signer): Promise<Identity> {
  if (signer.userId) return { userIds: new Set([signer.userId]), workerIds: new Set(await linkedWorkers(reader, signer.userId)) }
  const userId = signer.workerId ? await userOfWorker(reader, signer.workerId) : null
  return { userIds: new Set(userId ? [userId] : []), workerIds: new Set(signer.workerId ? [signer.workerId] : []) }
}

export const inspectorSigner = (inspection: Pick<InspectionRow, 'inspectorWorkerId' | 'inspectorUserId'>): Signer => ({ workerId: inspection.inspectorWorkerId, userId: inspection.inspectorUserId })

const meets = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => [...a].some((id) => b.has(id))
export const samePerson = (a: Identity, b: Identity): boolean => meets(a.userIds, b.userIds) || meets(a.workerIds, b.workerIds)
export const madeAny = (identity: Identity, makers: Makers): boolean => meets(identity.workerIds, makers.workerIds) || meets(identity.userIds, makers.userIds)

/** The maker check in words (design dec-sod: "Made by (from scans): 9 people - you are not among them"). */
export function makerCheck(identity: Identity, makers: Makers, workOrderNumber: string): { made: boolean; words: string } {
  const people = makers.workerIds.size + makers.userIds.size
  if (madeAny(identity, makers)) {
    return { made: true, words: `You made garments of work order ${workOrderNumber} (its cut log, bundles or scans name you): another inspector, who made none of them, signs it.` }
  }
  const station = makers.unnamed ? '; some records name the station only' : ''
  return { made: false, words: `Made by (from the floor's records): ${people} ${people === 1 ? 'person' : 'people'}${station}. You are not among them.` }
}

/** The work order's makers as a refusal (409 `maker`) — the inspector or releaser made garments. */
export class MakerRefusedError extends ConflictError {
  override name = 'MakerRefusedError'
  override readonly issues: readonly Issue[]
  constructor(message: string) {
    super(message)
    this.issues = [{ path: 'maker', message }]
  }
}

// ---- the documents (B-W1-20's compliance checks) ----------------------------------------------------------------------------

const DOCUMENT_CHECKS: readonly string[] = ['DECLARATION_OF_CONFORMITY', 'USER_INFORMATION']

/**
 * The DoC and the leaflet that hold up the garments of the work order's frozen style revision (PPE: art. 8(7)(8)), in
 * the compliance step's words: its BLOCKED checks of those two kinds (empty: on file, or not PPE). Read as the office
 * or the tenant's system view (a floor role may not read compliance documents).
 */
export async function documentBlockers(reader: Reader, header: Pick<LabelHeader, 'styleId' | 'styleRevisionId' | 'labelTemplateId'>): Promise<ComplianceCheck[]> {
  const style = await reader.style.findUnique({ where: { id: header.styleId }, select: STYLE_SELECT })
  if (!style) return []
  const classification = classificationOf(styleFactsOf(style))
  if (!classification.documentsRequired) return []
  const revision = header.styleRevisionId ? await reader.styleRevision.findUnique({ where: { id: header.styleRevisionId }, select: { id: true, revision: true, status: true } }) : null
  const label = await readLabel(reader, header.labelTemplateId)
  const { facts } = await readDocuments(reader, header.styleId)
  const expected = label?.languages ?? []
  const statuses = (kind: DocumentKind) => documentLanguages(kind, facts, expected).map((language) => documentStatus(kind, language, revision?.revision ?? null, facts))
  const checks = complianceChecks({
    styleId: style.id,
    classification,
    revision: revision ? { id: revision.id, revision: revision.revision, status: revision.status, styleId: style.id } : null,
    released: revision ? { id: revision.id, revision: revision.revision } : null,
    label: label ? { id: label.id, code: label.code, revision: label.revision, status: label.status } : null,
    cells: [],
    documents: { DECLARATION_OF_CONFORMITY: statuses('DECLARATION_OF_CONFORMITY'), USER_INFORMATION: statuses('USER_INFORMATION') },
  })
  return checks.filter((check) => check.state === 'BLOCKED' && DOCUMENT_CHECKS.includes(check.code))
}

// ---- the certificate gate ---------------------------------------------------------------------------------------------------

export const cellText = (cell: Pick<CellRow, 'colourwayCode' | 'size'>): string => `${cell.colourwayCode} ${cell.size}`

export function gateWords(answer: GateAnswer, cell: Pick<CellRow, 'colourwayCode' | 'size'>): string {
  if (answer.outcome === 'covered' && answer.certificate) {
    const c = answer.certificate
    return `Covered: certificate ${c.number} (${c.standard}${c.ppeClass ? `, ${c.ppeClass}` : ''}) covers ${cellText(cell)} today; valid until ${c.validTo}.`
  }
  if (answer.outcome === 'not_required') return answer.message ?? 'No certificate is needed.'
  return answer.reasons.map((reason) => reason.message).join(' ') || `No valid certificate covers ${cellText(cell)} today.`
}

export async function certificateOf(db: Reader, header: Pick<LabelHeader, 'styleId'>, cell: CellRow, today: BusinessDate): Promise<GateAnswer> {
  return certificateGateFor(db, { styleId: header.styleId, colourwayId: cell.colourwayId, size: cell.size }, today)
}

// ---- the rule in force ----------------------------------------------------------------------------------------------------------

export async function ruleInForce(db: Reader, tenantId: string, companyId: string): Promise<FourEyesInForce> {
  const rows = await fourEyesRows(db, tenantId, companyId)
  const row = (value: typeof rows.company) => (value ? { releaseFourEyes: (value.releaseFourEyes ?? null) as FourEyesRule | null, secondPersonPartyIds: value.secondPersonPartyIds ?? [] } : null)
  return fourEyesInForce(row(rows.company), row(rows.tenant))
}

// ---- the gate of one cell ---------------------------------------------------------------------------------------------------------

export interface GateInput {
  readonly tenantId: string
  readonly header: LabelHeader
  readonly cellId: string
  readonly inspection: InspectionRow | null
  /** Garments asked (a release); null: the gate as it stands. */
  readonly quantity: number | null
  /** SERIAL: the serials named (a release). */
  readonly serialIds: readonly string[]
  /** The releaser (or the viewer, for a read); null: nobody yet. */
  readonly releaser: Identity | null
  /** The inspection's inspector, as people (the same-person check of four eyes). */
  readonly inspector: Identity | null
  /** Read before (the office: in the transaction; the floor: through the system view). */
  readonly documents: readonly ComplianceCheck[]
  readonly today: BusinessDate
}

export interface CellGate {
  readonly cell: CellRow
  readonly facts: ReleaseFacts
  readonly checks: ReleaseCheck[]
  readonly certificate: GateAnswer
  readonly reasons: SecondPersonReason[]
  readonly rule: FourEyesInForce
  readonly makers: Makers
  /** SERIAL: the cell's serials ready to release (MADE, not packed), oldest first. */
  readonly readySerials: { readonly id: string; readonly serial: string }[]
}

export async function cellGate(db: Reader, input: GateInput): Promise<CellGate> {
  const { header } = input
  const cells = await readCells(db, header.id)
  const cell = cells.find((entry) => entry.id === input.cellId)
  if (!cell) throw new ConflictError('Not a cell of this work order.')
  const style = await readStyle(db, header.styleId)
  const tracking = style?.tracking ?? 'BATCH'
  const counts = (await releasedPerCell(db, [cell.id])).get(cell.id) ?? { released: 0, reversed: 0 }
  const netReleased = counts.released - counts.reversed
  const inspections = await readWorkOrderInspections(db, header.id)
  const inspection = input.inspection
  const seq = inspection ? inspections.findIndex((row) => row.id === inspection.id) + 1 : 0
  const fromIt = inspection ? await releasedFrom(db, inspection.id) : 0
  const labels = await labelsOfCell(db, cell.id)
  const serials = tracking === 'SERIAL' ? (await readSerials(db, header.id)).filter((serial) => serial.workOrderSizeId === cell.id) : []
  const ready = serials.filter((serial) => serial.status === 'MADE' && serial.shipmentLineId === null)
  const readyIds = new Set(ready.map((serial) => serial.id))
  const serialProblems: string[] = []
  for (const id of input.serialIds) {
    const serial = serials.find((entry) => entry.id === id)
    if (!serial) serialProblems.push('A serial named is not a serial of this cell.')
    else if (!readyIds.has(id)) serialProblems.push(`Serial ${serial.serial} is ${serial.status}${serial.shipmentLineId ? ' and packed' : ''}: only MADE, unpacked serials are released.`)
  }
  const certificate = await certificateOf(db, header, cell, input.today)
  const lots = (await lotsOfWorkOrder(db, header.id)).filter(lotHolds)
  const makers = await makersOf(db, header.id)
  const rule = await ruleInForce(db, input.tenantId, header.companyId)
  const reasons = secondPersonReasons({ overridden: Boolean(inspection?.overrideReason), rule: rule.rule, customerListed: rule.partyIds.includes(cell.partyId) })
  const facts: ReleaseFacts = {
    workOrder: { number: header.number, status: header.status },
    inspection: inspection ? { label: inspectionLabel(header.number, seq, inspection.number), status: inspection.status, lotSize: inspection.lotSize, releasedFrom: fromIt } : null,
    cell: { label: cellText(cell), pieces: cell.quantity, netReleased },
    quantity: input.quantity,
    tracking,
    serials: { named: input.serialIds.length, problems: serialProblems, available: ready.length },
    labels: { printed: tracking === 'BATCH' ? labels.printed : input.serialIds.filter((id) => labels.serialIds.has(id)).length },
    certificate: { allowed: certificate.allowed, words: gateWords(certificate, cell) },
    documents: input.documents.map((check) => ({ code: check.code, message: check.message })),
    lotsOnHold: lots.map((lot) => ({ code: lot.code, qualityStatus: lot.qualityStatus, crViStatus: lot.crViStatus })),
    maker: input.releaser ? makerCheck(input.releaser, makers, header.number) : null,
    secondPerson: { reasons, releaserIsInspector: input.releaser && input.inspector ? samePerson(input.releaser, input.inspector) : null },
  }
  return { cell, facts, checks: releaseChecks(facts), certificate, reasons, rule, makers, readySerials: ready.map((serial) => ({ id: serial.id, serial: serial.serial })) }
}

/** A refused release: 409 with `checks/<CODE>` and its fix, every open check at once. */
export class ReleaseRefusedError extends ConflictError {
  override name = 'ReleaseRefusedError'
  override readonly issues: readonly Issue[]
  constructor(checks: readonly ReleaseCheck[]) {
    const issues = releaseRefusalIssues(checks)
    super(issues[0]?.message ?? 'The release is refused.')
    this.issues = issues
  }
}

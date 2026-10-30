import { FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  completeProblems,
  evidenceKindWords,
  evidenceNeed,
  filingProblems,
  missingWords,
  needChangeProblems,
  stateAfterFiling,
  stateAfterReopen,
  stateWhenNeeded,
  summary,
  type EvidenceKind,
  type TransportEvidenceStatus,
} from '@nexus/factory-domain/shipping/evidence/evidence'
import { SHIPPING_EVIDENCE_MANAGE } from '@nexus/factory-domain/shipping/shipments/permissions'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { completeUpload, requestUpload } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { officeContextOf } from '../access'
import { readShipment, type ShipmentHeader } from '../store'
import { officeShipment } from '../shipments/shipments'

/**
 * Intra-EU transport evidence (B-W2a-48; LOG-090; art. 41 DL 331/1993, Reg. (EU) 282/2011 art. 45a; design
 * warehouse.shipments Export "intra-EU evidence files (art. 41 DL 331/93: POD, CMR, carrier invoice; W2a)"): the papers
 * are files of the shipment (StoredFile recordType "Shipment", kind ATTACHMENT, kept ten years), each filed through these
 * routes with its kind (the audit row `shipping.evidencePaper` names the file and its kind: no column does); the
 * shipment keeps the state (factory-domain shipping/evidence). Office only.
 *
 *   GET  /shipping/shipments/:id/evidence                       shipping.view: the state, why it is needed, the papers,
 *                                                                what is missing
 *   POST /shipping/shipments/:id/evidence/papers                shipping.evidence.manage + files.upload: a paper (its kind),
 *                                                                then the presigned PUT
 *   POST /shipping/shipments/:id/evidence/papers/:fileId/complete   confirmed: AWAITED → PARTIAL
 *   POST /shipping/shipments/:id/evidence/complete              a person says the papers are enough (COMPLETE, at + by)
 *   POST /shipping/shipments/:id/evidence/reopen                COMPLETE back (a paper found wrong), with the reason
 *   POST /shipping/shipments/:id/evidence/needed                the office says it does (or does not) need it, with the
 *                                                                reason (the automatic call was wrong)
 *
 * When the goods leave, the leaving command sets AWAITED for a zero-rated intra-EU sale (`markAwaitedInCommand`).
 * Every write is one command on the Shipment (its version bump locks the row).
 */

const PAPER = 'shipping.evidencePaper'
/** Ten years (art. 2220 c.c.; the VAT records' evidence). */
const RETAIN_YEARS = 10

export interface Paper {
  readonly fileId: string
  readonly kind: EvidenceKind
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly status: string
  readonly createdAt: string
}

/** The papers filed for a shipment: its files named by `shipping.evidencePaper` audit rows, not deleted. */
async function papersOf(db: CommandTx, shipmentId: string): Promise<Paper[]> {
  const rows = await db.auditLog.findMany({ where: { recordType: 'Shipment', recordId: shipmentId, action: PAPER }, select: { after: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
  const kinds = new Map<string, EvidenceKind>()
  for (const row of rows) {
    const after = row.after as { fileId?: unknown; kind?: unknown } | null
    if (typeof after?.fileId === 'string' && typeof after.kind === 'string') kinds.set(after.fileId, after.kind as EvidenceKind)
  }
  if (kinds.size === 0) return []
  const files = await db.storedFile.findMany({
    where: { id: { in: [...kinds.keys()] }, recordType: 'Shipment', recordId: shipmentId, status: { not: 'DELETED' } },
    select: { id: true, originalName: true, contentType: true, sizeBytes: true, status: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return files.map((file) => ({ fileId: file.id, kind: kinds.get(file.id)!, originalName: file.originalName, contentType: file.contentType, sizeBytes: file.sizeBytes, status: file.status, createdAt: toUtcIso(file.createdAt) }))
}

const available = (papers: readonly Paper[]) => papers.filter((paper) => paper.status === 'AVAILABLE')

async function evidenceRow(db: CommandTx, shipmentId: string) {
  const row = await db.shipment.findUnique({ where: { id: shipmentId }, select: { transportEvidence: true, transportEvidenceAt: true, transportEvidenceById: true, transportEvidenceNote: true } })
  return row ?? { transportEvidence: 'NOT_NEEDED' as const, transportEvidenceAt: null, transportEvidenceById: null, transportEvidenceNote: null }
}

/** Whether the shipment's sale needs the evidence (the order's VAT treatment, where it goes, the seller's country). */
async function needOf(db: CommandTx, shipment: Pick<ShipmentHeader, 'salesOrderId' | 'companyId' | 'shipTo'>) {
  const order = await db.salesOrder.findUnique({ where: { id: shipment.salesOrderId }, select: { taxMode: true } })
  const company = await db.company.findUnique({ where: { id: shipment.companyId }, select: { country: true } })
  const shipTo = shipment.shipTo as { country?: unknown } | null
  return evidenceNeed({ taxMode: order?.taxMode ?? 'IT_B2B', shipToCountry: typeof shipTo?.country === 'string' ? shipTo.country : null, companyCountry: company?.country ?? 'IT' })
}

/** The record's evidence part (also the answer of every write here). */
export async function evidenceView(db: CommandTx, shipment: ShipmentHeader) {
  const row = await evidenceRow(db, shipment.id)
  const papers = await papersOf(db, shipment.id)
  const kinds = available(papers).map((paper) => paper.kind)
  const need = await needOf(db, shipment)
  const status = row.transportEvidence as TransportEvidenceStatus
  return {
    shipmentId: shipment.id,
    number: shipment.number,
    shipmentStatus: shipment.status,
    version: shipment.version,
    status,
    completedAt: row.transportEvidenceAt ? toUtcIso(row.transportEvidenceAt) : null,
    completedById: row.transportEvidenceById,
    note: row.transportEvidenceNote,
    need: need.words,
    neededBySale: need.needed,
    onFile: kinds.length > 0 ? summary(kinds) : null,
    missing: missingWords(status, kinds),
    papers: papers.map((paper) => ({ ...paper, kindWords: evidenceKindWords(paper.kind) })),
  }
}

export type EvidenceView = Awaited<ReturnType<typeof evidenceView>>

function changed(tools: CommandTools, shipment: ShipmentHeader, from: TransportEvidenceStatus, to: TransportEvidenceStatus, papers: number) {
  if (from === to) return
  tools.emit({ type: 'shipment.evidence_changed', subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: shipment.number, from, to, papers } })
}

/**
 * Inside the leaving command (after the shipment is SHIPPED): AWAITED for a zero-rated intra-EU sale. Answers the
 * state it set, or null when the sale needs none.
 */
export async function markAwaitedInCommand(tools: CommandTools, shipment: ShipmentHeader): Promise<TransportEvidenceStatus | null> {
  const need = await needOf(tools.tx, shipment)
  if (!need.needed) return null
  const row = await evidenceRow(tools.tx, shipment.id)
  if (row.transportEvidence !== 'NOT_NEEDED') return null
  await tools.tx.shipment.update({ where: { id: shipment.id }, data: { transportEvidence: 'AWAITED' }, select: { id: true } })
  tools.audit({ action: 'shipping.evidenceAwaited', recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, before: { transportEvidence: 'NOT_NEEDED' }, after: { transportEvidence: 'AWAITED' }, reason: need.words })
  changed(tools, shipment, 'NOT_NEEDED', 'AWAITED', 0)
  return 'AWAITED'
}

/** GET /shipping/shipments/:shipmentId/evidence */
export async function getEvidence(caller: CommandCaller, shipmentId: string) {
  const shipment = await officeShipment(caller, shipmentId)
  return { evidence: await caller.withClient((client) => evidenceView(client, shipment)) }
}

/** A command on the shipment (its version bump locks the row), answering the evidence as it is then. */
async function onShipment(caller: CommandCaller, shipment: ShipmentHeader, spec: { name: `shipping.${string}`; idempotencyKey: string | undefined; input: unknown; version: number | undefined }, work: (tools: CommandTools, current: ShipmentHeader) => Promise<void>) {
  const { result } = await command(caller, { name: spec.name, idempotencyKey: spec.idempotencyKey, input: spec.input, record: { type: 'Shipment', id: shipment.id, expectedVersion: spec.version } }, async (tools) => {
    const current = await readShipment(tools.tx, shipment.id)
    if (!current) throw new NotFoundError('Shipment not found.')
    await work(tools, current)
    return { evidence: await evidenceView(tools.tx, (await readShipment(tools.tx, shipment.id))!) }
  })
  return result
}

export interface PaperBody {
  readonly kind: EvidenceKind
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

/** POST /shipping/shipments/:shipmentId/evidence/papers: a paper and its kind, then the presigned PUT. */
export async function announcePaper(files: FilesRuntime, caller: CommandCaller, shipmentId: string, body: PaperBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_EVIDENCE_MANAGE)
  if (!can(actorOf(context), FILES_UPLOAD, { companyId: shipment.companyId, siteId: shipment.siteId, partyId: shipment.partyId })) throw new ForbiddenError(`Filing a paper needs ${FILES_UPLOAD} over the company.`)
  const row = await caller.withClient((client) => evidenceRow(client, shipment.id))
  const problems = filingProblems(shipment.status, row.transportEvidence as TransportEvidenceStatus)
  if (problems.length > 0) throw new InvalidStateError(problems.join(' '))
  const retainUntil = new Date(files.clock.now().getTime())
  retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + RETAIN_YEARS)
  const upload = await requestUpload(
    files,
    caller,
    { companyId: shipment.companyId, recordType: 'Shipment', recordId: shipment.id, kind: 'ATTACHMENT', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256, retainUntil: retainUntil.toISOString() },
    idempotencyKey,
  )
  // The paper's kind (no column says it): an audit row of the shipment, once per file.
  await command(caller, { name: PAPER, ...(idempotencyKey ? { idempotencyKey: `${idempotencyKey}:kind` } : {}), input: { shipmentId, fileId: upload.file.id, kind: body.kind } }, async (tools) => {
    const known = await tools.tx.auditLog.findFirst({ where: { recordType: 'Shipment', recordId: shipment.id, action: PAPER, after: { path: ['fileId'], equals: upload.file.id } }, select: { id: true } })
    if (!known) tools.audit({ action: PAPER, recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, after: { fileId: upload.file.id, kind: body.kind, originalName: upload.file.originalName } })
    else tools.audit({ action: 'shipping.evidencePaperAgain', recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, after: { fileId: upload.file.id } })
    return { fileId: upload.file.id }
  })
  return upload
}

/** POST /shipping/shipments/:shipmentId/evidence/papers/:fileId/complete: the upload confirmed; AWAITED → PARTIAL. */
export async function completePaper(files: FilesRuntime, caller: CommandCaller, shipmentId: string, fileId: string, body: { version?: number | undefined }, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_EVIDENCE_MANAGE)
  const paper = isUuid(fileId) ? (await caller.withClient((client) => papersOf(client, shipment.id))).find((entry) => entry.fileId === fileId) : undefined
  if (!paper) throw new NotFoundError('Paper not found on this shipment.')
  const file = await completeUpload(files, caller, fileId, idempotencyKey)
  if (file.status !== 'AVAILABLE') return { file, evidence: await caller.withClient(async (client) => evidenceView(client, (await readShipment(client, shipment.id))!)) }
  const answer = await onShipment(caller, shipment, { name: 'shipping.evidenceFiled', idempotencyKey: idempotencyKey ? `${idempotencyKey}:state` : undefined, input: { shipmentId, fileId }, version: body.version }, async (tools, current) => {
    const row = await evidenceRow(tools.tx, current.id)
    const from = row.transportEvidence as TransportEvidenceStatus
    const to = stateAfterFiling(from)
    const papers = available(await papersOf(tools.tx, current.id)).length
    if (to !== from) await tools.tx.shipment.update({ where: { id: current.id }, data: { transportEvidence: to }, select: { id: true } })
    tools.audit({ action: 'shipping.evidenceFiled', recordType: 'Shipment', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { transportEvidence: from }, after: { transportEvidence: to, fileId, kind: paper.kind, papers } })
    changed(tools, current, from, to, papers)
  })
  return { file, ...answer }
}

/** POST /shipping/shipments/:shipmentId/evidence/complete: a person says the papers are enough. */
export async function completeEvidence(caller: CommandCaller, shipmentId: string, body: { version?: number | undefined; note?: string | null | undefined }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_EVIDENCE_MANAGE)
  return onShipment(caller, shipment, { name: 'shipping.evidenceComplete', idempotencyKey, input: { shipmentId, ...body }, version: body.version }, async (tools, current) => {
    const row = await evidenceRow(tools.tx, current.id)
    const from = row.transportEvidence as TransportEvidenceStatus
    const papers = available(await papersOf(tools.tx, current.id))
    const problems = completeProblems(from, papers.map((paper) => paper.kind))
    if (problems.length > 0) throw new InvalidStateError(problems.join(' '))
    const note = body.note?.trim() ? body.note.trim() : row.transportEvidenceNote
    await tools.tx.shipment.update({ where: { id: current.id }, data: { transportEvidence: 'COMPLETE', transportEvidenceAt: tools.now, transportEvidenceById: context.actorId, transportEvidenceNote: note }, select: { id: true } })
    tools.audit({ action: 'shipping.evidenceComplete', recordType: 'Shipment', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { transportEvidence: from }, after: { transportEvidence: 'COMPLETE', papers: papers.map((paper) => ({ fileId: paper.fileId, kind: paper.kind })) } })
    changed(tools, current, from, 'COMPLETE', papers.length)
  })
}

/** POST /shipping/shipments/:shipmentId/evidence/reopen: COMPLETE back, with the reason. */
export async function reopenEvidence(caller: CommandCaller, shipmentId: string, body: { version?: number | undefined; reason: string }, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_EVIDENCE_MANAGE)
  return onShipment(caller, shipment, { name: 'shipping.evidenceReopen', idempotencyKey, input: { shipmentId, ...body }, version: body.version }, async (tools, current) => {
    const row = await evidenceRow(tools.tx, current.id)
    if (row.transportEvidence !== 'COMPLETE') throw new InvalidStateError(`The transport evidence is ${row.transportEvidence}: only COMPLETE evidence is reopened.`)
    const papers = available(await papersOf(tools.tx, current.id)).length
    const to = stateAfterReopen(papers)
    await tools.tx.shipment.update({ where: { id: current.id }, data: { transportEvidence: to, transportEvidenceAt: null, transportEvidenceById: null }, select: { id: true } })
    tools.audit({ action: 'shipping.evidenceReopen', recordType: 'Shipment', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { transportEvidence: 'COMPLETE', completedAt: row.transportEvidenceAt ? toUtcIso(row.transportEvidenceAt) : null }, after: { transportEvidence: to }, reason: body.reason })
    changed(tools, current, 'COMPLETE', to, papers)
  })
}

/** POST /shipping/shipments/:shipmentId/evidence/needed: the office says the shipment does (or does not) need it. */
export async function setEvidenceNeeded(caller: CommandCaller, shipmentId: string, body: { version?: number | undefined; needed: boolean; reason: string }, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_EVIDENCE_MANAGE)
  return onShipment(caller, shipment, { name: 'shipping.evidenceNeeded', idempotencyKey, input: { shipmentId, ...body }, version: body.version }, async (tools, current) => {
    const row = await evidenceRow(tools.tx, current.id)
    const from = row.transportEvidence as TransportEvidenceStatus
    const papers = available(await papersOf(tools.tx, current.id)).length
    const problems = needChangeProblems(current.status, from, body.needed, papers)
    if (problems.length > 0) throw new InvalidStateError(problems.join(' '))
    const to: TransportEvidenceStatus = body.needed ? stateWhenNeeded(papers) : 'NOT_NEEDED'
    await tools.tx.shipment.update({ where: { id: current.id }, data: { transportEvidence: to }, select: { id: true } })
    tools.audit({ action: 'shipping.evidenceNeeded', recordType: 'Shipment', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { transportEvidence: from }, after: { transportEvidence: to, needed: body.needed }, reason: body.reason })
    changed(tools, current, from, to, papers)
  })
}

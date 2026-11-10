import type { Prisma } from '@nexus/factory-db'
import { BATCH_NUMBER_MAX, keptUntil, recordRefusal, recordsToMake, versionsByBatch } from '@nexus/factory-domain/compliance/declarations/batches'
import { DECLARATIONS_RECORD, DECLARATIONS_VIEW } from '@nexus/factory-domain/compliance/declarations/permissions'
import { NOTE_MAX } from '@nexus/factory-domain/compliance/declarations/rules'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { readDocuments } from '../../shipping/documents/read'
import { readShipment, type ShipmentHeader } from '../../shipping/store'
import { assertMayWriteDocument, dateDay, dateOf, declarationsCommand, mayRead, namesFor, officeOf, readVisibleDocument, refused, type Reader } from './common'
import { unrecordedPairs } from './read'

/**
 * Versions by batch (B-W2b-257; PRD-295; Reg. (EU) 2016/425 art. 8(8), art. 15(2); QHS-110): which signed revision of a DoC
 * or leaflet went with which batch and shipment, on B-W2b-218's ComplianceDocumentBatch (written once, kept ten years: the
 * database refuses its removal before retainUntil for every login). A work order's batch takes exactly the revision the work
 * order froze, so the public DoC page (B-W2b-166: the frozen revision) and the customer documents (B-W1-49: the copies of the
 * frozen revision on the shipment) name the same revision as the record — neither reads this table, and neither needs to.
 *
 *   GET  /compliance/declarations/batches                     the records (filters), and the timeline of a style
 *   POST /compliance/declarations/batches                     one record: a work order's batch (or a batch number typed) with
 *                                                             an issued document, as made or with a shipment
 *   POST /compliance/declarations/shipments/:id/versions      what travelled: every travelling DoC and leaflet (shipping's
 *                                                             choice) × each batch of the shipment, not recorded yet
 *   GET  /compliance/declarations/batches/unrecorded          shipments that left with a PPE batch and no record (the tile
 *                                                             "batches shipped without a recorded version", should be 0)
 *
 * The shipment compliance pack (pack.ts) records the same in its command. Writing needs W1's compliance.declarations.manage
 * (the signed documents are W1's) over the batch's company.
 */

const RECORD_SELECT = {
  id: true,
  companyId: true,
  styleId: true,
  documentId: true,
  siteId: true,
  workOrderId: true,
  batchNumber: true,
  shipmentId: true,
  retainUntil: true,
  note: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.ComplianceDocumentBatchSelect
type RecordRow = Prisma.ComplianceDocumentBatchGetPayload<{ select: typeof RECORD_SELECT }>

async function recordViews(db: Reader, rows: readonly RecordRow[]) {
  const documents = new Map((await db.complianceDocument.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.documentId))] } }, select: { id: true, kind: true, language: true, revision: true, number: true, status: true } })).map((row) => [row.id, row]))
  const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.styleId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const orders = new Map((await db.workOrder.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.workOrderId).filter((id): id is string => id !== null))] } }, select: { id: true, number: true } })).map((row) => [row.id, row.number]))
  const shipments = new Map((await db.shipment.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.shipmentId).filter((id): id is string => id !== null))] } }, select: { id: true, number: true } })).map((row) => [row.id, row.number]))
  const names = await namesFor(db, rows.map((row) => row.createdById))
  return rows.map((row) => {
    const document = documents.get(row.documentId)
    return {
      id: row.id,
      companyId: row.companyId,
      style: { id: row.styleId, code: styles.get(row.styleId) ?? '?' },
      document: document ? { id: document.id, kind: document.kind, language: document.language, revision: document.revision, number: document.number, status: document.status } : null,
      batchNumber: row.batchNumber,
      workOrder: row.workOrderId ? { id: row.workOrderId, number: orders.get(row.workOrderId) ?? '?' } : null,
      shipment: row.shipmentId ? { id: row.shipmentId, number: shipments.get(row.shipmentId) ?? '?' } : null,
      retainUntil: dateDay(row.retainUntil),
      note: row.note,
      createdAt: toUtcIso(row.createdAt),
      createdBy: names(row.createdById),
    }
  })
}

export interface BatchesQuery {
  readonly styleId?: string | undefined
  readonly batchNumber?: string | undefined
  readonly workOrderId?: string | undefined
  readonly shipmentId?: string | undefined
}

/** GET /compliance/declarations/batches */
export async function listBatches(caller: CommandCaller, query: BatchesQuery) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (db) => {
    const filters: Prisma.ComplianceDocumentBatchWhereInput[] = [scopeWhere(actor, DECLARATIONS_VIEW, { company: 'companyId' }) as Prisma.ComplianceDocumentBatchWhereInput]
    if (query.styleId) filters.push({ styleId: query.styleId })
    if (query.batchNumber) filters.push({ batchNumber: query.batchNumber })
    if (query.workOrderId) filters.push({ workOrderId: query.workOrderId })
    if (query.shipmentId) filters.push({ shipmentId: query.shipmentId })
    const rows = await db.complianceDocumentBatch.findMany({ where: { AND: filters }, select: RECORD_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1000 })
    const records = await recordViews(db, rows)
    let timeline = null
    if (query.styleId) {
      const documents = await db.complianceDocument.findMany({ where: { styleId: query.styleId, origin: 'SIGNED', status: { not: 'DRAFT' } }, select: { id: true, kind: true, language: true, revision: true, number: true, status: true } })
      timeline = versionsByBatch(
        rows.map((row) => ({ id: row.id, documentId: row.documentId, batchNumber: row.batchNumber, workOrderId: row.workOrderId, shipmentId: row.shipmentId, createdAt: toUtcIso(row.createdAt) })),
        documents,
      )
    }
    return { records, timeline, asOf: toUtcIso(new Date()) }
  })
}

export interface RecordBody {
  readonly documentId: string
  readonly workOrderId?: string | undefined
  readonly batchNumber?: string | undefined
  readonly shipmentId?: string | undefined
  /** For a batch number typed on a document of every company: the batch's company. */
  readonly companyId?: string | undefined
  readonly note?: string | null | undefined
}

interface NewRecord {
  readonly companyId: string
  readonly styleId: string
  readonly documentId: string
  readonly siteId: string | null
  readonly workOrderId: string | null
  readonly batchNumber: string
  readonly shipmentId: string | null
  readonly note: string | null
}

/** Inside a command: the records, each with its retainUntil, one audit row each and one event for all. */
export async function insertRecords(tools: CommandTools, records: readonly NewRecord[], shipmentId: string | null): Promise<string[]> {
  if (records.length === 0) return []
  const { tx, audit, emit, context, now } = tools
  // Kept from the Rome day it is recorded (the command's time, which is also its createdAt: the database counts from it).
  const today: BusinessDate = businessDate(now)
  const ids: string[] = []
  for (const record of records) {
    const id = newId()
    await tx.complianceDocumentBatch.create({ data: { id, ...record, retainUntil: dateOf(keptUntil(today)), createdAt: now, createdById: context.audience === 'office' ? context.actorId : null }, select: { id: true } })
    audit({ action: 'compliance.declarations.recordBatch', recordType: 'ComplianceDocumentBatch', recordId: id, companyId: record.companyId, after: { ...record, retainUntil: keptUntil(today) } })
    ids.push(id)
  }
  const companyId = records[0]!.companyId
  emit({
    type: 'compliance_declarations.batches_recorded',
    subject: shipmentId ?? records[0]!.documentId,
    companyId,
    payload: { styleIds: [...new Set(records.map((record) => record.styleId))], shipmentId, records: records.length, batchNumbers: [...new Set(records.map((record) => record.batchNumber))] },
  })
  return ids
}

/** POST /compliance/declarations/batches: one record. */
export async function recordBatch(caller: CommandCaller, body: RecordBody, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  if (body.note !== undefined && body.note !== null && (body.note.trim() === '' || body.note.length > NOTE_MAX)) throw new ValidationError('The record is not valid.', [{ path: 'body/note', message: `A note of 1 to ${NOTE_MAX} characters, or none.` }])
  if (body.batchNumber !== undefined && (body.batchNumber.trim() === '' || body.batchNumber.length > BATCH_NUMBER_MAX)) throw new ValidationError('The record is not valid.', [{ path: 'body/batchNumber', message: `The batch number: 1 to ${BATCH_NUMBER_MAX} characters.` }])
  const prepared = await caller.withClient(async (db) => {
    const document = await readVisibleDocument(db, context, body.documentId)
    const order = body.workOrderId
      ? await db.workOrder.findUnique({ where: { id: body.workOrderId }, select: { id: true, number: true, companyId: true, siteId: true, styleId: true, batchNumber: true, styleRevisionId: true } })
      : null
    if (body.workOrderId && (!order || !mayRead(context, order.companyId))) throw new NotFoundError('There is no such work order.')
    const frozen = order?.styleRevisionId ? await db.styleRevision.findUnique({ where: { id: order.styleRevisionId }, select: { revision: true } }) : null
    const shipment = body.shipmentId && isUuid(body.shipmentId) ? await db.shipment.findUnique({ where: { id: body.shipmentId }, select: { id: true, number: true, status: true, companyId: true } }) : null
    if (body.shipmentId && (!shipment || !mayRead(context, shipment.companyId))) throw new NotFoundError('There is no such shipment.')
    const carries = shipment && order ? (await db.shipmentLine.count({ where: { shipmentId: shipment.id, workOrderId: order.id } })) > 0 : null
    const companyId = order?.companyId ?? document.companyId ?? body.companyId ?? shipment?.companyId ?? null
    if (!companyId) throw new ValidationError('The record is not valid.', [{ path: 'body/companyId', message: 'This document is every company\'s: say which company made the batch.' }])
    if (!mayRead(context, companyId)) throw new ValidationError('The record is not valid.', [{ path: 'body/companyId', message: 'Not a company you reach.' }])
    return { document, order, frozen, shipment, carries, companyId }
  })
  const { document, order, frozen, shipment, carries, companyId } = prepared
  assertMayWriteDocument(context, DECLARATIONS_RECORD, companyId)
  const refusal = recordRefusal({
    document: { styleId: document.styleId, kind: document.kind, revision: document.revision, status: document.status, language: document.language },
    workOrder: order ? { styleId: order.styleId, batchNumber: order.batchNumber, frozenRevision: frozen?.revision ?? null, number: order.number } : null,
    batchNumber: body.batchNumber?.trim() ?? null,
    shipment: shipment ? { number: shipment.number, status: shipment.status, carriesWorkOrder: carries } : null,
  })
  if (refusal) throw refused(refusal.code === 'NOT_ISSUED' || refusal.code === 'NOT_RELEASED' || refusal.code === 'SHIPMENT_CANCELLED' ? 'invalid_state' : 'conflict', refusal)
  const batchNumber = order ? order.batchNumber! : body.batchNumber!.trim()
  const { result } = await declarationsCommand(
    caller,
    { name: 'compliance.declarations.recordBatch', idempotencyKey, input: body },
    async (tools) => {
      const existing = await tools.tx.complianceDocumentBatch.findFirst({ where: { documentId: document.id, batchNumber, shipmentId: shipment?.id ?? null }, select: { id: true } })
      if (existing) throw refused('conflict', { code: 'RECORDED', message: `Batch ${batchNumber} is recorded with this document${shipment ? ` and shipment ${shipment.number}` : ''} already.` })
      const [id] = await insertRecords(
        tools,
        [{ companyId, styleId: document.styleId, documentId: document.id, siteId: order?.siteId ?? null, workOrderId: order?.id ?? null, batchNumber, shipmentId: shipment?.id ?? null, note: body.note?.trim() ?? null }],
        shipment?.id ?? null,
      )
      return id!
    },
    { taken: `Batch ${batchNumber} is recorded with this document already.` },
  )
  const rows = await caller.withClient((db) => db.complianceDocumentBatch.findMany({ where: { id: result }, select: RECORD_SELECT }))
  return { record: (await caller.withClient((db) => recordViews(db, rows)))[0]! }
}

// ---- what travelled with a shipment ------------------------------------------------------------------------------------------

/** The shipment as the caller may see it (its company), or not found. */
export async function visibleShipment(db: Reader, context: OfficeContext, shipmentId: string): Promise<ShipmentHeader> {
  const shipment = await readShipment(db as Parameters<typeof readShipment>[0], shipmentId)
  if (!shipment || !mayRead(context, shipment.companyId)) throw new NotFoundError('There is no such shipment.')
  return shipment
}

export interface Travelled {
  readonly toMake: NewRecord[]
  readonly skipped: { readonly batchNumber: string; readonly documentId: string; readonly message: string }[]
}

/** The records a shipment still needs (shipping's travelling documents × its batches); a document no longer ISSUED is skipped. */
export async function travelledRecords(db: Reader, shipment: ShipmentHeader): Promise<Travelled> {
  const { documents } = await readDocuments(db, shipment)
  const travelling = documents.documents.filter((document) => (document.kind === 'DECLARATION_OF_CONFORMITY' || document.kind === 'USER_INFORMATION') && document.documentId !== null && document.style !== null && document.style.revision !== null)
  const rows = travelling.length > 0 ? await db.complianceDocument.findMany({ where: { id: { in: travelling.map((document) => document.documentId!) } }, select: { id: true, styleId: true, revision: true, status: true, companyId: true } }) : []
  const lines = await db.shipmentLine.findMany({ where: { shipmentId: shipment.id }, select: { workOrderId: true } })
  const orders = await db.workOrder.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.workOrderId))] } }, select: { id: true, siteId: true, companyId: true, styleId: true, batchNumber: true, styleRevisionId: true } })
  const revisions = new Map((await db.styleRevision.findMany({ where: { id: { in: orders.map((order) => order.styleRevisionId).filter((id): id is string => id !== null) } }, select: { id: true, revision: true } })).map((row) => [row.id, row.revision]))
  const recorded = await db.complianceDocumentBatch.findMany({ where: { shipmentId: shipment.id }, select: { documentId: true, batchNumber: true } })
  const issued = rows.filter((row) => row.status === 'ISSUED')
  const make = recordsToMake({
    shipmentId: shipment.id,
    batches: orders.map((order) => ({ workOrderId: order.id, batchNumber: order.batchNumber, styleId: order.styleId, frozenRevision: order.styleRevisionId ? (revisions.get(order.styleRevisionId) ?? null) : null })),
    documents: rows.map((row) => ({ documentId: row.id, styleId: row.styleId, revision: row.revision })),
    recorded: new Set(recorded.map((row) => `${row.documentId}|${row.batchNumber}`)),
  })
  const orderOf = new Map(orders.map((order) => [order.id, order]))
  const toMake: NewRecord[] = []
  const skipped: Travelled['skipped'] = []
  for (const entry of make) {
    const document = rows.find((row) => row.id === entry.documentId)!
    if (!issued.includes(document)) {
      skipped.push({ batchNumber: entry.batchNumber, documentId: entry.documentId, message: `The document of batch ${entry.batchNumber} is ${document.status}: the database records a batch only with an issued document.` })
      continue
    }
    const order = orderOf.get(entry.workOrderId)!
    toMake.push({ companyId: order.companyId, styleId: order.styleId, documentId: entry.documentId, siteId: order.siteId, workOrderId: order.id, batchNumber: entry.batchNumber, shipmentId: shipment.id, note: null })
  }
  return { toMake, skipped }
}

/** POST /compliance/declarations/shipments/:shipmentId/versions: record what travelled with the shipment. */
export async function recordShipmentVersions(caller: CommandCaller, shipmentId: string, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const shipment = await caller.withClient((db) => visibleShipment(db, context, shipmentId))
  assertMayWriteDocument(context, DECLARATIONS_RECORD, shipment.companyId)
  if (shipment.status === 'CANCELLED') throw refused('invalid_state', { code: 'SHIPMENT_CANCELLED', message: `Shipment ${shipment.number} is cancelled.` })
  const { toMake, skipped } = await caller.withClient((db) => travelledRecords(db, shipment))
  let ids: string[] = []
  if (toMake.length > 0) {
    const { result } = await declarationsCommand(
      caller,
      { name: 'compliance.declarations.recordShipment', idempotencyKey, input: { shipmentId } },
      async (tools) => {
        await lockShipmentRecords(tools, shipment.id)
        // Read again under the lock: a pack or another call may have recorded them meanwhile.
        const again = await travelledRecords(tools.tx, shipment)
        return insertRecords(tools, again.toMake, shipment.id)
      },
    )
    ids = result
  }
  const rows = ids.length > 0 ? await caller.withClient((db) => db.complianceDocumentBatch.findMany({ where: { id: { in: ids } }, select: RECORD_SELECT })) : []
  return { recorded: await caller.withClient((db) => recordViews(db, rows)), skipped }
}

export async function lockShipmentRecords(tools: Pick<CommandTools, 'tx' | 'context'>, shipmentId: string): Promise<void> {
  const tenantId = (tools.context as OfficeContext).tenantId
  await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.declaration-batches', ${tenantId}::uuid, ${shipmentId}::uuid), 0))`
}

/** GET /compliance/declarations/batches/unrecorded */
export async function unrecordedBatches(caller: CommandCaller) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => ({ unrecorded: await unrecordedPairs(db, context), asOf: toUtcIso(new Date()) }))
}

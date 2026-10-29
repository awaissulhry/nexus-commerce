import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { CommandTx } from '../../../core/command'

/**
 * The final inspection's reads and locks (B-W1-45; factory-db quality.prisma Inspection, InspectionDefect, QualityRelease,
 * QualityReleaseReversal, GarmentSerial, QualitySettings; production.prisma CutLog, Bundle, OperationScan, GarmentLabelPrint;
 * inventory.prisma StockMove, Lot; shipping.prisma ShipmentLine, Shipment). Every read names its columns and selects no
 * relation (inside a command's transaction the queries run one after another on its one connection) and runs as the
 * caller: row-level security keeps a floor device to its own site.
 */

export type Reader = FactoryClient | CommandTx

export const INSPECTION_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  workOrderId: true,
  number: true,
  lotSize: true,
  sampleSize: true,
  inspectionLevel: true,
  aqlMajor: true,
  aqlMinor: true,
  acceptMajor: true,
  acceptMinor: true,
  checklist: true,
  status: true,
  inspectorWorkerId: true,
  inspectorUserId: true,
  notMakerStatement: true,
  decidedAt: true,
  signatureSha256: true,
  computedResult: true,
  overrideReason: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.InspectionSelect
export type InspectionRow = Prisma.InspectionGetPayload<{ select: typeof INSPECTION_COLUMNS }>

export const DEFECT_COLUMNS = { id: true, inspectionId: true, defectClass: true, code: true, description: true, quantity: true, workOrderSizeId: true, note: true } as const satisfies Prisma.InspectionDefectSelect
export type DefectRow = Prisma.InspectionDefectGetPayload<{ select: typeof DEFECT_COLUMNS }>

export const RELEASE_COLUMNS = {
  id: true,
  number: true,
  companyId: true,
  siteId: true,
  workOrderId: true,
  workOrderSizeId: true,
  inspectionId: true,
  quantity: true,
  certificateIds: true,
  releasedById: true,
  releasedByWorkerId: true,
  releasedAt: true,
  signatureSha256: true,
  secondPersonReasons: true,
  note: true,
} as const satisfies Prisma.QualityReleaseSelect
export type ReleaseRow = Prisma.QualityReleaseGetPayload<{ select: typeof RELEASE_COLUMNS }>

export const REVERSAL_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  workOrderId: true,
  workOrderSizeId: true,
  releaseId: true,
  quantity: true,
  serialIds: true,
  serialsTo: true,
  reasonCode: true,
  reason: true,
  reversedById: true,
  reversedAt: true,
} as const satisfies Prisma.QualityReleaseReversalSelect
export type ReversalRow = Prisma.QualityReleaseReversalGetPayload<{ select: typeof REVERSAL_COLUMNS }>

export async function readInspection(db: Reader, inspectionId: string): Promise<InspectionRow | null> {
  return isUuid(inspectionId) ? db.inspection.findUnique({ where: { id: inspectionId }, select: INSPECTION_COLUMNS }) : null
}

/** A work order's inspections, oldest first (their place in this order labels one without a number: "WO-0003 · inspection 2"). */
export async function readWorkOrderInspections(db: Reader, workOrderId: string): Promise<InspectionRow[]> {
  return db.inspection.findMany({ where: { workOrderId }, select: INSPECTION_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
}

export async function readDefects(db: Reader, inspectionIds: readonly string[]): Promise<DefectRow[]> {
  if (inspectionIds.length === 0) return []
  return db.inspectionDefect.findMany({ where: { inspectionId: { in: [...inspectionIds] } }, select: DEFECT_COLUMNS, orderBy: [{ defectClass: 'asc' }, { code: 'asc' }] })
}

export async function readRelease(db: Reader, releaseId: string): Promise<ReleaseRow | null> {
  return isUuid(releaseId) ? db.qualityRelease.findUnique({ where: { id: releaseId }, select: RELEASE_COLUMNS }) : null
}

export async function readReleases(db: Reader, where: Prisma.QualityReleaseWhereInput, take = 500): Promise<ReleaseRow[]> {
  return db.qualityRelease.findMany({ where, select: RELEASE_COLUMNS, orderBy: [{ releasedAt: 'desc' }, { id: 'desc' }], take })
}

export async function readReversals(db: Reader, where: Prisma.QualityReleaseReversalWhereInput): Promise<ReversalRow[]> {
  return db.qualityReleaseReversal.findMany({ where, select: REVERSAL_COLUMNS, orderBy: [{ reversedAt: 'asc' }, { id: 'asc' }] })
}

// ---- who made the garments (four eyes) --------------------------------------------------------------------------------------

export interface Makers {
  /** Workers named by a cut log (not a reversal), a REPORT or CORRECTION scan, or a bundle made on a device. */
  readonly workerIds: ReadonlySet<string>
  /** Office users who made a bundle in the office. */
  readonly userIds: ReadonlySet<string>
  /** A cut log, scan or device bundle names nobody (the site records the station, MES-278): the records cannot tell. */
  readonly unnamed: boolean
}

/** The makers of a work order's garments, from the floor's records (the database's factory_quality_worker_made). */
export async function makersOf(db: Reader, workOrderId: string): Promise<Makers> {
  const cuts = await db.cutLog.findMany({ where: { workOrderId, reversalOfId: null }, select: { workerId: true } })
  const scans = await db.operationScan.findMany({ where: { workOrderId, kind: { in: ['REPORT', 'CORRECTION'] } }, select: { workerId: true } })
  const bundles = await db.bundle.findMany({ where: { workOrderId, status: { not: 'VOID' } }, select: { createdById: true, deviceId: true } })
  const workerIds = new Set<string>()
  const userIds = new Set<string>()
  let unnamed = false
  for (const row of [...cuts, ...scans]) {
    if (row.workerId) workerIds.add(row.workerId)
    else unnamed = true
  }
  for (const bundle of bundles) {
    if (bundle.deviceId === null) {
      if (bundle.createdById) userIds.add(bundle.createdById)
    } else if (bundle.createdById) workerIds.add(bundle.createdById)
    else unnamed = true
  }
  return { workerIds, userIds, unnamed }
}

/** The workers linked to an office user (Worker.userId: the office reads it, the floor may not). */
export async function linkedWorkers(db: Reader, userId: string): Promise<string[]> {
  return (await db.worker.findMany({ where: { userId }, select: { id: true } })).map((row) => row.id)
}

/** The office user a worker is linked to, or null (office or system reads only). */
export async function userOfWorker(db: Reader, workerId: string): Promise<string | null> {
  return (await db.worker.findUnique({ where: { id: workerId }, select: { userId: true } }))?.userId ?? null
}

// ---- what the release gate reads -----------------------------------------------------------------------------------------------

/** Per cell: garments released, reversed (0 for none). */
export async function releasedPerCell(db: Reader, cellIds: readonly string[]): Promise<Map<string, { released: number; reversed: number }>> {
  const ids = [...new Set(cellIds)]
  if (ids.length === 0) return new Map()
  const released = await db.qualityRelease.groupBy({ by: ['workOrderSizeId'], where: { workOrderSizeId: { in: ids } }, _sum: { quantity: true } })
  const reversed = await db.qualityReleaseReversal.groupBy({ by: ['workOrderSizeId'], where: { workOrderSizeId: { in: ids } }, _sum: { quantity: true } })
  const r = new Map(released.map((row) => [row.workOrderSizeId, row._sum.quantity ?? 0]))
  const v = new Map(reversed.map((row) => [row.workOrderSizeId, row._sum.quantity ?? 0]))
  return new Map(ids.map((id) => [id, { released: r.get(id) ?? 0, reversed: v.get(id) ?? 0 }]))
}

/** The garments an inspection released (reversed ones too: the lot's cap). */
export async function releasedFrom(db: Reader, inspectionId: string): Promise<number> {
  return (await db.qualityRelease.aggregate({ where: { inspectionId }, _sum: { quantity: true } }))._sum.quantity ?? 0
}

/** A cell's garment labels: BATCH printed (PRINT entries), the serials a PRINT entry named (SERIAL). */
export async function labelsOfCell(db: Reader, cellId: string): Promise<{ printed: number; serialIds: Set<string> }> {
  const rows = await db.garmentLabelPrint.findMany({ where: { workOrderSizeId: cellId, kind: 'PRINT' }, select: { quantity: true, serialIds: true } })
  return { printed: rows.reduce((sum, row) => sum + row.quantity, 0), serialIds: new Set(rows.flatMap((row) => row.serialIds ?? [])) }
}

/** A cell's garments on shipments by the shipment's state: DRAFT, PACKED, gone (SHIPPED, DELIVERED, RETURNED); CANCELLED apart. */
export async function shippedOfCell(db: Reader, cellId: string): Promise<{ onDraft: number; packed: number; shipped: number; shipmentIds: { draft: string[]; gone: string[] } }> {
  const lines = await db.shipmentLine.findMany({ where: { workOrderSizeId: cellId }, select: { shipmentId: true, quantity: true } })
  const shipments = lines.length
    ? new Map((await db.shipment.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.shipmentId))] } }, select: { id: true, status: true } })).map((row) => [row.id, row.status]))
    : new Map<string, string>()
  const out = { onDraft: 0, packed: 0, shipped: 0, shipmentIds: { draft: [] as string[], gone: [] as string[] } }
  for (const line of lines) {
    const status = shipments.get(line.shipmentId)
    if (status === 'DRAFT') {
      out.onDraft += line.quantity
      out.shipmentIds.draft.push(line.shipmentId)
    } else if (status === 'PACKED') {
      out.packed += line.quantity
      out.shipmentIds.draft.push(line.shipmentId)
    } else if (status === 'SHIPPED' || status === 'DELIVERED' || status === 'RETURNED') {
      out.shipped += line.quantity
      out.shipmentIds.gone.push(line.shipmentId)
    }
  }
  out.shipmentIds.draft = [...new Set(out.shipmentIds.draft)].sort()
  out.shipmentIds.gone = [...new Set(out.shipmentIds.gone)].sort()
  return out
}

export const LOT_COLUMNS = { id: true, code: true, itemId: true, companyId: true, siteId: true, qualityStatus: true, crViStatus: true, crViMgKg: true, crViLimitMgKg: true, crViEvidence: true, crViTestedAt: true, requiresCrViTest: true } as const satisfies Prisma.LotSelect
export type WorkOrderLot = Prisma.LotGetPayload<{ select: typeof LOT_COLUMNS }>

/**
 * The material lots in a work order's garments: every lot it took stock of (ISSUE moves no reversal cancelled; also when
 * all came back: a piece may have been cut from it, as the lab step's trace says) and the lots of the hides its cut log
 * names. Oldest code first.
 */
export async function lotsOfWorkOrder(db: Reader, workOrderId: string): Promise<WorkOrderLot[]> {
  const moves = await db.stockMove.findMany({ where: { workOrderId, reason: { in: ['ISSUE', 'RETURN'] } }, select: { id: true, reason: true, lotId: true, reversalOfId: true } })
  const reversed = new Set(moves.filter((move) => move.reversalOfId !== null).map((move) => move.reversalOfId!))
  const lotIds = new Set(moves.filter((move) => move.reason === 'ISSUE' && move.reversalOfId === null && !reversed.has(move.id) && move.lotId).map((move) => move.lotId!))
  for (const cut of await db.cutLog.findMany({ where: { workOrderId, reversalOfId: null }, select: { lotId: true } })) lotIds.add(cut.lotId)
  if (lotIds.size === 0) return []
  return db.lot.findMany({ where: { id: { in: [...lotIds] } }, select: LOT_COLUMNS, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
}

/** The company's quality settings row and the tenant-wide one (the four-eyes columns). */
export async function fourEyesRows(db: Reader, tenantId: string, companyId: string | null) {
  const rows = await db.qualitySettings.findMany({
    where: { id: { in: companyId === null ? [tenantId] : [companyId, tenantId] } },
    select: { id: true, companyId: true, releaseFourEyes: true, secondPersonPartyIds: true, crViEvidenceRule: true, version: true, updatedAt: true },
  })
  return { company: companyId === null ? null : (rows.find((row) => row.id === companyId) ?? null), tenant: rows.find((row) => row.id === tenantId) ?? null }
}

// ---- locks -----------------------------------------------------------------------------------------------------------------------

/**
 * The work order's release lock (the …_quality_shipping_guards triggers take it at a release's and a reversal's insert):
 * the API takes it FIRST, so two releases of one work order read the caps one after the other and answer in words.
 */
export async function lockRelease(tx: CommandTx, tenantId: string, workOrderId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.release', ${tenantId}::uuid, ${workOrderId}::uuid), 0))`
}

/** The serials named, locked FOR UPDATE in id order (a packer or a void of the same serial waits). */
export async function lockSerials(tx: CommandTx, serialIds: readonly string[]) {
  const ids = [...new Set(serialIds)].filter(isUuid).sort()
  if (ids.length === 0) return []
  await tx.$queryRaw`SELECT "id" FROM "GarmentSerial" WHERE "id" = ANY (${ids}::uuid[]) ORDER BY "id" FOR UPDATE`
  return tx.garmentSerial.findMany({ where: { id: { in: ids } }, select: { id: true, serial: true, status: true, workOrderSizeId: true, releaseId: true, shipmentLineId: true } })
}

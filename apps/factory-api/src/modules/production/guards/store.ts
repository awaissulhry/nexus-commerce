import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { ItemTracking } from '@nexus/factory-domain/product/materials/rules'
import { guardSettingsOf, type ComponentMaterial, type GuardSettings, type ScannedLot } from '@nexus/factory-domain/production/guards/rules'
import type { GarmentTracking } from '@nexus/factory-domain/production/serials/rules'
import type { WorkCentreKind } from '@nexus/factory-domain/product/routing/operations'
import type { CommandTx } from '../../../core/command'

/**
 * The checks' reads (B-W2b-46). Every read names its columns, selects no relation and runs as the caller (row-level
 * security keeps a floor device to its own site); inside the report's command they run on its one connection.
 *
 * The record of what the checks found is the audit log (no table of its own yet: a schema need of the step notes): on
 * the scan (recordType OperationScan) and on its work order (recordType WorkOrder, the work order's history index), with
 * these actions. A reader of the log filters on them.
 */

export type Reader = FactoryClient | CommandTx

/** A report counted although a WARN check found something: the team leader was told. */
export const FLAGGED_ACTION = 'production.scanGuardFlagged'
/** A team leader overrode the STRICT checks that held a report, with their PIN and a reason. */
export const OVERRIDDEN_ACTION = 'production.scanGuardOverridden'
/** The lots scanned at the operation for the garments that go on (MES-114). */
export const TRACED_ACTION = 'production.scanComponentsTraced'
/** A wrong team leader PIN, counted on the team leader's worker row. */
export const PIN_WRONG_ACTION = 'production.scanOverridePinWrong'

/** The site's floor checks (ProductionSettings, the site's own id), or the schema's defaults. */
export async function guardSettingsFor(db: Pick<Reader, 'productionSettings'>, siteId: string): Promise<GuardSettings> {
  const row = await db.productionSettings.findUnique({ where: { id: siteId }, select: { quantityGuard: true, skippedOperationRule: true } })
  return guardSettingsOf(row)
}

export interface LineRow {
  readonly id: string
  readonly code: string
}

/**
 * The lines MES-070 compares: the station's (with its code), the work order's allocation (WorkOrder.lineId), and
 * whether that line has an ACTIVE station of the operation's kind of work (else any line may do the operation).
 */
export async function lineFacts(db: Reader, input: { readonly stationId: string | null; readonly workOrderId: string; readonly kind: WorkCentreKind }) {
  const station = input.stationId ? await db.station.findUnique({ where: { id: input.stationId }, select: { code: true, lineId: true } }) : null
  const workOrder = await db.workOrder.findUnique({ where: { id: input.workOrderId }, select: { lineId: true } })
  const ids = [...new Set([station?.lineId, workOrder?.lineId].filter((value): value is string => !!value))]
  const lines = new Map(ids.length > 0 ? (await db.line.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } })).map((row) => [row.id, row]) : [])
  let lineHasKind = false
  if (workOrder?.lineId) {
    const stations = await db.station.findMany({ where: { lineId: workOrder.lineId, status: 'ACTIVE' }, select: { workCentreId: true } })
    const centres = stations.length > 0 ? await db.workCentre.findMany({ where: { id: { in: [...new Set(stations.map((row) => row.workCentreId))] } }, select: { kind: true } }) : []
    lineHasKind = centres.some((row) => row.kind === input.kind)
  }
  return {
    station: station ? { code: station.code, line: station.lineId ? (lines.get(station.lineId) ?? null) : null } : null,
    workOrder: workOrder?.lineId ? (lines.get(workOrder.lineId) ?? null) : null,
    lineHasKind,
  }
}

/** The style's garment tracking and the lot-relevant planned materials of the bundle's cell (WorkOrderMaterial → Item). */
export async function componentFacts(db: Reader, input: { readonly styleId: string; readonly workOrderId: string; readonly workOrderSizeId: string }): Promise<{ readonly garmentTracking: GarmentTracking; readonly materials: ComponentMaterial[] }> {
  const style = await db.style.findUnique({ where: { id: input.styleId }, select: { garmentTracking: true } })
  const planned = await db.workOrderMaterial.findMany({ where: { workOrderId: input.workOrderId, workOrderSizeId: input.workOrderSizeId }, select: { itemId: true } })
  const itemIds = [...new Set(planned.map((row) => row.itemId))]
  const items = itemIds.length > 0 ? await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true, kind: true, tracking: true, isPpeComponent: true }, orderBy: { code: 'asc' } }) : []
  return {
    garmentTracking: (style?.garmentTracking ?? 'BATCH') as GarmentTracking,
    materials: items.map((item) => ({ itemId: item.id, code: item.code, name: item.name, tracking: item.tracking as ItemTracking, ppe: item.isPpeComponent || item.kind === 'PROTECTOR' })),
  }
}

/** The lots the operator scanned, by their code (as typed or in capitals), at the work order's site (null: no such lot there). */
export async function scannedLots(db: Reader, siteId: string, scanned: readonly { readonly code: string; readonly garments: number }[]): Promise<ScannedLot[]> {
  const codes = [...new Set(scanned.flatMap((entry) => [entry.code.trim(), entry.code.trim().toUpperCase()]))]
  const lots = codes.length > 0 ? await db.lot.findMany({ where: { code: { in: codes, mode: 'insensitive' }, siteId }, select: { id: true, code: true, itemId: true, qualityStatus: true } }) : []
  const byCode = new Map(lots.map((lot) => [lot.code.toUpperCase(), lot]))
  return scanned.map((entry) => ({ code: entry.code, garments: entry.garments, lot: byCode.get(entry.code.trim().toUpperCase()) ?? null }))
}

// ---- the record (audit rows) ---------------------------------------------------------------------------------------------------------

export interface GuardAuditRow {
  readonly id: string
  readonly at: Date
  readonly action: string
  readonly recordId: string
  readonly siteId: string | null
  readonly companyId: string | null
  readonly after: Prisma.JsonValue
  readonly reason: string | null
}

const AUDIT_SELECT = { id: true, at: true, action: true, recordId: true, siteId: true, companyId: true, after: true, reason: true } as const

/** The checks' rows on scans of these sites in a time window (office reads), newest first. */
export async function guardRows(db: Reader, where: { readonly siteIds: readonly string[]; readonly from: Date; readonly to: Date; readonly actions: readonly string[] }, take: number): Promise<GuardAuditRow[]> {
  return db.auditLog.findMany({
    where: { recordType: 'OperationScan', action: { in: [...where.actions] }, siteId: { in: [...where.siteIds] }, at: { gte: where.from, lt: where.to } },
    select: AUDIT_SELECT,
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take,
  })
}

/** The checks' rows of one scan, oldest first. */
export async function guardRowsOfScan(db: Reader, scanId: string): Promise<GuardAuditRow[]> {
  if (!isUuid(scanId)) return []
  return db.auditLog.findMany({ where: { recordType: 'OperationScan', recordId: scanId, action: { in: [FLAGGED_ACTION, OVERRIDDEN_ACTION, TRACED_ACTION] } }, select: AUDIT_SELECT, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
}

/** The lots traced on a work order's scans (its history index), oldest first. */
export async function tracedOfWorkOrder(db: Reader, workOrderId: string): Promise<GuardAuditRow[]> {
  return db.auditLog.findMany({ where: { recordType: 'WorkOrder', recordId: workOrderId, action: TRACED_ACTION }, select: AUDIT_SELECT, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
}

/** Where a lot went: the traced rows (on work orders) that name it, oldest first. */
export async function tracedOfLot(db: Reader, lotId: string): Promise<GuardAuditRow[]> {
  return db.auditLog.findMany({
    where: { recordType: 'WorkOrder', action: TRACED_ACTION, after: { path: ['lotIds'], array_contains: [lotId] } },
    select: AUDIT_SELECT,
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
  })
}

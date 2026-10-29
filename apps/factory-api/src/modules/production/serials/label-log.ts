import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import type { GarmentTracking, LabelLogKind } from '@nexus/factory-domain/production/serials/rules'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { systemContext } from '../../../platform/outbox/system'
import type { Reader } from './store'

/**
 * The garment label log (PRD-348: every print and reprint of a garment label, with its reason) — ONE seam, on audit rows
 * until its table lands.
 *
 * INTERIM (lead's decision 2026-10-29): the table `GarmentLabelPrint` (@append-only; tenant, site, work order, cell,
 * kind PRINT | REPRINT, tracking, quantity, batch number, serials, reason (REPRINT: required), printer, device, worker;
 * floor select/insert at its own site) and `GarmentSerial.bundleId` come in this step's schema round. Until then an
 * entry is ONE audit row of the cell (recordType WorkOrderSize, action `production.garmentLabels.print|reprint`, `after`
 * = the entry, `reason`), written inside the printing command, so the entry commits with what it records or not at all.
 * The floor role may not read AuditLog: a floor read goes through the tenant's system context (`readLabelLog` with the
 * request as caller). Inside a floor command the read runs on another connection AFTER the cells' label locks, so it sees
 * every entry a command that held them before committed (the lock is released only at that commit). When the table
 * lands, only this file changes: `recordLabelLog` inserts the row, `readLabelLog` reads it in the caller's scope.
 */

export const LABEL_LOG_ACTIONS: Readonly<Record<LabelLogKind, string>> = Object.freeze({ PRINT: 'production.garmentLabels.print', REPRINT: 'production.garmentLabels.reprint' })

export interface LabelLogSerial {
  readonly id: string
  readonly serial: string
  /** The bundle its garment came in (genealogy, MES-076); null: not known. */
  readonly bundleId: string | null
}

export interface LabelLogDraft {
  readonly id: string
  readonly kind: LabelLogKind
  readonly tracking: GarmentTracking
  readonly companyId: string
  readonly siteId: string
  readonly workOrderId: string
  readonly cellId: string
  readonly quantity: number
  readonly batchNumber: string | null
  /** SERIAL: the serials printed (given, or printed again). */
  readonly serials: readonly LabelLogSerial[]
  readonly printerId: string
  /** REPRINT: why (required). */
  readonly reason: string | null
}

export interface LabelLogEntry extends Omit<LabelLogDraft, 'companyId' | 'siteId'> {
  readonly at: Date
  readonly postedBy: 'FLOOR' | 'OFFICE' | 'SYSTEM'
  readonly deviceId: string | null
}

/** Records one entry inside the printing command (its audit row). */
export function recordLabelLog(tools: CommandTools, draft: LabelLogDraft): void {
  tools.audit({
    action: LABEL_LOG_ACTIONS[draft.kind],
    recordType: 'WorkOrderSize',
    recordId: draft.cellId,
    companyId: draft.companyId,
    siteId: draft.siteId,
    after: {
      entryId: draft.id,
      kind: draft.kind,
      tracking: draft.tracking,
      workOrderId: draft.workOrderId,
      quantity: draft.quantity,
      batchNumber: draft.batchNumber,
      serials: draft.serials.map((serial) => ({ id: serial.id, serial: serial.serial, bundleId: serial.bundleId })),
      printerId: draft.printerId,
    },
    ...(draft.reason ? { reason: draft.reason } : {}),
  })
}

const asRecord = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function entryOf(row: { action: string; recordId: string; after: unknown; reason: string | null; at: Date; audience: string; deviceId: string | null }): LabelLogEntry | null {
  const after = asRecord(row.after)
  const kind: LabelLogKind | null = row.action === LABEL_LOG_ACTIONS.PRINT ? 'PRINT' : row.action === LABEL_LOG_ACTIONS.REPRINT ? 'REPRINT' : null
  const quantity = after.quantity
  if (kind === null || typeof quantity !== 'number' || !Number.isSafeInteger(quantity)) return null
  const serials = Array.isArray(after.serials)
    ? after.serials.map(asRecord).flatMap((serial) => (text(serial.id) && text(serial.serial) ? [{ id: text(serial.id)!, serial: text(serial.serial)!, bundleId: text(serial.bundleId) }] : []))
    : []
  return {
    id: text(after.entryId) ?? row.recordId,
    kind,
    tracking: after.tracking === 'SERIAL' ? 'SERIAL' : 'BATCH',
    workOrderId: text(after.workOrderId) ?? '',
    cellId: row.recordId,
    quantity,
    batchNumber: text(after.batchNumber),
    serials,
    printerId: text(after.printerId) ?? '',
    reason: row.reason,
    at: row.at,
    postedBy: row.audience === 'FLOOR' ? 'FLOOR' : row.audience === 'OFFICE' ? 'OFFICE' : 'SYSTEM',
    deviceId: row.deviceId,
  }
}

async function readRows(db: Reader, cellIds: readonly string[]): Promise<LabelLogEntry[]> {
  if (cellIds.length === 0) return []
  const rows = await db.auditLog.findMany({
    where: { recordType: 'WorkOrderSize', recordId: { in: [...new Set(cellIds)] }, action: { in: Object.values(LABEL_LOG_ACTIONS) } },
    select: { action: true, recordId: true, after: true, reason: true, at: true, audience: true, deviceId: true },
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
  })
  return rows.flatMap((row) => entryOf(row) ?? [])
}

/** The request in the tenant's system context (the office role, row-level security on the tenant): the floor's read. */
function asTenantSystem(caller: CommandCaller): CommandCaller {
  const context = caller.factoryContext
  if (!context || !('tenantId' in context) || !context.tenantId) throw new ForbiddenError()
  const view = Object.create(caller) as CommandCaller & { factoryContext: CommandCaller['factoryContext'] }
  view.factoryContext = systemContext(context.tenantId, context.requestId)
  return view
}

/**
 * The entries of these cells, oldest first. The office reads them with `db` (its request client or its command's
 * transaction); a floor caller's read goes through the tenant's system context (another connection: inside a floor
 * command, call it after the cells' label locks).
 */
export async function readLabelLog(caller: CommandCaller, cellIds: readonly string[], db?: Reader): Promise<LabelLogEntry[]> {
  const context = caller.factoryContext
  if (context?.audience === 'office' && db) return readRows(db, cellIds)
  if (context?.audience === 'office') return caller.withClient((client) => readRows(client, cellIds))
  return asTenantSystem(caller).withClient((client) => readRows(client, cellIds))
}

import type { GarmentTracking, LabelLogKind } from '@nexus/factory-domain/production/serials/rules'
import type { CommandTools } from '../../../core/command'
import type { Reader } from './store'

/**
 * The garment label log (PRD-348: every print and reprint of a garment label, with its reason): the append-only table
 * GarmentLabelPrint (production.prisma; its guards in …_production_garment_labels_guards). An entry is written inside the
 * command that gives the labels (after the serials it names), with its audit row, before any print job is queued; a
 * cell's PRINT entries are the labels its finished garments have. The floor reads and writes its own site's entries,
 * the office every site's (row-level security).
 */

export interface LabelLogDraft {
  readonly id: string
  readonly kind: LabelLogKind
  readonly tracking: GarmentTracking
  readonly companyId: string
  readonly siteId: string
  readonly workOrderId: string
  readonly cellId: string
  readonly quantity: number
  readonly batchNumber: string
  /** SERIAL: the serials printed (given, or printed again). */
  readonly serialIds: readonly string[]
  readonly printerId: string | null
  /** The floor device (null: the office). */
  readonly deviceId: string | null
  /** The office user, or the worker where the site names workers; null at a station site. */
  readonly createdById: string | null
  /** REPRINT: why (required). */
  readonly reason: string | null
}

export interface LabelLogEntry {
  readonly id: string
  readonly kind: LabelLogKind
  readonly tracking: GarmentTracking
  readonly workOrderId: string
  readonly cellId: string
  readonly quantity: number
  readonly batchNumber: string
  readonly serialIds: readonly string[]
  readonly reason: string | null
  readonly printerId: string | null
  readonly deviceId: string | null
  readonly at: Date
  /** FLOOR (printed from a device) or OFFICE: never who. */
  readonly postedBy: 'FLOOR' | 'OFFICE'
}

/** Records one entry inside the printing command, with its audit row. */
export async function recordLabelLog(tools: CommandTools, draft: LabelLogDraft): Promise<void> {
  await tools.tx.garmentLabelPrint.create({
    data: {
      id: draft.id,
      companyId: draft.companyId,
      siteId: draft.siteId,
      workOrderId: draft.workOrderId,
      workOrderSizeId: draft.cellId,
      kind: draft.kind,
      tracking: draft.tracking,
      quantity: draft.quantity,
      batchNumber: draft.batchNumber,
      serialIds: [...draft.serialIds],
      reason: draft.reason,
      printerId: draft.printerId,
      deviceId: draft.deviceId,
      createdAt: tools.now,
      createdById: draft.createdById,
    },
    select: { id: true },
  })
  tools.audit({
    recordType: 'GarmentLabelPrint',
    recordId: draft.id,
    companyId: draft.companyId,
    siteId: draft.siteId,
    after: { kind: draft.kind, tracking: draft.tracking, workOrderId: draft.workOrderId, workOrderSizeId: draft.cellId, quantity: draft.quantity, batchNumber: draft.batchNumber, serialIds: [...draft.serialIds], printerId: draft.printerId },
    ...(draft.reason ? { reason: draft.reason } : {}),
  })
}

/** The work order's entries the reader may see, oldest first (inside a command: after the cells' label locks). */
export async function readLabelLog(db: Reader, workOrderId: string): Promise<LabelLogEntry[]> {
  const rows = await db.garmentLabelPrint.findMany({
    where: { workOrderId },
    select: { id: true, kind: true, tracking: true, workOrderId: true, workOrderSizeId: true, quantity: true, batchNumber: true, serialIds: true, reason: true, printerId: true, deviceId: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    tracking: row.tracking,
    workOrderId: row.workOrderId,
    cellId: row.workOrderSizeId,
    quantity: row.quantity,
    batchNumber: row.batchNumber,
    serialIds: row.serialIds ?? [],
    reason: row.reason,
    printerId: row.printerId,
    deviceId: row.deviceId,
    at: row.createdAt,
    postedBy: row.deviceId ? 'FLOOR' : 'OFFICE',
  }))
}

// ---- B-W2b-259 (MES-140): labels of a print that did not end on a garment ------------------------------------------------

/**
 * Spoiled and returned labels (B-W2b-218's append-only GarmentLabelSpoil): rows of a print (its company, site and work
 * order), SPOILED with the reason in words or RETURNED. Written inside the command that logs them (compliance/label-artwork
 * reconciliation.ts), each with its audit row; the database keeps a print's spoiled + returned at most its quantity. The
 * floor reads and writes its own site's rows, the office every site's (row-level security).
 */
export interface LabelSpoilDraft {
  readonly id: string
  readonly companyId: string
  readonly siteId: string
  readonly workOrderId: string
  readonly printId: string
  readonly kind: 'SPOILED' | 'RETURNED'
  readonly quantity: number
  readonly reason: string | null
  /** The office user, or the worker where the site names workers; null at a station site. */
  readonly createdById: string | null
}

export interface LabelSpoilEntry {
  readonly id: string
  readonly printId: string
  readonly kind: 'SPOILED' | 'RETURNED'
  readonly quantity: number
  readonly reason: string | null
  readonly at: Date
}

/** Records one row inside the logging command, with its audit row (never who on the floor: the row's createdById says it where the site names workers). */
export async function recordLabelSpoil(tools: CommandTools, draft: LabelSpoilDraft): Promise<void> {
  await tools.tx.garmentLabelSpoil.create({
    data: {
      id: draft.id,
      companyId: draft.companyId,
      siteId: draft.siteId,
      workOrderId: draft.workOrderId,
      printId: draft.printId,
      kind: draft.kind,
      quantity: draft.quantity,
      reason: draft.reason,
      createdAt: tools.now,
      createdById: draft.createdById,
    },
    select: { id: true },
  })
  tools.audit({
    recordType: 'GarmentLabelSpoil',
    recordId: draft.id,
    companyId: draft.companyId,
    siteId: draft.siteId,
    after: { kind: draft.kind, workOrderId: draft.workOrderId, printId: draft.printId, quantity: draft.quantity },
    ...(draft.reason ? { reason: draft.reason } : {}),
  })
}

/** The work order's spoiled and returned labels the reader may see, oldest first. */
export async function readLabelSpoils(db: Reader, workOrderId: string): Promise<LabelSpoilEntry[]> {
  const rows = await db.garmentLabelSpoil.findMany({
    where: { workOrderId },
    select: { id: true, printId: true, kind: true, quantity: true, reason: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return rows.map((row) => ({ id: row.id, printId: row.printId, kind: row.kind, quantity: row.quantity, reason: row.reason, at: row.createdAt }))
}

import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { GarmentTracking } from '@nexus/factory-domain/production/serials/rules'
import type { CommandTx } from '../../../core/command'

/**
 * The garment labels' reads and locks (B-W1-44): a work order as the label step sees it (its frozen label template and
 * revision, its batch number and release day), its cells, its style's tracking, its serials, the site's label printers,
 * the cells' buyers' languages, and the advisory lock of a cell's labels. Every read names its columns, selects no
 * relation (inside a command's transaction the queries run one after another on its one connection) and runs as the
 * caller: row-level security keeps a floor device to its own site.
 */

export type Reader = FactoryClient | CommandTx

export const LABEL_HEADER = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  batchNumber: true,
  status: true,
  kind: true,
  styleId: true,
  styleRevisionId: true,
  labelTemplateId: true,
  releasedAt: true,
} as const satisfies Prisma.WorkOrderSelect
export type LabelHeader = Prisma.WorkOrderGetPayload<{ select: typeof LABEL_HEADER }>

export async function readHeader(db: Reader, workOrderId: string): Promise<LabelHeader | null> {
  if (!isUuid(workOrderId)) return null
  return db.workOrder.findUnique({ where: { id: workOrderId }, select: LABEL_HEADER })
}

export interface StyleFacts {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly tracking: GarmentTracking
}

/** The work order's style and how its garments are traced (Q31: Style.garmentTracking). */
export async function readStyle(db: Reader, styleId: string): Promise<StyleFacts | null> {
  const row = await db.style.findUnique({ where: { id: styleId }, select: { id: true, code: true, name: true, garmentTracking: true } })
  return row ? { id: row.id, code: row.code, name: row.name, tracking: row.garmentTracking as GarmentTracking } : null
}

export interface CellRow {
  readonly id: string
  readonly colourwayId: string
  readonly colourwayCode: string
  readonly colourwayName: string
  readonly size: string
  readonly quantity: number
  /** The order line's party (the buyer whose market the label's languages serve). */
  readonly partyId: string
}

/** The work order's cells with their colourway, by colourway code and size. */
export async function readCells(db: Reader, workOrderId: string): Promise<CellRow[]> {
  const cells = await db.workOrderSize.findMany({ where: { workOrderId }, select: { id: true, colourwayId: true, size: true, quantity: true, partyId: true } })
  const colourways = new Map(
    (await db.colourway.findMany({ where: { id: { in: [...new Set(cells.map((cell) => cell.colourwayId))] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]),
  )
  return cells
    .map((cell) => ({ ...cell, colourwayCode: colourways.get(cell.colourwayId)?.code ?? '', colourwayName: colourways.get(cell.colourwayId)?.name ?? '' }))
    .sort((a, b) => a.colourwayCode.localeCompare(b.colourwayCode) || a.size.localeCompare(b.size, undefined, { numeric: true }) || a.id.localeCompare(b.id))
}

export const SERIAL_COLUMNS = {
  id: true,
  siteId: true,
  workOrderId: true,
  workOrderSizeId: true,
  serial: true,
  status: true,
  releaseId: true,
  shipmentLineId: true,
  bundleId: true,
  voidedAt: true,
  voidReason: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.GarmentSerialSelect
export type SerialRow = Prisma.GarmentSerialGetPayload<{ select: typeof SERIAL_COLUMNS }>

/** The work order's serials, oldest first. */
export async function readSerials(db: Reader, workOrderId: string): Promise<SerialRow[]> {
  return db.garmentSerial.findMany({ where: { workOrderId }, select: SERIAL_COLUMNS, orderBy: [{ createdAt: 'asc' }, { serial: 'asc' }] })
}

export async function readSerial(db: Reader, serialId: string): Promise<SerialRow | null> {
  if (!isUuid(serialId)) return null
  return db.garmentSerial.findUnique({ where: { id: serialId }, select: SERIAL_COLUMNS })
}

export async function readSerialByText(db: Reader, serial: string): Promise<SerialRow | null> {
  return db.garmentSerial.findFirst({ where: { serial }, select: SERIAL_COLUMNS })
}

/** Live (not VOID) serials per cell. */
export async function liveSerialsPerCell(db: Reader, workOrderId: string): Promise<Map<string, number>> {
  const rows = await db.garmentSerial.groupBy({ by: ['workOrderSizeId'], where: { workOrderId, status: { not: 'VOID' } }, _count: { _all: true } })
  return new Map(rows.map((row) => [row.workOrderSizeId, row._count._all]))
}

/**
 * The serial row locked FOR UPDATE inside a reprint's or void's command, before its state is read: a void and a
 * reprint of one serial take turns (and a release, packing or reversal that updates it waits, or is waited for).
 */
export async function lockSerial(tx: CommandTx, serialId: string): Promise<SerialRow | null> {
  if (!isUuid(serialId)) return null
  await tx.$queryRaw`SELECT "id" FROM "GarmentSerial" WHERE "id" = ${serialId}::uuid FOR UPDATE`
  return readSerial(tx, serialId)
}

/** The ACTIVE label printers of a site (the floor reads no relay target). */
export async function readLabelPrinters(db: Reader, siteId: string) {
  return db.printer.findMany({
    where: { siteId, kind: 'LABEL_ZPL', status: 'ACTIVE' },
    select: { id: true, companyId: true, siteId: true, code: true, name: true, dpi: true, labelWidthMm: true, labelHeightMm: true },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
  })
}
export type LabelPrinterRow = Awaited<ReturnType<typeof readLabelPrinters>>[number]

/** The label template's size (millimetres, two decimals), for the printer's stock. */
export async function readTemplateSize(db: Reader, templateId: string): Promise<{ readonly code: string; readonly revision: number; readonly widthMm: string; readonly heightMm: string; readonly status: string } | null> {
  const row = await db.labelTemplate.findUnique({ where: { id: templateId }, select: { code: true, revision: true, widthMm: true, heightMm: true, status: true } })
  return row ? { code: row.code, revision: row.revision, widthMm: row.widthMm.toFixed(2), heightMm: row.heightMm.toFixed(2), status: row.status } : null
}

/**
 * The languages the cells' buyers need on the label (Party.language of each order line's party): read in the office's
 * or the tenant's system scope (the floor role reads no party).
 */
export async function buyerLanguages(db: Reader, partyIds: readonly string[]): Promise<Map<string, string>> {
  if (partyIds.length === 0) return new Map()
  const rows = await db.party.findMany({ where: { id: { in: [...new Set(partyIds)] } }, select: { id: true, language: true } })
  return new Map(rows.map((row) => [row.id, row.language]))
}

/** The bundles a scanned ticket code names (its current code, or a replaced one): its work order and cell. */
export async function readBundleByCode(db: Reader, code: string) {
  const select = { id: true, code: true, workOrderId: true, workOrderSizeId: true, status: true } as const
  return (await db.bundle.findFirst({ where: { code }, select })) ?? db.bundle.findFirst({ where: { replacedCodes: { has: code } }, select })
}

/** Bundle codes by id (a serial's bundle). */
export async function bundleCodes(db: Reader, bundleIds: readonly string[]): Promise<Map<string, string>> {
  if (bundleIds.length === 0) return new Map()
  const rows = await db.bundle.findMany({ where: { id: { in: [...new Set(bundleIds)] } }, select: { id: true, code: true } })
  return new Map(rows.map((row) => [row.id, row.code]))
}

/** The print jobs of these records' garment labels (cells for a batch, serials), newest first. */
export async function readLabelJobs(db: Reader, recordIds: readonly string[]) {
  if (recordIds.length === 0) return []
  return db.printJob.findMany({
    where: { labelKind: 'GARMENT', recordType: { in: ['WorkOrderSize', 'GarmentSerial'] }, recordId: { in: [...recordIds] } },
    select: { id: true, recordType: true, recordId: true, printerId: true, scanId: true, copies: true, status: true, lastError: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
}

// ---- locks ---------------------------------------------------------------------------------------------------------------------

/**
 * The cells' label locks, in id order: one request at a time reads a cell's labels (serials, label log) and prints new
 * ones, so two tablets never label the same finished garments twice. Taken after the work order's issue lock in SHARED
 * mode (scans' scanWorkOrderLock: a complete, close or cancel of the work order waits for the labels in flight). The
 * GarmentSerial trigger takes its own `factory.serial-cell` lock per cell at the insert, after this one.
 */
export async function lockLabelCells(tx: CommandTx, tenantId: string, siteId: string, cellIds: readonly string[]): Promise<void> {
  for (const cellId of [...new Set(cellIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.garment-label-cell', ${tenantId}::uuid, ${siteId}::uuid, ${cellId}::uuid), 0))`
  }
}

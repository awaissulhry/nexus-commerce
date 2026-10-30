import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandTx } from '../../../core/command'

/**
 * The rework loop's reads and locks (B-W2a-13; MES-126): a rework order, its row lock, the tenant's REWORK reasons, the
 * facts of a scan whose rework count opens one, and the rows a rework's view names (work order, cell, bundle,
 * operations). Every read names its columns, selects no relation and runs as the caller (a floor device: its own
 * site, by row-level security).
 */

export type Reader = FactoryClient | CommandTx

export const REWORK_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  workOrderId: true,
  workOrderSizeId: true,
  bundleId: true,
  sourceScanId: true,
  foundAtOperationId: true,
  reworkAtOperationId: true,
  quantity: true,
  reasonCode: true,
  description: true,
  recordType: true,
  recordId: true,
  status: true,
  goodQuantity: true,
  scrapQuantity: true,
  startedAt: true,
  doneAt: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.ReworkOrderSelect
export type ReworkRow = Prisma.ReworkOrderGetPayload<{ select: typeof REWORK_COLUMNS }>

export async function readRework(db: Reader, reworkId: string): Promise<ReworkRow | null> {
  if (!isUuid(reworkId)) return null
  return db.reworkOrder.findUnique({ where: { id: reworkId }, select: REWORK_COLUMNS })
}

/** The rework row locked FOR UPDATE inside a move's command, then read again. */
export async function lockRework(tx: CommandTx, reworkId: string): Promise<ReworkRow | null> {
  if (!isUuid(reworkId)) return null
  await tx.$queryRaw`SELECT "id" FROM "ReworkOrder" WHERE "id" = ${reworkId}::uuid FOR UPDATE`
  return readRework(tx, reworkId)
}

/** The tenant's REWORK reasons (production ScrapReason), active ones only unless asked. */
export async function readReworkReasons(db: Reader, all = false) {
  return db.scrapReason.findMany({ where: { kind: 'REWORK', ...(all ? {} : { active: true }) }, select: { code: true, labelIt: true, labelEn: true, active: true }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] })
}

/** A scan as a rework's source: its counts, bundle, operation, whether a later row voids it, and its REWORK lines. */
export async function readSourceScan(db: Reader, scanId: string) {
  if (!isUuid(scanId)) return null
  const scan = await db.operationScan.findUnique({
    where: { id: scanId },
    select: { id: true, workOrderId: true, bundleId: true, workOrderOperationId: true, kind: true, reworkQuantity: true, scrapQuantity: true, serverTime: true },
  })
  if (!scan) return null
  const voided = (await db.operationScan.count({ where: { correctsId: scan.id } })) > 0
  const lines = await db.operationScanDefect.findMany({ where: { scanId: scan.id, kind: 'REWORK' }, select: { reasonCode: true, quantity: true } })
  return { ...scan, voided, lines }
}

/** The reworks a scan's rework count opened (any status). */
export async function readReworksOfScan(db: Reader, scanId: string) {
  return db.reworkOrder.findMany({ where: { sourceScanId: scanId }, select: { id: true, sourceScanId: true, status: true, quantity: true } })
}

/** The work order as the rework reads it. */
export async function readOrder(db: Reader, workOrderId: string) {
  if (!isUuid(workOrderId)) return null
  return db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, companyId: true, siteId: true, number: true, status: true, holdReason: true, styleId: true } })
}
export type OrderRow = NonNullable<Awaited<ReturnType<typeof readOrder>>>

/** The work order's operations in routing order. */
export async function readOperations(db: Reader, workOrderId: string) {
  return db.workOrderOperation.findMany({ where: { workOrderId }, select: { id: true, seq: true, code: true, name: true, scanRequired: true }, orderBy: { seq: 'asc' } })
}

/** The bundle with its live garments (its quantity less its children that are not VOID). */
export async function readBundleLive(db: Reader, bundleId: string) {
  if (!isUuid(bundleId)) return null
  const bundle = await db.bundle.findUnique({ where: { id: bundleId }, select: { id: true, code: true, workOrderId: true, workOrderSizeId: true, part: true, quantity: true, status: true, parentBundleId: true } })
  if (!bundle) return null
  const children = await db.bundle.findMany({ where: { parentBundleId: bundle.id, status: { not: 'VOID' } }, select: { quantity: true } })
  return { ...bundle, live: bundle.quantity - children.reduce((sum, child) => sum + child.quantity, 0) }
}

// ---- views ----------------------------------------------------------------------------------------------------------------------

const at = (value: Date | null) => (value ? toUtcIso(value) : null)

/** The views of rework rows: work order, cell, bundle, operations, reason words, who opened it (office users only). */
export async function reworkViews(db: Reader, rows: readonly ReworkRow[], options: { readonly office: boolean }) {
  if (rows.length === 0) return []
  const unique = (values: readonly (string | null)[]) => [...new Set(values.filter((value): value is string => value !== null))]
  const orders = new Map((await db.workOrder.findMany({ where: { id: { in: unique(rows.map((row) => row.workOrderId)) } }, select: { id: true, number: true, status: true } })).map((row) => [row.id, row]))
  const cells = await db.workOrderSize.findMany({ where: { id: { in: unique(rows.map((row) => row.workOrderSizeId)) } }, select: { id: true, colourwayId: true, size: true } })
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: unique(cells.map((cell) => cell.colourwayId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const cellOf = new Map(cells.map((cell) => [cell.id, { id: cell.id, colourwayCode: colourways.get(cell.colourwayId) ?? '', size: cell.size }]))
  const bundles = new Map((await db.bundle.findMany({ where: { id: { in: unique(rows.map((row) => row.bundleId)) } }, select: { id: true, code: true, status: true, parentBundleId: true } })).map((row) => [row.id, row]))
  const operations = new Map(
    (await db.workOrderOperation.findMany({ where: { id: { in: unique(rows.flatMap((row) => [row.foundAtOperationId, row.reworkAtOperationId])) } }, select: { id: true, seq: true, code: true, name: true } })).map((row) => [row.id, row]),
  )
  const reasons = new Map((await readReworkReasons(db, true)).map((row) => [row.code, row]))
  // The office reads who opened it and the replacements; the floor reads neither (no grant, and no names on the floor).
  const users = new Map((options.office ? await db.user.findMany({ where: { id: { in: unique(rows.map((row) => row.createdById)) } }, select: { id: true, displayName: true } }) : []).map((row) => [row.id, row]))
  const replacements = options.office
    ? await db.replacementRequest.findMany({ where: { reworkOrderId: { in: rows.map((row) => row.id) } }, select: { id: true, reworkOrderId: true, kind: true, status: true, quantity: true } })
    : []
  const operation = (id: string | null) => (id && operations.has(id) ? { id, seq: operations.get(id)!.seq, code: operations.get(id)!.code, name: operations.get(id)!.name } : null)
  return rows.map((row) => {
    const order = orders.get(row.workOrderId)
    const reason = reasons.get(row.reasonCode)
    const bundle = row.bundleId ? bundles.get(row.bundleId) : undefined
    const user = row.createdById ? users.get(row.createdById) : undefined
    return {
      id: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      workOrder: { id: row.workOrderId, number: order?.number ?? '', status: order?.status ?? 'RELEASED' },
      cell: cellOf.get(row.workOrderSizeId) ?? { id: row.workOrderSizeId, colourwayCode: '', size: '' },
      bundle: bundle ? { id: bundle.id, code: bundle.code, status: bundle.status, parentBundleId: bundle.parentBundleId } : null,
      sourceScanId: row.sourceScanId,
      foundAt: operation(row.foundAtOperationId),
      reworkAt: operation(row.reworkAtOperationId)!,
      quantity: row.quantity,
      reasonCode: row.reasonCode,
      reasonLabel: reason ? { it: reason.labelIt, en: reason.labelEn } : null,
      description: row.description,
      record: row.recordType && row.recordId ? { type: row.recordType, id: row.recordId } : null,
      status: row.status,
      goodQuantity: row.goodQuantity,
      scrapQuantity: row.scrapQuantity,
      startedAt: at(row.startedAt),
      doneAt: at(row.doneAt),
      cancelledAt: at(row.cancelledAt),
      cancelReason: row.cancelReason,
      note: row.note,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
      // An office user who opened it (a floor rework names nobody: Statuto dei Lavoratori art. 4).
      createdBy: user ? { id: user.id, name: user.displayName } : null,
      replacements: options.office ? replacements.filter((request) => request.reworkOrderId === row.id).map((request) => ({ id: request.id, kind: request.kind, status: request.status, quantity: request.quantity })) : null,
    }
  })
}
export type ReworkView = Awaited<ReturnType<typeof reworkViews>>[number]

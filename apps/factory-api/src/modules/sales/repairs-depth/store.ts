import type { Prisma } from '@nexus/factory-db'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { estimateTotals, newestOf, type EstimateStatus } from '@nexus/factory-domain/sales/repairs-depth/rules'
import type { Reader } from '../repairs/store'

/**
 * The reads of repairs in depth (B-W2b-342): a repair's estimates with their lines, the newest one the stage rule reads,
 * the repair's damage photos, and the customer's views. Every read names its columns and runs on the client it is given
 * (a command's transaction or a scoped client). Money leaves here marked with its grain (prices `price`, costs `cost`):
 * the serializer drops a field for a caller without it.
 */

export { REPAIR_RECORD, type Reader } from '../repairs/store'

export const ESTIMATE_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  partyId: true,
  repairId: true,
  revision: true,
  status: true,
  currency: true,
  validUntil: true,
  customerNote: true,
  internalNote: true,
  sentAt: true,
  sentById: true,
  answeredAt: true,
  answeredVia: true,
  answeredByName: true,
  recordedById: true,
  declineReason: true,
  withdrawnAt: true,
  withdrawnById: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.RepairEstimateSelect

export type EstimateRow = Prisma.RepairEstimateGetPayload<{ select: typeof ESTIMATE_COLUMNS }>

export const LINE_COLUMNS = {
  id: true,
  seq: true,
  kind: true,
  itemId: true,
  description: true,
  quantity: true,
  minutes: true,
  unitPrice: true,
  amount: true,
  unitCost: true,
  costAmount: true,
  version: true,
} as const satisfies Prisma.RepairEstimateLineSelect

export type LineRow = Prisma.RepairEstimateLineGetPayload<{ select: typeof LINE_COLUMNS }>

export const dayOrNull = (value: Date | null): BusinessDate | null => (value ? value.toISOString().slice(0, 10) : null)
export const isoOrNull = (value: Date | null): string | null => (value ? toUtcIso(value) : null)
/** A Decimal column as the plain decimal string contracts carry (no trailing zeros lost: Prisma's own text). */
export const decimalText = (value: Prisma.Decimal | null): string | null => (value === null ? null : value.toFixed())

export async function estimatesOf(db: Reader, repairId: string): Promise<EstimateRow[]> {
  return db.repairEstimate.findMany({ where: { repairId }, select: ESTIMATE_COLUMNS, orderBy: [{ revision: 'desc' }] })
}

export async function linesOf(db: Reader, estimateIds: readonly string[]): Promise<Map<string, LineRow[]>> {
  const map = new Map<string, LineRow[]>()
  if (estimateIds.length === 0) return map
  const rows = await db.repairEstimateLine.findMany({ where: { estimateId: { in: [...estimateIds] } }, select: { ...LINE_COLUMNS, estimateId: true }, orderBy: [{ estimateId: 'asc' }, { seq: 'asc' }] })
  for (const { estimateId, ...row } of rows) map.set(estimateId, [...(map.get(estimateId) ?? []), row])
  return map
}

/** The newest estimate of a repair that is not withdrawn (the "approved before work starts" rule reads it), or null. */
export async function newestEstimateOf(db: Reader, repairId: string): Promise<{ id: string; revision: number; status: EstimateStatus } | null> {
  const rows = await db.repairEstimate.findMany({ where: { repairId }, select: { id: true, revision: true, status: true } })
  return newestOf(rows.map((row) => ({ ...row, status: row.status as EstimateStatus })))
}

export const totalsOf = (lines: readonly LineRow[]) =>
  estimateTotals(lines.map((line) => ({ kind: line.kind, amount: line.amount, costAmount: line.costAmount, minutes: line.minutes, quantity: line.quantity.toFixed() })))

/** An estimate's lines and sums as the office sees them (prices and costs marked). */
export function officeLines(lines: readonly LineRow[], items: ReadonlyMap<string, { id: string; code: string; name: string }>) {
  return lines.map((line) => ({
    id: line.id,
    seq: line.seq,
    kind: line.kind,
    item: line.itemId ? (items.get(line.itemId) ?? null) : null,
    description: line.description,
    quantity: line.quantity.toFixed(),
    minutes: line.minutes,
    unitPrice: asMoney('price', line.unitPrice.toFixed()),
    amount: asMoney('price', line.amount),
    unitCost: asMoney('cost', decimalText(line.unitCost)),
    costAmount: asMoney('cost', line.costAmount),
    version: line.version,
  }))
}

export function sumsOf(lines: readonly LineRow[]) {
  const sums = totalsOf(lines)
  return {
    amount: asMoney('price', sums.amount),
    partsAmount: asMoney('price', sums.parts),
    labourAmount: asMoney('price', sums.labour),
    costAmount: asMoney('cost', sums.costAmount),
    labourMinutes: sums.labourMinutes,
    lines: sums.lines,
  }
}

/** The customer's lines: what they read and pay, never our cost. */
export function customerLines(lines: readonly LineRow[]) {
  return lines.map((line) => ({
    seq: line.seq,
    kind: line.kind,
    description: line.description,
    quantity: line.quantity.toFixed(),
    minutes: line.minutes,
    unitPrice: asMoney('price', line.unitPrice.toFixed()),
    amount: asMoney('price', line.amount),
  }))
}

export async function itemsOf(db: Reader, lines: readonly LineRow[]): Promise<Map<string, { id: string; code: string; name: string }>> {
  const ids = [...new Set(lines.flatMap((line) => (line.itemId ? [line.itemId] : [])))]
  if (ids.length === 0) return new Map()
  return new Map((await db.item.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
}

// ---- photos -----------------------------------------------------------------------------------------------------------

export const PHOTO_COLUMNS = { id: true, originalName: true, contentType: true, sizeBytes: true, status: true, visibility: true, partyId: true, createdAt: true } as const satisfies Prisma.StoredFileSelect
export type PhotoRow = Prisma.StoredFileGetPayload<{ select: typeof PHOTO_COLUMNS }>

/** The repair's damage photos (category DAMAGE_PHOTO), oldest first; deleted ones left out. */
export async function damagePhotosOf(db: Reader, repairId: string): Promise<PhotoRow[]> {
  return db.storedFile.findMany({ where: { recordType: 'RepairOrder', recordId: repairId, category: 'DAMAGE_PHOTO', status: { not: 'DELETED' } }, select: PHOTO_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
}

/** A photo the customer sent (shared with the party), or one the office took. */
export const fromCustomer = (row: Pick<PhotoRow, 'visibility'>): boolean => row.visibility.includes('PARTNER') || row.visibility.includes('LINK')

import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandTx } from '../../../core/command'

/**
 * The rows of portal order requests (B-W2b-190; factory-db portal-sales.prisma, B-W2b-157), as the partner role reads
 * them (decidedById is hidden from it: never selected here) and as the office reads them (+ decidedById).
 */

export const REQUEST_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  number: true,
  source: true,
  customerRef: true,
  shipToAddressId: true,
  requestedDate: true,
  note: true,
  currency: true,
  status: true,
  sentAt: true,
  sentById: true,
  decidedAt: true,
  refuseReason: true,
  salesOrderId: true,
  quoteId: true,
  withdrawnAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.PortalOrderRequestSelect

export const LINE_COLUMNS = {
  id: true,
  requestId: true,
  seq: true,
  styleId: true,
  colourwayId: true,
  sourceOrderLineId: true,
  unitPriceShown: true,
  note: true,
  version: true,
  sizes: { select: { id: true, size: true, quantity: true }, orderBy: { size: 'asc' } },
} as const satisfies Prisma.PortalOrderRequestLineSelect

export type RequestRow = Prisma.PortalOrderRequestGetPayload<{ select: typeof REQUEST_COLUMNS }>
export type LineRow = Prisma.PortalOrderRequestLineGetPayload<{ select: typeof LINE_COLUMNS }>
export type Reader = FactoryClient | CommandTx

/** An instant as the contracts send it (UTC, milliseconds), or null. */
export const iso = (value: Date | null): string | null => (value === null ? null : toUtcIso(value))
export const dayText = (value: Date | null): string | null => (value === null ? null : value.toISOString().slice(0, 10))
export const dayValue = (value: string): Date => new Date(`${value}T00:00:00.000Z`)
export const priceOrNull = (value: Prisma.Decimal | null): string | null => (value === null ? null : value.toString())

export async function readRequest(db: Reader, requestId: string): Promise<RequestRow | null> {
  if (!isUuid(requestId)) return null
  return db.portalOrderRequest.findUnique({ where: { id: requestId }, select: REQUEST_COLUMNS })
}

export async function readLines(db: Reader, requestIds: readonly string[]): Promise<LineRow[]> {
  if (requestIds.length === 0) return []
  return db.portalOrderRequestLine.findMany({ where: { requestId: { in: [...requestIds] } }, select: LINE_COLUMNS, orderBy: [{ requestId: 'asc' }, { seq: 'asc' }] })
}

/** The request row locked for the command (FOR UPDATE), checked against the version the caller read. */
export async function lockRequest(tx: CommandTx, requestId: string, expected: number): Promise<RequestRow> {
  await tx.$queryRaw`SELECT "id" FROM "PortalOrderRequest" WHERE "id" = ${requestId}::uuid FOR UPDATE`
  const row = await readRequest(tx, requestId)
  if (!row) throw new NotFoundError('Order request not found.')
  if (row.version !== expected) throw new ConflictError(`This order request changed since you read it (now version ${row.version}). Read it again.`)
  return row
}

// ---- B-CP-072 (customer page plan C5): a draft's files — on the draft or one of its lines, not deleted ---------------------------

/** What a draft's file shows (partner-readable columns: never who uploaded it, never a hold or a scan finding). */
export const DRAFT_FILE_COLUMNS = { id: true, recordType: true, recordId: true, category: true, kind: true, originalName: true, contentType: true, sizeBytes: true, status: true, version: true, createdAt: true } as const satisfies Prisma.StoredFileSelect
export type DraftFileRow = Prisma.StoredFileGetPayload<{ select: typeof DRAFT_FILE_COLUMNS }>

/** The where of the files of these drafts and of their lines (read in the caller's scope: a portal session sees its party's only). */
export const draftFilesWhere = (requestIds: readonly string[], lineIds: readonly string[]): Prisma.StoredFileWhereInput => ({
  status: { not: 'DELETED' },
  OR: [{ recordType: 'PortalOrderRequest', recordId: { in: [...requestIds] } }, ...(lineIds.length > 0 ? [{ recordType: 'PortalOrderRequestLine', recordId: { in: [...lineIds] } }] : [])],
})

export async function readDraftFiles(db: Reader, requestIds: readonly string[], lineIds: readonly string[]): Promise<DraftFileRow[]> {
  if (requestIds.length === 0) return []
  return db.storedFile.findMany({ where: draftFilesWhere(requestIds, lineIds), select: DRAFT_FILE_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 1000 })
}
// ---- end B-CP-072

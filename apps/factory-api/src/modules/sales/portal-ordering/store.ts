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
  // B-CP-075: the parts sent later, and who of the customer saved it last (partner-readable; never an office person).
  laterParts: true,
  lastEditedById: true,
  lastEditedAt: true,
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
  // B-CP-005: the line's kind and its own words (a described or made-to-measure line names no catalogue style and colourway).
  kind: true,
  description: true,
  garmentType: true,
  // end B-CP-005
  // B-CP-075: a described or made-to-measure line's colours in words, its total, whether its pieces are its people.
  colourText: true,
  quantity: true,
  byPerson: true,
  // B-CP-076: "Your price", the customer's own net unit price (the price grain: the contracts mark it, the grain filter drops it).
  brandUnitPrice: true,
} as const satisfies Prisma.PortalOrderRequestLineSelect

export type RequestRow = Prisma.PortalOrderRequestGetPayload<{ select: typeof REQUEST_COLUMNS }>
export type LineRow = Prisma.PortalOrderRequestLineGetPayload<{ select: typeof LINE_COLUMNS }>
export type Reader = FactoryClient | CommandTx

// ---- B-CP-005 (schema wave "customer page 1/1"): a request line is of one of three kinds. A CATALOGUE line names a style of
// the catalogue and one of its colourways (the …_customer_page_guards trigger holds it); a DESCRIBED or MADE_TO_MEASURE
// line names neither, or only the customer's own style. Whatever reads lines as catalogue lines (the grid, the sizes and
// colours offered, the list price, merging an upload or a reorder, the order or quote made from them) takes the catalogue
// lines only; the other kinds are shown and accepted by their own steps (B-CP-075, B-CP-077).
export type CatalogueLineRow = LineRow & { readonly kind: 'CATALOGUE'; readonly styleId: string; readonly colourwayId: string }
export const isCatalogueLine = (line: LineRow): line is CatalogueLineRow => line.kind === 'CATALOGUE' && line.styleId !== null && line.colourwayId !== null
export const catalogueLines = (lines: readonly LineRow[]): CatalogueLineRow[] => lines.filter(isCatalogueLine)
/** A line in the customer's own words (a described or made-to-measure one): its description, else its garment type. */
export const ownWordsOf = (line: LineRow): string | null => line.description ?? line.garmentType
// ---- end B-CP-005

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

// ---- B-CP-075 (customer page plan C5, 12 §2 part 4): the people of a draft's by-person lines, and who saved the draft last ------

export const PERSON_COLUMNS = { id: true, requestId: true, lineId: true, seq: true, name: true, number: true, measureBy: true, size: true, measurementFileId: true, note: true, version: true } as const satisfies Prisma.PortalOrderRequestPersonSelect
export type PersonRow = Prisma.PortalOrderRequestPersonGetPayload<{ select: typeof PERSON_COLUMNS }>

/** The people of these requests' lines, by line and place (read in the caller's scope: a portal session sees its party's only). */
export async function readPeople(db: Reader, requestIds: readonly string[]): Promise<PersonRow[]> {
  if (requestIds.length === 0) return []
  return db.portalOrderRequestPerson.findMany({ where: { requestId: { in: [...requestIds] } }, select: PERSON_COLUMNS, orderBy: [{ requestId: 'asc' }, { lineId: 'asc' }, { seq: 'asc' }] })
}

/** "Saved 10:42 by Marta Bianchi": every draft command of the customer names who saved it (a draft column, frozen at Send). */
export async function markEdited(tx: CommandTx, requestId: string, userId: string, now: Date): Promise<void> {
  await tx.portalOrderRequest.update({ where: { id: requestId }, data: { lastEditedById: userId, lastEditedAt: now }, select: { id: true } })
}
// ---- end B-CP-075

// ---- B-CP-076 (lead, 11-19: the take-over by the line map): the accept's ONE map as its audit row keeps it (B-CP-077) ----------
/**
 * Each request line and the lines the accept made from it (the order's, accepted as an order; the quote's, accepted as a quote),
 * from the accept's own audit row (`portalOrdering.accept` `after.lineMap`). null: no accept, or one made before the map was kept
 * (the take-over then pairs nothing: better empty than wrong).
 */
export async function readAcceptedLineMap(db: Reader, requestId: string): Promise<{ readonly requestLineId: string; readonly into: readonly string[] }[] | null> {
  const row = await db.auditLog.findFirst({ where: { recordType: 'PortalOrderRequest', recordId: requestId, action: 'portalOrdering.accept' }, select: { after: true }, orderBy: [{ at: 'desc' }, { id: 'desc' }] })
  const map = (row?.after as { readonly lineMap?: unknown } | null | undefined)?.lineMap
  if (!Array.isArray(map)) return null
  return map.flatMap((entry: unknown) => {
    const item = entry as { readonly requestLineId?: unknown; readonly into?: unknown } | null
    if (!item || typeof item.requestLineId !== 'string' || !Array.isArray(item.into)) return []
    return [{ requestLineId: item.requestLineId, into: item.into.filter((lineId: unknown): lineId is string => typeof lineId === 'string') }]
  })
}
// ---- end B-CP-076

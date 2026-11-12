import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { SAFETY_REPORT_RECORD, statusWords, type AccidentOutcome, type ReportStatus } from '@nexus/factory-domain/sales/safety-reports/rules'
import { StaleVersionError, type CommandTools, type CommandTx } from '../../../core/command'

/**
 * The reads and the one row write of a product-safety report (B-W2b-351): its row (never an injury: ProductSafetyInjury is read
 * only by ./injury.ts, for the product-safety role), its photos, its accident log revisions, and the version bump every change
 * takes. Every read names its columns and runs on the client it is given (a command's transaction or a scoped client:
 * row-level security decides what it finds).
 */

export type Reader = FactoryClient | CommandTx

export const REPORT_COLUMNS = {
  id: true,
  companyId: true,
  number: true,
  source: true,
  receivedAt: true,
  partyId: true,
  contactId: true,
  reporterName: true,
  reporterEmail: true,
  reporterPhone: true,
  styleId: true,
  colourwayId: true,
  size: true,
  serial: true,
  garmentSerial: true,
  batchNumber: true,
  garmentBatch: true,
  occurredOn: true,
  whatHappened: true,
  wornAsIntended: true,
  status: true,
  seenAt: true,
  seenById: true,
  ownerId: true,
  serviceCaseId: true,
  registerEntryId: true,
  closedAt: true,
  closedById: true,
  closeNote: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.ProductSafetyReportSelect

export type ReportRow = Prisma.ProductSafetyReportGetPayload<{ select: typeof REPORT_COLUMNS }>

export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
export const dayOrNull = (value: Date | null): BusinessDate | null => (value ? dayOf(value) : null)
export const asDay = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)
export const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

export async function readReport(db: Reader, reportId: string): Promise<ReportRow | null> {
  return db.productSafetyReport.findUnique({ where: { id: reportId }, select: REPORT_COLUMNS })
}

/** command()'s record guard by hand: the report's row FOR UPDATE, at the version the caller read (not closed unless asked). */
export async function lockReport(tools: Pick<CommandTools, 'tx'>, reportId: string, expectedVersion: number | undefined, options: { readonly closedToo?: boolean } = {}): Promise<ReportRow> {
  const [locked] = await tools.tx.$queryRaw<{ version: number; status: ReportStatus; number: string }[]>`SELECT "version", "status"::text AS "status", "number" FROM "ProductSafetyReport" WHERE "id" = ${reportId}::uuid FOR UPDATE`
  if (!locked) throw new NotFoundError('Safety report not found.')
  if (!options.closedToo && locked.status === 'CLOSED') throw new InvalidStateError(`Safety report ${locked.number} is ${statusWords(locked.status)}: it changes no more.`)
  if (expectedVersion !== undefined && locked.version !== expectedVersion) throw new StaleVersionError(SAFETY_REPORT_RECORD, reportId, locked.version, expectedVersion)
  return (await readReport(tools.tx, reportId))!
}

/** Writes the report with its version moved on (every change of it, its injury, photos and accident log included). */
export async function touchReport(tools: Pick<CommandTools, 'tx' | 'now'>, row: Pick<ReportRow, 'id'>, data: Prisma.ProductSafetyReportUncheckedUpdateInput = {}): Promise<ReportRow> {
  return tools.tx.productSafetyReport.update({ where: { id: row.id }, data: { ...data, updatedAt: tools.now, version: { increment: 1 } }, select: REPORT_COLUMNS })
}

/** Whether the injury row exists and its state, never its words nor whether someone was hurt (those are ./injury.ts's). */
export async function injuryStateOf(db: Reader, reportId: string): Promise<{ id: string; words: boolean; erased: boolean } | null> {
  const row = await db.productSafetyInjury.findFirst({ where: { reportId }, select: { id: true, erasedAt: true } })
  if (!row) return null
  // Whether words are kept, without reading them.
  const words = (await db.productSafetyInjury.count({ where: { id: row.id, injuryWords: { not: null } } })) > 0
  return { id: row.id, words, erased: row.erasedAt !== null }
}

export const LOG_COLUMNS = {
  id: true,
  companyId: true,
  reportId: true,
  revision: true,
  occurredOn: true,
  place: true,
  styleId: true,
  serial: true,
  batchNumber: true,
  outcome: true,
  authorityToldAt: true,
  authorityToldById: true,
  authorityReference: true,
  authorityNoticeId: true,
  note: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.AccidentLogEntrySelect

export type LogRow = Prisma.AccidentLogEntryGetPayload<{ select: typeof LOG_COLUMNS }>

export async function revisionsOf(db: Reader, reportId: string): Promise<LogRow[]> {
  return db.accidentLogEntry.findMany({ where: { reportId }, select: LOG_COLUMNS, orderBy: [{ revision: 'desc' }, { id: 'asc' }] })
}

export function revisionView(row: LogRow) {
  return {
    id: row.id,
    revision: row.revision,
    occurredOn: dayOf(row.occurredOn),
    place: row.place,
    styleId: row.styleId,
    serial: row.serial,
    batchNumber: row.batchNumber,
    outcome: row.outcome as AccidentOutcome,
    authority: row.authorityToldAt ? { toldAt: toUtcIso(row.authorityToldAt), byId: row.authorityToldById!, reference: row.authorityReference, noticeId: row.authorityNoticeId } : null,
    note: row.note,
    recordedAt: toUtcIso(row.createdAt),
    recordedById: row.createdById,
  }
}

/** The photos a report shows (AVAILABLE PHOTO files of the row, oldest first; read through this module only). */
export async function photosOf(db: Pick<CommandTx, 'storedFile'>, reportId: string) {
  const rows = await db.storedFile.findMany({
    where: { recordType: SAFETY_REPORT_RECORD, recordId: reportId, kind: 'PHOTO', status: 'AVAILABLE' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, originalName: true, contentType: true, sizeBytes: true, availableAt: true },
  })
  return rows.map((row) => ({ id: row.id, name: row.originalName, contentType: row.contentType, sizeBytes: row.sizeBytes, availableAt: iso(row.availableAt) }))
}

/** The photos that count toward the limit (waiting for the upload, available, or held by the scanner). */
export async function photosHeld(db: Pick<CommandTx, 'storedFile'>, reportId: string): Promise<number> {
  return db.storedFile.count({ where: { recordType: SAFETY_REPORT_RECORD, recordId: reportId, kind: 'PHOTO', status: { in: ['PENDING_UPLOAD', 'AVAILABLE', 'QUARANTINED'] } } })
}

export async function peopleOf(db: Reader, ids: readonly (string | null | undefined)[]): Promise<{ id: string; name: string }[]> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))]
  if (wanted.length === 0) return []
  return (await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true }, orderBy: { id: 'asc' } })).map((row) => ({ id: row.id, name: row.displayName }))
}

import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { QUALITY_INCOMING_VIEW } from '@nexus/factory-domain/quality/incoming/permissions'
import { StaleVersionError, type CommandCaller, type CommandTx } from '../../../core/command'
import { inspectorOf, mayOn, signerOf, type Inspector } from '../final/access'

/**
 * What the incoming inspection's reads and commands share (B-W2b-98): the columns, one lot and one inspection as the
 * caller may reach them (office: the permission over the lot's company and site; a floor device: its own site only, as
 * can() and row-level security pin it), the inspection row locked inside a command, who records and signs it, and the
 * lot's lock that keeps two OPEN inspections of one lot from being opened at once.
 */

export type Reader = FactoryClient | CommandTx

export const LOT_COLUMNS = {
  id: true,
  code: true,
  companyId: true,
  siteId: true,
  itemId: true,
  itemColourId: true,
  supplierId: true,
  supplierLotRef: true,
  dyeBatch: true,
  qualityStatus: true,
  receivedAt: true,
  createdById: true,
  item: { select: { id: true, code: true, name: true, kind: true, tracking: true, baseUom: true } },
  itemColour: { select: { id: true, code: true, name: true } },
} as const satisfies Prisma.LotSelect
export type LotRow = Prisma.LotGetPayload<{ select: typeof LOT_COLUMNS }>

export const INCOMING_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  lotId: true,
  itemId: true,
  planVersionId: true,
  aqlProfileId: true,
  codeLetter: true,
  lotSize: true,
  uom: true,
  sampleSize: true,
  inspectionLevel: true,
  aqlMajor: true,
  aqlMinor: true,
  acceptMajor: true,
  acceptMinor: true,
  foundCritical: true,
  foundMajor: true,
  foundMinor: true,
  status: true,
  acceptedQuantity: true,
  rejectedQuantity: true,
  toSortQuantity: true,
  computedResult: true,
  overrideReason: true,
  inspectorWorkerId: true,
  inspectorUserId: true,
  dueAt: true,
  decidedAt: true,
  signatureSha256: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.IncomingInspectionSelect
export type IncomingRow = Prisma.IncomingInspectionGetPayload<{ select: typeof INCOMING_COLUMNS }>

export const RESULT_COLUMNS = {
  id: true,
  hideId: true,
  seq: true,
  declaredArea: true,
  measuredArea: true,
  areaUom: true,
  shadeGroup: true,
  shadeRecordId: true,
  grade: true,
  gradeRecordId: true,
  marks: true,
  decision: true,
  note: true,
  version: true,
} as const satisfies Prisma.IncomingHideResultSelect
export type ResultRow = Prisma.IncomingHideResultGetPayload<{ select: typeof RESULT_COLUMNS }>

export const readIncoming = (db: Pick<Reader, 'incomingInspection'>, id: string): Promise<IncomingRow | null> =>
  isUuid(id) ? db.incomingInspection.findUnique({ where: { id }, select: INCOMING_COLUMNS }) : Promise.resolve(null)

export const readLot = (db: Pick<Reader, 'lot'>, id: string): Promise<LotRow | null> => (isUuid(id) ? db.lot.findUnique({ where: { id }, select: LOT_COLUMNS }) : Promise.resolve(null))

export const readResults = (db: Pick<Reader, 'incomingHideResult'>, inspectionId: string): Promise<ResultRow[]> =>
  db.incomingHideResult.findMany({ where: { incomingInspectionId: inspectionId }, select: RESULT_COLUMNS, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })

/**
 * The lot's lock: one writer opens an incoming inspection of a lot at a time, so the count of OPEN ones read after it is
 * the truth (the database does not refuse a second OPEN row: its isolation test copies one). THE SAME KEY as the
 * inspection triggers' handler (B-W2b-101, modules/quality/triggers `lockIncomingSubject`), so a person and a rule never
 * open two of one lot at once. Once B-W2b-101 is on main, import its helper and drop this copy.
 */
export const lockIncomingSubject = (tx: CommandTx, subjectId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.incoming-inspection', current_setting('factory.tenant_id', true), ${subjectId}::text), 0))`

/** The lot as the caller may reach it with the permission (not found outside its view; forbidden without the permission). */
export async function lotFor(caller: CommandCaller, lotId: string, permission: Permission): Promise<{ lot: LotRow; context: Inspector }> {
  const context = inspectorOf(caller)
  const lot = await caller.withClient((client) => readLot(client, lotId))
  if (!lot || !(mayOn(context, QUALITY_INCOMING_VIEW, lot) || mayOn(context, permission, lot))) throw new NotFoundError('Lot not found.')
  if (!mayOn(context, permission, lot)) throw new ForbiddenError(`This needs ${permission} over the lot's company and site.`)
  return { lot, context }
}

/** The inspection and its lot as the caller may reach them with the permission. */
export async function incomingFor(caller: CommandCaller, inspectionId: string, permission: Permission): Promise<{ row: IncomingRow; lot: LotRow; context: Inspector }> {
  const context = inspectorOf(caller)
  const row = await caller.withClient((client) => readIncoming(client, inspectionId))
  if (!row || !row.lotId || !(mayOn(context, QUALITY_INCOMING_VIEW, row) || mayOn(context, permission, row))) throw new NotFoundError('Incoming inspection not found.')
  if (!mayOn(context, permission, row)) throw new ForbiddenError(`This needs ${permission} over the lot's company and site.`)
  const lot = (await caller.withClient((client) => readLot(client, row.lotId!)))!
  return { row, lot, context }
}

/** A decided or cancelled inspection never changes (409 before the trigger). */
export function assertOpen(row: Pick<IncomingRow, 'status' | 'number'>): void {
  if (row.status !== 'OPEN') throw new InvalidStateError(`Incoming inspection ${row.number} is ${row.status}; a signed or cancelled inspection never changes (a correction is an amendment).`)
}

/** The inspection's row FOR UPDATE inside a command, then its version (409 when stale) and its state (an OPEN one only). */
export async function lockIncoming(tx: CommandTx, inspectionId: string, expectedVersion: number): Promise<IncomingRow> {
  await tx.$queryRaw`SELECT "id" FROM "IncomingInspection" WHERE "id" = ${inspectionId}::uuid FOR UPDATE`
  const row = await readIncoming(tx, inspectionId)
  if (!row) throw new NotFoundError('Incoming inspection not found.')
  if (row.version !== expectedVersion) throw new StaleVersionError('IncomingInspection', row.id, row.version, expectedVersion)
  assertOpen(row)
  return row
}

/** Nobody took it yet (an inspection a rule opened, B-W2b-101): the first person who records it becomes its inspector. */
export const unassigned = (row: Pick<IncomingRow, 'inspectorWorkerId' | 'inspectorUserId'>): boolean => row.inspectorWorkerId === null && row.inspectorUserId === null

/** The caller records and signs this inspection: its inspector, or anyone with the permission while nobody took it. */
export function isOwn(context: Inspector, row: Pick<IncomingRow, 'inspectorWorkerId' | 'inspectorUserId'>): boolean {
  if (unassigned(row)) return true
  const signer = signerOf(context)
  return (signer.workerId !== null && signer.workerId === row.inspectorWorkerId) || (signer.userId !== null && signer.userId === row.inspectorUserId)
}

export function assertOwn(context: Inspector, row: Pick<IncomingRow, 'inspectorWorkerId' | 'inspectorUserId'>): void {
  if (!isOwn(context, row)) throw new ForbiddenError('This incoming inspection is recorded and signed by the inspector who took it.')
}

/** The inspector columns a write sets: the caller takes an inspection nobody took; nothing changes when it is theirs. */
export function takeOver(context: Inspector, row: Pick<IncomingRow, 'inspectorWorkerId' | 'inspectorUserId'>): { inspectorWorkerId: string | null; inspectorUserId: string | null } | Record<string, never> {
  if (!unassigned(row)) return {}
  const signer = signerOf(context)
  return { inspectorWorkerId: signer.workerId, inspectorUserId: signer.userId }
}

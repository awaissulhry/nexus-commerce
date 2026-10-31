import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { CommandTx } from '../../../core/command'
import { legalGateFor, type GateReader } from '../../people/privacy/gate'

/**
 * Off-standard and indirect time's reads and locks (B-W2b-29): the codes, the blocks, their line days and their labour
 * edits, the stations and lines they name, a subject's running block and running bundle. Every read names its columns
 * (a floor read of a Worker never asks for its hidden userId), selects no relation, and runs as the caller: row-level
 * security keeps a floor device to its own site (the codes are the tenant's: the floor reads them all, the API keeps it to
 * the device's company).
 */

export type Reader = FactoryClient | CommandTx

export const CODE = {
  id: true,
  companyId: true,
  code: true,
  kind: true,
  payRule: true,
  needsApproval: true,
  labelIt: true,
  labelEn: true,
  labelI18n: true,
  icon: true,
  colour: true,
  sortOrder: true,
  active: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.OffStandardCodeSelect
export type CodeRow = Prisma.OffStandardCodeGetPayload<{ select: typeof CODE }>

export const BLOCK = {
  id: true,
  companyId: true,
  siteId: true,
  lineId: true,
  stationId: true,
  workerId: true,
  employeeId: true,
  codeId: true,
  source: true,
  helpCallId: true,
  workDate: true,
  startedAt: true,
  endedAt: true,
  status: true,
  approvedAt: true,
  approvedById: true,
  rejectedAt: true,
  rejectedById: true,
  rejectReason: true,
  note: true,
  deviceId: true,
  clientEventId: true,
  deviceTime: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.OffStandardEntrySelect
export type BlockRow = Prisma.OffStandardEntryGetPayload<{ select: typeof BLOCK }>

/** The other languages' words as the row keeps them ({ "ro": "…" }; the database's guard keeps the shape). */
export const wordsOf = (value: Prisma.JsonValue): Record<string, string> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}

export async function readCode(db: Reader, codeId: string): Promise<CodeRow | null> {
  if (!isUuid(codeId)) return null
  return db.offStandardCode.findUnique({ where: { id: codeId }, select: CODE })
}

export async function readCodes(db: Reader, where: Prisma.OffStandardCodeWhereInput): Promise<CodeRow[]> {
  return db.offStandardCode.findMany({ where, select: CODE, orderBy: [{ companyId: 'asc' }, { sortOrder: 'asc' }, { code: 'asc' }] })
}

export async function codesById(db: Reader, ids: readonly string[]): Promise<Map<string, CodeRow>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  return new Map((await db.offStandardCode.findMany({ where: { id: { in: unique } }, select: CODE })).map((row) => [row.id, row]))
}

/** How many blocks name each code (a code in use is set inactive, never deleted). Office reads. */
export async function codeUsage(db: Reader, codeIds: readonly string[]): Promise<Map<string, number>> {
  if (codeIds.length === 0) return new Map()
  const rows = await db.offStandardEntry.groupBy({ by: ['codeId'], where: { codeId: { in: [...codeIds] } }, _count: { _all: true } })
  return new Map(rows.map((row) => [row.codeId, row._count._all]))
}

/** The active help-call types that book their waiting to each code (MES-148). Office reads. */
export async function callTypesOf(db: Reader, codeIds: readonly string[]): Promise<Map<string, string[]>> {
  if (codeIds.length === 0) return new Map()
  const rows = await db.helpCallType.findMany({ where: { offStandardCodeId: { in: [...codeIds] }, active: true }, select: { offStandardCodeId: true, code: true }, orderBy: { code: 'asc' } })
  const map = new Map<string, string[]>()
  for (const row of rows) if (row.offStandardCodeId) map.set(row.offStandardCodeId, [...(map.get(row.offStandardCodeId) ?? []), row.code])
  return map
}

export async function readBlock(db: Reader, blockId: string): Promise<BlockRow | null> {
  if (!isUuid(blockId)) return null
  return db.offStandardEntry.findUnique({ where: { id: blockId }, select: BLOCK })
}

export async function readBlocks(db: Reader, where: Prisma.OffStandardEntryWhereInput, order: 'oldest' | 'newest', take: number): Promise<BlockRow[]> {
  const direction = order === 'oldest' ? 'asc' : 'desc'
  return db.offStandardEntry.findMany({ where, select: BLOCK, orderBy: [{ startedAt: direction }, { id: direction }], take })
}

/** A device's block by its client event id (the floor's resend). */
export async function readBlockByClient(db: Reader, deviceId: string, clientEventId: string): Promise<BlockRow | null> {
  return db.offStandardEntry.findFirst({ where: { deviceId, clientEventId }, select: BLOCK })
}

/** Who a block is about: the worker where the site records workers, else the station. */
export interface Subject {
  readonly workerId: string | null
  readonly stationId: string | null
}

const subjectWhere = (subject: Subject): Prisma.OffStandardEntryWhereInput =>
  subject.workerId ? { workerId: subject.workerId } : { workerId: null, stationId: subject.stationId ?? '00000000-0000-0000-0000-000000000000' }

/** The subject's running block (one at most: the partial unique indexes). */
export async function runningBlockOf(db: Reader, siteId: string, subject: Subject): Promise<BlockRow | null> {
  if (!subject.workerId && !subject.stationId) return null
  return db.offStandardEntry.findFirst({ where: { siteId, status: 'OPEN', ...subjectWhere(subject) }, select: BLOCK })
}

/** The subject's running block, locked for this transaction (FOR UPDATE: another end or switch waits). */
export async function lockRunningBlock(tx: CommandTx, tenantId: string, siteId: string, subject: Subject): Promise<BlockRow | null> {
  if (!subject.workerId && !subject.stationId) return null
  const rows = subject.workerId
    ? await tx.$queryRaw<{ id: string }[]>`SELECT "id"::text FROM "OffStandardEntry" WHERE "tenantId" = ${tenantId}::uuid AND "siteId" = ${siteId}::uuid AND "status" = 'OPEN' AND "workerId" = ${subject.workerId}::uuid FOR UPDATE`
    : await tx.$queryRaw<{ id: string }[]>`SELECT "id"::text FROM "OffStandardEntry" WHERE "tenantId" = ${tenantId}::uuid AND "siteId" = ${siteId}::uuid AND "status" = 'OPEN' AND "workerId" IS NULL AND "stationId" = ${subject.stationId}::uuid FOR UPDATE`
  return rows[0] ? readBlock(tx, rows[0].id) : null
}

/** When the subject's latest ended block (not rejected) ended: a new block starts no earlier (an offline tablet's clock). */
export async function latestEndOf(db: Reader, siteId: string, subject: Subject): Promise<Date | null> {
  if (!subject.workerId && !subject.stationId) return null
  const row = await db.offStandardEntry.findFirst({ where: { siteId, ...subjectWhere(subject), status: { not: 'REJECTED' }, endedAt: { not: null } }, select: { endedAt: true }, orderBy: { endedAt: 'desc' } })
  return row?.endedAt ?? null
}

/** One block, locked for this transaction. */
export async function lockBlock(tx: CommandTx, tenantId: string, blockId: string): Promise<BlockRow | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id"::text FROM "OffStandardEntry" WHERE "tenantId" = ${tenantId}::uuid AND "id" = ${blockId}::uuid FOR UPDATE`
  return rows[0] ? readBlock(tx, rows[0].id) : null
}

/** The subject's other blocks that are not rejected, around a time span (the overlap check). */
export async function blocksAround(db: Reader, siteId: string, subject: Subject, from: Date, to: Date, except: string | null): Promise<BlockRow[]> {
  if (!subject.workerId && !subject.stationId) return []
  return db.offStandardEntry.findMany({
    where: {
      siteId,
      ...subjectWhere(subject),
      status: { not: 'REJECTED' },
      startedAt: { lt: to },
      OR: [{ endedAt: null }, { endedAt: { gt: from } }],
      ...(except ? { id: { not: except } } : {}),
    },
    select: BLOCK,
    orderBy: { startedAt: 'asc' },
  })
}

/**
 * The subject's running bundle (a START or RESUME still the last row of its bundle and operation, in the last day): the
 * database's own function, so the API answers in words what the trigger would refuse (MES-156: "no bundle active").
 */
export async function runningStretchOf(tx: Reader, tenantId: string, siteId: string, subject: Subject): Promise<string | null> {
  const rows = await tx.$queryRaw<{ id: string | null }[]>`SELECT "factory_floor_running_stretch"(${tenantId}::uuid, ${siteId}::uuid, ${subject.workerId}::uuid, ${subject.stationId}::uuid)::text AS id`
  return rows[0]?.id ?? null
}

/** The line days of these (line, day) pairs that are CLOSED. */
export async function closedDays(db: Reader, pairs: readonly { readonly lineId: string | null; readonly workDate: Date }[]): Promise<Set<string>> {
  const wanted = pairs.filter((pair): pair is { lineId: string; workDate: Date } => pair.lineId !== null)
  if (wanted.length === 0) return new Set()
  const rows = await db.labourDay.findMany({ where: { status: 'CLOSED', OR: wanted.map((pair) => ({ lineId: pair.lineId, workDate: pair.workDate })) }, select: { lineId: true, workDate: true } })
  return new Set(rows.map((row) => dayKey(row.lineId, row.workDate)))
}
export const dayKey = (lineId: string, workDate: Date): string => `${lineId}|${workDate.toISOString().slice(0, 10)}`

/** The blocks that have a labour edit (changed after they ended). */
export async function editedBlocks(db: Reader, blockIds: readonly string[]): Promise<Set<string>> {
  if (blockIds.length === 0) return new Set()
  const rows = await db.labourEdit.findMany({ where: { recordType: 'OffStandardEntry', recordId: { in: [...blockIds] } }, select: { recordId: true }, distinct: ['recordId'] })
  return new Set(rows.map((row) => row.recordId))
}

export async function editsOf(db: Reader, blockId: string) {
  return db.labourEdit.findMany({
    where: { recordType: 'OffStandardEntry', recordId: blockId },
    select: { id: true, before: true, after: true, reason: true, disputeId: true, createdAt: true, createdById: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
}

export interface Place {
  readonly id: string
  readonly code: string
  readonly name: string
}
export interface StationPlace extends Place {
  readonly lineId: string | null
}

export async function stationsById(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, StationPlace>> {
  const unique = [...new Set(ids.filter((value): value is string => value !== null))]
  if (unique.length === 0) return new Map()
  return new Map((await db.station.findMany({ where: { id: { in: unique } }, select: { id: true, code: true, name: true, lineId: true } })).map((row) => [row.id, row]))
}

export async function linesById(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, Place>> {
  const unique = [...new Set(ids.filter((value): value is string => value !== null))]
  if (unique.length === 0) return new Map()
  return new Map((await db.line.findMany({ where: { id: { in: unique } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
}

export async function sitesById(db: Reader, ids: readonly string[]) {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map<string, { id: string; companyId: string; code: string; name: string; timezone: string; floorLocales: string[] }>()
  return new Map((await db.site.findMany({ where: { id: { in: unique } }, select: { id: true, companyId: true, code: true, name: true, timezone: true, floorLocales: true } })).map((row) => [row.id, row]))
}

/** The device's station (null: a tablet placed at none). */
export async function deviceStationOf(db: Reader, deviceId: string): Promise<string | null> {
  return (await db.device.findUnique({ where: { id: deviceId }, select: { stationId: true } }))?.stationId ?? null
}

/** A worker's employee (Worker.employeeId: the floor may read it), its site and state. */
export async function workerOf(db: Reader, workerId: string) {
  if (!isUuid(workerId)) return null
  return db.worker.findUnique({ where: { id: workerId }, select: { id: true, siteId: true, status: true, employeeId: true, displayName: true } })
}

/** People by id as one record names them: floor workers, else office users (an office read). */
export async function peopleNames(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((value): value is string => value !== null))]
  if (unique.length === 0) return new Map()
  const names = new Map((await db.worker.findMany({ where: { id: { in: unique } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
  const users = unique.filter((id) => !names.has(id))
  if (users.length > 0) for (const row of await db.user.findMany({ where: { id: { in: users } }, select: { id: true, displayName: true } })) names.set(row.id, row.displayName)
  return names
}

/**
 * The site's legal gate for one person's work figures is switched on: a PeopleLegalGate row in force for PERFORMANCE
 * (Statuto dei Lavoratori art. 4 c.1: the site's recorded basis; GATE-LABOUR; B-W2b-06's table). Off by default: no row.
 * Read through B-W2b-27's legalGateFor (the gate's own dates and state decide). Office reads.
 */
export async function performanceGateOpen(db: Reader, siteId: string): Promise<boolean> {
  return (await legalGateFor(db as GateReader, siteId, 'PERFORMANCE')).open
}

/** The office users these workers also are (Worker.userId; office reads only: the floor role cannot see the column). */
export async function workerUsers(db: Reader, workerIds: readonly (string | null)[]): Promise<Set<string>> {
  const ids = [...new Set(workerIds.filter((value): value is string => value !== null))]
  if (ids.length === 0) return new Set()
  return new Set((await db.worker.findMany({ where: { id: { in: ids } }, select: { userId: true } })).flatMap((row) => (row.userId ? [row.userId] : [])))
}

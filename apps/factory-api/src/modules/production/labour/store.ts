import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDayStart, type BusinessDate } from '@nexus/factory-domain/core/time'
import { addDays, labourRecordsOf, type LabourRecord, type LabourScan } from '@nexus/factory-domain/production/labour/rules'
import { SCAN_KINDS } from '@nexus/factory-domain/production/scans/rules'
import type { CommandTx } from '../../../core/command'

/**
 * Labour records' reads (B-W2b-45): the scans of the count ledger with their whole chains (corrections, undos), the
 * operations' frozen standard minutes, the lines, stations and devices a scan's line comes from, and the people behind
 * the floor sign-ins. Every read names its columns and runs as the caller: row-level security keeps a floor device to its
 * own site. The timing kinds (START, PAUSE …) are left out of every count read (SCAN_KINDS; B-W2b-12's rule).
 */

export type Reader = FactoryClient | CommandTx

export const SCAN = {
  id: true,
  siteId: true,
  kind: true,
  correctsId: true,
  goodQuantity: true,
  scrapQuantity: true,
  reworkQuantity: true,
  serverTime: true,
  workOrderId: true,
  workOrderOperationId: true,
  bundleId: true,
  workerId: true,
  stationId: true,
  deviceId: true,
  approvedById: true,
  reason: true,
} as const satisfies Prisma.OperationScanSelect
export type ScanRow = Prisma.OperationScanGetPayload<{ select: typeof SCAN }>

export const COUNT_KINDS = [...SCAN_KINDS]

export const toLabourScan = (row: ScanRow): LabourScan => ({ ...row, kind: row.kind })

/** A site's day as the Date column keeps it (midnight UTC of that calendar day). */
export const dayColumn = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)
export const isoDay = (date: Date): BusinessDate => date.toISOString().slice(0, 10)

/** The instants a site's days from `from` to `to` cover: [start of from, start of the day after to). */
export function dayRange(from: BusinessDate, to: BusinessDate, timeZone: string): { readonly start: Date; readonly end: Date } {
  return { start: businessDayStart(from, timeZone), end: businessDayStart(addDays(to, 1), timeZone) }
}

const chunks = <T>(items: readonly T[], size = 200): T[][] => {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size))
  return out
}

/** Every count scan of these (bundle, operation) pairs: the whole chain of each report (its corrections, its undo). */
export async function chainsOf(db: Reader, pairs: readonly { readonly bundleId: string; readonly workOrderOperationId: string }[]): Promise<ScanRow[]> {
  const unique = [...new Map(pairs.map((pair) => [`${pair.bundleId}|${pair.workOrderOperationId}`, pair])).values()]
  const rows: ScanRow[] = []
  for (const part of chunks(unique)) {
    if (part.length === 0) continue
    rows.push(...(await db.operationScan.findMany({ where: { kind: { in: COUNT_KINDS }, OR: part.map((pair) => ({ bundleId: pair.bundleId, workOrderOperationId: pair.workOrderOperationId })) }, select: SCAN })))
  }
  return rows
}

export interface OperationRow {
  readonly id: string
  readonly workOrderId: string
  readonly seq: number
  readonly code: string
  readonly name: string
  readonly standardMinutes: string
}

export async function operationsById(db: Reader, ids: readonly string[]): Promise<Map<string, OperationRow>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await db.workOrderOperation.findMany({ where: { id: { in: unique } }, select: { id: true, workOrderId: true, seq: true, code: true, name: true, standardMinutes: true } })
  return new Map(rows.map((row) => [row.id, { ...row, standardMinutes: row.standardMinutes.toString() }]))
}

export interface RecordSet {
  readonly records: LabourRecord[]
  /** Every scan of the records' chains, by id. */
  readonly scans: Map<string, ScanRow>
  readonly operations: Map<string, OperationRow>
}

/**
 * The labour records of these REPORT scans (MES-201): each with its whole chain and its operation's standard minutes.
 * Only the reports asked for are answered (a bundle's operation may hold another worker's undone report).
 */
export async function recordsFor(db: Reader, reports: readonly Pick<ScanRow, 'id' | 'bundleId' | 'workOrderOperationId'>[], timeZone: string): Promise<RecordSet> {
  if (reports.length === 0) return { records: [], scans: new Map(), operations: new Map() }
  const all = await chainsOf(db, reports)
  const operations = await operationsById(db, all.map((row) => row.workOrderOperationId))
  const standard = new Map([...operations.values()].map((row) => [row.id, row.standardMinutes]))
  const wanted = new Set(reports.map((row) => row.id))
  const records = labourRecordsOf(all.map(toLabourScan), standard, timeZone).filter((record) => wanted.has(record.scanId))
  return { records, scans: new Map(all.map((row) => [row.id, row])), operations }
}

export interface SiteRow {
  readonly id: string
  readonly companyId: string
  readonly code: string
  readonly name: string
  readonly timezone: string
}

export async function sitesById(db: Reader, ids: readonly string[]): Promise<Map<string, SiteRow>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  return new Map((await db.site.findMany({ where: { id: { in: unique } }, select: { id: true, companyId: true, code: true, name: true, timezone: true } })).map((row) => [row.id, row]))
}

export interface LineRow {
  readonly id: string
  readonly siteId: string
  readonly code: string
  readonly name: string
}

export async function readLine(db: Reader, lineId: string): Promise<LineRow | null> {
  if (!isUuid(lineId)) return null
  return db.line.findUnique({ where: { id: lineId }, select: { id: true, siteId: true, code: true, name: true } })
}

export async function linesById(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, LineRow>> {
  const unique = [...new Set(ids.filter((value): value is string => value !== null))]
  if (unique.length === 0) return new Map()
  return new Map((await db.line.findMany({ where: { id: { in: unique } }, select: { id: true, siteId: true, code: true, name: true } })).map((row) => [row.id, row]))
}

/** Where a scan's line comes from: its station's line, else (no station) the line its tablet shows (B-W2b-52 LINE mode). */
export interface LineSources {
  readonly stationLine: Map<string, string>
  readonly deviceLine: Map<string, string>
}

/** The stations and the station-less tablets of these lines. */
export async function lineSources(db: Reader, lineIds: readonly string[]): Promise<LineSources> {
  if (lineIds.length === 0) return { stationLine: new Map(), deviceLine: new Map() }
  const stations = await db.station.findMany({ where: { lineId: { in: [...lineIds] } }, select: { id: true, lineId: true } })
  const devices = await db.device.findMany({ where: { lineId: { in: [...lineIds] }, stationId: null }, select: { id: true, lineId: true } })
  return {
    stationLine: new Map(stations.flatMap((row) => (row.lineId ? [[row.id, row.lineId] as const] : []))),
    deviceLine: new Map(devices.flatMap((row) => (row.lineId ? [[row.id, row.lineId] as const] : []))),
  }
}

/** The line a scan (or a refused scan) was made on, from its station or its station-less tablet; null: none. */
export const lineOf = (sources: LineSources, row: { readonly stationId: string | null; readonly deviceId: string | null }): string | null =>
  row.stationId ? (sources.stationLine.get(row.stationId) ?? null) : row.deviceId ? (sources.deviceLine.get(row.deviceId) ?? null) : null

/** The where-clause of the scans made on these lines' stations and station-less tablets. */
export function onLines(sources: LineSources): Prisma.OperationScanWhereInput {
  const stations = [...sources.stationLine.keys()]
  const devices = [...sources.deviceLine.keys()]
  const or: Prisma.OperationScanWhereInput[] = []
  if (stations.length > 0) or.push({ stationId: { in: stations } })
  if (devices.length > 0) or.push({ stationId: null, deviceId: { in: devices } })
  return or.length > 0 ? { OR: or } : { id: { in: [] } }
}

/** The lines of stations by id (one record's line). */
export async function stationsById(db: Reader, ids: readonly (string | null)[]) {
  const unique = [...new Set(ids.filter((value): value is string => value !== null))]
  if (unique.length === 0) return new Map<string, { id: string; code: string; name: string; lineId: string | null }>()
  return new Map((await db.station.findMany({ where: { id: { in: unique } }, select: { id: true, code: true, name: true, lineId: true } })).map((row) => [row.id, row]))
}

export async function devicesById(db: Reader, ids: readonly (string | null)[]) {
  const unique = [...new Set(ids.filter((value): value is string => value !== null))]
  if (unique.length === 0) return new Map<string, { id: string; stationId: string | null; lineId: string | null }>()
  return new Map((await db.device.findMany({ where: { id: { in: unique } }, select: { id: true, stationId: true, lineId: true } })).map((row) => [row.id, row]))
}

/** The line of one scan: its station's, else its tablet's. */
export async function lineOfScan(db: Reader, scan: { readonly stationId: string | null; readonly deviceId: string | null }): Promise<string | null> {
  if (scan.stationId) return (await stationsById(db, [scan.stationId])).get(scan.stationId)?.lineId ?? null
  if (scan.deviceId) return (await devicesById(db, [scan.deviceId])).get(scan.deviceId)?.lineId ?? null
  return null
}

export async function bundlesById(db: Reader, ids: readonly string[]): Promise<Map<string, { id: string; code: string }>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  return new Map((await db.bundle.findMany({ where: { id: { in: unique } }, select: { id: true, code: true } })).map((row) => [row.id, row]))
}

export async function workOrdersById(db: Reader, ids: readonly string[]): Promise<Map<string, { id: string; number: string }>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  return new Map((await db.workOrder.findMany({ where: { id: { in: unique } }, select: { id: true, number: true } })).map((row) => [row.id, row]))
}

/** The employees behind floor sign-ins (Worker.employeeId; the floor may read it). */
export async function employeesOfWorkers(db: Reader, workerIds: readonly (string | null)[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(workerIds.filter((value): value is string => value !== null))]
  if (unique.length === 0) return new Map()
  return new Map((await db.worker.findMany({ where: { id: { in: unique } }, select: { id: true, employeeId: true } })).map((row) => [row.id, row.employeeId]))
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

/** The office users a worker (and the employee behind it) also is: they never answer that worker's dispute. */
export async function usersOfPerson(db: Reader, person: { readonly workerId: string | null; readonly employeeId: string | null }): Promise<Set<string>> {
  const ids = new Set<string>()
  if (person.workerId) {
    const worker = await db.worker.findUnique({ where: { id: person.workerId }, select: { userId: true } })
    if (worker?.userId) ids.add(worker.userId)
  }
  if (person.employeeId) {
    const employee = await db.employee.findUnique({ where: { id: person.employeeId }, select: { userId: true } })
    if (employee?.userId) ids.add(employee.userId)
  }
  return ids
}

/** The JSON object a labour edit keeps (before / after). */
export const jsonObject = (value: Prisma.JsonValue): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

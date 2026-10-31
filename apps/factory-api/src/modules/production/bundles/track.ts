import type { Prisma } from '@nexus/factory-db'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { workingMinutesBetween, type WorkingCalendar } from '@nexus/factory-domain/calendars/working-time'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { placeOf, stuckLimitOf, stuckOf, type PlaceAnswer, type StuckAnswer } from '@nexus/factory-domain/production/bundles/where'
import { workingCalendarFor } from '../../../platform/calendars/service'
import { activeHoldsOf } from '../../quality/holds/checks'
import { readCellLabels, type BundleRow, type CellLabel, type Reader } from './store'

/**
 * Where every bundle is and whether it is stuck (B-W2b-41; MES-074, MES-168): the facts factory-domain
 * production/bundles/where.ts needs, read for many bundles at once (one read per table, never one per bundle), as the
 * caller (office reads: the floor role has no grant on the calendars). A bundle's place comes from its scans (the
 * standing reports, its newest scan), the holds on it or its work order, an open rework that travels in it and an open
 * subcontract send; stuck counts the WORKING minutes of its site's calendar (platform/calendars/service) since its last
 * scan, else since it was made, against the site's ProductionSettings.stuckBundleHours.
 */

/** A bundle's work order as the tracking reads it. */
export const TRACK_WORK_ORDER = { id: true, companyId: true, siteId: true, number: true, status: true, styleId: true } as const

export interface TrackOperation {
  readonly id: string
  readonly workOrderId: string
  readonly seq: number
  readonly code: string
  readonly name: string
  readonly scanRequired: boolean
  readonly standardMinutes: number
}

export interface TrackScan {
  readonly id: string
  readonly bundleId: string
  readonly workOrderOperationId: string
  readonly kind: string
  readonly correctsId: string | null
  readonly stationId: string | null
  readonly serverTime: Date
}

export interface Tracked {
  readonly bundle: BundleRow
  readonly workOrder: Prisma.WorkOrderGetPayload<{ select: typeof TRACK_WORK_ORDER }>
  readonly cell: CellLabel | undefined
  readonly style: { readonly id: string; readonly code: string; readonly name: string } | undefined
  readonly operations: readonly TrackOperation[]
  readonly scans: readonly TrackScan[]
  /** The operations it has a standing report at. */
  readonly standing: ReadonlySet<string>
  readonly lastScan: TrackScan | null
  readonly place: PlaceAnswer
  readonly stuck: StuckAnswer
  readonly limitHours: number
  readonly holdIds: readonly string[]
  readonly reworkIds: readonly string[]
  readonly subcontract: { readonly orderId: string; readonly number: string } | null
}

/** The count kinds: the rows a standing report rests on (timing rows of W2b are not counts). */
const COUNT_KINDS = ['REPORT', 'UNDO', 'CORRECTION'] as const

/** REPORT and CORRECTION scans no later UNDO or CORRECTION voids. */
export function standingOf(scans: readonly TrackScan[]): Set<string> {
  const counts = scans.filter((scan) => (COUNT_KINDS as readonly string[]).includes(scan.kind))
  const voided = new Set(counts.flatMap((scan) => (scan.correctsId ? [scan.correctsId] : [])))
  return new Set(counts.filter((scan) => scan.kind !== 'UNDO' && !voided.has(scan.id)).map((scan) => scan.workOrderOperationId))
}

const unique = <T>(values: readonly T[]) => [...new Set(values)]
const SUBCONTRACT_OUT = ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED'] as const

/** Every scan of these bundles, oldest first (any kind). */
export async function scansOf(db: Reader, bundleIds: readonly string[]): Promise<TrackScan[]> {
  if (bundleIds.length === 0) return []
  return db.operationScan.findMany({
    where: { bundleId: { in: [...bundleIds] } },
    select: { id: true, bundleId: true, workOrderOperationId: true, kind: true, correctsId: true, stationId: true, serverTime: true },
    orderBy: [{ serverTime: 'asc' }, { id: 'asc' }],
  })
}

/** The work orders' operations, in routing order. */
export async function operationsOf(db: Reader, workOrderIds: readonly string[]): Promise<TrackOperation[]> {
  if (workOrderIds.length === 0) return []
  const rows = await db.workOrderOperation.findMany({
    where: { workOrderId: { in: [...workOrderIds] } },
    select: { id: true, workOrderId: true, seq: true, code: true, name: true, scanRequired: true, standardMinutes: true },
    orderBy: [{ workOrderId: 'asc' }, { seq: 'asc' }],
  })
  return rows.map((row) => ({ ...row, standardMinutes: Number(row.standardMinutes) }))
}

/** The sites' stuck limits (ProductionSettings.stuckBundleHours; the default where a site has no row). */
export async function stuckLimitsOf(db: Reader, siteIds: readonly string[]): Promise<Map<string, number>> {
  const rows = siteIds.length ? await db.productionSettings.findMany({ where: { id: { in: [...siteIds] } }, select: { id: true, stuckBundleHours: true } }) : []
  const found = new Map(rows.map((row) => [row.id, row.stuckBundleHours]))
  return new Map(siteIds.map((siteId) => [siteId, stuckLimitOf(found.has(siteId) ? { stuckBundleHours: found.get(siteId)! } : null)]))
}

/** The longest wait a stuck count reads back (older: counted from the window's start, stuck anyway after a few days). */
export const STUCK_LOOKBACK_DAYS = 45

/** The working calendar of each site over the window the waits need (the site → company chain). */
async function calendarsOf(db: Reader, waits: ReadonlyMap<string, Date>, now: Date): Promise<Map<string, WorkingCalendar>> {
  const out = new Map<string, WorkingCalendar>()
  for (const [siteId, oldest] of waits) {
    // From the oldest wait's start (a device clock ahead of ours: now), at most the look-back.
    const floor = now.getTime() - STUCK_LOOKBACK_DAYS * 86_400_000
    const from = new Date(Math.min(now.getTime(), Math.max(floor, oldest.getTime())))
    const window = { from: plusDays(businessDate(from, 'UTC'), -2), to: plusDays(businessDate(now, 'UTC'), 1) }
    const loaded = await workingCalendarFor(db as Prisma.TransactionClient, { scope: 'SITE', id: siteId }, window)
    out.set(siteId, loaded.calendar)
  }
  return out
}

/** Working minutes from `since` to `now` on the site's calendar (from the look-back's start at most). */
function waitOf(calendar: WorkingCalendar | undefined, since: Date, now: Date): number {
  if (since >= now) return 0
  if (!calendar) return Math.max(0, (now.getTime() - since.getTime()) / 60_000)
  const floor = new Date(now.getTime() - STUCK_LOOKBACK_DAYS * 86_400_000)
  return workingMinutesBetween(calendar, since < floor ? floor : since, now)
}

/**
 * The tracking facts of these bundles (as the caller sees them; rows of work orders it cannot read are left out).
 * `now`: the instant the waits are counted to.
 */
export async function trackBundles(db: Reader, bundles: readonly BundleRow[], now: Date): Promise<Tracked[]> {
  if (bundles.length === 0) return []
  const bundleIds = bundles.map((bundle) => bundle.id)
  const workOrderIds = unique(bundles.map((bundle) => bundle.workOrderId))
  const workOrders = new Map((await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: TRACK_WORK_ORDER })).map((row) => [row.id, row]))
  const styles = new Map((await db.style.findMany({ where: { id: { in: unique([...workOrders.values()].map((row) => row.styleId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const cells = new Map<string, CellLabel>()
  for (const workOrderId of workOrderIds) for (const [id, label] of await readCellLabels(db, workOrderId)) cells.set(id, label)
  const operations = await operationsOf(db, workOrderIds)
  const scans = await scansOf(db, bundleIds)
  const bundleHolds = await activeHoldsOf(db, 'Bundle', bundleIds)
  const orderHolds = await activeHoldsOf(db, 'WorkOrder', workOrderIds)
  const reworks = await db.reworkOrder.findMany({ where: { bundleId: { in: bundleIds }, status: { in: ['OPEN', 'IN_PROGRESS'] } }, select: { id: true, bundleId: true } })
  const sends = await db.subcontractBundle.findMany({ where: { bundleId: { in: bundleIds } }, select: { bundleId: true, subcontractOrderId: true } })
  const orders = sends.length
    ? new Map((await db.subcontractOrder.findMany({ where: { id: { in: unique(sends.map((send) => send.subcontractOrderId)) }, status: { in: [...SUBCONTRACT_OUT] } }, select: { id: true, number: true } })).map((row) => [row.id, row]))
    : new Map<string, { id: string; number: string }>()
  // A send has come back when a receipt of its order names the bundle (two reads: no relation is selected).
  const receipts = orders.size ? new Map((await db.subcontractReceipt.findMany({ where: { subcontractOrderId: { in: [...orders.keys()] } }, select: { id: true, subcontractOrderId: true } })).map((row) => [row.id, row.subcontractOrderId])) : new Map<string, string>()
  const back = receipts.size
    ? new Set((await db.subcontractReceiptLine.findMany({ where: { bundleId: { in: bundleIds }, receiptId: { in: [...receipts.keys()] } }, select: { bundleId: true, receiptId: true } })).map((line) => `${receipts.get(line.receiptId)}|${line.bundleId}`))
    : new Set<string>()
  const siteIds = unique(bundles.map((bundle) => bundle.siteId))
  const limits = await stuckLimitsOf(db, siteIds)

  const rows = bundles.flatMap((bundle) => {
    const workOrder = workOrders.get(bundle.workOrderId)
    if (!workOrder) return []
    const own = scans.filter((scan) => scan.bundleId === bundle.id)
    const standing = standingOf(own)
    const lastScan = own.at(-1) ?? null
    const send = sends.find((row) => row.bundleId === bundle.id && orders.has(row.subcontractOrderId) && !back.has(`${row.subcontractOrderId}|${row.bundleId}`))
    const holdIds = [...bundleHolds.filter((hold) => hold.subjectIds.includes(bundle.id)), ...orderHolds.filter((hold) => hold.subjectIds.includes(workOrder.id))].map((hold) => hold.id)
    const reworkIds = reworks.filter((row) => row.bundleId === bundle.id).map((row) => row.id)
    const ops = operations.filter((operation) => operation.workOrderId === workOrder.id)
    const place = placeOf({
      status: bundle.status,
      createdAt: bundle.createdAt,
      operations: ops,
      standing,
      lastScan: lastScan ? { at: lastScan.serverTime, operationId: lastScan.workOrderOperationId, stationId: lastScan.stationId } : null,
      held: holdIds.length > 0 || workOrder.status === 'ON_HOLD',
      inRework: reworkIds.length > 0,
      subcontract: send ? { orderId: send.subcontractOrderId, number: orders.get(send.subcontractOrderId)!.number } : null,
    })
    return [{ bundle, workOrder, cell: cells.get(bundle.workOrderSizeId), style: styles.get(workOrder.styleId), operations: ops, scans: own, standing, lastScan, place, holdIds, reworkIds, subcontract: send ? { orderId: send.subcontractOrderId, number: orders.get(send.subcontractOrderId)!.number } : null, limitHours: limits.get(bundle.siteId)! }]
  })
  // The waits, on each site's calendar (only the bundles that can be stuck need one).
  const waits = new Map<string, Date>()
  for (const row of rows) {
    if (row.place.place !== 'CUTTING' && row.place.place !== 'LINE') continue
    const oldest = waits.get(row.bundle.siteId)
    if (!oldest || row.place.since < oldest) waits.set(row.bundle.siteId, row.place.since)
  }
  const calendars = await calendarsOf(db, waits, now)
  return rows.map((row) => {
    const minutes = row.place.place === 'CUTTING' || row.place.place === 'LINE' ? waitOf(calendars.get(row.bundle.siteId), row.place.since, now) : 0
    return { ...row, stuck: stuckOf(row.place.place, minutes, row.limitHours) }
  })
}

/** The stations named by these scans (code, name, line). */
export async function stationsOf(db: Reader, stationIds: readonly (string | null)[]) {
  const ids = unique(stationIds.filter((value): value is string => value !== null))
  if (ids.length === 0) return new Map<string, { id: string; code: string; name: string; lineId: string | null }>()
  return new Map((await db.station.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, lineId: true } })).map((row) => [row.id, row]))
}

const operationRef = (operation: { readonly id: string; readonly seq: number; readonly code: string; readonly name: string } | null) => (operation ? { id: operation.id, seq: operation.seq, code: operation.code, name: operation.name } : null)

/** The place as the answers show it. */
export function placeView(row: Tracked, stations: ReadonlyMap<string, { id: string; code: string; name: string }>) {
  const station = row.lastScan?.stationId ? (stations.get(row.lastScan.stationId) ?? null) : null
  return {
    place: row.place.place,
    qualityReason: row.place.qualityReason,
    operation: operationRef(row.place.operation),
    next: operationRef(row.place.next),
    subcontract: row.subcontract,
    since: toUtcIso(row.place.since),
    lastScan: row.lastScan
      ? { at: toUtcIso(row.lastScan.serverTime), operation: operationRef(row.operations.find((operation) => operation.id === row.lastScan!.workOrderOperationId) ?? null), station: station ? { id: station.id, code: station.code, name: station.name } : null }
      : null,
    stuck: { stuck: row.stuck.stuck, workingHours: row.stuck.hours, limitHours: row.limitHours },
  }
}

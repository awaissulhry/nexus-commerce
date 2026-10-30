import { businessDate, type BusinessDate } from '../../core/time'
import { Dec, type Decimal } from '../../tax/decimal'

/**
 * The daily production report (B-W2a-38; MES-301; design production.reports "Daily production": per line, style and size,
 * good, scrap, rework and line efficiency), pure. The numbers are the floor's own scans: the same standing reports WIP
 * and the line efficiency of B-W2a-16 count (a REPORT or CORRECTION that no later UNDO or CORRECTION voids), of
 * whole-garment bundles (a part bundle holds pieces of one part, not garments: they stay on the work order's Scrap &
 * rework, not here).
 *
 *   lane        where the work was done: the line of the reporting station, else its work centre (a station that
 *               stands alone: the cutting table, the inspection bench). Never a person, never a station on its own.
 *   day         a standing scan counts on the day of the REPORT it stands for (a correction approved later changes that
 *               day, not the day it was approved), in the site's zone, by the time the report reached the server.
 *   good        the garments that passed the lane's LAST operation of the work order that day (the highest scanned
 *               operation of its routing whose work centre is one the lane's stations do): a garment sewn through five
 *               operations of a line is one garment out of the line, not five.
 *   scrap       the garments scrapped at any of the lane's operations that day, and those scrapped when a rework was
 *               finished that day (`extras`: a rework records its outcome on itself, not in a scan).
 *   rework      the garments sent back for rework at any of the lane's operations that day, and the rework opened by hand
 *               that day (`extras`; one opened from a scan is that scan's rework count already).
 *   efficiency  per LINE only: earned standard minutes (the good garments of every standing scan its stations sent that
 *               day × the operation's frozen standard minutes) over the minutes its people were planned to work (people
 *               × the line's working minutes that day, at 100 %), as B-W2a-16's actual line efficiency counts a week.
 *
 * Statuto dei Lavoratori art. 4 (Owner answers W1, F2): a scan's worker is never an input, so no figure can be per
 * person; a station only says which lane the work was on.
 */

export const LANE_KINDS = ['LINE', 'WORK_CENTRE'] as const
export type LaneKind = (typeof LANE_KINDS)[number]

export interface LaneRef {
  readonly kind: LaneKind
  readonly id: string
}

export const laneKey = (lane: LaneRef): string => `${lane.kind}:${lane.id}`

export interface DailyScan {
  readonly id: string
  readonly kind: 'REPORT' | 'UNDO' | 'CORRECTION'
  readonly correctsId: string | null
  readonly bundleId: string
  readonly workOrderId: string
  readonly operationId: string
  readonly good: number
  readonly scrap: number
  readonly rework: number
  readonly stationId: string | null
  /** When it reached the server. */
  readonly at: Date
}

export interface DailyOperation {
  readonly workOrderId: string
  readonly seq: number
  readonly scanRequired: boolean
  readonly workCentreId: string
  /** Per garment, a decimal string. */
  readonly standardMinutes: string
}

/** Garments found at a lane on the day outside any scan: a DONE rework's scrap, rework opened by hand. */
export interface DailyExtra {
  readonly lane: LaneRef
  readonly workOrderId: string
  readonly workOrderSizeId: string
  readonly scrap: number
  readonly rework: number
}

export interface DailyFacts {
  readonly day: BusinessDate
  readonly timeZone: string
  /** Every scan of the site that reached the server from the day's start on, and the older rows their corrections go back to. */
  readonly scans: readonly DailyScan[]
  readonly bundles: ReadonlyMap<string, { readonly part: string | null; readonly status: string; readonly workOrderSizeId: string }>
  readonly operations: ReadonlyMap<string, DailyOperation>
  readonly workOrders: ReadonlyMap<string, { readonly styleId: string }>
  /** Each cell's size label. */
  readonly sizes: ReadonlyMap<string, string>
  /** The lane of each station: its line, else its work centre. */
  readonly stationLanes: ReadonlyMap<string, LaneRef>
  /** The work centres each lane does (a line: those of its stations; a work centre: itself), by laneKey. */
  readonly laneCentres: ReadonlyMap<string, ReadonlySet<string>>
  readonly extras: readonly DailyExtra[]
  /** Per line id: its people per shift (a headcount) and its working minutes that day. */
  readonly available: ReadonlyMap<string, { readonly people: number; readonly workingMinutes: number }>
}

export interface DailyRow {
  readonly styleId: string
  readonly size: string
  readonly good: number
  readonly scrap: number
  readonly rework: number
}

export interface DailyLane {
  readonly lane: LaneRef
  readonly good: number
  readonly scrap: number
  readonly rework: number
  /** LINE only (else null): earned standard minutes, one decimal. */
  readonly earnedMinutes: string | null
  /** LINE only: people × working minutes, one decimal; null for a work centre. */
  readonly availableMinutes: string | null
  /** LINE only: earned over available, percent with one decimal; null when nothing was available (a closed day). */
  readonly efficiencyPct: string | null
  /** Per style and size, by style then size. */
  readonly rows: readonly DailyRow[]
}

export interface DailyReport {
  readonly day: BusinessDate
  /** Lines first, then work centres, each in the order of `laneOrder` (else by key). */
  readonly lanes: readonly DailyLane[]
  readonly totals: { readonly good: number; readonly scrap: number; readonly rework: number }
}

/** The scans that stand (no later UNDO or CORRECTION voids them) and are not UNDO rows. */
export function standingScans<T extends Pick<DailyScan, 'id' | 'kind' | 'correctsId'>>(scans: readonly T[]): T[] {
  const voided = new Set(scans.flatMap((scan) => (scan.correctsId ? [scan.correctsId] : [])))
  return scans.filter((scan) => scan.kind !== 'UNDO' && !voided.has(scan.id))
}

/** The REPORT a scan stands for (a CORRECTION goes back along correctsId); itself when the chain is not all read. */
export function rootOf<T extends Pick<DailyScan, 'id' | 'kind' | 'correctsId'>>(scan: T, byId: ReadonlyMap<string, T>): T {
  let current = scan
  const seen = new Set<string>()
  while (current.kind === 'CORRECTION' && current.correctsId && !seen.has(current.id)) {
    seen.add(current.id)
    const previous = byId.get(current.correctsId)
    if (!previous) break
    current = previous
  }
  return current
}

/** The ids the corrections among `scans` go back to that are not read yet (the API reads them, then asks again). */
export function missingRoots(scans: readonly Pick<DailyScan, 'id' | 'kind' | 'correctsId'>[]): string[] {
  const ids = new Set(scans.map((scan) => scan.id))
  return [...new Set(scans.flatMap((scan) => (scan.kind === 'CORRECTION' && scan.correctsId && !ids.has(scan.correctsId) ? [scan.correctsId] : [])))]
}

/** The lane's last operation of a work order: its highest scanned operation done at one of the lane's work centres. */
export function lastOperationOf(operations: readonly (DailyOperation & { readonly id: string })[], centres: ReadonlySet<string> | undefined): string | null {
  if (!centres || centres.size === 0) return null
  let best: (DailyOperation & { readonly id: string }) | null = null
  for (const operation of operations) {
    if (!operation.scanRequired || !centres.has(operation.workCentreId)) continue
    if (!best || operation.seq > best.seq) best = operation
  }
  return best?.id ?? null
}

const pctOf = (earned: Decimal, available: Decimal): string | null => (available.gt(0) ? earned.div(available).times(100).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1) : null)
const minutes = (value: Decimal): string => value.toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1)

/** The day's report (see the module comment). `laneOrder`: laneKeys in the order to list them (lines first). */
export function dailyReport(facts: DailyFacts, laneOrder: readonly string[] = []): DailyReport {
  const byId = new Map(facts.scans.map((scan) => [scan.id, scan]))
  const opsOfWorkOrder = new Map<string, (DailyOperation & { id: string })[]>()
  for (const [id, operation] of facts.operations) {
    const list = opsOfWorkOrder.get(operation.workOrderId) ?? []
    list.push({ ...operation, id })
    opsOfWorkOrder.set(operation.workOrderId, list)
  }
  const lastOps = new Map<string, string | null>()
  const lastOperation = (lane: LaneRef, workOrderId: string): string | null => {
    const key = `${laneKey(lane)}|${workOrderId}`
    if (!lastOps.has(key)) lastOps.set(key, lastOperationOf(opsOfWorkOrder.get(workOrderId) ?? [], facts.laneCentres.get(laneKey(lane))))
    return lastOps.get(key)!
  }

  interface Acc {
    lane: LaneRef
    good: number
    scrap: number
    rework: number
    earned: Decimal
    rows: Map<string, { styleId: string; size: string; good: number; scrap: number; rework: number }>
  }
  const lanes = new Map<string, Acc>()
  const accOf = (lane: LaneRef): Acc => {
    const key = laneKey(lane)
    let acc = lanes.get(key)
    if (!acc) {
      acc = { lane, good: 0, scrap: 0, rework: 0, earned: new Dec(0), rows: new Map() }
      lanes.set(key, acc)
    }
    return acc
  }
  const rowOf = (acc: Acc, workOrderId: string, workOrderSizeId: string) => {
    const styleId = facts.workOrders.get(workOrderId)?.styleId ?? ''
    const size = facts.sizes.get(workOrderSizeId) ?? ''
    const key = `${styleId}|${size}`
    let row = acc.rows.get(key)
    if (!row) {
      row = { styleId, size, good: 0, scrap: 0, rework: 0 }
      acc.rows.set(key, row)
    }
    return row
  }

  for (const scan of standingScans(facts.scans)) {
    if (scan.stationId === null) continue
    const lane = facts.stationLanes.get(scan.stationId)
    const bundle = facts.bundles.get(scan.bundleId)
    const operation = facts.operations.get(scan.operationId)
    if (!lane || !bundle || !operation || bundle.part !== null || bundle.status !== 'ACTIVE') continue
    if (businessDate(rootOf(scan, byId).at, facts.timeZone) !== facts.day) continue
    const acc = accOf(lane)
    const row = rowOf(acc, scan.workOrderId, bundle.workOrderSizeId)
    const good = Math.max(0, scan.good)
    if (lastOperation(lane, scan.workOrderId) === scan.operationId) {
      acc.good += good
      row.good += good
    }
    acc.scrap += Math.max(0, scan.scrap)
    row.scrap += Math.max(0, scan.scrap)
    acc.rework += Math.max(0, scan.rework)
    row.rework += Math.max(0, scan.rework)
    if (lane.kind === 'LINE' && good > 0) acc.earned = acc.earned.plus(new Dec(operation.standardMinutes).times(good))
  }
  for (const extra of facts.extras) {
    if (extra.scrap <= 0 && extra.rework <= 0) continue
    const acc = accOf(extra.lane)
    const row = rowOf(acc, extra.workOrderId, extra.workOrderSizeId)
    acc.scrap += Math.max(0, extra.scrap)
    row.scrap += Math.max(0, extra.scrap)
    acc.rework += Math.max(0, extra.rework)
    row.rework += Math.max(0, extra.rework)
  }
  // A line with nothing reported still has its efficiency (0 %) when its people were planned to work.
  for (const [lineId, setup] of facts.available) if (setup.people > 0 && setup.workingMinutes > 0) accOf({ kind: 'LINE', id: lineId })

  const order = new Map(laneOrder.map((key, index) => [key, index]))
  const sorted = [...lanes.entries()].sort(([a, x], [b, y]) => {
    if (x.lane.kind !== y.lane.kind) return x.lane.kind === 'LINE' ? -1 : 1
    const ia = order.get(a) ?? Number.MAX_SAFE_INTEGER
    const ib = order.get(b) ?? Number.MAX_SAFE_INTEGER
    return ia !== ib ? ia - ib : a < b ? -1 : a > b ? 1 : 0
  })
  const out: DailyLane[] = sorted.map(([, acc]) => {
    const setup = acc.lane.kind === 'LINE' ? facts.available.get(acc.lane.id) : undefined
    const available = setup ? new Dec(setup.workingMinutes).times(setup.people) : null
    return {
      lane: acc.lane,
      good: acc.good,
      scrap: acc.scrap,
      rework: acc.rework,
      earnedMinutes: acc.lane.kind === 'LINE' ? minutes(acc.earned) : null,
      availableMinutes: available ? minutes(available) : null,
      efficiencyPct: available ? pctOf(acc.earned, available) : null,
      rows: [...acc.rows.values()]
        .filter((row) => row.good + row.scrap + row.rework > 0)
        .sort((a, b) => (a.styleId !== b.styleId ? (a.styleId < b.styleId ? -1 : 1) : a.size.localeCompare(b.size, 'en', { numeric: true }))),
    }
  })
  return {
    day: facts.day,
    lanes: out,
    totals: out.reduce((sum, lane) => ({ good: sum.good + lane.good, scrap: sum.scrap + lane.scrap, rework: sum.rework + lane.rework }), { good: 0, scrap: 0, rework: 0 }),
  }
}

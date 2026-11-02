import { businessDayRange, businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { dispatchState, type DispatchState } from '@nexus/factory-domain/planning/schedule/dispatch'
import { liveGarments } from '@nexus/factory-domain/production/bundles/split'
import { materialFlagOf, type MaterialFlag } from '@nexus/factory-domain/production/dispatch/material'
import { placementsOf, REST_CARD, sequenceOf, type SequenceState } from '@nexus/factory-domain/production/dispatch/rules'
import { SCAN_KINDS, standingKey, standingScans, type ScanFact } from '@nexus/factory-domain/production/scans/rules'
import type { Wip } from '@nexus/factory-domain/production/scans/wip'
import type { FloorRuleMode } from '@nexus/factory-domain/production/settings/floor-rules'
import type { ScanSubject } from '@nexus/factory-domain/production/settings/monitoring'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { Prisma } from '@nexus/factory-db'
import { wipForMany } from '../../planning/capacity/wip'
import { readinessFor } from '../../planning/readiness/service'
import { floorVersionsOf, slotsOf, type PlanRow, type SlotRow } from '../../planning/schedule/store'
import type { SiteRow } from '../../planning/store'
import { SCAN_COLUMNS } from '../scans/store'
import { floorChecksFor } from '../settings/floor-rules'
import { scanSubjectFor } from '../settings/subject'
import { activeStationsOf, assignmentsOf, dayOf, type AssignmentRow, type Reader, type StationRow } from './store'

/**
 * A site's day on the dispatch board (B-W2b-49; MES-023, -025, -027; design production.dispatch "Board", "Not assigned"):
 * what the published plan (Owner answer P3) queues up to the end of the day, plus whatever the day's assignments name,
 * less what is done, cut into cards by where the assignments put it. THE read of the board, the printed list, My work and
 * the W2a lists on a day the board changed. Pass your own client; no permission is checked here. One query after another.
 *
 *   a card      one placement of an operation (factory-domain production/dispatch/rules), or what has no place yet (key
 *               REST): its pieces and standard minutes still to do, where the work stands, the site's sequence rule on it
 *   pieces      the garments the plan puts on the operation less those done there (good + scrapped), from the floor's
 *               scans; bundles named on a row take their live garments, the rest is the rest
 *
 * No person is read here but the rows' ids; no money.
 */

export const WORK_ORDER_SELECT = {
  id: true,
  siteId: true,
  number: true,
  status: true,
  priority: true,
  rush: true,
  dueDate: true,
  holdReason: true,
  style: { select: { code: true, name: true } },
  sizes: { select: { quantity: true } },
  operations: { select: { id: true, seq: true, code: true, name: true, workCentreId: true, standardMinutes: true }, orderBy: { seq: 'asc' } },
} as const satisfies Prisma.WorkOrderSelect
export type WorkOrderRow = Prisma.WorkOrderGetPayload<{ select: typeof WORK_ORDER_SELECT }>
export type OperationOfOrder = WorkOrderRow['operations'][number]

/** One operation a published plan puts on a lane. */
export interface PlannedOperation {
  readonly slot: SlotRow
  readonly workOrder: WorkOrderRow
  readonly operation: OperationOfOrder
  readonly garments: number
  readonly lineId: string | null
  readonly workCentreId: string | null
}

/**
 * What the slots of a plan put where (B-W2a-34): a bar is its operation on its line or work centre; a work order (or part
 * of one) placed whole on a line is the operations the line does that have no bar of their own.
 */
export function plannedOperations(slots: readonly SlotRow[], workOrders: readonly WorkOrderRow[], stations: readonly Pick<StationRow, 'lineId' | 'workCentreId'>[]): PlannedOperation[] {
  const byId = new Map(workOrders.map((workOrder) => [workOrder.id, workOrder]))
  const lineDoes = (lineId: string) => {
    const own = stations.filter((station) => station.lineId === lineId).map((station) => station.workCentreId)
    return own.length > 0 ? new Set(own) : null
  }
  const out: PlannedOperation[] = []
  for (const slot of slots) {
    const workOrder = byId.get(slot.workOrderId)
    if (!workOrder) continue
    const garments = workOrder.sizes.reduce((sum, size) => sum + size.quantity, 0)
    if (slot.workOrderOperationId) {
      const operation = workOrder.operations.find((candidate) => candidate.id === slot.workOrderOperationId)
      if (operation) out.push({ slot, workOrder, operation, garments, lineId: slot.lineId, workCentreId: slot.workCentreId })
      continue
    }
    if (slot.lineId === null) continue
    const does = lineDoes(slot.lineId)
    for (const operation of workOrder.operations) {
      if (does !== null && !does.has(operation.workCentreId)) continue
      if (slots.some((other) => other.workOrderId === workOrder.id && other.workOrderOperationId === operation.id)) continue
      out.push({ slot, workOrder, operation, garments: slot.pieces ?? garments, lineId: slot.lineId, workCentreId: null })
    }
  }
  return out
}

export interface DayCard {
  /** Stable while the card stays: the operation, the placement and, for what has no place, the line. */
  readonly id: string
  /** What a move names as `from`. */
  readonly key: string
  readonly workOrder: WorkOrderRow
  readonly operation: OperationOfOrder
  readonly previous: OperationOfOrder | null
  readonly slot: Pick<SlotRow, 'id' | 'startAt' | 'endAt'> | null
  readonly stationId: string | null
  readonly lineId: string | null
  /** The plan's work centre lane, for what has no station. */
  readonly workCentreId: string | null
  readonly bundleIds: readonly string[]
  readonly whole: boolean
  readonly pieces: number
  readonly minutes: string
  readonly state: DispatchState
  readonly words: string
  readonly arrived: number
  readonly waiting: number
  readonly sequence: { readonly rule: FloorRuleMode; readonly state: SequenceState; readonly words: string | null }
  /** The rows behind it (none: it has no place). */
  readonly rows: readonly AssignmentRow[]
  /** The lane's order; null: the plan's. */
  readonly order: number | null
  /** It counts in the line's load: released work, not on hold. */
  readonly counted: boolean
}

export interface BundleOfDay {
  readonly id: string
  readonly code: string
  readonly workOrderId: string
  readonly garments: number
}

export interface DispatchWorld {
  readonly site: SiteRow
  readonly day: BusinessDate
  readonly today: BusinessDate
  readonly now: Date
  readonly start: Date
  readonly end: Date
  readonly plan: PlanRow | null
  readonly upcoming: PlanRow | null
  readonly rows: readonly AssignmentRow[]
  readonly stations: readonly StationRow[]
  readonly cards: readonly DayCard[]
  readonly bundles: ReadonlyMap<string, BundleOfDay>
  readonly sequenceRule: FloorRuleMode
  readonly subject: ScanSubject
}

/** The operations' open bundles: ACTIVE, with no standing report there; live garments each. */
export interface BundleFlows {
  readonly bundlesOf: (workOrderId: string) => readonly BundleOfDay[]
  readonly reported: (bundleId: string, operationId: string) => boolean
}

export async function bundleFlows(db: Reader, workOrderIds: readonly string[]): Promise<BundleFlows> {
  const ids = [...new Set(workOrderIds)]
  if (ids.length === 0) return { bundlesOf: () => [], reported: () => false }
  const rows = await db.bundle.findMany({ where: { workOrderId: { in: ids } }, select: { id: true, code: true, workOrderId: true, quantity: true, status: true, parentBundleId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const scans = (await db.operationScan.findMany({ where: { workOrderId: { in: ids }, kind: { in: [...SCAN_KINDS] } }, select: SCAN_COLUMNS, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }] })) as unknown as ScanFact[]
  const standing = standingScans(scans)
  const children = new Map<string, { quantity: number; status: 'ACTIVE' | 'VOID' }[]>()
  for (const row of rows) if (row.parentBundleId) children.set(row.parentBundleId, [...(children.get(row.parentBundleId) ?? []), { quantity: row.quantity, status: row.status as 'ACTIVE' | 'VOID' }])
  const active = rows.filter((row) => row.status === 'ACTIVE').map((row): BundleOfDay => ({ id: row.id, code: row.code, workOrderId: row.workOrderId, garments: liveGarments(row.quantity, children.get(row.id) ?? []) }))
  const byOrder = new Map<string, BundleOfDay[]>()
  for (const bundle of active) byOrder.set(bundle.workOrderId, [...(byOrder.get(bundle.workOrderId) ?? []), bundle])
  return { bundlesOf: (workOrderId) => byOrder.get(workOrderId) ?? [], reported: (bundleId, operationId) => standing.has(standingKey(bundleId, operationId)) }
}

const COUNTED_STATUSES: readonly string[] = ['RELEASED', 'IN_PROGRESS']
const ENDED_STATUSES: readonly string[] = ['COMPLETED', 'CLOSED', 'CANCELLED']

function cardsOfOperation(input: {
  readonly workOrder: WorkOrderRow
  readonly operation: OperationOfOrder
  readonly rows: readonly AssignmentRow[]
  readonly planned: readonly PlannedOperation[]
  readonly wip: Wip | undefined
  readonly flows: BundleFlows
  readonly sequenceRule: FloorRuleMode
}): DayCard[] {
  const { workOrder, operation, rows, planned, wip, flows, sequenceRule } = input
  const total = workOrder.sizes.reduce((sum, size) => sum + size.quantity, 0)
  const garments = planned.length > 0 ? Math.min(total, planned.reduce((sum, entry) => sum + entry.garments, 0)) : total
  const flow = wip?.operations.find((row) => row.operationId === operation.id)
  let left = Math.max(0, garments - ((flow?.good ?? 0) + (flow?.scrap ?? 0)))
  if (left === 0) return []
  const open = flows.bundlesOf(workOrder.id).filter((bundle) => !flows.reported(bundle.id, operation.id))
  const placements = placementsOf(rows, open.map((bundle) => bundle.id))
  const previous = [...workOrder.operations].reverse().find((candidate) => candidate.seq < operation.seq) ?? null
  const standard = new Dec(operation.standardMinutes.toString())
  const slotOf = (entry: PlannedOperation | undefined) => (entry ? { id: entry.slot.id, startAt: entry.slot.startAt, endAt: entry.slot.endAt } : null)
  const cardOf = (fields: { key: string; pieces: number; bundleIds: readonly string[]; whole: boolean; stationId: string | null; lineId: string | null; workCentreId: string | null; rows: readonly AssignmentRow[]; order: number | null; slot: DayCard['slot'] }): DayCard => {
    const waiting = Math.min(flow?.waiting ?? 0, fields.pieces)
    const state = dispatchState({ workOrderNumber: workOrder.number, workOrderStatus: workOrder.status, holdReason: workOrder.holdReason, operation: { seq: operation.seq, name: operation.name }, previous: previous ? { seq: previous.seq, name: previous.name } : null, garments: fields.pieces, arrived: flow?.arrived ?? 0, waiting, done: 0 })
    return {
      ...fields,
      id: `${operation.id}:${fields.key}${fields.key === REST_CARD ? `:${fields.lineId ?? fields.workCentreId ?? ''}` : ''}`,
      workOrder,
      operation,
      previous,
      minutes: standard.times(fields.pieces).toFixed(1),
      state: state.state,
      words: state.words,
      arrived: flow?.arrived ?? 0,
      waiting,
      sequence: sequenceOf(sequenceRule, { operation: { seq: operation.seq, name: operation.name }, previous: previous ? { seq: previous.seq, name: previous.name } : null, waiting: state.state === 'WAITING_FOR_PREVIOUS' }),
      counted: COUNTED_STATUSES.includes(workOrder.status),
    }
  }
  const cards: DayCard[] = []
  const garmentsOf = new Map(open.map((bundle) => [bundle.id, bundle.garments]))
  // By name first: what the rest holds is what is left after them.
  for (const placement of [...placements.placements].sort((a, b) => Number(a.whole) - Number(b.whole))) {
    const named = placement.whole ? left : Math.min(left, placement.bundleIds.reduce((sum, id) => sum + (garmentsOf.get(id) ?? 0), 0))
    if (named <= 0) continue
    left -= named
    cards.push(cardOf({ key: placement.key, pieces: named, bundleIds: placement.bundleIds, whole: placement.whole, stationId: placement.stationId, lineId: placement.lineId, workCentreId: null, rows: placement.rows, order: placement.sequence, slot: slotOf(planned[0]) }))
  }
  // What nothing holds: the rest of the bundles and the garments not in a bundle yet, on the lane the plan put them.
  for (const entry of planned) {
    if (left <= 0) break
    const pieces = Math.min(left, entry.garments)
    left -= pieces
    cards.push(cardOf({ key: REST_CARD, pieces, bundleIds: placements.rest, whole: false, stationId: null, lineId: entry.lineId, workCentreId: entry.workCentreId, rows: [], order: null, slot: slotOf(entry) }))
  }
  return cards
}

export async function dispatchWorld(db: Reader, site: SiteRow, day: BusinessDate, now: Date): Promise<DispatchWorld> {
  const today = businessDate(now, site.timezone)
  const { start, end } = businessDayRange(day, site.timezone)
  const { current, upcoming } = await floorVersionsOf(db, site.id, now)
  const plan = day > today && upcoming?.effectiveFrom && upcoming.effectiveFrom < end ? upcoming : current
  const slots = plan ? (await slotsOf(db, plan.id)).filter((slot) => slot.startAt < end) : []
  const rows = await assignmentsOf(db, site.id, day)
  const workOrderIds = [...new Set([...slots.map((slot) => slot.workOrderId), ...rows.flatMap((row) => (row.workOrderId ? [row.workOrderId] : []))])]
  const workOrders = workOrderIds.length > 0 ? await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: WORK_ORDER_SELECT }) : []
  const stations = await activeStationsOf(db, site.id)
  const planned = plannedOperations(slots, workOrders, stations)
  const wips = await wipForMany(db, workOrderIds)
  const flows = await bundleFlows(db, workOrderIds)
  const sequenceRule = (await floorChecksFor(db, site.id)).skippedOperationRule
  const subject = await scanSubjectFor(db, site.id)
  const cards: DayCard[] = []
  // A work order that ended leaves the board, whatever a row of the day still says about it.
  for (const workOrder of workOrders.filter((row) => !ENDED_STATUSES.includes(row.status))) {
    for (const operation of workOrder.operations) {
      const opRows = rows.filter((row) => row.workOrderOperationId === operation.id)
      const opPlanned = planned.filter((entry) => entry.operation.id === operation.id).sort((a, b) => a.slot.startAt.getTime() - b.slot.startAt.getTime())
      if (opRows.length === 0 && opPlanned.length === 0) continue
      cards.push(...cardsOfOperation({ workOrder, operation, rows: opRows, planned: opPlanned, wip: wips.get(workOrder.id), flows, sequenceRule }))
    }
  }
  const bundles = new Map(workOrderIds.flatMap((id) => flows.bundlesOf(id)).map((bundle) => [bundle.id, bundle]))
  return { site, day, today, now, start, end, plan, upcoming, rows, stations, cards, bundles, sequenceRule, subject }
}

export interface CardTarget {
  readonly kind: 'LINE' | 'WORK_CENTRE' | 'STATION'
  readonly id: string
  readonly lineId: string | null
  readonly workCentreId: string | null
}

/** A card of the day at this target: at its station when it has one, else where the plan put it. */
export function cardAt(card: DayCard, target: CardTarget, stations: readonly Pick<StationRow, 'id' | 'lineId' | 'workCentreId'>[]): boolean {
  if (card.stationId) {
    const station = stations.find((row) => row.id === card.stationId)
    if (!station) return false
    return target.kind === 'STATION' ? station.id === target.id : target.kind === 'LINE' ? station.lineId === target.id : station.workCentreId === target.id
  }
  if (target.kind === 'LINE') return card.lineId === target.id
  if (target.kind === 'WORK_CENTRE') return card.workCentreId === target.id
  return (card.lineId !== null && card.lineId === target.lineId && card.operation.workCentreId === target.workCentreId) || (card.workCentreId !== null && card.workCentreId === target.workCentreId)
}

export const dueOf = (card: Pick<DayCard, 'workOrder'>): BusinessDate | null => (card.workOrder.dueDate ? dayOf(card.workOrder.dueDate) : null)

export const planView = (version: PlanRow) => ({
  id: version.id,
  number: version.number!,
  coversFrom: dayOf(version.coversFrom!),
  coversTo: dayOf(version.coversTo!),
  effectiveFrom: toUtcIso(version.effectiveFrom!),
  publishedAt: toUtcIso(version.publishedAt!),
})

/**
 * The material flag of these work orders from the plan computed now (planning/readiness; one netting of the site, however
 * many work orders). Read with the office's client or, for the floor, the system view: the floor reads no planning table.
 */
export async function materialFlags(db: Reader, site: SiteRow, workOrderIds: readonly string[]): Promise<Map<string, MaterialFlag>> {
  const ids = [...new Set(workOrderIds)]
  if (ids.length === 0) return new Map()
  const answers = await readinessFor(db, site, ids)
  return new Map(answers.map((answer) => [answer.workOrderId, materialFlagOf(answer.word, answer.date)]))
}

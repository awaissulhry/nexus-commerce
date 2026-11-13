import type { Prisma } from '@nexus/factory-db'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { Bucket } from '@nexus/factory-domain/planning/settings/buckets'
import {
  amountText,
  capacityOver,
  daysBetween,
  jobAmount,
  keysOf,
  loadPctOf,
  outsideWorkOf,
  spreadJob,
  type CapacityKey,
  type CapacityRow,
  type CapacityUnit,
  type WorkshopJob,
} from '@nexus/factory-domain/planning/subcontract-capacity/rules'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { supplierClosedDaysFor } from '../../../platform/calendars/service'
import { workshopsOf, workingPlanOf, type WorkshopRow } from '../schedule/store'
import { dayOf, type Reader, type SiteRow } from '../store'
// B-W2b-365: a planned subcontract order books its workshop for the cells each step it sends is for.
import { demandOf } from '@nexus/factory-domain/planning/planned-orders/rules'
import { garmentsOf, STEP_VARIANT_COLUMNS } from '../capacity/steps'
import { cellsOfDemand, lineOptionsOf } from '../planned-orders/steps'

/**
 * What work to subcontractors reads (B-W2b-321), one query after another on the caller's client. No permission is checked
 * here (the routes check their own). Every read names its columns.
 *
 *   capacity rows  SubcontractorCapacity of the workshops (tenant-wide: a workshop is a party)
 *   jobs           the work at the site's workshops: live subcontract orders (DRAFT to PARTLY_RECEIVED: the pieces still
 *                  to come back), the allocation board's parts at a workshop of released or running work orders (the
 *                  garments no live order of that work order at that workshop carries yet), and the plan's planned
 *                  subcontract orders (PROPOSED: shown apart, never in the load %). What is left is spread from today
 *                  (or later) to the day it is due back; a late job lands on today.
 *   lines          per workshop and capacity row kind, per bucket: available (its weekly capacity over its open
 *                  weekdays), booked, proposed, load %; a workshop with no row is one line of unknown capacity
 */

export const CAPACITY_COLUMNS = { id: true, partyId: true, workCentreKind: true, unit: true, perWeek: true, validFrom: true, validTo: true, note: true, version: true, createdAt: true, updatedAt: true } as const satisfies Prisma.SubcontractorCapacitySelect
export type CapacityDbRow = Prisma.SubcontractorCapacityGetPayload<{ select: typeof CAPACITY_COLUMNS }>

export const capacityRowOf = (row: Pick<CapacityDbRow, 'id' | 'partyId' | 'workCentreKind' | 'unit' | 'perWeek' | 'validFrom' | 'validTo'>): CapacityRow => ({
  id: row.id,
  partyId: row.partyId,
  workCentreKind: row.workCentreKind,
  unit: row.unit as CapacityUnit,
  perWeek: row.perWeek,
  validFrom: dayOf(row.validFrom),
  validTo: row.validTo ? dayOf(row.validTo) : null,
})

export const readCapacityRows = (db: Reader, partyIds: readonly string[]): Promise<CapacityDbRow[]> =>
  partyIds.length === 0 ? Promise.resolve([]) : db.subcontractorCapacity.findMany({ where: { partyId: { in: [...partyIds] } }, select: CAPACITY_COLUMNS, orderBy: [{ partyId: 'asc' }, { validFrom: 'asc' }, { id: 'asc' }] })

const LIVE_ORDERS = ['DRAFT', 'ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED'] as const
const BOOKING = ['RELEASED', 'IN_PROGRESS'] as const

/** A job with what the cell's detail shows. */
export interface Job extends WorkshopJob {
  readonly number: string | null
  readonly status: string
  readonly workOrderNumber: string | null
  readonly style: string | null
  readonly proposed: boolean
}

const later = (a: BusinessDate, b: BusinessDate): BusinessDate => (a > b ? a : b)

/** The work at the site's workshops (see above). */
export async function readJobs(db: Reader, site: SiteRow, today: BusinessDate): Promise<Job[]> {
  const jobs: Job[] = []
  const orders = await db.subcontractOrder.findMany({
    where: { siteId: site.id, status: { in: [...LIVE_ORDERS] } },
    select: {
      id: true,
      number: true,
      status: true,
      partyId: true,
      orderDate: true,
      expectedBackDate: true,
      kitDueAt: true,
      workOrderId: true,
      workOrder: { select: { number: true, style: { select: { code: true } } } },
      operations: { select: { pieces: true, piecesBackGood: true, piecesBackDefective: true, piecesScrapped: true, expectedBackDate: true, workOrderOperation: { select: { standardMinutes: true, workCentre: { select: { kind: true } } } } } },
    },
    orderBy: [{ orderDate: 'asc' }, { id: 'asc' }],
  })
  const ordered = new Map<string, number>()
  for (const order of orders) {
    const left = order.operations.map((operation) => ({ ...operation, left: Math.max(0, operation.pieces - operation.piecesBackGood - operation.piecesBackDefective - operation.piecesScrapped) }))
    const key = `${order.workOrderId}|${order.partyId}`
    ordered.set(key, Math.max(ordered.get(key) ?? 0, ...order.operations.map((operation) => operation.pieces)))
    const garments = Math.max(0, ...left.map((operation) => operation.left))
    if (garments === 0) continue
    const start = order.kitDueAt ? businessDate(order.kitDueAt, site.timezone) : dayOf(order.orderDate)
    const back = [order.expectedBackDate, ...order.operations.map((operation) => operation.expectedBackDate)].filter((date): date is Date => date !== null).map(dayOf).sort().pop() ?? start
    const from = later(start, today)
    jobs.push({
      kind: 'ORDER',
      id: order.id,
      partyId: order.partyId,
      workOrderId: order.workOrderId,
      from,
      to: later(back, from),
      garments,
      operations: left.filter((operation) => operation.left > 0).map((operation) => ({ workCentreKind: operation.workOrderOperation.workCentre.kind, minutes: new Dec(operation.workOrderOperation.standardMinutes.toString()).times(operation.left).toFixed(3) })),
      number: order.number,
      status: order.status,
      workOrderNumber: order.workOrder.number,
      style: order.workOrder.style.code,
      proposed: false,
    })
  }
  // The allocation board's parts at a workshop.
  const plan = await workingPlanOf(db, site.id)
  const slots = plan ? await db.scheduleSlot.findMany({ where: { planVersionId: plan.id, partyId: { not: null }, workOrderOperationId: null }, select: { id: true, workOrderId: true, partyId: true, pieces: true, startAt: true, endAt: true }, orderBy: [{ startAt: 'asc' }, { id: 'asc' }] }) : []
  const workOrders = await readWorkOrderOperations(db, [...new Set(slots.map((slot) => slot.workOrderId))])
  for (const slot of slots) {
    const workOrder = workOrders.get(slot.workOrderId)
    if (!workOrder || !(BOOKING as readonly string[]).includes(workOrder.status)) continue
    const garments = Math.max(0, (slot.pieces ?? workOrder.garments) - (ordered.get(`${slot.workOrderId}|${slot.partyId}`) ?? 0))
    if (garments === 0) continue
    const sent = outsideWorkOf(workOrder.operations)
    const from = later(businessDate(slot.startAt, site.timezone), today)
    jobs.push({
      kind: 'ALLOCATION',
      id: slot.id,
      partyId: slot.partyId!,
      workOrderId: slot.workOrderId,
      from,
      to: later(businessDate(new Date(slot.endAt.getTime() - 1), site.timezone), from),
      garments,
      operations: sent.map((operation) => ({ workCentreKind: operation.workCentreKind, minutes: new Dec(operation.standardMinutes).times(garments).toFixed(3) })),
      number: null,
      status: workOrder.status,
      workOrderNumber: workOrder.number,
      style: workOrder.style,
      proposed: false,
    })
  }
  // The plan's planned subcontract orders: proposed.
  const planned = await db.plannedWorkOrder.findMany({ where: { siteId: site.id, status: 'PLANNED', kind: 'SUBCONTRACT', partyId: { not: null } }, select: { id: true, partyId: true, styleId: true, styleRevisionId: true, quantity: true, startDate: true, dueDate: true, kitDueAt: true, operationSeqs: true, style: { select: { code: true } }, /* B-W2b-365 */ colourwayId: true, demand: true }, orderBy: [{ startDate: 'asc' }, { id: 'asc' }] })
  if (planned.length > 0) {
    // The revision it names, else the style's RELEASED one, else its newest (a draft's routing still says what goes out).
    const revisions = await db.styleRevision.findMany({ where: { styleId: { in: [...new Set(planned.map((row) => row.styleId))] }, status: { in: ['RELEASED', 'DRAFT'] } }, select: { id: true, styleId: true, status: true, revision: true }, orderBy: [{ revision: 'desc' }, { id: 'asc' }] })
    const revisionOf = (row: (typeof planned)[number]) => row.styleRevisionId ?? (revisions.find((revision) => revision.styleId === row.styleId && revision.status === 'RELEASED') ?? revisions.find((revision) => revision.styleId === row.styleId))?.id ?? null
    const revisionIds = [...new Set(planned.map(revisionOf).filter((id): id is string => id !== null))]
    const steps = revisionIds.length === 0 ? [] : await db.routingOperation.findMany({ where: { revisionId: { in: revisionIds } }, select: { revisionId: true, seq: true, workCentreKind: true, standardMinutes: true, /* B-W2b-365 */ ...STEP_VARIANT_COLUMNS } })
    const options = await lineOptionsOf(db, planned.flatMap((row) => demandOf(row.demand).map((entry) => entry.orderLineId)))
    for (const row of planned) {
      const revisionId = revisionOf(row)
      // B-W2b-365: each step for the garments of the cells it is for (the demand's sizes; a row with no demand: its quantity).
      const demand = demandOf(row.demand)
      const cells = cellsOfDemand(row.colourwayId, demand, options).map((cell, index) => ({ ...cell, quantity: demand[index]!.pieces }))
      const garmentsAt = (step: (typeof steps)[number]) => (cells.length === 0 ? row.quantity : garmentsOf(step, cells))
      const sent = steps.filter((step) => step.revisionId === revisionId && row.operationSeqs.includes(step.seq) && garmentsAt(step) > 0)
      const start = row.kitDueAt ? businessDate(row.kitDueAt, site.timezone) : dayOf(row.startDate)
      const from = later(start, today)
      jobs.push({
        kind: 'PLANNED',
        id: row.id,
        partyId: row.partyId!,
        workOrderId: null,
        from,
        to: later(dayOf(row.dueDate), from),
        garments: row.quantity,
        operations: sent.map((step) => ({ workCentreKind: step.workCentreKind, minutes: new Dec(step.standardMinutes.toString()).times(garmentsAt(step)).toFixed(3) })),
        number: null,
        status: 'PLANNED',
        workOrderNumber: null,
        style: row.style.code,
        proposed: true,
      })
    }
  }
  return jobs
}

export interface WorkOrderOperations {
  readonly id: string
  readonly companyId: string
  readonly siteId: string
  readonly number: string
  readonly status: string
  readonly version: number
  readonly style: string
  readonly garments: number
  readonly operations: readonly {
    readonly id: string
    readonly seq: number
    readonly code: string
    readonly name: string
    readonly workCentreKind: string
    readonly operationId: string | null
    readonly standardMinutes: string
    readonly outsourced: boolean
    readonly subcontractOrderId: string | null
    readonly outsideStep: boolean
    readonly outsidePartyId: string | null
    readonly routingDays: number | null
    readonly remaining: number
    readonly version: number
  }[]
}

/** Work orders with their planned operations: kind, the library operation, outside or not, and the routing step's workshop. */
export async function readWorkOrderOperations(db: Reader, ids: readonly string[]): Promise<Map<string, WorkOrderOperations>> {
  const wanted = ids.filter(isUuid)
  if (wanted.length === 0) return new Map()
  const rows = await db.workOrder.findMany({
    where: { id: { in: wanted } },
    select: {
      id: true,
      companyId: true,
      siteId: true,
      number: true,
      status: true,
      version: true,
      style: { select: { code: true } },
      sizes: { select: { quantity: true } },
      operations: {
        where: { routingSeq: { not: null } },
        select: { id: true, seq: true, code: true, name: true, standardMinutes: true, outsourced: true, subcontractOrderId: true, version: true, workCentre: { select: { kind: true } }, routingOperation: { select: { operationId: true, supplierId: true, transitDays: true } } },
        orderBy: { seq: 'asc' },
      },
    },
  })
  const out = new Map<string, WorkOrderOperations>()
  for (const row of rows) {
    const garments = row.sizes.reduce((sum, size) => sum + size.quantity, 0)
    out.set(row.id, {
      id: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      number: row.number,
      status: row.status,
      version: row.version,
      style: row.style.code,
      garments,
      operations: row.operations.map((operation) => ({
        id: operation.id,
        seq: operation.seq,
        code: operation.code,
        name: operation.name,
        workCentreKind: operation.workCentre.kind,
        operationId: operation.routingOperation?.operationId ?? null,
        standardMinutes: operation.standardMinutes.toString(),
        outsourced: operation.outsourced,
        subcontractOrderId: operation.subcontractOrderId,
        outsideStep: operation.routingOperation?.supplierId != null,
        outsidePartyId: operation.routingOperation?.supplierId ?? null,
        routingDays: operation.routingOperation?.transitDays ?? null,
        // Garments still to do: the work order's (the scans' WIP is the board's; a whole-order drop sends what is left of it).
        remaining: garments,
        version: operation.version,
      })),
    })
  }
  return out
}

/** Each workshop's closed days between two days (its own calendar; none: never closed). */
export async function closedDaysOf(db: Reader, partyIds: readonly string[], from: BusinessDate, to: BusinessDate): Promise<Map<string, Set<BusinessDate>>> {
  const out = new Map<string, Set<BusinessDate>>()
  for (const partyId of partyIds) out.set(partyId, new Set((await supplierClosedDaysFor(db as never, partyId, from, to)).closedDays.map((day) => day.date)))
  return out
}

export interface LineCell {
  readonly key: string
  readonly from: BusinessDate
  readonly to: BusinessDate
  readonly known: boolean
  readonly available: Decimal
  readonly booked: Decimal
  readonly proposed: Decimal
  readonly openDays: number
  readonly closedDays: number
  readonly loadPct: string | null
  readonly over: boolean
}

export interface WorkshopLine {
  readonly workshop: WorkshopRow
  /** null: the workshop has no capacity row (unknown). */
  readonly key: CapacityKey | null
  readonly cells: readonly LineCell[]
}

/** Every workshop's capacity lines over the buckets (one unknown line for a workshop with no row). */
export function linesOf(workshops: readonly WorkshopRow[], rows: readonly CapacityRow[], jobs: readonly Job[], buckets: readonly Bucket[], closed: ReadonlyMap<string, ReadonlySet<BusinessDate>>): WorkshopLine[] {
  const keys = keysOf(rows)
  const out: WorkshopLine[] = []
  for (const workshop of workshops) {
    const own = keys.filter((key) => key.partyId === workshop.id)
    const shut = closed.get(workshop.id) ?? new Set<BusinessDate>()
    const mine = jobs.filter((job) => job.partyId === workshop.id)
    for (const key of own.length > 0 ? own : [null]) {
      const perDay = new Map<BusinessDate, { booked: Decimal; proposed: Decimal }>()
      for (const job of mine) {
        const amount = jobAmount(job, key ?? { workCentreKind: null, unit: 'PIECES' })
        if (!amount.gt(0)) continue
        for (const [day, share] of spreadJob(amount, job, shut)) {
          const cell = perDay.get(day) ?? { booked: new Dec(0), proposed: new Dec(0) }
          perDay.set(day, job.proposed ? { ...cell, proposed: cell.proposed.plus(share) } : { ...cell, booked: cell.booked.plus(share) })
        }
      }
      const cells = buckets.map((bucket): LineCell => {
        const days = daysBetween(bucket.from, bucket.to)
        const capacity = key ? capacityOver(rows, key, days, shut) : { amount: new Dec(0), openDays: 0, closedDays: days.filter((day) => shut.has(day)).length, known: false }
        let booked = new Dec(0)
        let proposed = new Dec(0)
        for (const day of days) {
          const cell = perDay.get(day)
          if (cell) {
            booked = booked.plus(cell.booked)
            proposed = proposed.plus(cell.proposed)
          }
        }
        const loadPct = capacity.known ? loadPctOf(booked, capacity.amount) : null
        return { key: bucket.key, from: bucket.from, to: bucket.to, known: capacity.known, available: capacity.amount, booked, proposed, openDays: capacity.openDays, closedDays: capacity.closedDays, loadPct, over: capacity.known && booked.gt(capacity.amount) && booked.minus(capacity.amount).gt('0.05') }
      })
      out.push({ workshop, key, cells })
    }
  }
  return out
}

/** The site's workshops (schedule/store's: a SUBCONTRACTOR location at the site, or named by the plan), the jobs' too. */
export async function siteWorkshops(db: Reader, site: SiteRow, jobs: readonly Job[]): Promise<WorkshopRow[]> {
  return workshopsOf(db, site, jobs.map((job) => job.partyId))
}

export const cellView = (cell: LineCell, unit: CapacityUnit | null) => ({
  key: cell.key,
  from: cell.from,
  to: cell.to,
  available: cell.known ? amountText(cell.available) : null,
  booked: amountText(cell.booked),
  proposed: amountText(cell.proposed),
  loadPct: cell.loadPct,
  over: cell.over,
  openDays: cell.openDays,
  closedDays: cell.closedDays,
  words: !cell.known
    ? cell.booked.gt(0)
      ? `No capacity set: ${amountText(cell.booked)} ${unit === 'PIECES' ? 'garments' : unit === 'MINUTES' ? 'minutes' : 'garments'} booked here.`
      : 'No capacity set.'
    : `${amountText(cell.available)} ${unit === 'PIECES' ? 'garments' : 'minutes'} available over ${cell.openDays} open weekday${cell.openDays === 1 ? '' : 's'}${cell.closedDays > 0 ? ` (${cell.closedDays} closed)` : ''}; ${amountText(cell.booked)} booked${cell.proposed.gt(0) ? `, ${amountText(cell.proposed)} more proposed by the plan` : ''}.`,
})

/** Two days around the buckets: the window the jobs and the closed days are read for. */
export const windowOf = (buckets: readonly Bucket[], today: BusinessDate): { from: BusinessDate; to: BusinessDate } => ({
  from: [today, ...buckets.map((bucket) => bucket.from)].sort()[0]!,
  to: plusDays([today, ...buckets.map((bucket) => bucket.to)].sort().pop()!, 1),
})

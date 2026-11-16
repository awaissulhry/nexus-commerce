import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { businessDate, businessDayStart, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { Bucket } from '@nexus/factory-domain/planning/settings/buckets'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { Reader, SiteRow } from '../store'
import { capacityRowOf, closedDaysOf, linesOf, readCapacityRows, siteWorkshops, type Job, type WorkshopLine } from './store'

/**
 * B-W2b-GB29 (G225, B-W2b-349's gap "a workshop's past load is not kept"): nothing needs keeping — a workshop's past load
 * follows from the subcontract orders' own dates, which stay on the orders. A past week of a workshop's capacity line is the
 * work that was at the workshop on its days: every subcontract order of the site that went out (ISSUED or later, never a
 * DRAFT or a CANCELLED one), from the day it was issued to the day its last goods came back (its last receipt, else the day
 * it was closed; one still out: its expected-back day, today at the earliest), its operations' standard minutes × the pieces
 * sent (or the garments sent, for a line in pieces) spread evenly over the workshop's open weekdays of that span (as the load
 * ahead, factory-domain planning/subcontract-capacity `spreadJob`), against the capacity line in force on those days
 * (SubcontractorCapacity's validFrom / validTo) less its closed days. Three reads, then the workshops' closed days.
 */

const SENT = ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED'] as const

const later = (a: BusinessDate, b: BusinessDate): BusinessDate => (a > b ? a : b)

/** The subcontract orders that were at a workshop on some day from `from` to `to` (the site's days), as jobs over their whole span. */
export async function readPastJobs(db: Reader, site: SiteRow, from: BusinessDate, to: BusinessDate, today: BusinessDate): Promise<Job[]> {
  const orders = await db.subcontractOrder.findMany({
    where: {
      siteId: site.id,
      status: { in: [...SENT] },
      issuedAt: { not: null, lt: businessDayStart(plusDays(to, 1), site.timezone) },
      OR: [{ closedAt: null }, { closedAt: { gte: businessDayStart(from, site.timezone) } }],
    },
    select: {
      id: true,
      number: true,
      status: true,
      partyId: true,
      issuedAt: true,
      closedAt: true,
      expectedBackDate: true,
      workOrderId: true,
      workOrder: { select: { number: true, style: { select: { code: true } } } },
      receipts: { select: { receivedAt: true }, orderBy: { receivedAt: 'desc' }, take: 1 },
      operations: { select: { pieces: true, expectedBackDate: true, workOrderOperation: { select: { standardMinutes: true, workCentre: { select: { kind: true } } } } } },
    },
    orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
  })
  const jobs: Job[] = []
  for (const order of orders) {
    const garments = Math.max(0, ...order.operations.map((operation) => operation.pieces))
    if (garments === 0) continue
    const out = businessDate(order.issuedAt!, site.timezone)
    const done = order.status === 'RECEIVED' || order.status === 'CLOSED'
    const lastReceipt = order.receipts[0] ? businessDate(order.receipts[0].receivedAt, site.timezone) : null
    const closed = order.closedAt ? businessDate(order.closedAt, site.timezone) : null
    const expected = [order.expectedBackDate, ...order.operations.map((operation) => operation.expectedBackDate)].filter((date): date is Date => date !== null).map((date) => date.toISOString().slice(0, 10)).sort().pop() ?? null
    // Back: its last goods (done), else still out until it is expected back (today at the earliest).
    const back = done ? (lastReceipt ?? closed ?? expected ?? out) : later(expected ?? today, today)
    if (later(back, out) < from) continue
    jobs.push({
      kind: 'ORDER',
      id: order.id,
      partyId: order.partyId,
      workOrderId: order.workOrderId,
      from: out,
      to: later(back, out),
      garments,
      operations: order.operations.filter((operation) => operation.pieces > 0).map((operation) => ({ workCentreKind: operation.workOrderOperation.workCentre.kind, minutes: new Dec(operation.workOrderOperation.standardMinutes.toString()).times(operation.pieces).toFixed(3) })),
      number: order.number,
      status: order.status,
      workOrderNumber: order.workOrder.number,
      style: order.workOrder.style.code,
      proposed: false,
    })
  }
  return jobs
}

/** The site's workshops' capacity lines over past buckets (the weeks before this one), from the orders' own dates. */
export async function pastWorkshopLines(db: Reader, site: SiteRow, buckets: readonly Bucket[], today: BusinessDate): Promise<WorkshopLine[]> {
  if (buckets.length === 0) return []
  const from = buckets.map((bucket) => bucket.from).sort()[0]!
  const to = buckets.map((bucket) => bucket.to).sort().at(-1)!
  const jobs = await readPastJobs(db, site, from, to, today)
  const workshops = await siteWorkshops(db, site, jobs)
  const rows = (await readCapacityRows(db, workshops.map((workshop) => workshop.id))).map(capacityRowOf)
  // The closed days over every job's whole span (a job's share of a past week depends on its open days after it too).
  const first = [from, ...jobs.map((job) => job.from)].sort()[0]!
  const last = [to, ...jobs.map((job) => job.to)].sort().at(-1)!
  const closed = await closedDaysOf(db, workshops.map((workshop) => workshop.id), first, last)
  return linesOf(workshops, rows, jobs, buckets, closed)
}

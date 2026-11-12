import { daysFrom, plusDays } from '@nexus/factory-domain/calendars/dates'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { weekStart, type Bucket } from '@nexus/factory-domain/planning/settings/buckets'
import { amountText, capacityWords, daysBetween, jobAmount, loadPctOf, spreadJob, type CapacityUnit } from '@nexus/factory-domain/planning/subcontract-capacity/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { siteFor } from '../access'
import { readSettings } from '../settings/store'
import type { Reader, SiteRow } from '../store'
import { capacityRowOf, cellView, closedDaysOf, linesOf, readCapacityRows, readJobs, siteWorkshops, windowOf, type WorkshopLine } from '../subcontract-capacity/store'
import { CAPACITY_MAX_DAYS } from './contract'
import { periodOf } from './service'

/**
 * Subcontractors on Capacity & load (B-W2b-321; PLN-124; design planning.capacity › Load against capacity "Rows: lines,
 * work centres; subcontractors (W2b) with their weekly minutes or pieces", tile "Subcontractors over their capacity (W2b)",
 * the cell's DetailModal):
 *
 *   GET /planning/capacity/subcontractors?siteId&from&to&bucket          per workshop of the site and capacity line (kind
 *       of work, minutes or garments), per bucket: available (its weekly capacity over its open weekdays), booked (live
 *       subcontract orders and the allocation board's parts there), proposed (the plan's planned subcontract orders, never
 *       in the %), load %; the tiles
 *   GET /planning/capacity/subcontractors/cell?siteId&partyId&workCentreKind&from&to   the work behind one cell
 *
 * planning.view over the site; the same buckets as GET /planning/capacity (B-W2a-16's periodOf). No money, no person.
 */

export interface SubcontractorWorld {
  readonly site: SiteRow
  readonly today: BusinessDate
  readonly lines: readonly WorkshopLine[]
  readonly rows: readonly ReturnType<typeof capacityRowOf>[]
}

/** The workshops' lines over buckets, read once (the capacity screen, the heatmap). */
export async function subcontractorWorld(db: Reader, site: SiteRow, buckets: readonly Bucket[], today: BusinessDate) {
  const jobs = await readJobs(db, site, today)
  const workshops = await siteWorkshops(db, site, jobs)
  const rows = (await readCapacityRows(db, workshops.map((workshop) => workshop.id))).map(capacityRowOf)
  const window = windowOf(buckets, today)
  const closed = await closedDaysOf(db, workshops.map((workshop) => workshop.id), window.from, window.to)
  return { site, today, jobs, workshops, rows, closed, lines: linesOf(workshops, rows, jobs, buckets, closed) }
}

export const lineView = (line: WorkshopLine, rows: SubcontractorWorld['rows']) => {
  const unit: CapacityUnit | null = line.key?.unit ?? null
  const available = line.cells.filter((cell) => cell.known).reduce((sum, cell) => sum.plus(cell.available), new Dec(0))
  const booked = line.cells.reduce((sum, cell) => sum.plus(cell.booked), new Dec(0))
  const proposed = line.cells.reduce((sum, cell) => sum.plus(cell.proposed), new Dec(0))
  const known = line.cells.some((cell) => cell.known)
  return {
    kind: 'WORKSHOP' as const,
    id: line.workshop.id,
    code: line.workshop.code,
    name: line.workshop.name,
    location: line.workshop.location,
    workCentreKind: line.key?.workCentreKind ?? null,
    unit,
    known,
    capacity: rows.filter((row) => line.key && row.partyId === line.key.partyId && row.workCentreKind === line.key.workCentreKind).map((row) => ({ id: row.id, perWeek: row.perWeek, validFrom: row.validFrom, validTo: row.validTo, words: capacityWords(row) })),
    cells: line.cells.map((cell) => cellView(cell, unit)),
    overall: { available: known ? amountText(available) : null, booked: amountText(booked), proposed: amountText(proposed), loadPct: known ? loadPctOf(booked, available) : null, over: line.cells.some((cell) => cell.over) },
  }
}

/** GET /planning/capacity/subcontractors. */
export async function subcontractorCapacity(caller: CommandCaller, query: { readonly siteId: string; readonly from?: string | undefined; readonly to?: string | undefined; readonly bucket?: string | undefined }) {
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  const now = serverClock.now()
  const today = businessDate(now, site.timezone)
  return caller.withClient(async (db) => {
    const period = periodOf(await readSettings(db, site.id), today, query)
    const monday = weekStart(today)
    const thisWeek: Bucket = { key: 'this-week', kind: 'DAY', from: monday, to: plusDays(monday, 6) }
    const world = await subcontractorWorld(db, site, [...period.buckets, thisWeek], today)
    const lines = world.lines.map((line) => ({ ...line, cells: line.cells.slice(0, period.buckets.length) }))
    const over = new Set(world.lines.filter((line) => line.cells.at(-1)!.over).map((line) => line.workshop.id))
    return {
      site: { id: site.id, companyId: site.companyId, code: site.code, name: site.name, timeZone: site.timezone },
      from: period.from,
      to: period.to,
      bucket: period.bucket,
      today,
      asOf: toUtcIso(now),
      buckets: period.buckets.map((bucket) => ({ key: bucket.key, kind: bucket.kind, from: bucket.from, to: bucket.to })),
      lanes: lines.map((line) => lineView(line, world.rows)),
      tiles: {
        subcontractorsOverThisWeek: over.size,
        workshopsWithoutCapacity: world.lines.filter((line) => line.key === null).length,
      },
    }
  })
}

/** GET /planning/capacity/subcontractors/cell. */
export async function subcontractorCell(caller: CommandCaller, query: { readonly siteId: string; readonly partyId: string; readonly workCentreKind?: string | undefined; readonly from: BusinessDate; readonly to: BusinessDate }) {
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  if (query.to < query.from) throw new ValidationError('The days end before they start.', [{ path: 'querystring/to', message: 'Give a last day on or after the first.' }])
  if (daysFrom(query.from, query.to) + 1 > CAPACITY_MAX_DAYS) throw new ValidationError(`A capacity question covers at most ${CAPACITY_MAX_DAYS} days.`, [{ path: 'querystring/to', message: `At most ${CAPACITY_MAX_DAYS} days from the first.` }])
  const today = businessDate(serverClock.now(), site.timezone)
  return caller.withClient(async (db) => {
    const bucket: Bucket = { key: 'cell', kind: 'DAY', from: query.from, to: query.to }
    const world = await subcontractorWorld(db, site, [bucket], today)
    const kind = query.workCentreKind && query.workCentreKind !== '' ? query.workCentreKind : null
    const line = world.lines.find((candidate) => candidate.workshop.id === query.partyId && (candidate.key?.workCentreKind ?? null) === kind) ?? world.lines.find((candidate) => candidate.workshop.id === query.partyId && candidate.key === null)
    if (!line) throw new NotFoundError('Workshop not found on this site, or it has no capacity line for that work.')
    const cell = line.cells[0]!
    const unit: CapacityUnit | null = line.key?.unit ?? null
    const days = new Set(daysBetween(query.from, query.to))
    const shut = world.closed.get(line.workshop.id) ?? new Set<BusinessDate>()
    const jobs = world.jobs
      .filter((job) => job.partyId === line.workshop.id)
      .map((job) => {
        const amount = jobAmount(job, line.key ?? { workCentreKind: null, unit: 'PIECES' })
        let share = new Dec(0)
        for (const [day, part] of spreadJob(amount, job, shut)) if (days.has(day)) share = share.plus(part)
        return { job, share }
      })
      .filter(({ share }) => share.gt(0))
      .sort((a, b) => b.share.comparedTo(a.share))
    const total = cell.booked.plus(cell.proposed)
    const view = cellView(cell, unit)
    return {
      workshop: { id: line.workshop.id, code: line.workshop.code, name: line.workshop.name },
      workCentreKind: line.key?.workCentreKind ?? null,
      unit,
      from: query.from,
      to: query.to,
      available: view.available,
      booked: view.booked,
      proposed: view.proposed,
      loadPct: view.loadPct,
      words: view.words,
      jobs: jobs.map(({ job, share }) => ({
        kind: job.kind,
        id: job.id,
        number: job.number,
        status: job.status,
        proposed: job.proposed,
        workOrder: job.workOrderId ? { id: job.workOrderId, number: job.workOrderNumber } : null,
        style: job.style,
        from: job.from,
        to: job.to,
        garments: job.garments,
        share: amountText(share),
        sharePct: total.gt(0) ? share.div(total).times(100).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1) : '0.0',
      })),
    }
  })
}

import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { businessDate } from '@nexus/factory-domain/core/time'
import { adherenceFigures, adherenceOf, adherenceOrder, baselineOf, PLANNING_REPORT_LIMITS, weekOfDay, type Adherence, type PlanBar, type PlannedSpan } from '@nexus/factory-domain/planning/reports/rules'
import { uniformBuckets, type Bucket } from '@nexus/factory-domain/planning/settings/buckets'
import type { CommandCaller } from '../../../core/command'
import { dayOf, type Reader } from '../store'
import { headOf, placeOf, type Place } from './access'
import type { AdherenceQuery, AdherenceWorkOrdersQuery } from './contract'

/**
 * Schedule adherence (B-W2b-349; PLN-202; design planning.reports sec adherence "Planned vs actual start and finish per line and
 * week" and pop drill "Work orders behind this bar"): the work orders of the site finished (COMPLETED, then CLOSED) in the
 * period, each against the plan the floor worked to when its work started (factory-domain planning/reports `baselineOf`: the
 * published version then, else the first one with it, else the working plan): its first bar's start and its last bar's end
 * against the first work recorded on it (WorkOrder.startedAt) and its completion (completedAt), in the site's days. Per line it
 * is allocated to (else the line of its first bar), by the week it finished. No money, no person.
 */

const FINISHED = ['COMPLETED', 'CLOSED'] as const

interface Ref {
  readonly id: string
  readonly code: string
  readonly name: string
}

export interface FinishedRow extends Adherence {
  readonly id: string
  readonly number: string
  readonly kind: string
  readonly status: (typeof FINISHED)[number]
  readonly dueDate: string | null
  readonly rush: boolean
  readonly style: Ref
  readonly line: Ref | null
  readonly startedAt: Date | null
  readonly completedAt: Date
  readonly planned: PlannedSpan | null
  readonly week: string
}

/** The finished work orders of the period with their plan and adherence; one query after another. */
export async function finishedOf(db: Reader, place: Place): Promise<{ rows: FinishedRow[]; weeks: Bucket[]; complete: boolean }> {
  const { site, span, period } = place
  const weeks = uniformBuckets(period.from, period.to, 'WEEK')
  const found = await db.workOrder.findMany({
    where: { siteId: site.id, status: { in: [...FINISHED] }, completedAt: { gte: span.start, lt: span.end } },
    select: { id: true, number: true, kind: true, status: true, dueDate: true, rush: true, startedAt: true, completedAt: true, lineId: true, style: { select: { id: true, code: true, name: true } } },
    orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
    take: PLANNING_REPORT_LIMITS.workOrders + 1,
  })
  const complete = found.length <= PLANNING_REPORT_LIMITS.workOrders
  const list = found.slice(0, PLANNING_REPORT_LIMITS.workOrders)
  const ids = list.map((row) => row.id)
  const slots = ids.length === 0 ? [] : await db.scheduleSlot.findMany({ where: { siteId: site.id, workOrderId: { in: ids } }, select: { id: true, workOrderId: true, planVersionId: true, planKind: true, lineId: true, startAt: true, endAt: true }, orderBy: [{ startAt: 'asc' }, { id: 'asc' }] })
  const versionIds = [...new Set(slots.map((slot) => slot.planVersionId))]
  const versions = versionIds.length === 0 ? [] : await db.planVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, kind: true, number: true, publishedAt: true } })
  const versionOf = new Map(versions.map((version) => [version.id, version]))
  const lines = await db.line.findMany({ where: { siteId: site.id }, select: { id: true, code: true, name: true } })
  const lineOf = new Map(lines.map((line) => [line.id, line]))
  const barsOf = new Map<string, (PlanBar & { lineId: string | null })[]>()
  for (const slot of slots) {
    const version = versionOf.get(slot.planVersionId)
    if (!version) continue
    barsOf.set(slot.workOrderId, [...(barsOf.get(slot.workOrderId) ?? []), { versionId: version.id, kind: version.kind, number: version.number, publishedAt: version.publishedAt, startAt: slot.startAt, endAt: slot.endAt, lineId: slot.lineId }])
  }
  const rows: FinishedRow[] = list.flatMap((row) => {
    if (!row.completedAt) return []
    const bars = barsOf.get(row.id) ?? []
    const planned = baselineOf(bars, row.startedAt)
    const barLine = planned ? (bars.find((bar) => bar.versionId === planned.versionId && bar.lineId !== null)?.lineId ?? null) : null
    const lineId = row.lineId ?? barLine
    const week = weekOfDay(weeks, businessDate(row.completedAt, site.timezone))
    if (!week) return []
    return [
      {
        id: row.id,
        number: row.number,
        kind: row.kind,
        status: row.status as FinishedRow['status'],
        dueDate: row.dueDate ? dayOf(row.dueDate) : null,
        rush: row.rush,
        style: row.style,
        line: lineId ? (lineOf.get(lineId) ?? null) : null,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        planned,
        week,
        ...adherenceOf({ planned, actualStart: row.startedAt, actualFinish: row.completedAt, timeZone: site.timezone }),
      },
    ]
  })
  return { rows, weeks, complete }
}

const lineKeyOf = (row: Pick<FinishedRow, 'line'>): string => row.line?.id ?? 'none'

/** GET /planning/reports/adherence (sec adherence): the period's finished work orders per week and per line, on time against plan. */
export async function adherenceAnswer(caller: CommandCaller, query: AdherenceQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(caller, query, db)
    const read = await finishedOf(db, place)
    const groups = new Map<string, { line: Ref | null; rows: FinishedRow[] }>()
    for (const row of read.rows) {
      const key = lineKeyOf(row)
      groups.set(key, { line: row.line, rows: [...(groups.get(key)?.rows ?? []), row] })
    }
    const lines = [...groups.values()].sort((a, b) => (a.line === null ? 1 : b.line === null ? -1 : a.line.code.localeCompare(b.line.code)))
    return {
      ...headOf(place),
      weeks: read.weeks.map((week) => ({ key: week.key, from: week.from, to: week.to, figures: adherenceFigures(read.rows.filter((row) => row.week === week.key)) })),
      lines: lines.map((group) => ({
        line: group.line,
        figures: adherenceFigures(group.rows),
        weeks: read.weeks.map((week) => ({ key: week.key, figures: adherenceFigures(group.rows.filter((row) => row.week === week.key)) })),
      })),
      all: adherenceFigures(read.rows),
      complete: read.complete,
    }
  })
}

/**
 * GET /planning/reports/adherence/work-orders (pop drill "Work orders behind this bar"): the finished work orders behind a week,
 * a line or one of its cells (and a state), the latest against plan first (at most 500), each with its plan and what happened.
 */
export async function adherenceWorkOrdersAnswer(caller: CommandCaller, query: AdherenceWorkOrdersQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(caller, query, db)
    const read = await finishedOf(db, place)
    const week = query.week ? read.weeks.find((entry) => entry.key === query.week) : undefined
    if (query.week && !week) throw new ValidationError(`A week of the period: ${read.weeks.map((entry) => entry.key).join(', ')}.`, [{ path: 'querystring/week', message: 'Choose a week of the period.' }])
    let line: Ref | null = null
    if (query.lineId && query.lineId !== 'none') {
      line = await db.line.findFirst({ where: { id: query.lineId, siteId: place.site.id }, select: { id: true, code: true, name: true } })
      if (!line) throw new NotFoundError('Line not found.')
    }
    const rows = read.rows
      .filter((row) => (query.lineId ? lineKeyOf(row) === query.lineId : true))
      .filter((row) => (week ? row.week === week.key : true))
      .filter((row) => (query.state ? row.state === query.state : true))
      .sort(adherenceOrder)
    const shown = rows.slice(0, PLANNING_REPORT_LIMITS.drillRows)
    return {
      ...headOf(place),
      line,
      week: week ? { key: week.key, from: week.from, to: week.to } : null,
      figures: adherenceFigures(rows),
      rows: shown.map((row) => ({
        workOrder: { id: row.id, number: row.number, kind: row.kind, status: row.status, dueDate: row.dueDate, rush: row.rush, style: row.style },
        line: row.line,
        planned: row.planned ? { source: row.planned.source, number: row.planned.number, startAt: toUtcIso(row.planned.startAt), endAt: toUtcIso(row.planned.endAt) } : null,
        actual: { startAt: row.startedAt ? toUtcIso(row.startedAt) : null, finishAt: toUtcIso(row.completedAt) },
        state: row.state,
        startDays: row.startDays,
        finishDays: row.finishDays,
      })),
      more: Math.max(0, rows.length - shown.length),
    }
  })
}

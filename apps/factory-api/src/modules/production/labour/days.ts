import type { Prisma } from '@nexus/factory-db'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PRODUCTION_LABOUR_CLOSE, PRODUCTION_LABOUR_REOPEN, PRODUCTION_LABOUR_VIEW } from '@nexus/factory-domain/production/labour/permissions'
import {
  addDays,
  blockersOf,
  closeRefusal,
  DAY_BLOCKERS,
  LABOUR_LIMITS,
  lineDayKey,
  lineDayState,
  offStandardCoded,
  rangeProblems,
  reopenRefusal,
  type DayBlocker,
  type LineDayState,
} from '@nexus/factory-domain/production/labour/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeLine, officeOf, refuse } from './access'
import type { CloseBody, DaysQuery, ReopenBody } from './contract'
import { dayColumn, dayRange, employeesOfWorkers, isoDay, lineOf, lineSources, onLines, peopleNames, type LineRow, type Reader, type SiteRow } from './store'

/**
 * Each line's day (B-W2b-45; MES-203; design production.labour "Line days": line · date · off-standard coded (yes / 3
 * blocks left) · anomalies · status (Open / Ready / Closed), "Close day (held until anomalies are cleared, with the
 * count)", the confirm "Close the day for Line 2: closed days feed pay; reopening needs permission and a reason").
 *
 * A line's day is the site's calendar day (Site.timezone). What holds its close, read live from the records (nothing is
 * stored but the close itself, LabourDay): off-standard blocks of the line's day still running or waiting for approval
 * (the database refuses the close too), correction requests waiting for a decision of the reports made on the line that
 * day, open disputes of the line's day, refused scans of the line's stations not dealt with, and the attendance anomalies
 * of the people who worked on the line that day (counted, never named). A report's line is its station's line, else the
 * line its station-less tablet shows (B-W2b-52); a report with neither belongs to no line's day.
 *
 * Close (production.labour.close) and reopen (production.labour.reopen, with a reason) are ONE command each, under the
 * day's lock taken EXCLUSIVE (the …_floor_work_w2b_guards' `factory.labour-day` key: a block written meanwhile waits, and
 * one written after sees the day closed). A day without a row is OPEN; the row is made at its first close.
 */

export const LABOUR_DAY = {
  id: true,
  siteId: true,
  lineId: true,
  workDate: true,
  status: true,
  closedAt: true,
  closedById: true,
  reopenedAt: true,
  reopenedById: true,
  reopenReason: true,
  note: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.LabourDaySelect
export type LabourDayRow = Prisma.LabourDayGetPayload<{ select: typeof LABOUR_DAY }>

export interface DayLine {
  readonly line: LineRow
  readonly site: SiteRow
}

export interface DayFacts {
  readonly line: LineRow
  readonly site: SiteRow
  readonly workDate: BusinessDate
  row: LabourDayRow | null
  readonly counts: Record<DayBlocker, number>
  /** Reports made on the line that day. */
  records: number
  /** Something happened on the line that day (a report, a block, a dispute, a close…). */
  activity: boolean
  readonly employees: Set<string>
}

const zeroCounts = (): Record<DayBlocker, number> => Object.fromEntries(DAY_BLOCKERS.map((kind) => [kind, 0])) as Record<DayBlocker, number>

/** The facts of every day from `from` to `to` of these lines (only the days something happened on, plus those asked for). */
export async function dayFactsOf(db: Reader, lines: readonly DayLine[], from: BusinessDate, to: BusinessDate): Promise<Map<string, DayFacts>> {
  const facts = new Map<string, DayFacts>()
  const byLine = new Map(lines.map((entry) => [entry.line.id, entry]))
  const accOf = (lineId: string | null, workDate: BusinessDate): DayFacts | null => {
    if (!lineId || workDate < from || workDate > to) return null
    const entry = byLine.get(lineId)
    if (!entry) return null
    const key = lineDayKey(lineId, workDate)
    let acc = facts.get(key)
    if (!acc) {
      acc = { line: entry.line, site: entry.site, workDate, row: null, counts: zeroCounts(), records: 0, activity: false, employees: new Set() }
      facts.set(key, acc)
    }
    return acc
  }
  const lineIds = [...byLine.keys()]
  if (lineIds.length === 0) return facts
  const dates = { gte: dayColumn(from), lte: dayColumn(to) }

  for (const row of await db.labourDay.findMany({ where: { lineId: { in: lineIds }, workDate: dates }, select: LABOUR_DAY })) {
    const acc = accOf(row.lineId, isoDay(row.workDate))
    if (acc) {
      acc.row = row
      acc.activity = true
    }
  }
  for (const block of await db.offStandardEntry.findMany({ where: { lineId: { in: lineIds }, workDate: dates }, select: { lineId: true, workDate: true, status: true, employeeId: true } })) {
    const acc = accOf(block.lineId, isoDay(block.workDate))
    if (!acc) continue
    acc.activity = true
    if (block.status === 'OPEN') acc.counts.OFF_STANDARD_RUNNING += 1
    if (block.status === 'PENDING') acc.counts.OFF_STANDARD_WAITING += 1
    if (block.employeeId) acc.employees.add(block.employeeId)
  }
  for (const dispute of await db.labourDispute.findMany({ where: { lineId: { in: lineIds }, workDate: dates }, select: { lineId: true, workDate: true, status: true } })) {
    const acc = accOf(dispute.lineId, isoDay(dispute.workDate))
    if (!acc) continue
    acc.activity = true
    if (dispute.status === 'OPEN') acc.counts.DISPUTE_OPEN += 1
  }

  const sources = await lineSources(db, lineIds)
  const sites = [...new Map(lines.map((entry) => [entry.site.id, entry.site])).values()]
  const workerDays: { acc: DayFacts; workerId: string }[] = []
  for (const site of sites) {
    const range = dayRange(from, to, site.timezone)
    const scans = await db.operationScan.findMany({
      where: { AND: [{ siteId: site.id, kind: 'REPORT', serverTime: { gte: range.start, lt: range.end } }, onLines(sources)] },
      select: { stationId: true, deviceId: true, serverTime: true, workerId: true },
    })
    for (const scan of scans) {
      const acc = accOf(lineOf(sources, scan), businessDate(scan.serverTime, site.timezone))
      if (!acc) continue
      acc.activity = true
      acc.records += 1
      if (scan.workerId) workerDays.push({ acc, workerId: scan.workerId })
    }
    const refusals = await db.floorScanRefusal.findMany({
      where: { siteId: site.id, discardedAt: null, resolvedByScanId: null, resolvedByRequestId: null, serverTime: { gte: range.start, lt: range.end } },
      select: { stationId: true, deviceId: true, serverTime: true },
    })
    for (const refusal of refusals) {
      const acc = accOf(lineOf(sources, refusal), businessDate(refusal.serverTime, site.timezone))
      if (!acc) continue
      acc.activity = true
      acc.counts.REFUSED_SCAN += 1
    }
  }
  const employees = await employeesOfWorkers(db, workerDays.map((entry) => entry.workerId))
  for (const entry of workerDays) {
    const employeeId = employees.get(entry.workerId)
    if (employeeId) entry.acc.employees.add(employeeId)
  }

  // Corrections waiting: each on the day and line of the report it goes back to.
  const timeZoneOf = new Map(sites.map((site) => [site.id, site.timezone]))
  const requests = await db.scanCorrectionRequest.findMany({ where: { status: 'PENDING', siteId: { in: sites.map((site) => site.id) } }, select: { scanId: true, siteId: true } })
  if (requests.length > 0) {
    const roots = await reportsOf(db, requests.map((request) => request.scanId))
    for (const request of requests) {
      const root = roots.get(request.scanId)
      if (!root) continue
      const acc = accOf(lineOf(sources, root), businessDate(root.serverTime, timeZoneOf.get(request.siteId)))
      if (!acc) continue
      acc.activity = true
      acc.counts.CORRECTION_WAITING += 1
    }
  }

  // Attendance anomalies still open of the people who worked on the line that day (counts; never who).
  const people = [...new Set([...facts.values()].flatMap((acc) => [...acc.employees]))]
  if (people.length > 0) {
    const days = await db.attendanceDay.findMany({ where: { employeeId: { in: people }, date: dates }, select: { id: true, employeeId: true, date: true } })
    const open = days.length === 0 ? [] : await db.attendanceAnomaly.findMany({ where: { dayId: { in: days.map((day) => day.id) }, resolvedAt: null }, select: { dayId: true } })
    const perDay = new Map<string, number>()
    for (const anomaly of open) perDay.set(anomaly.dayId, (perDay.get(anomaly.dayId) ?? 0) + 1)
    for (const day of days) {
      const count = perDay.get(day.id) ?? 0
      if (count === 0) continue
      for (const acc of facts.values()) if (acc.workDate === isoDay(day.date) && acc.employees.has(day.employeeId)) acc.counts.ATTENDANCE_ANOMALY += count
    }
  }
  return facts
}

/** The REPORT each of these scans goes back to (a correction request may name a CORRECTION), with its line and time. */
export async function reportsOf(db: Reader, scanIds: readonly string[]) {
  type Row = { id: string; kind: string; correctsId: string | null; stationId: string | null; deviceId: string | null; serverTime: Date }
  const byId = new Map<string, Row>()
  let wanted = [...new Set(scanIds)]
  for (let round = 0; round < 6 && wanted.length > 0; round += 1) {
    const rows = await db.operationScan.findMany({ where: { id: { in: wanted } }, select: { id: true, kind: true, correctsId: true, stationId: true, deviceId: true, serverTime: true } })
    for (const row of rows) byId.set(row.id, row)
    wanted = rows.flatMap((row) => (row.kind !== 'REPORT' && row.correctsId && !byId.has(row.correctsId) ? [row.correctsId] : []))
  }
  const roots = new Map<string, Row>()
  for (const id of scanIds) {
    let current = byId.get(id)
    for (let hop = 0; current && current.kind !== 'REPORT' && hop < 6; hop += 1) current = current.correctsId ? byId.get(current.correctsId) : undefined
    if (current?.kind === 'REPORT') roots.set(id, current)
  }
  return roots
}

// ---- views -----------------------------------------------------------------------------------------------------------

const someone = (names: Map<string, string>, id: string | null) => (id ? { id, name: names.get(id) ?? '' } : null)

export function dayViewOf(acc: DayFacts, names: Map<string, string>) {
  const closed = acc.row?.status === 'CLOSED'
  const facts = { closed, counts: acc.counts }
  const blockers = blockersOf(facts)
  return {
    labourDayId: acc.row?.id ?? null,
    version: acc.row?.version ?? null,
    siteId: acc.site.id,
    line: { id: acc.line.id, code: acc.line.code, name: acc.line.name },
    workDate: acc.workDate,
    state: lineDayState(facts) as LineDayState,
    offStandard: offStandardCoded(facts),
    /** Anomalies left besides off-standard time (corrections, disputes, refused scans, attendance). */
    anomalies: blockers.filter((blocker) => blocker.kind !== 'OFF_STANDARD_RUNNING' && blocker.kind !== 'OFF_STANDARD_WAITING').reduce((sum, blocker) => sum + blocker.count, 0),
    blockers,
    records: acc.records,
    closedAt: acc.row?.closedAt ? toUtcIso(acc.row.closedAt) : null,
    closedBy: someone(names, acc.row?.closedById ?? null),
    reopenedAt: acc.row?.reopenedAt ? toUtcIso(acc.row.reopenedAt) : null,
    reopenedBy: someone(names, acc.row?.reopenedById ?? null),
    reopenReason: acc.row?.reopenReason ?? null,
    note: acc.row?.note ?? null,
  }
}

// ---- reads -----------------------------------------------------------------------------------------------------------

/** The lines of the sites the caller reaches with production.labour.view (optionally one site or one line). */
export async function sitesInScope(db: Reader, caller: CommandCaller, query: { readonly siteId?: string | undefined }): Promise<SiteRow[]> {
  const actor = actorOf(officeOf(caller))
  return db.site.findMany({
    where: { AND: [scopeWhere(actor, PRODUCTION_LABOUR_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput, query.siteId ? { id: query.siteId } : {}] },
    select: { id: true, companyId: true, code: true, name: true, timezone: true },
  })
}

export async function linesInScope(db: Reader, caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly lineId?: string | undefined }): Promise<DayLine[]> {
  const sites = await sitesInScope(db, caller, query)
  if (sites.length === 0) return []
  const bySite = new Map(sites.map((site) => [site.id, site]))
  const lines = await db.line.findMany({ where: { siteId: { in: [...bySite.keys()] }, ...(query.lineId ? { id: query.lineId } : {}) }, select: { id: true, siteId: true, code: true, name: true }, orderBy: [{ code: 'asc' }] })
  return lines.map((line) => ({ line, site: bySite.get(line.siteId)! }))
}

export function defaultRange(query: { readonly from?: string | undefined; readonly to?: string | undefined }, now: Date, back = 6): { from: BusinessDate; to: BusinessDate } {
  const to = query.to ?? (query.from ? addDays(query.from, back) : businessDate(now))
  const from = query.from ?? addDays(to, -back)
  const problems = rangeProblems(from, to)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  return { from, to }
}

/** The line days of the caller's sites (design "Line days"): the days something happened on, newest first. */
export async function listDays(caller: CommandCaller, query: DaysQuery) {
  officeOf(caller)
  const { from, to } = defaultRange(query, serverClock.now())
  return caller.withClient(async (db) => {
    const lines = await linesInScope(db, caller, query)
    const facts = [...(await dayFactsOf(db, lines, from, to)).values()].filter((acc) => acc.activity)
    const names = await peopleNames(db, facts.flatMap((acc) => [acc.row?.closedById ?? null, acc.row?.reopenedById ?? null]))
    const days = facts
      .map((acc) => dayViewOf(acc, names))
      .filter((day) => !query.state || day.state === query.state)
      .sort((a, b) => (a.workDate !== b.workDate ? (a.workDate < b.workDate ? 1 : -1) : a.line.code < b.line.code ? -1 : a.line.code > b.line.code ? 1 : 0))
    return { from, to, days }
  })
}

/** The line days still to close in the last days (READY ones are the queue's; held ones say why). */
export async function openDays(db: Reader, caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly lineId?: string | undefined }, now: Date): Promise<DayFacts[]> {
  const to = businessDate(now)
  const lines = await linesInScope(db, caller, query)
  const facts = await dayFactsOf(db, lines, addDays(to, -(LABOUR_LIMITS.openDaysWindow - 1)), to)
  return [...facts.values()].filter((acc) => acc.activity && acc.row?.status !== 'CLOSED' && acc.workDate <= businessDate(now, acc.site.timezone))
}

async function oneDay(db: Reader, place: DayLine, workDate: BusinessDate): Promise<DayFacts> {
  const facts = await dayFactsOf(db, [place], workDate, workDate)
  return facts.get(lineDayKey(place.line.id, workDate)) ?? { line: place.line, site: place.site, workDate, row: null, counts: zeroCounts(), records: 0, activity: false, employees: new Set() }
}

/** A close or reopening made in this command: its audit row is written after the answer is made. */
interface InFlight {
  readonly action: 'production.labourDayClose' | 'production.labourDayReopen'
  readonly at: Date
  readonly actorId: string
  readonly reason: string | null
}

async function dayAnswer(db: Reader, caller: CommandCaller, place: DayLine, workDate: BusinessDate, inFlight?: InFlight) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const acc = await oneDay(db, place, workDate)
  const recorded = acc.row
    ? await db.auditLog.findMany({ where: { recordType: 'LabourDay', recordId: acc.row.id }, select: { id: true, action: true, at: true, actorId: true, reason: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
    : []
  const history = inFlight && acc.row ? [...recorded, { id: acc.row.id, ...inFlight }] : recorded
  const names = await peopleNames(db, [acc.row?.closedById ?? null, acc.row?.reopenedById ?? null, ...history.map((entry) => entry.actorId)])
  const view = dayViewOf(acc, names)
  const where = { companyId: place.site.companyId, siteId: place.site.id }
  return {
    ...view,
    history: history.map((entry) => ({ id: entry.id, change: entry.action === 'production.labourDayReopen' ? ('REOPENED' as const) : ('CLOSED' as const), at: toUtcIso(entry.at), by: someone(names, entry.actorId), reason: entry.reason })),
    canClose: view.state === 'READY' && can(actor, PRODUCTION_LABOUR_CLOSE, where),
    canReopen: view.state === 'CLOSED' && can(actor, PRODUCTION_LABOUR_REOPEN, where),
  }
}

export async function dayOf(caller: CommandCaller, lineId: string, workDate: BusinessDate) {
  const place = await officeLine(caller, lineId, PRODUCTION_LABOUR_VIEW)
  return { day: await caller.withClient((db) => dayAnswer(db, caller, place, workDate)) }
}

// ---- close and reopen ------------------------------------------------------------------------------------------------

/** The day's lock, EXCLUSIVE (the database's own key: a block written meanwhile waits; one written after sees it closed). */
async function lockDay(tools: CommandTools, lineId: string, workDate: BusinessDate): Promise<void> {
  const tenantId = (tools.context as { readonly tenantId: string }).tenantId
  await tools.tx.$executeRaw`SELECT "factory_labour_day_lock"(${tenantId}::uuid, ${lineId}::uuid, ${workDate}::date, true)`
}

async function rowOf(tools: CommandTools, lineId: string, workDate: BusinessDate): Promise<LabourDayRow | null> {
  return tools.tx.labourDay.findFirst({ where: { lineId, workDate: dayColumn(workDate) }, select: LABOUR_DAY })
}

/** Close a line's day (MES-203): held in words while its off-standard time is not coded or an anomaly is left. */
export async function closeDay(caller: CommandCaller, lineId: string, workDate: BusinessDate, body: CloseBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const place = await officeLine(caller, lineId, PRODUCTION_LABOUR_CLOSE)
  const { result } = await command(caller, { name: 'production.labourDayClose', idempotencyKey, input: { lineId, workDate, ...body } }, async (tools) => {
    await lockDay(tools, lineId, workDate)
    const row = await rowOf(tools, lineId, workDate)
    if (body.version !== undefined && row && row.version !== body.version) throw new StaleVersionError('LabourDay', row.id, row.version, body.version)
    const acc = await oneDay(tools.tx, place, workDate)
    const refusal = closeRefusal({ facts: { closed: row?.status === 'CLOSED', counts: acc.counts }, workDate, today: businessDate(tools.now, place.site.timezone), lineCode: place.line.code })
    if (refusal) refuse(refusal)
    const note = body.note?.trim() ? body.note.trim() : (row?.note ?? null)
    const saved = row
      ? await tools.tx.labourDay.update({ where: { id: row.id }, data: { status: 'CLOSED', closedAt: tools.now, closedById: context.actorId, note, updatedAt: tools.now, version: { increment: 1 } }, select: LABOUR_DAY })
      : await tools.tx.labourDay.create({ data: { id: newId(), siteId: place.site.id, lineId, workDate: dayColumn(workDate), status: 'CLOSED', closedAt: tools.now, closedById: context.actorId, note, createdById: context.actorId }, select: LABOUR_DAY })
    tools.audit({ recordType: 'LabourDay', recordId: saved.id, companyId: place.site.companyId, siteId: place.site.id, before: { status: row?.status ?? 'OPEN' }, after: { status: 'CLOSED', lineId, workDate, closedAt: toUtcIso(tools.now), records: acc.records } })
    tools.emit({ type: 'labour_day.closed', subject: saved.id, companyId: place.site.companyId, siteId: place.site.id, payload: { labourDayId: saved.id, siteId: place.site.id, lineId, workDate } })
    return { day: await dayAnswer(tools.tx, caller, place, workDate, { action: 'production.labourDayClose', at: tools.now, actorId: context.actorId, reason: null }) }
  })
  return result
}

/** Reopen a closed line's day, with a reason (production.labour.reopen): its blocks and disputes take changes again. */
export async function reopenDay(caller: CommandCaller, lineId: string, workDate: BusinessDate, body: ReopenBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const place = await officeLine(caller, lineId, PRODUCTION_LABOUR_REOPEN)
  const reason = body.reason.trim()
  const { result } = await command(caller, { name: 'production.labourDayReopen', idempotencyKey, input: { lineId, workDate, ...body } }, async (tools) => {
    await lockDay(tools, lineId, workDate)
    const row = await rowOf(tools, lineId, workDate)
    const refusal = reopenRefusal({ closed: row?.status === 'CLOSED', workDate, lineCode: place.line.code })
    if (refusal || !row) return refuse(refusal!)
    if (row.version !== body.version) throw new StaleVersionError('LabourDay', row.id, row.version, body.version)
    const saved = await tools.tx.labourDay.update({
      where: { id: row.id },
      data: { status: 'OPEN', closedAt: null, closedById: null, reopenedAt: tools.now, reopenedById: context.actorId, reopenReason: reason, updatedAt: tools.now, version: { increment: 1 } },
      select: LABOUR_DAY,
    })
    tools.audit({ recordType: 'LabourDay', recordId: saved.id, companyId: place.site.companyId, siteId: place.site.id, before: { status: 'CLOSED', closedAt: row.closedAt ? toUtcIso(row.closedAt) : null }, after: { status: 'OPEN', lineId, workDate }, reason })
    tools.emit({ type: 'labour_day.reopened', subject: saved.id, companyId: place.site.companyId, siteId: place.site.id, payload: { labourDayId: saved.id, siteId: place.site.id, lineId, workDate } })
    return { day: await dayAnswer(tools.tx, caller, place, workDate, { action: 'production.labourDayReopen', at: tools.now, actorId: context.actorId, reason }) }
  })
  return result
}


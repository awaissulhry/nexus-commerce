import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { changesOf, LABOUR_LIMITS, type Change, type EditKind } from '@nexus/factory-domain/production/labour/rules'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { legalGateFor, type GateReader } from '../../people/privacy/gate'
import { officeOf } from './access'
import type { EditsQuery } from './contract'
import { defaultRange, linesInScope, reportsOf, sitesInScope } from './days'
import { dayRange, isoDay, jsonObject, lineOf, lineSources, linesById, peopleNames, type Reader, type SiteRow } from './store'

/**
 * Changes to labour and attendance records (B-W2b-45; MES-204 "every edit keeps before / after, who, when and why"; design
 * production.labour "Changes to labour records": a timeline with ChangeValue, filter by line and date; people.employees
 * "Activity": every change with before → after, who, when, why). One timeline, newest first, read from the records that
 * keep each change (nothing is copied):
 *
 *   LABOUR_EDIT            the labour edits (an off-standard block corrected or reopened, a dispute's correction)
 *   SCAN_CORRECTION        a lead's correction of a report (the corrected counts → the new ones, who approved, why)
 *   ATTENDANCE_CORRECTION  a closed attendance day corrected (minutes before → after, why)
 *   CLOCK_EDIT             a clock event typed or voided by hand (why)
 *
 * The attendance changes only at the sites whose ATTENDANCE legal gate is on (Statuto dei Lavoratori art. 4 c.2; GDPR art.
 * 13); none name a line. A row names who made the change (an office user or a team leader) and never whose record it is
 * (`named` says a person is on it): the record itself names them, within its own rules (Owner answers W1, F2).
 */

interface Row {
  readonly id: string
  readonly kind: EditKind
  readonly at: Date
  readonly siteId: string
  readonly lineId: string | null
  readonly workDate: string
  readonly recordType: string
  readonly recordId: string
  readonly changes: readonly Change[]
  readonly by: string | null
  readonly reason: string | null
  readonly disputeId: string | null
  readonly named: boolean
}

const clockText = (kind: string, at: Date) => `${kind} ${toUtcIso(at)}`

async function openAttendanceSites(db: Reader, sites: readonly SiteRow[]): Promise<SiteRow[]> {
  const open: SiteRow[] = []
  for (const site of sites) if ((await legalGateFor(db as GateReader, site.id, 'ATTENDANCE')).open) open.push(site)
  return open
}

export async function listEdits(caller: CommandCaller, query: EditsQuery) {
  officeOf(caller)
  const { from, to } = defaultRange(query, serverClock.now(), 13)
  const wants = (kind: EditKind) => !query.kind || query.kind === kind
  return caller.withClient(async (db) => {
    const sites = await sitesInScope(db, caller, query)
    const zoneOf = new Map(sites.map((site) => [site.id, site.timezone]))
    const inRange = (siteId: string, at: Date) => {
      const day = businessDate(at, zoneOf.get(siteId))
      return day >= from && day <= to
    }
    const ranges = sites.map((site) => dayRange(from, to, site.timezone))
    const window = ranges.length === 0 ? null : { gte: new Date(Math.min(...ranges.map((range) => range.start.getTime()))), lt: new Date(Math.max(...ranges.map((range) => range.end.getTime()))) }
    const take = Math.min(query.limit, LABOUR_LIMITS.rows) + 1
    const rows: Row[] = []
    if (window && sites.length > 0) {
      const siteIds = sites.map((site) => site.id)
      if (wants('LABOUR_EDIT')) {
        const edits = await db.labourEdit.findMany({
          where: { siteId: { in: siteIds }, createdAt: window, ...(query.lineId ? { lineId: query.lineId } : {}) },
          select: { id: true, siteId: true, lineId: true, workDate: true, recordType: true, recordId: true, workerId: true, before: true, after: true, reason: true, disputeId: true, createdAt: true, createdById: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
        })
        for (const edit of edits) {
          if (!inRange(edit.siteId, edit.createdAt)) continue
          rows.push({ id: edit.id, kind: 'LABOUR_EDIT', at: edit.createdAt, siteId: edit.siteId, lineId: edit.lineId, workDate: isoDay(edit.workDate), recordType: edit.recordType, recordId: edit.recordId, changes: changesOf(jsonObject(edit.before), jsonObject(edit.after)), by: edit.createdById, reason: edit.reason, disputeId: edit.disputeId, named: edit.workerId !== null })
        }
      }
      if (wants('SCAN_CORRECTION')) {
        const corrections = await db.operationScan.findMany({
          where: { siteId: { in: siteIds }, kind: 'CORRECTION', serverTime: window },
          select: { id: true, siteId: true, correctsId: true, goodQuantity: true, scrapQuantity: true, reworkQuantity: true, serverTime: true, approvedById: true, reason: true, workerId: true },
          orderBy: [{ serverTime: 'desc' }, { id: 'desc' }],
          take,
        })
        const corrected = new Map((await db.operationScan.findMany({ where: { id: { in: corrections.flatMap((row) => (row.correctsId ? [row.correctsId] : [])) } }, select: { id: true, goodQuantity: true, scrapQuantity: true, reworkQuantity: true } })).map((row) => [row.id, row]))
        const roots = await reportsOf(db, corrections.map((row) => row.id))
        const sources = await lineSources(db, (await linesInScope(db, caller, query)).map((entry) => entry.line.id))
        for (const row of corrections) {
          if (!inRange(row.siteId, row.serverTime)) continue
          const root = roots.get(row.id)
          const lineId = root ? lineOf(sources, root) : null
          if (query.lineId && lineId !== query.lineId) continue
          const before = row.correctsId ? corrected.get(row.correctsId) : undefined
          rows.push({
            id: row.id,
            kind: 'SCAN_CORRECTION',
            at: row.serverTime,
            siteId: row.siteId,
            lineId,
            workDate: businessDate(root?.serverTime ?? row.serverTime, zoneOf.get(row.siteId)),
            recordType: 'OperationScan',
            recordId: root?.id ?? row.correctsId ?? row.id,
            changes: changesOf(before ? { good: before.goodQuantity, scrap: before.scrapQuantity, rework: before.reworkQuantity } : {}, { good: row.goodQuantity, scrap: row.scrapQuantity, rework: row.reworkQuantity }),
            by: row.approvedById,
            reason: row.reason,
            disputeId: null,
            named: row.workerId !== null,
          })
        }
      }
      // Attendance changes name no line: none when a line is asked for.
      const attendanceSites = query.lineId || (!wants('ATTENDANCE_CORRECTION') && !wants('CLOCK_EDIT')) ? [] : await openAttendanceSites(db, sites)
      if (attendanceSites.length > 0) {
        const openIds = attendanceSites.map((site) => site.id)
        if (wants('ATTENDANCE_CORRECTION')) {
          const days = await db.attendanceDay.findMany({ where: { siteId: { in: openIds }, corrections: { some: { createdAt: window } } }, select: { id: true, siteId: true, date: true } })
          const dayOf = new Map(days.map((day) => [day.id, day]))
          const corrections = days.length === 0 ? [] : await db.attendanceCorrection.findMany({ where: { dayId: { in: days.map((day) => day.id) }, createdAt: window }, select: { id: true, dayId: true, kind: true, minutesBefore: true, minutesAfter: true, reason: true, createdAt: true, createdById: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take })
          for (const row of corrections) {
            const day = dayOf.get(row.dayId)
            if (!day || !inRange(day.siteId, row.createdAt)) continue
            rows.push({ id: row.id, kind: 'ATTENDANCE_CORRECTION', at: row.createdAt, siteId: day.siteId, lineId: null, workDate: isoDay(day.date), recordType: 'AttendanceDay', recordId: day.id, changes: [{ field: `${row.kind.toLowerCase()}Minutes`, from: row.minutesBefore, to: row.minutesAfter }], by: row.createdById, reason: row.reason, disputeId: null, named: true })
          }
        }
        if (wants('CLOCK_EDIT')) {
          const events = await db.clockEvent.findMany({
            where: { siteId: { in: openIds }, createdAt: window, OR: [{ source: 'MANUAL' }, { kind: 'VOID' }] },
            select: { id: true, siteId: true, kind: true, source: true, occurredAt: true, reason: true, voidsEventId: true, createdAt: true, createdById: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
          })
          const voided = new Map((await db.clockEvent.findMany({ where: { id: { in: events.flatMap((row) => (row.voidsEventId ? [row.voidsEventId] : [])) } }, select: { id: true, kind: true, occurredAt: true } })).map((row) => [row.id, row]))
          for (const row of events) {
            if (!inRange(row.siteId, row.createdAt)) continue
            const target = row.voidsEventId ? voided.get(row.voidsEventId) : undefined
            const changes: Change[] = row.kind === 'VOID' ? [{ field: 'clock', from: target ? clockText(target.kind, target.occurredAt) : null, to: null }] : [{ field: 'clock', from: null, to: clockText(row.kind, row.occurredAt) }]
            rows.push({ id: row.id, kind: 'CLOCK_EDIT', at: row.createdAt, siteId: row.siteId, lineId: null, workDate: businessDate((target ?? row).occurredAt, zoneOf.get(row.siteId)), recordType: 'ClockEvent', recordId: row.voidsEventId ?? row.id, changes, by: row.createdById, reason: row.reason, disputeId: null, named: true })
          }
        }
      }
    }
    const limit = Math.min(query.limit, LABOUR_LIMITS.rows)
    const sorted = rows.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1))
    const shown = sorted.slice(0, limit)
    const lines = await linesById(db, shown.map((row) => row.lineId))
    const names = await peopleNames(db, shown.map((row) => row.by))
    return {
      from,
      to,
      edits: shown.map((row) => ({
        id: row.id,
        kind: row.kind,
        at: toUtcIso(row.at),
        siteId: row.siteId,
        line: row.lineId && lines.get(row.lineId) ? { id: row.lineId, code: lines.get(row.lineId)!.code, name: lines.get(row.lineId)!.name } : null,
        workDate: row.workDate,
        recordType: row.recordType,
        recordId: row.recordId,
        changes: [...row.changes],
        by: row.by ? { id: row.by, name: names.get(row.by) ?? '' } : null,
        reason: row.reason,
        disputeId: row.disputeId,
        named: row.named,
      })),
      more: sorted.length > limit,
    }
  })
}

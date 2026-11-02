import { businessDate } from '@nexus/factory-domain/core/time'
import { PEOPLE_ATTENDANCE_VIEW } from '@nexus/factory-domain/people/clock/permissions'
import { minutesOf as blockMinutes } from '@nexus/factory-domain/production/offstandard/rules'
import { sumMinutes } from '@nexus/factory-domain/production/labour/rules'
import { coveredPct, gapMinutes, REPORT_WORDS, summaryShown } from '@nexus/factory-domain/people/reports/attendance/report'
import type { CommandCaller } from '../../../../core/command'
import { serverClock } from '../../../../core/time'
import { dateOf, officeOf } from '../../employees/access'
import { requireAttendance, siteFor } from '../../attendance/access'
import { monthDays, periodOfMonth } from '../../close/store'
import { hideSmallGroups, minimumGroupSizeFor } from '../../privacy/groups'
import { dayRange, lineOf, lineSources, onLines, recordsFor, SCAN, type Reader } from '../../../production/labour/store'
import type { AttendedQuery } from './contract'
import { monthOr } from './report'

/**
 * Attendance against production minutes, per line (B-W2b-48; MES-236; design people.attendance "Scan minutes · Gap"), office
 * only, behind the site's ATTENDANCE gate, people.attendance.view:
 *
 *   GET /people/reports/attendance/production   for a month, per line: the minutes attended, the standard minutes earned, the
 *                                               coded off-standard minutes, what nobody coded (the gap)
 *
 * Per line only, a line under the company's minimum size emptied: a per-person gap is a monitoring figure, and the Owner's
 * answer W1 keeps every figure about one person out of a list. Attended minutes follow the person: their home line, or the
 * line a loan had them on at their first clock-in. Production minutes come from the labour records (what stands after
 * corrections and undos: B-W2b-45's `recordsFor`), whose worker is read by the labour query and never kept here. No scan
 * is joined to a person's attendance: the two sides only meet as a line's sums.
 */

const STANDING_BLOCKS = ['PENDING', 'APPROVED'] as const

interface LineSide {
  attended: number
  readonly people: Set<string>
  readonly earned: string[]
  offStandard: number
}

/** GET /people/reports/attendance/production. */
export async function attendedAgainstProduction(caller: CommandCaller, query: AttendedQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const site = await siteFor(db, context, query.siteId, [PEOPLE_ATTENDANCE_VIEW])
    await requireAttendance(db, site.id)
    const now = serverClock.now()
    const month = monthOr(query.month, businessDate(now, site.timezone))
    const period = periodOfMonth(month, 'querystring/month')
    const lines = await db.line.findMany({ where: { siteId: site.id, ...(query.lineId ? { id: query.lineId } : {}) }, select: { id: true, code: true, name: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
    const sides = new Map<string, LineSide>(lines.map((line) => [line.id, { attended: 0, people: new Set<string>(), earned: [], offStandard: 0 }]))

    // The attended side.
    const days = await monthDays(db, { siteId: site.id, ...period })
    const range = dayRange(period.from, period.to, site.timezone)
    const people = [...new Set(days.map((day) => day.employeeId))]
    const homes = people.length === 0 ? [] : await db.employee.findMany({ where: { id: { in: people } }, select: { id: true, siteId: true, homeLineId: true } })
    const homeOf = new Map(homes.map((row) => [row.id, row.siteId === site.id ? row.homeLineId : null]))
    const loans = await db.lineLoan.findMany({ where: { siteId: site.id, startsAt: { lt: range.end }, endsAt: { gt: range.start } }, select: { employeeId: true, toLineId: true, startsAt: true, endsAt: true } })
    for (const day of days) {
      const loan = day.firstInAt ? loans.find((entry) => entry.employeeId === day.employeeId && entry.startsAt <= day.firstInAt! && entry.endsAt > day.firstInAt!) : undefined
      const side = sides.get(loan?.toLineId ?? homeOf.get(day.employeeId) ?? '')
      if (!side || day.effective.present === 0) continue
      side.attended += day.effective.present
      side.people.add(day.employeeId)
    }

    // The production side: what stands of the reports made on the line.
    const sources = await lineSources(db as Reader, lines.map((line) => line.id))
    const reports = await db.operationScan.findMany({ where: { AND: [{ siteId: site.id, kind: 'REPORT', serverTime: { gte: range.start, lt: range.end } }, onLines(sources)] }, select: SCAN })
    const set = await recordsFor(db as Reader, reports, site.timezone)
    for (const record of set.records) {
      const lineId = lineOf(sources, record)
      if (lineId) sides.get(lineId)?.earned.push(record.earnedMinutes)
    }
    const blocks = await db.offStandardEntry.findMany({ where: { lineId: { in: lines.map((line) => line.id) }, workDate: { gte: dateOf(period.from), lte: dateOf(period.to) }, status: { in: [...STANDING_BLOCKS] } }, select: { lineId: true, startedAt: true, endedAt: true } })
    for (const block of blocks) {
      const side = block.lineId ? sides.get(block.lineId) : undefined
      if (side) side.offStandard += blockMinutes(block.startedAt, block.endedAt, now)
    }

    const rows = lines.map((line) => {
      const side = sides.get(line.id)!
      const productionMinutes = sumMinutes(side.earned)
      return {
        line,
        people: side.people.size as number | null,
        figures: { attendedMinutes: side.attended, productionMinutes, offStandardMinutes: side.offStandard, gapMinutes: gapMinutes(side.attended, productionMinutes, side.offStandard), coveredPct: coveredPct(side.attended, productionMinutes) },
      }
    })
    const active = rows.filter((row) => (row.people ?? 0) > 0 || row.figures.productionMinutes !== sumMinutes([]))
    const masked = await hideSmallGroups(db, site.companyId, active)
    const minimum = await minimumGroupSizeFor(db, site.companyId)
    const hiddenPeople = masked.rows.reduce((total, entry, index) => total + (entry.tooFew ? (active[index]!.people ?? 0) : 0), 0)
    const everyone = new Set(active.flatMap((row) => [...sides.get(row.line.id)!.people]))
    const sum = (pick: (row: (typeof active)[number]) => number): number => active.reduce((total, row) => total + pick(row), 0)
    const productionMinutes = sumMinutes(active.map((row) => row.figures.productionMinutes))
    const attendedMinutes = sum((row) => row.figures.attendedMinutes)
    const offStandardMinutes = sum((row) => row.figures.offStandardMinutes)
    return {
      siteId: site.id,
      month,
      lines: masked.rows.map((entry, index) => ({ line: active[index]!.line, people: entry.row.people, tooFew: entry.tooFew, words: entry.words, figures: entry.tooFew ? null : entry.row.figures })),
      summary: summaryShown(hiddenPeople, everyone.size, minimum) ? { people: everyone.size, figures: { attendedMinutes, productionMinutes, offStandardMinutes, gapMinutes: gapMinutes(attendedMinutes, productionMinutes, offStandardMinutes), coveredPct: coveredPct(attendedMinutes, productionMinutes) } } : null,
      words: [REPORT_WORDS.production],
    }
  })
}

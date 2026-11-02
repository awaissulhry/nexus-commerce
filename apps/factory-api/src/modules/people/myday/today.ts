import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { monthOf, paysOn, windowsOf } from '@nexus/factory-domain/people/earnings/rules'
import { MYDAY_ANSWER_DAYS, MYDAY_ANSWER_ROWS, monthPays, myPaceOf, officePrinterOf, targetHours } from '@nexus/factory-domain/people/myday/rules'
import { PACE_LOOK } from '@nexus/factory-domain/production/boards/hourly'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { devicePlaceOf } from '../../production/calls/store'
import { targetsOf } from '../../production/boards/store'
import { floorOf } from '../../production/labour/access'
import { scanSubjectFor } from '../../production/settings/subject'
import { systemOf } from '../clock/access'
import { floorMine } from '../earnings/floor'
import { personDaysAt } from '../efficiency/person'
import { readWork, siteLines, type Reader, type SiteLines, type WorkRecord } from '../efficiency/store'
import { legalGateFor } from '../privacy/gate'
import type { MyDayQuery } from './contract'

/**
 * My day's one read (B-W2b-68; MES-111, MES-112; design floor.myday "Today"; c.c. art. 2101; GDPR art. 15). floor.work with the
 * PIN again (the route's requireFloorStepUp), the signed-in worker only: what they reported today, and, where the site allows
 * it, their own minutes, efficiency and pace; money for a month piece pay covers. The floor role holds no grant on most of what
 * this reads (attendance aside, which it never reads): the API reads it in the tenant's system view after the session is
 * checked, one person's rows only, as My pay does. Read fresh each time: nothing here is kept in a table or on the tablet.
 *
 * No line output goes in, and none can come out: pace has the line's target and the person's own pieces, never what the line or
 * anyone on it did (Owner answer F2; Statuto dei Lavoratori art. 4). A site that records stations names nobody: no personal day.
 */

const dayRangeOf = (day: BusinessDate) => ({ from: day, to: day })

const sum = (records: readonly WorkRecord[], of: (record: WorkRecord) => number): number => records.reduce((total, record) => total + of(record), 0)

/** The worker's pace on the line they work on now: the tablet's, else the one of their last report, else their home line. */
async function paceToday(db: Reader, input: { readonly place: { readonly timezone: string }; readonly setup: SiteLines; readonly deviceId: string; readonly employeeId: string; readonly records: readonly WorkRecord[]; readonly today: BusinessDate; readonly now: Date }) {
  const { records, today, now } = input
  const solo = records.filter((entry) => !entry.team)
  const latest = [...records].sort((a, b) => b.record.at.getTime() - a.record.at.getTime()).find((entry) => entry.lineId !== null)
  const lineId = (await devicePlaceOf(db, input.deviceId)).lineId ?? latest?.lineId ?? (await db.employee.findUnique({ where: { id: input.employeeId }, select: { homeLineId: true } }))?.homeLineId ?? null
  const line = lineId ? (input.setup.lines.get(lineId) ?? null) : null
  const here = line ? solo.filter((entry) => entry.lineId === line.id) : []
  const hours = line ? targetHours({ day: today, timeZone: input.place.timezone, now, targets: await targetsOf(db, [line.id], today) }) : []
  const since = here.length > 0 ? new Date(Math.min(...here.map((entry) => entry.record.at.getTime()))) : null
  const figures = myPaceOf({ hours, done: sum(here, (entry) => entry.record.counts.good), since, now })
  return { line: line ? { code: line.code, name: line.name } : null, ...figures, look: PACE_LOOK[figures.pace] }
}

/** GET /people/myday. */
export async function myDay(caller: CommandCaller, query: MyDayQuery) {
  const context = floorOf(caller)
  const now = serverClock.now()
  const read = await systemOf(caller).withClient(async (db) => {
    const site = await db.site.findUnique({ where: { id: context.siteId }, select: { id: true, companyId: true, timezone: true } })
    if (!site) throw new NotFoundError('Site not found.')
    const today = businessDate(now, site.timezone)
    const month = query.month ?? monthOf(today)
    const nobody = { work: { pieces: 0, scrap: 0, rework: 0, reports: 0 }, performance: null, paysToday: false, printer: false, paysMonth: false }
    if ((await scanSubjectFor(db, site.id)) === 'STATION') return { subject: 'STATION' as const, linked: false, today, month, ...nobody }
    const worker = await db.worker.findUnique({ where: { id: context.actorId }, select: { employeeId: true } })
    const employeeId = worker?.employeeId ?? null
    const setup = await siteLines(db, site)
    const { records } = await readWork(db, site, setup.sources, dayRangeOf(today), { workerIds: [context.actorId] })
    const work = { pieces: sum(records, (entry) => entry.record.counts.good), scrap: sum(records, (entry) => entry.record.counts.scrap), rework: sum(records, (entry) => entry.record.counts.rework), reports: records.length }
    if (!employeeId) return { subject: 'WORKER' as const, linked: false, today, month, ...nobody, work }

    const switched = await db.piecePaySwitch.findFirst({ where: { siteId: site.id }, select: { onFrom: true, offFrom: true, earlierWindows: true } })
    const windows = switched ? windowsOf({ onFrom: dayOrNull(switched.onFrom), offFrom: dayOrNull(switched.offFrom), earlierWindows: switched.earlierWindows }) : []
    const printers = await db.printer.findMany({ where: { siteId: site.id, kind: 'A4_PDF', status: 'ACTIVE' }, select: { id: true }, take: 2 })
    const base = { subject: 'WORKER' as const, linked: true, today, month, work, paysToday: paysOn(windows, today), paysMonth: monthPays(windows, month), printer: officePrinterOf(printers) !== null }

    // The gate first: closed, none of one person's work figures is even computed.
    if (!(await legalGateFor(db, site.id, 'PERFORMANCE', now)).open) return { ...base, performance: null }
    const person = await personDaysAt(db, site, setup, employeeId, dayRangeOf(today), now)
    const day = person.days[0] ?? null
    const traineeDay = person.leftOut.traineeDays > 0
    const pace = await paceToday(db, { place: site, setup, deviceId: context.deviceId, employeeId, records: traineeDay ? [] : records, today, now })
    return {
      ...base,
      performance: {
        earnedMinutes: day?.earnedMinutes ?? '0.000',
        timedMinutes: day?.timedMinutes ?? '0.000',
        offStandardMinutes: day?.offStandardMinutes ?? '0.000',
        efficiency: day?.efficiency ?? null,
        traineeDay,
        sharedReports: person.leftOut.sharedReports,
        pace,
      },
    }
  })
  const { paysMonth, ...answer } = read
  return { ...answer, asOf: toUtcIso(now), pay: paysMonth ? await floorMine(caller, { month: read.month }) : null }
}

const dayOrNull = (value: Date | null): BusinessDate | null => (value ? value.toISOString().slice(0, 10) : null)

/**
 * GET /people/myday/answers: the worker's disputes answered in the last days, by id: the My day tile's badge (design "a dispute
 * answered → a badge on the My day tile"). No PIN: it says nothing but that an answer waits, to the person signed in.
 */
export async function myAnswers(caller: CommandCaller) {
  const context = floorOf(caller)
  const since = new Date(serverClock.now().getTime() - MYDAY_ANSWER_DAYS * 86_400_000)
  const rows = await caller.withClient((db) =>
    db.labourDispute.findMany({ where: { siteId: context.siteId, workerId: context.actorId, status: { in: ['UPHELD', 'REJECTED'] }, answeredAt: { gte: since } }, select: { id: true }, orderBy: [{ answeredAt: 'desc' }, { id: 'asc' }], take: MYDAY_ANSWER_ROWS }),
  )
  return { ids: rows.map((row) => row.id) }
}

import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { openReasonProblems } from '@nexus/factory-domain/people/privacy/figures'
import { changesOf, dailySheetOf, STATION_SITE, type SheetAttendance } from '@nexus/factory-domain/production/labour/rules'
import { minutesOf } from '@nexus/factory-domain/production/offstandard/rules'
import { command, type CommandCaller } from '../../../core/command'
import { openPersonFiguresInCommand, personFiguresAccess, requirePersonFigures } from '../../people/privacy/access'
import { gateClosedError, legalGateFor, type GateReader } from '../../people/privacy/gate'
import { codesById } from '../offstandard/store'
import { scanSubjectFor } from '../settings/subject'
import { officeOf, refuse } from './access'
import type { SheetBody } from './contract'
import { operationRefOf, recordPlaces } from './records'
import { bundlesById, dayColumn, dayRange, jsonObject, recordsFor, SCAN, sitesById, workOrdersById, type Reader } from './store'

/**
 * The operator's daily sheet (B-W2b-45; MES-202; design production.labour pop-up "Daily sheet": "one person, one day:
 * attendance minutes · production minutes (standard minutes earned) · off-standard minutes by code · pieces · exceptions;
 * no percentage, no comparison, no colour judgement", "This view is logged"). One person's work figures: opened only
 * through the People privacy gate (B-W2b-27): the site's legal gate for one person's work figures (PERFORMANCE, Statuto dei
 * Lavoratori art. 4 c.1) on, and the viewer the worker, a role People settings name (HR) or, where the site allows it, the
 * worker's team lead; someone else's sheet takes a reason. ONE command writes the opening down (audit
 * people.openPersonFigures: who, whose, purpose, why) and answers the sheet. Off (the default): 409 `gate/PERFORMANCE` in
 * words, for everyone. A site that records stations has no personal sheet (409 STATION_SITE).
 *
 * Attendance minutes show only where the site's ATTENDANCE legal gate is on too (art. 4 c.2); else the sheet says so.
 */

interface SheetPerson {
  readonly employeeId: string
  readonly name: string
  readonly companyId: string
  readonly siteId: string
  readonly timezone: string
  readonly workerIds: readonly string[]
}

/** One person's day, read inside the opening command (the records of their floor sign-ins, their blocks, their attendance). */
export async function sheetOf(db: Reader, person: SheetPerson, workDate: BusinessDate, now: Date) {
  const range = dayRange(workDate, workDate, person.timezone)
  const reports = person.workerIds.length === 0 ? [] : await db.operationScan.findMany({ where: { workerId: { in: [...person.workerIds] }, kind: 'REPORT', serverTime: { gte: range.start, lt: range.end } }, select: SCAN, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }] })
  const set = await recordsFor(db, reports, person.timezone)
  const blocks = await db.offStandardEntry.findMany({ where: { employeeId: person.employeeId, workDate: dayColumn(workDate) }, select: { id: true, codeId: true, status: true, startedAt: true, endedAt: true }, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] })
  const codes = await codesById(db, blocks.map((block) => block.codeId))
  const chainIds = set.records.flatMap((record) => [record.scanId, ...record.steps.map((step) => step.scanId)])
  const correctionsWaiting = chainIds.length === 0 ? 0 : await db.scanCorrectionRequest.count({ where: { status: 'PENDING', scanId: { in: chainIds } } })
  const disputesOpen = await db.labourDispute.count({ where: { status: 'OPEN', workDate: dayColumn(workDate), OR: [{ employeeId: person.employeeId }, ...(person.workerIds.length > 0 ? [{ workerId: { in: [...person.workerIds] } }] : [])] } })
  const attendanceShown = (await legalGateFor(db as GateReader, person.siteId, 'ATTENDANCE')).open
  let attendance: SheetAttendance | null = null
  let anomalies = 0
  if (attendanceShown) {
    const day = await db.attendanceDay.findFirst({ where: { employeeId: person.employeeId, date: dayColumn(workDate) }, select: { id: true, status: true, presentMinutes: true, breakMinutes: true, ordinaryMinutes: true, overtimeMinutes: true, absenceMinutes: true } })
    if (day) {
      attendance = { status: day.status, presentMinutes: day.presentMinutes, breakMinutes: day.breakMinutes, ordinaryMinutes: day.ordinaryMinutes, overtimeMinutes: day.overtimeMinutes, absenceMinutes: day.absenceMinutes }
      anomalies = await db.attendanceAnomaly.count({ where: { dayId: day.id, resolvedAt: null } })
    }
  }
  const sheet = dailySheetOf({
    workDate,
    records: set.records,
    blocks: blocks.map((block) => ({ codeId: block.codeId, code: codes.get(block.codeId)?.code ?? '', kind: codes.get(block.codeId)?.kind ?? 'OFF_STANDARD', status: block.status, minutes: minutesOf(block.startedAt, block.endedAt, now) })),
    attendance,
    counts: { CORRECTION_WAITING: correctionsWaiting, DISPUTE_OPEN: disputesOpen, ATTENDANCE_ANOMALY: anomalies },
  })
  const bundles = await bundlesById(db, set.records.map((record) => record.bundleId))
  const workOrders = await workOrdersById(db, set.records.map((record) => record.workOrderId))
  const places = await recordPlaces(db, set.records)
  const edits = await db.labourEdit.findMany({ where: { employeeId: person.employeeId, workDate: dayColumn(workDate) }, select: { id: true, recordType: true, recordId: true, before: true, after: true, reason: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  return {
    // The answer's arrays are copies (the domain's sheet is read-only).
    sheet: { ...sheet, offStandard: { minutes: sheet.offStandard.minutes, byCode: sheet.offStandard.byCode.map((entry) => ({ ...entry })) }, exceptions: sheet.exceptions.map((entry) => ({ ...entry })) },
    records: set.records.map((record) => ({
      scanId: record.scanId,
      at: toUtcIso(record.at),
      workOrder: { id: record.workOrderId, number: workOrders.get(record.workOrderId)?.number ?? '' },
      bundle: { id: record.bundleId, code: bundles.get(record.bundleId)?.code ?? '' },
      operation: operationRefOf(set.operations.get(record.workOrderOperationId), record.workOrderOperationId),
      line: places.lineOf(record),
      state: record.state,
      counts: record.counts,
      earnedMinutes: record.earnedMinutes,
    })),
    blocks: blocks.map((block) => ({ id: block.id, code: codes.get(block.codeId)?.code ?? '', kind: codes.get(block.codeId)?.kind ?? 'OFF_STANDARD', startedAt: toUtcIso(block.startedAt), endedAt: block.endedAt ? toUtcIso(block.endedAt) : null, minutes: minutesOf(block.startedAt, block.endedAt, now), status: block.status })),
    edits: edits.map((edit) => ({ id: edit.id, at: toUtcIso(edit.createdAt), recordType: edit.recordType, recordId: edit.recordId, changes: changesOf(jsonObject(edit.before), jsonObject(edit.after)), reason: edit.reason })),
    attendanceShown,
  }
}

const LOGGED = "This view is logged: who opened this person's day, when and why are recorded and visible to HR and the data protection officer. No comparison with others, no export, no print."

/** POST /production/labour/sheets: open one person's daily sheet (the opening is the command; the sheet is its answer). */
export async function openSheet(caller: CommandCaller, body: SheetBody, idempotencyKey?: string) {
  officeOf(caller)
  const access = await personFiguresAccess(caller, body.employeeId, 'PERFORMANCE')
  const as = requirePersonFigures(access)
  const problems = openReasonProblems(access.decision, body.reason, body.note)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const person = await caller.withClient(async (db) => {
    if ((await scanSubjectFor(db, access.employee.siteId)) === 'STATION') return refuse(STATION_SITE)
    const employee = await db.employee.findUnique({ where: { id: access.employee.id }, select: { displayName: true } })
    const site = (await sitesById(db, [access.employee.siteId])).get(access.employee.siteId)
    if (!employee || !site) throw new NotFoundError('Person not found.')
    const workers = await db.worker.findMany({ where: { employeeId: access.employee.id }, select: { id: true } })
    return { employeeId: access.employee.id, name: employee.displayName, companyId: access.employee.companyId, siteId: site.id, timezone: site.timezone, workerIds: workers.map((row) => row.id) } satisfies SheetPerson
  })
  const { result } = await command(caller, { name: 'production.labourSheetOpen', idempotencyKey, input: body }, async (tools) => {
    // The gate read again inside the command: switched off since the check, nothing is opened.
    const { gate } = await legalGateFor(tools.tx, person.siteId, 'PERFORMANCE')
    if (!gate) throw gateClosedError('PERFORMANCE')
    openPersonFiguresInCommand(tools, { ...access, gate }, { reason: body.reason, note: body.note })
    const read = await sheetOf(tools.tx, person, body.workDate, tools.now)
    return {
      person: { employeeId: person.employeeId, name: person.name },
      siteId: person.siteId,
      workDate: body.workDate,
      as,
      ...read,
      words: [LOGGED, ...(read.attendanceShown ? [] : ["Attendance minutes are not shown: this site's attendance purpose is off (Statuto dei Lavoratori art. 4 c.2)."])],
      recorded: true as const,
    }
  })
  return result
}

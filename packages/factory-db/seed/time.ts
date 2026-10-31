import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import {
  AbsenceCategory,
  AnomalyResolution,
  AttendanceAnomalyKind,
  AttendanceCorrectionKind,
  AttendanceDayStatus,
  AttendanceMonthStatus,
  ClockEventFlag,
  ClockEventKind,
  ClockEventSource,
  MasterStatus,
  OvertimeAnswer,
  OvertimeAnswerChannel,
  OvertimeClass,
  OvertimeRequestStatus,
  RosterEntryKind,
  RosterEntryStatus,
  TimesheetStatus,
  WorkingTimeAction,
  WorkingTimeRuleKind,
  WorkingTimeRuleSource,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedCalendar } from './calendar'
import { seed as seedFiles } from './files'
import { seed as seedFloorAuth } from './floor-auth'
import { seed as seedPeople } from './people'

/**
 * The time and attendance seed (W2b schema wave 5/7), per tenant of seed/_core.ts. Plant A1 (company A) has a week of
 * two made-up people, the floor-auth seed's workers ("Seed Worker A1-1", an operator on the morning shift, and
 * "Seed Worker A1-2", the team leader on the afternoon shift); plant B1 (company B) one day of its operator:
 *
 *   rules          the law's working-time limits tenant-wide (D.Lgs. 66/2003: 11 h daily rest, 24 h weekly rest, 48 h
 *                  weekly average over 4 months, a break after 6 h, 250 h of overtime a year, 8 h at night), a CCNL
 *                  example on plant A1 (a 15-minute break; set your contract's article), and company A's earlier rule,
 *                  archived. All warn; none blocks.
 *   codes          the tenant's absence codes (holiday, permit, sickness, injury, law 104, union leave, strike, unpaid
 *                  leave); their LUL codes are left to the labour consultant (GATE-PAYROLL).
 *   roster         week 26-30 October 2026 published (the operator on Morning 06-14, the lead on Afternoon 14-22, from
 *                  the planning pattern "2T"), the operator's Monday 2 November still a draft; B1's operator on Day.
 *   overtime       2 hours on Thursday 29 October for a rush order: asked of both, the operator agreed on the tablet,
 *                  the lead declined (told the office): AGREED. A draft for 5 November with the operator asked. B1: an
 *                  hour asked of its operator.
 *   clock events   the operator's Tuesday (badge in, a break, badge out), Wednesday (forgot badge: name and PIN,
 *                  flagged; no clock-out, so the automatic one at 14:15) and Thursday (a double badge scan, the second
 *                  voided by the lead; out at 16:05 after the agreed overtime); the lead's Tuesday (in offline, with the
 *                  tablet's time); B1's operator's Tuesday.
 *   days           Tuesday APPROVED; Wednesday NEEDS_FIX with two anomalies open (the missing clock-out, the flagged
 *                  event); Thursday OPEN, marked manual (the void), its double clock-in FIXED, 2 hours of overtime
 *                  PENDING from the request; the lead's Tuesday OPEN; B1's day OPEN.
 *   absences       the lead's holiday on Friday 30 October (planned), the operator's permit of 2 hours on 2 November.
 *   September      company A's September 2026 CLOSED: the operator's 29th (worked) and 30th (holiday), approved and
 *                  closed, the timesheet approved by the lead then HR, the LUL calendar sealed; two corrections of the
 *                  29th (an early leave typed on the wrong day, then put back). October's close is OPEN (being made).
 *
 * The person: these rows name the People seed's employees of the same workers (E1, E2, EB1; seed/people.ts), each of
 * the row's company (the foreign key holds the company too).
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: so the first roster cell, request (a DRAFT), answer (PENDING), clock event (a badge clock-in at A1, in an open
 * month), day (OPEN), anomaly (open), absence, overtime entry (PENDING), timesheet (PENDING), month close (OPEN) and
 * correction (whose figure was put back by a later one) get ids that start with eight zeros, and the archived rule
 * comes first among the rules (the copy of an active one would clash with it); the LUL file starts with eight f's.
 *
 * Every name, time and code is invented. Written in the tenant's office scope, the tablets' clock events and answers in
 * the plant's floor scope, as the app does. Idempotent: each record is written once and skipped when it exists (clock
 * events and corrections are append-only: written once, never upserted).
 */

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const day = (date: string): Date => new Date(`${date}T00:00:00.000Z`)
const at = (iso: string): Date => new Date(iso)
const plusSecond = (iso: string): Date => new Date(new Date(iso).getTime() + 1000)

const T = {
  rules: at('2026-10-01T07:00:00.000Z'),
  oldRule: at('2025-01-10T08:00:00.000Z'),
  published: at('2026-10-23T15:00:00.000Z'),
  draftRoster: at('2026-10-30T10:00:00.000Z'),
  asked: at('2026-10-27T09:00:00.000Z'),
  operatorAgreed: at('2026-10-27T10:30:00.000Z'),
  leadDeclined: at('2026-10-27T11:00:00.000Z'),
  requestAgreed: at('2026-10-27T11:05:00.000Z'),
  computed: at('2026-10-29T16:00:00.000Z'),
  approved27: at('2026-10-28T08:00:00.000Z'),
  voided: at('2026-10-29T07:30:00.000Z'),
  septemberApproved: at('2026-10-01T08:00:00.000Z'),
  septemberLead: at('2026-10-01T09:00:00.000Z'),
  septemberHr: at('2026-10-01T15:00:00.000Z'),
  septemberClosed: at('2026-10-02T09:00:00.000Z'),
  lul: at('2026-10-02T09:05:00.000Z'),
  correction1: at('2026-10-05T09:00:00.000Z'),
  correction2: at('2026-10-06T09:00:00.000Z'),
  octoberClose: at('2026-10-30T16:00:00.000Z'),
} as const

/** The law's limits (D.Lgs. 66/2003), tenant-wide. */
const LAW_RULES = [
  { kind: WorkingTimeRuleKind.DAILY_REST, limitMinutes: 660, legalReference: 'D.Lgs. 66/2003 art. 7' },
  { kind: WorkingTimeRuleKind.WEEKLY_REST, limitMinutes: 1440, legalReference: 'D.Lgs. 66/2003 art. 9' },
  { kind: WorkingTimeRuleKind.WEEKLY_AVERAGE, limitMinutes: 2880, referenceMonths: 4, legalReference: 'D.Lgs. 66/2003 art. 4' },
  { kind: WorkingTimeRuleKind.BREAK_AFTER, limitMinutes: 360, breakMinutes: 10, legalReference: 'D.Lgs. 66/2003 art. 8' },
  { kind: WorkingTimeRuleKind.OVERTIME_YEARLY_CAP, limitMinutes: 15000, legalReference: 'D.Lgs. 66/2003 art. 5' },
  { kind: WorkingTimeRuleKind.NIGHT_AVERAGE, limitMinutes: 480, legalReference: 'D.Lgs. 66/2003 art. 13' },
] as const

/** The tenant's absence codes; LUL codes come from the labour consultant. */
const ABSENCE_CODES = [
  { code: 'FER', category: AbsenceCategory.HOLIDAY, paid: true, documentRequired: false, it: 'Ferie', en: 'Holiday' },
  { code: 'ROL', category: AbsenceCategory.PERMIT, paid: true, documentRequired: false, it: 'Permesso (ROL)', en: 'Leave of hours (ROL)' },
  { code: 'MAL', category: AbsenceCategory.SICKNESS, paid: true, documentRequired: true, it: 'Malattia', en: 'Sickness' },
  { code: 'INF', category: AbsenceCategory.INJURY, paid: true, documentRequired: true, it: 'Infortunio', en: 'Injury at work' },
  { code: 'L104', category: AbsenceCategory.LAW_104, paid: true, documentRequired: true, it: 'Permesso legge 104', en: 'Law 104 leave' },
  { code: 'SIN', category: AbsenceCategory.UNION, paid: true, documentRequired: false, it: 'Permesso sindacale', en: 'Union leave' },
  { code: 'SCI', category: AbsenceCategory.STRIKE, paid: false, documentRequired: false, it: 'Sciopero', en: 'Strike' },
  { code: 'ASP', category: AbsenceCategory.UNPAID_LEAVE, paid: false, documentRequired: false, it: 'Aspettativa non retribuita', en: 'Unpaid leave' },
] as const

/** The shifts of the planning patterns "2T" and "1T" (seed/calendar.ts), as the roster copies them. */
const SHIFT = {
  morning: { shiftLabel: 'Morning', startMinute: 360, endMinute: 840, breakMinutes: 15 },
  afternoon: { shiftLabel: 'Afternoon', startMinute: 840, endMinute: 1320, breakMinutes: 15 },
  day: { shiftLabel: 'Day', startMinute: 480, endMinute: 1020, breakMinutes: 60 },
} as const
const PLANNED = {
  morning: { plannedLabel: 'Morning', plannedStartMinute: 360, plannedEndMinute: 840, plannedMinutes: 465 },
  afternoon: { plannedLabel: 'Afternoon', plannedStartMinute: 840, plannedEndMinute: 1320, plannedMinutes: 465 },
  day: { plannedLabel: 'Day', plannedStartMinute: 480, plannedEndMinute: 1020, plannedMinutes: 480 },
} as const

export interface TimeSeed {
  /** The made-up people: plant A1's operator and lead, plant B1's operator (Employee ids of the People schema). */
  readonly employees: { readonly operator: string; readonly lead: string; readonly b1Operator: string }
  readonly ruleIds: { readonly archived: string; readonly breakA1: string } & Readonly<Record<string, string>>
  readonly absenceCodeIds: Readonly<Record<string, string>>
  readonly rosterIds: { readonly first: string; readonly draft: string }
  readonly requestIds: { readonly draft: string; readonly agreed: string; readonly b1: string }
  readonly agreementIds: { readonly draft: string; readonly operator: string; readonly lead: string; readonly b1: string }
  readonly clockIds: {
    readonly firstIn: string
    readonly forgotBadge: string
    readonly autoOut: string
    readonly doubleIn: string
    readonly void: string
    readonly leadOffline: string
  }
  readonly dayIds: {
    readonly lead27: string
    readonly operator27: string
    readonly operator28: string
    readonly operator29: string
    readonly b1Operator27: string
    readonly september29: string
    readonly september30: string
  }
  readonly anomalyIds: { readonly missingOut: string; readonly flagged: string; readonly double: string }
  readonly absenceIds: { readonly leadHoliday: string; readonly operatorPermit: string; readonly septemberHoliday: string }
  readonly overtimeEntryId: string
  readonly timesheetIds: { readonly october: string; readonly september: string }
  readonly monthCloseIds: { readonly october: string; readonly september: string }
  readonly lulFileId: string
  readonly correctionIds: { readonly first: string; readonly putBack: string }
}

export async function seed(context: SeedContext): Promise<TimeSeed> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order (_core, auth … floor-auth … people … threads, time); run what this one builds
  // on: the shift patterns (calendar, with the parties), the workers and tablets (floor-auth), the file store (files),
  // the people (People schema: the employees of the seeded workers).
  await seedCalendar(context)
  await seedFloorAuth(context)
  await seedFiles(context)
  const people = await seedPeople(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  /** HR: the auth seed's member (a second person, for the approvals that need two). */
  const hrId = id('user:member')
  const company = { A: id('company:A'), B: id('company:B') }
  const site = { A1: id('site:A1'), B1: id('site:B1') }
  const lineA1 = id('site:A1:line:L1')
  const store = id('files:account:r2')
  const pattern = { twoShifts: id('calendar:pattern:2T'), oneShift: id('calendar:pattern:1T') }
  const worker = { operator: id('worker:A1:operator'), lead: id('worker:A1:lead'), b1Operator: id('worker:B1:operator') }
  const device = { A1: id('device:A1:cutting'), B1: id('device:B1:cutting') }
  /** The Employees of the seeded workers (seed/people.ts: E1 is A1's operator, E2 A1's lead, EB1 B1's operator). */
  const employees = { operator: people.employeeIds.e1, lead: people.employeeIds.e2, b1Operator: people.employeeIds.eb1 }
  const office = { audience: 'office' as const, tenantId, actorId }
  const floorOf = (siteId: string, workerId: string) => ({ audience: 'floor' as const, tenantId, actorId: workerId, siteId })
  const stamp = (when: Date, by: string | null = actorId) => ({ createdAt: when, updatedAt: when, createdById: by })
  const select = { id: true } as const

  // --- the ids ---------------------------------------------------------------------------------------------------
  const ruleIds = {
    archived: firstId('time:rule:A:DAILY_REST:2025'),
    breakA1: id('time:rule:A1:BREAK_AFTER'),
    ...Object.fromEntries(LAW_RULES.map((rule) => [rule.kind, id(`time:rule:tenant:${rule.kind}`)])),
  } as TimeSeed['ruleIds']
  const absenceCodeIds = Object.fromEntries(ABSENCE_CODES.map((entry) => [entry.code, id(`time:absence-code:${entry.code}`)])) as Record<string, string>
  const rosterIds = { first: firstId('time:roster:A1:operator:2026-10-26'), draft: id('time:roster:A1:operator:2026-11-02') }
  const requestIds = { draft: firstId('time:overtime:A1:2026-11-05'), agreed: id('time:overtime:A1:2026-10-29'), b1: id('time:overtime:B1:2026-10-28') }
  const agreementIds = {
    draft: firstId('time:overtime:A1:2026-11-05:operator'),
    operator: id('time:overtime:A1:2026-10-29:operator'),
    lead: id('time:overtime:A1:2026-10-29:lead'),
    b1: id('time:overtime:B1:2026-10-28:operator'),
  }
  const clock = (key: string): string => id(`time:clock:${key}`)
  const clockIds = {
    firstIn: firstId('time:clock:A1:operator:2026-10-27:in'),
    forgotBadge: clock('A1:operator:2026-10-28:in'),
    autoOut: clock('A1:operator:2026-10-28:auto-out'),
    doubleIn: clock('A1:operator:2026-10-29:in-2'),
    void: clock('A1:operator:2026-10-29:void'),
    leadOffline: clock('A1:lead:2026-10-27:in'),
  }
  const dayIds = {
    lead27: firstId('time:day:A1:lead:2026-10-27'),
    operator27: id('time:day:A1:operator:2026-10-27'),
    operator28: id('time:day:A1:operator:2026-10-28'),
    operator29: id('time:day:A1:operator:2026-10-29'),
    b1Operator27: id('time:day:B1:operator:2026-10-27'),
    september29: id('time:day:A1:operator:2026-09-29'),
    september30: id('time:day:A1:operator:2026-09-30'),
  }
  const anomalyIds = {
    missingOut: firstId('time:anomaly:A1:operator:2026-10-28:missing-out'),
    flagged: id('time:anomaly:A1:operator:2026-10-28:flagged'),
    double: id('time:anomaly:A1:operator:2026-10-29:double'),
  }
  const absenceIds = {
    leadHoliday: firstId('time:absence:A1:lead:2026-10-30:FER'),
    operatorPermit: id('time:absence:A1:operator:2026-11-02:ROL'),
    septemberHoliday: id('time:absence:A1:operator:2026-09-30:FER'),
  }
  const overtimeEntryId = firstId('time:overtime-entry:A1:operator:2026-10-29:DAY')
  const timesheetIds = { october: firstId('time:timesheet:A1:operator:2026-10'), september: id('time:timesheet:A1:operator:2026-09') }
  const monthCloseIds = { october: firstId('time:month-close:A:2026-10'), september: id('time:month-close:A:2026-09') }
  const lulFileId = lastId('time:file:lul:A:2026-09')
  const correctionIds = { first: firstId('time:correction:A1:operator:2026-09-29:1'), putBack: lastId('time:correction:A1:operator:2026-09-29:2') }

  // --- working-time limits and absence codes ------------------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const rules: Prisma.WorkingTimeRuleCreateManyInput[] = [
        {
          id: ruleIds.archived,
          companyId: company.A,
          kind: WorkingTimeRuleKind.DAILY_REST,
          limitMinutes: 660,
          action: WorkingTimeAction.WARN,
          legalReference: 'D.Lgs. 66/2003 art. 7',
          status: MasterStatus.ARCHIVED,
          ...stamp(T.oldRule),
        },
        ...LAW_RULES.map(
          (rule): Prisma.WorkingTimeRuleCreateManyInput => ({
            id: ruleIds[rule.kind] as string,
            kind: rule.kind,
            limitMinutes: rule.limitMinutes,
            breakMinutes: 'breakMinutes' in rule ? rule.breakMinutes : null,
            referenceMonths: 'referenceMonths' in rule ? rule.referenceMonths : null,
            action: WorkingTimeAction.WARN,
            alertRoles: ['owner', 'floor_supervisor'],
            source: WorkingTimeRuleSource.LAW,
            legalReference: rule.legalReference,
            ...stamp(T.rules),
          }),
        ),
        {
          id: ruleIds.breakA1,
          companyId: company.A,
          siteId: site.A1,
          kind: WorkingTimeRuleKind.BREAK_AFTER,
          limitMinutes: 360,
          breakMinutes: 15,
          action: WorkingTimeAction.WARN,
          alertRoles: ['floor_supervisor'],
          source: WorkingTimeRuleSource.CCNL,
          legalReference: 'D.Lgs. 66/2003 art. 8; CCNL (example: set your contract’s article)',
          ...stamp(T.rules),
        },
      ]
      await tx.workingTimeRule.createMany({ data: rules, skipDuplicates: true })
      for (const entry of ABSENCE_CODES) {
        const codeId = absenceCodeIds[entry.code] as string
        const data = { category: entry.category, paid: entry.paid, documentRequired: entry.documentRequired, labelI18n: { it: entry.it, en: entry.en } }
        await tx.absenceCode.upsert({ where: { id: codeId }, create: { id: codeId, code: entry.code, ...data, ...stamp(T.rules) }, update: data, select })
      }
    }),
  )

  // --- September 2026, closed ---------------------------------------------------------------------------------------
  const septemberDone = await db.withScope(office, (client) => client.attendanceMonthClose.findUnique({ where: { id: monthCloseIds.september }, select: { status: true } }))
  if (septemberDone?.status !== AttendanceMonthStatus.CLOSED) {
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        const common = { companyId: company.A, siteId: site.A1, employeeId: employees.operator, ...PLANNED.morning, computedAt: T.septemberApproved }
        await tx.attendanceDay.createMany({
          data: [
            {
              id: dayIds.september29,
              ...common,
              date: day('2026-09-29'),
              firstInAt: at('2026-09-29T03:58:00.000Z'),
              lastOutAt: at('2026-09-29T12:01:00.000Z'),
              presentMinutes: 468,
              breakMinutes: 15,
              ordinaryMinutes: 465,
              ...stamp(T.septemberApproved),
            },
            { id: dayIds.september30, ...common, date: day('2026-09-30'), absenceMinutes: 465, ...stamp(T.septemberApproved) },
          ],
          skipDuplicates: true,
        })
        await tx.absenceEntry.createMany({
          data: [{ id: absenceIds.septemberHoliday, companyId: company.A, employeeId: employees.operator, date: day('2026-09-30'), codeId: absenceCodeIds.FER as string, minutes: 465, ...stamp(T.septemberApproved) }],
          skipDuplicates: true,
        })
        for (const dayId of [dayIds.september29, dayIds.september30]) {
          await tx.attendanceDay.updateMany({
            where: { id: dayId, status: AttendanceDayStatus.OPEN },
            data: { status: AttendanceDayStatus.APPROVED, approvedAt: T.septemberApproved, approvedById: actorId },
          })
        }
        const timesheet = { companyId: company.A, employeeId: employees.operator, periodStart: day('2026-09-01'), periodEnd: day('2026-09-30') }
        await tx.timesheetApproval.createMany({ data: [{ id: timesheetIds.september, ...timesheet, ...stamp(T.septemberApproved) }], skipDuplicates: true })
        await tx.timesheetApproval.updateMany({
          where: { id: timesheetIds.september, status: TimesheetStatus.PENDING },
          data: { status: TimesheetStatus.LEAD_APPROVED, leadApprovedAt: T.septemberLead, leadApprovedById: actorId },
        })
        await tx.timesheetApproval.updateMany({
          where: { id: timesheetIds.september, status: TimesheetStatus.LEAD_APPROVED },
          data: { status: TimesheetStatus.APPROVED, hrApprovedAt: T.septemberHr, hrApprovedById: hrId },
        })
        await tx.attendanceMonthClose.createMany({
          data: [{ id: monthCloseIds.september, companyId: company.A, month: day('2026-09-01'), note: 'September 2026 (made up).', ...stamp(T.septemberClosed, hrId) }],
          skipDuplicates: true,
        })
        for (const dayId of [dayIds.september29, dayIds.september30]) {
          await tx.attendanceDay.updateMany({
            where: { id: dayId, status: AttendanceDayStatus.APPROVED },
            data: { status: AttendanceDayStatus.CLOSED, monthCloseId: monthCloseIds.september, closedAt: T.septemberClosed },
          })
        }
        await tx.attendanceMonthClose.update({
          where: { id: monthCloseIds.september },
          data: { status: AttendanceMonthStatus.CLOSED, closedAt: T.septemberClosed, closedById: hrId },
          select,
        })
        const lulSha = sha256(`seed time lul ${namespace} 2026-09`)
        await tx.storedFile.createMany({
          data: [
            {
              id: lulFileId,
              companyId: company.A,
              recordType: 'AttendanceMonthClose',
              recordId: monthCloseIds.september,
              kind: 'DOCUMENT',
              originalName: 'Calendario presenze LUL 2026-09 (esempio).pdf',
              contentType: 'application/pdf',
              sizeBytes: 4096,
              sha256: lulSha,
              storeAccountId: store,
              storageKey: `t/${tenantId}/c/${company.A}/2026/${id('time:file:key:lul:A:2026-09')}`,
              status: 'AVAILABLE',
              availableAt: T.lul,
              visibility: ['OFFICE'],
              ...stamp(T.lul, hrId),
            },
          ],
          skipDuplicates: true,
        })
        await tx.attendanceMonthClose.update({ where: { id: monthCloseIds.september }, data: { lulFileId, lulSha256: lulSha }, select })
        // Two corrections of the 29th after the close: an early leave typed on the wrong day, then put back.
        const correction = { companyId: company.A, employeeId: employees.operator, dayId: dayIds.september29, monthCloseId: monthCloseIds.september, kind: AttendanceCorrectionKind.ORDINARY }
        await tx.attendanceCorrection.create({
          data: { id: correctionIds.first, ...correction, minutesBefore: 465, minutesAfter: 435, reason: 'Left at 13:30 with a permit, typed after the close.', createdAt: T.correction1, createdById: hrId },
          select,
        })
        await tx.attendanceCorrection.create({
          data: { id: correctionIds.putBack, ...correction, minutesBefore: 435, minutesAfter: 465, reason: 'Put back: that permit was on 28 September, not on the 29th.', createdAt: T.correction2, createdById: hrId },
          select,
        })
      }),
    )
  }

  // --- the roster -------------------------------------------------------------------------------------------------
  const rosterCell = (key: string, employeeId: string, siteId: string, companyId: string, date: string, shift: (typeof SHIFT)[keyof typeof SHIFT], patternId: string, published = true): Prisma.RosterEntryCreateManyInput => ({
    id: key,
    companyId,
    siteId,
    employeeId,
    date: day(date),
    kind: RosterEntryKind.WORK,
    shiftPatternId: patternId,
    ...shift,
    status: published ? RosterEntryStatus.PUBLISHED : RosterEntryStatus.DRAFT,
    publishedAt: published ? T.published : null,
    publishedById: published ? actorId : null,
    ...stamp(published ? T.published : T.draftRoster),
  })
  const week = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']
  await db.withScope(office, (client) =>
    client.rosterEntry.createMany({
      data: [
        ...week.map((date, index) =>
          rosterCell(index === 0 ? rosterIds.first : id(`time:roster:A1:operator:${date}`), employees.operator, site.A1, company.A, date, SHIFT.morning, pattern.twoShifts),
        ),
        rosterCell(rosterIds.draft, employees.operator, site.A1, company.A, '2026-11-02', SHIFT.morning, pattern.twoShifts, false),
        ...week.slice(0, 4).map((date) => rosterCell(id(`time:roster:A1:lead:${date}`), employees.lead, site.A1, company.A, date, SHIFT.afternoon, pattern.twoShifts)),
        rosterCell(id('time:roster:B1:operator:2026-10-27'), employees.b1Operator, site.B1, company.B, '2026-10-27', SHIFT.day, pattern.oneShift),
      ],
      skipDuplicates: true,
    }),
  )

  // --- planned overtime -------------------------------------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const asked = { askedAt: T.asked, askedById: actorId }
      if (!(await tx.overtimeRequest.findUnique({ where: { id: requestIds.draft }, select }))) {
        await tx.overtimeRequest.create({
          data: { id: requestIds.draft, companyId: company.A, siteId: site.A1, lineId: lineA1, date: day('2026-11-05'), startMinute: 840, minutes: 120, reason: 'Catch up the protector orders.', ...stamp(T.draftRoster) },
          select,
        })
        await tx.overtimeAgreement.create({ data: { id: agreementIds.draft, siteId: site.A1, requestId: requestIds.draft, employeeId: employees.operator, ...stamp(T.draftRoster) }, select })
      }
      if (!(await tx.overtimeRequest.findUnique({ where: { id: requestIds.agreed }, select }))) {
        await tx.overtimeRequest.create({
          data: { id: requestIds.agreed, companyId: company.A, siteId: site.A1, lineId: lineA1, date: day('2026-10-29'), startMinute: 840, minutes: 120, reason: 'Rush order: the jackets ship on Friday.', ...stamp(T.asked) },
          select,
        })
        await tx.overtimeAgreement.createMany({
          data: [
            { id: agreementIds.operator, siteId: site.A1, requestId: requestIds.agreed, employeeId: employees.operator, ...stamp(T.asked) },
            { id: agreementIds.lead, siteId: site.A1, requestId: requestIds.agreed, employeeId: employees.lead, ...stamp(T.asked) },
          ],
        })
        await tx.overtimeRequest.update({ where: { id: requestIds.agreed }, data: { status: OvertimeRequestStatus.ASKED, ...asked }, select })
        await tx.overtimeAgreement.update({
          where: { id: agreementIds.lead },
          data: { answer: OvertimeAnswer.DECLINED, answeredAt: T.leadDeclined, answeredVia: OvertimeAnswerChannel.OFFICE, answeredById: actorId },
          select,
        })
      }
      if (!(await tx.overtimeRequest.findUnique({ where: { id: requestIds.b1 }, select }))) {
        await tx.overtimeRequest.create({
          data: { id: requestIds.b1, companyId: company.B, siteId: site.B1, date: day('2026-10-28'), minutes: 60, reason: 'Stock count before the month end.', ...stamp(T.asked) },
          select,
        })
        await tx.overtimeAgreement.create({ data: { id: agreementIds.b1, siteId: site.B1, requestId: requestIds.b1, employeeId: employees.b1Operator, ...stamp(T.asked) }, select })
        await tx.overtimeRequest.update({ where: { id: requestIds.b1 }, data: { status: OvertimeRequestStatus.ASKED, ...asked }, select })
      }
    }),
  )
  // The operator agreed on the plant's tablet (the floor's own answer), then the request is AGREED.
  await db.withScope(floorOf(site.A1, worker.operator), (client) =>
    client.overtimeAgreement.updateMany({
      where: { id: agreementIds.operator, answer: OvertimeAnswer.PENDING },
      data: { answer: OvertimeAnswer.AGREED, answeredAt: T.operatorAgreed, answeredVia: OvertimeAnswerChannel.FLOOR, workerId: worker.operator, deviceId: device.A1 },
    }),
  )
  await db.withScope(office, (client) =>
    client.overtimeRequest.updateMany({ where: { id: requestIds.agreed, status: OvertimeRequestStatus.ASKED }, data: { status: OvertimeRequestStatus.AGREED, updatedAt: T.requestAgreed } }),
  )

  // --- clock events: the tablets' in the plants' floor scope, the automatic and the void in the office --------------
  const tablet = (key: string, siteId: string, companyId: string, employeeId: string, workerId: string, deviceId: string, kind: ClockEventKind, iso: string, source: ClockEventSource = ClockEventSource.BADGE): Prisma.ClockEventCreateManyInput => ({
    id: key,
    companyId,
    siteId,
    employeeId,
    workerId,
    deviceId,
    kind,
    source,
    occurredAt: at(iso),
    deviceTime: at(iso),
    receivedAt: plusSecond(iso),
    flags: source === ClockEventSource.NAME_PIN ? [ClockEventFlag.FORGOT_BADGE] : [],
    clientEventId: `seed-${key}`,
    createdAt: plusSecond(iso),
    createdById: workerId,
  })
  const operatorAt = (key: string, kind: ClockEventKind, iso: string, source?: ClockEventSource) =>
    tablet(key, site.A1, company.A, employees.operator, worker.operator, device.A1, kind, iso, source)
  await db.withScope(floorOf(site.A1, worker.operator), (client) =>
    client.clockEvent.createMany({
      data: [
        operatorAt(clockIds.firstIn, ClockEventKind.IN, '2026-10-27T04:58:00.000Z'),
        operatorAt(clock('A1:operator:2026-10-27:break-out'), ClockEventKind.BREAK_OUT, '2026-10-27T09:00:00.000Z'),
        operatorAt(clock('A1:operator:2026-10-27:break-in'), ClockEventKind.BREAK_IN, '2026-10-27T09:15:00.000Z'),
        operatorAt(clock('A1:operator:2026-10-27:out'), ClockEventKind.OUT, '2026-10-27T13:02:00.000Z'),
        operatorAt(clockIds.forgotBadge, ClockEventKind.IN, '2026-10-28T05:01:00.000Z', ClockEventSource.NAME_PIN),
        operatorAt(clock('A1:operator:2026-10-29:in'), ClockEventKind.IN, '2026-10-29T04:59:00.000Z'),
        operatorAt(clockIds.doubleIn, ClockEventKind.IN, '2026-10-29T05:00:00.000Z'),
        operatorAt(clock('A1:operator:2026-10-29:out'), ClockEventKind.OUT, '2026-10-29T15:05:00.000Z'),
        // The lead clocked in while the tablet was offline: dated by the tablet, received when it was back online.
        {
          ...tablet(clockIds.leadOffline, site.A1, company.A, employees.lead, worker.lead, device.A1, ClockEventKind.IN, '2026-10-27T12:55:00.000Z', ClockEventSource.OFFLINE),
          receivedAt: at('2026-10-27T13:20:00.000Z'),
          createdAt: at('2026-10-27T13:20:00.000Z'),
        },
        tablet(clock('A1:lead:2026-10-27:out'), site.A1, company.A, employees.lead, worker.lead, device.A1, ClockEventKind.OUT, '2026-10-27T21:00:00.000Z'),
      ],
      skipDuplicates: true,
    }),
  )
  await db.withScope(floorOf(site.B1, worker.b1Operator), (client) =>
    client.clockEvent.createMany({
      data: [
        tablet(clock('B1:operator:2026-10-27:in'), site.B1, company.B, employees.b1Operator, worker.b1Operator, device.B1, ClockEventKind.IN, '2026-10-27T07:00:00.000Z'),
        tablet(clock('B1:operator:2026-10-27:out'), site.B1, company.B, employees.b1Operator, worker.b1Operator, device.B1, ClockEventKind.OUT, '2026-10-27T16:00:00.000Z'),
      ],
      skipDuplicates: true,
    }),
  )
  const officeEvent = { companyId: company.A, siteId: site.A1, employeeId: employees.operator }
  await db.withScope(office, (client) =>
    client.clockEvent.createMany({
      data: [
        {
          id: clockIds.autoOut,
          ...officeEvent,
          kind: ClockEventKind.OUT,
          source: ClockEventSource.AUTO,
          occurredAt: at('2026-10-28T13:15:00.000Z'),
          receivedAt: at('2026-10-28T13:15:00.000Z'),
          reason: 'Shift end 14:00 + 15 min (People settings)',
          createdAt: at('2026-10-28T13:15:00.000Z'),
          createdById: null,
        },
      ],
      skipDuplicates: true,
    }),
  )
  await db.withScope(office, (client) =>
    client.clockEvent.createMany({
      data: [
        {
          id: clockIds.void,
          ...officeEvent,
          kind: ClockEventKind.VOID,
          source: ClockEventSource.MANUAL,
          occurredAt: at('2026-10-29T05:00:00.000Z'),
          receivedAt: T.voided,
          reason: 'Double badge scan at the kiosk.',
          voidsEventId: clockIds.doubleIn,
          createdAt: T.voided,
          createdById: actorId,
        },
      ],
      skipDuplicates: true,
    }),
  )

  // --- October: days, anomalies, absences, overtime, timesheet, the close being made --------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const operatorDay = { companyId: company.A, siteId: site.A1, employeeId: employees.operator, ...PLANNED.morning, breakMinutes: 15, ordinaryMinutes: 465, computedAt: T.computed }
      await tx.attendanceDay.createMany({
        data: [
          {
            id: dayIds.lead27,
            companyId: company.A,
            siteId: site.A1,
            employeeId: employees.lead,
            date: day('2026-10-27'),
            ...PLANNED.afternoon,
            firstInAt: at('2026-10-27T12:55:00.000Z'),
            lastOutAt: at('2026-10-27T21:00:00.000Z'),
            presentMinutes: 470,
            breakMinutes: 15,
            ordinaryMinutes: 465,
            computedAt: T.computed,
            ...stamp(T.computed),
          },
          { id: dayIds.operator27, ...operatorDay, date: day('2026-10-27'), firstInAt: at('2026-10-27T04:58:00.000Z'), lastOutAt: at('2026-10-27T13:02:00.000Z'), presentMinutes: 469, ...stamp(T.computed) },
          {
            id: dayIds.operator28,
            ...operatorDay,
            date: day('2026-10-28'),
            status: AttendanceDayStatus.NEEDS_FIX,
            firstInAt: at('2026-10-28T05:01:00.000Z'),
            lastOutAt: at('2026-10-28T13:15:00.000Z'),
            presentMinutes: 479,
            ...stamp(T.computed),
          },
          {
            id: dayIds.operator29,
            ...operatorDay,
            date: day('2026-10-29'),
            firstInAt: at('2026-10-29T04:59:00.000Z'),
            lastOutAt: at('2026-10-29T15:05:00.000Z'),
            presentMinutes: 591,
            overtimeMinutes: 120,
            manual: true,
            ...stamp(T.computed),
          },
          {
            id: dayIds.b1Operator27,
            companyId: company.B,
            siteId: site.B1,
            employeeId: employees.b1Operator,
            date: day('2026-10-27'),
            ...PLANNED.day,
            firstInAt: at('2026-10-27T07:00:00.000Z'),
            lastOutAt: at('2026-10-27T16:00:00.000Z'),
            presentMinutes: 480,
            breakMinutes: 60,
            ordinaryMinutes: 480,
            computedAt: T.computed,
            ...stamp(T.computed),
          },
        ],
        skipDuplicates: true,
      })
      await tx.attendanceDay.updateMany({
        where: { id: dayIds.operator27, status: AttendanceDayStatus.OPEN },
        data: { status: AttendanceDayStatus.APPROVED, approvedAt: T.approved27, approvedById: actorId },
      })
      const anomaly = { companyId: company.A, employeeId: employees.operator }
      await tx.attendanceAnomaly.createMany({
        data: [
          {
            id: anomalyIds.missingOut,
            ...anomaly,
            dayId: dayIds.operator28,
            kind: AttendanceAnomalyKind.MISSING_CLOCK_OUT,
            ruleKey: 'people.autoClockOut',
            clockEventId: clockIds.autoOut,
            detail: { shiftEndMinute: 840, toleranceMinutes: 15, autoClockOutAt: '2026-10-28T13:15:00.000Z' },
            raisedAt: at('2026-10-28T13:15:00.000Z'),
            ...stamp(at('2026-10-28T13:15:00.000Z'), null),
          },
          {
            id: anomalyIds.flagged,
            ...anomaly,
            dayId: dayIds.operator28,
            kind: AttendanceAnomalyKind.FLAGGED_EVENT,
            ruleKey: 'time.clock.flags',
            clockEventId: clockIds.forgotBadge,
            detail: { flags: [ClockEventFlag.FORGOT_BADGE] },
            raisedAt: at('2026-10-28T05:01:01.000Z'),
            ...stamp(at('2026-10-28T05:01:01.000Z'), null),
          },
          {
            id: anomalyIds.double,
            ...anomaly,
            dayId: dayIds.operator29,
            kind: AttendanceAnomalyKind.DOUBLE_CLOCK_IN,
            ruleKey: 'time.clock.double',
            clockEventId: clockIds.doubleIn,
            detail: { gapSeconds: 60 },
            raisedAt: at('2026-10-29T05:00:01.000Z'),
            ...stamp(at('2026-10-29T05:00:01.000Z'), null),
          },
        ],
        skipDuplicates: true,
      })
      await tx.attendanceAnomaly.updateMany({
        where: { id: anomalyIds.double, resolvedAt: null },
        data: { resolution: AnomalyResolution.FIXED, resolvedAt: T.voided, resolvedById: actorId },
      })
      await tx.absenceEntry.createMany({
        data: [
          { id: absenceIds.leadHoliday, companyId: company.A, employeeId: employees.lead, date: day('2026-10-30'), codeId: absenceCodeIds.FER as string, minutes: 465, ...stamp(T.published) },
          { id: absenceIds.operatorPermit, companyId: company.A, employeeId: employees.operator, date: day('2026-11-02'), codeId: absenceCodeIds.ROL as string, minutes: 120, ...stamp(T.draftRoster) },
        ],
        skipDuplicates: true,
      })
      await tx.overtimeEntry.createMany({
        data: [
          {
            id: overtimeEntryId,
            companyId: company.A,
            siteId: site.A1,
            employeeId: employees.operator,
            date: day('2026-10-29'),
            kind: OvertimeClass.DAY,
            minutes: 120,
            requestId: requestIds.agreed,
            ...stamp(T.computed, null),
          },
        ],
        skipDuplicates: true,
      })
      await tx.timesheetApproval.createMany({
        data: [{ id: timesheetIds.october, companyId: company.A, employeeId: employees.operator, periodStart: day('2026-10-01'), periodEnd: day('2026-10-31'), ...stamp(T.computed) }],
        skipDuplicates: true,
      })
      await tx.attendanceMonthClose.createMany({
        data: [{ id: monthCloseIds.october, companyId: company.A, month: day('2026-10-01'), note: 'Started; waiting for the open days and anomalies.', ...stamp(T.octoberClose, hrId) }],
        skipDuplicates: true,
      })
    }),
  )

  return {
    employees,
    ruleIds,
    absenceCodeIds,
    rosterIds,
    requestIds,
    agreementIds,
    clockIds,
    dayIds,
    anomalyIds,
    absenceIds,
    overtimeEntryId,
    timesheetIds,
    monthCloseIds,
    lulFileId,
    correctionIds,
  }
}

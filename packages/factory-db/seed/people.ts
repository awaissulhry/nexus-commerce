import { EmployeeContract, EmployeeKind, EmployeeStatus, LeaverCaseStatus, LeaverStepKind, LeaverStepStatus, MonitoringBasis, PeoplePurpose } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedCalendar } from './calendar'
import { seed as seedPrivacy } from './privacy'

/**
 * The people seed (W2b schema wave 4/7, B-W2b-06), per tenant of seed/_core.ts, written in the tenant's office scope as
 * the app does. Made-up people only: no real name, no tax code, nothing a real person could be found by (the repo is
 * public). On plant A1 of company A:
 *
 *   areas      "Sewing hall" (line L1 is in it) and "Cutting room"; plant B1 has its "Main hall" (B1's L1 in it).
 *   employees  E1 Seed Employee One (the A1 operator's floor sign-in points at it), E2 Seed Employee Two (the team lead:
 *              the A1 team leader's sign-in and the seed member's office account), E3 an AGENCY worker of P2 until
 *              2026-12-31 with no employee code, E4 an office clerk who is leaving (last day 2026-11-30), E5 a former
 *              employee (LEFT on 2026-06-30). On plant B1 of company B: EB1 (the B1 operator's sign-in). The B1 team
 *              leader's sign-in has no employee record (design "Floor workers with no employee record").
 *   teams      L1-A on A1's line L1: E2 its lead, E1 and E3 in it now, E5 until 2026-06-30; L1-B on B1's line: EB1.
 *   loan       E4 lent to line L1 (team L1-A) for the morning of 2026-11-03.
 *   leavers    E5's case DONE (every step done); E4's case OPEN: access end, open work, shifts and the payroll flag to
 *              do, floor sign-in and badge skipped (an office clerk has neither).
 *   settings   both companies' people settings (5 minutes of grace, no rounding, overtime by 15 minutes, no automatic
 *              clock-out, fixed breaks, groups of 3 at least, nobody but the worker sees one person's figures).
 *   gate       A1's ATTENDANCE gate switched on and off again the same morning (a decision of the past): no purpose is
 *              in force anywhere, so every per-person read stays refused (GATE-LABOUR: the safe default).
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy. So the rows those copies must pass with get ids starting with eight zeros: E1 (no office account: an account
 * links one employee), the area, E5's ended team membership (one team at a time counts only rows without an end), E5's
 * DONE case (one OPEN case per person), the first step of E4's OPEN case (steps change only while their case is OPEN),
 * and the switched-off gate (one gate in force per site and purpose). The workers and lines this seed links are other
 * modules' rows; it only sets their new columns.
 *
 * Idempotent: each record is written once, in one transaction, and skipped when it exists (the guards freeze closed
 * cases, ended gates and the like, so they are never written twice).
 */

const T = {
  setup: new Date('2026-10-01T08:00:00.000Z'),
  e5CaseStarted: new Date('2026-06-01T08:00:00.000Z'),
  e5CaseClosed: new Date('2026-07-02T09:00:00.000Z'),
  e4CaseStarted: new Date('2026-10-30T09:00:00.000Z'),
  e4Skipped: new Date('2026-10-30T09:05:00.000Z'),
  loanStart: new Date('2026-11-03T07:00:00.000Z'),
  loanEnd: new Date('2026-11-03T11:00:00.000Z'),
  gateOn: new Date('2026-11-13T09:00:00.000Z'),
  gateOff: new Date('2026-11-13T09:30:00.000Z'),
} as const
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`)

export interface PeopleSeed {
  /** A1's areas (sewing hall with line L1, cutting room) and B1's main hall. */
  readonly areaIds: { readonly sewing: string; readonly cutting: string; readonly mainB: string }
  /** Company A's people on plant A1 (E1-E5) and company B's EB1 on plant B1. */
  readonly employeeIds: { readonly e1: string; readonly e2: string; readonly e3: string; readonly e4: string; readonly e5: string; readonly eb1: string }
  readonly teamIds: { readonly a: string; readonly b: string }
  readonly loanId: string
  /** E5's DONE case and E4's OPEN one. */
  readonly caseIds: { readonly done: string; readonly open: string }
  readonly gateId: string
}

export async function seed(context: SeedContext): Promise<PeopleSeed> {
  const { db, namespace } = context
  // The gate names company A's worker notice and its stored impact assessment; the floor workers, the seed member and
  // the agency P2 come with them (privacy runs auth, files and floor-auth); the default shift is a calendar pattern.
  const privacy = await seedPrivacy(context)
  const { patternIds } = await seedCalendar(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** Ids that sort first (see above). */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const memberId = id('user:member')
  const company = { A: id('company:A'), B: id('company:B') }
  const site = { A1: id('site:A1'), B1: id('site:B1') }
  const line = { A1: id('site:A1:line:L1'), B1: id('site:B1:line:L1') }
  const worker = { a1Operator: id('worker:A1:operator'), a1Lead: id('worker:A1:lead'), b1Operator: id('worker:B1:operator') }
  const agency = id('party:P2')
  const office = { audience: 'office' as const, tenantId, actorId }
  const stamp = (at: Date = T.setup) => ({ createdAt: at, updatedAt: at, createdById: actorId })

  const areaIds = { sewing: firstId('people:area:A1:SEW'), cutting: id('people:area:A1:CUT'), mainB: id('people:area:B1:MAIN') }
  const employeeIds = {
    e1: firstId('people:employee:A1:1'),
    e2: id('people:employee:A1:2'),
    e3: id('people:employee:A1:3'),
    e4: id('people:employee:A:4'),
    e5: id('people:employee:A1:5'),
    eb1: id('people:employee:B1:1'),
  }
  const teamIds = { a: id('people:team:A1:L1-A'), b: id('people:team:B1:L1-B') }
  const loanId = id('people:loan:E4:2026-11-03')
  const caseIds = { done: firstId('people:leaver:E5:2026-06-30'), open: id('people:leaver:E4:2026-11-30') }
  const gateId = firstId('people:gate:A1:ATTENDANCE:2026-11-13')

  const atA1 = { companyId: company.A, siteId: site.A1 }
  const areas = [
    { id: areaIds.sewing, ...atA1, code: 'SEW-HALL', name: 'Sewing hall', sortOrder: 1 },
    { id: areaIds.cutting, ...atA1, code: 'CUT-ROOM', name: 'Cutting room', sortOrder: 2 },
    { id: areaIds.mainB, companyId: company.B, siteId: site.B1, code: 'MAIN-HALL', name: 'Main hall', sortOrder: 1 },
  ]
  const shift1T = patternIds['1T'] ?? null
  const employees = [
    {
      id: employeeIds.e1, ...atA1, employeeCode: 'SEED-A1-1', firstName: 'Seed', lastName: 'Employee One', displayName: 'Seed Worker A1-1', kind: EmployeeKind.EMPLOYEE,
      locale: 'it', startDate: day('2024-03-04'), department: 'Sewing', jobRole: 'Machinist', homeLineId: line.A1, contract: EmployeeContract.FULL_TIME, weeklyMinutes: 2400, defaultShiftPatternId: shift1T,
    },
    {
      id: employeeIds.e2, ...atA1, employeeCode: 'SEED-A1-2', firstName: 'Seed', lastName: 'Employee Two', displayName: 'Seed Worker A1-2', kind: EmployeeKind.EMPLOYEE,
      locale: 'en', startDate: day('2022-09-01'), department: 'Sewing', jobRole: 'Team leader', homeLineId: line.A1, contract: EmployeeContract.FULL_TIME, weeklyMinutes: 2400, defaultShiftPatternId: shift1T, userId: memberId,
    },
    {
      id: employeeIds.e3, ...atA1, employeeCode: null, firstName: 'Seed', lastName: 'Agency Worker', displayName: 'Seed Agency A1-3', kind: EmployeeKind.AGENCY, agencyPartyId: agency,
      locale: 'it', startDate: day('2026-09-01'), endDate: day('2026-12-31'), department: 'Sewing', jobRole: 'Machinist', homeLineId: line.A1, contract: EmployeeContract.PART_TIME, weeklyMinutes: 1200, defaultShiftPatternId: shift1T,
    },
    {
      id: employeeIds.e4, ...atA1, employeeCode: 'SEED-A-4', firstName: 'Seed', lastName: 'Office Clerk', displayName: 'Seed Office A-4', kind: EmployeeKind.EMPLOYEE,
      locale: 'it', startDate: day('2023-01-09'), department: 'Office', jobRole: 'Production clerk', contract: EmployeeContract.FULL_TIME, weeklyMinutes: 2400,
    },
    {
      id: employeeIds.e5, ...atA1, employeeCode: 'SEED-A1-5', firstName: 'Seed', lastName: 'Former Employee', displayName: 'Seed Former A1-5', kind: EmployeeKind.EMPLOYEE,
      locale: 'it', startDate: day('2021-04-12'), endDate: day('2026-06-30'), department: 'Sewing', jobRole: 'Cutter', homeLineId: line.A1, contract: EmployeeContract.FULL_TIME, weeklyMinutes: 2400,
    },
    {
      id: employeeIds.eb1, companyId: company.B, siteId: site.B1, employeeCode: 'SEED-B1-1', firstName: 'Seed', lastName: 'Employee B One', displayName: 'Seed Worker B1-1', kind: EmployeeKind.EMPLOYEE,
      locale: 'it', startDate: day('2025-01-07'), department: 'Sewing', jobRole: 'Machinist', homeLineId: line.B1, contract: EmployeeContract.FULL_TIME, weeklyMinutes: 2400,
    },
  ]
  const memberships = [
    // E5's ended membership first (see above).
    { id: firstId('people:member:E5:L1-A'), siteId: site.A1, teamId: teamIds.a, employeeId: employeeIds.e5, isLead: false, since: day('2021-04-12'), until: day('2026-06-30') },
    { id: id('people:member:E2:L1-A'), siteId: site.A1, teamId: teamIds.a, employeeId: employeeIds.e2, isLead: true, since: day('2022-09-01'), until: null },
    { id: id('people:member:E1:L1-A'), siteId: site.A1, teamId: teamIds.a, employeeId: employeeIds.e1, isLead: false, since: day('2024-03-04'), until: null },
    { id: id('people:member:E3:L1-A'), siteId: site.A1, teamId: teamIds.a, employeeId: employeeIds.e3, isLead: false, since: day('2026-09-01'), until: null },
    { id: id('people:member:EB1:L1-B'), siteId: site.B1, teamId: teamIds.b, employeeId: employeeIds.eb1, isLead: false, since: day('2025-01-07'), until: null },
  ]
  /** E4's open steps: the first sorts first (an OPEN step of an OPEN case: its copy passes). */
  const openSteps = [
    { id: firstId('people:step:E4:1'), kind: LeaverStepKind.ACCESS_ENDED, seq: 1, automatic: true, dueOn: day('2026-11-30') },
    { id: id('people:step:E4:2'), kind: LeaverStepKind.WORK_HANDED_OVER, seq: 2, automatic: false, dueOn: day('2026-11-30') },
    { id: id('people:step:E4:3'), kind: LeaverStepKind.SESSIONS_ENDED, seq: 3, automatic: true, dueOn: day('2026-11-30'), skip: 'No floor sign-in: an office clerk (made-up)' },
    { id: id('people:step:E4:4'), kind: LeaverStepKind.BADGE_RETURNED, seq: 4, automatic: false, dueOn: day('2026-11-30'), skip: 'No badge was issued (made-up)' },
    { id: id('people:step:E4:5'), kind: LeaverStepKind.SHIFTS_CLEARED, seq: 5, automatic: true, dueOn: day('2026-12-01') },
    { id: id('people:step:E4:6'), kind: LeaverStepKind.PAYROLL_FLAGGED, seq: 6, automatic: true, dueOn: null },
    { id: id('people:step:E4:7'), kind: LeaverStepKind.EXIT_VISIT, seq: 7, automatic: false, dueOn: null },
  ]
  /** E5's steps, every one done (the system ticked the automatic ones). */
  const doneSteps = [
    { id: id('people:step:E5:1'), kind: LeaverStepKind.BADGE_OFF, seq: 1, automatic: true, dueOn: day('2026-06-30'), doneAt: new Date('2026-06-30T20:00:00.000Z'), doneById: null },
    { id: id('people:step:E5:2'), kind: LeaverStepKind.BADGE_RETURNED, seq: 2, automatic: false, dueOn: day('2026-06-30'), doneAt: new Date('2026-06-30T15:00:00.000Z'), doneById: actorId },
    { id: id('people:step:E5:3'), kind: LeaverStepKind.SESSIONS_ENDED, seq: 3, automatic: true, dueOn: day('2026-06-30'), doneAt: new Date('2026-06-30T20:00:00.000Z'), doneById: null },
    { id: id('people:step:E5:4'), kind: LeaverStepKind.PPE_RETURNED, seq: 4, automatic: false, dueOn: day('2026-06-30'), doneAt: new Date('2026-06-30T15:05:00.000Z'), doneById: actorId },
    { id: id('people:step:E5:5'), kind: LeaverStepKind.SHIFTS_CLEARED, seq: 5, automatic: true, dueOn: day('2026-07-01'), doneAt: new Date('2026-07-01T02:00:00.000Z'), doneById: null },
    { id: id('people:step:E5:6'), kind: LeaverStepKind.PAYROLL_FLAGGED, seq: 6, automatic: true, dueOn: null, doneAt: new Date('2026-07-02T08:00:00.000Z'), doneById: null },
  ]

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      // --- areas and the lines in them -------------------------------------------------------------------------------
      for (const { id: rowId, ...data } of areas) {
        if (!(await tx.orgArea.findUnique({ where: { id: rowId }, select: { id: true } }))) await tx.orgArea.create({ data: { id: rowId, ...data, ...stamp() }, select: { id: true } })
      }
      await tx.line.update({ where: { id: line.A1 }, data: { areaId: areaIds.sewing }, select: { id: true } })
      await tx.line.update({ where: { id: line.B1 }, data: { areaId: areaIds.mainB }, select: { id: true } })

      // --- employees (E5 is written ACTIVE first: its leaver case is walked to DONE below, then it is LEFT) -------------
      for (const { id: rowId, ...data } of employees) {
        if (!(await tx.employee.findUnique({ where: { id: rowId }, select: { id: true } }))) await tx.employee.create({ data: { id: rowId, ...data, ...stamp() }, select: { id: true } })
      }
      // Their floor sign-in points at them (the B1 team leader's stays without a record).
      await tx.worker.update({ where: { id: worker.a1Operator }, data: { employeeId: employeeIds.e1 }, select: { id: true } })
      await tx.worker.update({ where: { id: worker.a1Lead }, data: { employeeId: employeeIds.e2 }, select: { id: true } })
      await tx.worker.update({ where: { id: worker.b1Operator }, data: { employeeId: employeeIds.eb1 }, select: { id: true } })

      // --- teams and members -----------------------------------------------------------------------------------------
      const teams = [
        { id: teamIds.a, ...atA1, lineId: line.A1, code: 'L1-A', name: 'Line 1 team' },
        { id: teamIds.b, companyId: company.B, siteId: site.B1, lineId: line.B1, code: 'L1-B', name: 'Line 1 team (B1)' },
      ]
      for (const { id: rowId, ...data } of teams) {
        if (!(await tx.team.findUnique({ where: { id: rowId }, select: { id: true } }))) await tx.team.create({ data: { id: rowId, ...data, ...stamp() }, select: { id: true } })
      }
      for (const { id: rowId, ...data } of memberships) {
        if (!(await tx.teamMember.findUnique({ where: { id: rowId }, select: { id: true } }))) await tx.teamMember.create({ data: { id: rowId, ...data, ...stamp() }, select: { id: true } })
      }

      // --- E4 lent to line L1 for a morning ----------------------------------------------------------------------------
      if (!(await tx.lineLoan.findUnique({ where: { id: loanId }, select: { id: true } }))) {
        await tx.lineLoan.create({
          data: { id: loanId, siteId: site.A1, employeeId: employeeIds.e4, toLineId: line.A1, toTeamId: teamIds.a, startsAt: T.loanStart, endsAt: T.loanEnd, reason: 'Help on the line for the packing peak (made-up)', ...stamp() },
          select: { id: true },
        })
      }

      // --- E5 left: the case started OPEN, every step done, closed DONE, then the person LEFT ----------------------------
      if (!(await tx.leaverCase.findUnique({ where: { id: caseIds.done }, select: { id: true } }))) {
        await tx.leaverCase.create({
          data: { id: caseIds.done, employeeId: employeeIds.e5, lastWorkingDay: day('2026-06-30'), status: LeaverCaseStatus.OPEN, startedAt: T.e5CaseStarted, startedById: actorId, ...stamp(T.e5CaseStarted) },
          select: { id: true },
        })
        for (const { doneAt, doneById, ...step } of doneSteps) {
          await tx.leaverStep.create({ data: { ...step, caseId: caseIds.done, ...stamp(T.e5CaseStarted) }, select: { id: true } })
          await tx.leaverStep.update({ where: { id: step.id }, data: { status: LeaverStepStatus.DONE, doneAt, doneById }, select: { id: true } })
        }
        await tx.leaverCase.update({ where: { id: caseIds.done }, data: { status: LeaverCaseStatus.DONE, closedAt: T.e5CaseClosed, closedById: actorId }, select: { id: true } })
      }
      await tx.employee.updateMany({ where: { id: employeeIds.e5, status: EmployeeStatus.ACTIVE }, data: { status: EmployeeStatus.LEFT } })

      // --- E4 is leaving: the case OPEN, two steps skipped ---------------------------------------------------------------
      if (!(await tx.leaverCase.findUnique({ where: { id: caseIds.open }, select: { id: true } }))) {
        await tx.leaverCase.create({
          data: { id: caseIds.open, employeeId: employeeIds.e4, lastWorkingDay: day('2026-11-30'), status: LeaverCaseStatus.OPEN, startedAt: T.e4CaseStarted, startedById: actorId, ...stamp(T.e4CaseStarted) },
          select: { id: true },
        })
        for (const { skip, ...step } of openSteps) {
          const skipped = skip ? { status: LeaverStepStatus.SKIPPED, doneAt: T.e4Skipped, doneById: actorId, skipReason: skip } : {}
          await tx.leaverStep.create({ data: { ...step, caseId: caseIds.open, ...skipped, ...stamp(T.e4CaseStarted) }, select: { id: true } })
        }
      }

      // --- people settings of both companies (the row has the company's id) ------------------------------------------
      for (const companyId of [company.A, company.B]) {
        if (!(await tx.peopleSettings.findUnique({ where: { id: companyId }, select: { id: true } }))) {
          await tx.peopleSettings.create({
            data: { id: companyId, companyId, earlyClockInFromShiftStart: true, lateGraceMinutes: 5, overtimeUnitMinutes: 15, roundingMinutes: 0, autoClockOutAfterMinutes: null, fixedBreaks: true, minimumGroupSize: 3, figureRoleKeys: [], ...stamp() },
            select: { id: true },
          })
        }
      }

      // --- A1's ATTENDANCE gate: switched on and off again (no purpose in force) ------------------------------------------
      if (!(await tx.peopleLegalGate.findUnique({ where: { id: gateId }, select: { id: true } }))) {
        await tx.peopleLegalGate.create({
          data: {
            id: gateId,
            ...atA1,
            purpose: PeoplePurpose.ATTENDANCE,
            basis: MonitoringBasis.NOT_REQUIRED,
            basisReference: 'SAMPLE - counsel opinion 2026/01: badge clock-in is a work tool (art. 4 c.2)',
            noticeId: privacy.workerNoticeId,
            dpiaId: privacy.dpiaId,
            switchedOnAt: T.gateOn,
            switchedOnById: actorId,
            switchedOffAt: T.gateOff,
            switchedOffById: actorId,
            switchOffReason: 'Switched on to try the setting; the labour lawyer has not confirmed the reading yet (made-up)',
            ...stamp(T.gateOn),
          },
          select: { id: true },
        })
      }
    }),
  )

  return { areaIds, employeeIds, teamIds, loanId, caseIds, gateId }
}

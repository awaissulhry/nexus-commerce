import { createHash } from 'node:crypto'
import {
  ChemicalQuantityUnit,
  ChemicalSignalWord,
  ChemicalUse,
  FitnessJudgementVoidReason,
  FitnessOutcome,
  GhsPictogram,
  HealthVisitCancelReason,
  HealthVisitStatus,
  HealthVisitType,
  IncidentActionLink,
  IncidentBodyPart,
  IncidentBodySide,
  IncidentInjuryNature,
  IncidentInvolvement,
  IncidentKind,
  IncidentReportedVia,
  IncidentSeverity,
  InailFilingStatus,
  InailFilingType,
  ProtectedRecordType,
  ProtectedViewWhat,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedPeople } from './people'
import { seed as seedPlant } from './plant'
import { seed as seedSafety } from './safety'

/**
 * The protected safety data seed (W2b schema wave 16/16, B-W2b-91), per tenant of seed/_core.ts, written as the app does: the
 * office's rows in the tenant's office scope, the floor's reports in plant A1's floor scope (an INSERT without RETURNING: the
 * floor never reads a report back). The CLI runs the seed files in name order, so this one runs the safety seed first
 * (idempotent; it runs people, plant and the calendar): role sheets, the doctor's appointment, the improvement plan's measure
 * from an incident, the open training session. Dates count from today (Europe/Rome), so due, overdue and expiring stay true
 * whenever it runs. Every person, product and number is made up.
 *
 *   plans        A1 Cutter: visits every 12 months; A1 Machinist: every 24 months (set by the company's doctor); B1 Machinist:
 *                no surveillance needed.
 *   visits       E1: the periodic one of last year DONE, the next DUE in 20 days, a return after a 75-day absence DUE 3 days
 *                ago (overdue); E2: a visit on request DONE 20 days ago, the periodic BOOKED in 12 days; E3: before the task
 *                DONE 100 days ago; E5: the periodic CANCELLED (left).
 *   judgements   E5's from a paper copy (expired long ago); E1 FIT_WITH_LIMITS (expires in 20 days); E2 TEMPORARILY_UNFIT until
 *                10 days from now; E3's first one recorded with the wrong details and VOIDED, then FIT.
 *   views        the HR member opened E1's judgement, printed the doctor's visit list, opened the injured person of the cut
 *                and showed the people of the incident list.
 *   incidents    B1: a near miss reported in the office (a person involved, not hurt). A1: E1 cut a hand at the cutting table
 *                (reported on the tablet with E1's sign-in; first aid, sent to hospital; seen by safety, LOST_DAYS; the
 *                insurance filing DUE, its 48 hours running from yesterday's certificate; three actions made into the
 *                press's maintenance job, the improvement plan's measure from this incident and the open training session);
 *                oil on the floor by sewing station 2, a hazard sent WITHOUT a name; the clicking press's missing guard (the
 *                unsafe-lock request) as a hazard from the office; a near miss on the walkway CLOSED with its action DONE; a
 *                duplicate report CANCELLED.
 *   chemicals    B1: a water-based adhesive (its first data sheet SUPERSEDED, the current one); A1: a contact glue in the
 *                cutting room's cabinet (current sheets in Italian and English, an older one superseded), an edge paint, an old
 *                solvent ARCHIVED. Every data sheet is a file of its chemical shared with the site's floor (the cabinet QR).
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id (tenant A for the
 * office, plant A1 for the floor) and insert the copy: so the first plan, visit (DUE), judgement (without a visit: one per
 * visit), view, incident and person (B1's office report and its person involved), action, filing, chemical and data sheet
 * (SUPERSEDED: one current per language) get ids that start with eight zeros, and the floor's first rows at A1 are the
 * nameless hazard and E1's person record (00000001…), valid floor inserts. Idempotent: written once, skipped when A1's Cutter
 * plan exists.
 */

export interface HealthSeed {
  /** A1 Cutter (sorts first), A1 Machinist, B1 Machinist. */
  readonly planIds: { readonly cutter: string; readonly machinist: string; readonly machinistB: string }
  readonly visitIds: {
    readonly e1Due: string
    readonly e1Done: string
    readonly e1Return: string
    readonly e2OnRequest: string
    readonly e2Booked: string
    readonly e3Preventive: string
    readonly e5Cancelled: string
  }
  readonly judgementIds: { readonly e5Paper: string; readonly e1Limits: string; readonly e2Unfit: string; readonly e3Voided: string; readonly e3Fit: string }
  /** B1's office near miss (sorts first), E1's cut (A1, floor), the nameless hazard (A1, floor; the floor's first), the press's guard, the closed near miss, the cancelled duplicate. */
  readonly incidentIds: { readonly b1NearMiss: string; readonly cut: string; readonly anonymousHazard: string; readonly pressGuard: string; readonly closed: string; readonly cancelled: string }
  /** EB1 involved in B1's near miss (sorts first), E1 injured in the cut (the floor's first at A1). */
  readonly personIds: { readonly b1Involved: string; readonly e1Injured: string }
  readonly filingId: string
  readonly chemicalIds: { readonly b1Adhesive: string; readonly glue: string; readonly edgePaint: string; readonly solvent: string }
}

const DAY_MS = 86_400_000

/** Today in Europe/Rome as a UTC midnight. */
function romeToday(): Date {
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return new Date(`${iso}T00:00:00.000Z`)
}

export async function seed(context: SeedContext): Promise<HealthSeed> {
  const { db, namespace } = context
  const safety = await seedSafety(context)
  // Already written by the safety seed (idempotent): their ids.
  const people = await seedPeople(context)
  const plant = await seedPlant(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** Ids that sort first (see above); the floor's first rows at A1 come just after B1's. */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const floorFirstId = (key: string): string => `00000001${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const memberId = id('user:member')
  const company = { A: id('company:A'), B: id('company:B') }
  const site = { A1: id('site:A1'), B1: id('site:B1') }
  const e = people.employeeIds
  const worker = { a1Operator: id('worker:A1:operator') }
  const device = { A1: id('device:A1:cutting') }
  const station = { cut: id('site:A1:station:CUT-01'), sew2: id('site:A1:station:SEW-02') }
  const area = { cutting: people.areaIds.cutting, mainB: people.areaIds.mainB }
  const machine = { press: plant.machineIds[1] }
  const store = id('files:account:r2')
  const office = { audience: 'office' as const, tenantId, actorId }
  const floorAs = (workerId: string) => ({ audience: 'floor' as const, tenantId, actorId: workerId, siteId: site.A1 })
  const select = { id: true } as const
  const sha = (key: string): string => createHash('sha256').update(`seed health ${key} (${namespace})`).digest('hex')

  const today = romeToday()
  const daysAgo = (days: number): Date => new Date(today.getTime() - days * DAY_MS)
  const daysAhead = (days: number): Date => new Date(today.getTime() + days * DAY_MS)
  /** A time of a day: 08:00 UTC plus minutes. */
  const at = (day: Date, minutes = 0): Date => new Date(day.getTime() + 8 * 3_600_000 + minutes * 60_000)
  const now = new Date()
  const stamp = (when: Date = now, by: string | null = actorId) => ({ createdAt: when, updatedAt: when, createdById: by })

  const planIds = { cutter: firstId('health:plan:A1:CUT'), machinist: id('health:plan:A1:SEW'), machinistB: id('health:plan:B1:SEW') }
  const visitIds = {
    e1Due: firstId('health:visit:E1:periodic:next'),
    e1Done: id('health:visit:E1:periodic:last'),
    e1Return: id('health:visit:E1:return'),
    e2OnRequest: id('health:visit:E2:request'),
    e2Booked: id('health:visit:E2:periodic'),
    e3Preventive: id('health:visit:E3:preventive'),
    e5Cancelled: id('health:visit:E5:periodic'),
  }
  const judgementIds = {
    e5Paper: firstId('health:judgement:E5:paper'),
    e1Limits: id('health:judgement:E1'),
    e2Unfit: id('health:judgement:E2'),
    e3Voided: id('health:judgement:E3:voided'),
    e3Fit: id('health:judgement:E3'),
  }
  const incidentIds = {
    b1NearMiss: firstId('health:incident:B1:near-miss'),
    // The improvement plan's measure from an incident (seed/safety.ts) names this id as its source.
    cut: id('safety:incident:made-up'),
    anonymousHazard: floorFirstId('health:incident:A1:oil'),
    pressGuard: id('health:incident:A1:press-guard'),
    closed: id('health:incident:A1:walkway'),
    cancelled: id('health:incident:A1:duplicate'),
  }
  const personIds = { b1Involved: firstId('health:person:B1:EB1'), e1Injured: floorFirstId('health:person:A1:E1') }
  const filingId = firstId('health:inail:E1:INSURANCE')
  const chemicalIds = { b1Adhesive: firstId('health:chemical:B1:adhesive'), glue: floorFirstId('health:chemical:A1:glue'), edgePaint: id('health:chemical:A1:edge-paint'), solvent: id('health:chemical:A1:solvent') }
  const result: HealthSeed = { planIds, visitIds, judgementIds, incidentIds, personIds, filingId, chemicalIds }

  const done = await db.withScope(office, (client) => client.healthPlan.findUnique({ where: { id: planIds.cutter }, select }))
  if (done) return result

  const doctor = safety.appointmentIds.doctor
  /** A data sheet's PDF: a file of its chemical, shared with the chemical's site floor (the cabinet QR opens it offline). */
  const sheetFile = (key: string, companyId: string, siteId: string, chemicalId: string, name: string, when: Date) => ({
    id: id(`health:file:${key}`),
    companyId,
    recordType: 'Chemical',
    recordId: chemicalId,
    kind: 'DOCUMENT' as const,
    originalName: name,
    contentType: 'application/pdf',
    sizeBytes: 4096,
    sha256: sha(`file ${key}`),
    storeAccountId: store,
    storageKey: `t/${tenantId}/c/${companyId}/health/${id(`health:file:key:${key}`)}`,
    status: 'AVAILABLE' as const,
    availableAt: when,
    visibility: ['OFFICE' as const, 'FLOOR' as const],
    floorSiteId: siteId,
    ...stamp(when),
  })

  // ------------------------------------------------------------------------------------------------------------------
  // Health surveillance (the office): plans, visits, judgements.
  // ------------------------------------------------------------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.healthPlan.create({
        data: { id: planIds.cutter, companyId: company.A, siteId: site.A1, roleSheetId: safety.roleSheetIds.cutter, key: `plan:${safety.roleSheetIds.cutter}`, needed: true, frequencyMonths: 12, setOn: daysAgo(400), doctorAppointmentId: doctor, ...stamp(at(daysAgo(400))) },
        select,
      })
      await tx.healthPlan.create({
        data: { id: planIds.machinist, companyId: company.A, siteId: site.A1, roleSheetId: safety.roleSheetIds.machinist, key: `plan:${safety.roleSheetIds.machinist}`, needed: true, frequencyMonths: 24, setOn: daysAgo(400), doctorAppointmentId: doctor, ...stamp(at(daysAgo(400))) },
        select,
      })
      await tx.healthPlan.create({
        data: { id: planIds.machinistB, companyId: company.B, siteId: site.B1, roleSheetId: safety.roleSheetIds.machinistB, key: `plan:${safety.roleSheetIds.machinistB}`, needed: false, setOn: daysAgo(10), ...stamp(at(daysAgo(10))) },
        select,
      })

      const cutterVisit = { companyId: company.A, planId: planIds.cutter, roleSheetId: safety.roleSheetIds.cutter }
      await tx.healthVisit.create({ data: { id: visitIds.e1Due, ...cutterVisit, employeeId: e.e1, type: HealthVisitType.PERIODIC, dueOn: daysAhead(20), ...stamp() }, select })
      await tx.healthVisit.create({
        data: {
          id: visitIds.e1Done, ...cutterVisit, employeeId: e.e1, type: HealthVisitType.PERIODIC, dueOn: daysAgo(340), status: HealthVisitStatus.DONE,
          bookedOn: daysAgo(345), bookedPlace: 'Seed occupational health clinic (made-up)', bookedAt: at(daysAgo(360)), bookedById: memberId, doneOn: daysAgo(345), ...stamp(at(daysAgo(370))),
        },
        select,
      })
      await tx.healthVisit.create({
        data: { id: visitIds.e1Return, companyId: company.A, employeeId: e.e1, roleSheetId: safety.roleSheetIds.cutter, type: HealthVisitType.RETURN_AFTER_ABSENCE, absenceDays: 75, dueOn: daysAgo(3), ...stamp(at(daysAgo(5))) },
        select,
      })
      await tx.healthVisit.create({
        data: { id: visitIds.e2OnRequest, companyId: company.A, employeeId: e.e2, type: HealthVisitType.ON_REQUEST, dueOn: daysAgo(18), status: HealthVisitStatus.DONE, doneOn: daysAgo(20), ...stamp(at(daysAgo(30))) },
        select,
      })
      await tx.healthVisit.create({
        data: {
          id: visitIds.e2Booked, companyId: company.A, planId: planIds.machinist, roleSheetId: safety.roleSheetIds.machinist, employeeId: e.e2, type: HealthVisitType.PERIODIC, dueOn: daysAhead(25),
          status: HealthVisitStatus.BOOKED, bookedOn: daysAhead(12), bookedPlace: 'Seed occupational health clinic (made-up)', bookedAt: at(daysAgo(2)), bookedById: memberId, ...stamp(at(daysAgo(40))),
        },
        select,
      })
      await tx.healthVisit.create({
        data: { id: visitIds.e3Preventive, companyId: company.A, planId: planIds.machinist, roleSheetId: safety.roleSheetIds.machinist, employeeId: e.e3, type: HealthVisitType.PREVENTIVE, dueOn: daysAgo(98), status: HealthVisitStatus.DONE, doneOn: daysAgo(100), ...stamp(at(daysAgo(110))) },
        select,
      })
      await tx.healthVisit.create({
        data: { id: visitIds.e5Cancelled, companyId: company.A, planId: planIds.machinist, roleSheetId: safety.roleSheetIds.machinist, employeeId: e.e5, type: HealthVisitType.PERIODIC, dueOn: daysAgo(100), ...stamp(at(daysAgo(200))) },
        select,
      })
      await tx.healthVisit.update({
        where: { id: visitIds.e5Cancelled },
        data: { status: HealthVisitStatus.CANCELLED, cancelledAt: at(daysAgo(120)), cancelledById: actorId, cancelReason: HealthVisitCancelReason.LEFT, version: { increment: 1 }, updatedAt: at(daysAgo(120)) },
        select,
      })

      await tx.fitnessJudgement.create({
        data: { id: judgementIds.e5Paper, companyId: company.A, employeeId: e.e5, outcome: FitnessOutcome.FIT, judgedOn: daysAgo(800), expiresOn: daysAgo(70), ...stamp(at(daysAgo(790))) },
        select,
      })
      await tx.fitnessJudgement.create({
        data: {
          id: judgementIds.e1Limits, companyId: company.A, employeeId: e.e1, visitId: visitIds.e1Done, outcome: FitnessOutcome.FIT_WITH_LIMITS,
          taskLimits: 'No lifting over 15 kg without help; ear defenders at the clicking press.', judgedOn: daysAgo(345), expiresOn: daysAhead(20), doctorAppointmentId: doctor, ...stamp(at(daysAgo(344))),
        },
        select,
      })
      await tx.fitnessJudgement.create({
        data: { id: judgementIds.e2Unfit, companyId: company.A, employeeId: e.e2, visitId: visitIds.e2OnRequest, outcome: FitnessOutcome.TEMPORARILY_UNFIT, unfitUntil: daysAhead(10), judgedOn: daysAgo(20), expiresOn: daysAhead(10), doctorAppointmentId: doctor, ...stamp(at(daysAgo(19))) },
        select,
      })
      await tx.fitnessJudgement.create({
        data: {
          id: judgementIds.e3Voided, companyId: company.A, employeeId: e.e3, visitId: visitIds.e3Preventive, outcome: FitnessOutcome.FIT_WITH_LIMITS, taskLimits: 'Typed by mistake.', judgedOn: daysAgo(100),
          expiresOn: daysAhead(630), doctorAppointmentId: doctor, ...stamp(at(daysAgo(99))),
        },
        select,
      })
      await tx.fitnessJudgement.update({
        where: { id: judgementIds.e3Voided },
        data: { voidedAt: at(daysAgo(99), 30), voidedById: actorId, voidReason: FitnessJudgementVoidReason.WRONG_DETAILS, version: { increment: 1 }, updatedAt: at(daysAgo(99), 30) },
        select,
      })
      await tx.fitnessJudgement.create({
        data: { id: judgementIds.e3Fit, companyId: company.A, employeeId: e.e3, visitId: visitIds.e3Preventive, outcome: FitnessOutcome.FIT, judgedOn: daysAgo(100), expiresOn: daysAhead(630), doctorAppointmentId: doctor, ...stamp(at(daysAgo(99), 35)) },
        select,
      })

      // ----------------------------------------------------------------------------------------------------------------
      // Incidents reported in the office: B1's near miss (its person involved, not hurt), the press's missing guard (the
      // unsafe-lock request), the walkway near miss (closed with its action done), a duplicate (cancelled).
      // ----------------------------------------------------------------------------------------------------------------
      const officeReport = { reportedVia: IncidentReportedVia.OFFICE, reportedById: memberId }
      await tx.incident.create({
        data: {
          id: incidentIds.b1NearMiss, companyId: company.B, siteId: site.B1, number: 'SEED-INC-0001', kind: IncidentKind.NEAR_MISS, occurredAt: at(daysAgo(6)), reportedAt: at(daysAgo(6), 30),
          what: 'A pallet slid off the lift truck forks while turning; nobody under it.', areaId: area.mainB, ...officeReport, ...stamp(at(daysAgo(6), 30), memberId),
        },
        select,
      })
      await tx.incidentPerson.create({
        data: { id: personIds.b1Involved, siteId: site.B1, incidentId: incidentIds.b1NearMiss, involvement: IncidentInvolvement.INVOLVED, employeeId: e.eb1, ...stamp(at(daysAgo(6), 31), memberId) },
        select,
      })
      await tx.incident.create({
        data: {
          id: incidentIds.pressGuard, companyId: company.A, siteId: site.A1, number: 'SEED-INC-0002', kind: IncidentKind.HAZARD, occurredAt: at(daysAgo(4)), reportedAt: at(daysAgo(4), 10),
          what: 'The guard of the clicking press is missing.', machineId: machine.press, stationId: station.cut, immediateAction: 'Press locked: do not use until signed safe.', maintenanceRequestId: plant.requestIds[1],
          ...officeReport, ...stamp(at(daysAgo(4), 10), memberId),
        },
        select,
      })
      await tx.incident.create({
        data: {
          id: incidentIds.closed, companyId: company.A, siteId: site.A1, number: 'SEED-INC-0003', kind: IncidentKind.NEAR_MISS, occurredAt: at(daysAgo(40)), reportedAt: at(daysAgo(40), 60),
          what: 'A trolley of bundles nearly hit a person where the walkway is not marked.', areaId: area.cutting, place: 'Walkway between cutting and sewing', severity: IncidentSeverity.NONE,
          ...officeReport, ...stamp(at(daysAgo(40), 60), memberId),
        },
        select,
      })
      await tx.incidentAction.create({
        data: { id: id('health:action:walkway:1'), siteId: site.A1, incidentId: incidentIds.closed, seq: 1, title: 'Mark the walkway with floor tape', ownerId: actorId, dueOn: daysAgo(30), ...stamp(at(daysAgo(39))) },
        select,
      })
      await tx.incidentAction.update({
        where: { id: id('health:action:walkway:1') },
        data: { status: 'DONE', doneAt: at(daysAgo(32)), doneById: actorId, evidenceNote: 'Yellow tape laid along the whole walkway.', version: { increment: 1 }, updatedAt: at(daysAgo(32)) },
        select,
      })
      await tx.incident.update({
        where: { id: incidentIds.closed },
        data: { seenAt: at(daysAgo(40), 90), seenById: actorId, status: 'CLOSED', closedAt: at(daysAgo(31)), closedById: actorId, version: { increment: 1 }, updatedAt: at(daysAgo(31)) },
        select,
      })
      await tx.incident.create({
        data: {
          id: incidentIds.cancelled, companyId: company.A, siteId: site.A1, number: 'SEED-INC-0004', kind: IncidentKind.HAZARD, occurredAt: at(daysAgo(4)), reportedAt: at(daysAgo(4), 20),
          what: 'Clicking press without its guard.', machineId: machine.press, ...officeReport, ...stamp(at(daysAgo(4), 20), memberId),
        },
        select,
      })
      await tx.incident.update({
        where: { id: incidentIds.cancelled },
        data: { status: 'CANCELLED', cancelledAt: at(daysAgo(4), 40), cancelledById: actorId, cancelReason: 'Duplicate of SEED-INC-0002.', version: { increment: 1 }, updatedAt: at(daysAgo(4), 40) },
        select,
      })
    }),
  )

  // ------------------------------------------------------------------------------------------------------------------
  // Plant A1's tablet: E1 reports the cut with their sign-in, and its person; a hazard comes in without a name. INSERT only:
  // the floor reads no report (createMany: no RETURNING), and names none of the office's columns.
  // ------------------------------------------------------------------------------------------------------------------
  await db.withScope(floorAs(worker.a1Operator), (client) =>
    client.$transaction(async (tx) => {
      await tx.incident.createMany({
        data: [
          {
            id: incidentIds.cut, companyId: company.A, siteId: site.A1, number: 'SEED-INC-0005', kind: IncidentKind.INJURY, occurredAt: at(daysAgo(2), 140), reportedAt: at(daysAgo(2), 150),
            what: 'Cut while changing the blade at cutting table 1.', areaId: area.cutting, stationId: station.cut, reportedVia: IncidentReportedVia.FLOOR, reportedByWorkerId: worker.a1Operator,
            deviceId: device.A1, createdAt: at(daysAgo(2), 150), updatedAt: at(daysAgo(2), 150),
          },
        ],
      })
      await tx.incidentPerson.createMany({
        data: [
          {
            id: personIds.e1Injured, siteId: site.A1, incidentId: incidentIds.cut, involvement: IncidentInvolvement.INJURED, employeeId: e.e1, bodyParts: [IncidentBodyPart.HAND, IncidentBodyPart.FINGER],
            bodySide: IncidentBodySide.LEFT, nature: IncidentInjuryNature.CUT, firstAidGiven: true, sentToHospital: true, createdAt: at(daysAgo(2), 151), updatedAt: at(daysAgo(2), 151),
          },
        ],
      })
      await tx.incident.createMany({
        data: [
          {
            id: incidentIds.anonymousHazard, companyId: company.A, siteId: site.A1, number: 'SEED-INC-0006', kind: IncidentKind.HAZARD, occurredAt: at(daysAgo(1), 60), reportedAt: at(daysAgo(1), 62),
            what: 'Oil on the floor next to sewing station 2.', stationId: station.sew2, reportedVia: IncidentReportedVia.FLOOR, reporterAnonymous: true, createdAt: at(daysAgo(1), 62), updatedAt: at(daysAgo(1), 62),
          },
        ],
      })
    }),
  )

  // ------------------------------------------------------------------------------------------------------------------
  // The office: safety sees the cut, sets its severity, the insurance filing waits 48 hours from the certificate, three
  // actions made into the press's job, the plan's measure and the open training session; the views of the protected data.
  // ------------------------------------------------------------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.incident.update({
        where: { id: incidentIds.cut },
        data: { seenAt: at(daysAgo(2), 170), seenById: actorId, severity: IncidentSeverity.LOST_DAYS, version: { increment: 1 }, updatedAt: at(daysAgo(2), 170) },
        select,
      })
      const certificate = at(daysAgo(1), 60)
      await tx.inailFiling.create({
        data: {
          id: filingId, siteId: site.A1, incidentId: incidentIds.cut, incidentPersonId: personIds.e1Injured, type: InailFilingType.INSURANCE, key: `inail:${personIds.e1Injured}:${InailFilingType.INSURANCE}`,
          expectedAbsenceDays: 5, certificateReference: 'SEED-CERT-0001', certificateReceivedAt: certificate, dueAt: new Date(certificate.getTime() + 48 * 3_600_000), status: InailFilingStatus.DUE,
          ...stamp(at(daysAgo(1), 70)),
        },
        select,
      })
      const action = { siteId: site.A1, incidentId: incidentIds.cut, ownerId: actorId }
      await tx.incidentAction.create({
        data: { id: firstId('health:action:cut:1'), ...action, seq: 1, title: 'Check the blade guard of cutting table 1', dueOn: daysAhead(3), madeInto: IncidentActionLink.MAINTENANCE_JOB, maintenanceJobId: plant.jobId, ...stamp(at(daysAgo(2), 180)) },
        select,
      })
      await tx.incidentAction.create({
        data: { id: id('health:action:cut:2'), ...action, seq: 2, title: 'Add a blade guard to the improvement plan', dueOn: daysAhead(15), madeInto: IncidentActionLink.RISK_MEASURE, riskMeasureId: id('safety:measure:A1:incident'), ...stamp(at(daysAgo(2), 181)) },
        select,
      })
      await tx.incidentAction.create({
        data: { id: id('health:action:cut:3'), ...action, seq: 3, title: 'Retrain on the blade change', dueOn: daysAhead(10), madeInto: IncidentActionLink.TRAINING_SESSION, trainingSessionId: safety.sessionIds.open, ...stamp(at(daysAgo(2), 182)) },
        select,
      })

      const view = { viewerId: memberId }
      await tx.protectedView.create({
        data: { id: firstId('health:view:E1:judgement'), companyId: company.A, recordType: ProtectedRecordType.FITNESS_JUDGEMENT, recordId: judgementIds.e1Limits, employeeId: e.e1, what: ProtectedViewWhat.OPEN, viewedAt: at(daysAgo(30)), ...view },
        select,
      })
      await tx.protectedView.create({
        data: { id: id('health:view:visit-list'), companyId: company.A, recordType: ProtectedRecordType.HEALTH_VISIT_LIST, what: ProtectedViewWhat.PRINT, viewedAt: at(daysAgo(3)), ...view },
        select,
      })
      await tx.protectedView.create({
        data: { id: id('health:view:E1:injury'), companyId: company.A, recordType: ProtectedRecordType.INCIDENT_PERSON, recordId: personIds.e1Injured, employeeId: e.e1, what: ProtectedViewWhat.OPEN, viewedAt: at(daysAgo(2), 171), ...view },
        select,
      })
      await tx.protectedView.create({
        data: { id: id('health:view:incident-people'), companyId: company.A, recordType: ProtectedRecordType.INCIDENT_PEOPLE_LIST, what: ProtectedViewWhat.LIST, viewedAt: at(daysAgo(1), 120), ...view },
        select,
      })

      // ----------------------------------------------------------------------------------------------------------------
      // Chemicals and their data sheets.
      // ----------------------------------------------------------------------------------------------------------------
      await tx.chemical.create({
        data: { id: chemicalIds.b1Adhesive, companyId: company.B, siteId: site.B1, name: 'Seed water-based adhesive (made-up)', supplierName: 'Seed Adhesives (made-up)', use: ChemicalUse.GLUE, storagePlace: 'Main hall, shelf 2', ...stamp(at(daysAgo(300))) },
        select,
      })
      await tx.chemical.create({
        data: {
          id: chemicalIds.glue, companyId: company.A, siteId: site.A1, name: 'Seed contact glue (made-up)', supplierPartyId: id('party:P2'), use: ChemicalUse.GLUE,
          ghsPictograms: [GhsPictogram.GHS02, GhsPictogram.GHS07], signalWord: ChemicalSignalWord.DANGER, hazardStatements: ['H225', 'H319', 'H336', 'EUH066'], precautionStatements: ['P210', 'P233', 'P305+P351+P338'],
          storagePlace: 'Glue cabinet, cutting room', cabinetCode: 'CAB-CUT-1', maxQuantity: '25', maxQuantityUnit: ChemicalQuantityUnit.L, roleSheetIds: [safety.roleSheetIds.cutter], ppeItemIds: [safety.ppeItemIds.gloves],
          ...stamp(at(daysAgo(300))),
        },
        select,
      })
      await tx.chemical.create({
        data: {
          id: chemicalIds.edgePaint, companyId: company.A, siteId: site.A1, name: 'Seed edge paint (made-up)', supplierName: 'Seed Finishes (made-up)', use: ChemicalUse.EDGE_PAINT, ghsPictograms: [GhsPictogram.GHS07],
          signalWord: ChemicalSignalWord.WARNING, hazardStatements: ['H319'], precautionStatements: ['P280'], storagePlace: 'Glue cabinet, cutting room', cabinetCode: 'CAB-CUT-1', maxQuantity: '5', maxQuantityUnit: ChemicalQuantityUnit.L,
          roleSheetIds: [safety.roleSheetIds.machinist], ...stamp(at(daysAgo(200))),
        },
        select,
      })
      await tx.chemical.create({
        data: { id: chemicalIds.solvent, companyId: company.A, siteId: site.A1, name: 'Seed old solvent (made-up)', use: ChemicalUse.SOLVENT, ghsPictograms: [GhsPictogram.GHS02], storagePlace: 'Glue cabinet, cutting room', ...stamp(at(daysAgo(500))) },
        select,
      })
      await tx.chemical.update({ where: { id: chemicalIds.solvent }, data: { status: 'ARCHIVED', version: { increment: 1 }, updatedAt: at(daysAgo(100)) }, select })

      const sheets = [
        { key: 'B1:adhesive:v1', at: site.B1, companyId: company.B, chemicalId: chemicalIds.b1Adhesive, versionLabel: '1.0', revisedOn: daysAgo(900), language: 'it', superseded: at(daysAgo(200)), id: firstId('health:sds:B1:adhesive:v1') },
        { key: 'B1:adhesive:v2', at: site.B1, companyId: company.B, chemicalId: chemicalIds.b1Adhesive, versionLabel: '2.0', revisedOn: daysAgo(210), language: 'it', superseded: null, id: id('health:sds:B1:adhesive:v2') },
        { key: 'A1:glue:v3.0', at: site.A1, companyId: company.A, chemicalId: chemicalIds.glue, versionLabel: '3.0', revisedOn: daysAgo(800), language: 'it', superseded: at(daysAgo(60)), id: floorFirstId('health:sds:A1:glue:v3.0') },
        { key: 'A1:glue:v3.1:it', at: site.A1, companyId: company.A, chemicalId: chemicalIds.glue, versionLabel: '3.1', revisedOn: daysAgo(70), language: 'it', superseded: null, id: id('health:sds:A1:glue:v3.1:it') },
        { key: 'A1:glue:v3.1:en', at: site.A1, companyId: company.A, chemicalId: chemicalIds.glue, versionLabel: '3.1', revisedOn: daysAgo(70), language: 'en', superseded: null, id: id('health:sds:A1:glue:v3.1:en') },
        { key: 'A1:edge:v1', at: site.A1, companyId: company.A, chemicalId: chemicalIds.edgePaint, versionLabel: '1', revisedOn: daysAgo(400), language: 'it', superseded: null, id: id('health:sds:A1:edge:v1') },
      ]
      for (const sheet of sheets) {
        const received = sheet.superseded ? at(daysAgo(850)) : at(daysAgo(65))
        const pdf = sheetFile(sheet.key, sheet.companyId, sheet.at, sheet.chemicalId, `Seed SDS ${sheet.key}.pdf`, received)
        await tx.storedFile.create({ data: pdf, select })
        await tx.safetyDataSheet.create({
          data: { id: sheet.id, siteId: sheet.at, chemicalId: sheet.chemicalId, versionLabel: sheet.versionLabel, revisedOn: sheet.revisedOn, language: sheet.language, fileId: pdf.id, ...stamp(received) },
          select,
        })
        if (sheet.superseded) {
          await tx.safetyDataSheet.update({ where: { id: sheet.id }, data: { status: 'SUPERSEDED', supersededAt: sheet.superseded, supersededById: actorId, version: { increment: 1 }, updatedAt: sheet.superseded }, select })
        }
      }
    }),
  )
  return result
}

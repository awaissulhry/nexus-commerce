import { createHash } from 'node:crypto'
import {
  CheckIntervalUnit,
  CheckOutcome,
  CheckPlanStatus,
  DieCondition,
  MachineStatus,
  MaintenanceJobSource,
  MaintenanceJobStatus,
  MaintenanceJobType,
  MaintenancePriority,
  MaintenanceRequestStatus,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedCutting } from './cutting'
import { seed as seedFiles } from './files'
import { seed as seedPeople } from './people'
import { seed as seedPlant } from './plant'

/**
 * The plant care seed (W2b schema wave 14/16, B-W2b-86), per tenant of seed/_core.ts, on plant A1, written as the app does: the
 * office's rows in the tenant's office scope, the station's and the technician's in A1's floor scope. The CLI runs this file
 * after seed/plant.ts by name; it runs the seeds it builds on first anyway (idempotent).
 *
 *   classes      post-bed and walking-foot machines need an authorisation (the classes seed/skills.ts keeps under one at A1).
 *   check types  press guards and two-hand controls (in house, every 3 months, the press's class), earthing (an outside body,
 *                every 2 years), pressure vessels (an outside body, yearly, kept 5 years), lifting equipment (retired).
 *   plans        on the clicking press SEED-CP-01: an ended monthly guards plan, the quarterly guards plan now, earthing.
 *   results      the guards check PASSED in August, with its report (a file of the result); the same check corrected (the
 *                day was typed wrong); the guards check FAILED in November (the front guard missing), which made the
 *                statutory-check job SEED-MJ-0002.
 *   history      the press's lock (seed/plant.ts) and the cutting table's day below are in its status history, written by the
 *                machine's own trigger.
 *   request      the operator at the cutting table reports SEED-CT-01's blade guard loose (the machine down): routed by the
 *                fallback rule to E2, escalated once to E3; the A1 lead (as the technician) acknowledges it and is on the way;
 *                the office makes job SEED-MJ-0003; the technician starts it and hands it back running, with the failure code
 *                and the minutes; the operator confirms the table works, the lead confirms the job. The job stays HANDED_BACK.
 *   files        the A1 floor adds a before-work photo of the press's job SEED-MJ-0001 (announced, not uploaded yet) and a
 *                voice note of the cutting table's request (confirmed).
 *   dies         JKT-01: front left in 50 and 52 (worn), the sleeve for every size, and a retired die.
 *   settings     A1's plant rules: Owner answer H1 (anyone at the station locks, only a technician signs safe), a hazard report
 *                on lock.
 *   routing      lockstitch requests to the line team L1-A (escalated to E2 after 10 minutes, to E3 after 30); every other class
 *                to E2 (escalated to E3 after 15).
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the copy:
 * so the first check type, the ENDED plan (a copy of an active plan would break "one active plan per machine and type"), the
 * PASSED result, the first die, the first routing rule and the floor's announced photo (the floor adds only an announced photo
 * or voice note of a request or job) get ids that start with eight zeros. The requests and jobs of seed/plant.ts stay those
 * tables' first rows: nothing here changes them. Every name, number and value is invented; numbers are made-up SEED- numbers,
 * not the company's MAINTENANCE_JOB series. Idempotent: written once, skipped when A1's plant settings exist.
 */

const T = {
  setup: new Date('2026-10-29T08:00:00.000Z'),
  firstEnded: new Date('2026-07-01T08:00:00.000Z'),
  passed: new Date('2026-08-20T09:00:00.000Z'),
  corrected: new Date('2026-08-22T09:00:00.000Z'),
  failed: new Date('2026-11-20T09:40:00.000Z'),
  checkJob: new Date('2026-11-20T10:00:00.000Z'),
  reported: new Date('2026-11-21T07:50:00.000Z'),
  escalated: new Date('2026-11-21T08:05:00.000Z'),
  acknowledged: new Date('2026-11-21T08:07:00.000Z'),
  onTheWay: new Date('2026-11-21T08:09:00.000Z'),
  job: new Date('2026-11-21T08:15:00.000Z'),
  started: new Date('2026-11-21T08:20:00.000Z'),
  handedBack: new Date('2026-11-21T08:45:00.000Z'),
  confirmed: new Date('2026-11-21T08:55:00.000Z'),
  leadConfirmed: new Date('2026-11-21T09:00:00.000Z'),
  photo: new Date('2026-11-21T09:10:00.000Z'),
} as const

const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`)

export interface PlantCareSeed {
  readonly checkTypeIds: { readonly guards: string; readonly earthing: string; readonly pressure: string; readonly lifting: string }
  /** The ENDED monthly guards plan (sorts first), the quarterly guards plan, the earthing plan: all on SEED-CP-01. */
  readonly planIds: { readonly ended: string; readonly guards: string; readonly earthing: string }
  /** August's PASSED guards check (sorts first), its correction, November's FAILED one. */
  readonly resultIds: { readonly passed: string; readonly correction: string; readonly failed: string }
  /** SEED-MJ-0002 (from the failed check, NEW), SEED-MJ-0003 (the cutting table's, HANDED_BACK). */
  readonly jobIds: { readonly fromCheck: string; readonly cuttingTable: string }
  /** The cutting table's request (JOB_MADE, confirmed working). */
  readonly requestId: string
  readonly dieIds: { readonly front50: string; readonly front52: string; readonly sleeve: string; readonly retired: string }
  /** A1's settings row (its id is the site's). */
  readonly settingsId: string
  /** Lockstitch → team L1-A (sorts first); every class → E2. */
  readonly ruleIds: { readonly lockstitch: string; readonly fallback: string }
  /** The floor's announced photo of SEED-MJ-0001 (sorts first), its confirmed voice note of the request. */
  readonly fileIds: { readonly photo: string; readonly voice: string }
}

export async function seed(context: SeedContext): Promise<PlantCareSeed> {
  const { db, namespace } = context
  const plant = await seedPlant(context)
  const people = await seedPeople(context)
  const cutting = await seedCutting(context)
  await seedFiles(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** Ids that sort first (see above). */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const operatorId = id('worker:A1:operator')
  const leadId = id('worker:A1:lead')
  const styleId = id('product:style:JKT-01')
  const supplierId = id('party:P2')
  const store = id('files:account:r2')
  const office = { audience: 'office' as const, tenantId, actorId }
  const floorAs = (workerId: string) => ({ audience: 'floor' as const, tenantId, actorId: workerId, siteId: siteA })
  const stamp = (at: Date, by: string | null = actorId) => ({ createdAt: at, updatedAt: at, createdById: by })
  const select = { id: true } as const
  const sha = (key: string): string => createHash('sha256').update(`seed plant care ${key} (${namespace})`).digest('hex')
  const storageKey = (key: string): string => `t/${tenantId}/c/${companyA}/2026/${id(`plantcare:file:key:${key}`)}`
  const press = plant.machineIds[1]
  const cuttingTable = plant.machineIds[2]
  const atA1 = { companyId: companyA, siteId: siteA }

  const checkTypeIds = {
    guards: firstId('plantcare:check-type:PRESS_GUARDS'),
    earthing: id('plantcare:check-type:EARTHING'),
    pressure: id('plantcare:check-type:PRESSURE_VESSEL'),
    lifting: id('plantcare:check-type:LIFTING'),
  }
  const planIds = { ended: firstId('plantcare:plan:CP-01:guards:monthly'), guards: id('plantcare:plan:CP-01:guards'), earthing: id('plantcare:plan:CP-01:earthing') }
  const resultIds = { passed: firstId('plantcare:result:CP-01:2026-08'), correction: id('plantcare:result:CP-01:2026-08:correction'), failed: id('plantcare:result:CP-01:2026-11') }
  const jobIds = { fromCheck: id('plantcare:job:MJ-0002'), cuttingTable: id('plantcare:job:MJ-0003') }
  const requestId = id('plantcare:request:CT-01:blade-guard')
  const dieIds = { front50: firstId('plantcare:die:D-0001'), front52: id('plantcare:die:D-0002'), sleeve: id('plantcare:die:D-0003'), retired: id('plantcare:die:D-0004') }
  const settingsId = siteA
  const ruleIds = { lockstitch: firstId('plantcare:rule:A1:lockstitch'), fallback: id('plantcare:rule:A1:fallback') }
  const fileIds = { photo: firstId('plantcare:file:MJ-0001:before'), voice: id('plantcare:file:CT-01:voice') }
  const result: PlantCareSeed = { checkTypeIds, planIds, resultIds, jobIds, requestId, dieIds, settingsId, ruleIds, fileIds }

  const done = await db.withScope(office, (client) => client.plantSettings.findUnique({ where: { id: settingsId }, select }))
  if (done) return result

  // --- the office's lists, plans, results, dies, settings and routing ---------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      for (const code of ['POST_BED', 'WALKING_FOOT']) {
        await tx.machineClass.update({ where: { id: plant.classIds[code]! }, data: { authorisationRequired: true, version: { increment: 1 }, updatedAt: T.setup }, select })
      }
      await tx.machineCheckType.createMany({
        data: [
          {
            id: checkTypeIds.guards,
            code: 'PRESS_GUARDS',
            labelIt: 'Protezioni e comando a due mani',
            labelEn: 'Guards and two-hand control',
            legalBasis: 'D.Lgs. 81/2008 art. 71 c.4 and c.9',
            classId: plant.classIds['CLICKING_PRESS']!,
            defaultInterval: 3,
            defaultIntervalUnit: CheckIntervalUnit.MONTH,
            sortOrder: 0,
            ...stamp(T.setup),
          },
          {
            id: checkTypeIds.earthing,
            code: 'EARTHING',
            labelIt: 'Verifica impianto di terra',
            labelEn: 'Earthing check',
            legalBasis: 'DPR 462/2001 (made-up interval)',
            defaultInterval: 2,
            defaultIntervalUnit: CheckIntervalUnit.YEAR,
            outsideBody: true,
            sortOrder: 1,
            ...stamp(T.setup),
          },
          {
            id: checkTypeIds.pressure,
            code: 'PRESSURE_VESSEL',
            labelIt: 'Apparecchi a pressione',
            labelEn: 'Pressure vessels',
            legalBasis: 'D.Lgs. 81/2008 art. 71 c.11, Annex VII',
            defaultInterval: 1,
            defaultIntervalUnit: CheckIntervalUnit.YEAR,
            outsideBody: true,
            retentionYears: 5,
            sortOrder: 2,
            ...stamp(T.setup),
          },
          {
            id: checkTypeIds.lifting,
            code: 'LIFTING',
            labelIt: 'Apparecchi di sollevamento',
            labelEn: 'Lifting equipment',
            legalBasis: 'D.Lgs. 81/2008 art. 71 c.11, Annex VII',
            defaultInterval: 1,
            defaultIntervalUnit: CheckIntervalUnit.YEAR,
            outsideBody: true,
            sortOrder: 3,
            active: false,
            ...stamp(T.setup),
          },
        ],
      })
      await tx.machineCheckPlan.createMany({
        data: [
          {
            id: planIds.ended,
            ...atA1,
            machineId: press,
            checkTypeId: checkTypeIds.guards,
            interval: 1,
            intervalUnit: CheckIntervalUnit.MONTH,
            firstDueOn: day('2026-01-20'),
            nextDueOn: day('2026-07-20'),
            reminderDays: 7,
            status: CheckPlanStatus.ENDED,
            endedAt: T.firstEnded,
            endedReason: 'Replaced by the quarterly plan (made-up).',
            ...stamp(T.firstEnded),
          },
          {
            id: planIds.guards,
            ...atA1,
            machineId: press,
            checkTypeId: checkTypeIds.guards,
            interval: 3,
            intervalUnit: CheckIntervalUnit.MONTH,
            ownerId: actorId,
            firstDueOn: day('2026-08-20'),
            nextDueOn: day('2026-11-20'),
            reminderDays: 14,
            ...stamp(T.firstEnded),
          },
          {
            id: planIds.earthing,
            ...atA1,
            machineId: press,
            checkTypeId: checkTypeIds.earthing,
            interval: 2,
            intervalUnit: CheckIntervalUnit.YEAR,
            firstDueOn: day('2027-03-15'),
            nextDueOn: day('2027-03-15'),
            note: 'The outside body is booked by the office (made-up).',
            ...stamp(T.setup),
          },
        ],
      })
      // The register: August's check, its correction, November's failure (append-only rows, each written once).
      await tx.machineCheckResult.create({
        data: {
          id: resultIds.passed,
          ...atA1,
          machineId: press,
          checkTypeId: checkTypeIds.guards,
          planId: planIds.guards,
          performedOn: day('2026-08-20'),
          outcome: CheckOutcome.PASSED,
          performedBy: 'Seed maintenance (in house)',
          nextDueOn: day('2026-11-20'),
          keptUntil: day('2029-08-20'),
          createdAt: T.passed,
          createdById: actorId,
        },
        select,
      })
      await tx.machineCheckResult.create({
        data: {
          id: resultIds.correction,
          ...atA1,
          machineId: press,
          checkTypeId: checkTypeIds.guards,
          planId: planIds.guards,
          performedOn: day('2026-08-21'),
          outcome: CheckOutcome.PASSED,
          performedBy: 'Seed maintenance (in house)',
          nextDueOn: day('2026-11-21'),
          keptUntil: day('2029-08-21'),
          correctsId: resultIds.passed,
          correctionReason: 'The day was typed wrong: the check was done on the 21st (made-up).',
          createdAt: T.corrected,
          createdById: actorId,
        },
        select,
      })
      await tx.machineCheckResult.create({
        data: {
          id: resultIds.failed,
          ...atA1,
          machineId: press,
          checkTypeId: checkTypeIds.guards,
          planId: planIds.guards,
          performedOn: day('2026-11-20'),
          outcome: CheckOutcome.FAILED,
          remarks: 'The front guard is off its hinges; the two-hand control could not be tested (made-up).',
          performedBy: 'Seed maintenance (in house)',
          keptUntil: day('2029-11-20'),
          createdAt: T.failed,
          createdById: actorId,
        },
        select,
      })
      await tx.machineCheckPlan.update({ where: { id: planIds.guards }, data: { nextDueOn: day('2027-02-20'), version: { increment: 1 }, updatedAt: T.failed }, select })
      // August's report, a file of its result.
      await tx.storedFile.create({
        data: {
          id: id('plantcare:file:CP-01:2026-08:report'),
          companyId: companyA,
          recordType: 'MachineCheckResult',
          recordId: resultIds.passed,
          kind: 'DOCUMENT',
          category: 'CHECK_REPORT',
          originalName: 'Seed guards check 2026-08.pdf',
          contentType: 'application/pdf',
          sizeBytes: 2048,
          sha256: sha('report 2026-08'),
          storeAccountId: store,
          storageKey: storageKey('report 2026-08'),
          status: 'AVAILABLE',
          availableAt: T.passed,
          visibility: ['OFFICE'],
          ...stamp(T.passed),
        },
        select,
      })
      // The failed check makes the job (QHS-205).
      await tx.maintenanceJob.create({
        data: {
          id: jobIds.fromCheck,
          ...atA1,
          number: 'SEED-MJ-0002',
          machineId: press,
          type: MaintenanceJobType.SAFETY,
          source: MaintenanceJobSource.STATUTORY_CHECK,
          checkResultId: resultIds.failed,
          problem: 'Failed guards check: refit the front guard, then test the two-hand control.',
          priority: MaintenancePriority.P1,
          status: MaintenanceJobStatus.NEW,
          ...stamp(T.checkJob),
        },
        select,
      })

      await tx.clickingDie.createMany({
        data: [
          { id: dieIds.front50, ...atA1, code: 'SEED-D-0001', styleId, size: '50', piece: 'Front left', patternPieceId: cutting.patternPieceIds.front, rackLocation: 'Rack R1, shelf 1', material: 'Steel rule', supplierId, purchaseCost: 18000, ...stamp(T.setup) },
          { id: dieIds.front52, ...atA1, code: 'SEED-D-0002', styleId, size: '52', piece: 'Front left', patternPieceId: cutting.patternPieceIds.front, rackLocation: 'Rack R1, shelf 2', material: 'Steel rule', supplierId, purchaseCost: 18500, condition: DieCondition.WORN, note: 'Edge rounded at the collar: order a new one (made-up).', ...stamp(T.setup) },
          { id: dieIds.sleeve, ...atA1, code: 'SEED-D-0003', styleId, piece: 'Sleeve', patternPieceId: cutting.patternPieceIds.sleeve, rackLocation: 'Rack R2', material: 'Forged steel', supplierId, purchaseCost: 26000, ...stamp(T.setup) },
          { id: dieIds.retired, ...atA1, code: 'SEED-D-0004', styleId, size: '54', piece: 'Front left', rackLocation: 'Rack R9 (scrap)', material: 'Steel rule', ...stamp(T.setup) },
        ],
      })
      await tx.clickingDie.update({ where: { id: dieIds.retired }, data: { condition: DieCondition.RETIRED, note: 'Cracked; kept for the record (made-up).', version: { increment: 1 }, updatedAt: T.setup }, select })

      await tx.plantSettings.create({ data: { id: settingsId, ...atA1, ...stamp(T.setup) }, select })
      await tx.requestRoutingRule.createMany({
        data: [
          {
            id: ruleIds.lockstitch,
            ...atA1,
            seq: 0,
            machineClassId: plant.classIds['LOCKSTITCH']!,
            teamId: people.teamIds.a,
            escalateAfterMinutes: 10,
            escalateToId: people.employeeIds.e2,
            escalateAgainAfterMinutes: 30,
            escalateAgainToId: people.employeeIds.e3,
            ...stamp(T.setup),
          },
          { id: ruleIds.fallback, ...atA1, seq: 1, technicianId: people.employeeIds.e2, escalateAfterMinutes: 15, escalateToId: people.employeeIds.e3, ...stamp(T.setup) },
        ],
      })
    }),
  )

  // --- the cutting table's day: a report from the station, routed and escalated ------------------------------------------
  await db.withScope(floorAs(operatorId), (client) =>
    client.$transaction(async (tx) => {
      await tx.maintenanceRequest.create({
        data: {
          id: requestId,
          ...atA1,
          machineId: cuttingTable,
          symptomId: plant.symptomIds['OTHER'],
          description: 'The blade guard of the round knife is loose (made-up).',
          reportedAt: T.reported,
          reportedByWorkerId: operatorId,
          stationId: id('site:A1:station:CUT-01'),
          deviceId: id('device:A1:cutting'),
          routingRuleId: ruleIds.fallback,
          routedEmployeeId: people.employeeIds.e2,
          ...stamp(T.reported, operatorId),
        },
        select,
      })
      await tx.machine.update({ where: { id: cuttingTable }, data: { status: MachineStatus.DOWN, statusSince: T.reported, statusReason: 'Reported down at the cutting table: blade guard loose.', version: { increment: 1 }, updatedAt: T.reported }, select })
    }),
  )
  await db.withScope(office, (client) =>
    client.maintenanceRequest.update({ where: { id: requestId }, data: { escalationLevel: 1, escalatedAt: T.escalated, version: { increment: 1 }, updatedAt: T.escalated }, select }),
  )
  // The A1 lead, looking after the machines here: acknowledged, on the way.
  await db.withScope(floorAs(leadId), (client) =>
    client.maintenanceRequest.update({
      where: { id: requestId },
      data: { status: MaintenanceRequestStatus.ACKNOWLEDGED, acknowledgedAt: T.acknowledged, acknowledgedByWorkerId: leadId, version: { increment: 1 }, updatedAt: T.acknowledged },
      select,
    }),
  )
  await db.withScope(floorAs(leadId), (client) =>
    client.maintenanceRequest.update({ where: { id: requestId }, data: { onTheWayAt: T.onTheWay, onTheWayByWorkerId: leadId, version: { increment: 1 }, updatedAt: T.onTheWay }, select }),
  )
  // The office makes the job for the lead.
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.maintenanceJob.create({
        data: {
          id: jobIds.cuttingTable,
          ...atA1,
          number: 'SEED-MJ-0003',
          machineId: cuttingTable,
          type: MaintenanceJobType.CORRECTIVE,
          source: MaintenanceJobSource.REQUEST,
          problem: 'Other: the blade guard of the round knife is loose.',
          symptomId: plant.symptomIds['OTHER'],
          priority: MaintenancePriority.P2,
          assigneeWorkerId: leadId,
          status: MaintenanceJobStatus.NEW,
          ...stamp(T.job),
        },
        select,
      })
      await tx.maintenanceRequest.update({ where: { id: requestId }, data: { status: MaintenanceRequestStatus.JOB_MADE, jobId: jobIds.cuttingTable, version: { increment: 1 }, updatedAt: T.job }, select })
    }),
  )
  // The technician works it on the floor and hands the table back running, with the one-screen close.
  await db.withScope(floorAs(leadId), (client) =>
    client.$transaction(async (tx) => {
      await tx.maintenanceJob.update({ where: { id: jobIds.cuttingTable }, data: { status: MaintenanceJobStatus.IN_PROGRESS, startedAt: T.started, version: { increment: 1 }, updatedAt: T.started }, select })
      await tx.machine.update({ where: { id: cuttingTable }, data: { status: MachineStatus.UNDER_MAINTENANCE, statusSince: T.started, statusReason: 'Job SEED-MJ-0003 started.', version: { increment: 1 }, updatedAt: T.started }, select })
    }),
  )
  await db.withScope(floorAs(leadId), (client) =>
    client.$transaction(async (tx) => {
      await tx.maintenanceJob.update({
        where: { id: jobIds.cuttingTable },
        data: {
          status: MaintenanceJobStatus.HANDED_BACK,
          handedBackAt: T.handedBack,
          handedBackByWorkerId: leadId,
          workDone: 'Adjusted: tightened the guard screws and checked the blade.',
          machineAfter: MachineStatus.RUNNING,
          failureCode: 'LOOSE_PART',
          minutesSpent: 25,
          version: { increment: 1 },
          updatedAt: T.handedBack,
        },
        select,
      })
      await tx.machine.update({ where: { id: cuttingTable }, data: { status: MachineStatus.RUNNING, statusSince: T.handedBack, statusReason: null, version: { increment: 1 }, updatedAt: T.handedBack }, select })
    }),
  )
  // The operator confirms the table works; the lead confirms the job.
  await db.withScope(floorAs(operatorId), (client) =>
    client.maintenanceRequest.update({ where: { id: requestId }, data: { confirmedWorksAt: T.confirmed, confirmedWorksByWorkerId: operatorId, version: { increment: 1 }, updatedAt: T.confirmed }, select }),
  )
  await db.withScope(floorAs(leadId), (client) =>
    client.maintenanceJob.update({ where: { id: jobIds.cuttingTable }, data: { leadConfirmedAt: T.leadConfirmed, leadConfirmedByWorkerId: leadId, version: { increment: 1 }, updatedAt: T.leadConfirmed }, select }),
  )

  // --- the floor's photo and voice note (QHS-189) ------------------------------------------------------------------------
  const floorFile = (fileId: string, recordType: string, recordId: string, kind: 'PHOTO' | 'AUDIO', contentType: string, name: string) => ({
    id: fileId,
    companyId: companyA,
    recordType,
    recordId,
    kind,
    originalName: name,
    contentType,
    sizeBytes: 4096,
    sha256: sha(name),
    storeAccountId: store,
    storageKey: storageKey(name),
    visibility: ['OFFICE' as const, 'FLOOR' as const],
    floorSiteId: siteA,
    ...stamp(T.photo, null),
  })
  await db.withScope(floorAs(leadId), (client) =>
    client.$transaction(async (tx) => {
      await tx.storedFile.create({ data: { ...floorFile(fileIds.photo, 'MaintenanceJob', plant.jobId, 'PHOTO', 'image/jpeg', 'Seed press guard before work.jpg'), category: 'BEFORE_WORK' }, select })
      await tx.storedFile.create({ data: floorFile(fileIds.voice, 'MaintenanceRequest', requestId, 'AUDIO', 'audio/webm', 'Seed cutting table voice note.webm'), select })
      await tx.storedFile.update({ where: { id: fileIds.voice }, data: { status: 'AVAILABLE', availableAt: T.photo, version: { increment: 1 }, updatedAt: T.photo }, select })
    }),
  )
  return result
}

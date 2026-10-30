import type { Prisma } from '../src/generated/prisma/client'
import {
  MachineStatus,
  MaintenanceJobSource,
  MaintenanceJobStatus,
  MaintenanceJobType,
  MaintenancePriority,
  MaintenanceRequestStatus,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedFloorAuth } from './floor-auth'

/**
 * The W2a plant seed (schema wave 6/7), per tenant of seed/_core.ts: the machine classes and the symptoms a station
 * reports, two machines of plant A1, two requests from its stations and one maintenance job. The office's rows are
 * written in the tenant's office scope, the requests in A1's floor scope (the operator at the station), as the app does
 * (the CLI runs this file after seed/floor-auth.ts by name; it runs that seed first anyway).
 *
 *   classes    lockstitch, post-bed and walking-foot sewing machines, a cutting table, a clicking press, a heat press.
 *   symptoms   for every class: won't start, noise, oil leak, guard missing (unsafe: it marks the machine unsafe at
 *              once, Owner answer H1), other (with a photo or a note); for a lockstitch: thread breaks, skipped
 *              stitches; for a clicking press: the two-hand control fails (unsafe).
 *   machines   SEED-SEW-L1-01, a lockstitch at sewing station 1 (RUNNING); SEED-CP-01, the clicking press at the cutting
 *              table, DO_NOT_USE: locked as unsafe (its guard is missing).
 *   requests   the operator at sewing station 1 reports thread breaks (NEW); the operator at the cutting table reports
 *              the guard missing (unsafe: the press is DO_NOT_USE in the same transaction); maintenance acknowledged it
 *              and made a job; no technician has signed it safe yet.
 *   job        SEED-MJ-0001, a safety job for the press (P1), PLANNED for the office's technician, due the next morning.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: a machine is registered in use, a request starts NEW (a floor session's names a worker or the station), a job
 * starts NEW or PLANNED. So the lockstitch class, the "won't start" symptom, the lockstitch machine, the thread-breaks
 * request and the job get ids that start with eight zeros (still derived from the namespace).
 *
 * Every name, number and value is invented; the machines' cost is made up. Idempotent: classes, symptoms and machines
 * are upserted (the machines' status only when they are made); the requests and the job are written once and skipped
 * when they exist.
 */

/** Fixed instants and dates, so the seed never depends on the clock. */
const T = {
  setup: new Date('2026-10-29T08:00:00.000Z'),
  threadReport: new Date('2026-11-20T10:05:00.000Z'),
  guardReport: new Date('2026-11-20T09:12:00.000Z'),
  acknowledged: new Date('2026-11-20T09:20:00.000Z'),
  job: new Date('2026-11-20T09:30:00.000Z'),
  due: new Date('2026-11-21T08:00:00.000Z'),
} as const

const AMBER = '#D97706'
const RED = '#DC2626'
const SLATE = '#475569'

export interface PlantSeed {
  readonly classIds: Readonly<Record<string, string>>
  readonly symptomIds: Readonly<Record<string, string>>
  /** SEED-SEW-L1-01 (RUNNING), SEED-CP-01 (DO_NOT_USE, locked). */
  readonly machineIds: readonly [string, string]
  /** The thread-breaks request (NEW) and the unsafe guard-missing one (JOB_MADE, not signed safe). */
  readonly requestIds: readonly [string, string]
  readonly jobId: string
}

export async function seed(context: SeedContext): Promise<PlantSeed> {
  const { db, namespace } = context
  await seedFloorAuth(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** Ids that sort first (see above). */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const operatorId = id('worker:A1:operator')
  const station = { sew: id('site:A1:station:SEW-01'), cut: id('site:A1:station:CUT-01') }
  const workCentre = { sew: id('site:A1:work-centre:SEW'), cut: id('site:A1:work-centre:CUT') }
  const cuttingTablet = id('device:A1:cutting')
  const office = { audience: 'office' as const, tenantId, actorId }
  const floor = { audience: 'floor' as const, tenantId, actorId: operatorId, siteId: siteA }
  const stamp = (at: Date, by: string = actorId) => ({ createdAt: at, updatedAt: at, createdById: by })
  const select = { id: true } as const

  // --- classes and symptoms: upserted ---------------------------------------------------------------------------------
  const classIds: Record<string, string> = {}
  const classes: (Prisma.MachineClassUncheckedCreateInput & { id: string })[] = (
    [
      ['LOCKSTITCH', 'Lineare', 'Lockstitch', 'needle'],
      ['POST_BED', 'Colonna', 'Post-bed', 'needle'],
      ['WALKING_FOOT', 'Triplo trasporto', 'Walking-foot', 'needle'],
      ['CUTTING_TABLE', 'Tavolo di taglio', 'Cutting table', 'scissors'],
      ['CLICKING_PRESS', 'Trancia', 'Clicking press', 'stamp'],
      ['HEAT_PRESS', 'Pressa a caldo', 'Heat press', 'flame'],
    ] as const
  ).map(([code, labelIt, labelEn, icon], index) => {
    const classId = index === 0 ? firstId(`plant:class:${code}`) : id(`plant:class:${code}`)
    classIds[code] = classId
    return { id: classId, code, labelIt, labelEn, icon, sortOrder: index, ...stamp(T.setup) }
  })
  const symptomIds: Record<string, string> = {}
  const symptoms: (Prisma.MachineSymptomUncheckedCreateInput & { id: string })[] = (
    [
      ['WONT_START', null, 'Non parte', "Won't start", 'power', SLATE, false, false],
      ['NOISE', null, 'Rumore', 'Noise', 'volume', SLATE, false, false],
      ['OIL_LEAK', null, 'Perdita d’olio', 'Oil leak', 'droplet', AMBER, false, false],
      ['GUARD_MISSING', null, 'Protezione mancante', 'Guard missing', 'shield-off', RED, true, false],
      ['OTHER', null, 'Altro', 'Other', null, null, false, true],
      ['THREAD_BREAKS', 'LOCKSTITCH', 'Il filo si rompe', 'Thread breaks', 'scissors', AMBER, false, false],
      ['SKIPPED_STITCHES', 'LOCKSTITCH', 'Salta i punti', 'Skipped stitches', 'needle', AMBER, false, false],
      ['TWO_HAND_CONTROL', 'CLICKING_PRESS', 'Comando a due mani guasto', 'Two-hand control fails', 'hand', RED, true, false],
    ] as const
  ).map(([code, machineClass, labelIt, labelEn, icon, colour, unsafe, needsDetail], index) => {
    const symptomId = index === 0 ? firstId(`plant:symptom:${code}`) : id(`plant:symptom:${code}`)
    symptomIds[code] = symptomId
    return { id: symptomId, classId: machineClass ? classIds[machineClass] : null, code, labelIt, labelEn, icon, colour, unsafe, needsDetail, sortOrder: index, ...stamp(T.setup) }
  })

  // --- machines: upserted, the status only when they are made ---------------------------------------------------------
  const machineIds = [firstId('plant:machine:SEED-SEW-L1-01'), id('plant:machine:SEED-CP-01')] as const
  const machines: (Prisma.MachineUncheckedCreateInput & { id: string })[] = [
    {
      id: machineIds[0],
      companyId: companyA,
      siteId: siteA,
      assetNumber: 'SEED-SEW-L1-01',
      classId: classIds['LOCKSTITCH']!,
      make: 'Seedmac',
      modelName: 'LS-100',
      serialNumber: 'SM-0001',
      year: 2021,
      stationId: station.sew,
      workCentreId: workCentre.sew,
      purchaseCost: 185000,
      statusSince: T.setup,
      ...stamp(T.setup),
    },
    {
      id: machineIds[1],
      companyId: companyA,
      siteId: siteA,
      assetNumber: 'SEED-CP-01',
      classId: classIds['CLICKING_PRESS']!,
      make: 'Seedpress',
      modelName: 'CP-20',
      serialNumber: 'SP-0042',
      year: 2018,
      stationId: station.cut,
      workCentreId: workCentre.cut,
      purchaseCost: 920000,
      statusSince: T.setup,
      note: 'The swing-beam press of the cutting room.',
      ...stamp(T.setup),
    },
  ]
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      for (const { id: rowId, createdAt, createdById, ...data } of classes) {
        await tx.machineClass.upsert({ where: { id: rowId }, create: { id: rowId, createdAt, createdById, ...data }, update: data, select })
      }
      for (const { id: rowId, createdAt, createdById, ...data } of symptoms) {
        await tx.machineSymptom.upsert({ where: { id: rowId }, create: { id: rowId, createdAt, createdById, ...data }, update: data, select })
      }
      for (const { id: rowId, createdAt, createdById, status, statusSince, statusReason, updatedAt, ...data } of machines) {
        await tx.machine.upsert({ where: { id: rowId }, create: { id: rowId, createdAt, createdById, updatedAt, status, statusSince, statusReason, ...data }, update: data, select })
      }
    }),
  )

  // --- the requests, from the stations (the operator) -----------------------------------------------------------------
  const requestIds = [firstId('plant:request:SEW-L1-01:thread'), id('plant:request:CP-01:guard')] as const
  const jobId = firstId('plant:job:MJ-0001')
  await db.withScope(floor, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.maintenanceRequest.findUnique({ where: { id: requestIds[0] }, select })) return
      await tx.maintenanceRequest.create({
        data: {
          id: requestIds[0],
          companyId: companyA,
          siteId: siteA,
          machineId: machineIds[0],
          symptomId: symptomIds['THREAD_BREAKS'],
          description: 'The needle thread breaks every few stitches on heavy leather.',
          reportedAt: T.threadReport,
          reportedByWorkerId: operatorId,
          stationId: station.sew,
          ...stamp(T.threadReport, operatorId),
        },
        select,
      })
    }),
  )
  await db.withScope(floor, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.maintenanceRequest.findUnique({ where: { id: requestIds[1] }, select })) return
      // Unsafe (H1): the request and the press DO_NOT_USE in one transaction, at once.
      await tx.maintenanceRequest.create({
        data: {
          id: requestIds[1],
          companyId: companyA,
          siteId: siteA,
          machineId: machineIds[1],
          symptomId: symptomIds['GUARD_MISSING'],
          description: 'The front guard of the press is off its hinges.',
          unsafe: true,
          reportedAt: T.guardReport,
          reportedByWorkerId: operatorId,
          stationId: station.cut,
          deviceId: cuttingTablet,
          ...stamp(T.guardReport, operatorId),
        },
        select,
      })
      await tx.machine.update({
        where: { id: machineIds[1] },
        data: { status: MachineStatus.DO_NOT_USE, statusSince: T.guardReport, statusReason: 'Locked as unsafe: guard missing (reported at the cutting table).', version: { increment: 1 }, updatedAt: T.guardReport },
        select,
      })
    }),
  )

  // --- the job for the press (the office triages the request) ---------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.maintenanceJob.findUnique({ where: { id: jobId }, select })) return
      await tx.maintenanceJob.create({
        data: {
          id: jobId,
          companyId: companyA,
          siteId: siteA,
          number: 'SEED-MJ-0001',
          machineId: machineIds[1],
          type: MaintenanceJobType.SAFETY,
          source: MaintenanceJobSource.REQUEST,
          problem: 'Guard missing on the clicking press: refit the front guard and test the two-hand control.',
          symptomId: symptomIds['GUARD_MISSING'],
          priority: MaintenancePriority.P1,
          assigneeId: actorId,
          dueAt: T.due,
          status: MaintenanceJobStatus.PLANNED,
          ...stamp(T.job),
        },
        select,
      })
      await tx.maintenanceRequest.update({
        where: { id: requestIds[1] },
        data: { status: MaintenanceRequestStatus.JOB_MADE, acknowledgedAt: T.acknowledged, acknowledgedById: actorId, jobId, version: 2, updatedAt: T.job },
        select,
      })
    }),
  )

  return { classIds, symptomIds, machineIds, requestIds, jobId }
}

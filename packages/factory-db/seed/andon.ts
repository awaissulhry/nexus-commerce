import { HandoverTopic, HelpCallKind, HelpCallStatus, OffStandardSource, OffStandardStatus } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seedOffStandardCodes, type OffStandardCodeKey } from './labour'
import { seed as seedPeople } from './people'
import { seed as seedProduction, type ProductionSeed } from './production'

/**
 * The line's signals seed (W2b schema wave 7/7, B-W2b-12), per tenant of seed/_core.ts, on plant A1's line L1, written
 * as the app does: the routing and targets in the tenant's office scope, the calls, the team leader's reason and the
 * handover note in A1's floor scope.
 *
 *   routing      three help-call types of A1 (codes of the HELP_CALL reason list): MATERIAL (answered by the line team
 *                L1-A of seed/people.ts, escalated after 10 minutes), MAINTENANCE (the same team, 5 minutes), TEAM_LEADER
 *                (the site's team leaders, never escalated); the waiting books to WAIT_HELP (seed/labour.ts). The caller
 *                is named with the employee behind the operator's sign-in (E1).
 *   calls        17 Nov: a material call from SEW-01 (09:10 Rome) seen at 09:12, on the way at 09:14, solved at 09:22 by
 *                the team leader, with the operator's waiting booked (WAIT_HELP, approved as it ended); a maintenance call
 *                from SEW-02 at 13:05 still SENT (no caller named).
 *   targets      L1 on 17 Nov, 6 pieces an hour from 08:00 to 11:00 Rome; the team leader's reason for the short 10:00
 *                hour (BREAKDOWN: the needle plate of SEW-02).
 *   handover     L1's note for shift A on 17 Nov: half-done bundles and machines, with a short text.
 *
 * The generated isolation tests copy the FIRST row of each table by id and insert the copy: the first call is SOLVED (one
 * open call per station and type), the first target is the 08:00 hour. Those rows get ids that start with eight zeros,
 * the others (and the waiting block this seed adds to seed/labour.ts's table) with eight f's. Every name and value is
 * invented. Idempotent: each record is written once and skipped when it exists.
 */

const T = {
  routing: new Date('2026-11-01T08:00:00.000Z'),
  sent: new Date('2026-11-17T08:10:00.000Z'),
  seen: new Date('2026-11-17T08:12:00.000Z'),
  onTheWay: new Date('2026-11-17T08:14:00.000Z'),
  solved: new Date('2026-11-17T08:22:00.000Z'),
  machine: new Date('2026-11-17T12:05:00.000Z'),
  targets: new Date('2026-11-16T16:00:00.000Z'),
  shortHour: new Date('2026-11-17T10:05:00.000Z'),
  handover: new Date('2026-11-17T12:50:00.000Z'),
} as const
const DAY = new Date('2026-11-17T00:00:00.000Z')
/** L1's hourly targets on 17 Nov (hours of the day, Rome). */
const HOURS = [8, 9, 10, 11] as const

export interface AndonSeed {
  readonly production: ProductionSeed
  readonly codeIds: Record<OffStandardCodeKey, string>
  readonly typeIds: { readonly material: string; readonly maintenance: string; readonly teamLeader: string }
  /** The SOLVED material call, the SENT maintenance call. */
  readonly callIds: readonly [string, string]
  /** The operator's waiting on the material call (WAIT_HELP, APPROVED). */
  readonly waitingBlockId: string
  /** L1's targets of 17 Nov, 08:00 to 11:00. */
  readonly targetIds: readonly string[]
  readonly handoverNoteId: string
}

export async function seed(context: SeedContext): Promise<AndonSeed> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order (this one early): the line, stations, workers and tablet come from the production
  // seed (it runs the core, floor sign-in and privacy seeds), the employees and the line team from the people seed, the
  // off-standard codes from seed/labour.ts (all idempotent).
  const production = await seedProduction(context)
  const people = await seedPeople(context)
  const codeIds = await seedOffStandardCodes(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const lineL1 = id('site:A1:line:L1')
  const station = { sew1: id('site:A1:station:SEW-01'), sew2: id('site:A1:station:SEW-02') }
  const { operatorId, leadId, deviceId } = production
  const office = { audience: 'office' as const, tenantId, actorId }
  const floorAs = (workerId: string) => ({ audience: 'floor' as const, tenantId, actorId: workerId, siteId: siteA })
  const select = { id: true } as const

  const typeIds = { material: firstId('andon:type:A1:MATERIAL'), maintenance: lastId('andon:type:A1:MAINTENANCE'), teamLeader: lastId('andon:type:A1:TEAM_LEADER') }
  const callIds = [firstId('andon:call:A1:material'), lastId('andon:call:A1:maintenance')] as const
  const waitingBlockId = lastId('andon:off-standard:A1:material-call')
  const targetIds = HOURS.map((hour) => (hour === HOURS[0] ? firstId : lastId)(`andon:target:A1:L1:2026-11-17:${hour}`))
  const handoverNoteId = firstId('andon:handover:A1:L1:2026-11-17:A')

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const types = [
        { typeId: typeIds.material, code: 'MATERIAL', kind: HelpCallKind.MATERIAL, responderTeamId: people.teamIds.a, escalateAfterMinutes: 10, sortOrder: 10 },
        { typeId: typeIds.maintenance, code: 'MAINTENANCE', kind: HelpCallKind.MAINTENANCE, responderTeamId: people.teamIds.a, escalateAfterMinutes: 5, sortOrder: 20 },
        { typeId: typeIds.teamLeader, code: 'TEAM_LEADER', kind: HelpCallKind.SUPERVISOR, responderTeamId: null, escalateAfterMinutes: null, sortOrder: 30 },
      ]
      for (const { typeId, code, kind, ...routing } of types) {
        const data = { ...routing, offStandardCodeId: codeIds.WAIT_HELP }
        await tx.helpCallType.upsert({
          where: { id: typeId },
          create: { id: typeId, companyId: companyA, siteId: siteA, code, kind, ...data, createdAt: T.routing, updatedAt: T.routing, createdById: actorId },
          update: data,
          select,
        })
      }
      for (const [index, hour] of HOURS.entries()) {
        if (await tx.lineTarget.findUnique({ where: { id: targetIds[index]! }, select })) continue
        await tx.lineTarget.create({ data: { id: targetIds[index]!, siteId: siteA, lineId: lineL1, workDate: DAY, hour, targetPieces: 6, createdAt: T.targets, updatedAt: T.targets, createdById: actorId }, select })
      }
    }),
  )

  // The floor: the operator's material call and its waiting, the open maintenance call; the team leader answers the first
  // and, later, gives the reason of the short hour and writes the handover note.
  await db.withScope(floorAs(operatorId), (client) =>
    client.$transaction(async (tx) => {
      if (await tx.helpCall.findUnique({ where: { id: callIds[0] }, select })) return
      await tx.helpCall.create({
        data: {
          id: callIds[0],
          siteId: siteA,
          typeId: typeIds.material,
          stationId: station.sew1,
          lineId: lineL1,
          workerId: operatorId,
          employeeId: people.employeeIds.e1,
          note: 'Lining for size 52.',
          status: HelpCallStatus.SOLVED,
          sentAt: T.sent,
          seenAt: T.seen,
          seenById: leadId,
          onTheWayAt: T.onTheWay,
          onTheWayById: leadId,
          solvedAt: T.solved,
          solvedById: leadId,
          resolutionCode: 'BROUGHT',
          deviceId,
          clientEventId: 'seed-call-1',
          deviceTime: T.sent,
          createdAt: T.sent,
          updatedAt: T.solved,
          createdById: operatorId,
        },
        select,
      })
      await tx.offStandardEntry.create({
        data: {
          id: waitingBlockId,
          companyId: companyA,
          siteId: siteA,
          lineId: lineL1,
          stationId: station.sew1,
          workerId: operatorId,
          employeeId: people.employeeIds.e1,
          codeId: codeIds.WAIT_HELP,
          source: OffStandardSource.HELP_CALL,
          helpCallId: callIds[0],
          workDate: DAY,
          startedAt: T.sent,
          endedAt: T.solved,
          status: OffStandardStatus.APPROVED,
          approvedAt: T.solved,
          createdAt: T.sent,
          updatedAt: T.solved,
          createdById: operatorId,
        },
        select,
      })
      await tx.helpCall.create({
        data: { id: callIds[1], siteId: siteA, typeId: typeIds.maintenance, stationId: station.sew2, lineId: lineL1, note: 'Needle plate loose.', sentAt: T.machine, createdAt: T.machine, updatedAt: T.machine, createdById: operatorId },
        select,
      })
    }),
  )
  await db.withScope(floorAs(leadId), (client) =>
    client.$transaction(async (tx) => {
      if (await tx.handoverNote.findUnique({ where: { id: handoverNoteId }, select })) return
      await tx.lineTarget.update({
        where: { id: targetIds[2]! },
        data: { shortReasonCode: 'BREAKDOWN', shortNote: 'Needle plate of SEW-02 came loose.', shortReasonAt: T.shortHour, shortReasonById: leadId, version: 2, updatedAt: T.shortHour },
        select,
      })
      await tx.handoverNote.create({
        data: {
          id: handoverNoteId,
          siteId: siteA,
          lineId: lineL1,
          shiftDate: DAY,
          shiftLabel: 'A',
          topics: [HandoverTopic.HALF_DONE_BUNDLES, HandoverTopic.MACHINES],
          text: 'WO-0001 bundle 2 sewn, waiting at inspection. SEW-02 needle plate loose: maintenance called.',
          deviceId,
          createdAt: T.handover,
          updatedAt: T.handover,
          createdById: leadId,
        },
        select,
      })
    }),
  )

  return { production, codeIds, typeIds, callIds, waitingBlockId, targetIds, handoverNoteId }
}

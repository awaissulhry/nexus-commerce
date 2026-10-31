import {
  ChecklistOutcome,
  CouponStatus,
  FindingStatus,
  FloorSessionEndReason,
  LabourDayStatus,
  LabourDisputeStatus,
  OffStandardKind,
  OffStandardPayRule,
  OffStandardSource,
  OffStandardStatus,
  ScanPatternKind,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedProduction, type ProductionSeed } from './production'

/**
 * The floor work seed (W2b schema wave 7/7, B-W2b-12), per tenant of seed/_core.ts, on plant A1 (which names workers: its
 * operator acknowledged the notice), written as the app does: the office's rows in the tenant's office scope, the
 * floor's in A1's floor scope with the operator (or the team leader) signed in on the cutting tablet.
 *
 *   codes        company A's off-standard and indirect codes: WAIT_MATERIAL (off-standard, average pay, the team leader
 *                approves), WAIT_HELP (off-standard, average, no approval: the waiting on a help call), CLEANING
 *                (indirect, base pay, no approval), TRAINING (indirect, average, approved). The pay rules are
 *                placeholders for the company and its labour consultant (CCNL: UNVERIFIED).
 *   team         the operator as a member of the standing sewing report of WO-0001's second bundle (a team of one: the
 *                seed's only acknowledged worker).
 *   steps        two steps ticked on that bundle at sewing: TRIM_THREADS done, POCKET_ZIP not applicable.
 *   off-standard on 17 Nov the operator waited for material at SEW-01 (10:40-11:05 Rome): PENDING, waiting for the team
 *                leader; she disputed its start (typed 10:35) and the office upheld it with a labour edit naming the
 *                dispute; on 16 Nov 15 minutes of cleaning (approved as it ended); line L1's 16 Nov is CLOSED.
 *   dispute      also an OPEN dispute of the standing sewing report ("the stain was there before it reached me").
 *   dispatch     18 Nov: the operator at SEW-01; WO-0001's sewing of its first bundle queued at SEW-02.
 *   coupons      WO-0001's first bundle at sewing: coupon SEED-CP-0001 VOID (torn) and SEED-CP-0002 replacing it.
 *   findings     two about the second bundle at sewing: scans bunched before the shift's end (OPEN), and gaps below the
 *                standard (REVIEWED: sewn by a pair). No person in either.
 *   crew         an ended crew on the cutting tablet (16 Nov, 06:00-14:00 Rome): the operator and the team leader.
 *
 * No timing scan (START, PAUSE …) is seeded: the W1 and W2a count reads take every scan but an UNDO as a report until
 * B-W2b-40 filters them on the count kinds (factory-domain countKindOf), so a seeded timing row would change their
 * figures. The generated isolation tests copy the FIRST row of each table by id and insert the copy: the first off-standard
 * block is PENDING (one OPEN block per worker), on a day that is not closed; the first coupon is VOID (one ACTIVE
 * coupon per bundle and operation); the first crew and its first member have ended (one open crew per device); the first
 * dispute is OPEN; the first finding OPEN. Those rows get ids that start with eight zeros, the others with eight f's
 * (both still derived from the namespace). The labour edit's createdAt is the database's own (now()): the off-standard
 * trigger matches an edit to its transaction by it.
 *
 * Every name and value is invented. Idempotent: each record is written once and skipped when it exists.
 */

const T = {
  codes: new Date('2026-11-01T08:00:00.000Z'),
  cleanStart: new Date('2026-11-16T14:30:00.000Z'),
  cleanEnd: new Date('2026-11-16T14:45:00.000Z'),
  dayClosed: new Date('2026-11-16T17:00:00.000Z'),
  crewStart: new Date('2026-11-16T05:00:00.000Z'),
  leadJoined: new Date('2026-11-16T05:10:00.000Z'),
  leadLeft: new Date('2026-11-16T12:00:00.000Z'),
  crewEnd: new Date('2026-11-16T13:00:00.000Z'),
  typedStart: new Date('2026-11-17T09:35:00.000Z'),
  waitStart: new Date('2026-11-17T09:40:00.000Z'),
  waitEnd: new Date('2026-11-17T10:05:00.000Z'),
  ticked: new Date('2026-11-17T09:20:00.000Z'),
  disputed: new Date('2026-11-17T15:00:00.000Z'),
  answered: new Date('2026-11-18T08:30:00.000Z'),
  planned: new Date('2026-11-17T16:00:00.000Z'),
  coupon: new Date('2026-11-16T10:05:00.000Z'),
  couponVoided: new Date('2026-11-16T10:30:00.000Z'),
  found: new Date('2026-11-18T02:00:00.000Z'),
  reviewed: new Date('2026-11-18T09:00:00.000Z'),
} as const
const DAY = { cleaned: new Date('2026-11-16T00:00:00.000Z'), waited: new Date('2026-11-17T00:00:00.000Z'), dispatch: new Date('2026-11-18T00:00:00.000Z') } as const

/** Company A's codes: code, kind, pay rule, approval, words, icon, colour. */
const CODES = [
  { code: 'WAIT_MATERIAL', kind: OffStandardKind.OFF_STANDARD, payRule: OffStandardPayRule.AVERAGE, needsApproval: true, labelIt: 'Attesa materiale', labelEn: 'Waiting for material', icon: 'package', colour: '#d97706', first: true },
  { code: 'WAIT_HELP', kind: OffStandardKind.OFF_STANDARD, payRule: OffStandardPayRule.AVERAGE, needsApproval: false, labelIt: 'Attesa assistenza', labelEn: 'Waiting for help', icon: 'flag', colour: '#2563eb', first: false },
  { code: 'CLEANING', kind: OffStandardKind.INDIRECT, payRule: OffStandardPayRule.BASE, needsApproval: false, labelIt: 'Pulizia', labelEn: 'Cleaning', icon: 'zap', colour: '#059669', first: false },
  { code: 'TRAINING', kind: OffStandardKind.INDIRECT, payRule: OffStandardPayRule.AVERAGE, needsApproval: true, labelIt: 'Formazione', labelEn: 'Training', icon: 'calendar', colour: '#6366f1', first: false },
] as const
export type OffStandardCodeKey = (typeof CODES)[number]['code']

const ids = (namespace: string) => {
  const id = (key: string): string => seedUuid(namespace, key)
  return { id, firstId: (key: string): string => `00000000${id(key).slice(8)}`, lastId: (key: string): string => `ffffffff${id(key).slice(8)}` }
}

/** Company A's off-standard codes (the andon seed books the help-call waiting to WAIT_HELP); idempotent. */
export async function seedOffStandardCodes({ db, namespace }: SeedContext): Promise<Record<OffStandardCodeKey, string>> {
  const { id, firstId, lastId } = ids(namespace)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const codeIds = Object.fromEntries(CODES.map((entry) => [entry.code, (entry.first ? firstId : lastId)(`labour:code:A:${entry.code}`)])) as Record<OffStandardCodeKey, string>
  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      for (const [order, entry] of CODES.entries()) {
        const words = { labelIt: entry.labelIt, labelEn: entry.labelEn, icon: entry.icon, colour: entry.colour, sortOrder: (order + 1) * 10 }
        await tx.offStandardCode.upsert({
          where: { id: codeIds[entry.code] },
          create: { id: codeIds[entry.code], companyId: companyA, code: entry.code, kind: entry.kind, payRule: entry.payRule, needsApproval: entry.needsApproval, ...words, createdAt: T.codes, updatedAt: T.codes, createdById: actorId },
          update: words,
          select: { id: true },
        })
      }
    }),
  )
  return codeIds
}

export interface LabourSeed {
  readonly production: ProductionSeed
  readonly codeIds: Record<OffStandardCodeKey, string>
  /** The operator as a member of the standing sewing report. */
  readonly memberId: string
  /** TRIM_THREADS done, POCKET_ZIP not applicable. */
  readonly tickIds: readonly [string, string]
  /** 17 Nov's waiting for material (PENDING), 16 Nov's cleaning (APPROVED). */
  readonly blockIds: readonly [string, string]
  /** Line L1's 16 Nov, CLOSED. */
  readonly labourDayId: string
  /** The edit of the waiting block's start that answered the upheld dispute. */
  readonly labourEditId: string
  /** The OPEN dispute of the standing report, the UPHELD one of the waiting block. */
  readonly disputeIds: readonly [string, string]
  /** The operator at SEW-01; the sewing of the first bundle queued at SEW-02. */
  readonly dispatchIds: readonly [string, string]
  /** SEED-CP-0001 (VOID), SEED-CP-0002 (ACTIVE, replacing it). */
  readonly couponIds: readonly [string, string]
  /** Bunched at the shift's end (OPEN), gaps below the standard (REVIEWED). */
  readonly findingIds: readonly [string, string]
  readonly crewId: string
  /** The operator and the team leader, both left. */
  readonly crewMemberIds: readonly [string, string]
}

export async function seed(context: SeedContext): Promise<LabourSeed> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order: the work order, its bundles and scans, the workers and the tablet come from
  // the production seed (which runs the floor sign-in, privacy and earlier seeds; all idempotent).
  const production = await seedProduction(context)
  const codeIds = await seedOffStandardCodes(context)
  const { id, firstId, lastId } = ids(namespace)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const lineL1 = id('site:A1:line:L1')
  const station = { sew1: id('site:A1:station:SEW-01'), sew2: id('site:A1:station:SEW-02') }
  const { operatorId, leadId, deviceId, workOrderId, operationIds, bundleIds, scanIds } = production
  const office = { audience: 'office' as const, tenantId, actorId }
  const asOperator = { audience: 'floor' as const, tenantId, actorId: operatorId, siteId: siteA }
  const select = { id: true } as const

  const memberId = firstId('labour:member:WO-0001:scan-3:operator')
  const tickIds = [firstId('labour:tick:WO-0001:2:sew:TRIM_THREADS'), lastId('labour:tick:WO-0001:2:sew:POCKET_ZIP')] as const
  const blockIds = [firstId('labour:off-standard:A1:wait-material'), lastId('labour:off-standard:A1:cleaning')] as const
  const labourDayId = firstId('labour:day:A1:L1:2026-11-16')
  const labourEditId = firstId('labour:edit:A1:wait-material:start')
  const disputeIds = [firstId('labour:dispute:A1:report'), lastId('labour:dispute:A1:wait-material')] as const
  const dispatchIds = [firstId('labour:dispatch:A1:2026-11-18:operator'), lastId('labour:dispatch:A1:2026-11-18:sew-bundle-1')] as const
  const couponIds = [firstId('labour:coupon:WO-0001:1:sew:1'), lastId('labour:coupon:WO-0001:1:sew:2')] as const
  const findingIds = [firstId('labour:finding:WO-0001:2:sew:bunched'), lastId('labour:finding:WO-0001:2:sew:gaps')] as const
  const crewId = firstId('labour:crew:A1:cutting:2026-11-16')
  const crewMemberIds = [firstId('labour:crew:A1:cutting:2026-11-16:operator'), lastId('labour:crew:A1:cutting:2026-11-16:lead')] as const

  // The floor: the team member and the ticked steps of the standing sewing report's bundle, the off-standard blocks, the
  // disputes and the ended crew, as the operator's tablet sends them.
  await db.withScope(asOperator, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.operationScanMember.findUnique({ where: { id: memberId }, select })) return
      await tx.operationScanMember.create({ data: { id: memberId, siteId: siteA, scanId: scanIds[2], workerId: operatorId, createdAt: T.ticked, createdById: operatorId }, select })
      const tick = { siteId: siteA, workOrderId, workOrderOperationId: operationIds.sew, bundleId: bundleIds[1], workerId: operatorId, deviceId, deviceTime: T.ticked, serverTime: T.ticked, createdById: operatorId }
      await tx.operationChecklistResult.create({ data: { id: tickIds[0], ...tick, stepCode: 'TRIM_THREADS', outcome: ChecklistOutcome.DONE, clientEventId: 'seed-tick-1' }, select })
      await tx.operationChecklistResult.create({ data: { id: tickIds[1], ...tick, stepCode: 'POCKET_ZIP', outcome: ChecklistOutcome.NOT_APPLICABLE, clientEventId: 'seed-tick-2' }, select })
    }),
  )
  await db.withScope(asOperator, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.offStandardEntry.findUnique({ where: { id: blockIds[0] }, select })) return
      const block = { companyId: companyA, siteId: siteA, lineId: lineL1, stationId: station.sew1, workerId: operatorId, source: OffStandardSource.FLOOR, deviceId, createdById: operatorId }
      await tx.offStandardEntry.create({
        data: { id: blockIds[1], ...block, codeId: codeIds.CLEANING, workDate: DAY.cleaned, startedAt: T.cleanStart, endedAt: T.cleanEnd, status: OffStandardStatus.APPROVED, approvedAt: T.cleanEnd, clientEventId: 'seed-off-2', deviceTime: T.cleanStart, createdAt: T.cleanStart, updatedAt: T.cleanEnd },
        select,
      })
      // Typed with the wrong start (10:35 Rome); the dispute below puts it right.
      await tx.offStandardEntry.create({
        data: { id: blockIds[0], ...block, codeId: codeIds.WAIT_MATERIAL, workDate: DAY.waited, startedAt: T.typedStart, endedAt: T.waitEnd, status: OffStandardStatus.PENDING, note: 'The lining trolley ran out.', clientEventId: 'seed-off-1', deviceTime: T.typedStart, createdAt: T.typedStart, updatedAt: T.waitEnd },
        select,
      })
      const dispute = { siteId: siteA, workerId: operatorId, lineId: lineL1, workDate: DAY.waited, deviceId, createdById: operatorId, createdAt: T.disputed, updatedAt: T.disputed }
      await tx.labourDispute.create({
        data: { id: disputeIds[0], ...dispute, recordType: 'OperationScan', recordId: scanIds[2], message: 'I sewed both sleeve sets; the stain was on the leather before it reached me.', clientEventId: 'seed-dispute-1' },
        select,
      })
      await tx.labourDispute.create({
        data: { id: disputeIds[1], ...dispute, recordType: 'OffStandardEntry', recordId: blockIds[0], message: 'I started waiting at 10:40, not 10:35.', clientEventId: 'seed-dispute-2' },
        select,
      })
      const crew = { siteId: siteA, createdById: operatorId }
      await tx.crewSession.create({ data: { id: crewId, ...crew, deviceId, startedAt: T.crewStart, endedAt: T.crewEnd, endReason: FloorSessionEndReason.SHIFT_END, createdAt: T.crewStart, updatedAt: T.crewEnd }, select })
      await tx.crewMember.create({ data: { id: crewMemberIds[0], ...crew, crewSessionId: crewId, workerId: operatorId, joinedAt: T.crewStart, leftAt: T.crewEnd, createdAt: T.crewStart, updatedAt: T.crewEnd }, select })
      await tx.crewMember.create({ data: { id: crewMemberIds[1], ...crew, crewSessionId: crewId, workerId: leadId, joinedAt: T.leadJoined, leftAt: T.leadLeft, createdAt: T.leadJoined, updatedAt: T.leadLeft }, select })
    }),
  )

  // The office: the upheld dispute and its labour edit (in one command: the block ended, so its change comes with the
  // edit), the closed day, the dispatch, the coupons and the scan findings.
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.labourEdit.findUnique({ where: { id: labourEditId }, select })) return
      await tx.labourDispute.update({
        where: { id: disputeIds[1] },
        data: { status: LabourDisputeStatus.UPHELD, answer: 'Upheld: the trolley ran out at 10:40; the start is corrected.', answeredAt: T.answered, answeredById: actorId, version: 2, updatedAt: T.answered },
        select,
      })
      await tx.offStandardEntry.update({ where: { id: blockIds[0] }, data: { startedAt: T.waitStart, version: 2, updatedAt: T.answered }, select })
      await tx.labourEdit.create({
        data: {
          id: labourEditId,
          companyId: companyA,
          siteId: siteA,
          lineId: lineL1,
          workDate: DAY.waited,
          recordType: 'OffStandardEntry',
          recordId: blockIds[0],
          workerId: operatorId,
          before: { startedAt: T.typedStart.toISOString() },
          after: { startedAt: T.waitStart.toISOString() },
          reason: 'The worker disputed the start; the trolley ran out at 10:40.',
          disputeId: disputeIds[1],
          createdById: actorId,
        },
        select,
      })
    }),
  )
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.labourDay.findUnique({ where: { id: labourDayId }, select })) return
      await tx.labourDay.create({
        data: { id: labourDayId, siteId: siteA, lineId: lineL1, workDate: DAY.cleaned, status: LabourDayStatus.CLOSED, closedAt: T.dayClosed, closedById: actorId, createdAt: T.dayClosed, updatedAt: T.dayClosed, createdById: actorId },
        select,
      })
    }),
  )
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      // A plan, not a ledger: the office may remove a line, so each is written when it is missing.
      const planned = { siteId: siteA, workDate: DAY.dispatch, lineId: lineL1, sequence: 1, createdAt: T.planned, updatedAt: T.planned, createdById: actorId }
      const lines = [
        { id: dispatchIds[0], ...planned, stationId: station.sew1, workerId: operatorId },
        { id: dispatchIds[1], ...planned, stationId: station.sew2, workOrderId, workOrderOperationId: operationIds.sew, bundleIds: [bundleIds[0]] },
      ]
      for (const data of lines) if (!(await tx.dispatchAssignment.findUnique({ where: { id: data.id }, select }))) await tx.dispatchAssignment.create({ data, select })
    }),
  )
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.bundleCoupon.findUnique({ where: { id: couponIds[0] }, select })) return
      const coupon = { siteId: siteA, workOrderId, bundleId: bundleIds[0], workOrderOperationId: operationIds.sew, createdById: actorId }
      await tx.bundleCoupon.create({
        data: { id: couponIds[0], ...coupon, code: 'SEED-CP-0001', status: CouponStatus.VOID, voidedAt: T.couponVoided, voidReason: 'Torn at the press.', createdAt: T.coupon, updatedAt: T.couponVoided },
        select,
      })
      await tx.bundleCoupon.create({ data: { id: couponIds[1], ...coupon, code: 'SEED-CP-0002', replacesId: couponIds[0], createdAt: T.couponVoided, updatedAt: T.couponVoided }, select })
    }),
  )
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.scanPatternFinding.findUnique({ where: { id: findingIds[0] }, select })) return
      const finding = { siteId: siteA, workOrderId, bundleId: bundleIds[1], workOrderOperationId: operationIds.sew, createdAt: T.found, updatedAt: T.found }
      await tx.scanPatternFinding.create({
        data: { id: findingIds[0], ...finding, kind: ScanPatternKind.BUNCHED_AT_SHIFT_END, windowStart: new Date('2026-11-17T12:30:00.000Z'), windowEnd: new Date('2026-11-17T13:00:00.000Z'), detail: { scans: 6, shiftEnd: '14:00' } },
        select,
      })
      await tx.scanPatternFinding.create({
        data: {
          id: findingIds[1],
          ...finding,
          kind: ScanPatternKind.GAP_BELOW_STANDARD,
          windowStart: new Date('2026-11-17T08:00:00.000Z'),
          windowEnd: new Date('2026-11-17T09:30:00.000Z'),
          detail: { scans: 2, gapMinutes: 48, standardMinutes: 96.5 },
        },
        select,
      })
      // A finding starts OPEN; the office reviews it.
      await tx.scanPatternFinding.update({
        where: { id: findingIds[1] },
        data: { status: FindingStatus.REVIEWED, reviewedAt: T.reviewed, reviewedById: actorId, reviewNote: 'The two sets were sewn by a pair: not a pattern.', version: 2, updatedAt: T.reviewed },
        select,
      })
    }),
  )

  return { production, codeIds, memberId, tickIds, blockIds, labourDayId, labourEditId, disputeIds, dispatchIds, couponIds, findingIds, crewId, crewMemberIds }
}

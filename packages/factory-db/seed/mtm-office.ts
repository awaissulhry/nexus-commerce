import {
  AppointmentKind,
  AppointmentStatus,
  FittingVerdict,
  GeneratedDocumentKind,
  MeasurementReviewStatus,
  RepairKind,
  RepairStage,
} from '../src/generated/prisma/enums'
import { createHash } from 'node:crypto'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAuth } from './auth'
import { seed as seedFiles } from './files'
import { seed as seedProduct } from './product'

/**
 * The made-to-measure office seed (W2b-5, schema wave 44/44, B-W2b-297), per tenant of seed/_core.ts, written in the tenant's
 * office scope as apps/factory-api's modules/sales/mtm (B-W2b-358) and modules/sales/fittings (B-W2b-360) will write it. It
 * runs the auth seed (the owner and the member), the product seed (SEED-JKT-01 and, through it, the parties seed with its
 * rider profiles: P1's team rider JACKET revision 1, P4's private rider JACKET revisions 1 and 2) and the files seed (the
 * file store) first, all idempotent. Made-to-measure stays OFF: no style flag or template switch is changed here.
 *
 *   reviews       P1's team rider JACKET revision 1 CONFIRMED by the owner (the first row of MeasurementProfile, the revision
 *                 that rider sent by link, stays WAITING: a copy of it is a valid link send); P4's revision 1 NEED_MORE
 *                 ("measure the sleeve again") and its revision 2, the answer, WAITING. A new revision: P1's team rider
 *                 TROUSERS revision 1, measured by the member in the seed showroom, WAITING.
 *   appointments  company A: a BOOKED second fitting of P1's rider (the first row; its invite sent); the DONE first fitting
 *                 (with the member, reminder sent); a DONE fitting of P4's rider at a dealer, with the dealer's fitter by
 *                 name; a CANCELLED showroom visit of P1's buyer; a MISSED measuring session of P4's rider.
 *   fittings      P4's fitting: OK, nothing changes (the first row); P1's first fitting: ALTER, chest +2.0 cm and sleeve
 *                 -1.0 cm, 5 days, and the alteration it opened (SEED-REP-MTM-0001, an ALTERATION repair order of P1,
 *                 waiting for the garment) named after.
 *   worksheet     the made-to-measure worksheet and order form of P1's JACKET revision 1 (MTM_WORKSHEET, version 1, a PDF of
 *                 the profile, company A).
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: so the first rows (ids starting with eight zeros, still derived from the namespace) are ones a copy may repeat: a
 * BOOKED fitting, an OK fitting result that opened nothing. Every name, number and word is made up; every time but the
 * booked fitting's is before the day the wave was built (the guards refuse a closing, a review or a fitting in the future).
 * Idempotent: written once, skipped when its first row exists.
 */

const T = {
  p1Reviewed: new Date('2026-10-21T09:00:00.000Z'),
  p4Asked: new Date('2026-10-21T15:00:00.000Z'),
  fitting1Booked: new Date('2026-10-22T08:00:00.000Z'),
  fitting1Invite: new Date('2026-10-22T08:05:00.000Z'),
  fitting1Reminder: new Date('2026-10-27T09:00:00.000Z'),
  fitting1Starts: new Date('2026-10-28T09:00:00.000Z'),
  fitting1Ends: new Date('2026-10-28T10:00:00.000Z'),
  fitting1Fitted: new Date('2026-10-28T09:30:00.000Z'),
  fitting1Closed: new Date('2026-10-28T10:05:00.000Z'),
  alterationOpened: new Date('2026-10-28T11:00:00.000Z'),
  dealerBooked: new Date('2026-10-25T10:00:00.000Z'),
  dealerStarts: new Date('2026-10-30T14:00:00.000Z'),
  dealerEnds: new Date('2026-10-30T14:45:00.000Z'),
  dealerFitted: new Date('2026-10-30T14:30:00.000Z'),
  dealerClosed: new Date('2026-10-30T15:00:00.000Z'),
  visitBooked: new Date('2026-10-29T09:00:00.000Z'),
  visitStarts: new Date('2026-11-05T10:00:00.000Z'),
  visitEnds: new Date('2026-11-05T11:00:00.000Z'),
  visitCancelled: new Date('2026-11-03T08:00:00.000Z'),
  measuringBooked: new Date('2026-10-30T09:00:00.000Z'),
  measuringStarts: new Date('2026-11-03T16:00:00.000Z'),
  measuringEnds: new Date('2026-11-03T16:30:00.000Z'),
  measuringMissed: new Date('2026-11-03T17:00:00.000Z'),
  trousersNotice: new Date('2026-11-04T09:55:00.000Z'),
  trousersTaken: new Date('2026-11-04T10:00:00.000Z'),
  trousersWritten: new Date('2026-11-04T10:30:00.000Z'),
  fitting2Booked: new Date('2026-11-06T08:55:00.000Z'),
  fitting2Invite: new Date('2026-11-06T09:00:00.000Z'),
  fitting2Starts: new Date('2026-12-02T09:00:00.000Z'),
  fitting2Ends: new Date('2026-12-02T10:00:00.000Z'),
  worksheet: new Date('2026-10-27T16:00:00.000Z'),
} as const

export interface MtmOfficeSeed {
  readonly companyA: string
  readonly ownerId: string
  readonly memberId: string
  readonly partyIds: { readonly P1: string; readonly P4: string }
  readonly profileIds: { readonly p1Jacket1: string; readonly p1Jacket2: string; readonly p1Trousers1: string; readonly p4Jacket1: string; readonly p4Jacket2: string }
  readonly appointmentIds: { readonly booked: string; readonly fitted: string; readonly dealer: string; readonly cancelled: string; readonly missed: string }
  readonly fittingIds: { readonly ok: string; readonly alter: string }
  readonly alterationRepairId: string
  readonly worksheetId: string
}

export async function seed(context: SeedContext): Promise<MtmOfficeSeed> {
  const { db, namespace } = context
  const { ownerId, memberId } = await seedAuth(context)
  const product = await seedProduct(context)
  await seedFiles(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** Ids that sort first (see above). */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const companyA = id('company:A')
  const siteA1 = id('site:A1')
  const P1 = id('party:P1')
  const P4 = id('party:P4')
  const office = { audience: 'office', tenantId, actorId: ownerId } as const
  const select = { id: true } as const

  const result: MtmOfficeSeed = {
    companyA,
    ownerId,
    memberId,
    partyIds: { P1, P4 },
    profileIds: {
      p1Jacket1: id('measurement:P1:rider:JACKET:1'),
      p1Jacket2: firstId('portal-sales:measurement:P1:rider:JACKET:2'),
      p1Trousers1: id('mtm-office:measurement:P1:rider:TROUSERS:1'),
      p4Jacket1: id('measurement:P4:rider:JACKET:1'),
      p4Jacket2: id('measurement:P4:rider:JACKET:2'),
    },
    appointmentIds: {
      booked: firstId('mtm-office:appointment:P1:fitting:2'),
      fitted: id('mtm-office:appointment:P1:fitting:1'),
      dealer: id('mtm-office:appointment:P4:fitting:1'),
      cancelled: id('mtm-office:appointment:P1:showroom'),
      missed: id('mtm-office:appointment:P4:measuring'),
    },
    fittingIds: { ok: firstId('mtm-office:fitting:P4:1'), alter: id('mtm-office:fitting:P1:1') },
    alterationRepairId: id('mtm-office:repair:ALT-1'),
    worksheetId: id('mtm-office:worksheet:P1:JACKET:1:1'),
  }
  const { profileIds: M, appointmentIds: A, fittingIds: F } = result

  if (await db.withScope(office, (client) => client.appointment.findUnique({ where: { id: A.booked }, select }))) return result

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      // --- the factory review (SAL-292) and who measured and where (SAL-291) ---------------------------------------------
      await tx.measurementProfile.update({
        where: { id: M.p1Jacket1 },
        data: { reviewStatus: MeasurementReviewStatus.CONFIRMED, reviewedAt: T.p1Reviewed, reviewedById: ownerId, reviewNote: 'Seed: measures and design checked; base size 50, sleeves 1 cm longer for the racing position.' },
        select,
      })
      await tx.measurementProfile.update({
        where: { id: M.p4Jacket1 },
        data: { reviewStatus: MeasurementReviewStatus.NEED_MORE, reviewedAt: T.p4Asked, reviewedById: ownerId, reviewNote: 'Seed: the sleeve looks short for the chest. Please measure the sleeve again with the arm bent, from the shoulder seam.' },
        select,
      })
      await tx.measurementProfile.create({
        data: {
          id: M.p1Trousers1,
          partyId: P1,
          contactId: id('party-contact:P1:rider'),
          riderName: 'Seed Team Rider',
          garmentType: 'TROUSERS',
          revision: 1,
          measurements: { waist: { value: '82.0', unit: 'cm' }, outseam: { value: '104.0', unit: 'cm' }, inseam: { value: '80.5', unit: 'cm' } },
          fitNotes: 'Seed: knee sliders on both sides; a little room at the hip.',
          takenAt: T.trousersTaken,
          takenBy: 'Seed member, in the showroom',
          measuredByUserId: memberId,
          measuredPlace: 'Seed showroom',
          privacyNoticeRef: 'seed-privacy-notice-v1',
          privacyNoticeAt: T.trousersNotice,
          createdAt: T.trousersWritten,
          createdById: memberId,
        },
        select,
      })

      // --- appointments (SAL-054): each booked first, then closed ------------------------------------------------------
      const booking = { companyId: companyA, status: AppointmentStatus.BOOKED }
      await tx.appointment.create({
        data: {
          id: A.booked, ...booking, partyId: P1, contactId: id('party-contact:P1:rider'), measurementProfileId: M.p1Jacket1, kind: AppointmentKind.FITTING,
          startsAt: T.fitting2Starts, endsAt: T.fitting2Ends, place: 'Seed showroom', withUserId: memberId, inviteSentAt: T.fitting2Invite,
          notes: 'Seed: second fitting, after the alteration.', createdAt: T.fitting2Booked, updatedAt: T.fitting2Invite, createdById: memberId, updatedById: memberId,
        },
        select,
      })
      await tx.appointment.create({
        data: {
          id: A.fitted, ...booking, partyId: P1, contactId: id('party-contact:P1:rider'), measurementProfileId: M.p1Jacket1, kind: AppointmentKind.FITTING,
          startsAt: T.fitting1Starts, endsAt: T.fitting1Ends, place: 'Seed showroom', withUserId: memberId, inviteSentAt: T.fitting1Invite,
          reminderSentAt: T.fitting1Reminder, createdAt: T.fitting1Booked, updatedAt: T.fitting1Reminder, createdById: memberId,
        },
        select,
      })
      await tx.appointment.update({ where: { id: A.fitted }, data: { status: AppointmentStatus.DONE, closedAt: T.fitting1Closed, closedById: memberId, version: 2, updatedAt: T.fitting1Closed, updatedById: memberId }, select })
      await tx.appointment.create({
        data: {
          id: A.dealer, ...booking, partyId: P4, contactId: id('party-contact:P4:rider'), measurementProfileId: M.p4Jacket2, kind: AppointmentKind.FITTING,
          startsAt: T.dealerStarts, endsAt: T.dealerEnds, place: 'Seed dealer shop', withName: 'Seed dealer fitter', createdAt: T.dealerBooked, updatedAt: T.dealerBooked,
          createdById: ownerId,
        },
        select,
      })
      await tx.appointment.update({ where: { id: A.dealer }, data: { status: AppointmentStatus.DONE, closedAt: T.dealerClosed, closedById: ownerId, version: 2, updatedAt: T.dealerClosed, updatedById: ownerId }, select })
      await tx.appointment.create({
        data: {
          id: A.cancelled, ...booking, partyId: P1, contactId: id('party-contact:P1:buyer'), kind: AppointmentKind.SHOWROOM, startsAt: T.visitStarts, endsAt: T.visitEnds,
          place: 'Seed showroom', withUserId: ownerId, notes: 'Seed: the buyer wants to see the new colours.', createdAt: T.visitBooked, updatedAt: T.visitBooked, createdById: ownerId,
        },
        select,
      })
      await tx.appointment.update({
        where: { id: A.cancelled },
        data: { status: AppointmentStatus.CANCELLED, closedAt: T.visitCancelled, closedById: ownerId, cancelReason: 'Seed: the buyer moved the visit to next month.', version: 2, updatedAt: T.visitCancelled, updatedById: ownerId },
        select,
      })
      await tx.appointment.create({
        data: {
          id: A.missed, ...booking, partyId: P4, contactId: id('party-contact:P4:rider'), riderName: 'Seed Private Rider', kind: AppointmentKind.MEASURING,
          startsAt: T.measuringStarts, endsAt: T.measuringEnds, place: 'Seed showroom', withUserId: memberId, createdAt: T.measuringBooked, updatedAt: T.measuringBooked, createdById: memberId,
        },
        select,
      })
      await tx.appointment.update({ where: { id: A.missed }, data: { status: AppointmentStatus.MISSED, closedAt: T.measuringMissed, closedById: memberId, version: 2, updatedAt: T.measuringMissed, updatedById: memberId }, select })

      // --- fitting results (SAL-297) and the alteration one opened -----------------------------------------------------
      await tx.fittingResult.create({
        data: {
          id: F.ok, companyId: companyA, partyId: P4, appointmentId: A.dealer, measurementProfileId: M.p4Jacket2, fittedAt: T.dealerFitted, verdict: FittingVerdict.OK,
          notes: 'Seed: it fits; nothing to change.', createdAt: T.dealerClosed, updatedAt: T.dealerClosed, createdById: ownerId,
        },
        select,
      })
      await tx.fittingResult.create({
        data: {
          id: F.alter, companyId: companyA, partyId: P1, appointmentId: A.fitted, measurementProfileId: M.p1Jacket1, fittedAt: T.fitting1Fitted, verdict: FittingVerdict.ALTER,
          pointChanges: { chest: { change: '+2.0', unit: 'cm', note: 'Seed: tight when tucked on the bike' }, sleeve: { change: '-1.0', unit: 'cm' } },
          notes: 'Seed: let the chest out, shorten the sleeves; the rest fits.', alterationDays: 5, createdAt: T.fitting1Closed, updatedAt: T.fitting1Closed, createdById: memberId,
        },
        select,
      })
      await tx.repairOrder.create({
        data: {
          id: result.alterationRepairId, companyId: companyA, siteId: siteA1, partyId: P1, number: 'SEED-REP-MTM-0001', kind: RepairKind.ALTERATION, styleId: product.styleId,
          problem: 'Seed: after the first fitting, the chest let out 2 cm and the sleeves shortened 1 cm.', workWanted: 'Chest +2 cm, sleeves -1 cm (fitting of 28 October).',
          stage: RepairStage.AWAITING_GOODS, ownerId: memberId, createdAt: T.alterationOpened, updatedAt: T.alterationOpened, createdById: memberId,
        },
        select,
      })
      await tx.repairStageEvent.create({
        data: {
          id: id('mtm-office:repair:ALT-1:event:1'), siteId: siteA1, repairId: result.alterationRepairId, fromStage: null, stage: RepairStage.AWAITING_GOODS, repairVersion: 1,
          at: T.alterationOpened, requestId: `seed-mtm-office-${namespace}-alteration-1`, createdAt: T.alterationOpened, createdById: memberId,
        },
        select,
      })
      await tx.fittingResult.update({ where: { id: F.alter }, data: { alterationRepairId: result.alterationRepairId, version: 2, updatedAt: T.alterationOpened }, select })

      // --- the worksheet and order form of P1's JACKET revision 1 (SAL-303) --------------------------------------------
      const worksheetSha = createHash('sha256').update(`seed mtm worksheet P1 JACKET 1 version 1 (${namespace})`).digest('hex')
      const worksheetFile = id('mtm-office:worksheet:P1:JACKET:1:1:file')
      await tx.storedFile.create({
        data: {
          id: worksheetFile,
          companyId: companyA,
          recordType: 'MeasurementProfile',
          recordId: M.p1Jacket1,
          kind: 'DOCUMENT',
          originalName: 'Seed Team Rider JACKET rev 1 worksheet.pdf',
          contentType: 'application/pdf',
          sizeBytes: 2048,
          sha256: worksheetSha,
          storeAccountId: id('files:account:r2'),
          storageKey: `t/${tenantId}/c/${companyA}/2026/${id('mtm-office:worksheet:P1:JACKET:1:1:key')}`,
          status: 'AVAILABLE',
          availableAt: T.worksheet,
          visibility: ['OFFICE'],
          createdAt: T.worksheet,
          updatedAt: T.worksheet,
          createdById: memberId,
        },
        select,
      })
      await tx.generatedDocument.create({
        data: {
          id: result.worksheetId,
          companyId: companyA,
          recordType: 'MeasurementProfile',
          recordId: M.p1Jacket1,
          kind: GeneratedDocumentKind.MTM_WORKSHEET,
          version: 1,
          fingerprint: worksheetSha,
          language: 'it',
          fileId: worksheetFile,
          createdAt: T.worksheet,
          createdById: memberId,
        },
        select,
      })
    }),
  )

  return result
}

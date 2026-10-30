import { ComplaintCategory, ComplaintChannel, ComplaintSeverity, ComplaintStatus, ParcelCondition, RepairKind, RepairStage, ReturnCause, ReturnDisposition, ReturnFreightPayer, ReturnGoodsOutcome, ReturnGrade, ReturnStatus } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedMoney, type MoneySeed } from './money'

/**
 * The returns, repairs and complaints seed (W2a schema wave 2/7), per tenant of seed/_core.ts, written in the tenant's
 * office scope as the app does (the dock's receipt too: the office may record it):
 *
 *   return policy   the tenant-wide sales settings: 30 days from delivery to ask, 15 days for the goods to arrive, the
 *                   freight paid by whoever caused the return, a 10% restocking fee, the conditions printed on the RMA.
 *   SEED-RMA-0001   P1 sends back one of the two sample jackets of FT-2026-00001 (the wrong size): AUTHORISED, waiting
 *                   for the goods at A1.
 *   SEED-RMA-0002   P1 sends back the BLK 50 jacket of SEED-SO-0002 that left with SH-0001 (a seam opened): received at A1's
 *                   dock in one parcel with the customer's DDT, graded DAMAGED, our defect, decided REPAIR; INSPECTED.
 *   SEED-REP-0001   the repair of that jacket, from the RMA line: RECEIVED (its first stage event), a PPE garment, so it
 *                   goes back only after a safety check.
 *   SEED-CMP-0001   P1's mail about the same jacket: a SAFETY complaint, triaged (major, answer due in a week), its alert
 *                   raised and not yet acknowledged by the owner.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: an RMA starts REQUESTED or AUTHORISED, its lines are written before the goods arrive and never take back more
 * than was sold. So SEED-RMA-0001 and its line (1 of the invoice line's 2 jackets: the copy takes the other) get ids that
 * start with eight zeros (still derived from the namespace).
 *
 * Every name, number and value is invented; the numbers are the seed's own, not from the series. Idempotent: each
 * record is written once, in one transaction, and skipped when it exists (a receipt and a stage event are append-only);
 * the return policy is written again with the same values.
 */

const T = {
  rma1: new Date('2026-11-05T09:00:00.000Z'),
  rma2: new Date('2026-11-26T09:00:00.000Z'),
  complaint: new Date('2026-11-26T08:30:00.000Z'),
  triaged: new Date('2026-11-27T10:00:00.000Z'),
  received: new Date('2026-12-01T08:15:00.000Z'),
  inspected: new Date('2026-12-01T10:00:00.000Z'),
  decided: new Date('2026-12-01T10:30:00.000Z'),
  repair: new Date('2026-12-01T11:00:00.000Z'),
} as const
const DAY = {
  rma1Due: new Date('2026-11-20T00:00:00.000Z'),
  rma2Due: new Date('2026-12-11T00:00:00.000Z'),
  customerDdt: new Date('2026-11-28T00:00:00.000Z'),
  answerDue: new Date('2026-12-04T00:00:00.000Z'),
} as const

export interface ReturnsSeed {
  readonly money: MoneySeed
  /** SEED-RMA-0001 (AUTHORISED) and its line. */
  readonly waitingReturnId: string
  readonly waitingLineId: string
  /** SEED-RMA-0002 (INSPECTED), its line and its dock receipt. */
  readonly inspectedReturnId: string
  readonly inspectedLineId: string
  readonly receiptId: string
  /** SEED-REP-0001 (RECEIVED) and its first stage event. */
  readonly repairId: string
  readonly stageEventId: string
  /** SEED-CMP-0001 (TRIAGED, SAFETY). */
  readonly complaintId: string
}

export async function seed(context: SeedContext): Promise<ReturnsSeed> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order; the invoice, the shipped order and its shipment come from the money seed (it
  // runs the shipping, production, sales and product seeds; all idempotent).
  const money = await seedMoney(context)
  const production = money.shipping.quality.production
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const P1 = id('party:P1')
  const buyer = id('party-contact:P1:buyer')
  // FT-2026-00001's line (seed/money.ts): two sample jackets; SEED-SO-0002's BLK line (seed/production.ts), BLK 50
  // shipped one with SH-0001.
  const sampleInvoiceLineId = id('money:line:FT-2026-00001:1')
  const orderLineBlk = id('production:sales-order:SO-0002:10')
  const colourwayBlk = id('production:colourway:JKT-02:BLK')
  const select = { id: true } as const

  const ids = {
    waitingReturnId: firstId('returns:RMA-0001'),
    waitingLineId: firstId('returns:RMA-0001:10'),
    inspectedReturnId: id('returns:RMA-0002'),
    inspectedLineId: id('returns:RMA-0002:10'),
    receiptId: id('returns:RMA-0002:receipt:1'),
    repairId: id('returns:REP-0001'),
    stageEventId: id('returns:REP-0001:stage:1'),
    complaintId: id('returns:CMP-0001'),
  }

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      // --- the return policy (tenant-wide; the sales seed made the row) ------------------------------------------------
      await tx.salesSettings.update({
        where: { id: tenantId },
        data: {
          returnWindowDays: 30,
          returnGoodsDueDays: 15,
          returnFreightPaidBy: ReturnFreightPayer.BY_CAUSE,
          returnRestockingFeePct: '10.0000',
          returnConditions: 'Unworn, with its labels, in its own packaging; a made-to-measure garment is not taken back.',
        },
        select,
      })

      // --- SEED-RMA-0001: authorised, waiting for the goods ----------------------------------------------------------
      if (!(await tx.returnAuthorisation.findUnique({ where: { id: ids.waitingReturnId }, select }))) {
        await tx.returnAuthorisation.create({
          data: {
            id: ids.waitingReturnId,
            companyId: companyA,
            siteId: siteA,
            partyId: P1,
            number: 'SEED-RMA-0001',
            contactId: buyer,
            customerRef: 'SEED-RET-31',
            status: ReturnStatus.AUTHORISED,
            requestedAt: T.rma1,
            authorisedAt: T.rma1,
            authorisedById: actorId,
            goodsDueBy: DAY.rma1Due,
            ownerId: actorId,
            createdAt: T.rma1,
            updatedAt: T.rma1,
            createdById: actorId,
          },
          select,
        })
        await tx.returnLine.create({
          data: {
            id: ids.waitingLineId,
            siteId: siteA,
            partyId: P1,
            returnId: ids.waitingReturnId,
            seq: 10,
            invoiceLineId: sampleInvoiceLineId,
            description: 'Seed sample jacket (sample, size 52)',
            quantity: 1,
            reasonCode: 'WRONG_SIZE',
            reasonNote: 'The rider needs a 54.',
            unitPrice: '250.000000',
            createdAt: T.rma1,
            updatedAt: T.rma1,
            createdById: actorId,
          },
          select,
        })
      }

      // --- SEED-RMA-0002: received, graded and decided; and its repair -----------------------------------------------
      if (!(await tx.returnAuthorisation.findUnique({ where: { id: ids.inspectedReturnId }, select }))) {
        const orderLine = await tx.salesOrderLine.findUniqueOrThrow({ where: { id: orderLineBlk }, select: { unitPrice: true } })
        await tx.returnAuthorisation.create({
          data: {
            id: ids.inspectedReturnId,
            companyId: companyA,
            siteId: siteA,
            partyId: P1,
            number: 'SEED-RMA-0002',
            contactId: buyer,
            salesOrderId: production.salesOrderId,
            status: ReturnStatus.AUTHORISED,
            requestedAt: T.rma2,
            authorisedAt: T.rma2,
            authorisedById: actorId,
            goodsDueBy: DAY.rma2Due,
            ownerId: actorId,
            createdAt: T.rma2,
            updatedAt: T.rma2,
            createdById: actorId,
          },
          select,
        })
        await tx.returnLine.create({
          data: {
            id: ids.inspectedLineId,
            siteId: siteA,
            partyId: P1,
            returnId: ids.inspectedReturnId,
            seq: 10,
            salesOrderLineId: orderLineBlk,
            size: '50',
            description: 'Giacca moto in pelle SEED-JKT-02, nero, taglia 50',
            batchNumber: 'SEED-BT-0001',
            quantity: 1,
            reasonCode: 'DEFECT',
            reasonNote: 'A seam opened at the left shoulder after the first ride.',
            unitPrice: orderLine.unitPrice,
            createdAt: T.rma2,
            updatedAt: T.rma2,
            createdById: actorId,
          },
          select,
        })
        // At the dock: one parcel with the customer's DDT; the RMA is RECEIVED (its receipt checked at commit).
        await tx.returnReceipt.create({
          data: {
            id: ids.receiptId,
            siteId: siteA,
            returnId: ids.inspectedReturnId,
            receivedAt: T.received,
            parcels: 1,
            parcelCondition: ParcelCondition.INTACT,
            carrierName: 'Seed Carrier',
            trackingNumber: 'SEED-TRK-R-0001',
            customerDdtNumber: 'SEED-C1-R-7',
            customerDdtDate: DAY.customerDdt,
            requestId: `seed-returns-${namespace}-receipt-1`,
            createdAt: T.received,
            createdById: actorId,
          },
          select,
        })
        await tx.returnAuthorisation.update({ where: { id: ids.inspectedReturnId }, data: { status: ReturnStatus.RECEIVED, receivedAt: T.received, version: 2, updatedAt: T.received }, select })
        await tx.returnLine.update({
          where: { id: ids.inspectedLineId },
          data: {
            receivedQuantity: 1,
            receivedAt: T.received,
            receiptId: ids.receiptId,
            grade: ReturnGrade.DAMAGED,
            cause: ReturnCause.OUR_DEFECT,
            conditionNote: 'Shoulder seam open over 4 cm; leather and protectors fine.',
            inspectedAt: T.inspected,
            inspectedById: actorId,
            disposition: ReturnDisposition.REPAIR,
            goodsOutcome: ReturnGoodsOutcome.REPAIR,
            decidedAt: T.decided,
            decidedById: actorId,
            creditAmount: 0,
            version: 2,
            updatedAt: T.decided,
          },
          select,
        })
        await tx.returnAuthorisation.update({ where: { id: ids.inspectedReturnId }, data: { status: ReturnStatus.INSPECTED, inspectedAt: T.decided, version: 3, updatedAt: T.decided }, select })

        // The repair, from the RMA line: the jacket is here (RECEIVED, its first stage event).
        await tx.repairOrder.create({
          data: {
            id: ids.repairId,
            companyId: companyA,
            siteId: siteA,
            partyId: P1,
            number: 'SEED-REP-0001',
            kind: RepairKind.REPAIR,
            returnLineId: ids.inspectedLineId,
            styleId: production.styleId,
            colourwayId: colourwayBlk,
            size: '50',
            problem: 'A seam opened at the left shoulder after the first ride.',
            stage: RepairStage.RECEIVED,
            receivedAt: T.received,
            inboundDdtNumber: 'SEED-C1-R-7',
            inboundDdtDate: DAY.customerDdt,
            safetyCheckRequired: true,
            ownerId: actorId,
            createdAt: T.repair,
            updatedAt: T.repair,
            createdById: actorId,
          },
          select,
        })
        await tx.repairStageEvent.create({
          data: { id: ids.stageEventId, siteId: siteA, repairId: ids.repairId, stage: RepairStage.RECEIVED, repairVersion: 1, at: T.repair, requestId: `seed-returns-${namespace}-repair-1`, createdAt: T.repair, createdById: actorId },
          select,
        })
      }

      // --- SEED-CMP-0001: the customer's mail about the jacket, triaged as SAFETY --------------------------------------
      if (!(await tx.complaint.findUnique({ where: { id: ids.complaintId }, select }))) {
        await tx.complaint.create({
          data: {
            id: ids.complaintId,
            companyId: companyA,
            partyId: P1,
            contactId: buyer,
            number: 'SEED-CMP-0001',
            customerRef: 'SEED-CLAIM-4',
            channel: ComplaintChannel.EMAIL,
            receivedAt: T.complaint,
            description: 'The left shoulder seam of the black jacket (size 50) opened after the first ride; the rider asks whether it still protects.',
            salesOrderId: production.salesOrderId,
            shipmentId: money.shipping.shipmentId,
            returnId: ids.inspectedReturnId,
            styleId: production.styleId,
            size: '50',
            batchNumber: 'SEED-BT-0001',
            status: ComplaintStatus.TRIAGED,
            category: ComplaintCategory.SAFETY,
            severity: ComplaintSeverity.MAJOR,
            ownerId: actorId,
            answerDueOn: DAY.answerDue,
            triagedAt: T.triaged,
            triagedById: actorId,
            safetyRaisedAt: T.triaged,
            createdAt: T.complaint,
            updatedAt: T.triaged,
            createdById: actorId,
          },
          select,
        })
      }
    }),
  )

  return { money, ...ids }
}

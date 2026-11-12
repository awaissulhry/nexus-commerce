import {
  DeliveryToleranceAction,
  ItemKind,
  MasterStatus,
  PoDateChangeSource,
  PurchaseConfirmationChannel,
  PurchaseOrderKind,
  PurchaseOrderStatus,
  PurchaseRequestSource,
  PurchaseRequestStatus,
  StockMoveReason,
  SubcontractConsumptionKind,
  SubcontractCostKind,
  SubcontractKitLineStatus,
  Uom,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedPortalSupply } from './portal-supply'
import { seed as seedSamples } from './samples'
import { seed as seedSubcontractReceipts } from './subcontract-receipts'

/**
 * The buying and subcontracting depth seed (W2b-5, schema wave 40/44, B-W2b-285), per tenant of seed/_core.ts, written in
 * the tenant's office scope, as the app does. The CLI runs the seed files in name order and this one sorts early, so it
 * runs the samples seed (product, compliance, production) and the subcontract-receipts seed (SEED-SC-0002) first, both
 * idempotent. Every name, number, rate, price and reason is made up.
 *
 *   variants    the seed protector SEED-PRO-300 in sizes S and M (ACTIVE) and XL (ARCHIVED, never bought).
 *   tolerances  company A: the supplier P2's leather ±5 % (refused beyond: the first row) and its protectors exactly as
 *               ordered; the tenant: every material +10 % / −5 %, beyond it a person's yes.
 *   PO-0101     SEED-PO-0101 of company B (plant B1) to the brand P1, DRAFT: a SAMPLE order for the tenant-wide style
 *               SEED-JKT-01 (no round: the seed's rounds are company A's). Line 10: 10 protectors of variant M with the protector's EN 1621 certificate, in two
 *               deliveries (4 on the need date, 6 a week later); line 20: 2 rolls of 50 m of the grey lining, 150 cm wide.
 *   PO-0102     SEED-PO-0102 of company B (plant B1) to P1 for 12 protectors of variant S in USD at 1.0850 to the euro (its
 *               value in EUR frozen), delivered to the workshop P2's office address: sent, confirmed by the office from the
 *               supplier's mail (the line and both deliveries), then the second delivery re-dated a week later by the
 *               supplier (its PoDateChange: the first row). Both orders on plant B1: planning nets every open order of a
 *               site, DRAFT included, so the golden flow's A1 plan stays as it was.
 *   requests    on plant A1: an OPEN request for 30 m of grey lining (the first row: a copy may repeat it), a request from
 *               WO-0001's protector shortage converted into the supply seed's draft SEED-PO-0002 (its line 10), one waiting
 *               for a yes (needles, in words), and one refused with the reason.
 *   cost        SEED-SC-0002 (the subcontract-receipts seed's packing job at P2): the fee for its 1 good sleeve set and the
 *               transport with its receipt, a charge booked twice and its reversal.
 *   isolation   only with `partnerScope` (the generated isolation tests, after the portal-supply seed's P1 rows):
 *               SEED-PO-0103 of company A (plant A1) to P1, DRAFT, a SAMPLE order for SEED-JKT-01's fit round SEED-SR-0001,
 *               10 protectors in two deliveries (the first rows of the
 *               schedule, a DRAFT order's, which a copy may repeat; plant A1's floor reads them); and 2 m of the grey lining
 *               sent with P1's job SEED-SC-0003 (a kit line of its own, TRANSFER into P1's workshop place), what P1 declared
 *               (1.5 used, 0.3 returned, 0.1 scrapped) and an adjustment after it (0.1 from used to scrapped: the first row,
 *               which a copy may repeat). Without it nothing is planned on A1 and no stock moves: the golden flows count the
 *               same orders and stock.
 *
 * Every instant is before the day the wave was built (the database refuses a date change, a request, a report or a cost
 * in the future). Rows of other tables that a copy must not repeat (a sent order, its line, a SENT kit line, a TRANSFER)
 * get ids that start with eight f's. Idempotent: each part is written once and skipped when its first row exists.
 */

/** Fixed instants and dates, so the seed never depends on the clock. */
const T = {
  setup: new Date('2026-11-02T08:00:00.000Z'),
  drafted: new Date('2026-11-03T09:00:00.000Z'),
  sent: new Date('2026-11-03T10:00:00.000Z'),
  confirmed: new Date('2026-11-04T09:00:00.000Z'),
  redated: new Date('2026-11-06T11:30:00.000Z'),
  asked: new Date('2026-11-05T08:30:00.000Z'),
  decided: new Date('2026-11-06T09:00:00.000Z'),
  costed: new Date('2026-11-07T10:00:00.000Z'),
  reversed: new Date('2026-11-07T11:00:00.000Z'),
  kitSent: new Date('2026-11-05T14:00:00.000Z'),
  declared: new Date('2026-11-08T16:00:00.000Z'),
  adjusted: new Date('2026-11-09T09:00:00.000Z'),
} as const
const DAY = {
  drafted: new Date('2026-11-03T00:00:00.000Z'),
  sampleNeed: new Date('2026-12-07T00:00:00.000Z'),
  sampleSecond: new Date('2026-12-14T00:00:00.000Z'),
  need: new Date('2027-01-11T00:00:00.000Z'),
  second: new Date('2027-01-25T00:00:00.000Z'),
  secondLater: new Date('2027-02-01T00:00:00.000Z'),
  requestNeed: new Date('2026-12-15T00:00:00.000Z'),
} as const

export interface BuyingDepthSeedOptions {
  /** The generated isolation tests: a SENT kit line of P1's job SEED-SC-0003 and its material balance (see above). */
  readonly partnerScope?: boolean
}

export interface BuyingDepthSeed {
  readonly variantCodes: { readonly small: string; readonly medium: string; readonly archived: string }
  readonly toleranceIds: { readonly leatherP2: string; readonly tenant: string; readonly protectorsP2: string }
  readonly sampleOrder: { readonly orderId: string; readonly protectorLineId: string; readonly liningLineId: string; readonly deliveryIds: readonly [string, string] }
  readonly usdOrder: { readonly orderId: string; readonly lineId: string; readonly deliveryIds: readonly [string, string]; readonly dateChangeId: string }
  /** With partnerScope: SEED-PO-0103 (A1, DRAFT) and its line's two deliveries. */
  readonly plantOrder: { readonly orderId: string; readonly lineId: string; readonly deliveryIds: readonly [string, string] }
  readonly requestIds: { readonly open: string; readonly converted: string; readonly waiting: string; readonly refused: string }
  readonly costEntryIds: { readonly fee: string; readonly transport: string; readonly twice: string; readonly reversal: string }
  /** With partnerScope: the SENT kit line, its TRANSFER, and the balance rows. */
  readonly balance: { readonly kitLineId: string; readonly moveId: string; readonly declaredId: string; readonly adjustmentId: string }
}

export async function seed(context: SeedContext, options: BuyingDepthSeedOptions = {}): Promise<BuyingDepthSeed> {
  const { db, namespace } = context
  await seedSamples(context)
  const job = await seedSubcontractReceipts(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  /** The supply seed's draft SEED-PO-0002 (A1, P1): its ids start with eight zeros. */
  const draftId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const companyB = id('company:B')
  const siteA = id('site:A1')
  const siteB = id('site:B1')
  const partyP1 = id('party:P1')
  const partyP2 = id('party:P2')
  const item = { leather: id('product:item:leather'), lining: id('product:item:lining'), protector: id('product:item:protector') }
  const liningGRY = id('product:item-colour:lining:GRY')
  const office = { audience: 'office', tenantId, actorId } as const
  const select = { id: true } as const

  const result: BuyingDepthSeed = {
    variantCodes: { small: 'SEED-PRO-300-S', medium: 'SEED-PRO-300-M', archived: 'SEED-PRO-300-XL' },
    toleranceIds: { leatherP2: firstId('buying-depth:tolerance:A:P2:LEATHER'), tenant: id('buying-depth:tolerance:tenant'), protectorsP2: id('buying-depth:tolerance:A:P2:protector') },
    sampleOrder: {
      orderId: lateId('buying-depth:PO-0101'),
      protectorLineId: lateId('buying-depth:PO-0101:10'),
      liningLineId: lateId('buying-depth:PO-0101:20'),
      deliveryIds: [id('buying-depth:PO-0101:10:delivery:1'), id('buying-depth:PO-0101:10:delivery:2')],
    },
    usdOrder: {
      orderId: lateId('buying-depth:PO-0102'),
      lineId: lateId('buying-depth:PO-0102:10'),
      deliveryIds: [id('buying-depth:PO-0102:10:delivery:1'), id('buying-depth:PO-0102:10:delivery:2')],
      dateChangeId: firstId('buying-depth:PO-0102:10:date-change:1'),
    },
    plantOrder: {
      orderId: lateId('buying-depth:PO-0103'),
      lineId: lateId('buying-depth:PO-0103:10'),
      deliveryIds: [firstId('buying-depth:PO-0103:10:delivery:1'), firstId('buying-depth:PO-0103:10:delivery:2')],
    },
    requestIds: {
      open: firstId('buying-depth:request:lining'),
      converted: id('buying-depth:request:shortage:protector'),
      waiting: id('buying-depth:request:needles'),
      refused: id('buying-depth:request:refused'),
    },
    costEntryIds: {
      fee: firstId('buying-depth:cost:SC-0002:fee'),
      transport: id('buying-depth:cost:SC-0002:transport'),
      twice: id('buying-depth:cost:SC-0002:twice'),
      reversal: id('buying-depth:cost:SC-0002:twice:reversal'),
    },
    balance: {
      kitLineId: lateId('buying-depth:P1:SC-0003:kit:20'),
      moveId: lateId('buying-depth:P1:SC-0003:kit:20:transfer'),
      declaredId: id('buying-depth:P1:SC-0003:kit:20:declared'),
      adjustmentId: firstId('buying-depth:P1:SC-0003:kit:20:adjustment'),
    },
  }
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })

  // --- variants and tolerances (master data) ----------------------------------------------------------------------------
  if (!(await db.withScope(office, (client) => client.deliveryTolerance.findUnique({ where: { id: result.toleranceIds.leatherP2 }, select })))) {
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        await tx.itemVariant.createMany({
          data: [
            { id: id('buying-depth:variant:PRO-300:S'), itemId: item.protector, size: 'S', code: result.variantCodes.small, supplierCode: 'SEED-ART-300-S', ...stamp(T.setup) },
            { id: id('buying-depth:variant:PRO-300:M'), itemId: item.protector, size: 'M', code: result.variantCodes.medium, supplierCode: 'SEED-ART-300-M', ...stamp(T.setup) },
            { id: id('buying-depth:variant:PRO-300:XL'), itemId: item.protector, size: 'XL', code: result.variantCodes.archived, status: MasterStatus.ARCHIVED, ...stamp(T.setup) },
          ],
        })
        await tx.deliveryTolerance.createMany({
          data: [
            { id: result.toleranceIds.leatherP2, companyId: companyA, supplierId: partyP2, itemKind: ItemKind.LEATHER, overPct: '5.0000', underPct: '5.0000', whenBeyond: DeliveryToleranceAction.BLOCK, note: 'Hides vary; the tannery agreed ±5 % of the footage (made-up).', ...stamp(T.setup), updatedById: actorId },
            { id: result.toleranceIds.tenant, overPct: '10.0000', underPct: '5.0000', whenBeyond: DeliveryToleranceAction.APPROVAL, ...stamp(T.setup), updatedById: actorId },
            { id: result.toleranceIds.protectorsP2, companyId: companyA, supplierId: partyP2, itemId: item.protector, overPct: '0.0000', underPct: '0.0000', whenBeyond: DeliveryToleranceAction.BLOCK, note: 'Certified protectors: exactly as ordered.', ...stamp(T.setup), updatedById: actorId },
          ],
        })
      }),
    )
  }

  // --- PO-0101: a DRAFT sample order with a delivery schedule, rolls, a certificate and a variant -------------------------
  const S = result.sampleOrder
  if (!(await db.withScope(office, (client) => client.purchaseOrder.findUnique({ where: { id: S.orderId }, select })))) {
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        await tx.purchaseOrder.create({
          data: {
            id: S.orderId,
            companyId: companyB,
            siteId: siteB,
            number: 'SEED-PO-0101',
            partyId: partyP1,
            kind: PurchaseOrderKind.SAMPLE,
            developmentStyleId: id('product:style:JKT-01'),
            orderDate: DAY.drafted,
            requestedDate: DAY.sampleNeed,
            note: 'Samples for the fit round of the seed jacket.',
            internalNote: 'Seed note for the office only.',
            netAmount: 38_000,
            ...stamp(T.drafted),
          },
          select,
        })
        const line = { purchaseOrderId: S.orderId, partyId: partyP1, siteId: siteB, needDate: DAY.sampleNeed, ...stamp(T.drafted) }
        await tx.purchaseOrderLine.createMany({
          data: [
            {
              id: S.protectorLineId,
              ...line,
              seq: 10,
              itemId: item.protector,
              variantCode: result.variantCodes.medium,
              certificateId: id('compliance:certificate:PRO-300'),
              supplierArticleCode: 'SEED-ART-300-M',
              quantity: '10.0000',
              uom: Uom.PCS,
              baseQuantity: '10.0000',
              unitPrice: '7.000000',
              netAmount: 7_000,
            },
            {
              id: S.liningLineId,
              ...line,
              seq: 20,
              itemId: item.lining,
              itemColourId: liningGRY,
              description: 'Mesh lining in whole rolls',
              quantity: '100.0000',
              uom: Uom.M,
              baseQuantity: '100.0000',
              unitPrice: '3.100000',
              netAmount: 31_000,
              rolls: 2,
              rollLengthM: '50.00',
              rollWidthCm: '150.00',
            },
          ],
        })
        await tx.purchaseOrderLineDelivery.createMany({
          data: [
            { id: S.deliveryIds[0], purchaseOrderLineId: S.protectorLineId, partyId: partyP1, siteId: siteB, seq: 1, quantity: '4.0000', baseQuantity: '4.0000', needDate: DAY.sampleNeed, note: 'For the first fit sample.', ...stamp(T.drafted) },
            { id: S.deliveryIds[1], purchaseOrderLineId: S.protectorLineId, partyId: partyP1, siteId: siteB, seq: 2, quantity: '6.0000', baseQuantity: '6.0000', needDate: DAY.sampleSecond, ...stamp(T.drafted) },
          ],
        })
      }),
    )
  }

  // --- PO-0102: in USD to a third party, sent, confirmed, a delivery re-dated --------------------------------------------
  const U = result.usdOrder
  if (!(await db.withScope(office, (client) => client.purchaseOrder.findUnique({ where: { id: U.orderId }, select })))) {
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        await tx.purchaseOrder.create({
          data: {
            id: U.orderId,
            companyId: companyB,
            siteId: siteB,
            number: 'SEED-PO-0102',
            partyId: partyP1,
            currency: 'USD',
            // 7,200 US cents at 1.0850 USD to the euro: 6,636 euro cents, frozen with the order.
            rateAtOrder: '1.08500000',
            companyNetAmount: 6_636,
            shipToPartyId: partyP2,
            shipToAddressId: id('party-address:P2:office'),
            orderDate: DAY.drafted,
            requestedDate: DAY.need,
            incoterms: 'DAP Seedtown',
            note: 'Deliver to our workshop, please: two deliveries.',
            netAmount: 7_200,
            ...stamp(T.drafted),
          },
          select,
        })
        await tx.purchaseOrderLine.create({
          data: {
            id: U.lineId,
            purchaseOrderId: U.orderId,
            partyId: partyP1,
            siteId: siteB,
            seq: 10,
            itemId: item.protector,
            variantCode: result.variantCodes.small,
            quantity: '12.0000',
            uom: Uom.PCS,
            baseQuantity: '12.0000',
            unitPrice: '6.000000',
            netAmount: 7_200,
            needDate: DAY.need,
            ...stamp(T.drafted),
          },
          select,
        })
        await tx.purchaseOrderLineDelivery.createMany({
          data: [
            { id: U.deliveryIds[0], purchaseOrderLineId: U.lineId, partyId: partyP1, siteId: siteB, seq: 1, quantity: '5.0000', baseQuantity: '5.0000', needDate: DAY.need, ...stamp(T.drafted) },
            { id: U.deliveryIds[1], purchaseOrderLineId: U.lineId, partyId: partyP1, siteId: siteB, seq: 2, quantity: '7.0000', baseQuantity: '7.0000', needDate: DAY.second, ...stamp(T.drafted) },
          ],
        })
        await tx.purchaseOrder.update({ where: { id: U.orderId }, data: { status: PurchaseOrderStatus.SENT, sentAt: T.sent, sentById: actorId, version: 2, updatedAt: T.sent }, select })
        // The supplier's mail confirms the line and both deliveries as asked; the office records it.
        await tx.purchaseOrderLine.update({ where: { id: U.lineId }, data: { confirmedQuantity: '12.0000', confirmedDate: DAY.need, version: 2, updatedAt: T.confirmed }, select })
        await tx.purchaseOrderLineDelivery.update({ where: { id: U.deliveryIds[0] }, data: { confirmedDate: DAY.need, version: 2, updatedAt: T.confirmed }, select })
        await tx.purchaseOrderLineDelivery.update({ where: { id: U.deliveryIds[1] }, data: { confirmedDate: DAY.second, version: 2, updatedAt: T.confirmed }, select })
        await tx.purchaseOrder.update({
          where: { id: U.orderId },
          data: { status: PurchaseOrderStatus.CONFIRMED, confirmedAt: T.confirmed, confirmedVia: PurchaseConfirmationChannel.OFFICE, confirmedByName: 'Seed Order Desk', supplierRef: 'SEED-OC-0102', version: 3, updatedAt: T.confirmed },
          select,
        })
        // Two days later the supplier moves the second delivery a week later: the change, then the date.
        await tx.poDateChange.create({
          data: {
            id: U.dateChangeId,
            purchaseOrderLineId: U.lineId,
            partyId: partyP1,
            siteId: siteB,
            deliveryId: U.deliveryIds[1],
            seq: 1,
            fromDate: DAY.second,
            toDate: DAY.secondLater,
            source: PoDateChangeSource.SUPPLIER,
            changedAt: T.redated,
            supplierContactName: 'Seed Buyer One',
            reason: 'The moulding press is down for a week (made-up).',
            createdAt: T.redated,
            createdById: actorId,
          },
          select,
        })
        await tx.purchaseOrderLineDelivery.update({ where: { id: U.deliveryIds[1] }, data: { confirmedDate: DAY.secondLater, version: 3, updatedAt: T.redated }, select })
      }),
    )
  }

  // --- requests to buy ----------------------------------------------------------------------------------------------------
  const R = result.requestIds
  if (!(await db.withScope(office, (client) => client.purchaseRequest.findUnique({ where: { id: R.open }, select })))) {
    const production = job.subcontract.production
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        const asked = { companyId: companyA, siteId: siteA, requestedById: actorId, requestedAt: T.asked, ...stamp(T.asked) }
        await tx.purchaseRequest.createMany({
          data: [
            { id: R.open, ...asked, itemId: item.lining, itemColourId: liningGRY, quantity: '30.0000', uom: Uom.M, needDate: DAY.requestNeed, reason: 'For the spring sample jackets (made-up).' },
            {
              id: R.converted,
              ...asked,
              source: PurchaseRequestSource.SHORTAGE,
              itemId: item.protector,
              quantity: '8.0000',
              uom: Uom.PCS,
              needDate: DAY.sampleNeed,
              reason: 'WO-0001 is short of protectors.',
              workOrderId: production.workOrderId,
              shortage: { word: 'NOT_ENOUGH', short: '8.0000', needDate: '2026-12-07', runId: id('supply:run:1') },
            },
            {
              id: R.waiting,
              ...asked,
              status: PurchaseRequestStatus.PENDING_APPROVAL,
              approvalTaskId: id('buying-depth:approval-task:needles'),
              description: 'Spare needles for the new walking-foot machine (made-up).',
              quantity: '2.0000',
              uom: Uom.BOX,
              needDate: DAY.requestNeed,
              reason: 'The last box is open.',
            },
            { id: R.refused, ...asked, itemId: item.lining, itemColourId: liningGRY, quantity: '200.0000', uom: Uom.M, needDate: DAY.requestNeed, reason: 'Stock for the winter (made-up).' },
          ],
        })
        await tx.purchaseRequest.update({
          where: { id: R.converted },
          data: { status: PurchaseRequestStatus.CONVERTED, convertedAt: T.decided, convertedById: actorId, purchaseOrderLineId: draftId('supply:PO2:10'), version: 2, updatedAt: T.decided },
          select,
        })
        await tx.purchaseRequest.update({
          where: { id: R.refused },
          data: { status: PurchaseRequestStatus.REJECTED, rejectedAt: T.decided, rejectedById: actorId, rejectReason: 'Enough on the shelf until January (made-up).', version: 2, updatedAt: T.decided },
          select,
        })
      }),
    )
  }

  // --- the workshop's cost on SEED-SC-0002 (P2's packing job) -------------------------------------------------------------
  const C = result.costEntryIds
  if (!(await db.withScope(office, (client) => client.subcontractCostEntry.findUnique({ where: { id: C.fee }, select })))) {
    const order = { siteId: siteA, workOrderId: job.subcontract.production.workOrderId, subcontractOrderId: job.orderId, currency: 'EUR', createdById: actorId }
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        await tx.subcontractCostEntry.create({
          data: { id: C.fee, ...order, kind: SubcontractCostKind.FEE, subcontractOperationId: job.operationId, receiptId: job.receiptId, quantity: '1.0000', unitPrice: '2.000000', amount: 200, occurredAt: T.costed, createdAt: T.costed },
          select,
        })
        await tx.subcontractCostEntry.create({
          data: { id: C.transport, ...order, kind: SubcontractCostKind.TRANSPORT, receiptId: job.receiptId, quantity: '1.0000', unitPrice: '15.000000', amount: 1_500, occurredAt: T.costed, createdAt: T.costed },
          select,
        })
        await tx.subcontractCostEntry.create({
          data: { id: C.twice, ...order, kind: SubcontractCostKind.OTHER, quantity: '1.0000', unitPrice: '3.000000', amount: 300, occurredAt: T.costed, reason: 'Packing tape (made-up).', createdAt: T.costed },
          select,
        })
        await tx.subcontractCostEntry.create({
          data: { id: C.reversal, ...order, kind: SubcontractCostKind.OTHER, quantity: '1.0000', unitPrice: '3.000000', amount: -300, occurredAt: T.reversed, reversalOfId: C.twice, reason: 'Charged twice: the tape is in the fee (made-up).', createdAt: T.reversed },
          select,
        })
      }),
    )
  }

  // --- with partnerScope: a DRAFT order of plant A1 with its schedule; a SENT kit line of P1's job and its balance --------
  if (options.partnerScope) {
    const B = result.balance
    const P = result.plantOrder
    await seedPortalSupply(context, { partnerScope: true })
    if (!(await db.withScope(office, (client) => client.purchaseOrder.findUnique({ where: { id: P.orderId }, select })))) {
      await db.withScope(office, (client) =>
        client.$transaction(async (tx) => {
          await tx.purchaseOrder.create({
            data: {
              id: P.orderId,
              companyId: companyA,
              siteId: siteA,
              number: 'SEED-PO-0103',
              partyId: partyP1,
              kind: PurchaseOrderKind.SAMPLE,
              developmentStyleId: id('product:style:JKT-01'),
              sampleRoundId: firstId('samples:round:JKT-01:FIT:1'),
              orderDate: DAY.drafted,
              requestedDate: DAY.sampleNeed,
              netAmount: 7_000,
              ...stamp(T.drafted),
            },
            select,
          })
          await tx.purchaseOrderLine.create({
            data: { id: P.lineId, purchaseOrderId: P.orderId, partyId: partyP1, siteId: siteA, seq: 10, itemId: item.protector, quantity: '10.0000', uom: Uom.PCS, baseQuantity: '10.0000', unitPrice: '7.000000', netAmount: 7_000, needDate: DAY.sampleNeed, ...stamp(T.drafted) },
            select,
          })
          await tx.purchaseOrderLineDelivery.createMany({
            data: [
              { id: P.deliveryIds[0], purchaseOrderLineId: P.lineId, partyId: partyP1, siteId: siteA, seq: 1, quantity: '4.0000', baseQuantity: '4.0000', needDate: DAY.sampleNeed, ...stamp(T.drafted) },
              { id: P.deliveryIds[1], purchaseOrderLineId: P.lineId, partyId: partyP1, siteId: siteA, seq: 2, quantity: '6.0000', baseQuantity: '6.0000', needDate: DAY.sampleSecond, ...stamp(T.drafted) },
            ],
          })
        }),
      )
    }
    const inventory = job.subcontract.production.inventory
    const p1Job = lateId('portal-supply:P1:SC-0003')
    const p1Place = lateId('portal-supply:P1:location')
    if (!(await db.withScope(office, (client) => client.subcontractConsumption.findUnique({ where: { id: B.adjustmentId }, select })))) {
      await db.withScope(office, (client) =>
        client.$transaction(async (tx) => {
          const goods = { itemId: item.lining, itemColourId: liningGRY, lotId: inventory.liningLotId, quantity: '2.0000', uom: Uom.M, baseQuantity: '2.0000' }
          await tx.subcontractKitLine.create({
            data: { id: B.kitLineId, siteId: siteA, partyId: partyP1, subcontractOrderId: p1Job, seq: 20, ...goods, note: 'Lining for the pockets.', ...stamp(T.kitSent) },
            select,
          })
          await tx.stockMove.create({
            data: {
              id: B.moveId,
              companyId: companyA,
              siteId: siteA,
              reason: StockMoveReason.TRANSFER,
              ...goods,
              fromLocationId: inventory.locations.bin,
              toLocationId: p1Place,
              reference: 'SEED-SC-0003 kit',
              idempotencyKey: `seed-buying-depth-kit-${B.kitLineId}`,
              occurredAt: T.kitSent,
              createdAt: T.kitSent,
              createdById: actorId,
            },
            select,
          })
          await tx.subcontractKitLine.update({ where: { id: B.kitLineId }, data: { status: SubcontractKitLineStatus.SENT, sentAt: T.kitSent, moveId: B.moveId, version: 2, updatedAt: T.kitSent }, select })
          const row = { siteId: siteA, workOrderId: job.subcontract.production.workOrderId, partyId: partyP1, subcontractOrderId: p1Job, kitLineId: B.kitLineId, createdById: actorId }
          await tx.subcontractConsumption.create({
            data: { id: B.declaredId, ...row, seq: 1, kind: SubcontractConsumptionKind.DECLARED, usedQuantity: '1.5000', returnedQuantity: '0.3000', scrappedQuantity: '0.1000', reportedAt: T.declared, createdAt: T.declared },
            select,
          })
          await tx.subcontractConsumption.create({
            data: {
              id: B.adjustmentId,
              ...row,
              seq: 2,
              kind: SubcontractConsumptionKind.ADJUSTMENT,
              usedQuantity: '-0.1000',
              scrappedQuantity: '0.1000',
              reportedAt: T.adjusted,
              reasonCode: 'MEASURED',
              reason: 'The workshop measured its offcuts again: a strip was spoiled, not used (made-up).',
              createdAt: T.adjusted,
            },
            select,
          })
        }),
      )
    }
  }
  return result
}

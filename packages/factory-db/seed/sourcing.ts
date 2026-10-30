import type { Prisma } from '../src/generated/prisma/client'
import {
  ClaimFoundAt,
  ClaimRemedy,
  MasterStatus,
  PurchaseOrderStatus,
  PurchaseReminderKind,
  ReceiptDiscrepancyKind,
  ReceiptDiscrepancyStatus,
  SupplierClaimKind,
  SupplierClaimStatus,
  SupplierItemPreference,
  TypeChangeReviewStatus,
  Uom,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedCompliance } from './compliance'
import { seed as seedInventory, type InventorySeed } from './inventory'

/**
 * The W2a sourcing, buying-changes and claims seed (schema wave 3/7), per tenant of seed/_core.ts, written in the
 * tenant's office scope, as the app does:
 *
 *   source       the supplier P2's approved source for the black seed leather (company A): article SEED-ART-100 in
 *                ft², 4.20 a ft², at least 100 ft² in steps of 50, 21 days, PRIMARY.
 *   PO3          SEED-PO-0003 of company B (delivered to B1) to the brand P1 for 12 of its branded protectors: sent
 *                (revision 1), recalled and changed to 16 protectors, sent again (revision 2, confirm by 48 hours
 *                later): two PurchaseOrderRevision rows (the second with the first as `before`), and one confirmation
 *                reminder for revision 2, sent after its deadline. It gives the partner scope of the generated
 *                isolation tests (P1) a revision of its own; company B's plant keeps the golden flow's A1 plan as it was.
 *   discrepancy  on the inventory seed's R1 (posted, leather line): 4.5 ft² of hide SEED-HIDE-0002 damaged (OPEN).
 *   claim        SEED-CLM-0001 (company A, DRAFT): a claim for credit to P2 about that discrepancy, one line of 4.5 ft² of
 *                the hide at the order's 4.20, 18.90 asked.
 *   review       a type-change review (OPEN) of the product seed's jacket revision 1 against its EN 17092 certificate:
 *                a lighter body lining.
 *
 * The generated isolation tests copy the FIRST row of each table by id and insert the copy: every row here can be
 * copied as it stands (a revision of a sent order, a reminder of a SENT order, an OPEN discrepancy, a DRAFT claim and its
 * line, an OPEN review). Every name, number and price is invented. Idempotent: the source and PO3's chain are written
 * once and skipped when they exist (a sent order's history is append-only); the discrepancy, claim and review are
 * inserted once.
 */

/** Fixed instants and dates, so the seed never depends on the clock. */
const T = {
  setup: new Date('2026-10-29T08:00:00.000Z'),
  drafted: new Date('2026-11-02T08:00:00.000Z'),
  sent1: new Date('2026-11-02T09:00:00.000Z'),
  recalled: new Date('2026-11-03T08:00:00.000Z'),
  sent2: new Date('2026-11-03T09:00:00.000Z'),
  confirmBy: new Date('2026-11-05T09:00:00.000Z'),
  reminded: new Date('2026-11-05T10:00:00.000Z'),
  found: new Date('2026-11-12T11:00:00.000Z'),
  claimed: new Date('2026-11-12T12:00:00.000Z'),
  reviewed: new Date('2026-11-06T08:00:00.000Z'),
} as const
const DAY = { ordered: new Date('2026-11-02T00:00:00.000Z'), need: new Date('2026-12-10T00:00:00.000Z') } as const

export interface SourcingSeed {
  readonly inventory: InventorySeed
  readonly supplierItemId: string
  /** PO3 (company B, B1, party P1): its line, its two revisions (1 then 2) and the reminder of revision 2. */
  readonly revisedPurchaseOrderId: string
  readonly revisedLineId: string
  readonly revisionIds: readonly [string, string]
  readonly reminderId: string
  readonly discrepancyId: string
  readonly claimId: string
  readonly claimLineId: string
  readonly typeChangeReviewId: string
}

export async function seed(context: SeedContext): Promise<SourcingSeed> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order; the order, receipt, lots and certificate come from earlier seeds.
  const inventory = await seedInventory(context)
  const compliance = await seedCompliance(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const companyB = id('company:B')
  const siteA = id('site:A1')
  const siteB = id('site:B1')
  const supplierId = id('party:P2')
  const brandId = id('party:P1')
  const item = { leather: id('product:item:leather'), protector: id('product:item:protector') }
  const leatherBLK = id('product:item-colour:leather:BLK')
  const office = { audience: 'office' as const, tenantId, actorId }

  const supplierItemId = id('sourcing:supplier-item:P2:leather:BLK')
  const po3 = {
    order: id('sourcing:PO3'),
    line: id('sourcing:PO3:10'),
    revisions: [id('sourcing:PO3:revision:1'), id('sourcing:PO3:revision:2')] as const,
    reminder: id('sourcing:PO3:reminder:1'),
  }
  const discrepancyId = id('claims:discrepancy:R1:10')
  const claim = { id: id('claims:claim:CLM-0001'), line: id('claims:claim:CLM-0001:10') }
  const typeChangeReviewId = id('compliance:type-change:JKT-01:1')

  // --- the approved source: upserted (a plain master row) ---------------------------------------------------------
  const source: Prisma.SupplierItemUncheckedCreateInput = {
    id: supplierItemId,
    companyId: companyA,
    partyId: supplierId,
    itemId: item.leather,
    itemColourId: leatherBLK,
    supplierArticleCode: 'SEED-ART-100',
    supplierColourCode: 'S-001',
    description: 'Seed cowhide, full grain, black',
    purchaseUom: Uom.FT2,
    purchaseFactor: '1',
    unitPrice: '4.200000',
    currency: 'EUR',
    minOrderQty: '100.0000',
    orderMultiple: '50.0000',
    leadTimeDays: 21,
    preference: SupplierItemPreference.PRIMARY,
    status: MasterStatus.ACTIVE,
    note: 'Seed source: one dye batch per order on request.',
    createdAt: T.setup,
    updatedAt: T.setup,
    createdById: actorId,
  }
  await db.withScope(office, (client) => {
    const { id: sourceId, ...data } = source
    return client.supplierItem.upsert({ where: { id: sourceId as string }, create: source, update: data, select: { id: true } })
  })

  // --- PO3: sent, changed, sent again; its revisions and a reminder (once) -----------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.purchaseOrder.findUnique({ where: { id: po3.order }, select: { id: true } })) return
      const header = {
        requestedDate: '2026-12-10',
        incoterms: null,
        paymentTerms: '30 days end of month',
        note: 'Branded shoulder protectors for the brand line (plant B1).',
      }
      await tx.purchaseOrder.create({
        data: {
          id: po3.order,
          companyId: companyB,
          siteId: siteB,
          number: 'SEED-PO-0003',
          partyId: brandId,
          contactId: id('party-contact:P1:buyer'),
          orderDate: DAY.ordered,
          requestedDate: DAY.need,
          paymentTerms: header.paymentTerms,
          note: header.note,
          internalNote: 'Seed note for the office only.',
          netAmount: 7_800,
          createdAt: T.drafted,
          updatedAt: T.drafted,
          createdById: actorId,
        },
        select: { id: true },
      })
      await tx.purchaseOrderLine.create({
        data: {
          id: po3.line,
          purchaseOrderId: po3.order,
          partyId: brandId,
          siteId: siteB,
          seq: 10,
          itemId: item.protector,
          description: 'Shoulder protector level 2, brand logo',
          quantity: '12.0000',
          uom: Uom.PCS,
          baseQuantity: '12.0000',
          unitPrice: '6.500000',
          netAmount: 7_800,
          needDate: DAY.need,
          createdAt: T.drafted,
          updatedAt: T.drafted,
          createdById: actorId,
        },
        select: { id: true },
      })
      const lineAs = (quantity: string) => ({ id: po3.line, seq: 10, itemId: item.protector, itemColourId: null, description: 'Shoulder protector level 2, brand logo', quantity, uom: 'PCS', needDate: '2026-12-10', confirmedQuantity: null, confirmedDate: null, cancelled: false })
      const pricesAs = (quantity: number) => ({ currency: 'EUR', netAmount: quantity * 650, lines: [{ id: po3.line, seq: 10, unitPrice: '6.500000', netAmount: quantity * 650 }] })
      const revision1 = { ...header, status: 'SENT', confirmation: null, lines: [lineAs('12.0000')] }

      // Revision 1: sent.
      await tx.purchaseOrder.update({ where: { id: po3.order }, data: { status: PurchaseOrderStatus.SENT, sentAt: T.sent1, sentById: actorId, version: 2 }, select: { id: true } })
      await tx.purchaseOrderRevision.create({
        data: { id: po3.revisions[0], purchaseOrderId: po3.order, partyId: brandId, siteId: siteB, revision: 1, sentAt: T.sent1, sentById: actorId, after: revision1, afterPrices: pricesAs(12), createdAt: T.sent1, createdById: actorId },
        select: { id: true },
      })
      // Recalled to change the quantity (revision 2), then sent again with a confirm-by deadline.
      await tx.purchaseOrder.update({ where: { id: po3.order }, data: { status: PurchaseOrderStatus.DRAFT, revision: 2, sentAt: null, sentById: null, version: 3 }, select: { id: true } })
      await tx.purchaseOrderLine.update({ where: { id: po3.line }, data: { quantity: '16.0000', baseQuantity: '16.0000', netAmount: 10_400, version: 2 }, select: { id: true } })
      await tx.purchaseOrder.update({
        where: { id: po3.order },
        data: { status: PurchaseOrderStatus.SENT, sentAt: T.sent2, sentById: actorId, confirmBy: T.confirmBy, netAmount: 10_400, version: 4 },
        select: { id: true },
      })
      await tx.purchaseOrderRevision.create({
        data: {
          id: po3.revisions[1],
          purchaseOrderId: po3.order,
          partyId: brandId,
          siteId: siteB,
          revision: 2,
          sentAt: T.sent2,
          sentById: actorId,
          before: revision1,
          after: { ...header, status: 'SENT', confirmation: null, lines: [lineAs('16.0000')] },
          beforePrices: pricesAs(12),
          afterPrices: pricesAs(16),
          changeNote: 'Four more protectors for the brand line: 16 instead of 12, same date.',
          createdAt: T.sent2,
          createdById: actorId,
        },
        select: { id: true },
      })
      // No answer by the deadline: the scheduler's reminder (no person).
      await tx.purchaseOrderReminder.create({
        data: { id: po3.reminder, purchaseOrderId: po3.order, partyId: brandId, siteId: siteB, revision: 2, kind: PurchaseReminderKind.CONFIRMATION, sentAt: T.reminded, toAddress: 'buyer.p1@example.com', note: 'Seed reminder: no answer 48 hours after the send.', createdAt: T.reminded },
        select: { id: true },
      })
    }),
  )

  // --- the discrepancy, the claim and the review (once each) -------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (!(await tx.receiptDiscrepancy.findUnique({ where: { id: discrepancyId }, select: { id: true } }))) {
        await tx.receiptDiscrepancy.create({
          data: {
            id: discrepancyId,
            siteId: siteA,
            receiptId: inventory.receiptId,
            seq: 10,
            receiptLineId: inventory.receiptLineId,
            supplierId,
            kind: ReceiptDiscrepancyKind.DAMAGED,
            quantity: '4.5000',
            uom: Uom.FT2,
            note: 'A hole near the belly of hide SEED-HIDE-0002 (about 4.5 ft²); photos attached.',
            status: ReceiptDiscrepancyStatus.OPEN,
            createdAt: T.found,
            updatedAt: T.found,
            createdById: actorId,
          },
          select: { id: true },
        })
      }
      if (!(await tx.supplierClaim.findUnique({ where: { id: claim.id }, select: { id: true } }))) {
        await tx.supplierClaim.create({
          data: {
            id: claim.id,
            companyId: companyA,
            siteId: siteA,
            number: 'SEED-CLM-0001',
            partyId: supplierId,
            kind: SupplierClaimKind.CLAIM,
            goodsReceiptId: inventory.receiptId,
            purchaseOrderId: inventory.supply.purchaseOrderId,
            foundAt: ClaimFoundAt.RECEIPT,
            reason: 'Hide SEED-HIDE-0002 has a hole of about 4.5 ft²: we ask for a credit of that area.',
            remedy: ClaimRemedy.CREDIT,
            status: SupplierClaimStatus.DRAFT,
            currency: 'EUR',
            expectedCreditAmount: 1_890,
            internalNote: 'Seed note for the office only.',
            createdAt: T.claimed,
            updatedAt: T.claimed,
            createdById: actorId,
          },
          select: { id: true },
        })
        await tx.supplierClaimLine.create({
          data: {
            id: claim.line,
            siteId: siteA,
            partyId: supplierId,
            claimId: claim.id,
            seq: 10,
            discrepancyId,
            receiptLineId: inventory.receiptLineId,
            itemId: item.leather,
            itemColourId: leatherBLK,
            lotId: inventory.leatherLotId,
            hideId: inventory.hideIds[1],
            quantity: '4.5000',
            uom: Uom.FT2,
            baseQuantity: '4.5000',
            unitCost: '4.200000',
            creditAmount: 1_890,
            createdAt: T.claimed,
            updatedAt: T.claimed,
            createdById: actorId,
          },
          select: { id: true },
        })
      }
      if (!(await tx.typeChangeReview.findUnique({ where: { id: typeChangeReviewId }, select: { id: true } }))) {
        await tx.typeChangeReview.create({
          data: {
            id: typeChangeReviewId,
            styleId: id('product:style:JKT-01'),
            revisionId: id('product:revision:JKT-01:1'),
            certificateId: compliance.certificateId,
            changes: [{ kind: 'LINING', what: 'Body lining', before: 'SEED-LIN-200 grey, as examined', after: 'SEED-LIN-200 grey, a lighter weave', bomLineId: id('product:bom:JKT-01:1:20') }],
            status: TypeChangeReviewStatus.OPEN,
            createdAt: T.reviewed,
            updatedAt: T.reviewed,
            createdById: actorId,
          },
          select: { id: true },
        })
      }
    }),
  )

  return {
    inventory,
    supplierItemId,
    revisedPurchaseOrderId: po3.order,
    revisedLineId: po3.line,
    revisionIds: po3.revisions,
    reminderId: po3.reminder,
    discrepancyId,
    claimId: claim.id,
    claimLineId: claim.line,
    typeChangeReviewId,
  }
}

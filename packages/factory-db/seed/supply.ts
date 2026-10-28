import type { Prisma } from '../src/generated/prisma/client'
import {
  PlanningRunStatus,
  PlanningTrigger,
  PurchaseConfirmationChannel,
  PurchaseOrderStatus,
  RequirementAction,
  RequirementDecision,
  Uom,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedSales } from './sales'

/**
 * The supply seed, per tenant of seed/_core.ts: the golden flow's stage 08-buy for the sales seed's order SO1, written
 * in the tenant's office scope, as the app does.
 *
 *   run 1  a planning run of site A1 (DONE) for SO1 (BLK 2/4/2 and RED 1/2/1 in sizes 50/52/54): black leather
 *          404.32 ft² (ORDERED), red leather 202.16 ft² (OPEN), grey lining covered by stock (IGNORED), 24 shoulder
 *          protectors (ORDERED).
 *   PO1    SEED-PO-0001 (company A, delivered to A1) to the parties seed's supplier P2: black leather 420 ft² (about 8
 *          hides, one dye batch, Cr VI tested) and 24 protectors; sent, and CONFIRMED by the office from the supplier's
 *          mail. Its id is the links seed's PO_CONFIRM record, so that seeded link names a real order. The inventory
 *          seed receives part of it (PARTLY_RECEIVED).
 *   PO2    SEED-PO-0002: a DRAFT order to the brand P1 for 10 of its branded protectors (a brand that also supplies a
 *          component; the purchasing module checks the SUPPLIER role, the database does not). It gives the partner
 *          scope of the generated isolation tests (P1) an order of its own.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: a line of a sent order cannot be copied (the …_supply_guards triggers). So PO2's rows get ids that start with
 * eight zeros (still derived from the namespace) and are always the first.
 *
 * Every name, number and price is invented. Idempotent: PO1 and the run are made in one transaction and skipped when
 * they exist (a sent order's lines never change, a run's numbers never change); PO2 is inserted once and its line is
 * left as it is once the order left DRAFT.
 */

/** Fixed instants and dates, so the seed never depends on the clock. */
const T = {
  planned: new Date('2026-10-30T09:00:00.000Z'),
  planFinished: new Date('2026-10-30T09:01:00.000Z'),
  ordered: new Date('2026-10-30T10:00:00.000Z'),
  sent: new Date('2026-10-30T11:00:00.000Z'),
  confirmed: new Date('2026-10-31T09:00:00.000Z'),
  draft: new Date('2026-10-31T08:00:00.000Z'),
} as const
const DAY = {
  ordered: new Date('2026-10-30T00:00:00.000Z'),
  draft: new Date('2026-10-31T00:00:00.000Z'),
  need: new Date('2026-11-16T00:00:00.000Z'),
  confirmed: new Date('2026-11-13T00:00:00.000Z'),
  draftNeed: new Date('2026-12-01T00:00:00.000Z'),
} as const

export interface SupplySeed {
  /** PO1: the confirmed order to the supplier P2 and its two lines. */
  readonly purchaseOrderId: string
  readonly leatherLineId: string
  readonly protectorLineId: string
  /** PO2: the draft order to the brand P1 and its line. */
  readonly draftPurchaseOrderId: string
  readonly draftLineId: string
  readonly planningRunId: string
  /** The parties seed's supplier P2. */
  readonly supplierId: string
}

export async function seed(context: SeedContext): Promise<SupplySeed> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order; the order, its party and the materials come from earlier seeds.
  await seedSales(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** PO2's ids: derived like every other, with eight leading zeros so they sort first (see above). */
  const draftId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const supplierId = id('party:P2')
  const brandId = id('party:P1')
  const item = { leather: id('product:item:leather'), lining: id('product:item:lining'), protector: id('product:item:protector') }
  const colour = { leatherBLK: id('product:item-colour:leather:BLK'), leatherRED: id('product:item-colour:leather:RED'), liningGRY: id('product:item-colour:lining:GRY') }
  const orderLine = { BLK: id('sales:SO1:line:10'), RED: id('sales:SO1:line:20') }
  const orderId = id('sales:SO1')

  const po1 = { order: id('link:P2:record'), leather: id('supply:PO1:10'), protector: id('supply:PO1:20') }
  const po2 = { order: draftId('supply:PO2'), line: draftId('supply:PO2:10') }
  const runId = id('supply:run:1')

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      // --- PO2: a draft, inserted once ------------------------------------------------------------------------------
      const draft = await tx.purchaseOrder.findUnique({ where: { id: po2.order }, select: { status: true } })
      if (!draft) {
        await tx.purchaseOrder.create({
          data: {
            id: po2.order,
            companyId: companyA,
            siteId: siteA,
            number: 'SEED-PO-0002',
            partyId: brandId,
            contactId: id('party-contact:P1:buyer'),
            orderDate: DAY.draft,
            requestedDate: DAY.draftNeed,
            paymentTerms: '30 days end of month',
            note: 'Branded shoulder protectors for the brand line.',
            internalNote: 'Seed note for the office only.',
            netAmount: 7_000,
            createdAt: T.draft,
            updatedAt: T.draft,
            createdById: actorId,
          },
          select: { id: true },
        })
      }
      if (!draft || draft.status === PurchaseOrderStatus.DRAFT) {
        const line: Prisma.PurchaseOrderLineUncheckedCreateInput = {
          id: po2.line,
          purchaseOrderId: po2.order,
          partyId: brandId,
          siteId: siteA,
          seq: 10,
          itemId: item.protector,
          description: 'Shoulder protector level 2, brand logo',
          quantity: '10.0000',
          uom: Uom.PCS,
          baseQuantity: '10.0000',
          unitPrice: '7.000000',
          netAmount: 7_000,
          needDate: DAY.draftNeed,
          createdAt: T.draft,
          updatedAt: T.draft,
          createdById: actorId,
        }
        const { id: lineId, ...data } = line
        await tx.purchaseOrderLine.upsert({ where: { id: lineId as string }, create: line, update: data, select: { id: true } })
      }

      // --- the planning run and PO1, in one go (skipped once they exist) --------------------------------------------
      if (await tx.planningRun.findUnique({ where: { id: runId }, select: { id: true } })) return

      await tx.planningRun.create({
        data: {
          id: runId,
          companyId: companyA,
          siteId: siteA,
          trigger: PlanningTrigger.ORDER,
          status: PlanningRunStatus.DONE,
          orderLines: 2,
          startedAt: T.planned,
          finishedAt: T.planFinished,
          note: 'Seed run after order SEED-SO-0001.',
          createdAt: T.planned,
          updatedAt: T.planFinished,
          createdById: actorId,
        },
        select: { id: true },
      })

      // PO1: drafted with its lines, sent, then confirmed by the office from the supplier's mail.
      await tx.purchaseOrder.create({
        data: {
          id: po1.order,
          companyId: companyA,
          siteId: siteA,
          number: 'SEED-PO-0001',
          partyId: supplierId,
          contactId: id('party-contact:P2:orders'),
          orderDate: DAY.ordered,
          requestedDate: DAY.need,
          incoterms: 'DAP Seedville',
          paymentTerms: '60 days end of month',
          note: 'One dye batch for the whole leather line, please.',
          internalNote: 'Seed note for the office only.',
          netAmount: 192_000,
          createdAt: T.ordered,
          updatedAt: T.ordered,
          createdById: actorId,
        },
        select: { id: true },
      })
      const common = { purchaseOrderId: po1.order, partyId: supplierId, siteId: siteA, needDate: DAY.need, createdAt: T.ordered, updatedAt: T.ordered, createdById: actorId }
      await tx.purchaseOrderLine.createMany({
        data: [
          {
            id: po1.leather,
            ...common,
            seq: 10,
            itemId: item.leather,
            itemColourId: colour.leatherBLK,
            supplierArticleCode: 'SEED-ART-100',
            supplierColourCode: 'S-001',
            quantity: '420.0000',
            uom: Uom.FT2,
            baseQuantity: '420.0000',
            unitPrice: '4.200000',
            netAmount: 176_400,
            grade: 'A',
            thicknessMinMm: '1.10',
            thicknessMaxMm: '1.30',
            oneDyeBatch: true,
            areaTolerancePct: '5.0000',
            estimatedHides: 8,
            requiresCrViTest: true,
          },
          {
            id: po1.protector,
            ...common,
            seq: 20,
            itemId: item.protector,
            supplierArticleCode: 'SEED-ART-300',
            quantity: '24.0000',
            uom: Uom.PCS,
            baseQuantity: '24.0000',
            unitPrice: '6.500000',
            netAmount: 15_600,
          },
        ],
      })
      await tx.purchaseOrder.update({
        where: { id: po1.order },
        data: { status: PurchaseOrderStatus.SENT, sentAt: T.sent, sentById: actorId, version: 2 },
        select: { id: true },
      })
      for (const lineId of [po1.leather, po1.protector]) {
        await tx.purchaseOrderLine.update({
          where: { id: lineId },
          data: { confirmedQuantity: lineId === po1.leather ? '420.0000' : '24.0000', confirmedDate: DAY.confirmed, version: 2 },
          select: { id: true },
        })
      }
      await tx.purchaseOrder.update({
        where: { id: po1.order },
        data: {
          status: PurchaseOrderStatus.CONFIRMED,
          confirmedAt: T.confirmed,
          confirmedVia: PurchaseConfirmationChannel.OFFICE,
          confirmedByName: 'Seed Order Desk',
          supplierRef: 'SEED-OC-2201',
          confirmNote: 'Confirmed by mail; delivery in two parts.',
          version: 3,
        },
        select: { id: true },
      })

      // The run's requirements: the snapshot it wrote, then the office's decisions.
      const leatherSources = (code: 'BLK' | 'RED', sizes: readonly [string, number, string][]) =>
        sizes.map(([size, pieces, quantity]) => ({ orderId, orderLineId: orderLine[code], size, pieces, quantity }))
      const requirement = { siteId: siteA, runId, needDate: DAY.need, createdAt: T.planFinished, createdById: actorId }
      await tx.materialRequirement.createMany({
        data: [
          {
            id: id('supply:run:1:1'),
            ...requirement,
            seq: 1,
            itemId: item.leather,
            itemColourId: colour.leatherBLK,
            action: RequirementAction.BUY,
            uom: Uom.FT2,
            // 2 x 43 + 4 x 45 + 2 x 47.5 = 361 ft², with 12% hide wastage.
            grossQuantity: '404.3200',
            usableStock: '0.0000',
            heldStock: '0.0000',
            onOrder: '0.0000',
            netQuantity: '404.3200',
            suggestedQuantity: '8.0000',
            suggestedUom: Uom.HIDE,
            supplierId,
            sources: leatherSources('BLK', [
              ['50', 2, '96.3200'],
              ['52', 4, '201.6000'],
              ['54', 2, '106.4000'],
            ]),
            decision: RequirementDecision.ORDERED,
            purchaseOrderLineId: po1.leather,
            decidedAt: T.ordered,
            decidedById: actorId,
            updatedAt: T.ordered,
          },
          {
            id: id('supply:run:1:2'),
            ...requirement,
            seq: 2,
            itemId: item.leather,
            itemColourId: colour.leatherRED,
            action: RequirementAction.BUY,
            uom: Uom.FT2,
            // 43 + 2 x 45 + 47.5 = 180.5 ft², with 12% hide wastage.
            grossQuantity: '202.1600',
            usableStock: '0.0000',
            heldStock: '0.0000',
            onOrder: '0.0000',
            netQuantity: '202.1600',
            suggestedQuantity: '4.0000',
            suggestedUom: Uom.HIDE,
            supplierId,
            sources: leatherSources('RED', [
              ['50', 1, '48.1600'],
              ['52', 2, '100.8000'],
              ['54', 1, '53.2000'],
            ]),
            updatedAt: T.planFinished,
          },
          {
            id: id('supply:run:1:3'),
            ...requirement,
            seq: 3,
            itemId: item.lining,
            itemColourId: colour.liningGRY,
            action: RequirementAction.BUY,
            uom: Uom.M,
            // 12 jackets x 1.8 m, with 5% wastage; the opening stock covers it.
            grossQuantity: '22.6800',
            usableStock: '120.0000',
            heldStock: '0.0000',
            onOrder: '0.0000',
            netQuantity: '0.0000',
            suggestedQuantity: '0.0000',
            suggestedUom: Uom.ROLL,
            sources: [
              { orderId, orderLineId: orderLine.BLK, size: '*', pieces: 8, quantity: '15.1200' },
              { orderId, orderLineId: orderLine.RED, size: '*', pieces: 4, quantity: '7.5600' },
            ],
            decision: RequirementDecision.IGNORED,
            decisionNote: 'Covered by the stock on hand.',
            decidedAt: T.ordered,
            decidedById: actorId,
            updatedAt: T.ordered,
          },
          {
            id: id('supply:run:1:4'),
            ...requirement,
            seq: 4,
            itemId: item.protector,
            action: RequirementAction.BUY,
            uom: Uom.PCS,
            grossQuantity: '24.0000',
            usableStock: '0.0000',
            heldStock: '0.0000',
            onOrder: '0.0000',
            netQuantity: '24.0000',
            suggestedQuantity: '24.0000',
            suggestedUom: Uom.PCS,
            supplierId,
            sources: [
              { orderId, orderLineId: orderLine.BLK, size: '*', pieces: 8, quantity: '16.0000' },
              { orderId, orderLineId: orderLine.RED, size: '*', pieces: 4, quantity: '8.0000' },
            ],
            decision: RequirementDecision.ORDERED,
            purchaseOrderLineId: po1.protector,
            decidedAt: T.ordered,
            decidedById: actorId,
            updatedAt: T.ordered,
          },
        ],
      })
    }),
  )

  return {
    purchaseOrderId: po1.order,
    leatherLineId: po1.leather,
    protectorLineId: po1.protector,
    draftPurchaseOrderId: po2.order,
    draftLineId: po2.line,
    planningRunId: runId,
    supplierId,
  }
}

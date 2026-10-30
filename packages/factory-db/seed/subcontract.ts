import {
  LocationKind,
  SubcontractKitLineStatus,
  SubcontractOrderStatus,
  Uom,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedProduction, type ProductionSeed } from './production'

/**
 * The W2a subcontracting seed (schema wave 3/7), per tenant of seed/_core.ts, written in the tenant's office scope, as
 * the app does:
 *
 *   location  A1-TERZ-P2, the stock location of the workshop P2 (the parties seed's supplier and subcontractor of
 *             company A) on plant A1: kind SUBCONTRACTOR, owned by P2; empty (our stock there stays ours).
 *   order     SEED-SC-0001 (company A, DRAFT) to P2 for the production seed's WO-0001: its sewing operation for the 7
 *             garments of the work order (BLK 1/2/1, RED 1/1/1 of sizes 50/52/54) at 4.50 a piece, due back in 10 days;
 *             one kit line PLANNED: 12.6 m of the grey lining (7 × 1.8 m), lot still to pick.
 *
 * Nothing moves in the stock ledger: the kit is only planned, so the golden flow's stock at A1 is the same. The
 * generated isolation tests copy the FIRST row of each table by id and insert the copy: an operation and a kit line of
 * a DRAFT order can be copied. Every name, number and fee is invented. Idempotent: the location is upserted (its
 * workshop never changes), the order with its operation and kit line is written once and skipped when it exists.
 */

/** Fixed instants and dates, so the seed never depends on the clock. */
const T = { setup: new Date('2026-11-15T08:00:00.000Z'), drafted: new Date('2026-11-16T11:00:00.000Z') } as const
const DAY = { ordered: new Date('2026-11-16T00:00:00.000Z'), back: new Date('2026-11-26T00:00:00.000Z') } as const

export interface SubcontractSeed {
  readonly production: ProductionSeed
  readonly locationId: string
  readonly orderId: string
  readonly operationId: string
  readonly kitLineId: string
}

export async function seed(context: SeedContext): Promise<SubcontractSeed> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order; the work order and its operations come from the production seed.
  const production = await seedProduction(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const workshopId = id('party:P2')
  const office = { audience: 'office' as const, tenantId, actorId }

  const locationId = id('subcontract:location:A1-TERZ-P2')
  const order = { id: id('subcontract:SC-0001'), operation: id('subcontract:SC-0001:op:10'), kit: id('subcontract:SC-0001:kit:10') }
  const cells = production.cellIds
  const grid = [
    ['BLK-50', 1],
    ['BLK-52', 2],
    ['BLK-54', 1],
    ['RED-50', 1],
    ['RED-52', 1],
    ['RED-54', 1],
  ] as const

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const place = { companyId: companyA, siteId: siteA, code: 'A1-TERZ-P2', name: 'Seed workshop P2 (our stock there)', kind: LocationKind.SUBCONTRACTOR, partyId: workshopId, updatedAt: T.setup }
      await tx.location.upsert({ where: { id: locationId }, create: { id: locationId, ...place, createdAt: T.setup, createdById: actorId }, update: place, select: { id: true } })

      if (await tx.subcontractOrder.findUnique({ where: { id: order.id }, select: { id: true } })) return
      await tx.subcontractOrder.create({
        data: {
          id: order.id,
          companyId: companyA,
          siteId: siteA,
          number: 'SEED-SC-0001',
          partyId: workshopId,
          locationId,
          workOrderId: production.workOrderId,
          status: SubcontractOrderStatus.DRAFT,
          orderDate: DAY.ordered,
          expectedBackDate: DAY.back,
          currency: 'EUR',
          netAmount: 3_150,
          note: 'Sew the jackets of the seed work order; trims and lining come with the kit.',
          internalNote: 'Seed note for the office only.',
          createdAt: T.drafted,
          updatedAt: T.drafted,
          createdById: actorId,
        },
        select: { id: true },
      })
      await tx.subcontractOperation.create({
        data: {
          id: order.operation,
          siteId: siteA,
          workOrderId: production.workOrderId,
          subcontractOrderId: order.id,
          seq: 10,
          workOrderOperationId: production.operationIds.sew,
          pieces: 7,
          sizes: grid.map(([cell, pieces]) => ({ workOrderSizeId: cells[cell], pieces })),
          pricePerPiece: '4.500000',
          netAmount: 3_150,
          expectedBackDate: DAY.back,
          createdAt: T.drafted,
          updatedAt: T.drafted,
          createdById: actorId,
        },
        select: { id: true },
      })
      await tx.subcontractKitLine.create({
        data: {
          id: order.kit,
          siteId: siteA,
          partyId: workshopId,
          subcontractOrderId: order.id,
          seq: 10,
          itemId: id('product:item:lining'),
          itemColourId: id('product:item-colour:lining:GRY'),
          quantity: '12.6000',
          uom: Uom.M,
          baseQuantity: '12.6000',
          status: SubcontractKitLineStatus.PLANNED,
          note: 'Body lining for the 7 jackets.',
          createdAt: T.drafted,
          updatedAt: T.drafted,
          createdById: actorId,
        },
        select: { id: true },
      })
    }),
  )

  return { production, locationId, orderId: order.id, operationId: order.operation, kitLineId: order.kit }
}

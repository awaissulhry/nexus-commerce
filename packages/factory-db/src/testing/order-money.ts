import { seed as seedPortalSales } from '../../seed/portal-sales'
import { seedUuid, type SeedContext } from '../seeding'

/**
 * B-OM-019 (order money tab, schema wave "order money 1/1"): rows of the wave's two new tables, for the tests. The wave changes no
 * CLI seed, so the generated isolation test (isolation.pg.vitest.test.ts) writes them with this fixture (as testing/customer-page.ts
 * does for its wave). Per tenant of seed/_core.ts, on SEED-SO-0001 (P1's, open):
 *
 *   OrderPriceAcceptance  one price difference accepted by the office, in force (the first row a generated copy may repeat: the
 *                         isolation test moves the copy to another open order of P1, as one order holds one in force)
 *   OrderCostLine         a commission typed by hand, counted (the first row a copy may repeat), and a freight estimate removed
 *                         with its reason (typed, then removed, as the app does: the guard allows the removal once)
 *
 * Written as the app does, in the office scope. The first row of each table (ids that start with eight zeros) is the plain one a
 * generated copy may repeat; the others start with eight f's. Every figure and word is made up. Idempotent: rows are inserted once
 * (skipped when they exist), the removal made once. Runs the portal sales seed of the same namespace first (idempotent).
 */

/** A fixed instant, before the day the step was built (history: it never moves). */
const AT = new Date('2026-11-21T09:00:00.000Z')
const REMOVED_AT = new Date('2026-11-21T10:00:00.000Z')

export interface OrderMoneyFixture {
  readonly tenantId: string
  readonly companyId: string
  readonly partyId: string
  /** SEED-SO-0001. */
  readonly orderId: string
  readonly acceptanceId: string
  readonly costLineIds: { readonly counted: string; readonly removed: string }
}

export async function seedOrderMoney(context: SeedContext): Promise<OrderMoneyFixture> {
  const { db, namespace } = context
  const portal = await seedPortalSales(context)
  const id = (key: string): string => seedUuid(namespace, `order-money:${key}`)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const actorId = seedUuid(namespace, 'actor')
  const office = { audience: 'office', tenantId: portal.tenantId, actorId } as const
  const made: OrderMoneyFixture = {
    tenantId: portal.tenantId,
    companyId: portal.companyId,
    partyId: portal.partyId,
    orderId: portal.orders.so1,
    acceptanceId: firstId('acceptance:SO1'),
    costLineIds: { counted: firstId('cost-line:SO1:commission'), removed: lateId('cost-line:SO1:freight') },
  }
  const { currency } = await db.withScope(office, (client) => client.salesOrder.findUniqueOrThrow({ where: { id: made.orderId }, select: { currency: true } }))
  const ofOrder = { companyId: made.companyId, partyId: made.partyId, salesOrderId: made.orderId } as const

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.orderPriceAcceptance.createMany({
        data: [{ id: made.acceptanceId, ...ofOrder, ourNet: 1_250_000, brandNet: 1_234_500, reason: 'Seed: the customer’s total agreed by phone.', acceptedById: actorId, acceptedAt: AT }],
        skipDuplicates: true,
      })
      await tx.orderCostLine.createMany({
        data: [
          { id: made.costLineIds.counted, ...ofOrder, kind: 'COMMISSION', amount: 25_000, currency, reason: 'Seed: the agent’s commission.', createdById: actorId, createdAt: AT },
          { id: made.costLineIds.removed, ...ofOrder, kind: 'FREIGHT_ESTIMATE', amount: 4_000, currency, reason: 'Seed: the freight until the carrier charges it.', createdById: actorId, createdAt: AT },
        ],
        skipDuplicates: true,
      })
      // The freight estimate removed once the carrier's charge came (the guard allows it once: only while it still counts).
      await tx.orderCostLine.updateMany({
        where: { id: made.costLineIds.removed, removedAt: null },
        data: { removedAt: REMOVED_AT, removedById: actorId, removeReason: 'Seed: the carrier’s charge is on the shipment now.' },
      })
    }),
  )
  return made
}

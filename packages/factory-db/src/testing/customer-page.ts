import { seed as seedPortalSales } from '../../seed/portal-sales'
import { seedUuid, type SeedContext } from '../seeding'

/**
 * B-CP-005 (customer page plan, schema wave "customer page 1/1"): rows of the wave's two new tables, for the tests. The wave
 * changes no CLI seed (15-steps-notes §2: "no seed change"), so the generated isolation test (isolation.pg.vitest.test.ts)
 * and the wave's own test (customer-page.pg.vitest.test.ts) write them with this fixture. Per tenant of seed/_core.ts:
 *
 *   OrderBrandPrice           P1's own price for SEED-SO-0001's first line (PORTAL: typed by its buyer in the portal, a unit
 *                             price) and the factory's total for the whole order (OFFICE: typed by the seed's office person);
 *                             the order's second line has none, so a generated copy of the first row can take it (a line
 *                             holds one row: the unique key).
 *   PortalOrderRequestPerson  a MADE_TO_MEASURE line on P1's DRAFT (seq 3, a jacket, by person) and two of its riders: the
 *                             first by size, the second "sending later".
 *
 * Written as the app does: the customer's rows in P1's partner scope (its portal buyer), the office's in the office scope.
 * The first row of each table (ids that start with eight zeros) is the plain one a generated copy may repeat; the others
 * start with eight f's. Every name and number is made up. Idempotent: rows are inserted once (skipped when they exist).
 * Runs the portal sales seed of the same namespace first (idempotent).
 */

/** A fixed instant, before the day the step was built (history: it never moves). */
const AT = new Date('2026-11-05T09:00:00.000Z')

export interface CustomerPageFixture {
  readonly tenantId: string
  readonly companyId: string
  readonly partyId: string
  readonly buyerId: string
  /** SEED-SO-0001 and its two lines (seq 10, 20). */
  readonly orderId: string
  readonly lineIds: readonly [string, string]
  readonly priceIds: { readonly portalLine: string; readonly officeTotal: string }
  /** P1's DRAFT request, its made-to-measure line and the line's two people. */
  readonly draftId: string
  readonly mtmLineId: string
  readonly personIds: readonly [string, string]
}

export async function seedCustomerPage(context: SeedContext): Promise<CustomerPageFixture> {
  const { db, namespace } = context
  const portal = await seedPortalSales(context)
  const id = (key: string): string => seedUuid(namespace, `customer-page:${key}`)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = portal.tenantId
  const actorId = seedUuid(namespace, 'actor')
  const office = { audience: 'office', tenantId, actorId } as const
  const asBuyer = { audience: 'partner', tenantId, actorId: portal.buyerId, partyId: portal.partyId } as const

  const lines = await db.withScope(office, (client) =>
    client.salesOrderLine.findMany({ where: { orderId: portal.orders.so1 }, select: { id: true }, orderBy: { seq: 'asc' } }),
  )
  if (lines.length < 2) throw new Error('customer-page fixture: SEED-SO-0001 needs its two lines (seed/sales.ts)')
  const made: CustomerPageFixture = {
    tenantId,
    companyId: portal.companyId,
    partyId: portal.partyId,
    buyerId: portal.buyerId,
    orderId: portal.orders.so1,
    lineIds: [lines[0]!.id, lines[1]!.id],
    priceIds: { portalLine: firstId('price:SO1:line:10'), officeTotal: lateId('price:SO1:total') },
    draftId: portal.requests.draft,
    mtmLineId: lateId('draft:line:3'),
    personIds: [firstId('draft:line:3:person:1'), lateId('draft:line:3:person:2')],
  }
  const stamp = { createdAt: AT, updatedAt: AT } as const

  // The customer's own price for the first line, typed in the portal (the partner role reads no enteredById: nothing is
  // read back but the count).
  await db.withScope(asBuyer, (client) =>
    client.orderBrandPrice.createMany({
      data: [
        {
          id: made.priceIds.portalLine,
          companyId: made.companyId,
          partyId: made.partyId,
          salesOrderId: made.orderId,
          salesOrderLineId: made.lineIds[0],
          unitPrice: '41.500000',
          currency: 'EUR',
          source: 'PORTAL',
          note: 'Seed: as on our purchase order.',
          enteredAt: AT,
          ...stamp,
        },
      ],
      skipDuplicates: true,
    }),
  )
  // The factory's total for the whole order, typed from the customer's PO.
  await db.withScope(office, (client) =>
    client.orderBrandPrice.createMany({
      data: [
        {
          id: made.priceIds.officeTotal,
          companyId: made.companyId,
          partyId: made.partyId,
          salesOrderId: made.orderId,
          salesOrderLineId: null,
          netAmount: 1_234_500,
          currency: 'EUR',
          source: 'OFFICE',
          enteredById: actorId,
          enteredAt: AT,
          ...stamp,
        },
      ],
      skipDuplicates: true,
    }),
  )
  // A made-to-measure line on P1's DRAFT and its two riders (the line first: a person needs its by-person line).
  await db.withScope(asBuyer, (client) =>
    client.$transaction(async (tx) => {
      await tx.portalOrderRequestLine.createMany({
        data: [
          {
            id: made.mtmLineId,
            partyId: made.partyId,
            requestId: made.draftId,
            seq: 3,
            kind: 'MADE_TO_MEASURE',
            garmentType: 'JACKET',
            byPerson: true,
            note: 'Seed: the team jackets, made to measure.',
            createdById: made.buyerId,
            ...stamp,
          },
        ],
        skipDuplicates: true,
      })
      await tx.portalOrderRequestPerson.createMany({
        data: [
          { id: made.personIds[0], partyId: made.partyId, requestId: made.draftId, lineId: made.mtmLineId, seq: 1, name: 'Rider One', number: '7', measureBy: 'SIZE', size: '52', createdById: made.buyerId, ...stamp },
          { id: made.personIds[1], partyId: made.partyId, requestId: made.draftId, lineId: made.mtmLineId, seq: 2, name: 'Rider Two', measureBy: 'LATER', createdById: made.buyerId, ...stamp },
        ],
        skipDuplicates: true,
      })
    }),
  )
  return made
}

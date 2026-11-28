import { seedUuid, type SeedContext } from '../seeding'

/**
 * owb-b1 (order workflow build, schema wave "order workflow 1/1"; the guards of …_order_workflow_guards, G2-G11): rows of the
 * wave's new tables that no CLI seed writes, for the tests. The generated isolation test (isolation.pg.vitest.test.ts) writes them
 * with this fixture in each tenant, as testing/order-files.ts does for its wave (Department comes with seed/product.ts). Per tenant
 * of seed/_core.ts, on P1's SEED-SO-0002 (its BLK line), SEED-WO-0001 at plant A1 (its steps 10-40, its bundle 1), A1's team L1-A,
 * the shipping seed's SEED-SH-0002 (DRAFT) and the auth seed's office member:
 *
 *   Site                  a WAREHOUSE site of company A, "Seed warehouse A" (no seed has one; the warehouse leg goes through it)
 *   PartyLineColumn       P1's TEXT column "Rider number" (the first row) and its CHOICE column "Logo ready?" (Yes, No)
 *   OrderLineColumnUse    "Rider number" used on SEED-SO-0002
 *   OrderLineOwnValue     its value on the BLK line ("Seed: 7")
 *   PaymentNotice         P1's buyer's OPEN "I paid" for SEED-SO-0002 (written in P1's portal: the office has no insert grant)
 *   OrderTeam             team L1-A in charge of SEED-SO-0002, no basket of its own yet
 *   OrderPrint            SEED-SO-0002's FIRST print (its BLK line's page, bundle 1's card)
 *   BasketMove            bundle 1 moved by hand FORWARD from step 10 to step 20 (the first row: a hand move, no undo)
 *   BasketRouteEdit       step 30 skipped for bundle 1 (NOT_NEEDED)
 *   FloorLateWarning      an OPEN warning from A1: SEED-WO-0001 late by 2 days (MATERIAL)
 *   ShipmentWarehouseLeg  SEED-SH-0002 goes through the warehouse site: not arrived, not sent on
 *   PartyOfficePerson     the office member in P1's pool (open)
 *
 * Written as the app does, in the office scope by the seed's actor (the owner, an active office person), the notice in P1's portal
 * scope by its buyer. The first row of each table (an id that starts with eight zeros) is the plain one a generated copy may repeat
 * (the isolation test's adjustCopy moves what a partial unique or a guard keeps once: a column's name, a team's order, a leg's
 * shipment, a pool's person); every other row starts with eight f's. Every word is made up. Idempotent: rows are inserted once
 * (skipped when they exist). Needs the auth, portal-auth, people and shipping seeds of the same namespace first (the isolation test
 * runs them earlier; the shipping seed runs the production seed).
 */

/** A fixed instant, before the day the wave was built (history: it never moves), and the day the customer says it paid. */
const AT = new Date('2026-11-27T09:00:00.000Z')
const PAID_ON = new Date('2026-11-25T00:00:00.000Z')

export interface OrderWorkflowFixture {
  readonly tenantId: string
  readonly companyId: string
  readonly partyId: string
  /** Plant A1, and the WAREHOUSE site this fixture adds to company A. */
  readonly siteId: string
  readonly warehouseSiteId: string
  /** SEED-SO-0002, its BLK and RED lines. */
  readonly orderId: string
  readonly orderLineIds: readonly [string, string]
  /** SEED-WO-0001 (A1), its steps 10 (cut), 20 (sew), 30 (QC), 40 (pack) and its two bundles. */
  readonly workOrderId: string
  readonly stepIds: { readonly cut: string; readonly sew: string; readonly qc: string; readonly pack: string }
  readonly bundleIds: readonly [string, string]
  /** A1's team L1-A. */
  readonly teamId: string
  /** SEED-SH-0001 (SHIPPED) and SEED-SH-0002 (DRAFT), both P1's at A1. */
  readonly shipmentIds: { readonly shipped: string; readonly draft: string }
  /** P1's portal buyer; the auth seed's owner (the actor) and member, both active office people. */
  readonly buyerId: string
  readonly ownerId: string
  readonly memberId: string
  readonly ids: {
    readonly columns: { readonly rider: string; readonly logo: string }
    readonly use: string
    readonly value: string
    readonly notice: string
    readonly team: string
    readonly print: string
    readonly move: string
    readonly routeEdit: string
    readonly late: string
    readonly leg: string
    readonly pool: string
  }
}

export async function seedOrderWorkflow(context: SeedContext): Promise<OrderWorkflowFixture> {
  const { db, namespace } = context
  const base = (key: string): string => seedUuid(namespace, key)
  const id = (key: string): string => seedUuid(namespace, `order-workflow:${key}`)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const made: OrderWorkflowFixture = {
    tenantId: base('tenant'),
    companyId: base('company:A'),
    partyId: base('party:P1'),
    siteId: base('site:A1'),
    warehouseSiteId: lateId('site:A-WH'),
    orderId: base('production:sales-order:SO-0002'),
    orderLineIds: [base('production:sales-order:SO-0002:10'), base('production:sales-order:SO-0002:20')],
    workOrderId: base('production:work-order:WO-0001'),
    stepIds: {
      cut: base('production:WO-0001:operation:10'),
      sew: base('production:WO-0001:operation:20'),
      qc: base('production:WO-0001:operation:30'),
      pack: base('production:WO-0001:operation:40'),
    },
    bundleIds: [base('production:bundle:WO-0001:1'), base('production:bundle:WO-0001:2')],
    teamId: base('people:team:A1:L1-A'),
    shipmentIds: { shipped: base('shipping:shipment:SH-0001'), draft: base('shipping:shipment:SH-0002') },
    buyerId: base('portal:user:P1:buyer'),
    ownerId: base('actor'),
    memberId: base('user:member'),
    ids: {
      columns: { rider: firstId('column:P1:rider'), logo: lateId('column:P1:logo') },
      use: firstId('use:SO-0002:rider'),
      value: firstId('value:SO-0002:10:rider'),
      notice: firstId('payment-notice:SO-0002'),
      team: firstId('order-team:SO-0002:L1-A'),
      print: firstId('order-print:SO-0002:first'),
      move: firstId('basket-move:WO-0001:1:forward'),
      routeEdit: firstId('route-edit:WO-0001:1:skip-30'),
      late: firstId('late:WO-0001'),
      leg: firstId('warehouse-leg:SH-0002'),
      pool: firstId('party-office:P1:member'),
    },
  }
  const office = { audience: 'office', tenantId: made.tenantId, actorId: made.ownerId } as const
  const portal = { audience: 'partner', tenantId: made.tenantId, actorId: made.buyerId, partyId: made.partyId } as const
  const ofOrder = { companyId: made.companyId, partyId: made.partyId, salesOrderId: made.orderId } as const
  const group = firstId('basket-group:WO-0001:1')

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const order = await tx.salesOrder.findUnique({ where: { id: made.orderId }, select: { id: true } })
      const shipment = await tx.shipment.findUnique({ where: { id: made.shipmentIds.draft }, select: { id: true } })
      const team = await tx.team.findUnique({ where: { id: made.teamId }, select: { id: true } })
      if (!order || !shipment || !team) throw new Error('order-workflow fixture: needs SEED-SO-0002 and SEED-SH-0002 (seed/shipping.ts) and team L1-A (seed/people.ts) of the same namespace')
      await tx.site.createMany({
        data: [{ id: made.warehouseSiteId, companyId: made.companyId, code: 'A-WH', name: 'Seed warehouse A', kind: 'WAREHOUSE', createdAt: AT, updatedAt: AT, createdById: made.ownerId }],
        skipDuplicates: true,
      })
      await tx.partyLineColumn.createMany({
        data: [
          { id: made.ids.columns.rider, partyId: made.partyId, name: 'Rider number', kind: 'TEXT', seq: 1, createdAt: AT, updatedAt: AT, createdById: made.ownerId },
          { id: made.ids.columns.logo, partyId: made.partyId, name: 'Logo ready?', kind: 'CHOICE', choices: ['Yes', 'No'], seq: 2, createdAt: AT, updatedAt: AT, createdById: made.ownerId },
        ],
        skipDuplicates: true,
      })
      await tx.orderLineColumnUse.createMany({
        data: [{ id: made.ids.use, ...ofOrder, columnId: made.ids.columns.rider, seq: 1, createdAt: AT, updatedAt: AT, createdById: made.ownerId }],
        skipDuplicates: true,
      })
      await tx.orderLineOwnValue.createMany({
        data: [{ id: made.ids.value, partyId: made.partyId, columnId: made.ids.columns.rider, salesOrderLineId: made.orderLineIds[0], valueText: 'Seed: 7', createdAt: AT, updatedAt: AT, createdById: made.ownerId }],
        skipDuplicates: true,
      })
      await tx.orderTeam.createMany({
        data: [{ id: made.ids.team, ...ofOrder, siteId: made.siteId, teamId: made.teamId, inCharge: true, givenBy: 'USER', createdAt: AT, updatedAt: AT, createdById: made.ownerId }],
        skipDuplicates: true,
      })
      await tx.orderPrint.createMany({
        data: [{ id: made.ids.print, ...ofOrder, kind: 'FIRST', pages: [{ salesOrderLineId: made.orderLineIds[0], page: 1 }], cards: [{ bundleId: made.bundleIds[0] }], createdAt: AT, createdById: made.ownerId }],
        skipDuplicates: true,
      })
      await tx.basketMove.createMany({
        data: [{ id: made.ids.move, siteId: made.siteId, workOrderId: made.workOrderId, bundleId: made.bundleIds[0], fromOperationId: made.stepIds.cut, toOperationId: made.stepIds.sew, kind: 'FORWARD', groupId: group, userId: made.ownerId, serverTime: AT }],
        skipDuplicates: true,
      })
      await tx.basketRouteEdit.createMany({
        data: [{ id: made.ids.routeEdit, siteId: made.siteId, workOrderId: made.workOrderId, bundleId: made.bundleIds[0], operationId: made.stepIds.qc, kind: 'SKIP', reason: 'NOT_NEEDED', groupId: group, userId: made.ownerId, serverTime: AT }],
        skipDuplicates: true,
      })
      await tx.floorLateWarning.createMany({
        data: [{ id: made.ids.late, siteId: made.siteId, workOrderId: made.workOrderId, days: 2, reason: 'MATERIAL', createdAt: AT, updatedAt: AT, createdById: made.ownerId }],
        skipDuplicates: true,
      })
      await tx.shipmentWarehouseLeg.createMany({
        data: [{ id: made.ids.leg, companyId: made.companyId, siteId: made.siteId, partyId: made.partyId, shipmentId: made.shipmentIds.draft, warehouseSiteId: made.warehouseSiteId, createdAt: AT, updatedAt: AT, createdById: made.ownerId }],
        skipDuplicates: true,
      })
      await tx.partyOfficePerson.createMany({
        data: [{ id: made.ids.pool, companyId: made.companyId, partyId: made.partyId, userId: made.memberId, createdAt: AT, updatedAt: AT, createdById: made.ownerId }],
        skipDuplicates: true,
      })
    }),
  )
  // "I paid": the customer's own notice, written in its portal (the office answers it, never inserts it).
  await db.withScope(portal, (client) =>
    client.paymentNotice.createMany({
      data: [{ id: made.ids.notice, ...ofOrder, amount: 50_000, currency: 'EUR', paidOn: PAID_ON, method: 'Bank transfer', note: 'Seed: the deposit, paid today.', createdAt: AT, updatedAt: AT, createdById: made.buyerId }],
      skipDuplicates: true,
    }),
  )
  return made
}
